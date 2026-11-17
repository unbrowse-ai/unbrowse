//! Sharing the routes the node learns, by itself, with the owner able to say no (`share_routes`, a route's own
//! `share`). Listing writes nothing to the chain (R2.15): a listing is signed and spread, under a root this node posts
//! or the reserve's poster posts for it (R2.20). In the default mode (`used`) a route is listed once the
//! node's agents have shown they keep using it, the most used first, and in every mode the node lists a few routes a
//! pass and a bounded number a day.
//!
//! A route is listed only when all of these hold:
//! - it has run successfully through this node: a recording that never worked is never published;
//! - in `used` mode it has earned it ([`earned`]): passed on [`DAYS_EARNED`] different days, or [`RUNS_EARNED`] times;
//! - nothing the owner said keeps it off: the mode isn't `off`, its own `share` isn't `false`, no host it reaches is
//!   excluded, and it isn't one they delisted before (a delisted route comes back only when they share it again);
//! - the owner has signed in (R1.35), and the route was learned after: a route learned before the sign-in stays on
//!   the node for good (R2.8, `Route::local`);
//! - the owner has been shown which routes the node will share, before its first listing (`share_status`, R2.8);
//! - it can be shared at all: not another contributor's body, and its body carries nothing of the session (a route
//!   learned from the owner's own browsing is shared as its recipe, with placeholders, spec §72.1) (`recipe::of_route` refuses one that would, and that refusal stands);
//! - the node can list: its key is unlocked, it is on the peer network, Settlement is deployed on its chain, and its
//!   key can pay a root's gas, unless it sends its leaves to the reserve's poster, when it needs none (spec §76 item
//!   2). When it can't pay, it says so once and waits; the funds arriving resume it.
//!
//! Turning sharing off delists nothing: what is listed stays until the owner delists it (`delist_route`, one route;
//! `delist_all`, every one).

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store::{self, Route, Settings, ShareMode};
use crate::{chain, recipe, Node};
use crate::sync::Locked;

/// In `used` mode, a route that passed on this many different days has earned a listing.
pub const DAYS_EARNED: u32 = 3;
/// Or one that passed this many times, whatever the days.
pub const RUNS_EARNED: u64 = 5;
/// Routes listed at most in one pass of the background loop (once a minute): a first run with many routes waiting
/// spreads its writes out.
pub const PER_TICK: usize = 2;
/// How long a route whose listing failed (not for gas) waits before it is tried again.
const RETRY_AFTER: u64 = 3_600;

/// Why a route isn't listed (yet), as the owner is shown it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum Waiting {
    /// Listed and live.
    Listed,
    /// Signed and kept, under no posted root yet, so nobody can check it and it isn't spread (R2.19). `poster` is whether
    /// a reserve's poster will post that root; with none, the node's own next pass does, and needs gas to.
    Unspread { poster: bool },
    /// It stays on this node: learned before the owner signed in, or no one has signed in yet (R2.8).
    Local { signed_in: bool },
    /// It will be listed once the owner has seen which routes the node shares (`share_status`).
    Preview,
    /// Sharing is off.
    Off,
    /// The owner keeps this route off the network, or delisted it before.
    OptedOut,
    /// It reaches a site the owner excluded.
    Excluded { host: String },
    /// It can't be shared: what `recipe` or the record says.
    NotShareable { reason: String },
    /// It hasn't run successfully through this node yet.
    NotRunYet,
    /// In `used` mode, it hasn't been used enough yet.
    BelowThreshold { days: u32, runs: u64, days_needed: u32, runs_needed: u64 },
    /// It will be listed: in this many passes, at most, if nothing else stops it.
    Queued,
    /// Today's listings are spent; it waits for tomorrow.
    CapReached { per_day: u32 },
    /// The node can't list now; why.
    Blocked { reason: Blocked },
    /// The last try failed; it is tried again later.
    Failed { error: String },
}

/// What keeps the node from listing anything right now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Blocked {
    Locked,
    NetworkOff,
    NoSettlement { error: String },
    NoGas { have: f64, need: f64, message: String },
}

/// Whether a route has been used enough to earn a listing in `used` mode.
pub fn earned(route: &Route) -> bool {
    route.stats.pass_days >= DAYS_EARNED || route.stats.passed >= RUNS_EARNED
}

/// How much a route is used, to list the most used first: runs that passed, then days, then the latest.
fn usage(r: &Route) -> (u64, u32, u64) {
    (r.stats.passed, r.stats.pass_days, r.stats.last_at.unwrap_or(0))
}

/// How long after the node told the owner which routes it will share (in its activity log and output) the first
/// listing goes ahead when the owner hasn't looked: a node run from a shell alone is never stuck waiting.
pub const PREVIEW_GRACE_SECS: u64 = 86_400;

/// Whether the owner has been shown what the node shares: they looked (`share_status`), or were told a day ago.
pub fn preview_done(s: &Settings, now: u64) -> bool {
    s.share_previewed || s.share_preview_told.is_some_and(|t| now >= t + PREVIEW_GRACE_SECS)
}

/// What the owner is told once, before the first payout from a listed route (R1.35): earning needs nothing up front,
/// and a route's share is paid whole until its coin is launched (`coin.split`).
pub const EARNING_NOTE: &str = "Earning needs nothing up front: a route's share of each paid use is yours in USDC, paid whole, until the route's coin is launched; from then on it pays whoever stakes the coin.";

/// The routes as this deployment lists them. A listing is signed under one deployment, and its book is that
/// deployment's (`listing::load_book`): a route listed under contracts the network has since deployed again isn't
/// listed under these, so it reads as not listed and lists afresh. Without this, every route a node listed before a
/// redeploy read as listed and shared, and none was ever listed under the new contracts, so no other node found them.
/// A route the owner delisted stays delisted.
pub fn listed_here(mut routes: Vec<Route>, book: &crate::listing::Book) -> Vec<Route> {
    for r in &mut routes {
        let elsewhere = r.listing.as_ref().is_some_and(|l| l.live && l.entry_id.parse::<alloy::primitives::FixedBytes<32>>().map_or(true, |e| !book.holds(e)));
        if elsewhere {
            r.listing = None;
        }
    }
    routes
}

