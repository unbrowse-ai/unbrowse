//! Chrome-shaped HTTP: the TLS/HTTP2 fingerprint of a real Chrome, with the
//! node's own identity in the User-Agent. Many walls (Carousell's
//! `dynamic_block`, SISTIC's queue) judge the transport before any challenge
//! runs; those fall here, with no browser at all.
//!
//! The spec's line: this matches the *transport* a browser uses — the client
//! still says who it is (`unbrowse-node/<version>`), and it never pretends to
//! be a browser in script-visible ways. Where a wall needs script execution,
//! the mint (a real browser) is the honest tool.


use wreq::IntoEmulation;

use crate::replay::{Fetch, Request, ReplayError};
use crate::trace::Exchange;

/// A `Fetch` with a Chrome TLS/HTTP2 profile and a tokio runtime to block on.
pub struct ChromeFetch {
    /// The client and the runtime its connections live on, shared by every transport of the same rule and proxy
    /// (`shared`): a call reuses the connection the last call to the site left open instead of paying DNS, TCP and TLS
    /// again. The client holds no cookie and no identity (both go on each request), so the open connection is all one
    /// call leaves another.
    shared: std::sync::Arc<Shared>,
    user_agent: Option<String>,
    /// What the minting browser said about itself in `sec-ch-ua*`: Chrome sends these low-entropy hints on every
    /// request, so a call without them is a Chrome that isn't one. Read from the browser at mint, never guessed.
    hints: Option<ClientHints>,
    /// Whose rule every request, hop and answer is held to.
    egress: crate::egress::Egress,
    /// The latest a request may still be answering: none starts after it, and one under way is cut at it.
    until: Option<std::time::Instant>,
}

/// The low-entropy client hints Chrome sends on every request, as the minting browser reported them
/// (`navigator.userAgentData`). A site that checks the transport against the profile reads these; one that asked for
/// high-entropy hints through `Accept-CH` is a per-site shape the walk's own headers carry instead.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClientHints {
    /// Brand and version, in the browser's own order — the grease brand included, because the browser sent it.
    pub brands: Vec<(String, String)>,
    pub mobile: bool,
    pub platform: String,
}

impl ClientHints {
    /// The hints a fingerprint sample carries (`jars/<host>.json.fp`), when the browser reported them. A sample from
    /// an older mint has no `uaData`, and then there is nothing honest to send.
    pub fn of(sample: &serde_json::Value) -> Option<Self> {
        let data = sample.get("uaData")?.as_object()?;
        let mut brands = Vec::new();
        for b in data.get("brands")?.as_array()? {
            let (Some(brand), Some(version)) = (b.get("brand").and_then(|v| v.as_str()), b.get("version").and_then(|v| v.as_str())) else { continue };
            brands.push((brand.to_string(), version.to_string()));
        }
        let platform = data.get("platform").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if brands.is_empty() || platform.is_empty() {
            return None;
        }
        Some(Self { brands, mobile: data.get("mobile").and_then(|v| v.as_bool()).unwrap_or(false), platform })
    }

    /// The headers a browser sends for these hints, in the browser's shape: one quoted brand list, `?0`/`?1` for the
    /// mobile flag, and the platform quoted.
    pub fn headers(&self) -> Vec<(&'static str, String)> {
        let brands = self.brands.iter().map(|(b, v)| format!("\"{b}\";v=\"{v}\"")).collect::<Vec<_>>().join(", ");
        vec![
            ("sec-ch-ua", brands),
            ("sec-ch-ua-mobile", if self.mobile { "?1" } else { "?0" }.to_string()),
            ("sec-ch-ua-platform", format!("\"{}\"", self.platform)),
        ]
    }

    /// Added to a request's headers unless the route already set them: what the site said when it was learned is the
    /// more specific word, and a hint that disagrees with the walk is worse than the browser's default.
    pub fn add_to(&self, headers: &mut Vec<(String, String)>) {
        for (name, value) in self.headers() {
            if !headers.iter().any(|(h, _)| h.eq_ignore_ascii_case(name)) {
                headers.push((name.to_string(), value));
            }
        }
    }
}


/// Whether this build's TLS stack accepts the RSA-PSS-PSS signature algorithms the minting browser offers: asked once
/// per process, so a stack without them (`vendor/btls-sys` not patched with `chrome-pss.patch`) costs one failed build,
/// not one per call.
static SIGALGS_HELD: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether the transport's TLS stack held the browser's RSA-PSS-PSS set. A build that fell back presents a ClientHello
/// the minting browser does not have, and a clearance bound to the browser's handshake is refused on replay; the test
/// below holds every build to the patched stack instead of letting the fallback pass silently.
pub fn sigalgs_held() -> bool {
    *SIGALGS_HELD.get().unwrap_or(&false)
}

impl ChromeFetch {
    pub fn new() -> Result<Self, ReplayError> {
        Self::held_to(crate::egress::Egress::Own)
    }

    /// The transport for a call under `egress`: its resolver refuses an answer the rule doesn't allow, so the
    /// address checked is the address connected to, and every request and redirect hop is checked before it is sent.
    pub fn held_to(egress: crate::egress::Egress) -> Result<Self, ReplayError> {
        Self::held_to_proxy(egress, None)
    }

    /// [`ChromeFetch::held_to`] through `proxy` when the call's site is pinned: the node's own local proxy, so the
    /// pin that carries the browser carries the call too and both leave from one public address.
    pub fn held_to_proxy(egress: crate::egress::Egress, proxy: Option<&str>) -> Result<Self, ReplayError> {
        let shared = shared(egress, proxy)?;
        Ok(Self { shared, user_agent: None, hints: None, egress, until: None })
    }

    /// A client and its runtime, built once for each rule and proxy (and the settings read when it is built).
    fn build(egress: crate::egress::Egress, proxy: Option<&str>) -> Result<Shared, ReplayError> {
        let rt = tokio::runtime::Runtime::new().map_err(|e| ReplayError::BadUrl(e.to_string()))?;
        // The latest Chrome profile the crate ships, then aligned with the
        // browser actually minting our sessions: measured against the minting
        // Chrome 157 (tls.peet.ws, in-browser, 2026-11-20), its ClientHello
        // carries 18 counted extensions against the profile's 16 — the two it
        // adds are ECH GREASE and ALPS. A clearance is bound to the client that
        // earned it, so the set has to match, not merely resemble.
        let mut emulation = wreq_util::emulate::Emulation::Chrome149.into_emulation();
        if std::env::var("UNBROWSE_TLS_DEBUG").is_ok() {
            eprintln!("[tls] tls_options present: {}", emulation.tls_options.is_some());
        }
        if let Some(mut tls) = emulation.tls_options.take() {
            tls.enable_ech_grease = true;
            // Chrome sends a GREASE signature algorithm ahead of its real ones (peetprint's sigalgs field reads
            // `GREASE-2308-2309-2310-…`); the explicit sigalgs list below carries none, so peetprint differed from the
            // browser's by that one GREASE token even with JA4 equal. RFC 8701 GREASE puts it back (measured 2026-11-20).
            tls.grease_enabled = Some(true);
            // Chrome sends both ALPS codepoints while the new one rolls out;
            // the profile defaults to one, which leaves it an extension short.
            tls.alps_use_new_codepoint = std::env::var("UNBROWSE_ALPS_OLD").is_err();
            if tls.alps_protocols.is_none() {
                tls.alps_protocols = Some(std::borrow::Cow::Borrowed(&[
                    wreq::tls::AlpsProtocol::HTTP2,
                ]));
            }
            // Chrome 157's signature algorithms, measured from the minting browser against `tls.peet.ws`
            // (2026-11-20; its `ja4_r` ends `…_0904,0905,0906,0403,0804,0401,0503,0805,0501,0806,0601`), begin
            // with the RSA-PSS-PSS trio. Every other part of the ClientHello already matches (ciphers, extension
            // set and order, HTTP/2 settings and frame order); these three are what `chrome-pss.patch`
            // (`crates/learn/assets/chrome-clienthello/`, vendored by `scripts/apply-tls-patch.sh`) adds to the
            // fork's BoringSSL, so that a clearance bound to the browser's ClientHello can be spent. Without the
            // patch the stack refuses the set and falls back, and the transport's JA4 is not the browser's
            // (measured: `…_f9a770a73cc2` against the browser's `…_4980c97edce0`); `sigalgs_held()` is the alarm.
            if *SIGALGS_HELD.get().unwrap_or(&true) {
            tls.sigalgs_list = Some(std::borrow::Cow::Borrowed(
                "rsa_pss_pss_sha256:rsa_pss_pss_sha384:rsa_pss_pss_sha512:ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512",
            ));
            }
            if std::env::var("UNBROWSE_SIGALGS_DEBUG").is_ok() {
                eprintln!("[tls] sigalgs={:?}", tls.sigalgs_list.as_deref());
            }
            emulation.tls_options = Some(tls);
        }
        #[allow(unused_mut)]
        let mut builder = wreq::Client::builder()
            .emulation(emulation)
            // A public name that resolves inside the owner's network is refused before anything is sent, and the
            // client connects to what it resolved itself: no proxy from the environment resolves a name unchecked.
            .no_proxy()
            .dns_resolver(crate::egress::Resolver(egress))
            // Redirects are followed by `send`, hop by hop, so each hop decides what the request still carries.
            .redirect(wreq::redirect::Policy::none());
        if let Some(p) = proxy {
            // The node's own proxy: it resolves and checks the name, and carries a pinned site through its upstream.
            builder = builder.proxy(wreq::Proxy::all(p).map_err(|e| ReplayError::BadUrl(e.to_string()))?);
        }
        #[cfg(feature = "test-roots")]
        let builder = match test_roots()? {
            Some(store) => builder.tls_cert_store(store),
            None => builder,
        };
        let client = match builder.build() {
            Ok(client) => { let _ = SIGALGS_HELD.set(true); client }
            // A TLS stack without RSA-PSS-PSS (the crate's own, where `vendor/btls-sys` was not patched) refuses the
            // set: the call goes out on the shape it can send, rather than not at all. The cost is one build.
            Err(first) => {
                let _ = SIGALGS_HELD.set(false);
                let mut emulation = wreq_util::emulate::Emulation::Chrome149.into_emulation();
                if let Some(mut tls) = emulation.tls_options.take() {
                    tls.enable_ech_grease = true;
                    tls.alps_use_new_codepoint = std::env::var("UNBROWSE_ALPS_OLD").is_err();
                    if tls.alps_protocols.is_none() {
                        tls.alps_protocols = Some(std::borrow::Cow::Borrowed(&[wreq::tls::AlpsProtocol::HTTP2]));
                    }
                    emulation.tls_options = Some(tls);
                }
                let mut builder = wreq::Client::builder()
                    .emulation(emulation)
                    .no_proxy()
                    .dns_resolver(crate::egress::Resolver(egress))
                    .redirect(wreq::redirect::Policy::none());
                if let Some(p) = proxy {
                    builder = builder.proxy(wreq::Proxy::all(p).map_err(|e| ReplayError::BadUrl(e.to_string()))?);
                }
                #[cfg(feature = "test-roots")]
                let builder = match test_roots()? {
                    Some(store) => builder.tls_cert_store(store),
                    None => builder,
                };
                if std::env::var("UNBROWSE_SIGALGS_DEBUG").is_ok() {
                    eprintln!("[tls] this TLS stack has no RSA-PSS-PSS: the set is not asked for ({first})");
                }
                builder.build().map_err(|e| ReplayError::BadUrl(e.to_string()))?
            }
        };
        Ok(Shared { client, rt })
    }

}

