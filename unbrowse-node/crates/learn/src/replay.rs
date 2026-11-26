//! The clean re-run (Phase 1 spec §4): run a learned route again in a fresh session with new
//! inputs, before it is published.
//!
//! [`replay`] with [`HttpFetch`] runs the graph with plain HTTP: every derived value is taken from the new
//! responses, never from the recording, and the target must answer with the recorded shape.
//! A page-computed value fails the run (`ReplayError::NeedsBrowser`). An unconfirmed value is sent as it was seen,
//! with the graph marked provisional, and a second passive sighting settles what it really is.

use std::collections::HashMap;

use serde_json::Value;

use crate::graph::{shape, Body, Class, Graph, Step};
use crate::provenance::{extract, At};
use crate::rung::Rung;
use crate::slots::Loc;
use crate::trace::Exchange;

#[derive(Debug, thiserror::Error)]
pub enum ReplayError {
    #[error("step {step} ({url}) needs a browser: the page computes {loc}")]
    NeedsBrowser { step: usize, url: String, loc: Loc },
    #[error("no value given for input `{0}`")]
    MissingInput(String),
    #[error("no browser-minted value for `{0}`; the node's session must supply it")]
    MissingMinted(String),
    #[error("step {step} ({url}): {loc} should come from an earlier response, but it wasn't there")]
    SourceMissing { step: usize, url: String, loc: Loc },
    #[error("step {step} ({url}) has a body that can't be replayed yet")]
    UnsupportedBody { step: usize, url: String },
    #[error("step {step} ({url}): the value for part `{part}` holds the form's boundary, so it would end the part")]
    BreaksBody { step: usize, url: String, part: String },
    #[error("step {step} ({url}) answered {status}: {}", crate::answer::site_said(.body))]
    Failed { step: usize, url: String, status: u16, body: String },
    /// The site's door answered instead of its page: the credential it wants is not one this call holds. The route
    /// says which class the wall is and what earns a fresh credential, so the caller can recompute, open a browser,
    /// or hand the page to its owner — instead of treating the refusal as the site drifting.
    #[error("step {step} ({url}) met the site's door: answered {status}")]
    Door {
        step: usize,
        url: String,
        status: u16,
        door: crate::graph::Door,
        /// What the answer itself was (`refusal::read`): a page that waits on its own code, a check for a person, a
        /// plain refusal. It says what may clear the door (`Wall::sources`). None on an error built without the answer.
        wall: Option<crate::refusal::Wall>,
    },
    #[error("the target answered, but not in the recorded shape")]
    ShapeMismatch { expected: Value, got: Value },
    /// The target answered, but with no answer: a refusal, an error said in the site's words, a challenge, nothing,
    /// or a detour to another page (`answer::replayed_not_an_answer`).
    #[error("the site answered {status}, but not with an answer: {why}")]
    NotAnAnswer {
        status: u16,
        why: String,
        /// The answer is the site checking the caller: a challenge, not a session that ended.
        challenge: bool,
    },
    #[error("request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("the request did not complete: {0}")]
    Transport(String),
    #[error("bad URL template {0}")]
    BadUrl(String),
    /// The call's rule (`egress::Egress`) refused a request before anything was sent: it says which rule.
    #[error("the call wasn't made: {0}")]
    Refused(String),
    /// The site answered, and the call's rule refused where its redirect leads: the request before it was made, so
    /// the site may hold it, and this never says otherwise.
    #[error("the site answered, and where it sent the call was refused: {0}")]
    RefusedHop(String),
    #[error("file input `{input}`: {reason}")]
    File { input: String, reason: String },
}

impl ReplayError {
    /// The answers say the session or the site changed since the route was learned —
    /// a blocked step, a source that isn't where it was, or a response in a new
    /// shape. Re-running the route's root step (the node re-minting its session in
    /// the browser) may fix it, so a caller can retry after reseeding.
    pub fn is_stale(&self) -> bool {
        match self {
            ReplayError::Failed { status, .. } => *status == 403 || *status == 401,
            ReplayError::Door { .. } => true,
            ReplayError::SourceMissing { .. } => true,
            ReplayError::ShapeMismatch { .. } => true,
            ReplayError::MissingMinted(_) => true,
            _ => false,
        }
    }
}

/// A request the replay is about to make, described so a runner other than plain HTTP
/// (such as the node's browser tab) can make it instead.
#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub url: url::Url,
    /// The recorded exchange this step replays, so a mixed runner can tell which
    /// steps are its to make in a browser.
    pub exchange: usize,
    /// Headers, including a joined `cookie` header for the session's cookies.
    pub headers: Vec<(String, String)>,
    /// The body's bytes: text for a JSON, form or multipart body, a chunk of a file for an upload.
    pub body: Option<Vec<u8>>,
}

impl Request {
    /// The body as text, when it is text: a file's bytes are not, and are never shown as such.
    pub fn text(&self) -> Option<&str> {
        self.body.as_deref().and_then(|b| std::str::from_utf8(b).ok())
    }
}

/// Where a request of a route that came from another node may go, its first address and every address a redirect
/// leads it to: an origin its graph names exactly (scheme, host and port), on the route's own site, and nowhere once
/// the site replaced the owner's session the call was sent with. The rule is handed to the transport with the request
/// ([`Fetch::fetch_within`]), so a redirect is held to it hop by hop where it is followed: a hop it refuses ends the
/// fetch there, with nothing sent to that address and nothing of its answer handed back.
///
/// Clones share one record of the session's end: the call's steps and the page's own calls see the same end.
#[derive(Clone, Debug)]
pub struct Within {
    origins: std::collections::HashSet<String>,
    /// The route's own place, scheme and host: a named origin off its site is still refused.
    home: Option<(String, String)>,
    /// The owner's session as the call began: a hop's answer that sets one of these to another value, or takes it
    /// out, on a request that carried it, changes whose session the call runs in.
    owner: HashMap<String, String>,
    replaced: std::sync::Arc<std::sync::Mutex<Option<String>>>,
}

impl Within {
    pub fn new(origins: impl IntoIterator<Item = String>, home: Option<(String, String)>, owner: HashMap<String, String>) -> Self {
        Self { origins: origins.into_iter().collect(), home, owner, replaced: Default::default() }
    }

    /// Whether `url` is an origin the route names, on its own site.
    pub fn names(&self, url: &url::Url) -> bool {
        let on_its_site = self.home.as_ref().is_some_and(|(scheme, home)| url.scheme() == scheme && url.host_str().is_some_and(|h| crate::identity::same_site(home, h)));
        on_its_site && self.origins.contains(&url.origin().ascii_serialization())
    }

    /// Whether `host` is the host of an origin the route names.
    pub fn names_host(&self, host: &str) -> bool {
        self.origins.iter().any(|o| url::Url::parse(o).ok().and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case(host))).unwrap_or(false))
    }

    /// Whether a request may be sent to `url` now: an origin the route names, and the owner's session not replaced.
    pub fn admits(&self, url: &url::Url) -> Result<(), String> {
        if let Some(name) = self.ended() {
            return Err(format!("the site replaced the session this call was sent with (its {name} cookie): a route that came from another node sends nothing more under it"));
        }
        if !self.names(url) {
            return Err(format!("{} is not an origin the route names: a route that came from another node sends nothing anywhere else, another host of its site and a redirect's included", url.origin().ascii_serialization()));
        }
        Ok(())
    }

    /// The owner's cookie a site replaced during this call, if one was.
    pub fn ended(&self) -> Option<String> {
        self.replaced.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Records that the site replaced the owner's `name`: nothing more is sent under this rule.
    pub fn end(&self, name: &str) {
        self.replaced.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get_or_insert_with(|| name.to_string());
    }

    /// The owner's cookie a redirect's answer (`headers`) replaces or takes out, of those the request it answers
    /// (`sent`) carried as the owner held them. Read before the redirect is followed: a session the site swapped on
    /// the way is never carried to the next hop.
    pub fn replaced_by(&self, sent: &Request, headers: &[(String, String)]) -> Option<String> {
        let carried: HashMap<&str, &str> = sent
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .flat_map(|(_, v)| v.split(';'))
            .filter_map(|p| p.split_once('=').map(|(k, v)| (k.trim(), v.trim())))
            .collect();
        headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie")).find_map(|(_, line)| {
            let (name, value) = line.split(';').next()?.split_once('=')?;
            let (name, value) = (name.trim(), value.trim());
            let was = self.owner.get(name)?;
            if carried.get(name) != Some(&was.as_str()) {
                return None;
            }
            let gone = value.is_empty() || crate::http::ends_the_cookie(line);
            (gone || value != was).then(|| name.to_string())
        })
    }
}

/// Runs one step's request. Plain HTTP is the default; the node can run a site's
/// front-door step in a browser tab so it is seen by the session the browser minted.
///
/// Every runner says how it sends a request without following redirects ([`Fetch::fetch_unredirected`] has no
/// default): [`Fetch::fetch_within`] sends through it, so a runner whose `fetch` follows redirects can't leave a hop
/// unchecked by forgetting to say so. One that says only `fetch` doesn't compile:
///
/// ```compile_fail
/// use unbrowse_learn::replay::{Fetch, Request, ReplayError};
/// use unbrowse_learn::trace::Exchange;
/// struct FollowsRedirects;
/// impl Fetch for FollowsRedirects {
///     fn fetch(&mut self, _req: &Request) -> Result<Exchange, ReplayError> {
///         unimplemented!()
///     }
/// }
/// ```
///
/// And one that states it does:
///
/// ```
/// use unbrowse_learn::replay::{Fetch, Request, ReplayError};
/// use unbrowse_learn::trace::Exchange;
/// struct Plain;
/// impl Fetch for Plain {
///     fn fetch(&mut self, _req: &Request) -> Result<Exchange, ReplayError> {
///         unimplemented!()
///     }
///     fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
///         self.fetch(req)
///     }
/// }
/// ```
pub trait Fetch {
    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError>;

    /// [`Fetch::fetch`] with every address it reaches held to `within`: the first, and each a redirect leads to,
    /// before anything is sent there. A runner that follows redirects checks each hop as it follows it; this default
    /// follows none ([`Fetch::fetch_unredirected`]), so a runner that can't check a hop never reaches one.
    fn fetch_within(&mut self, req: &Request, within: &Within) -> Result<Exchange, ReplayError> {
        within.admits(&req.url).map_err(ReplayError::Refused)?;
        self.fetch_unredirected(req)
    }

    /// Runs one step's request without following redirects, for a check that asks where a page lands rather
    /// than what it ends up saying: a signed-in page that moves to the sign-in page must be seen moving. A
    /// runner that does not follow redirects anyway answers this with its ordinary fetch, and says so: there is no
    /// default, so a runner that follows redirects in `fetch` can't hand it to [`Fetch::fetch_within`] by omission.
    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError>;

    /// Whether the runner may make this request at all, asked before it counts as sent: a request the call's rule
    /// refuses is never made, so it never reached the site. Plain HTTP checks it again as it sends, hop by hop.
    fn allows(&self, _req: &Request) -> Result<(), ReplayError> {
        Ok(())
    }

    /// The session values this step exists to carry, if the runner can serve
    /// them from its store. A step answered here never touches the network and
    /// never needs a replayable body: a challenge-platform request whose only
    /// product is `cf_clearance` is the store's business, not the wire's.
    fn session_values(&mut self, _exchange: usize) -> Option<Vec<(String, String)>> {
        None
    }

    /// The headers the page's own code adds to `req`: a runner that can run a recorded producer (a script sandbox, a
    /// page kept warm, `crate::signing`) answers with them, and one that can't answers None. None on a plain read (a
    /// `GET` or a `HEAD`) sends the step as the route builds it, and the site's answer says whether it needed the
    /// page's values; None on anything else is a step with a computed value, and it goes to the browser as one always
    /// has. `inputs` are the caller's values, which the page is booted with so its own code asks for what this call asks.
    fn sign_request(&mut self, _req: &Request, _inputs: &std::collections::HashMap<String, String>) -> Option<crate::sandbox::Signed> {
        None
    }

    /// What this runner did that the route does not say, in the call's own words: a step sent as the route builds it
    /// because the page's code made nothing for it. The reply carries it in `notes`, so a call that answered cheaper
    /// than the route says is never silent about it.
    fn fell_back(&mut self, _why: String) {}

    /// The node's browser-minted session value for a cookie, if this runner holds one.
    /// A browser runner answers from its live cookie jar; plain HTTP holds none.
    fn minted(&self, _name: &str) -> Option<String> {
        None
    }

    /// A value the page kept in its storage under `key`, as the session this runner keeps holds it (what the walk
    /// that minted the session left there). A runner that keeps no session holds none, and the place is not sent, as
    /// a cookie the jar does not hold is not.
    fn stored(&self, _area: unbrowse_route::expr::Area, _key: &str) -> Option<String> {
        None
    }

    /// The browser the page's own code saw (its fingerprint and storage), for a generated producer that reads it. A
    /// runner that keeps the session answers it; one that doesn't gives the program an empty environment.
    fn environment(&self) -> crate::generated::Environment {
        crate::generated::Environment::default()
    }

    /// The jar's copy of a cookie for a step whose recorded source no longer sets it, as a browser would send it to
    /// `host`: only where the jar's cookies go. A runner that keeps a session for one host answers for that host
    /// alone, so a step sent to another host never draws the owner's cookie by naming it (`host` is `None` when the
    /// step builds its host at call time, which is never the jar's). The default answers from [`Fetch::minted`].
    fn minted_cookie(&self, name: &str, host: Option<&str>) -> Option<String> {
        host?;
        self.minted(name)
    }

    /// Re-mints the runner's session by running the route's root step (given as the
    /// request the replay is about to make of it) somewhere stronger than plain HTTP,
    /// such as the node's browser: the site's front door sees a real session again,
    /// the minted values refresh, and the root's response is what `fetch` returns
    /// for it from now on. Plain HTTP has nothing to re-mint, so the default is a
    /// no-op.
    fn reseed(&mut self, _root: &Request) -> Result<(), ReplayError> {
        Ok(())
    }

    /// The folder a route's file inputs may be read from (see [`crate::files`]): the node's file root.
    fn file_root(&self) -> std::path::PathBuf {
        crate::files::root()
    }

    /// Whether the transport had its browser make the request of this exchange, having been refused plainly: the
    /// step was the browser's, the last rung (`learn.rung`).
    fn browser_made(&self, _exchange: usize) -> bool {
        false
    }
}

/// The default runner: plain HTTP, redirects not followed.
pub struct HttpFetch {
    client: reqwest::blocking::Client,
    egress: crate::egress::Egress,
}

impl HttpFetch {
    pub fn new() -> Result<Self, ReplayError> {
        Self::held_to(crate::egress::Egress::Own)
    }

    /// Plain HTTP for a call under `egress`, its answers and requests checked as the Chrome-shaped transport's are.
    pub fn held_to(egress: crate::egress::Egress) -> Result<Self, ReplayError> {
        Self::held_to_proxy(egress, None)
    }

    /// [`HttpFetch::held_to`] through `proxy` when the call's site is pinned: the node's own local proxy, so the
    /// browser and the call leave from one public address.
    pub fn held_to_proxy(egress: crate::egress::Egress, proxy: Option<&str>) -> Result<Self, ReplayError> {
        let mut builder = crate::tls::blocking_for(egress)
            // The client identifies itself (Phase 1 spec §12): sites such as
            // Wikimedia answer 403 to callers with no user-agent at all.
            .user_agent(concat!("unbrowse-node/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(p) = proxy {
            builder = builder.proxy(reqwest::Proxy::all(p)?);
        }
        if let Some(t) = egress.timeout() {
            builder = builder.timeout(t);
        }
        Ok(Self { egress, client: builder.build()? })
    }
}

impl Default for HttpFetch {
    fn default() -> Self {
        Self::new().expect("building the plain HTTP client")
    }
}

impl Fetch for HttpFetch {
    /// This runner follows no redirect itself: its plain fetch is the unredirected one.
    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.fetch(req)
    }

    fn allows(&self, req: &Request) -> Result<(), ReplayError> {
        self.egress.request(&req.url).map_err(ReplayError::Refused)
    }

    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        // A site the owner is paying on is sent nothing, and while a checkout waits no host is (`hold`). This client
        // follows no redirect itself.
        crate::hold::check_request(&req.url, &req.method)?;
        self.allows(req)?;
        let mut r = self.client.request(req.method.parse().unwrap_or(reqwest::Method::GET), req.url.as_str());
        for (name, value) in &req.headers {
            r = r.header(name.as_str(), value.as_str());
        }
        if let Some(body) = &req.body {
            r = r.body(body.clone());
        }
        let res = r.send().map_err(|e| match crate::egress::refusal_in(&e) {
            Some(why) => ReplayError::Refused(why),
            None => ReplayError::Http(e),
        })?;
        let status = res.status().as_u16();
        let response_headers: Vec<(String, String)> =
            res.headers().iter().map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or_default().to_string())).collect();
        let response_mime = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
        // The events an event stream has sent are its answer: the stream is the site's to keep open, not the call's
        // to wait on. Someone else's route gets an answer of bounded size; the node's own reads its site's as it comes.
        let body = if response_mime.to_ascii_lowercase().contains("text/event-stream") {
            String::from_utf8_lossy(&crate::http::read_event_stream_blocking(res)).into_owned()
        } else {
            match self.egress.answer_max() {
                Some(max) => unbrowse_route::wire::reply_read(&response_mime, &crate::egress::read_capped(res, max).map_err(ReplayError::Transport)?),
                // A binary answer of a codec the engine reads is read as the JSON it holds, as a walk records it.
                None if unbrowse_route::wire::named(&response_mime).is_some() => {
                    let bytes = res.bytes()?;
                    unbrowse_route::wire::reply_read(&response_mime, &bytes)
                }
                None => res.text()?,
            }
        };
        Ok(Exchange {
            method: req.method.clone(),
            url: req.url.clone(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers,
            response_body: Some(body),
            response_mime,
            resource_type: None,
            main_frame: None,
        })
    }
}

/// What a request says, for a question about the values in it: its address and its body, percent-decoded and
/// lowercased. One reader for the question "does this request carry this value?", whether it is the request the route
/// built, a step sent as the route builds it, or the call the page's own code made.
pub fn what_it_says(url: &str, body: Option<&[u8]>) -> String {
    let mut all = percent_encoding::percent_decode_str(&url.replace('+', " ")).decode_utf8_lossy().to_lowercase();
    if let Some(b) = body {
        let b = String::from_utf8_lossy(b);
        all.push('\n');
        all.push_str(&percent_encoding::percent_decode_str(&b.replace('+', " ")).decode_utf8_lossy().to_lowercase());
        all.push('\n');
        all.push_str(&b.to_lowercase());
    }
    all
}

/// The caller's values (`inputs`, two characters or more) that `said`, what a request says ([`what_it_says`]), does
/// not carry, sorted: a request that asks another value is another value's answer, whenever it runs.
pub fn values_it_lacks(said: &str, inputs: &HashMap<String, String>) -> Vec<String> {
    let mut values: Vec<String> = inputs.values().map(|v| v.trim().to_lowercase()).filter(|v| v.chars().count() >= 2).collect();
    values.sort();
    values.retain(|v| !said.contains(v.as_str()));
    values
}

/// What a successful HTTP replay did.
#[derive(Debug)]
pub struct HttpReplay {
    /// Each step's request URL and status, in order.
    pub steps: Vec<(String, u16)>,
    /// The rung that made each of those steps (`learn.rung`), in the same order.
    pub rungs: Vec<Rung>,
    /// The target's response.
    pub target: Exchange,
    /// What the run did to the site: the commit marks it read from the route, and how far each got.
    pub ledger: crate::ledger::Ledger,
}

/// Runs `graph` browserless, and when the answers say the session or the site has
/// gone stale ([`ReplayError::is_stale`]), re-runs the route's root step once —
/// `Fetch::reseed` re-mints the session, e.g. in the node's browser — then tries
/// the plain run again. `root` is the root step's 1-based number.
pub fn replay_reseeded(
    graph: &Graph,
    inputs: &HashMap<String, String>,
    fetch: &mut impl Fetch,
    root: usize,
) -> Result<HttpReplay, ReplayError> {
    let mut ledger = crate::ledger::Ledger::of(graph);
    match replay_ledgered(graph, inputs, fetch, &mut ledger) {
        Ok(r) => Ok(r),
        // A write the site may hold is never sent again, stale or not.
        Err(e) if e.is_stale() && root >= 1 && root <= graph.steps.len() && ledger.sent_nothing() => {
            let step = &graph.steps[root - 1];
            let bridged = graph.page.is_some() && step.is_page_signed();
            let values = realize(graph, root, step, inputs, fetch, &HashMap::new(), &fresh_values(graph), bridged)?;
            let url = request_url(step, &values)?;
            let mut headers: Vec<(String, String)> = Vec::new();
            let mut cookies = Vec::new();
            for (loc, value) in &values {
                match loc {
                    Loc::Header(name) => headers.push((name.clone(), value.clone())),
                    Loc::Cookie(name) => cookies.push(format!("{name}={value}")),
                    _ => {}
                }
            }
            if !cookies.is_empty() {
                headers.push(("cookie".into(), cookies.join("; ")));
            }
            let body = request_body(root, step, &values)?.map(String::into_bytes);
            let req = Request { method: step.method.clone(), url, exchange: step.exchange, headers, body };
            fetch.reseed(&req)?;
            replay(graph, inputs, fetch)
        }
        Err(e) => Err(e),
    }
}

/// A step the browser made from the page's script (it answered with data) goes out the way a script's call does:
/// asking for JSON, as a CORS fetch, from the page it was learned on (`page`, its origin; the call's own when the
/// graph doesn't say), with that origin on anything but a GET. The transport's defaults describe a navigation, an API
/// that checks the request's shape refuses a navigation-shaped POST, and an API another host serves for the page
/// (`search.site.example` for `www.site.example`) answers a call that says it comes from itself with nothing.
/// Headers the route itself sets win.
fn script_shape(step: &Step, as_a_page: bool, url: &url::Url, page: Option<&str>, headers: &mut Vec<(String, String)>) {
    // A page is asked for as a page (`Graph::asks_as_a_page`). The learner keeps a page's shape too (to tell it from a
    // wall put in its place), and a page taken for a script's fetch goes out saying it wants JSON as a cross-origin
    // call — which is what a search page's own wall answers, in place of the results (aljazeera.com's
    // `/search/<word>`, 2026-11-11: the same GET from the same transport answered the real page when it asked for one).
    if as_a_page {
        return;
    }
    let own = url.origin().ascii_serialization();
    let origin = page.map(String::from).unwrap_or_else(|| own.clone());
    let site = |o: &str| url::Url::parse(o).ok().and_then(|u| u.host_str().map(crate::identity::site_of));
    let fetch_site = if origin == own {
        "same-origin"
    } else if site(&origin).is_some() && site(&origin) == site(&own) {
        "same-site"
    } else {
        "cross-site"
    };
    let mut add = |k: &str, v: String| {
        if !headers.iter().any(|(h, _)| h.eq_ignore_ascii_case(k)) {
            headers.push((k.to_string(), v));
        }
    };
    add("accept", "application/json, text/plain, */*".into());
    add("sec-fetch-dest", "empty".into());
    add("sec-fetch-mode", "cors".into());
    add("sec-fetch-site", fetch_site.into());
    add("referer", format!("{origin}/"));
    if step.method != "GET" {
        add("origin", origin);
    }
}

/// Runs `graph` step by step over `fetch`. Every derived value is taken from the new
/// responses, never from the recording; inputs come from the caller, and browser-minted
/// session values from the runner (`Fetch::minted`).
pub fn replay(graph: &Graph, inputs: &HashMap<String, String>, fetch: &mut impl Fetch) -> Result<HttpReplay, ReplayError> {
    let mut ledger = crate::ledger::Ledger::of(graph);
    replay_ledgered(graph, inputs, fetch, &mut ledger)
}