/// Where each route stands, and the routes that may be listed, most used first. `since` is when the owner signed in,
/// `None` before they have. Nothing here reads the chain: what the owner said, what the route is, and how it has been
/// used.
pub fn plan(routes: &[Route], s: &Settings, since: Option<u64>) -> (Vec<String>, HashMap<String, Waiting>) {
    let mut standing = HashMap::new();
    let mut ready: Vec<&Route> = Vec::new();
    for r in routes {
        let w = match (&r.listing, r.share) {
            (Some(l), _) if l.live => Some(Waiting::Listed),
            _ if r.local_since(since) => Some(Waiting::Local { signed_in: since.is_some() }),
            _ if r.fetched.is_some() => Some(Waiting::NotShareable { reason: "its body is another contributor's listing".into() }),
            (_, Some(false)) => Some(Waiting::OptedOut),
            // Delisted before and never shared again since: the owner's delist stands.
            (Some(_), None) => Some(Waiting::OptedOut),
            _ if s.share_routes == ShareMode::Off && r.share != Some(true) => Some(Waiting::Off),
            _ => None,
        };
        let w = w.or_else(|| store::excluded_host(r, &s.excluded).map(|host| Waiting::Excluded { host }));
        let w = w.or_else(|| recipe::of_route(r).err().map(|reason| Waiting::NotShareable { reason }));
        let w = w.or_else(|| (r.stats.passed == 0).then_some(Waiting::NotRunYet));
        // A route the owner shared by hand needn't earn it; in `all` mode none must.
        let must_earn = s.share_routes == ShareMode::Used && r.share != Some(true);
        let w = w.or_else(|| {
            (must_earn && !earned(r)).then_some(Waiting::BelowThreshold {
                days: r.stats.pass_days,
                runs: r.stats.passed,
                days_needed: DAYS_EARNED,
                runs_needed: RUNS_EARNED,
            })
        });
        let w = w.or_else(|| (!preview_done(s, store::now())).then_some(Waiting::Preview));
        match w {
            Some(w) => {
                standing.insert(r.id.clone(), w);
            }
            None => {
                ready.push(r);
                standing.insert(r.id.clone(), Waiting::Queued);
            }
        }
    }
    ready.sort_by(|a, b| usage(b).cmp(&usage(a)).then_with(|| a.id.cmp(&b.id)));
    (ready.into_iter().map(|r| r.id.clone()).collect(), standing)
}

/// Today's count once a listing counted before its write failed with `error`. A failure that may have landed stays
/// counted, so the cap holds however a write ended. One the node stopped itself for gas sent nothing, and it is tried
/// again every pass until the funds come: counted, those tries would spend the day's listings on nothing.
fn counted_after_failure(listed: u32, error: &str) -> u32 {
    if chain::stopped_for_gas(error) {
        listed.saturating_sub(1)
    } else {
        listed
    }
}

/// How many routes the node listed by itself today, kept across restarts so a restart never resets the day's cap.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Today {
    pub day: u64,
    pub listed: u32,
}

impl Today {
    fn on(mut self, day: u64) -> Self {
        if self.day != day {
            self = Today { day, listed: 0 };
        }
        self
    }
}

fn today_path() -> std::path::PathBuf {
    store::home().join("autolist.json")
}

/// Today's count, strictly: a count that is there and can't be read is an error, never a fresh day, which would list
/// the day's cap again.
fn today() -> Result<Today, String> {
    Ok(store::read_json_strict::<Today>(&today_path(), &unbrowse_files::AUTOLIST)?.on(store::now() / 86_400))
}

/// Which of the ready routes this pass lists: at most [`PER_TICK`], and no more than today leaves under the cap.
pub fn this_pass(ready: &[String], per_day: u32, listed_today: u32) -> Vec<String> {
    let left = per_day.saturating_sub(listed_today) as usize;
    ready.iter().take(left.min(PER_TICK)).cloned().collect()
}

/// What the loop knows between passes: why it last stopped, whether it said so, and the routes whose listing failed.
#[derive(Default)]
struct State {
    blocked: Option<Blocked>,
    said: bool,
    failed: std::collections::BTreeMap<String, (u64, String)>,
}

static STATE: Mutex<State> = Mutex::new(State { blocked: None, said: false, failed: std::collections::BTreeMap::new() });

fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.locked()
}

/// What keeps the node from listing now, if anything: asked before any write, so a node that can't pay sends nothing.
async fn blocked(node: &Node) -> Option<Blocked> {
    if !node.unlocked() {
        return Some(Blocked::Locked);
    }
    if !crate::network_on() {
        return Some(Blocked::NetworkOff);
    }
    if let Err(error) = node.chain.deployed() {
        return Some(Blocked::NoSettlement { error });
    }
    // A node that sends its leaves to the reserve's poster lists with no gas at all.
    if crate::reserve::endpoint().is_some() {
        return None;
    }
    match chain::gas_short(node.key().ok()?).await {
        Ok(Some(g)) => Some(Blocked::NoGas { have: g.have, need: g.need, message: g.why }),
        // A chain that didn't answer: this pass lists nothing, the next asks again.
        Err(error) => Some(Blocked::NoSettlement { error }),
        Ok(None) => None,
    }
}

