//! A site's opt-out, read on this client only (R4.32, `decide.optout-client-side`): a site may take its routes out of
//! this node's live set without a wallet, DNSSEC or anything on the chain, by naming the product token [`TOKEN`] in its
//! robots rules (RFC 9309). The node reads the robots rules of each host a route calls and doesn't call, list or
//! announce a route whose path a group naming the token disallows (`unbrowse_learn::robots::disallowed_by_name`). A
//! group for `*`, or for another agent, never opts a site out: only the site's word to Unbrowse does.
//!
//! The opt-out is the site's explicit word, so silence never blocks: no robots.txt, a 4xx, a 5xx, a redirect the
//! call's rule refuses, a network error, a timeout, a file over `robots::MAX_ROBOTS_BYTES` or one that doesn't parse
//! all read as "nothing said", and the route is called. (RFC 9309 asks a crawler to treat a 5xx or an unreachable file
//! as a complete disallow; this is no crawler, and a site that can't serve its file has said nothing to Unbrowse.)
//!
//! The file is fetched from the scheme, host and port each of the route's requests goes to (its steps' and its
//! socket's, never another host it names), with the node's ordinary client held to the route's egress rule
//! (`share::egress`: someone else's route reaches public HTTPS addresses only), with no cookie, session or header of the
//! owner's, within [`FETCH_TIMEOUT`]. A host the owner excluded in Settings is never read. A route is judged once,
//! before its first request: every step's path against its host's rules. The node doesn't judge each request as it
//! goes out, nor steps a heal makes during the call, nor the pages a walk or the browser opens.
//!
//! One route reads at most [`MAX_ORIGINS_PER_ROUTE`] hosts, all at once, under one deadline for the whole judgement
//! ([`JUDGE_DEADLINE`]): a read not done by then says nothing, and finishes into the cache for the next call. Someone
//! else's route that sends to more hosts than that isn't called; the node's own route judges the hosts past the bound
//! from what it already read. So one call adds at most `MAX_ORIGINS_PER_ROUTE` hosts to the cache.
//!
//! What a host said is kept in memory per scheme, host and port: an answer for [`OPTOUT_RECHECK`], a failed read for
//! [`FAILED_RETRY`], for at most [`MAX_HOSTS`] hosts (the oldest dropped first). One read per host runs at a time. The
//! cache doesn't outlive the node: at start, before the node announces the bodies it serves (`share::provide_all`), it
//! reads its live listings' and kept bodies' hosts once (`autolist::opted_out`), so a body whose site opted out isn't
//! announced again after a restart. A peer that asks for this node's listings in the seconds between joining the
//! network and the end of that read is answered as if nothing had been read yet.
//!
//! The read leaves the machine the way the route's call does ([`way`]). A call to a pinned site goes through the node's
//! own local proxy (`unbrowse_learn::proxy`), as the call's own client decides (`RouteClient::local_proxy`), and every
//! robots read for that route goes through the same proxy, so the site sees the pinned upstream's address and never
//! this machine's. A pinned host is never read from this machine's own address: when the call doesn't go through the
//! proxy (it isn't up, or the call's rule keeps that route off it), the read isn't made, and that is a failed read like
//! any other (the call goes ahead, and the host is read again after [`FAILED_RETRY`]). Any other host is read directly,
//! never through a proxy from the environment.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use url::Url;

use crate::store;
use crate::sync::Locked;

/// The product token a site names to opt out (R4.32): `User-agent: Unbrowse`, matched case-insensitively.
pub const TOKEN: &str = "Unbrowse";
/// `routes.optout_recheck`: one epoch, in seconds (`chain::EPOCH`, what an epoch is meant to last), the most a host's
/// rules are kept before they are read again. The same 24 hours with no chain deployed.
pub const OPTOUT_RECHECK: u64 = crate::chain::EPOCH;
/// The longest one read of a robots.txt may take, connecting included.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// The most hosts whose rules are kept at once.
pub const MAX_HOSTS: usize = 4_096;
/// The most distinct hosts (scheme, host and port) one route's robots rules are read from. A route calls its site's
/// page or API, often an API host beside it, now and then an auth or asset host: four covers them, and stops a
/// stranger's body from sending the node to knock on a crowd of hosts or from emptying the cache.
pub const MAX_ORIGINS_PER_ROUTE: usize = 4;
/// The most one route's judgement waits for its reads, all of them together: one read's timeout and a little.
pub const JUDGE_DEADLINE: Duration = Duration::from_secs(6);
/// How long a read that failed (no answer, a timeout, a 5xx, a body past the limit) is kept before the host is read
/// again: it allows meanwhile, and a dead host isn't read on every call, nor kept a whole epoch unread.
pub const FAILED_RETRY: u64 = 3_600;

/// Which way one robots read leaves the machine ([`way`]).
#[derive(Clone, Debug, PartialEq)]
pub enum Way {
    /// Straight from this machine's own address, as the route's call goes.
    Direct,
    /// Through the node's local proxy at this address, as the route's call goes.
    Proxy(String),
    /// Not at all: the host is pinned and the call doesn't go through the proxy, so the only way left is this machine's
    /// own address, which a pinned host is never read from. A failed read.
    NotRead,
}

