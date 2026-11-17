//! The harness-level bypass: one call, browserless first, the walk as the
//! fallback.
//!
//! ```no_run
//! # fn main() -> Result<(), Box<dyn std::error::Error>> {
//! let page = unbrowse_learn::site::Site::new().fetch("https://example.com/")?;
//! println!("{} {} bytes from {:?}", page.status, page.body.len(), page.source);
//! # Ok(())
//! # }
//! ```
//!
//! The order is the point, and it is the same for every site:
//!
//! 1. **walk** — a real browser opens the URL once, in process, and its
//!    session and its own request headers are kept;
//! 2. **browserless** — the URL is called over a Chrome-shaped transport with
//!    those headers and that session;
//! 3. **fallback** — if the door refuses, the walk's recorded response answers
//!    (the browser already fetched it, so nothing more is spent);
//! 4. **report** — if that was refused too, say so, and say why.
//!
//! No site-specific code lives here: the site's own walk supplies the shape,
//! the session and the fallback.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::http::ChromeFetch;
use crate::mint::{BrowserMint, Mint};
use crate::replay::{Fetch, Request};

/// The node's own identity, presented by default.
pub const NODE_USER_AGENT: &str = "unbrowse-node/0.1.0";

/// Where a page's bytes came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The site answered the browserless call.
    Browserless,
    /// The site refused the call; the walk's recorded response answered.
    Walk,
}

/// A page, however it had to be fetched.
#[derive(Clone, Debug)]
pub struct Page {
    pub status: u16,
    pub body: String,
    pub source: Source,
    /// Cookies the walk minted (0 when the site set none).
    pub cookies: usize,
    /// The hosts of the walk's door (`Trace::gates`), if it met one.
    pub gates: Vec<String>,
}

impl Page {
    /// Did the site answer at all, by either route?
    pub fn ok(&self) -> bool {
        (200..400).contains(&self.status)
    }
}

/// The harness's own client: a profile per site, a capture per walk.
pub struct Site {
    pub profile_root: PathBuf,
    pub capture_root: PathBuf,
    /// Where minted sessions persist, one file per host. A jar that still
    /// works skips the walk entirely: the first call to a site pays for the
    /// browser, every call after it is plain HTTP.
    pub jar_root: PathBuf,
    /// A browser that already exists, as a CDP endpoint. With this set the
    /// node launches nothing: it opens a tab in the browser you point it at —
    /// your own, or any Chrome with a debug port — and mints through that.
    pub cdp_endpoint: Option<String>,
    /// How long a walk lets the page settle before harvesting.
    pub settle_ms: u64,
}

impl Default for Site {
    fn default() -> Self {
        Self::new()
    }
}

impl Site {
    pub fn new() -> Self {
        // The node's home, not the shell's `$HOME`: a harness run under another home (`UNBROWSE_HOME`) keeps its
        // profiles and jars there, never in the owner's `~/.unbrowse`.
        let home = unbrowse_files::private::home();
        Self {
            profile_root: home.join("profiles"),
            // A walk's log is read back as what the site said: it is kept where only the owner can write.
            capture_root: home.join("tmp").join("captures"),
            jar_root: home.join("jars"),
            // An empty value is no endpoint: a scratch sets the variable on every run.
            cdp_endpoint: std::env::var("UNBROWSE_CDP").ok().filter(|s| !s.trim().is_empty()),
            settle_ms: 6_000,
        }
    }

    /// The headers a browser's navigation carries. A door reads this before it
    /// reads anything else; the same session without it draws an interstitial.
    pub fn browser_headers(host: &str, cookies: &str) -> Vec<(String, String)> {
        let origin = format!("https://{host}");
        vec![
            ("accept".into(), "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8".into()),
            ("accept-language".into(), "en-US,en;q=0.9".into()),
            ("cookie".into(), cookies.into()),
            ("referer".into(), format!("{origin}/")),
            ("sec-fetch-dest".into(), "document".into()),
            ("sec-fetch-mode".into(), "navigate".into()),
            ("sec-fetch-site".into(), "same-origin".into()),
            ("sec-fetch-user".into(), "?1".into()),
            ("upgrade-insecure-requests".into(), "1".into()),
        ]
    }

