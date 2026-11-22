//! What the node keeps on disk, beside the learner's own profiles and jars in `~/.unbrowse`:
//!
//! - `routes/<id>.json`: each route this node learned: the dependency graph and what the window shows about it;
//! - `activity.jsonl`: one line per thing the node did for an agent or the owner, newest last;
//! - `agents.json`, `vault.json`, `settings.json`: small indexes with no secret in them (keys are derived from the
//!   root key, passwords live in the Keychain or are derived on demand).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use unbrowse_learn::{Class, Graph};
use crate::sync::Locked;

/// `~/.unbrowse`, or `UNBROWSE_HOME` when set (tests use a scratch folder so they never touch the owner's data).
pub fn home() -> PathBuf {
    #[cfg(test)]
    {
        engine_reads_the_test_home();
        test_home()
    }
    #[cfg(not(test))]
    unbrowse_files::private::home()
}

/// A test's home: its thread's scratch home, else `UNBROWSE_HOME` when a test set it, else a folder of this test
/// process's own. Never the owner's `~/.unbrowse`: a thread the engine starts for a test's walk has no scratch home of
/// its own, and before this it opened its browser in the owner's profile for the site (a matrix run left one there).
#[cfg(test)]
fn test_home() -> PathBuf {
    if let Some(h) = TEST_HOME.with(|h| h.borrow().clone()) {
        return h;
    }
    if let Some(h) = std::env::var_os("UNBROWSE_HOME") {
        return PathBuf::from(h);
    }
    std::env::temp_dir().join(format!("unbrowse-test-unhomed-{}", std::process::id()))
}

/// Has every crate's home ([`unbrowse_files::private::home`]: the engine's profiles, the learner's browser program)
/// read this test thread's, as [`home`] does.
#[cfg(test)]
fn engine_reads_the_test_home() {
    unbrowse_files::private::read_home_with(test_home);
}

#[cfg(test)]
thread_local! {
    static TEST_HOME: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Whether this test thread has a scratch home: a test without one writes nothing into the owner's.
#[cfg(test)]
pub fn has_scratch_home() -> bool {
    TEST_HOME.with(|h| h.borrow().is_some())
}

/// The folder of session jars, one file per host the node holds a session for. A public peer's calls keep theirs apart
/// (`public-jars`): what they run with is never a session the owner's home held, whatever is in `owner_jars_dir`
/// (graph `gateway.no-credentials`).
pub fn jars_dir() -> PathBuf {
    if crate::remote::public_home() {
        return home().join("public-jars");
    }
    owner_jars_dir()
}

/// The folder of the owner's session jars: their sign-ins, imported or walked. A public peer refuses a home with any
/// (`remote::credentials_held`).
pub fn owner_jars_dir() -> PathBuf {
    home().join("jars")
}

/// The session jar named `name` (a host, or a route's [`unbrowse_learn::client::jar_name`]).
pub fn jar_path(name: &str) -> PathBuf {
    jars_dir().join(format!("{name}.json"))
}

/// Where how far each cookie of that jar goes is kept, beside it: the `Domain` the walk, the site's own answers or
/// an import set a cookie for, so a call sends it where the browser that earned it would
/// ([`unbrowse_learn::client::scope_path`]). Nothing that reads the jar reads this by mistake: it is not named
/// `<host>.json`.
pub fn jar_scope_path(name: &str) -> PathBuf {
    unbrowse_learn::client::scope_path(&jars_dir(), name)
}

/// The jar's cookies no browser of the node's holds, beside the jar: an import that couldn't reach a profile. What a
/// walk can't speak for, since its browser never had them. Its suffix keeps it out of the jar's own name.
pub fn jar_only_path(name: &str) -> PathBuf {
    jars_dir().join(format!("{name}.json.only"))
}

/// A cookie only the jar holds (`jar_only_path`), for as long as it was given to last.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct JarOnly {
    pub value: String,
    /// Seconds since the epoch.
    pub until: f64,
}

/// The doors this node has met, by site: what a refused walk found ([`known_door`]), so the next attempt hears which
/// wall it is even when its own capture says nothing.
fn doors_path() -> PathBuf {
    home().join("doors.json")
}

/// The door last met on `site`, if any.
pub fn known_door(site: &str) -> Option<unbrowse_learn::graph::Door> {
    let all: std::collections::BTreeMap<String, unbrowse_learn::graph::Door> = read_json(&doors_path(), &unbrowse_files::DOORS);
    all.get(site).cloned()
}

/// Keeps `door` as what `site` put in front of a walk.
pub fn note_door(site: &str, door: &unbrowse_learn::graph::Door) {
    let mut all: std::collections::BTreeMap<String, unbrowse_learn::graph::Door> = read_json(&doors_path(), &unbrowse_files::DOORS);
    all.insert(site.to_string(), door.clone());
    let _ = write_json(&doors_path(), &unbrowse_files::DOORS, &all);
}

/// The folder of the node's browser profiles, one per host.
pub fn profiles_dir() -> PathBuf {
    home().join("profiles")
}

/// The node's browser profile for `host`.
pub fn profile_dir(host: &str) -> PathBuf {
    profiles_dir().join(host)
}

/// A fresh scratch folder as this test thread's home: the owner's data and other tests' are never touched.
#[cfg(test)]
pub fn scratch_home(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("unbrowse-test-{name}-{}-{n}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("scratch home");
    use_home(&dir);
    // A scratch home keeps checkout holds on disk, sealed: every test with one seals with the same key, whichever
    // runs first or alone.
    crate::payhold::seal_for_tests();
    dir
}

/// `route` with a body beside its graph that holds `text` where nothing else of the route does (a slot's example, and
/// a header its last step sends), and a check of it that says `text` too. A test reads where that text goes.
#[cfg(test)]
pub fn with_a_body_saying(mut route: Route, text: &str) -> Route {
    use unbrowse_learn::route as body;
    let mut learned = unbrowse_learn::body::from_graph(&route.graph, &route.site);
    learned.slots.push(body::Slot { name: "body-only".into(), secret: false, example: Some(text.into()), choices: Vec::new() });
    if let Some(step) = learned.steps.last_mut() {
        step.holes.push(body::Hole { at: body::Place::Header("x-body-only".into()), ways: vec![body::Way { rung: 0, expr: body::Expr::text(text) }], over: false, open: false });
    }
    route.body = Some(learned);
    route.checked = Some(Checked { tests: vec![text.into()], left_out: vec![text.into()], ..Checked::default() });
    route
}

/// Makes `dir` this test thread's home (a thread a test starts takes the test's home this way).
#[cfg(test)]
pub fn use_home(dir: &Path) {
    engine_reads_the_test_home();
    TEST_HOME.with(|h| *h.borrow_mut() = Some(dir.to_path_buf()));
}


pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub use unbrowse_files::Format;

/// The file at `path` in `format`, or the default when it is missing or doesn't read. One a newer node wrote reads as
/// the default too, and the owner is told once (it is never written over: [`write_json`]).
pub fn read_json<T: DeserializeOwned + Default>(path: &Path, format: &Format) -> T {
    match format.read_at(path) {
        Ok(v) => v.unwrap_or_default(),
        Err(r) => {
            if r.is_newer() {
                refused(path, &r);
            }
            T::default()
        }
    }
}

/// The same, for a file whose contents decide who may do what: a file that is missing is empty, but one that is
/// there and doesn't read, or that a newer node wrote, is an error, never read as empty.
pub fn read_json_strict<T: DeserializeOwned + Default>(path: &Path, format: &Format) -> Result<T, String> {
    match format.read_at(path) {
        Ok(v) => Ok(v.unwrap_or_default()),
        Err(r @ unbrowse_files::Refusal::Newer { .. }) => Err(r.message(path)),
        Err(r) => Err(format!("{}; fix or restore it first", r.message(path))),
    }
}

/// The file at `path` in `format`, if there is one that reads: none when it is missing, doesn't read or a newer node
/// wrote it (the owner is told once).
pub fn read_json_opt<T: DeserializeOwned>(path: &Path, format: &Format) -> Option<T> {
    format.read_at(path).map_err(|r| if r.is_newer() { refused(path, &r) }).ok().flatten()
}

/// Tells the owner, once a run, that a file a newer node wrote was left unread.
fn refused(path: &Path, r: &unbrowse_files::Refusal) {
    tell_once(path, &r.message(path));
}

/// Says `what` about the file at `path` once a run: a pass that meets the same unreadable file each time says so once.
pub fn tell_once(path: &Path, what: &str) {
    static TOLD: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    let mut told = TOLD.locked();
    if !told.iter().any(|p| p == path) {
        told.push(path.to_path_buf());
        eprintln!("{what}");
    }
}

/// Writes `value` as JSON in `format`, carrying its version, readable by the owner alone: the node's files hold its
/// sessions (jars), its routes and what it did, so each is 0600, and every folder of the node's own under its home is
/// 0700, a folder kept from before included. A file a newer node wrote is never written over: that is an error.
pub fn write_json<T: Serialize + ?Sized>(path: &Path, format: &Format, value: &T) -> Result<(), String> {
    format.write_at(path, value)?;
    narrow_to(path);
    Ok(())
}

/// Narrows every folder from the node's home down to `path`'s to the owner alone. A path outside the home is left as
/// it is: those folders are not the node's.
fn narrow_to(path: &Path) {
    let home = home();
    let Some(dir) = path.parent() else { return };
    let Ok(rel) = dir.strip_prefix(&home) else { return };
    let mut at = home.clone();
    let _ = unbrowse_files::private::narrow(&at);
    for part in rel.components() {
        at.push(part);
        let _ = unbrowse_files::private::narrow(&at);
    }
}

/// The first host a route reaches that the owner excluded in Settings: its site, the page it starts from, any step's
/// host and its socket's. A route never runs, heals or is kept on a host the node never learns from, whichever host
/// the walk began on.
pub fn excluded_host(route: &Route, excluded: &[String]) -> Option<String> {
    let host_of = |url: &str| {
        let mut parts = url.splitn(4, '/');
        let (scheme, _, authority) = (parts.next().unwrap_or_default(), parts.next(), parts.next().unwrap_or_default());
        url::Url::parse(&format!("{scheme}//{authority}/")).ok().and_then(|u| u.host_str().map(String::from))
    };
    std::iter::once(Some(route.site.clone()))
        .chain(std::iter::once(host_of(&route.root)))
        .chain(route.graph.steps.iter().map(|s| host_of(&s.url)))
        .chain(route.socket.iter().map(|s| host_of(&s.url)))
        .flatten()
        .find(|h| excluded.iter().any(|e| unbrowse_learn::identity::at_or_under(h, e)))
}

/// A value the caller supplies when the route runs.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RouteInput {
    pub name: String,
    pub secret: bool,
    pub default: Option<String>,
    /// A file the route uploads: the caller passes its path, inside the node's file root (`AGENT_BROWSER_FILE_ROOT`,
    /// or `~/.agent-browser/files`), and the call reads the file from there.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub file: bool,
    /// A call needn't give it: left out, nothing is sent for it (a filter, the next page).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
    /// The values the page offers for it, as far as the walk saw: it may take others.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<unbrowse_learn::controls::Choice>,
}

impl RouteInput {
    /// What kind of value the input takes, as route listings say it: `file` (a path) or `text`.
    pub fn kind(&self) -> &'static str {
        if self.file { "file" } else { "text" }
    }
}

/// How the route has done when called through this node.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct RouteStats {
    pub calls: u64,
    pub passed: u64,
    pub last_ms: Option<u64>,
    pub last_at: Option<u64>,
    pub last_error: Option<String>,
    /// The days (UTC, counted from the epoch) the route passed on: how many there were, and the last. Two calls that
    /// pass on one day count one day, so a burst of calls is told apart from a route agents come back to.
    #[serde(default)]
    pub pass_days: u32,
    #[serde(default)]
    pub last_pass_day: u64,
    /// Which rule chose the route's default fields (`fields::DEFAULTS_RULE`): defaults an older rule chose are chosen
    /// again on the next call, once, unless an agent set them.
    #[serde(default)]
    pub fields_rule: u32,
    /// What each step last did when the route was called (`unbrowse_learn::health`): the step a refusal landed on,
    /// how and when, and when each step last answered.
    #[serde(default, skip_serializing_if = "health_is_empty")]
    pub health: unbrowse_learn::health::Health,
}

fn health_is_empty(h: &unbrowse_learn::health::Health) -> bool {
    h.steps.is_empty()
}

impl RouteStats {
    /// Whether what a route sends has been seen working more than once: passes on two days. Two passes in one sitting
    /// say less: a value that lasts a session would pass them both.
    pub fn sighted(&self) -> bool {
        self.pass_days >= 2
    }

    /// Counts a call that passed at `at` (seconds).
    pub fn passed_at(&mut self, at: u64) {
        self.passed += 1;
        let day = at / 86_400;
        if self.pass_days == 0 || day != self.last_pass_day {
            self.pass_days += 1;
            self.last_pass_day = day;
        }
    }
}

/// The tries of a route's page that read nothing: a browser that didn't start, a site that refused an empty profile, or
/// another try running at the time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PageTries {
    /// How many failed. A try that couldn't start for another running isn't one.
    pub failed: u8,
    /// When it last came up (seconds); 0 when it never has.
    pub at: u64,
}

impl PageTries {
    fn none(&self) -> bool {
        *self == PageTries::default()
    }
}

/// What became of the route on the chain, once it is listed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Listing {
    /// The entry id on the Settlement contract (hex).
    pub entry_id: String,
    pub tx: String,
    pub listed_at: u64,
    pub live: bool,
}

/// The versions of the rules a route's walk was judged by: the address reader (`walk::ADDRESS_READER`) and the rule of
/// what explains a constant (`learn::PAGE_MADE_RULE`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadBy {
    pub addresses: u32,
    pub page_made: u32,
}

impl ReadBy {
    /// The rules this build judges by.
    pub fn current() -> Self {
        Self { addresses: unbrowse_learn::walk::ADDRESS_READER, page_made: crate::learn::PAGE_MADE_RULE }
    }