/// One pass of the background loop: lists the routes this pass may, most used first. What it listed.
pub async fn tick(node: &std::sync::Arc<Node>) -> Vec<String> {
    // A listing stands only while its route would be listed today: one that wouldn't is withdrawn first.
    withdraw_refused(node).await;
    // One whose site opted out for Unbrowse since is served and announced no more, with nothing sent to the chain.
    opted_out(node).await;
    let s = store::load_settings();
    let routes = listed_here(store::load_routes(), &crate::listing::load_book(&node.chain));
    let (ready, standing) = plan(&routes, &s, signed_in_since());
    tell_preview(&s, &standing);
    let now = store::now();
    let ready: Vec<String> = {
        let st = state();
        ready.into_iter().filter(|id| st.failed.get(id).is_none_or(|(at, _)| now >= at + RETRY_AFTER)).collect()
    };
    if ready.is_empty() {
        return Vec::new();
    }
    // A route whose site opted out for Unbrowse (R4.32) isn't listed, and spends nothing of the day's count.
    let (ready, skipped) = {
        let routes = routes.clone();
        tokio::task::spawn_blocking(move || not_opted_out(ready, &routes, crate::optout::refuses)).await.unwrap_or_default()
    };
    for (id, why) in skipped {
        if let Some(r) = routes.iter().find(|r| r.id == id).filter(|_| tell_once(&OPTED_OUT_TOLD, &id)) {
            store::log_activity(&store::Activity {
                at: store::now(),
                who: "Node".into(),
                site: r.site.clone(),
                what: format!("Didn't list {}: the site opted out of Unbrowse", r.what),
                kind: "list".into(),
                result: "refused".into(),
                ms: None,
                unb: None,
                tx: None,
                note: Some(why),
            });
            node.events.emit("activity", ());
        }
    }
    if ready.is_empty() {
        return Vec::new();
    }
    let why = blocked(node).await;
    {
        let mut st = state();
        if why != st.blocked {
            st.said = false;
        }
        st.blocked = why.clone();
        if let Some(b) = &why {
            if !st.said {
                st.said = true;
                drop(st);
                eprintln!("sharing: {} route{} waiting to be listed: {}", ready.len(), if ready.len() == 1 { "" } else { "s" }, said(b));
                node.events.emit("activity", ());
            }
            return Vec::new();
        }
    }
    let mut day = match today() {
        Ok(day) => day,
        Err(e) => {
            store::tell_once(&today_path(), &format!("sharing: nothing is listed by itself until today's count reads: {e}"));
            return Vec::new();
        }
    };
    let mut listed = Vec::new();
    for id in this_pass(&ready, s.list_per_day(), day.listed) {
        // Counted before the write: a listing that lands but answers an error still counts against the day. A count
        // that can't be kept stops the pass: the next one would read the day as not spent and list again.
        day.listed += 1;
        if let Err(e) = store::write_json(&today_path(), &unbrowse_files::AUTOLIST, &day) {
            store::tell_once(&today_path(), &format!("sharing: nothing more is listed by itself until today's count can be kept: {e}"));
            break;
        }
        match crate::list_route(node, id.clone()).await {
            Ok(_) => {
                state().failed.remove(&id);
                listed.push(id);
            }
            Err(e) => {
                let gas = chain::stopped_for_gas(&e);
                eprintln!("sharing: listing {id}: {e}");
                let listed_after = counted_after_failure(day.listed, &e);
                state().failed.insert(id, (if gas { 0 } else { now }, e));
                if listed_after != day.listed {
                    day.listed = listed_after;
                    if let Err(e) = store::write_json(&today_path(), &unbrowse_files::AUTOLIST, &day) {
                        store::tell_once(&today_path(), &format!("sharing: today's count wasn't corrected: {e}"));
                    }
                }
                // Out of gas part way: the rest wait for the funds, the most used still first.
                if gas {
                    break;
                }
            }
        }
    }
    if !listed.is_empty() {
        node.events.emit("activity", ());
    }
    listed
}

fn said(b: &Blocked) -> String {
    match b {
        Blocked::Locked => "the node's key isn't unlocked yet".into(),
        Blocked::NetworkOff if crate::terms::standing(&store::load_settings()) == crate::terms::Standing::TermsDue => crate::terms::due(),
        Blocked::NetworkOff => "the node is off the peer network (`unbrowse-node network on` joins)".into(),
        Blocked::NoSettlement { error } => format!("Settlement can't be used: {error}"),
        Blocked::NoGas { message, .. } => format!("{message}; a node that only earns needs a few cents of USDC once, for its identity"),
    }
}

/// Wakes the loop's waits when something they wait on may have changed (the start funds arrived).
pub fn retry_now() {
    let mut st = state();
    st.blocked = None;
    st.said = false;
    st.failed.retain(|_, (at, _)| *at != 0);
}

/// What the owner is shown: the mode, today's count against the cap, what stops listing now, and each route's
/// standing.
#[derive(Serialize)]
pub struct View {
    pub mode: ShareMode,
    pub per_day: u32,
    pub listed_today: u32,
    pub blocked: Option<Blocked>,
    pub routes: Vec<RouteView>,
}

#[derive(Serialize)]
pub struct RouteView {
    pub id: String,
    pub site: String,
    pub what: String,
    pub share: Option<bool>,
    pub passed: u64,
    pub days: u32,
    #[serde(flatten)]
    pub standing: Waiting,
}

/// When this node went on the network, if it has (`link::on_network_since`): off it now, a route it learned while on
/// still reads as one it could share, and `blocked` keeps it from listing.
fn signed_in_since() -> Option<u64> {
    crate::link::joined_since()
}

/// Tells the owner once, in the activity log and the node's output, which routes it will share, when some are waiting
/// on the preview and the owner hasn't looked: listing goes ahead `PREVIEW_GRACE_SECS` later unless they keep them
/// private (R2.8, R2.14a).
fn tell_preview(s: &Settings, standing: &HashMap<String, Waiting>) {
    if s.share_previewed || s.share_preview_told.is_some() {
        return;
    }
    let mut waiting: Vec<&String> = standing.iter().filter(|(_, w)| **w == Waiting::Preview).map(|(id, _)| id).collect();
    if waiting.is_empty() {
        return;
    }
    waiting.sort();
    let list = waiting.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
    let note = format!("These routes will be shared in a day: {list}. `unbrowse-node share route <id> off`, or My routes in the window, keeps one private; `unbrowse-node share` shows them all.");
    eprintln!("sharing: {note}");
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "Node".into(),
        site: String::new(),
        what: "Routes it will share".into(),
        kind: "share".into(),
        result: "waiting".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(note),
    });
    let _held = store::settings_held();
    let mut s = store::load_settings();
    s.share_preview_told = Some(store::now());
    let _ = store::save_settings(&s);
}

/// The owner has looked at which routes the node will share and said go (`share_approve`): the first listing needn't
/// wait out the day it told them (R2.8). Only a press of theirs comes here, never a window reading `share_status`.
pub fn previewed() {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    if !s.share_previewed {
        s.share_previewed = true;
        let _ = store::save_settings(&s);
        retry_now();
    }
}

pub fn view() -> View {
    view_of(store::load_routes())
}

/// `view` as the running node sees it: routes listed under another deployment read as not listed (`listed_here`).
pub fn view_on(chain: &chain::Chain) -> View {
    let book = crate::listing::load_book(chain);
    let mut v = view_of(listed_here(store::load_routes(), &book));
    unspread(&mut v, &book, crate::reserve::endpoint().is_some());
    v
}

/// A route marked listed whose latest listing has no posted root reads as what it is: nobody else can see it yet.
fn unspread(v: &mut View, book: &crate::listing::Book, poster: bool) {
    for r in v.routes.iter_mut().filter(|r| r.standing == Waiting::Listed) {
        if book.latest(&r.id).is_some_and(|k| k.root.is_none()) {
            r.standing = Waiting::Unspread { poster };
        }
    }
}