/// Which way the read of `origin`'s robots rules goes, for a route whose call leaves through the node's local proxy at
/// `call` (`RouteClient::local_proxy`: the client's own test of whether the call goes through it), or not (`None`).
/// Through that proxy when the call does. Otherwise directly, unless `origin`'s host is pinned (`pinned`): then not at
/// all, never directly and never through the proxy around the call's own rule.
pub fn way(call: Option<&str>, origin: &str, pinned: impl Fn(&str) -> bool) -> Way {
    if let Some(p) = call {
        return Way::Proxy(p.to_string());
    }
    match Url::parse(origin).ok().as_ref().and_then(Url::host_str) {
        Some(host) if !pinned(&host.to_ascii_lowercase()) => Way::Direct,
        _ => Way::NotRead,
    }
}

/// The robots reads for `route`, each made the way [`way`] says, under the route's `egress`. Whether the call goes through
/// the node's local proxy is asked of the call's own client only when a host the route calls is pinned: otherwise it
/// can't, and the proxy isn't started for it.
fn reads_for(route: &store::Route, egress: unbrowse_learn::egress::Egress) -> Fetch {
    let pinned = |host: &str| unbrowse_learn::proxy::pinned(host).is_some();
    let call = if targets(route).iter().any(|u| u.host_str().is_some_and(pinned)) {
        unbrowse_learn::RouteClient::new(route.graph.clone()).with_egress(egress).local_proxy()
    } else {
        None
    };
    Arc::new(move |o: &str| fetch(o, egress, &way(call.as_deref(), o, pinned)))
}

/// What one read of a host's robots.txt came to.
#[derive(Clone, Debug, PartialEq)]
pub enum Read {
    /// The host answered: its rules, or none (no file, a 4xx, a redirect off the host). Kept `OPTOUT_RECHECK`.
    Answered(Option<String>),
    /// The read failed. Kept `FAILED_RETRY`.
    Failed,
}

/// What a host's robots rules said, as last read: the rules when they name the token at all, else nothing (every path
/// is allowed, and the file isn't kept).
#[derive(Clone)]
struct Said {
    at: u64,
    /// How long it stands from `at`.
    for_secs: u64,
    rules: Option<Arc<str>>,
}

type Slot = Arc<Mutex<Option<Said>>>;

/// Each host's last word, by scheme, host and port, with when its slot was made (for dropping the oldest).
#[derive(Default)]
pub struct Cache {
    hosts: Mutex<HashMap<String, (Slot, u64)>>,
}

impl Cache {
    fn slot(&self, origin: &str, now: u64) -> Slot {
        let mut hosts = self.hosts.locked();
        if let Some((slot, _)) = hosts.get(origin) {
            return slot.clone();
        }
        if hosts.len() >= MAX_HOSTS {
            if let Some(oldest) = hosts.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone()) {
                hosts.remove(&oldest);
            }
        }
        let slot: Slot = Arc::default();
        hosts.insert(origin.to_string(), (slot.clone(), now));
        slot
    }

    /// Whether `origin`'s last word still stands at `now`, read without waiting for a read in flight.
    fn fresh(&self, origin: &str, now: u64) -> bool {
        self.known(origin).is_some_and(|s| now < s.at.saturating_add(s.for_secs))
    }

    fn known(&self, origin: &str) -> Option<Said> {
        let slot = self.hosts.locked().get(origin).map(|(s, _)| s.clone())?;
        let said = slot.try_lock().ok()?.clone();
        said
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.hosts.locked().len()
    }
}

/// The scheme, host and port a URL's robots rules are read from: a socket's from the same host over HTTP(S).
fn origin(url: &Url) -> Option<String> {
    let scheme = match url.scheme() {
        "https" | "wss" => "https",
        "http" | "ws" => "http",
        _ => return None,
    };
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    Some(format!("{scheme}://{host}:{port}"))
}

/// What the caller is told of a path the site opted out of.
fn refusal(url: &Url) -> String {
    format!(
        "{}'s robots rules ask Unbrowse not to call {}: the site opted out of Unbrowse (R4.32), so this node doesn't call, list or announce this route",
        url.host_str().unwrap_or_default(),
        url.path()
    )
}

/// Why `url` may not be called, by the rules `cache` holds for its host, read with `fetch` when none are held or they
/// are [`OPTOUT_RECHECK`] old at `now` ([`FAILED_RETRY`] for a read that failed). `fetch` gets the host's origin
/// (scheme, host and port: the key, so a route's paths and queries never add one) and reads its robots.txt.
#[cfg(test)]
pub fn judge_with(cache: &Cache, url: &Url, now: u64, fetch: impl FnOnce(&str) -> Read) -> Option<String> {
    let said = read_into(cache, &origin(url)?, now, fetch);
    said.and_then(|s| s.rules).filter(|r| unbrowse_learn::robots::disallowed_by_name(r, TOKEN, url)).map(|_| refusal(url))
}