    /// Whether a verdict judged by these rules stands in this build: this build's rule of what explains a constant, and
    /// an address reader no older than the oldest whose verdicts it trusts (`walk::OLDEST_TRUSTED_ADDRESS_READER`) and
    /// no newer than its own.
    pub fn trusted(by: Option<Self>) -> bool {
        by.is_some_and(|b| b.page_made == crate::learn::PAGE_MADE_RULE && (unbrowse_learn::walk::OLDEST_TRUSTED_ADDRESS_READER..=unbrowse_learn::walk::ADDRESS_READER).contains(&b.addresses))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    pub site: String,
    /// What the route does, in the owner's words.
    pub what: String,
    /// The other goals this same call was learned for, newest last: a route is named by its call, so two goals that
    /// land on one call share one record, and each still finds it without walking the page again. Empty once an agent
    /// names the route (`Judged::named`): a goal in the old words is then one the agent said it doesn't do.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asked: Vec<String>,
    pub method: String,
    /// The target's URL with every non-constant value as `{name}`.
    pub path: String,
    /// The page the flow starts from, walked again when the site drifts.
    pub root: String,
    pub inputs: Vec<RouteInput>,
    pub steps: usize,
    /// Some step needs the browser (a value only page code computes).
    pub browser_assisted: bool,
    /// The learn-time trial's answer: whether the route's own fields answered **without** the page's values
    /// (`Some(true)`), or they were needed / the page was kept (`Some(false)`). None when the trial didn't run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plain_trial: Option<bool>,
    /// How the route reads on to its list's next page, when the walk showed that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paging: Option<unbrowse_learn::paging::Paging>,
    /// The node has tried the page's own controls for this route (`learn::try_the_page`), whatever it found, or given up
    /// trying.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub tried_page: bool,
    /// How trying the page has gone so far, while nothing has read it.
    #[serde(default, skip_serializing_if = "PageTries::none")]
    pub page_tries: PageTries,
    /// Changes state on the site, so it is labelled a write. See [`unbrowse_learn::ledger::writes`].
    pub write: bool,
    /// Learned from one sighting: it sends a value with no source the walk shows, unconfirmed until a second. A call that
    /// passes is a sighting of the site taking that value, and one on another day is the second (`RouteStats::sighted`).
    /// This says what the route has been through, and nothing more: the value stays what the graph says it is, so it
    /// still never goes out in a listing (`recipe`).
    pub provisional: bool,
    pub learned_at: u64,
    #[serde(default)]
    pub stats: RouteStats,
    #[serde(default)]
    pub listing: Option<Listing>,
    /// Learned from the owner's own browsing through the node: it runs here with their session. Listed after sign-in
    /// like any other route, as its recipe with placeholders: the owner's session never leaves the node (spec §72.1).
    #[serde(default)]
    pub yours: bool,
    /// Learned while the owner hadn't signed in (R1.35): it stays on this node and is never listed (R2.8). `None` for a
    /// record from before this mark, read by when it was learned against the sign-in (`Route::local`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<bool>,
    /// For a route whose target is a frame sent over a socket rather than a request: how to open the socket and
    /// what to send. Its `graph` is then empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket: Option<SocketRoute>,
    /// For a route made from another contributor's listed body (`recipe::into_route`): where it came from. Such a route
    /// runs under this node's own session and is never this node's to list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched: Option<Fetched>,
    /// The owner's say on sharing this one route: `None` follows the `share_routes` setting, `Some(false)` keeps it
    /// off the network (delisting it sets this), `Some(true)` shares it even after an earlier delist.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub share: Option<bool>,
    /// The fields a call hands back by default (`unbrowse_learn::fields::defaults`): the goal's own fields and each
    /// record's name, read from the first answer big enough to trim. A caller adds any other by its path, or asks
    /// for `*`, the whole answer. Empty until then.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
    /// What agents said of the route after reading its answers (`unbrowse_judge`): the pages it doesn't do, and
    /// whether its name and its default fields are an agent's. The agent driving a page can tell an empty list, a
    /// suggestion box or the wrong tab from the answer it asked for; the node keeps what it says rather than guess it
    /// from the words.
    #[serde(default, skip_serializing_if = "Judged::is_empty")]
    pub judged: Judged,
    /// What the site said when it was asked whether the route's answer changes with what the caller sends
    /// (`learn::hears`): the pick is the learner's proposal, and this is the site's word on it.
    #[serde(default, skip_serializing_if = "Heard::is_unasked")]
    pub heard: Heard,
    /// For a route whose walked address carried values only in its fragment: the constants it sends that the walk
    /// shows no source for other than the page's own code (`learn::page_made`), by where each goes. None when no such
    /// reading was made (a route with no fragment-only values, or one learned before it was). This node's own record:
    /// a route with any, or one never read, isn't listed (`recipe::compile_with`), since the page may have made them
    /// from what the fragment held.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_made: Option<Vec<String>>,
    /// The walk this route was learned from shows it was never at an address with a fragment (`learn::walk_without_fragment`):
    /// its own address had none, its capture recorded every address its browser was at and none had one, and no
    /// redirect named one. False for a walk that can't say (a browsing session's capture, a route learned before this was
    /// read, one a heal rebuilt): such a route is listed only as one whose walk had a fragment is (`page_made`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub walk_without_fragment: bool,
    /// Which rules judged `walk_without_fragment` and `page_made` when the route was learned. Evidence is only as good
    /// as the reader that judged it: a route judged by another version of either, or by none (one kept before this was
    /// recorded), is read as unjudged, its walk as one that may have been at an address with a fragment and its
    /// `page_made` as never read (`recipe::compile_with`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_by: Option<ReadBy>,
    /// The inputs whose walked value the owner's own session gave the page (typed, selected, or chosen by a click), by
    /// name. This node's own record: a shared route carries none of those values, not even as an optional input's
    /// default (`recipe::compile_with`), whatever the site said back.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub given: Vec<String>,
    /// The owner's own browsing session gave the page at least one of the route's inputs (typed, selected, clicked),
    /// as opposed to a value a caller named for a walk through the API, which is the caller's own word. Such a route is
    /// listed only as one whose walk had a fragment is (`page_made`): what the page made from the owner's value (a code
    /// wrapped in base64, sent under another name) can't be found by its text.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub session_gave: bool,
    /// The body the route was learned as by example (`docs/REBUILD.md`), from the same walks as `graph`, kept beside
    /// it: the node calls it where the switch says so. None for a route learned otherwise, and once a heal or a learn
    /// puts a graph of other walks in its place. It never leaves the node: it holds the walk's own values. One this
    /// build does not read is no body, and the route stands as its graph.
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "a_body_that_reads")]
    pub body: Option<unbrowse_learn::route::Route>,
    /// What the site said when the node checked the route it learned by example (`learn::checked`): the four tests
    /// and what shrinking left out. The node's own record, for a later look to read; never shared, stripped as the body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<Checked>,
    pub graph: Graph,
}

/// What the site said of a route learned by example, when the node checked it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Checked {
    pub at: u64,
    /// Each of the four tests, how it came out and why.
    pub tests: Vec<String>,
    /// What shrinking left out, and what it kept, as each part is named.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub left_out: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kept: Vec<String>,
    /// What the asks ran out before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub untried: Vec<String>,
    /// The asks of the site the check spent.
    pub asks: usize,
}

/// A route's body as this build reads it: one written by a newer node, or one that does not read, is none, so the
/// route still reads as its graph.
fn a_body_that_reads<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<unbrowse_learn::route::Route>, D::Error> {
    let value: Option<serde_json::Value> = Option::deserialize(d)?;
    Ok(value.and_then(|v| serde_json::from_value::<unbrowse_learn::route::Route>(v).ok()).filter(|b| b.refused().is_none()))
}

/// The site's word on whether a route hears its caller (`learn::hears`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Heard {
    /// The site was asked: the route was called once more with a value nobody would send.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub probed: bool,
    /// The inputs whose value changed nothing in the answer: the route answers its own page whatever they say, so an
    /// ask for another value is never answered by it (`goal::unreached`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deaf: Vec<String>,
    /// Another word the route was called with, taken from the page it was learned on, whose answer said that word
    /// back (`learn::trial`): the route is known to answer a second value, not only the walked one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub said_back: Option<String>,
    /// Where the answer holds its records, as a confirming browse saw them for a value the route was not learned on
    /// (`confirm::records_place`): the keys by name down to the list, `[]` for a list on the way. A later answer
    /// without that place holds no records for its value, whatever else it says (`confirm::lacks_its_records`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub records_at: Option<String>,
}

impl Heard {
    pub fn is_unasked(&self) -> bool {
        *self == Heard::default()
    }
}

/// What agents judged of a route (`unbrowse_judge`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Judged {
    /// The pages an agent said the route's answer doesn't do: `unbrowse_do` for one of them passes the route over and
    /// learns the page afresh, or opens it for the agent's hands.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub wrong: Vec<WrongPage>,
    /// `what` is an agent's words for what the route's answer is, so a learn of the same call keeps it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub named: bool,
    /// `fields` are the paths an agent said are the answer: they stay the defaults, never chosen again by the node.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub fields: bool,
    /// An agent saw that calling the route changes something on the site, whatever its method says (a GET that
    /// unsubscribes or adds to a cart): the route is a write from then on, held to the write rules and never called for
    /// a goal that only reads (R1.25).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub writes: bool,
}

impl Judged {
    pub fn is_empty(&self) -> bool {
        *self == Judged::default()
    }
}

/// A page an agent said the route doesn't do, and why, in its words.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WrongPage {
    /// The page as `page_key` writes it.
    pub page: String,
    pub why: String,
    /// The agent that said so, and when.
    pub by: String,
    pub at: u64,
}

/// A page as a verdict names it: its scheme, host, path without a trailing slash, and query values in order, with no
/// fragment and no empty values. `/search/x/` and `/search/x` are one page; `?tab=marketplace` makes another.
pub fn page_key(url: &str) -> Option<String> {
    let u = url::Url::parse(url.trim()).ok()?;
    let mut query: Vec<(String, String)> = u.query_pairs().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    query.sort();
    let path = percent_encoding::percent_decode_str(u.path().trim_end_matches('/')).decode_utf8_lossy().into_owned();
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    let mut key = format!("{}://{}{port}{}", u.scheme(), u.host_str()?.to_lowercase(), path);
    if !query.is_empty() {
        key.push('?');
        key.push_str(&query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));
    }
    Some(key)
}

/// The listing a fetched route's body came from.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Fetched {
    /// The entry on the Settlement contract (hex), and the route it lists.
    pub entry_id: String,
    pub route_id: String,
    /// The contributor's identity: its ERC-8004 `agentId`, or its wallet on a devnet with no registry.
    pub agent_id: String,
    pub content_id: String,
    /// What the contributor says the route does: their words, kept as data (R2.25).
    pub listed_as: String,
    pub fetched_at: u64,
}

/// A frame sent over a page's socket, as a route: the socket's address and the headers the page chose to open it
/// with (the browser's own, such as its key, are made fresh), the frames the protocol opens with, and the frame
/// itself with the caller's values in it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SocketRoute {
    pub url: String,
    pub headers: Vec<(String, String)>,
    /// Frames the page sent as the socket opened, before anything of its own.
    pub opening: Vec<String>,
    /// The server spoke first (a greeting the page waited for before sending).
    pub server_first: bool,
    pub frame: Vec<Piece>,
}

/// A piece of a frame: text as it was sent, or one of the caller's values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Piece {
    Text { text: String },
    Input { name: String },
}

impl Route {
    /// Whether something stands on this record that a learn has no say over: a place on the chain (its entry names it,
    /// and peers pay for it), the owner's own (learned from their browsing, acting as them), or an agent's verdict
    /// (`unbrowse_judge`: a page it doesn't do, its name, its fields, or that it changes the site, which only this
    /// record remembers). A learn adds to such a record and never removes it; the owner still can.
    pub fn stands(&self) -> bool {
        self.listing.is_some() || self.yours || !self.judged.is_empty()
    }

    /// Whether this route stays on the node for good, learned before the owner signed in at `since` (or with no
    /// sign-in yet): its own mark, or for a record from before the mark, when it was learned (R2.8).
    pub fn local_since(&self, since: Option<u64>) -> bool {
        self.local.unwrap_or_else(|| since.is_none_or(|t| self.learned_at < t))
    }