fn view_of(routes: Vec<Route>) -> View {
    let s = store::load_settings();
    let (ready, mut standing) = plan(&routes, &s, signed_in_since());
    let st = state();
    // What the window shows; the pass that lists refuses an unreadable count (`today`).
    let day = today().unwrap_or_default();
    let per_day = s.list_per_day();
    // Those today's cap leaves for later, and those a stop holds back, are said so.
    let room = per_day.saturating_sub(day.listed) as usize;
    for (i, id) in ready.iter().enumerate() {
        let w = if let Some((_, e)) = st.failed.get(id) {
            Waiting::Failed { error: e.clone() }
        } else if let Some(b) = &st.blocked {
            Waiting::Blocked { reason: b.clone() }
        } else if i >= room {
            Waiting::CapReached { per_day }
        } else {
            Waiting::Queued
        };
        standing.insert(id.clone(), w);
    }
    let routes = routes
        .into_iter()
        .map(|r| RouteView {
            standing: standing.remove(&r.id).unwrap_or(Waiting::NotRunYet),
            id: r.id,
            site: r.site,
            what: r.what,
            share: r.share,
            passed: r.stats.passed,
            days: r.stats.pass_days,
        })
        .collect();
    View { mode: s.share_routes, per_day, listed_today: day.listed, blocked: st.blocked.clone(), routes }
}

/// The owner's say on one route (R2.14a): on shares it (even one they delisted before, and in `used` mode before it
/// has earned it), off keeps it off the network from now on. Turning sharing off delists nothing: a listing already
/// made stays listed until the owner signs its withdrawal (`delist_route`, R2.16).
pub async fn share_route(node: &std::sync::Arc<Node>, id: String, on: bool) -> Result<Route, String> {
    let route = store::update_route(&id, |r| r.share = Some(on))?.ok_or("no such route")?;
    state().failed.remove(&route.id);
    node.events.emit("activity", ());
    Ok(route)
}

/// The node's own live listings whose route would not be listed today (`share::listed_today`), each with why: one made
/// under an older reader of its walk, or by a build from before a guard existed, fails the check every new listing
/// crosses (`recipe::of_route`).
pub fn no_longer_listed(routes: &[Route]) -> Vec<(String, String)> {
    routes
        .iter()
        .filter(|r| r.listing.as_ref().is_some_and(|l| l.live) && r.fetched.is_none())
        .filter_map(|r| recipe::of_route(r).err().map(|why| (r.id.clone(), why)))
        .collect()
}

/// Withdraws each of the node's own listings whose route would not be listed today ([`no_longer_listed`]), by the
/// node's one delist path (`delist_route`: on the chain when the node's key may, the owner's wallet's transaction
/// handed to them when only it may, and the route kept off the network until the owner shares it again). The route is
/// served, spread and announced no more from the moment it fails the check (`share::listed_today`), before its
/// withdrawal lands. The owner is told once in the activity log, by route, why and what brings it back: walking the
/// page again. A withdrawal that couldn't be made yet is tried again on the next pass, and said no more. What was
/// withdrawn.
pub async fn withdraw_refused(node: &std::sync::Arc<Node>) -> Vec<String> {
    let routes = store::load_routes();
    let mut withdrawn = Vec::new();
    for (id, why) in no_longer_listed(&routes) {
        let Some(r) = routes.iter().find(|r| r.id == id) else { continue };
        let done = crate::delist_route(node, id.clone()).await;
        if tell_withdrawal_once(&id) {
            store::log_activity(&store::Activity {
                at: store::now(),
                who: "Node".into(),
                site: r.site.clone(),
                what: format!("Withdrew the listing of {}: it would not be listed today ({why}). Walk the page again, then share the route again", r.what),
                kind: "list".into(),
                result: if done.is_ok() { "done".into() } else { "waiting".into() },
                ms: None,
                unb: None,
                tx: None,
                note: done.as_ref().err().cloned(),
            });
            node.events.emit("activity", ());
        }
        if done.is_ok() {
            withdrawn.push(id);
        }
    }
    withdrawn
}

/// `ready` without the routes whose site opted out for Unbrowse (`refuses`, `optout::refuses`), and those, each with
/// why.
pub fn not_opted_out(ready: Vec<String>, routes: &[Route], refuses: impl Fn(&Route) -> Option<String>) -> (Vec<String>, Vec<(String, String)>) {
    let mut out = (Vec::new(), Vec::new());
    for id in ready {
        match routes.iter().find(|r| r.id == id).and_then(&refuses) {
            Some(why) => out.1.push((id, why)),
            None => out.0.push(id),
        }
    }
    out
}

/// How many routes `opted_out` judges at once.
const OPTED_OUT_AT_ONCE: usize = 8;

/// The routes the owner was told this run were skipped or stopped for their site's opt-out: told once each.
static OPTED_OUT_TOLD: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
static STOPPED_TOLD: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn tell_once(told: &std::sync::Mutex<Vec<String>>, route_id: &str) -> bool {
    let mut told = told.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if told.iter().any(|t| t == route_id) {
        return false;
    }
    told.push(route_id.to_string());
    true
}