    /// The walk's own request headers for a host, as (name, value) pairs.
    pub fn walked_headers(capture_dir: &Path, session: &str, host: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for v in agent_browser_core::session::read_capture(&agent_browser_core::session::capture_path(capture_dir, session)) {
            if v.get("type").and_then(|t| t.as_str()) != Some("request") {
                continue;
            }
            let url = v.get("url").and_then(|u| u.as_str()).unwrap_or_default();
            if !url.contains(host) || v.get("method").and_then(|m| m.as_str()) != Some("GET") {
                continue;
            }
            let Some(h) = v.get("headers").and_then(|h| h.as_object()) else { continue };
            out = h
                .iter()
                .filter(|(k, _)| {
                    let k = k.to_ascii_lowercase();
                    !k.starts_with(':') && k != "cookie" && k != "content-length" && k != "host"
                })
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
            break;
        }
        out
    }

    /// Merge the walk's headers over the browser-shaped defaults.
    pub fn merged_headers(defaults: Vec<(String, String)>, walked: &[(String, String)]) -> Vec<(String, String)> {
        let mut out = defaults;
        for (k, v) in walked {
            match out.iter_mut().find(|(dk, _)| dk.eq_ignore_ascii_case(k)) {
                Some(slot) => slot.1 = v.clone(),
                None => out.push((k.clone(), v.clone())),
            }
        }
        out
    }

    /// Fetch a URL: walk, call browserless, fall back to the walk, and if the
    /// site refuses our own identity, walk again presenting the browser's.
    ///
    /// Identity negotiation is the last general lever: a bot manager can
    /// refuse an unknown user agent outright (a 403 from the site's own edge,
    /// no vendor host in the walk), and the same walk with a browser's agent
    /// passes. Starting honest and adapting on refusal keeps the stack's name
    /// on every site that accepts it.
    pub fn fetch(&self, url: &str) -> Result<Page, String> {
        // Fast path: a jar that still works means no browser at all. This is
        // what makes repeated unbrowsing cheap — the walk is paid once.
        if let Some(page) = self.cached_call(url) {
            return Ok(page);
        }
        let first = self.attempt(url, Some(NODE_USER_AGENT), "self");
        match &first {
            Ok(page) if page.status < 400 => return first,
            _ => {}
        }
        let second = self.attempt(url, None, "browser");
        match (&first, &second) {
            (_, Ok(page)) if page.status < 400 => Ok(page.clone()),
            (Ok(a), Ok(b)) if b.body.len() > a.body.len() => Ok(b.clone()),
            (Ok(a), _) => Ok(a.clone()),
            (Err(_), Ok(b)) => Ok(b.clone()),
            (Err(e), Err(_)) => Err(e.clone()),
        }
    }

    /// The host's jar file, if one was minted before.
    fn jar_path(&self, host: &str) -> PathBuf {
        self.jar_root.join(format!("{host}.json"))
    }

    fn read_jar(&self, host: &str) -> HashMap<String, String> {
        unbrowse_files::JAR.read_at(&self.jar_path(host)).ok().flatten().unwrap_or_default()
    }

    fn write_jar(&self, host: &str, jar: &HashMap<String, String>) {
        let _ = std::fs::create_dir_all(&self.jar_root);
        // A jar a newer node saved is never written over.
        if unbrowse_files::JAR.writable(&self.jar_path(host)).is_err() {
            return;
        }
        if let Ok(s) = unbrowse_files::JAR.to_vec(jar) {
            let _ = unbrowse_files::private::write(&self.jar_path(host), &s);
        }
    }

    /// How far each of a mint's cookies goes, kept beside the jar: the `Domain` the site set it for, so the route
    /// calls that share this folder send this walk's clearance to every host of the site it reaches — the harness
    /// mints into the same jar folder the route client keeps, so it keeps their files their way. It is rewritten
    /// whole whenever the jar is, reach or no reach, so the last walk's domains never outlive the cookies they
    /// described.
    fn write_scope(&self, host: &str, domains: &HashMap<String, String>) {
        let path = crate::client::scope_path(&self.jar_root, host);
        let _ = std::fs::create_dir_all(&self.jar_root);
        // A scope a newer node saved is never written over.
        if unbrowse_files::JAR.writable(&path).is_err() {
            return;
        }
        if let Ok(s) = unbrowse_files::JAR.to_vec(domains) {
            let _ = unbrowse_files::private::write(&path, &s);
        }
    }

    /// Call the URL with the stored session, no browser: the fast path.
    fn cached_call(&self, url: &str) -> Option<Page> {
        let parsed: url::Url = url.parse().ok()?;
        let host = parsed.host_str()?.to_string();
        let jar = self.read_jar(&host);
        if jar.is_empty() {
            return None;
        }
        let cookies: String = jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ");
        let headers = Self::browser_headers(&host, &cookies);
        let mut chrome = ChromeFetch::new().ok()?.with_identity(NODE_USER_AGENT);
        let req = Request {
            method: "GET".into(),
            url: parsed,
            headers,
            body: None,
            exchange: 0,
        };
        let e = chrome.fetch(&req).ok()?;
        let body = e.response_body.clone().unwrap_or_default();
        if e.status >= 400 || crate::page::a_door(e.status, &body, &e.url) {
            return None;
        }
        Some(Page {
            status: e.status,
            body,
            source: Source::Browserless,
            cookies: jar.len(),
            gates: Vec::new(),
        })
    }

