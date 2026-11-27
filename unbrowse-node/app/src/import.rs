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

mod other;

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

/// The cookie stores of the browsers this node doesn't drive (Firefox, Safari), under the user's home.
fn other_stores() -> Vec<other::Store> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|h| other::stores(Path::new(&h))).unwrap_or_default()
}

/// Whether this machine has an ordinary browser that could hold a session at all: its stores are listed, nothing in
/// them is read.
fn a_browser_is_here() -> bool {
    !cookie_sources().is_empty() || !other_stores().is_empty()
}

fn no_browser_here(host: &str) -> String {
    format!(
        "no ordinary browser here to read a session from (the node's own downloaded browser holds no sign-in). Sign in to {host} in a normally installed Chrome, Firefox, Safari, Brave or Edge, or export its cookies to a file with a cookie extension and import that file"
    )
}

/// Imports the owner's browser session for `host`: the cookies any browser on this machine would send to it. Every
/// real browser the node can drive is read, not only the one it browses with, so the session is found whichever
/// browser the owner signed in with. Each browser's cookies are read by that same browser (it holds the key that
/// decrypts them), from a throwaway copy of its cookie store; another site's cookies are dropped before anything is
/// kept, as ever.
pub fn session(host: &str) -> Result<Kept, String> {
    // A public peer reads no one's browser for a session (`gateway.no-credentials`).
    if crate::remote::public_home() {
        return Err("a public peer reads no one's browser for a session".into());
    }
    let host = host_arg(host)?;
    let sources = cookie_sources();
    let others = other_stores();
    if sources.is_empty() && others.is_empty() {
        return Err(no_browser_here(&host));
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

    let mut mine = for_host(&host, held, store::now() as f64);
    // The browser gave none, though its store holds the host's: on macOS a browser launched on a copy of the store may
    // be refused its own key (Chrome 158 can no longer open a copied store, and drops every cookie in it). The node
    // then opens the store itself, with the browser's key from the keychain (`direct`).
    #[cfg(target_os = "macos")]
    if mine.is_empty() {
        for (name, exe, profile) in &sources {
            match direct::read(exe, profile, &host) {
                Ok(cookies) => mine.extend(for_host(&host, cookies, store::now() as f64)),
                Err(e) => unread.push(format!("{name}, read directly: {e}")),
            }
        }
    }
    let chromium: Vec<&str> = sources.iter().map(|(n, _, _)| n.as_str()).collect();
    let (mine, from) = chosen(&host, &chromium, &others, &import, mine, had_store, unread)?;
    keep(&host, mine, &from)
}

/// Which session an import keeps, once the Chromium browsers (`chromium`, by name) were read: their cookies for the host
/// (`mine`), else the first of the other browsers (`others`) that holds some, read one at a time so one browser's
/// session is kept whole. Answers the cookies and the browser they came from, or what the owner is told: no browser
/// with cookies at all, or none with the host's, with what couldn't be read. `had_store` and `unread` come in from the
/// Chromium read.
fn chosen(host: &str, chromium: &[&str], others: &[other::Store], import: &Path, mut mine: Vec<Cookie>, mut had_store: Vec<String>, mut unread: Vec<String>) -> Result<(Vec<Cookie>, String), String> {
    let mut from = had_store.join(", ");
    if mine.is_empty() {
        for s in others {
            let work = import.join(format!("{}-{}-{}", session_name(host), session_name(&s.name), std::process::id()));
            match other::read(s, host, &work) {
                Ok(cookies) => {
                    had_store.push(s.name.clone());
                    mine = for_host(host, cookies, store::now() as f64);
                    if !mine.is_empty() {
                        from = s.name.clone();
                        break;
                    }
                }
                Err(e) => unread.push(format!("{}: {e}", s.name)),
            }
        }
    }
    let couldnt = |msg: String| if unread.is_empty() { msg } else { format!("{msg}. Couldn't read: {}", unread.join("; ")) };
    if had_store.is_empty() {
        let tried = chromium.iter().copied().chain(others.iter().map(|s| s.name.as_str())).collect::<Vec<_>>().join(", ");
        return Err(couldnt(format!("no browser here has cookies yet (looked in {tried}): open {host} in your browser and sign in, then try again")));
    }
    if mine.is_empty() {
        let read = had_store.join(", ");
        return Err(couldnt(format!(
            "no cookies for {host} in your browsers ({read}). Sign in to {host} in one of them first; if you already are, that browser may lock its cookies to itself (app-bound encryption): export them to a file with a cookie extension and import that file, or sign in through Unbrowse once instead"
        )));
    }
    Ok((mine, from))
}

/// The owner's browsers on this machine the node can read a cookie store from: every real browser it can drive, not
/// the Chrome for Testing it downloaded (which holds no one's session), one entry per cookie-store directory so a
/// family that shows up under two names is read once. Each is (name, program, the directory it keeps its cookies in).
fn cookie_sources() -> Vec<(String, String, PathBuf)> {
    let mut all = browsers::found();
    all.extend(browsers::flatpak_browsers());
    dedupe_sources(all, browsers::profile_dir)
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

/// The owner's browser session for `host`, imported by the node itself because a page `who` (an agent, or the node's
/// own work) opened on the site was sent to its sign-in or turned away by its check: the owner may be signed in there
/// in their own browser. Only on the owner's yes, asked by `ask` in the node's own window ([`ask_in_the_nodes_window`]),
/// never through the agent ([`owner_lets`]): the session is the owner's, and an agent signed in as them acts as them.
/// At most once per site in [`SIGNED_OUT_AGAIN`] (`None` when it was reached for within that), whatever the owner or
/// the import answered, so a site costs one question and one headless open of their browser, not one per page.
pub fn when_signed_out(host: &str, who: &str, ask: impl FnOnce(String) -> Result<(), String>) -> Option<Result<Kept, String>> {
    reach_for(host, who, ask, session, a_browser_is_here)
}

/// [`when_signed_out`], reading the session with `read`, where `there` says whether any browser could hold one.
fn reach_for(host: &str, who: &str, ask: impl FnOnce(String) -> Result<(), String>, read: impl FnOnce(&str) -> Result<Kept, String>, there: impl FnOnce() -> bool) -> Option<Result<Kept, String>> {
    static TRIED: std::sync::Mutex<BTreeMap<String, std::time::Instant>> = std::sync::Mutex::new(BTreeMap::new());
    let site = site_of(host);
    if !reach_again(&mut TRIED.lock().unwrap_or_else(|p| p.into_inner()), &site, std::time::Instant::now()) {
        return None;
    }
    // A public peer reads no one's browser: its owner isn't asked for what it would refuse anyway.
    if crate::remote::public_home() {
        return Some(read(host));
    }
    // With no ordinary browser on this machine there is no session to take: the owner isn't asked (and the call
    // doesn't wait on a question nobody can usefully answer) for what isn't there. Until 2026-11-25 the question came
    // first, and a node nobody watched held the call two minutes on it.
    if !there() {
        return Some(Err(no_browser_here(host)));
    }
    Some(owner_lets(&site, who, ask).and_then(|()| read(host)))
}

/// The sites whose owner said yes, while this node runs, to the node taking their browser's session in for an agent.
/// Held in memory only: a file any program of this user can write would be a yes nobody gave, and a restart asks again.
static LET_IN: std::sync::Mutex<std::collections::BTreeSet<String>> = std::sync::Mutex::new(std::collections::BTreeSet::new());

/// Whether the owner lets the node take their own browser's session for `site` in, for `who`: asked by `ask` in the
/// node's own window, naming the site and who wants it, and logged under `who` (the agent, never the owner). A yes is
/// remembered for the site while the node runs, so the owner isn't asked again on its next page; a no, or no answer,
/// is a no, and nothing of their browser is read.
pub fn owner_lets(site: &str, who: &str, ask: impl FnOnce(String) -> Result<(), String>) -> Result<(), String> {
    if LET_IN.lock().unwrap_or_else(|p| p.into_inner()).contains(site) {
        return Ok(());
    }
    let question = format!(
        "{who} opened a page of {site} that asks to sign in.\n\nLet the node take in your own browser's session for {site}, so {who} is signed in there as you? What it does on {site} after that, it does as you.\n\nIf you allow it, the node won't ask again for {site} until it restarts."
    );
    let answer = ask(question);
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: site.to_string(),
        what: format!("Asked to use your browser's sign-in for {site}"),
        kind: "vault".into(),
        result: if answer.is_ok() { "done" } else { "declined" }.into(),
        ms: None,
        unb: None,
        tx: None,
        note: answer.as_ref().err().cloned(),
    });
    match answer {
        Ok(()) => {
            LET_IN.lock().unwrap_or_else(|p| p.into_inner()).insert(site.to_string());
            Ok(())
        }
        Err(no) => Err(format!("the owner didn't let the node take their browser's session for {site} ({no})")),
    }
}