    /// `url`'s page as a verdict on this route reads it: `page_key`, without the values the route takes as inputs. What
    /// was searched is the caller's, and the route is the same call whatever it is: `?q=rust` and `?q=sourdough` are one
    /// page to a route that takes `q`. A piece of the path is read the same way, where the page the route was learned on
    /// has an input's value in that place.
    fn verdict_key(&self, url: &str) -> Option<String> {
        let mut u = url::Url::parse(url.trim()).ok()?;
        let takes = |k: &str| self.inputs.iter().any(|i| i.name == k);
        let query: Vec<(String, String)> = u.query_pairs().filter(|(k, _)| !takes(k)).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        u.query_pairs_mut().clear().extend_pairs(query);
        if u.query() == Some("") {
            u.set_query(None);
        }
        let pieces = |x: &url::Url| -> Vec<String> { x.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(String::from).collect()).unwrap_or_default() };
        let mine = pieces(&u);
        let learned = url::Url::parse(&self.root).ok().filter(|r| r.host_str() == u.host_str()).map(|r| pieces(&r)).unwrap_or_default();
        // The route's own path template says which pieces are the caller's: `/search/{q}` makes `/search/chicken` and
        // `/search/pasta` one page, so a route answers a new value without another walk (foodnetwork re-learned on a
        // browser for every value before this).
        let template: Vec<String> = self.path.split('?').next().unwrap_or_default().split('/').filter(|s| !s.is_empty()).map(String::from).collect();
        let hole = |i: usize| template.get(i).is_some_and(|p| p.starts_with('{') && p.ends_with('}'));
        if learned.len() == mine.len() {
            let is_input = |piece: &str| {
                let piece = percent_encoding::percent_decode_str(piece).decode_utf8_lossy();
                // Two bytes, as a path piece ever has: a one-byte input default (`adults=1`) came from the query,
                // and matching a path piece against it would read `/news/1` and `/news/2` as one page.
                self.inputs.iter().any(|i| i.default.as_deref().is_some_and(|d| d.len() >= 2 && d.eq_ignore_ascii_case(&piece)))
            };
            let path: Vec<&str> = mine.iter().enumerate().map(|(i, now)| if hole(i) || learned.get(i).is_some_and(|was| is_input(was)) { "-" } else { now.as_str() }).collect();
            u.set_path(&path.join("/"));
        }
        page_key(u.as_str())
    }

    /// Whether two addresses are one page to a verdict on this route.
    pub fn same_page(&self, a: &str, b: &str) -> bool {
        self.verdict_key(a).is_some_and(|k| Some(k) == self.verdict_key(b))
    }

    /// The verdict that the route doesn't do `url`'s page, if an agent gave one.
    pub fn wrong_for(&self, url: &str) -> Option<&WrongPage> {
        self.judged.wrong.iter().find(|w| self.same_page(&w.page, url))
    }

    /// What the owner's own browsing session gave this route's page, by input name with its walked value: typed,
    /// selected or chosen by a click (`given` with `session_gave`). None of it is said back to an agent as a value, and
    /// no agent's call uses it in the agent's place ([`Route::usable_by_an_agent`], [`Route::shown_to_an_agent`]). A
    /// value a caller named for a walk through the API (`given` without `session_gave`) is that caller's own word.
    pub fn owners_own(&self) -> Vec<(String, String)> {
        if !self.session_gave {
            return Vec::new();
        }
        self.inputs.iter().filter(|i| self.given.contains(&i.name)).filter_map(|i| Some((i.name.clone(), i.default.clone()?))).collect()
    }

    /// The route as an agent's call runs it: what the owner's own session gave (`owners_own`) keeps no default, so an
    /// agent's call that leaves such an input out is refused for want of it rather than sent with the owner's value.
    /// The owner's own calls (the window, the owner's token) run the route as kept.
    pub fn usable_by_an_agent(&self) -> Route {
        let mut r = self.clone();
        if !r.session_gave {
            return r;
        }
        // The body it was learned as by example holds the walk's own values, the owner's among them: an agent's call
        // runs the graph, made safe below, never that.
        r.body = None;
        let own: Vec<String> = r.given.clone();
        for i in r.inputs.iter_mut().filter(|i| own.contains(&i.name)) {
            i.default = None;
        }
        for f in r.graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
            if let unbrowse_learn::Class::Input { name, default, .. } = &mut f.class {
                if own.contains(name) {
                    *default = None;
                }
            }
        }
        r
    }

    /// The route as an agent's call runs it, or why an agent can't run it. On top of [`Route::usable_by_an_agent`]:
    /// - a fixed value equal to what the owner's session gave for an input, at the very place (`Loc`) another step
    ///   takes that input, is that input there too: the graph says which it is, so the agent's value goes there;
    /// - the page the route was learned on (the root a heal walks again) keeps none of it: its query and fragment go,
    ///   and its path too if that still carries it;
    /// - and then, if what the call would send (each step's address, body and fixed values, with where each was seen,
    ///   and everything else of the graph the call or the signing sandbox runs with: the page, its kept page, scripts and
    ///   answers) still carries a value the owner's session gave, however written, read as the sharing boundary reads
    ///   it (`recipe::still_carries`), the call is refused by the place it sits.
    pub fn callable_by_an_agent(&self) -> Result<Route, String> {
        let mut r = self.usable_by_an_agent();
        let own = self.owners_own();
        if own.is_empty() {
            return Ok(r);
        }
        use unbrowse_learn::slots::Loc;
        let taken: Vec<(Loc, String)> = r
            .graph
            .steps
            .iter()
            .flat_map(|s| &s.fields)
            .filter_map(|f| match &f.class {
                Class::Input { name, .. } if own.iter().any(|(n, _)| n == name) => Some((f.loc.clone(), name.clone())),
                _ => None,
            })
            .collect();
        for step in r.graph.steps.iter_mut() {
            for f in step.fields.iter_mut() {
                let fixed = match &f.class {
                    Class::Constant { value, .. } | Class::Unconfirmed { value } => value.clone(),
                    _ => continue,
                };
                let Some((_, name)) = taken.iter().find(|(loc, name)| *loc == f.loc && own.iter().any(|(n, v)| n == name && *v == fixed)) else { continue };
                f.class = Class::Input { name: name.clone(), secret: false, default: None, optional: false };
                // Out of the step's own address and body too, as the sharing boundary takes a value out (`promote`).
                crate::recipe::promote(&mut step.url, &mut step.body, &f.loc, &fixed);
            }
        }
        let carries = |text: &str| own.iter().find(|(_, v)| crate::recipe::still_carries(text, v)).map(|(n, _)| n.clone());
        if carries(&r.root).is_some() {
            let bare = r.root.split(['?', '#']).next().unwrap_or_default().to_string();
            r.root = if carries(&bare).is_some() { url::Url::parse(&bare).map(|u| u.origin().ascii_serialization()).unwrap_or_default() } else { bare };
        }
        let refused = |at: String| format!("this route was taught by the owner's own browsing and still carries what they typed at {at}: walk the page again as the agent (unbrowse_do with the page's url, or unbrowse_browse)");
        for (n, step) in r.graph.steps.iter().enumerate() {
            for f in &step.fields {
                let text = serde_json::to_string(&f.class).unwrap_or_default();
                if carries(&text).is_some() {
                    return Err(refused(format!("step {} {}", n + 1, f.loc)));
                }
            }
            let mut sent = serde_json::to_value(step).unwrap_or_default();
            if let Some(m) = sent.as_object_mut() {
                m.remove("response_shape");
            }
            if carries(&sent.to_string()).is_some() {
                return Err(refused(format!("step {}", n + 1)));
            }
        }
        // And everything else of the graph a call sends or runs with, read from the graph as it is serialised, so a field
        // added to it later is read too: the page a signing bridge boots, its kept page, scripts and the answers the
        // sandbox replays (`page`, `page_html`, `scripts`, `api`), a door's record. Only an answer's shape is left out:
        // it holds key names and types, and nothing in it is sent.
        let mut whole = serde_json::to_value(&r.graph).unwrap_or_default();
        for step in whole.get_mut("steps").and_then(serde_json::Value::as_array_mut).into_iter().flatten() {
            if let Some(m) = step.as_object_mut() {
                m.remove("response_shape");
            }
        }
        if let Some(m) = whole.as_object() {
            if let Some((key, _)) = m.iter().find(|(_, v)| carries(&v.to_string()).is_some()) {
                return Err(refused(format!("the route's kept {key}")));
            }
        }
        Ok(r)
    }

    /// The route as an agent is shown it ([`Route::usable_by_an_agent`], and more): on a route the owner's own session
    /// gave a value to, what the page made from that value can't be found by its text, so no address of it is shown
    /// whole. Each step's address keeps its scheme, host and path, with no query, and a fixed path piece only where the
    /// site served it before any of the walk's page code ran (`page_made`, judged by this build's rules); every other
    /// fixed piece reads `{fixed}`. An address an earlier answer was read at keeps only its scheme and host; the walked
    /// address and the page keep nothing. The route's own path is its last step's, so shown.
    pub fn shown_to_an_agent(&self) -> Route {
        let mut r = self.usable_by_an_agent().shown();
        // The second word a route answered came from the page as the owner's session saw it (a link, a suggestion):
        // an agent is told that there was one, never which.
        if r.heard.said_back.is_some() {
            r.heard.said_back = Some("{word}".into());
        }
        if !r.session_gave {
            return r;
        }
        let judged = ReadBy::trusted(r.read_by);
        let made = r.page_made.clone().unwrap_or_default();
        let origin_only = |u: &str| url::Url::parse(u).ok().map(|u| u.origin().ascii_serialization()).unwrap_or_default();
        for (n, step) in r.graph.steps.iter_mut().enumerate() {
            let fixed: Vec<usize> = step
                .fields
                .iter()
                .filter_map(|f| match (&f.loc, &f.class) {
                    (unbrowse_learn::slots::Loc::Path(i), unbrowse_learn::Class::Constant { .. }) if !judged || made.contains(&format!("step {} path[{i}]", n + 1)) => Some(*i),
                    _ => None,
                })
                .collect();
            let bare = step.url.split('?').next().unwrap_or_default().to_string();
            let (head, path) = match bare.splitn(4, '/').collect::<Vec<_>>()[..] {
                [scheme, empty, authority, path] => (format!("{scheme}/{empty}/{authority}"), path.to_string()),
                _ => (bare.clone(), String::new()),
            };
            let path: Vec<String> = path.split('/').enumerate().map(|(i, p)| if fixed.contains(&i) { "{fixed}".to_string() } else { p.to_string() }).collect();
            step.url = format!("{head}/{}", path.join("/"));
            for f in step.fields.iter_mut() {
                match &mut f.class {
                    unbrowse_learn::Class::Constant { origin: Some(o), .. } | unbrowse_learn::Class::Derived { origin: o } => o.url = origin_only(&o.url),
                    _ => {}
                }
            }
        }
        if let Some(last) = r.graph.steps.last() {
            r.path = last.url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_else(|| "/".into());
        }
        r.root = origin_only(&r.root);
        r.graph.page = None;
        r
    }

    /// The slots the route's body asks that its graph takes no input for, offered as the route's own: optional, with
    /// the walk's value as the default, so a caller's value for one reaches the body (`inputs_for` hands on only what
    /// a route takes). A secret keeps no value here, as a graph's secret input keeps none but a vault login's name.
    pub fn offer_the_bodys_slots(&mut self) {
        let Some(body) = &self.body else { return };
        for (name, secret, walked) in unbrowse_learn::body::asked_as_walked(body) {
            if !self.inputs.iter().any(|i| i.name == name) {
                let default = walked.filter(|v| !secret || crate::vault::is_ref(v));
                self.inputs.push(RouteInput { name, secret, default, file: false, optional: true, options: Vec::new() });
            }
        }
    }

    /// The route as it is shown off the node's own records (the owner's window and SDKs): without the body it was
    /// learned as, which holds the walk's own values and never leaves the node, nor what the node's check of it found.
    pub fn shown(mut self) -> Self {
        self.body = None;
        self.checked = None;
        self
    }

    pub fn from_graph(id: String, what: String, root: String, graph: Graph) -> Option<Self> {
        let target = graph.steps.last()?;
        let url: url::Url = target.url.replace('{', "%7B").replace('}', "%7D").parse().ok()?;
        let site = url.host_str()?.to_string();
        let path = target.url.splitn(4, '/').nth(3).map(|p| format!("/{p}")).unwrap_or_else(|| "/".into());
        let mut inputs: Vec<RouteInput> = Vec::new();
        for step in &graph.steps {
            for f in &step.fields {
                if let Class::Input { name, secret, default, optional } = &f.class {
                    if !inputs.iter().any(|i| &i.name == name) {
                        // A secret's value is never kept, unless it is a login's or a card's name in the vault: then
                        // it is how every later call signs in again, or pays (asking the owner each time).
                        let kept = default.clone().filter(|d| !*secret || crate::vault::is_ref(d));
                        inputs.push(RouteInput { name: name.clone(), secret: *secret, default: kept, file: false, optional: *optional, options: Vec::new() });
                    }
                }
            }
            // A file the route uploads is an input too, taken by path; the walk's own file is never its default.
            let files = step.fields.iter().filter_map(|f| match &f.class {
                Class::File { name, .. } => Some(name.clone()),
                _ => None,
            });
            let upload = match &step.body {
                Some(unbrowse_learn::Body::Upload { input, .. }) => Some(input.clone()),
                _ => None,
            };
            for name in upload.into_iter().chain(files) {
                if !inputs.iter().any(|i| i.name == name) {
                    inputs.push(RouteInput { name, secret: false, default: None, file: true, optional: false, options: Vec::new() });
                }
            }
        }
        // A value that rides only inside longer ones is an input all the same. Not one that rides only in the
        // referer: that is the page's own address said back, as a browser says it for every call, and a value of
        // the page's that the call sends nowhere else is no ask of the call's (a tab of the page, a sort).
        let said_back = |h: &&unbrowse_learn::graph::Held| matches!(&h.loc, unbrowse_learn::Loc::Header(name) if name.eq_ignore_ascii_case("referer"));
        for h in graph.steps.iter().flat_map(|s| &s.held).filter(|h| !said_back(h)) {
            if !inputs.iter().any(|i| i.name == h.input) {
                inputs.push(RouteInput { name: h.input.clone(), secret: false, default: Some(h.sits.clone()), file: false, optional: false, options: Vec::new() });
            }
        }
        Some(Self {
            id,
            site,
            what,
            method: target.method.clone(),
            path,
            root,
            inputs,
            steps: graph.steps.len(),
            browser_assisted: graph.steps.iter().any(|s| s.needs_browser || s.is_page_signed()),
            plain_trial: None,
            paging: None,
            tried_page: false,
            page_tries: PageTries::default(),
            asked: Vec::new(),
            write: unbrowse_learn::ledger::writes(target),
            provisional: graph.provisional,
            learned_at: now(),
            stats: RouteStats::default(),
            listing: None,
            yours: false,
            local: None,
            socket: None,
            fetched: None,
            share: None,
            fields: Vec::new(),
            judged: Judged::default(),
            heard: Heard::default(),
            page_made: None,
            walk_without_fragment: false,
            read_by: None,
            given: Vec::new(),
            session_gave: false,
            body: None,
            checked: None,
            graph,
        })
    }
}

pub fn routes_dir() -> PathBuf {
    home().join("routes")
}

/// Routes as last read from their files, each by its file's length and when it was last written: a route's file
/// holds its graph and its page's code (megabytes for a busy page), every ask reads every route, and each call writes
/// one. A file changed since, by this node or anything else, is read again. Holds no route that isn't on disk.
static READ_ROUTES: std::sync::Mutex<Option<std::collections::HashMap<PathBuf, (std::time::SystemTime, u64, std::sync::Arc<Route>)>>> = std::sync::Mutex::new(None);

fn stamp(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let m = fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// The route in the file at `path`, read once for each time the file is written.
fn read_route(path: &Path) -> Option<Route> {
    read_route_shared(path).map(|r| (*r).clone())
}

/// Set when a route was read from its file rather than the cache: reading one whole takes its page's code into memory
/// for a moment, and `load_routes_shared` gives that back to the system after.
static READ_FROM_FILES: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The route in the file at `path`, as kept in the cache: shared, not copied.
fn read_route_shared(path: &Path) -> Option<std::sync::Arc<Route>> {
    rejoin_from_files();
    let (at, len) = stamp(path)?;
    if let Some(r) = READ_ROUTES.locked().as_ref().and_then(|m| m.get(path)).filter(|(t, l, _)| *t == at && *l == len).map(|(_, _, r)| r.clone()) {
        return Some(r);
    }
    READ_FROM_FILES.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut route: Route = read_json_opt(path, &unbrowse_files::ROUTE)?;
    // The page's code a route carries for its signing bridge is most of its bytes, and only running the route reads
    // it: it stays in the file (`Graph::set_apart`), and the graph takes it back when it runs or is written.
    route.graph.set_apart(path);
    let route = std::sync::Arc::new(route);
    // Kept as read only if the file wasn't written while it was being read.
    if stamp(path) == Some((at, len)) {
        READ_ROUTES.locked().get_or_insert_with(std::collections::HashMap::new).insert(path.to_path_buf(), (at, len, route.clone()));
    }
    Some(route)
}

/// Tells the learner where a graph read without its page's code takes it back from: the route file it was read from,
/// read whole. Set once, before the first route is read.
fn rejoin_from_files() {
    fn whole(path: &Path) -> Option<unbrowse_learn::Graph> {
        read_json_opt::<Route>(path, &unbrowse_files::ROUTE).map(|r| r.graph)
    }
    unbrowse_learn::graph::set_rejoin(whole);
}

pub fn load_routes() -> Vec<Route> {
    load_routes_shared().iter().map(|r| relabeled(r)).collect()
}

/// Every route, newest first, as the cache holds them: shared, not copied, and not yet `relabeled`. For a pass that
/// reads them all and keeps few (a search ranks every route and answers with the ones that match).
pub fn load_routes_shared() -> Vec<std::sync::Arc<Route>> {
    let Ok(dir) = fs::read_dir(routes_dir()) else { return Vec::new() };
    let mut out: Vec<std::sync::Arc<Route>> = dir.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "json")).filter_map(|e| read_route_shared(&e.path())).collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.learned_at));
    if READ_FROM_FILES.swap(false, std::sync::atomic::Ordering::Relaxed) {
        give_back_memory();
    }
    out
}

/// A route as the cache holds it, as callers are given it (`relabel`).
pub fn relabeled(r: &Route) -> Route {
    relabel(r.clone())
}

/// Gives the system back what the allocator holds free: reading routes whole from their files (at start, or after
/// many were written) takes their page's code in for a moment, and the allocator otherwise keeps that peak.
fn give_back_memory() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only returns free memory at the top of the allocator's heaps to the system.
    unsafe {
        libc::malloc_trim(0);
    }
}

pub fn load_route(id: &str) -> Option<Route> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    read_route(&routes_dir().join(format!("{id}.json"))).map(relabel)
}

/// Whether a call of `r` changes state on the site: its target does. A route made from another contributor's body is
/// someone else's code, and every step of it runs on this node's session, so it writes when any step does: a body
/// can't hide an account-changing request in front of a read target and run it for a goal that only reads. Nor do the
/// ledger's read exceptions apply to it: a POST to a `search` path or a GraphQL body that starts with `query` is read
/// from the request the body itself supplies, so a decoy value would pass an action off as a read. Every step of
/// someone else's body other than GET or HEAD is a write.
pub fn route_writes(r: &Route) -> bool {
    match r.fetched {
        // Held to the foreign rule whether or not its steps carry the mark yet (one kept before the mark existed).
        Some(_) => r.graph.steps.iter().any(|s| unbrowse_learn::ledger::writes_as(s, true)),
        None => r.graph.steps.last().is_some_and(unbrowse_learn::ledger::writes),
    }
}

/// Routes saved before a labelling rule changed carry the old label; read them with the current one.
fn relabel(mut r: Route) -> Route {
    // A route made from someone else's body is that body's word in every step, kept before the mark or after.
    if r.fetched.is_some() {
        for s in &mut r.graph.steps {
            s.foreign = true;
        }
    }
    if !r.graph.steps.is_empty() {
        r.write = route_writes(&r);
    }
    // What an agent saw change the site is a write, whatever the rule reads of its request (R1.25).
    r.write |= r.judged.writes;
    r
}

/// Held while a route record is read and written back, so a change made from one record never undoes another made
/// meanwhile (a call's stats against the owner's delete, list or delist, or a learn).
static ROUTES: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn routes_held() -> std::sync::MutexGuard<'static, ()> {
    ROUTES.locked()
}