/// Whether every value a later step reads from `step` is already the session's: a cookie in the jar, or a header
/// token it keeps. A one-time bootstrap (`createTUid`) the page skips on a warm session is this: the later steps read
/// its cookie, and the jar already has it.
fn held_for_later(graph: &Graph, step: &crate::graph::Step, fetch: &mut impl Fetch) -> bool {
    let host = step_host(&step.url);
    graph.steps.iter().flat_map(|s| &s.fields).all(|f| match &f.class {
        crate::graph::Class::Derived { origin } if origin.exchange == step.exchange => match &f.loc {
            Loc::Cookie(name) => fetch.minted_cookie(name, host.as_deref()).is_some(),
            Loc::Header(name) => fetch.minted(name).is_some(),
            _ => false,
        },
        _ => true,
    })
}

/// The page markup the route carries, when it is the first page step's answer: the walk's own page, which is what the
/// route's page-derived values read. None when the step is the target itself, set a cookie, or a later step reads a
/// live response header from it — those need the site's answer, not the walk's markup.
/// Whether the route's first page step is served from the markup the route carries. The scoreboard's question: the
/// page is data here, not a fetch.
pub fn page_is_carried(graph: &Graph) -> bool {
    graph.steps.first().is_some_and(|s| carried_page(graph, s, 1).is_some())
}

/// What the route reads from the page it carries: `text` (all text markers, so the markup answers), `live` (a value
/// from a live header or a parsed script, so the page is fetched), or `none` (no page step or no reads).
pub fn page_reads(graph: &Graph) -> &'static str {
    let Some(first) = graph.steps.first().filter(|_| graph.page_html.is_some()) else { return "none" };
    let mut any = false;
    let mut live = false;
    for f in graph.steps.iter().flat_map(|s| &s.fields) {
        if let crate::graph::Class::Derived { origin } = &f.class {
            if origin.exchange == first.exchange {
                any = true;
                live |= !matches!(origin.at, crate::provenance::At::Text { .. });
            }
        }
    }
    if live { "live" } else if any { "text" } else { "none" }
}

/// Whether `step` answered the walk with a redirect that a later step reads: a value taken from the address its
/// `location` header hands over, or the header itself.
fn hands_over_its_redirect(graph: &Graph, step: &crate::graph::Step) -> bool {
    use crate::provenance::At;
    (300..400).contains(&step.status)
        && graph.steps.iter().flat_map(|s| &s.fields).any(|f| match &f.class {
            crate::graph::Class::Derived { origin } if origin.exchange == step.exchange => match &origin.at {
                At::HeaderQuery { name, .. } | At::Header { name } => name.eq_ignore_ascii_case("location"),
                _ => false,
            },
            _ => false,
        })
}

fn carried_page(graph: &Graph, step: &crate::graph::Step, n: usize) -> Option<String> {
    // The first step (1-based in the replay loop) is the page the walk started on; a single-step route's page is its
    // target and is fetched live.
    if n != 1 || graph.steps.len() < 2 || step.sets_cookie || step.status != 200 || !step.method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let html = graph.page_html.clone()?;
    let text_only = graph.steps.iter().flat_map(|s| &s.fields).all(|f| match &f.class {
        crate::graph::Class::Derived { origin } if origin.exchange == step.exchange => matches!(origin.at, crate::provenance::At::Text { .. }),
        _ => true,
    });
    text_only.then_some(html)
}

/// [`replay`], with the caller holding the ledger: a run that fails leaves it filled, so the caller knows whether the
/// site may already hold the write before deciding to run again.
pub fn replay_ledgered(
    graph: &Graph,
    inputs: &HashMap<String, String>,
    fetch: &mut impl Fetch,
    ledger: &mut crate::ledger::Ledger,
) -> Result<HttpReplay, ReplayError> {
    replay_ledgered_by(graph, inputs, fetch, ledger, fills_by_body())
}

/// Whether what a replay sends is built by the body's filler (`docs/REBUILD.md`, phase 5): the default with the learner
/// by example (15 November); `UNBROWSE_FILL_BODY=0` builds it the old way, kept for one release. Read once. In this
/// crate's tests the same variable sets it for the whole test run, so every replay test runs either way without being
/// written twice.
pub fn fills_by_body() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("UNBROWSE_FILL_BODY").ok().as_deref().map(str::trim) != Some("0"))
}

/// [`replay`], with the builder of what is sent chosen: `fill_body`, the body's filler.
pub fn replay_by(graph: &Graph, inputs: &HashMap<String, String>, fetch: &mut impl Fetch, fill_body: bool) -> Result<HttpReplay, ReplayError> {
    let mut ledger = crate::ledger::Ledger::of(graph);
    replay_ledgered_by(graph, inputs, fetch, &mut ledger, fill_body)
}

/// A step's request as one builder made it: the request, and the rung its values were made at; or, for an upload,
/// the request around the file's bytes, which the upload sends.
enum Made {
    Sent(Request, Rung),
    Upload(Request),
}

/// A step's request as the graph's own builders make it: its fields' values (`realize`), its address, its headers and
/// a script's shape, its body, then the values made over the request (a recipe's digest, a program's value), with
/// `reading`'s clock and chance. Err: what replay says, and whether it is a value the page did not hand over, which
/// replay steps past where nothing after reads it.
#[allow(clippy::too_many_arguments)]
fn by_fields<F: Fetch>(
    graph: &Graph,
    n: usize,
    step: &Step,
    inputs: &HashMap<String, String>,
    fetch: &F,
    responses: &HashMap<usize, Exchange>,
    fresh: &HashMap<String, String>,
    bridged: bool,
    reading: crate::body::Reading,
) -> Result<Made, (ReplayError, bool)> {
    let values = realize(graph, n, step, inputs, fetch, responses, fresh, bridged).map_err(|e| {
        let past = matches!(e, ReplayError::SourceMissing { .. });
        (e, past)
    })?;
    let url = request_url(step, &values).map_err(|e| (e, false))?;
    said_by_name(n, step);
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut cookies = Vec::new();
    for (loc, value) in &values {
        match loc {
            Loc::Header(name) => headers.push((name.clone(), value.clone())),
            Loc::Cookie(name) => cookies.push(format!("{name}={value}")),
            _ => {}
        }
    }
    if !cookies.is_empty() {
        headers.push(("cookie".into(), cookies.join("; ")));
    }
    script_shape(step, graph.asks_as_a_page(step), &url, graph.page_origin.as_deref(), &mut headers);
    if let Some(Body::Upload { .. }) = &step.body {
        return Ok(Made::Upload(Request { method: step.method.clone(), url, exchange: step.exchange, headers, body: None }));
    }
    let body = request_body(n, step, &values).map_err(|e| (e, false))?.map(String::into_bytes);
    let mut req = Request { method: step.method.clone(), url, exchange: step.exchange, headers, body };
    // The step's values so far are the walk's own; a value the page's code makes lifts it to whichever maker made
    // it (`learn.rung`): a recipe the node computes itself, a program run for the value, the page's scripts.
    let mut rung = Rung::Walk;
    let mut chance = reading.chance();
    // A signature whose recipe the walk proved is computed here, from the request as it stands and the session it
    // carries: no page, no scripts, no bridge. A header is set on the request; a value in the address is written
    // into it, last, from the address's other values as they are sent. One in a body stays the page's for now.
    for f in &step.fields {
        if let Class::Recipe { recipe } = &f.class {
            let text = req.body.as_deref().map(|b| String::from_utf8_lossy(b).into_owned());
            let cookies = sent_cookies(&req);
            // A cookie the session doesn't hold yet is signed over as nothing, as the page's own code does before it
            // has one: a gateway that issues its own token answers that with the token (`resigned`).
            let made = crate::signing::compute_before_token(recipe, &req, text.as_deref(), &cookies, reading.now, &mut chance);
            rung = rung.max(Rung::Expression);
            match (&f.loc, made) {
                (Loc::Header(name), Some(value)) => {
                    req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
                    req.headers.push((name.clone(), value));
                }
                (Loc::Query(key), Some(value)) => {
                    let others: Vec<(String, String)> = req.url.query_pairs().filter(|(k, _)| k != key).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                    req.url.query_pairs_mut().clear().extend_pairs(others).append_pair(key, &value);
                }
                _ => return Err((ReplayError::NeedsBrowser { step: n, url: req.url.to_string(), loc: f.loc.clone() }, false)),
            }
        }
    }
    // A producer carried as a program is run here too, from the request as it stands: the verifier proved it on the
    // walk's own sightings, and a run that fails sends the step to the browser rather than a guessed header.
    for f in &step.fields {
        if let Class::Generated { program, .. } = &f.class {
            let Loc::Header(name) = &f.loc else {
                return Err((ReplayError::NeedsBrowser { step: n, url: req.url.to_string(), loc: f.loc.clone() }, false));
            };
            let cookies = sent_cookies(&req);
            let env = fetch.environment();
            let Some(value) = crate::generated::compute(program, &req, &cookies, &env) else {
                return Err((ReplayError::NeedsBrowser { step: n, url: req.url.to_string(), loc: f.loc.clone() }, false));
            };
            req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
            req.headers.push((name.clone(), value));
            rung = rung.max(Rung::Function);
        }
    }
    Ok(Made::Sent(req, rung))
}

/// What a step's values are and where each came from, by name only, where `UNBROWSE_REPLAY_DEBUG` is set: a 403 is
/// then diagnosed (a token with no producer, a value from a step that moved) rather than guessed at. Never a value: a
/// route holds secrets.
fn said_by_name(n: usize, step: &Step) {
    if std::env::var_os("UNBROWSE_REPLAY_DEBUG").is_none() {
        return;
    }
    eprintln!("   [debug] step {n} {} {}", step.method, step.url);
    for f in &step.fields {
        let what = match &f.class {
            Class::Input { name, .. } => format!("input {name}"),
            Class::Constant { .. } => "constant".to_string(),
            Class::Piece { input, from, .. } => format!("piece of {input} at {from}"),
            Class::Derived { origin } => format!("from exchange {} at {:?}", origin.exchange, origin.at),
            Class::Minted { name } => format!("jar {name}"),
            Class::Unconfirmed { .. } => "unconfirmed (replayed as seen)".to_string(),
            Class::Fresh { id, .. } => format!("fresh {id}"),
            Class::Computed => "computed (browser)".to_string(),
            Class::Script { producer } => format!("script {}", producer.script),
            Class::Recipe { recipe } => format!("recipe {:?} over {} parts", recipe.algo, recipe.parts.len()),
            Class::Generated { evidence, .. } => format!("generated program ({} sightings)", evidence.sightings),
            Class::File { name, .. } => format!("file {name}"),
            Class::CookieIn { name, .. } => format!("jar {name} inside the page's value"),
        };
        eprintln!("   [debug]   {:?}: {what}", f.loc);
    }
}

/// [`replay_ledgered`], with the builder of what is sent chosen. With `fill_body` a step's request is the body's
/// filler's (`body::filled`): its holes, address, headers, body and the values made over it. Without, it is the
/// graph's own builders' ([`by_fields`]), as it always was. Where a replay is held to the filler (`body::shadowing`),
/// the other builds the same step beside it and the two are held to each other, request and rung, or refusal and
/// place (`body::held_alike`). An upload's request, around bytes the graph sends, is the graph's builders' either way.
/// Everything after the request is built is the same for both.
pub fn replay_ledgered_by(
    graph: &Graph,
    inputs: &HashMap<String, String>,
    fetch: &mut impl Fetch,
    ledger: &mut crate::ledger::Ledger,
    fill_body: bool,
) -> Result<HttpReplay, ReplayError> {
    run(graph, inputs, fetch, ledger, Requests::Graph { fill_body })
}

/// Runs a body step by step over `fetch`, as [`replay`] runs a graph: each step's request is the one the body's own
/// step builds (`route::start`, then `finish`), and everything else the call does (what is skipped, carried, judged,
/// counted as sent) is read off the body's [`skeleton`](crate::body::skeleton). A body a graph cannot say runs all the
/// same. A step's rung is the one its request was built at (`Built::rung`).
pub fn replay_body(body: &unbrowse_route::Route, inputs: &HashMap<String, String>, fetch: &mut impl Fetch) -> Result<HttpReplay, ReplayError> {
    let skeleton = crate::body::skeleton(body);
    let mut ledger = crate::ledger::Ledger::of(&skeleton);
    replay_body_ledgered(body, &skeleton, inputs, fetch, &mut ledger)
}

/// [`replay_body`], with the caller holding the ledger, made from the body's `skeleton` (`Ledger::of`): a run that
/// fails leaves it filled, as [`replay_ledgered`] does.
pub fn replay_body_ledgered(
    body: &unbrowse_route::Route,
    skeleton: &Graph,
    inputs: &HashMap<String, String>,
    fetch: &mut impl Fetch,
    ledger: &mut crate::ledger::Ledger,
) -> Result<HttpReplay, ReplayError> {
    run(skeleton, inputs, fetch, ledger, Requests::Body(body))
}

/// Where the one replay loop takes each step's request from.
#[derive(Clone, Copy)]
enum Requests<'a> {
    /// The graph's own builders, or with `fill_body` the body its step says (`body::filled`), the other beside it
    /// where a replay is held to the filler.
    Graph { fill_body: bool },
    /// A body's own steps, in the graph's order, through the filler. The graph is the body's skeleton, which says
    /// nothing of what a step sends, so nothing is built beside it.
    Body(&'a unbrowse_route::Route),
}

/// The one replay loop, with each step's request built as `requests` says and everything else read off `graph`.
fn run(
    graph: &Graph,
    inputs: &HashMap<String, String>,
    fetch: &mut impl Fetch,
    ledger: &mut crate::ledger::Ledger,
    requests: Requests<'_>,
) -> Result<HttpReplay, ReplayError> {
    let mut responses: HashMap<usize, Exchange> = HashMap::new();
    let mut steps = Vec::new();
    let mut rungs = Vec::new();
    // One new id for each the page made up when the route was learned, the same in every step of this call.
    let fresh = fresh_values(graph);
    for (n, step) in graph.steps.iter().enumerate() {
        let n = n + 1;
        // A session-only step is answered from the store before anything is
        // realized: its request body may be unreplayable (a challenge probe),
        // and it must not touch the network.
        if let Some(headers) = fetch.session_values(step.exchange) {
            let ex = Exchange {
                method: step.method.clone(),
                url: url::Url::parse(&step.url).unwrap_or_else(|_| url::Url::parse("https://invalid.local/").unwrap()),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: headers,
                response_body: Some(String::new()),
                response_mime: "application/octet-stream".into(),
                resource_type: Some("XHR".into()),
                main_frame: None,
            };
            steps.push((step.url.clone(), 200));
            rungs.push(Rung::Walk);
            responses.insert(step.exchange, ex);
            continue;
        }
        // A step whose answer nothing later reads — not the target, no cookie, no write, not the page markup — is the
        // page's own: the route never sends it. A browser would make the call, but its answer goes nowhere, and the
        // call can meet a wall the target never would.
        if n < graph.steps.len() && step.on_load && !step.reads_page && !step.sets_cookie && !crate::ledger::writes(step) && !graph.feeds_later(n - 1) {
            eprintln!("   [replay] step {} {} is the page's own: skipped, nothing reads it", n + 1, step.url);
            continue;
        }
        let bridged = graph.page.is_some() && step.is_page_signed();
        // The step's clock and chance, read once: whichever builder sends, and the one beside it, draw the same.
        let reading = crate::body::Reading::take();
        let uploads = matches!(step.body, Some(Body::Upload { .. }));
        // The filler's request, as replay sends it: around a file's bytes for an upload, which the upload sends.
        let sent = |filled: Result<unbrowse_route::Built, (unbrowse_route::Stuck, Option<unbrowse_route::Built>)>| match filled {
            Ok(built) => {
                let rung = crate::body::rung_of(&built);
                let req = Request { method: built.method, url: built.url, exchange: step.exchange, headers: built.headers, body: built.body.map(|b| unbrowse_route::wire::bytes_of(&b)) };
                Ok(if uploads { Made::Upload(req) } else { Made::Sent(req, rung) })
            }
            Err((stuck, built)) => Err(crate::body::refusal_of(&stuck, n, step, built.as_ref())),
        };
        // Before either builder reads a value (the graph's fields or the body's filler, whichever sends): a stranger's
        // step that would choose a credential's text itself is refused whole, with nothing of it sent.
        if let Some(why) = chosen_credential(n, step).or_else(|| misplaced_session(n, step)) {
            return Err(ReplayError::Refused(why));
        }
        let made = match requests {
            Requests::Body(body) => {
                said_by_name(n, step);
                sent(crate::body::filled_from(&body.steps[n - 1], graph, inputs, &*fetch, &responses, &fresh, reading))
            }
            Requests::Graph { fill_body } => {
                let filler_sends = fill_body && !uploads;
                let fields = (!filler_sends || crate::body::shadowing()).then(|| by_fields(graph, n, step, inputs, &*fetch, &responses, &fresh, bridged, reading));
                let filled = (filler_sends || crate::body::shadowing()).then(|| crate::body::filled(graph, step, inputs, &*fetch, &responses, &fresh, reading));
                if let (Some(fields), Some(filled)) = (&fields, &filled) {
                    let fields = match fields {
                        Ok(Made::Sent(req, rung)) => Ok((req, *rung)),
                        Ok(Made::Upload(req)) => Ok((req, Rung::Walk)),
                        Err((refusal, _)) => Err(refusal),
                    };
                    crate::body::held_alike(step, filled, fields);
                }
                match (filler_sends, fields, filled) {
                    (true, _, Some(filled)) => {
                        if !crate::body::shadowing() {
                            said_by_name(n, step);
                        }
                        sent(filled)
                    }
                    (_, Some(fields), _) => fields,
                    _ => unreachable!("one builder always builds what is sent"),
                }
            }
        };
        let (mut req, mut rung) = match made {
            Ok(Made::Sent(req, rung)) => (req, rung),
            Ok(Made::Upload(base)) => {
                let Some(Body::Upload { input, protocol, .. }) = &step.body else { unreachable!("an upload's request is an upload step's") };
                let raw = inputs.get(input).ok_or_else(|| ReplayError::MissingInput(input.clone()))?;
                let ex = upload(n, step, &base, input, raw, protocol, fetch, ledger)?;
                steps.push((base.url.to_string(), ex.status));
                rungs.push(if fetch.browser_made(step.exchange) { Rung::Browser } else { Rung::Walk });
                responses.insert(step.exchange, ex);
                continue;
            }
            // A call the route can't put together — a value from the page the plain fetch doesn't hold — is the page's
            // own, and one nothing after it reads is not this call's: the route goes on without it, as a browser that
            // never made that call would.
            Err((ReplayError::SourceMissing { .. }, true)) if n < graph.steps.len() && !graph.feeds_later(n - 1) => {
                eprintln!("   [replay] step {} {} has a value the page didn't hand over: skipped, nothing reads it", n + 1, step.url);
                continue;
            }
            Err((e, _)) => return Err(e),
        };
        // A value the page's own code makes is asked of the transport now that the request stands: a signing bridge
        // runs the page and reads the call it makes — its address, body and signatures together. That covers both a
        // value whose producer the walk named (`Class::Script`) and one it couldn't place (`Class::Computed`): the
        // page makes the call either way. A transport with no bridge says so, and the step goes to the browser, as a
        // computed value always has.
        // The page's own request is this step's request. `is_page_signed` covers both the step marker and the
        // Script/Computed fields older routes carry; the page's call is authoritative either way.
        let script_signed = step.is_page_signed();
        if script_signed {
            match fetch.sign_request(&req, inputs) {
                Some(signed) => {
                    rung = rung.max(signed.by);
                    // The page's own request, as it made it: its address, body and signatures travel together. A
                    // header the page set is *that* header, not a second copy beside the route's own value: a stale
                    // value left in front of a signature is a signature the site reads as wrong.
                    if let Ok(url) = signed.url.parse() {
                        req.url = url;
                    }
                    for (name, value) in signed.headers {
                        req.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(&name));
                        req.headers.push((name, value));
                    }
                    if signed.body.is_some() {
                        req.body = signed.body;
                    }
                }
                None => {
                    // A call the page didn't make, whose answer nothing after it reads, is the page's own: the route
                    // goes on without it, as a browser that never made that call would. One a later step reads from
                    // is not optional — that step would have nothing to send — unless the session already holds what
                    // it reads (a one-time bootstrap the page skips on a warm session): then the jar answers too.
                    if n < graph.steps.len() && !graph.feeds_later(n - 1) {
                        eprintln!("   [replay] step {} {} is not one the page makes: skipped, nothing reads it", n + 1, req.url.path());
                        continue;
                    }
                    if n < graph.steps.len() && held_for_later(graph, step, fetch) {
                        eprintln!("   [replay] step {} {} is not one the page makes: the session holds what later steps read", n + 1, req.url.path());
                        continue;
                    }
                    let loc = step.page_producers.first().map(|p| p.loc.clone()).unwrap_or(Loc::Url);
                    // The page's own code made nothing for this step, and nothing else makes its values: a plain read
                    // goes as the route builds it, and the site's answer says whether it needed them (`api::goal`'s
                    // own reader holds it, and a call that fails is the browser's as any failed call is). Never a
                    // step that can change the site. The write rule (`ledger::writes`) is this engine's one reader of
                    // that question, so it is the one asked here too: a request it names a read — the page sent it as
                    // it loaded, it answered with data and set no cookie, or its path is a query's — is sent as the
                    // route builds it whatever its method, and a POST that only asked is no reason to open a browser.
                    let a_plain_read = !crate::ledger::writes(step);
                    if !a_plain_read {
                        return Err(ReplayError::NeedsBrowser { step: n, url: req.url.to_string(), loc });
                    }
                    // A request that lost a value of the caller's on the way — the page computes it, so its place went
                    // unsent — asks the site another value, and its answer is that value's: nothing is sent.
                    if let Some(value) = values_it_lacks(&what_it_says(req.url.as_str(), req.body.as_deref()), inputs).first() {
                        eprintln!("   [replay] step {} {} does not carry {value:?}: the page's code makes it, so nothing is sent", n, req.url.path());
                        return Err(ReplayError::NeedsBrowser { step: n, url: req.url.to_string(), loc });
                    }
                    eprintln!("   [replay] step {} {} is sent as the route builds it: the page's code made nothing for it", n, req.url.path());
                    fetch.fell_back(format!(
                        "the page's own code made no call for step {n} ({}), so it was sent as the route builds it: the site's answer says whether it needed the page's values",
                        req.url.path()
                    ));
                }
            }
        }
        // A request the call's rule refuses is never made: it fails the call before it counts as sent.
        // The page the route carries is the first step's own answer. Its markup is what the route's page-derived
        // values read and what a signing bridge boots; re-fetching it buys nothing and can meet a wall the walk never
        // did. It is fetched live only when a later step reads its live headers, it set a cookie, or it is the target.
        let carried = carried_page(graph, step, n);
        // A page the route carries is the walk's own markup, not the site's current answer: it cannot be the site
        // checking a caller, and a client-rendered shell (a short static text, no links, its app's scripts) is a page.
        let from_markup = carried.is_some();
        let ex = match carried {
            Some(html) => crate::trace::Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: req.headers.clone(),
                request_body: req.body.as_deref().filter(|b| !b.is_empty()).map(unbrowse_route::wire::carried),
                status: step.status,
                response_headers: Vec::new(),
                response_body: Some(html),
                response_mime: "text/html".into(),
                resource_type: Some("Document".into()),
                main_frame: Some(true),
            },
            None => {
                fetch.allows(&req)?;
                // From here the request may reach the site, whatever the transport answers or fails with.
                ledger.sending(n);
                // A step whose answer was a redirect, and whose redirect a later step reads (the address it hands over,
                // a sign-in's one-time flow id in it), is sent without following it: the redirect is its answer.
                let ex = if hands_over_its_redirect(graph, step) { fetch.fetch_unredirected(&req)? } else { fetch.fetch(&req)? };
                // A gateway that signs with a token it issues itself hands the token over on the first call that
                // lacks it: the call is signed again with it and sent once more. A write is never sent twice.
                let ex = match resigned(step, &req, &ex, reading.now).filter(|_| !crate::ledger::writes(step)) {
                    Some(again) => {
                        eprintln!("   [replay] step {} {} handed over the token its signature is over: signed again and sent once more", n, req.url.path());
                        fetch.allows(&again)?;
                        req = again;
                        fetch.fetch(&req)?
                    }
                    None => ex,
                };
                asked_again_when_busy(fetch, &req, ex, step)?
            }
        };
        ledger.heard(n, &req.url, &ex);
        // The recorded status is the expected one: a route learned through a
        // guest probe that answers 401 does the same on every call.
        let expected = (200..400).contains(&ex.status) || ex.status == step.status;
        let found_nothing = n == graph.steps.len() && crate::answer::found_nothing(step, inputs, &ex);
        if !expected && !found_nothing {
            // A call the page made that the site now refuses, and that nothing after it reads, is the page's own: the
            // route goes on without it, as a browser that ignored the failed call would. The target and a step whose
            // cookie later steps need are not skipped — their answer is the request.
            // A failed call sets nothing, so a cookie the walk saw it set is not this call's either: skip it when no
            // later step reads it. The target and a read answer are never skipped.
            if n < graph.steps.len() && !graph.feeds_later(n - 1) {
                eprintln!("   [replay] step {} {} answered {}: skipped, nothing reads it", n + 1, req.url.path(), ex.status);
                continue;
            }
            // The site's door, told apart from drift: the route knows one, or this answer shows one. A refusal with
            // no vendor's mark is the site's own (its scripts, its rule), and stays a plain failure for the values to
            // diagnose.
            let known = graph.door.as_ref().filter(|d| d.statuses.contains(&ex.status)).cloned();
            // A vendor marks every answer it serves, a page not found among them: its cookie on a 404 says who served
            // the 404, not that a wall stood. Only a refusal, or a page that is the vendor's check, is its door.
            let walled = crate::trace::REFUSED.contains(&ex.status) || crate::page::a_door(ex.status, ex.response_body.as_deref().unwrap_or_default(), &req.url);
            let met = known.or_else(|| crate::graph::Door::answered(&ex).filter(|_| walled));
            if let Some(door) = met {
                let wall = crate::refusal::read(&crate::refusal::Answer { status: ex.status, body: ex.response_body.as_deref().unwrap_or_default(), url: &ex.url, asked: Some(&req.url) });
                return Err(ReplayError::Door { step: n, url: req.url.to_string(), status: ex.status, door, wall });
            }
            return Err(ReplayError::Failed { step: n, url: req.url.to_string(), status: ex.status, body: ex.response_body.clone().unwrap_or_default() });
        }
        // A page the chain reads a value from that comes back as the site's check for a person (a challenge page, served
        // 2xx) holds none of what the walk read there: the call fails at that step, saying what the site sent, rather
        // than at the next for a value that was never going to be there.
        let body = ex.response_body.as_deref().unwrap_or_default();
        if n < graph.steps.len() && !from_markup && body.trim_start().starts_with('<') && crate::page::a_door(ex.status, body, &req.url) {
            // But a step nothing after it reads is the page's own, and the site's check in its place is not what the
            // call came for: the route goes on without it, as a browser that never loaded that page would, and as it
            // already does for a step that answered an unexpected status. Its answer is never the call's request.
            if !graph.feeds_later(n - 1) {
                eprintln!("   [replay] step {} {} answered {} with the site's check for a person: skipped, nothing reads it", n + 1, req.url.path(), ex.status);
                continue;
            }
            if let Some(door) = graph.door.clone().or_else(|| crate::graph::Door::answered(&ex)) {
                let wall = crate::refusal::read(&crate::refusal::Answer { status: ex.status, body: ex.response_body.as_deref().unwrap_or_default(), url: &ex.url, asked: Some(&req.url) });
                return Err(ReplayError::Door { step: n, url: req.url.to_string(), status: ex.status, door, wall });
            }
            return Err(ReplayError::Failed { step: n, url: req.url.to_string(), status: ex.status, body: body.to_string() });
        }
        steps.push((req.url.to_string(), ex.status));
        crate::budget::note(&ex);
        rungs.push(if fetch.browser_made(step.exchange) { Rung::Browser } else { rung });
        responses.insert(step.exchange, ex);
    }

    let last = graph.steps.last().expect("a graph has its target");
    let mut target = responses.remove(&last.exchange).expect("the target ran");
    // A reply no standard reader reads, that the body says the site's own code unpacks (`Answer::decode`): the decoder
    // cut at learn time runs over it in the sandbox, and from here on the target is what it was turned into, so every
    // judge below and the call's answer read it as the page did. The decoder made the answer, so the answer's step is
    // counted at its rung (a function of the site's, `Rung::Function`), as any hole a program made is.
    if let Requests::Body(body) = &requests {
        if let Some(d) = body.answer.decode.as_ref() {
            let raw = target.response_body.clone().unwrap_or_default();
            if let Some(text) = crate::trace::decoded_answer(&d.source, &raw, &fetch.environment()) {
                target.response_body = Some(text);
                target.response_mime = "application/json".into();
                target.response_headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
                if let Some(r) = rungs.last_mut() {
                    *r = (*r).max(Rung::Function);
                }
            }
        }
    }
    // A read's target that came back with no answer (a refusal, an error in the site's words, a challenge, nothing,
    // a detour) fails the call, saying what the site said, before its shape is weighed.
    // A search the site answers with a page saying it found nothing (a 404 that says back what was asked) is answered:
    // nothing is what there is (`answer::found_nothing`).
    let found_nothing = crate::answer::found_nothing(last, inputs, &target);
    if let Some(asked) = steps.last().and_then(|(u, _)| url::Url::parse(u).ok()).filter(|_| !found_nothing) {
        if let Some(why) = crate::answer::replayed_not_an_answer(last, &asked, &target) {
            return Err(ReplayError::NotAnAnswer { status: target.status, why, challenge: crate::answer::a_challenge(&target) });
        }
    }
    if let Some(expected) = last.response_shape.as_ref().filter(|_| !found_nothing) {
        // Read as the recording was: a page's answer is the data embedded in its HTML (and a reply the site's own code
        // unpacks was turned into its answer above: the shape was recorded of that).
        let got = target.json_body_like(Some(expected)).map(|v| shape(&v));
        if !got.as_ref().is_some_and(|g| answers_like(expected, g)) {
            return Err(ReplayError::ShapeMismatch { expected: expected.clone(), got: got.unwrap_or(Value::Null) });
        }
    }
    Ok(HttpReplay { steps, rungs, target, ledger: ledger.clone() })
}