/// Reads `origin`'s rules into `cache` with `fetch` unless what it holds still stands at `now`, and what it holds then.
fn read_into(cache: &Cache, origin: &str, now: u64, fetch: impl FnOnce(&str) -> Read) -> Option<Said> {
    let slot = cache.slot(origin, now);
    // Held while the file is read: one read per host, and a call that comes meanwhile waits for its answer, which the
    // fetch's own timeout bounds.
    let mut held = slot.locked();
    if held.as_ref().is_none_or(|s| now >= s.at.saturating_add(s.for_secs)) {
        let (rules, for_secs) = match fetch(origin) {
            Read::Answered(t) => (t, OPTOUT_RECHECK),
            Read::Failed => (None, FAILED_RETRY),
        };
        // Only rules that name the token at all are kept: the rest say nothing to Unbrowse.
        let rules = rules.filter(|t| t.to_ascii_lowercase().contains(&TOKEN.to_ascii_lowercase()));
        *held = Some(Said { at: now, for_secs, rules: rules.map(Arc::from) });
    }
    held.clone()
}

/// A fetch the judgement may hand to a thread of its own.
pub type Fetch = Arc<dyn Fn(&str) -> Read + Send + Sync>;

/// Why `route` may not be called, judged with `cache` at `now`: its requests' hosts (deduplicated by scheme, host and
/// port), the first [`MAX_ORIGINS_PER_ROUTE`] of them read with `fetch` (those whose rules don't already stand), all at
/// once, waiting at most `deadline` in all; then every request's path judged against what its host's rules say, from
/// the cache. A read still running at the deadline says nothing this time. Someone else's route (`foreign`) with more
/// hosts than the bound is refused and nothing is read; the node's own judges those past it from the cache alone.
/// A host the owner excluded in Settings is never read: such a route is refused by the exclusion, not here.
pub fn refuses_with(cache: &'static Cache, route: &store::Route, foreign: bool, now: u64, deadline: Duration, fetch: Fetch) -> Option<String> {
    if store::excluded_host(route, &store::load_settings().excluded).is_some() {
        return None;
    }
    let urls = targets(route);
    let mut origins: Vec<String> = Vec::new();
    for o in urls.iter().filter_map(origin) {
        if !origins.contains(&o) {
            origins.push(o);
        }
    }
    if foreign && origins.len() > MAX_ORIGINS_PER_ROUTE {
        return Some(format!(
            "this route is another contributor's and sends its requests to {} hosts, more than the {MAX_ORIGINS_PER_ROUTE} whose robots rules this node reads for one route, so it isn't called",
            origins.len()
        ));
    }
    let (done, wait) = std::sync::mpsc::channel();
    let mut reading = 0;
    for o in origins.into_iter().take(MAX_ORIGINS_PER_ROUTE).filter(|o| !cache.fresh(o, now)) {
        let (done, fetch) = (done.clone(), fetch.clone());
        reading += 1;
        // A thread of its own: a read past the deadline finishes into the cache, and never holds this call up.
        std::thread::spawn(move || {
            let _ = read_into(cache, &o, now, |o| fetch(o));
            let _ = done.send(());
        });
    }
    let until = std::time::Instant::now() + deadline;
    for _ in 0..reading {
        if wait.recv_timeout(until.saturating_duration_since(std::time::Instant::now())).is_err() {
            break;
        }
    }
    urls.iter().find_map(|u| known_with(cache, u))
}

/// Why `url` may not be called, by what `cache` already holds of its host: never a read.
fn known_with(cache: &Cache, url: &Url) -> Option<String> {
    let rules = cache.known(&origin(url)?)?.rules?;
    unbrowse_learn::robots::disallowed_by_name(&rules, TOKEN, url).then(|| refusal(url))
}

/// The addresses a route's call sends its requests to, and only those: each step's (its address as learned, values
/// as `{name}`), or its socket's. Never a host named anywhere else in the route, its body or its listing (its root, its
/// site, its path): a stranger's route can't make the node read robots rules of a host it won't call. A step whose
/// host is built at call time (`{name}` in it) names no host to read before then.
fn targets(route: &store::Route) -> Vec<Url> {
    let sent = route.socket.iter().map(|s| s.url.as_str()).chain(route.graph.steps.iter().map(|s| s.url.as_str()));
    let mut out: Vec<Url> = Vec::new();
    for u in sent {
        let Ok(url) = Url::parse(u) else { continue };
        if url.host_str().is_some_and(|h| !h.contains(['{', '}', '%'])) && !out.contains(&url) {
            out.push(url);
        }
    }
    out
}

static CACHE: std::sync::LazyLock<Cache> = std::sync::LazyLock::new(Cache::default);

/// Why this node may not call `route`: the first of the addresses it calls whose host's robots rules opt its path out
/// for Unbrowse, judged as [`refuses_with`] judges them. Blocking, at most [`JUDGE_DEADLINE`].
pub fn refuses(route: &store::Route) -> Option<String> {
    let egress = crate::share::egress(route);
    let foreign = egress != unbrowse_learn::egress::Egress::Own;
    refuses_with(&CACHE, route, foreign, store::now(), JUDGE_DEADLINE, reads_for(route, egress))
}

/// The same, from what the node already read: never a read, so it may be asked anywhere. A host not read yet says
/// nothing. What keeps a listed route from being served or announced (`share::listed_today`).
pub fn known_refusal(route: &store::Route) -> Option<String> {
    targets(route).iter().find_map(|u| known_with(&CACHE, u))
}

/// `refuses`, off the async runtime.
pub async fn refuses_async(route: &store::Route) -> Option<String> {
    let r = route.clone();
    tokio::task::spawn_blocking(move || refuses(&r)).await.ok().flatten()
}