fn write_route(route: &Route) -> Result<(), String> {
    rejoin_from_files();
    let path = routes_dir().join(format!("{}.json", route.id));
    // A route read without its page's code is written with it: the file is the only place the code is kept.
    let mut whole = None;
    if route.graph.apart.is_some() {
        let mut r = route.clone();
        if !r.graph.rejoined() {
            return Err(format!("route {}: its page's code could not be read back from its file, so it was not written", route.id));
        }
        whole = Some(r);
    }
    let written = write_json(&path, &unbrowse_files::ROUTE, whole.as_ref().unwrap_or(route));
    let mut route = whole.unwrap_or_else(|| route.clone());
    route.graph.set_apart(&path);
    let route = &route;
    // What was written is what the file now holds: the next read takes it as it is, unless something wrote the file
    // since (its stamp then differs, and it is read again).
    let mut kept = READ_ROUTES.locked();
    let map = kept.get_or_insert_with(std::collections::HashMap::new);
    match (&written, stamp(&path)) {
        (Ok(()), Some((at, len))) => {
            map.insert(path, (at, len, std::sync::Arc::new(route.clone())));
        }
        _ => {
            map.remove(&path);
        }
    }
    written
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn save_route(route: &Route) -> Result<(), String> {
    let _held = routes_held();
    write_route(route)
}

/// Changes route `id` as it is on disk now, not as some earlier copy had it. A route deleted meanwhile stays
/// deleted: `None`.
/// Drops the node's own verdicts on the routes of `site`: something was just done on the site in its browser (a
/// country chosen, a sign-in), and what a route answered before that says nothing of what it answers now. A route
/// the node passed over for answering a "choose your country" page answers the search once a country is chosen.
/// A verdict an agent gave stays: it read an answer and said what it saw. How many routes were given another try.
pub fn forget_node_verdicts(site: &str) -> usize {
    let own = |w: &WrongPage| w.by == "the node";
    let ids: Vec<String> = load_routes().into_iter().filter(|r| unbrowse_learn::identity::site_of(&r.site) == site && r.judged.wrong.iter().any(own)).map(|r| r.id).collect();
    ids.iter().filter(|id| matches!(update_route(id, |r| r.judged.wrong.retain(|w| !own(w))), Ok(Some(_)))).count()
}

pub fn update_route(id: &str, change: impl FnOnce(&mut Route)) -> Result<Option<Route>, String> {
    let _held = routes_held();
    let Some(mut route) = load_route(id) else { return Ok(None) };
    change(&mut route);
    write_route(&route)?;
    Ok(Some(route))
}

/// Keeps a route just learned, and returns the record that now stands under its id, and whether it is the one just
/// learned. A route is named by its call, so learning the same call again can find a record already there. A
/// record with a place on the chain, or the owner's own (learned from browsing in their profile) when this learn
/// isn't, is never replaced by it: the old record stands. Anything else is learned afresh and keeps its history (its
/// stats, and whose it is).
pub fn keep_learned(mut route: Route) -> Result<(Route, bool), String> {
    let _held = routes_held();
    // Learned while the node was off the network, it stays on the node for good (R2.8), whether or not it had joined
    // before the owner turned it off; learned again after, it still does.
    let since = crate::link::on_network_now();
    route.local = Some(route.local.unwrap_or(false) || since.is_none());
    if let Some(old) = load_route(&route.id) {
        if old.listing.is_some() || (old.yours && !route.yours) {
            return Ok((old, false));
        }
        route.local = Some(route.local == Some(true) || old.local_since(since));
        route.stats = old.stats;
        // Learning the call again says nothing of whether the site lets an empty profile see the page.
        route.page_tries = old.page_tries;
        route.provisional &= !route.stats.sighted();
        route.yours |= old.yours;
        route.share = route.share.or(old.share);
        // What agents judged of the call stands through a learn of it: the pages it doesn't do, and an agent's name
        // and fields over the learn's goal and the node's own choice.
        if old.judged.named {
            route.what = old.what;
        } else {
            route.asked = goals_asked(&route.what, old.asked, old.what);
        }
        if old.judged.fields {
            route.fields = old.fields;
        }
        route.judged = old.judged;
        route.write |= route.judged.writes;
    }
    write_route(&route)?;
    Ok((route, true))
}

/// How many other goals one call keeps as its own.
const ASKED_KEPT: usize = 8;

/// The goals a call was learned for other than `what`, its name from now on: those it had, and the name it had.
fn goals_asked(what: &str, mut asked: Vec<String>, had: String) -> Vec<String> {
    asked.push(had);
    let name = unbrowse_learn::goal::words(what);
    let mut seen = Vec::new();
    asked.retain(|a| {
        let words = unbrowse_learn::goal::words(a);
        let fresh = words != name && !seen.contains(&words);
        seen.push(words);
        fresh
    });
    let over = asked.len().saturating_sub(ASKED_KEPT);
    asked.drain(..over);
    asked
}

/// Deletes route `id` because a newer one does what it did, unless, as it is on disk now, it `stands`: a learn never
/// removes those. Whether it was deleted.
pub fn retire_route(id: &str) -> Result<bool, String> {
    let _held = routes_held();
    match load_route(id) {
        Some(r) if !r.stands() => {
            // Kept aside a while: the agent that was answered by it may still judge what it read (`restore_retired`).
            let aside = retired_dir();
            let _ = fs::create_dir_all(&aside);
            let file = format!("{id}.json");
            fs::rename(routes_dir().join(&file), aside.join(&file)).map_err(|e| e.to_string())?;
            trim_retired(&aside);
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// Retires `id` as `retire_route` does, and notes that route `by` took its place: the agent that was answered by `id`
/// holds that id, and its next call is answered by the route that does the goal now (`took_the_place_of`).
pub fn retire_route_for(id: &str, by: &str) -> Result<bool, String> {
    let done = retire_route(id)?;
    if done {
        succeeded(id, by);
    }
    Ok(done)
}

/// Notes that route `by` does now what `id` did, however `id` left the store: a learn that lands on another call
/// can drop the first before anything retires it, and the id was handed out all the same.
pub fn succeeded(id: &str, by: &str) {
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if id != by && plain(id) && plain(by) {
        let aside = retired_dir();
        let _ = fs::create_dir_all(&aside);
        let _ = fs::write(aside.join(format!("{id}.next")), by);
    }
}

/// The route that does now what retired route `id` did: the one that took its place, or the one that took that
/// one's, as far as a route the node still holds. None where `id` was never retired for another or the line ends.
pub fn took_the_place_of(id: &str) -> Option<Route> {
    let mut at = id.to_string();
    for _ in 0..8 {
        if !at.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        let next = fs::read_to_string(retired_dir().join(format!("{at}.next"))).ok()?.trim().to_string();
        if let Some(route) = load_route(&next) {
            return Some(route);
        }
        at = next;
    }
    None
}

/// How many retired routes are kept aside for an agent to judge.
const RETIRED_KEPT: usize = 200;

fn retired_dir() -> PathBuf {
    home().join("routes-retired")
}

/// The oldest go once more than `RETIRED_KEPT` are kept.
fn trim_retired(aside: &Path) {
    let Ok(files) = fs::read_dir(aside) else { return };
    let mut kept: Vec<(std::time::SystemTime, PathBuf)> = files.flatten().filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f.path()))).collect();
    kept.sort();
    let over = kept.len().saturating_sub(RETIRED_KEPT);
    for (_, path) in kept.into_iter().take(over) {
        let _ = fs::remove_file(path);
    }
}

/// Drops route `id`, just learned for a goal it turned out not to answer, unless, as it is on disk now, it `stands`:
/// a learn lands on the record already under its call, so what it found can be far older than the learn. Whether it
/// was dropped.
pub fn drop_learned(id: &str) -> Result<bool, String> {
    let _held = routes_held();
    match load_route(id) {
        Some(r) if !r.stands() => fs::remove_file(routes_dir().join(format!("{id}.json"))).map(|_| true).map_err(|e| e.to_string()),
        _ => Ok(false),
    }
}

/// A route a newer one replaced, as it lies aside, moved nowhere: a verdict is checked against it before it brings the
/// route back (`restore_retired`), so one refused leaves it retired.
pub fn load_retired(id: &str) -> Option<Route> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    read_json_opt(&retired_dir().join(format!("{id}.json")), &unbrowse_files::ROUTE).map(relabel)
}

/// Brings back a route a newer one replaced, for a verdict on what it answered: the agent read that answer, and its
/// word on it is what keeps the next learn from coming back to the same call.
pub fn restore_retired(id: &str) -> Option<Route> {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let _held = routes_held();
    let file = format!("{id}.json");
    fs::rename(retired_dir().join(&file), routes_dir().join(&file)).ok()?;
    load_route(id)
}

pub fn delete_route(id: &str) -> Result<(), String> {
    let _held = routes_held();
    if load_route(id).is_none() {
        return Err(format!("no route {id}"));
    }
    fs::remove_file(routes_dir().join(format!("{id}.json"))).map_err(|e| e.to_string())
}

/// The bytes route `id`'s record takes on disk, or 0 when it has none.
pub fn route_bytes(id: &str) -> u64 {
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return 0;
    }
    fs::metadata(routes_dir().join(format!("{id}.json"))).map(|m| m.len()).unwrap_or(0)
}

/// The most bytes the node's store of route bodies holds, from the `storage_gb` setting in decimal gigabytes, the
/// unit the window shows it in. A setting of 0 or below holds nothing but what is pinned.
pub fn body_bound(storage_gb: f64) -> u64 {
    if storage_gb.is_finite() && storage_gb > 0.0 {
        (storage_gb * 1e9) as u64
    } else {
        0
    }
}

/// One body in the node's store, as it is accounted for: its bytes on disk (the body's file and the route records
/// made from it), when it was last used (seconds), and whether it is pinned, which keeps it whatever the bound.
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub content_id: String,
    pub bytes: u64,
    pub used_at: u64,
    pub pinned: bool,
}

/// The bodies to let go so the store fits within `bound`: unpinned ones only, least recently used first (two used at
/// the same moment in content id order, so the choice is the same every time), until what is left fits. Pinned bodies
/// are never chosen, even when they alone are over the bound: what is pinned is what the node can't do without.
pub fn over_bound(stored: &[Stored], bound: u64) -> Vec<String> {
    let mut total: u64 = stored.iter().map(|s| s.bytes).sum();
    let mut unpinned: Vec<&Stored> = stored.iter().filter(|s| !s.pinned).collect();
    unpinned.sort_by(|a, b| a.used_at.cmp(&b.used_at).then_with(|| a.content_id.cmp(&b.content_id)));
    let mut out = Vec::new();
    for s in unpinned {
        if total <= bound {
            break;
        }
        total = total.saturating_sub(s.bytes);
        out.push(s.content_id.clone());
    }
    out
}

/// One thing the node did. Amounts are what moved (negative out, positive in): USDC for fees, deposits and earnings,
/// UNB for a route coin, a bounty or a witness pledge. The field is still named `unb` for the files and replies that
/// already carry it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Activity {
    pub at: u64,
    /// Who asked: an agent's name, "You", or "Node" for the node's own work.
    pub who: String,
    pub site: String,
    pub what: String,
    /// call, learn, list, deposit, withdraw, coin, bounty, witness, key, claim, approval, vault; "bond", from before
    /// route coins, still names the node's second look at a write it kept (`inflight`)
    pub kind: String,
    /// passed, failed, waiting, declined, done
    pub result: String,
    #[serde(default)]
    pub ms: Option<u64>,
    #[serde(default)]
    pub unb: Option<f64>,
    #[serde(default)]
    pub tx: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

pub fn log_activity(a: &Activity) {
    log_activity_in(&home(), a)
}

/// The same, into the activity log kept in `dir`.
pub fn log_activity_in(dir: &std::path::Path, a: &Activity) {
    let path = dir.join("activity.jsonl");
    let _ = unbrowse_files::private::dir_at(dir);
    let _ = unbrowse_files::private::narrow(dir);
    // Who called what on which site, for the owner alone.
    if let Ok(mut f) = unbrowse_files::private::open(&path, true) {
        if let Ok(line) = unbrowse_files::ACTIVITY.to_vec(a) {
            let _ = writeln!(f, "{}", String::from_utf8_lossy(&line));
        }
    }
}

/// The newest `limit` lines, newest first.
pub fn read_activity(limit: usize) -> Vec<Activity> {
    let Ok(s) = fs::read_to_string(home().join("activity.jsonl")) else { return Vec::new() };
    // A line a newer node appended is left out: this node can't say what it means.
    let line = |l: &str| serde_json::from_value(unbrowse_files::ACTIVITY.decode(l.as_bytes()).ok()?).ok();
    let mut out: Vec<Activity> = s.lines().rev().filter_map(line).take(limit).collect();
    out.truncate(limit);
    out
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub map_while_browsing: bool,
    pub hold_routes: bool,
    /// Read by nothing. It stays in the file because a node older than this one requires it, and an update can go back to
    /// one: without it that node couldn't read the owner's settings.
    pub signed_in_calls: bool,
    pub paused: bool,
    pub api_port: u16,
    /// The disk the node gives the network, in gigabytes: the bound of its store of route bodies (`body_bound`,
    /// `share::trim`), and of how many other contributors' routes it holds (`peers::max_held`).
    pub storage_gb: f64,
    pub excluded: Vec<String>,
    /// Whether a shared route (one this node fetched from the network) may open this node's browser to mint its own
    /// session — its own credential, its own address, in this node's profile. Off, the default: a shared route runs
    /// browserless, and one that needs a browser says so. The owner's login is never spent on one either way.
    #[serde(default)]
    pub shared_mint: bool,
    /// Per site (a registrable site, or `*` for every site), the SOCKS5 upstream the site's browser and its calls
    /// leave through: one public address for the client that earned a credential and the calls that spend it. Empty,
    /// the default: direct. A value with no scheme is `socks5://`.
    #[serde(default)]
    pub proxies: std::collections::BTreeMap<String, String>,
    /// Which routes the node lists on the network by itself (`autolist.rs`). A settings file from before this
    /// setting reads the build's default; one from when it was a switch reads `true` as `used` and `false` as `off`.
    /// (The old `auto_buy` and `auto_buy_level`, which nothing read, are ignored when an old file has them.)
    #[serde(default = "crate::build_config::share_default")]
    pub share_routes: ShareMode,
    /// Whether the owner has been told, once, that the node shares what it learns and how to stop it.
    #[serde(default)]
    pub share_notice_seen: bool,
    /// Whether the owner has looked at which routes the node will share and let them go (`share_approve`). The first
    /// listing after sign-in waits for that, or for a day after the node told them (R2.8).
    #[serde(default)]
    pub share_previewed: bool,
    /// When the node first told the owner which routes it will share, in its activity log and its output, without the
    /// owner having looked (`autolist::PREVIEW_GRACE_SECS` later, listing goes ahead).
    #[serde(default)]
    pub share_preview_told: Option<u64>,
    /// The most listing writes the node makes by itself in a day; `None` is the mode's own (`ShareMode::per_day`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_per_day: Option<u32>,
    /// Whether the node's calls may follow a public name to an address inside this network (an intranet whose
    /// public names resolve privately). Off: a name pointed inside is refused (`unbrowse_learn::egress`).
    #[serde(default)]
    pub private_network: bool,
    /// The version of TERMS.md and PRIVACY.md the owner was shown and acknowledged (`terms::TERMS_VERSION`). The node
    /// joins the network only with the current one here (`terms::standing`).
    #[serde(default)]
    pub terms_accepted: Option<String>,
    /// Whether the owner lets the node advertise itself and join the peer network, once the terms are acknowledged. On
    /// unless they turn it off (in the window, or `unbrowse-node network off`); a settings file from before this setting
    /// reads as on.
    #[serde(default = "on")]
    pub peer_network: bool,
    /// Light mode (R7.18, R7.23): on the peer network the node only asks. It answers no lookups, and it seeds no body
    /// it fetched; the bodies of the routes it lists itself it still serves, as their contributor. Off unless the
    /// owner turns it on (`unbrowse-node network light`).
    #[serde(default)]
    pub light: bool,
    /// Whether the node announces and serves the routes it fetched from other contributors and keeps (spec §103,
    /// R7.18): a provider record for each kept route's site and body, and their listings answered to seekers. Off, the
    /// default, and off for a node upgraded from one that served them without asking: using a route says nothing to the
    /// network, and only the routes the owner chose to list are announced. On only by the owner's choice.
    #[serde(default)]
    pub serve_kept: bool,
    /// Whether the node fetches newer releases and restarts into them (`update.rs`).
    #[serde(default = "on")]
    pub auto_update: bool,
    /// Whether the node fetches its browser itself the first time something needs one (`browsers::ensure`): the
    /// browser program from its release and, when there is no Chromium here, Chrome for Testing. On unless the owner
    /// turns it off (`unbrowse browser fetch off`); off, a goal that needs the browser answers `browser_missing` until
    /// the owner runs `unbrowse browser install`.
    #[serde(default = "on")]
    pub fetch_browser: bool,
    /// Whether the node's browser stays headless whatever a site does. Off, the default: a walk a site refused opens a
    /// window (a window passes doors a headless browser can't), and an ask for the owner opens theirs. On (`unbrowse
    /// browser headless on`, for a server or a test bank): nothing opens one, and a walk that would need a window ends
    /// as `how: browse` or says why it can't. `UNBROWSE_HEADLESS` overrides it either way (`browsers::headless_only`).
    #[serde(default)]
    pub headless_only: bool,
    /// The release channel the node updates on (`stable` or `canary`), or none to be placed by a hash of its identity
    /// (`update::choose`). `unbrowse-node update channel` sets it.
    #[serde(default)]
    pub update_channel: Option<String>,
    /// Whether the vault keeps website passkeys and signs in with them (`passkey.rs`): a site the node signs in to
    /// may get one. On unless the owner turns it off; `UNBROWSE_PASSKEYS` overrides it either way.
    #[serde(default = "on")]
    pub passkeys: bool,
    /// Sites the node never enrols a passkey on, nor signs in to with one (`passkey never <site>`).
    #[serde(default)]
    pub passkeys_never: Vec<String>,
    /// The chain the node runs on: `devnet`, its own Anvil, or a live Arc network by name (`chain::names`). Read when
    /// the node starts; `UNBROWSE_CHAIN` overrides it (`unbrowse-node chain`).
    #[serde(default = "devnet")]
    pub chain: String,
    /// The most the node pays, in USDC, to fetch one route another contributor lists: an entry whose fee is above it
    /// is passed over as if it weren't offered, so the node never pays more (R3.3). Agents spend up to it on their
    /// own, with nothing to approve. 0: the node pays for no fetch and uses only free entries and its own routes. A
    /// settings file from before this setting reads the default.
    #[serde(default = "max_fetch")]
    pub max_fetch_usdc: f64,
    /// On a live chain, what the node keeps its agents' fetches paid from: while the deposit is below this, Settlement's USDC the wallet holds (sent by an owner who has some) is moved in, up to it
    /// (`chain::top_up`). 0: the node never deposits by itself.
    #[serde(default = "deposit_floor")]
    pub deposit_floor_usdc: f64,
    /// The listing's first buy (`decide.dev-buy-default-on`): once an entry of the wallet's is credited, the node launches
    /// its route coin with a first buy of this share of the wallet's UNB at that moment, in basis points, and stakes the
    /// coins it gets for the owner (`chain::coins::launch_listed`). `COIN_DEV_BUY_BPS`, 1%, by default; 0 turns it off.
    /// Raising it past the default asks the owner (`Loosens::UpPast`), through `coin_dev_buy` or the settings.
    #[serde(default = "coin_dev_buy_bps")]
    pub coin_dev_buy_bps: u32,
    /// Whether the claim pass also completes other wallets' parked coin buys (`CoinFetch.completeBuy`), paying their
    /// gas. Off by default: the node completes only its owner's own payers' (`chain::coins::complete_own_buys`).
    #[serde(default)]
    pub coin_complete_others: bool,
    /// Where the deposit's USDC is also the chain's gas (`chain::gas_is_usdc`), the USDC a top-up always leaves in the
    /// wallet so the node can still pay its writes.
    #[serde(default = "gas_reserve")]
    pub gas_reserve_usdc: f64,
    /// The most the node pays a unit of gas, in gwei, on any write it signs (`rpc::price`): a chain whose base fee is
    /// above it gets no write from this node until it falls, and no fee an RPC suggests is ever paid past it.
    #[serde(default = "max_gas_price")]
    pub max_gas_price_gwei: f64,
    /// The most the node's own key spends on network fees in a day, in USDC, on a live network (`rpc::budget`): a write
    /// that could take it past this waits for the next day. 0 sends no write at all.
    #[serde(default = "gas_budget")]
    pub gas_budget_usdc_per_day: f64,
    /// A second RPC of the same chain the node checks the first against (`rpc::second`), named by the owner: every
    /// receipt it acts on, the blocks they are in, the chain's ID, and the balances its writes are judged by are read
    /// there too, and a different answer stops every write (`rpc::halt`); while it is behind or not answering, writes
    /// wait. It must be run by another operator than the first: the node refuses one under the first's registrable
    /// domain or resolving to any of its addresses (`rpc::independent`), but code can't prove two operators independent,
    /// and that they are is the owner's judgement. None by default: with one RPC on a chain reached over the network the
    /// node holds back every write that must not go twice and gives back no gas it set aside (`rpc::HELD_BACK`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_rpc: Option<String>,
    /// The most of what a batch of receipt lines pays that its gas may cost before the node claims it by itself
    /// (`chain::claim_due`): 0.1 sends a claim once its gas is a tenth of what it pays. Lines too small to be worth
    /// it still go once their epoch is over, a whole epoch before their window closes, so none is lost by waiting; the
    /// owner's claim sends them whatever they pay.
    #[serde(default = "claim_gas_share")]
    pub claim_gas_share: f64,
    /// Whether the node takes the bounty steps for the owner (`autobounty`, spec ch. 8): it asks the owner's agent, in the
    /// reply of its passed call on an entry of an open bounty's site, whether the entry answers the bounty, and on the
    /// agent's yes and then the owner's own it confirms the bounty once that call's line is claimed; it also releases by
    /// use the shares of entries the owner lists. Off until the owner turns it on (`unbrowse-node bounty auto on`). On or
    /// off, the owner's bounties past their deadline are settled and what is the owner's is taken back, and the `bounty`
    /// commands work.
    #[serde(default)]
    pub bounty_auto: bool,
    /// Whether the vault keeps a card's security code beside the card, so a call that pays with it needs no one at the
    /// page (#185). Off unless the owner turns it on (`unbrowse-node vault card codes on`, or Settings): card rules (PCI
    /// DSS) forbid keeping a code after authorisation, so off, `vault card add` asks for none and a checkout asks the
    /// owner to type it. Turning it off forgets every kept code at once (`vault::set_keep_codes`).
    #[serde(default)]
    pub keep_card_codes: bool,
    /// Whether the node takes an agent's or the owner's token sent as a plain bearer token, from a client that doesn't
    /// sign its requests (`api/signed.rs`). A bearer token goes to whatever answers at the node's address, so a process
    /// that took the port, or relays it, keeps the token. Off for every node, new or upgraded (settings version 4 turns
    /// off what a version-3 build turned on unasked), until the owner turns it on, asked first (`unbrowse agent bearer
    /// on`). An agent still set up to send one is told how to sign instead (`BEARER_OFF`).
    #[serde(default)]
    pub accept_bearer: bool,
}

