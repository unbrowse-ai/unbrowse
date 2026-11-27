//! How a site's check is passed without a browser: the request the check's page sends with the token a solver
//! answers, learned the one time the node met the check in its browser (`unbrowse_challenge` solve), and sent again by
//! the node's own transport when a call meets the same check (`clearer`, the `Solver` source against a wall).
//!
//! Propose from the walk, let the site verify. The request is kept as the page sent it, each value read for where it
//! came from: the token, a value the check's own address carries, or a short constant. A value the walk can't source
//! (a long signature the page's own code made) is left out. The site is the judge: a redemption it answers without
//! setting the pass it set before has earned nothing, and the call's wall stays an honest wall.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use unbrowse_learn::client::Clearer;
use unbrowse_learn::refusal::{Cleared, Source, Wall};
use unbrowse_learn::replay::{Fetch, Request};
use url::Url;

use crate::store;

/// The request that redeems a solver's token for a site's pass.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Redemption {
    pub method: String,
    /// Where it goes, relative to the check's own document (or whole, when it goes to another origin).
    pub to: String,
    pub content_type: String,
    pub fields: Vec<Field>,
    /// The cookies the site set in answer: the pass a redemption earns.
    pub earns: Vec<String>,
}

/// One field of a redemption's form, and where its value comes from.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    #[serde(flatten)]
    pub from: Slot,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
pub enum Slot {
    /// The solver's token, as it is.
    Token,
    /// A JSON object holding the token under `key`, with the short constants the page sent beside it.
    TokenIn { key: String, with: Map<String, Value> },
    /// A value the check's own address carries, by its name there.
    Address { param: String },
    /// A short constant, as the page sent it.
    Said { value: String },
}

/// The longest value read as a constant: longer, a value the walk can't source is something the page computed.
const SHORT: usize = 32;

/// A redemption read from a request the check's page sent after `token` was handed to it at `check` (the document the
/// check is in): the request's method, address, form body and the names of the cookies its answer set. `None` for a
/// request that isn't one: no form body, nothing set in answer, or no token in it.
pub fn propose(check: &Url, token: &str, method: &str, url: &Url, content_type: &str, body: &str, set: &[String]) -> Option<Redemption> {
    if !content_type.to_ascii_lowercase().contains("x-www-form-urlencoded") || set.is_empty() || token.is_empty() {
        return None;
    }
    let asked: Vec<(String, String)> = check.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let mut fields = Vec::new();
    let mut carries = false;
    for (name, value) in url::form_urlencoded::parse(body.as_bytes()) {
        let from = if value == token {
            carries = true;
            Slot::Token
        } else if let Some((key, with)) = token_in(&value, token) {
            carries = true;
            Slot::TokenIn { key, with }
        } else if let Some((n, _)) = asked.iter().find(|(_, v)| !v.is_empty() && *v == value) {
            Slot::Address { param: n.clone() }
        } else if value.len() <= SHORT {
            Slot::Said { value: value.into_owned() }
        } else {
            continue;
        };
        fields.push(Field { name: name.into_owned(), from });
    }
    if !carries {
        return None;
    }
    let to = (check.origin() == url.origin()).then(|| check.make_relative(url)).flatten().unwrap_or_else(|| url.to_string());
    Some(Redemption { method: method.to_ascii_uppercase(), to, content_type: content_type.to_string(), fields, earns: set.to_vec() })
}

/// The token's place in a JSON object a field holds, and the short constants beside it.
fn token_in(value: &str, token: &str) -> Option<(String, Map<String, Value>)> {
    let Value::Object(o) = serde_json::from_str::<Value>(value).ok()? else { return None };
    let key = o.iter().find(|(_, v)| v.as_str() == Some(token)).map(|(k, _)| k.clone())?;
    let with = o
        .into_iter()
        .filter(|(k, v)| *k != key && (matches!(v, Value::Bool(_) | Value::Number(_)) || v.as_str().is_some_and(|s| s.len() <= SHORT)))
        .collect();
    Some((key, with))
}

