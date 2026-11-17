//! Route bodies between nodes (protocol §3.3, §7): serving the bodies this node holds, fetching another
//! contributor's, and seeding what it fetched.
//!
//! A node never runs a route for another node. A caller reads an entry's content identifier from the contributor's
//! signed listing, checked against a posted root (R3.9); asks the nodes that hold the body for it, the contributor's
//! own first, paying with a body voucher (R3.10); checks the bytes against that identifier (R7.19); keeps the body and
//! makes it a route of its own (`recipe::into_route`), which runs on its own node under its own session and is reused
//! with no new payment while it works (R3.12). The use's receipt line names the node that served the body as its
//! server; serving is paid no share of the fee (`coin.split`), and the name checks the lister when it served the line
//! (`coin.check`). The body is kept (`keep`) only once that line is written and passed:
//! a body this node keeps is one its use was billed for.
//!
//! A node serves a body only against a voucher that pays the entry's fee for that body (`network::verify_body_voucher`),
//! and only bodies it holds: the routes it lists, and, unless the owner keeps it in light mode, the bodies it fetched
//! and paid for (R7.18). Which providers a caller still asks, and which entries served nothing lately, it keeps in
//! `Share`, saved under the node's home on every change (`Share::kept`): a restart still skips them, rather than
//! learning again, one timeout each, which providers are gone.
//!
//! A delist or a reprice reaches the nodes that keep a copy or serve the site in seconds (`announce`, `on_change`): the
//! contributor's node says so on the site's topic, and each node that watches it (`watch`) reads the chain again at
//! once for the entries it names. The chain stays the truth: a notice makes a node read it, never changes anything by
//! itself, and a node that heard nothing still reads it within `LIVE_FOR`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alloy::primitives::{Address, FixedBytes};
use unbrowse_learn::egress::Egress;
use unbrowse_learn::Class;
use unbrowse_net::{Bodies, Change, ChangeKind, FetchError, Heard, PeerId, Providers, Registry, Standing};

use crate::{chain, listing, network, peers, recipe, store, Node};
use crate::sync::Locked;

/// What one node keeps in memory about other nodes' bodies.
#[derive(Default)]
pub struct Share {
    /// The entries that failed in this node (R5.4).
    demoted: Mutex<crate::rank::reputation::Demoted>,
    /// The providers set aside for a body, on R7.20's doubling schedule.
    providers: Mutex<Providers>,
    /// The entries that served nothing, on R7.12's.
    dark: Mutex<Dark>,
    /// The bodies refused for what this network did, not for what they say (`rest`).
    resting: Mutex<HashMap<String, (String, Instant)>>,
    /// The routes of bodies fetched for a goal they couldn't answer and never run, by entry (`note_unrun`): a body that
    /// wasn't run isn't kept, so this is how the next goal it can't answer is told so before it is fetched again.
    unrun: Mutex<HashMap<FixedBytes<32>, (store::Route, Instant)>>,
    /// The signed listings this node read and checked, by entry: what a call that names an entry fetches its body by.
    /// Listings of one body are one entry (R2.4) and only accumulate (R2.16), so an entry keeps each contributor's
    /// listing of each route, the newest version of it, and the last one read last.
    listings: Mutex<HashMap<FixedBytes<32>, Vec<listing::Proven>>>,
    /// When the chain last showed each entry whose body this node keeps as live: a read route runs from its kept body
    /// for `LIVE_FOR` after that without asking the chain again.
    live: Mutex<HashMap<FixedBytes<32>, Instant>>,
    /// The bodies, by content identifier, that go where a route this node didn't learn itself may not (R2.28), and
    /// why: an entry that lists one is skipped, never paid for. Its providers served it, so it isn't dark; it is the
    /// body that is bad, and a version never changes (R2.6).
    refused: Mutex<HashMap<String, String>>,
    /// When a change notice last made the node begin reading the chain for each entry: a notice that arrived before
    /// that read began is one the read answers.
    rechecked: Mutex<HashMap<FixedBytes<32>, Instant>>,
    /// The listings whose contributor signed a withdrawal before any claim put their entry on the chain (R2.16): neither
    /// run nor fetched again until a later version is listed. Saved on every change: a restart must not bring back a
    /// route its contributor took back.
    withdrawn: Mutex<Withdrawn>,
}

/// The files the two schedules are kept in, under the node's home.
pub const SET_ASIDE_FILE: &str = "set-aside.json";
pub const DARK_FILE: &str = "dark-entries.json";
/// The file local demotions are kept in, under the node's home.
pub const DEMOTED_FILE: &str = "demoted.json";

/// How long a body refused for what this network did rests (`Share::rest`).
const RESTS_FOR: Duration = Duration::from_secs(600);

/// The most fetched routes that weren't run the node remembers (`Share::note_unrun`): the oldest goes first past it.
const UNRUN_KEPT: usize = 256;

/// The file signed withdrawals are kept in, under the node's home.
pub const WITHDRAWN_FILE: &str = "withdrawn.json";

impl Share {
    /// The node's share state with the providers set aside (R7.20) and the entries that served nothing (R7.12) as
    /// they were last saved under `home`, and saved there again on every change. A file that doesn't read is empty.
    pub fn kept(home: &std::path::Path) -> Share {
        Share {
            providers: Mutex::new(Providers::open(home.join(SET_ASIDE_FILE))),
            dark: Mutex::new(Dark::open(home.join(DARK_FILE))),
            demoted: Mutex::new(crate::rank::reputation::Demoted::open(home.join(DEMOTED_FILE))),
            resting: Mutex::default(),
            withdrawn: Mutex::new(Withdrawn::open(home.join(WITHDRAWN_FILE))),
            ..Share::default()
        }
    }

    /// Keeps a listing this node checked under its entry (its body's, `SignedListing::entry`): beside the other
    /// listings of the same body, in place of an older version of the same contributor's listing of the same route.
    pub fn saw(&self, p: &listing::Proven) {
        let mut all = self.listings.locked();
        let id = p.listing.entry();
        let kept = all.entry(id).or_default();
        let same = |k: &listing::Proven| k.listing.agent_id == p.listing.agent_id && k.listing.route_id == p.listing.route_id;
        match kept.iter().position(same) {
            Some(i) if kept[i].listing.version > p.listing.version => {}
            Some(i) => {
                kept.remove(i);
                kept.push(p.clone());
            }
            None => {
                if kept.len() >= LISTINGS_PER_ENTRY {
                    kept.remove(0);
                }
                kept.push(p.clone());
            }
        }
        // Republishing restores a withdrawn listing (R2.16).
        self.withdrawn.locked().republished(&p.listing);
    }

    /// Whether `entry` is withdrawn: a contributor withdrew its listing, and no listing this node read still stands.
    /// Listings of one body are one entry (R2.4), so one contributor's withdrawal says nothing of another's listing.
    pub fn withdrawn(&self, entry: FixedBytes<32>) -> bool {
        let all = self.listings.locked();
        self.withdrawn.locked().whole(entry, all.get(&entry).map_or(&[], Vec::as_slice))
    }

    fn withdraw(&self, listing: &listing::SignedListing, at: u64) {
        self.withdrawn.locked().add(listing, at);
    }

    /// Every listing of `entry` this node read since it started, withdrawn or not.
    fn listings_of(&self, entry: FixedBytes<32>) -> Vec<listing::Proven> {
        self.listings.locked().get(&entry).cloned().unwrap_or_default()
    }

    /// The listings this node checked for the site `page` is on.
    pub fn known_on(&self, page: &str) -> Vec<listing::Proven> {
        let Some(site) = unbrowse_net::site_of(page) else { return vec![] };
        let all = self.listings.locked();
        let withdrawn = self.withdrawn.locked();
        all.values()
            .flatten()
            .filter(|p| unbrowse_net::site_of(&p.listing.site).as_deref() == Some(site.as_str()) && !withdrawn.covers(&p.listing))
            .cloned()
            .collect()
    }

    /// The listing of `entry` this node read last, of those not withdrawn while any stands: any listing of an entry
    /// names its body, which is all a fetch needs, but the one it names is the contributor the fetch pays.
    pub(crate) fn known(&self, entry: FixedBytes<32>) -> Option<listing::Proven> {
        let all = self.listings.locked();
        let ps = all.get(&entry)?;
        let withdrawn = self.withdrawn.locked();
        ps.iter().rev().find(|p| !withdrawn.covers(&p.listing)).or(ps.last()).cloned()
    }

    /// The listing of `entry` whose words are `description`, else the one `known` gives.
    pub(crate) fn known_as(&self, entry: FixedBytes<32>, description: &str) -> Option<listing::Proven> {
        let all = self.listings.locked();
        let ps = all.get(&entry)?;
        let withdrawn = self.withdrawn.locked();
        let standing = || ps.iter().rev().filter(|p| !withdrawn.covers(&p.listing));
        standing().find(|p| p.listing.terms.description == description).or(standing().next()).or(ps.last()).cloned()
    }

    /// A use of `entry` ran and failed: it goes last in this node's picks for `LOCAL_DEMOTION` (R5.4).
    pub fn demote(&self, entry: FixedBytes<32>) {
        self.demoted.locked().demote(entry, store::now());
    }

    /// Whether a failure here still demotes `entry`.
    pub fn demoted(&self, entry: FixedBytes<32>) -> bool {
        self.demoted.locked().demoted(entry, store::now())
    }

    /// The epoch an entry that served nothing comes back in, while it is off the ranking.
    pub fn off_until(&self, entry: FixedBytes<32>, epoch: u64) -> Option<u64> {
        self.dark.locked().off_until(entry, epoch)
    }

    fn served_nothing(&self, entry: FixedBytes<32>, epoch: u64) {
        self.dark.locked().served_nothing(entry, epoch)
    }

    fn served(&self, entry: FixedBytes<32>) {
        self.dark.locked().served(entry)
    }

    fn providers(&self) -> std::sync::MutexGuard<'_, Providers> {
        self.providers.locked()
    }

    /// The chain showed `entry` live at `at`.
    pub(crate) fn saw_live(&self, entry: FixedBytes<32>, at: Instant) {
        self.live.locked().insert(entry, at);
    }

    /// Whether the chain showed `entry` live within `LIVE_FOR` of `now`.
    pub(crate) fn live_lately(&self, entry: FixedBytes<32>, now: Instant) -> bool {
        self.live.locked().get(&entry).is_some_and(|at| now.saturating_duration_since(*at) < LIVE_FOR)
    }

    /// Why the body `content_id` names is set aside, if it is.
    pub fn refused(&self, content_id: &str) -> Option<String> {
        self.refused.locked().get(content_id).cloned()
    }

    /// Sets aside the body `content_id` names: it goes where a route this node didn't learn itself may not.
    pub fn set_aside(&self, content_id: &str, why: &str) {
        self.refused.locked().insert(content_id.to_string(), why.to_string());
    }

    /// Leaves the body `content_id` names alone for a while: it was refused for where this network sent it just now, so
    /// its entry isn't fetched and refused over and over, and it is looked at again once a VPN or a captive portal may
    /// have gone.
    pub fn rest(&self, content_id: &str, why: &str) {
        self.resting.locked().insert(content_id.to_string(), (why.to_string(), Instant::now()));
    }

    /// Why the body `content_id` names rests, while it does.
    pub fn resting(&self, content_id: &str) -> Option<String> {
        self.resting.locked().get(content_id).filter(|(_, at)| at.elapsed() < RESTS_FOR).map(|(why, _)| why.clone())
    }

    /// Remembers what the body of `entry` does, fetched for a goal it couldn't answer and never run: it writes and the
    /// goal only reads, or it does another page. The body itself isn't kept (one kept is never paid for again, R3.12),
    /// only the route made from it, in memory, so a later goal it can't answer doesn't fetch it again; a goal it can
    /// answer fetches it afresh, and pays for it then. At most `UNRUN_KEPT`, the oldest dropped first.
    pub fn note_unrun(&self, entry: FixedBytes<32>, route: &store::Route) {
        let mut all = self.unrun.locked();
        if !all.contains_key(&entry) && all.len() >= UNRUN_KEPT {
            if let Some(oldest) = all.iter().min_by_key(|(_, (_, at))| *at).map(|(e, _)| *e) {
                all.remove(&oldest);
            }
        }
        all.insert(entry, (route.clone(), Instant::now()));
    }

    /// The route of `entry`'s body, when it was fetched and not run (`note_unrun`).
    pub fn unrun(&self, entry: FixedBytes<32>) -> Option<store::Route> {
        self.unrun.locked().get(&entry).map(|(r, _)| r.clone())
    }

    fn forget_live(&self, entry: FixedBytes<32>) {
        self.live.locked().remove(&entry);
    }

    /// Moves every answer the chain gave back by `by`, as if that long had passed since.
    #[cfg(test)]
    fn age_live(&self, by: Duration) {
        for at in self.live.locked().values_mut() {
            *at = at.checked_sub(by).unwrap_or(*at);
        }
    }
}

/// The most listings one entry keeps (`Share::saw`): the oldest read goes first past it.
const LISTINGS_PER_ENTRY: usize = 32;

/// How long an entry the chain showed live is taken to still be live, for a read route run from its kept body: a delist
/// reaches a node that keeps the body within this long, and a route called often reads the chain once in it.
pub const LIVE_FOR: Duration = Duration::from_secs(10 * 60);

/// Why a route made from another contributor's body didn't run from the copy this node keeps.
#[derive(Debug, PartialEq)]
pub enum NotRun {
    /// The contributor delisted the entry: the kept body is dropped, and the route is neither offered nor run again.
    Delisted,
    /// The route writes and the chain couldn't be read, so whether the entry is still live is unknown.
    Unchecked(String),
}

impl NotRun {
    pub fn why(&self) -> String {
        match self {
            NotRun::Delisted => "its contributor delisted this route, so the copy this node kept was dropped and nothing ran: use another route for the site, or learn one with unbrowse_do".into(),
            NotRun::Unchecked(e) => format!("this route changes things on the site, and the chain couldn't be read to check its contributor still lists it, so nothing ran ({e}): try again once the chain answers"),
        }
    }
}

/// Whether a route made from another contributor's body may run from the copy this node keeps: its entry must still be
/// live. Delisting is the contributor's way to withdraw a route, so it has to reach every node that kept the body, not
/// only those that fetch it afresh. A read route asks the chain at most once in `LIVE_FOR`, and keeps running while
/// the chain can't be read: what it does is only read. A route that writes asks every time, and never runs on an
/// answer it couldn't get. A delisted entry's body and route are dropped here. A route this node learned itself passes.
pub async fn still_listed(node: &Node, route: &store::Route) -> Result<(), NotRun> {
    let Some(f) = &route.fetched else { return Ok(()) };
    let Ok(entry) = f.entry_id.parse::<FixedBytes<32>>() else {
        drop_cached(node, route).await;
        return Err(NotRun::Delisted);
    };
    if !route.write && node.share.live_lately(entry, Instant::now()) {
        return Ok(());
    }
    match chain::entry_by_hash(&node.chain, entry).await {
        Ok(Some((_, e))) if e.live => {
            node.share.saw_live(entry, Instant::now());
            Ok(())
        }
        // No claim has credited the body's entry yet, so nothing on the chain can have delisted it: it is withdrawn, if
        // at all, between nodes (R2.16).
        Ok(None) if node.share.withdrawn(entry) => {
            drop_kept(node, route, entry).await;
            Err(NotRun::Delisted)
        }
        Ok(None) => {
            node.share.saw_live(entry, Instant::now());
            Ok(())
        }
        Ok(Some(_)) => {
            sut_reachable!("a kept copy of a delisted route was dropped instead of run", &serde_json::json!({ "entry": f.entry_id, "write": route.write }));
            drop_kept(node, route, entry).await;
            Err(NotRun::Delisted)
        }
        Err(e) if route.write => {
            sut_reachable!("a kept route that writes didn't run while the chain couldn't say it is listed", &serde_json::json!({ "entry": f.entry_id }));
            Err(NotRun::Unchecked(e))
        }
        Err(_) => Ok(()),
    }
}

/// Drops a kept copy whose entry is delisted, or withdrawn: the route goes, and its bytes too unless they are a body this
/// node lists itself or keeps for another entry.
async fn drop_kept(node: &Node, route: &store::Route, entry: FixedBytes<32>) {
    let Some(f) = &route.fetched else { return };
    node.share.forget_live(entry);
    drop_cached(node, route).await;
    let elsewhere = listing::load_book(&node.chain).listings.iter().any(|k| k.listing.content_id == f.content_id)
        || store::load_routes().iter().any(|r| r.fetched.as_ref().is_some_and(|o| o.content_id == f.content_id));
    if !elsewhere {
        recipe::drop_body(&f.content_id);
    }
}

/// Asks the chain about every kept body whose entry it hasn't shown live within `LIVE_FOR`, so a delisted route stops
/// being offered within that bound even when no agent calls it. A chain that can't be read leaves them as they are.
pub async fn check_kept(node: &Node) {
    let now = Instant::now();
    for r in store::load_routes() {
        let Some(entry) = r.fetched.as_ref().and_then(|f| f.entry_id.parse::<FixedBytes<32>>().ok()) else { continue };
        if node.share.live_lately(entry, now) {
            continue;
        }
        // Only the read's outcome matters here: a write route's unknown is the same as a read's.
        let read = store::Route { write: false, ..r };
        let _ = still_listed(node, &read).await;
    }
}

/// The listings their contributors withdrew (R2.16), by entry: whose each was and the version withdrawn. A withdrawal
/// is one contributor's word about its own listing: a body many list stays listed by the rest, and a contributor that
/// lists a body someone else listed first can't take it from them. A later version of a listing restores it.
#[derive(Clone, Debug, Default)]
struct Withdrawn {
    entries: HashMap<FixedBytes<32>, Vec<KeptWithdrawal>>,
    /// The file they are kept in, if any.
    kept: Option<std::path::PathBuf>,
}

/// One withdrawn listing, as the file keeps it: whose it was, the version, and when its contributor signed.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct KeptWithdrawal {
    entry: FixedBytes<32>,
    agent_id: String,
    version: u64,
    at: u64,
}

impl Withdrawn {
    /// The withdrawals kept at `path` (`unbrowse_net::load_kept`), saved there on every change.
    fn open(path: std::path::PathBuf) -> Withdrawn {
        let mut entries: HashMap<FixedBytes<32>, Vec<KeptWithdrawal>> = HashMap::new();
        for k in unbrowse_net::load_kept::<KeptWithdrawal>(&path, &unbrowse_files::WITHDRAWN) {
            entries.entry(k.entry).or_default().push(k);
        }
        Withdrawn { entries, kept: Some(path) }
    }

    /// Whether `l` is a listing its contributor withdrew: no later version of it was read since.
    fn covers(&self, l: &listing::SignedListing) -> bool {
        self.entries.get(&l.entry()).is_some_and(|ws| ws.iter().any(|w| w.agent_id == l.agent_id && w.version >= l.version))
    }

    /// Whether `entry` was withdrawn and none of `listings`, the ones read of it, still stands.
    fn whole(&self, entry: FixedBytes<32>, listings: &[listing::Proven]) -> bool {
        self.entries.contains_key(&entry) && listings.iter().all(|p| self.covers(&p.listing))
    }