    fn attempt(&self, url: &str, user_agent: Option<&str>, tag: &str) -> Result<Page, String> {
        let parsed: url::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
        let host = parsed.host_str().unwrap_or_default().to_string();
        let session = format!("{}_{}", host.replace('.', "_"), tag);
        let capture_dir = self.capture_root.clone();
        if let Some(parent) = capture_dir.parent() {
            let _ = unbrowse_files::private::dir_at(parent).and_then(|()| unbrowse_files::private::narrow(parent));
        }
        let _ = unbrowse_files::private::dir_at(&capture_dir);
        let _ = std::fs::remove_file(agent_browser_core::session::capture_path(&capture_dir, &session));

        // 1. the walk
        let mut mint = BrowserMint {
            try_controls: false,
            frames: None,
            seed: Vec::new(),
            browser: "in-process".into(),
            session: session.clone(),
            capture_dir: capture_dir.clone(),
            profile: Some(self.profile_root.join(&host).to_string_lossy().into_owned()),
            _host: host.clone(),
            user_agent: user_agent.map(|u| u.to_string()),
            cdp_endpoint: self.cdp_endpoint.clone(),
        };
        let jar = mint.mint(&parsed).map_err(|e| format!("mint: {e:?}"))?;
        if !jar.cookies.is_empty() {
            self.write_jar(&host, &jar.cookies);
            self.write_scope(&host, &jar.domains);
        }

        // What the walk saw: the gates on the way, the hosts of its door.
        let gates: Vec<String> = crate::walk::trace_from_walk(&capture_dir, &session)
            .map(|t| t.gates(&crate::identity::site_of(&host)))
            .unwrap_or_default();

        // 2. the browserless call
        let cookies: String = jar
            .cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ");
        let walked = Self::walked_headers(&capture_dir, &session, &host);
        let headers = Self::merged_headers(Self::browser_headers(&host, &cookies), &walked);
        // The call presents what the walk presented: the node's own name, or
        // the browser's when the site refused ours.
        let identity = match user_agent {
            Some(ua) => ua.to_string(),
            None => walked
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case("user-agent"))
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| NODE_USER_AGENT.to_string()),
        };
        let mut chrome = ChromeFetch::new()
            .map_err(|e| format!("transport: {e:?}"))?
            .with_identity(&identity);
        let req = Request {
            method: "GET".into(),
            url: parsed.clone(),
            headers,
            body: None,
            exchange: 0,
        };
        // Some doors judge the client's shape probabilistically: the same
        // call passes one moment and is challenged the next. Retrying costs
        // nothing but a moment — the walk, the jar and the headers are already
        // in hand — and turns a flaky door into a reliable one.
        let mut browserless = chrome.fetch(&req);
        for _ in 0..3 {
            let refused = match &browserless {
                Ok(e) => e.status >= 400 || crate::page::a_door(e.status, e.response_body.as_deref().unwrap_or(""), &e.url),
                Err(_) => true,
            };
            if !refused {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(700));
            browserless = chrome.fetch(&req);
        }
        if let Ok(e) = &browserless {
            let body = e.response_body.clone().unwrap_or_default();
            if e.status < 400 && !crate::page::a_door(e.status, &body, &e.url) {
                // A browserless answer can still be a shell the page hydrates
                // in JavaScript. When the walk's own page is far larger, it is
                // the hydrated one: serve that, and say so.
                let walked_size = agent_browser_core::session::walk_page(&capture_dir, &session)
                    .map(|(_, _, b)| b.len())
                    .unwrap_or(0);
                if walked_size > body.len() * 4 && walked_size > 20_000 {
                    if let Some((status, _mime, walked)) =
                        agent_browser_core::session::walk_page(&capture_dir, &session)
                    {
                        return Ok(Page {
                            status,
                            body: walked,
                            source: Source::Walk,
                            cookies: jar.cookies.len(),
                            gates,
                        });
                    }
                }
                return Ok(Page {
                    status: e.status,
                    body,
                    source: Source::Browserless,
                    cookies: jar.cookies.len(),
                    gates,
                });
            }
        }

        // 3. the walk's own response, for whatever the call could not get
        // The walk's own response for the URL; failing that (a redirect means
        // the browser ended somewhere else), the page it ended on.
        let walked_page = agent_browser_core::session::walk_response(&capture_dir, &session, url)
            .or_else(|| agent_browser_core::session::walk_page(&capture_dir, &session));
        if let Some((status, _mime, body)) = walked_page
        {
            return Ok(Page {
                status,
                body,
                source: Source::Walk,
                cookies: jar.cookies.len(),
                gates,
            });
        }

        // 4. nothing to serve: report what the call saw
        match browserless {
            Ok(e) => Ok(Page {
                status: e.status,
                body: e.response_body.unwrap_or_default(),
                source: Source::Browserless,
                cookies: jar.cookies.len(),
                gates,
            }),
            Err(e) => Err(format!("call failed: {e:?}")),
        }
    }

    /// Fetch several URLs with one walk each.
    pub fn fetch_all(&self, urls: &[String]) -> Vec<Result<Page, String>> {
        urls.iter().map(|u| self.fetch(u)).collect()
    }
}