impl Redemption {
    /// The request for `token` against the check at `check`: its address and its form body. `None` when the check's
    /// address lacks a value the request takes from it.
    pub fn request(&self, check: &Url, token: &str) -> Option<(Url, String)> {
        let url = check.join(&self.to).ok()?;
        let asked: HashMap<String, String> = check.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        for f in &self.fields {
            let value = match &f.from {
                Slot::Token => token.to_string(),
                Slot::TokenIn { key, with } => {
                    let mut o = Map::new();
                    o.insert(key.clone(), Value::String(token.to_string()));
                    o.extend(with.clone());
                    serde_json::to_string(&Value::Object(o)).ok()?
                }
                Slot::Address { param } => asked.get(param)?.clone(),
                Slot::Said { value } => value.clone(),
            };
            form.append_pair(&f.name, &value);
        }
        Some((url, form.finish()))
    }
}

fn path(site: &str) -> PathBuf {
    store::home().join("redemptions").join(format!("{site}.json"))
}

/// The redemptions learned for `site`, the newest first.
pub fn load(site: &str) -> Vec<Redemption> {
    store::read_json(&path(site), &unbrowse_files::REDEMPTIONS)
}

/// Keeps `r` for `site`, first, in place of one that goes to the same address the same way.
pub fn keep(site: &str, r: Redemption) {
    let mut all = load(site);
    all.retain(|o| !(o.method == r.method && o.to == r.to));
    all.insert(0, r);
    all.truncate(4);
    if let Err(e) = store::write_json(&path(site), &unbrowse_files::REDEMPTIONS, &all) {
        eprintln!("   [redeem] {site}: not kept: {e}");
    }
}

/// The cookies an answer set, by name, with each one's `Max-Age` where it gave one.
fn cookies_set(headers: &[(String, String)]) -> Vec<(String, String, Option<u64>)> {
    headers
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
        .flat_map(|(_, v)| v.split('\n'))
        .filter_map(|line| {
            let mut parts = line.split(';');
            let (name, value) = parts.next()?.split_once('=')?;
            let age = parts.filter_map(|a| a.trim().split_once('=')).find(|(k, _)| k.eq_ignore_ascii_case("max-age")).and_then(|(_, v)| v.trim().parse().ok());
            Some((name.trim().to_string(), value.trim().to_string(), age))
        })
        .filter(|(n, _, _)| !n.is_empty())
        .collect()
}

/// The names of the cookies set by `set-cookie` header values (`name=value; attributes`, one cookie a value).
pub fn names_set(values: &[String]) -> Vec<String> {
    cookies_set(&values.iter().map(|v| ("set-cookie".to_string(), v.clone())).collect::<Vec<_>>()).into_iter().map(|(n, _, _)| n).collect()
}

/// The most documents read on the way to the check: the page the wall named, and the frames of its site under it.
const PAGES_MOST: usize = 4;

/// What the clearer's requests leave with: the cookies the site set on the way, sent back as a browser would.
struct Visit<'a> {
    net: &'a mut dyn Fetch,
    jar: BTreeMap<String, String>,
    /// Each cookie's life, where the site said.
    ages: HashMap<String, u64>,
}