    /// Notes that `l`'s contributor withdrew it, in a withdrawal signed at `at`.
    fn add(&mut self, l: &listing::SignedListing, at: u64) {
        let entry = l.entry();
        let ws = self.entries.entry(entry).or_default();
        ws.retain(|w| w.agent_id != l.agent_id);
        ws.push(KeptWithdrawal { entry, agent_id: l.agent_id.clone(), version: l.version, at });
        // Past the bound, the withdrawals signed longest ago are forgotten first.
        while self.entries.len() > unbrowse_net::MAX_KEPT {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, ws)| ws.iter().map(|w| w.at).max()).map(|(e, _)| *e) else { break };
            self.entries.remove(&oldest);
        }
        self.save();
    }

    /// `l` was read: a later version than the one its contributor withdrew brings it back (R2.16).
    fn republished(&mut self, l: &listing::SignedListing) {
        let entry = l.entry();
        let Some(ws) = self.entries.get_mut(&entry) else { return };
        let before = ws.len();
        ws.retain(|w| w.agent_id != l.agent_id || w.version >= l.version);
        if ws.len() == before {
            return;
        }
        if ws.is_empty() {
            self.entries.remove(&entry);
        }
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.kept else { return };
        let items: Vec<&KeptWithdrawal> = self.entries.values().flatten().collect();
        unbrowse_net::save_kept(path, &unbrowse_files::WITHDRAWN, &items);
    }
}

/// The entries none of whose providers served a body (R7.11, R7.12). On its `k`-th dark epoch an entry is off the
/// ranking for the rest of that epoch and `min(2^(k-1), 32)` epochs after it: callers skip it and try the next entry.
/// A body served clears its count, as a good serve clears a provider's (`Providers::served`); whether the count should
/// ever reset is open in R7.12.
#[derive(Clone, Debug, Default)]
pub struct Dark {
    /// Dark epochs counted, and the last one.
    entries: HashMap<FixedBytes<32>, (u32, u64)>,
    /// The file the schedule is kept in, if any.
    kept: Option<std::path::PathBuf>,
}

/// One dark entry, as the file keeps it.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct KeptDark {
    entry: FixedBytes<32>,
    count: u32,
    last: u64,
}

impl Dark {
    /// The schedule kept at `path` (`unbrowse_net::load_kept`: small, versioned, bounded, and empty when it doesn't
    /// read), saved there on every change.
    pub fn open(path: std::path::PathBuf) -> Dark {
        let entries = unbrowse_net::load_kept::<KeptDark>(&path, &unbrowse_files::DARK_ENTRIES).into_iter().filter(|k| k.count > 0).map(|k| (k.entry, (k.count, k.last))).collect();
        Dark { entries, kept: Some(path) }
    }

    /// `entry` was tried in `epoch` and no provider served it. An epoch counts once, however often it was tried.
    pub fn served_nothing(&mut self, entry: FixedBytes<32>, epoch: u64) {
        let (k, last) = self.entries.entry(entry).or_insert((0, 0));
        if *k > 0 && *last == epoch {
            return;
        }
        *k += 1;
        *last = epoch;
        // Past the bound, the entries dark longest ago are forgotten first.
        while self.entries.len() > unbrowse_net::MAX_KEPT {
            let Some(oldest) = self.entries.iter().min_by_key(|(_, (_, last))| *last).map(|(e, _)| *e) else { break };
            self.entries.remove(&oldest);
        }
        self.save();
    }

    pub fn served(&mut self, entry: FixedBytes<32>) {
        if self.entries.remove(&entry).is_some() {
            self.save();
        }
    }

    fn save(&self) {
        let Some(path) = &self.kept else { return };
        let items: Vec<KeptDark> = self.entries.iter().map(|(e, (count, last))| KeptDark { entry: *e, count: *count, last: *last }).collect();
        unbrowse_net::save_kept(path, &unbrowse_files::DARK_ENTRIES, &items);
    }

    /// While `entry` is off the ranking in `epoch`, the epoch it returns in.
    pub fn off_until(&self, entry: FixedBytes<32>, epoch: u64) -> Option<u64> {
        let (k, last) = *self.entries.get(&entry)?;
        let back = last.saturating_add(1).saturating_add(unbrowse_net::exclusion(k));
        (epoch >= last && epoch < back).then_some(back)
    }
}

// ---- serving ----

/// What this node answers a caller that asks it for a body: the body, once its payment checks.
pub struct Served(pub Arc<Node>);

impl Bodies for Served {
    async fn serve(&self, from: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, String> {
        release(&self.0, from, content_id, payment).await
    }
}

/// Whether the node's own route stands as listed today: its listing is live, and the route would be listed now, through
/// the same check every new listing crosses (`recipe::of_route`, the evidence guard and the whole-value checks with it).
/// A listing made under an older reader, or by a build from before a guard existed, stands only while that holds: one
/// that fails it is served, spread and announced no more from this moment, before its withdrawal lands
/// (`autolist::withdraw_refused`). The one reader of whether the node's own listing stands.
/// One whose site opted out for Unbrowse in its robots rules, as the node last read them (`optout::known_refusal`,
/// R4.32), stands no more either: nothing is sent to the chain for it, and the owner is told (`autolist::opted_out`).
pub fn listed_today(r: &store::Route) -> bool {
    r.listing.as_ref().is_some_and(|l| l.live) && r.fetched.is_none() && recipe::of_route(r).is_ok() && crate::optout::known_refusal(r).is_none()
}

/// Whether this node serves its own listing of `route_id`: only while the route stands as listed ([`listed_today`]). A
/// delisted route is withdrawn between nodes by no longer being served or spread (R2.16), whatever its listing's book
/// entry or the chain still say, and so is one whose route would no longer be listed.
fn serves_own(route_id: &str, routes: &[store::Route]) -> bool {
    routes.iter().any(|r| r.id == route_id && listed_today(r))
}

/// Stops announcing the bodies of `route_id`'s listings, once the route is delisted, unless the node still serves one
/// under another entry: a provider record would send callers to a node that refuses them.
pub async fn stop_serving_own(node: &Node, route_id: &str) {
    let Some(net) = node.net.get() else { return };
    let bodies: std::collections::BTreeSet<String> = listing::load_book(&node.chain).listings.into_iter().filter(|k| k.listing.route_id == route_id).map(|k| k.listing.content_id).collect();
    for content_id in bodies {
        if held(&node.chain, &content_id).is_empty() {
            let _ = net.stop_providing_body(&content_id).await;
        }
    }
}

/// The entries this node serves the body `content_id` under, each with its site and whose it is: every version of a
/// route it lists that names the body (a version never changes, R2.6, so an older one is still that entry's body), and,
/// when the owner chose to serve kept routes (`seeds_kept_body`), every entry whose body it fetched and paid for and
/// keeps (R7.18).
/// Entries that list byte-identical bodies share one content id, so a body may serve several; the body is held once,
/// by its content id, and each entry is paid for as itself.
fn held(chain: &chain::Chain, content_id: &str) -> Vec<(FixedBytes<32>, String, Whose)> {
    let mut out: Vec<(FixedBytes<32>, String, Whose)> = Vec::new();
    let routes = store::load_routes();
    for k in listing::load_book(chain).listings.into_iter().filter(|k| k.listing.content_id == content_id && serves_own(&k.listing.route_id, &routes)) {
        let entry = k.listing.entry();
        if !out.iter().any(|(e, _, _)| *e == entry) {
            out.push((entry, k.listing.site, Whose::Own));
        }
    }
    if seeds_kept_body(&store::load_settings()) {
        for r in store::load_routes() {
            // A kept route whose site opted out for Unbrowse (R4.32) is served no more from here.
            if crate::optout::known_refusal(&r).is_some() {
                continue;
            }
            let Some(f) = r.fetched.filter(|f| f.content_id == content_id) else { continue };
            let Ok(entry) = f.entry_id.parse::<FixedBytes<32>>() else { continue };
            if !out.iter().any(|(e, _, _)| *e == entry) {
                out.push((entry, r.site, Whose::Fetched));
            }
        }
    }
    out
}

/// Whose an entry a node serves a body under is: its own listing, another contributor's it fetched, or another
/// contributor's whose signed listing names a body this node keeps for an entry it fetched.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Whose {
    Own,
    Fetched,
    Seen,
}

/// `entry`, when this node seeds the body `content_id` and the signed listing it read for `entry` names that body and
/// still checks against the chain (its signer's, live, under a posted root). Only when the owner serves kept routes.
async fn seen_under(node: &Node, content_id: &str, entry: FixedBytes<32>) -> Option<(FixedBytes<32>, String, Whose)> {
    if !seeds_kept_body(&store::load_settings()) {
        return None;
    }
    let p = node.share.known(entry).filter(|p| p.listing.content_id == content_id)?;
    let v = listing::verify(&node.chain, &p).await.ok()?;
    Some((entry, v.proven.listing.site, Whose::Seen))
}

/// Releases a body this node holds against a payment for it (R3.11, R7.5): a body voucher for one of the entries this
/// node serves the body under and for this body, covering that entry's fee, its agent authorised and unexpired, its
/// payer's deposit covering it, its epoch current and its nonce unspent. Every check is made against the voucher's own
/// entry: it must be live, and one of this node's own is still this node's on the chain. The release is noted, so a
/// passed line for the use is kept when it comes.
/// How long a release may take in all, its chain reads included (R11-CHAIN-1): one stalled reply can't stretch it
/// past this, and nothing is served once it has passed.
pub(crate) const RELEASE_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

/// What runs just before a release reserves its line's place, for a test that moves the chain then.
#[cfg(test)]
pub(crate) static BEFORE_RESERVE: std::sync::Mutex<Option<std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>>> = std::sync::Mutex::new(None);

/// `release_within`, held to `RELEASE_DEADLINE`.
async fn release(node: &Node, from: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(RELEASE_DEADLINE, release_within(node, from, content_id, payment)).await {
        Ok(out) => out,
        Err(_) => Err(format!("the release took longer than {}s, so nothing was served", RELEASE_DEADLINE.as_secs())),
    }
}

async fn release_within(node: &Node, from: PeerId, content_id: &str, payment: &[u8]) -> Result<Vec<u8>, String> {
    // The owner's pause stops what the node does for others as much as for its own agents.
    if store::load_settings().paused {
        return Err("the node is paused by its owner".into());
    }
    let under = held(&node.chain, content_id);
    if under.is_empty() {
        return Err("this node doesn't serve that body".into());
    }
    // One reading of the epoch a witness stands behind, for this release (R9-CHAIN-1): what lifts the books' bounds and
    // what the voucher is held to, never whether a second RPC is merely named. A contradiction refuses the release.
    // One head followed for the whole release (`rpc::Head`): one `anchor::advance`, every reading made at it.
    let head = chain::follow_head(&node.chain).await?;
    let seen = chain::witness_epoch_at(&node.chain, &head).await?;
    // With a second RPC named and no head it stands behind now, nothing paid is served: fail closed before any work.
    if seen.is_none() && crate::rpc::second_url()?.is_some() {
        return Err("no finalized head the second RPC stands behind can be followed now, so no paid body is served; try again".into());
    }
    // A line this node couldn't keep would be dropped: with its books full, it takes on none (R6-CHAIN-3). Checked here
    // first, so a full node spends no voucher; the place itself is reserved below, as the body goes out.
    chain::may_take_paid_lines(seen.is_some())?;
    if crate::leak::taken_down(content_id) {
        return Err("that body was proven to leak a credential and is taken down".into());
    }
    let bytes = recipe::load_body(content_id).ok_or("this node doesn't hold that body")?;
    let v = network::BodyVoucher::from_bytes(payment)?;
    // The entry is the one the voucher pays for, so long as its listing names this body; an entry whose listing
    // names another is paid for with another body's voucher. A node that keeps the body for one entry also serves it
    // for another whose signed listing it has read and checked and that names the same body: the body is the same
    // bytes whichever entry lists it.
    let (entry, site, whose) = match under.into_iter().find(|(e, _, _)| *e == v.entry_id) {
        Some(u) => u,
        None => seen_under(node, content_id, v.entry_id).await.ok_or("the voucher pays for an entry this node doesn't serve that body under")?,
    };
    // The listing the body is served under, checked as a caller checks it (`listing::verify`): signed and under a posted
    // root, and, once a claim has credited the body's entry, credited to the same contributor and live. No claim may
    // have shown it yet: a listing is on the chain only from its first claim (R2.18), so its server takes vouchers for
    // it before then too, at its listed price (spec §76 item 2).
    let me = chain::owner_address(node.keys.as_ref())?;
    // This node's listings are credited to its own wallet (`listing::lister`, issue #184).
    let ours = [me, listing::lister_wallet(&node.chain, node.keys.as_ref()).await?];
    let p = match whose {
        Whose::Own => listing::load_book(&node.chain).of_entry(entry),
        _ => listing::held_listing(&node.chain, entry).or_else(|| node.share.known(entry)),
    }
    .ok_or("this node holds no posted listing of the entry")?;
    let e = listing::verify(&node.chain, &p).await?;
    if whose == Whose::Own && !ours.contains(&e.contributor) {
        return Err("the entry is another contributor's".into());
    }
    network::verify_body_voucher(&node.chain, &v, entry, content_id, e.fee_units, seen, &head).await?;
    // A body callers pay for is one the store keeps longest.
    recipe::used_body(content_id, std::time::SystemTime::now());
    #[cfg(test)]
    {
        let hook = BEFORE_RESERVE.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(hook) = hook {
            hook.await;
        }
    }
    // The voucher's window judged again at the finalized height now, right before anything is reserved or served
    // (R11-CHAIN-1): the head above is a snapshot. It is the LAST thing a release awaits (R12-CHAIN-1): from here to
    // the bytes going out only local work runs (the reservation, the activity line), so no reply the chain is slow to
    // give can carry the release past the voucher's closing epoch after it was judged open.
    // -- last chain read --
    network::still_open_now(&node.chain, v.epoch, &head).await?;
    // The line's place in the books, reserved before the body goes out (R7-CHAIN-1): refused, nothing is released.
    // Old notes go only by a witnessed epoch (R7-CHAIN-2), read with the voucher just now (`verify_body_voucher`).
    network::reserve_served(me, &v, seen.is_some())?;
    store::log_activity(&store::Activity {
        at: store::now(),
        who: format!("peer:{from}"),
        site,
        what: format!("Served a route's body to {:#x}", v.payer),
        kind: "body".into(),
        result: "done".into(),
        ms: None,
        unb: Some(e.fee),
        tx: None,
        note: Some("Paid when the caller's use of it passes: the line names this node as its server, which earns it the serving share. A failed use costs the caller nothing.".into()),
    });
    node.events.emit("activity", ());
    Ok(bytes)
}

// ---- seeding ----

/// Announces this node as a provider of a body (R7.18), only when it would serve it: one of its own routes' always, as
/// their contributor; one it fetched unless the owner keeps it in light mode or off the network. Never a body set
/// aside (`Share::set_aside`), which this node won't run and so doesn't hand on. The table refreshes the record every
/// epoch until the node stops, or lets the body go (`trim`).
pub async fn provide(node: &Node, content_id: &str, own: bool) {
    let Some(net) = node.net.get() else { return };
    if !own && !seeds_kept_body(&store::load_settings()) {
        return;
    }
    if node.share.refused(content_id).is_some() || crate::leak::taken_down(content_id) {
        return;
    }
    if let Err(e) = net.provide_body(content_id).await {
        eprintln!("peers: couldn't announce a body: {e}");
    }
}

/// Whether a body this node fetched and keeps is seeded (announced by its content id): only when the owner chose to
/// serve kept routes (`peers::announces_kept`). A body of a route the node lists itself is its contributor's to serve,
/// and always is.
pub fn seeds_kept_body(settings: &store::Settings) -> bool {
    crate::peers::announces_kept(settings)
}

/// Every body this node serves, announced as it joins: the current version of each route it lists live, and each body
/// it fetched and keeps, once the store is within its bound (`trim`). Only a body whose bytes are on disk is announced:
/// a caller sent to a node that has let a body go pays for nothing and sets the node aside. A body is announced once by
/// its content id, which every entry it serves is fetched by.
pub async fn provide_all(node: &Node) {
    trim(node).await;
    // What the node read of sites' opt-outs went with its last run: read again first, so a listing or a kept body whose
    // site opted out for Unbrowse isn't announced again (`autolist::opted_out`, `listed_today`).
    crate::autolist::opted_out(node).await;
    let on_disk: std::collections::HashSet<String> = recipe::kept_bodies().into_iter().map(|(c, _, _)| c).collect();
    let live: std::collections::HashSet<String> = store::load_routes().iter().filter(|r| listed_today(r)).map(|r| r.id.clone()).collect();
    let mut said = std::collections::HashSet::new();
    for p in listing::load_book(&node.chain).current().into_iter().filter(|p| live.contains(&p.listing.route_id)) {
        if on_disk.contains(&p.listing.content_id) && said.insert(p.listing.content_id.clone()) {
            provide(node, &p.listing.content_id, true).await;
        }
    }
    for r in store::load_routes() {
        // Nor is a kept body announced whose site opted out for Unbrowse (R4.32).
        if crate::optout::known_refusal(&r).is_some() {
            continue;
        }
        if let Some(f) = r.fetched {
            if on_disk.contains(&f.content_id) && said.insert(f.content_id.clone()) {
                provide(node, &f.content_id, false).await;
            }
        }
    }
}

// ---- the body store ----

/// How long a body this node's agents used stays pinned after its last use (or its fetch): a week, so a task an agent
/// comes back to weekly never pays for the same body twice, while a body nobody here has used for longer is the first
/// the store lets go once it is full. Its route runs from the copy until then, as before.
pub const PINNED_FOR: u64 = 7 * 86_400;

/// How long a body file that no listing or route names yet is pinned: whatever kept it (a publish, a fetch's `keep`)
/// names it in the next moment, and the store must not let it go in between.
pub const JUST_KEPT: u64 = 10 * 60;

/// The node's store of route bodies as it stands on disk at `now` (seconds), each body with its footprint (its file and
/// the route records made from it), when it was last used, and whether it is pinned (IPFS's pinning, R7.18 note):
///
/// - a body the node lists itself, any version of it, on any chain (`listing::listed_bodies`), is pinned: it is the node's own route,
///   and its callers fetch it from here;
/// - a body a route made from it was used within `PINNED_FOR` is pinned: this node's agents use it;
/// - anything else is a cache, let go least recently used first once the store is over its bound (`trim`).
///
/// A body's last use is the latest of its file's time (when it was kept or last served to a paying caller,
/// `recipe::used_body`), and the last call and the fetch of each route made from it. All of it is read from disk, so
/// a restart accounts for the store exactly as before it.
pub fn body_store(now: u64) -> Vec<store::Stored> {
    let own = listing::listed_bodies();
    let mut by: HashMap<String, (store::Stored, bool)> = HashMap::new();
    for (content_id, bytes, at) in recipe::kept_bodies() {
        let pinned = own.contains(&content_id);
        by.insert(content_id.clone(), (store::Stored { content_id, bytes, used_at: at, pinned }, false));
    }
    // A route made from a body counts toward it, even when the body's file is gone: it is the same body, kept to run.
    for r in store::load_routes() {
        let Some(f) = &r.fetched else { continue };
        let used = r.stats.last_at.unwrap_or(0).max(f.fetched_at);
        let (s, named) = by.entry(f.content_id.clone()).or_insert_with(|| (store::Stored { content_id: f.content_id.clone(), bytes: 0, used_at: 0, pinned: own.contains(&f.content_id) }, false));
        s.bytes += store::route_bytes(&r.id);
        s.used_at = s.used_at.max(used);
        s.pinned |= now.saturating_sub(used) < PINNED_FOR;
        *named = true;
    }
    by.into_values()
        .map(|(mut s, named)| {
            // A body no listing and no route names, kept a moment ago: what kept it is about to name it.
            if !named && !own.contains(&s.content_id) && now.saturating_sub(s.used_at) < JUST_KEPT {
                s.pinned = true;
            }
            s
        })
        .collect()
}