fn claim_gas_share() -> f64 {
    crate::chain::CLAIM_GAS_SHARE
}

/// A claim gas share the owner may set: a share of what a claim pays, zero or more. Zero claims only once lines fill
/// a batch or their epoch is over.
pub fn check_claim_gas_share(share: f64) -> Result<f64, String> {
    if share.is_finite() && share >= 0.0 {
        Ok(share)
    } else {
        Err("the share of a claim its gas may cost is a number, zero or more".into())
    }
}

impl Settings {
    /// The claim gas share the node holds to. One it can't read (a file edited by hand) is the default.
    pub fn claim_gas_share(&self) -> f64 {
        check_claim_gas_share(self.claim_gas_share).unwrap_or(crate::chain::CLAIM_GAS_SHARE)
    }
}

/// Which change to a setting lets the node spend more, sooner, or somewhere else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Loosens {
    /// A larger number: a cap, a budget, a floor the node fills, a share of a claim gas may take, a count a day.
    Up,
    /// A larger number past the default the owner decided on: up to the default (turning it back on, say) isn't asked.
    UpPast(u64),
    /// A smaller number: what the node keeps back.
    Down,
    /// Turning it on.
    On,
    /// Any change at all: which chain the node pays on.
    Any,
}

/// Every setting that bounds what the node spends, or where, by itself, with what loosens it and what the owner is told
/// it does. A change that loosens any of these is the owner's to make, asked in their own dialog (`commands`); one that
/// tightens it isn't asked. A setting added later that bounds spending goes here, and
/// `every_money_setting_says_which_way_loosens_it` holds the list to the settings' own money fields.
pub const SPENDING: &[(&str, Loosens, &str)] = &[
    ("max_fetch_usdc", Loosens::Up, "raise the most one paid call costs"),
    ("coin_dev_buy_bps", Loosens::UpPast(COIN_DEV_BUY_BPS as u64), "launch the coin of each entry it lists with a larger first buy of your UNB (in hundredths of a percent of what the wallet holds), by itself"),
    ("coin_complete_others", Loosens::On, "pay the network fee to complete other wallets' parked coin buys"),
    ("deposit_floor_usdc", Loosens::Up, "raise how much of your wallet's USDC it moves into the deposit agents spend from"),
    ("claim_gas_share", Loosens::Up, "let a claim's network fee take more of what it pays"),
    ("max_gas_price_gwei", Loosens::Up, "raise the most it pays a unit of gas"),
    ("gas_budget_usdc_per_day", Loosens::Up, "raise what it spends on network fees a day"),
    ("list_per_day", Loosens::Up, "list more routes a day, each paying gas"),
    ("gas_reserve_usdc", Loosens::Down, "keep less USDC back for its own network fees"),
    ("bounty_auto", Loosens::On, "take bounty steps for you"),
    ("private_network", Loosens::On, "let routes reach addresses on this computer's own network"),
    ("chain", Loosens::Any, "move it to another chain, where it pays with that chain's money"),
    ("check_rpc", Loosens::Any, "change the second RPC it checks every receipt and balance against (it must be another operator's: endpoints of one provider, under one domain or on one address, are refused, and whether two are truly independent is your judgement)"),
];

/// What a settings change from `now` to `to` (both as the settings file holds them; `to` may name only some fields)
/// loosens, said for the owner: each `SPENDING` setting it moves the loosening way. A value that isn't of the field's
/// kind counts as loosening: the settings' own checks refuse it, after the owner's answer.
pub fn loosened(now: &serde_json::Value, to: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    for (k, way, what) in SPENDING {
        let Some(new) = to.get(*k) else { continue };
        let old = now.get(*k).unwrap_or(&serde_json::Value::Null);
        // A count with no number set (`list_per_day`: the mode's own) reads as none, so any number set is a change.
        let num = |v: &serde_json::Value| v.as_f64();
        let looser = match way {
            Loosens::Up => match (num(old), num(new)) {
                (_, None) => !new.is_null() || !old.is_null(),
                (Some(o), Some(n)) => !n.is_finite() || n > o,
                (None, Some(_)) => true,
            },
            Loosens::UpPast(d) => match (num(old), num(new)) {
                (_, None) => !new.is_null() || !old.is_null(),
                (o, Some(n)) => !n.is_finite() || n > o.unwrap_or(0.0).max(*d as f64),
            },
            Loosens::Down => match (num(old), num(new)) {
                (Some(o), Some(n)) => !n.is_finite() || n < o,
                _ => new != old,
            },
            Loosens::On => old.as_bool() != Some(true) && !new.is_null() && new.as_bool() != Some(false),
            Loosens::Any => new != old,
        };
        if looser {
            out.push(match way {
                Loosens::Up | Loosens::UpPast(_) | Loosens::Down => format!("{what} from {old} to {new}"),
                Loosens::On => what.to_string(),
                Loosens::Any => format!("{what}: from {old} to {new}"),
            });
        }
    }
    out
}

/// The gas a top-up leaves in the wallet until the owner says otherwise. A top-up never leaves less than a full claim
/// batch takes at the gas price then (`chain::claim_reserve`, about 0.31 USDC at 25 gwei), whatever this says.
pub const GAS_RESERVE_USDC: f64 = 0.25;

fn gas_reserve() -> f64 {
    GAS_RESERVE_USDC
}

/// The most a unit of gas costs the node until its owner says otherwise, in gwei: 25 times Arc's 20 gwei base-fee floor
/// (`arc::BASE_FEE_FLOOR`), far above what the chain charges when it isn't under attack, and far below what drains a
/// wallet.
pub const MAX_GAS_PRICE_GWEI: f64 = 500.0;

fn max_gas_price() -> f64 {
    MAX_GAS_PRICE_GWEI
}

/// What the node's key spends on network fees in a day at most until its owner says otherwise, in USDC.
pub const GAS_BUDGET_USDC_PER_DAY: f64 = 5.0;

fn gas_budget() -> f64 {
    GAS_BUDGET_USDC_PER_DAY
}

impl Settings {
    /// The gas price cap the node holds to, in wei. One that isn't a number above zero (a file edited by hand) is the
    /// default: a cap the node can't read is never one it pays past.
    pub fn max_gas_price_wei(&self) -> u128 {
        let g = if self.max_gas_price_gwei.is_finite() && self.max_gas_price_gwei > 0.0 { self.max_gas_price_gwei } else { MAX_GAS_PRICE_GWEI };
        (g * 1e9) as u128
    }

    /// The daily gas budget the node holds to, in USDC; one it can't read is nothing, and nothing is sent.
    pub fn gas_budget(&self) -> f64 {
        if self.gas_budget_usdc_per_day.is_finite() && self.gas_budget_usdc_per_day >= 0.0 { self.gas_budget_usdc_per_day } else { 0.0 }
    }
}

/// What a node keeps its deposit topped up to from its wallet until its owner says otherwise.
pub const DEPOSIT_FLOOR_USDC: f64 = 0.5;

fn deposit_floor() -> f64 {
    DEPOSIT_FLOOR_USDC
}

/// The listing's first buy by default, in basis points of the wallet's UNB: 1% (`decide.dev-buy-default-on`, the size
/// the owner named on 5 and 7 November 2026).
pub const COIN_DEV_BUY_BPS: u32 = 100;

fn coin_dev_buy_bps() -> u32 {
    COIN_DEV_BUY_BPS
}

fn on() -> bool {
    true
}

/// What a node pays at most for one fetch until its owner says otherwise.
pub const MAX_FETCH_USDC: f64 = 0.05;

fn max_fetch() -> f64 {
    MAX_FETCH_USDC
}

/// A per-fetch maximum the owner may set: a sum of USDC, zero or more.
pub fn check_max_fetch(usdc: f64) -> Result<f64, String> {
    if usdc.is_finite() && usdc >= 0.0 {
        Ok(usdc)
    } else {
        Err("the most the node pays to fetch one route is a sum of USDC, zero or more".into())
    }
}

impl Settings {
    /// The per-fetch maximum the node holds to. One that isn't a sum of money (a file edited by hand) pays nothing:
    /// a maximum the node can't read is never one it pays past.
    pub fn max_fetch(&self) -> f64 {
        check_max_fetch(self.max_fetch_usdc).unwrap_or(0.0)
    }
}

/// Which routes the node lists by itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    /// The routes this node's agents keep using (`autolist::earned`): listing costs no gas, but what is shared is
    /// paced, so it goes to routes that have shown they are worth listing.
    Used,
    /// Every route the node learns, once it has run successfully once.
    All,
    /// None. What is listed stays listed until the owner delists it.
    Off,
}

impl ShareMode {
    /// The listing writes a day the node makes by itself when the owner sets no number: few when it lists what is
    /// used, more when the owner opted in to listing everything.
    pub fn per_day(self) -> u32 {
        match self {
            ShareMode::Used => 5,
            ShareMode::All => 20,
            ShareMode::Off => 0,
        }
    }
}

impl<'de> Deserialize<'de> for ShareMode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Said {
            Switch(bool),
            Mode(String),
        }
        match Said::deserialize(d)? {
            Said::Switch(true) => Ok(ShareMode::Used),
            Said::Switch(false) => Ok(ShareMode::Off),
            Said::Mode(m) => crate::build_config::share_mode(Some(m.trim())).ok_or_else(|| serde::de::Error::custom(format!("share_routes is used, all or off, not {m}"))),
        }
    }
}

impl Settings {
    /// The listing writes a day the node makes by itself.
    pub fn list_per_day(&self) -> u32 {
        if self.share_routes == ShareMode::Off {
            return 0;
        }
        self.list_per_day.unwrap_or(self.share_routes.per_day())
    }
}

fn devnet() -> String {
    crate::chain::DEVNET.into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            map_while_browsing: true,
            hold_routes: false,
            signed_in_calls: true,
            paused: false,
            api_port: DEFAULT_API_PORT,
            storage_gb: 4.0,
            excluded: Vec::new(),
            shared_mint: false,
            proxies: Default::default(),
            share_routes: crate::build_config::share_default(),
            share_notice_seen: false,
            share_previewed: false,
            share_preview_told: None,
            list_per_day: None,
            private_network: false,
            terms_accepted: None,
            peer_network: true,
            light: false,
            serve_kept: false,
            auto_update: true,
            fetch_browser: true,
            headless_only: false,
            update_channel: None,
            passkeys: true,
            passkeys_never: Vec::new(),
            chain: crate::build_config::default_chain().into(),
            max_fetch_usdc: MAX_FETCH_USDC,
            deposit_floor_usdc: DEPOSIT_FLOOR_USDC,
            coin_dev_buy_bps: COIN_DEV_BUY_BPS,
            coin_complete_others: false,
            gas_reserve_usdc: GAS_RESERVE_USDC,
            max_gas_price_gwei: MAX_GAS_PRICE_GWEI,
            gas_budget_usdc_per_day: GAS_BUDGET_USDC_PER_DAY,
            check_rpc: None,
            claim_gas_share: crate::chain::CLAIM_GAS_SHARE,
            bounty_auto: false,
            keep_card_codes: false,
            accept_bearer: false,
        }
    }
}

/// The node's price: one detail fee for every route it lists, set on the chain, and whether the node moves it once an
/// epoch with its own demand and what other contributors charge for the same sites, between the owner's floor and
/// ceiling. It moves by default: the protocol sets no price (R3.30), so contributors compete it down.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Pricing {
    pub auto: bool,
    pub floor: f64,
    pub ceiling: f64,
    /// The epoch the fee was last looked at, the block that look ended on, and the paid fetches it counted.
    pub epoch: u64,
    pub block: u64,
    pub lines: u64,
}

impl Default for Pricing {
    fn default() -> Self {
        Self { auto: true, floor: 0.0001, ceiling: 1.0, epoch: 0, block: 0, lines: 0 }
    }
}

impl Pricing {
    /// The next epoch's fee: up a tenth when more paid fetches came than the epoch before, the same when demand
    /// held. When fewer or none came it falls: halfway to `market`, the median other contributors charge for the same
    /// sites, when that is lower, else a tenth. Always within the floor and ceiling.
    pub fn next_fee(&self, fee: f64, lines: u64, market: Option<f64>) -> f64 {
        let moved = if lines > self.lines {
            fee * 1.1
        } else if lines < self.lines || lines == 0 {
            match market {
                Some(m) if m < fee * 0.9 => (fee + m) / 2.0,
                _ => fee * 0.9,
            }
        } else {
            fee
        };
        let rounded = (moved * 1e6).round() / 1e6;
        rounded.clamp(self.floor, self.ceiling.max(self.floor))
    }

    /// Whether an auto-priced node looks at its fee in `epoch`: once an epoch. Any other epoch than the last look's, not
    /// a later one: a new deployment may count from a lower number (`chain::claimable`), and a look must not wait for it.
    pub fn due(&self, epoch: u64) -> bool {
        self.auto && epoch != self.epoch
    }

    /// This epoch's look: records it (the epoch, the block it ended on and the paid fetches it counted) and gives the
    /// fee to set, if it moves. The record is saved before the fee is sent, so the look happens once an epoch however
    /// the send ends: a send that landed but answered an error is never followed by a second step from the fee it set.
    pub fn look(&mut self, epoch: u64, block: u64, lines: u64, fee: f64, market: Option<f64>, listed: bool) -> Option<f64> {
        let next = self.next_fee(fee, lines, market);
        self.epoch = epoch;
        self.block = block;
        self.lines = lines;
        (listed && fee > 0.0 && (next - fee).abs() > 1e-9).then_some(next)
    }
}

/// Whether moving the fee on the chain from `fee` to `next` changes what a use of any listing costs. A use pays the fee
/// or the listing's own price, whichever is more (`listing::price`, R6.29), so a fee moving wholly under every listed
/// price changes nothing, and the write would be gas spent each epoch for that. `listed` holds each live listing's
/// price, 0 for one that lists none.
pub fn moves_a_price(fee: f64, next: f64, listed: &[f64]) -> bool {
    listed.iter().any(|p| (p.max(fee) - p.max(next)).abs() > 1e-9)
}

pub fn load_pricing() -> Pricing {
    read_json(&home().join("pricing.json"), &unbrowse_files::PRICING)
}