impl Visit<'_> {
    fn send(&mut self, method: &str, url: &Url, headers: Vec<(String, String)>, body: Option<String>) -> Option<unbrowse_learn::trace::Exchange> {
        let mut headers = headers;
        if !self.jar.is_empty() {
            headers.push(("cookie".into(), self.jar.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")));
        }
        let req = Request { method: method.into(), url: url.clone(), exchange: 0, headers, body: body.map(String::into_bytes) };
        let got = self.net.fetch(&req).map_err(|e| eprintln!("   [redeem] {url}: {e}")).ok()?;
        for (name, value, age) in cookies_set(&got.response_headers) {
            if let Some(a) = age {
                self.ages.insert(name.clone(), a);
            }
            self.jar.insert(name, value);
        }
        Some(got)
    }

    /// The check, and the document it is in: the page the wall named, or a frame of its site under it.
    fn find(&mut self, start: &Url) -> Option<(crate::solver::Check, Url)> {
        let mut queue = vec![start.clone()];
        let mut seen = 0;
        while let Some(at) = queue.first().cloned() {
            queue.remove(0);
            seen += 1;
            if seen > PAGES_MOST {
                break;
            }
            let page = vec![("accept".to_string(), "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8".to_string())];
            let got = self.send("GET", &at, page, None)?;
            let html = got.response_body.clone().unwrap_or_default();
            if let Some(check) = crate::solver::check_in_html(&html, &got.url) {
                return Some((check, got.url));
            }
            queue.extend(crate::solver::frames_in_html(&html, &got.url));
        }
        None
    }
}

/// The solver as a source against a wall on `host`'s calls: the wall's check page is read over the node's own
/// transport for the check, the solver answers it, and the redemption this node learned for the site is sent with
/// the token. What the site set in answer is the pass. Nothing, when the node has learned no redemption for the site
/// or has no solver: the wall is met by the next source, or stands.
/// The least time between two of the solver's clears of one site. A wall that is back sooner is the site turning the
/// caller away after a pass, which a second pass only deepens: it is left to time, not solved again.
pub const SPACING: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// When the solver last cleared each site, while the node runs.
static CLEARED: std::sync::Mutex<BTreeMap<String, std::time::Instant>> = std::sync::Mutex::new(BTreeMap::new());

/// Whether the solver may clear a site it last cleared at `last`, now.
fn spaced(last: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    last.is_none_or(|at| now.saturating_duration_since(at) >= SPACING)
}

pub fn clearer(host: String, browser: bool) -> Clearer {
    clearer_with(
        host,
        browser,
        || crate::solver::configured().map(|s| -> Token { Box::new(move |check| s.token_for(check)) }),
        // The transport the site's calls go out over (`client::presenting`): the browser the jar's sample names and the
        // address a pinned host leaves from, so the pass is earned by the client that will send it.
        |host| unbrowse_learn::client::presenting(Some(host), &store::jars_dir(), unbrowse_learn::egress::Egress::Own, None).map(|n| Box::new(n) as Box<dyn Fetch>).map_err(|e| e.to_string()),
        crate::challenge::solve_in_the_nodes_browser,
    )
}

/// A token for a check, from the node's solver.
pub type Token = Box<dyn FnMut(&crate::solver::Check) -> Result<String, String>>;

/// What a solve in the node's browser hands back: what it did, and the site's cookies with when each runs out.
pub type Met = Result<(String, Vec<(String, String, Option<f64>)>), String>;

/// [`clearer`], with the solver it asks (`solver`, none when the node has none), the transport it reads and redeems
/// over (`net`, for the host) and the solve in the node's own browser (`meet`) given to it.
pub fn clearer_with(
    host: String,
    browser: bool,
    solver: impl Fn() -> Option<Token> + Send + 'static,
    net: impl Fn(&str) -> Result<Box<dyn Fetch>, String> + Send + 'static,
    meet: impl Fn(&str) -> Met + Send + 'static,
) -> Clearer {
    Box::new(move |wall| {
        let site = unbrowse_learn::identity::site_of(&host);
        let last = CLEARED.lock().unwrap_or_else(|p| p.into_inner()).get(&site).copied();
        if !spaced(last, std::time::Instant::now()) {
            eprintln!("   [redeem] {site}: cleared {} min ago and walled again already: not solved again before {} min have passed", last.map(|l| l.elapsed().as_secs() / 60).unwrap_or_default(), SPACING.as_secs() / 60);
            return None;
        }
        let kept = load(&site);
        let mut token = solver()?;
        // With no redemption that earns the pass, the check is met in the node's own browser where the call may open it.
        let mut in_browser = |url: &str| -> Option<Cleared> {
            match meet(url) {
                Ok((line, cookies)) => {
                    eprintln!("   [redeem] {site}: met in the node's browser: {line}");
                    let earns = load(&site).first().map(|r| r.earns.clone()).unwrap_or_default();
                    Some(in_the_browser(cookies, &earns, now()))
                }
                Err(e) => {
                    eprintln!("   [redeem] {site}: not met in the node's browser: {e}");
                    None
                }
            }
        };
        let mut net = match net(&host) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("   [redeem] {site}: no transport: {e}");
                return None;
            }
        };
        let browse: Option<&mut dyn FnMut(&str) -> Option<Cleared>> = if browser { Some(&mut in_browser) } else { None };
        let pass = clear_with(wall, &kept, net.as_mut(), &mut |check| token(check).map_err(|e| eprintln!("   [redeem] {site}: no token: {e}")).ok(), browse);
        if pass.is_some() {
            CLEARED.lock().unwrap_or_else(|p| p.into_inner()).insert(site.clone(), std::time::Instant::now());
        }
        pass
    })
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or_default()
}