/// A client and the runtime its connections run on.
struct Shared {
    client: wreq::Client,
    rt: tokio::runtime::Runtime,
}

/// The transport for `egress` through `proxy`, built the first time it is asked for and shared after. Kept for the
/// process's life: its runtime is never dropped inside another, and the client closes a connection idle past its pool's
/// timeout by itself. Keyed also by what `build` reads from the environment, so a setting changed is a new client.
fn shared(egress: crate::egress::Egress, proxy: Option<&str>) -> Result<std::sync::Arc<Shared>, ReplayError> {
    type Pool = std::sync::Mutex<Vec<(String, std::sync::Arc<Shared>)>>;
    static POOL: std::sync::OnceLock<Pool> = std::sync::OnceLock::new();
    let key = format!(
        "{egress:?}|{proxy:?}|{}|{}",
        std::env::var("UNBROWSE_ALPS_OLD").is_ok(),
        std::env::var("UNBROWSE_TEST_EXTRA_ROOTS").unwrap_or_default()
    );
    let pool = POOL.get_or_init(Default::default);
    if let Some((_, s)) = pool.lock().map_err(|_| ReplayError::BadUrl("the transport pool is poisoned".into()))?.iter().find(|(k, _)| *k == key) {
        return Ok(s.clone());
    }
    let built = std::sync::Arc::new(ChromeFetch::build(egress, proxy)?);
    let mut held = pool.lock().map_err(|_| ReplayError::BadUrl("the transport pool is poisoned".into()))?;
    // Another thread may have built it meanwhile: the first one kept is everyone's.
    if let Some((_, s)) = held.iter().find(|(k, _)| *k == key) {
        return Ok(s.clone());
    }
    held.push((key, built.clone()));
    Ok(built)
}

/// Test harness only (`antithesis/`, feature `test-roots`): the bundled Mozilla roots plus the PEM certificates in
/// `UNBROWSE_TEST_EXTRA_ROOTS`, so a fixture site can serve HTTPS under a test CA and a route another node listed runs
/// against it under the same HTTPS-only, public-address rule (`egress::Egress::Foreign`) as in production. A build
/// without the feature never reads the variable, and the rule itself is unchanged either way: only the trust anchors
/// differ.
#[cfg(feature = "test-roots")]
fn test_roots() -> Result<Option<wreq::tls::trust::CertStore>, ReplayError> {
    let Ok(path) = std::env::var("UNBROWSE_TEST_EXTRA_ROOTS") else {
        return Ok(None);
    };
    let pem = std::fs::read(&path).map_err(|e| ReplayError::BadUrl(format!("UNBROWSE_TEST_EXTRA_ROOTS {path}: {e}")))?;
    wreq::tls::trust::CertStore::builder()
        .add_der_certs(webpki_root_certs::TLS_SERVER_ROOT_CERTS)
        .add_stack_pem_certs(&pem)
        .build()
        .map(Some)
        .map_err(|e| ReplayError::BadUrl(format!("UNBROWSE_TEST_EXTRA_ROOTS {path}: {e}")))
}

impl ChromeFetch {
    /// The node's own identity, kept honest next to the Chrome-shaped transport.
    pub fn with_identity(mut self, ua: &str) -> Self {
        self.user_agent = Some(ua.to_string());
        self
    }

    /// The client hints the minting browser sent, so the transport and the profile agree: a Chrome-shaped ClientHello
    /// with no `sec-ch-ua` is a shape no Chrome has.
    pub fn with_client_hints(mut self, hints: Option<ClientHints>) -> Self {
        self.hints = hints;
        self
    }

    /// Holds every request after this to `deadline`, connection to last byte, every redirect hop included: a request
    /// past it is never sent, and one under way is cut there.
    pub fn until(&mut self, deadline: Option<std::time::Instant>) {
        self.until = deadline;
    }
}

impl ChromeFetch {
    /// The browser a fingerprint sample names (`jars/<host>.json.fp`), whole: its client hints and the user agent that
    /// goes with them. A request whose hints say one version and whose user agent says another is a shape no browser
    /// sends, and a door that reads both refuses it; the transport's own default user agent is whatever version its
    /// emulation was built for, which is the walk's browser only by chance. A sample without a user agent leaves the
    /// transport's own.
    pub fn as_sampled(self, sample: &serde_json::Value) -> Self {
        let named = sample.get("ua").and_then(|u| u.as_str()).filter(|u| !u.trim().is_empty()).map(String::from);
        let sampled = self.with_client_hints(ClientHints::of(sample));
        match named {
            Some(ua) => sampled.with_identity(&ua),
            None => sampled,
        }
    }
}

/// The user agent a request must go out with so it names the browser its client hints name, when the one it would
/// send doesn't: the hints say Chrome (or Chromium) at a major version, and `named` is absent or says another. A
/// Chrome's user agent is fixed by that version and its platform (the browser reduced it to exactly that), so the
/// hints say all of it. None when the two already agree, or the hints name no Chrome: nothing is made up for a
/// browser this transport isn't.
pub fn agreeing_user_agent(headers: &[(String, String)], named: Option<&str>) -> Option<String> {
    let header = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
    let brands = header("sec-ch-ua")?;
    // `"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"`: the browser's own brand, not the grease.
    let version = brands.split(',').find_map(|b| {
        let (brand, v) = b.split_once(";v=")?;
        let brand = brand.trim().trim_matches('"');
        (brand == "Google Chrome" || brand == "Chromium").then(|| v.trim().trim_matches('"').to_string())
    })?;
    if version.is_empty() || !version.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if named.is_some_and(|ua| ua.contains(&format!("Chrome/{version}."))) {
        return None;
    }
    let system = match header("sec-ch-ua-platform").map(|p| p.trim_matches('"').to_ascii_lowercase()).as_deref() {
        Some("windows") => "Windows NT 10.0; Win64; x64",
        Some("linux") => "X11; Linux x86_64",
        Some("macos") | None => "Macintosh; Intel Mac OS X 10_15_7",
        // A phone's or another system's user agent has parts the hints don't say.
        Some(_) => return None,
    };
    Some(format!("Mozilla/5.0 ({system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version}.0.0.0 Safari/537.36"))
}

/// Whether a request says it is a navigation: the browser's own words for it, read from the request, never from a
/// host. A page asked for as a page (`script_shape`'s `as_a_page`) carries these; a script's fetch does not.
fn is_navigation(headers: &[(String, String)]) -> bool {
    let says = |name: &str, word: &str| {
        headers.iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && v.trim().eq_ignore_ascii_case(word))
    };
    says("sec-fetch-mode", "navigate") || says("sec-fetch-dest", "document")
}

/// The order Chrome sends a navigation's headers in, measured from the minting Chrome 157's own wire
/// (net-export, 2026-11-20, a profile with the site's client hints cached). A door reads the order as part of the
/// client's shape; a transport that claims the browser's identity sends the browser's order, not the order a route's
/// fields happen to be stored in. The hint siblings marked *inferred* were not in the measured capture's hint set;
/// they sit with their measured family until a walk that carries them measures them too.
const CHROME_NAVIGATION_ORDER: &[&str] = &[
    "sec-ch-device-memory",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-arch",
    "sec-ch-ua-bitness", // *inferred: with arch
    "sec-ch-ua-platform",
    "sec-ch-ua-platform-version",
    "sec-ch-ua-model",
    "sec-ch-ua-full-version-list",
    "sec-ch-ua-form-factors",
    "sec-ch-dpr", // *inferred: the hint block
    "dpr",
    "ect",
    "rtt",
    "downlink",
    "upgrade-insecure-requests",
    "user-agent",
    "accept",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-user",
    "sec-fetch-dest",
    "accept-encoding",
    "accept-language",
    "cookie",
    "priority",
];

/// A navigation's headers as the browser sends them: the measured order, the user agent the hints agree with placed
/// in its slot, and the two defaults a navigation always carries (`accept-encoding`, `priority`) when the route did
/// not record them. Values are the route's own; only their order and the missing defaults are the browser's. A
/// request that is no navigation is left exactly as it was.
fn as_the_browser_sends(mut headers: Vec<(String, String)>, ua: Option<String>) -> Vec<(String, String)> {
    if !is_navigation(&headers) {
        return headers;
    }
    let has_encoding = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("accept-encoding"));
    let has_priority = headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("priority"));
    if let Some(ua) = ua {
        headers.retain(|(k, _)| !k.eq_ignore_ascii_case("user-agent"));
        headers.push(("user-agent".to_string(), ua));
    }
    if !has_encoding {
        headers.push(("accept-encoding".to_string(), "gzip, deflate, br, zstd".to_string()));
    }
    if !has_priority {
        headers.push(("priority".to_string(), "u=0, i".to_string()));
    }
    let rank = |k: &str| {
        CHROME_NAVIGATION_ORDER.iter().position(|n| n.eq_ignore_ascii_case(k))
            .unwrap_or(CHROME_NAVIGATION_ORDER.len())
    };
    // Stable: a header the order does not name keeps its place beside its own kind, after the named ones.
    headers.sort_by_key(|(k, _)| rank(k));
    headers
}

impl Fetch for ChromeFetch {
    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.send(req, true, None)
    }

    /// Redirects followed as [`Fetch::fetch`] follows them, every hop held to `within` before it is sent.
    fn fetch_within(&mut self, req: &Request, within: &crate::replay::Within) -> Result<Exchange, ReplayError> {
        self.send(req, true, Some(within))
    }

    /// A check that asks where a page lands: the answer is the redirect itself, not the page after it.
    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.send(req, false, None)
    }

    fn allows(&self, req: &Request) -> Result<(), ReplayError> {
        self.egress.request(&req.url).map_err(ReplayError::Refused)
    }

    fn minted(&self, _name: &str) -> Option<String> {
        None
    }
}