pub fn save_pricing(p: &Pricing) -> Result<(), String> {
    write_json(&home().join("pricing.json"), &unbrowse_files::PRICING, p)
}

/// A route this node holds for another contributor (§6 serving role, R4.3): the node stores its listing and serves
/// it, so a seeker that routes through this node names it as the server and it earns the serving share. The listing
/// is light metadata; the `storage_gb` setting bounds how many are kept.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct HeldRoute {
    pub entry_id: String,
    pub site: String,
    pub contributor: String,
    pub description: String,
    pub fee: f64,
    pub held_at: u64,
}

/// The hosts the node's browser has walked (one profile folder each). A holder serves routes for the sites it engages,
/// and these are part of what it engages.
pub fn walked_hosts() -> Vec<String> {
    let Ok(dir) = std::fs::read_dir(profiles_dir()) else { return Vec::new() };
    dir.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|h| h.contains('.')).collect()
}

/// The lock a node holds on its home for as long as it runs, from before it reads its key (`node.lock`). A second node
/// started on the same home (the window starting one while the first is still coming up, waiting on the owner at the
/// keystore's dialog) finds it held and stops at once: it would ask the owner the same questions again and fight the
/// first for the port and the browsers. The file names the holder's pid, for what the second one says.
pub struct NodeHeld(#[allow(dead_code)] fs::File);

/// Whether this process takes the node's lock on its home: `Ok(None)` when a node holds it, with that node's pid when it
/// named one. `wait` is how long to wait for it, for a node an update or a restart starts while the one it replaces is
/// still stopping.
pub fn hold_node(wait: std::time::Duration) -> Result<Result<NodeHeld, Option<u32>>, String> {
    hold_node_in(&home(), wait)
}

fn hold_node_in(dir: &Path, wait: std::time::Duration) -> Result<Result<NodeHeld, Option<u32>>, String> {
    use std::io::{Read, Seek, Write};
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join("node.lock")).map_err(|e| e.to_string())?;
    let until = std::time::Instant::now() + wait;
    loop {
        match f.try_lock() {
            Ok(()) => break,
            Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(200)),
            Err(fs::TryLockError::WouldBlock) => {
                let mut said = String::new();
                let _ = f.read_to_string(&mut said);
                return Ok(Err(said.trim().parse().ok()));
            }
            Err(fs::TryLockError::Error(e)) => return Err(e.to_string()),
        }
    }
    let _ = f.set_len(0);
    let _ = f.rewind();
    let _ = write!(f, "{}", std::process::id());
    let _ = f.flush();
    Ok(Ok(NodeHeld(f)))
}

/// Held while a file more than one process writes is read and written back: the window's node and a command in a shell
/// each keep the whole file, so without it the later write takes back what the earlier one added. As `agents::Held`.
/// It is taken on a file of its own beside `path`, since writing `path` replaces it.
pub struct FileHeld(fs::File);

pub fn hold_file(path: &Path) -> Result<FileHeld, String> {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(path.with_extension("lock")).map_err(|e| e.to_string())?;
    f.lock().map_err(|e| e.to_string())?;
    Ok(FileHeld(f))
}

impl Drop for FileHeld {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

pub fn load_held() -> Vec<HeldRoute> {
    read_json(&home().join("held.json"), &unbrowse_files::HELD)
}

pub fn save_held(held: &[HeldRoute]) -> Result<(), String> {
    write_json(&home().join("held.json"), &unbrowse_files::HELD, held)
}

pub fn settings_path() -> PathBuf {
    home().join("settings.json")
}

pub fn load_settings() -> Settings {
    read_json(&settings_path(), &unbrowse_files::SETTINGS)
}

/// Whether the settings file reads: a node never runs on the defaults in place of a file a newer node wrote, since
/// those could turn back on what the owner turned off there.
pub fn settings_readable() -> Result<(), String> {
    match unbrowse_files::SETTINGS.read_at::<serde_json::Value>(&settings_path()) {
        Err(r) if r.is_newer() => Err(r.message(&settings_path())),
        _ => Ok(()),
    }
}

/// The port a node's API listens on until its owner names another (`api_port`).
pub const DEFAULT_API_PORT: u16 = 7788;

/// The port the node's API listens on: `UNBROWSE_PORT` when it names one (a second node on one machine, a node an SDK
/// starts beside the owner's), else the owner's `api_port`.
pub fn api_port() -> u16 {
    std::env::var("UNBROWSE_PORT").ok().and_then(|p| p.trim().parse::<u16>().ok()).filter(|p| *p > 0).unwrap_or_else(|| load_settings().api_port)
}

/// The owner's yes a shell's command waits on before it writes settings (`ask_before_shell_writes`).
pub type SettingsYes = fn(&Settings) -> Result<(), String>;

static SHELL_YES: std::sync::OnceLock<SettingsYes> = std::sync::OnceLock::new();

#[cfg(test)]
thread_local! {
    static SHELL_YES_IN_TEST: std::cell::Cell<Option<SettingsYes>> = const { std::cell::Cell::new(None) };
}

/// Set once in a process that runs one of the owner's shell commands, never in the node: every settings write that
/// process makes goes through `yes` first, whichever command makes it. The rule is at the write, not in a list of
/// commands, so a command added later that loosens a setting asks too.
pub fn ask_before_shell_writes(yes: SettingsYes) {
    let _ = SHELL_YES.set(yes);
}

/// The same for this thread of a test.
#[cfg(test)]
pub fn ask_before_shell_writes_in_test(yes: Option<SettingsYes>) {
    SHELL_YES_IN_TEST.with(|y| y.set(yes));
}

fn shell_yes() -> Option<SettingsYes> {
    #[cfg(test)]
    if let Some(yes) = SHELL_YES_IN_TEST.with(std::cell::Cell::get) {
        return Some(yes);
    }
    SHELL_YES.get().copied()
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    if let Some(yes) = shell_yes() {
        yes(s)?;
    }
    let written = write_json(&settings_path(), &unbrowse_files::SETTINGS, s);
    apply_proxies();
    written
}

/// Puts the owner's per-site egress pins where the browser and the browserless calls both read them
/// (`unbrowse_learn::proxy`). `UNBROWSE_PROXY` is the default for every site when no `*` entry says otherwise.
pub fn apply_proxies() {
    let mut pins = load_settings().proxies;
    if let Ok(url) = std::env::var("UNBROWSE_PROXY") {
        let url = url.trim();
        if !url.is_empty() {
            pins.entry("*".to_string()).or_insert_with(|| url.to_string());
        }
    }
    let pins = pins
        .into_iter()
        .map(|(site, url)| {
            let url = url.trim().to_string();
            let url = if url.contains("://") { url } else { format!("socks5://{url}") };
            (site, url)
        })
        .collect();
    unbrowse_learn::proxy::pin_all(pins);
}

/// Held while `settings.json` is read and written back, across processes (the running node and a command in a shell):
/// one reads, changes a field and writes the whole file, so a write that started before the owner's `share off` and
/// ended after it would put the old value back. Take it before `load_settings`. One process's two writers each open the
/// file, so the lock holds between them too.
pub struct SettingsHeld(fs::File);

/// Takes the lock on the settings, waiting for whoever holds it. A holder only reads and writes one small file, so a wait
/// this long means a holder went on to something else (a command calling the running node, which wants the lock too): the
/// caller then goes ahead unlocked, as every write did before, rather than hang.
pub fn settings_held() -> Result<SettingsHeld, String> {
    let _ = fs::create_dir_all(home());
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(home().join("settings.lock")).map_err(|e| e.to_string())?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match f.try_lock() {
            Ok(()) => return Ok(SettingsHeld(f)),
            Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(5)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

impl Drop for SettingsHeld {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// How long a money file's lock is waited for. A holder reads and writes one small file, so a wait this long is a
/// holder that stopped or hung, and the change is refused rather than made unlocked.
pub const MONEY_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Takes the lock beside `file` (as `hold_file` names it), waiting at most `wait`, across processes: whoever reads a file
/// of money state, changes it and writes it back holds it throughout, so two node processes, or a node and a command
/// in a shell, never both read the same state and each write back their own. Fails closed: a lock that can't be taken
/// in that time, or opened at all, is an error, and the caller changes nothing. The node's own threads take their
/// in-process lock first.
pub fn hold_money_file(file: &Path, wait: std::time::Duration) -> Result<FileHeld, String> {
    let at = file.with_extension("lock");
    if let Some(dir) = at.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let f = fs::OpenOptions::new().create(true).truncate(false).write(true).open(&at).map_err(|e| format!("{}: {e}", at.display()))?;
    let until = std::time::Instant::now() + wait;
    loop {
        match f.try_lock() {
            Ok(()) => return Ok(FileHeld(f)),
            Err(fs::TryLockError::WouldBlock) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(5)),
            Err(fs::TryLockError::WouldBlock) => return Err(format!("{} is held by another process, so it wasn't changed", file.display())),
            Err(e) => return Err(format!("{}: {e}", at.display())),
        }
    }
}

/// The folders this process holds for its life (`hold_for_process`), with their locks.
static PROCESS_HOLDS: std::sync::Mutex<Vec<(PathBuf, FileHeld)>> = std::sync::Mutex::new(Vec::new());

/// Holds `folder` for this process's whole life, so no second process signs from the same state: the node takes its
/// chain's folder as its chain starts, and a command in a shell that would sign takes it too. Holding it again in the
/// same process is a no-op; another process holding it is an error.
pub fn hold_for_process(folder: &Path) -> Result<(), String> {
    let mut held = PROCESS_HOLDS.lock().map_err(|e| e.to_string())?;
    if held.iter().any(|(f, _)| f == folder) {
        return Ok(());
    }
    let lock = hold_money_file(&folder.join("node"), std::time::Duration::ZERO)
        .map_err(|_| format!("another Unbrowse process is running on {}: stop it, or ask the running node, which signs for this folder", folder.display()))?;
    held.push((folder.to_path_buf(), lock));
    Ok(())
}

#[cfg(test)]
mod file_lock_tests {
    use super::*;

    /// One process signs from a chain's folder: while this one holds it, a second process asking for it is refused at
    /// once with a reason, and this process asking again is let through.
    #[test]
    fn a_second_process_on_a_chain_folder_is_refused() {
        if let Ok(folder) = std::env::var("UNBROWSE_TEST_HOLD_FOLDER") {
            let r = hold_for_process(Path::new(&folder));
            std::process::exit(match r {
                Err(e) if e.contains("another Unbrowse process is running") => 0,
                _ => 3,
            });
        }
        let _home = scratch_home("process-hold");
        let folder = home().join("arc-testnet");
        fs::create_dir_all(&folder).unwrap();
        hold_for_process(&folder).unwrap();
        hold_for_process(&folder).expect("this process again");
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "store::file_lock_tests::a_second_process_on_a_chain_folder_is_refused", "--test-threads=1"])
            .env("UNBROWSE_TEST_HOLD_FOLDER", &folder)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert_eq!(child.code(), Some(0), "the second process was refused, and said why");
    }

    /// A money file's lock is held across processes: a second open of it (as another process makes) waits, and gives
    /// up within its bound with an error rather than going on unlocked; once the first lets go, it is taken.
    #[test]
    fn a_money_files_lock_is_held_across_openers_and_fails_closed() {
        let _home = scratch_home("file-lock");
        let file = home().join("gas-spent.json");
        let first = hold_money_file(&file, MONEY_LOCK_WAIT).unwrap();
        let t = std::time::Instant::now();
        let second = hold_money_file(&file, std::time::Duration::from_millis(100));
        assert!(second.is_err_and(|e| e.contains("held by another process")), "a second holder is refused");
        assert!(t.elapsed() >= std::time::Duration::from_millis(100), "after its bound, not at once");
        drop(first);
        assert!(hold_money_file(&file, std::time::Duration::from_millis(100)).is_ok(), "free once let go");
    }
}

#[cfg(test)]
mod max_fetch_tests {
    use super::*;