/// Reads again the robots rules of the sites of the node's own live listings and of the bodies it keeps (at most once
/// an epoch a host, `optout::OPTOUT_RECHECK`). A route whose site has since opted out for Unbrowse (R4.32) is served,
/// spread and announced no more from this node (`share::listed_today` reads what was read here): no withdrawal, no
/// delist, nothing sent to the chain, which a site's opt-out needs none of. Its listing still stands where the chain
/// and other nodes keep it, for the owner to delist if they choose. The owner is told once, by route. Also what the
/// node does at start, before it announces anything (`share::provide_all`): the reads are memory only. Routes are
/// judged [`OPTED_OUT_AT_ONCE`] at a time, each within `optout::JUDGE_DEADLINE`.
pub async fn opted_out(node: &Node) -> Vec<String> {
    let routes: Vec<Route> = store::load_routes().into_iter().filter(|r| r.listing.as_ref().is_some_and(|l| l.live) || r.fetched.is_some()).collect();
    let mut judged = Vec::new();
    for group in routes.chunks(OPTED_OUT_AT_ONCE) {
        let mut set = tokio::task::JoinSet::new();
        for r in group.iter().cloned() {
            set.spawn(async move {
                let why = crate::optout::refuses_async(&r).await;
                (r, why)
            });
        }
        while let Some(done) = set.join_next().await {
            if let Ok((r, Some(why))) = done {
                judged.push((r, why));
            }
        }
    }
    let mut stopped = Vec::new();
    for (r, why) in judged {
        match &r.fetched {
            None => crate::share::stop_serving_own(node, &r.id).await,
            Some(f) => {
                if let Some(net) = node.net.get() {
                    let _ = net.stop_providing_body(&f.content_id).await;
                }
            }
        }
        if r.fetched.is_none() && tell_once(&STOPPED_TOLD, &r.id) {
            store::log_activity(&store::Activity {
                at: store::now(),
                who: "Node".into(),
                site: r.site.clone(),
                what: format!("Stopped serving and announcing your listing of {}: the site opted out of Unbrowse", r.what),
                kind: "list".into(),
                result: "refused".into(),
                ms: None,
                unb: None,
                tx: None,
                note: Some(format!("{why}. Nothing was sent to the chain: the listing stands there until you delist it (Routes, Delist)")),
            });
            node.events.emit("activity", ());
        }
        stopped.push(r.id);
    }
    stopped
}

/// Whether the withdrawal of `route_id` is still to be told this run: the owner hears it once, not on every pass that
/// tries the write again.
fn tell_withdrawal_once(route_id: &str) -> bool {
    static TOLD: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut told = TOLD.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if told.iter().any(|t| t == route_id) {
        return false;
    }
    told.push(route_id.to_string());
    true
}

/// Delists every route this node lists, and keeps each off the network until the owner shares it again. What it
/// delisted; a delist that fails is said and the rest go on.
pub async fn delist_all(node: &std::sync::Arc<Node>) -> Result<Vec<String>, String> {
    let mut done = Vec::new();
    let mut failed = None;
    for r in store::load_routes().into_iter().filter(|r| r.listing.as_ref().is_some_and(|l| l.live)) {
        match crate::delist_route(node, r.id.clone()).await {
            Ok(_) => done.push(r.id),
            Err(e) => {
                failed.get_or_insert(format!("delisting {}: {e}", r.id));
            }
        }
    }
    node.events.emit("activity", ());
    match failed {
        Some(e) if done.is_empty() => Err(e),
        Some(e) => Err(format!("delisted {} and stopped: {e}", done.len())),
        None => Ok(done),
    }
}

/// What the owner is told once, the first time the node runs with sharing on.
pub fn notice(mode: ShareMode) -> Option<String> {
    let how = "`unbrowse-node share off` stops it, `unbrowse-node share route <id> off` keeps one route off, and Settings has the same";
    match mode {
        ShareMode::Used => Some(format!(
            "sharing is on: once your agents keep using a route this node learned (passed on {DAYS_EARNED} days or {RUNS_EARNED} times), the node lists it on the network so others can fetch it and you earn its fee. Nothing of your session goes with it; {how}"
        )),
        ShareMode::All => Some(format!("sharing is on for every route: each route this node learns is listed once it has run successfully. Nothing of your session goes with it; {how}")),
        ShareMode::Off => None,
    }
}

/// Says the notice on the node's log the first time it runs with sharing on, and records that it did. The window
/// shows the same once, and marks it seen the same way.
pub fn announce() {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    if s.share_notice_seen {
        return;
    }
    if let Some(n) = notice(s.share_routes) {
        eprintln!("{n}");
        s.share_notice_seen = true;
        let _ = store::save_settings(&s);
    }
}

#[cfg(test)]
mod tests {
    /// A try the node stopped for gas sent nothing, so a node waiting on funds keeps today's listings for when they come.
    #[test]
    fn a_listing_stopped_for_gas_costs_the_day_nothing() {
        let short = chain::needs_gas(&crate::arc::ARC_TESTNET, alloy::primitives::Address::repeat_byte(1), alloy::primitives::U256::ZERO, alloy::primitives::U256::from(1u64));
        assert_eq!(counted_after_failure(3, &short), 2);
        assert_eq!(counted_after_failure(3, "the RPC dropped the connection"), 3, "a write that may have landed stays counted");
        assert_eq!(counted_after_failure(0, &short), 0);
    }

    /// Listed means others can find it: a listing no root holds yet says it is waiting, whatever the route's mark says.
    #[test]
    fn a_listing_under_no_root_is_not_shown_listed() {
        let kept = |id: &str, root: Option<alloy::primitives::FixedBytes<32>>| crate::listing::Kept {
            listing: crate::listing::SignedListing {
                route_id: id.into(),
                site: "shop.example".into(),
                content_id: format!("sha256:{}", "ab".repeat(32)),
                agent_id: "42".into(),
                version: 1,
                supersedes: None,
                terms: crate::listing::Terms { description: "search items".into(), response: None, price: Default::default() },
                sig: String::new(),
            },
            leaf: alloy::primitives::FixedBytes::ZERO,
            root,
        };
        let mut book = crate::listing::Book::default();
        book.listings.push(kept("waits", None));
        book.listings.push(kept("spread", Some(alloy::primitives::FixedBytes::repeat_byte(1))));
        let row = |id: &str| RouteView { standing: Waiting::Listed, id: id.into(), site: String::new(), what: String::new(), share: None, passed: 0, days: 0 };
        let mut v = View { mode: ShareMode::Used, per_day: 1, listed_today: 0, blocked: None, routes: vec![row("waits"), row("spread")] };
        unspread(&mut v, &book, false);
        assert_eq!(v.routes[0].standing, Waiting::Unspread { poster: false });
        assert_eq!(v.routes[1].standing, Waiting::Listed);
    }

    use super::*;
    use crate::store::{Listing, RouteStats};

    /// Today's listing count that is there and can't be read is never a fresh day: that would list the day's cap again.
    #[test]
    fn a_days_count_that_doesnt_read_is_never_a_fresh_day() {
        let _home = store::scratch_home("autolist-day-spoiled");
        assert!(today().is_ok_and(|d| d.listed == 0));
        std::fs::write(today_path(), b"{ not json").unwrap();
        assert!(today().is_err());
    }