/// Whether the target's answer is the same API's answer: at the top, most of the recorded keys with the same kind
/// of value (an object, a list, a scalar). Below that, an API varies by query (a product search lists differently
/// shaped cards than a listing search), and that is still an answer, not drift. A block page or another endpoint
/// still fails here, as does any answer that isn't an object when the recording was.
pub(crate) fn answers_like(expected: &Value, got: &Value) -> bool {
    let kind = |v: &Value| match v {
        Value::Object(_) => 0,
        Value::Array(_) => 1,
        _ => 2,
    };
    match (expected, got) {
        (Value::Object(a), Value::Object(b)) => {
            // An answer whose only content is an error list, where the recording had none, is the call failing in the
            // site's words (a refused operation beside an empty `data`), not another shape of the answer. Which
            // operation a shared endpoint answered is settled by the request, never by the answer's keys: a search may
            // answer in another card shape.
            let empty = |v: &Value| v.is_null() || v == "null" || v.as_object().is_some_and(|o| o.values().all(|x| x.is_null() || x == "null"));
            let errors = b.get("errors").is_some_and(|e| e.as_array().is_some_and(|l| !l.is_empty()) || e.is_string());
            if errors && !a.contains_key("errors") && b.iter().filter(|(k, _)| k.as_str() != "errors").all(|(_, v)| empty(v)) {
                return false;
            }
            let shared = a.keys().filter(|k| b.contains_key(k.as_str())).count();
            shared * 2 >= a.len()
                && a.iter().all(|(k, va)| b.get(k).is_none_or(|vb| va == "null" || vb == "null" || kind(va) == kind(vb)))
        }
        _ => shape_matches(expected, got),
    }
}

/// A recorded shape accepts the answer: every key the answer has, the recording
/// had with the same type — no new keys, no type changes. Keys the recording saw
/// that the answer omits are fine (optional fields are absent for some items),
/// and a field recorded as `null` may arrive with a type (`matched_title` is
/// null for some results and a string for others).
fn shape_matches(expected: &Value, got: &Value) -> bool {
    match (expected, got) {
        // A field may be absent: the shape says "null" (a result with no
        // thumbnail), on either side.
        (_, Value::String(g)) if g == "null" => true,
        // A field recorded as absent may have a type now (matched_title is null
        // for some results and a string for others).
        (Value::String(e), _) if e == "null" => true,
        // Shared keys must keep their types, and most of the recording's keys
        // must be present. A server-rendered page's state blob legitimately
        // varies per fetch: lazy slices appear only with data, experiments
        // add keys. A wrong page still fails — it shares too few keys with
        // the recording to reach the half.
        (Value::Object(a), Value::Object(b)) => {
            a.iter().all(|(ka, va)| b.get(ka).is_none_or(|vb| shape_matches(va, vb)))
                && a.keys().filter(|k| b.contains_key(k.as_str())).count() * 2 >= a.len()
        }
        // No results is an answer, not drift: a search for something that doesn't exist answers an empty list.
        // Either side empty says nothing about the items' shape.
        (Value::Array(a), Value::Array(b)) => {
            a.is_empty() || b.is_empty() || (a.len() == b.len() && a.iter().zip(b.iter()).all(|(va, vb)| shape_matches(va, vb)))
        }
        _ => expected == got,
    }
}

/// Where a value sits, for this run: a JSON source keyed by what the caller sent (`/items/1321463987/uuid`, the
/// item's entry in its own page) follows what the caller sends now. A piece that is a place in a list (`/pages/0/id`)
/// is not a key: it counts the answer's own entries, and reads where it read whatever the caller sends, though a
/// caller's value was once written the same way (a first page asked for as `offset=0`).
pub(crate) fn rekeyed(at: &At, graph: &Graph, inputs: &HashMap<String, String>, answer: Option<&str>) -> At {
    let At::Json { pointer } = at else { return at.clone() };
    let escape = |s: &str| s.replace('~', "~0").replace('/', "~1");
    let unescape = |s: &str| s.replace("~1", "/").replace("~0", "~");
    let mut parts: Vec<String> = pointer.split('/').map(String::from).collect();
    let moved: Vec<(String, String)> = graph
        .steps
        .iter()
        .flat_map(|s| &s.fields)
        .filter_map(|f| match &f.class {
            Class::Input { name, default: Some(was), .. } => {
                inputs.get(name).filter(|now| *now != was).map(|now| (escape(was), escape(now)))
            }
            _ => None,
        })
        .collect();
    if moved.is_empty() {
        return at.clone();
    }
    let parsed: Option<Value> = answer.and_then(|a| serde_json::from_str(a).ok());
    let mut here: Option<&Value> = parsed.as_ref();
    for p in parts.iter_mut().skip(1) {
        let in_a_list = matches!(here, Some(Value::Array(_)));
        if !in_a_list {
            if let Some((_, now)) = moved.iter().find(|(was, _)| was == p) {
                *p = now.clone();
            }
        }
        here = here.and_then(|v| match v {
            Value::Array(a) => p.parse::<usize>().ok().and_then(|i| a.get(i)),
            Value::Object(o) => o.get(&unescape(p)),
            _ => None,
        });
    }
    At::Json { pointer: parts.join("/") }
}

/// A new id for each one the route's page made up when it was learned, by the id the walk sent.
fn fresh_values(graph: &Graph) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for f in graph.steps.iter().flat_map(|s| &s.fields) {
        if let Class::Fresh { id, clock, .. } = &f.class {
            if !out.contains_key(id) {
                let mut new = crate::fresh::make(*clock, out.len());
                // A reading equal to the walk's would be the walk's id again, which the site has seen.
                if &new == id {
                    new = crate::fresh::make(*clock, out.len() + 1);
                }
                out.insert(id.clone(), new);
            }
        }
    }
    out
}

/// Sends a file to an upload step by its protocol, chunk by chunk, each chunk read from the file as it goes: no
/// file's bytes are kept or logged. The last chunk's answer is the step's, the one later steps read. A chunk the
/// server answers 206 is one it is still waiting past; any answer outside 200..400 fails the step.
#[allow(clippy::too_many_arguments)]
fn upload(
    n: usize,
    step: &Step,
    base: &Request,
    input: &str,
    raw: &str,
    protocol: &crate::upload::Protocol,
    fetch: &mut impl Fetch,
    ledger: &mut crate::ledger::Ledger,
) -> Result<Exchange, ReplayError> {
    use crate::upload::Protocol;
    use std::io::{Read, Seek, SeekFrom};
    let refused = |reason: String| ReplayError::File { input: input.to_string(), reason };
    let mut opened = crate::files::open_in(raw, &fetch.file_root()).map_err(refused)?;
    let total = opened.size;
    let chunk = protocol.chunk().filter(|c| *c > 0).unwrap_or(total.max(1));
    let mut offset = 0u64;
    ledger.sending(n);
    loop {
        let len = chunk.min(total - offset);
        let last = offset + len >= total;
        let mut bytes = vec![0u8; len as usize];
        opened.file.seek(SeekFrom::Start(offset)).and_then(|_| opened.file.read_exact(&mut bytes)).map_err(|_| refused("changed while it was being sent".into()))?;
        let mut headers: Vec<(String, String)> = base.headers.iter().filter(|(k, _)| !protocol.sets(k)).cloned().collect();
        match protocol {
            Protocol::Rupload { .. } => {
                headers.push(("offset".into(), offset.to_string()));
                headers.push(("x-entity-length".into(), total.to_string()));
            }
            Protocol::GoogleResumable { .. } => {
                headers.push(("x-goog-upload-command".into(), if last { "upload, finalize" } else { "upload" }.into()));
                headers.push(("x-goog-upload-offset".into(), offset.to_string()));
            }
            Protocol::Single => {}
        }
        let req = Request { headers, body: Some(bytes), ..base.clone() };
        let mut ex = fetch.fetch(&req)?;
        // The answer keeps no copy of what was sent.
        ex.request_body = None;
        if !((200..400).contains(&ex.status) || ex.status == step.status) {
            // The chunks before this one are at the site: a refusal of the rest doesn't take them back.
            if offset == 0 {
                ledger.heard(n, &req.url, &ex);
            }
            return Err(ReplayError::Failed { step: n, url: req.url.to_string(), status: ex.status, body: ex.response_body.clone().unwrap_or_default() });
        }
        offset += len;
        if last {
            ledger.heard(n, &req.url, &ex);
            return Ok(ex);
        }
    }
}

/// Where a step of a route this node didn't learn wraps a value an earlier answer gave in text of its own that can
/// choose a credential: a header or cookie whose `Derived` origin puts anything around the value but an authentication
/// scheme before it ([`crate::provenance::Origin::wraps_only_a_scheme`]). The wrap is the body's word, sent as it is:
/// `Bearer <their token> ` before the site's value makes the whole `authorization` value theirs. Said as the field,
/// never the text. The node's own step is what its own walk saw, and is never asked. `n` is the step's number, from 1.
pub fn chosen_credential(n: usize, step: &Step) -> Option<String> {
    if !step.foreign {
        return None;
    }
    step.fields.iter().find_map(|f| match &f.class {
        Class::Derived { origin } if matches!(f.loc, Loc::Header(_) | Loc::Cookie(_)) && !origin.wraps_only_a_scheme() => {
            Some(format!("step {n} {} puts text of the route's own around a value the site gave: a route this node didn't learn sends a credential only as the site gave it, after an authentication scheme at most", f.loc))
        }
        _ => None,
    })
}

/// Where a step of a route this node didn't learn puts a session value somewhere a browser never would, said as the
/// field (`step 2 query sid`), never its value: a session value of the jar (`Minted`) anywhere but the cookie header or
/// a header the session carries, or a cookie the site set during the call ([`crate::provenance::At::sets_a_cookie`])
/// anywhere but the cookie header. A form, query, JSON or path field holding the session is how someone else's route
/// would carry the owner's session where the site writes it down (a search box, a comment, a log line) and reads it
/// back to its author. The node's own step is what its own walk saw the page send, and is never asked. `n` is the
/// step's number, from 1.
pub fn misplaced_session(n: usize, step: &Step) -> Option<String> {
    if !step.foreign {
        return None;
    }
    step.fields.iter().find_map(|f| {
        let misplaced = match &f.class {
            Class::Minted { .. } => !matches!(f.loc, Loc::Cookie(_) | Loc::Header(_)),
            Class::Derived { origin } => origin.at.sets_a_cookie() && !matches!(f.loc, Loc::Cookie(_)),
            _ => false,
        };
        misplaced.then(|| format!("step {n} {} puts the session somewhere other than the cookie header: a route this node didn't learn carries the session only as a browser sends it", f.loc))
    })
}

/// Every field's value for this run.
fn realize(
    graph: &Graph,
    n: usize,
    step: &Step,
    inputs: &HashMap<String, String>,
    fetch: &impl Fetch,
    responses: &HashMap<usize, Exchange>,
    fresh: &HashMap<String, String>,
    bridged: bool,
) -> Result<Vec<(Loc, String)>, ReplayError> {
    // Checked before any value is read, whoever calls this: a stranger's step that wraps a value an answer gave in a
    // credential text of its own, or puts the session outside the cookie header, is refused whole, with nothing sent.
    if let Some(why) = chosen_credential(n, step).or_else(|| misplaced_session(n, step)) {
        return Err(ReplayError::Refused(why));
    }
    let mut out = Vec::new();
    for f in &step.fields {
        let value = match &f.class {
            Class::Input { name, default, optional, .. } => match inputs.get(name).cloned().or_else(|| default.clone()) {
                Some(v) => v,
                None if *optional => continue,
                None => return Err(ReplayError::MissingInput(name.clone())),
            },
            // A session value the store lacks is simply not sent, the way a
            // browser omits a cookie it does not hold. If the site truly needs
            // it, the call fails and the heal re-mints.
            // A cookie someone else's body names is the owner's only where the jar's cookies go: the site check
            // (`share::bound`) lets a body reach any host of the site, and the jar no longer knows which of its
            // cookies that host would be sent. The node's own walk saw the browser send it, so its step sends it.
            Class::Minted { name } => match match &f.loc {
                Loc::Cookie(_) if step.foreign => fetch.minted_cookie(name, step_host(&step.url).as_deref()),
                _ => fetch.minted(name),
            } {
                Some(v) => v,
                None => continue,
            },
            Class::Constant { value, .. } => value.clone(),
            Class::Derived { origin } => {
                let missing = || ReplayError::SourceMissing { step: n, url: step.url.clone(), loc: f.loc.clone() };
                // A cookie is session state: the browser keeps it across
                // responses that do not re-set it. When the recorded source
                // no longer sets it, the store's copy is the right value — and
                // if the store has none either, it is simply not sent.
                let from_source = responses
                    .get(&origin.exchange)
                    .and_then(|source| extract(source, &rekeyed(&origin.at, graph, inputs, source.response_body.as_deref())));
                let v = match from_source {
                    Some(v) => match &origin.wrap {
                        Some((before, after)) => format!("{before}{v}{after}"),
                        None => v,
                    },
                    None => match &f.loc {
                        Loc::Cookie(name) => match fetch.minted_cookie(name, step_host(&step.url).as_deref()) {
                            Some(v) => v,
                            None => continue,
                        },
                        // A step the page signs takes the page's own request whole, so a value the page didn't hand
                        // over is not this request's: the signature and the body that carries it come from the page.
                        _ if bridged => continue,
                        // The request's own template holds `null` where the walk had this value: the site left the
                        // state out this time (a query it doesn't render), and a call that cannot re-derive it sends
                        // the template's null rather than failing at a value the request never needed.
                        _ if template_is_null(step, &f.loc) => continue,
                        // A list the walk read off a list in an earlier answer, one element each: this answer's
                        // list is shorter (a search that found twelve where the walk's found eighteen), and the
                        // list sent is as long as the list read. Its end is cut where the body is written.
                        _ if follows_a_list(step, &f.loc, origin.exchange) && responses.contains_key(&origin.exchange) => continue,
                        // A header an earlier answer's own header filled (a request id a server stamps on its
                        // answers) is not there when that step was answered another way: by the browser going to
                        // the page, which hands over the page and not its headers. The header goes unsent, and the
                        // site says whether it needed it; a call refused for it fails as any refused call does.
                        Loc::Header(_) if matches!(origin.at, crate::provenance::At::Header { .. }) && responses.contains_key(&origin.exchange) => continue,
                        // The walk's own reading, where the graph keeps it (`Step::fallback`): a value of the page's
                        // own load that a later load leaves out (an experiment's code, a visitor's id, a piece of the
                        // state it renders) is not the call failing, as a browser's page holds what its own load gave
                        // it. The value is the walk's, never one made up, and holds no word the page was asked.
                        _ if step.fallback(&f.loc).is_some() => {
                            eprintln!("   [replay] step {} {:?}: the answer does not hold it, so it is sent as the walk read it", n + 1, f.loc);
                            step.fallback(&f.loc).expect("just asked").to_string()
                        }
                        _ => {
                            // Name what a page that answered didn't hold: a page whose state moved is diagnosed from
                            // the pointer, not from the step it landed in. (A step with no answer yet is the fast
                            // path trying the target alone, which is expected to send nothing.)
                            if let Some(seen) = responses.get(&origin.exchange) {
                                eprintln!("   [replay] step {} needs {:?} from exchange {} (status {}, {} bytes): not there",
                                    n + 1, origin.at, origin.exchange, seen.status, seen.response_body.as_deref().map_or(0, str::len));
                            }
                            return Err(missing())
                        }
                    },
                };
                v
            }
            Class::Computed => continue,
            // A piece of what the caller sent (`date: 2026-11-12` for `?dateTime=2026-11-12T19:00:00`): the same piece
            // of what they send now, so a call for another day asks for that day.
            Class::Piece { input, from, len } => {
                let Some(given) = inputs.get(input) else { return Err(ReplayError::MissingInput(input.clone())) };
                let piece: String = given.chars().skip(*from).take(*len).collect();
                if piece.chars().count() < *len {
                    return Err(ReplayError::SourceMissing { step: n, url: step.url.clone(), loc: f.loc.clone() });
                }
                piece
            }
            // A producer's value is not realized here: it is asked of the transport once the request is built, from
            // the URL, method, body and fields this step knows (`Fetch::sign_request`).
            Class::Script { .. } => continue,
            // A recipe's value needs the request complete: it is computed beside the request, below (`signing::compute`).
            Class::Recipe { .. } => continue,
            // A generated producer's value is computed beside the request too, from the same context it was fitted on.
            Class::Generated { .. } => continue,
            Class::Unconfirmed { value } => value.clone(),
            Class::Fresh { value, id, .. } => value.replace(id.as_str(), fresh.get(id).map(String::as_str).unwrap_or(id)),
            // The caller's own cookie where the walker's stood; nothing there when the jar holds none.
            Class::CookieIn { template, name } => Class::cookie_in(template, fetch.minted(name).as_deref()),
            Class::File { name, of } => {
                let raw = inputs.get(name).ok_or_else(|| ReplayError::MissingInput(name.clone()))?;
                let opened = crate::files::open_in(raw, &fetch.file_root()).map_err(|reason| ReplayError::File { input: name.clone(), reason })?;
                match of {
                    crate::upload::FileFact::Size => opened.size.to_string(),
                    crate::upload::FileFact::Name => opened.name,
                }
            }
        };
        out.push((f.loc.clone(), value));
    }
    // What the caller asks now goes where the walk's own value rode inside a longer one. A value taken from a fresh
    // answer may say it already, and is left as the site wrote it. The walk's own text is never left for saying it
    // somewhere else (a key of the JSON the word rides in, an earlier search a history holds): asked for `query`, a
    // call whose walked value was `{"query":"lamp"}` searches for `query`, not for the walk's lamp.
    for h in &step.held {
        let Some(now) = inputs.get(&h.input).map(|v| h.written.write(v)) else { continue };
        let fresh = step.fields.iter().any(|f| f.loc == h.loc && matches!(f.class, Class::Derived { .. }));
        let Some((_, v)) = out.iter_mut().find(|(l, _)| *l == h.loc) else { continue };
        let said = |text: &str| fresh && text.contains(&now);
        match h.inside {
            // The value is a text encoded again: the caller's word goes into the text, and the text is encoded back the
            // same way (`learn.derivation`).
            Some(wrap) => {
                if let Some(text) = wrap.open(v).filter(|text| !said(text)) {
                    *v = wrap.close(&crate::graph::swapped(&text, &h.sits, &now));
                }
            }
            None if !said(v) => *v = crate::graph::swapped(v, &h.sits, &now),
            None => {}
        }
    }
    Ok(out)
}