/// Robots texts tests answer for an origin, in place of the network: present means that answer, `None` a host with no
/// file. An origin a test didn't name is read for real only when it is in `READ_IN_TESTS`, so a test site that counts
/// its requests hears none.
#[cfg(test)]
pub static ANSWERS: std::sync::LazyLock<Mutex<HashMap<String, Option<String>>>> = std::sync::LazyLock::new(Default::default);
/// Every origin the node read (or would have read) robots rules of, in a test, with the way the read went (or would
/// have gone): a read that isn't made ([`Way::NotRead`]) is recorded too.
#[cfg(test)]
pub static ASKED: Mutex<Vec<(String, Way)>> = Mutex::new(Vec::new());
#[cfg(test)]
pub static READ_IN_TESTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Redirects a robots read follows: within the one origin only, and no more than five (RFC 9309, 2.3.1.2), each hop
/// held to the call's rule as well. One that leaves the origin isn't followed: its 3xx is the answer, read as no file.
fn same_origin(egress: unbrowse_learn::egress::Egress) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |a| {
        let first = a.previous().first().and_then(origin);
        let from = a.previous().last().and_then(|u| u.host_str()).unwrap_or_default().to_string();
        if a.previous().len() > 5 || first.is_none() || first != origin(a.url()) {
            return a.stop();
        }
        match egress.hop(&from, a.url()) {
            Ok(()) => a.follow(),
            Err(_) => a.stop(),
        }
    })
}

/// Reads `origin`'s robots.txt (module doc) the way `way` says: the node's ordinary client under the route's egress rule
/// (its resolver checks every connection's addresses, every hop's too), through the node's local proxy when the call
/// goes through it, redirects within the origin only (`same_origin`), no cookie store and no header but its user agent
/// (nothing of the owner's: no session, jar or vault value), never the browser. At most `MAX_ROBOTS_BYTES`, refused as
/// it is read, and `FETCH_TIMEOUT` for the whole read. A read that isn't made, and one the proxy doesn't carry, fail.
fn fetch(origin: &str, egress: unbrowse_learn::egress::Egress, way: &Way) -> Read {
    #[cfg(test)]
    {
        ASKED.locked().push((origin.to_string(), way.clone()));
    }
    // A pinned host the call reaches without the proxy is never read from this machine's own address.
    let proxy = match way {
        Way::NotRead => return Read::Failed,
        Way::Proxy(p) => Some(p.as_str()),
        Way::Direct => None,
    };
    #[cfg(test)]
    {
        if let Some(a) = ANSWERS.locked().get(origin) {
            return Read::Answered(a.clone());
        }
        if !READ_IN_TESTS.locked().iter().any(|o| o == origin) {
            return Read::Answered(None);
        }
    }
    let Ok(url) = Url::parse(&format!("{origin}/robots.txt")) else { return Read::Failed };
    if egress.request(&url).is_err() {
        return Read::Answered(None);
    }
    let mut client = unbrowse_learn::tls::blocking_for(egress).redirect(same_origin(egress)).timeout(FETCH_TIMEOUT).connect_timeout(FETCH_TIMEOUT).user_agent(TOKEN);
    if let Some(p) = proxy {
        // The node's own proxy, as the call goes: it resolves and checks the name, and carries a pinned site through its
        // upstream. A proxy that doesn't answer fails the read; it never falls back to this machine's address.
        let Ok(p) = reqwest::Proxy::all(p) else { return Read::Failed };
        client = client.proxy(p);
    }
    let Ok(client) = client.build() else { return Read::Failed };
    let resp = match client.get(url).send() {
        Ok(r) => r,
        Err(_) => return Read::Failed,
    };
    read_answer(resp.status().as_u16(), resp)
}