/// The request a redirect leads to, or why it is not followed. A browser follows the redirects a site hands it, so
/// does the call (a 307 from a country redirect is not a refusal), with the browser's rules for what the next request
/// is: a 303, and a 301 or 302 answering a POST, become a GET with no body; a 307 or 308 keeps its method and body.
///
/// What the request carries stays with the origin it was made for. A hop to another origin (scheme, host or port)
/// carries only what a browser sends on its own, never the route's session headers, tokens or cookies; and a body
/// that would follow to another origin is not sent there at all. No hop leads a call that began on the internet
/// inside the owner's network (`egress::hop_allowed`), and no hop of a route this node didn't learn itself leaves
/// HTTPS or the public internet (`Egress::hop`).
pub(crate) fn next_hop(egress: crate::egress::Egress, began: &str, req: &Request, status: u16, location: &str) -> Result<Request, ReplayError> {
    let to = req.url.join(location).map_err(|e| ReplayError::BadUrl(format!("a redirect to {location}: {e}")))?;
    if !matches!(to.scheme(), "http" | "https") {
        return Err(ReplayError::Transport(format!("{} redirected to {to}, which is not a web address", req.url)));
    }
    egress.hop(began, &to).map_err(ReplayError::Refused)?;
    let (method, body) = match status {
        307 | 308 => (req.method.clone(), req.body.clone()),
        303 if req.method != "HEAD" => ("GET".to_string(), None),
        301 | 302 if req.method == "POST" => ("GET".to_string(), None),
        _ => (req.method.clone(), req.body.clone()),
    };
    let same_origin = to.origin() == req.url.origin();
    if !same_origin && body.as_deref().is_some_and(|b: &[u8]| !b.is_empty()) {
        return Err(ReplayError::Transport(format!(
            "{} redirected the request's body to {}, another origin: the node doesn't send it there",
            req.url.origin().ascii_serialization(),
            to.origin().ascii_serialization()
        )));
    }
    let headers = req
        .headers
        .iter()
        .filter(|(k, _)| {
            let k = k.to_ascii_lowercase();
            // A body that is gone takes its description with it.
            let describes_body = k.starts_with("content-");
            let kept = same_origin || (crate::slots::is_browser_header(&k) && !matches!(k.as_str(), "cookie" | "origin" | "referer"));
            kept && !(body.is_none() && describes_body)
        })
        .cloned()
        .collect();
    Ok(Request { method, url: to, exchange: req.exchange, headers, body })
}

/// A refusal once the site has answered: the first request was made, so it can't say the call wasn't.
fn past_the_first_hop(e: ReplayError) -> ReplayError {
    match e {
        ReplayError::Refused(why) => ReplayError::RefusedHop(why),
        other => other,
    }
}

impl ChromeFetch {
    /// `within`, when the call is held to a route's own origins: every hop is checked against it before it is sent, and
    /// a redirect whose answer swaps the owner's session is not followed.
    fn send(&mut self, req: &Request, follow: bool, within: Option<&crate::replay::Within>) -> Result<Exchange, ReplayError> {
        let began = req.url.host_str().unwrap_or_default().to_string();
        let mut at = req.clone();
        // The cookies the site set on the hops so far: a browser keeps them before it follows the redirect.
        let mut kept: Vec<HopCookie> = Vec::new();
        // What the request's own origin set on the way (a sign-in's session, set on its redirect): handed on with the
        // answer, before the answer's own, so the route's jar keeps it for the calls after this one.
        let mut set_on_the_way: Vec<(String, String)> = Vec::new();
        for hop in 0..=crate::egress::MAX_REDIRECTS {
            // A site the owner is paying on is sent nothing, on any hop (`hold`).
            crate::hold::check_request(&at.url, &at.method).map_err(|e| if hop == 0 { e } else { past_the_first_hop(e) })?;
            // A route held to its own origins is held to them on every hop: a redirect to an address it doesn't name
            // ends the fetch here, nothing sent there, nothing of it handed back.
            if let Some(w) = within {
                w.admits(&at.url).map_err(|why| if hop == 0 { ReplayError::Refused(why) } else { ReplayError::RefusedHop(why) })?;
            }
            let (status, headers, body) = self.send_once(&at).map_err(|e| if hop == 0 { e } else { past_the_first_hop(e) })?;
            let location = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("location")).map(|(_, v)| v.clone());
            match location {
                Some(location) if follow && (300..400).contains(&status) && status != 304 => {
                    if let Some(name) = within.and_then(|w| w.replaced_by(&at, &headers)) {
                        within.inspect(|w| w.end(&name));
                        return Err(ReplayError::RefusedHop(format!("the site replaced the session this call was sent with (its {name} cookie) on a redirect: a route that came from another node doesn't follow it")));
                    }
                    keep_hop_cookies(&mut kept, &at.url, &headers);
                    if at.url.origin() == req.url.origin() {
                        set_on_the_way.extend(headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie")).cloned());
                    }
                    at = next_hop(self.egress, &began, &at, status, &location).map_err(past_the_first_hop)?;
                    send_hop_cookies(&mut at, &kept);
                }
                _ => {
                    return Ok(Exchange {
                        method: req.method.clone(),
                        // Where the request landed after the redirects it followed: a page the site sent it to
                        // instead is told apart by its address (`answer::detour`).
                        url: at.url.clone(),
                        request_headers: req.headers.clone(),
                        // The bytes sent, carried as text where they are one and marked where not (`wire::carried`).
                        request_body: req.body.as_deref().map(unbrowse_route::wire::carried),
                        status,
                        response_headers: set_on_the_way.into_iter().chain(headers).collect(),
                        response_body: (!body.is_empty()).then_some(body),
                        response_mime: String::new(),
                        resource_type: None,
                        main_frame: None,
                    })
                }
            }
        }
        Err(ReplayError::Transport("too many redirects".into()))
    }

    /// One request on the wire, redirects not followed: its status, headers and body.
    fn send_once(&mut self, req: &Request) -> Result<(u16, Vec<(String, String)>, String), ReplayError> {
        // Every request is checked here too, the first and every hop, whoever handed it over.
        self.egress.request(&req.url).map_err(ReplayError::Refused)?;
        let method = match req.method.as_str() {
            "GET" => wreq::Method::GET,
            "POST" => wreq::Method::POST,
            "PUT" => wreq::Method::PUT,
            "DELETE" => wreq::Method::DELETE,
            "PATCH" => wreq::Method::PATCH,
            other => wreq::Method::from_bytes(other.as_bytes()).map_err(|e| ReplayError::BadUrl(e.to_string()))?,
        };
        let mut builder = self.shared.client.request(method, req.url.as_str());
        // What the browser sends on every request, and this call's own headers win: a route learned under a shape
        // keeps that shape.
        let mut headers = req.headers.clone();
        if let Some(hints) = &self.hints {
            hints.add_to(&mut headers);
        }
        // One browser on the wire, whoever built the request: the user agent says the version the client hints say.
        // Held here, where every request leaves, so no caller can send the two apart (`agreeing_user_agent`).
        let named = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("user-agent")).map(|(_, v)| v.as_str()).or(self.user_agent.as_deref());
        let agreed = agreeing_user_agent(&headers, named);
        // A navigation leaves in the browser's own header order, its user agent in its slot; a script's call keeps
        // the order it was built in. The order is part of the shape a door reads (`as_the_browser_sends`).
        let nav = is_navigation(&headers);
        if nav {
            let ua = agreed.clone().or_else(|| self.user_agent.clone());
            headers = as_the_browser_sends(headers, ua);
            // A navigation carries the browser's complete shape; the client's own defaults (its emulation's user
            // agent beside the one placed here, its own accept-encoding) would ride beside it and double it. The
            // browser sends one of each, in its order (`as_the_browser_sends`).
            builder = builder.default_headers(false);
        }
        for (k, v) in &headers {
            // The request's own user agent gives way to the one that agrees, never rides beside it. A navigation's
            // user agent is already placed in its slot with the agreed value.
            if !nav && agreed.is_some() && k.eq_ignore_ascii_case("user-agent") {
                continue;
            }
            if let (Ok(name), Ok(value)) = (
                wreq::header::HeaderName::from_bytes(k.as_bytes()),
                wreq::header::HeaderValue::from_str(v),
            ) {
                builder = builder.header(name, value);
            }
        }
        if !nav {
            match &agreed {
                Some(ua) => builder = builder.header(wreq::header::USER_AGENT, ua.as_str()),
                None => {
                    if let Some(ua) = &self.user_agent {
                        builder = builder.header(wreq::header::USER_AGENT, ua.as_str());
                    }
                }
            }
        }
        if let Some(body) = &req.body {
            builder = builder.body(body.clone());
        }
        // Someone else's route waits a bounded time for its answer, connection to last byte (`egress::FOREIGN_TIMEOUT`),
        // and a request held to a deadline waits no later than it.
        let left = self.until.map(|d| d.saturating_duration_since(std::time::Instant::now()));
        if left.is_some_and(|l| l.is_zero()) {
            return Err(ReplayError::Refused("the time this request was given is up: nothing was sent".into()));
        }
        if let Some(t) = [self.egress.timeout(), left].into_iter().flatten().min() {
            builder = builder.timeout(t);
        }
        // What goes on the wire, by name only: values carry the session and stay out of logs.
        if std::env::var("UNBROWSE_WIRE_DEBUG").is_ok() {
            let names: Vec<&str> = headers.iter().map(|(k, _)| k.as_str()).collect();
            eprintln!("[wire] {} {} headers={names:?} body={}b", req.method, req.url, req.body.as_ref().map_or(0, |b| b.len()));
        }
        // A read of kept walks or kept routes (`offline`) asks no site: refused before a connection is opened.
        if OFFLINE.with(std::cell::Cell::get) {
            return Err(ReplayError::Refused(OFFLINE_WHY.into()));
        }
        SENT_HERE.with(|n| n.set(n.get() + 1));
        let resp = self.shared.rt.block_on(builder.send()).map_err(|e| match crate::egress::refusal_in(&e) {
            // The resolver refused the address before a connection was made: nothing was sent.
            Some(why) => ReplayError::Refused(why),
            None => ReplayError::Transport(with_causes(&e)),
        })?;
        let status = resp.status().as_u16();
        SENT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        // One line per request sent, beside `made.jsonl`, where `UNBROWSE_SENT_LOG` names a file: names and shapes
        // only (`sent_line`). Read once per process; unset, a call pays one branch.
        if let Some(path) = sent_log() {
            // What was handed to the client, in the order it left: a navigation's headers are already the browser's
            // whole shape (its user agent in its slot, `as_the_browser_sends`), so they are logged as they are; a
            // script's call gives its route user agent way to the agreed one, appended as the loop appends it. A
            // header whose name or value the client refuses was never sent.
            let on_the_wire: Vec<(String, String)> = headers
                .iter()
                .filter(|(k, _)| !(!nav && agreed.is_some() && k.eq_ignore_ascii_case("user-agent")))
                .filter(|(k, v)| wreq::header::HeaderName::from_bytes(k.as_bytes()).is_ok() && wreq::header::HeaderValue::from_str(v).is_ok())
                .cloned()
                .chain(if nav { None } else { agreed.clone().or_else(|| self.user_agent.clone()).map(|ua| ("user-agent".to_string(), ua)) })
                .collect();
            note_sent(path, &sent_line(req, &on_the_wire, status, protocol(resp.version()), now_ms()));
        }
        let mut response_headers = Vec::new();
        for (k, v) in resp.headers().iter() {
            if let Ok(v) = v.to_str() {
                response_headers.push((k.as_str().to_string(), v.to_string()));
            }
        }
        let event_stream = resp
            .headers()
            .get(wreq::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|m| m.to_ascii_lowercase().contains("text/event-stream"));
        let content_type = resp.headers().get(wreq::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        let binary = resp.headers().get(wreq::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).filter(|m| unbrowse_route::wire::named(m).is_some()).map(String::from);
        let response_body = if event_stream {
            // The events it has sent are the answer: the stream is the site's to keep open, not the call's to wait on.
            let body = self.shared.rt.block_on(read_event_stream(resp.bytes_stream()));
            String::from_utf8_lossy(&body).into_owned()
        } else {
            match self.egress.answer_max() {
            // Someone else's route gets an answer of bounded size, refused as soon as it says or sends more.
            Some(max) => {
                if resp.content_length().is_some_and(|n| n > max as u64) {
                    return Err(ReplayError::Transport(format!("the answer is larger than {max} bytes: someone else's route gets no more than that")));
                }
                let read = crate::egress::read_stream_capped(Box::pin(resp.bytes_stream()), max);
                unbrowse_route::wire::reply_read(binary.as_deref().unwrap_or_default(), &self.shared.rt.block_on(read).map_err(ReplayError::Transport)?)
            }
            None => match binary {
                // A binary answer of a codec the engine reads is read as the JSON it holds, as a walk records it.
                Some(mime) => {
                    let bytes = self.shared.rt.block_on(resp.bytes()).map_err(|e| ReplayError::Transport(format!("{e}")))?;
                    unbrowse_route::wire::reply_read(&mime, &bytes)
                }
                None => {
                    // Read as the walk records it: a binary answer its content type mislabels (a protobuf body served
                    // as application/json) is sniffed and read as the JSON it holds, not lossy text (`wire::reply_text`).
                    let bytes = self.shared.rt.block_on(resp.bytes()).map_err(|e| ReplayError::Transport(format!("{e}")))?;
                    unbrowse_route::wire::reply_read(&content_type, &bytes)
                }
            },
            }
        };
        Ok((status, response_headers, response_body))
    }
}