/// Asks the owner `question` in the node's own window (`owner_dialog`), from one of the node's blocking threads: Err
/// with no node, or off the node's runtime, where no one can be asked.
pub fn ask_in_the_nodes_window(node: Option<&crate::Node>, question: String) -> Result<(), String> {
    let node = node.ok_or("no one to ask")?;
    let handle = tokio::runtime::Handle::try_current().map_err(|_| "no one to ask".to_string())?;
    handle.block_on(crate::owner_dialog::ask(node.key().ok(), question))
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

/// What follows a page sent to `host`'s sign-in (`sent` says how; None when it wasn't): the owner's browser session for
/// the site is taken in by `take_in` ([`when_signed_out`] on a node, which asks the owner first), and once some was, the
/// page is gone over again by `again`, whose answer is returned. None, and the page as it was, when it wasn't sent, the
/// site was reached for within [`SIGNED_OUT_AGAIN`], the owner said no, or their browser holds no session for it. `who`
/// names the caller in the log.
pub fn again_signed_in<T>(who: &str, sent: Option<&str>, host: &str, take_in: impl FnOnce(&str) -> Option<Result<Kept, String>>, again: impl FnOnce() -> T) -> Option<T> {
    let why = sent?;
    match take_in(host)? {
        Ok(kept) => {
            eprintln!("   [{who}] {why}; took in the owner's browser session for {} ({} cookies) and went over the page again", kept.host, kept.cookies);
            Some(again())
        }
        Err(none) => {
            eprintln!("   [{who}] {why}; the owner's browser session wasn't taken in: {none}");
            None
        }
    }
}

/// Reading a Chromium-family browser's cookie store on macOS without the browser: the store is SQLite (read with the
/// system's `sqlite3`, read-only, as the file stands), and each value is sealed `v10`: AES-128-CBC under a key
/// PBKDF2-derived from the browser's "Safe Storage" keychain password. A store at schema 24 and up puts the SHA-256 of
/// the cookie's domain before each value. Only the host's rows (and its parents') are opened; no value is printed or
/// logged. The keychain asks the owner once whether this program may use the browser's key.
#[cfg(target_os = "macos")]
mod direct {
    use super::Cookie;
    use std::path::Path;

    /// Microseconds from 1601-01-01 (the browser's epoch) to 1970-01-01.
    const WINDOWS_EPOCH_US: i64 = 11_644_473_600_000_000;

    pub fn read(exe: &str, profile: &Path, host: &str) -> Result<Vec<Cookie>, String> {
        let stores: Vec<_> = ["Default/Cookies", "Default/Network/Cookies"].iter().map(|rel| profile.join(rel)).filter(|p| p.is_file()).collect();
        let mut out = Vec::new();
        let mut key = None;
        for store in stores {
            let rows = rows_for(&store, host)?;
            if rows.is_empty() {
                continue;
            }
            if key.is_none() {
                let (service, account) = crate::browsers::safe_storage(exe).ok_or("the node doesn't know where this browser keeps its key")?;
                let secret = keyring::Entry::new(service, account).and_then(|e| e.get_password()).map_err(|e| format!("its key ({service}) didn't read: {e}"))?;
                key = Some(derive(secret.as_bytes()));
            }
            let prefixed = schema(&store)? >= 24;
            out.extend(rows.into_iter().filter_map(|r| r.cookie(key.as_ref().expect("read above"), prefixed)));
        }
        Ok(out)
    }

    /// The key a v10 value is sealed under: PBKDF2-HMAC-SHA1 of the keychain password, "saltysalt", 1003 rounds.
    pub fn derive(secret: &[u8]) -> [u8; 16] {
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(secret, b"saltysalt", 1003, &mut key);
        key
    }

    /// A v10 value opened: the plaintext, less the domain's SHA-256 a schema-24 store puts first. None for another kind
    /// of value or one that doesn't open.
    pub fn open(key: &[u8; 16], sealed: &[u8], prefixed: bool) -> Option<Vec<u8>> {
        use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
        let body = sealed.strip_prefix(b"v10")?;
        let mut buf = body.to_vec();
        let plain = cbc::Decryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into()).decrypt_padded_mut::<Pkcs7>(&mut buf).ok()?.to_vec();
        Some(if prefixed && plain.len() >= 32 { plain[32..].to_vec() } else { plain })
    }

    pub struct Row {
        pub host_key: String,
        pub name: String,
        pub path: String,
        pub expires_utc: i64,
        pub secure: bool,
        pub http_only: bool,
        pub same_site: i64,
        pub sealed: Vec<u8>,
        pub value: String,
    }

    impl Row {
        pub fn cookie(self, key: &[u8; 16], prefixed: bool) -> Option<Cookie> {
            let value = if self.sealed.is_empty() { self.value } else { String::from_utf8(open(key, &self.sealed, prefixed)?).ok()? };
            Some(Cookie {
                host_only: !self.host_key.starts_with('.'),
                domain: self.host_key.trim_start_matches('.').to_string(),
                name: self.name,
                value,
                path: self.path,
                secure: self.secure,
                http_only: self.http_only,
                expires: (self.expires_utc > 0).then(|| (self.expires_utc - WINDOWS_EPOCH_US) as f64 / 1e6),
                same_site: match self.same_site {
                    0 => Some("None".into()),
                    1 => Some("Lax".into()),
                    2 => Some("Strict".into()),
                    _ => None,
                },
            })
        }
    }

    /// The store's rows a browser would send to `host`: set for it, or for a domain above it. `host` is a host name
    /// (`import::host_arg`: letters, digits, dots and dashes), so it goes into the query as it is.
    fn rows_for(store: &Path, host: &str) -> Result<Vec<Row>, String> {
        let labels: Vec<&str> = host.split('.').collect();
        let mut domains = Vec::new();
        for i in 0..labels.len().saturating_sub(1) {
            let d = labels[i..].join(".");
            domains.push(format!("'{d}'"));
            domains.push(format!("'.{d}'"));
        }
        let sql = format!(
            "select host_key, name, path, expires_utc, is_secure, is_httponly, samesite, hex(encrypted_value), value from cookies where host_key in ({})",
            domains.join(",")
        );
        let text = query(store, &sql)?;
        Ok(text.split('\x1e').filter(|l| !l.is_empty()).filter_map(parse).collect())
    }

    pub fn parse(line: &str) -> Option<Row> {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() != 9 {
            return None;
        }
        Some(Row {
            host_key: f[0].into(),
            name: f[1].into(),
            path: f[2].into(),
            expires_utc: f[3].parse().unwrap_or(0),
            secure: f[4] == "1",
            http_only: f[5] == "1",
            same_site: f[6].parse().unwrap_or(-1),
            sealed: hex::decode(f[7]).ok()?,
            value: f[8].into(),
        })
    }

    fn schema(store: &Path) -> Result<i64, String> {
        Ok(query(store, "select value from meta where key = 'version'")?.trim_end_matches('\x1e').trim().parse().unwrap_or(0))
    }

    /// One read-only query of the store as it stands on disk (`immutable`: the running browser's lock isn't waited on),
    /// fields split by 0x1f and rows by 0x1e.
    fn query(store: &Path, sql: &str) -> Result<String, String> {
        let uri = format!("file:{}?immutable=1", store.display());
        let out = std::process::Command::new("/usr/bin/sqlite3")
            .args(["-readonly", "-separator", "\x1f", "-newline", "\x1e", &uri, sql])
            .output()
            .map_err(|e| format!("sqlite3 didn't run: {e}"))?;
        if !out.status.success() {
            return Err(format!("the store didn't read: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        String::from_utf8(out.stdout).map_err(|_| "the store's rows aren't text".to_string())
    }
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
    // A public peer keeps no one's session, from a browser or a file (`gateway.no-credentials`).
    if crate::remote::public_home() {
        return Err("a public peer keeps no one's session".into());
    }
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

    /// Chrome 158 launched on a copy of the owner's cookie store is refused its key and drops every cookie, so the node
    /// opens the store itself: a v10 value, sealed as Chromium seals it, opens to the value, less the domain's SHA-256 a
    /// schema-24 store puts first; a row reads as the cookie a browser would send; a value under another key opens to
    /// nothing, never to a wrong value.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_browsers_sealed_cookie_opens_with_its_key() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        use sha2::Digest;
        let key = direct::derive(b"the browser's safe storage password");
        let seal = |key: &[u8; 16], plain: &[u8]| {
            let mut out = b"v10".to_vec();
            let mut buf = plain.to_vec();
            buf.resize(plain.len() + 16, 0);
            let sealed = cbc::Encryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into()).encrypt_padded_mut::<Pkcs7>(&mut buf, plain.len()).unwrap();
            out.extend_from_slice(sealed);
            out
        };
        let mut prefixed = sha2::Sha256::digest(b".www.loom.example").to_vec();
        prefixed.extend(b"s%3Asession-value");
        assert_eq!(direct::open(&key, &seal(&key, &prefixed), true).as_deref(), Some(&b"s%3Asession-value"[..]));
        assert_eq!(direct::open(&key, &seal(&key, b"plain"), false).as_deref(), Some(&b"plain"[..]), "an older store has no prefix");
        let other = direct::derive(b"another browser's password");
        assert!(direct::open(&other, &seal(&key, b"plain"), false).is_none_or(|p| p != b"plain"), "another key never opens it to the value");
        assert_eq!(direct::open(&key, b"v20abc", false), None, "another kind of seal isn't guessed at");
        let line = format!(".www.loom.example\x1fconnect.sid\x1f/\x1f{}\x1f1\x1f1\x1f1\x1f{}\x1f", 13_441_000_000_000_000i64 + 11_644_473_600_000_000, hex::encode_upper(seal(&key, &prefixed)));
        let c = direct::parse(&line).unwrap().cookie(&key, true).unwrap();
        assert_eq!((c.name.as_str(), c.value.as_str(), c.domain.as_str(), c.host_only), ("connect.sid", "s%3Asession-value", "www.loom.example", false));
        assert!(c.secure && c.http_only && c.same_site.as_deref() == Some("Lax"));
        assert_eq!(c.expires, Some(13_441_000_000.0));
        assert!(c.sent_to("www.loom.example"));
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

    /// A page sent to the site's sign-in takes in the owner's browser session and is gone over again, once: signed in
    /// there, the owner isn't asked for what their browser holds. A browser holding no session, or a site reached for
    /// a moment ago, leaves the page as it was, and a page that wasn't sent to a sign-in never opens the owner's browser.
    #[test]
    fn a_page_sent_to_a_sign_in_is_gone_over_again_with_the_owners_session() {
        let kept = || Kept { host: "x.com".into(), cookies: 3, profiles: 1, profile_error: None };
        let (mut asked, mut walked) = (Vec::new(), 0);
        let again = again_signed_in("learn", Some("x.com sent the page to /login"), "x.com", |h| {
            asked.push(h.to_string());
            Some(Ok(kept()))
        }, || {
            walked += 1;
            "signed in"
        });
        assert_eq!((again, walked), (Some("signed in"), 1), "walked again once, and that walk is the answer");
        assert_eq!(asked, ["x.com"], "the session is reached for on the page's own host");
        let none = again_signed_in("learn", Some("sent to /login"), "x.com", |_| Some(Err("no cookies for x.com".into())), || -> &str { unreachable!("no session, no second walk") });
        assert_eq!(none, None);
        let rested = again_signed_in("learn", Some("sent to /login"), "x.com", |_| None, || -> &str { unreachable!("reached for a moment ago") });
        assert_eq!(rested, None);
        let not_sent = again_signed_in("learn", None, "x.com", |_| -> Option<Result<Kept, String>> { unreachable!("a page not sent to a sign-in opens no browser of the owner's") }, || "x");
        assert_eq!(not_sent, None);
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

    /// A Flatpak Chromium keeps its cookies in its own sandbox folder, so a session is read from it beside an ordinary
    /// Chromium of the same family, not left out as a second name for the ordinary one's store.
    #[cfg(target_os = "linux")]
    #[test]
    fn import_reads_a_flatpak_chromium_beside_an_ordinary_one() {
        let dir = std::env::temp_dir().join(format!("unbrowse-import-flatpak-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (home, config) = (dir.join("home"), dir.join("config"));
        let sandbox = home.join(".var/app/org.chromium.Chromium/config/chromium");
        std::fs::create_dir_all(&sandbox).unwrap();
        std::fs::create_dir_all(config.join("chromium")).unwrap();
        let found = vec![
            browsers::Found { name: "Chromium".into(), path: "/usr/bin/chromium".into(), downloaded: false },
            browsers::Found { name: "org.chromium.Chromium (Flatpak)".into(), path: "/var/lib/flatpak/exports/bin/org.chromium.Chromium".into(), downloaded: false },
        ];
        let got = dedupe_sources(found, |exe| browsers::profile_dir_in(exe, &home, config.clone()));
        let read: Vec<(&str, &Path)> = got.iter().map(|(n, _, d)| (n.as_str(), d.as_path())).collect();
        assert_eq!(read, [("Chromium", config.join("chromium").as_path()), ("org.chromium.Chromium (Flatpak)", sandbox.as_path())]);
        let _ = std::fs::remove_dir_all(&dir);
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
    /// A browser that is a script, so the import's own browser steps run with no real browser: it answers on the
    /// debugger's pipe (read on fd 3, answered on fd 4, each message ended by a NUL, as Chrome does), holds two cookies
    /// for `Storage.getCookies`, refuses any `Storage.setCookies` that names a cookie "poison", closes on
    /// `Browser.close`, and notes each message it was sent in `<script>.log`.
    #[cfg(unix)]
    fn a_browser_on_the_pipe(dir: &Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        const SCRIPT: &str = r##"#!/bin/bash
log="$0.log"
while IFS= read -r -d '' msg <&3; do
  printf '%s\n' "$msg" >> "$log"
  id=$(printf '%s' "$msg" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
  method=$(printf '%s' "$msg" | grep -o '"method":"[^"]*"' | head -1 | cut -d'"' -f4)
  session=$(printf '%s' "$msg" | grep -o '"sessionId":"[^"]*"' | head -1 | cut -d'"' -f4)
  named=""
  [ -n "$session" ] && named=",\"sessionId\":\"$session\""
  case "$method" in
    Target.attachToBrowserTarget) out="{\"id\":$id,\"result\":{\"sessionId\":\"browser-1\"}}" ;;
    Storage.getCookies) out="{\"id\":$id$named,\"result\":{\"cookies\":[{\"name\":\"sid\",\"value\":\"abc\",\"domain\":\".shop.example\",\"path\":\"/\",\"secure\":true,\"httpOnly\":true,\"expires\":4102444800},{\"name\":\"tracker\",\"value\":\"t\",\"domain\":\"ads.example\",\"path\":\"/\"}]}}" ;;
    Storage.setCookies)
      if printf '%s' "$msg" | grep -q '"name":"poison"'; then
        out="{\"id\":$id$named,\"error\":{\"code\":-32602,\"message\":\"Invalid cookie fields\"}}"
      else
        out="{\"id\":$id$named,\"result\":{}}"
      fi ;;
    Browser.close)
      printf '%s\0' "{\"id\":$id$named,\"result\":{}}" >&4
      exit 0 ;;
    *) out="{\"id\":$id$named,\"result\":{}}" ;;
  esac
  printf '%s\0' "$out" >&4
done
"##;
        let exe = dir.join("a-browser-on-the-pipe");
        std::fs::write(&exe, SCRIPT).unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        exe.display().to_string()
    }

    /// What the script browser at `exe` was sent, one message to a line.
    #[cfg(unix)]
    fn sent_to_the_browser(exe: &str) -> Vec<String> {
        std::fs::read_to_string(format!("{exe}.log")).unwrap_or_default().lines().map(String::from).collect()
    }

    /// A cookie as DevTools takes it, for the script browser.
    fn kv(name: &str) -> Value {
        json!({ "name": name, "value": "v", "domain": "shop.example", "path": "/" })
    }

    /// The browser is asked for the cookies it holds (not a page), whoever set them: they come back as cookies, the
    /// other site's among them (`for_host` drops it, as ever), and a browser that won't open is said, not hung on.
    #[cfg(unix)]
    #[test]
    fn a_browsers_cookies_are_read_through_its_debugger_and_a_browser_that_wont_open_is_said() {
        let home = store::scratch_home("import-read");
        let exe = a_browser_on_the_pipe(&home);
        let read = read_cookies(&exe, &home.join("work")).unwrap();
        let held: Vec<_> = read.iter().map(|c| (c.name.as_str(), c.value.as_str(), c.domain.as_str(), c.host_only)).collect();
        assert_eq!(held, [("sid", "abc", "shop.example", false), ("tracker", "t", "ads.example", true)]);
        assert!(read[0].secure && read[0].http_only && read[0].expires == Some(4_102_444_800.0));
        let mine = for_host("www.shop.example", read, 1000.0);
        assert_eq!(mine.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["sid"], "another site's cookie is left out");
        let said = sent_to_the_browser(&exe).join("\n");
        assert!(said.contains("Storage.getCookies") && said.contains("Browser.close"), "it asked the browser for its cookies, then closed it: {said}");
        let err = read_cookies(&home.join("no-such-browser").display().to_string(), &home.join("work-2")).unwrap_err();
        assert!(err.contains("the node's browser didn't open"), "{err}");
    }

    /// A cookie one browser won't take costs the batch, not the rest: refused whole, they go one by one, and the import
    /// says so only when the browser took none; a browser that isn't listening is said.
    #[cfg(unix)]
    #[test]
    fn a_cookie_the_browser_refuses_costs_the_batch_but_not_the_rest() {
        let home = store::scratch_home("import-set");
        let exe = a_browser_on_the_pipe(&home);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut chrome = agent_browser_core::cdp::chrome::launch_chrome(&reading(&exe, &home.join("work"), Vec::new())).unwrap();
        let sets = || sent_to_the_browser(&exe).iter().filter(|m| m.contains("Storage.setCookies")).count();
        rt.block_on(set_cookies(&chrome.ws_url, &[kv("sid"), kv("cart")])).unwrap();
        assert_eq!(sets(), 1, "a batch the browser takes is one ask");
        rt.block_on(set_cookies(&chrome.ws_url, &[kv("sid"), kv("poison"), kv("cart")])).unwrap();
        assert_eq!(sets(), 1 + 1 + 3, "a batch it refuses goes again one cookie at a time");
        let none = rt.block_on(set_cookies(&chrome.ws_url, &[kv("poison")])).unwrap_err();
        assert!(none.contains("took none of the cookies"), "{none}");
        chrome.kill();
        let gone = rt.block_on(set_cookies("ws://127.0.0.1:1/devtools/browser/none", &[kv("sid")])).unwrap_err();
        assert!(gone.contains("couldn't reach the node's browser"), "{gone}");
    }

    /// A profile is opened headless, given the session, and its browser closed so it writes the cookies to disk, with
    /// the profile's folder made if it was not there.
    #[cfg(unix)]
    #[test]
    fn a_closed_profile_is_opened_given_the_session_and_its_browser_closed() {
        let home = store::scratch_home("import-profile");
        let exe = a_browser_on_the_pipe(&home);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let profile = home.join("profiles").join("shop.example");
        into_closed_profile(&rt, &exe, &profile, &[kv("sid"), kv("cart")]).unwrap();
        assert!(profile.is_dir(), "the profile's folder is made");
        let said = sent_to_the_browser(&exe);
        let set: Vec<_> = said.iter().filter(|m| m.contains("Storage.setCookies")).collect();
        assert!(set.len() == 1 && set[0].contains("\"sid\"") && set[0].contains("\"cart\""), "{said:?}");
        assert!(said.iter().any(|m| m.contains("Browser.close")), "closed cleanly, so the browser writes them: {said:?}");
        let blocked = home.join("a-file");
        std::fs::write(&blocked, "x").unwrap();
        let err = into_closed_profile(&rt, &exe, &blocked.join("profile"), &[kv("sid")]).unwrap_err();
        assert!(err.starts_with(&blocked.join("profile").display().to_string()), "a profile that can't be made is said by its place: {err}");
        let err = into_closed_profile(&rt, &home.join("no-such-browser").display().to_string(), &home.join("profiles").join("x.example"), &[kv("sid")]).unwrap_err();
        assert!(err.contains("didn't open the site's profile"), "{err}");
    }

    /// A session goes into the node's profile for the host and the others it keeps for the same site, each opened in the
    /// node's browser, and each cookie lives as long as the profile keeps a session cookie; with no browser the node
    /// can drive, it says so.
    #[cfg(unix)]
    #[test]
    fn a_session_is_put_into_every_profile_of_the_site_through_the_nodes_browser() {
        let home = store::scratch_home("import-profiles");
        let exe = a_browser_on_the_pipe(&home);
        std::fs::create_dir_all(store::profiles_dir().join("www.shop.example")).unwrap();
        let mine = [cookie("sid", "shop.example", false, "/")];
        browsers::for_this_test(None);
        assert_eq!(into_profiles("app.shop.example", &mine).unwrap_err(), browsers::missing());
        browsers::for_this_test(Some(exe.clone()));
        assert_eq!(into_profiles("app.shop.example", &mine), Ok(2));
        let said = sent_to_the_browser(&exe);
        let set: Vec<_> = said.iter().filter(|m| m.contains("Storage.setCookies")).collect();
        assert_eq!(set.len(), 2, "the host's own profile and the sibling's: {said:?}");
        assert!(set.iter().all(|m| m.contains("\"expires\"")), "a session cookie is given a life the profile keeps");
        assert!(store::profiles_dir().join("app.shop.example").is_dir());
    }

    /// A cookie file imported in full: the host's cookies are the session for calls, the node's browser takes them (so
    /// no cookie is held by the jar alone), another site's cookie in the file is never kept or sent to the browser, and a
    /// file with none of the host's says so.
    #[cfg(unix)]
    #[test]
    fn a_cookie_file_becomes_the_sites_session_in_the_jar_and_the_profile() {
        let home = store::scratch_home("import-file");
        let exe = a_browser_on_the_pipe(&home);
        browsers::for_this_test(Some(exe.clone()));
        let file = r#"[{"name":"sid","value":"s1","domain":".shop.example","path":"/","secure":true},
            {"name":"cart","value":"c1","domain":"www.shop.example","path":"/"},
            {"name":"tracker","value":"t1","domain":"ads.example","path":"/"}]"#;
        let kept = session_from("https://www.shop.example/login", file).unwrap();
        assert_eq!((kept.host.as_str(), kept.cookies, kept.profiles, kept.profile_error.as_deref()), ("www.shop.example", 2, 1, None));
        let jar: BTreeMap<String, String> = store::read_json(&store::jar_path("www.shop.example"), &unbrowse_files::JAR);
        assert_eq!(jar, BTreeMap::from([("cart".to_string(), "c1".to_string()), ("sid".to_string(), "s1".to_string())]));
        let only: BTreeMap<String, store::JarOnly> = store::read_json(&store::jar_only_path("www.shop.example"), &unbrowse_files::JAR);
        assert!(only.is_empty(), "a browser took them, so none is held by the jar alone");
        assert!(!sent_to_the_browser(&exe).join("\n").contains("tracker"), "another site's cookie never reaches the browser");
        let err = session_from("www.shop.example", r#"[{"name":"tracker","value":"t1","domain":"ads.example"}]"#).unwrap_err();
        assert!(err.contains("holds no live cookie for www.shop.example"), "{err}");
    }

    /// A public peer reads no one's browser, and the node reaches for the owner's session once for a site, not on every
    /// page of it.
    #[test]
    fn a_public_peer_signs_in_from_no_browser_and_a_site_is_reached_for_once() {
        let home = store::scratch_home("import-public");
        store::write_json(&home.join("remote.json"), &unbrowse_files::REMOTE, &json!({ "public": true })).unwrap();
        let unasked = |_: String| -> Result<(), String> { unreachable!("a public peer asks its owner nothing for a browser it never reads") };
        let first = when_signed_out("www.reached-once.example", "agent", unasked).expect("the first time a site is reached for");
        assert!(first.unwrap_err().contains("public peer"), "it reads no one's browser");
        assert!(when_signed_out("app.reached-once.example", "agent", unasked).is_none(), "another page of the same site, a moment later, is not reached for");
    }

    /// Audit 1118 H1. An agent's page that lands on a sign-in takes the owner's browser session into the node only on the
    /// owner's yes, given in the node's window (naming the site and the agent): with no yes, no browser of theirs is
    /// opened for cookies and the page is not gone over again signed in as them. The ask is logged under the agent, not
    /// the owner. A yes reads the session once and is remembered for the site; the control, a page that wasn't sent to
    /// a sign-in, reaches for nothing and asks nothing.
    #[test]
    fn a_sign_in_an_agents_page_landed_on_takes_the_owners_session_only_on_their_yes() {
        store::scratch_home("import-owners-yes");
        let reached = std::cell::Cell::new(0);
        let asked = std::cell::RefCell::new(Vec::<String>::new());
        let kept = |host: &str| Kept { host: host.into(), cookies: 2, profiles: 1, profile_error: None };
        let reach = |host: &str, yes: bool| {
            reach_for(
                host,
                "shopping-agent",
                |q| {
                    asked.borrow_mut().push(q);
                    if yes { Ok(()) } else { Err("the owner said no".into()) }
                },
                |h| {
                    reached.set(reached.get() + 1);
                    Ok(kept(h))
                },
                || true,
            )
        };
        let not_sent = again_signed_in("browse", None, "app.no-yes.example", |h| reach(h, true), || "again");
        assert_eq!((not_sent, reached.get(), asked.borrow().len()), (None, 0, 0), "the control: a page that wasn't sent to a sign-in is left as it was");
        let again = again_signed_in("browse", Some("https://app.no-yes.example/login asked the page to sign in"), "app.no-yes.example", |h| reach(h, false), || "opened again signed in as the owner");
        assert_eq!(reached.get(), 0, "the owner's browser session was read with no yes from the owner");
        assert_eq!(again, None, "the page was opened again signed in as the owner with no yes from the owner");
        let q = asked.borrow().last().cloned().expect("the owner was asked");
        assert!(q.contains("no-yes.example") && q.contains("shopping-agent"), "the question names the site and the agent: {q}");
        let logged = store::read_activity(50);
        assert!(logged.iter().any(|a| a.who == "shopping-agent" && a.site == "no-yes.example" && a.result == "declined"), "the ask is logged under the agent: {logged:?}");
        // On their yes, the session is read once and the page gone over again; the yes holds for the site.
        let again = again_signed_in("browse", Some("sent to /login"), "app.yes.example", |h| reach(h, true), || "signed in");
        assert_eq!((again, reached.get()), (Some("signed in"), 1));
        let before = asked.borrow().len();
        assert_eq!(owner_lets("yes.example", "another-agent", |_| -> Result<(), String> { unreachable!("asked again for a site the owner let in") }), Ok(()));
        assert_eq!(asked.borrow().len(), before);
    }

    /// With no ordinary browser on the machine there is no session to take, and the owner is not asked for one: the
    /// reach says so at once, and nothing is read.
    #[test]
    fn with_no_browser_here_the_owner_is_not_asked_for_its_session() {
        store::scratch_home("import-no-browser");
        let unasked = |_: String| -> Result<(), String> { unreachable!("asked the owner for a session no browser here holds") };
        let said = reach_for("www.no-browser.example", "agent", unasked, |_| unreachable!("read a browser that isn't here"), || false).expect("reached for once");
        assert!(said.unwrap_err().contains("no ordinary browser here"));
    }

    /// A cookie with no name is no cookie, a cookies.txt line short of its fields is skipped, a work folder's name is made
    /// of letters and digits, and a copy that can't be written says where.
    #[test]
    fn what_is_no_cookie_is_left_out_and_a_copy_that_cant_be_written_is_said() {
        assert!(cookie_of(&json!({ "value": "x", "domain": "shop.example" }), "shop.example").is_none());
        assert!(cookie_of(&json!({ "name": 7, "value": "x" }), "shop.example").is_none());
        assert_eq!(netscape("# a comment\nshop.example\tFALSE\t/\n.shop.example\tTRUE\t/\tFALSE\t0\tsid\ts1\n").iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["sid"]);
        assert_eq!(session_name("www.shop.example:8080/a b"), "www-shop-example-8080-a-b");
        let dir = std::env::temp_dir().join(format!("unbrowse-import-unwritable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("profile")).unwrap();
        std::fs::write(dir.join("profile/Local State"), "{}").unwrap();
        std::fs::write(dir.join("a-file"), "x").unwrap();
        let under = dir.join("a-file").join("copy");
        let err = copy_cookie_store(&dir.join("profile"), &under).unwrap_err();
        assert!(err.starts_with(&under.display().to_string()), "{err}");
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
#[path = "import_cov_tests.rs"]
mod import_cov_tests;