/// Keeps the store within `storage_gb` (`store::body_bound`): every body `store::over_bound` chooses, unpinned and least
/// recently used first, is let go (`evict`). Run after each body kept, as the node joins, and on the background pass,
/// so a lowered setting or a pin that lapsed takes effect within a minute. Returns the bodies let go.
pub async fn trim(node: &Node) -> Vec<String> {
    let bound = store::body_bound(store::load_settings().storage_gb);
    let stored = body_store(store::now());
    let out = store::over_bound(&stored, bound);
    if out.is_empty() {
        return out;
    }
    sut_reachable!("the body store let go of its least recently used bodies to stay within storage_gb", &serde_json::json!({ "bodies": out.len() }));
    for content_id in &out {
        evict(node, content_id).await;
    }
    store::log_activity(&store::Activity {
        at: store::now(),
        who: "Node".into(),
        site: String::new(),
        what: format!("Let go of {} route bod{} nobody here used lately, to stay within storage", out.len(), if out.len() == 1 { "y" } else { "ies" }),
        kind: "body".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some("A route made from one is fetched again, and paid for, the next time an agent asks for it".into()),
    });
    node.events.emit("activity", ());
    out
}

/// Lets a body go: the routes made from it, its bytes, and the node's provider record for it, so the table stops
/// sending callers here for a body this node no longer holds (R7.18). A route made from it is fetched again, and paid
/// for, the next time an agent asks for it.
async fn evict(node: &Node, content_id: &str) {
    for r in store::load_routes().into_iter().filter(|r| r.fetched.as_ref().is_some_and(|f| f.content_id == content_id)) {
        let _ = store::delete_route(&r.id);
        if let Some(entry) = r.fetched.as_ref().and_then(|f| f.entry_id.parse::<FixedBytes<32>>().ok()) {
            node.share.forget_live(entry);
        }
    }
    recipe::drop_body(content_id);
    if let Some(net) = node.net.get() {
        let _ = net.stop_providing_body(content_id).await;
    }
    peers::listings_changed().await;
}

// ---- fetching ----

/// The route made from an entry's body this node fetched before, if it still has it.
pub fn cached(entry: &str) -> Option<store::Route> {
    let entry: FixedBytes<32> = entry.parse().ok()?;
    let entry = format!("{entry:#x}");
    // A kept body is run from the cache only while it passes every check a fetched body passes now (`recheck_kept`).
    store::load_routes().into_iter().find(|r| r.fetched.as_ref().is_some_and(|f| f.entry_id.eq_ignore_ascii_case(&entry) && recheck_kept(f).is_ok()))
}

/// Whether the kept body behind `f` passes every check a fetched body passes now (`recipe::recheck`): one kept before a
/// rule was added doesn't. A route whose body bytes the store let go of can't be checked again and runs as it was kept;
/// bytes that are there and no longer hash to their name are another body.
fn recheck_kept(f: &store::Fetched) -> Result<(), String> {
    match recipe::kept_bytes(&f.content_id) {
        Some(b) => recipe::recheck(&b, &f.content_id, body_rule(&f.content_id)).map(drop).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// Why a route made from someone else's kept body doesn't run, if it doesn't: the body is set aside, or no longer passes
/// the checks. Every way to a kept route runs through here (`run_route`, the owner's own call), not only a call that
/// names its entry: it runs under the owner's session, and a route found by its id or its goal is the same body.
pub fn may_run_kept(node: &Node, route: &store::Route) -> Result<(), String> {
    let Some(f) = &route.fetched else { return Ok(()) };
    if let Some(why) = node.share.refused(&f.content_id) {
        return Err(why);
    }
    // A site's word against its routes reaches kept copies as a contributor's delisting does (R4.17).
    if crate::sitepolicy::of(&route.site).is_some_and(|p| p.delisted) {
        return Err(format!("{} delisted its routes (its site policy, R4.17)", route.site));
    }
    recheck_kept(f)
}

/// Whether a refusal of `route`'s call is the body's own doing: what its steps say breaks the rule by itself (plain HTTP,
/// an address inside, a host made at call time), so it would be refused anywhere. A body whose steps all pass was refused
/// for where a name resolved or a site redirected on this network just now: a VPN or a captive portal does that to every
/// body it touches, and that is nothing to delete a paid-for copy over.
pub fn refused_for_what_it_says(route: &store::Route) -> bool {
    route.graph.steps.iter().any(|s| {
        let authority = s.url.split_once("://").map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default()).unwrap_or_default();
        let url = (!authority.contains(['{', '}'])).then(|| url::Url::parse(&s.url.replace('{', "%7B").replace('}', "%7D")).ok()).flatten();
        url.is_none_or(|u| unbrowse_learn::egress::Egress::Foreign.request(&u).is_err())
    })
}

/// A fetched route that failed is let go: a version is reused only while it works (R3.12), and the next call fetches
/// the entry's body afresh. The node stops seeding the body, unless it still serves it under another entry.
pub async fn drop_cached(node: &Node, route: &store::Route) {
    let Some(f) = &route.fetched else { return };
    let _ = store::delete_route(&route.id);
    peers::listings_changed().await;
    if !held(&node.chain, &f.content_id).is_empty() {
        return;
    }
    if let Some(net) = node.net.get() {
        let _ = net.stop_providing_body(&f.content_id).await;
    }
}

/// The signed listing of `entry`, checked against the chain as it is now (R2.15, R3.9): the one this node read last
/// (a search reads them), else found again from the peers that hold the entry's site.
pub async fn listing_of(node: &Node, entry: FixedBytes<32>) -> Result<listing::Verified, String> {
    if let Some(p) = node.share.known(entry).or_else(|| listing::held_listing(&node.chain, entry)) {
        if let Ok(v) = listing::verify(&node.chain, &p).await {
            return Ok(v);
        }
    }
    let domain = chain::listed_entries(&node.chain)
        .await?
        .into_iter()
        .find(|e| e.entry_id == entry && e.live)
        .map(|e| e.domain)
        .ok_or("this node holds no listing of the entry, and no claim has credited it on the chain: search its site first")?;
    let (found, _) = peers::find_signed(node, &domain).await.ok_or("the node isn't on the peer network, so it can't read the entry's signed listing")?;
    found.into_iter().find(|v| v.entry() == entry).ok_or_else(|| "no node answered with the entry's signed listing".into())
}

/// An entry's body, fetched and checked, as a route this node runs. Nothing of it is on disk yet: `keep` keeps it once
/// its use has a line.
pub struct Got {
    pub route: store::Route,
    /// The wallet of the node that served it: the use's line names it as its server.
    pub server: Option<Address>,
    /// The peer that served it, where the use's receipt is handed when its node isn't on this machine.
    pub server_peer: Option<PeerId>,
    /// The body's bytes, as checked against the listing's content identifier.
    pub body: Vec<u8>,
}

/// Why no body came back. `dark` says whether that is the entry's providers serving nothing (R7.11, R7.20): those
/// asked served no listed body, every provider was already set aside for serving nothing, or the lookups found none.
/// A failure of the caller's own (its chain, its keys, its disk, no network, a provider lookup that errored) says
/// nothing about the entry and doesn't set it aside. `refused` says the listed body was
/// served and is one this node won't run (`recipe::goes_where_it_may`): its body is set aside, not dark, and the try
/// is never made, so it makes no line (R2.28).
#[derive(Debug)]
pub struct NoBody {
    pub why: String,
    pub dark: bool,
    pub refused: bool,
}

/// Why a fetch has no provider left to ask, given how many providers of the body it knew of before those set aside
/// (R7.20) were left out, and whether a lookup of them errored. An entry is dark only when none of its providers serves
/// it (R7.11, R7.20): every provider it knew set aside for serving nothing (perhaps under another entry with the same
/// body), or lookups that answered with no provider at all, mean none serves it. Only a lookup that errored and left
/// it knowing nobody is this node's own failure, which says nothing about the entry.
fn no_provider_left(known: usize, lookup_failed: bool) -> NoBody {
    match (known, lookup_failed) {
        (0, true) => NoBody { why: "this node couldn't look up the nodes that serve the body".into(), dark: false, refused: false },
        (0, false) => NoBody { why: "no node serves the body".into(), dark: true, refused: false },
        _ => NoBody { why: "every node that serves the body served nothing lately and is set aside".into(), dark: true, refused: false },
    }
}

/// Fetches the body `v` lists (R3.9–R3.11, R7.9): from the contributor's own nodes, read from its identity's metadata
/// (R1.15), then the providers the table lists (R7.18), without any set aside for this body (R7.20). Each ask pays
/// with a fresh voucher for this body of this entry at its fee. A body is used only once its bytes are the ones the
/// signed listing names; one that isn't, or no answer, sets that provider aside and the next is asked. The body is made
/// a route (`recipe::into_route`) and handed back unsaved: the caller writes the use's line and only then keeps it
/// (`keep`), so a crash, a refusal or a failed run between the two never leaves a body kept that no line paid for.
pub async fn fetch(node: &Node, agent: u32, v: &listing::Verified) -> Result<Got, NoBody> {
    // The caller's own failure, before any provider is asked or after one served the listed body.
    let fail = |e: String| NoBody { why: e, dark: false, refused: false };
    let l = &v.proven.listing;
    // The identifier comes from the contributor's signed word, never from whoever serves the body.
    let content_id = l.content_id.as_str();
    let entry = l.entry();
    // A body proven to leak is never fetched or paid for again (R7.20).
    if crate::leak::taken_down(content_id) {
        return Err(NoBody { why: "the body was proven to leak a credential and is taken down".into(), dark: false, refused: true });
    }
    let net = node.peers().ok_or_else(|| fail("the node isn't on the peer network".into()))?;
    let d = node.chain.deployed().map_err(fail)?;
    let domain = chain::domain(&d);
    let epoch = chain::current_epoch(&node.chain).await.map_err(fail)?;
    // The voucher's payer: the owner's wallet once it granted this agent's key, else the node's own (spec §76.1).
    let me = chain::payer_of(node.keys.as_ref(), agent, epoch).map_err(fail)?;

    // Who serves the body. A lookup that errors is this node's own failure, kept apart from one that found nobody.
    let (contributors, identity_failed): (Vec<PeerId>, bool) = match peers::registry(node) {
        Ok(r) => match r.identity(&l.agent_id).await {
            Ok(i) => (i.map(|i| i.nodes.into_iter().map(|(p, _)| p).collect()).unwrap_or_default(), false),
            Err(_) => (vec![], true),
        },
        Err(_) => (vec![], true),
    };
    let (table, table_failed) = match net.find_body_providers(content_id).await {
        Ok(found) => (found, false),
        Err(_) => (vec![], true),
    };
    let mut asked = contributors.clone();
    for p in table {
        if !asked.contains(&p) {
            asked.push(p);
        }
    }
    asked.retain(|p| *p != net.peer_id());
    let known = asked.len();
    let asked = node.share.providers().usable(content_id, asked, epoch);
    if asked.is_empty() {
        return Err(no_provider_left(known, identity_failed || table_failed));
    }

    let mut why = Vec::new();
    for peer in asked {
        let voucher = network::sign_body_voucher(node.keys.as_ref(), agent, &domain, me, entry, content_id, v.fee_units, epoch).map_err(fail)?;
        let body = match net.fetch_body(peer, content_id, &voucher.to_bytes()).await {
            Ok(body) => body,
            // It answered, and wouldn't serve: what it said is the reason, and it isn't set aside for answering.
            Err(FetchError::Refused(r)) => {
                why.push(format!("a provider refused: {r}"));
                continue;
            }
            // The ask itself is out of bounds: no provider would take it.
            Err(FetchError::Invalid(r)) => return Err(fail(r)),
            // This node's network stopped under the ask: the failure is its own, and is no mark against the peer.
            Err(_) if net.stopped() => return Err(fail("the node left the peer network".into())),
            Err(e) => {
                node.share.providers().failed(content_id, peer, epoch);
                why.push(e.to_string());
                continue;
            }
        };
        // Every check runs before anything runs the body (`recipe::admit`): the listed bytes are read by the pinned
        // detector (R6.36), and a body that sets the session, the connection or a credential of its own, or goes
        // where a route this node didn't learn itself may not, is the listed one all the same: every provider serves
        // the same, so the entry is set aside and no other is asked. Never used and never paid for: the line is
        // written for a use, and this was none (R7.19).
        let route = match recipe::admit(&body, l, body_rule(content_id)) {
            Ok(route) => route,
            Err(recipe::Refusal::NotListed(e)) => {
                node.share.providers().failed(content_id, peer, epoch);
                why.push(format!("a provider served a body that isn't the listed one ({e})"));
                continue;
            }
            Err(recipe::Refusal::Leaks(hit)) => {
                node.share.providers().served(content_id, peer);
                crate::leak::found(node, &v.proven, &body, hit);
                let why = format!("{}: it is set aside, and this node reports it", recipe::Refusal::Leaks(hit));
                return Err(NoBody { why, dark: false, refused: true });
            }
            Err(recipe::Refusal::SetAside(e)) => {
                node.share.providers().served(content_id, peer);
                node.share.set_aside(content_id, &e);
                return Err(NoBody { why: e, dark: false, refused: true });
            }
            Err(recipe::Refusal::Unrunnable(e)) => {
                node.share.providers().served(content_id, peer);
                return Err(fail(e));
            }
        };
        node.share.providers().served(content_id, peer);
        // The payer keeps the listing it paid under, with its proof: its claim of the line carries it while no claim
        // has credited the entry (R2.18, spec §76 item 2).
        listing::remember(&node.chain, &v.proven);
        let server = if contributors.contains(&peer) {
            Some(v.contributor)
        } else {
            match net.admit(peer).await {
                Standing::Counts(id) => listing::identity_key(&node.chain, &id).await.ok(),
                _ => None,
            }
        };
        return Ok(Got { route, server, server_peer: Some(peer), body });
    }
    // Every provider asked answered nothing, refused, or served another body: the entry served nothing.
    Err(NoBody { why: why.join("; "), dark: true, refused: false })
}

/// Keeps a fetched body whose use has a passed line: the body and its route on disk, reused with no new payment while
/// it works (R3.12), and seeded (R7.18). It is pinned, having just been used, and the store lets go of what no longer
/// fits beside it (`trim`).
pub async fn keep(node: &Node, route: &store::Route, body: &[u8]) -> Result<(), String> {
    let Some(f) = &route.fetched else { return Ok(()) };
    recipe::save_body(body)?;
    store::save_route(route)?;
    provide(node, &f.content_id, false).await;
    trim(node).await;
    // A route kept is found here too while its contributor is offline (spec §103), when the owner chose to serve kept
    // routes; otherwise using it says nothing to the network. `provide` also watches the site, and a copy kept is a
    // route whose delist this node must hear of, so it is watched either way.
    if peers::announces_kept(&store::load_settings()) {
        peers::provide(node, &route.site).await;
    } else {
        watch(node).await;
    }
    Ok(())
}

// ---- change notices ----

/// How long the node remembers when it last began reading the chain for an entry because of a notice. A notice that
/// arrived before such a read began is one the read answers; one older than this is read again, which only costs a read.
const RECHECKED_FOR: Duration = Duration::from_secs(60);

/// The sites whose change notices this node watches: those it lists live routes for, so it is on the topic its own
/// notices go out on; those it keeps another contributor's body for; and those it holds routes for.
pub fn watched_sites() -> Vec<String> {
    let mut sites: Vec<String> = store::load_routes()
        .into_iter()
        .filter(|r| r.fetched.is_some() || r.listing.as_ref().is_some_and(|l| l.live))
        .map(|r| r.site)
        .chain(store::load_held().into_iter().map(|h| h.site))
        .collect();
    sites.sort();
    sites.dedup();
    sites
}

/// Watches the sites `watched_sites` names, and no others.
pub async fn watch(node: &Node) {
    if let Some(net) = node.net.get() {
        if let Err(e) = net.watch(watched_sites()).await {
            eprintln!("peers: couldn't watch the sites this node keeps routes for: {e}");
        }
    }
}

/// The notices that say this node changed `entries` on the chain, each `(site, entry)`: one a site, at most
/// `MAX_CHANGED` entries each.
fn notices(kind: ChangeKind, entries: Vec<(String, FixedBytes<32>)>) -> Vec<Change> {
    let mut by_site: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    for (site, entry) in entries {
        let Some(site) = unbrowse_net::site_of(&site) else { continue };
        let ids = by_site.entry(site).or_default();
        let id = format!("{entry:#x}");
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    by_site
        .into_iter()
        .flat_map(|(site, ids)| ids.chunks(unbrowse_net::changes::MAX_CHANGED).map(|c| Change::now(&site, kind, c.to_vec())).collect::<Vec<_>>())
        .collect()
}

/// Says on each site's topic that this node changed `entries` on the chain, once the change has landed there: the
/// nodes that keep or serve them read the chain again now rather than within `LIVE_FOR`. It runs in the background:
/// a node that hears nothing reads the chain on its own schedule, so a notice that doesn't go out costs only time.
pub fn announce(node: &Node, kind: ChangeKind, entries: Vec<(String, FixedBytes<32>)>) {
    publish(node, notices(kind, entries));
}

/// Publishes notices in the background.
fn publish(node: &Node, notices: Vec<Change>) {
    let Some(net) = node.net.get().cloned() else { return };
    tokio::spawn(async move {
        for c in notices {
            let site = c.site.clone();
            if let Err(e) = net.publish_change(c).await {
                eprintln!("peers: couldn't tell the nodes watching {site}: {e}");
            }
        }
    });
}

/// Says on the site's topic that this node delisted the route whose body is `entry`. The notice carries the delist
/// signed by the key that signed the listing (`listing::sign_withdrawal`): the chain holds the entry only once a claim
/// has credited it, and until then the signature is the contributor's word that the listing is withdrawn (R2.16).
pub async fn announce_delist(node: &Node, site: &str, entry: FixedBytes<32>) {
    let signed = async {
        let content = listing::load_book(&node.chain).listings.into_iter().find(|k| k.listing.entry() == entry).map(|k| k.listing.content_id).ok_or("no listing of it")?;
        let lister = listing::lister(&node.chain, node.keys.as_ref(), &node.info.name).await?;
        let domain = chain::domain(&node.chain.deployed()?);
        let site = unbrowse_net::site_of(site).ok_or("not a site")?;
        let mut c = Change::now(&site, ChangeKind::Delisted, vec![format!("{entry:#x}")]);
        // A withdrawal is a raw digest, which a wallet's provider won't sign, so a node under its owner's wallet says
        // it unsigned: the chain's entry, once a claim credits it, is the wallet's to delist (`EntryStep::Wallet`).
        let key = lister.key.ok_or("this node lists under its owner's wallet, whose key it doesn't hold")?;
        c.signed = vec![listing::sign_withdrawal(&key, &domain, entry, &content, c.at)?];
        Ok::<_, String>(c)
    };
    match signed.await {
        Ok(c) => publish(node, vec![c]),
        Err(e) => {
            eprintln!("peers: couldn't sign the delist of {entry:#x}, so it goes out unsigned: {e}");
            announce(node, ChangeKind::Delisted, vec![(site.to_string(), entry)]);
        }
    }
}

/// The listings of `listings`, all of `entry`, that `sig`, a withdrawal signed at `at`, takes back: those the same key
/// signed. Any other contributor's listing of the body is theirs to withdraw.
fn withdrawn_by<'a>(listings: &'a [listing::Proven], domain: &alloy::sol_types::Eip712Domain, entry: FixedBytes<32>, sig: &str, at: u64) -> Vec<&'a listing::Proven> {
    listings
        .iter()
        .filter(|p| match (p.listing.signer(domain), listing::withdrawal_signer(sig, domain, entry, &p.listing.content_id, at)) {
            (Ok(lister), Ok(signer)) => lister == signer,
            _ => false,
        })
        .collect()
}