/// A page as a JSON value, with where it came from: what a caller returns.
pub fn page_json(page: &Page) -> serde_json::Value {
    serde_json::json!({
        "status": page.status,
        "source": match page.source {
            Source::Browserless => "browserless",
            Source::Walk => "walk",
        },
        "cookies": page.cookies,
        "gates": page.gates,
        "body": page.body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session jar is the owner's alone, whichever part of the node keeps it.
    #[cfg(unix)]
    #[test]
    fn a_jar_the_site_fetcher_keeps_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("site-jar-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let site = Site { jar_root: dir.clone(), ..Site::new() };
        site.write_jar("shop.example", &HashMap::from([("sid".to_string(), "dummy".to_string())]));
        let mode = std::fs::metadata(dir.join("shop.example.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A walk this fetcher makes keeps how far each cookie goes beside the jar: the same folder the route client
    /// keeps, so its steps on another host of the site send this walk's clearance without opening a browser.
    #[test]
    fn the_site_fetcher_keeps_how_far_each_cookie_goes_beside_the_jar() {
        let dir = std::env::temp_dir().join(format!("site-jar-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let site = Site { jar_root: dir.clone(), ..Site::new() };
        site.write_jar("www.shop.example", &HashMap::from([("cf_clearance".to_string(), "site-wide-pass".to_string())]));
        site.write_scope("www.shop.example", &HashMap::from([("cf_clearance".to_string(), ".shop.example".to_string())]));
        let path = crate::client::scope_path(&dir, "www.shop.example");
        let read: HashMap<String, String> = unbrowse_files::JAR.read_at(&path).unwrap().unwrap();
        assert_eq!(read.get("cf_clearance").map(String::as_str), Some(".shop.example"));
        // Rewritten whole as the jar is: a walk that recorded no reach says so beside the jar, rather than leaving
        // the last walk's domains standing over cookies that aren't there.
        site.write_jar("plain.example", &HashMap::from([("sid".to_string(), "dummy".to_string())]));
        site.write_scope("plain.example", &HashMap::new());
        let read: HashMap<String, String> = unbrowse_files::JAR.read_at(&crate::client::scope_path(&dir, "plain.example")).unwrap().unwrap();
        assert!(read.is_empty(), "no reach recorded, no reach kept: {read:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn walked_headers_win_over_the_defaults() {
        let defaults = Site::browser_headers("example.com", "a=1");
        let walked = vec![
            ("accept".to_string(), "application/json".to_string()),
            ("x-custom".to_string(), "yes".to_string()),
        ];
        let merged = Site::merged_headers(defaults, &walked);
        assert_eq!(
            merged.iter().find(|(k, _)| k == "accept").map(|(_, v)| v.as_str()),
            Some("application/json")
        );
        assert!(merged.iter().any(|(k, v)| k == "x-custom" && v == "yes"));
        assert_eq!(merged.iter().filter(|(k, _)| k.eq_ignore_ascii_case("accept")).count(), 1);
    }

    #[test]
    fn a_browser_navigation_shape_is_always_present() {
        let h = Site::browser_headers("example.com", "s=1");
        for want in ["accept", "accept-language", "cookie", "referer", "sec-fetch-dest", "sec-fetch-mode"] {
            assert!(h.iter().any(|(k, _)| k == want), "missing {want}");
        }
    }

    #[test]
    fn page_reports_where_it_came_from() {
        let page = Page {
            status: 200,
            body: "x".into(),
            source: Source::Walk,
            cookies: 3,
            gates: vec!["js.px-cloud.net".into()],
        };
        let j = page_json(&page);
        assert_eq!(j["source"], "walk");
        assert_eq!(j["gates"][0], "js.px-cloud.net");
        assert!(page.ok());
    }
}