/// What an answer of `status` says, its body read through `body` up to `MAX_ROBOTS_BYTES`: rules on a 2xx, none on a
/// 3xx left unfollowed or a 4xx, a failed read on a 5xx or a body too large or not text.
fn read_answer(status: u16, body: impl std::io::Read) -> Read {
    match status {
        200..=299 => match unbrowse_learn::egress::read_capped(body, unbrowse_learn::robots::MAX_ROBOTS_BYTES).ok().and_then(|b| String::from_utf8(b).ok()) {
            Some(text) => Read::Answered(Some(text)),
            None => Read::Failed,
        },
        300..=499 => Read::Answered(None),
        _ => Read::Failed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(u: &str) -> Url {
        Url::parse(u).unwrap()
    }

    /// A group naming Unbrowse that disallows the path refuses the call; a `*`-only disallow, or one for another
    /// agent, doesn't; an Allow inside the named group wins over a shorter Disallow.
    #[test]
    fn only_the_sites_word_to_unbrowse_refuses_a_call() {
        let cache = Cache::default();
        let says = |t: &'static str| move |_: &str| Read::Answered(Some(t.to_string()));
        let why = judge_with(&cache, &url("https://shop.example/api/items?q={q}"), 1, says("User-agent: Unbrowse\nDisallow: /api\nAllow: /api/public"));
        assert!(why.as_deref().is_some_and(|w| w.contains("shop.example's robots rules ask Unbrowse not to call /api/items")), "{why:?}");
        assert_eq!(judge_with(&cache, &url("https://shop.example/api/public/x"), 1, |_| unreachable!("kept")), None, "Allow overrides inside the group");
        assert_eq!(judge_with(&Cache::default(), &url("https://a.example/api"), 1, says("User-agent: *\nDisallow: /")), None, "a wildcard disallow");
        assert_eq!(judge_with(&Cache::default(), &url("https://a.example/api"), 1, says("User-agent: GPTBot\nDisallow: /")), None);
    }

    /// Silence is no opt-out: no file, an unreachable host and a file past the limits all allow.
    #[test]
    fn a_missing_unreachable_or_oversized_file_allows() {
        let u = url("https://quiet.example/api");
        assert_eq!(judge_with(&Cache::default(), &u, 1, |_| Read::Answered(None)), None, "no file, or a 4xx");
        assert_eq!(judge_with(&Cache::default(), &u, 1, |_| Read::Failed), None, "a 5xx, a timeout or no answer");
        let huge = format!("User-agent: Unbrowse\nDisallow: /\n{}", " ".repeat(unbrowse_learn::robots::MAX_ROBOTS_BYTES));
        assert_eq!(judge_with(&Cache::default(), &u, 1, move |_| Read::Answered(Some(huge))), None, "a file past the limit");
        assert_eq!(read_answer(200, std::io::repeat(b'x')), Read::Failed, "a body past the limit is refused as it is read");
        assert_eq!(read_answer(200, &b"User-agent: Unbrowse\nDisallow: /"[..]), Read::Answered(Some("User-agent: Unbrowse\nDisallow: /".into())));
        assert_eq!(read_answer(404, &b"x"[..]), Read::Answered(None));
        assert_eq!(read_answer(301, &b""[..]), Read::Answered(None), "a redirect left unfollowed is no file");
        assert_eq!(read_answer(503, &b""[..]), Read::Failed);
        assert_eq!(judge_with(&Cache::default(), &url("ftp://quiet.example/x"), 1, |_| panic!("never read")), None, "not a web address");
    }

    /// A host's rules are read once and kept: read again only once `OPTOUT_RECHECK` has passed. The key is the scheme,
    /// host and port, so another port is another host.
    #[test]
    fn the_rules_are_read_again_only_after_the_recheck() {
        let cache = Cache::default();
        let reads = std::cell::Cell::new(0);
        let u = url("https://shop.example/api");
        let read = |text: &'static str| {
            let reads = &reads;
            move |_: &str| {
                reads.set(reads.get() + 1);
                Read::Answered(Some(text.to_string()))
            }
        };
        assert!(judge_with(&cache, &u, 100, read("User-agent: Unbrowse\nDisallow: /api")).is_some());
        assert!(judge_with(&cache, &u, 100 + OPTOUT_RECHECK - 1, read("")).is_some(), "kept within the recheck");
        assert_eq!(reads.get(), 1);
        assert_eq!(judge_with(&cache, &u, 100 + OPTOUT_RECHECK, read("User-agent: Unbrowse\nAllow: /")), None, "read again: the site took it back");
        assert_eq!(reads.get(), 2);
        assert!(judge_with(&cache, &url("https://shop.example:8443/api"), 100, read("")).is_none());
        assert_eq!(reads.get(), 3, "another port is another host");
        assert!(known_with(&cache, &url("https://shop.example/api")).is_none(), "what was read last stands");
        let fresh = Cache::default();
        assert!(known_with(&fresh, &u).is_none(), "a host not read says nothing");
        let _ = judge_with(&fresh, &u, 1, read("User-agent: unbrowse\nDisallow: /"));
        assert!(known_with(&fresh, &u).is_some(), "and once read, it is known without a read");
    }

    /// A read that failed is kept too, for `FAILED_RETRY`: a dead host isn't read on every call.
    #[test]
    fn a_failed_read_is_kept_for_the_retry() {
        let cache = Cache::default();
        let u = url("https://dead.example/x");
        let reads = std::cell::Cell::new(0);
        let fail = |_: &str| {
            reads.set(reads.get() + 1);
            Read::Failed
        };
        for at in [10, 11, 10 + FAILED_RETRY - 1] {
            assert_eq!(judge_with(&cache, &u, at, fail), None);
        }
        assert_eq!(reads.get(), 1);
        assert_eq!(judge_with(&cache, &u, 10 + FAILED_RETRY, fail), None);
        assert_eq!(reads.get(), 2, "read again after the retry, well before the recheck");
    }

    /// The key is the scheme, host and port alone: a route's paths and queries, however many, add no host.
    #[test]
    fn paths_and_queries_never_add_a_key() {
        let cache = Cache::default();
        for i in 0..500 {
            let _ = judge_with(&cache, &url(&format!("https://one.example/p{i}/x?q={i}&r={i}#f{i}")), 1, |_| Read::Answered(None));
        }
        assert_eq!(cache.len(), 1);
        let _ = judge_with(&cache, &url("http://one.example/"), 1, |_| Read::Answered(None));
        assert_eq!(cache.len(), 2, "another scheme is another origin");
    }

    /// The robots read follows a redirect within its origin only: one to another host, port or scheme is not followed,
    /// and its 3xx reads as no file. Against two real local servers, the second of which would opt the path out.
    #[test]
    fn a_redirect_off_the_origin_is_not_followed() {
        use std::io::{BufRead, Write};
        let serve = |answer: Box<dyn Fn(&str) -> String + Send>| {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            let hits = Arc::new(Mutex::new(Vec::<String>::new()));
            let seen = hits.clone();
            std::thread::spawn(move || {
                for stream in l.incoming().flatten() {
                    let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                    let mut first = String::new();
                    let _ = reader.read_line(&mut first);
                    let mut headers = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        headers.push_str(&line.to_ascii_lowercase());
                    }
                    seen.locked().push(format!("{}{headers}", first.trim()));
                    let mut out = stream;
                    let _ = out.write_all(answer(first.trim()).as_bytes());
                }
            });
            (port, hits)
        };
        let deny = "User-agent: Unbrowse\nDisallow: /";
        let ok = move |_: &str| format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{deny}", deny.len());
        let (elsewhere, elsewhere_hits) = serve(Box::new(ok));
        let (port, hits) = serve(Box::new(move |line: &str| {
            let to = if line.contains("/robots.txt") { format!("http://127.0.0.1:{elsewhere}/robots.txt") } else { "/robots.txt".into() };
            format!("HTTP/1.1 301 Moved\r\nlocation: {to}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        }));
        let origin = format!("http://127.0.0.1:{port}");
        assert_eq!(fetch_for_real(&origin), Read::Answered(None), "off-site: not followed, no file");
        assert!(elsewhere_hits.locked().is_empty(), "the other origin heard nothing");
        let sent = hits.locked().join("\n");
        assert!(!sent.contains("cookie") && !sent.contains("authorization"), "nothing of the owner's: {sent}");
        assert!(sent.contains("user-agent: unbrowse"), "{sent}");
        // Within the origin, followed.
        let (same, _) = serve(Box::new(move |line: &str| {
            if line.contains("/real.txt") {
                format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{deny}", deny.len())
            } else {
                "HTTP/1.1 302 Found\r\nlocation: /real.txt\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".into()
            }
        }));
        assert_eq!(fetch_for_real(&format!("http://127.0.0.1:{same}")), Read::Answered(Some(deny.into())));
    }

    /// `fetch`, past the test answers: the network read itself, made directly.
    fn fetch_for_real(origin: &str) -> Read {
        fetch_for_real_by(origin, &Way::Direct)
    }

    /// The same, made the way `way` says.
    fn fetch_for_real_by(origin: &str, way: &Way) -> Read {
        READ_IN_TESTS.locked().push(origin.to_string());
        fetch(origin, unbrowse_learn::egress::Egress::Own, way)
    }

    /// A listener on loopback that records each connection it takes and answers `reply` to it: its port and the record.
    fn listen(reply: &'static [u8]) -> (u16, Arc<Mutex<Vec<String>>>) {
        use std::io::{Read as _, Write};
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let hits: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = hits.clone();
        std::thread::spawn(move || {
            for mut stream in l.incoming().flatten() {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                let mut first = [0u8; 4096];
                let n = stream.read(&mut first).unwrap_or(0);
                seen.locked().push(String::from_utf8_lossy(&first[..n]).into_owned());
                let _ = stream.write_all(reply);
            }
        });
        (port, hits)
    }

    /// A pinned host's robots rules are never read from this machine's own address. The way follows the route's call:
    /// through the node's local proxy when the client sends the call through it, every host of the route; when it
    /// doesn't, a pinned host isn't read at all (a failed read: the call goes ahead, and the host is read again after
    /// `FAILED_RETRY`), and an unpinned one directly. Judged through `refuses_with` and the read itself: the seam records
    /// which way each read went, the site's own server hears nothing for a read through the proxy or not made, and a read
    /// through the proxy reaches the proxy.
    #[test]
    fn a_pinned_hosts_rules_are_never_read_from_this_machines_own_address() {
        let pinned = |h: &str| h.ends_with("pinned.optout-way.example");
        let (shop, api) = ("https://shop.pinned.optout-way.example:443", "https://api.elsewhere.optout-way.example:443");
        assert_eq!(way(Some("socks5h://127.0.0.1:9"), shop, pinned), Way::Proxy("socks5h://127.0.0.1:9".into()), "the call goes through the proxy");
        assert_eq!(way(Some("socks5h://127.0.0.1:9"), api, pinned), Way::Proxy("socks5h://127.0.0.1:9".into()), "every host of that route with it");
        assert_eq!(way(None, shop, pinned), Way::NotRead, "pinned, and the call isn't through the proxy: not read");
        assert_eq!(way(None, "https://SHOP.pinned.optout-way.example:443", pinned), Way::NotRead, "whatever its case");
        assert_eq!(way(None, api, pinned), Way::Direct, "an unpinned host, read as its call goes");
        assert_eq!(way(None, "not an origin", pinned), Way::NotRead, "nothing to read directly");

        // Through a route's judgement: the pinned host opts out, but isn't read, so the call isn't refused for it.
        ANSWERS.locked().insert(shop.into(), Some("User-agent: Unbrowse\nDisallow: /".into()));
        ANSWERS.locked().insert(api.into(), None);
        let route = route_to(&["shop.pinned.optout-way.example", "api.elsewhere.optout-way.example"]);
        let ways: Fetch = Arc::new(move |o: &str| fetch(o, unbrowse_learn::egress::Egress::Own, &way(None, o, pinned)));
        assert_eq!(refuses_with(leaked(), &route, false, 1, JUDGE_DEADLINE, ways), None, "a read not made says nothing");
        let asked: Vec<(String, Way)> = ASKED.locked().iter().filter(|(o, _)| o.contains("optout-way")).cloned().collect();
        assert!(asked.contains(&(shop.into(), Way::NotRead)), "{asked:?}");
        assert!(asked.contains(&(api.into(), Way::Direct)), "{asked:?}");
        assert!(!asked.iter().any(|(o, w)| o == shop && *w == Way::Direct), "never directly: {asked:?}");

        // The read itself: one not made reaches no one and fails; one through the proxy reaches the proxy, never the
        // site's own address, and a proxy that doesn't carry it fails it there.
        let (site, site_hits) = listen(b"HTTP/1.1 200 OK\r\ncontent-length: 32\r\nconnection: close\r\n\r\nUser-agent: Unbrowse\nDisallow: /");
        let origin = format!("http://127.0.0.1:{site}");
        assert_eq!(fetch_for_real_by(&origin, &Way::NotRead), Read::Failed);
        let (proxy, proxy_hits) = listen(b"");
        assert_eq!(fetch_for_real_by(&origin, &Way::Proxy(format!("socks5h://127.0.0.1:{proxy}"))), Read::Failed, "the proxy didn't carry it");
        assert!(!proxy_hits.locked().is_empty(), "the read went to the proxy");
        assert!(site_hits.locked().is_empty(), "the site's own address heard nothing: {:?}", site_hits.locked());
        assert_eq!(fetch_for_real(&origin), Read::Answered(Some("User-agent: Unbrowse\nDisallow: /".into())), "and directly, an unpinned host's is read");
    }

    /// A stranger's route makes the node read robots rules only of the hosts its requests go to: never one named in
    /// its root, its site or its path, nor one whose host is built at call time.
    #[test]
    fn only_the_hosts_a_route_sends_to_are_read() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://api.sends-to.example/v1/items", "needs_browser": false, "fields": [] },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://{tenant}.built-later.example/v1", "needs_browser": false, "fields": [] }
        ] }))
        .unwrap();
        let mut route = store::Route::from_graph("r".into(), "search".into(), "https://root-only.example/page".into(), graph).unwrap();
        route.site = "site-only.example".into();
        route.path = "https://path-only.example/x".into();
        let hosts: Vec<String> = targets(&route).iter().filter_map(|u| u.host_str().map(String::from)).collect();
        assert_eq!(hosts, ["api.sends-to.example"]);
        let _ = refuses(&route);
        let asked: Vec<String> = ASKED.locked().iter().map(|(o, _)| o.clone()).collect();
        assert!(asked.iter().any(|o| o == "https://api.sends-to.example:443"));
        assert!(!asked.iter().any(|o| o.contains("root-only") || o.contains("site-only") || o.contains("path-only") || o.contains("built-later")), "{asked:?}");
    }

    /// A route whose steps go to `hosts`, one step each (two on the first host, on two paths).
    fn route_to(hosts: &[&str]) -> store::Route {
        let mut steps: Vec<serde_json::Value> = hosts
            .iter()
            .enumerate()
            .map(|(i, h)| serde_json::json!({ "exchange": i, "method": "GET", "status": 200, "url": format!("https://{h}/api/{i}"), "needs_browser": false, "fields": [] }))
            .collect();
        steps.push(serde_json::json!({ "exchange": hosts.len(), "method": "GET", "status": 200, "url": format!("https://{}/other", hosts[0]), "needs_browser": false, "fields": [] }));
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": steps })).unwrap();
        store::Route::from_graph("r".into(), "search".into(), format!("https://{}/", hosts[0]), graph).unwrap()
    }

    /// A fetch that counts its reads and answers `text` for every host.
    fn counting(text: Option<&'static str>, wait: Duration) -> (Fetch, Arc<Mutex<Vec<String>>>) {
        let asked: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = asked.clone();
        let f: Fetch = Arc::new(move |o: &str| {
            seen.locked().push(o.to_string());
            std::thread::sleep(wait);
            Read::Answered(text.map(String::from))
        });
        (f, asked)
    }

    fn leaked() -> &'static Cache {
        Box::leak(Box::default())
    }

    /// Two steps on one host are one read, whatever their paths; each path is still judged.
    #[test]
    fn a_host_is_read_once_however_many_steps_go_to_it() {
        let cache = leaked();
        let (f, asked) = counting(Some("User-agent: Unbrowse\nDisallow: /other"), Duration::ZERO);
        let why = refuses_with(cache, &route_to(&["one.bound.example"]), false, 1, JUDGE_DEADLINE, f).expect("the second step's path");
        assert!(why.contains("/other"), "{why}");
        assert_eq!(asked.locked().len(), 1);
    }

    /// Someone else's route that sends to more hosts than the bound isn't called, and no host is read. The node's own
    /// reads the first `MAX_ORIGINS_PER_ROUTE` and judges the rest from the cache alone: a host past the bound whose
    /// opt-out is already known still refuses, and one not known says nothing. One call adds at most the bound.
    #[test]
    fn a_route_reads_at_most_the_bound_of_hosts() {
        let hosts = ["h0.bound.example", "h1.bound.example", "h2.bound.example", "h3.bound.example", "h4.bound.example", "h5.bound.example"];
        let cache = leaked();
        let (f, asked) = counting(None, Duration::ZERO);
        let why = refuses_with(cache, &route_to(&hosts), true, 1, JUDGE_DEADLINE, f.clone()).expect("refused");
        assert!(why.contains("6 hosts") && why.contains("more than the 4"), "{why}");
        assert!(asked.locked().is_empty() && cache.len() == 0, "nothing read, nothing kept");

        assert_eq!(refuses_with(cache, &route_to(&hosts), false, 1, JUDGE_DEADLINE, f.clone()), None);
        assert_eq!(asked.locked().len(), MAX_ORIGINS_PER_ROUTE, "the node's own route reads the bound");
        assert_eq!(cache.len(), MAX_ORIGINS_PER_ROUTE, "and adds no more to the cache");
        assert!(!asked.locked().iter().any(|o| o.contains("h4") || o.contains("h5")));
        // h5's opt-out, read before by another route, refuses from the cache.
        let _ = judge_with(cache, &url("https://h5.bound.example/api/5"), 1, |_| Read::Answered(Some("User-agent: Unbrowse\nDisallow: /".into())));
        let why = refuses_with(cache, &route_to(&hosts), false, 2, JUDGE_DEADLINE, f).expect("from the cache");
        assert!(why.contains("h5.bound.example"), "{why}");
        assert_eq!(asked.locked().len(), MAX_ORIGINS_PER_ROUTE, "the first four still stand: nothing read again");
    }

    /// Slow hosts can't hold a call past the deadline: their reads say nothing this time, and finish into the cache.
    #[test]
    fn slow_hosts_cannot_stall_a_call_past_the_deadline() {
        let cache = leaked();
        let (f, asked) = counting(Some("User-agent: Unbrowse\nDisallow: /"), Duration::from_millis(1_500));
        let route = route_to(&["s0.slow.example", "s1.slow.example", "s2.slow.example", "s3.slow.example"]);
        let started = std::time::Instant::now();
        assert_eq!(refuses_with(cache, &route, false, 1, Duration::from_millis(200), f.clone()), None, "nothing said in time");
        assert!(started.elapsed() < Duration::from_millis(1_000), "{:?}: one deadline, not one per host", started.elapsed());
        std::thread::sleep(Duration::from_millis(1_800));
        assert_eq!(asked.locked().len(), 4, "the four were read at once");
        assert!(refuses_with(cache, &route, false, 1, Duration::from_millis(200), f).is_some(), "the reads finished into the cache");
        assert_eq!(asked.locked().len(), 4);
    }

    /// A host the owner excluded in Settings is never read, whoever asks: the route is refused by the exclusion.
    #[test]
    fn an_excluded_host_is_never_read() {
        let _home = store::scratch_home("optout-excluded");
        store::save_settings(&store::Settings { excluded: vec!["excluded.bound.example".into()], ..store::load_settings() }).unwrap();
        let (f, asked) = counting(Some("User-agent: Unbrowse\nDisallow: /"), Duration::ZERO);
        assert_eq!(refuses_with(leaked(), &route_to(&["api.excluded.bound.example", "fine.bound.example"]), false, 1, JUDGE_DEADLINE, f), None);
        assert!(asked.locked().is_empty(), "{:?}", asked.locked());
    }

    /// The cache holds at most `MAX_HOSTS`, dropping the oldest.
    #[test]
    fn the_cache_is_bounded() {
        let cache = Cache::default();
        for i in 0..MAX_HOSTS + 10 {
            let _ = judge_with(&cache, &url(&format!("https://h{i}.example/")), i as u64, |_| Read::Answered(None));
        }
        assert_eq!(cache.len(), MAX_HOSTS);
        assert!(cache.known("https://h0.example:443").is_none(), "the oldest went");
        assert!(cache.known(&format!("https://h{}.example:443", MAX_HOSTS + 9)).is_some());
    }

    /// Every address a route calls is judged: its steps', each against its own host's rules.
    #[test]
    fn every_host_a_route_calls_is_judged() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://www.optout-steps.example/search", "needs_browser": false, "fields": [] },
            { "exchange": 1, "method": "GET", "status": 200, "url": "https://api.optout-steps.example/v1/items?q={q}", "needs_browser": false, "fields": [] }
        ] }))
        .unwrap();
        let route = store::Route::from_graph("r".into(), "search".into(), "https://www.optout-steps.example/search".into(), graph).unwrap();
        assert_eq!(targets(&route).len(), 2);
        ANSWERS.locked().insert("https://api.optout-steps.example:443".into(), Some("User-agent: Unbrowse\nDisallow: /v1".into()));
        ANSWERS.locked().insert("https://www.optout-steps.example:443".into(), None);
        let why = refuses(&route).expect("the API host opted out");
        assert!(why.contains("api.optout-steps.example") && why.contains("/v1/items"), "{why}");
        assert!(known_refusal(&route).is_some());
    }
}