/// A JSON pointer's list and place in it: `/variables/ids/3` is (`/variables/ids`, 3).
fn place_in_a_list(pointer: &str) -> Option<(&str, usize)> {
    let (parent, last) = pointer.rsplit_once('/')?;
    Some((parent, last.parse().ok()?))
}

/// Whether the value at `loc` is an element, past the first, of a list whose first element the step also takes from
/// an answer of `exchange`: a list read off a list.
pub(crate) fn follows_a_list(step: &Step, loc: &Loc, exchange: usize) -> bool {
    let Loc::Json(pointer) = loc else { return false };
    let Some((parent, at)) = place_in_a_list(pointer) else { return false };
    at >= 1 && followed_lists_from(step, Some(exchange)).iter().any(|p| p == parent)
}

/// The lists in a step's body that follow a list in an earlier answer: two or more of their elements, the first
/// among them, are taken from one exchange's answer.
pub(crate) fn followed_lists(step: &Step) -> Vec<String> {
    followed_lists_from(step, None)
}

fn followed_lists_from(step: &Step, exchange: Option<usize>) -> Vec<String> {
    let mut lists: std::collections::BTreeMap<String, Vec<(usize, usize)>> = Default::default();
    for f in &step.fields {
        if let (Loc::Json(pointer), Class::Derived { origin }) = (&f.loc, &f.class) {
            if let Some((parent, at)) = place_in_a_list(pointer) {
                lists.entry(parent.to_string()).or_default().push((at, origin.exchange));
            }
        }
    }
    lists
        .into_iter()
        .filter(|(_, items)| {
            let Some(&(_, first)) = items.iter().find(|(at, _)| *at == 0) else { return false };
            items.len() >= 2 && items.iter().filter(|(_, from)| *from == first).count() >= 2 && exchange.is_none_or(|e| items.iter().any(|(_, from)| *from == e))
        })
        .map(|(parent, _)| parent)
        .collect()
}

/// The cookies a request carries, by name: what a recipe's parts read, exactly as the call sends them.
/// The cookies a signature's recipe is over, by name.
fn cookie_parts(recipe: &crate::signing::Recipe) -> Vec<String> {
    recipe
        .parts
        .iter()
        .filter_map(|p| match p {
            crate::signing::Part::Cookie { name } | crate::signing::Part::CookiePiece { name, .. } => Some(name.clone()),
            _ => None,
        })
        .collect()
}

/// How many times a call asks a site that said it was out of asks, and how long it waits before each: the interval the
/// site names in `Retry-After` when it names a whole number of seconds, else the node's own, growing. Bounded, so a
/// call never hangs on a site's own number.
const ASKED_AGAIN: usize = 2;
const OUR_WAITS: [std::time::Duration; ASKED_AGAIN] = [std::time::Duration::from_millis(1000), std::time::Duration::from_millis(2500)];
const LONGEST_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// A site that answers "too many requests" is asking to be asked again, not refusing: the answer is read as the wall it
/// is (`refusal::read` names it `Wall::Rate`) and waiting is the only source that clears it (`Wall::sources`). So a
/// step the write rule names a read is asked again, after the interval the site names when it names a short one, else
/// after the node's own — at most [`ASKED_AGAIN`] more times, and never past [`LONGEST_WAIT`]. A step that may change
/// the site is never sent twice, as a heal is never run on one.
fn asked_again_when_busy(fetch: &mut impl Fetch, req: &Request, first: Exchange, step: &Step) -> Result<Exchange, ReplayError> {
    let busy = |ex: &Exchange| {
        matches!(
            crate::refusal::read(&crate::refusal::Answer { status: ex.status, body: ex.response_body.as_deref().unwrap_or_default(), url: &ex.url, asked: Some(&req.url) }),
            Some(crate::refusal::Wall::Rate)
        )
    };
    if !busy(&first) || crate::ledger::writes(step) {
        return Ok(first);
    }
    let mut ex = first;
    for own in OUR_WAITS {
        let wait = wait_called_for(&ex).unwrap_or(own).min(LONGEST_WAIT);
        eprintln!("   [replay] step {} {} answered {} (out of asks): asked again after {} ms", step.url, req.url.path(), ex.status, wait.as_millis());
        fetch.fell_back(format!("the site was out of asks ({}): asked again after {} ms", ex.status, wait.as_millis()));
        std::thread::sleep(wait);
        ex = fetch.fetch(req)?;
        if !busy(&ex) {
            return Ok(ex);
        }
    }
    Ok(ex)
}

/// The interval the answer names, in `Retry-After`, as a whole number of seconds. A date is not read — the node's own
/// wait stands in its place — so a site's own number can never hold a call for long.
fn wait_called_for(ex: &Exchange) -> Option<std::time::Duration> {
    ex.response_headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("retry-after"))
        .and_then(|(_, v)| v.trim().parse::<u64>().ok())
        .map(std::time::Duration::from_secs)
}

/// `req` again, carrying every cookie `answer` set and signed over the ones its signatures are over and it was sent
/// without: the request a page's code sends once its gateway hands it the token. None when the step signs over no
/// cookie it lacked, or the answer set none of them.
fn resigned(step: &Step, req: &Request, answer: &Exchange, now: u64) -> Option<Request> {    let sent = sent_cookies(req);
    let lacked: Vec<String> = step
        .fields
        .iter()
        .filter_map(|f| match &f.class {
            Class::Recipe { recipe } => Some(cookie_parts(recipe)),
            _ => None,
        })
        .flatten()
        .filter(|name| !sent.iter().any(|(k, v)| k == name && !v.is_empty()))
        .collect();
    if lacked.is_empty() {
        return None;
    }
    let set: Vec<(String, String)> = answer
        .response_headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
        .filter_map(|(_, line)| {
            let (name, rest) = line.split_once('=')?;
            Some((name.trim().to_string(), rest.split(';').next().unwrap_or_default().trim().to_string()))
        })
        .filter(|(_, value)| !value.is_empty())
        .collect();
    // Only an answer that handed over what the signature is over; and then everything it set goes back with the call,
    // as a page's next request carries it (a gateway hands its token over in a pair: the token and its check).
    if !set.iter().any(|(name, _)| lacked.contains(name)) {
        return None;
    }
    // The cookie header with what the answer handed over in place of, or beside, what was sent.
    let mut cookies: Vec<(String, String)> = sent.into_iter().filter(|(k, _)| !set.iter().any(|(n, _)| n == k)).collect();
    cookies.extend(set);
    let mut again = req.clone();
    again.headers.retain(|(k, _)| !k.eq_ignore_ascii_case("cookie"));
    again.headers.push(("cookie".into(), cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")));
    let text = again.body.as_deref().map(|b| String::from_utf8_lossy(b).into_owned());
    for f in &step.fields {
        let Class::Recipe { recipe } = &f.class else { continue };
        let value = crate::signing::compute_with(recipe, &again, text.as_deref(), &cookies, now, |_| String::new())?;
        match &f.loc {
            Loc::Header(name) => {
                again.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
                again.headers.push((name.clone(), value));
            }
            Loc::Query(key) => {
                let others: Vec<(String, String)> = again.url.query_pairs().filter(|(k, _)| k != key).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                again.url.query_pairs_mut().clear().extend_pairs(others).append_pair(key, &value);
            }
            _ => return None,
        }
    }
    Some(again)
}

fn sent_cookies(req: &Request) -> Vec<(String, String)> {
    req.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("cookie"))
        .map(|(_, v)| {
            v.split(';')
                .filter_map(|p| p.split_once('='))
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// The host a step's URL template names, lowercased; `None` when the template builds its host at call time.
pub fn step_host(template: &str) -> Option<String> {
    let authority = template.split_once("://")?.1.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['{', '}']) {
        return None;
    }
    url::Url::parse(&template.replace('{', "%7B").replace('}', "%7D")).ok()?.host_str().map(str::to_ascii_lowercase)
}

/// What a path segment escapes: everything but the characters an address carries as themselves (RFC 3986's
/// unreserved), so a segment such as `fb_uploader_1793383794019` goes as the browser sent it.
const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

fn request_url(step: &Step, values: &[(Loc, String)]) -> Result<url::Url, ReplayError> {
    // An address an earlier answer handed over is taken whole, on the step's own origin only: an answer that names
    // another origin would send the step, and the file it uploads, somewhere the route never went.
    if let Some((_, handed)) = values.iter().find(|(l, _)| *l == Loc::Url) {
        let to = url::Url::parse(handed.trim()).map_err(|e| ReplayError::BadUrl(format!("{handed}: {e}")))?;
        let own = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")).map_err(|e| ReplayError::BadUrl(format!("{}: {e}", step.url)))?;
        if to.origin() != own.origin() {
            return Err(ReplayError::Transport(format!(
                "an earlier answer handed {} over to {}, another origin: the node doesn't send it there",
                own.origin().ascii_serialization(),
                to.origin().ascii_serialization()
            )));
        }
        return Ok(to);
    }
    let path_part = step.url.split('?').next().unwrap_or_default();
    let mut url = path_part.to_string();
    for (loc, value) in values {
        if let Loc::Path(i) = loc {
            // A value fills its segment and nothing more: `.` and `..` are steps through the address, not a segment's
            // text, and would move the request to another path of the site.
            if matches!(value.trim(), "." | "..") {
                return Err(ReplayError::BadUrl(format!("{} takes a value at path segment {i}, and `{value}` would move the request to another path", step.url)));
            }
            let seg = percent_encoding::utf8_percent_encode(value, SEGMENT).to_string();
            url = url.replace(&format!("{{path[{i}]}}"), &seg);
        }
    }
    let mut url = url::Url::parse(&url).map_err(|e| ReplayError::BadUrl(format!("{}: {e}", step.url)))?;
    let query: Vec<(&str, &str)> = values
        .iter()
        .filter_map(|(loc, v)| if let Loc::Query(k) = loc { Some((k.as_str(), v.as_str())) } else { None })
        .collect();
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Ok(url)
}

/// Puts each value at its pointer in a JSON template. Constants keep their typed leaf in the template (a bool stays
/// a bool); only the blanked slots take a value, of the type the template recorded.
/// The first leaf the walk sent a value at (`types`) that this call could not produce, where the template put it in a
/// list: `Some(pointer)`. An object key left null is a value a site may read as absent; an array's element is never
/// absent, only wrong — a `restaurantIds` list with a hole is a malformed call, not a narrower one.
fn hole_in_a_list(body: &Value, types: &std::collections::BTreeMap<String, String>) -> Option<String> {
    for pointer in types.keys() {
        if !body.pointer(pointer).is_some_and(Value::is_null) {
            continue;
        }
        let parent = pointer.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        if matches!(body.pointer(parent), Some(Value::Array(_))) {
            return Some(pointer.clone());
        }
    }
    None
}

fn fill_json<'a>(body: &mut Value, types: &std::collections::BTreeMap<String, String>, values: impl Iterator<Item = (&'a str, &'a String)>) {    for (pointer, value) in values {
        if let Some(slot) = body.pointer_mut(pointer) {
            if slot.is_null() {
                *slot = match types.get(pointer).map(String::as_str) {
                    Some("number") => serde_json::from_str(value).unwrap_or(Value::String(value.clone())),
                    Some("bool") => Value::Bool(value == "true"),
                    _ => Value::String(value.clone()),
                };
            }
        }
    }
}

/// Whether `loc` is an optional input of `step`: when no value came for it, it isn't sent.
fn unset_optional(step: &Step, loc: &Loc) -> bool {
    step.fields.iter().any(|f| f.loc == *loc && matches!(f.class, Class::Input { optional: true, .. }))
}

/// Whether the request's template already holds `null` at `loc` (a JSON body): a value the walk's call carried but the
/// request does not need, so a call that cannot derive it sends the null the template has.
pub(crate) fn template_is_null(step: &Step, loc: &Loc) -> bool {
    let (Some(Body::Json { template, .. }), Loc::Json(pointer)) = (&step.body, loc) else { return false };
    template.pointer(pointer).is_some_and(|v| v.is_null())
}

fn request_body(n: usize, step: &Step, values: &[(Loc, String)]) -> Result<Option<String>, ReplayError> {
    match &step.body {
        None => Ok(None),
        Some(Body::Other) | Some(Body::Upload { .. }) => Err(ReplayError::UnsupportedBody { step: n, url: step.url.clone() }),
        Some(Body::Form { fields }) => {
            let mut out = url::form_urlencoded::Serializer::new(String::new());
            for (name, constant) in fields {
                let loc = Loc::Form(name.clone());
                let value = || values.iter().find(|(l, _)| *l == loc).map(|(_, v)| v.clone());
                // What the route's field gives is what is sent: a caller's value, a value an earlier answer gave, a
                // trial's. The template's own copy is what the walk sent, and stands only where nothing gives one
                // (an optional input left unset sends the first call's value).
                let given = value().or_else(|| constant.clone());
                if given.is_none() && unset_optional(step, &Loc::Form(name.clone())) {
                    continue;
                }
                out.append_pair(name, &given.unwrap_or_default());
            }
            Ok(Some(out.finish()))
        }
        Some(Body::Json { template, types }) => {
            let mut body = template.clone();
            fill_json(&mut body, types, values.iter().filter_map(|(loc, v)| if let Loc::Json(p) = loc { Some((p.as_str(), v)) } else { None }));
            // A constant keeps its leaf, unless a caller's value rides inside it.
            for (p, v) in values.iter().filter(|(l, _)| step.held.iter().any(|h| h.loc == *l)).filter_map(|(l, v)| if let Loc::Json(p) = l { Some((p, v)) } else { None }) {
                if let Some(slot) = body.pointer_mut(p) {
                    *slot = Value::String(v.clone());
                }
            }
            // A key the caller left unset goes unsent: `null` is a value to a site, and not the one the first call sent.
            for f in step.fields.iter().filter(|f| !values.iter().any(|(l, _)| *l == f.loc)) {
                if let (Loc::Json(pointer), true) = (&f.loc, unset_optional(step, &f.loc)) {
                    crate::paging::remove_pointer(&mut body, pointer);
                }
            }
            // A hole in a list is not the request the walk sent. A value the walk put at an array's index and this call
            // could not produce (its source moved, or the site's state no longer holds it) leaves `null` where a number
            // or a token stood: a site reads that as a malformed call (OpenTable answers 400 to a `restaurantIds` list
            // with a hole), and the refusal says nothing about the client. An object key left null is a value the site
            // may read as absent (`template_is_null`); an array's element is never absent, only wrong.
            // A list that follows a list in an earlier answer ends where that one ended: the elements this call had
            // no source for are its tail, cut, never holes. One left with nothing is still a hole: the earlier answer
            // held no list at all.
            for parent in followed_lists(step) {
                if let Some(Value::Array(items)) = body.pointer_mut(&parent) {
                    while items.len() > 1 && items.last().is_some_and(Value::is_null) {
                        items.pop();
                    }
                }
            }
            if let Some(pointer) = hole_in_a_list(&body, types) {
                return Err(ReplayError::SourceMissing { step: n, url: step.url.clone(), loc: Loc::Json(pointer) });
            }
            Ok(Some(body.to_string()))
        }
        Some(Body::Multipart { boundary, parts }) => {
            let mut out = String::new();
            for part in parts {
                let text = match (&part.text, &part.json) {
                    (Some(text), _) => text.clone(),
                    (None, Some(template)) => {
                        let mut json = template.clone();
                        let mine = values.iter().filter_map(|(loc, v)| match loc {
                            Loc::Part(name, pointer) if name == &part.name && !pointer.is_empty() => Some((pointer.as_str(), v)),
                            _ => None,
                        });
                        fill_json(&mut json, &part.types, mine);
                        json.to_string()
                    }
                    (None, None) => values
                        .iter()
                        .find(|(l, _)| matches!(l, Loc::Part(name, pointer) if name == &part.name && pointer.is_empty()))
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default(),
                };
                // The boundary is the body's framing: a value that holds it would close its part and open others the
                // route never had. A browser picks a boundary its parts don't hold; a value that does is refused.
                if text.contains(&format!("--{boundary}")) {
                    return Err(ReplayError::BreaksBody { step: n, url: step.url.clone(), part: part.name.clone() });
                }
                out.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"", part.name));
                if let Some(f) = &part.filename {
                    out.push_str(&format!("; filename=\"{f}\""));
                }
                out.push_str("\r\n");
                if let Some(t) = &part.content_type {
                    out.push_str(&format!("Content-Type: {t}\r\n"));
                }
                out.push_str(&format!("\r\n{text}\r\n"));
            }
            out.push_str(&format!("--{boundary}--\r\n"));
            Ok(Some(out))
        }
    }
}

#[cfg(test)]
mod wrapped_answer_tests {
    use super::*;

    /// An answer whose only content is an error list, beside an empty `data`, where the recording had none, is a
    /// failed call; the same answer with its data, or with an error beside data it holds, is an answer.
    #[test]
    fn an_error_list_beside_nothing_is_a_failed_call() {
        let expected = serde_json::json!({ "data": { "getReviews": { "edges": "array", "totalCount": "number" } } });
        assert!(answers_like(&expected, &serde_json::json!({ "data": { "getReviews": { "edges": "array", "totalCount": "number" } } })));
        assert!(!answers_like(&expected, &serde_json::json!({ "data": { "getReviews": "null" }, "errors": [{ "errorType": "string" }] })));
        assert!(!answers_like(&expected, &serde_json::json!({ "data": "null", "errors": [{ "message": "string" }] })));
        assert!(answers_like(&expected, &serde_json::json!({ "data": { "getReviews": { "edges": "array" } }, "errors": [{ "message": "string" }] })));
    }
}