    /// A route a node learned of a public search: nothing of the session in its body.
    fn route(id: &str, site: &str, passed: u64, days: u32) -> Route {
        let mut r: Route = serde_json::from_value(serde_json::json!({
            "id": id, "site": site, "what": "search items", "method": "GET", "path": "/api/items",
            "root": format!("https://{site}/"), "inputs": [{ "name": "q", "secret": false, "default": "lamps" }], "steps": 1,
            "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("https://{site}/api/items?q={{q}}"),
                "needs_browser": false, "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
        }))
        .unwrap();
        r.stats = RouteStats { calls: passed, passed, pass_days: days, last_pass_day: 1, ..Default::default() };
        r
    }

    /// A route whose site opted out for Unbrowse in its robots rules is left out of the pass, and says why; the rest
    /// go on, in order. The real rules, read as the node reads them (`optout::refuses`), with the site's file injected.
    #[test]
    fn a_route_whose_site_opted_out_is_never_listed() {
        let (ok, out) = (route("a", "keeps.optout-list.example", 9, 9), route("b", "leaves.optout-list.example", 9, 9));
        crate::optout::ANSWERS.locked().insert("https://leaves.optout-list.example:443".into(), Some("User-agent: Unbrowse\nDisallow: /api".into()));
        crate::optout::ANSWERS.locked().insert("https://keeps.optout-list.example:443".into(), Some("User-agent: *\nDisallow: /".into()));
        let routes = vec![ok, out];
        let (ready, skipped) = not_opted_out(vec!["b".into(), "a".into()], &routes, crate::optout::refuses);
        assert_eq!(ready, ["a"], "a wildcard disallow lists on");
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].0 == "b" && skipped[0].1.contains("ask Unbrowse not to call /api/items"), "{skipped:?}");
        // What was read stands for what is served: the listing of b is served no more.
        let mut listed = routes[1].clone();
        listed.listing = Some(crate::store::Listing { entry_id: String::new(), tx: String::new(), listed_at: 1, live: true });
        assert!(!crate::share::listed_today(&listed) && crate::optout::known_refusal(&listed).is_some());
    }

    /// Settings in mode `m`, the owner shown what the node shares.
    fn mode(m: ShareMode) -> Settings {
        Settings { share_routes: m, share_previewed: true, ..Settings::default() }
    }

    /// Signed in before every route in these tests was learned (`learned_at` 1).
    const SIGNED_IN: Option<u64> = Some(0);

    /// The first listing waits for the owner to see what is shared, or for a day after the node told them: a node run
    /// from a shell alone isn't stuck.
    /// A route listed under contracts the network has since deployed again isn't listed under these: it reads as not
    /// listed and lists afresh; one listed in this deployment's book stays listed, and one the owner delisted stays
    /// delisted.
    #[test]
    fn a_route_listed_under_an_earlier_deployment_lists_again() {
        use alloy::primitives::FixedBytes;
        let listed = |id: &str, entry: FixedBytes<32>, live: bool| {
            let mut r = route(id, "shop.example", 0, 0);
            r.listing = Some(store::Listing { entry_id: format!("{entry:#x}"), tx: String::new(), listed_at: 1, live });
            r
        };
        let content_id = format!("sha256:{}", "ab".repeat(32));
        let here = chain::content_entry_id(&content_id);
        let signed = crate::listing::SignedListing {
            route_id: "here".into(),
            site: "shop.example".into(),
            content_id,
            agent_id: "42".into(),
            version: 1,
            supersedes: None,
            terms: crate::listing::Terms { description: "search items".into(), response: None, price: Default::default() },
            sig: String::new(),
        };
        let mut book = crate::listing::Book::default();
        book.listings.push(crate::listing::Kept { listing: signed, leaf: FixedBytes::ZERO, root: None });
        let routes = listed_here(vec![listed("here", here, true), listed("before", FixedBytes::repeat_byte(2), true), listed("delisted", FixedBytes::repeat_byte(3), false)], &book);
        let of = |id: &str| routes.iter().find(|r| r.id == id).unwrap().listing.clone();
        assert!(of("here").is_some(), "listed in this deployment's book");
        assert!(of("before").is_none(), "listed under the earlier deployment: lists afresh");
        assert!(of("delisted").is_some_and(|l| !l.live), "the owner's delist stands");
    }

    #[test]
    fn the_preview_is_seen_or_told_a_day_before() {
        let now = 1_000_000;
        let s = Settings { share_previewed: false, ..mode(ShareMode::Used) };
        assert!(!preview_done(&s, now));
        assert!(!preview_done(&Settings { share_preview_told: Some(now - 60), ..s.clone() }, now), "told a minute ago");
        assert!(preview_done(&Settings { share_preview_told: Some(now - PREVIEW_GRACE_SECS), ..s.clone() }, now), "told a day ago");
        assert!(preview_done(&Settings { share_previewed: true, ..s }, now), "looked");
    }

    /// A route learned from the owner's own browsing is listed by default after sign-in like any other (spec §72.1),
    /// and the owner can keep it private.
    #[test]
    fn the_owners_own_routes_list_by_default_after_sign_in() {
        let s = mode(ShareMode::Used);
        let mut yours = route("y", "d.example", 9, 9);
        yours.yours = true;
        assert_eq!(plan(&[yours.clone()], &s, SIGNED_IN).0, ["y"]);
        yours.share = Some(false);
        assert_eq!(plan(&[yours], &s, SIGNED_IN).1["y"], Waiting::OptedOut);
    }

    /// No route is listed before the owner signs in, and a route learned before the sign-in never is, whatever the
    /// owner says of it; one learned after is, once the owner has seen what the node shares (R1.35, R2.8).
    #[test]
    fn routes_stay_local_until_sign_in_and_list_by_default_after() {
        let s = mode(ShareMode::All);
        let mut before = route("before", "a.example", 9, 9);
        before.learned_at = 100;
        let mut after = route("after", "b.example", 9, 9);
        after.learned_at = 300;
        let (ready, standing) = plan(&[before.clone(), after.clone()], &s, None);
        assert!(ready.is_empty(), "no one has signed in");
        assert_eq!(standing["after"], Waiting::Local { signed_in: false });

        let (ready, standing) = plan(&[before.clone(), after.clone()], &s, Some(200));
        assert_eq!(ready, ["after"], "learned after the sign-in, listed by default");
        assert_eq!(standing["before"], Waiting::Local { signed_in: true }, "learned before it, kept on the node");

        // The mark made as a route is learned stands over the clock, and the owner can't share a local route.
        let mut marked = after.clone();
        marked.local = Some(true);
        marked.share = Some(true);
        assert!(plan(&[marked], &s, Some(200)).0.is_empty(), "learned before the sign-in, by its mark");
        let mut unmarked = before.clone();
        unmarked.local = Some(false);
        assert_eq!(plan(&[unmarked], &s, Some(200)).0, ["before"], "learned after, by its mark");

        // The first listing waits until the owner has been shown what will be shared.
        let unseen = Settings { share_previewed: false, ..s };
        let (ready, standing) = plan(&[after], &unseen, Some(200));
        assert!(ready.is_empty());
        assert_eq!(standing["after"], Waiting::Preview);
    }

    /// In `used` mode a route waits until the node's agents keep using it, and is listed from the run that crosses
    /// the line: on enough days, or enough runs on one.
    #[test]
    fn a_route_is_listed_once_its_use_crosses_the_threshold() {
        let s = mode(ShareMode::Used);
        let mut r = route("r", "shop.example", 1, 1);
        let (ready, standing) = plan(std::slice::from_ref(&r), &s, SIGNED_IN);
        assert!(ready.is_empty());
        assert!(matches!(standing["r"], Waiting::BelowThreshold { days: 1, runs: 1, .. }), "{:?}", standing["r"]);
        // Two more days of use.
        for day in [2, 3] {
            r.stats.passed_at(day * 86_400 + 5);
        }
        assert_eq!(r.stats.pass_days, 3);
        assert_eq!(plan(std::slice::from_ref(&r), &s, SIGNED_IN).0, ["r"], "three days earns it");
        // Or many runs in one day.
        let mut busy = route("b", "shop.example", 0, 0);
        for i in 0..RUNS_EARNED {
            busy.stats.passed_at(86_400 * 9 + i);
        }
        assert_eq!(busy.stats.pass_days, 1, "a burst is one day");
        assert_eq!(plan(&[busy], &s, SIGNED_IN).0, ["b"], "{RUNS_EARNED} runs earn it");
    }

    /// The most used routes go first, so a node short of gas or at its cap spends it where agents spend theirs.
    #[test]
    fn the_most_used_routes_are_listed_first() {
        let routes = [route("few", "a.example", 5, 1), route("most", "b.example", 40, 9), route("some", "c.example", 12, 3)];
        assert_eq!(plan(&routes, &mode(ShareMode::Used), SIGNED_IN).0, ["most", "some", "few"]);
        assert_eq!(plan(&routes, &mode(ShareMode::All), SIGNED_IN).0, ["most", "some", "few"]);
    }

    /// Each pass lists a few, and the day's cap holds whatever is waiting: the rest are said to wait for it.
    #[test]
    fn the_daily_cap_holds() {
        let ready: Vec<String> = (0..10).map(|i| format!("r{i}")).collect();
        assert_eq!(this_pass(&ready, 5, 0), ["r0", "r1"], "a pass lists at most PER_TICK");
        assert_eq!(this_pass(&ready, 5, 4), ["r0"], "one left today");
        assert!(this_pass(&ready, 5, 5).is_empty(), "the cap is reached");
        assert!(this_pass(&ready, 5, 9).is_empty());
        assert_eq!(Settings::default().list_per_day(), ShareMode::Used.per_day());
        assert!(ShareMode::Used.per_day() < ShareMode::All.per_day(), "listing everything is allowed more a day");
        assert_eq!(Settings { list_per_day: Some(1), ..mode(ShareMode::All) }.list_per_day(), 1, "the owner's number wins");
        assert_eq!(Settings { list_per_day: Some(9), ..mode(ShareMode::Off) }.list_per_day(), 0, "off lists nothing");
        // A new day starts the count again; the same day keeps it, a restart included.
        assert_eq!(Today { day: 3, listed: 5 }.on(3).listed, 5);
        assert_eq!(Today { day: 3, listed: 5 }.on(4), Today { day: 4, listed: 0 });
    }

    /// Opted in to everything, a route is listed after its first successful run, and not before.
    #[test]
    fn all_lists_every_route_after_its_first_successful_run() {
        let s = mode(ShareMode::All);
        let fresh = route("fresh", "a.example", 0, 0);
        let once = route("once", "b.example", 1, 1);
        let (ready, standing) = plan(&[fresh, once], &s, SIGNED_IN);
        assert_eq!(ready, ["once"]);
        assert_eq!(standing["fresh"], Waiting::NotRunYet, "a recording that never ran is never published");
    }

    /// Off lists nothing, however much a route is used; a route the owner shares by hand is theirs to share.
    #[test]
    fn off_lists_nothing() {
        let s = mode(ShareMode::Off);
        let (ready, standing) = plan(&[route("r", "a.example", 50, 20)], &s, SIGNED_IN);
        assert!(ready.is_empty());
        assert_eq!(standing["r"], Waiting::Off);
        let mut mine = route("m", "a.example", 1, 1);
        mine.share = Some(true);
        assert_eq!(plan(&[mine], &s, SIGNED_IN).0, ["m"]);
    }

    /// The owner's exclusions and opt-outs, and the routes that can't be shared, keep a route off in every mode; a
    /// route listed and live, or delisted before, is never listed again by itself.
    #[test]
    fn exclusions_and_opt_outs_keep_a_route_off() {
        let mut s = mode(ShareMode::All);
        s.excluded = vec!["private.example".into()];
        let excluded = route("x", "api.private.example", 9, 9);
        let mut opted = route("o", "a.example", 9, 9);
        opted.share = Some(false);
        let mut delisted = route("d", "b.example", 9, 9);
        delisted.listing = Some(Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: false });
        let mut listed = route("l", "c.example", 9, 9);
        listed.listing = Some(Listing { entry_id: "0x3".into(), tx: "0x4".into(), listed_at: 1, live: true });
        let mut session = route("s", "e.example", 9, 9);
        // A body that would carry the contributor's session value is refused, not scrubbed.
        session.graph.steps[0].fields.push(serde_json::from_value(serde_json::json!({ "loc": { "in": "header", "key": "authorization" }, "class": "constant", "value": "Bearer abc.def", "origin": null })).unwrap());
        let (ready, standing) = plan(&[excluded, opted, delisted.clone(), listed, session], &s, SIGNED_IN);
        assert!(ready.is_empty(), "{ready:?}");
        assert_eq!(standing["x"], Waiting::Excluded { host: "api.private.example".into() });
        assert_eq!(standing["o"], Waiting::OptedOut);
        assert_eq!(standing["d"], Waiting::OptedOut, "a delist stands");
        assert_eq!(standing["l"], Waiting::Listed);
        assert!(matches!(&standing["s"], Waiting::NotShareable { reason } if !reason.is_empty()), "{:?}", standing["s"]);
        // Shared again by the owner, the delisted route is listed once more.
        delisted.share = Some(true);
        assert_eq!(plan(&[delisted], &s, SIGNED_IN).0, ["d"]);
    }

    /// A listing stands only while its route would be listed today. One made under an older reader of its walk (or by a
    /// build from before the guard) is served, spread and announced no more at once, its withdrawal is made by the
    /// node's one delist path, and the owner is told once in the activity log, not on every pass. A listing whose route
    /// still lists is untouched.
    #[tokio::test]
    async fn a_listing_whose_route_no_longer_lists_is_withdrawn() {
        let _one = crate::testchain::one_at_a_time().await;
        let _home = store::scratch_home("autolist-withdraw");
        let listed = |r: Route| Route { listing: Some(Listing { entry_id: "0x1".into(), tx: String::new(), listed_at: 1, live: true }), local: Some(false), ..r };
        let stale = Route { read_by: None, ..listed(route("stale", "shop.example", 3, 2)) };
        let fresh = listed(route("fresh", "shop.example", 3, 2));
        store::save_route(&stale).unwrap();
        store::save_route(&fresh).unwrap();
        assert_eq!(no_longer_listed(&store::load_routes()).into_iter().map(|(id, _)| id).collect::<Vec<_>>(), ["stale"]);
        assert!(!crate::share::listed_today(&stale), "not served, spread or announced from now");
        assert!(crate::share::listed_today(&fresh));
        let node = crate::testchain::node("autolist-withdraw");
        withdraw_refused(&node).await;
        withdraw_refused(&node).await;
        let told: Vec<_> = store::read_activity(100).into_iter().filter(|a| a.what.starts_with("Withdrew the listing")).collect();
        assert_eq!(told.len(), 1, "told once, however many passes try the write");
        assert!(told[0].what.contains("Walk the page again"), "{}", told[0].what);
        assert!(!crate::share::listed_today(&store::load_route("stale").unwrap()));
        let after = store::load_route("fresh").unwrap();
        assert!(after.listing.is_some_and(|l| l.live) && after.share.is_none(), "a listing whose route still lists is untouched");
    }

    /// With no Settlement on the node's chain nothing is listed, and the owner is shown why.
    #[tokio::test]
    async fn no_listing_without_settlement() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = store::scratch_home("autolist-no-settlement");
        let s = Settings { share_routes: ShareMode::All, share_previewed: true, ..Settings::default() };
        store::save_settings(&crate::terms::acknowledged(s, false)).unwrap();
        // Learned after the node went on the network.
        store::save_route(&Route { local: Some(false), ..route("r", "shop.example", 3, 2) }).unwrap();
        let node = crate::testchain::node("autolist");
        assert!(tick(&node).await.is_empty());
        let v = view();
        assert!(matches!(v.blocked, Some(Blocked::NoSettlement { .. })), "{:?}", v.blocked);
        assert!(matches!(v.routes[0].standing, Waiting::Blocked { reason: Blocked::NoSettlement { .. } }));
        assert!(store::load_route("r").unwrap().listing.is_none());
        assert!(!home.join("autolist.json").exists(), "nothing was counted against the day");
        *STATE.locked() = State::default();
    }

    /// The node lists by itself on a local chain: the route most used first, a pass at a time, and no more than the
    /// day's cap however many are waiting. `cargo test -p unbrowse-node-app autolist -- --ignored` (needs Anvil).
    #[tokio::test]
    #[ignore = "needs Anvil"]
    async fn the_node_lists_what_it_uses_within_its_cap_on_a_local_chain() {
        let _one = crate::testchain::one_at_a_time().await;
        crate::testchain::home("autolist-anvil");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let node = crate::testchain::node("autolist");
        node.chain.start().await.expect("the devnet");
        store::save_settings(&Settings { share_routes: ShareMode::Used, list_per_day: Some(3), peer_network: false, ..Settings::default() }).unwrap();
        for (id, passed, days) in [("light", 5, 1), ("heavy", 30, 6), ("middle", 9, 3), ("next", 7, 2), ("new", 1, 1)] {
            // Learned after the node goes on the network, below.
            store::save_route(&Route { local: Some(false), ..route(id, &format!("{id}.example"), passed, days) }).unwrap();
        }
        // Local while the owner keeps it off the network, and on it, not before they have seen what is shared. No
        // sign-in: the node is on the network with its own wallet (spec §86).
        assert!(tick(&node).await.is_empty(), "off the network");
        store::save_settings(&crate::terms::acknowledged(store::load_settings(), false)).unwrap();
        assert!(tick(&node).await.is_empty(), "not shown yet");
        assert!(matches!(view().routes[0].standing, Waiting::Preview | Waiting::Local { .. } | Waiting::BelowThreshold { .. }));
        previewed();
        assert_eq!(tick(&node).await, ["heavy", "middle"], "the most used first, PER_TICK a pass");
        assert_eq!(tick(&node).await, ["next"], "the day's cap of three");
        assert!(tick(&node).await.is_empty(), "the cap holds");
        let v = view();
        let at = |id: &str| v.routes.iter().find(|r| r.id == id).unwrap().standing.clone();
        assert_eq!(at("heavy"), Waiting::Listed);
        assert_eq!(at("light"), Waiting::CapReached { per_day: 3 });
        assert!(matches!(at("new"), Waiting::BelowThreshold { .. }));
        assert_eq!(v.listed_today, 3);
        // Turning one off keeps it off the network, and delists nothing (R2.14a): it stays listed.
        share_route(&node, "heavy".into(), false).await.unwrap();
        assert_eq!(store::load_route("heavy").unwrap().share, Some(false));
        assert!(store::load_route("heavy").unwrap().listing.unwrap().live, "turning sharing off delists nothing");
        // Delisting is its own signed withdrawal (R2.16).
        assert_eq!(delist_all(&node).await.unwrap().len(), 3);
        assert!(plan(&store::load_routes(), &store::load_settings(), SIGNED_IN).0 == ["light"], "only the one never listed waits");
        *STATE.locked() = State::default();
    }
}