    /// Two writers of the file, each changing its own field: neither undoes the other. Without the lock most of these go
    /// missing, the way a pass of the running node put back what `share off` had just turned off.
    #[test]
    fn two_writers_of_the_settings_never_undo_each_other() {
        let home = scratch_home("settings-writers");
        save_settings(&Settings { list_per_day: Some(0), max_fetch_usdc: 0.0, ..Settings::default() }).unwrap();
        let writers: Vec<_> = [0, 1]
            .into_iter()
            .map(|which| {
                let home = home.clone();
                std::thread::spawn(move || {
                    use_home(&home);
                    for _ in 0..40 {
                        let _held = settings_held().unwrap();
                        let mut s = load_settings();
                        std::thread::yield_now();
                        match which {
                            0 => s.list_per_day = s.list_per_day.map(|n| n + 1),
                            _ => s.max_fetch_usdc += 1.0,
                        }
                        save_settings(&s).unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        let s = load_settings();
        assert_eq!((s.list_per_day, s.max_fetch_usdc), (Some(40), 40.0));
    }

    /// A settings file written before the per-fetch maximum reads it as the default, and keeps everything else it says.
    #[test]
    fn a_settings_file_from_before_reads_the_default_maximum() {
        let home = scratch_home("settings-old");
        let mut old = serde_json::to_value(Settings { paused: true, ..Settings::default() }).unwrap();
        old.as_object_mut().unwrap().remove("max_fetch_usdc");
        fs::write(home.join("settings.json"), old.to_string()).unwrap();
        let s = load_settings();
        assert!(s.paused, "the rest of the file is read");
        assert_eq!((s.max_fetch_usdc, s.max_fetch()), (MAX_FETCH_USDC, 0.05));
    }

    /// A settings file from when a node could decline fetches paid from trial credit still reads, its
    /// `serve_credit_fetches` left unread and everything else kept.
    #[test]
    fn a_settings_file_that_names_serving_credit_fetches_still_reads() {
        let home = scratch_home("settings-credit");
        let mut old = serde_json::to_value(Settings { paused: true, max_fetch_usdc: 0.02, ..Settings::default() }).unwrap();
        old.as_object_mut().unwrap().insert("serve_credit_fetches".into(), serde_json::json!(false));
        fs::write(home.join("settings.json"), old.to_string()).unwrap();
        let s = load_settings();
        assert!(s.paused, "the rest of the file is read");
        assert_eq!(s.max_fetch_usdc, 0.02);
        assert!(serde_json::to_value(&s).unwrap().get("serve_credit_fetches").is_none(), "and the setting is gone when it is saved");
    }

    /// The maximum is a sum of USDC, zero or more; one that isn't (edited by hand) pays for nothing.
    #[test]
    fn a_maximum_that_isnt_money_pays_nothing() {
        assert_eq!(check_max_fetch(0.0), Ok(0.0));
        assert_eq!(check_max_fetch(1.25), Ok(1.25));
        for bad in [-0.01, f64::NAN, f64::INFINITY] {
            assert!(check_max_fetch(bad).is_err(), "{bad}");
            assert_eq!(Settings { max_fetch_usdc: bad, ..Settings::default() }.max_fetch(), 0.0, "{bad}");
        }
    }
}

#[cfg(test)]
mod pricing_tests {
    use super::{moves_a_price, Pricing};

    /// A fee under every listed price is no price at all: only a move that reaches one is worth a write.
    #[test]
    fn a_fee_moving_under_every_listed_price_moves_nothing() {
        assert!(!moves_a_price(0.05, 0.04, &[0.1, 0.2]), "both under both prices");
        assert!(moves_a_price(0.15, 0.12, &[0.1, 0.2]), "above the cheaper listing");
        assert!(moves_a_price(0.05, 0.15, &[0.1]), "rising past a price");
        assert!(moves_a_price(0.05, 0.04, &[0.0]), "a listing that lists no price follows the fee");
        assert!(!moves_a_price(0.05, 0.04, &[]), "no live listing");
    }

    fn after(lines_before: u64) -> Pricing {
        Pricing { auto: true, floor: 0.05, ceiling: 0.2, lines: lines_before, ..Pricing::default() }
    }

    #[test]
    fn the_fee_follows_demand_within_its_bounds() {
        assert_eq!(after(3).next_fee(0.1, 5, None), 0.11, "more paid fetches raise it");
        assert_eq!(after(5).next_fee(0.1, 3, None), 0.09, "fewer lower it");
        assert_eq!(after(4).next_fee(0.1, 4, None), 0.1, "steady demand holds it");
        assert_eq!(after(0).next_fee(0.1, 0, None), 0.09, "no demand at all lowers it");
        assert_eq!(after(1).next_fee(0.195, 9, None), 0.2, "never above the ceiling");
        assert_eq!(after(9).next_fee(0.052, 1, None), 0.05, "never below the floor");
    }

    /// Losing sales to a cheaper market, the fee moves halfway to it; a market that isn't cheaper changes nothing,
    /// and gaining sales is never answered by cutting the price.
    #[test]
    fn a_falling_fee_moves_toward_what_others_charge() {
        assert_eq!(after(5).next_fee(0.1, 1, Some(0.02)), 0.06, "halfway to a much cheaper market");
        assert_eq!(after(5).next_fee(0.1, 1, Some(0.095)), 0.09, "a market barely cheaper: a tenth, as before");
        assert_eq!(after(5).next_fee(0.1, 1, Some(0.5)), 0.09, "a dearer market changes nothing");
        assert_eq!(after(3).next_fee(0.1, 5, Some(0.02)), 0.11, "gaining sales raises it, whatever others charge");
        assert_eq!(after(4).next_fee(0.1, 4, Some(0.02)), 0.1, "steady demand holds it");
    }

    /// A look moves the fee one step and is recorded before the fee is sent: a `setFee` that landed but answered an
    /// error, retried a minute later, finds the epoch already looked at, so the fee never compounds within an epoch.
    #[test]
    fn auto_pricing_moves_the_fee_once_per_epoch() {
        let mut p = after(3);
        assert!(p.due(7));
        assert_eq!(p.look(7, 100, 5, 0.1, None, true), Some(0.11), "more demand: up a tenth");
        // The send landed (the chain's fee is 0.11 now) and errored. The next pass, same epoch, same demand:
        assert!(!p.due(7), "the epoch is recorded before the send");
        // Had it looked again it would have moved from the new fee once more, to 0.121.
        assert_eq!(p.next_fee(0.11, 5, None), 0.11, "and against this epoch's record, the same demand holds the fee");
        assert!(p.due(8), "the next epoch looks again");
        assert!(p.due(6), "and a new deployment's lower count");
        assert_eq!(p.look(8, 200, 5, 0.11, None, true), None, "steady demand holds it");
        assert_eq!(p.look(9, 300, 0, 0.11, None, false), None, "nothing listed: nothing to send");
        assert_eq!((p.epoch, p.block, p.lines), (9, 300, 0));
    }

    #[test]
    fn a_new_node_prices_itself_and_competes_downward() {
        let p = Pricing::default();
        assert!(p.auto, "auto pricing is on until the owner turns it off");
        assert!(p.floor < 0.01, "the floor leaves room below the suggested starting price");
        let old: Pricing = serde_json::from_str(r#"{"auto":false,"floor":0.05,"ceiling":0.2}"#).unwrap();
        assert!(!old.auto, "an owner who turned it off keeps it off");
    }
}

#[cfg(test)]
mod private_tests {
    use super::*;

    fn route(site: &str, root: &str, steps: &[&str]) -> Route {
        let steps: Vec<serde_json::Value> = steps
            .iter()
            .enumerate()
            .map(|(i, u)| serde_json::json!({ "exchange": i, "method": "GET", "status": 200, "url": u, "fields": [], "needs_browser": false }))
            .collect();
        serde_json::from_value(serde_json::json!({
            "id": "r1", "site": site, "what": "x", "method": "GET", "path": "/", "root": root, "inputs": [], "steps": steps.len(),
            "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "steps": steps, "provisional": false }
        }))
        .expect("a route")
    }

    /// A route learned on one value of a page answers another value of the same page: its path template says which
    /// piece is the caller's (`/search/{path[1]}`). Comparing the pieces by their text made every value a new page,
    /// so foodnetwork re-learned on a browser for each value the bank asked.
    #[test]
    fn a_route_answers_another_value_of_the_same_page() {
        let r: Route = serde_json::from_value(serde_json::json!({
            "id": "r1", "site": "foodnetwork.com", "what": "x", "method": "GET",
            "path": "/search/{path[1]}", "root": "https://www.foodnetwork.com/search/chicken-",
            "inputs": [{ "name": "search", "secret": false, "default": "chicken-" }],
            "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://www.foodnetwork.com/search/{path[1]}", "fields": [], "needs_browser": false }], "provisional": false }
        }))
        .expect("a route");
        assert!(r.same_page("https://www.foodnetwork.com/search/chicken-", "https://www.foodnetwork.com/search/pasta"));
        assert!(!r.same_page("https://www.foodnetwork.com/recipes/chicken", "https://www.foodnetwork.com/search/pasta"));
    }

    /// A route that reaches a host the owner excluded is caught by that host, whichever host the walk began on:
    /// its target, the page it starts from, or any step between.
    #[test]
    fn a_route_whose_target_is_excluded_is_refused_at_keep_and_call() {
        let excluded = vec!["private.example".to_string()];
        let cross = route("api.private.example", "https://public.example/", &["https://public.example/api/a", "https://api.private.example/v1/{path[1]}"]);
        assert_eq!(excluded_host(&cross, &excluded).as_deref(), Some("api.private.example"));
        let rooted = route("public.example", "https://www.private.example/", &["https://public.example/api/a"]);
        assert_eq!(excluded_host(&rooted, &excluded).as_deref(), Some("www.private.example"));
        let ported = route("public.example", "https://public.example/", &["https://private.example:8443/x", "https://public.example/api/a"]);
        assert_eq!(excluded_host(&ported, &excluded).as_deref(), Some("private.example"));
        let clean = route("public.example", "https://public.example/", &["https://public.example/api/a"]);
        assert_eq!(excluded_host(&clean, &excluded), None);
    }

    /// What the node writes is readable by its owner alone.
    #[cfg(unix)]
    #[test]
    fn a_written_file_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("unbrowse-store-private-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("jars").join("127.0.0.1.json");
        write_json(&path, &unbrowse_files::JAR, &serde_json::json!({ "sid": "dummy_cookie_123" })).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir.join("jars")), 0o700);
        // Written again over a file kept before with a wider mode, it is narrowed.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_json(&path, &unbrowse_files::JAR, &serde_json::json!({ "sid": "dummy_cookie_456" })).unwrap();
        assert_eq!(mode(&path), 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod label_tests {
    use unbrowse_learn::ledger::writes;
    use unbrowse_learn::Step;

    fn step(method: &str, url: &str, body: Option<serde_json::Value>) -> Step {
        serde_json::from_value(serde_json::json!({
            "exchange": 0, "method": method, "status": 200, "url": url, "fields": [], "needs_browser": false,
            "body": body.map(|b| serde_json::json!({ "kind": "json", "template": b, "types": {} })),
        }))
        .expect("step")
    }

    #[test]
    fn asking_posts_are_reads() {
        assert!(!writes(&step("GET", "https://crates.io/api/v1/crates?q={q}", None)));
        assert!(!writes(&step("POST", "https://x-dsn.algolia.net/1/indexes/Item_dev/query?x-algolia-agent={a}", None)));
        assert!(!writes(&step("POST", "https://api.example.com/v2/search", None)));
        assert!(!writes(&step("POST", "https://example.com/graphql", Some(serde_json::json!({ "query": "query Q { a }" })))));
        assert!(writes(&step("POST", "https://example.com/graphql", Some(serde_json::json!({ "query": "mutation M { a }" })))));
        assert!(writes(&step("POST", "https://example.com/api/cart/items", None)));
        assert!(writes(&step("DELETE", "https://example.com/api/search", None)));
    }
}

#[cfg(test)]
mod secret_tests {
    use super::Route;
    use unbrowse_learn::{Class, Field, Graph, Loc, Step};

    /// A route keeps no secret's value, but a vault login's name it keeps: that is how a later call signs in again.
    #[test]
    fn a_route_keeps_a_logins_name_and_no_secret() {
        let mut step: Step = serde_json::from_value(serde_json::json!({
            "exchange": 0, "method": "POST", "status": 200, "url": "https://example.com/session", "fields": [], "needs_browser": false,
        }))
        .unwrap();
        let input = |name: &str, secret: bool, value: &str| Field {
            loc: Loc::Header(name.into()),
            class: Class::Input { name: name.into(), secret, default: Some(value.into()), optional: false },
        };
        step.fields = vec![input("user", false, "me"), input("password", true, "vault:example.com:me"), input("code", true, "secret:2")];
        let route = Route::from_graph("r".into(), "sign in".into(), "https://example.com/".into(), Graph { steps: vec![step], provisional: false, page_origin: None , ..Graph::default() }).unwrap();
        let default = |n: &str| route.inputs.iter().find(|i| i.name == n).unwrap().default.clone();
        assert_eq!(default("user").as_deref(), Some("me"));
        assert_eq!(default("password").as_deref(), Some("vault:example.com:me"));
        assert_eq!(default("code"), None);
    }
}

#[cfg(test)]
mod settings_tests {
    use super::{Settings, ShareMode};

    /// A settings file written before a setting existed keeps every value it has, and the new one starts off.
    #[test]
    fn an_older_settings_file_keeps_its_values() {
        let old = r#"{"map_while_browsing":false,"hold_routes":true,"signed_in_calls":true,"paused":true,"api_port":7790,"storage_gb":2.0,"excluded":["a.example"],"auto_buy":false,"auto_buy_level":5.0}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert!(s.paused && s.hold_routes && !s.map_while_browsing);
        assert_eq!(s.api_port, 7790);
        assert!(!s.private_network);
        assert_eq!(s.chain, "devnet", "a node from before the setting stays on its devnet");
    }

    /// The dead `auto_buy` switch is gone; a file that still has it reads, and saving it again drops it.
    #[test]
    fn an_old_file_with_auto_buy_still_reads() {
        let old = r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[],"auto_buy":true,"auto_buy_level":10000.0}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        let again = serde_json::to_string(&s).unwrap();
        assert!(!again.contains("auto_buy"), "{again}");
    }

    /// Sharing was a switch before it had modes: on reads as `used`, off as `off`, and a file from before either reads
    /// the build's default. A fresh install takes the build's defaults; a file the owner has keeps what it says.
    /// Every setting that bounds what the node spends says which change loosens it, so a change that loosens it is the
    /// owner's to make: each money field of the settings is in `SPENDING`, and a change that only tightens asks nothing.
    #[test]
    fn a_change_that_lets_the_node_spend_more_asks_the_owner() {
        let now = serde_json::to_value(Settings::default()).unwrap();
        let money = |k: &str| ["_usdc", "_unb", "_gwei", "_share", "per_day"].iter().any(|t| k.contains(t)) || k == "chain";
        for k in now.as_object().unwrap().keys().filter(|k| money(k)) {
            assert!(crate::store::SPENDING.iter().any(|(n, _, _)| n == k), "{k} bounds spending and says nothing of which way loosens it");
        }
        let with = |k: &str, v: serde_json::Value| serde_json::json!({ k: v });
        assert_eq!(crate::store::loosened(&now, &with("deposit_floor_usdc", 1_000.into())).len(), 1);
        assert_eq!(crate::store::loosened(&now, &with("gas_reserve_usdc", 0.into())).len(), 1, "keeping less back loosens");
        assert_eq!(crate::store::loosened(&now, &with("chain", "arc-mainnet".into())).len(), 1);
        assert_eq!(crate::store::loosened(&now, &with("list_per_day", 50.into())).len(), 1, "a count set where none was");
        assert_eq!(crate::store::loosened(&now, &with("max_fetch_usdc", "lots".into())).len(), 1, "a value of the wrong kind counts as loosening");
        assert!(crate::store::loosened(&now, &with("deposit_floor_usdc", 0.into())).is_empty(), "lowering a floor tightens");
        assert!(crate::store::loosened(&now, &with("gas_reserve_usdc", 100.into())).is_empty(), "keeping more back tightens");
        assert!(crate::store::loosened(&now, &now).is_empty(), "the same settings loosen nothing");
    }

    #[test]
    fn old_share_switches_and_fresh_installs_read_as_they_should() {
        let with = |v: &str| -> Settings { serde_json::from_str(&format!(r#"{{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[],"share_routes":{v}}}"#)).unwrap() };
        assert_eq!(with("true").share_routes, ShareMode::Used);
        assert_eq!(with("false").share_routes, ShareMode::Off);
        assert_eq!(with(r#""all""#).share_routes, ShareMode::All);
        assert_eq!(with(r#""off""#).share_routes, ShareMode::Off);
        assert!(serde_json::from_str::<Settings>(r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[],"share_routes":"everything"}"#).is_err());
        let before: Settings = serde_json::from_str(r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[]}"#).unwrap();
        assert_eq!(before.share_routes, crate::build_config::share_default());
        assert_eq!(before.chain, "devnet", "an existing file never moves chain because the build's default did");
        let fresh = Settings::default();
        assert_eq!((fresh.chain.as_str(), fresh.share_routes), (crate::build_config::default_chain(), crate::build_config::share_default()));
        assert!(!fresh.share_notice_seen);
        // Written and read again, the mode is its name.
        let back: Settings = serde_json::from_str(&serde_json::to_string(&with("true")).unwrap()).unwrap();
        assert_eq!(back.share_routes, ShareMode::Used);
        assert!(serde_json::to_string(&with("true")).unwrap().contains(r#""share_routes":"used""#));
    }

    /// Joining the peer network is opt-out: a node is on it unless its owner turned it off, an older settings file
    /// (from before the setting, or with the terms never acknowledged) included.
    #[test]
    fn a_node_joins_the_network_unless_its_owner_opts_out() {
        assert!(Settings::default().peer_network);
        let old: Settings = serde_json::from_str(r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[],"auto_buy":true,"auto_buy_level":10000.0,"terms_accepted":null}"#).unwrap();
        assert!(old.peer_network, "a file from before the setting reads as on");
        let off: Settings = serde_json::from_str(r#"{"map_while_browsing":true,"hold_routes":false,"signed_in_calls":true,"paused":false,"api_port":7788,"storage_gb":4.0,"excluded":[],"auto_buy":true,"auto_buy_level":10000.0,"peer_network":false}"#).unwrap();
        assert!(!off.peer_network, "an owner who opted out stays out");
    }
}

#[cfg(test)]
mod route_record_tests {
    use super::*;

    /// A body this build reads is kept, and one it does not (a newer body's version, or one that no longer reads) is
    /// none: the route still reads, as its graph.
    #[test]
    fn a_body_this_build_does_not_read_leaves_the_route_as_its_graph() {
        let route = with_a_body_saying(Route::from_graph("r".into(), "search".into(), "https://shop.example/".into(), serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api", "fields": [], "needs_browser": false }
        ]})).unwrap()).unwrap(), "kept");
        let mut file = serde_json::to_value(&route).unwrap();
        assert_eq!(serde_json::from_value::<Route>(file.clone()).unwrap().body, route.body);
        file["body"]["v"] = serde_json::json!(unbrowse_learn::route::VERSION + 1);
        let newer: Route = serde_json::from_value(file.clone()).expect("the route still reads");
        assert!(newer.body.is_none() && serde_json::to_value(&newer.graph).unwrap() == serde_json::to_value(&route.graph).unwrap());
        file["body"] = serde_json::json!({ "steps": "not a body" });
        assert!(serde_json::from_value::<Route>(file).unwrap().body.is_none());
    }

    /// A body's plan is kept with it and read back as written. One whose page holds a secret's value where its slot
    /// was asked does not read, and the route reads as its graph: no value of a session leaves in a body.
    #[test]
    fn a_body_whose_plan_holds_a_secrets_value_does_not_read() {
        use unbrowse_learn::route as body;
        let mut route = with_a_body_saying(Route::from_graph("r".into(), "sign in".into(), "https://shop.example/".into(), serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api", "fields": [], "needs_browser": false }
        ]})).unwrap()).unwrap(), "kept");
        let learned = route.body.as_mut().unwrap();
        learned.slots.push(body::Slot { name: "code".into(), secret: true, example: None, choices: Vec::new() });
        learned.plan = Some(body::Plan { page: "https://shop.example/in?code={code}".into(), goal: "sign in".into(), asked: vec![body::Asked { slot: "code".into(), at: body::AskedAt::Query("code".into()), by: body::AskedBy::OneWalk }], done: Vec::new() });
        let mut file = serde_json::to_value(&route).unwrap();
        assert_eq!(serde_json::from_value::<Route>(file.clone()).unwrap().body, route.body, "a plan with its slot in place reads");
        file["body"]["plan"]["page"] = serde_json::json!("https://shop.example/in?code=4471");
        let read: Route = serde_json::from_value(file).expect("the route still reads");
        assert!(read.body.is_none(), "a plan holding a secret's value does not read");
        assert_eq!(serde_json::to_value(&read.graph).unwrap(), serde_json::to_value(&route.graph).unwrap());
    }

    /// Every route a node holds, read as this build reads a route file and written back as it writes one, in memory
    /// (nothing is written to the folder): no body on a route that had none, and none written. Where the bytes differ
    /// it is the store's own writing out of what an older file left unsaid (its version, a stat's default), said by
    /// path: a body is no part of that.
    ///
    /// `UNBROWSE_ROUTES=<a node's routes folder> cargo test -p unbrowse-node-app --bin unbrowse-node the_routes_a_node_holds -- --nocapture`.
    #[test]
    fn the_routes_a_node_holds_read_and_write_back_as_they_were() {
        let _offline = unbrowse_learn::http::offline();
        let Some(dir) = std::env::var_os("UNBROWSE_ROUTES") else { return };
        let mut files: Vec<PathBuf> = fs::read_dir(&dir).expect("the routes folder").filter_map(|e| Some(e.ok()?.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        let (mut read, mut unread, mut same_bytes, mut bodied, mut written_with_one) = (0usize, 0usize, 0usize, 0usize, 0usize);
        let mut differing: Vec<String> = Vec::new();
        for file in &files {
            let bytes = fs::read(file).expect("a route file");
            let Ok(route) = unbrowse_files::ROUTE.read::<Route>(&bytes).map(relabel) else {
                unread += 1;
                continue;
            };
            read += 1;
            bodied += usize::from(route.body.is_some());
            let back = unbrowse_files::ROUTE.to_vec_pretty(&route).expect("a route is written");
            written_with_one += usize::from(serde_json::from_slice::<serde_json::Value>(&back).ok().is_some_and(|v| v.get("body").is_some()));
            if back == bytes {
                same_bytes += 1;
                continue;
            }
            let (was, now): (serde_json::Value, serde_json::Value) = (serde_json::from_slice(&bytes).unwrap_or_default(), serde_json::from_slice(&back).unwrap_or_default());
            // Where the two first part, by path alone: a route holds values that stay out of a test's output.
            fn parted(was: &serde_json::Value, now: &serde_json::Value, at: String) -> String {
                match (was, now) {
                    (serde_json::Value::Object(a), serde_json::Value::Object(b)) => {
                        let gained = b.keys().find(|k| !a.contains_key(*k)).map(|k| format!("{at}/{k} (written, absent before)"));
                        let lost = a.keys().find(|k| !b.contains_key(*k)).map(|k| format!("{at}/{k} (left out)"));
                        gained.or(lost).unwrap_or_else(|| a.iter().find(|(k, v)| b.get(k.as_str()) != Some(*v)).map(|(k, v)| parted(v, &b[k.as_str()], format!("{at}/{k}"))).unwrap_or(at))
                    }
                    (serde_json::Value::Array(a), serde_json::Value::Array(b)) if a.len() == b.len() => a.iter().zip(b).position(|(x, y)| x != y).map(|i| parted(&a[i], &b[i], format!("{at}/{i}"))).unwrap_or(at),
                    _ => format!("{at} (another value)"),
                }
            }
            let keys: Vec<String> = now.as_object().into_iter().flatten().filter(|(k, v)| was.get(k.as_str()) != Some(*v)).map(|(k, v)| if k == "v" { "v (written, absent before)".to_string() } else { parted(&was[k.as_str()], v, k.clone()) }).chain(was.as_object().into_iter().flatten().filter(|(k, _)| now.get(k.as_str()).is_none()).map(|(k, _)| format!("{k} (left out)"))).collect();
            differing.push(format!("{}: {}", file.file_name().unwrap_or_default().to_string_lossy(), if keys.is_empty() { "the same fields, written otherwise".to_string() } else { keys.join(", ") }));
        }
        eprintln!("{} files: {read} read, {unread} not; {bodied} carry a body, {written_with_one} written back with one; {same_bytes} written back the same bytes, {} otherwise:", files.len(), differing.len());
        for d in &differing {
            eprintln!("  {d}");
        }
        assert_eq!((bodied, written_with_one), (0, 0), "no body appears on a route that had none");
    }

    fn route(id: &str) -> Route {
        serde_json::from_value(serde_json::json!({
            "id": id, "site": "shop.example", "what": "list items", "method": "GET", "path": "/api/items",
            "root": "https://shop.example/", "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
            "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
        }))
        .unwrap()
    }

    fn listed(mut r: Route) -> Route {
        r.listing = Some(Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: true });
        r
    }

    /// A route is read from its file once for each time the file is written: a read after the node's own write is
    /// the route written, and a file another program changed is read again, never answered from what was read before.
    #[test]
    fn a_route_file_changed_since_it_was_read_is_read_again() {
        scratch_home("read-routes");
        let mut r = route("c1");
        r.what = "list items".into();
        save_route(&r).unwrap();
        assert_eq!(load_route("c1").unwrap().what, "list items");
        update_route("c1", |r| r.stats.calls = 3).unwrap();
        assert_eq!(load_route("c1").unwrap().stats.calls, 3, "the node's own write");
        let path = routes_dir().join("c1.json");
        let text = std::fs::read_to_string(&path).unwrap().replace("list items", "list other things");
        std::thread::sleep(std::time::Duration::from_millis(5));
        std::fs::write(&path, text).unwrap();
        assert_eq!(load_route("c1").unwrap().what, "list other things", "another program's write");
        assert_eq!(load_routes().iter().find(|r| r.id == "c1").unwrap().what, "list other things");
        std::fs::remove_file(&path).unwrap();
        assert!(load_route("c1").is_none(), "a file gone is no route");
    }

    #[test]
    fn a_route_learned_again_never_replaces_a_listed_or_the_owners_own_record() {
        scratch_home("keep-learned");
        let mut old = listed(route("a1"));
        old.stats.calls = 9;
        save_route(&old).unwrap();
        let mut again = route("a1");
        again.what = "something else".into();
        let (stands, kept) = keep_learned(again).unwrap();
        assert!(!kept);
        assert_eq!(stands.what, "list items");
        let on_disk = load_route("a1").unwrap();
        assert!(on_disk.listing.is_some() && on_disk.stats.calls == 9);

        let mut mine = route("b1");
        mine.yours = true;
        save_route(&mine).unwrap();
        let (stands, kept) = keep_learned(route("b1")).unwrap();
        assert!(!kept && stands.yours);
        // The owner's own browsing learns it afresh, and it stays theirs.
        let mut theirs = route("b1");
        theirs.yours = true;
        theirs.what = "list new items".into();
        assert!(keep_learned(theirs).unwrap().1);
        assert_eq!(load_route("b1").unwrap().what, "list new items");

        // Anything else is learned afresh, keeping its stats.
        let mut plain = route("c1");
        plain.stats.calls = 4;
        save_route(&plain).unwrap();
        let mut fresh = route("c1");
        fresh.what = "list all items".into();
        let (now, kept) = keep_learned(fresh).unwrap();
        assert!(kept && now.what == "list all items" && now.stats.calls == 4);
    }

    #[test]
    fn a_route_learned_after_the_owner_turned_the_network_off_stays_on_the_node() {
        scratch_home("off-after-joining-learns");
        let me = "0x00000000000000000000000000000000000000a1";
        crate::link::set_node(me);
        save_settings(&crate::terms::acknowledged(Settings::default(), false)).unwrap();
        assert!(crate::link::on_network_since(me).is_some(), "it joined");
        let mut s = load_settings();
        s.peer_network = false;
        save_settings(&s).unwrap();
        assert_eq!(keep_learned(route("off1")).unwrap().0.local, Some(true));
    }

    #[test]
    fn a_route_retired_by_a_learn_is_never_listed_or_the_owners_own() {
        scratch_home("retire");
        save_route(&listed(route("l1"))).unwrap();
        let mut mine = route("m1");
        mine.yours = true;
        save_route(&mine).unwrap();
        save_route(&route("p1")).unwrap();
        assert!(!retire_route("l1").unwrap() && load_route("l1").is_some());
        assert!(!retire_route("m1").unwrap() && load_route("m1").is_some());
        assert!(retire_route("p1").unwrap() && load_route("p1").is_none());
    }

    /// A learn checks a snapshot of the routes before it retires one: a verdict that lands in between is read here, on
    /// the record as it is, or the verdict would leave with the route and the next learn walk back to the same call.
    #[test]
    fn a_route_judged_since_the_learn_looked_is_never_retired_or_dropped() {
        scratch_home("retire-judged");
        let mut judged = route("j1");
        judged.judged.writes = true;
        save_route(&judged).unwrap();
        assert!(!retire_route("j1").unwrap() && !drop_learned("j1").unwrap());
        assert!(load_route("j1").is_some_and(|r| r.judged.writes));
        save_route(&route("p2")).unwrap();
        assert!(drop_learned("p2").unwrap() && load_route("p2").is_none());
        save_route(&listed(route("l2"))).unwrap();
        assert!(!drop_learned("l2").unwrap() && load_route("l2").is_some());
    }

    /// A change made from a copy read before is made on the record as it is now: a route deleted meanwhile stays
    /// deleted, and a listing ended meanwhile stays ended.
    #[test]
    fn a_change_never_brings_back_what_the_owner_changed_meanwhile() {
        scratch_home("update");
        save_route(&listed(route("d1"))).unwrap();
        let before = load_route("d1").unwrap();
        delete_route("d1").unwrap();
        assert!(update_route(&before.id, |r| r.stats.calls += 1).unwrap().is_none());
        assert!(load_route("d1").is_none());

        save_route(&listed(route("d2"))).unwrap();
        update_route("d2", |r| r.listing.as_mut().unwrap().live = false).unwrap();
        update_route("d2", |r| r.stats.calls += 1).unwrap();
        let now = load_route("d2").unwrap();
        assert!(!now.listing.unwrap().live);
        assert_eq!(now.stats.calls, 1);
    }

    #[test]
    fn two_writers_of_one_record_never_leave_it_torn() {
        let home = scratch_home("torn");
        save_route(&route("t1")).unwrap();
        let writers: Vec<_> = (0..2)
            .map(|w| {
                let home = home.clone();
                std::thread::spawn(move || {
                    use_home(&home);
                    for i in 0..200 {
                        let mut r = route("t1");
                        r.stats.last_error = Some("x".repeat(if w == 0 { 10 } else { 4000 } + i));
                        write_json(&routes_dir().join("t1.json"), &unbrowse_files::ROUTE, &r).unwrap();
                    }
                })
            })
            .collect();
        for _ in 0..200 {
            assert!(read_json_opt::<Route>(&routes_dir().join("t1.json"), &unbrowse_files::ROUTE).is_some());
        }
        for w in writers {
            w.join().unwrap();
        }
        assert!(load_route("t1").is_some());
    }

    /// A route's page code (the scripts its signing bridge boots, the answers the page read, the page itself) is most
    /// of its bytes: a listing leaves it in the file, so asking for every route holds none of it, while the route still
    /// runs with it and a listed route written back keeps it (UNB-139: every search held a copy of every route's code).
    #[test]
    fn a_listing_holds_no_page_code_and_writing_a_listed_route_keeps_it() {
        let _home = scratch_home("apart");
        let script = unbrowse_learn::signing::Script { url: "https://shop.example/app.js".into(), body: "x".repeat(1 << 20) };
        let mut signed = route("signed");
        signed.graph.scripts = vec![script.clone()];
        signed.graph.page_html = Some("<html>kept</html>".into());
        save_route(&signed).unwrap();
        save_route(&route("plain")).unwrap();

        let listed = load_routes();
        let bytes: usize = listed.iter().flat_map(|r| &r.graph.scripts).map(|s| s.body.len()).sum();
        assert_eq!(bytes, 0, "a listing carries no page code");
        let mut light = listed.into_iter().find(|r| r.id == "signed").unwrap();
        assert!(light.graph.apart.is_some() && light.graph.page_html.is_none());
        assert!(load_routes().iter().find(|r| r.id == "plain").unwrap().graph.apart.is_none(), "a route with no code is whole");

        // Written back from the listing (a call's stats, say): the file still holds the code.
        light.stats.last_error = Some("once".into());
        save_route(&light).unwrap();
        let on_disk: Route = read_json_opt(&routes_dir().join("signed.json"), &unbrowse_files::ROUTE).unwrap();
        assert_eq!(on_disk.graph.scripts, vec![script.clone()], "the file keeps the page's code");
        assert_eq!(on_disk.graph.page_html.as_deref(), Some("<html>kept</html>"));
        assert_eq!(on_disk.stats.last_error.as_deref(), Some("once"));

        // And the graph takes it back to run.
        let mut graph = load_route("signed").unwrap().graph;
        assert!(graph.rejoined());
        assert_eq!(graph.scripts, vec![script]);
        assert_eq!(graph.page_html.as_deref(), Some("<html>kept</html>"));
    }

    #[test]
    fn a_file_that_doesnt_read_is_never_read_as_empty() {
        let home = scratch_home("strict");
        let path = home.join("agents.json");
        assert_eq!(read_json_strict::<Vec<u32>>(&path, &unbrowse_files::AGENTS).unwrap(), Vec::<u32>::new(), "missing is empty");
        fs::write(&path, "{").unwrap();
        assert!(read_json_strict::<Vec<u32>>(&path, &unbrowse_files::AGENTS).is_err());
    }
}

#[cfg(test)]
mod file_input_tests {
    use super::Route;
    use unbrowse_learn::Graph;

    /// A route that uploads lists its file as an input of kind `file`, with no default: the walk's own file is never
    /// sent again on its own.
    #[test]
    fn an_upload_lists_its_file_as_a_file_input() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [
                { "exchange": 0, "method": "POST", "status": 200, "url": "https://upload.video.example/upload/studio", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-goog-upload-header-content-length" }, "class": "file", "name": "file", "of": "size" }] },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://upload.video.example/", "needs_browser": false, "fields": [],
                  "body": { "kind": "upload", "input": "file", "protocol": { "kind": "google_resumable", "chunk": 104857600 } } },
                { "exchange": 2, "method": "POST", "status": 200, "url": "https://studio.video.example/api/create", "needs_browser": false,
                  "fields": [{ "loc": { "in": "json", "key": "/title" }, "class": "input", "name": "title", "secret": false, "default": "x" }],
                  "body": { "kind": "json", "template": { "title": null }, "types": { "/title": "string" } } }
            ],
            "provisional": false
        }))
        .unwrap();
        let route = Route::from_graph("r".into(), "post a video".into(), "https://studio.video.example/".into(), graph).unwrap();
        let file = route.inputs.iter().find(|i| i.name == "file").expect("the file is an input");
        assert!(file.file && file.default.is_none() && !file.secret);
        assert_eq!(file.kind(), "file");
        assert_eq!(route.inputs.iter().filter(|i| i.name == "file").count(), 1, "listed once though two steps use it");
        assert_eq!(route.inputs.iter().find(|i| i.name == "title").unwrap().kind(), "text");
        let saved = |name: &str| serde_json::to_value(route.inputs.iter().find(|i| i.name == name).unwrap()).unwrap();
        assert_eq!(saved("file")["file"], true);
        assert!(saved("title").get("file").is_none(), "a text input is saved as before");
    }
}

#[cfg(test)]
mod home_tests {
    use super::*;

    /// A test's walks open their browser, profile and browser program in the test's home, never the owner's: the
    /// engine and the learner read the home from `unbrowse_files::private::home`, and a matrix run once opened a
    /// browser in the owner's profile for its site from a thread that had no scratch home.
    #[test]
    fn a_test_never_opens_the_owners_home() {
        let owners = unbrowse_files::private::user_home().join(".unbrowse");
        let home = scratch_home("owners-home");
        assert_eq!(unbrowse_files::private::home(), home, "the engine reads the test's home");
        assert_eq!(unbrowse_learn::site::Site::new().profile_root, home.join("profiles"), "a walk's profile is in the test's home");
        let elsewhere = std::thread::spawn(|| (unbrowse_files::private::home(), unbrowse_learn::site::Site::new().profile_root)).join().unwrap();
        assert!(!elsewhere.0.starts_with(&owners) && !elsewhere.1.starts_with(&owners), "a thread with no scratch home still never opens the owner's: {elsewhere:?}");
        let _ = fs::remove_dir_all(&home);
    }

    /// A browse session's tab closes when idle, and the browser program's daemon closes no sooner: a tab the node still
    /// counts as open is never pulled from under it.
    #[test]
    fn the_program_closes_an_idle_browser_no_sooner_than_its_tabs() {
        assert!(unbrowse_learn::mint::PROGRAM_IDLE >= crate::browse::TAB_IDLE);
    }
}

#[cfg(test)]
mod node_lock_tests {
    use super::hold_node_in;
    use std::time::Duration;

    /// A second node on a home finds the first's lock and stops, told its pid; once the first lets go, the next one
    /// takes it. Before this the window started a node every ten seconds while the first waited on the owner at the
    /// keystore's dialog, and each one asked the owner again.
    #[test]
    fn a_second_node_on_a_home_finds_the_first_and_stops() {
        let home = std::env::temp_dir().join(format!("unbrowse-node-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let first = hold_node_in(&home, Duration::ZERO).unwrap().expect("the first node takes the lock");
        let second = hold_node_in(&home, Duration::ZERO).unwrap();
        assert_eq!(second.err(), Some(Some(std::process::id())), "the second is told who holds it");
        let waited = std::time::Instant::now();
        assert!(hold_node_in(&home, Duration::from_millis(500)).unwrap().is_err(), "a wait that runs out still finds it held");
        assert!(waited.elapsed() >= Duration::from_millis(400), "and it did wait");
        drop(first);
        assert!(hold_node_in(&home, Duration::ZERO).unwrap().is_ok(), "the first gone, the next one takes it");
        let _ = std::fs::remove_dir_all(&home);
    }
}