#[cfg(test)]
mod tests {
    /// A request the write rule names a read goes as the route builds it whatever its method (`ledger::writes` is the
    /// one reader of that question, and a method is not): a POST the page sent as it loaded, that answered with data
    /// and set no cookie, asks and changes nothing, so the page's code making no call for it is no reason to open a
    /// browser — the site's answer says whether it needed the page's signature (trip.com's flight list answers a
    /// caller's cities without the page's tokens). A POST that may change the site still never goes without them.
    #[test]
    fn a_post_the_write_rule_names_a_read_goes_as_the_route_builds_it() {
        struct Nothing { seen: RefCell<Vec<String>>, told: RefCell<Vec<String>> }
        impl Fetch for Nothing {
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.seen.borrow_mut().push(format!("{} {}", req.method, req.url.path()));
                Ok(Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: req.headers.clone(), request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some(r#"{"tiles":[{"title":"resume"}]}"#.into()), response_mime: "application/json".into(),
                    resource_type: Some("XHR".into()), main_frame: None,
                })
            }

            fn sign_request(&mut self, _req: &Request, _inputs: &HashMap<String, String>) -> Option<crate::sandbox::Signed> {
                None
            }

            fn fell_back(&mut self, why: String) {
                self.told.borrow_mut().push(why);
            }
        }
        // The page sent this POST as it loaded, it answered 200 with data and set no cookie: the write rule names it a
        // read. The page's own code makes nothing for it this run.
        let asking: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/_ajax/tiles",
                "needs_browser": true, "page_signed": true, "on_load": true, "sets_cookie": false,
                "page_producers": [{ "loc": { "in": "header", "key": "x-canva-analytics" }, "producer": { "script": "https://shop.example/app.js", "at": 12 } }],
                "fields": []
            }]
        }))
        .unwrap();
        let mut sent = Nothing { seen: RefCell::new(vec![]), told: RefCell::new(vec![]) };
        let ran = replay(&asking, &HashMap::new(), &mut sent).expect("a request the write rule names a read goes as the route builds it");
        assert_eq!(ran.target.status, 200);
        assert_eq!(&*sent.seen.borrow(), &["POST /_ajax/tiles"], "the POST was sent as the route builds it");
        let told = sent.told.borrow().clone();
        assert_eq!(told.len(), 1, "the call says what it did: {told:?}");
        assert!(told[0].contains("sent as the route builds it"), "{told:?}");
        // The same request, with the answer setting a cookie: a step that may hold something the site changed, so the
        // page's own code is what sends it, as before.
        let mut setting: Graph = asking.clone();
        setting.steps[0].sets_cookie = true;
        let mut write = Nothing { seen: RefCell::new(vec![]), told: RefCell::new(vec![]) };
        assert!(
            matches!(replay(&setting, &HashMap::new(), &mut write), Err(ReplayError::NeedsBrowser { step: 1, .. })),
            "a write is never sent without the values the page's code makes"
        );
        assert!(write.seen.borrow().is_empty(), "nothing was sent: {:?}", write.seen.borrow());
    }

    /// A value at a path segment fills that segment: a `..` or `.` never walks the request to another path of the site,
    /// and a slash or a percent sign in it is the segment's text.
    #[test]
    fn a_value_in_the_path_never_moves_the_request() {
        let step: crate::graph::Step = serde_json::from_value(serde_json::json!({
            "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example.com/api/items/{path[2]}/reviews", "fields": [], "needs_browser": false
        }))
        .unwrap();
        let at = |v: &str| super::request_url(&step, &[(crate::slots::Loc::Path(2), v.to_string())]);
        for v in ["..", ".", " .. "] {
            assert!(matches!(at(v), Err(super::ReplayError::BadUrl(_))), "{v:?}");
        }
        assert_eq!(at("../../admin").unwrap().path(), "/api/items/..%2F..%2Fadmin/reviews");
        assert_eq!(at("%2e%2e").unwrap().path(), "/api/items/%252e%252e/reviews");
        assert_eq!(at("lamp-7").unwrap().path(), "/api/items/lamp-7/reviews");
    }

    use super::*;
    use crate::graph::build;
    use std::cell::RefCell;

    /// A step the page's own code makes, when that code makes nothing for it this run: a read goes as the route builds
    /// it, and the site's answer says whether it needed the page's values; a write still goes to the browser. The call
    /// says which it did (`Fetch::fell_back`), so a cheaper answer is never silent.
    #[test]
    fn a_page_signed_step_the_page_made_nothing_for_goes_as_the_route_builds_it_unless_it_writes() {
        struct Nothing { seen: RefCell<Vec<String>>, told: RefCell<Vec<String>> }
        impl Fetch for Nothing {
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.seen.borrow_mut().push(req.url.path().to_string());
                Ok(Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: req.headers.clone(), request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some(r#"{"items":[{"title":"lamp"}]}"#.into()), response_mime: "application/json".into(),
                    resource_type: Some("XHR".into()), main_frame: None,
                })
            }

            fn sign_request(&mut self, _req: &Request, _inputs: &HashMap<String, String>) -> Option<crate::sandbox::Signed> {
                None
            }

            fn fell_back(&mut self, why: String) {
                self.told.borrow_mut().push(why);
            }
        }
        let signed = |method: &str| -> Graph {
            serde_json::from_value(serde_json::json!({
                "provisional": false,
                "steps": [{
                    "exchange": 0, "method": method, "status": 200, "url": "https://shop.example/api/items?q={q}",
                    "needs_browser": true, "page_signed": true,
                    "page_producers": [{ "loc": { "in": "header", "key": "sentry-trace" }, "producer": { "script": "https://shop.example/app.js", "at": 7 } }],
                    "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }]
                }]
            }))
            .unwrap()
        };
        let inputs = HashMap::from([("q".to_string(), "jug".to_string())]);
        let mut read = Nothing { seen: RefCell::new(vec![]), told: RefCell::new(vec![]) };
        let ran = replay(&signed("GET"), &inputs, &mut read).expect("a read goes as the route builds it");
        assert_eq!(ran.target.status, 200);
        assert_eq!(&*read.seen.borrow(), &["/api/items"], "the read was sent");
        let told = read.told.borrow().clone();
        assert_eq!(told.len(), 1, "the call says what it did: {told:?}");
        assert!(told[0].contains("sent as the route builds it"), "{told:?}");
        let mut write = Nothing { seen: RefCell::new(vec![]), told: RefCell::new(vec![]) };
        assert!(
            matches!(replay(&signed("POST"), &inputs, &mut write), Err(ReplayError::NeedsBrowser { step: 1, .. })),
            "a write is never sent without the values the page's code makes"
        );
        assert!(write.seen.borrow().is_empty(), "nothing was sent: {:?}", write.seen.borrow());
        // A read whose own value the page computes is one the route builds without it: sending that asks the site
        // another value, so nothing is sent and the browser serves it, as before.
        let without_the_value: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/items?q={q}",
                "needs_browser": true, "page_signed": true,
                "page_producers": [{ "loc": { "in": "header", "key": "sentry-trace" }, "producer": { "script": "https://shop.example/app.js", "at": 7 } }],
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "computed" }]
            }]
        }))
        .unwrap();
        let mut lost = Nothing { seen: RefCell::new(vec![]), told: RefCell::new(vec![]) };
        assert!(
            matches!(replay(&without_the_value, &inputs, &mut lost), Err(ReplayError::NeedsBrowser { step: 1, .. })),
            "a request that lost the caller's value is never sent"
        );
        assert!(lost.seen.borrow().is_empty(), "nothing was sent: {:?}", lost.seen.borrow());
    }

    /// A refusal from a wall the route knows is said as a door, with the class and what earns a credential: not the
    /// site drifting, and not a value the page never had.
    #[test]
    fn a_known_door_is_said_as_a_door() {
        let page = |status: u16| Exchange {
            method: "GET".into(),
            url: "https://shop.example/search?q=lamp".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let mut g = build(&[crate::trace::Trace { exchanges: vec![page(200)], inputs: vec![] }], |_| true).unwrap();
        g.door = Some(crate::graph::Door {
            kind: crate::graph::DoorKind::Akamai,
            statuses: crate::trace::REFUSED.to_vec(),
            credential: Some("_abck".into()),
            ttl: Some(3600),
            earn: crate::graph::Earn::BrowserOrOwner,
            at: None,
        });
        struct Gated;
        impl Fetch for Gated {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 403,
                    response_headers: vec![],
                    response_body: Some("<html>no</html>".into()),
                    response_mime: "text/html".into(),
                    resource_type: None,
                    main_frame: None,
                })
            }
        }
        let r = replay(&g, &HashMap::new(), &mut Gated);
        assert!(matches!(r, Err(ReplayError::Door { status: 403, .. })), "{:?}", r.as_ref().err());
        // A refusal the route doesn't know is still a plain failure: nothing is called a wall that showed no sign of one.
        g.door = None;
        let r = replay(&g, &HashMap::new(), &mut Gated);
        assert!(matches!(r, Err(ReplayError::Failed { status: 403, .. })), "{:?}", r.as_ref().err());
    }

    /// A gateway that signs with a token it issues itself: a caller with no token signs over nothing, as the page's own
    /// code does on its first call; the gateway refuses that and hands the token over in a cookie; the call is signed
    /// again with it and sent once more, and answers. No session of anyone's, no browser. A write is never sent twice,
    /// and a gateway that hands nothing over leaves its refusal as the answer.
    #[test]
    fn a_gateway_that_issues_its_own_token_is_signed_again_with_it() {
        use md5::{Digest, Md5};
        let md5 = |t: &str| Md5::digest(t.as_bytes()).iter().map(|b| format!("{b:02x}")).collect::<String>();
        let (t, key, data) = ("1794402610160", "24677475", r#"{"q":"lamps"}"#);
        let walked = |method: &str| Exchange {
            method: method.into(),
            url: url::Url::parse_with_params("https://api.shop.example/h5/find/1.0/", &[("appKey", key), ("t", t), ("data", data), ("sign", "0123456789abcdef0123456789abcdef")]).unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"ret":["SUCCESS"],"data":{"items":[{"title":"green lamp"}]}}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let signed = |method: &str| {
            let mut g = build(&[crate::trace::Trace { exchanges: vec![walked(method)], inputs: vec![] }], |_| true).unwrap();
            for f in g.steps.iter_mut().flat_map(|s| s.fields.iter_mut()).filter(|f| f.loc == Loc::Query("sign".into())) {
                f.class = Class::Recipe {
                    recipe: crate::signing::Recipe {
                        algo: crate::signing::Algo::Md5,
                        separator: "&".into(),
                        parts: vec![
                            crate::signing::Part::CookiePiece { name: "_tk".into(), separator: "_".into(), index: 0 },
                            crate::signing::Part::Query { key: "t".into() },
                            crate::signing::Part::Query { key: "appKey".into() },
                            crate::signing::Part::Query { key: "data".into() },
                        ],
                    },
                };
            }
            g
        };
        struct Gateway {
            hands_over: bool,
            calls: usize,
        }
        impl Fetch for Gateway {
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                use md5::{Digest, Md5};
                self.calls += 1;
                let q: HashMap<String, String> = req.url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
                let token = sent_cookies(req).into_iter().find(|(k, _)| k == "_tk").map(|(_, v)| v.split('_').next().unwrap_or_default().to_string()).unwrap_or_default();
                let want: String = Md5::digest(format!("{token}&{}&{}&{}", q["t"], q["appKey"], q["data"]).as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                let (headers, body) = if token.is_empty() {
                    let issued = if self.hands_over { vec![("set-cookie".to_string(), "_tk=9e107d9d372bb6826bd81d3542a419d6_1794402700000; Path=/".to_string()), ("set-cookie".to_string(), "_tk_enc=c0ffee; Path=/".to_string())] } else { vec![] };
                    (issued, r#"{"ret":["FAIL_SYS_TOKEN_EMPTY"],"data":{}}"#)
                } else if !sent_cookies(req).iter().any(|(k, v)| k == "_tk_enc" && v == "c0ffee") {
                    (vec![], r#"{"ret":["FAIL_SYS_TOKEN_ILLEGAL"],"data":{}}"#)
                } else if q["sign"] == want {
                    (vec![], r#"{"ret":["SUCCESS"],"data":{"items":[{"title":"green lamp"}]}}"#)
                } else {
                    (vec![], r#"{"ret":["FAIL_SYS_ILLEGAL_ACCESS"],"data":{}}"#)
                };
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: headers, response_body: Some(body.into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
        }
        let mut gateway = Gateway { hands_over: true, calls: 0 };
        let r = replay(&signed("GET"), &HashMap::new(), &mut gateway).expect("signed again with the issued token, the call answers");
        assert!(r.target.response_body.as_deref().is_some_and(|b| b.contains("SUCCESS")), "{:?}", r.target.response_body);
        assert_eq!(gateway.calls, 2, "the tokenless call, then the one signed with the token");
        assert_eq!(md5("9e107d9d372bb6826bd81d3542a419d6&1794402610160&24677475&{\"q\":\"lamps\"}"), r.target.url.query_pairs().find(|(k, _)| k == "sign").unwrap().1);
        let mut write = Gateway { hands_over: true, calls: 0 };
        let _ = replay(&signed("POST"), &HashMap::new(), &mut write);
        assert_eq!(write.calls, 1, "a write is never sent twice");
        let mut silent = Gateway { hands_over: false, calls: 0 };
        let r = replay(&signed("GET"), &HashMap::new(), &mut silent);
        assert_eq!(silent.calls, 1, "nothing handed over, nothing sent again");
        assert!(r.as_ref().map_or(true, |r| r.target.response_body.as_deref().is_some_and(|b| b.contains("TOKEN_EMPTY"))), "{:?}", r.map(|r| r.target.response_body));
    }

    /// A sign-in service hands its one-time flow id over in the address its redirect sends the browser to (Fandom's
    /// Ory Kratos: `GET /self-service/login/browser` answers 303 to `/signin?flow=…`), and the page and the login send
    /// that id back. Learned from the walk, the id is read from the redirect's `location`; replayed, that step is sent
    /// without following its redirect, so a fresh flow's id is what the later steps send, never the walked one.
    #[test]
    fn a_flow_id_a_redirect_hands_over_is_read_from_its_location() {
        let ex = |method: &str, url: &str, status: u16, headers: Vec<(String, String)>, body: &str, kind: &str| Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: if method == "POST" { vec![("content-type".into(), "application/x-www-form-urlencoded".into())] } else { vec![] },
            request_body: (method == "POST").then(|| "csrf=t0k3n-77aa91&identifier=me".to_string()),
            status,
            response_headers: headers,
            response_body: Some(body.into()),
            response_mime: if kind == "Document" { "text/html".into() } else { "application/json".into() },
            resource_type: Some(kind.into()),
            main_frame: Some(true),
        };
        let walked = "4b553b2d-d6ae-46ea-948b-3f8a46b12c44";
        let trace = crate::trace::Trace {
            exchanges: vec![
                ex("GET", "https://id.shop.example/login/browser", 303, vec![("location".into(), format!("https://auth.shop.example/signin?flow={walked}"))], "", "Document"),
                ex("GET", &format!("https://auth.shop.example/signin?flow={walked}"), 200, vec![], r#"<input name="csrf" value="t0k3n-77aa91">"#, "Document"),
                ex("POST", &format!("https://id.shop.example/login?flow={walked}"), 200, vec![], r#"{"session":{"active":true}}"#, "XHR"),
            ],
            inputs: vec![crate::trace::Input::new("identifier", "me")],
        };
        let graph = build(&[trace], |e| e.method == "POST").unwrap();
        let flow_of = |n: usize| graph.steps[n].fields.iter().find(|f| f.loc == Loc::Query("flow".into())).map(|f| f.class.clone());
        assert!(
            matches!(flow_of(graph.steps.len() - 1), Some(crate::graph::Class::Derived { origin }) if matches!(&origin.at, crate::provenance::At::HeaderQuery { name, key } if name == "location" && key == "flow")),
            "{:?}",
            graph.steps.iter().map(|s| (s.url.clone(), s.fields.iter().filter(|f| f.loc == Loc::Query("flow".into())).map(|f| f.class.clone()).collect::<Vec<_>>())).collect::<Vec<_>>()
        );
        struct Kratos {
            sent: Vec<String>,
        }
        impl Fetch for Kratos {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                // A runner that follows redirects: the first step's answer would be the page it leads to.
                let at = self.fetch_unredirected(req)?;
                match at.response_header("location") {
                    Some(to) => self.fetch_unredirected(&Request { url: to.parse().unwrap(), method: "GET".into(), body: None, ..req.clone() }),
                    None => Ok(at),
                }
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.sent.push(req.url.to_string());
                let fresh = "9c0ffee0-0000-4000-8000-000000000001";
                let answer = |status: u16, headers: Vec<(String, String)>, body: &str, mime: &str| Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status,
                    response_headers: headers, response_body: Some(body.into()), response_mime: mime.into(), resource_type: None, main_frame: None,
                };
                Ok(match req.url.path() {
                    "/login/browser" => answer(303, vec![("location".into(), format!("https://auth.shop.example/signin?flow={fresh}"))], "", "text/html"),
                    "/signin" => answer(200, vec![], r#"<input name="csrf" value="n3w-t0k3n-88"> "#, "text/html"),
                    _ => answer(200, vec![], r#"{"session":{"active":true}}"#, "application/json"),
                })
            }
        }
        let mut site = Kratos { sent: Vec::new() };
        let r = replay(&graph, &HashMap::from([("identifier".to_string(), "me".to_string())]), &mut site);
        assert!(r.is_ok(), "{:?} sent {:?}", r.err(), site.sent);
        assert!(site.sent.iter().any(|u| u == "https://id.shop.example/login?flow=9c0ffee0-0000-4000-8000-000000000001"), "the fresh flow is sent: {:?}", site.sent);
        assert!(!site.sent.iter().any(|u| u.contains(walked)), "never the walked one: {:?}", site.sent);
    }

    /// A server-rendered page as the target: its answer is the state embedded in its HTML, read the same way the
    /// recording was, so a fresh page with fresh data passes and a block page still doesn't.
    #[test]
    fn a_page_answers_with_the_data_embedded_in_it() {
        let page = |state: &str| format!(r#"<html><body><script id="__NEXT_DATA__" type="application/json">{state}</script></body></html>"#);
        let ex = |body: String| Exchange {
            method: "GET".into(),
            url: "https://shop.example/search?q=lamp".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(body),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let trace = crate::trace::Trace {
            exchanges: vec![ex(page(r#"{"props":{"results":[{"title":"green lamp"}],"total":1}}"#))],
            inputs: vec![crate::trace::Input::new("q", "lamp")],
        };
        let graph = build(&[trace], |_| true).unwrap();
        struct Page(String);
        impl Fetch for Page {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Ok(Exchange { url: req.url.clone(), response_body: Some(self.0.clone()), ..Exchange {
                    method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![], response_body: None, response_mime: "text/html".into(), resource_type: None, main_frame: None,
                } })
            }
        }
        let fresh = page(r#"{"props":{"results":[{"title":"blue chair"},{"title":"red chair"}],"total":2}}"#);
        let inputs = HashMap::from([("q".to_string(), "chair".to_string())]);
        assert!(replay(&graph, &inputs, &mut Page(fresh)).is_ok(), "a fresh page of the same kind is an answer");
        let blocked = "<html><title>Just a moment...</title></html>".to_string();
        let r = replay(&graph, &inputs, &mut Page(blocked));
        assert!(matches!(r, Err(ReplayError::ShapeMismatch { .. })), "{:?} {:?}", r.as_ref().err(), graph.steps.last().unwrap().response_shape);
    }

    /// A form that can carry a file sends multipart: what was typed into its text parts, and into JSON held in a
    /// part, are the route's inputs, and the replay puts new values back on the same boundary.
    #[test]
    fn a_multipart_form_takes_new_values() {
        let b = "----Form7";
        let body = format!(
            "--{b}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nGreen lamp, barely used\r\n--{b}\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\n{{\"text\":\"Works fine, pick up only\",\"lang\":\"en\"}}\r\n--{b}\r\nContent-Disposition: form-data; name=\"fixed\"\r\n\r\nfalse\r\n--{b}--\r\n"
        );
        let post = Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/listings".parse().unwrap(),
            request_headers: vec![("content-type".into(), format!("multipart/form-data; boundary={b}"))],
            request_body: Some(body),
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"id":"L1"}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = crate::trace::Trace {
            exchanges: vec![post],
            inputs: vec![crate::trace::Input::new("Title", "Green lamp, barely used"), crate::trace::Input::new("Description", "Works fine, pick up only")],
        };
        let graph = build(&[trace], |e| e.method == "POST").unwrap();
        let step = graph.steps.last().unwrap();
        let named: Vec<String> = step.fields.iter().filter_map(|f| if let crate::graph::Class::Input { name, .. } = &f.class { Some(name.clone()) } else { None }).collect();
        assert_eq!(named, ["Title", "Description"]);
        let values = vec![
            (Loc::Part("title".into(), String::new()), "Blue chair".to_string()),
            (Loc::Part("note".into(), "/text".into()), "Collect today".to_string()),
        ];
        let sent = request_body(0, step, &values).unwrap().unwrap();
        assert!(sent.starts_with(&format!("--{b}\r\n")) && sent.ends_with(&format!("--{b}--\r\n")));
        assert!(sent.contains("name=\"title\"\r\n\r\nBlue chair\r\n"), "{sent}");
        assert!(sent.contains(r#"{"lang":"en","text":"Collect today"}"#) || sent.contains(r#"{"text":"Collect today","lang":"en"}"#), "{sent}");
        assert!(sent.contains("name=\"fixed\"\r\n\r\nfalse\r\n") && !sent.contains("Green lamp"));

        // A value is a part's content, never its framing: one that holds the boundary would end the part and open
        // others (a second `fixed`), and is refused. Line breaks of its own are content, kept as typed.
        let forged = format!("x\r\n--{b}\r\nContent-Disposition: form-data; name=\"fixed\"\r\n\r\ntrue");
        let values = vec![(Loc::Part("title".into(), String::new()), forged)];
        assert!(matches!(request_body(0, step, &values), Err(ReplayError::BreaksBody { .. })));
        let values = vec![(Loc::Part("title".into(), String::new()), "Blue chair\r\nsecond line".to_string())];
        let sent = request_body(0, step, &values).unwrap().unwrap();
        assert_eq!(sent.matches("name=\"fixed\"").count(), 1);
        assert!(sent.contains("Blue chair\r\nsecond line\r\n"));
    }

    /// A search whose results come in another card shape is still the API's answer; a block page is not.
    #[test]
    fn a_different_card_shape_is_still_an_answer() {
        let recorded = serde_json::json!({ "data": { "results": [{ "listingCard": { "price": "string" } }], "total": "string" } });
        assert!(answers_like(&recorded, &serde_json::json!({ "data": { "productResults": [{ "product": "string" }] } })));
        assert!(!answers_like(&recorded, &serde_json::json!({ "error": "string" })));
        assert!(!answers_like(&recorded, &serde_json::json!("string")));
    }

    #[test]
    fn no_results_is_an_answer() {
        let recorded = serde_json::json!({ "crates": [{ "name": "string" }], "meta": { "total": "number" } });
        assert!(shape_matches(&recorded, &serde_json::json!({ "crates": [], "meta": { "total": "number" } })));
        assert!(!shape_matches(&recorded, &serde_json::json!({ "crates": [{ "name": "number" }] })));
    }

    fn traces() -> Vec<crate::trace::Trace> {
        let page = Exchange {
            method: "GET".into(),
            url: "https://shop.example/app".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: None,
        };
        let api = |pxhd: &str| Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("cookie".into(), format!("_pxhd={pxhd}"))],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        vec![
            crate::trace::Trace { exchanges: vec![page.clone(), api("px_aaa_111111")], inputs: vec![] },
            crate::trace::Trace { exchanges: vec![page, api("px_bbb_222222")], inputs: vec![] },
        ]
    }

    /// Answers from canned responses and hands out a browser-minted session cookie,
    /// remembering the requests it ran so the test can see what the replay sent.
    struct Stub {
        seen: RefCell<Vec<Request>>,
    }

    impl Fetch for Stub {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.seen.borrow_mut().push(req.clone());
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some(r#"{"items":[]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }

        fn minted(&self, name: &str) -> Option<String> {
            (name == "_pxhd").then(|| "px_ccc_333333".into())
        }
    }

    #[test]
    fn replay_takes_minted_cookies_from_the_runner() {
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        // A minted cookie needs no earlier step: the page that issued it isn't part of
        // the route, so the graph is the target alone.
        assert_eq!(g.steps.len(), 1);
        let mut stub = Stub { seen: RefCell::new(vec![]) };
        let run = replay(&g, &HashMap::new(), &mut stub).unwrap();
        assert_eq!(run.steps.len(), 1);
        let api = stub.seen.borrow().last().unwrap().clone();
        let cookie = api.headers.iter().find(|(k, _)| k == "cookie").unwrap();
        assert_eq!(cookie.1, "_pxhd=px_ccc_333333");
    }

    /// Audit 1118 M7 (16 Nov H5): replay itself refuses a step of a route this node didn't learn that puts a session
    /// value in a form, query, JSON or path field, or a cookie the site set (one of a `Set-Cookie` line, or the line
    /// read whole) outside the cookie header, with nothing of that step sent and no value in what it says. The same
    /// step as the node's own sends it as its walk saw, and a stranger's session cookie in the cookie header goes.
    #[test]
    fn a_strangers_step_never_puts_the_session_in_a_field() {
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let with = |loc: Loc, class: Class, foreign: bool| {
            let mut g = g.clone();
            let s = g.steps.last_mut().unwrap();
            s.foreign = foreign;
            s.fields = vec![crate::graph::Field { loc, class }];
            g
        };
        let minted = || Class::Minted { name: "_pxhd".into() };
        let origin = |at: crate::provenance::At| Class::Derived { origin: crate::provenance::Origin { exchange: 0, url: "https://shop.example/".into(), at, wrap: None } };
        let set = origin(crate::provenance::At::SetCookie { name: "_pxhd".into() });
        // The whole `Set-Cookie` line, read as a header, is the same cookie with its value in it.
        let line = |name: &str| origin(crate::provenance::At::Header { name: name.into() });
        for (loc, class) in [
            (Loc::Query("q".into()), minted()),
            (Loc::Form("q".into()), minted()),
            (Loc::Json("/q".into()), minted()),
            (Loc::Path(0), minted()),
            (Loc::Query("q".into()), set.clone()),
            (Loc::Header("x-echo".into()), set.clone()),
            (Loc::Query("q".into()), line("set-cookie")),
            (Loc::Json("/note".into()), line("Set-Cookie")),
            (Loc::Header("x-echo".into()), line("SET-COOKIE2")),
        ] {
            let mut stub = Stub { seen: RefCell::new(vec![]) };
            let refused = replay(&with(loc.clone(), class.clone(), true), &HashMap::new(), &mut stub);
            assert!(matches!(&refused, Err(ReplayError::Refused(why)) if why.contains("cookie header") && !why.contains("px_ccc")), "{loc}: {:?}", refused.err());
            assert!(stub.seen.borrow().is_empty(), "{loc}: nothing was sent");
            assert!(misplaced_session(1, &with(loc.clone(), class, false).steps[0]).is_none(), "{loc}: the node's own step is never asked");
        }
        let mut stub = Stub { seen: RefCell::new(vec![]) };
        replay(&with(Loc::Query("q".into()), minted(), false), &HashMap::new(), &mut stub).unwrap();
        assert!(stub.seen.borrow()[0].url.query().unwrap_or_default().contains("px_ccc_333333"), "the node's own route sends what its walk saw");
        let mut stub = Stub { seen: RefCell::new(vec![]) };
        replay(&with(Loc::Cookie("_pxhd".into()), minted(), true), &HashMap::new(), &mut stub).unwrap();
        assert!(stub.seen.borrow()[0].headers.iter().any(|(k, v)| k == "cookie" && v.contains("px_ccc_333333")), "the cookie header carries it");
    }

    /// Audit 1118 H2 (16 Nov H6), the runner's half. A stranger's step that wraps a value an earlier answer gave in
    /// text of its own, in a header, must not send that text: `Bearer <their token> ` before the site's value makes the
    /// whole `authorization` value theirs. The node refuses such a step before anything is sent, or sends the site's
    /// value alone; either way no header carries the body's own text. An authentication scheme alone before the value,
    /// or none, is sent as it is.
    #[test]
    fn a_strangers_credential_carries_no_text_of_its_own() {
        /// A site that hands out a token and answers every other call with an empty list, remembering what it was sent.
        struct Site {
            seen: RefCell<Vec<Request>>,
        }
        impl Fetch for Site {
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.seen.borrow_mut().push(req.clone());
                let body = if req.url.path() == "/api/token" { r#"{"token":"site_tok_7f3a9c"}"# } else { r#"{"items":[]}"# };
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 200,
                    response_headers: vec![],
                    response_body: Some(body.into()),
                    response_mime: "application/json".into(),
                    resource_type: None,
                    main_frame: None,
                })
            }
        }
        let graph = |loc: &str, wrap: Option<(&str, &str)>| -> Graph {
            let mut origin = serde_json::json!({ "exchange": 0, "url": "https://shop.example/api/token", "at": { "from": "json", "pointer": "/token" } });
            if let Some((before, after)) = wrap {
                origin["wrap"] = serde_json::json!([before, after]);
            }
            serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/token", "fields": [], "needs_browser": false },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/list", "needs_browser": false, "foreign": true, "fields": [
                    { "loc": { "in": "header", "key": loc }, "class": "derived", "origin": origin },
                ] },
            ] }))
            .unwrap()
        };
        let sent_in = |graph: &Graph, loc: &str| -> Vec<String> {
            let mut site = Site { seen: RefCell::new(vec![]) };
            let _ = replay(graph, &HashMap::new(), &mut site);
            let seen = site.seen.borrow();
            seen.iter().flat_map(|r| r.headers.iter()).filter(|(k, _)| k.eq_ignore_ascii_case(loc)).map(|(_, v)| v.clone()).collect()
        };
        assert_eq!(sent_in(&graph("authorization", None), "authorization"), ["site_tok_7f3a9c"], "control: the site's value as it gave it");
        assert_eq!(sent_in(&graph("authorization", Some(("Bearer ", ""))), "authorization"), ["Bearer site_tok_7f3a9c"], "control: after a scheme");
        for (loc, wrap) in [
            ("authorization", ("Bearer attacker_tok_9911 ", "")),
            ("authorization", ("Bearer ", " attacker_tok_9911")),
            ("x-api-key", ("ak_attacker_", "")),
        ] {
            let sent = sent_in(&graph(loc, Some(wrap)), loc);
            assert!(sent.iter().all(|v| !v.contains("attacker")), "{loc} {wrap:?}: the step sent text of the route's own: {sent:?}");
        }
    }
}

#[cfg(test)]
mod signing_tests {
    use super::*;
    use std::cell::RefCell;

    /// A route whose target has a header the page's own code makes: the walk recorded its producer, and the field
    /// is a [`Class::Script`].
    fn signed() -> Graph {
        serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200,
                "url": "https://shop.example/api/search", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "header", "key": "x-sig" }, "class": "script",
                      "producer": { "script": "https://cdn.shop.example/app.js", "at": 42 } },
                    { "loc": { "in": "header", "key": "content-type" }, "class": "constant", "value": "application/json" }
                ]
            }],
            "provisional": false
        }))
        .unwrap()
    }

    /// A transport with a signing bridge: it answers the producer's header for the request it is given, and remembers
    /// what it signed and what it sent.
    struct Signs {
        seen: RefCell<Vec<Request>>,
        signed: RefCell<Vec<Request>>,
    }

    impl Fetch for Signs {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.seen.borrow_mut().push(req.clone());
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some(r#"{"items":[]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }

        fn sign_request(&mut self, req: &Request, _inputs: &std::collections::HashMap<String, String>) -> Option<crate::sandbox::Signed> {
            self.signed.borrow_mut().push(req.clone());
            Some(crate::sandbox::Signed {
                method: req.method.to_uppercase(),
                url: req.url.to_string(),
                headers: vec![
                    ("x-sig".into(), format!("sig-of-{}", req.method)),
                    // The page's own content-type: it replaces the route's, never rides beside it.
                    ("content-type".into(), "text/event-stream".into()),
                ],
                body: None,
                modules: Vec::new(),
                values: Vec::new(),
                by: Rung::Bundle,
            })
        }
    }

    /// A route of two plain steps: a list, then an item.
    fn plain() -> Graph {
        serde_json::from_value(serde_json::json!({
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/list", "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/item", "needs_browser": false, "fields": [] }
            ],
            "provisional": false
        }))
        .unwrap()
    }

    /// Every step says which rung made it (`learn.rung`), in step order. One whose values are all the walk's own
    /// (constants, the caller's, an earlier answer's) is the first rung: nothing of the page's ran.
    #[test]
    fn a_step_made_from_the_walks_own_values_reports_rung_zero() {
        let mut bridge = Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) };
        let run = replay(&plain(), &HashMap::new(), &mut bridge).unwrap();
        assert_eq!(run.rungs, vec![Rung::Walk, Rung::Walk]);
        assert_eq!(run.rungs.len(), run.steps.len(), "one rung per step made");
        assert!(bridge.signed.borrow().is_empty(), "nothing asked the page's code for a value");
    }

    /// A step whose value the page's whole script made, booted without a browser, reports that rung: the bridge says
    /// which maker it was, and the step carries it.
    #[test]
    fn a_step_the_bundle_signed_reports_rung_three() {
        let mut bridge = Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) };
        let run = replay(&signed(), &HashMap::new(), &mut bridge).unwrap();
        assert_eq!(run.rungs, vec![Rung::Bundle]);
        assert!(!run.rungs[0].needs_browser());
    }

    /// A step whose value is a recipe the walk proved (a standard digest over parts of the request) is the second
    /// rung: the node computes it itself, and nothing of the page's runs.
    #[test]
    fn a_step_signed_by_a_recipe_reports_rung_one() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200,
                "url": "https://shop.example/api/search", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "header", "key": "x-sig" }, "class": "recipe",
                      "recipe": { "algo": "md5", "separator": "", "parts": [{ "part": "method" }, { "part": "path" }] } }
                ]
            }],
            "provisional": false
        }))
        .unwrap();
        let mut bridge = Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) };
        let run = replay(&graph, &HashMap::new(), &mut bridge).unwrap();
        assert_eq!(run.rungs, vec![Rung::Expression]);
        assert!(bridge.signed.borrow().is_empty(), "the page's code was not asked");
        let sent = bridge.seen.borrow();
        let sig = sent[0].headers.iter().find(|(k, _)| k == "x-sig").map(|(_, v)| v.as_str()).unwrap_or_default();
        assert!(sig.len() == 32 && sig.chars().all(|c| c.is_ascii_hexdigit()), "an md5 written as hex: {sig}");
    }

    /// A step the transport's browser had to make, refused plainly, is the browser's however its values were made.
    #[test]
    fn a_step_the_browser_made_reports_rung_five() {
        struct Walled(Signs);
        impl Fetch for Walled {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.0.fetch(req)
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
            fn browser_made(&self, exchange: usize) -> bool {
                exchange == 1
            }
        }
        let mut walled = Walled(Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) });
        let run = replay(&plain(), &HashMap::new(), &mut walled).unwrap();
        assert_eq!(run.rungs, vec![Rung::Walk, Rung::Browser], "only the walled step is the browser's");
        assert!(run.rungs[1].needs_browser());
    }

    /// A call the page doesn't make, and whose answer nothing after it reads, is the page's own: the route goes on
    /// without it instead of failing at it.
    #[test]
    fn an_unsignable_leaf_the_route_does_not_need_is_skipped() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [
                { "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/beacon", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-sig" }, "class": "script",
                               "producer": { "script": "https://cdn.shop.example/app.js", "at": 3 } }] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/search", "needs_browser": false, "fields": [] }
            ],
            "provisional": false
        }))
        .unwrap();
        struct Sends(RefCell<Vec<Request>>);
        impl Fetch for Sends {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.0.borrow_mut().push(req.clone());
                Ok(Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![], response_body: Some(r#"{"items":[]}"#.into()), response_mime: "application/json".into(),
                    resource_type: None, main_frame: None,
                })
            }
        }
        let mut stub = Sends(RefCell::new(vec![]));
        replay(&graph, &HashMap::new(), &mut stub).expect("the route answers without the call the page never made");
        let seen = stub.0.borrow();
        assert_eq!(seen.len(), 1, "only the step the route needs was sent: {:?}", seen.iter().map(|r| r.url.path()).collect::<Vec<_>>());
        assert_eq!(seen[0].url.path(), "/api/search");
    }

    /// A bridged step takes the page's own request whole, so a value the page didn't hand over is not this request's:
    /// the call is made with what the page sent, not refused for a value the bridge replaces.
    #[test]
    fn a_bridged_step_does_not_need_the_pages_derived_value() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/search", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "header", "key": "x-sig" }, "class": "script",
                      "producer": { "script": "https://cdn.shop.example/app.js", "at": 3 } },
                    { "loc": { "in": "json", "key": "/ab" }, "class": "derived",
                      "origin": { "exchange": 0, "url": "https://shop.example/search", "at": { "from": "text", "before": "ab:", "after": ";", "nth": 0 } } }
                ]
            }],
            "provisional": false,
            "page": "https://shop.example/search"
        }))
        .unwrap();
        let mut bridge = Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) };
        // The run's own answers are empty: the value the page's text held is not there.
        replay(&graph, &HashMap::new(), &mut bridge).expect("the page's own request answers the step");
        assert_eq!(bridge.signed.borrow().len(), 1);
        assert_eq!(bridge.seen.borrow().len(), 1, "signed, then sent: not walled");
    }

    /// A transport that answers everything with an empty JSON object and remembers what it was sent.
    struct Sent0(RefCell<Vec<Request>>);
    impl Fetch for Sent0 {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.0.borrow_mut().push(req.clone());
            Ok(Exchange {
                method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                response_headers: vec![], response_body: Some("{}".into()), response_mime: "application/json".into(),
                resource_type: None, main_frame: None,
            })
        }
    }

    /// A value the page left out where the request's template already says `null` is not this call's: the site
    /// answered a query it didn't render state for, and the call goes out as the template has it.
    #[test]
    fn a_value_the_template_holds_as_null_is_not_needed() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/search", "needs_browser": false,
                "body": { "kind": "json", "template": { "q": null, "filter": { "value": null } }, "types": { "/q": "string", "/filter/value": "string" } },
                "fields": [
                    { "loc": { "in": "json", "key": "/q" }, "class": "input", "name": "q", "secret": false, "default": "kettle" },
                    { "loc": { "in": "json", "key": "/filter/value" }, "class": "derived",
                      "origin": { "exchange": 0, "url": "https://shop.example/search", "at": { "from": "json", "pointer": "/Search/filter" } } }
                ]
            }],
            "provisional": false
        }))
        .unwrap();
        let mut stub = Sent0(RefCell::new(vec![]));
        replay(&graph, &HashMap::new(), &mut stub).expect("the call goes out as the template has it");
        let seen = stub.0.borrow();
        let body = seen[0].body.as_deref().map(String::from_utf8_lossy).unwrap_or_default().to_string();
        assert!(body.contains(r#""filter":{"value":null}"#), "{body}");
        assert!(body.contains(r#""q":"kettle""#), "{body}");
    }

    /// The same value where the template holds a real value is not optional: a call that cannot derive it would send
    /// something else, so the step fails instead of making a request the site never answered.
    #[test]
    fn a_value_the_template_needs_is_not_papered_over() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api/search", "needs_browser": false,
                "body": { "kind": "json", "template": { "filter": { "value": "on" } }, "types": { "/filter/value": "string" } },
                "fields": [
                    { "loc": { "in": "json", "key": "/filter/value" }, "class": "derived",
                      "origin": { "exchange": 0, "url": "https://shop.example/search", "at": { "from": "json", "pointer": "/Search/filter" } } }
                ]
            }],
            "provisional": false
        }))
        .unwrap();
        let mut stub = Sent0(RefCell::new(vec![]));
        let err = replay(&graph, &HashMap::new(), &mut stub).unwrap_err();
        assert!(matches!(err, ReplayError::SourceMissing { .. }), "{err:?}");
    }

    /// The producer is run once the request stands (URL, method, body, the fields already known), and what it answers
    /// is sent: the page's own code signed a plain HTTP call, with no browser step.
    #[test]
    fn a_script_signed_step_is_signed_once_the_request_stands() {
        let mut bridge = Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) };
        replay(&signed(), &HashMap::new(), &mut bridge).unwrap();
        let signed = bridge.signed.borrow();
        assert_eq!(signed.len(), 1, "the bridge is asked once");
        assert_eq!(signed[0].method, "POST");
        assert_eq!(signed[0].url.path(), "/api/search");
        let sent = bridge.seen.borrow();
        assert_eq!(sent.len(), 1, "the call was sent plain, not walled");
        let sig = sent[0].headers.iter().find(|(k, _)| k == "x-sig").map(|(_, v)| v.as_str());
        assert_eq!(sig, Some("sig-of-POST"));
        // A header the page set is one header, its value: the route's own is replaced, not left in front of it.
        let types: Vec<&str> = sent[0].headers.iter().filter(|(k, _)| k == "content-type").map(|(_, v)| v.as_str()).collect();
        assert_eq!(types, vec!["text/event-stream"], "{:?}", sent[0].headers);
    }

    /// A step nothing after it reads that comes back as the site's check for a person (a challenge page, served 2xx) is
    /// the page's own: the route goes on without it, as a browser that never loaded that page would, and a later step
    /// that holds what the walk read for a value (`Step::fallback`) still sends that value. Measured on a site whose
    /// page is challenged plain and whose own search call answers: the page was the whole refusal.
    #[test]
    fn a_challenged_step_nothing_reads_is_skipped_and_the_call_goes_on() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/templates?query=lamp", "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://shop.example/_ajax/masonry", "needs_browser": false,
                  "fallbacks": [[{ "in": "header", "key": "x-app" }, "seo_landing_page"]],
                  "fields": [{ "loc": { "in": "header", "key": "x-app" }, "class": "derived",
                               "origin": { "exchange": 0, "url": "https://shop.example/templates", "at": { "from": "text", "before": "<meta name=\"app-name\" content=\"", "after": "\"", "nth": 0 } } }] }
            ]
        }))
        .unwrap();
        struct Challenged { seen: RefCell<Vec<(String, String)>> }
        impl Fetch for Challenged {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                let app = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("x-app")).map(|(_, v)| v.clone()).unwrap_or_default();
                self.seen.borrow_mut().push((req.url.path().to_string(), app));
                let (mime, body) = if req.url.path() == "/templates" {
                    ("text/html", "<html><head><title>Client Challenge</title><script src=\"/_fs-ch/errors.js\"></script></head><body></body></html>")
                } else {
                    ("application/json", r#"{"results":[{"title":"Lamp resume"}]}"#)
                };
                Ok(Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), mime.into())],
                    response_body: Some(body.into()), response_mime: mime.into(), resource_type: None, main_frame: None,
                })
            }
        }
        let mut fetch = Challenged { seen: RefCell::new(vec![]) };
        let run = replay(&graph, &HashMap::new(), &mut fetch).expect("the call answers without the page");
        assert_eq!(&*fetch.seen.borrow(), &[("/templates".to_string(), String::new()), ("/_ajax/masonry".to_string(), "seo_landing_page".to_string())], "the target is sent with what the walk read");
        assert_eq!(run.steps.len(), 1, "the challenged page is not one of the call's steps");
        assert!(run.target.response_body.unwrap_or_default().contains("Lamp resume"));
    }

    /// A one-time bootstrap the page skips on a warm session is not a browser step when the jar already holds what
    /// later steps read from it: the step is skipped and the jar answers.
    #[test]
    fn a_bootstrap_the_session_already_holds_is_not_a_browser_step() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://shop.example/search",
            "steps": [
                { "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/bootstrap", "needs_browser": true,
                  "page_signed": true,
                  "page_producers": [{ "loc": { "in": "header", "key": "x-sig" }, "producer": { "script": "https://shop.example/app.js", "at": 1 } }],
                  "fields": [] },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://shop.example/api/target", "needs_browser": false,
                  "fields": [{ "loc": { "in": "cookie", "key": "w_tuid" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/bootstrap", "at": { "from": "json", "pointer": "/tuid" } } }] }
            ]
        }))
        .unwrap();
        struct Skips { seen: RefCell<Vec<String>> }
        impl Fetch for Skips {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.seen.borrow_mut().push(req.url.path().to_string());
                Ok(Exchange {
                    method: "POST".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some(r#"{"ok":true}"#.into()), response_mime: "application/json".into(),
                    resource_type: None, main_frame: None,
                })
            }
            fn sign_request(&mut self, _req: &Request, _inputs: &HashMap<String, String>) -> Option<crate::sandbox::Signed> {
                None
            }
            fn minted_cookie(&self, name: &str, _host: Option<&str>) -> Option<String> {
                (name == "w_tuid").then(|| "jar-tuid".into())
            }
        }
        let mut skips = Skips { seen: RefCell::new(vec![]) };
        replay(&graph, &HashMap::new(), &mut skips).unwrap();
        assert_eq!(&*skips.seen.borrow(), &["/api/target"], "the bootstrap is skipped; only the target is sent");
    }

    /// The page markup the route carries is the first page step's answer: the route's page-derived values read it, and
    /// the page is not fetched again — so a wall the walk never met has nothing to refuse.
    #[test]
    fn the_page_the_route_carries_is_not_fetched_again() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page_html": "<html><meta name=\"build\" content=\"7\"></html>",
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/", "reads_page": true, "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-build" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/", "at": { "from": "text", "before": "content=\"", "after": "\"", "nth": 0 } } }] }
            ]
        }))
        .unwrap();
        struct Pages { seen: RefCell<Vec<String>> }
        impl Fetch for Pages {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.seen.borrow_mut().push(req.url.path().to_string());
                if req.url.path() == "/" {
                    panic!("the page the route carries must not be fetched again");
                }
                Ok(Exchange {
                    method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some(r#"{"items":[]}"#.into()), response_mime: "application/json".into(),
                    resource_type: None, main_frame: None,
                })
            }
        }
        let mut pages = Pages { seen: RefCell::new(vec![]) };
        replay(&graph, &HashMap::new(), &mut pages).unwrap();
        assert_eq!(&*pages.seen.borrow(), &["/api/items"], "only the target is fetched");
    }

    /// A page the route carries is the walk's own markup, not the site's answer: a client-rendered shell (a title, a
    /// short static text, its app's scripts, no links) has the shape of a check, and treating it as one fails the call
    /// at the page even though the walk had it. The carried page is never a door.
    #[test]
    fn a_carried_page_that_looks_like_a_check_is_still_the_page() {
        let shell = r#"<html><head><title>Search</title><meta name="build" content="7"><script src="/app.js"></script></head><body><p>Loading your results…</p></body></html>"#;
        assert!(crate::page::a_door(200, shell, &"https://shop.example/search".parse().unwrap()), "the fixture has the shape this test is about");
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page_html": shell,
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/search", "reads_page": true, "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-build" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/search", "at": { "from": "text", "before": "content=\"", "after": "\"", "nth": 0 } } }] }
            ]
        }))
        .unwrap();
        struct Pages { seen: RefCell<Vec<String>> }
        impl Fetch for Pages {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.seen.borrow_mut().push(req.url.path().to_string());
                Ok(Exchange {
                    method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/json".into())],
                    response_body: Some(r#"{"items":[]}"#.into()), response_mime: "application/json".into(),
                    resource_type: None, main_frame: None,
                })
            }
        }
        let mut pages = Pages { seen: RefCell::new(vec![]) };
        replay(&graph, &HashMap::new(), &mut pages).expect("the carried page is the walk's, not a door");
        assert_eq!(&*pages.seen.borrow(), &["/api/items"], "only the target is fetched");
    }

    /// A call whose answer says it failed, wrapped in the callback its address asked for, fails the call: the site said
    /// no, whatever its status and however it wrapped the word.
    #[test]
    fn a_failure_the_site_states_inside_a_callback_fails_the_call() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://api.shop.example/h5/search/1.0/?callback=cb7&q=flask", "needs_browser": false,
                "response_shape": { "data": { "items": [{ "name": "string" }] }, "ret": ["string"] },
                "fields": [
                    { "loc": { "in": "query", "key": "callback" }, "class": "constant", "value": "cb7", "origin": null },
                    { "loc": { "in": "query", "key": "q" }, "class": "constant", "value": "flask", "origin": null }
                ] }]
        }))
        .unwrap();
        struct Says(&'static str);
        impl Fetch for Says {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Ok(Exchange {
                    method: "GET".into(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "application/javascript".into())],
                    response_body: Some(self.0.into()), response_mime: "application/javascript".into(),
                    resource_type: None, main_frame: None,
                })
            }
        }
        let failed = replay(&graph, &HashMap::new(), &mut Says(r#"cb7({"data":{},"ret":["FAIL_SYS_TOKEN_EMPTY::the token is empty"]})"#));
        assert!(matches!(&failed, Err(ReplayError::NotAnAnswer { why, .. }) if why.contains("says it failed")), "{failed:?}");
        let answered = replay(&graph, &HashMap::new(), &mut Says(r#"cb7({"data":{"items":[{"name":"flask"}]},"ret":["SUCCESS::ok"]})"#)).expect("the site answered");
        assert_eq!(answered.target.own_json().expect("its JSON")["data"]["items"][0]["name"], "flask");
    }

    /// The same, from the step-level marker: a route learned after the change has `page_signed` and its producers, not
    /// a field per header. Replay asks the bridge for the page's request on the marker alone.
    #[test]
    fn a_page_signed_step_is_signed_from_the_marker() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200,
                "url": "https://shop.example/api/search", "needs_browser": true,
                "page_signed": true,
                "page_producers": [{ "loc": { "in": "header", "key": "x-sig" }, "producer": { "script": "https://cdn.shop.example/app.js", "at": 42 } }],
                "fields": [{ "loc": { "in": "header", "key": "content-type" }, "class": "constant", "value": "application/json" }]
            }],
            "provisional": false
        }))
        .unwrap();
        let mut bridge = Signs { seen: RefCell::new(vec![]), signed: RefCell::new(vec![]) };
        replay(&graph, &HashMap::new(), &mut bridge).unwrap();
        assert_eq!(bridge.signed.borrow().len(), 1, "the marker asks the bridge once");
        let sent = bridge.seen.borrow();
        assert_eq!(sent.len(), 1, "the call was sent plain");
        assert_eq!(sent[0].headers.iter().find(|(k, _)| k == "x-sig").map(|(_, v)| v.as_str()), Some("sig-of-POST"));
    }

    /// A transport with no signing bridge says so, and a step that may change the site goes to the browser exactly as a
    /// computed value always did: nothing about a route learned on a signed call changes for a runner that cannot run
    /// its producer. (A step the write rule names a read goes as the route builds it instead: the site's answer says
    /// whether it needed the page's values — see `a_post_the_write_rule_names_a_read_goes_as_the_route_builds_it`.)
    #[test]
    fn a_script_signed_step_with_no_bridge_still_goes_to_the_browser() {
        struct Plain;
        impl Fetch for Plain {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, _req: &Request) -> Result<Exchange, ReplayError> {
                panic!("a script-signed step must not be sent unsigned")
            }
        }
        let mut writing = signed();
        writing.steps[0].url = "https://shop.example/api/cart/items".into();
        let err = replay(&writing, &HashMap::new(), &mut Plain).unwrap_err();
        assert!(matches!(err, ReplayError::NeedsBrowser { step: 1, .. }), "{err:?}");
    }

    /// A call whose answer the site's own decoder made is a rung-2 call: the reply no standard reader reads is run
    /// through the decoder in the sandbox, the answer's step is counted at `Rung::Function` on the same counter every
    /// hole uses (`HttpReplay::rungs`, which `made.jsonl` writes), and the answer is what the page read. The same body
    /// answered with a reply a standard reader reads runs no decoder and stays at the walk's rung.
    #[test]
    fn a_call_whose_answer_a_decoder_made_is_a_rung_two_call() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the decoder's rung is skipped");
            return;
        }
        use base64::Engine;
        const SCRIPT: &str = "(function () {\n  function unpack(t) { var raw = atob(t), out = ''; for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a); return JSON.parse(out); }\n  window.searchCipher = function (q, done) {\n    fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n  };\n})();\n";
        let records = r#"{"query":"lamp","results":[{"title":"lamp one"}]}"#;
        let ciphered = base64::engine::general_purpose::STANDARD.encode(records.bytes().map(|b| b ^ 0x5a).collect::<Vec<u8>>());
        struct Answers(String);
        impl Fetch for Answers {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Ok(Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![("content-type".into(), "text/plain".into())], response_body: Some(self.0.clone()), response_mime: "text/plain".into(),
                    resource_type: None, main_frame: None,
                })
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
        }
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q=lamp", "needs_browser": false, "fields": [] }],
            "provisional": false
        }))
        .unwrap();
        let mut body = crate::body::from_graph(&graph, "shop.example");
        let program = crate::slice::assemble_decoder(&[("https://shop.example/s/app.js", SCRIPT)]).expect("a decoder");
        body.answer.decode = Some(unbrowse_route::Decode { source: program, evidence: None });
        let run = replay_body(&body, &HashMap::new(), &mut Answers(ciphered)).expect("the call answers");
        assert_eq!(run.rungs.last(), Some(&Rung::Function), "the decoder made the answer: its step is a function of the site's");
        assert_eq!(run.target.own_json().map(|v| v["results"][0]["title"].clone()), Some(serde_json::json!("lamp one")), "the answer is what the page read");
        // The same body, answered with a reply a standard reader reads: no decoder runs, and the step is the walk's.
        let plain = replay_body(&body, &HashMap::new(), &mut Answers(records.into())).expect("the call answers");
        assert_eq!(plain.rungs.last(), Some(&Rung::Walk), "a reply read as it stands is no decoder's work");
    }

    fn generated(program: &str) -> Graph {
        serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200,
                "url": "https://shop.example/api/search", "needs_browser": false,
                "fields": [{
                    "loc": { "in": "header", "key": "x-sig" },
                    "class": "generated",
                    "program": program,
                    "evidence": { "header": "x-sig", "sightings": 2, "proposed_by": "agent", "evidence_hash": "0" }
                }]
            }],
            "provisional": false
        }))
        .unwrap()
    }

    /// A generated producer is run beside the request, in the sandbox: the call is sent plain, with the value the
    /// program computed. No page bridge is asked for it.
    #[test]
    fn a_generated_producer_is_run_without_a_page() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the generated producer is skipped");
            return;
        }
        struct Sends(RefCell<Vec<Request>>);
        impl Fetch for Sends {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.0.borrow_mut().push(req.clone());
                Ok(Exchange {
                    method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200,
                    response_headers: vec![], response_body: Some(r#"{"items":[]}"#.into()), response_mime: "application/json".into(),
                    resource_type: None, main_frame: None,
                })
            }
            fn sign_request(&mut self, _req: &Request, _inputs: &std::collections::HashMap<String, String>) -> Option<crate::sandbox::Signed> {
                panic!("a generated producer is not the page's to sign")
            }
        }
        let program = "function sign(ctx) { return 'g-' + ctx.path.slice(1).replace('/', '.'); }";
        let mut fetch = Sends(RefCell::new(vec![]));
        let run = replay(&generated(program), &HashMap::new(), &mut fetch).expect("the call is sent");
        assert_eq!(run.rungs.last(), Some(&Rung::Function), "a program run for the value is its own rung, below the page's whole script");
        let sent = fetch.0.borrow();
        assert_eq!(sent.len(), 1);
        let sig = sent[0].headers.iter().find(|(k, _)| k == "x-sig").map(|(_, v)| v.as_str());
        assert_eq!(sig, Some("g-api.search"), "{:?}", sent[0].headers);
    }

    /// A program that fails at call time is never a guessed header: the step goes to the browser, as a computed value
    /// always did.
    #[test]
    fn a_generated_producer_that_fails_falls_back_to_the_browser() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the generated producer is skipped");
            return;
        }
        struct Plain;
        impl Fetch for Plain {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, _req: &Request) -> Result<Exchange, ReplayError> {
                panic!("a step whose program failed must not be sent")
            }
        }
        let err = replay(&generated("function sign(ctx) { throw new Error('no'); }"), &HashMap::new(), &mut Plain).unwrap_err();
        assert!(matches!(err, ReplayError::NeedsBrowser { step: 1, .. }), "{err:?}");
    }
}