/// The requests this process has put on the wire and been answered for, the ones a sent log has a line each for
/// (`UNBROWSE_SENT_LOG`), counted whether or not one is kept: the difference across a stretch of work is what it sent.
static SENT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

thread_local! {
    /// Whether this thread is reading kept walks or kept routes (`offline`): every request is refused unsent.
    static OFFLINE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// Requests this thread handed to the wire, refused ones not counted (`sent_here`).
    static SENT_HERE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Why a request made while `offline` was not sent.
pub const OFFLINE_WHY: &str = "offline: a read of kept walks or kept routes asks no site";

/// Holds this thread offline while it lives (`offline`).
pub struct Offline(bool);

impl Drop for Offline {
    fn drop(&mut self) {
        OFFLINE.with(|o| o.set(self.0));
    }
}

/// Holds this thread offline until the guard is dropped: every request it makes is refused before a connection is
/// opened (`OFFLINE_WHY`), so a read of a corpus, the lab's walks or a node's kept routes reaches no site by
/// construction, whatever the learn's own settings ask of a site. The first line of every such test.
pub fn offline() -> Offline {
    Offline(OFFLINE.with(|o| o.replace(true)))
}

/// The requests this thread has handed to the wire so far: what a stretch of work on one thread sent.
pub fn sent_here() -> u64 {
    SENT_HERE.with(std::cell::Cell::get)
}

/// The requests this process has sent so far and been answered for (`SENT`), across every thread.
pub fn sent_so_far() -> u64 {
    SENT.load(std::sync::atomic::Ordering::Relaxed)
}

/// Where each request sent is written (`UNBROWSE_SENT_LOG`), read once per process: None leaves the call as it was.
static SENT_LOG: std::sync::OnceLock<Option<std::path::PathBuf>> = std::sync::OnceLock::new();

fn sent_log() -> Option<&'static std::path::Path> {
    SENT_LOG.get_or_init(|| std::env::var_os("UNBROWSE_SENT_LOG").filter(|p| !p.is_empty()).map(std::path::PathBuf::from)).as_deref()
}

/// The most a sent log grows to: past it no line is added, so a long-running node never fills a disk with it.
pub(crate) const SENT_MOST: u64 = 8 * 1024 * 1024;

/// The most header names a line carries.
const SENT_NAMES: usize = 64;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn protocol(v: wreq::Version) -> &'static str {
    if v == wreq::Version::HTTP_2 {
        "h2"
    } else if v == wreq::Version::HTTP_3 {
        "h3"
    } else if v == wreq::Version::HTTP_11 || v == wreq::Version::HTTP_10 || v == wreq::Version::HTTP_09 {
        "h1"
    } else {
        "unknown"
    }
}

/// What one request put on the wire, by name and shape, never a value: its exchange, method and site, its header names
/// in the order they were handed to the client (the emulation adds its own defaults where a name is missing), each
/// value's length, the names of the cookies its `cookie` header carried, the body's length, the protocol the answer
/// came back on and its status. Neither the path nor the whole host is written, since either may carry the caller's
/// values (a step whose address builds its host from what the caller asked): the host's site (`identity::site_of`)
/// says where it went, and the exchange which step it was.
pub(crate) fn sent_line(req: &Request, headers: &[(String, String)], status: u16, proto: &str, at_ms: u64) -> serde_json::Value {
    let names: Vec<String> = headers.iter().take(SENT_NAMES).map(|(k, _)| k.to_ascii_lowercase()).collect();
    let lens: Vec<usize> = headers.iter().take(SENT_NAMES).map(|(_, v)| v.len()).collect();
    let cookies: Vec<String> = headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
        .flat_map(|(_, v)| v.split(';'))
        .filter_map(|p| p.trim().split_once('=').map(|(k, _)| k.to_string()))
        .take(SENT_NAMES)
        .collect();
    serde_json::json!({
        "v": 1,
        "at_ms": at_ms,
        "exchange": (req.exchange != usize::MAX).then_some(req.exchange),
        "method": req.method,
        "site": req.url.host_str().map(crate::identity::site_of).unwrap_or_default(),
        "headers": names,
        "lens": lens,
        "cookies": cookies,
        "body": req.body.as_ref().map_or(0, Vec::len),
        "proto": proto,
        "status": status,
    })
}

/// Appends a sent line to `path`, unless the file has reached `SENT_MOST`. A line that can't be written costs the
/// call nothing.
pub(crate) fn note_sent(path: &std::path::Path, line: &serde_json::Value) {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= SENT_MOST) {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// How long an event stream may go quiet before what arrived is the answer, how much of it a call keeps, and how long
/// a stream may hold the call at most. An SSE answer is a stream the site may keep open for as long as it likes:
/// waiting for its end is waiting for the site to hang up, and a call would pay for every second of that.
pub(crate) const STREAM_QUIET: std::time::Duration = std::time::Duration::from_secs(60);
pub(crate) const STREAM_MOST: std::time::Duration = std::time::Duration::from_secs(120);
pub(crate) const STREAM_CAP: usize = 2 * 1024 * 1024;

/// Reads an event stream's answer: the events it sent, until it goes quiet, says `[DONE]`, sends more than a call
/// carries, or holds the call longer than it may. What the site has said so far is the data an SSE endpoint answers
/// with; the reader is the site's to end, not the call's.
pub(crate) async fn read_event_stream<S, B, E>(body: S) -> Vec<u8>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    read_event_stream_with(STREAM_QUIET, STREAM_MOST, STREAM_CAP, body).await
}

/// [`read_event_stream`] with the marks given, so a test needn't wait out the real ones.
pub(crate) async fn read_event_stream_with<S, B, E>(quiet: std::time::Duration, most: std::time::Duration, cap: usize, mut body: S) -> Vec<u8>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;
    let start = std::time::Instant::now();
    let mut out: Vec<u8> = Vec::new();
    while out.len() < cap && start.elapsed() < most {
        match tokio::time::timeout(quiet, body.next()).await {
            Ok(Some(Ok(chunk))) => {
                out.extend_from_slice(chunk.as_ref());
                if out.windows(6).any(|w| w.eq_ignore_ascii_case(b"[DONE]")) {
                    break;
                }
            }
            Ok(Some(Err(_))) | Ok(None) => break,
            // Nothing for `quiet`: the site has said all it is going to say now.
            Err(_) => break,
        }
    }
    finished_events(out)
}