/// Reads `sig`, the signed withdrawal of `entry` a notice carried: an entry no claim has put on the chain is withdrawn
/// by its contributor's signature alone (R2.16). Noted whether or not this node keeps a copy, since a node that only
/// read the listing must not fetch it either. The listings read before a restart are gone from memory, so those kept
/// on disk are read too. Whether the entry is now withdrawn.
async fn hear_withdrawal(node: &Node, entry: FixedBytes<32>, sig: &str, at: u64) -> bool {
    let Ok(d) = node.chain.deployed() else { return false };
    if !matches!(chain::entry_by_hash(&node.chain, entry).await, Ok(None)) {
        return false;
    }
    for p in listing::known_of(&d, entry) {
        node.share.saw(&p);
    }
    let read = node.share.listings_of(entry);
    for p in withdrawn_by(&read, &chain::domain(&d), entry, sig, at) {
        node.share.withdraw(&p.listing, at);
    }
    node.share.withdrawn(entry)
}

/// Says on their sites' topics that this node's fee changed, which every entry it lists live charges.
pub fn announce_reprice(node: &Node) {
    let entries = store::load_routes()
        .into_iter()
        .filter_map(|r| r.listing.filter(|l| l.live).and_then(|l| l.entry_id.parse::<FixedBytes<32>>().ok()).map(|e| (r.site, e)))
        .collect();
    announce(node, ChangeKind::Repriced, entries);
}

/// A change notice from a node that counts: the chain is read again, now, for each entry it names that this node keeps
/// a copy of or holds. A kept copy whose entry is delisted is dropped (`still_listed`); a held route whose entry is
/// delisted is released, and one still live takes the fee the chain shows. Whatever the notice says, only what the
/// chain says changes anything, so a notice for an entry still live, or one this node has nothing of, changes nothing.
pub async fn on_change(node: &Node, heard: Heard, arrived: Instant) {
    for (i, id) in heard.change.entries.iter().enumerate() {
        let Ok(entry) = id.parse::<FixedBytes<32>>() else { continue };
        {
            // A read of the entry that began after this notice arrived saw the chain as it was after the change the
            // notice tells of, so it answers this notice too. One that began before it, however recent, didn't: a
            // second notice soon after a first is a second change, and is read again.
            let mut rechecked = node.share.rechecked.locked();
            if rechecked.get(&entry).is_some_and(|began| *began > arrived) {
                continue;
            }
            let now = Instant::now();
            rechecked.insert(entry, now);
            if rechecked.len() > unbrowse_net::MAX_KEPT {
                rechecked.retain(|_, began| now.saturating_duration_since(*began) < RECHECKED_FOR);
            }
        }
        let withdrawn = match heard.change.signed.get(i).filter(|_| heard.change.kind == ChangeKind::Delisted) {
            Some(sig) => hear_withdrawal(node, entry, sig, heard.change.at).await,
            None => false,
        };
        for r in store::load_routes().into_iter().filter(|r| r.fetched.as_ref().is_some_and(|f| f.entry_id.parse::<FixedBytes<32>>().ok() == Some(entry))) {
            node.share.forget_live(entry);
            if withdrawn {
                drop_kept(node, &r, entry).await;
                eprintln!("peers: {} withdrew its route {id}, signed by the key that listed it: the copy this node kept is dropped", heard.identity);
                continue;
            }
            let read = store::Route { write: false, ..r };
            if still_listed(node, &read).await == Err(NotRun::Delisted) {
                eprintln!("peers: {} said its route {id} is delisted, and the chain agrees: the copy this node kept is dropped", heard.identity);
            }
        }
        recheck_held(node, entry).await;
    }
}

/// Reads the chain for a held route's entry: one delisted or withdrawn is released and no longer held, one still live
/// takes the fee the chain shows. A chain that can't be read leaves it as it is, and so does one no claim has credited.
async fn recheck_held(node: &Node, entry: FixedBytes<32>) {
    let _one = peers::HOLDS.lock().await;
    let held = store::load_held();
    let Some(h) = held.iter().find(|h| h.entry_id.parse::<FixedBytes<32>>().ok() == Some(entry)).cloned() else { return };
    let Ok(on_chain) = chain::entry_by_hash(&node.chain, entry).await else { return };
    let mut held = held;
    match on_chain {
        Some((_, e)) if e.live => {
            if (h.fee - e.fee).abs() < 1e-12 {
                return;
            }
            for x in held.iter_mut().filter(|x| x.entry_id == h.entry_id) {
                x.fee = e.fee;
            }
        }
        // No claim has credited it, so nothing on the chain can have delisted it (R2.18): it is withdrawn, if at all,
        // between nodes. Dropped here, the next tick would only hold it again.
        None if !node.share.withdrawn(entry) => return,
        _ => held.retain(|x| x.entry_id != h.entry_id),
    }
    let _ = store::save_held(&held);
}

/// Hands every change notice the network reads to `on_change`, one at a time, for as long as the network runs.
pub fn hear_changes(node: Arc<Node>, net: &unbrowse_net::Net) {
    let Some(mut heard) = net.changes() else { return };
    tokio::spawn(async move {
        while let Some(h) = heard.recv().await {
            // Taken off the stream no sooner than it arrived, so a read that began after this began after it came.
            let arrived = Instant::now();
            on_change(&node, h, arrived).await;
        }
    });
}

/// What happens to an entry's tries: a body served brings it back to the ranking, none sets it aside.
pub fn tried(node: &Node, entry: FixedBytes<32>, epoch: u64, served: bool) {
    if served {
        node.share.served(entry);
    } else {
        node.share.served_nothing(entry, epoch);
    }
}

// ---- running another contributor's body ----

/// Whose rule a route's calls run under (R2.28). A route this node learned itself is its own walk of the site: it
/// runs under the owner's rule, Reach private networks included, which an owner sets for their intranet. A route made
/// from another contributor's body is someone else's code: every request it makes, every redirect hop and every setup
/// step goes over HTTPS to a public internet address, checked against the address resolved for the connection, and
/// the owner's setting never applies to it.
pub fn egress(route: &store::Route) -> Egress {
    match &route.fetched {
        Some(f) => body_rule(&f.content_id),
        None => Egress::Own,
    }
}

/// The rule a body fetched from another node runs under: someone else's.
fn body_rule(content_id: &str) -> Egress {
    match run_as_own_in_this_test(content_id) {
        true => Egress::Own,
        false => Egress::Foreign,
    }
}

/// Bodies a test runs as if this node had learned them, by content identifier. A test's site is plain HTTP on this
/// machine, which no route of someone else's may reach; a test that carries a body between nodes on one machine
/// names it here. It is compiled into test builds only, so no setting, file or environment variable can reach it.
#[cfg(test)]
static OWN_IN_THIS_TEST: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[cfg(test)]
pub(crate) fn run_as_own_in_tests(content_id: &str) {
    OWN_IN_THIS_TEST.locked().push(content_id.to_string());
}

#[cfg(test)]
fn run_as_own_in_this_test(content_id: &str) -> bool {
    OWN_IN_THIS_TEST.locked().iter().any(|c| c == content_id)
}

#[cfg(not(test))]
fn run_as_own_in_this_test(_: &str) -> bool {
    false
}

/// Whether a route made from another contributor's body may run here (R2.7, R2.27–R2.28): it sends this node's session
/// values, and the secrets the vault fills in, only to hosts on the site the body lists, by registrable domain. A body
/// can't send the caller's session for its site to a host that isn't the site's, and a host it builds at call time,
/// which can't be checked before the call, never carries one. A step with no session value goes where the call takes
/// it, the agent having named the entry, but never off HTTPS or the public internet (`egress`), which the transport
/// holds every request of the route to. Anything refused here is never sent, so it makes no line. A route this node learned
/// itself is the node's own walk of the site, and passes.
pub fn bound(route: &store::Route) -> Result<(), String> {
    if route.fetched.is_none() {
        return Ok(());
    }
    for (n, s) in route.graph.steps.iter().enumerate() {
        let carries = s.fields.iter().any(|f| carries_the_callers(&f.class));
        if !carries {
            continue;
        }
        // The authority as the template writes it: a slot in it is a host made at call time.
        let authority = s.url.split_once("://").map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default()).unwrap_or_default();
        let host = (!authority.is_empty() && !authority.contains(['{', '}'])).then(|| url::Url::parse(&s.url.replace('{', "%7B").replace('}', "%7D")).ok()).flatten();
        // A host is the site's own when it is on the site (R2.27 (a)), or the site's policy declares it (R2.27 (b)).
        let declared = host.as_ref().is_some_and(|u| crate::sitepolicy::declares(&route.site, u));
        match host.as_ref().and_then(|u| u.host_str()) {
            Some(h) if declared || unbrowse_learn::identity::same_site(h, &route.site) => {}
            Some(h) => {
                return Err(format!("step {} of this route's body sends a session value to {h}, which isn't on {}: the node sends one only to the site's own hosts", n + 1, route.site))
            }
            None => return Err(format!("step {} of this route's body builds its host at call time and sends a session value there: the node sends one only to hosts it can check first", n + 1)),
        }
    }
    Ok(())
}