#[cfg(test)]
mod reseed_tests {
    use super::*;
    use crate::graph::build;
    use std::cell::Cell;

    fn traces() -> Vec<crate::trace::Trace> {
        let page = Exchange {
            method: "GET".into(),
            url: "https://shop.example/app".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: None,
        };
        let api = |pxhd: &str| Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("cookie".into(), format!("_pxhd={pxhd}"))],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        vec![
            crate::trace::Trace { exchanges: vec![page, api("px_aaa_111111")], inputs: vec![] },
            crate::trace::Trace { exchanges: vec![api("px_bbb_222222")], inputs: vec![] },
        ]
    }

    /// The first plain run is blocked; the runner re-mints its session from the root,
    /// and the retry goes through browserless.
    struct Flap {
        reseeded: Cell<bool>,
    }

    impl Fetch for Flap {
        /// This runner follows no redirect itself: its plain fetch is the unredirected one.
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }

        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let status = if req.url.path() == "/api/p/list" && !self.reseeded.get() { 403 } else { 200 };
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status,
                response_headers: vec![],
                response_body: Some(r#"{"items":[]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }

        fn minted(&self, name: &str) -> Option<String> {
            (name == "_pxhd").then(|| "px_ccc_333333".into())
        }

        fn reseed(&mut self, _root: &Request) -> Result<(), ReplayError> {
            self.reseeded.set(true);
            Ok(())
        }
    }

    /// The reseed's second run is a second send: a write the site may hold never gets one, however stale the answer.
    #[test]
    fn a_write_the_site_may_hold_is_not_sent_again_by_a_reseed() {
        let mut g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        for s in &mut g.steps {
            s.method = "PUT".into();
        }
        struct Refuses {
            sent: Cell<usize>,
        }
        impl Fetch for Refuses {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.sent.set(self.sent.get() + 1);
                Ok(Exchange {
                    method: req.method.clone(),
                    url: req.url.clone(),
                    request_headers: vec![],
                    request_body: None,
                    status: 500,
                    response_headers: vec![],
                    response_body: None,
                    response_mime: String::new(),
                    resource_type: None,
                    main_frame: None,
                })
            }
        }
        // A stale verdict on an answer that may have landed: a shape the recording never saw.
        let target = g.steps.len();
        g.steps[target - 1].status = 500;
        g.steps[target - 1].response_shape = Some(serde_json::json!({ "items": "array" }));
        let mut runner = Refuses { sent: Cell::new(0) };
        assert!(replay_reseeded(&g, &HashMap::new(), &mut runner, 1).is_err());
        assert_eq!(runner.sent.get(), g.steps.len(), "every step once, none twice");
    }

    #[test]
    fn a_stale_session_reseeds_from_the_root_and_retries() {
        let g = build(&traces(), |e| e.url.path() == "/api/p/list").unwrap();
        let mut runner = Flap { reseeded: Cell::new(false) };
        let run = replay_reseeded(&g, &HashMap::new(), &mut runner, 1).unwrap();
        assert!(runner.reseeded.get(), "the blocked run must re-mint the session");
        assert_eq!(run.steps.len(), 1);
    }
}