/// [`read_event_stream`] for a blocking body: a reader thread fills a channel, and the call stops at the same quiet
/// mark. The thread ends when the stream does, or at its next chunk after the call stopped listening.
pub(crate) fn read_event_stream_blocking(mut body: impl std::io::Read + Send + 'static) -> Vec<u8> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match body.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let start = std::time::Instant::now();
    let mut out: Vec<u8> = Vec::new();
    while out.len() < STREAM_CAP && start.elapsed() < STREAM_MOST {
        match rx.recv_timeout(STREAM_QUIET) {
            Ok(chunk) => {
                out.extend_from_slice(&chunk);
                if out.windows(6).any(|w| w.eq_ignore_ascii_case(b"[DONE]")) {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    finished_events(out)
}

/// `out` up to its last finished event: half a line the site was still writing is not data, and an answer that
/// stops mid-event is read as one that ended.
fn finished_events(mut out: Vec<u8>) -> Vec<u8> {
    if let Some(end) = out.windows(2).rposition(|w| w == b"\n\n") {
        out.truncate(end + 2);
    }
    out
}

/// A cookie a site set on a redirect, kept for the hops after it the way a browser keeps it: by the host (or the
/// domain it names), the path and whether it needs HTTPS. A cookie set to expire is a deletion.
#[derive(Clone, Debug, PartialEq)]
struct HopCookie {
    name: String,
    value: Option<String>,
    domain: String,
    host_only: bool,
    path: String,
    secure: bool,
}

impl HopCookie {
    fn goes_to(&self, url: &url::Url) -> bool {
        let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
        let host_ok = if self.host_only { host == self.domain } else { host == self.domain || host.ends_with(&format!(".{}", self.domain)) };
        host_ok && path_matches(&self.path, url.path()) && (!self.secure || url.scheme() == "https")
    }
}

/// Whether a cookie set for `cookie_path` goes with a request for `path` (RFC 6265 §5.1.4): the same path, or one under
/// it, `/api` reaching `/api/x` and never `/apix`.
pub fn path_matches(cookie_path: &str, path: &str) -> bool {
    path == cookie_path || (path.starts_with(cookie_path) && (cookie_path.ends_with('/') || path[cookie_path.len()..].starts_with('/')))
}

/// The path a `Set-Cookie` line sends its cookie to, as a browser reads it (RFC 6265 §5.2.4, §5.1.4): its own `Path`
/// when that starts with `/`, else the folder of the address that set it.
pub fn cookie_path(line: &str, set_at: &url::Url) -> String {
    let said = line.split(';').skip(1).find_map(|a| {
        let (k, v) = a.split_once('=').map(|(k, v)| (k.trim(), v.trim())).unwrap_or((a.trim(), ""));
        k.eq_ignore_ascii_case("path").then(|| v.to_string())
    });
    match said.filter(|p| p.starts_with('/')) {
        Some(p) => p,
        None => set_at.path().rsplit_once('/').map(|(d, _)| d).filter(|d| !d.is_empty()).unwrap_or("/").to_string(),
    }
}

/// Whether a `Set-Cookie` line keeps its cookie from a page's script (`HttpOnly`).
pub fn cookie_http_only(line: &str) -> bool {
    line.split(';').skip(1).any(|a| a.trim().eq_ignore_ascii_case("httponly"))
}

/// A `Set-Cookie` date read the way a browser reads one (RFC 6265 §5.1.1), in Unix seconds: its tokens, split on the
/// characters the RFC names, give a time (`hh:mm:ss`), a day of the month, a month by its first three letters, and a
/// year (two digits read as 1970-2069). Any order, any separators (`Thu, 01-Jan-1970 00:00:00 GMT` reads like
/// `Thu, 01 Jan 1970 00:00:00 GMT`). None for text that isn't a date: the line then names no life.
pub fn cookie_date(date: &str) -> Option<f64> {
    let delimiter = |c: char| c == '\t' || (' '..='/').contains(&c) || (';'..='@').contains(&c) || ('['..='`').contains(&c) || ('{'..='~').contains(&c);
    let (mut time, mut day, mut month, mut year) = (None, None, None, None);
    for token in date.split(delimiter).filter(|t| !t.is_empty()) {
        let digits = |t: &str, lo: usize, hi: usize| {
            let n = t.chars().take_while(char::is_ascii_digit).count();
            (lo..=hi).contains(&n).then(|| t[..n].parse::<u32>().ok()).flatten()
        };
        if time.is_none() {
            let parts: Vec<&str> = token.splitn(3, ':').collect();
            if parts.len() == 3 {
                if let (Some(h), Some(m), Some(s)) = (digits(parts[0], 1, 2), digits(parts[1], 1, 2), digits(parts[2], 1, 2)) {
                    time = Some((h, m, s));
                    continue;
                }
            }
        }
        if day.is_none() {
            if let Some(d) = digits(token, 1, 2) {
                day = Some(d);
                continue;
            }
        }
        if month.is_none() {
            let lower = token.to_ascii_lowercase();
            if let Some(i) = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].iter().position(|m| lower.starts_with(m)) {
                month = Some(i as u32 + 1);
                continue;
            }
        }
        if year.is_none() {
            if let Some(y) = digits(token, 2, 4) {
                year = Some(match y {
                    70..=99 => y + 1900,
                    0..=69 => y + 2000,
                    y => y,
                });
                continue;
            }
        }
    }
    let ((h, mi, s), d, mo, y) = (time?, day?, month?, year?);
    if !(1..=31).contains(&d) || y < 1601 || h > 23 || mi > 59 || s > 59 {
        return None;
    }
    // Days from 1970-01-01 to the date, by the civil calendar.
    let (y, mo) = (i64::from(y) - i64::from(mo <= 2), i64::from(mo));
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + i64::from(h) * 3_600 + i64::from(mi) * 60 + i64::from(s)) as f64)
}

/// When a `Set-Cookie` line's cookie runs out, in Unix seconds: from its `Max-Age` when it has one (which wins, RFC 6265
/// §5.3; zero or less is now), else from its `Expires`. None when it names neither, or a date that doesn't read: a
/// cookie that lives as long as its session. The one reader of a cookie's life from its line.
pub fn cookie_expiry(line: &str) -> Option<f64> {
    let attr = |name: &str| {
        line.split(';').skip(1).find_map(|a| {
            let (k, v) = a.split_once('=').map(|(k, v)| (k.trim(), v.trim())).unwrap_or((a.trim(), ""));
            k.eq_ignore_ascii_case(name).then(|| v.to_string())
        })
    };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    match attr("max-age").and_then(|v| v.parse::<i64>().ok()) {
        Some(seconds) => Some(if seconds <= 0 { 0.0 } else { now + seconds as f64 }),
        None => attr("expires").and_then(|v| cookie_date(&v)),
    }
}

/// Whether a `Set-Cookie` line ends its cookie: its life ([`cookie_expiry`]) is already over, Max-Age winning where a
/// line has both (RFC 6265 §5.3).
pub fn ends_the_cookie(line: &str) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    cookie_expiry(line).is_some_and(|e| e <= now)
}

/// Reads the cookies a hop's answer sets (`url` is where it was asked), into `kept`: a newer one of the same name,
/// domain and path takes the older one's place. A Domain the host isn't in is refused, as a browser refuses it, and so
/// is one that is a public suffix (a Domain off the host's own site), as a browser refuses that too.
fn keep_hop_cookies(kept: &mut Vec<HopCookie>, url: &url::Url, headers: &[(String, String)]) {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    for (_, line) in headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie")) {
        let mut parts = line.split(';');
        let Some((name, value)) = parts.next().and_then(|p| p.split_once('=')) else { continue };
        let name = name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let dir = url.path().rsplit_once('/').map(|(d, _)| d).filter(|d| !d.is_empty()).unwrap_or("/");
        let mut c = HopCookie { name, value: Some(value.trim().to_string()), domain: host.clone(), host_only: true, path: dir.to_string(), secure: false };
        let mut refused = false;
        for attr in parts {
            let (k, v) = attr.split_once('=').map(|(k, v)| (k.trim(), v.trim())).unwrap_or((attr.trim(), ""));
            match k.to_ascii_lowercase().as_str() {
                "domain" if !v.is_empty() => {
                    let d = v.trim_start_matches('.').to_ascii_lowercase();
                    // A domain the host is in, and on the host's own site: a public suffix (`co.uk`, a hosting suffix)
                    // spans every site under it, so a cookie set for one would go to the next hop on another site.
                    if crate::identity::at_or_under(&host, &d) && (host == d || crate::identity::same_site(&d, &host)) {
                        (c.domain, c.host_only) = (d, false);
                    } else {
                        refused = true;
                    }
                }
                "path" if v.starts_with('/') => c.path = v.to_string(),
                "secure" => c.secure = true,
                _ => {}
            }
        }
        // A line whose life is over (Max-Age, or else Expires, already past) takes the cookie off.
        if ends_the_cookie(line) {
            c.value = None;
        }
        if refused {
            continue;
        }
        kept.retain(|o| !(o.name == c.name && o.domain == c.domain && o.path == c.path));
        kept.push(c);
    }
}