/// The pass a solve in the node's browser earned: the site's cookies there, and the life of the ones a redemption
/// earns (`earns`, the soonest to run out), when the solve kept one and the browser said when they run out.
fn in_the_browser(cookies: Vec<(String, String, Option<f64>)>, earns: &[String], now: f64) -> Cleared {
    let ttl = cookies.iter().filter(|(n, _, _)| earns.contains(n)).filter_map(|(_, _, e)| *e).map(|e| (e - now).max(0.0) as u64).min();
    Cleared { browser: true, cookies: cookies.into_iter().map(|(n, v, _)| (n, v)).collect(), ttl, bound_to: None, by: Some(Source::Solver) }
}

/// [`clearer`]'s work over `net`, with `token` answering a check: the wall's page read for the check, each redemption
/// tried with the token until the site sets what one earned before; and, where none earns it and `in_browser` is
/// given, the check met there instead.
pub fn clear_with(wall: &Wall, kept: &[Redemption], net: &mut dyn Fetch, token: &mut dyn FnMut(&crate::solver::Check) -> Option<String>, in_browser: Option<&mut dyn FnMut(&str) -> Option<Cleared>>) -> Option<Cleared> {
    let Wall::Check { url } = wall else { return None };
    let start = Url::parse(url).ok()?;
    let mut visit = Visit { net, jar: BTreeMap::new(), ages: HashMap::new() };
    // The page is read before anything is spent on it: one that holds no check is the site's word that it won't
    // answer this caller, which no token passes and only time clears.
    let Some((check, at)) = visit.find(&start) else {
        eprintln!("   [redeem] {}: the page the call was sent to holds no check to pass: the site said no, and only time clears that", start.host_str().unwrap_or_default());
        return None;
    };
    if let Some(pass) = (!kept.is_empty()).then(|| redeemed(&mut visit, &check, &at, kept, token)).flatten() {
        return Some(pass);
    }
    in_browser.and_then(|meet| meet(url))
}

/// The pass a kept redemption earns for `check`, found at `at`, over the visit's transport.
fn redeemed(visit: &mut Visit, check: &crate::solver::Check, at: &Url, kept: &[Redemption], token: &mut dyn FnMut(&crate::solver::Check) -> Option<String>) -> Option<Cleared> {
    let at = at.clone();
    let token = token(check)?;
    for r in kept {
        let Some((to, body)) = r.request(&at, &token) else { continue };
        let headers = vec![
            ("content-type".to_string(), r.content_type.clone()),
            ("accept".to_string(), "*/*".to_string()),
            ("origin".to_string(), at.origin().ascii_serialization()),
            ("referer".to_string(), at.to_string()),
        ];
        let Some(got) = visit.send(&r.method, &to, headers, Some(body)) else { continue };
        let set: Vec<String> = cookies_set(&got.response_headers).into_iter().map(|(n, _, _)| n).collect();
        if !r.earns.iter().any(|e| set.contains(e)) {
            eprintln!("   [redeem] {}: the site took the token at {to} and set nothing it set before ({})", at.host_str().unwrap_or_default(), got.status);
            continue;
        }
        let ttl = r.earns.iter().filter_map(|e| visit.ages.get(e)).min().copied();
        return Some(Cleared { browser: false, cookies: visit.jar.clone(), ttl, bound_to: None, by: Some(Source::Solver) });
    }
    None
}

#[cfg(test)]
#[path = "redeem_tests.rs"]
mod tests;