/// Fake wires for tests: a type that answers a request one way, plain or redirected alike, and may stand in for a
/// runner's session, is a [`Fetch`] by this one impl, so no test restates the two fetches.
#[cfg(test)]
pub(crate) mod fake_wire {
    use super::*;

    pub trait Answer {
        fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError>;
        fn session_values(&mut self, _exchange: usize) -> Option<Vec<(String, String)>> { None }
        fn minted(&self, _name: &str) -> Option<String> { None }
    }

    impl<T: Answer> Fetch for T {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> { self.answer(req) }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> { self.answer(req) }
        fn session_values(&mut self, exchange: usize) -> Option<Vec<(String, String)>> { Answer::session_values(self, exchange) }
        fn minted(&self, name: &str) -> Option<String> { Answer::minted(self, name) }
    }
}

#[cfg(test)]
mod rekey_tests {
    use super::fake_wire::Answer;
    use super::*;

    /// A value read from an entry keyed by what the caller sent follows what the caller sends now: the item's page
    /// lists the item under its own id.
    #[test]
    fn a_source_keyed_by_an_input_follows_the_input() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{"exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/p/{path[1]}/", "needs_browser": false,
                "fields": [{"loc": {"in": "path", "key": 1}, "class": "input", "name": "id", "secret": false, "default": "77001"}]}],
            "provisional": false
        }))
        .unwrap();
        let at = At::Json { pointer: "/items/77001/uuid".into() };
        let inputs: HashMap<String, String> = [("id".to_string(), "88002".to_string())].into_iter().collect();
        assert_eq!(rekeyed(&at, &graph, &inputs, None), At::Json { pointer: "/items/88002/uuid".into() });
        assert_eq!(rekeyed(&at, &graph, &HashMap::new(), None), at, "with the recorded value it reads where it read");
    }

    /// The walk that exposed it: a shop's search whose second call takes the page's id from the first entry of a
    /// list in the first call's answer (`/pages/0/id`), and whose first page is asked for as `offset=0`. A call for
    /// the next page read `/pages/24/id` and failed at a value that was there. A place in a list counts the answer's
    /// entries and is nobody's key; an entry filed under the caller's value in an object still follows the caller.
    #[test]
    fn a_place_in_a_list_is_not_the_callers_key() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{"exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/s?offset={offset}", "needs_browser": false,
                "fields": [{"loc": {"in": "query", "key": "offset"}, "class": "input", "name": "offset", "secret": false, "default": "0"}]}],
            "provisional": false
        }))
        .unwrap();
        let inputs: HashMap<String, String> = [("offset".to_string(), "24".to_string())].into_iter().collect();
        let listed = At::Json { pointer: "/pages/0/id".into() };
        assert_eq!(rekeyed(&listed, &graph, &inputs, Some(r#"{"pages":[{"id":"/s/lamp"}]}"#)), listed);
        let filed = At::Json { pointer: "/by_offset/0/id".into() };
        let answer = r#"{"by_offset":{"24":{"id":"x"}}}"#;
        assert_eq!(rekeyed(&filed, &graph, &inputs, Some(answer)), At::Json { pointer: "/by_offset/24/id".into() });
    }
    /// A script's call to an API another host serves for the page says it comes from the page: its Origin and Referer
    /// are the page's, and the fetch is same-site. The API that exposed it: a video site's search host answered an
    /// empty list to a call saying it came from the search host itself (2026-11-06).
    #[test]
    fn a_scripts_call_goes_out_from_the_page_it_was_learned_on() {
        let step: Step = serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "POST", "status": 200, "url": "https://search.video.example/v1", "needs_browser": false, "response_shape": {}, "fields": [] })).unwrap();
        let url = url::Url::parse("https://search.video.example/v1").unwrap();
        let mut h = Vec::new();
        script_shape(&step, Graph::default().asks_as_a_page(&step), &url, Some("https://www.video.example"), &mut h);
        let get = |k: &str| h.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str());
        assert_eq!(get("origin"), Some("https://www.video.example"));
        assert_eq!(get("referer"), Some("https://www.video.example/"));
        assert_eq!(get("sec-fetch-site"), Some("same-site"));
        let mut own = Vec::new();
        script_shape(&step, Graph::default().asks_as_a_page(&step), &url, None, &mut own);
        assert!(own.iter().any(|(a, v)| a == "origin" && v == "https://search.video.example"));
        assert!(own.iter().any(|(a, v)| a == "sec-fetch-site" && v == "same-origin"));
    }

    /// A page is asked for as a page: the search a browser opens is a navigation, and a route that sends it as a
    /// script's cross-origin fetch gets the site's wall instead of the results (aljazeera.com, 2026-11-11).
    #[test]
    fn a_page_is_asked_for_as_a_page() {
        let step: Step = serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://www.news.example/search/{word}", "needs_browser": false, "response_shape": {}, "reads_page": true, "fields": [] })).unwrap();
        let url = url::Url::parse("https://www.news.example/search/gaza").unwrap();
        let mut h = Vec::new();
        script_shape(&step, Graph::default().asks_as_a_page(&step), &url, Some("https://www.news.example"), &mut h);
        assert!(h.is_empty(), "a page carries none of a script's shape: {h:?}");
    }

    /// A page the browser went to is asked for as a page, though its reply holds JSON (the state it embeds): a graph
    /// that marks it `visited` sends none of a script's shape. A classifier's step with the same reply, unmarked, is
    /// asked as it always was, as a script's call.
    #[test]
    fn a_page_the_browser_went_to_is_asked_for_as_a_page_though_its_reply_holds_json() {
        let step: Step = serde_json::from_value(serde_json::json!({ "exchange": 3, "method": "GET", "status": 200, "url": "https://www.stays.example/searchresults.html", "needs_browser": false, "response_shape": { "results": [{ "name": "string" }] }, "fields": [] })).unwrap();
        let url = url::Url::parse("https://www.stays.example/searchresults.html?ss=Lisbon").unwrap();
        let visited = Graph { steps: vec![step.clone()], visited: vec![3], ..Graph::default() };
        let mut h = Vec::new();
        script_shape(&step, visited.asks_as_a_page(&step), &url, Some("https://www.stays.example"), &mut h);
        assert!(h.is_empty(), "a page carries none of a script's shape: {h:?}");
        let classifiers = Graph { steps: vec![step.clone()], ..Graph::default() };
        let mut h = Vec::new();
        script_shape(&step, classifiers.asks_as_a_page(&step), &url, Some("https://www.stays.example"), &mut h);
        assert!(h.iter().any(|(k, v)| k == "sec-fetch-mode" && v == "cors"), "a classifier's step is asked as it was: {h:?}");
    }

    /// A date and a time the call sends are pieces of the date-time the caller gave: replay writes the same piece of
    /// the new value, so a call for another day asks for that day.
    #[test]
    fn a_piece_of_the_callers_value_is_written_from_what_they_send_now() {
        use crate::graph::{Body, Field, Step};
        let piece = |pointer: &str, from: usize, len: usize| Field { loc: Loc::Json(pointer.into()), class: Class::Piece { input: "dateTime".into(), from, len } };
        let step = Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0, method: "POST".into(), status: 200, url: "https://book.example/api/availability".into(),
            fields: vec![piece("/date", 0, 10), piece("/time", 11, 5)],
            body: Some(Body::Json { template: serde_json::json!({"date": null, "time": null}), types: [("/date", "string"), ("/time", "string")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect() }),
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), reads_page: false,
            fallbacks: Vec::new(),
        };
        let graph = Graph { steps: vec![step], provisional: false, page_origin: None, ..Graph::default() };
        let mut seen = None;
        struct Sees<'a>(&'a mut Option<String>);
        impl Fetch for Sees<'_> {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                *self.0 = req.text().map(String::from);
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some("{}".into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
        }
        replay(&graph, &HashMap::from([("dateTime".to_string(), "2026-12-24T21:30:00".to_string())]), &mut Sees(&mut seen)).unwrap();
        assert_eq!(seen.as_deref(), Some(r#"{"date":"2026-12-24","time":"21:30"}"#));
    }

    /// An optional input nobody set isn't sent, in any place a value can sit: `null` and an empty value are values to a
    /// site, and the call must be the one the walk made.
    /// A search's word inside the JSON a call carries, and in the page's address beside it: every call asks for what
    /// its caller asked, in each place written the way that place writes it.
    #[test]
    fn a_callers_value_replaces_the_walks_inside_a_longer_value() {
        use crate::graph::{Held, Written};
        let held = |loc: Loc, sits: &str, written| Held { loc, input: "q".into(), sits: sits.into(), written, inside: None };
        let constant = |loc: Loc, value: &str| crate::graph::Field { loc, class: Class::Constant { value: value.into(), origin: None } };
        let step = Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0,
            method: "GET".into(),
            status: 200,
            url: "https://shop.example/get/?data={data}&from={from}".into(),
            fields: vec![constant(Loc::Query("data".into()), r#"{"query":"kitchen"}"#), constant(Loc::Query("from".into()), "/s?q=kitchen")],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign: false,
            held: vec![held(Loc::Query("data".into()), "kitchen", Written::Json), held(Loc::Query("from".into()), "kitchen", Written::Percent)],
            fallbacks: Vec::new(),
        };
        let graph = Graph { steps: vec![step], provisional: false, page_origin: None, ..Graph::default() };
        let mut seen = None;
        struct Sees<'a>(&'a mut Option<url::Url>);
        impl Fetch for Sees<'_> {
            /// This runner follows no redirect itself: its plain fetch is the unredirected one.
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }

            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                *self.0 = Some(req.url.clone());
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some("{}".into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
        }
        replay(&graph, &HashMap::from([("q".to_string(), "tiny \"house\"".to_string())]), &mut Sees(&mut seen)).unwrap();
        let sent: HashMap<String, String> = seen.unwrap().query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(sent["data"], r#"{"query":"tiny \"house\""}"#);
        assert_eq!(sent["from"], "/s?q=tiny%20%22house%22");
    }

    /// A value the walk sent at an array's index and this call could not produce (its state moved, or the site no
    /// longer holds it) is not sent as `null` in the list: a hole there is a malformed call (OpenTable's
    /// `restaurantIds` earns a 400), and the site's refusal would be read as the client's. The step says what it needs
    /// instead. An object key left null still goes as the template had it.
    #[test]
    fn a_hole_in_a_list_is_not_the_request_the_walk_sent() {
        use crate::graph::{Body, Class, Field, Step};
        let value = |loc: Loc| Field { loc, class: Class::Input { name: "restaurantIds".into(), secret: false, default: None, optional: false } };
        let step = |body: Body, fields: Vec<Field>| Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0, method: "POST".into(), status: 200, url: "https://book.example/api".into(), fields, body: Some(body),
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), reads_page: false,
            fallbacks: Vec::new(),
        };
        let list = step(
            Body::Json {
                template: serde_json::json!({"ids": [null, null], "date": null}),
                types: [("/ids/0", "number"), ("/ids/1", "number"), ("/date", "string")].into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            },
            vec![value(Loc::Json("/ids/0".into())), value(Loc::Json("/ids/1".into()))],
        );
        let both = [(Loc::Json("/ids/0".into()), "1".to_string()), (Loc::Json("/ids/1".into()), "2".to_string())];
        assert_eq!(request_body(0, &list, &both).unwrap().unwrap(), r#"{"ids":[1,2],"date":null}"#, "an object key may stay null");
        let one = [(Loc::Json("/ids/0".into()), "1".to_string())];
        let err = request_body(0, &list, &one).expect_err("a hole in the list is not a narrower call");
        assert!(matches!(err, ReplayError::SourceMissing { .. }), "{err:?}");
        assert!(err.to_string().contains("/ids/1"), "{err}");
    }

    /// The walk that exposed it: a restaurant search whose availability call sends the ids of the restaurants the
    /// page listed, eighteen of them, each read from its place in the page's list. A page for another word lists
    /// twelve, and the call failed at the thirteenth. A list read off a list is as long as the list read: its tail is
    /// cut. A hole inside it, with elements after, is still a hole.
    #[test]
    fn a_list_read_off_a_list_is_as_long_as_the_list_read() {
        use crate::graph::{Body, Class, Field, Step};
        use crate::provenance::{At, Origin};
        let from = |n: usize| Field { loc: Loc::Json(format!("/ids/{n}")), class: Class::Derived { origin: Origin { exchange: 0, url: "https://book.example/s".into(), at: At::Json { pointer: format!("/list/{n}/id") }, wrap: None } } };
        let step = Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 1, method: "POST".into(), status: 200, url: "https://book.example/api".into(), fields: (0..4).map(from).collect(),
            body: Some(Body::Json {
                template: serde_json::json!({"ids": [null, null, null, null]}),
                types: (0..4).map(|n| (format!("/ids/{n}"), "number".to_string())).collect(),
            }),
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), reads_page: false,
            fallbacks: Vec::new(),
        };
        assert!(follows_a_list(&step, &Loc::Json("/ids/2".into()), 0) && !follows_a_list(&step, &Loc::Json("/ids/0".into()), 0));
        let read = |ns: &[usize]| ns.iter().map(|n| (Loc::Json(format!("/ids/{n}")), (n + 7).to_string())).collect::<Vec<_>>();
        assert_eq!(request_body(1, &step, &read(&[0, 1])).unwrap().unwrap(), r#"{"ids":[7,8]}"#);
        assert!(request_body(1, &step, &read(&[0, 3])).is_err(), "a hole with an element after it");
    }

    /// The walk that exposed it: a fund search posted as a form, its result count and its first result among the
    /// fields. The route offered the count to its caller and tried the next page at learn time, and the form sent the
    /// walk's own values both times: the template's copy was written and the field's value never was. So a form's
    /// input was heard by no site, and no form-posted search was ever found to read on.
    #[test]
    fn a_forms_field_sends_what_the_route_gives_it() {
        use crate::graph::{Body, Class, Field, Step};
        let step = Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0, method: "POST".into(), status: 200, url: "https://funds.example/rest/search".into(),
            fields: vec![
                Field { loc: Loc::Form("q".into()), class: Class::Input { name: "q".into(), secret: false, default: Some("bonds".into()), optional: false } },
                Field { loc: Loc::Form("count".into()), class: Class::Input { name: "count".into(), secret: false, default: Some("10".into()), optional: true } },
            ],
            body: Some(Body::Form { fields: vec![("q".into(), None), ("count".into(), Some("10".into())), ("first".into(), Some("0".into()))] }),
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), reads_page: false,
            fallbacks: Vec::new(),
        };
        let given = [(Loc::Form("q".into()), "index funds".to_string()), (Loc::Form("count".into()), "25".to_string())];
        assert_eq!(request_body(0, &step, &given).unwrap().unwrap(), "q=index+funds&count=25&first=0");
        let unset = [(Loc::Form("q".into()), "index funds".to_string())];
        assert_eq!(request_body(0, &step, &unset).unwrap().unwrap(), "q=index+funds&count=10&first=0", "left unset, the first call's value");
    }

    /// The walk that exposed it: a documentation search posted as JSON, its offset a number in the body. The trial
    /// for the next page moved the route's field and the body sent the template's own `0`: the site answered the
    /// first page again and the search was never found to read on. A slot opened for its field sends the field's
    /// value, typed as the walk's was; left unopened, the template's copy stands.
    #[test]
    fn a_json_slot_opened_for_its_field_sends_the_fields_value() {
        use crate::graph::{Body, Class, Field, Step};
        let mut step = Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0, method: "POST".into(), status: 200, url: "https://docs.example/api/search".into(),
            fields: vec![Field { loc: Loc::Json("/offset".into()), class: Class::Unconfirmed { value: "10".into() } }],
            body: Some(Body::Json { template: serde_json::json!({ "q": "backup", "size": 10, "offset": 0 }), types: Default::default() }),
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), reads_page: false,
            fallbacks: Vec::new(),
        };
        let given = [(Loc::Json("/offset".into()), "10".to_string())];
        assert_eq!(request_body(0, &step, &given).unwrap().unwrap(), r#"{"q":"backup","size":10,"offset":0}"#, "unopened, the walk's copy");
        crate::paging::open_slot(&mut step, &Loc::Json("/offset".into()));
        assert_eq!(request_body(0, &step, &given).unwrap().unwrap(), r#"{"q":"backup","size":10,"offset":10}"#);
    }

    /// The walk that exposed it: a hotel search asked for a place that does not exist. The site's place lookup
    /// answered 404, with the cookie its bot vendor sets on every answer, and the caller was told the vendor's wall
    /// stood. A vendor's mark on a page not found is who served it; only a refusal or the vendor's check is a door.
    #[test]
    fn a_page_not_found_with_a_vendors_cookie_is_not_its_wall() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{"exchange": 0, "method": "GET", "status": 200, "url": "https://stay.example/api/places?q={q}", "needs_browser": false,
                "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "secret": false, "default": "paris"}]}],
            "provisional": false
        }))
        .unwrap();
        struct Answers(u16);
        impl Fetch for Answers {
            fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: self.0,
                    response_headers: vec![("set-cookie".into(), "_abck=x; Path=/; Max-Age=3600".into())], response_body: Some("{\"error\":\"Not Found\"}".into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.fetch(req)
            }
        }
        let asked = HashMap::from([("q".to_string(), "zzqxjvkw".to_string())]);
        let not_found = replay(&graph, &asked, &mut Answers(404)).expect_err("a 404 is no answer");
        assert!(!matches!(not_found, ReplayError::Door { .. }), "{not_found:?}");
        let refused = replay(&graph, &asked, &mut Answers(403)).expect_err("a 403 is no answer");
        assert!(matches!(refused, ReplayError::Door { .. }), "{refused:?}");
    }

    /// A site that says it is out of asks (429) is asking to be asked again, not refusing: the second ask is the
    /// call's answer. The wait is the interval the site names, so the test costs nothing.
    #[test]
    fn a_site_out_of_asks_is_asked_again_and_the_second_ask_is_the_calls_answer() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{"exchange": 0, "method": "GET", "status": 200, "url": "https://site.example/search?q={q}", "needs_browser": false,
                "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "secret": false, "default": "mars"}]}],
            "provisional": false
        }))
        .unwrap();
        let mut answers = BusyThenFree { busy: 2, asked: 0 };
        let got = replay(&graph, &HashMap::new(), &mut answers).expect("the second ask is the answer");
        assert_eq!(got.target.response_body.as_deref(), Some("{\"results\":[{\"title\":\"Mars\"}]}"));
        assert_eq!(answers.asked, 3, "one ask and the two the site asked for");
    }

    /// A site that keeps saying it is busy is refused with its own status, after a bounded number of asks: a call
    /// never sits on a wall that only time clears.
    #[test]
    fn a_site_that_keeps_saying_it_is_busy_is_refused_with_its_own_status() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{"exchange": 0, "method": "GET", "status": 200, "url": "https://site.example/search?q={q}", "needs_browser": false,
                "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "secret": false, "default": "mars"}]}],
            "provisional": false
        }))
        .unwrap();
        let mut answers = BusyThenFree { busy: 99, asked: 0 };
        let refused = replay(&graph, &HashMap::new(), &mut answers).expect_err("still busy");
        assert!(matches!(refused, ReplayError::Failed { status: 429, .. }), "{refused:?}");
        assert_eq!(answers.asked, 1 + ASKED_AGAIN, "asked, and asked the bounded number of times more");
    }

    /// A step that may change the site is never sent twice, whatever the site says: the same rule that holds a heal
    /// holds this.
    #[test]
    fn a_step_that_may_write_is_not_sent_again_when_the_site_says_it_is_busy() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{"exchange": 0, "method": "POST", "status": 200, "url": "https://site.example/api/orders", "needs_browser": false,
                "fields": [], "body": {"kind": "json", "template": {"q": "mars"}, "types": {}}}],
            "provisional": false
        }))
        .unwrap();
        let mut answers = BusyThenFree { busy: 1, asked: 0 };
        let refused = replay(&graph, &HashMap::new(), &mut answers).expect_err("a write is not retried");
        assert!(matches!(refused, ReplayError::Failed { status: 429, .. }), "{refused:?}");
        assert_eq!(answers.asked, 1, "the commit was sent once");
    }

    /// A site that answers "too many requests" a few times and then the answer, and counts the asks, each answered
    /// with the interval the node's own wait is held to (`Retry-After: 0`), so a test is not spent on waiting.
    struct BusyThenFree {
        busy: usize,
        asked: usize,
    }
    impl Fetch for BusyThenFree {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.asked += 1;
            let (status, headers, body) = if self.asked <= self.busy {
                (429, vec![("retry-after".to_string(), "0".to_string())], "429 Too Many Requests".to_string())
            } else {
                (200, Vec::new(), "{\"results\":[{\"title\":\"Mars\"}]}".to_string())
            };
            Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status,
                response_headers: headers, response_body: Some(body), response_mime: "application/json".into(), resource_type: None, main_frame: None })
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
    }

    #[test]
    fn an_unset_optional_input_is_not_sent() {        use crate::graph::{Body, Class, Field, Step};
        let optional = |loc: Loc, name: &str| Field { loc, class: Class::Input { name: name.into(), secret: false, default: None, optional: true } };
        let step = |body: Option<Body>, fields: Vec<Field>| Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0, method: "POST".into(), status: 200, url: "https://shop.example/api".into(), fields, body,
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), reads_page: false,
            fallbacks: Vec::new(),
        };
        let json = step(
            Some(Body::Json { template: serde_json::json!({"q": "lamp", "after": null}), types: [("/after".to_string(), "string".to_string())].into() }),
            vec![optional(Loc::Json("/after".into()), "after")],
        );
        assert_eq!(request_body(0, &json, &[]).unwrap().unwrap(), r#"{"q":"lamp"}"#);
        let given = [(Loc::Json("/after".into()), "n3xt".to_string())];
        assert_eq!(request_body(0, &json, &given).unwrap().unwrap(), r#"{"q":"lamp","after":"n3xt"}"#);
        let form = step(Some(Body::Form { fields: vec![("q".into(), Some("lamp".into())), ("sort".into(), None)] }), vec![optional(Loc::Form("sort".into()), "sort")]);
        assert_eq!(request_body(0, &form, &[]).unwrap().unwrap(), "q=lamp");
        let given = [(Loc::Form("sort".into()), "price".to_string())];
        assert_eq!(request_body(0, &form, &given).unwrap().unwrap(), "q=lamp&sort=price");
    }


    /// A failed step's error goes to the owner's log and the route's record: what the site said, never the page.
    #[test]
    fn a_failed_step_says_what_the_page_said_not_the_page() {
        let e = ReplayError::Failed { step: 1, url: "https://shop.example/x".into(), status: 404, body: "<!doctype html><html><head><title>Gone</title><script>var a=1</script></head><body><h1>Nothing here</h1></body></html>".into() };
        let said = e.to_string();
        assert!(said.contains("Gone") && said.contains("Nothing here") && !said.contains('<'), "{said}");
    }

    /// A site that has moved on since the route was learned (a refusal of the session, a door, a source or shape that
    /// is not where it was, a session value gone) is stale, and a reseed may mend it; a call that was wrong, or a
    /// failure that is the site's own, is not.
    #[test]
    fn an_answer_that_says_the_session_moved_is_stale_and_one_that_says_otherwise_is_not() {
        use super::*;
        let failed = |status: u16| ReplayError::Failed { step: 1, url: "https://shop.example/x".into(), status, body: String::new() };
        let missing = || ReplayError::SourceMissing { step: 1, url: "https://shop.example/x".into(), loc: Loc::Url };
        let shape = || ReplayError::ShapeMismatch { expected: serde_json::json!({}), got: serde_json::json!([]) };
        for stale in [failed(401), failed(403), missing(), shape(), ReplayError::MissingMinted("sid".into())] {
            assert!(stale.is_stale(), "{stale}");
        }
        for fine in [failed(404), failed(500), ReplayError::MissingInput("q".into()), ReplayError::Transport("EOF".into()), ReplayError::Refused("rule".into())] {
            assert!(!fine.is_stale(), "{fine}");
        }
    }

    /// A runner that implements only the two fetches keeps no session and no storage: it holds no cookie, no stored
    /// value, no session-only step and no page of its own, a reseed is nothing to do, and no step is the browser's.
    #[test]
    fn a_runner_that_keeps_no_session_holds_nothing() {
        use super::*;
        struct Bare;
        impl Fetch for Bare {
            fn fetch(&mut self, _: &Request) -> Result<Exchange, ReplayError> { Err(ReplayError::Transport("never".into())) }
            fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> { self.fetch(req) }
        }
        let mut bare = Bare;
        let root = Request { method: "GET".into(), url: "https://shop.example/".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        assert_eq!(bare.minted("sid"), None);
        assert_eq!(bare.minted_cookie("sid", Some("shop.example")), None);
        assert_eq!(bare.stored(unbrowse_route::expr::Area::Local, "seed"), None);
        assert_eq!(bare.session_values(0), None);
        assert!(bare.reseed(&root).is_ok(), "a reseed with no session to mint is nothing to do");
        assert!(!bare.browser_made(0));
        assert!(bare.allows(&root).is_ok());
        assert_eq!(bare.file_root(), crate::files::root());
        assert!(matches!(bare.fetch_unredirected(&root), Err(ReplayError::Transport(_))), "its plain fetch is its only fetch");
    }

    /// What a route reads from the page it carries: a text marker is read off the carried markup, a live value (a
    /// header, a parsed script) needs the page fetched, and a route that reads nothing from it, or carries none, says so.
    #[test]
    fn a_route_says_whether_it_reads_the_page_it_carries_as_text_live_or_not_at_all() {
        use super::*;
        let reading = |at: serde_json::Value, page: bool| -> Graph {
            let mut graph = serde_json::json!({
                "provisional": false,
                "steps": [
                    { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/", "reads_page": true, "needs_browser": false, "fields": [] },
                    { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "needs_browser": false,
                      "fields": [{ "loc": { "in": "header", "key": "x-build" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/", "at": at } }] }
                ]
            });
            if page {
                graph["page_html"] = serde_json::json!("<html>shop</html>");
            }
            serde_json::from_value(graph).unwrap()
        };
        let text = serde_json::json!({ "from": "text", "before": "content=\"", "after": "\"", "nth": 0 });
        let header = serde_json::json!({ "from": "header", "name": "x-build" });
        assert_eq!(page_reads(&reading(text.clone(), true)), "text");
        assert_eq!(page_reads(&reading(header, true)), "live");
        assert_eq!(page_reads(&reading(text, false)), "none", "no carried page, nothing to read");
        let mut unread = reading(serde_json::json!({ "from": "header", "name": "x" }), true);
        unread.steps[1].fields.clear();
        assert_eq!(page_reads(&unread), "none", "a page nothing reads");
    }

    /// A step answered from the runner's store (a challenge's clearance cookie) never touches the network: its
    /// headers stand as its answer, and a later step reads a value off them.
    #[test]
    fn a_step_the_store_answers_is_never_sent_and_its_headers_feed_the_next() {
        use super::*;
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [
                { "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/challenge", "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-clear" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/challenge", "at": { "from": "header", "name": "x-clearance" } } }] }
            ]
        }))
        .unwrap();
        struct Store { sent: Vec<Request> }
        impl Answer for Store {
            fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                self.sent.push(req.clone());
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some(r#"{"items":[]}"#.into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
            fn session_values(&mut self, exchange: usize) -> Option<Vec<(String, String)>> {
                (exchange == 0).then(|| vec![("x-clearance".to_string(), "clear-9".to_string())])
            }
        }
        let mut store = Store { sent: vec![] };
        let run = replay(&graph, &HashMap::new(), &mut store).unwrap();
        assert_eq!(store.sent.len(), 1, "only the target goes out");
        assert_eq!(store.sent[0].url.path(), "/api/items");
        assert!(store.sent[0].headers.iter().any(|(k, v)| k == "x-clear" && v == "clear-9"), "{:?}", store.sent[0].headers);
        assert_eq!(run.steps.len(), 2, "the store's step is counted as answered");
        assert_eq!(run.rungs[0], Rung::Walk);
    }

    /// A call the page made that the site now refuses, and that nothing after it reads, is the page's own: the route
    /// goes on without it. The target's own refusal is the call's failure.
    #[test]
    fn a_refused_step_nothing_reads_is_skipped_and_the_targets_refusal_fails_the_call() {
        use super::*;
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/ping", "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "needs_browser": false, "fields": [] }
            ]
        }))
        .unwrap();
        struct Refuses { target: u16 }
        impl Answer for Refuses {
            fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
                let status = if req.url.path() == "/api/ping" { 404 } else { self.target };
                Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status, response_headers: vec![], response_body: Some(r#"{"items":[]}"#.into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
            }
        }
        let run = replay(&graph, &HashMap::new(), &mut Refuses { target: 200 }).expect("the ping is the page's own");
        assert_eq!(run.steps.len(), 1, "the refused step is not counted");
        assert_eq!(run.steps[0].0, "https://shop.example/api/items");
        let refused = replay(&graph, &HashMap::new(), &mut Refuses { target: 500 });
        assert!(matches!(&refused, Err(ReplayError::Failed { step: 2, status: 500, .. })), "{refused:?}");
    }

    /// A caller's word that rides inside a longer text of a JSON body is written into that text, where no type says how.
    #[test]
    fn a_callers_word_is_written_into_the_json_leaf_it_rode_in() {
        use super::*;
        use crate::graph::{Body, Held, Step, Written};
        let step = Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: 0, method: "POST".into(), status: 200, url: "https://shop.example/api".into(), fields: Vec::new(),
            body: Some(Body::Json { template: serde_json::json!({"q": "red lamp, cheap", "n": 3}), types: Default::default() }),
            response_shape: None, needs_browser: false, sets_cookie: false, on_load: false, foreign: false,
            held: vec![Held { loc: Loc::Json("/q".into()), input: "q".into(), sits: "red lamp".into(), written: Written::Plain, inside: None }],
            reads_page: false,
            fallbacks: Vec::new(),
        };
        let given = [(Loc::Json("/q".into()), "blue desk, cheap".to_string())];
        assert_eq!(request_body(0, &step, &given).unwrap().unwrap(), r#"{"q":"blue desk, cheap","n":3}"#);
    }

    /// A one-time bootstrap is held for later only when the jar already holds what later steps read from it: a header's
    /// token the jar keeps, and not one a later step reads into a query.
    #[test]
    fn a_bootstrap_is_held_for_later_only_when_the_jar_holds_what_later_steps_read_from_it() {
        use super::*;
        let graph = |key: serde_json::Value| -> Graph {
            serde_json::from_value(serde_json::json!({
                "provisional": false,
                "page": "https://shop.example/search",
                "steps": [
                    { "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/bootstrap", "needs_browser": true,
                      "page_signed": true,
                      "page_producers": [{ "loc": { "in": "header", "key": "x-sig" }, "producer": { "script": "https://shop.example/app.js", "at": 1 } }],
                      "fields": [] },
                    { "exchange": 1, "method": "POST", "status": 200, "url": "https://shop.example/api/target", "needs_browser": false,
                      "fields": [{ "loc": key, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/bootstrap", "at": { "from": "json", "pointer": "/tok" } } }] }
                ]
            }))
            .unwrap()
        };
        struct Jar { held: bool }
        impl Answer for Jar {
            fn answer(&mut self, _: &Request) -> Result<Exchange, ReplayError> { Err(ReplayError::Transport("never".into())) }
            fn minted(&self, name: &str) -> Option<String> {
                (self.held && name == "x-tok").then(|| "jar-tok".into())
            }
        }
        let held = |key: serde_json::Value, held: bool| {
            let graph = graph(key);
            held_for_later(&graph, &graph.steps[0], &mut Jar { held })
        };
        let header = || serde_json::json!({ "in": "header", "key": "x-tok" });
        assert!(held(header(), true), "the jar holds the token the later step reads");
        assert!(!held(header(), false), "the jar lacks it");
        assert!(!held(serde_json::json!({ "in": "query", "key": "x-tok" }), true), "a query is not the jar's");
    }
}

#[cfg(test)]
mod packed_tests {
    use super::*;
    use base64::Engine;
    use std::cell::RefCell;

    struct Seen(RefCell<Vec<Request>>);

    impl Fetch for Seen {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.0.borrow_mut().push(req.clone());
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: vec![],
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some(r#"{"results":[]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
    }

    /// A page packed its search into JSON and sent that encoded. A call packs its own word the same way: into the
    /// text the value decodes to, encoded back as the page encoded it, with everything else in it as it was
    /// (`learn.derivation`).
    #[test]
    fn a_call_packs_its_word_the_way_the_page_packed_the_walks() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let walked = b64.encode(r#"{"query":"kettle","first":3}"#);
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200, "needs_browser": false,
                "url": "https://shop.example/api/search?v={v}",
                "fields": [{ "loc": { "in": "query", "key": "v" }, "class": "constant", "value": walked }],
                "held": [{ "loc": { "in": "query", "key": "v" }, "input": "q", "sits": "kettle", "written": "json", "inside": "base64" }]
            }],
            "provisional": false
        }))
        .unwrap();
        let mut seen = Seen(RefCell::new(vec![]));
        replay(&graph, &HashMap::from([("q".to_string(), "tea \"pot\"".to_string())]), &mut seen).unwrap();
        let sent = seen.0.borrow()[0].url.query_pairs().find(|(k, _)| k == "v").map(|(_, v)| v.into_owned()).expect("the packed value");
        let text = String::from_utf8(b64.decode(&sent).expect("it is encoded as the page encoded it")).unwrap();
        let packed: Value = serde_json::from_str(&text).expect("what it holds is still JSON");
        assert_eq!(packed, serde_json::json!({ "query": "tea \"pot\"", "first": 3 }), "the caller's word, written as JSON writes it, and the rest as it was");
        // With no word given, the walk's own value goes as it was.
        let mut again = Seen(RefCell::new(vec![]));
        replay(&graph, &HashMap::new(), &mut again).unwrap();
        assert!(again.0.borrow()[0].url.as_str().contains(&walked.replace('=', "%3D")) || again.0.borrow()[0].url.query_pairs().any(|(_, v)| v == walked));
    }
}