/// Puts the kept cookies that go to `req`'s address on its Cookie header, in place of the ones of the same name it
/// carries, and takes off the ones the site deleted.
fn send_hop_cookies(req: &mut Request, kept: &[HopCookie]) {
    let going: Vec<&HopCookie> = kept.iter().filter(|c| c.goes_to(&req.url)).collect();
    if going.is_empty() {
        return;
    }
    let had = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
    let mut pairs: Vec<(String, String)> = had
        .split(';')
        .filter_map(|p| p.split_once('=').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .filter(|(k, _)| !k.is_empty())
        .collect();
    for c in going {
        pairs.retain(|(k, _)| *k != c.name);
        if let Some(v) = &c.value {
            pairs.push((c.name.clone(), v.clone()));
        }
    }
    req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case("cookie"));
    if !pairs.is_empty() {
        req.headers.push(("cookie".into(), pairs.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")));
    }
}

/// An error with what caused it, down the chain: a failed connect says why it failed (a refused name, a bad
/// certificate), not only that it did.
fn with_causes(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cause = e.source();
    while let Some(c) = cause {
        let said = c.to_string();
        if !out.contains(&said) {
            out.push_str(": ");
            out.push_str(&said);
        }
        cause = c.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::egress::Egress::{Foreign, Own};

    /// The transport's handshake is the minting browser's: a door binds its clearance to the ClientHello that earned
    /// it, so a transport whose TLS stack cannot offer the browser's RSA-PSS-PSS signature algorithms spends a
    /// clearance the site refuses. The fallback that keeps unpatched builds calling must not pass silently here.
    #[test]
    fn the_transport_holds_the_browsers_pss_pss_signature_algorithms() {
        let _ = ChromeFetch::new().expect("the transport builds");
        assert!(
            sigalgs_held(),
            "the TLS stack refused the RSA-PSS-PSS set the minting browser offers: a door-bound clearance would be \
             refused on replay. Run scripts/apply-tls-patch.sh, and clear the btls-sys cmake cache \
             (target/debug/build/btls-sys-*) so the patched BoringSSL is actually compiled."
        );
    }

    /// A navigation is asked in the browser's header order, not the order a route's fields were stored in: the order
    /// is part of the shape a door reads, measured from the minting browser's own wire.
    #[test]
    fn a_navigation_leaves_in_the_browsers_header_order() {
        // The order a learner's storage happened to keep (the shape a refused replay sent, 2026-11-20).
        let stored = vec![
            ("sec-fetch-user", "?1"), ("upgrade-insecure-requests", "1"), ("rtt", "50"),
            ("sec-ch-ua", "\"Chromium\";v=\"157\""), ("accept", "text/html"), ("sec-fetch-mode", "navigate"),
            ("sec-fetch-dest", "document"), ("sec-fetch-site", "none"), ("accept-language", "en-US,en;q=0.9"),
            ("cookie", "datadome=earned"),
        ].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let sent = as_the_browser_sends(stored, Some("Mozilla/5.0 Chrome/157.0.0.0".into()));
        let names: Vec<&str> = sent.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, vec![
            "sec-ch-ua", "rtt", "upgrade-insecure-requests", "user-agent", "accept",
            "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest",
            "accept-encoding", "accept-language", "cookie", "priority",
        ], "the browser's order, the agent in its slot, the two defaults present: {names:?}");
        let val = |n: &str| sent.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
        assert_eq!(val("user-agent"), Some("Mozilla/5.0 Chrome/157.0.0.0"));
        assert_eq!(val("accept-encoding"), Some("gzip, deflate, br, zstd"));
        assert_eq!(val("priority"), Some("u=0, i"));
        assert_eq!(val("cookie"), Some("datadome=earned"), "the route's own values are kept");
    }

    /// A script's call is no navigation: its order is its own, and nothing is added to it.
    #[test]
    fn a_scripts_call_keeps_its_own_order() {
        let call = vec![
            ("accept", "application/json"), ("sec-fetch-mode", "cors"), ("sec-fetch-dest", "empty"),
            ("x-token", "t"),
        ].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let sent = as_the_browser_sends(call.clone(), Some("ua".into()));
        assert_eq!(sent, call, "a fetch is not reordered and gains no navigation defaults");
    }

    /// A sent line says what went on the wire by name and shape, and never a value: the session's cookies, a token
    /// header, the body and the caller's word in the address stay out; names keep their order.
    #[test]
    fn a_sent_line_names_and_measures_and_never_holds_a_value() {
        let req = Request {
            method: "POST".into(),
            url: "https://lamps.shop.example/api/find?q=lamps".parse().unwrap(),
            exchange: 3,
            headers: Vec::new(),
            body: Some(b"{\"q\":\"lamps\"}".to_vec()),
        };
        let headers = vec![
            ("X-Token".to_string(), "tok-9f3k2m8q7z1x4b".to_string()),
            ("accept".to_string(), "*/*".to_string()),
            ("cookie".to_string(), "sid=sess-Zk3Qm9Lx2Pv7; theme=dark".to_string()),
        ];
        let line = sent_line(&req, &headers, 403, "h2", 7);
        let text = line.to_string();
        for value in ["tok-9f3k2m8q7z1x4b", "sess-Zk3Qm9Lx2Pv7", "dark", "lamps", "*/*"] {
            assert!(!text.contains(value), "{value} leaked: {text}");
        }
        assert_eq!(line["headers"], serde_json::json!(["x-token", "accept", "cookie"]));
        assert_eq!(line["lens"], serde_json::json!([18, 3, 33]));
        assert_eq!(line["cookies"], serde_json::json!(["sid", "theme"]));
        assert_eq!((line["exchange"].clone(), line["status"].clone(), line["proto"].clone(), line["body"].clone()), (serde_json::json!(3), serde_json::json!(403), serde_json::json!("h2"), serde_json::json!(13)));
        assert_eq!(line["site"], "shop.example", "the host's site, not a host that carries the caller's word");
        // A request that is no step of a route (a page fetched for its markup) has no exchange.
        let page = Request { exchange: usize::MAX, ..req };
        assert!(sent_line(&page, &[], 200, "h1", 7)["exchange"].is_null());
    }

    /// The sent log stops growing at its bound: a node left running never fills the disk with it.
    #[test]
    fn the_sent_log_stops_at_its_bound() {
        let dir = std::env::temp_dir().join(format!("sent-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sent.jsonl");
        std::fs::write(&path, vec![b'x'; SENT_MOST as usize]).unwrap();
        note_sent(&path, &serde_json::json!({"v": 1}));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), SENT_MOST, "nothing is added past the bound");
        std::fs::write(&path, b"").unwrap();
        note_sent(&path, &serde_json::json!({"v": 1}));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"v\":1}\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Whoever builds a request, it leaves naming one browser: hints for one version under a user agent for another
    /// (or none) are brought to agree where the request is sent. Hints that name no Chrome, and a pair that already
    /// agrees, are left alone.
    #[test]
    fn a_request_leaves_naming_the_browser_its_hints_name() {
        let hints = |v: &str, platform: &str| vec![("sec-ch-ua".to_string(), format!("\"Not-A.Brand\";v=\"99\", \"Google Chrome\";v=\"{v}\", \"Chromium\";v=\"{v}\"")), ("sec-ch-ua-platform".to_string(), format!("\"{platform}\""))];
        let older = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
        let agreed = agreeing_user_agent(&hints("157", "macOS"), Some(older)).expect("the two disagree");
        assert!(agreed.contains("Chrome/157.0.0.0") && agreed.contains("Macintosh"), "{agreed}");
        assert!(agreeing_user_agent(&hints("157", "Windows"), None).is_some_and(|ua| ua.contains("Windows NT 10.0") && ua.contains("Chrome/157.")));
        assert_eq!(agreeing_user_agent(&hints("149", "macOS"), Some(older)), None, "already one browser");
        assert_eq!(agreeing_user_agent(&[], Some(older)), None, "no hints: nothing to agree with");
        assert_eq!(agreeing_user_agent(&[("sec-ch-ua".into(), "\"Brave\";v=\"1\"".into())], None), None, "not a Chrome");
        assert_eq!(agreeing_user_agent(&hints("157", "Android"), Some(older)), None, "a phone's user agent says more than the hints do");
    }

    /// The transport names one browser: the user agent the sample holds goes out beside the hints it holds, so the two
    /// never say different versions (a door that reads both answered 403 to a version-157 hint under the transport's
    /// own older user agent). A sample that names no user agent leaves the transport's.
    #[test]
    fn the_user_agent_is_the_sampled_browsers_beside_its_hints() {
        let ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
        let sample = serde_json::json!({
            "ua": ua,
            "uaData": { "brands": [{ "brand": "Chromium", "version": "157" }], "mobile": false, "platform": "macOS" }
        });
        let t = ChromeFetch::new().unwrap().as_sampled(&sample);
        assert_eq!(t.user_agent.as_deref(), Some(ua));
        assert_eq!(t.hints.as_ref().map(|h| h.brands.clone()), Some(vec![("Chromium".to_string(), "157".to_string())]));
        let bare = ChromeFetch::new().unwrap().as_sampled(&serde_json::json!({ "lang": "en-US" }));
        assert!(bare.user_agent.is_none() && bare.hints.is_none());
    }

    /// The client hints a browser sends are the ones it reported at mint: the greet brands in the browser's own
    /// order, the mobile flag, and the platform, in Chrome's shape. A sample from a mint that recorded none sends
    /// nothing rather than a guess.
    #[test]
    fn the_client_hints_are_the_browsers_own() {
        let sample = serde_json::json!({
            "ua": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
            "uaData": {
                "brands": [
                    { "brand": "Chromium", "version": "156" },
                    { "brand": "Not.A/Brand", "version": "99" },
                    { "brand": "Google Chrome", "version": "156" }
                ],
                "mobile": false,
                "platform": "macOS"
            }
        });
        let hints = ClientHints::of(&sample).expect("the sample carries the browser's own hints");
        let h: Vec<(String, String)> = hints.headers().into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let got = |n: &str| h.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
        assert_eq!(got("sec-ch-ua"), Some("\"Chromium\";v=\"156\", \"Not.A/Brand\";v=\"99\", \"Google Chrome\";v=\"156\""));
        assert_eq!(got("sec-ch-ua-mobile"), Some("?0"));
        assert_eq!(got("sec-ch-ua-platform"), Some("\"macOS\""));
        // A sample without them, or one that never had them recorded, says nothing.
        assert_eq!(ClientHints::of(&serde_json::json!({ "ua": "Mozilla/5.0" })), None);
        assert_eq!(ClientHints::of(&serde_json::Value::Null), None);
    }

    /// What the route itself said wins: a walk learned with its own hint shape keeps that shape, and the browser's
    /// default fills only what the route left open.
    #[test]
    fn a_routes_own_hint_shape_wins_over_the_browsers_default() {
        let hints = ClientHints { brands: vec![("Chromium".into(), "156".into())], mobile: true, platform: "Android".into() };
        let mut headers = vec![("sec-ch-ua-platform".to_string(), "\"Windows\"".to_string())];
        hints.add_to(&mut headers);
        let all = |n: &str| headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.as_str()).collect::<Vec<_>>();
        assert_eq!(all("sec-ch-ua-platform"), vec!["\"Windows\""], "the route's own word, not a second one");
        assert_eq!(all("sec-ch-ua-mobile"), vec!["?1"], "what the route left open is filled");
        assert_eq!(all("sec-ch-ua").len(), 1);
    }

    /// An event stream's answer is what it has said so far: `[DONE]` ends it, and half a line the site was still
    /// writing is not data.
    #[test]
    fn an_event_streams_answer_is_what_it_said_so_far() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let parts = |p: Vec<&'static str>| futures_util::stream::iter(p.into_iter().map(|s| Ok::<_, String>(s.as_bytes().to_vec())));
        let quick = std::time::Duration::from_millis(30);
        let done = rt.block_on(read_event_stream_with(quick, std::time::Duration::from_secs(1), 4096, parts(vec!["data: {\"a\":1}\n\n", "data: [DONE]\n\n", "data: after"])));
        assert_eq!(String::from_utf8_lossy(&done), "data: {\"a\":1}\n\ndata: [DONE]\n\n");
        let cut = rt.block_on(read_event_stream_with(quick, std::time::Duration::from_secs(1), 4096, parts(vec!["data: 1\n\ndata: 2"])));
        assert_eq!(String::from_utf8_lossy(&cut), "data: 1\n\n", "half an event is not data");
    }

    /// The blocking reader stops the same way: the stream ends, and the call has its answer rather than waiting for
    /// the site to hang up.
    #[test]
    fn a_blocking_event_streams_answer_is_what_it_said_so_far() {
        struct Trickle(bool);
        impl std::io::Read for Trickle {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    return Ok(0);
                }
                self.0 = true;
                let bytes = b"data: 1\n\n";
                buf[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            }
        }
        let out = read_event_stream_blocking(Trickle(false));
        assert_eq!(String::from_utf8_lossy(&out), "data: 1\n\n");
    }

    fn req(method: &str, url: &str, body: Option<&str>) -> Request {
        Request {
            method: method.into(),
            url: url.parse().unwrap(),
            exchange: 0,
            headers: vec![
                ("accept".into(), "application/json".into()),
                ("x-session-token".into(), "tok_dummy_123456".into()),
                ("authorization".into(), "Bearer dummy".into()),
                ("cookie".into(), "sid=dummy".into()),
                ("content-type".into(), "application/json".into()),
            ],
            body: body.map(|b| b.as_bytes().to_vec()),
        }
    }

    fn names(r: &Request) -> Vec<&str> {
        r.headers.iter().map(|(k, _)| k.as_str()).collect()
    }

    /// A hop to another origin carries what a browser sends on its own and nothing the route's session put on the
    /// request; a hop on the same origin carries it all.
    #[test]
    fn a_redirect_to_another_origin_never_carries_the_session() {
        let r = req("GET", "https://shop.example.com/api/x", None);
        let away = next_hop(Own, "shop.example.com", &r, 302, "https://elsewhere.example.org/sink").unwrap();
        assert_eq!(names(&away), ["accept"], "only the request's browser shape crosses");
        let downgraded = next_hop(Own, "shop.example.com", &r, 302, "http://shop.example.com/api/x").unwrap();
        assert_eq!(names(&downgraded), ["accept"], "another scheme is another origin");
        let home = next_hop(Own, "shop.example.com", &r, 302, "/api/y").unwrap();
        assert_eq!(home.url.as_str(), "https://shop.example.com/api/y");
        assert!(names(&home).contains(&"x-session-token") && names(&home).contains(&"cookie"));
    }

    /// A body follows a 307 or 308 on its own origin, and never to another; a POST answered 302 or 303 becomes a GET
    /// with no body, as a browser makes it.
    #[test]
    fn a_body_never_follows_a_redirect_to_another_origin() {
        let post = req("POST", "https://shop.example.com/api/order", Some(r#"{"item":"lamp"}"#));
        assert!(next_hop(Own, "shop.example.com", &post, 307, "https://elsewhere.example.org/sink").is_err());
        assert!(next_hop(Own, "shop.example.com", &post, 308, "https://elsewhere.example.org/sink").is_err());
        let kept = next_hop(Own, "shop.example.com", &post, 307, "/api/order2").unwrap();
        assert_eq!((kept.method.as_str(), kept.text()), ("POST", Some(r#"{"item":"lamp"}"#)));
        let got = next_hop(Own, "shop.example.com", &post, 303, "https://elsewhere.example.org/done").unwrap();
        assert_eq!((got.method.as_str(), got.text()), ("GET", None));
        assert_eq!(names(&got), ["accept"]);
        let same = next_hop(Own, "shop.example.com", &post, 302, "/done").unwrap();
        assert!(same.body.is_none() && !names(&same).contains(&"content-type"), "the body's description goes with it");
    }

    /// No hop leads a call that began on the internet inside the owner's network.
    #[test]
    fn a_redirect_never_leads_inside() {
        let _setting = crate::egress::tests::setting();
        let r = req("GET", "https://shop.example.com/", None);
        for inside in ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://localhost:8080/"] {
            assert!(next_hop(Own, "shop.example.com", &r, 302, inside).is_err(), "{inside}");
        }
        assert!(next_hop(Own, "shop.example.com", &r, 302, "file:///etc/passwd").is_err());
    }

    /// Over the wire: a site that redirects to another origin, which records what it is sent, receives none of the
    /// route's session headers. Both origins are local (the hop is allowed), on different ports.
    #[test]
    fn the_chrome_transport_never_forwards_session_headers_to_another_origin() {
        use std::io::{Read, Write};
        let sink = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (sink_at, site_at) = (sink.local_addr().unwrap(), site.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = site.accept() {
                let _ = s.read(&mut [0u8; 4096]);
                let _ = write!(s, "HTTP/1.1 302 Found\r\nlocation: http://{sink_at}/sink\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            }
        });
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = sink.accept() {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase());
                let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
            }
        });
        let mut chrome = ChromeFetch::new().unwrap();
        let r = req("GET", &format!("http://{site_at}/api/x"), None);
        let ex = Fetch::fetch(&mut chrome, &r).unwrap();
        assert_eq!(ex.status, 200);
        let seen = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert!(seen.starts_with("get /sink"), "{seen}");
        for name in ["x-session-token", "authorization", "cookie"] {
            assert!(!seen.contains(&format!("{name}:")), "{name} reached another origin: {seen}");
        }
    }

    /// Calls to one site, each through a transport of its own as the node makes them, go over the connection the first
    /// one opened: one TCP connect (and one TLS handshake) for all of them, where each call opened its own and paid
    /// DNS, TCP and TLS again (a warm call took 270 ms where the same request over a warm connection takes 40).
    #[test]
    fn calls_to_one_site_share_one_connection() {
        use std::io::{BufRead, BufReader, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        let connects = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = connects.clone();
        std::thread::spawn(move || {
            for s in site.incoming() {
                let Ok(s) = s else { continue };
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                std::thread::spawn(move || {
                    let mut w = s.try_clone().unwrap();
                    let mut r = BufReader::new(s);
                    loop {
                        let mut line = String::new();
                        // One request: its lines up to the blank one (a GET has no body).
                        let mut any = false;
                        while r.read_line(&mut line).unwrap_or(0) > 0 {
                            any = true;
                            if line == "\r\n" {
                                break;
                            }
                            line.clear();
                        }
                        if !any {
                            return;
                        }
                        let _ = write!(w, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{{\"ok\":true}}");
                    }
                });
            }
        });
        for n in 0..5 {
            let mut chrome = ChromeFetch::new().unwrap();
            let ex = Fetch::fetch(&mut chrome, &req("GET", &format!("http://{at}/search?q=w{n}"), None)).unwrap();
            assert_eq!(ex.status, 200);
        }
        assert_eq!(connects.load(std::sync::atomic::Ordering::SeqCst), 1, "five calls, one connection");
    }

    /// Over the wire: a request held to a route's own origins is held to them on every hop. The named origin answers
    /// by setting the owner's cookie again (the same value, for the whole host, which a browser would carry to any
    /// port of it) and redirecting to an origin the route doesn't name: that origin is never contacted, the fetch ends
    /// as one whose first request was sent, and nothing of the other origin's answer comes back.
    #[test]
    fn every_hop_of_a_fetch_is_held_to_the_routes_origins() {
        use std::io::{Read, Write};
        let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (other_at, site_at) = (other.local_addr().unwrap(), site.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = site.accept() {
                let _ = s.read(&mut [0u8; 4096]);
                let _ = write!(s, "HTTP/1.1 302 Found\r\nset-cookie: sid=owner-value; Path=/\r\nlocation: http://{other_at}/page\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            }
        });
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = other.accept() {
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase());
                let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 15\r\nconnection: close\r\n\r\n<html>x</html>\n");
            }
        });
        let within = crate::replay::Within::new([format!("http://{site_at}")], Some(("http".into(), "127.0.0.1".into())), std::collections::HashMap::from([("sid".to_string(), "owner-value".to_string())]));
        let mut chrome = ChromeFetch::new().unwrap();
        let mut r = req("GET", &format!("http://{site_at}/page"), None);
        r.headers.push(("cookie".into(), "sid=owner-value".into()));
        let got = chrome.fetch_within(&r, &within);
        assert!(matches!(&got, Err(ReplayError::RefusedHop(why)) if why.contains("not an origin the route names")), "{got:?}");
        assert!(rx.recv_timeout(std::time::Duration::from_millis(500)).is_err(), "the origin the route doesn't name was never contacted");
        // The first address is held to the same rule: a request to an origin the route doesn't name is never made.
        let first = req("GET", &format!("http://{other_at}/page"), None);
        assert!(matches!(chrome.fetch_within(&first, &within), Err(ReplayError::Refused(_))));
    }

    /// Over the wire: a redirect whose answer swaps the owner's session for another is not followed. The site the
    /// route names sets the owner's cookie to someone else's value on its redirect; the next hop is never asked, and
    /// the rule records the end so nothing more of the call goes out.
    #[test]
    fn a_redirect_that_replaces_the_owners_session_is_not_followed() {
        use std::io::{Read, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for (n, s) in site.incoming().take(2).enumerate() {
                let Ok(mut s) = s else { continue };
                let _ = s.read(&mut [0u8; 4096]);
                let _ = tx.send(n);
                let _ = write!(s, "HTTP/1.1 302 Found\r\nset-cookie: sid=someone-elses; Path=/\r\nlocation: /next\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
            }
        });
        let within = crate::replay::Within::new([format!("http://{at}")], Some(("http".into(), "127.0.0.1".into())), std::collections::HashMap::from([("sid".to_string(), "owner-value".to_string())]));
        let mut chrome = ChromeFetch::new().unwrap();
        let mut r = req("GET", &format!("http://{at}/start"), None);
        r.headers.push(("cookie".into(), "sid=owner-value".into()));
        let got = chrome.fetch_within(&r, &within);
        assert!(matches!(&got, Err(ReplayError::RefusedHop(why)) if why.contains("sid")), "{got:?}");
        assert_eq!(rx.recv_timeout(std::time::Duration::from_secs(5)).ok(), Some(0));
        assert!(rx.recv_timeout(std::time::Duration::from_millis(500)).is_err(), "the redirect was not followed");
        assert_eq!(within.ended().as_deref(), Some("sid"));
        assert!(within.admits(&r.url).is_err(), "nothing more goes out under the rule");
    }

    /// Over the wire: a site that sets a cookie on a redirect back to the same page, and answers the page only to a
    /// request that carries it, is answered the way a browser is, not redirected until the hops run out.
    #[test]
    fn a_cookie_set_on_a_redirect_goes_with_the_next_hop() {
        use std::io::{Read, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in site.incoming().take(4) {
                let Ok(mut s) = s else { continue };
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let asked = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                if asked.contains("passed=1") && asked.contains("sid=dummy") {
                    let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{{\"ok\":true}}");
                } else {
                    let _ = write!(s, "HTTP/1.1 302 Found\r\nlocation: /search?q=dune\r\nset-cookie: passed=1; Path=/; HttpOnly\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
                }
            }
        });
        let mut chrome = ChromeFetch::new().unwrap();
        let r = req("GET", &format!("http://{at}/search?q=dune"), None);
        let ex = Fetch::fetch(&mut chrome, &r).unwrap();
        assert_eq!((ex.status, ex.response_body.as_deref()), (200, Some(r#"{"ok":true}"#)), "the cookie the redirect set went with the next hop, beside the route's own");
        // And it is handed on with the answer, for the route's jar: a sign-in that sets its session on the redirect
        // signs in the calls after it too (a demo bank's login, 2026-11-06).
        assert!(ex.response_headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("set-cookie") && v.starts_with("passed=1")), "{:?}", ex.response_headers);
    }

    /// What a hop keeps: a cookie for its host or a domain it is in, never one for a domain it isn't; one dated in
    /// the past, or with no age left, takes the cookie off the next hop.
    #[test]
    fn a_hop_keeps_the_cookies_a_browser_would() {
        let at = url::Url::parse("https://www.shop.example.com/a/b").unwrap();
        let mut kept = Vec::new();
        keep_hop_cookies(
            &mut kept,
            &at,
            &[
                ("Set-Cookie".into(), "wide=1; Domain=.shop.example.com; Path=/".into()),
                ("set-cookie".into(), "here=2".into()),
                ("set-cookie".into(), "foreign=3; Domain=elsewhere.example.org; Path=/".into()),
                ("set-cookie".into(), "sid=; Domain=shop.example.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT".into()),
                ("set-cookie".into(), "gone=; Domain=shop.example.com; Path=/; Max-Age=0".into()),
            ],
        );
        assert!(!kept.iter().any(|c| c.name == "foreign"), "a domain the host isn't in is refused");
        let mut next = req("GET", "https://shop.example.com/a/c", None);
        next.headers.retain(|(k, _)| k != "cookie");
        next.headers.push(("cookie".into(), "sid=dummy; gone=x; other=y".into()));
        send_hop_cookies(&mut next, &kept);
        let cookie = next.headers.iter().find(|(k, _)| k == "cookie").map(|(_, v)| v.as_str()).unwrap();
        assert_eq!(cookie, "other=y; wide=1", "the domain cookie goes; the host-only one stays on its host; the deleted ones are taken off");
    }

    /// A cookie a hop sets for a public suffix is refused as a browser refuses it: within one call it would ride the
    /// next hop to another site under the suffix (a session put on the victim's site). One for the host's own site
    /// still goes.
    #[test]
    fn a_hop_cookie_for_a_public_suffix_never_reaches_another_site() {
        let at = url::Url::parse("https://evil.co.uk/login").unwrap();
        let mut kept = Vec::new();
        keep_hop_cookies(&mut kept, &at, &[("set-cookie".into(), "sid=attackers; Domain=.co.uk; Path=/".into()), ("set-cookie".into(), "tenant=1; Domain=github.io; Path=/".into())]);
        assert!(kept.is_empty(), "{:?}", kept.iter().map(|c| &c.name).collect::<Vec<_>>());
        let mut next = req("GET", "https://bank.co.uk/account", None);
        next.headers.retain(|(k, _)| k != "cookie");
        send_hop_cookies(&mut next, &kept);
        assert!(!next.headers.iter().any(|(k, v)| k == "cookie" && v.contains("attackers")));
        let own = url::Url::parse("https://www.shop.co.uk/a").unwrap();
        keep_hop_cookies(&mut kept, &own, &[("set-cookie".into(), "wide=1; Domain=shop.co.uk; Path=/".into())]);
        assert_eq!(kept.iter().map(|c| c.domain.as_str()).collect::<Vec<_>>(), ["shop.co.uk"], "the host's own site still goes");
    }

    /// A hop refused after the site answered never says the call wasn't made: its first request was.
    #[test]
    fn a_refused_hop_never_says_the_call_wasnt_made() {
        let e = past_the_first_hop(ReplayError::Refused("it leads off HTTPS".into()));
        assert!(matches!(e, ReplayError::RefusedHop(_)));
        assert!(!e.to_string().contains("wasn't made"), "{e}");
    }

    /// A route this node didn't learn itself follows no redirect off HTTPS or off the public internet, and the hop
    /// is refused before it is sent.
    #[test]
    fn someone_elses_route_never_follows_a_redirect_inside() {
        let r = req("GET", "https://shop.example.com/", None);
        for inside in ["http://shop.example.com/", "https://127.0.0.1/", "https://192.168.1.1/", "https://169.254.169.254/latest", "https://[::ffff:10.0.0.5]/", "https://localhost/"] {
            let e = next_hop(Foreign, "shop.example.com", &r, 302, inside).unwrap_err();
            assert!(matches!(e, ReplayError::Refused(_)), "{inside}: {e}");
        }
        assert!(next_hop(Foreign, "shop.example.com", &r, 302, "https://login.example.org/next").is_ok());
    }

    /// A local site that answers every request with what `answer` makes of its number (from 0) and the request as the
    /// client sent it, closing after each. Returns its address and the count of requests it has been asked.
    fn site_that_answers(answer: impl Fn(usize, &str) -> String + Send + 'static) -> (std::net::SocketAddr, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::io::{Read, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = asked.clone();
        std::thread::spawn(move || {
            for s in site.incoming() {
                let Ok(mut s) = s else { continue };
                let mut buf = vec![0u8; 8192];
                let n = s.read(&mut buf).unwrap_or(0);
                let said = String::from_utf8_lossy(&buf[..n]).into_owned();
                let number = counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = s.write_all(answer(number, &said).as_bytes());
            }
        });
        (at, asked)
    }

    /// Over the wire: a site that redirects to itself forever, one of them setting a fresh cookie on every hop so the
    /// cookie handling can't be what ends it, is followed for the hops a call is allowed and no more: the fetch ends
    /// as a transport failure that says so, the site was asked once for the first request and once for each hop
    /// (`MAX_REDIRECTS` + 1), and the call returns rather than hanging.
    #[test]
    fn a_site_that_redirects_to_itself_forever_is_followed_only_so_far() {
        let ends = |at: std::net::SocketAddr| {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let before = sent_here();
                let mut chrome = ChromeFetch::new().unwrap();
                let got = Fetch::fetch(&mut chrome, &req("GET", &format!("http://{at}/loop"), None));
                let _ = tx.send((got, sent_here() - before));
            });
            rx.recv_timeout(std::time::Duration::from_secs(60)).expect("the fetch returned: the hops are bounded")
        };
        let hops = crate::egress::MAX_REDIRECTS + 1;
        let (plain, plain_asked) = site_that_answers(|_, _| "HTTP/1.1 302 Found\r\nlocation: /loop\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string());
        let (cookies, cookies_asked) = site_that_answers(|n, _| format!("HTTP/1.1 302 Found\r\nlocation: /loop\r\nset-cookie: hop{n}=1; Path=/\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"));
        for (at, asked) in [(plain, plain_asked), (cookies, cookies_asked)] {
            let (got, sent) = ends(at);
            assert!(matches!(&got, Err(ReplayError::Transport(why)) if why.contains("too many redirects")), "{got:?}");
            assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), hops, "the site was asked once per hop and no more");
            assert_eq!(sent, hops as u64, "and the node counts what it sent the same");
        }
    }

    /// A check that asks where a page lands gets the redirect itself, not the page after it: one request, the answer
    /// is the 302 with its location.
    #[test]
    fn a_check_for_where_a_page_lands_is_answered_by_the_redirect_itself() {
        let (at, asked) = site_that_answers(|_, _| "HTTP/1.1 302 Found\r\nlocation: /elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string());
        let mut chrome = ChromeFetch::new().unwrap();
        let ex = chrome.fetch_unredirected(&req("GET", &format!("http://{at}/start"), None)).unwrap();
        assert_eq!(ex.status, 302);
        assert!(ex.response_headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("location") && v == "/elsewhere"), "{:?}", ex.response_headers);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1, "the redirect was not followed");
    }

    /// The browserless transport mints no cookie of its own, and says before anything is sent whether its rule lets a
    /// request go: this machine's own address is the owner's to ask for, never someone else's route's.
    #[test]
    fn the_browserless_transport_mints_nothing_and_asks_its_rule_first() {
        let own = ChromeFetch::new().unwrap();
        assert_eq!(own.minted("sid"), None);
        let local = req("GET", "http://127.0.0.1:9/x", None);
        assert!(own.allows(&local).is_ok());
        let foreign = ChromeFetch::held_to(Foreign).unwrap();
        assert!(matches!(foreign.allows(&local), Err(ReplayError::Refused(_))));
    }

    /// Every method a route can carry goes out as itself: the site is asked with the verb the call named, including
    /// one the transport has no name for, and a verb that can't be one is refused before anything is sent.
    #[test]
    fn a_calls_method_goes_out_as_itself() {
        let (at, asked) = site_that_answers(|_, said| {
            let verb = said.split(' ').next().unwrap_or_default();
            format!("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{verb}", verb.len())
        });
        let mut chrome = ChromeFetch::new().unwrap();
        for verb in ["PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"] {
            let ex = Fetch::fetch(&mut chrome, &req(verb, &format!("http://{at}/x"), None)).unwrap();
            assert_eq!(ex.response_body.as_deref(), Some(verb), "the site saw the verb the call named");
        }
        let before = asked.load(std::sync::atomic::Ordering::SeqCst);
        let got = Fetch::fetch(&mut chrome, &req("NOT A VERB", &format!("http://{at}/x"), None));
        assert!(matches!(got, Err(ReplayError::BadUrl(_))), "{got:?}");
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), before, "nothing was sent");
    }

    /// A read of kept walks or routes (`offline`) asks no site: the request is refused with the reason before a
    /// connection is opened, and the site hears nothing.
    #[test]
    fn an_offline_read_asks_no_site() {
        let (at, asked) = site_that_answers(|_, _| "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string());
        let mut chrome = ChromeFetch::new().unwrap();
        let held = offline();
        let before = sent_here();
        let got = Fetch::fetch(&mut chrome, &req("GET", &format!("http://{at}/x"), None));
        assert!(matches!(&got, Err(ReplayError::Refused(why)) if why == OFFLINE_WHY), "{got:?}");
        assert_eq!(sent_here(), before, "nothing was handed to the wire");
        drop(held);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0, "the site was never asked");
    }

    /// An event stream's answer is what it has said so far, over the wire: the events up to `[DONE]` come back, and
    /// what the site goes on to send after it does not.
    #[test]
    fn an_event_stream_over_the_wire_answers_with_the_events_before_done() {
        use std::io::{Read, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = site.accept() {
                let _ = s.read(&mut [0u8; 4096]);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\ndata: {\"a\":1}\n\ndata: [DONE]\n\n");
                let _ = s.flush();
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = s.write_all(b"data: after\n\n");
            }
        });
        let mut chrome = ChromeFetch::new().unwrap();
        let ex = Fetch::fetch(&mut chrome, &req("GET", &format!("http://{at}/events"), None)).unwrap();
        assert_eq!(ex.response_body.as_deref(), Some("data: {\"a\":1}\n\ndata: [DONE]\n\n"));
    }

    /// A binary answer of a codec the engine reads comes back as the JSON it holds, as a walk records it.
    #[test]
    fn a_msgpack_answer_comes_back_as_the_json_it_holds() {
        use std::io::{Read, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = site.accept() {
                let _ = s.read(&mut [0u8; 4096]);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/msgpack\r\ncontent-length: 5\r\nconnection: close\r\n\r\n\x81\xa2ok\xc3");
            }
        });
        let mut chrome = ChromeFetch::new().unwrap();
        let ex = Fetch::fetch(&mut chrome, &req("GET", &format!("http://{at}/m"), None)).unwrap();
        assert_eq!(ex.response_body.as_deref(), Some(r#"{"ok":true}"#));
    }

    /// The count of what this process has sent only grows with each answered request, and the clock a sent line is
    /// stamped with is the real one.
    #[test]
    fn the_process_counts_what_it_sent_and_stamps_it_with_the_clock() {
        let (at, _) = site_that_answers(|_, _| "HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string());
        let before = sent_so_far();
        let mut chrome = ChromeFetch::new().unwrap();
        Fetch::fetch(&mut chrome, &req("GET", &format!("http://{at}/x"), None)).unwrap();
        assert!(sent_so_far() > before, "an answered request was counted");
        assert!(now_ms() > 1_700_000_000_000, "milliseconds since the epoch");
    }
}