/// Whether a field's value can hold what this node keeps for the caller rather than what the body itself says: a
/// session value or vault secret, a value taken from an earlier answer (which this node's session may have fetched,
/// and which a cookie the source no longer sets would take from the jar), a value only the page's code makes, or a
/// fact about a local file. Only the body's own literals (a constant, a provisional value, a clock id) and the
/// agent's own non-secret words are not the caller's to lose.
fn carries_the_callers(class: &Class) -> bool {
    match class {
        Class::Minted { .. } | Class::Input { secret: true, .. } | Class::Derived { .. } | Class::Computed | Class::Script { .. } | Class::Recipe { .. } | Class::Generated { .. } | Class::File { .. } | Class::Piece { .. } => true,
        Class::Input { secret: false, .. } | Class::Constant { .. } | Class::Unconfirmed { .. } | Class::Fresh { .. } => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delisted_routes_body_is_not_served_as_this_nodes_own() {
        let route = |id: &str, live: Option<bool>| {
            let mut r: store::Route = serde_json::from_value(serde_json::json!({
                "id": id, "site": "shop.example", "what": "list items", "method": "GET", "path": "/api/items",
                "root": "https://shop.example/", "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
                "provisional": false, "learned_at": 1, "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200,
                    "url": "https://shop.example/api/items", "needs_browser": false, "fields": [], "response_shape": { "items": [{ "id": "number" }] } }] }
            }))
            .unwrap();
            r.listing = live.map(|live| store::Listing { entry_id: "0x1".into(), tx: String::new(), listed_at: 1, live });
            r
        };
        let routes = [route("listed", Some(true)), route("delisted", Some(false)), route("never", None)];
        // A route that would no longer be listed (judged by no reader this build knows) is served no more either.
        let stale = store::Route { read_by: None, ..route("stale", Some(true)) };
        assert!(!serves_own("stale", &[stale]), "a listing stands only while its route would be listed today");
        assert!(serves_own("listed", &routes));
        assert!(!serves_own("delisted", &routes), "withdrawn by no longer being served (R2.16)");
        assert!(!serves_own("never", &routes));
        assert!(!serves_own("deleted", &routes), "no record says it is listed");
    }

    /// Two listings of one body are one entry (R2.4) and both stand (R2.16): a node keeps each, so a goal finds the one
    /// whose words it says (R2.22) whichever was read last. A newer version of a contributor's listing of a route
    /// replaces its older one; an older one read late changes nothing.
    #[test]
    fn listings_that_share_a_body_are_each_known() {
        let said = |route: &str, words: &str, version: u64| listing::Proven {
            listing: listing::SignedListing {
                route_id: route.into(),
                site: "shop.example.com".into(),
                content_id: format!("sha256:{}", "8b".repeat(32)),
                agent_id: "7".into(),
                version,
                supersedes: None,
                terms: listing::Terms { description: words.into(), response: None, price: listing::Price::default() },
                sig: String::new(),
            },
            leaf: FixedBytes::ZERO,
            root: FixedBytes::ZERO,
            index: 0,
            proof: vec![],
        };
        let share = Share::default();
        share.saw(&said("route-cart", "Add an item to the cart", 1));
        share.saw(&said("route-lookup", "Look up items", 1));
        let words = |share: &Share| {
            let mut w: Vec<_> = share.known_on("https://shop.example.com/").into_iter().map(|p| (p.listing.terms.description, p.listing.version)).collect();
            w.sort();
            w
        };
        assert_eq!(words(&share), [("Add an item to the cart".to_string(), 1), ("Look up items".to_string(), 1)]);
        let entry = said("route-cart", "", 1).listing.entry();
        assert_eq!(share.known(entry).unwrap().listing.route_id, "route-lookup", "the one read last");
        assert_eq!(share.known_as(entry, "Add an item to the cart").unwrap().listing.route_id, "route-cart");
        share.saw(&said("route-cart", "Add one item to the cart", 2));
        share.saw(&said("route-cart", "Add an item to the cart", 1));
        assert_eq!(words(&share), [("Add one item to the cart".to_string(), 2), ("Look up items".to_string(), 1)]);
    }

    /// A change is told once a site, every page of a site under its registrable name, each entry once, in notices that
    /// fit the bound the network reads within.
    #[test]
    fn a_change_is_told_once_a_site_in_notices_within_the_bound() {
        let e = |n: u64| FixedBytes::<32>::from(alloy::primitives::U256::from(n).to_be_bytes::<32>());
        let mut entries = vec![("https://shop.example.com/items".to_string(), e(1)), ("example.com".to_string(), e(1)), ("other.example".to_string(), e(2))];
        entries.extend((0..40).map(|n| ("www.example.com".to_string(), e(100 + n))));
        entries.push(("not a site".to_string(), e(3)));
        let told = notices(ChangeKind::Delisted, entries);
        let sites: Vec<&str> = told.iter().map(|c| c.site.as_str()).collect();
        assert_eq!(sites, ["example.com", "example.com", "other.example"]);
        assert_eq!(told[0].entries.len() + told[1].entries.len(), 41, "each entry once");
        for c in &told {
            assert!(c.check(None, c.at).is_ok(), "{c:?}");
        }
    }

    /// An entry no provider served is off the ranking for the rest of that epoch and then one epoch, two, four and so
    /// on, doubling to 32; trying it again within an epoch counts that epoch once, and a body served brings it back.
    #[test]
    fn an_entry_that_serves_nothing_is_skipped_on_the_doubling_schedule() {
        let e = FixedBytes::repeat_byte(1);
        let mut d = Dark::default();
        assert_eq!(d.off_until(e, 10), None);
        d.served_nothing(e, 10);
        d.served_nothing(e, 10);
        assert_eq!(d.off_until(e, 10), Some(12), "the rest of epoch 10 and one epoch after");
        assert_eq!(d.off_until(e, 11), Some(12));
        assert_eq!(d.off_until(e, 12), None, "back on the ranking");
        d.served_nothing(e, 12);
        assert_eq!(d.off_until(e, 12), Some(15), "second dark epoch: two after");
        d.served_nothing(e, 15);
        assert_eq!(d.off_until(e, 15), Some(20), "third: four after");
        for epoch in [20, 30, 50, 100, 200, 300] {
            d.served_nothing(e, epoch);
        }
        assert_eq!(d.off_until(e, 300), Some(333), "capped at 32");
        assert_eq!(d.off_until(FixedBytes::repeat_byte(2), 300), None, "another entry stands");
        d.served(e);
        assert_eq!(d.off_until(e, 300), None);
    }

    /// The schedules are kept under the node's home: a node that restarts still skips the entry that served nothing
    /// and the provider it set aside, on the same schedule; a file that doesn't read is an empty schedule.
    #[test]
    fn a_restart_keeps_what_was_set_aside() {
        let home = std::env::temp_dir().join(format!("unbrowse-share-kept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let (e, peer) = (FixedBytes::repeat_byte(7), PeerId::random());
        {
            let share = Share::kept(&home);
            share.served_nothing(e, 10);
            share.providers().failed("sha256:aa", peer, 10);
        }
        let share = Share::kept(&home);
        assert_eq!(share.off_until(e, 10), Some(12));
        assert_eq!(share.providers().usable("sha256:aa", [peer], 10), Vec::<PeerId>::new());
        share.served(e);
        assert_eq!(Share::kept(&home).off_until(e, 10), None, "a body served clears it on disk too");
        std::fs::write(home.join(DARK_FILE), b"{\"v\":1,\"items\":[{\"entry\":").unwrap();
        assert_eq!(Share::kept(&home).off_until(e, 10), None, "a torn file is an empty schedule");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A fetch that fails for the caller's own reasons (here, it isn't on the peer network, and has no chain) asked no
    /// provider, so it says nothing about the entry: the entry isn't set aside for it.
    #[tokio::test]
    async fn entry_dark_only_when_providers_served_nothing() {
        let _home = store::scratch_home("dark");
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        let node = Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
            info: crate::NodeInfo { name: "n".into(), version: "test".into(), api_port: 0, dev: true },
            walks: crate::learn::Walks::default(),
            chain: chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: crate::api::Events::default(),
            net: std::sync::OnceLock::new(),
            share: Share::default(),
        };
        let listing: listing::SignedListing = serde_json::from_value(serde_json::json!({
            "route_id": "r1", "site": "shop.example", "content_id": format!("sha256:{}", "ab".repeat(32)), "agent_id": "7",
            "version": 1, "supersedes": null, "terms": { "description": "search the shop", "response": null, "price": listing::Price::default() }, "sig": ""
        }))
        .unwrap();
        let v = listing::Verified {
            proven: listing::Proven { listing, leaf: FixedBytes::ZERO, root: FixedBytes::ZERO, index: 0, proof: vec![] },
            contributor: Address::ZERO,
            fee: 0.01,
            fee_units: alloy::primitives::U256::from(10_000_000_000_000_000u64),
            root_block: 1,
            credited: false,
        };
        let e = fetch(&node, 0, &v).await.err().expect("no body");
        assert!(!e.dark, "{}", e.why);
    }

    /// An entry is dark when none of its providers serves it (R7.11, R7.20): when every provider of its body is already
    /// set aside, as after they served nothing under another entry with the same body, the entry is set aside too,
    /// though nobody was asked for it. A lookup that errored and found nobody is the caller's own failure.
    #[test]
    fn an_entry_whose_providers_are_all_set_aside_is_dark() {
        let share = Share::default();
        let (a, b) = (chain::test_entry("a"), chain::test_entry("b"));
        let body = "sha256:cd";
        let peer = PeerId::random();
        // Under entry A, the body's one provider served nothing.
        share.providers().failed(body, peer, 10);
        let known = 1;
        assert!(share.providers().usable(body, [peer], 10).is_empty());
        // Entry B lists the same body: no provider is left to ask, and B is dark.
        let e = no_provider_left(known, false);
        assert!(e.dark && !e.refused, "{}", e.why);
        share.served_nothing(b, 10);
        assert!(share.off_until(b, 10).is_some(), "B is off the ranking");
        assert_eq!(share.off_until(a, 10), None);
        assert!(no_provider_left(0, false).dark, "lookups that answered with nobody: no provider serves it");
        assert!(!no_provider_left(0, true).dark, "a lookup that errored says nothing about the entry");
        assert!(no_provider_left(2, true).dark, "providers it knew, all set aside");
    }

    fn fetched_route(steps: serde_json::Value) -> store::Route {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "steps": steps, "provisional": false })).unwrap();
        let mut r = store::Route::from_graph("r1-abc".into(), "GET".into(), "https://shop.example/".into(), graph).unwrap();
        r.walk_without_fragment = true;
        r.read_by = Some(crate::store::ReadBy::current());
        r.fetched = Some(store::Fetched {
            entry_id: format!("{:#x}", chain::test_entry("r1")),
            route_id: "r1".into(),
            agent_id: "7".into(),
            content_id: format!("sha256:{}", "ab".repeat(32)),
            listed_as: "search the shop".into(),
            fetched_at: 1,
        });
        r
    }

    fn step(url: &str, fields: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": fields, "needs_browser": false })
    }

    fn sid() -> serde_json::Value {
        serde_json::json!([{ "loc": { "in": "cookie", "key": "sid" }, "class": "minted", "name": "sid" }])
    }

    /// A body this node fetched sends this node's session only to hosts on the site it lists: a step carrying the
    /// session (or a vault secret) to another site's host, or to a host built at call time, keeps the route from
    /// running; a public step elsewhere doesn't.
    #[test]
    fn a_fetched_body_never_sends_the_session_off_its_site() {
        let on_site = fetched_route(serde_json::json!([step("https://api.shop.example/token", sid()), step("https://shop.example/api/items", sid())]));
        assert!(bound(&on_site).is_ok(), "the site's own hosts");
        let public_elsewhere = fetched_route(serde_json::json!([step("https://cdn.other.example/config", serde_json::json!([])), step("https://shop.example/api/items", sid())]));
        assert!(bound(&public_elsewhere).is_ok(), "no session value goes to the other host");
        let elsewhere = fetched_route(serde_json::json!([step("https://collect.other.example/t", sid()), step("https://shop.example/api/items", sid())]));
        assert!(bound(&elsewhere).unwrap_err().contains("collect.other.example"));
        let secret = serde_json::json!([{ "loc": { "in": "json", "key": "/password" }, "class": "input", "name": "password", "secret": true }]);
        let secret_elsewhere = fetched_route(serde_json::json!([step("https://login.other.example/in", secret), step("https://shop.example/api/items", sid())]));
        assert!(bound(&secret_elsewhere).is_err(), "a vault secret is a session value too");
        let built = fetched_route(serde_json::json!([step("https://{host}/t", sid()), step("https://shop.example/api/items", sid())]));
        assert!(bound(&built).unwrap_err().contains("call time"));
        let mut own = elsewhere.clone();
        own.fetched = None;
        assert!(bound(&own).is_ok(), "a route this node learned is its own walk of the site");
    }

    /// A listing can't carry the caller's session to its own host through a value taken from an earlier answer: a
    /// cookie whose recorded source stops setting it would come from the jar, and a token read from the site's own
    /// signed-in answer is the caller's too. Such a step off the site keeps the route from running; the same step on
    /// the site, or one to another host with only the agent's words and the body's literals, still runs.
    #[test]
    fn a_fetched_body_never_sends_a_derived_value_off_its_site() {
        let derived_cookie = serde_json::json!([{ "loc": { "in": "cookie", "key": "sid" }, "class": "derived",
            "origin": { "exchange": 0, "url": "https://shop.example/", "at": { "from": "set_cookie", "name": "sid" } } }]);
        let derived_token = serde_json::json!([{ "loc": { "in": "header", "key": "authorization" }, "class": "derived",
            "origin": { "exchange": 0, "url": "https://shop.example/api/me", "at": { "from": "json", "pointer": "/token" } } }]);
        for carried in [derived_cookie.clone(), derived_token] {
            let attack = fetched_route(serde_json::json!([step("https://shop.example/api/me", serde_json::json!([])), step("https://collect.attacker.example/t", carried.clone()), step("https://shop.example/api/items", serde_json::json!([]))]));
            assert!(bound(&attack).unwrap_err().contains("collect.attacker.example"), "{carried}");
        }
        let on_site = fetched_route(serde_json::json!([step("https://shop.example/", serde_json::json!([])), step("https://api.shop.example/items", derived_cookie)]));
        assert!(bound(&on_site).is_ok(), "on the site's own hosts");
        let words = serde_json::json!([{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": null },
            { "loc": { "in": "header", "key": "x-app-key" }, "class": "constant", "value": "public-search-key" }]);
        let search_elsewhere = fetched_route(serde_json::json!([step("https://search.other.example/1/query", words), step("https://shop.example/api/items", sid())]));
        assert!(bound(&search_elsewhere).is_ok(), "the agent's words and the body's literals go where the call takes them");
    }

    /// A host the site's own policy declares (R2.27 (b)) is the site's for a body's session values: exactly that host,
    /// under the path prefix it lists, and no other.
    #[test]
    fn a_host_the_sites_policy_declares_may_take_the_session() {
        let mut r = fetched_route(serde_json::json!([step("https://data.partner.example/v2/items", sid()), step("https://policy-site.example/api", sid())]));
        r.site = "policy-site.example".into();
        assert!(bound(&r).is_err(), "undeclared, the partner host is another site's");
        crate::sitepolicy::set_for_tests("policy-site.example", crate::sitepolicy::Policy { hosts: vec!["data.partner.example/v2/".into()], read_at: 1, ..Default::default() });
        assert!(bound(&r).is_ok(), "declared, with its path");
        let mut off_path = fetched_route(serde_json::json!([step("https://data.partner.example/v1/items", sid())]));
        off_path.site = "policy-site.example".into();
        assert!(bound(&off_path).is_err(), "outside the path the policy lists");
    }

    /// A route made from another contributor's body runs under someone else's rule, HTTPS and the public internet
    /// only, whatever the owner's setting; a route this node learned itself runs under the owner's.
    #[test]
    fn someone_elses_route_runs_under_someone_elses_rule() {
        let fetched = fetched_route(serde_json::json!([step("https://shop.example.com/api/items", sid())]));
        assert_eq!(egress(&fetched), Egress::Foreign);
        let mut own = fetched.clone();
        own.fetched = None;
        assert_eq!(egress(&own), Egress::Own);
    }

    /// A served body that names plain HTTP or a private address is refused when it is checked, before it is kept:
    /// a call of it would be refused anyway. One to a public HTTPS host passes.
    #[test]
    fn a_body_that_goes_inside_or_over_plain_http_is_refused_before_it_is_kept() {
        let body = |url: &str| {
            let r = fetched_route(serde_json::json!([step(url, serde_json::json!([]))]));
            recipe::of_route(&store::Route { fetched: None, ..r }).unwrap()
        };
        for bad in ["http://shop.example.com/api/items", "https://127.0.0.1/api", "https://10.0.0.5/api", "https://192.168.1.1/api", "https://169.254.169.254/latest", "https://[::1]/api", "https://[::ffff:10.0.0.5]/api", "https://localhost/api"] {
            let e = recipe::goes_where_it_may(&body(bad), Egress::Foreign).unwrap_err();
            assert!(e.contains("HTTPS only") || e.contains("public"), "{bad}: {e}");
        }
        assert!(recipe::goes_where_it_may(&body("https://shop.example.com/api/items"), Egress::Foreign).is_ok());
        // An entry whose body is set aside is skipped by content identifier; its providers aren't dark for it.
        let share = Share::default();
        share.set_aside("sha256:ab", "it goes over plain HTTP");
        assert!(share.refused("sha256:ab").is_some() && share.refused("sha256:cd").is_none());
        assert_eq!(share.off_until(FixedBytes::repeat_byte(1), 1), None);
    }

    /// The chain's word that an entry is live stands for `LIVE_FOR` from when it was read, and no longer: a delist
    /// reaches a node that keeps the body within that bound, however often the route is called.
    #[test]
    fn an_entry_shown_live_stands_only_within_the_bound() {
        let (e, other) = (FixedBytes::repeat_byte(1), FixedBytes::repeat_byte(2));
        let share = Share::default();
        let at = Instant::now();
        assert!(!share.live_lately(e, at), "never read: the chain is asked");
        share.saw_live(e, at);
        assert!(share.live_lately(e, at));
        assert!(share.live_lately(e, at + LIVE_FOR - Duration::from_secs(1)));
        assert!(!share.live_lately(e, at + LIVE_FOR), "the bound has passed: the chain is asked again");
        assert!(!share.live_lately(other, at), "one entry's answer is its own");
        share.forget_live(e);
        assert!(!share.live_lately(e, at));
    }

    // ---- the body store ----

    /// A node of a test with a deployment to keep its book under, and no chain or network.
    fn store_node() -> Arc<Node> {
        let n = crate::testchain::node("store");
        *n.chain.deployment.locked() = Some(chain::Deployment::default());
        n
    }

    /// A body of a call to the shop's `path`, kept as `keep` keeps one `ago` seconds before `now`: its bytes, and, when
    /// `routed`, the route made from it, fetched and last called then. Its content id.
    fn body_kept(path: &str, ago: u64, routed: bool, now: u64) -> String {
        let at = now - ago;
        let mut r = fetched_route(serde_json::json!([step(&format!("https://shop.example/api/{path}"), serde_json::json!([]))]));
        let body = recipe::canonical(&recipe::of_route(&store::Route { fetched: None, ..r.clone() }).unwrap());
        let content_id = recipe::save_body(&body).unwrap();
        recipe::used_body(&content_id, std::time::UNIX_EPOCH + Duration::from_secs(at));
        if routed {
            r.id = format!("{path}-kept");
            let f = r.fetched.as_mut().unwrap();
            (f.content_id, f.entry_id, f.route_id, f.fetched_at) = (content_id.clone(), format!("{:#x}", chain::test_entry(path)), path.into(), at);
            r.stats.last_at = Some(at);
            store::save_route(&r).unwrap();
        }
        content_id
    }

    /// The node lists `content_id` itself, as `listing::publish` leaves its book.
    fn listed_own(n: &Node, content_id: &str) {
        let listing: listing::SignedListing = serde_json::from_value(serde_json::json!({
            "route_id": "own", "site": "shop.example", "content_id": content_id, "agent_id": "7", "version": 1, "supersedes": null,
            "terms": { "description": "search the shop", "response": null, "price": listing::Price::default() }, "sig": ""
        }))
        .unwrap();
        listing::keep_book(&n.chain, &listing::Book { listings: vec![listing::Kept { listing, leaf: FixedBytes::ZERO, root: None }], roots: vec![] });
    }

    /// The bound that holds the store as it is less the footprint of `without`, as a `storage_gb` setting.
    fn fits_without(without: &[&str]) -> f64 {
        let s = body_store(store::now());
        let bytes = |c: &str| s.iter().find(|x| x.content_id == c).map(|x| x.bytes).unwrap();
        let bound = s.iter().map(|x| x.bytes).sum::<u64>() - without.iter().map(|c| bytes(c)).sum::<u64>();
        (bound as f64 + 0.5) / 1e9
    }

    struct Nobody;

    impl Registry for Nobody {
        async fn identity(&self, _: &str) -> Result<Option<unbrowse_net::Identity>, String> {
            Ok(None)
        }
        async fn seeds(&self) -> Vec<(PeerId, unbrowse_net::Multiaddr)> {
            vec![]
        }
    }

    struct NoListings;

    impl unbrowse_net::Listings for NoListings {
        async fn site(&self, _: &str) -> Vec<unbrowse_net::Listing> {
            vec![]
        }
    }

    /// Puts the node on a peer network of its own, on loopback, so what it provides can be read back from its table.
    async fn alone(n: &Node) -> unbrowse_net::Net {
        let rules = unbrowse_net::Rules { position_bits: 8, nodes_per_identity: 4 };
        let key = unbrowse_net::grind("store", &[0; 32], 0, rules.position_bits);
        let mut cfg = unbrowse_net::Config::new(unbrowse_net::Claim { identity: "store".into(), index: 0 });
        cfg.listen = vec!["/ip4/127.0.0.1/tcp/0".parse().unwrap()];
        cfg.announce_listen = true;
        cfg.serve = unbrowse_net::Serve::Server;
        cfg.rules = rules;
        let net = unbrowse_net::Net::start(key, cfg, Arc::new(Nobody), Arc::new(NoListings)).await.unwrap();
        n.net.set(net.clone()).ok();
        net
    }

    async fn provides(net: &unbrowse_net::Net, content_id: &str) -> bool {
        net.recorded_body_providers(content_id).await.contains(&net.peer_id())
    }

    /// A network that stopped (a restart that went no further) answers every ask with an error that reads as the peer
    /// not answering. The node doesn't take that for the peer's doing: to it the network is gone, and health says so.
    #[tokio::test]
    async fn a_stopped_network_is_not_taken_for_peers_that_dont_answer() {
        let _home = store::scratch_home("stopped-net");
        store::save_settings(&crate::terms::acknowledged(store::load_settings(), false)).unwrap();
        let n = store_node();
        let net = alone(&n).await;
        assert!(n.peers().is_some());
        net.stop().await;
        assert!(n.net.get().is_some() && n.peers().is_none(), "it stays set, and isn't the network any more");
        let said = crate::health::network_said(&n).unwrap_err();
        assert!(said.contains("restart the node"), "{said}");
    }

    /// The checks a body passes to be run from the cache hold on every way to it, and say no when they say no: a body
    /// whose bytes changed on disk used to read as one the store had let go of, and one set aside as another entry's
    /// fetch found it stayed kept and running. A body the store let go of still runs as it was kept.
    #[tokio::test]
    async fn a_kept_body_runs_only_while_it_would_be_fetched_today() {
        let _home = store::scratch_home("kept-recheck");
        let n = store_node();
        let id = body_kept("checked", 1, true, store::now());
        // The fixture's host is no public name, which the rule for someone else's code refuses: that isn't what is tested.
        run_as_own_in_tests(&id);
        let route = store::load_route("checked-kept").unwrap();
        let file = store::home().join("bodies").join(format!("{}.json", id.replace(':', "-")));
        may_run_kept(&n, &route).unwrap();
        let bytes = std::fs::read(&file).unwrap();
        std::fs::write(&file, [bytes.as_slice(), b" "].concat()).unwrap();
        assert!(may_run_kept(&n, &route).is_err(), "bytes that no longer hash to their name");
        std::fs::write(&file, &bytes).unwrap();
        n.share.set_aside(&id, "it goes where the node never runs one");
        assert!(may_run_kept(&n, &route).unwrap_err().contains("never runs one"));
        let n = store_node();
        recipe::drop_body(&id);
        may_run_kept(&n, &route).unwrap();
    }

    /// Bodies are kept one store per home, and books one per deployment: a body listed on a chain this node has moved off
    /// is still its own, and the store doesn't let it go for lack of a look at the other book.
    #[tokio::test]
    async fn a_body_listed_on_another_chain_stays_pinned() {
        let _home = store::scratch_home("pins-per-chain");
        let n = store_node();
        let (now, day) = (store::now(), 86_400);
        let own = body_kept("elsewhere", 60 * day, false, now);
        listed_own(&n, &own);
        let book = std::fs::read_dir(store::home()).unwrap().flatten().find(|f| f.file_name().to_string_lossy().starts_with("listings-")).unwrap().path();
        std::fs::rename(&book, store::home().join("listings-999-0xabc.json")).unwrap();
        assert!(body_store(now).iter().any(|s| s.content_id == own && s.pinned), "kept for the chain it is listed on");
    }

    /// Whether a refusal says anything about the body is read from the body: what it writes down would be refused on any
    /// network, and what resolves badly on this one says nothing of it.
    #[test]
    fn a_refusal_is_the_bodys_only_for_what_the_body_says() {
        let at = |url: &str| fetched_route(serde_json::json!([step(url, serde_json::json!([]))]));
        assert!(!refused_for_what_it_says(&at("https://shop.com/api/items?q={q}")), "a public name: where it resolved is this network's doing");
        assert!(refused_for_what_it_says(&at("http://shop.com/api/items")));
        assert!(refused_for_what_it_says(&at("https://10.0.0.8/api/items")));
        assert!(refused_for_what_it_says(&at("https://intranet/api/items")));
        assert!(refused_for_what_it_says(&at("https://{host}/api/items")));
    }

    /// A body refused for what this network did rests a while and comes back: it is neither set aside until a restart nor
    /// fetched and refused on every ask.
    #[test]
    fn a_body_refused_by_this_network_rests_then_comes_back() {
        let share = Share::default();
        share.rest("sha256:aa", "shop.example isn't a public internet address");
        assert!(share.resting("sha256:aa").is_some() && share.refused("sha256:aa").is_none());
        share.resting.locked().get_mut("sha256:aa").unwrap().1 = Instant::now().checked_sub(RESTS_FOR).unwrap();
        assert!(share.resting("sha256:aa").is_none());
    }

    /// Filling the store past `storage_gb` lets go of the least recently used unpinned bodies, just enough of them,
    /// and each one let go is no longer provided, its route made from it gone with it. A body the node lists itself and
    /// one its agents used within `PINNED_FOR` stay, though the first is the oldest of all.
    #[tokio::test]
    async fn a_full_store_lets_go_of_the_least_recently_used_unpinned_body_and_stops_providing_it() {
        let _home = store::scratch_home("body-store");
        // This owner serves the routes it keeps for others (`serve_kept`, off by default).
        store::save_settings(&store::Settings { serve_kept: true, ..store::load_settings() }).unwrap();
        let n = store_node();
        let (now, day) = (store::now(), 86_400);
        let own = body_kept("own", 60 * day, false, now);
        listed_own(&n, &own);
        let orphan = body_kept("orphan", 50 * day, false, now);
        let old = body_kept("old", 40 * day, true, now);
        let mid = body_kept("mid", 20 * day, true, now);
        let recent = body_kept("recent", day, true, now);
        let pinned: Vec<(String, bool)> = {
            let mut s: Vec<_> = body_store(now).into_iter().map(|s| (s.content_id, s.pinned)).collect();
            s.sort();
            s
        };
        let mut want = vec![(own.clone(), true), (orphan.clone(), false), (old.clone(), false), (mid.clone(), false), (recent.clone(), true)];
        want.sort();
        assert_eq!(pinned, want, "the node's own and the one used within the window are pinned");

        let net = alone(&n).await;
        for c in [&old, &mid, &recent] {
            provide(&n, c, false).await;
            assert!(provides(&net, c).await, "provided before");
        }
        // Within the bound, nothing goes.
        assert!(trim(&n).await.is_empty());

        // The bound holds everything but the two used longest ago that aren't pinned.
        let gb = fits_without(&[&orphan, &old]);
        let mut s = store::load_settings();
        s.storage_gb = gb;
        store::save_settings(&s).unwrap();
        assert_eq!(trim(&n).await, [orphan.clone(), old.clone()], "least recently used first, and no more than fits");
        assert!(!provides(&net, &old).await, "a body let go is no longer provided");
        assert!(recipe::load_body(&old).is_none() && recipe::load_body(&orphan).is_none());
        assert!(store::load_route("old-kept").is_none(), "the route made from it goes with it");
        for c in [&own, &mid, &recent] {
            assert!(recipe::load_body(c).is_some(), "kept");
        }
        assert!(provides(&net, &mid).await && provides(&net, &recent).await, "what is kept is still provided");
        assert!(store::load_route("mid-kept").is_some());
        assert!(store::read_activity(5).iter().any(|a| a.what.contains("Let go of 2 route bodies")));

        // At no room at all only what is pinned stays, the node's own body however old.
        s.storage_gb = 0.0;
        store::save_settings(&s).unwrap();
        assert_eq!(trim(&n).await, std::slice::from_ref(&mid));
        assert!(recipe::load_body(&own).is_some() && recipe::load_body(&recent).is_some(), "pinned bodies survive");
        assert!(provides(&net, &recent).await && !provides(&net, &mid).await);
        net.stop().await;
    }

    /// The store's accounting is read from disk: a node that restarts finds the same bodies, the same footprints and
    /// the same last uses, a serve to a paying caller among them, and lets go of the same body it would have.
    #[tokio::test]
    async fn a_restart_keeps_the_store_accounting_right() {
        let home = store::scratch_home("body-store-restart");
        let (now, day) = (store::now(), 86_400);
        let sorted = |mut s: Vec<store::Stored>| {
            s.sort_by(|a, b| a.content_id.cmp(&b.content_id));
            s
        };
        let (before, a, b, gb) = {
            let _n = store_node();
            let a = body_kept("a", 40 * day, true, now);
            let b = body_kept("b", 30 * day, true, now);
            // a was served a moment ago: it is the one used last now.
            recipe::used_body(&a, std::time::SystemTime::now());
            (sorted(body_store(now)), a.clone(), b.clone(), fits_without(&[&b]))
        };
        assert!(before.iter().find(|s| s.content_id == a).unwrap().used_at >= now, "{before:?}");
        store::use_home(&home);
        let n = store_node();
        assert_eq!(sorted(body_store(now)), before, "the same accounting after a restart");
        let mut s = store::load_settings();
        s.storage_gb = gb;
        store::save_settings(&s).unwrap();
        assert_eq!(trim(&n).await, std::slice::from_ref(&b), "the body served last stays");
        assert!(recipe::load_body(&a).is_some());
        assert_eq!(body_store(now).len(), 1);
    }

    /// A node announces only the bodies it would serve: one whose bytes it holds, never one it set aside, and none it
    /// fetched while in light mode.
    #[tokio::test]
    async fn a_node_announces_only_bodies_it_would_serve() {
        let _home = store::scratch_home("body-store-announce");
        // This owner serves the routes it keeps for others (`serve_kept`, off by default).
        store::save_settings(&store::Settings { serve_kept: true, ..store::load_settings() }).unwrap();
        let n = store_node();
        let now = store::now();
        let held = body_kept("held", 60, true, now);
        let gone = body_kept("gone", 60, true, now);
        recipe::drop_body(&gone);
        let bad = body_kept("bad", 60, true, now);
        n.share.set_aside(&bad, "it goes over plain HTTP");
        let net = alone(&n).await;
        provide_all(&n).await;
        assert!(provides(&net, &held).await);
        assert!(!provides(&net, &gone).await, "a route whose body isn't on disk");
        assert!(!provides(&net, &bad).await, "a body set aside");
        let mut s = store::load_settings();
        s.light = true;
        store::save_settings(&s).unwrap();
        let later = body_kept("later", 60, true, now);
        provide_all(&n).await;
        assert!(!provides(&net, &later).await, "light mode seeds nothing it fetched");
        net.stop().await;
    }

    // ---- a kept body whose entry is delisted ----

    /// A copy this node keeps of another contributor's route at the shop on this machine: its search, or, as `write`,
    /// a POST that orders (a write, by what the call does). Its body is kept too, as `keep` keeps it.
    fn kept(port: u16, route_id: &str, write: bool) -> store::Route {
        let (method, path) = if write { ("POST", "/api/orders") } else { ("GET", "/api/items") };
        let mut r: store::Route = serde_json::from_value(serde_json::json!({
            "id": format!("{route_id}-kept"), "site": "127.0.0.1", "what": "Search items", "method": method, "path": path,
            "root": format!("http://127.0.0.1:{port}/?q=lamps"), "inputs": [{ "name": "q", "secret": false, "default": "lamps" }],
            "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": write, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": method, "status": 200, "url": format!("http://127.0.0.1:{port}{path}?q={{q}}"),
                "needs_browser": false, "response_shape": { "items": [{ "id": "number", "name": "string" }] },
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
        }))
        .unwrap();
        assert_eq!(unbrowse_learn::ledger::writes(r.graph.steps.last().unwrap()), write);
        let body = recipe::canonical(&recipe::of_route(&r).unwrap());
        let content_id = recipe::save_body(&body).unwrap();
        // The shop is plain HTTP on this machine, where no route of someone else's goes: the test runs it as its own.
        run_as_own_in_tests(&content_id);
        r.fetched = Some(store::Fetched {
            entry_id: format!("{:#x}", chain::test_entry(route_id)),
            route_id: route_id.into(),
            agent_id: "7".into(),
            content_id,
            listed_as: "search items".into(),
            fetched_at: 1,
        });
        store::save_route(&r).unwrap();
        r
    }

    /// A node on a devnet of its own with entries listed for `route_ids`, as their contributor would list them, and an
    /// agent key. Calls from a kept copy are never billed, so the key needs no cap on the chain.
    async fn listed(name: &str, route_ids: &[&str]) -> (Arc<Node>, crate::agents::Agent) {
        let n = crate::testchain::node(name);
        n.chain.start().await.expect("the devnet");
        let keys = n.keys.as_ref();
        chain::set_fee(&n.chain, keys, 0.01, None).await.unwrap();
        for id in route_ids {
            chain::list_entry(&n.chain, keys, id, "shop.example", "Search items").await.unwrap();
        }
        let (agent, _) = crate::agents::create(keys, "agent", 100.0, 30, 0).unwrap();
        (n, agent)
    }

    async fn call_kept(n: &Arc<Node>, agent: &crate::agents::Agent, route_id: &str) -> Result<serde_json::Value, (axum::http::StatusCode, String)> {
        let inputs = HashMap::from([("q".to_string(), "desk lamps".to_string())]);
        crate::api::do_call(n, agent, format!("{:#x}", chain::test_entry(route_id)), inputs).await
    }

    /// A contributor's delist reaches a node that kept the body and runs it from there: the chain's word that the
    /// entry is live stands for `LIVE_FOR`, and the first call after that asks again, hears it is delisted, sends the
    /// site nothing, and drops the copy and its body, so the route is neither run nor offered again. A route that
    /// writes asks every time, so the delist stops it at once. `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_delisted_entrys_kept_body_stops_running_within_the_bound() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("kept-delisted");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let shop = shop();
        let (n, agent) = listed("kept", &["route-items", "route-orders"]).await;
        let read = kept(shop.port, "route-items", false);
        let write = kept(shop.port, "route-orders", true);
        let seen = || shop.seen.locked().len();

        for id in ["route-items", "route-orders"] {
            let r = call_kept(&n, &agent, id).await.expect("runs from the kept copy");
            assert_eq!((r["ok"].clone(), r["network"]["cached"].clone()), (serde_json::json!(true), serde_json::json!(true)), "{r}");
        }
        assert_eq!(seen(), 2);
        let keys = n.keys.as_ref();
        chain::delist_entry(&n.chain, keys, chain::test_entry("route-items"), "Search items").await.unwrap();
        chain::delist_entry(&n.chain, keys, chain::test_entry("route-orders"), "Search items").await.unwrap();

        // Within the bound the read still runs on the chain's last word; the write asks again and stops.
        call_kept(&n, &agent, "route-items").await.expect("within the bound");
        assert_eq!(seen(), 3);
        let (status, why) = call_kept(&n, &agent, "route-orders").await.expect_err("a write asks the chain every time");
        assert_eq!(status, axum::http::StatusCode::GONE, "{why}");
        assert!(why.contains("delisted"), "{why}");
        assert_eq!(seen(), 3, "the site heard nothing");
        assert!(store::load_route(&write.id).is_none() && cached(&format!("{:#x}", chain::test_entry("route-orders"))).is_none());

        // Once the bound has passed, the read's next call asks too.
        n.share.age_live(LIVE_FOR);
        let (status, why) = call_kept(&n, &agent, "route-items").await.expect_err("delisted");
        assert_eq!(status, axum::http::StatusCode::GONE, "{why}");
        assert_eq!(seen(), 3, "the site heard nothing");
        assert!(store::load_route(&read.id).is_none(), "the copy is dropped, so it isn't offered");
        assert!(recipe::load_body(&read.fetched.as_ref().unwrap().content_id).is_none(), "and its body");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A failure is a failure however the call came: one that named the entry demotes it as one a goal picked does
    /// (R5.4), and that outlasts a restart inside its two hours.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_failed_call_that_named_its_entry_demotes_it_past_a_restart() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("demoted");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let (mut n, agent) = listed("demoted", &["route-items"]).await;
        Arc::get_mut(&mut n).unwrap().share = Share::kept(&store::home());
        // A kept copy pointed at a port nothing answers on: the use runs, and fails.
        kept(1, "route-items", false);
        let r = call_kept(&n, &agent, "route-items").await.expect("the call ran");
        assert_eq!(r["ok"], serde_json::json!(false), "{r}");
        let entry = chain::test_entry("route-items");
        assert!(n.share.demoted(entry));
        assert!(Share::kept(&store::home()).demoted(entry), "a restart keeps it");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A key its payer revoked can buy nothing, so every provider refuses it. That is the payer's own failure, whatever
    /// the entry is like: the entry stays on the ranking, no failed line names it, and the agent hears it is its money.
    /// `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_key_that_cant_pay_never_darkens_the_entry_it_tried() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("dead-key");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let n = crate::testchain::node("dead-key");
        n.chain.start().await.expect("the devnet");
        let keys = n.keys.as_ref();
        chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
        chain::deposit(&n.chain, keys, 1_000.0).await.unwrap();
        chain::set_fee(&n.chain, keys, 0.01, None).await.unwrap();
        let (agent, _) = crate::agents::create(keys, "agent", 100.0, 30, 0).unwrap();
        chain::authorize(&n.chain, keys, agent.index, 100.0, store::now() + 30 * 86_400).await.unwrap();
        let proven = listing::publish(&n.chain, keys, &n.info.name, "route-items", "Search items", &recipe::of_route(&search_route(1)).unwrap(), 0.01).await.unwrap().unwrap();
        n.share.saw(&proven);
        let entry = proven.listing.entry();
        chain::revoke(&n.chain, keys, agent.index).await.unwrap();
        let net = alone(&n).await;

        let epoch = chain::current_epoch(&n.chain).await.unwrap();
        let (status, why) = crate::api::do_call(&n, &agent, format!("{entry:#x}"), HashMap::new()).await.expect_err("a revoked key buys nothing");
        net.stop().await;
        assert_eq!(n.share.off_until(entry, epoch), None, "the entry did nothing wrong: {why}");
        assert_eq!(status, axum::http::StatusCode::PAYMENT_REQUIRED, "{why}");
        assert!(why.contains("revoked"), "{why}");
        assert!(chain::receipts(agent.index, epoch).unwrap().is_empty(), "no line names the entry");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The chain shows no entry until a claim credits it (R2.18), and that isn't a delist: a notice about an entry nobody
    /// has claimed yet leaves its hold where it is.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_hold_on_an_entry_no_claim_credited_outlasts_a_notice() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("held-uncredited");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let n = crate::testchain::node("held-uncredited");
        n.chain.start().await.expect("the devnet");
        let entry = FixedBytes::<32>::repeat_byte(5);
        let id = format!("{entry:#x}");
        store::save_held(&[store::HeldRoute { entry_id: id.clone(), site: "shop.example".into(), contributor: String::new(), description: String::new(), fee: 0.01, held_at: 1 }]).unwrap();

        recheck_held(&n, entry).await;

        assert_eq!(store::load_held().len(), 1, "still held");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A listing sent to a poster that has since gone doesn't wait for good: the node posts its own root over it.
    /// `cargo test -p unbrowse-node-app a_listing_whose_poster -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_listing_whose_poster_is_gone_goes_under_the_nodes_own_root() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("poster-gone");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let n = crate::testchain::node("poster-gone");
        n.chain.start().await.expect("the devnet");
        let keys = n.keys.as_ref();
        chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
        let body = recipe::of_route(&search_route(1)).unwrap();
        // A poster that took the node's word and went: the listing is kept, signed and under no root.
        {
            let _poster = crate::testchain::Env::set(&[("UNBROWSE_RESERVE_URL", format!("http://127.0.0.1:{}", crate::testchain::free_port()))]);
            assert!(listing::publish(&n.chain, keys, &n.info.name, "route-items", "Search items", &body, 0.01).await.is_err(), "the poster doesn't answer");
        }
        assert!(listing::load_book(&n.chain).latest("route-items").unwrap().root.is_none());
        let spread = listing::adopt_reserve_roots(&n.chain, keys).await.unwrap();
        assert_eq!(spread.len(), 1, "with no poster left the node posts its own root");
        assert!(listing::load_book(&n.chain).latest("route-items").unwrap().root.is_some());
        assert!(listing::adopt_reserve_roots(&n.chain, keys).await.unwrap().is_empty(), "and only once");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---- a listing its contributor withdrew ----

    /// A node on a devnet of its own, its share state kept under its home as a running node's is, and a copy it keeps of
    /// the route `listing_of_kept` lists.
    async fn keeping(name: &str) -> (Arc<Node>, store::Route, FixedBytes<32>, String) {
        let mut n = crate::testchain::node(name);
        Arc::get_mut(&mut n).unwrap().share = Share::kept(&store::home());
        n.chain.start().await.expect("the devnet");
        let mut r = kept(1, "route-items", false);
        let content_id = r.fetched.as_ref().unwrap().content_id.clone();
        let entry = chain::content_entry_id(&content_id);
        r.fetched.as_mut().unwrap().entry_id = format!("{entry:#x}");
        store::save_route(&r).unwrap();
        (n, r, entry, content_id)
    }

    /// `agent`'s listing of `content_id`, signed by `key`, as a node reads it.
    fn listed_by(n: &Node, key: &alloy::signers::local::PrivateKeySigner, agent: &str, route: &str, content_id: &str, version: u64) -> listing::Proven {
        let domain = chain::domain(&n.chain.deployed().unwrap());
        let terms = listing::Terms { description: "Search items".into(), response: None, price: listing::Price::default() };
        let l = listing::SignedListing { route_id: route.into(), site: "shop.example".into(), content_id: content_id.into(), agent_id: agent.into(), version, supersedes: None, terms, sig: String::new() };
        listing::Proven { listing: l.signed(key, &domain).unwrap(), leaf: FixedBytes::ZERO, root: FixedBytes::ZERO, index: 0, proof: vec![] }
    }

    /// The notice carrying the withdrawal `key` signs of `entry`.
    fn withdrawal_by(n: &Node, key: &alloy::signers::local::PrivateKeySigner, entry: FixedBytes<32>, content_id: &str) -> Heard {
        let domain = chain::domain(&n.chain.deployed().unwrap());
        let mut change = Change::now("shop.example", ChangeKind::Delisted, vec![format!("{entry:#x}")]);
        change.signed = vec![listing::sign_withdrawal(key, &domain, entry, content_id, change.at).unwrap()];
        Heard { change, from: PeerId::random(), identity: "7".into() }
    }

    /// The listings a node read before it last started are gone from memory, and the one it paid under is on disk: a
    /// signed withdrawal is checked against that one, and what it withdrew stays withdrawn past the next restart.
    /// `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_withdrawal_reaches_a_copy_read_before_a_restart_and_outlasts_the_next() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("withdrawn-restart");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let (n, r, entry, cid) = keeping("withdrawn-restart").await;
        let key = alloy::signers::local::PrivateKeySigner::random();
        listing::remember(&n.chain, &listed_by(&n, &key, "7", "route-items", &cid, 1));

        on_change(&n, withdrawal_by(&n, &key, entry, &cid), Instant::now()).await;

        assert!(store::load_route(&r.id).is_none(), "the copy is dropped");
        assert!(Share::kept(&store::home()).withdrawn(entry), "and a restart doesn't bring the entry back");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A node that only read a listing has no copy to drop, and must still not offer or fetch what was withdrawn.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_node_with_no_copy_hears_a_withdrawal_too() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("withdrawn-read");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let (n, r, entry, cid) = keeping("withdrawn-read").await;
        store::delete_route(&r.id).unwrap();
        let key = alloy::signers::local::PrivateKeySigner::random();
        n.share.saw(&listed_by(&n, &key, "7", "route-items", &cid, 1));
        assert_eq!(n.share.known_on("https://shop.example/").len(), 1);

        on_change(&n, withdrawal_by(&n, &key, entry, &cid), Instant::now()).await;

        assert!(n.share.withdrawn(entry));
        assert!(n.share.known_on("https://shop.example/").is_empty(), "nothing is offered");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A later version of a withdrawn listing brings it back and the same one read again doesn't, since either contributor
    /// spreading the old listing would otherwise undo the withdrawal.
    #[test]
    fn only_a_later_version_brings_a_withdrawn_listing_back() {
        let listing = |version: u64| -> listing::SignedListing {
            serde_json::from_value(serde_json::json!({
                "route_id": "r1", "site": "shop.example", "content_id": "sha256:ab", "agent_id": "7", "version": version,
                "supersedes": null, "terms": { "description": "search", "response": null, "price": listing::Price::default() }, "sig": ""
            }))
            .unwrap()
        };
        let mut w = Withdrawn::default();
        w.add(&listing(2), 100);
        for read in [1, 2] {
            w.republished(&listing(read));
            assert!(w.covers(&listing(read)), "version {read}");
        }
        w.republished(&listing(3));
        assert!(!w.covers(&listing(3)) && w.entries.is_empty());
    }

    /// Two contributors list one body, so it is one entry (R2.4). Either can withdraw only its own listing: a second
    /// lister can't take the route from the first, or from the nodes that keep it, and the copy goes once both have.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn one_contributors_withdrawal_leaves_anothers_listing_standing() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("withdrawn-one");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let (n, r, entry, cid) = keeping("withdrawn-one").await;
        let (a, b) = (alloy::signers::local::PrivateKeySigner::random(), alloy::signers::local::PrivateKeySigner::random());
        n.share.saw(&listed_by(&n, &a, "7", "route-items", &cid, 1));
        n.share.saw(&listed_by(&n, &b, "8", "route-copied", &cid, 1));

        on_change(&n, withdrawal_by(&n, &b, entry, &cid), Instant::now()).await;

        assert!(store::load_route(&r.id).is_some(), "the first contributor's listing still stands, so the copy does");
        assert!(!n.share.withdrawn(entry));
        assert_eq!(n.share.known(entry).unwrap().listing.agent_id, "7", "and it is the one a fetch pays");

        on_change(&n, withdrawal_by(&n, &a, entry, &cid), Instant::now()).await;

        assert!(store::load_route(&r.id).is_none(), "both withdrew");
        assert!(n.share.withdrawn(entry));
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// R11-CHAIN-1: a release's head is a snapshot. Both RPCs agree on a head in epoch 1, where a voucher of epoch 0
    /// is good; then, between the head and the reservation, the honest second's own finalized head crosses into epoch
    /// 2 while the first keeps answering the old height. The voucher is judged again at the second's height just
    /// before anything is reserved: no bytes, and no place taken. `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_voucher_that_expires_during_a_release_is_never_served() {
        use alloy::providers::Provider;
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("expires-mid-release");
        let port = crate::testchain::free_port();
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", port.to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let n = crate::testchain::node("midway");
        n.chain.start().await.expect("the devnet");
        let keys = n.keys.as_ref();
        chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
        chain::deposit(&n.chain, keys, 1_000.0).await.unwrap();
        chain::set_fee(&n.chain, keys, 0.01, None).await.unwrap();
        let (agent, _) = crate::agents::create(keys, "agent", 100.0, 30, 0).unwrap();
        chain::authorize(&n.chain, keys, agent.index, 100.0, store::now() + 300 * 86_400).await.unwrap();
        let body = recipe::of_route(&search_route(1)).unwrap();
        let a = listing::publish(&n.chain, keys, &n.info.name, "route-items", "Search items", &body, 0.01).await.unwrap().unwrap();
        let (cid, entry) = (a.listing.content_id.clone(), a.listing.entry());
        let mut r = search_route(1);
        r.id = "route-items".into();
        r.listing = Some(store::Listing { entry_id: format!("{entry:#x}"), tx: String::new(), listed_at: 1, live: true });
        store::save_route(&r).unwrap();
        let d = n.chain.deployed().unwrap();
        let me = chain::owner_address(keys).unwrap();
        let old = network::sign_body_voucher(keys, agent.index, &chain::domain(&d), me, entry, &cid, d.fee_units(0.01), 0).unwrap().to_bytes();

        // The finalized head 5 blocks before epoch 2: a voucher of epoch 0 is still in its window.
        let real: reqwest::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
        let p = crate::rpc::ProviderBuilder::new().connect_http(real.clone());
        let length = d.blocks_per_epoch();
        let latest = p.get_block_number().await.unwrap();
        let finalized = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Finalized).await.unwrap().unwrap().header.number;
        let _: serde_json::Value = p.raw_request("anvil_mine".into(), (alloy::primitives::U256::from(2 * length - 5 + (latest - finalized) - latest),)).await.unwrap();
        let behind = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let first = crate::testchain::lying_rpc(real.clone(), behind.clone(), Default::default()).await;
        let _proxy = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
        store::save_settings(&store::Settings { check_rpc: Some(real.to_string()), ..store::load_settings() }).unwrap();

        // Between the head and the reservation: the chain moves 20 blocks on, into epoch 2, and the first stays behind.
        let (moved, url) = (behind.clone(), real.clone());
        *BEFORE_RESERVE.lock().unwrap() = Some(Box::pin(async move {
            moved.store(20, std::sync::atomic::Ordering::SeqCst);
            let p = crate::rpc::ProviderBuilder::new().connect_http(url);
            let _: serde_json::Value = p.raw_request("anvil_mine".into(), (alloy::primitives::U256::from(20u64),)).await.unwrap();
        }));
        let notes = network::served_notes().unwrap();
        let why = release(&n, PeerId::random(), &cid, &old).await.expect_err("no bytes for a voucher the chain stopped paying");
        assert!(why.contains("epoch is over"), "{why}");
        assert_eq!(network::served_notes().unwrap(), notes, "and no place taken");
        assert!(BEFORE_RESERVE.lock().unwrap().is_none(), "the chain moved mid-release");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// R12-CHAIN-1: the fresh expiry check is the last thing a release awaits. From it to the bytes going out only local
    /// work runs: no `.await` between `still_open_now` and the body returned.
    #[test]
    fn nothing_is_awaited_between_the_expiry_check_and_the_body() {
        let src = include_str!("share.rs");
        let body = &src[src.find("async fn release_within(").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let after = &body[body.find("// -- last chain read --").expect("the marked check")..];
        let after = &after[after.find("still_open_now").unwrap()..];
        let after = &after[after.find('\n').unwrap()..];
        assert!(!after.contains(".await"), "an await after the expiry check: {after}");
        assert!(after.contains("reserve_served") && after.contains("Ok(bytes)"));
    }

    /// R9-CHAIN-1 and R10-CHAIN-1, through a whole release: the honest second RPC is the devnet itself, and the first
    /// a proxy of it that says the chain is further back than it is. 150 blocks back, the second stands behind no head
    /// the first names and nothing paid is served. 20 blocks back, across an epoch boundary, the two agree on a head in
    /// epoch 1 while the second's own head is in epoch 2: a voucher of epoch 0, which the first's epoch would let in,
    /// is refused, and one of epoch 1 is served. `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_release_holds_a_stale_first_rpc_to_the_second_rpcs_head() {
        use alloy::providers::Provider;
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("stale-release");
        let port = crate::testchain::free_port();
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", port.to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let n = crate::testchain::node("stale");
        n.chain.start().await.expect("the devnet");
        let keys = n.keys.as_ref();
        chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
        chain::deposit(&n.chain, keys, 1_000.0).await.unwrap();
        chain::set_fee(&n.chain, keys, 0.01, None).await.unwrap();
        let (agent, _) = crate::agents::create(keys, "agent", 100.0, 30, 0).unwrap();
        chain::authorize(&n.chain, keys, agent.index, 100.0, store::now() + 300 * 86_400).await.unwrap();
        let body = recipe::of_route(&search_route(1)).unwrap();
        let a = listing::publish(&n.chain, keys, &n.info.name, "route-items", "Search items", &body, 0.01).await.unwrap().unwrap();
        let (cid, entry) = (a.listing.content_id.clone(), a.listing.entry());
        let mut r = search_route(1);
        r.id = "route-items".into();
        r.listing = Some(store::Listing { entry_id: format!("{entry:#x}"), tx: String::new(), listed_at: 1, live: true });
        store::save_route(&r).unwrap();
        let d = n.chain.deployed().unwrap();
        let me = chain::owner_address(keys).unwrap();
        let pay = |epoch: u64| network::sign_body_voucher(keys, agent.index, &chain::domain(&d), me, entry, &cid, d.fee_units(0.01), epoch).unwrap().to_bytes();
        let (old, current) = (pay(0), pay(1));

        // The chain moves on until its finalized head is 10 blocks into epoch 2, however far behind its latest the
        // devnet keeps finality.
        let real: reqwest::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
        let p = crate::rpc::ProviderBuilder::new().connect_http(real.clone());
        let length = d.blocks_per_epoch();
        let latest = p.get_block_number().await.unwrap();
        let finalized = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Finalized).await.unwrap().unwrap().header.number;
        let _: serde_json::Value = p.raw_request("anvil_mine".into(), (alloy::primitives::U256::from(2 * length + 10 + (latest - finalized) - latest),)).await.unwrap();
        let finalized = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Finalized).await.unwrap().unwrap().header.number;
        assert_eq!(finalized, 2 * length + 10, "the second's own head is 10 blocks into epoch 2");

        // The second RPC is the devnet; the node's own RPC is the lying proxy.
        let behind = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(150));
        let first = crate::testchain::lying_rpc(real.clone(), behind.clone(), Default::default()).await;
        let _proxy = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", first.port().unwrap().to_string())]);
        store::save_settings(&store::Settings { check_rpc: Some(real.to_string()), ..store::load_settings() }).unwrap();
        let peer = PeerId::random();

        let why = release(&n, peer, &cid, &current).await.expect_err("150 blocks back: no head the second stands behind");
        assert!(why.contains("second RPC stands behind"), "{why}");
        assert!(crate::rpc::halted().is_none(), "a stale first is no contradiction");

        behind.store(20, std::sync::atomic::Ordering::SeqCst);
        let why = release(&n, peer, &cid, &old).await.expect_err("a voucher two epochs old at the second's head");
        assert!(why.contains("epoch is over"), "{why}");
        assert_eq!(chain::epoch_floor().unwrap(), 2, "the floor is the later head's epoch");
        let served = release(&n, peer, &cid, &current).await.expect("a voucher of the last epoch is still served");
        assert_eq!(recipe::content_id(&served), cid);
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Two listings of byte-identical bodies name one content id, and so one entry (`Listings.entryIdOf`, spec
    /// §76.1): the node that lists them serves the body to a voucher for that entry, and refuses a voucher that names
    /// another body's entry, whichever body it asks for. `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_body_listed_twice_is_one_entry_and_served_under_it() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("shared-body");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let n = crate::testchain::node("shared");
        n.chain.start().await.expect("the devnet");
        let keys = n.keys.as_ref();
        chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
        chain::deposit(&n.chain, keys, 1_000.0).await.unwrap();
        chain::set_fee(&n.chain, keys, 0.01, None).await.unwrap();
        let (agent, _) = crate::agents::create(keys, "agent", 100.0, 30, 0).unwrap();
        chain::authorize(&n.chain, keys, agent.index, 100.0, store::now() + 30 * 86_400).await.unwrap();

        // One search listed twice under other words, and another call once.
        let same = recipe::of_route(&search_route(1)).unwrap();
        let other = recipe::of_route(&search_route(2)).unwrap();
        let a = listing::publish(&n.chain, keys, &n.info.name, "route-items", "Search items", &same, 0.01).await.unwrap().unwrap();
        let b = listing::publish(&n.chain, keys, &n.info.name, "route-lookup", "Look up items", &same, 0.01).await.unwrap().unwrap();
        let c = listing::publish(&n.chain, keys, &n.info.name, "route-other", "Search items", &other, 0.01).await.unwrap().unwrap();
        let (cid, other_cid) = (a.listing.content_id.clone(), c.listing.content_id.clone());
        assert_eq!(b.listing.content_id, cid, "byte-identical bodies have one content id");
        assert_ne!(other_cid, cid);
        let (entry, other_entry) = (chain::content_entry_id(&cid), chain::content_entry_id(&other_cid));
        assert_eq!((a.listing.entry(), b.listing.entry()), (entry, entry), "and one entry");
        // Listed as `list_route` lists them: a route's record is what says it is listed (`serves_own`).
        for (id, e) in [("route-items", entry), ("route-lookup", entry), ("route-other", other_entry)] {
            let mut r = search_route(1);
            r.id = id.into();
            r.listing = Some(store::Listing { entry_id: format!("{e:#x}"), tx: String::new(), listed_at: 1, live: true });
            store::save_route(&r).unwrap();
        }

        let d = n.chain.deployed().unwrap();
        let epoch = chain::current_epoch(&n.chain).await.unwrap();
        let me = chain::owner_address(keys).unwrap();
        let pay = |entry, cid: &str| network::sign_body_voucher(keys, agent.index, &chain::domain(&d), me, entry, cid, d.fee_units(0.01), epoch).unwrap().to_bytes();
        let peer = PeerId::random();
        let body = release(&n, peer, &cid, &pay(entry, &cid)).await.expect("the body's entry is served");
        assert_eq!(recipe::content_id(&body), cid);
        let why = release(&n, peer, &cid, &pay(other_entry, &cid)).await.expect_err("another body's entry");
        assert!(why.contains("doesn't serve that body under"), "{why}");
        let why = release(&n, peer, &other_cid, &pay(entry, &other_cid)).await.expect_err("another body's entry");
        assert!(why.contains("doesn't serve that body under"), "{why}");
        release(&n, peer, &other_cid, &pay(other_entry, &other_cid)).await.expect("the other body under its own entry");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// While the chain can't be read, a kept route that only reads keeps running from its copy, even past the bound,
    /// and one that writes never runs: whether its contributor still lists it is unknown. Its copy is kept for when
    /// the chain answers again. `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn a_kept_route_that_writes_never_runs_while_the_chain_cant_be_read() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("kept-unread");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let shop = shop();
        let (n, agent) = listed("kept", &["route-items", "route-orders"]).await;
        let cut = crate::testchain::Cut::to(chain::url().port().unwrap());
        let _through = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", cut.port.to_string())]);
        kept(shop.port, "route-items", false);
        let write = kept(shop.port, "route-orders", true);
        let seen = || shop.seen.locked().len();
        call_kept(&n, &agent, "route-items").await.expect("the read runs");
        call_kept(&n, &agent, "route-orders").await.expect("the write runs, checked");
        assert_eq!(seen(), 2);

        cut.set(false);
        let (status, why) = call_kept(&n, &agent, "route-orders").await.expect_err("unchecked");
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE, "{why}");
        assert!(why.contains("chain couldn't be read"), "{why}");
        assert_eq!(seen(), 2, "the site heard nothing");
        assert!(store::load_route(&write.id).is_some(), "the copy is kept: nothing says it was delisted");
        n.share.age_live(LIVE_FOR);
        let r = call_kept(&n, &agent, "route-items").await.expect("a read keeps running from its copy");
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(seen(), 3);

        cut.set(true);
        call_kept(&n, &agent, "route-orders").await.expect("checked again");
        assert_eq!(seen(), 4);
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ---- nodes on one local chain ----

    use std::path::{Path, PathBuf};

    /// One node of a test, with a home and a runtime of its own: every thread its runtime runs takes its home, so the
    /// routes, bodies, jars, receipts and settings each node keeps are its own, as on separate machines.
    struct Peer {
        node: Arc<Node>,
        rt: Option<tokio::runtime::Runtime>,
        home: PathBuf,
        /// The node as it ran before it came `back`: kept, since the chain it started runs on.
        retired: Vec<Arc<Node>>,
    }

    impl Peer {
        fn runtime(home: &Path) -> tokio::runtime::Runtime {
            let h = home.to_path_buf();
            tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap()
        }

        fn new(scratch: &Path, name: &str, api_port: u16) -> Peer {
            let home = scratch.join(name);
            std::fs::create_dir_all(&home).unwrap();
            let rt = Peer::runtime(&home);
            // These nodes' owners have answered for the terms, as `testchain::home`'s have: each node has a home of its own.
            rt.block_on(rt.spawn(async { store::save_settings(&crate::terms::acknowledged(store::load_settings(), false)).unwrap() })).unwrap();
            let node = Peer::node(unbrowse_core::MemoryStore::default(), name, api_port);
            Peer { node, rt: Some(rt), home, retired: vec![] }
        }

        /// A node under the key `keys` holds, or a new one.
        fn node(keys: unbrowse_core::MemoryStore, name: &str, api_port: u16) -> Arc<Node> {
            let id = unbrowse_core::load_or_create(&keys).unwrap();
            Arc::new(Node {
                keys: Box::new(keys),
                identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
                info: crate::NodeInfo { name: name.into(), version: "test".into(), api_port, dev: true },
                walks: crate::learn::Walks::default(),
                chain: chain::Chain::default(),
                chain_error: std::sync::Mutex::new(None),
                events: crate::api::Events::default(),
                net: std::sync::OnceLock::new(),
                share: Share::default(),
            })
        }

        /// Runs `f` on this node, in its own home.
        fn on<T: Send + 'static, F: std::future::Future<Output = T> + Send + 'static>(&self, f: impl FnOnce(Arc<Node>) -> F) -> T {
            let rt = self.rt.as_ref().expect("the node is running");
            rt.block_on(rt.spawn(f(self.node.clone()))).unwrap()
        }

        fn me(&self) -> Address {
            chain::owner_address(self.node.keys.as_ref()).unwrap()
        }

        /// Joins the peer network, advertising `port` as where its door is.
        fn join(&self, port: u16) {
            let me = format!("{:#x}", self.me());
            self.on(move |n| async move {
                network::advertise(&me, port, &n.info.name).unwrap();
                let net = peers::start(n.clone()).await.expect("join");
                n.net.set(net).ok();
            });
        }

        /// The node goes away: its network, its door and everything else it ran stop. (The node itself stays, so the
        /// chain it started keeps running for the others.)
        fn leave(&mut self) {
            self.rt.take().unwrap().shutdown_background();
        }

        /// The node runs again, as itself, from the home it left, on the chain it was on: it still has to `join` the
        /// network.
        fn back(&mut self) {
            let keys = unbrowse_core::MemoryStore::default();
            let secret = unbrowse_core::KeyStore::get(self.node.keys.as_ref()).unwrap().unwrap();
            unbrowse_core::KeyStore::set(&keys, &secret).unwrap();
            let node = Peer::node(keys, &self.node.info.name, self.node.info.api_port);
            self.retired.push(std::mem::replace(&mut self.node, node));
            self.rt = Some(Peer::runtime(&self.home));
            self.on(|n| async move { n.chain.start().await.expect("the same chain") });
        }

        /// Funds the node, and makes and authorises an agent key that may spend 100 UNB an epoch.
        fn caller(&self) -> crate::agents::Agent {
            self.on(|n| async move {
                let keys = n.keys.as_ref();
                chain::faucet(&n.chain, keys, 5_000.0).await.unwrap();
                chain::deposit(&n.chain, keys, 1_000.0).await.unwrap();
                let (a, _) = crate::agents::create(n.keys.as_ref(), "agent", 100.0, 30, n.info.api_port).unwrap();
                chain::authorize(&n.chain, keys, a.index, 100.0, store::now() + 30 * 86_400).await.unwrap();
                a
            })
        }

        /// The node's own session for the site: what its jar sends with every call there.
        fn signed_in(&self, port: u16, sid: &str) {
            let jars = self.home.join("jars");
            std::fs::create_dir_all(&jars).unwrap();
            std::fs::write(jars.join(format!("shop.localtest.me:{port}.json")), serde_json::json!({ "sid": sid }).to_string()).unwrap();
        }

        fn calls(&self, agent: &crate::agents::Agent, entry: &str) -> Result<serde_json::Value, (axum::http::StatusCode, String)> {
            let (agent, entry) = (agent.clone(), entry.to_string());
            self.on(move |n| async move {
                let inputs = HashMap::from([("q".to_string(), "desk lamps".to_string())]);
                crate::api::do_call(&n, &agent, entry, inputs).await
            })
        }

        /// What an agent's unbrowse_do does for the shop's search, naming its page. It says nothing about paying: the
        /// node pays a route's fee itself, up to its owner's maximum.
        fn does(&self, agent: &crate::agents::Agent, port: u16) -> Result<serde_json::Value, (axum::http::StatusCode, String)> {
            let agent = agent.clone();
            let body: crate::api::DoBody =
                serde_json::from_value(serde_json::json!({ "goal": "search items", "url": format!("http://shop.localtest.me:{port}/?q=desk+lamps") })).unwrap();
            self.on(move |n| async move { crate::api::do_goal(&n, &agent, body).await })
        }

        /// The owner's settings for this node, changed by `f`.
        fn settings(&self, f: impl FnOnce(&mut store::Settings) + Send + 'static) {
            self.on(|_| async move {
                let mut s = store::load_settings();
                f(&mut s);
                store::save_settings(&s).unwrap();
            });
        }

        fn receipts(&self, epoch: u64) -> Vec<chain::Receipt> {
            store::read_json(&self.home.join("devnet").join("receipts").join(format!("0-{epoch}.json")), &unbrowse_files::RECEIPTS)
        }
    }

    /// The devnet the first node made, shared: the others find its Anvil and its contracts and keep the rest of their
    /// chain folder (receipts, what they owe and are owed) apart. The files are copied, not linked: the first node has
    /// written them by now and never changes them, and a copy works on every system the tests build on.
    fn share_devnet(first: &Path, other: &Path) {
        let dir = other.join("devnet");
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["mark.key", "deployment.json", "deployer.key", "network.json"] {
            std::fs::copy(first.join("devnet").join(f), dir.join(f)).unwrap();
        }
    }

    /// A shop's API on this machine, at a name the public DNS points at loopback: it answers every search with one
    /// item and remembers each request it was sent and the cookie that came with it.
    struct Shop {
        port: u16,
        seen: Arc<Mutex<Vec<(String, String)>>>,
    }

    fn shop() -> Shop {
        use std::io::{BufRead, Write};
        let v4 = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = v4.local_addr().unwrap().port();
        // localtest.me resolves to both loopbacks: the shop answers at one port on each.
        let v6 = std::net::TcpListener::bind(("::1", port)).ok();
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
        for l in [Some(v4), v6].into_iter().flatten() {
            let seen = seen.clone();
            std::thread::spawn(move || {
                for stream in l.incoming().flatten() {
                    let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                    let (mut first, mut cookie) = (String::new(), String::new());
                    let _ = reader.read_line(&mut first);
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if let Some((k, v)) = line.split_once(':') {
                            if k.eq_ignore_ascii_case("cookie") {
                                cookie = v.trim().to_string();
                            }
                        }
                    }
                    seen.locked().push((first.trim().to_string(), cookie));
                    let body = r#"{"items":[{"id":1,"name":"desk lamp"}]}"#;
                    let mut out = stream;
                    let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                }
            });
        }
        Shop { port, seen }
    }

    /// The shop's search, as a node learns it: the caller's query, and the caller's own session cookie.
    fn search_route(port: u16) -> store::Route {
        serde_json::from_value(serde_json::json!({
            "id": "route-items", "site": "shop.localtest.me", "what": "Search items", "method": "GET", "path": "/api/items",
            "root": format!("http://shop.localtest.me:{port}/?q=lamps"), "inputs": [{ "name": "q", "secret": false, "default": "lamps" }],
            "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://shop.localtest.me:{port}/api/items?q={{q}}"),
                "needs_browser": false, "response_shape": { "items": [{ "id": "number", "name": "string" }] },
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" },
                           { "loc": { "in": "cookie", "key": "sid" }, "class": "minted", "name": "sid" }] }] }
        }))
        .unwrap()
    }

    /// Serves a copy of the body changed by one word: what a provider that can't be trusted might send.
    struct Tampered(Vec<u8>);

    impl Bodies for Tampered {
        async fn serve(&self, _: PeerId, _: &str, _: &[u8]) -> Result<Vec<u8>, String> {
            Ok(self.0.clone())
        }
    }

    fn free_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    /// A route this node learned itself is free to its own agents, listed or not (R3.12, R3.34): the node lists it,
    /// its agent key can pay and its deposit could cover a line, and still a call of it writes no line, signs no
    /// voucher, holds nothing under the cap and pays nothing. `cargo test -p unbrowse-node-app share -- --ignored`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs Anvil"]
    async fn the_nodes_own_listed_route_is_free_to_its_own_agents() {
        let _one = crate::testchain::one_at_a_time().await;
        let home = crate::testchain::home("own-free");
        let _env = crate::testchain::Env::set(&[("UNBROWSE_DEVNET_PORT", crate::testchain::free_port().to_string()), ("UNBROWSE_DEVNET_FORK", "none".into())]);
        let shop = shop();
        let (n, agent) = listed("own", &["route-items"]).await;
        let keys = n.keys.as_ref();
        chain::faucet(&n.chain, keys, 1_000.0).await.unwrap();
        chain::deposit(&n.chain, keys, 100.0).await.unwrap();
        chain::authorize(&n.chain, keys, agent.index, 100.0, 0).await.unwrap();
        // The node's own route, learned here, at the shop; its entry is the one `listed` put on the chain.
        let mut own = kept(shop.port, "route-items", false);
        store::delete_route(&own.id).unwrap();
        own.id = "route-items".into();
        own.fetched = None;
        own.listing = Some(store::Listing { entry_id: format!("{:#x}", chain::test_entry("route-items")), tx: String::new(), listed_at: 1, live: true });
        store::save_route(&own).unwrap();
        let me = chain::owner_address(keys).unwrap();
        let (by, e) = chain::entry_by_hash(&n.chain, chain::test_entry("route-items")).await.unwrap().expect("listed");
        assert!(by == me && e.live && e.fee > 0.0, "the node lists the route, at a fee");

        let epoch = chain::current_epoch(&n.chain).await.unwrap();
        for _ in 0..2 {
            let inputs = HashMap::from([("q".to_string(), "desk lamps".to_string())]);
            let r = crate::api::do_call(&n, &agent, "route-items".into(), inputs).await.expect("the own route runs");
            assert_eq!((r["ok"].clone(), r["paid_usdc"].clone()), (serde_json::json!(true), serde_json::Value::Null), "{r}");
        }
        assert_eq!(shop.seen.locked().len(), 2);
        assert!(chain::receipts(agent.index, epoch).unwrap().is_empty(), "no line");
        assert!(chain::running_voucher(&n.chain, keys, agent.index, epoch).await.unwrap().is_none(), "no voucher");
        assert_eq!(chain::agent_spend(&n.chain, keys, agent.index, epoch).await.unwrap().0, 0.0, "nothing spent");
        assert_eq!(store::load_route("route-items").unwrap().stats.calls, 2, "the runs count toward its use");
        drop(n);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A route travels as its body and runs on the caller, end to end on a local chain. Node a lists a route to a
    /// shop; b's agent asks for the search, and b finds a's signed listing, pays for the body, fetches it from a,
    /// checks it and runs it itself under its own session: the shop hears from b, and a gets the passed line naming it
    /// as the server. b's later calls run from its copy and pay nothing. b seeds the body: once a has gone, d (in light
    /// mode) fetches it from b. A provider serving a changed body is refused and set aside, and the try is a failed use.
    /// `cargo test -p unbrowse-node-app share -- --ignored --nocapture` (needs Anvil and the public DNS for localtest.me)
    #[test]
    #[ignore]
    fn a_route_body_travels_between_nodes_and_runs_on_the_caller() {
        // It sets the process's chain, as the other tests on Anvil do: one at a time.
        let _one = crate::testchain::one_at_a_time_blocking();
        let scratch = std::env::temp_dir().join(format!("unbrowse-share-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        std::env::set_var("UNBROWSE_NETWORK_DIR", scratch.join("network"));
        std::env::set_var("UNBROWSE_DEVNET_PORT", "8597");
        std::env::set_var("UNBROWSE_DEVNET_FORK", "none");
        // The shop is a public name pointed at this machine, as an intranet's are.
        unbrowse_learn::egress::allow_private(true);
        let shop = shop();
        let door = free_port();

        let mut a = Peer::new(&scratch, "a", door);
        a.on(|n| async move { n.chain.start().await.expect("chain") });
        let mut b = Peer::new(&scratch, "b", 1);
        let c = Peer::new(&scratch, "c", 2);
        let d = Peer::new(&scratch, "d", 3);
        let e = Peer::new(&scratch, "e", 4);
        for p in [&b, &c, &d, &e] {
            share_devnet(&a.home, &p.home);
            p.on(|n| async move { n.chain.start().await.expect("the same chain") });
        }
        d.settings(|s| s.light = true);
        // b's owner serves the routes it keeps, so b seeds the body it pays for (`peers::announces_kept`).
        b.settings(|s| s.serve_kept = true);
        // The callers' owners let the node pay up to a's fee for one fetch; b's owner starts below it.
        for p in [&c, &d] {
            p.settings(|s| s.max_fetch_usdc = 0.5);
        }

        // a shares the shop's search by itself, as a node does: its owner lets it list every route it learns, and the
        // route has run successfully once (its first run is what a learn checks). It opens its door for the receipts
        // its callers send.
        a.settings(|s| s.share_routes = store::ShareMode::All);
        let mut route = search_route(shop.port);
        route.stats.passed_at(store::now());
        let body = recipe::canonical(&recipe::of_route(&route).unwrap());
        let cid = recipe::content_id(&body);
        // The shop is plain HTTP on this machine, which a route made from another node's body never reaches: the
        // callers run this one body as if they had learned it (`run_as_own_in_tests`, compiled into tests only). Every
        // other body, the changed one e serves among them, is held to HTTPS and the public internet as ever.
        run_as_own_in_tests(&cid);
        a.on(move |n| async move {
            let keys = n.keys.as_ref();
            // The faucet's USDC and UNB; there is no bond to post.
            chain::faucet(&n.chain, keys, 300_000.0).await.unwrap();
            chain::set_fee(&n.chain, keys, 0.5, None).await.unwrap();
            // Learned after its owner signed in, and the owner shown what it shares.
            // The owner's wallet is the node's own key here, so the node lists and is paid under its own identity and
            // signs its listing itself (a wallet apart from the node signs each listing: `owner_nodes` tests that).
            crate::testchain::sign_in_as(&n, &chain::owner_signer(keys).unwrap());
            crate::autolist::previewed();
            store::save_route(&store::Route { local: Some(false), ..route }).unwrap();
            assert_eq!(crate::autolist::tick(&n).await, ["route-items"], "a lists its route by itself");
            assert!(store::load_route("route-items").unwrap().listing.is_some_and(|l| l.live));
            let at = n.clone();
            tokio::spawn(async move { crate::api::serve(at, door, "owner".into()).await });
        });
        let (agent_b, agent_c, agent_d) = (b.caller(), c.caller(), d.caller());
        b.signed_in(shop.port, "b-session");
        c.signed_in(shop.port, "c-session");
        d.signed_in(shop.port, "d-session");
        a.join(door);
        for (p, port) in [(&b, 1), (&c, 2), (&d, 3)] {
            p.join(port);
        }
        // e joins as a provider of a changed copy of the body; it announces it later.
        let mut changed = String::from_utf8(body.clone()).unwrap().replace("items", "itemz").into_bytes();
        assert_ne!(recipe::content_id(&changed), cid);
        {
            let me = format!("{:#x}", e.me());
            let tampered = Arc::new(Tampered(std::mem::take(&mut changed)));
            e.on(move |n| async move {
                network::advertise(&me, 4, &n.info.name).unwrap();
                let net = peers::start_serving(n.clone(), tampered).await.expect("join");
                n.net.set(net).ok();
            });
        }

        // Every caller reads a's signed listing by naming the shop's site, as a search does.
        // Entries are bodies' (`Listings.entryIdOf`): the one a's listing of this body is paid under.
        let entry = format!("{:#x}", chain::content_entry_id(&cid));
        for p in [&b, &c, &d] {
            let found = p.on(|n| async move {
                for _ in 0..90 {
                    if let Some((ls, _)) = peers::find_signed(&n, "search items on localtest.me").await {
                        if !ls.is_empty() {
                            return ls.into_iter().map(|v| v.proven.listing.content_id).collect::<Vec<_>>();
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                vec![]
            });
            assert_eq!(found, std::slice::from_ref(&cid), "the signed listing names the body a lists");
        }
        let epoch = b.on(|n| async move { chain::current_epoch(&n.chain).await.unwrap() });
        let (a_addr, b_addr) = (a.me(), b.me());

        // b's owner keeps the default maximum, under a's fee: the entry is passed over, never paid for. With learning
        // off, the goal says that is why nothing answered, and naming the entry is refused, both numbers said.
        b.settings(|s| s.map_while_browsing = false);
        let (status, why) = b.does(&agent_b, shop.port).expect_err("over b's maximum");
        assert_eq!(status, axum::http::StatusCode::FORBIDDEN);
        assert!(why.contains("$0.50") && why.contains("maximum of $0.05"), "{why}");
        let (status, why) = b.calls(&agent_b, &entry).expect_err("over b's maximum");
        assert_eq!(status, axum::http::StatusCode::PAYMENT_REQUIRED);
        assert!(why.contains("$0.50") && why.contains("maximum of $0.05"), "{why}");
        // At 0 the node pays for no fetch at all.
        b.settings(|s| s.max_fetch_usdc = 0.0);
        assert_eq!(b.calls(&agent_b, &entry).expect_err("b pays nothing").0, axum::http::StatusCode::PAYMENT_REQUIRED);
        assert!(b.receipts(epoch).is_empty() && shop.seen.locked().is_empty(), "nothing was paid and nothing reached the shop");

        // b's owner raises the maximum to a's fee: at it the node pays, with nothing asked of the owner. b's agent asks
        // for the shop's search: b pays for the body, fetches it from a, checks it and runs it itself.
        b.settings(|s| {
            s.max_fetch_usdc = 0.5;
            s.map_while_browsing = true;
        });
        let done = b.does(&agent_b, shop.port).expect("b's goal");
        println!("b: {done}");
        assert_eq!(done["how"], "network", "{done}");
        assert_eq!(done["entry"]["id"], entry);
        let r = done["result"].clone();
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["data"]["items"][0]["name"], "desk lamp");
        assert_eq!(r["paid_unb"], 0.5);
        assert_eq!(r["network"]["served_by"], format!("{a_addr:#x}"));
        assert_eq!(r["network"]["cached"], false);
        assert_eq!(r["network"]["content_id"], cid);
        let kept = std::fs::read(b.home.join("bodies").join(format!("sha256-{}.json", cid.trim_start_matches("sha256:")))).ok();
        assert_eq!(kept.as_deref(), Some(body.as_slice()), "b keeps the body it checked");
        {
            let seen = shop.seen.locked();
            assert_eq!(seen.len(), 1, "one call reached the shop: {seen:?}");
            assert!(seen[0].0.starts_with("GET /api/items?q=desk"), "{seen:?}");
            assert_eq!(seen[0].1, "sid=b-session", "the shop heard b, under b's own session");
        }
        // b's line passed, names a as the server, and reached a, which keeps it to claim.
        let lines = b.receipts(epoch);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].passed && (lines[0].amount - 0.5).abs() < 1e-9);
        assert_eq!((lines[0].entry, lines[0].holders.clone()), (Some(chain::content_entry_id(&cid)), Some(vec![a_addr])));
        let owed: Vec<chain::PaidLine> = store::read_json(&a.home.join("devnet").join("owed.json"), &unbrowse_files::OWED);
        assert_eq!(owed.len(), 1, "a received the line");
        assert_eq!((owed[0].entry_id, owed[0].holders.clone(), owed[0].passed, owed[0].payer), (chain::content_entry_id(&cid), vec![a_addr], true, b_addr));

        // Again, as the same goal and as a call naming the entry: from b's copy, paying nothing. The body is paid for
        // already, so it runs even once b's owner lets the node pay for no fetch.
        b.settings(|s| s.max_fetch_usdc = 0.0);
        let done = b.does(&agent_b, shop.port).expect("b's second goal");
        assert_eq!(done["how"], "called", "the copy is b's own route now: {done}");
        assert_eq!((done["result"]["network"]["cached"].clone(), done["result"]["paid_unb"].clone()), (serde_json::json!(true), serde_json::Value::Null));
        let r = b.calls(&agent_b, &entry).expect("b's third call");
        assert_eq!((r["ok"].clone(), r["network"]["cached"].clone(), r["paid_unb"].clone()), (serde_json::json!(true), serde_json::json!(true), serde_json::Value::Null));
        assert_eq!(b.receipts(epoch).len(), 1, "no new line");
        assert_eq!(shop.seen.locked().len(), 3);

        // a goes away. b paid for the body and seeds it; d fetches it from b and runs it under d's session.
        // d's agent asks with unbrowse_do too: the listing it read before still checks against the chain.
        a.leave();
        let done = d.does(&agent_d, shop.port).expect("d's goal");
        println!("d: {done}");
        assert_eq!(done["how"], "network", "{done}");
        let r = done["result"].clone();
        assert_eq!(r["ok"], true, "{r}");
        assert_eq!(r["network"]["served_by"], format!("{b_addr:#x}"), "the seeder served it");
        assert_eq!(d.receipts(epoch)[0].holders, Some(vec![b_addr]), "the line pays the seeder the serving share");
        // A body a node keeps is one its use was billed for: every fetched route on disk has a passed line for its
        // entry (the body is kept only after the line is written).
        for p in [&b, &d] {
            let lines = p.receipts(epoch);
            let routes: Vec<store::Route> = p.on(|_| async move { store::load_routes() });
            for f in routes.iter().filter_map(|r| r.fetched.as_ref()) {
                let entry: FixedBytes<32> = f.entry_id.parse().unwrap();
                assert!(lines.iter().any(|l| l.passed && l.entry == Some(entry)), "a kept body with no passed line");
            }
        }
        assert_eq!(shop.seen.locked().last().unwrap().1, "sid=d-session");
        // d is in light mode: it keeps the body and serves it to nobody.
        let held_by_d = {
            let cid = cid.clone();
            d.on(move |n| async move { held(&n.chain, &cid) })
        };
        assert!(held_by_d.is_empty());

        // b goes too, and e announces its changed copy: c is served it, refuses it, sets e aside, and the try is a
        // failed use that pays nothing. d, in light mode, isn't asked.
        b.leave();
        {
            let cid = cid.clone();
            e.on(move |n| async move { n.net.get().unwrap().provide_body(&cid).await.unwrap() });
        }
        let e_peer = e.on(|n| async move { n.net.get().unwrap().peer_id() });
        // A provider record takes a moment to reach the peers that answer for the body's key.
        let listed = {
            let cid = cid.clone();
            c.on(move |n| async move {
                for _ in 0..60 {
                    if n.net.get().unwrap().find_body_providers(&cid).await.unwrap_or_default().contains(&e_peer) {
                        return true;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                false
            })
        };
        assert!(listed, "e's record reaches c");
        let err = c.calls(&agent_c, &entry).expect_err("no honest provider is left");
        println!("c: {err:?}");
        assert_eq!(err.0, axum::http::StatusCode::BAD_GATEWAY);
        assert!(err.1.contains("isn't the listed one"), "{}", err.1);
        let set_aside = {
            let cid = cid.clone();
            c.on(move |n| async move {
                let p = n.share.providers();
                (p.failures(&cid, e_peer), p.excluded(&cid, e_peer, epoch))
            })
        };
        assert_eq!(set_aside, (1, true));
        let lines = c.receipts(epoch);
        assert_eq!(lines.len(), 1);
        // A failed line carries its fee in the voucher and names no server: it is never charged and pays no one.
        assert!(!lines[0].passed && (lines[0].amount - 0.5).abs() < 1e-9 && lines[0].holders == Some(vec![]), "{:?}", lines[0]);
        assert!(!c.home.join("bodies").exists() || std::fs::read_dir(c.home.join("bodies")).unwrap().next().is_none(), "the changed body is never kept");
        assert_eq!(shop.seen.locked().len(), 4, "nothing reached the shop");
        // The entry served nothing this epoch, so c skips it now.
        let again = c.calls(&agent_c, &entry).expect_err("off the ranking");
        assert_eq!(again.0, axum::http::StatusCode::SERVICE_UNAVAILABLE, "{}", again.1);

        // a comes back. d keeps a copy of a's route, so it watches the shop's site and meets a on its topic.
        a.back();
        a.join(door);
        let site = unbrowse_net::site_of("shop.localtest.me").unwrap();
        let d_peer = d.on(|n| async move { n.net.get().unwrap().peer_id() });
        let met = {
            let site = site.clone();
            a.on(move |n| async move {
                for _ in 0..90 {
                    if n.net.get().unwrap().watchers(&site).await.contains(&d_peer) {
                        return true;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
                false
            })
        };
        assert!(met, "d watches the site with a");

        // A notice alone changes nothing: a says the entry is delisted while the chain still lists it. d reads the
        // chain again, finds it live, and still runs its copy.
        {
            let (site, entry) = (site.clone(), entry.clone());
            a.on(move |n| async move { n.net.get().unwrap().publish_change(unbrowse_net::Change::now(&site, unbrowse_net::ChangeKind::Delisted, vec![entry])).await.unwrap() });
        }
        std::thread::sleep(std::time::Duration::from_secs(3));
        let r = d.calls(&agent_d, &entry).expect("the chain still lists it");
        assert_eq!((r["ok"].clone(), r["network"]["cached"].clone()), (serde_json::json!(true), serde_json::json!(true)), "{r}");
        assert_eq!(shop.seen.locked().len(), 5);

        // a's owner delists the route, and a's node says so on the site's topic. d kept a copy, and the chain showed
        // the entry live moments ago, which it would take for LIVE_FOR: it hears of the delist and reads the chain at
        // once instead, and drops the copy within seconds. Its next call sends the shop nothing.
        let t = std::time::Instant::now();
        a.on(|n| async move { crate::delist_route(&n, "route-items".into()).await.unwrap() });
        let dropped = {
            let entry = entry.clone();
            d.on(move |_| async move {
                for _ in 0..100 {
                    if cached(&entry).is_none() {
                        return true;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                false
            })
        };
        assert!(dropped, "d dropped its copy on hearing of the delist");
        println!("d dropped its copy {:?} after a delisted", t.elapsed());
        assert!(t.elapsed() < std::time::Duration::from_secs(15), "within seconds, not LIVE_FOR: {:?}", t.elapsed());
        let (status, why) = d.calls(&agent_d, &entry).expect_err("delisted");
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND, "{why}");
        assert!(why.contains("delisted"), "{why}");
        assert_eq!(shop.seen.locked().len(), 5, "nothing reached the shop");
        let gone = {
            let entry = entry.clone();
            d.on(move |_| async move { cached(&entry).is_none() })
        };
        assert!(gone, "d dropped its copy");

        drop((c, d, e));
        drop(b);
        drop(a);
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