#[cfg(test)]
mod fill_tests {
    use super::*;

    /// A transport that keeps every request it is asked and answers each with an empty reply.
    #[derive(Default)]
    struct Kept(Vec<Request>);
    impl Fetch for Kept {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.0.push(req.clone());
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: req.headers.clone(),
                request_body: None,
                status: 200,
                response_headers: Vec::new(),
                response_body: Some(r#"{"items":[{"name":"one"}]}"#.into()),
                response_mime: "application/json".into(),
                resource_type: Some("XHR".into()),
                main_frame: None,
            })
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
    }

    fn graph(steps: serde_json::Value) -> Graph {
        serde_json::from_value(serde_json::json!({ "provisional": false, "steps": steps })).unwrap()
    }

    /// What each builder sends for `graph`, and what the replay came to, in a world given `inputs`.
    fn both(graph: &Graph, inputs: &[(&str, &str)]) -> [(Vec<Request>, Result<Vec<Rung>, String>); 2] {
        let inputs: HashMap<String, String> = inputs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        [false, true].map(|fill| {
            let mut kept = Kept::default();
            let came = replay_by(graph, &inputs, &mut kept, fill).map(|r| r.rungs).map_err(|e| e.to_string());
            (kept.0, came)
        })
    }

    fn search(fields: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://air.example/flights", "needs_browser": false, "fields": fields })
    }

    /// With the switch on, what is sent is the body's filler's request, and it is the request the graph's own builders
    /// make for the same step; each is held to the other on the way, as the counts say.
    #[test]
    fn what_the_filler_builds_is_what_is_sent_and_it_is_what_the_fields_build() {
        let g = graph(serde_json::json!([search(serde_json::json!([
            { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "tokyo" },
            { "loc": { "in": "header", "key": "x-client" }, "class": "constant", "value": "web" }
        ]))]));
        let before = crate::body::HELD.with(|held| held.get());
        let [(old, old_came), (new, new_came)] = both(&g, &[("q", "osaka")]);
        assert_eq!(crate::body::HELD.with(|held| held.get()).0, before.0 + 2, "both runs held the two builders to each other");
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].url.as_str(), "https://air.example/flights?q=osaka");
        assert_eq!((new[0].url.clone(), new[0].headers.clone(), new[0].body.clone()), (old[0].url.clone(), old[0].headers.clone(), old[0].body.clone()));
        assert_eq!(new_came, old_came);
    }

    /// A signature over the request, the clock and a run of random digits is the same digest whichever builder makes
    /// it: both are handed the step's one reading of the clock and of chance, and the digest itself is compared whole.
    /// Its rung is the expression's, both ways.
    #[test]
    fn a_digest_over_the_clock_and_chance_is_the_same_whichever_builder_makes_it() {
        let g = graph(serde_json::json!([search(serde_json::json!([
            { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "tokyo" },
            { "loc": { "in": "header", "key": "x-sign" }, "class": "recipe", "recipe": { "algo": "md5", "separator": ";", "parts": [{ "part": "path" }, { "part": "fresh", "template": "{ms}-{d4}" }] } },
            { "loc": { "in": "query", "key": "sign" }, "class": "recipe", "recipe": { "algo": "sha1", "separator": "&", "parts": [{ "part": "query", "key": "q" }, { "part": "fresh", "template": "{d6}" }] } }
        ]))]));
        let [(old, old_came), (new, new_came)] = both(&g, &[("q", "osaka")]);
        let sign = |r: &Request| r.headers.iter().find(|(k, _)| k == "x-sign").map(|(_, v)| v.len());
        assert_eq!((sign(&old[0]), sign(&new[0])), (Some(32), Some(32)), "a digest is sent both ways");
        assert!(new[0].url.query_pairs().any(|(k, v)| k == "sign" && v.len() == 40), "{}", new[0].url);
        assert_eq!(old_came.as_deref(), Ok(&[Rung::Expression][..]));
        assert_eq!(new_came, old_came);
    }

    /// Where the filler stops, the replay comes to what it always came to: a value the caller must give, a value
    /// made over the request that its body would carry, each the same error; and a step that has a value an earlier
    /// reply did not hold, and that nothing after reads, is stepped past the same way, the call going on to its target.
    #[test]
    fn where_the_filler_stops_the_replay_says_what_it_always_said() {
        let needs = graph(serde_json::json!([search(serde_json::json!([{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": null }]))]));
        let [(_, old), (_, new)] = both(&needs, &[]);
        assert_eq!((old.as_ref().err().map(String::as_str), &new), (Some("no value given for input `q`"), &old));
        let mut signed_body = search(serde_json::json!([{ "loc": { "in": "json", "key": "/sig" }, "class": "recipe", "recipe": { "algo": "md5", "separator": "", "parts": [{ "part": "path" }] } }]));
        signed_body["method"] = "POST".into();
        signed_body["body"] = serde_json::json!({ "kind": "json", "template": { "sig": null }, "types": { "/sig": "string" } });
        let [(_, old), (_, new)] = both(&graph(serde_json::json!([signed_body])), &[]);
        assert!(old.as_ref().is_err_and(|e| e.contains("needs a browser")), "{old:?}");
        assert_eq!(new, old);
        let origin = serde_json::json!({ "exchange": 7, "url": "https://air.example/token", "at": { "from": "json", "pointer": "/token" } });
        let mut first = search(serde_json::json!([{ "loc": { "in": "header", "key": "x-token" }, "class": "derived", "origin": origin }]));
        first["url"] = "https://air.example/warm".into();
        let mut target = search(serde_json::json!([]));
        target["exchange"] = 1.into();
        let [(old_sent, old), (new_sent, new)] = both(&graph(serde_json::json!([first, target])), &[]);
        assert_eq!(old_sent.iter().map(|r| r.url.path().to_string()).collect::<Vec<_>>(), ["/flights"], "the step nothing reads is stepped past");
        assert_eq!((new_sent.iter().map(|r| r.url.to_string()).collect::<Vec<_>>(), &new), (old_sent.iter().map(|r| r.url.to_string()).collect::<Vec<_>>(), &old));
    }
}

#[cfg(test)]
#[path = "replay_cov_tests.rs"]
mod replay_cov_tests;
