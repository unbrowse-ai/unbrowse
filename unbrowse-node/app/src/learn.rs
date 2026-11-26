//! Learning a route (PRD US-005): the node's browser walks a page once with capture on, the walk's own API calls
//! are listed for the owner, and the one they keep becomes a route: the dependency graph from the page to that
//! call, with every value traced to its source and the caller's values as inputs.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha3::{Digest, Keccak256};
use unbrowse_learn::goal;
use unbrowse_learn::mint::{BrowserMint, Mint};
use unbrowse_learn::trace::{carries_text, Exchange, Input, Trace};
use unbrowse_learn::identity::site_of;


use crate::rank;
use crate::store::{self, Activity, Route};
use crate::sync::Locked;

/// A walk the owner is choosing from.
pub struct Walk {
    pub url: String,
    pub trace: Arc<Trace>,
    /// What the page's own code built when it signed, if the walk probed it: a recipe is fitted from it.
    pub probes: Vec<unbrowse_learn::trace::Probe>,
    /// The walk as the recording reads it: the scripts by hash and what sent each call, so a learn by example can
    /// read the sender script's constants (`body_by_example`). None when the capture could not be read as one.
    pub recording: Option<unbrowse_learn::recording::Recording>,
    /// When it was walked: the oldest go first (`keep_walk`).
    pub at: std::time::Instant,
    /// Every address the walk's browser was at, fragment and all, when its capture recorded them
    /// (`walk::addresses_from_walk`); None when it couldn't say.
    pub addresses: Option<Vec<String>>,
}

/// A walk kept on disk, learned again with no browser: its capture (`learn_<id>.jsonl`, as a walk writes it) is read
/// as a walk the node has just made is read, held as that walk, and the goal's call picked and kept by the same rule
/// (`pick_and_keep`, on the walk already held, as the experiment reads it). Nothing is walked and no site is asked.
/// The values a route sends come from the node's own home: on a fresh one the jar is empty, so the route kept is
/// one that has to answer from nothing the walk's browser held. Returns the route kept, saved in the node's store.
pub fn learn_kept_walk(capture: &std::path::Path, url: &str, goal: &str) -> Result<Route, String> {
    let dir = capture.parent().ok_or("the capture has no folder")?;
    let session = capture.file_stem().and_then(|s| s.to_str()).ok_or("the capture has no name")?;
    let trace = trace_from_walk(dir, session).ok_or("the capture holds no walk")?;
    let walk = Walk {
        url: url.to_string(),
        trace: trace.into(),
        probes: unbrowse_learn::walk::probes_from_walk(dir, session),
        recording: unbrowse_learn::recording::Recording::read(dir, session),
        at: std::time::Instant::now(),
        addresses: unbrowse_learn::walk::owners_addresses_from_walk(dir, session),
    };
    let walks = Walks::default();
    let id = walk_id(url);
    keep_walk(&mut walks.0.locked(), id.clone(), walk);
    pick_and_keep(&walks, url, goal, "You", &id, &|_| {}, None, true).map(|(route, _)| route).map_err(|e| e.to_string())
}

/// How many walks are held for the owner to choose from: each is a whole trace, bodies and all, and nothing else lets one go.
const WALKS_KEPT: usize = 16;

/// Keeps `walk`, and only the newest `WALKS_KEPT`. A choice made from one let go says it has expired.
fn keep_walk(walks: &mut HashMap<String, Walk>, id: String, walk: Walk) {
    walks.insert(id, walk);
    while walks.len() > WALKS_KEPT {
        let Some(oldest) = walks.iter().min_by_key(|(_, w)| w.at).map(|(id, _)| id.clone()) else { return };
        walks.remove(&oldest);
    }
}

/// The walks the owner is choosing from, and the last pictures of the walks (`frames`).
#[derive(Default)]
pub struct Walks(pub Mutex<HashMap<String, Walk>>, pub crate::frames::Frames, Mutex<HashMap<String, Vec<(String, String)>>>);

impl Walks {
    fn remember_companion(&self, walk: &str, route: &str, companion: String) {
        let walks = self.0.locked();
        let mut companions = self.2.locked();
        companions.retain(|id, _| walks.contains_key(id));
        let kept = companions.entry(walk.to_string()).or_default();
        if !kept.iter().any(|(primary, other)| primary == route && *other == companion) {
            kept.push((route.to_string(), companion));
        }
    }

    pub(crate) fn companions(&self, walk: &str, route: &str) -> Vec<String> {
        self.2.locked().get(walk).into_iter().flatten()
            .filter(|(primary, _)| primary == route).map(|(_, other)| other.clone()).collect()
    }
}

/// One of the site's own calls the walk saw: a candidate route.
#[derive(Clone, Serialize)]
pub struct Candidate {
    pub index: usize,
    pub method: String,
    pub host: String,
    pub path: String,
    pub status: u16,
    pub bytes: usize,
    /// The top-level keys of the JSON answer, so the owner can tell calls apart.
    pub keys: Vec<String>,
    /// The walk's page itself, rather than a call the page made.
    pub page: bool,
    /// What the answer holds, for the picker: `records` (a list a reader came for), `words` (a list of plain strings
    /// — a search's suggestions), `object`, `text`, `empty`, or `page`.
    pub shape: String,
    /// One of the request's keys is a quoted name in the page's own scripts: the page's code writes it, so a route on
    /// this call can compute the value in the sandbox instead of asking the browser.
    pub writes: bool,
}

#[derive(Clone, Serialize)]
pub struct WalkView {
    pub walk: String,
    pub url: String,
    pub site: String,
    pub exchanges: usize,
    pub cookies: usize,
    pub gates: Vec<String>,
    pub candidates: Vec<Candidate>,
}

/// What the node's browser sees while an agent's learn runs, as it happens, for the owner's window. Methods, hosts,
/// paths, statuses and sizes only: never a header, a cookie or a body.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Eye {
    Started { walk: String, url: String, goal: String, agent: String },
    Seen { walk: String, n: usize, method: String, host: String, path: String, status: u16, bytes: usize, sort: &'static str },
    Scored { walk: String, exchanges: usize, candidates: Vec<Scored> },
    Picked { walk: String, index: usize, method: String, host: String, path: String, by: &'static str, reasons: Vec<String> },
    Saved { walk: String, route: String, what: String, site: String, steps: usize, inputs: Vec<String> },
    Failed { walk: String, error: String },
    /// The calls the walk's door took away before any was a candidate (`Trace::door_why`), each with why: a reader of
    /// the learn sees what the walk showed rather than a learn with no candidate and no reason. Assets are counted, not
    /// listed.
    Door { walk: String, took: usize, assets: usize, calls: Vec<Taken> },
    /// A new picture of the page is ready (`GET /owner/frame`): pixels only, fetched by the window.
    Frame(crate::frames::FrameNote),
}

#[derive(Clone, Serialize)]
pub struct Scored {
    pub index: usize,
    pub method: String,
    pub host: String,
    pub path: String,
    pub score: f64,
    pub noise: bool,
}

/// One call the door took: where it went, and why the page that held it there was the door's.
#[derive(Clone, Serialize)]
pub struct Taken {
    pub index: usize,
    pub method: String,
    pub host: String,
    pub path: String,
    pub why: &'static str,
    pub by: usize,
}

/// What the door took from a walk, for the eye: every call but assets, listed (at most 24), assets counted. None
/// when the door took nothing.
fn door_taken(walk: &str, trace: &Trace, site: &str) -> Option<Eye> {
    let door = trace.door_why(site);
    if door.is_empty() {
        return None;
    }
    let (assets, calls): (Vec<&unbrowse_learn::trace::InDoor>, Vec<_>) = door.iter().partition(|d| trace.exchanges[d.index].is_asset());
    Some(Eye::Door {
        walk: walk.to_string(),
        took: door.len(),
        assets: assets.len(),
        calls: calls
            .into_iter()
            .take(24)
            .map(|d| {
                let e = &trace.exchanges[d.index];
                Taken {
                    index: d.index,
                    method: e.method.clone(),
                    host: e.url.host_str().unwrap_or_default().to_string(),
                    path: e.url.path().to_string(),
                    why: d.why.name(),
                    by: d.by,
                }
            })
            .collect(),
    })
}

/// Where the eye's events go. The API hands in the window's emitter; tests hand in nothing.
pub type Sink<'a> = &'a (dyn Fn(Eye) + Sync);

#[cfg(test)]
pub fn no_eye(_: Eye) {}

/// A path without its query: the eye shows where a call went, not the values it carried.
fn bare(path: &str) -> String {
    path.split('?').next().unwrap_or_default().to_string()
}

/// What kind of thing a response is, by where it came in the walk, its type and what it did: the window colours the
/// stream with it. A gate is the walk's door; noise reported the page or answered with nothing, the same calls the
/// rule never picks.
fn sort_of(gate: bool, mime: &str, status: u16, reports: bool) -> &'static str {
    if gate {
        "gate"
    } else if reports || status == 204 {
        "noise"
    } else if mime.contains("json") || unbrowse_learn::route::wire::named(mime).is_some() {
        "data"
    } else if mime.contains("html") {
        "page"
    } else {
        "asset"
    }
}

/// Follows the walk's capture log while the browser is still walking, and reports each response as it lands.
/// The log is the engine's own JSON lines; this reads only the fields the window may see.
fn follow(path: &Path, walk: &str, site: &str, page: Option<&str>, done: &AtomicBool, eye: Sink) {
    let mut methods: HashMap<String, String> = HashMap::new();
    let mut reporting: HashSet<String> = HashSet::new();
    // The door as it happens (`Trace::door`): the main frames' pages open and close it.
    let (mut main, mut pages, mut door) = (None::<String>, HashSet::<String>::new(), false);
    let mut pos = 0u64;
    let mut n = 0usize;
    let mut last = false;
    loop {
        if let Ok(mut f) = std::fs::File::open(path) {
            if f.seek(SeekFrom::Start(pos)).is_ok() {
                let mut r = BufReader::new(f);
                let mut line = String::new();
                while r.read_line(&mut line).unwrap_or(0) > 0 {
                    if !line.ends_with('\n') {
                        break; // half-written; read it whole next pass
                    }
                    pos += line.len() as u64;
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
                        match v.get("type").and_then(|t| t.as_str()) {
                            // A refused walk is tried again in another browser: its first page is a main frame too.
                            Some("mint") => main = None,
                            Some("request") => {
                                let body = v.get("postData").and_then(|b| b.as_str());
                                if let (Some(p), Ok(u)) = (page, url::Url::parse(&s("url"))) {
                                    if reports_the_page(&u, body, p) {
                                        reporting.insert(s("requestId"));
                                    }
                                }
                                if s("resourceType") == "Document" && !s("frameId").is_empty() && s("url").starts_with("http") {
                                    let frame = main.get_or_insert_with(|| s("frameId"));
                                    if *frame == s("frameId") {
                                        pages.insert(s("requestId"));
                                    }
                                }
                                methods.insert(s("requestId"), s("method"));
                            }
                            Some("response") => {
                                // The browser's own internals (chrome://, data:) are not the site.
                                if let Some(u) = url::Url::parse(&s("url")).ok().filter(|u| matches!(u.scheme(), "http" | "https")) {
                                    n += 1;
                                    let host = u.host_str().unwrap_or_default().to_string();
                                    let mime = s("mimeType");
                                    let status = v.get("status").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                                    if pages.contains(&s("requestId")) {
                                        door = !unbrowse_learn::identity::on_site(&host, site) || unbrowse_learn::trace::REFUSED.contains(&status);
                                    }
                                    eye(Eye::Seen {
                                        walk: walk.to_string(),
                                        n,
                                        method: methods.get(&s("requestId")).cloned().unwrap_or_else(|| "GET".into()),
                                        sort: sort_of(door, &mime, status, reporting.contains(&s("requestId"))),
                                        host,
                                        path: u.path().to_string(),
                                        status,
                                        bytes: v.get("body").and_then(|b| b.as_str()).map(|b| b.len()).unwrap_or(0),
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                    line.clear();
                }
            }
        }
        if last {
            return;
        }
        if done.load(Ordering::Relaxed) {
            last = true; // one more pass for what landed as the walk ended
            continue;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
}

/// A page's walk key, stable for the page: the same url names the same walk, so an agent that listed a walk picks
/// from the list it saw instead of a fresh walk whose indexes moved. (A walk's own id, `walk_id`, carries the clock so
/// separate walks of one page don't overwrite each other's capture.)
pub fn walk_key(url: &str) -> String {
    let h = Keccak256::digest(url.trim().as_bytes());
    format!("walk_{}", hex::encode(&h[..6]))
}

pub fn walk_id(url: &str) -> String {
    let h = Keccak256::digest(format!("{url}{}", store::now()).as_bytes());
    hex::encode(&h[..6])
}

/// Walks `url` in the node's own browser (a persistent profile per site, so a check passed once stays passed)
/// and returns the site's calls it saw. Blocking: run it off the UI thread.
#[cfg(test)]
pub fn walk(walks: &Walks, url: &str) -> Result<WalkView, String> {
    walk_as(walks, url, &walk_id(url), "You", &no_eye)
}

/// The candidates a walk already made, as the owner and the agent saw them, without walking again: an agent picks
/// from the list it was shown, not from a fresh walk whose indexes moved.
pub fn view(walks: &Walks, id: &str) -> Option<WalkView> {
    let guard = walks.0.locked();
    let w = guard.get(id)?;
    let host = url::Url::parse(&w.url).ok()?.host_str()?.to_string();
    Some(view_of(id, &w.url, &walked_site(&w.trace.exchanges, &host), &w.trace, 0))
}

/// Keeps candidate `index` (the exchange index a [`WalkView`] names) as a route, named `what`: the agent's pick, with
/// its own words for what the call is.
pub fn keep_candidate(walks: &Walks, walk: &str, index: usize, what: &str, who: &str) -> Result<Route, String> {
    keep_as(walks, walk, index, what, &[], who, true)
}

/// The walk, for `who`, reporting what the browser sees to `eye` as it goes.
pub fn walk_as(walks: &Walks, url: &str, id: &str, who: &str, eye: Sink) -> Result<WalkView, String> {
    walk_read(walks, url, id, who, eye).map_err(|why| why.to_string())
}

/// The same, a walk that failed said as what stood in its way (`walk_failed`).
fn walk_read(walks: &Walks, url: &str, id: &str, who: &str, eye: Sink) -> Result<WalkView, Unlearned> {
    // A public peer never walks a page: a walk launches a browser, whatever `browsers::current` says (UNB-234).
    if crate::remote::public_home() {
        return Err(crate::remote::NEEDS_OWN_NODE.into());
    }
    if let Some(why) = unwalkable(url, &store::load_settings().excluded) {
        return Err(why.into());
    }
    let parsed: url::Url = url.trim().parse().map_err(|e| format!("not a URL: {e}"))?;
    let host = parsed.host_str().ok_or("the URL has no host")?.to_string();
    // A site whose door has just refused this node's browser is rested, not asked again at once: every ask a door
    // refuses makes it surer of the next, and a walk asks in up to four browsers.
    if let Some(left) = REFUSED.locked().get(&site_of(&host)).and_then(|at| rest_left(at.elapsed())) {
        let door = store::known_door(&site_of(&host)).map(|d| format!("; the door is {}", d.said())).unwrap_or_default();
        return Err(Unlearned::Door(format!("the walk failed: {host}'s door refused this node's browser a moment ago, and asking again at once makes a door surer: it is rested for another {} s{door}", left.as_secs()), "learn.rested"));
    }
    crate::browsers::apply();
    let id = id.to_string();
    // The walk's log is read back as what the site said, so it is kept where only the owner can write.
    let capture_dir = unbrowse_files::private::scratch().map_err(|e| format!("the node's scratch folder: {e}"))?.join("walks");
    let _ = unbrowse_files::private::dir_at(&capture_dir);
    let session = format!("learn_{id}");
    // The site's profile opens in one browser at a time: a walk works in a browser already running in it, in a tab of
    // its own, else waits for another walk launched in it to end before launching its own.
    let profile = store::profile_dir(&host);
    // An empty `UNBROWSE_CDP` is no endpoint: the scratch sets it on every run, and an empty string is not a browser
    // address (the engine reads it as one and refuses the walk).
    let mut cdp_endpoint = std::env::var("UNBROWSE_CDP").ok().filter(|s| !s.trim().is_empty()).or_else(|| crate::browse::browser_in(&host, &profile));
    let _profile = cdp_endpoint.is_none().then(|| crate::browse::hold_profile(&profile, &format!("this node's walk of {}", unbrowse_learn::identity::said_address(url))));
    if _profile.is_some() {
        cdp_endpoint = crate::browse::browser_in(&host, &profile);
    }
    let mut mint = BrowserMint {
        try_controls: false,
        // The walk runs in process; a step it falls back to the program for runs the node's own.
        browser: crate::browse::step_program().unwrap_or_else(|| "in-process".into()),
        session: session.clone(),
        capture_dir: capture_dir.clone(),
        profile: Some(profile.to_string_lossy().into_owned()),
        _host: host.clone(),
        user_agent: None,
        cdp_endpoint,
        frames: None,
        // The session the node keeps for the site: what an agent signed in to by browsing, or the owner imported. A
        // session cookie dies with the browser that got it, and a walk often launches a new one (spec §104).
        seed: kept_session(&host),
    };
    let log = capture_dir.join(format!("{session}.jsonl"));
    let done = AtomicBool::new(false);
    let page = page_address(url);
    // Pictures of the walk: the latest is kept per walk, and the window is told one is ready.
    let (frames, pictures) = std::sync::mpsc::channel();
    mint.frames = Some(frames);
    let jar = std::thread::scope(|scope| {
        scope.spawn(|| follow(&log, &id, &site_of(&host), page.as_deref(), &done, eye));
        scope.spawn(|| pictures.into_iter().for_each(|f| eye(Eye::Frame(walks.1.put(&id, f)))));
        let mut jar = mint.mint(&parsed);
        // An interactive door the engine left open in a window is the owner's to pass. The walk waits for them and
        // resumes in that same browser: the accepted session is theirs, and the route is learned from it. A bank with
        // no window never reaches here.
        if let Err(unbrowse_learn::MintError::Browser(said)) = &jar {
            if !crate::browsers::headless_only() {
                if let Some(endpoint) = handoff_endpoint(said) {
                    eprintln!("   [mint] the door is open in a window: pass it; the walk resumes in that browser");
                    std::thread::sleep(HANDOFF_WAIT);
                    mint.cdp_endpoint = Some(endpoint);
                    jar = mint.mint(&parsed);
                }
            }
        }
        mint.frames = None; // the pictures end with the walk
        done.store(true, Ordering::Relaxed);
        jar
    })
    .map_err(|e| {
        // What the browser met, said as a door when it met one: a walk refused at a wall names the wall, so the
        // caller hears which one instead of only "refused". The refusal is in the capture the walk wrote before it
        // stopped; a site this node met before keeps its door when this capture says nothing.
        let walked = site_of(&host);
        let capture = trace_from_walk(&capture_dir, &session);
        let door = capture.as_ref().and_then(|t| unbrowse_learn::graph::Door::met(t, &walked)).or_else(|| store::known_door(&walked));
        let why = match door {
            Some(d) => {
                store::note_door(&walked, &d);
                // A site that has rested is forgotten as the next is noted: the list holds only sites still resting.
                let mut resting = REFUSED.locked();
                resting.retain(|_, at| rest_left(at.elapsed()).is_some());
                // And never more than a bound of them: past it the list starts over, and a site forgotten is asked
                // again once sooner than its rest.
                if resting.len() >= RESTING_SITES_MOST {
                    resting.clear();
                }
                resting.insert(walked.clone(), std::time::Instant::now());
                drop(resting);
                format!("the walk failed: {e}; the door is {}", d.said())
            }
            None => format!("the walk failed: {e}"),
        };
        walk_failed(&e.to_string(), why, capture.as_ref(), url)
    })?;
    // The site let this walk through: whatever it refused before, it is no longer resting.
    REFUSED.locked().remove(&site_of(&host));
    // The browser's answer is the judge of the jar's cookies, even when it holds none.
    if !jar.cookies.is_empty() || jar.judged {
        let before: HashMap<String, String> = store::read_json::<std::collections::BTreeMap<String, String>>(&store::jar_path(&host), &unbrowse_files::JAR).into_iter().collect();
        walked_into_jar(&host, jar.cookies.iter().chain(jar.tokens.iter()).map(|(k, v)| (k.clone(), v.clone())).collect(), jar.domains.iter().map(|(k, v)| (k.clone(), v.clone())).collect());
        // What the walk's browser knew of each cookie beyond its value (its path, whether it is HttpOnly), beside the
        // jar: a call sends each where the browser would, and a page's script is shown only what it would see.
        unbrowse_learn::client::note_cookie_facts(&store::jars_dir(), &host, &jar.facts, &before);
    }
    // What the page had in front of it when its scripts signed (its storages): kept beside the session, so a route
    // learned here signs the same way without a browser (`sandbox::Storage`). A walk that read neither leaves no file.
    let stored = unbrowse_learn::sandbox::Storage { local: jar.local_storage.clone(), session: jar.session_storage.clone() };
    let storage_file = unbrowse_learn::client::storage_path(&store::jars_dir(), &host);
    if stored.local.is_empty() && stored.session.is_empty() {
        let _ = std::fs::remove_file(&storage_file);
    } else {
        let _ = store::write_json(&storage_file, &unbrowse_files::JAR, &stored);
    }
    // What the page's own code saw when it fingerprinted the browser: a signing bridge puts it back in front of the
    // page's scripts, so a producer samples the browser that walked, not a generic one. A page that never looked
    // leaves none.
    let fingerprint_file = unbrowse_learn::client::fingerprint_path(&store::jars_dir(), &host);
    match jar.fingerprint.clone().filter(|v| !v.is_null()) {
        Some(fp) => {
            let _ = store::write_json(&fingerprint_file, &unbrowse_files::JAR, &fp);
        }
        None => {
            let _ = std::fs::remove_file(&fingerprint_file);
        }
    }
    let probes = unbrowse_learn::walk::probes_from_walk(&capture_dir, &session);
    let mut recording = unbrowse_learn::recording::Recording::read(&capture_dir, &session);
    let trace = match &recording {
        Some(rec) => {
            crate::session_held::note_trace(&rec.trace);
            rec.trace.clone()
        }
        None => trace_from_walk(&capture_dir, &session).ok_or("the walk recorded nothing")?.into(),
    };
    // The recording keeps what the page stored as the walk ended, for the page's own origin, where its capture did not:
    // a value a call sends that the page held there is learned as the storage's (`lab::compile::storage_when_called`).
    if let (Some(rec), Ok(page)) = (recording.as_mut(), url::Url::parse(url)) {
        let origin = page.origin().ascii_serialization();
        if (!stored.local.is_empty() || !stored.session.is_empty()) && rec.storage_at("end", &origin).is_none() {
            rec.storage.push(unbrowse_learn::recording::StorageSnapshot {
                at: "end".into(),
                origin,
                local: stored.local.clone().into_iter().collect(),
                session: stored.session.clone().into_iter().collect(),
            });
        }
    }
    let site = walked_site(&trace.exchanges, &host);
    let view = view_of(&id, url, &site, &trace, jar.cookies.len());
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: host,
        what: format!("Walked {url}"),
        kind: "learn".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("{} of the site's calls seen", view.candidates.len())),
    });
    // Where the walk was, as the share guard reads it: a fragment an answer handed the page first is the site's.
    let addresses = unbrowse_learn::walk::owners_addresses_from_walk(&capture_dir, &session);
    // Whether the walk can show where its browser was: a route learned from a walk that can't is shared only when
    // nothing it sends could be the page's own work (`page_made`).
    match &addresses {
        Some(at) => eprintln!("   [walk] {id}: its address record is whole ({} addresses)", at.len()),
        None => eprintln!("   [walk] {id}: its address record is not whole: read as a walk that may have been at an address with a fragment"),
    }
    keep_walk(&mut walks.0.locked(), id.clone(), Walk { url: url.to_string(), trace, probes, recording, at: std::time::Instant::now(), addresses });
    Ok(view)
}

/// How long a site is rested after its door refuses a walk.
const REST_AFTER_REFUSAL: Duration = Duration::from_secs(300);
/// How many sites rest at once.
const RESTING_SITES_MOST: usize = 4096;

/// When each site's door last refused a walk of this node's, while it runs.
static REFUSED: std::sync::LazyLock<Mutex<HashMap<String, std::time::Instant>>> = std::sync::LazyLock::new(Default::default);

/// The site's door was met: its page, seen in the node's browser, no longer asks for anyone. The rest a refusal
/// began ends with it, since the next walk opens in a browser the site has let through.
pub(crate) fn the_door_was_met(site: &str) {
    REFUSED.locked().remove(&site_of(site));
}

/// How much of a site's rest is left, `since` its door refused a walk: None once it has rested.
fn rest_left(since: Duration) -> Option<Duration> {
    REST_AFTER_REFUSAL.checked_sub(since).filter(|left| !left.is_zero())
}

/// Why `url` is never walked, whoever asks: nothing done on a page changes any of these.
fn unwalkable(url: &str, excluded: &[String]) -> Option<String> {
    let parsed: url::Url = match url.trim().parse() {
        Ok(u) => u,
        Err(e) => return Some(format!("not a URL: {e}")),
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Some("only http and https pages can be walked".into());
    }
    let Some(host) = parsed.host_str() else { return Some("the URL has no host".into()) };
    excluded.iter().any(|e| unbrowse_learn::identity::at_or_under(host, e)).then(|| format!("{host} is excluded from mapping in Settings"))
}

/// `host`'s jar after a walk. The jar holds the walk's session: its cookies and the tokens its calls carried in headers.
/// The browser is the truth for cookies, so a name it no longer holds leaves: a session it dropped or the site ended is
/// never sent again. And how far each cookie goes is rewritten beside it, the `Domain` the walk saw the site set a cookie
/// for, so a route's steps on any host of the site send the clearance this walk earned without opening a browser — and a
/// walk that recorded no reach says so, rather than leaving the last one. Only what the walk can't speak for stays
/// (`walk_cant_see`), with its reach.
fn walked_into_jar(host: &str, walked: std::collections::BTreeMap<String, String>, reach: std::collections::BTreeMap<String, String>) {
    use std::collections::BTreeMap;
    let jar: BTreeMap<String, String> = store::read_json(&store::jar_path(host), &unbrowse_files::JAR);
    let old_reach: BTreeMap<String, String> = store::read_json(&store::jar_scope_path(host), &unbrowse_files::JAR);
    let stays = walk_cant_see(host, &jar);
    let mut held: BTreeMap<String, String> = jar.into_iter().filter(|(k, _)| stays.contains(k) && !walked.contains_key(k)).collect();
    let mut scope: BTreeMap<String, String> = old_reach.into_iter().filter(|(k, _)| held.contains_key(k)).collect();
    held.extend(walked);
    scope.extend(reach);
    let _ = store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &held);
    let _ = store::write_json(&store::jar_scope_path(host), &unbrowse_files::JAR, &scope);
}

/// The names in `host`'s jar a browser's word doesn't reach: what its routes mint that isn't a cookie, and a cookie no
/// browser of the node's ever held (`store::JarOnly`) while it is still the one the jar was given and hasn't run out.
/// A cookie a browser once held has no place here: its being gone from the browser is news of it.
fn walk_cant_see(host: &str, jar: &std::collections::BTreeMap<String, String>) -> std::collections::HashSet<String> {
    let only: std::collections::BTreeMap<String, store::JarOnly> = store::read_json(&store::jar_only_path(host), &unbrowse_files::JAR);
    let mut names = header_tokens(host);
    names.extend(only_the_jar_holds(&only, jar, store::now() as f64));
    names
}

/// Of `only`, the cookies the jar still holds as they were given, unexpired at `now`.
fn only_the_jar_holds(only: &std::collections::BTreeMap<String, store::JarOnly>, jar: &std::collections::BTreeMap<String, String>, now: f64) -> Vec<String> {
    only.iter().filter(|(k, o)| o.until > now && jar.get(*k) == Some(&o.value)).map(|(k, _)| k.clone()).collect()
}

fn view_of(id: &str, url: &str, site: &str, trace: &Trace, cookies: usize) -> WalkView {
    let gates = trace.gates(site);
    let door = trace.door(site);
    // The names the page's own scripts write, read once at index time. A request key among them whose value the walk
    // cannot source is the page's code's: a route on that call computes it in the sandbox, so the picker can see which
    // calls the browserless path can close. Both halves are needed: a script writes `id` in its own code and every
    // answer carries ids, but only one the walk cannot source came from the script.
    let written = written_names(trace);
    let key = |loc: &unbrowse_learn::slots::Loc| match loc {
        unbrowse_learn::slots::Loc::Header(h) => Some(h.clone()),
        unbrowse_learn::slots::Loc::Query(q) => Some(q.clone()),
        unbrowse_learn::slots::Loc::Json(p) => p.rsplit('/').next().map(|k| k.replace("~1", "/").replace("~0", "~")),
        _ => None,
    };
    // Each answer's values are read once for the whole list, as a graph build reads them: without it every value of
    // every candidate read every answer of the walk again, and a busy page's walk (hundreds of calls, megabytes of
    // answers) spent minutes here while the ask that waited on it timed out.
    let _memo = unbrowse_learn::provenance::Memo::start();
    let mut candidates = trace
        .exchanges
        .iter()
        .enumerate()
        .filter(|(i, e)| !door.contains(i) && is_candidate(e, site))
        .map(|(index, e)| {
            let mut c = candidate(index, e);
            // Only the values under a name the page's scripts write are asked where they came from: sourcing one reads
            // the whole walk, and the rest of the call's values change nothing here.
            let written_here = |loc: &unbrowse_learn::slots::Loc| key(loc).is_some_and(|k| written.contains(&k));
            c.writes = !unbrowse_learn::graph::unsourced_among(trace, index, Some(&c.host), written_here).is_empty();
            c
        })
        .collect::<Vec<Candidate>>();
    candidates.sort_by_key(|c| (!unbrowse_learn::identity::on_site(&c.host, site), std::cmp::Reverse(c.bytes)));
    WalkView { walk: id.to_string(), url: url.to_string(), site: site.to_string(), exchanges: trace.exchanges.len(), cookies, gates, candidates }
}

/// The goal's words that ask for something, without the site's own name: every call of a site may carry its name, and a
/// path that spells it (`/mysql`) earns the points a search's path earns. "search MySQL site" asks for the search.
fn goal_words_of(goal: &str, site: &str) -> Vec<String> {
    let labels: Vec<String> = site.split('.').map(|p| p.to_lowercase()).filter(|p| p != "www" && p != "com" && !p.is_empty()).collect();
    words(goal).into_iter().filter(|w| !labels.iter().any(|l| l == w)).collect()
}

/// What a call answers with as data: a page's is the state embedded in it, never its markup and scripts (an app
/// shell is hundreds of KB of HTML that holds nothing the page shows).
fn answer_of(e: &Exchange) -> std::borrow::Cow<'_, str> {
    let body = e.response_body.as_deref().unwrap_or_default();
    if e.resource_type.as_deref() == Some("Document") || e.response_mime.contains("html") {
        // A page's answer is the state it embeds, or — when it embeds none — what it renders: its title, text and links.
        // A server-rendered search has no state at all, and read as empty it lost to a suggestion call beside it
        // (itch.io's `/autocomplete` over `/search?q=`, whose results are all in its HTML).
        return match unbrowse_learn::trace::embedded_json(body) {
            Some(state) if !state.trim().is_empty() => state.into(),
            _ => unbrowse_learn::page::read(body, &e.url).to_string().into(),
        };
    }
    body.into()
}

/// What the answer holds, from its own shape, looking through whatever wraps it: a stream's events, a call's
/// envelope (`{"data": {...}}`), a result's own fields. The longest list of objects with fields is the records a
/// reader came for; failing that, the longest list of strings is words (a search's suggestions say the query back but
/// carry no record); an empty list is nothing; anything else is an object. The picker reads this instead of guessing
/// from the path, and it must see a streamed answer as records rather than as its envelope.
fn answer_shape(page: bool, parsed: Option<&serde_json::Value>, answer: &str) -> String {
    if page {
        return "page".into();
    }
    let Some(v) = parsed else {
        return if answer.trim().is_empty() { "empty".into() } else { "text".into() };
    };
    fn walk(v: &serde_json::Value, depth: usize, records: &mut usize, words: &mut usize, empty: &mut bool) {
        match v {
            serde_json::Value::Array(items) => {
                if items.is_empty() {
                    *empty = true;
                } else {
                    let with_fields = items.iter().filter(|i| i.as_object().is_some_and(|o| o.len() >= 2)).count();
                    let strings = items.iter().filter(|i| i.is_string()).count();
                    if with_fields * 2 >= items.len() {
                        *records = (*records).max(items.len());
                    } else if strings * 2 >= items.len() {
                        *words = (*words).max(items.len());
                    }
                }
                if depth < 6 {
                    for i in items.iter().take(50) {
                        walk(i, depth + 1, records, words, empty);
                    }
                }
            }
            serde_json::Value::Object(o) if depth < 6 => {
                for x in o.values() {
                    walk(x, depth + 1, records, words, empty);
                }
            }
            _ => {}
        }
    }
    let (mut records, mut words, mut empty) = (0usize, 0usize, false);
    walk(v, 0, &mut records, &mut words, &mut empty);
    if records > 0 {
        "records".into()
    } else if words > 0 {
        "words".into()
    } else if empty {
        "empty".into()
    } else {
        "object".into()
    }
}

/// Every name the page's own code writes as a quoted string — a header, query or JSON key its scripts set. The
/// request keys in this set are values the page computes, so a route on such a call can compute them in the sandbox:
/// this is the slice the route will carry, read at index time so the picker can see it.
fn written_names(trace: &Trace) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for e in trace.exchanges.iter().filter(|e| e.resource_type.as_deref() == Some("Script") || e.response_mime.contains("javascript")) {
        let Some(body) = e.response_body.as_deref() else { continue };
        let bytes = body.as_bytes();
        let mut at = 0;
        while at < bytes.len() {
            let quote = bytes[at];
            if quote != b'"' && quote != b'\'' {
                at += 1;
                continue;
            }
            let start = at + 1;
            let end = bytes[start..].iter().position(|&b| b == quote).map(|p| start + p).unwrap_or(bytes.len());
            let name = &body[start..end];
            if !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_alphanumeric() || "_-./[]:".contains(c)) {
                out.insert(name.to_string());
            }
            at = end + 1;
        }
    }
    out
}

fn candidate(index: usize, e: &Exchange) -> Candidate {
    // A stream of events is a call like any other: its keys are the last event's, which is the one that carries the
    // answer (a search's list arrives after its head).
    let parsed = e.json_body();
    let page = e.resource_type.as_deref() == Some("Document");
    let shape = answer_shape(page, parsed.as_ref(), &answer_of(e));
    let keys = parsed
        .map(|v| match v {
            serde_json::Value::Object(m) => m.keys().take(8).cloned().collect(),
            serde_json::Value::Array(a) => a
                .iter()
                .rev()
                .find_map(|v| v.as_object().map(|m| m.keys().take(8).cloned().collect()))
                .unwrap_or_else(|| vec![format!("{} events", a.len())]),
            _ => Vec::new(),
        })
        .unwrap_or_default();
    Candidate {
        index,
        method: e.method.clone(),
        host: e.url.host_str().unwrap_or_default().to_string(),
        path: match e.url.query() {
            Some(q) => format!("{}?{q}", e.url.path()),
            None => e.url.path().to_string(),
        },
        status: e.status,
        bytes: answer_of(e).len(),
        keys,
        page,
        shape,
        writes: false,
    }
}

/// Whether a call sends something the agent typed: the call that typing set off, however little it answers with.
fn carries(e: &Exchange, typed: &[String]) -> bool {
    let body = e.request_body.as_deref().unwrap_or_default();
    typed.iter().any(|t| carries_text(e.url.as_str(), t) || carries_text(body, t))
}

/// A third-party, empty-answer POST at its root reports an event rather than
/// supplying data for the page. This also catches opaque text bodies that the
/// JSON telemetry detector cannot parse.
fn empty_third_party_event(e: &Exchange, site: &str) -> bool {
    e.method == "POST"
        && e.url.path() == "/"
        && !unbrowse_learn::identity::on_site(e.url.host_str().unwrap_or_default(), site)
        && e.response_mime.starts_with("text/plain")
        && e.response_body.as_deref().is_none_or(|b| b.trim().is_empty())
}

fn reports_an_event(e: &Exchange, site: &str) -> bool {
    let request: Option<serde_json::Value> =
        e.request_body.as_deref().and_then(|b| serde_json::from_str(b).ok());
    empty_third_party_event(e, site)
        || unbrowse_learn::verify::telemetry_endpoint(&e.url, request.as_ref(), None)
}

/// The page's own data: the site's page itself, and every call that answered with data, wherever its backend lives
/// (many sites keep their API on another domain: hn.algolia.com searches through algolia.net). Never an asset or an
/// empty answer; the walk's door is left out before this.
///
/// A call that gates access (a puzzle, an interstitial) or that reports the page rather than answering it (an
/// analytics beacon, a consent check) is not the page's data however much it answers with: the first is what the
/// site asked the browser to solve, the second is about the page and not for the reader.
/// The reading of the walk's ciphered or obfuscated replies: for each call of the walk's own site whose reply no
/// standard reader reads (`own_json` is None) and whose sender the recording names (a script of the page read it),
/// the raw reply body mapped to the JSON the page's own code unpacks it into (`slice::assemble_decoder`,
/// `generated::decode`). A property of the walk: the call's own sender, run over the call's own reply. Empty when the
/// walk kept no recording, no runtime is on the machine, or no reply needs it — a walk with none pays nothing beyond
/// one `own_json` a call. The decoder is kept on the route only where two walks bear it out (`lab::Lab::decoder`);
/// this reading is what lets recognition see the ciphered call as an answer at all, on one walk.
fn decoded_overlay_of(trace: &Trace, recording: Option<&unbrowse_learn::recording::Recording>, site: &str) -> Vec<String> {
    decoded_overlay_of_for(trace, recording, site, &unbrowse_learn::sandbox::available)
}

/// Whether `e` is a call of the walk's own site whose reply the page's own code may have unpacked: a reply no standard
/// reader reads, to a data call a script made rather than a resource the browser consumed or markup
/// (`Exchange::could_be_unpacked_by_the_page`). Asked of the walk alone: what a learn decodes, and what it says is
/// left to page code where no runtime can be held, are the same calls. The recording's sender is asked after this.
fn page_code_may_unpack(e: &Exchange, site: &str) -> bool {
    e.response_body.as_deref().is_some_and(|body| {
        !body.trim().is_empty()
            && unbrowse_learn::identity::on_site(e.url.host_str().unwrap_or_default(), site)
            && !unbrowse_learn::trace::reads_by_a_standard_reader(body)
            && e.could_be_unpacked_by_the_page()
    })
}

/// [`decoded_overlay_of`], with whether this machine can run page code given (`held`). It is asked only once the walk
/// shows a reply a script sent that the page's code may have unpacked, and at most once: a walk with none, the ordinary
/// page, starts no child process for it.
fn decoded_overlay_of_for(trace: &Trace, recording: Option<&unbrowse_learn::recording::Recording>, site: &str, held: &dyn Fn() -> bool) -> Vec<String> {
    let mut programs: Vec<String> = Vec::new();
    let Some(rec) = recording else { return programs };
    let mut seen_scripts: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut runs: Option<bool> = None;
    for e in &trace.exchanges {
        // Only a reply no standard reader reads, to a data call a page script sent (and so read): a page, a resource the
        // browser loaded or a plain JSON answer is read as it stands, and a reply nothing in the page fetched is not the
        // page's to decode.
        if !page_code_may_unpack(e, site) {
            continue;
        }
        let Some((script, _)) = rec.sent_by_value(&e.method, e.url.as_str()) else { continue };
        if !seen_scripts.insert(script.url.clone()) {
            continue;
        }
        if !*runs.get_or_insert_with(held) {
            return programs;
        }
        // The one script that sent (and so read) the call is run, not the page's whole bundle (a browser-internal
        // script among the rest would throw and take the decoder with it): its own code holds the decoder.
        let Some(body_js) = script.sha256.as_deref().and_then(|sha| rec.body(sha)) else { continue };
        if let Some(prog) = unbrowse_learn::slice::assemble_decoder(&[(script.url.as_str(), &String::from_utf8_lossy(body_js))]) {
            programs.push(prog);
        }
    }
    programs
}

/// Whether the walk holds a reply only the page's own code reads, left unread because this machine runs no page code
/// (`sandbox::unheld`): a call of the walk's own site whose reply no standard reader reads, not a page, that a script of
/// the page sent and so read (the same calls `decoded_overlay_of` decodes where a runtime can be held). Why such a
/// learn found no answer is the runtime, not the page needing hands.
fn left_to_page_code(trace: &Trace, recording: Option<&unbrowse_learn::recording::Recording>, site: &str) -> Option<unbrowse_learn::sandbox::Unheld> {
    left_to_page_code_for(trace, recording, site, unbrowse_learn::sandbox::unheld())
}

/// [`left_to_page_code`], with why this machine runs no page code given (`unheld`: None where it runs it).
fn left_to_page_code_for(trace: &Trace, recording: Option<&unbrowse_learn::recording::Recording>, site: &str, unheld: Option<unbrowse_learn::sandbox::Unheld>) -> Option<unbrowse_learn::sandbox::Unheld> {
    let why = unheld?;
    let rec = recording?;
    trace
        .exchanges
        .iter()
        .any(|e| page_code_may_unpack(e, site) && rec.sent_by_value(&e.method, e.url.as_str()).is_some())
        .then_some(why)
}

fn is_candidate(e: &Exchange, site: &str) -> bool {
    let host = e.url.host_str().unwrap_or_default();
    // A refusal, a redirect, nothing, or an error said in the site's words answers nothing (`answer::not_an_answer`).
    if e.is_asset() || unbrowse_learn::answer::not_an_answer(e, false).is_some() {
        return false;
    }
    let html = e.resource_type.as_deref() == Some("Document") || e.response_mime.contains("html");
    let document = html && unbrowse_learn::identity::on_site(host, site);
    if !document {
        if reports_an_event(e, site) {
            return false;
        }
        // A call that gates access is the puzzle the site set, and one that
        // reports the page rather than answering it is about the page, not for
        // the reader. Neither is the page's data.
        let answer = e.json_body().unwrap_or_default();
        if unbrowse_learn::verify::challenge_response(&e.url, &answer) {
            return false;
        }
    }
    // Data is data however it is sent: a search that streams its results as events of JSON (`text/event-stream`), or one
    // read back inside the name its own address gave it, or one whose whole body is the data encoded again as text, answers
    // with them as much as one that sends them at once (`Exchange::own_json` reads them all).
    let json = e.response_mime.contains("json") || e.response_body.as_deref().is_some_and(|b| b.trim_start().starts_with(['{', '['])) || e.own_json().is_some();
    // And it answers in a form the route's call can read back (`RouteClient`): JSON, events of it, a page's state, or text
    // the site serves as data. One read as none of them (chunks of markup joined by a separator) would answer every
    // call with nothing it can read, however big it was on the walk.
    let body = e.response_body.as_deref().unwrap_or_default();
    let readable = || e.json_body().is_some() || unbrowse_learn::answer::text_answer(e.response_header("content-type").unwrap_or(&e.response_mime), body).is_some();
    document || (json && body.len() > 64 && readable())
}

/// The values the owner asked the page for: the walked URL's query (`?q=rust` makes `q` an input) and its fragment
/// where that is written as one (`#q=rust`, `trace::asked_pairs`), plus any the owner names. Everything else the call sends is traced to its source, or kept as a constant.
///
/// However short: a guest count (`adults=2`) is asked for as much as a city is, and kept as a constant it would make
/// every other count a page the route can't do. A value that short binds only where a call sends it under the same
/// key (`slots::bound_by_key`), so another call's `version=2` is never taken for it.
///
/// A value only the fragment carried never reached a server in the address: one the walk (`walked`) then uses as a
/// credential (`trace::fragment_credential`) is a secret input, so its walked value is never the route's default and
/// never rides with the route (`withhold_secrets`).
pub fn walk_inputs(url: &str, extra: &[(String, String)], walked: &[Exchange]) -> Vec<Input> {
    let mut out: Vec<Input> = url::Url::parse(url)
        .map(|u| {
            let query: Vec<String> = u.query_pairs().map(|(k, _)| k.into_owned()).collect();
            let fragment = unbrowse_learn::trace::fragment_pairs(&u);
            unbrowse_learn::trace::asked_pairs(&u)
                .into_iter()
                .filter(|(k, v)| !k.is_empty() && !v.is_empty())
                .map(|(k, v)| {
                    let only_in_the_fragment = !query.contains(&k) && fragment.iter().any(|(fk, fv)| *fk == k && *fv == v);
                    if only_in_the_fragment && unbrowse_learn::trace::fragment_credential(&v, walked) { Input::secret(&k, &v) } else { Input::new(&k, &v) }
                })
                .collect()
        })
        .unwrap_or_default();
    for (k, v) in extra {
        if !k.trim().is_empty() && !v.is_empty() && !out.iter().any(|i| i.name == *k) {
            out.push(Input::new(k.trim(), v));
        }
    }
    out
}

/// The values of `walk_inputs` a call can be judged by: what the page was asked for, less a value too short to say
/// anything by itself (`slots::bound_by_key`). Any call may send a `2` or a `true`; sending one says nothing of whether
/// it answers the page, though the route still binds it where a call sends it under its own key.
fn asked_values(url: &str, extra: &[(String, String)]) -> Vec<String> {
    walk_inputs(url, extra, &[]).into_iter().map(|i| i.value).filter(|v| !unbrowse_learn::slots::bound_by_key(v)).collect()
}

/// The caller's values that live in the URL's path rather than its query (`/search/iphone%2015/` searches for
/// "iphone 15"). Clef, the decision model, judges each piece when a key is configured; otherwise the walk does: the
/// page hands a value it was asked for on to its own calls as a value (`?query=iphone 15`, `{"keyword":"ipad"}`),
/// where the site's own route words stay route words, and a piece with a space in it is never a route word. Either
/// way, a piece the page hands on to a call whose answer says it back is the caller's (`said_back`). Each is named for
/// the path word before it, or for its place when that word is a caller's value too.
pub fn path_inputs(url: &str, goal: &str, trace: &Trace) -> (Vec<(String, String)>, &'static str) {
    let (found, by) = path_inputs_read(url, goal, trace);
    // A piece the page's own form submits to is the form's address (`controls::form_address_pieces`): the walked
    // page says so in its markup, and it is noted as the site's own word is.
    if !found.is_empty() {
        if let Ok(page) = url::Url::parse(url) {
            let written: Vec<String> = trace
                .exchanges
                .iter()
                .filter(|e| e.is_main_document() && (200..300).contains(&e.status) && e.url.path() == page.path())
                .filter_map(|e| e.response_body.as_deref())
                .flat_map(|html| unbrowse_learn::controls::form_address_pieces(html, &page))
                .collect();
            if found.iter().any(|(_, value)| written.contains(&value.to_lowercase())) {
                eprintln!("   [path] {} of the path the page's own form submits to: its address, not the caller's", written.join(", "));
                note_address(url, &written);
            }
            // And a piece most of the page's own links carry in the same place is where the site lives
            // (`controls::link_address_pieces`): a language, a region, a section.
            let lives: Vec<String> = trace
                .exchanges
                .iter()
                .filter(|e| e.is_main_document() && (200..300).contains(&e.status) && e.url.path() == page.path())
                .filter_map(|e| e.response_body.as_deref())
                .flat_map(|html| unbrowse_learn::controls::link_address_pieces(html, &page))
                .map(|(_, piece)| piece)
                .collect();
            // Never the only thing the page was asked: a profile's own name leads most of its links too
            // (`/someone/` and `/someone/projects`), and there the name is what the caller came for. Something else
            // asked, in the path or the query, has to remain.
            let asked_besides = found.iter().any(|(_, value)| !lives.contains(&value.to_lowercase())) || page.query_pairs().any(|(_, v)| a_word(&v));
            if asked_besides && found.iter().any(|(_, value)| lives.contains(&value.to_lowercase())) {
                eprintln!("   [path] {} of the path the page's own links all carry: where the site lives, not the caller's", lives.join(", "));
                note_address(url, &lives);
            }
        }
    }
    // A piece the site itself has said is its address (`note_address`) is no value, whatever one walk suggests.
    let site = url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)).unwrap_or_default();
    let known = ADDRESS_WORDS.locked().get(&site).cloned().unwrap_or_default();
    if known.is_empty() || !found.iter().any(|(_, value)| known.contains(&value.to_lowercase())) {
        return (found, by);
    }
    let segments: Vec<String> = url::Url::parse(url).ok().and_then(|u| u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect())).unwrap_or_default();
    let kept = found
        .into_iter()
        .filter(|(_, value)| !known.contains(&value.to_lowercase()))
        .map(|(name, value)| {
            // Named for its place because the word before it was taken for a value too: named for that word now.
            let before = segments.iter().position(|p| p.eq_ignore_ascii_case(&value)).and_then(|at| at.checked_sub(1)).map(|at| segments[at].to_lowercase());
            match before {
                Some(word) if name.starts_with("part") && known.contains(&word) => (word.replace('-', "_"), value),
                _ => (name, value),
            }
        })
        .collect();
    (kept, by)
}

/// The words of each site's page addresses, as the site itself answered when asked (`trial::of_the_address`): a
/// page asked for without one is no page at all. Kept while the node runs, so every later reading of that site's
/// addresses, in the learner and in the route builder, agrees with the site.
static ADDRESS_WORDS: std::sync::LazyLock<Mutex<HashMap<String, HashSet<String>>>> = std::sync::LazyLock::new(Default::default);

/// Notes that `words` are part of `url`'s site's page addresses.
pub(crate) fn note_address(url: &str, words: &[String]) {
    let Some(site) = url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)) else { return };
    let mut known = ADDRESS_WORDS.locked();
    // What is kept is what the site can be asked again: past its bounds the oldest reading is no better than a new
    // one, so the list starts over rather than grow with every site and word a caller names.
    if known.len() >= ADDRESS_SITES_MOST && !known.contains_key(&site) {
        known.clear();
    }
    let of_the_site = known.entry(site).or_default();
    for word in words {
        if of_the_site.len() >= ADDRESS_WORDS_A_SITE_MOST {
            break;
        }
        of_the_site.insert(word.to_lowercase());
    }
}

/// How many sites' address words are kept at once, and how many words of one site.
const ADDRESS_SITES_MOST: usize = 2048;
const ADDRESS_WORDS_A_SITE_MOST: usize = 64;

/// Whether a value a call sends is `piece`, or is JSON holding `piece` as one of its own values (a query's
/// `variables={"query":"climate","start":1}`): a field written inside a field is still a field, and a word that is
/// the whole of one was put there, not found there by chance.
fn holds_as_a_value(sent: &str, piece: &str) -> bool {
    if sent.eq_ignore_ascii_case(piece) {
        return true;
    }
    let within = sent.trim_start();
    (within.starts_with('{') || within.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(sent).is_ok_and(|json| unbrowse_learn::slots::json_leaves(&json).iter().any(|(_, v)| v.eq_ignore_ascii_case(piece)))
}

/// What a page's document names itself: the text of its `<title>`.
fn title_of(html: &str) -> Option<String> {
    let low = html.to_ascii_lowercase();
    let open = low.find("<title")?;
    let from = open + low[open..].find('>')? + 1;
    let to = from + low[from..].find("</title")?;
    Some(html[from..to].trim().to_string()).filter(|t| !t.is_empty())
}

fn path_inputs_read(url: &str, goal: &str, trace: &Trace) -> (Vec<(String, String)>, &'static str) {
    let Ok(u) = url::Url::parse(url) else { return (Vec::new(), "the rule") };
    let mut segs: Vec<String> = u
        .path_segments()
        .map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect())
        .unwrap_or_default();
    let site = walked_site(&trace.exchanges, u.host_str().unwrap_or_default());
    let address = page_address(url).unwrap_or_default();
    // The calls that answer the page with data: an ack (`{}`), a beacon or a call reporting the page itself (its
    // address, and what the address holds, carried along) isn't the page asking its backend for what it was asked.
    let answering: Vec<&Exchange> =
        trace.exchanges.iter().filter(|e| is_candidate(e, &site) && !reports_the_page(&e.url, e.request_body.as_deref(), &address)).collect();
    // A piece written the way a form writes (`coffee+shops`) is what was asked, spaces and all, where a call the page
    // made sends it so (`q=coffee shops`): the caller's value is the spaced one, which the call sends.
    let sent_as_a_value = |v: &str| {
        answering.iter().any(|e| {
            unbrowse_learn::slots::slots(e)
                .iter()
                .any(|s| !matches!(s.loc, unbrowse_learn::Loc::Path(_) | unbrowse_learn::Loc::Header(_) | unbrowse_learn::Loc::Cookie(_)) && s.value.eq_ignore_ascii_case(v))
        })
    };
    for s in segs.iter_mut() {
        if let Some(spaced) = unbrowse_learn::slots::plus_spaced(s).filter(|p| sent_as_a_value(p)) {
            *s = spaced;
        }
    }
    // A piece the site wraps in marks of its own (`/search/chicken-`) holds the word that was asked where the page
    // it answered with names itself by that word: the page's title says the piece without its marks. The value is
    // the word; the marks stay the address's.
    let titled: Vec<String> = trace
        .exchanges
        .iter()
        .filter(|e| e.is_main_document() && e.url.path() == u.path() && e.url.host_str() == u.host_str() && (200..300).contains(&e.status))
        .filter_map(|e| title_of(e.response_body.as_deref().unwrap_or_default()))
        .map(|t| t.to_lowercase())
        .collect();
    let mut worded = std::collections::BTreeSet::new();
    for (i, s) in segs.iter_mut().enumerate() {
        let core = s.trim_matches(|c: char| !c.is_alphanumeric()).to_string();
        if core.chars().count() >= 2 && core != *s && !wants_one(goal) && titled.iter().any(|t| unbrowse_learn::trace::carries_whole(t, &core)) {
            *s = core;
            worded.insert(i);
        }
    }
    let pieces: Vec<(usize, &String)> = segs.iter().enumerate().filter(|(_, s)| s.len() >= 2).collect();
    let mut said = said_back(&segs, &answering);
    said.extend(worded);
    let named = |at: &std::collections::BTreeSet<usize>| -> Vec<(String, String)> {
        at.iter()
            .map(|&i| {
                let name = match i.checked_sub(1).filter(|j| !at.contains(j)).map(|j| segs[j].to_lowercase()) {
                    Some(prev) if !prev.is_empty() && prev.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => prev.replace('-', "_"),
                    _ => format!("part{i}"),
                };
                (name, segs[i].clone())
            })
            .collect()
    };
    if let Some(judge) = clef() {
        let texts: Vec<String> = pieces.iter().map(|(_, s)| s.to_string()).collect();
        if let Some(scores) = judge.ask_inputs(goal, url, &texts) {
            let mut at: std::collections::BTreeSet<usize> = pieces.iter().zip(scores).filter(|(_, p)| *p >= 0.7).map(|((i, _), _)| *i).collect();
            at.extend(&said);
            return (named(&at), "the decision model");
        }
    }
    let handed_on = |piece: &str| {
        answering.iter().any(|e| {
            unbrowse_learn::slots::slots(e)
                .iter()
                .any(|s| !matches!(s.loc, unbrowse_learn::Loc::Path(_) | unbrowse_learn::Loc::Header(_)) && holds_as_a_value(&s.value, piece))
        })
    };
    let setting = address_setting;
    let asked_for = |s: &str| goal.to_lowercase().split(|c: char| !c.is_alphanumeric()).any(|w| w == s.to_lowercase());
    let mut at: std::collections::BTreeSet<usize> = pieces
        .iter()
        .filter(|(_, s)| s.contains(' ') || (handed_on(s) && (!setting(s) || asked_for(s))))
        .map(|(i, _)| *i)
        .collect();
    at.extend(&said);
    // A goal for one thing, on a page that names it under a collection (`/prices/bitcoin`), is asked of every page
    // of the collection: the thing is an input, and a call that reads it from the page (`BTCUSD` in the bitcoin
    // page) reads it from each page in its place. A call that never depends on it ignores it.
    // Only for a page people read: an address that answers with data itself is the call, and its pieces are inputs
    // only where its answer says them back.
    let a_page = trace.exchanges.iter().any(|e| e.url.path() == u.path() && e.url.host_str() == u.host_str() && e.response_mime.contains("html"));
    if a_page && !goal.trim().is_empty() && wants_one(goal) && segs.iter().filter(|s| !s.is_empty()).count() >= 2 {
        if let Some((i, _)) = segs.iter().enumerate().rev().find(|(_, s)| !s.is_empty()) {
            at.insert(i);
        }
    }
    (named(&at), "the rule")
}

/// A path piece the site's own calls carry as a *setting* rather than as the caller's word: a language (`en`,
/// `en-GB`), a region, a version (`v2`). Huawei's `/en/searchresult?keyword=…` bound `en` as the caller's value, and
/// the picker then kept a labels call that "sends the page's en" over the search itself.
fn address_setting(piece: &str) -> bool {
    let low = piece.to_ascii_lowercase();
    let lang = |p: &str| p.len() == 2 && p.chars().all(|c| c.is_ascii_alphabetic());
    // A language alone (`en`), a language and a region (`en-gb`, `pt-br`, `zh-cn`), or a version (`v2`). Three letters
    // are a word (`new-york` starts with one), so they are never read as a setting.
    let region = |p: &str| {
        let mut it = p.splitn(2, '-');
        it.next().is_some_and(lang) && it.next().is_some_and(|r| (2..=4).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric()))
    };
    lang(&low) || region(&low) || (low.starts_with('v') && low.len() > 1 && low[1..].chars().all(|c| c.is_ascii_digit()))
}

/// What a page names as its subject, for a goal for one thing (`learn::named_things`): checked against an answer
/// before a route learned on another page of the collection answers this one.
pub fn subject_of(page: &str, goal: &str) -> Vec<String> {
    named_things(page, goal).0
}

/// Whether a call's data names any of `subject`, at the start of a word.
pub fn data_names(data: &serde_json::Value, subject: &[String]) -> bool {
    let text = data.to_string().to_lowercase();
    subject.iter().any(|t| names_it(&text, t))
}

/// The pieces of a page's path that a call answering it carries, in any place, and whose answer says back as one of
/// its own values: what the page is about (a package, a repository's owner and name), which the next page of the
/// same kind asks about in its place. A site's own route words (`repos`, `downloads`, `api`) are carried too, but an
/// answer never says them back. A value said back whole may span pieces (`@scope/name`, `owner/repo`), and a piece may
/// join values said back one by one (`2024-01-01:2024-06-30`).
fn said_back(segs: &[String], answering: &[&Exchange]) -> std::collections::BTreeSet<usize> {
    let mut out = std::collections::BTreeSet::new();
    for e in answering {
        let Some(answer) = e.json_body() else { continue };
        let leaves: Vec<String> = unbrowse_learn::slots::json_leaves(&answer).into_iter().map(|(_, v)| v.to_lowercase()).filter(|v| v.len() >= 2).collect();
        if leaves.is_empty() {
            continue;
        }
        let sent: Vec<String> = unbrowse_learn::slots::slots(e).into_iter().filter(|s| !matches!(s.loc, unbrowse_learn::Loc::Header(_) | unbrowse_learn::Loc::Cookie(_))).map(|s| s.value.to_lowercase()).collect();
        // The page's whole path handed on as one value (`path=/search`, an ad slot naming where it shows) is the
        // page's address, not a value read off it: its pieces are carried only by values of their own.
        let address = segs.iter().filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect::<Vec<_>>().join("/");
        let carried = |v: &str| sent.iter().filter(|s| !(s.contains('/') && s.trim_matches('/') == address)).any(|s| s == v || s.split('/').any(|p| p == v));
        let is_leaf = |v: &str| leaves.iter().any(|l| l == v);
        for (i, seg) in segs.iter().enumerate() {
            let piece = seg.to_lowercase();
            if piece.len() < 2 || !carried(&piece) {
                continue;
            }
            let whole = is_leaf(&piece);
            let joined = piece.contains([':', ',']) && piece.split([':', ',']).all(|p| p.len() >= 2 && is_leaf(p));
            let spans = (0..=i).any(|a| (i..segs.len()).any(|b| b > a && is_leaf(&segs[a..=b].join("/").to_lowercase())));
            if whole || joined || spans {
                out.insert(i);
            }
        }
    }
    out
}

/// The pages of `url`'s site where `goal` was learned before, other than `url` itself.
fn pages_learned_for(url: &str, goal: &str) -> Vec<String> {
    let said = unbrowse_learn::goal::words(goal);
    let site = url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of));
    store::load_routes()
        .into_iter()
        .filter(|r| !said.is_empty() && unbrowse_learn::goal::words(&r.what) == said && r.root != url)
        .filter(|r| url::Url::parse(&r.root).ok().and_then(|u| u.host_str().map(site_of)) == site)
        .map(|r| r.root)
        .collect()
}

/// The pieces of `url`'s path that are the caller's: those `found` holds, and those where the page differs from
/// `others`, pages on its host with as many pieces where the same goal was learned before. Two pages that do one goal
/// differ just where they were asked for different things (the item, its name) and agree on the site's own route
/// words. Each is named for the route word before it, or for its place when an input stands there.
pub fn with_other_pages(url: &str, found: Vec<(String, String)>, others: &[String]) -> Vec<(String, String)> {
    let Ok(u) = url::Url::parse(url) else { return found };
    let pieces = |u: &url::Url| -> Vec<String> {
        u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default()
    };
    let segs = pieces(&u);
    let mut differ = std::collections::BTreeSet::new();
    for other in others.iter().filter_map(|o| url::Url::parse(o).ok()).filter(|o| o.host_str() == u.host_str()) {
        let theirs = pieces(&other);
        if theirs.len() == segs.len() {
            differ.extend((0..segs.len()).filter(|&i| segs[i].len() >= 2 && segs[i] != theirs[i]));
        }
    }
    let mut at: std::collections::BTreeSet<usize> = (0..segs.len()).filter(|&i| found.iter().any(|(_, v)| *v == segs[i] || unbrowse_learn::slots::piece_holds(&segs[i], v))).collect();
    if differ.is_subset(&at) {
        return found;
    }
    at.extend(differ);
    let named = |i: usize| match i.checked_sub(1).filter(|j| !at.contains(j)).map(|j| segs[j].to_lowercase()) {
        Some(word) if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') => word.replace('-', "_"),
        _ => format!("part{i}"),
    };
    at.iter().map(|&i| (named(i), segs[i].clone())).collect()
}

/// Clef, the decision model, when this machine has a key for it: `TYPESAFE_API_KEY`, else the Keychain item
/// `network.unbrowse.clef` / `api-key` (add it with `security add-generic-password -s network.unbrowse.clef -a api-key -w`).
/// A test reads only `TYPESAFE_API_KEY`, never the machine's Keychain: a Mac that holds the owner's key would otherwise
/// put a remote model behind every pick a test checks, the way `store::test_home` keeps a test out of `~/.unbrowse`.
fn clef() -> Option<unbrowse_learn::judge::TypesafeJudge> {
    let key = std::env::var("TYPESAFE_API_KEY").ok().or_else(clef_from_keychain)?;
    Some(unbrowse_learn::judge::TypesafeJudge::new(key.trim()))
}

#[cfg(not(test))]
fn clef_from_keychain() -> Option<String> {
    let item = keyring::Entry::new("network.unbrowse.clef", "api-key").ok()?;
    unbrowse_core::keystore::retrying(|| item.get_password()).ok()
}

#[cfg(test)]
fn clef_from_keychain() -> Option<String> {
    None
}

/// Keeps candidate `index` of a walk as a route named `what`.
#[cfg(test)]
pub fn keep(walks: &Walks, walk: &str, index: usize, what: &str, extra: &[(String, String)]) -> Result<Route, String> {
    keep_as(walks, walk, index, what, extra, "You", false)
}

/// The page's other walks already in memory, as extra sightings for a producer: one walk is a sample of what the page
/// does, and a second may see a header the first saw once. The graph is still the current walk's shape.
fn history_of(walks: &HashMap<String, Walk>, id: &str, url: &str) -> Vec<(Trace, Vec<unbrowse_learn::trace::Probe>)> {
    let Ok(parsed) = url::Url::parse(url) else { return Vec::new() };
    let Some(site) = parsed.host_str().map(site_of) else { return Vec::new() };
    let path = parsed.path().to_string();
    let mut found: Vec<&Walk> = walks
        .iter()
        .filter(|(k, _)| k.as_str() != id)
        .map(|(_, w)| w)
        .filter(|w| {
            let Ok(u) = url::Url::parse(&w.url) else { return false };
            // The same page: its address, or the same address asked for another value in its path (as many pieces,
            // most of them the same). A walk of the page for a second word is a second sighting of its calls.
            let (here, there): (Vec<&str>, Vec<&str>) = (path.split('/').collect(), u.path().split('/').collect());
            let alike = here.len() == there.len() && here.iter().zip(&there).filter(|(a, b)| a == b).count() * 2 >= here.len();
            u.host_str().map(site_of).as_deref() == Some(site.as_str()) && (u.path() == path || alike)
        })
        .collect();
    found.sort_by_key(|w| std::cmp::Reverse(w.at));
    found.truncate(3);
    found.into_iter().map(|w| ((*w.trace).clone(), w.probes.clone())).collect()
}

/// Carries the site's own decoder for a reply no standard reader reads onto `route`, so a call reads the answer as the
/// page did: the answer step's reply is the site's to decode when it is not JSON, a page, a stream or base64-of-JSON
/// and the script that sent the call (which read the reply) turns it into JSON that says the walked word back. The
/// decoder is cut from that one script (`slice::assemble_decoder`) and set on the route's body (`Answer::decode`,
/// built from the graph where the route had none), with the script's SHA on the answer step's test. Does nothing
/// when the walk kept no recording, no runtime is on the machine, or the reply reads as it stands — most routes.
fn attach_a_decoder(route: &mut Route, trace: &Trace, recording: Option<&unbrowse_learn::recording::Recording>) {
    let Some(rec) = recording else { return };
    let Some(answer_step) = route.graph.steps.last() else { return };
    // The answer step's exchange in this trace, by its call (the graph's own `exchange` indexes the lean trace the
    // route was built from, not the walk's full trace): the last matching call the walk made, with a reply.
    let want = url::Url::parse(answer_step.url.split('?').next().unwrap_or_default()).ok();
    let Some(e) = trace.exchanges.iter().rev().find(|e| {
        e.method.eq_ignore_ascii_case(&answer_step.method)
            && want.as_ref().is_some_and(|w| e.url.host_str() == w.host_str() && e.url.path() == w.path())
            && e.response_body.as_deref().is_some_and(|b| !b.trim().is_empty())
    }) else { return };
    let Some(body) = e.response_body.as_deref().filter(|b| !b.trim().is_empty()) else { return };
    // Read as it stands by some standard reader, or a page: not the site's to decode.
    if unbrowse_learn::trace::reads_by_a_standard_reader(body) || unbrowse_learn::page::is_markup(e.response_header("content-type").unwrap_or(&e.response_mime), body) {
        return;
    }
    let Some((script, _)) = rec.sent_by_value(&e.method, e.url.as_str()) else { return };
    // Whether page code can be run here is asked last, once the reply is one only the page's code reads: most routes
    // start no child process for it.
    if !unbrowse_learn::sandbox::available() {
        return;
    }
    let Some(body_js) = script.sha256.as_deref().and_then(|sha| rec.body(sha)) else { return };
    let Some(program) = unbrowse_learn::slice::assemble_decoder(&[(script.url.as_str(), &String::from_utf8_lossy(body_js))]) else { return };
    let Some(out) = unbrowse_learn::generated::decode(&program, body, &unbrowse_learn::generated::Environment::default()) else { return };
    // It must read as JSON, and say the walked word back (what the page showed): a decoder that answers nonsense or a
    // constant is no reading of this reply.
    let Ok(decoded) = serde_json::from_str::<serde_json::Value>(&out) else { return };
    let walked: Vec<String> = route.inputs.iter().filter_map(|i| i.default.clone()).filter(|d| d.chars().count() >= 3).collect();
    let low = out.to_lowercase();
    if walked.is_empty() || !walked.iter().all(|w| low.contains(&w.to_lowercase())) {
        return;
    }
    let _ = decoded;
    let evidence = unbrowse_learn::generated::Evidence {
        header: String::new(),
        sightings: 1,
        producer: None,
        proposed_by: "the reply's own script".into(),
        evidence_hash: String::new(),
        exact: true,
        scripts: Vec::new(),
    };
    let decode = unbrowse_learn::route::Decode { source: program, evidence: serde_json::to_value(evidence).ok() };
    let mut body = route.body.take().unwrap_or_else(|| unbrowse_learn::body::from_graph(&route.graph, &route.site));
    // The decoder is a reason the body runs (a graph has none): `to_graph` refuses it, so the classifier graph stands
    // beside the body and the body runs (`client::with_body`).
    body.answer.decode = Some(decode);
    if let Some(sha) = script.sha256.clone() {
        if let Some(test) = body.tests.iter_mut().find(|t| t.step == body.answer.step) {
            if !test.over_scripts.contains(&sha) {
                test.over_scripts.push(sha);
            }
        }
    }
    route.body = Some(body);
    eprintln!("   [route] the answer is one only the site's own code reads: a decoder cut from {} is carried on the route", script.url);
}

fn keep_as(walks: &Walks, walk: &str, index: usize, what: &str, extra: &[(String, String)], who: &str, live: bool) -> Result<Route, String> {
    let guard = walks.0.locked();
    let w = guard.get(walk).ok_or("that walk has expired; walk the page again")?;
    let mut trace = (*w.trace).clone();
    trace.inputs = walk_inputs(&w.url, extra, &trace.exchanges);
    // A walk only loads the page: every call in it the page sent by itself.
    let history = history_of(&guard, walk, &w.url);
    // A learn by example reads the sender script's constants from this walk's recording (`the_sender_script`): set
    // for the route build, cleared after, so no other build reads a walk's recording that is not its own.
    let stored = stored_of_others(&guard, walk, &w.url);
    let mut route = with_the_recording(w.recording.clone(), || with_the_others_stored(stored, || route_of(&trace, index, what, &w.url, true, &w.probes, &history, w.addresses.as_deref())))?;
    // The answer is one only the site's own code reads (a ciphered or obfuscated reply): the decoder the page uses is
    // cut from the script that read it and carried on the route, so the call reads the answer as the page did. Built
    // from the one walk here (the site is the judge at call time); a second walk, where the learn gets one, holds it
    // to every reply (`lab::Lab::decoder`).
    attach_a_decoder(&mut route, &trace, w.recording.as_ref());
    // The values a caller named for the walk through the API: a shared route carries none of them as a default, but they
    // are the caller's own word, not what the owner's browsing gave a page, so `session_gave` stays false.
    route.given = extra.iter().map(|(name, _)| name.trim().to_string()).filter(|n| !n.is_empty()).collect();
    // A cookie the walk's own later calls carried is the session's: put it in the jar and name it, so a one-time
    // bootstrap that set it need not run again. The later step then reads the jar, and the bootstrap is skippable.
    mint_walked_cookies(&mut route, &trace);
    // One live trial, at learn time: a route whose header the page's code makes is asked with the walk's own value on
    // a different call. A site that answers has not checked that value against the call, so the header is the
    // session's — kept in the jar by name, with no producer and no page. The answer is the proof, never the walk's
    // value matching.
    if live && !route.write {
        route = mint_if_the_site_answers(route, &trace);
    }
    if unbrowse_learn::goal::opens_with_a_read(what) && route.write {
        return Err("the page's candidate changes state, so it cannot answer a read-only goal".into());
    }
    drop(guard);
    save_learned(route, who)
}

/// How long a walk leaves an interactive door open for its owner: the browser is in front of them, and the walk
/// resumes in that same browser once they have passed it. A test bank with no person waits it out and records the
/// site's answer, as it should.
const HANDOFF_WAIT: std::time::Duration = std::time::Duration::from_secs(90);

/// The DevTools address a headed walk left open for its owner, from the engine's refusal, read as the engine writes
/// it and nothing looser: `mint unresolved (<state>); browser left open for verification; reconnect at <address>`,
/// the state one of its own words and the address the whole rest. Only a DevTools socket of a browser on this machine
/// (a loopback `ws://` address with a port, at `/devtools/browser/…`) is the browser the walk launched: any other
/// address, or any other shape of the words, is not reconnected to, and the walk ends as the site answered.
fn handoff_endpoint(said: &str) -> Option<String> {
    let rest = said.strip_prefix("mint unresolved (")?;
    let (state, rest) = rest.split_once(')')?;
    if state.is_empty() || !state.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let endpoint = rest.strip_prefix("; browser left open for verification; reconnect at ")?;
    let url = url::Url::parse(endpoint).ok()?;
    let loopback = match url.host()? {
        url::Host::Ipv4(ip) => ip.is_loopback(),
        url::Host::Ipv6(ip) => ip.is_loopback(),
        url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
    };
    let devtools = url.path().strip_prefix("/devtools/browser/").is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));
    (url.scheme() == "ws" && loopback && url.port().is_some() && devtools && url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none()).then(|| url.to_string())
}

/// Every cookie a later step derived from an earlier response, but that the walk's own later call already sent, is the
/// session's: the walk's request is the proof, so the jar keeps it and the field names it (`Minted`). A one-time
/// bootstrap (`createTUid`) whose cookie this is then has nothing later reading its response, and replay skips it.
fn mint_walked_cookies(route: &mut Route, walked: &Trace) {
    let Some(jar) = unbrowse_learn::client::jar_name(&route.graph) else { return };
    let cookies = unbrowse_learn::graph::walked_cookies(&mut route.graph, walked);
    if cookies.is_empty() {
        return;
    }
    let path = store::jar_path(&jar);
    let mut values: std::collections::BTreeMap<String, String> = store::read_json(&path, &unbrowse_files::JAR);
    for (k, v) in cookies {
        values.insert(k, v);
    }
    let _ = store::write_json(&path, &unbrowse_files::JAR, &values);
}

/// Asks the route once with the walked value of every header the page's code makes, on a different call (one input
/// sent in the request moves), and keeps that value as the session's only when the target answers. A header the site
/// doesn't check against the call needs no producer and no page: the jar keeps the walk's value, and the route names
/// it (`Class::Minted`). Writes are never tried this way; a value the caller must supply with no default (an optional
/// one is left out of the call), or a step
/// a browser is still needed for, means the call can't be made here at all and the producer stays.
fn mint_if_the_site_answers(route: Route, walked: &Trace) -> Route {
    let mut answers = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| call_answers(g, i);
    // What the walk's own call was answered, to hold a trial's answer against.
    let was: Option<serde_json::Value> = route.graph.steps.last().and_then(|t| links::sighting(walked, t)).and_then(|e| e.response_body.as_deref()).and_then(|b| serde_json::from_str(b).ok());
    let asked: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let mut as_walked = |g: &unbrowse_learn::Graph| {
        let Some(was) = &was else { return true };
        let mut client = unbrowse_learn::RouteClient::new(g.clone()).with_chrome_transport().with_session_store(store::jars_dir());
        match client.call_with_ledger(&asked).0 {
            Ok(now) => {
                let emptied = lists_emptied(was, &now);
                if emptied {
                    eprintln!("   [route] asked what the walk asked, the call answers with lists empty where the walk's were filled: the site gave it nothing");
                }
                !emptied
            }
            Err(_) => false,
        }
    };
    let before = route.graph.clone();
    let tried = mint_trial_as_walked(route, walked, &mut answers, &mut as_walked);
    own_asks::say_left_out(&before, &tried.graph);
    tried
}

/// Whether a list the walk's answer filled is empty in this one, or gone to null: the same question, asked again,
/// answered with the frame and none of the records. A site that distrusts a call often answers it this way and not
/// with a refusal, and a 200 with nothing in it is not the call answering. A key this answer leaves out says nothing.
fn lists_emptied(was: &serde_json::Value, now: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (was, now) {
        (Value::Array(a), Value::Array(b)) => !a.is_empty() && b.is_empty(),
        (Value::Array(a), Value::Null) => !a.is_empty(),
        (Value::Object(a), Value::Object(b)) => a.iter().any(|(k, v)| b.get(k).is_some_and(|n| lists_emptied(v, n))),
        _ => false,
    }
}

/// `graph`'s last step by itself, without the headers earlier steps filled, when it takes nothing else from them (a
/// value in its address or body that an earlier answer gave is the call's own ask, and keeps the chain). A cookie an
/// earlier step set is the session's, named for the jar. None for a route of one step with no such header.
fn the_call_alone(graph: &unbrowse_learn::Graph) -> Option<unbrowse_learn::Graph> {
    use unbrowse_learn::graph::Class;
    use unbrowse_learn::slots::Loc;
    let mut target = graph.steps.last()?.clone();
    let filled = |f: &unbrowse_learn::graph::Field| matches!(f.class, Class::Derived { .. });
    if graph.steps.len() < 2 && !target.fields.iter().any(|f| filled(f) && matches!(f.loc, Loc::Header(_))) {
        return None;
    }
    if target.fields.iter().any(|f| filled(f) && !matches!(f.loc, Loc::Header(_) | Loc::Cookie(_))) {
        return None;
    }
    // The header HTTP gives a call to say who it is allowed as is not one of these: a call sent without the
    // authorization an earlier step earned is a call the site refuses, and the trial would spend an ask to hear it.
    if target.fields.iter().any(|f| filled(f) && authorizes(&f.loc)) {
        return None;
    }
    target.fields.retain(|f| !(filled(f) && matches!(f.loc, Loc::Header(_))));
    for f in target.fields.iter_mut() {
        if let (Loc::Cookie(name), true) = (f.loc.clone(), filled(f)) {
            f.class = Class::Minted { name };
        }
    }
    let mut alone = graph.clone();
    alone.steps = vec![target];
    Some(alone)
}

/// Whether a slot is HTTP's own `Authorization` header: what a call carries to say who it is allowed as.
fn authorizes(loc: &unbrowse_learn::slots::Loc) -> bool {
    matches!(loc, unbrowse_learn::slots::Loc::Header(name) if name.eq_ignore_ascii_case("authorization"))
}

/// `graph` cut down to the steps its answer needs: the target, and the reads on its own site whose answers fill its
/// address or its body (the page it was learned on, a config it reads). A step that only filled a header, one on
/// another site (an advert service whose answer happened to hold a number the call sends), and a post the route
/// cannot justify (a sensor's report) are left out; what the target took from them is sent as the walk sent it,
/// and a header from them is not sent. None when nothing would be left out, or a walked value cannot be found.
fn the_least_chain(graph: &unbrowse_learn::Graph, walked: &Trace) -> Option<unbrowse_learn::Graph> {
    use unbrowse_learn::graph::Class;
    use unbrowse_learn::slots::Loc;
    let target = graph.steps.last()?;
    let home = unbrowse_learn::replay::step_host(&target.url)?;
    let mut kept: Vec<usize> = vec![target.exchange];
    let mut at = 0;
    while at < kept.len() {
        let step = graph.steps.iter().find(|s| s.exchange == kept[at])?;
        for f in step.fields.iter().filter(|f| !matches!(f.loc, Loc::Header(_) | Loc::Cookie(_))) {
            let Class::Derived { origin } = &f.class else { continue };
            let Some(source) = graph.steps.iter().find(|s| s.exchange == origin.exchange) else { continue };
            let own = unbrowse_learn::replay::step_host(&source.url).is_some_and(|h| unbrowse_learn::identity::same_site(&h, &home));
            let read = source.method.eq_ignore_ascii_case("GET") && !matches!(origin.at, unbrowse_learn::provenance::At::Text { .. });
            if own && read && !kept.contains(&source.exchange) {
                kept.push(source.exchange);
            }
        }
        at += 1;
    }
    if kept.len() == graph.steps.len() {
        return None;
    }
    let sent = |step: &unbrowse_learn::Step, loc: &Loc| links::walked_at(walked, step, loc);
    let mut least = graph.clone();
    least.steps.retain(|s| kept.contains(&s.exchange));
    for step in least.steps.iter_mut() {
        let own = step.clone();
        let mut fields = Vec::new();
        for mut f in std::mem::take(&mut step.fields) {
            if let Class::Derived { origin } = &f.class {
                if !kept.contains(&origin.exchange) {
                    match f.loc.clone() {
                        // The step that earned the call's authorization is not one to leave out.
                        loc if authorizes(&loc) => return None,
                        Loc::Header(_) => continue,
                        Loc::Cookie(name) => f.class = Class::Minted { name },
                        loc => f.class = Class::Unconfirmed { value: sent(&own, &loc)? },
                    }
                }
            }
            fields.push(f);
        }
        step.fields = fields;
    }
    Some(least)
}

/// `graph` without the pages it reads: every step before the target that the walk shows was a page the browser
/// opened is left out, and what later steps read off it is sent as the walk sent it. A site may wall its pages and
/// leave its calls open, and a route that reads a query's text or an app's version off a walled page can never run
/// plain, though those are the same on every visit. A header a page filled is not sent, a cookie is the jar's, and
/// a call's authorization is never dropped this way. None when the route reads no page, or a walked value is not found.
fn without_its_pages(graph: &unbrowse_learn::Graph, walked: &Trace) -> Option<unbrowse_learn::Graph> {
    use unbrowse_learn::graph::Class;
    use unbrowse_learn::slots::Loc;
    let target = graph.steps.last()?.exchange;
    // A page is told by the walk's own sighting of the step, by the step reading a page, or by its address being the
    // route's own page: a templated address does not always find its sighting again.
    let path_of = |address: &str| address.split(['?', '#']).next().unwrap_or_default().trim_end_matches('/').to_string();
    let own_page = graph.page.as_deref().map(path_of);
    let is_page = |s: &unbrowse_learn::Step| {
        s.reads_page || links::sighting(walked, s).is_some_and(|e| e.is_main_document()) || (s.method.eq_ignore_ascii_case("GET") && s.body.is_none() && own_page.as_deref() == Some(path_of(&s.url).as_str()))
    };
    let pages: Vec<usize> = graph.steps.iter().filter(|s| s.exchange != target && is_page(s)).map(|s| s.exchange).collect();
    let mut bare = graph.clone();
    bare.steps.retain(|s| !pages.contains(&s.exchange));
    // What a step read from anything no longer in the chain is sent as walked: a page left out here, or one the
    // builder had already set aside while keeping the values read from it.
    let left: Vec<usize> = bare.steps.iter().map(|s| s.exchange).collect();
    let mut changed = !pages.is_empty();
    for step in bare.steps.iter_mut() {
        let own = step.clone();
        let mut fields = Vec::new();
        for mut f in std::mem::take(&mut step.fields) {
            if let Class::Derived { origin } = &f.class {
                if !left.contains(&origin.exchange) {
                    changed = true;
                    match f.loc.clone() {
                        loc if authorizes(&loc) => return None,
                        Loc::Header(_) => continue,
                        Loc::Cookie(name) => f.class = Class::Minted { name },
                        loc => f.class = Class::Unconfirmed { value: links::walked_at(walked, &own, &loc)? },
                    }
                }
            }
            fields.push(f);
        }
        step.fields = fields;
    }
    // Nothing left out and nothing rewritten is the chain as it stood, which was already tried.
    changed.then_some(bare)
}

/// `graph`'s last step by itself, with everything it took from the steps before it sent as the walk sent it: the
/// widest of the shorter chains, tried last. A walk ties a call to whatever answered before it with a value the call
/// also sends, an app's name or a query's text among them, and those are often the same on every visit. A header an
/// earlier step filled is not sent, a cookie is the jar's, and a call's authorization is never dropped this way.
/// None for a route of one step, or where a walked value is not found.
fn the_call_as_walked(graph: &unbrowse_learn::Graph, walked: &Trace) -> Option<unbrowse_learn::Graph> {
    use unbrowse_learn::graph::Class;
    use unbrowse_learn::slots::Loc;
    if graph.steps.len() < 2 {
        return None;
    }
    let mut target = graph.steps.last()?.clone();
    let own = target.clone();
    let mut fields = Vec::new();
    for mut f in std::mem::take(&mut target.fields) {
        if matches!(f.class, Class::Derived { .. }) {
            match f.loc.clone() {
                loc if authorizes(&loc) => return None,
                Loc::Header(_) => continue,
                Loc::Cookie(name) => f.class = Class::Minted { name },
                loc => f.class = Class::Unconfirmed { value: links::walked_at(walked, &own, &loc)? },
            }
        }
        fields.push(f);
    }
    target.fields = fields;
    let mut alone = graph.clone();
    alone.steps = vec![target];
    Some(alone)
}

/// The trial itself, with the site's answer as a parameter: a test decides it without a site.
#[cfg(test)]
fn mint_trial(route: Route, walked: &Trace, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> bool) -> Route {
    mint_trial_as_walked(route, walked, answers, &mut |_| true)
}

/// The same, with a second question for a call that answered on a moved input: `as_walked` says whether, asked what
/// the walk asked, it answers as fully as the walk's call was answered. A moved input can find nothing honestly, so
/// only the walk's own question shows a site that answers a call it distrusts with an empty frame.
fn mint_trial_as_walked(
    mut route: Route,
    walked: &Trace,
    answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> bool,
    as_walked: &mut impl FnMut(&unbrowse_learn::Graph) -> bool,
) -> Route {
    use unbrowse_learn::graph::{Class, Field};
    use unbrowse_learn::slots::Loc;

    // What the page's own code writes that the route cannot compute: the step-level producers (and the Script/Computed
    // fields a route learned before the marker carries), with the walk's value where the value is a header.
    let mut produced: Vec<(usize, Loc, Option<String>)> = Vec::new();
    let mut signed = false;
    for (n, step) in route.graph.steps.iter().enumerate() {
        signed |= step.is_page_signed();
        for p in &step.page_producers {
            let value = match &p.loc {
                Loc::Header(name) => walked_value(walked, step, name),
                _ => None,
            };
            produced.push((n, p.loc.clone(), value));
        }
        for f in &step.fields {
            if matches!(f.class, Class::Script { .. } | Class::Computed) {
                let value = match &f.loc {
                    Loc::Header(name) => walked_value(walked, step, name),
                    _ => None,
                };
                produced.push((n, f.loc.clone(), value));
            }
        }
    }
    // With the switch on, a call runs the graph with the stored body laid over it (`body::overlay`). Where the body
    // makes plainly each value the graph leaves to the page (the caller's date in the site's format, which no class of
    // a graph says), the call is plain by the body: it is not handed to the browser, and the site's four tests put to
    // the body (`checked`) are its trial.
    if learns_by_example() && !produced.is_empty() {
        if let Some(body) = route.body.as_ref() {
            let laid = unbrowse_learn::body::overlay(&route.graph, Some(body));
            let plain = laid.body.steps.iter().all(|s| !s.page && s.holes.iter().all(|h| h.ways.first().is_some_and(|w| w.rung < 3)));
            if plain && !laid.laid.is_empty() {
                eprintln!("   [route] the body learned by example makes the {} value(s) the graph leaves to the page: the call is plain by the body", produced.len());
                route.browser_assisted = false;
                return route;
            }
        }
    }
    // An optional input the walk never set (a filter, the next page) is simply not sent: only a value the caller
    // must give, and the walk has none of, leaves no call to try.
    if route.inputs.iter().any(|i| i.default.is_none() && !i.optional) {
        return route;
    }
    // Held, the route is the chain the walk made: nothing is tried shorter or plainer, and the site is asked nothing.
    if own_asks::held_at(own_asks::Ask::Shrink, "learn::mint_trial_as_walked") {
        return route;
    }
    // The trial asks what the walk did not: a value the request sends moves, so a header bound to the body is wrong.
    let mut inputs: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    if let Some((name, moved)) = moved_input(&route, &inputs) {
        inputs.insert(name, moved);
    }
    if !signed {
        // Nothing of the page's rides on it, and a chain may still not run: an earlier step tied to the call by a
        // header its answer filled on the walk, and fills no longer (an id a site hands a browser once). A read of
        // several steps that does not answer as it stands is tried as its call alone, then as its least chain, as a
        // page-signed one is. One that answers stands as built.
        if route.write || route.graph.steps.len() < 2 || answers(&route.graph, &inputs) {
            return route;
        }
        for (shorter, how) in [(the_call_alone(&route.graph), "alone"), (the_least_chain(&route.graph, walked), "with fewer steps")] {
            let Some(shorter) = shorter else { continue };
            if answers(&shorter, &inputs) && as_walked(&shorter) {
                eprintln!("   [route] the chain did not answer as built; the call answers {how}: {} of its {} steps are kept", shorter.steps.len(), route.graph.steps.len());
                route.steps = shorter.steps.len();
                route.graph = shorter;
                route.browser_assisted = false;
                route.plain_trial = Some(true);
                return route;
            }
        }
        return route;
    }
    // The trial is the call, not a page: no scripts, no answers, no markup, and no page-signed step.
    let strip = |g: &mut unbrowse_learn::Graph| {
        for step in &mut g.steps {
            step.page_signed = false;
            step.page_producers.clear();
            step.needs_browser = false;
            step.fields.retain(|f| !matches!(f.class, Class::Script { .. } | Class::Computed));
        }
        g.scripts.clear();
        g.api.clear();
        g.page = None;
        // The markup stays: it is data the route's page step reads, not code the page runs.
    };
    // First: the route's own fields, with none of the page's values. A site that answers says the page wrote nothing
    // this call needs — the step is plain, and no script or page rides on it.
    let mut plain = route.graph.clone();
    strip(&mut plain);
    if answers(&plain, &inputs) && as_walked(&plain) {
        // It answers plain. Fewer steps still answer where the rest were only tied to it by the walk: each step left
        // in is one more thing that can fail on a later call (another site's service refusing its own request).
        let least = (!route.write).then(|| the_least_chain(&plain, walked)).flatten();
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [route] the least chain of {} steps: {}", plain.steps.len(), least.as_ref().map_or("none shorter, or a walked value was not found".to_string(), |l| format!("{} steps", l.steps.len())));
        }
        let least = least.filter(|least| answers(least, &inputs) && as_walked(least));
        if let Some(least) = &least {
            eprintln!("   [route] the call answers with {} of its {} steps: the rest are dropped", least.steps.len(), plain.steps.len());
            route.steps = least.steps.len();
        }
        route.graph = least.unwrap_or(plain);
        route.browser_assisted = false;
        route.plain_trial = Some(true);
        eprintln!("   [route] the page's own value(s) are not in the call: the step is plain ({} dropped)", produced.len());
        return route;
    }
    // Next: the call alone. A header an earlier call's answer filled (an installation id, an experiment's
    // fingerprint) keeps that call in the route, and a chain that cannot source it again fails before the site is
    // asked. Where a read's target takes nothing else from the steps before it, it is tried without them and without
    // those headers: a site that answers needed neither. Cookies stay the jar's.
    if !route.write {
        if let Some(alone) = the_call_alone(&plain) {
            if answers(&alone, &inputs) && as_walked(&alone) {
                eprintln!("   [route] the call answers alone: {} earlier step(s) and the headers they filled are dropped", plain.steps.len() - 1);
                route.graph = alone;
                route.steps = 1;
                route.browser_assisted = false;
                route.plain_trial = Some(true);
                return route;
            }
        }
    }
    // Or the least chain: the target and the reads on its own site that fill its address and its body. A walk of a
    // busy page ties a call to whatever answered before it with a value the call also sends (a sensor's post, an
    // advert service), and a route that carries those fails when any of them does. Tried on a moved input: the
    // site's answer says whether the call needed them.
    if !route.write {
        let least = the_least_chain(&plain, walked);
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [route] the least chain of {} steps, tried after the plain chain was refused: {}", plain.steps.len(), least.as_ref().map_or("none shorter, or a walked value was not found".to_string(), |l| format!("{} step(s)", l.steps.len())));
        }
        if let Some(least) = least {
            if answers(&least, &inputs) && as_walked(&least) {
                eprintln!("   [route] the call answers with {} of its {} steps: the rest are dropped", least.steps.len(), plain.steps.len());
                route.steps = least.steps.len();
                route.graph = least;
                route.browser_assisted = false;
                route.plain_trial = Some(true);
                return route;
            }
        }
    }
    // Or the chain without its pages: what it read off them sent as the walk sent it. A site that walls its pages
    // and answers its calls is answered this way, and the site says whether the call needed the page.
    if !route.write {
        if let Some(bare) = without_its_pages(&plain, walked) {
            let answered = answers(&bare, &inputs) && as_walked(&bare);
            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                eprintln!("   [route] without its pages, {} of {} steps: {}", bare.steps.len(), plain.steps.len(), if answered { "the site answers" } else { "the site does not answer" });
            }
            if answered {
                eprintln!("   [route] the call answers without the pages it read: what it took from them is sent as the walk sent it");
                route.steps = bare.steps.len();
                route.graph = bare;
                route.graph.provisional = true;
                route.browser_assisted = false;
                route.plain_trial = Some(true);
                return route;
            }
        }
    }
    // Or the call by itself, as the walk sent it: the last and widest of the shorter chains.
    if !route.write {
        if let Some(alone) = the_call_as_walked(&plain, walked) {
            let answered = answers(&alone, &inputs) && as_walked(&alone);
            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                eprintln!("   [route] the call by itself, as the walk sent it: {}", if answered { "the site answers" } else { "the site does not answer" });
            }
            if answered {
                eprintln!("   [route] the call answers by itself with what the walk sent: the {} step(s) before it are dropped", plain.steps.len() - 1);
                route.steps = 1;
                route.graph = alone;
                route.graph.provisional = true;
                route.browser_assisted = false;
                route.plain_trial = Some(true);
                return route;
            }
        }
    }
    // Then: the walk's values as they were. A site that answers on a moved input has not checked them against the
    // call; they are the session's, kept by name, and the step needs no page.
    if produced.is_empty() {
        return route;
    }
    let Some(headers) = produced.iter().map(|(n, loc, value)| value.clone().map(|v| (*n, loc.clone(), v))).collect::<Option<Vec<_>>>() else { return route };
    // A value the walk shows a call handed the page during this very visit (a challenge's answer, in the response
    // that issued it) was made for the visit: it still works a moment later, which is all a trial now could show,
    // and a later call needs its own. It stays the page's to make, never the session's to keep.
    // What the page's own code or markup spells out (a script, a stylesheet, a document as served) is the page's to
    // say on every visit, an app's name or its build: only a call's answer hands over a value made for this one.
    let written_in_the_page = |e: &unbrowse_learn::Exchange| e.resource_type.as_deref().is_some_and(|t| ["script", "document", "stylesheet"].iter().any(|k| t.eq_ignore_ascii_case(k)));
    let issued_this_visit = |value: &str| {
        value.chars().count() >= 16 && walked.exchanges.iter().any(|e| !written_in_the_page(e) && e.response_body.as_deref().is_some_and(|b| b.contains(value)))
    };
    // The rest are the page's own to say the same on every visit (the app's name, its build): they are tried as the
    // walk sent them, with the visit's value left out. A site that answers needed the first and not the second.
    let issued = headers.iter().filter(|(_, _, value)| issued_this_visit(value)).count();
    let headers: Vec<(usize, Loc, String)> = headers.into_iter().filter(|(_, _, value)| !issued_this_visit(value)).collect();
    if issued > 0 && headers.is_empty() {
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [route] keeps {} page-made value(s): a call issued one during the visit, so it is made anew each time", produced.len());
        }
        route.plain_trial = Some(false);
        return route;
    }
    let mut minted = route.graph.clone();
    for (n, loc, value) in &headers {
        let step = &mut minted.steps[*n];
        match step.fields.iter_mut().find(|f| f.loc == *loc) {
            Some(f) => f.class = Class::Unconfirmed { value: value.clone() },
            None => step.fields.push(Field { loc: loc.clone(), class: Class::Unconfirmed { value: value.clone() } }),
        }
    }
    strip(&mut minted);
    if !(answers(&minted, &inputs) && as_walked(&minted)) {
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [route] keeps {} page-made value(s): neither plain nor the walk's values answered{}", produced.len(), if issued > 0 { " without the one issued this visit" } else { "" });
        }
        route.plain_trial = Some(false);
        if issued > 0 {
            return route;
        }
        route.graph.provisional = route.graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, Class::Unconfirmed { .. }));
        return route;
    }
    // The site answered with the walk's values on another call: the jar keeps them, the route only names them.
    let Some(jar) = unbrowse_learn::client::jar_name(&minted) else { return route };
    let path = store::jar_path(&jar);
    let mut jar_values: std::collections::BTreeMap<String, String> = store::read_json(&path, &unbrowse_files::JAR);
    let mut kept = 0usize;
    for (n, loc, value) in &headers {
        let Loc::Header(name) = loc else { continue };
        if let Some(f) = minted.steps[*n].fields.iter_mut().find(|f| f.loc == *loc) {
            f.class = Class::Minted { name: name.clone() };
        }
        jar_values.insert(name.clone(), value.clone());
        kept += 1;
    }
    if kept == 0 {
        return route;
    }
    let _ = store::write_json(&path, &unbrowse_files::JAR, &jar_values);
    minted.provisional = minted.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, Class::Unconfirmed { .. }));
    route.graph = minted;
    route.browser_assisted = false;
    route.plain_trial = Some(false);
    eprintln!("   [route] answers with the walk's {kept} page-made header value(s) on another call: the session keeps them");
    route
}

/// What the site said when asked whether a route hears its caller.
#[derive(Debug, PartialEq)]
pub(crate) enum Hears {
    /// The answer changed, or the site said no: what the caller sends reaches it.
    Yes,
    /// These inputs changed nothing: the answer is the walked page's, whatever they say.
    Deaf(Vec<String>),
    /// Not asked, and why: nothing is concluded.
    Unasked(&'static str),
}

/// A value nobody searches for: letters only, so it rides wherever a word rides.
const NOBODYS_WORD: &str = "zqxvkjwpf";

/// Asks the site whether `route` hears what the caller sends: the pick is the learner's proposal, read from one walk,
/// and a route that sends the caller's word to a call whose answer never depends on it answers the walked page for
/// every value after, `ok: true` each time. The route is called once as the walk called it and once with a word
/// nobody searches for in place of each value the page was asked (`asked`). The same answer both times is a route
/// that does not hear. A refusal, an error or nothing found is the site hearing the word and saying so.
///
/// Reads only, and only a route that runs as plain calls: one a page must sign is left to its first real second
/// value (`Unasked`). Two plain calls, at learn time, never in the call path.
pub(crate) fn hears(route: &Route, asked: &[String]) -> Hears {
    let mut answers = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        let mut client = unbrowse_learn::RouteClient::new(g.clone()).with_chrome_transport().with_session_store(store::jars_dir());
        client.call_with_ledger(i).0.ok()
    };
    hears_with(route, asked, &mut answers)
}

/// How the site writes a value of two words where the route holds the caller's word in a piece of its address: the
/// walk asked one word and shows nothing of it. The site is asked the walked word twice over, written each way an
/// address writes a space (escaped, a plus, a dash), and the first writing whose answer has something of its own
/// beside the answer to a word nobody searches for is kept. Learn time only; a route that holds no such word, or
/// whose walked value already has two words, is left as it is.
pub(crate) fn spaced_as_the_site_writes(route: Route, walked: &str) -> Route {
    let mut answers = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        let mut client = unbrowse_learn::RouteClient::new(g.clone()).with_chrome_transport().with_session_store(store::jars_dir());
        client.call_with_ledger(i).0.ok()
    };
    spaced_with(route, walked, &mut answers)
}

/// How the walked page's own links write two words in the piece of the address `before` leads to: joined by dashes,
/// where at least two links there do and none writes a space any other way. The site's own writing, read off its
/// page: for an address with no page for a made-up pair of words (a tag, a category), asking it shows nothing.
fn dashed_in_the_pages_links(walked: &str, before: &str) -> bool {
    if before.len() < 3 {
        return false;
    }
    let pieces: std::collections::BTreeSet<&str> = walked
        .match_indices(before)
        .map(|(at, _)| &walked[at + before.len()..])
        .map(|rest| &rest[..rest.find(['/', '"', '\'', '?', '#', '\\', '<', ' ']).unwrap_or(rest.len().min(80))])
        .filter(|p| p.len() >= 3 && p.len() <= 60)
        .collect();
    let worded = |p: &str, join: &str| p.split(join).count() >= 2 && p.split(join).all(|w| w.chars().count() >= 2 && w.chars().all(char::is_alphabetic));
    let dashed = pieces.iter().filter(|p| worded(p, "-")).count();
    let otherwise = pieces.iter().filter(|p| worded(p, "%20") || worded(p, "+") || worded(p, "_")).count();
    dashed >= 2 && otherwise == 0
}

fn spaced_with(mut route: Route, walked: &str, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    use unbrowse_learn::graph::{Class, Held, Written};
    use unbrowse_learn::Loc;
    if route.write || route.socket.is_some() || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return route;
    }
    // Held, the route is left as learned, as it is when the site answers no writing.
    if own_asks::held_at(own_asks::Ask::Nonsense, "learn::spaced_with") {
        return route;
    }
    let Some(step) = route.graph.steps.len().checked_sub(1) else { return route };
    // The route as it was learned: what comes back unless the site answers another writing.
    let learned = route.clone();
    // The word held in a piece of the address, or a piece that is the word itself: the same question either way, and
    // the second is asked as the first, the piece kept as walked with the word held in it.
    let at = match route.graph.steps[step].held.iter().position(|h| matches!(h.loc, Loc::Path(_))) {
        Some(at) => at,
        None => {
            let target = &mut route.graph.steps[step];
            let Some((n, name, word)) = target.fields.iter().find_map(|f| match (&f.loc, &f.class) {
                (Loc::Path(n), Class::Input { name, secret: false, default: Some(word), .. }) => Some((*n, name.clone(), word.clone())),
                _ => None,
            }) else {
                if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                    eprintln!("   [route] two words: no piece of the address is the caller's: {:?}", target.fields.iter().filter(|f| matches!(f.loc, Loc::Path(_))).map(|f| serde_json::to_string(&f.class).unwrap_or_default().chars().take(60).collect::<String>()).collect::<Vec<_>>());
                }
                return route;
            };
            let Some(f) = target.fields.iter_mut().find(|f| f.loc == Loc::Path(n)) else { return route };
            f.class = Class::Constant { value: word.clone(), origin: None };
            target.held.push(Held { loc: Loc::Path(n), input: name, sits: word, written: Written::Plain, inside: None });
            target.held.len() - 1
        }
    };
    let name = route.graph.steps[step].held[at].input.clone();
    let Some(word) = route.inputs.iter().find(|i| i.name == name).and_then(|i| i.default.clone()).filter(|d| !d.contains(char::is_whitespace) && d.chars().count() >= 2) else { return route };
    let mut inputs: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    inputs.insert(name.clone(), NOBODYS_WORD.to_string());
    // A site with no page for a word nobody searches for says nothing: every line of a writing's answer is its own.
    let nothing = answers(&route.graph, &inputs).map(|v| said_lines(&v, &[NOBODYS_WORD])).unwrap_or_default();
    inputs.insert(name, format!("{word} {word}"));
    // Each writing is asked, and the one whose answer says the most of its own is the site's: a page that found
    // nothing still says the ask back in a line or two, so the first to differ at all is not it.
    let was = route.graph.steps[step].held[at].written;
    let mut best: Option<(usize, Written)> = None;
    // A piece of an address is escaped when the address is written, so the ways to write two words in one are as
    // they are (the space escaped there) and joined by dashes.
    for written in [was, Written::Plain, Written::Dashed] {
        if best.is_some() && written == was {
            continue;
        }
        let mut tried = route.graph.clone();
        tried.steps[step].held[at].written = written;
        let Some(found) = answers(&tried, &inputs).map(|v| said_lines(&v, &[word.as_str()])) else { continue };
        let own = found.len() - found.intersection(&nothing).count();
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [route] two words as {written:?}: {own} of {} lines are its own beside the answer to a word nobody searches for", found.len());
        }
        if found.len() >= TOO_LITTLE_TO_TELL && !nothing_of_its_own(&found, &nothing) && best.is_none_or(|(most, _)| own > most) {
            best = Some((own, written));
        }
    }
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() && best.is_none() {
        eprintln!("   [route] two words: the site answered no writing of a made-up pair; its page is {} bytes, {} links under the piece's address", walked.len(), route.graph.steps[step].url.find("{path[").map_or(0, |hole| walked.matches(route.graph.steps[step].url[..hole].rsplit_once("://").map_or("", |(_, a)| a.find('/').map_or("", |p| &a[p..]))).count()));
    }
    match best.filter(|(_, w)| *w != was) {
        Some((_, written)) => {
            eprintln!("   [route] two words go into the address as {written:?}: the site answered them so");
            route.graph.steps[step].held[at].written = written;
            route
        }
        // The site answered no writing of a made-up pair. Its own page may still show how it writes one.
        None if best.is_none() && {
            let address = &route.graph.steps[step].url;
            let before = address.find("{path[").and_then(|hole| address[..hole].find("://").map(|s| &address[s + 3..hole])).and_then(|a| a.find('/').map(|p| &a[p..]));
            before.is_some_and(|b| dashed_in_the_pages_links(walked, b))
        } => {
            eprintln!("   [route] two words go into the address joined by dashes: the page's own links write them so");
            route.graph.steps[step].held[at].written = Written::Dashed;
            route
        }
        None => learned,
    }
}

/// The caller's word where the call carries it a second time inside a longer value, not as a word of its own (after
/// a type mark in a packed value, `!1sramen!7i20`): nothing in one walk says that text is the word and not a chance
/// run of letters. It is proposed, and the site decides: asked a word nobody searches for, the route is kept with
/// the word swapped there too only if its answer then shares less with the walked answer than it did without.
pub(crate) fn held_where_the_site_hears(route: Route) -> Route {
    let mut answers = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        let mut client = unbrowse_learn::RouteClient::new(g.clone()).with_chrome_transport().with_session_store(store::jars_dir());
        client.call_with_ledger(i).0.ok()
    };
    held_where_with(route, &mut answers)
}

fn held_where_with(mut route: Route, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    use unbrowse_learn::graph::{Class, Held, Written};
    use unbrowse_learn::Loc;
    if route.write || route.socket.is_some() || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return route;
    }
    // Held, nothing is proposed: the route is as it would be had the site not answered.
    if own_asks::held_at(own_asks::Ask::Nonsense, "learn::held_where_with") {
        return route;
    }
    let Some(step) = route.graph.steps.len().checked_sub(1) else { return route };
    let words: Vec<(String, String)> = route
        .inputs
        .iter()
        .filter(|i| !i.secret && !i.file)
        .filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d)))
        .filter(|(_, d)| d.chars().count() >= 4 && d.chars().any(char::is_alphabetic))
        .collect();
    let target = &route.graph.steps[step];
    let proposed: Vec<Held> = target
        .fields
        .iter()
        .filter(|f| matches!(f.loc, Loc::Query(_) | Loc::Json(_) | Loc::Form(_)))
        .filter_map(|f| match &f.class {
            Class::Constant { value, .. } | Class::Unconfirmed { value } => Some((&f.loc, value)),
            _ => None,
        })
        .flat_map(|(loc, value)| {
            words
                .iter()
                .filter(|(name, d)| value != d && value.matches(d.as_str()).count() == 1 && !target.held.iter().any(|h| h.loc == *loc && h.input == *name))
                .map(|(name, d)| Held { loc: loc.clone(), input: name.clone(), sits: d.clone(), written: Written::Plain, inside: None })
                .collect::<Vec<_>>()
        })
        .collect();
    if proposed.is_empty() {
        return route;
    }
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let mut moved = walked.clone();
    for h in &proposed {
        moved.insert(h.input.clone(), NOBODYS_WORD.to_string());
    }
    let struck: Vec<&str> = words.iter().map(|(_, d)| d.as_str()).collect();
    let Some(was) = answers(&route.graph, &walked).map(|v| said_lines(&v, &struck)) else { return route };
    let Some(without) = answers(&route.graph, &moved).map(|v| said_lines(&v, &[NOBODYS_WORD])) else { return route };
    let mut with = route.graph.clone();
    with.steps[step].held.extend(proposed.iter().cloned());
    // It must answer, and share less with the walk than it did without: a call that fails with the word moved there
    // has shown nothing (a value a check reads breaks when any of it is changed).
    let shares = |now: &std::collections::BTreeSet<String>| was.intersection(now).count();
    let hears_more = answers(&with, &moved).map(|v| said_lines(&v, &[NOBODYS_WORD])).is_some_and(|now| shares(&now) < shares(&without));
    if hears_more {
        eprintln!("   [route] the word also rides inside {}: with it swapped there the site answers less of the walk", proposed.iter().map(|h| format!("{:?}", h.loc)).collect::<Vec<_>>().join(", "));
        route.graph = with;
    }
    route
}

/// The asks a question about paging costs, the asks a second look costs (its walk's own, the trials behind it), and
/// how many are left to the caller whatever is asked: a route learned on a site's last asks answers nobody.
const PAGING_ASKS: u64 = 2;
const SECOND_LOOK_ASKS: u64 = 8;
const CALLERS_SHARE: u64 = 8;

/// Whether a route's call can spare `asks` more for a question the route can do without (`budget::spares`): one whose
/// answers have said nothing of a count can. The count is the call's own, by its address.
fn spares(route: &Route, asks: u64) -> bool {
    route.graph.steps.last().and_then(|s| unbrowse_learn::budget::place_of(&s.url)).is_none_or(|place| unbrowse_learn::budget::spares(&place, asks, CALLERS_SHARE))
}

/// How a route is read on, where its walk never turned the page: the call sends a small counting value as it stands
/// (`page=1`, `pageNum: 1`, `offset=0`), which one sighting cannot tell from any other setting. Each such value is
/// proposed as the count, and the site decides: asked with the next value (the next number, or for a zero the
/// number of records the first answer listed, as an offset moves), it must answer with the same kind of list and
/// records of its own. Only where the call sends exactly one such value: beside a second, the site's answer cannot
/// say which is the count. Learn time only.
/// With a second word the page was walked for, where there is one: where the walk's own word lists too little to
/// have a next page, the question is asked with that one (`asked_where_it_lists`).
pub(crate) fn read_on_by_trial_for(route: Route, other_word: Option<&str>, second_look_to_come: bool) -> Route {
    let mut answers = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        let mut client = unbrowse_learn::RouteClient::new(g.clone()).with_chrome_transport().with_session_store(store::jars_dir());
        client.call_with_ledger(i).0.ok()
    };
    read_on_by_trial_with(route, other_word, second_look_to_come, &mut answers)
}

/// `read_on_by_trial_for`, the site's answers given by `answers`. Held (`UNBROWSE_NO_PAGING`), the site is asked
/// nothing and the route reads on only as its walk or the page's own next link said when it was built
/// (`offered_by`, `next_page_linked`).
fn read_on_by_trial_with(mut route: Route, other_word: Option<&str>, second_look_to_come: bool, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    // Whether it reads on is a question the route can do without, on a site that has said it has few asks left. And
    // it gives way to the second look where that is still to come: two walks settle what the route's values are,
    // which every call depends on, and the second look asks about paging again once it has.
    let needed = PAGING_ASKS + if second_look_to_come { SECOND_LOOK_ASKS } else { 0 };
    if !spares(&route, needed) {
        eprintln!("   [route] not asked whether it reads on: the site says it has few asks left");
        return route;
    }
    // A route the trial never asks about (`read_on_with`) is not counted as held.
    if !(route.write || route.socket.is_some() || route.graph.steps.iter().any(|s| s.is_page_signed())) && own_asks::held_at(own_asks::Ask::Paging, "learn::read_on_by_trial_for") {
        return route;
    }
    // The word is lent to the question only: what the site was heard to say back stays as it was found.
    let heard = route.heard.said_back.clone();
    if heard.is_none() {
        route.heard.said_back = other_word.map(String::from);
        let mut read = read_on_with(route, answers);
        read.heard.said_back = heard;
        return read;
    }
    read_on_with(route, answers)
}

/// The lengths of the lists an answer holds, longest first.
fn list_lengths(answer: &serde_json::Value) -> Vec<u64> {
    fn walk(v: &serde_json::Value, out: &mut Vec<u64>) {
        match v {
            serde_json::Value::Array(items) => {
                out.push(items.len() as u64);
                items.iter().take(5).for_each(|i| walk(i, out));
            }
            serde_json::Value::Object(o) => o.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(answer, &mut out);
    out.sort_unstable_by(|a, b| b.cmp(a));
    out.dedup();
    out
}

/// Every list of three or more in an answer, by where it sits: the keys its records carry (the first few say it)
/// and the records themselves, written out, to tell one page of them from the next.
fn the_lists_of(answer: &serde_json::Value) -> std::collections::BTreeMap<String, (std::collections::BTreeSet<String>, String)> {
    fn find(v: &serde_json::Value, at: String, out: &mut std::collections::BTreeMap<String, (std::collections::BTreeSet<String>, String)>) {
        match v {
            serde_json::Value::Array(items) => {
                if items.len() >= 3 && !out.contains_key(&at) {
                    let keys = items.iter().take(5).filter_map(|i| i.as_object()).flat_map(|o| o.keys().cloned()).collect();
                    out.insert(at.clone(), (keys, serde_json::Value::Array(items.clone()).to_string()));
                }
                items.iter().take(5).for_each(|i| find(i, format!("{at}/*"), out));
            }
            serde_json::Value::Object(o) => o.iter().for_each(|(k, x)| find(x, format!("{at}/{k}"), out)),
            _ => {}
        }
    }
    let mut out = Default::default();
    find(answer, String::new(), &mut out);
    out
}

/// Whether two answers list the same kind of thing in the same place, with other records in it: what a next page is.
/// Some list of the first sits where one of the second does, their records share most of their keys, and the
/// records are not the same ones. The rest of an answer may differ from page to page (a box of suggestions the
/// first page fills and a later one leaves out) or stay put (its filters, a longer list than its records), and
/// says nothing of whether the list read on.
fn lists_the_same_kind(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    let (a, b) = (the_lists_of(a), the_lists_of(b));
    a.iter().any(|(at, (keys_a, records_a))| {
        b.get(at).is_some_and(|(keys_b, records_b)| records_a != records_b && keys_a.intersection(keys_b).count() * 2 >= keys_a.len().max(keys_b.len()))
    })
}

fn read_on_with(mut route: Route, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    use unbrowse_learn::graph::Class;
    use unbrowse_learn::Loc;
    if route.write || route.socket.is_some() || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return route;
    }
    // A way on the walk or the page's own link offered is held to the site too: asked for the next page, it must
    // answer with something of its own. A page whose results a script fills reads the same for every page, and an
    // input that changes nothing must never look as if it read on.
    if let Some(unbrowse_learn::paging::Paging::Count { input, step: by }) = route.paging.clone() {
        let inputs: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
        let from = inputs.get(&input).and_then(|v| v.parse::<u64>().ok()).unwrap_or(if by == 1 { 1 } else { 0 });
        let mut next = inputs.clone();
        next.insert(input.clone(), (from + by).to_string());
        if let (Some(first), Some(second)) = (answers(&route.graph, &inputs), answers(&route.graph, &next)) {
            let (was, now) = (said_lines(&first, &[]), said_lines(&second, &[]));
            if was.len() >= TOO_LITTLE_TO_TELL && nothing_of_its_own(&now, &was) {
                eprintln!("   [route] {input} does not read on: the site answers the next page as it answered the first");
                route.paging = None;
                route.inputs.retain(|i| !(i.name == input && i.optional));
                for s in route.graph.steps.iter_mut() {
                    s.fields.retain(|f| !matches!(&f.class, unbrowse_learn::graph::Class::Input { name, optional: true, .. } if *name == input));
                }
            }
        }
        return route;
    }
    let Some(step) = route.graph.steps.len().checked_sub(1) else { return route };
    let counted: Vec<(Loc, String)> = route.graph.steps[step]
        .fields
        .iter()
        .filter(|f| matches!(f.loc, Loc::Query(_) | Loc::Json(_) | Loc::Form(_)))
        .filter_map(|f| match &f.class {
            Class::Constant { value, .. } | Class::Unconfirmed { value } if value == "1" || value == "0" => Some((f.loc.clone(), value.clone())),
            _ => None,
        })
        .collect();
    // No such value sent: the answer may still say where it is (`"page": 1` beside its records, for a call that sent
    // no page at all). That name is put to the site as the call's own.
    // Each such value is tried as the count, by itself, and the site says which is: a call may send two (a counter
    // an older page read beside the one it reads now) and answer to one. Only where exactly one reads on: beside a
    // tab, both list other records, the answer cannot say which is the count, and a wrong way on is worse than none.
    // With none, with more than a few, or where none tried reads on, what the answer says is asked instead.
    if counted.is_empty() || counted.len() > 3 {
        return read_on_as_the_answer_counts(route, step, answers);
    }
    let Some((inputs, first)) = asked_where_it_lists(&route, answers) else { return route };
    let listed = longest_list(&first);
    let (kind, was) = (keys_of_an_answer(&first), said_lines(&first, &[]));
    let mut found: Vec<(Loc, String, u64)> = Vec::new();
    for (loc, value) in &counted {
        // An offset moves by a page of records. The call often says how many it asked for (`numberOfResults=10`), and
        // a list of that length in its answer is the page: that size is tried before the answer's longest list,
        // which may be its filters.
        let asked_for: Vec<u64> = route.graph.steps[step].fields.iter().filter_map(|f| match &f.class {
            Class::Constant { value, .. } | Class::Unconfirmed { value } | Class::Input { default: Some(value), .. } => value.parse::<u64>().ok(),
            _ => None,
        }).collect();
        let mut sizes: Vec<u64> = list_lengths(&first).into_iter().filter(|n| *n >= 3 && asked_for.contains(n)).collect();
        sizes.push(listed as u64);
        sizes.dedup();
        let steps: Vec<u64> = if value == "1" { vec![1] } else { std::iter::once(1).chain(sizes).collect() };
        for by in steps {
            let mut tried = route.graph.clone();
            let next = (value.parse::<u64>().unwrap_or(0) + by).to_string();
            if let Some(f) = tried.steps[step].fields.iter_mut().find(|f| f.loc == *loc) {
                f.class = Class::Unconfirmed { value: next };
            }
            unbrowse_learn::paging::open_slot(&mut tried.steps[step], loc);
            let Some(second) = answers(&tried, &inputs) else { continue };
            let now = said_lines(&second, &[]);
            if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
                let (a, b) = (keys_of_an_answer(&second).unwrap_or_default(), kind.clone().unwrap_or_default());
                eprintln!("   [route] read on by {loc:?} +{by}: {} of {} lines are new; it lists {}; keys only in one answer: {:?}", now.difference(&was).count(), now.len(), longest_list(&second), a.symmetric_difference(&b).take(6).collect::<Vec<_>>());
            }
            if longest_list(&second) >= 3 && lists_the_same_kind(&first, &second) && now.len() >= TOO_LITTLE_TO_TELL && !nothing_of_its_own(&now, &was) && now.difference(&was).count() * 3 >= now.len() {
                found.push((loc.clone(), value.clone(), by));
                break;
            }
        }
    }
    let [(loc, value, by)] = &found[..] else { return read_on_as_the_answer_counts(route, step, answers) };
    let name = match loc {
        Loc::Query(k) | Loc::Form(k) => k.clone(),
        Loc::Json(pointer) => pointer.rsplit('/').next().unwrap_or("page").to_string(),
        _ => return route,
    };
    if route.inputs.iter().any(|i| i.name == name) {
        return route;
    }
    if let Some(f) = route.graph.steps[step].fields.iter_mut().find(|f| f.loc == *loc) {
        f.class = Class::Input { name: name.clone(), secret: false, default: Some(value.clone()), optional: true };
    }
    unbrowse_learn::paging::open_slot(&mut route.graph.steps[step], loc);
    eprintln!("   [route] it reads on by {name}, {by} at a time: the site answered the next with records of its own");
    route.inputs.push(store::RouteInput { name: name.clone(), secret: false, default: Some(value.clone()), file: false, optional: true, options: Vec::new() });
    route.paging = Some(unbrowse_learn::paging::Paging::Count { input: name, step: *by });
    route
}

/// The route asked for something it lists enough of to read on from: as its walk asked it, or, where the walk's own
/// word finds too little to have a next page (one product), for the second word the site was shown to answer
/// (`heard.said_back`). The inputs asked with and the answer; None when neither lists three things.
fn asked_where_it_lists(route: &Route, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Option<(HashMap<String, String>, serde_json::Value)> {
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let first = answers(&route.graph, &walked)?;
    if longest_list(&first) >= 3 {
        return Some((walked, first));
    }
    let word = route.heard.said_back.clone()?;
    let input = route.inputs.iter().find(|i| !i.optional && !i.secret && i.default.as_deref().is_some_and(a_word))?;
    let mut other = walked;
    other.insert(input.name.clone(), word);
    let again = answers(&route.graph, &other)?;
    (longest_list(&again) >= 3).then_some((other, again))
}

/// How a route reads on where its call sends no counting value at all: its answer names one. An answer that says
/// `"page": 1` beside a list of records is counting pages, and a call that never sent `page` got the first. The call
/// is asked with that name set to 2 in its address, and the site decides: the same kind of list, records of its own,
/// and the answer saying 2 where it said 1. Only a read sent by GET, and only where the answer names exactly one
/// such value. Learn time only.
fn read_on_as_the_answer_counts(mut route: Route, step: usize, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Route {
    use unbrowse_learn::graph::{Class, Field};
    use unbrowse_learn::Loc;
    if !route.graph.steps[step].method.eq_ignore_ascii_case("GET") || route.graph.steps[step].body.is_some() {
        return route;
    }
    let Some((inputs, first)) = asked_where_it_lists(&route, answers) else { return route };
    // A number 1 the answer says of itself, at its top or one member down, never inside a record.
    fn ones(v: &serde_json::Value, depth: usize, out: &mut Vec<(String, String)>, at: String) {
        let Some(o) = v.as_object() else { return };
        for (k, x) in o {
            let here = format!("{at}/{k}");
            match x {
                serde_json::Value::Number(n) if n.as_u64() == Some(1) => out.push((k.clone(), here)),
                serde_json::Value::Object(_) if depth < 1 => ones(x, depth + 1, out, here),
                _ => {}
            }
        }
    }
    let mut named = Vec::new();
    ones(&first, 0, &mut named, String::new());
    if named.is_empty() {
        return read_on_by_what_the_answer_hands_over(route, step, &first, &inputs, answers);
    }
    let [(name, pointer)] = &named[..] else { return route };
    let sends = |loc: &Loc| route.graph.steps[step].fields.iter().any(|f| f.loc == *loc);
    if route.inputs.iter().any(|i| &i.name == name) || sends(&Loc::Query(name.clone())) {
        return route;
    }
    let mut tried = route.graph.clone();
    tried.steps[step].fields.push(Field { loc: Loc::Query(name.clone()), class: Class::Unconfirmed { value: "2".into() } });
    let Some(second) = answers(&tried, &inputs) else { return route };
    let (was, now) = (said_lines(&first, &[]), said_lines(&second, &[]));
    let says_two = second.pointer(pointer).and_then(|v| v.as_u64()) == Some(2);
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [route] the answer counts by {name}: asked for 2, {} of {} lines are new, and it says {:?}", now.difference(&was).count(), now.len(), second.pointer(pointer));
    }
    if !(says_two && longest_list(&second) >= 3 && lists_the_same_kind(&first, &second) && now.len() >= TOO_LITTLE_TO_TELL && !nothing_of_its_own(&now, &was) && now.difference(&was).count() * 3 >= now.len()) {
        return route;
    }
    unbrowse_learn::paging::place_optional(&mut route.graph.steps[step], &Loc::Query(name.clone()), name, Some("2"));
    eprintln!("   [route] it reads on by {name}, which its answer counts and its call never sent: the site answered 2 with records of its own");
    route.inputs.push(store::RouteInput { name: name.clone(), secret: false, default: None, file: false, optional: true, options: Vec::new() });
    route.paging = Some(unbrowse_learn::paging::Paging::Count { input: name.clone(), step: 1 });
    route
}

/// How a route reads on where its answer counts nothing and hands something over instead: one opaque value at its
/// top (`"page_handle": "ZnJvbT0xMC…"`), under a name the call never sent. The call is asked with that name set to
/// that value, and the site decides: the same kind of list, records of its own, and another value handed over or
/// none. Only where the answer holds exactly one such value. Learn time only.
fn read_on_by_what_the_answer_hands_over(
    mut route: Route,
    step: usize,
    first: &serde_json::Value,
    inputs: &HashMap<String, String>,
    answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>,
) -> Route {
    use unbrowse_learn::graph::{Class, Field};
    use unbrowse_learn::Loc;
    // Opaque: long, one run with no space in it, and no address or sentence.
    let opaque = |v: &str| v.chars().count() >= 16 && !v.contains(char::is_whitespace) && !v.contains("://") && !v.starts_with('/');
    let Some(top) = first.as_object() else { return route };
    let handed: Vec<(&String, &str)> = top.iter().filter_map(|(k, v)| v.as_str().filter(|v| opaque(v)).map(|v| (k, v))).collect();
    let [(name, value)] = &handed[..] else { return route };
    let (name, value) = ((*name).clone(), value.to_string());
    if route.inputs.iter().any(|i| i.name == name) || route.graph.steps[step].fields.iter().any(|f| f.loc == Loc::Query(name.clone())) {
        return route;
    }
    let mut tried = route.graph.clone();
    tried.steps[step].fields.push(Field { loc: Loc::Query(name.clone()), class: Class::Unconfirmed { value: value.clone() } });
    let Some(second) = answers(&tried, inputs) else { return route };
    let (was, now) = (said_lines(first, &[]), said_lines(&second, &[]));
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [route] the answer hands over {name}: sent back, {} of {} lines are new", now.difference(&was).count(), now.len());
    }
    let moved_on = second.get(&name).and_then(|v| v.as_str()) != Some(value.as_str());
    if !(moved_on && longest_list(&second) >= 3 && lists_the_same_kind(first, &second) && now.len() >= TOO_LITTLE_TO_TELL && !nothing_of_its_own(&now, &was) && now.difference(&was).count() * 3 >= now.len()) {
        return route;
    }
    unbrowse_learn::paging::place_optional(&mut route.graph.steps[step], &Loc::Query(name.clone()), &name, Some(&value));
    eprintln!("   [route] it reads on by {name}, which each answer hands over: sent back, the site answered with records of its own");
    route.inputs.push(store::RouteInput { name: name.clone(), secret: false, default: None, file: false, optional: true, options: Vec::new() });
    route.paging = Some(unbrowse_learn::paging::Paging::Token { input: name.clone(), from: format!("/{name}") });
    route
}

/// `hears`, with the site's answers as a parameter: a test decides it without a site.
fn hears_with(route: &Route, asked: &[String], answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Hears {
    if route.write || route.socket.is_some() {
        return Hears::Unasked("it changes something on the site");
    }
    if route.browser_assisted || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return Hears::Unasked("the page makes its call");
    }
    let probed = words_asked(route, asked);
    if probed.is_empty() {
        return Hears::Unasked("none of its inputs is a word the page was asked");
    }
    if own_asks::held_at(own_asks::Ask::Nonsense, "learn::hears_with") {
        return Hears::Unasked("the node asks no made-up value (UNBROWSE_NO_NONSENSE)");
    }
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let Some(first) = answers(&route.graph, &walked) else { return Hears::Unasked("it did not answer as the walk asked it") };
    let walked_words: Vec<&str> = probed.iter().filter_map(|i| i.default.as_deref()).collect();
    let was = said_lines(&first, &walked_words);
    // Each word is moved by itself. Moved together, a setting among them (`tbm=map`) breaks the call, and a call
    // that breaks reads as one that heard: the word beside it was never asked.
    let mut deaf: Vec<String> = Vec::new();
    for i in &probed {
        let mut moved = walked.clone();
        moved.insert(i.name.clone(), NOBODYS_WORD.to_string());
        // No answer to a word nobody searches for says nothing of this word: the site heard it, or a setting broke.
        let Some(second) = answers(&route.graph, &moved) else { continue };
        let now = said_lines(&second, &[NOBODYS_WORD]);
        if was.len() < TOO_LITTLE_TO_TELL {
            return Hears::Unasked("its answer says too little to tell two apart");
        }
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
            eprintln!("   [hears] {}: {} of the walked answer's {} lines are in the answer to a word nobody searches for ({} lines)", i.name, was.intersection(&now).count(), was.len(), now.len());
        }
        // Every word is asked, whatever the one before it showed: a route that hears one of its inputs (a piece of the
        // page's address) and not another (the word the page was asked) answers every caller of that word alike, and
        // is deaf to it. Stopping at the first word that changed the answer forgot the ones that did not.
        if nothing_of_its_own(&was, &now) {
            deaf.push(i.name.clone());
        }
    }
    // Deaf only where a word that was answered left the answer as it was; where none answered, the site heard.
    if deaf.is_empty() {
        Hears::Yes
    } else {
        Hears::Deaf(deaf)
    }
}

/// Which of a route's inputs in its call's path are the call's address, on the site's word. One walk cannot tell
/// `/rest/search` + `queryText=robotics` from a call that takes two values: the page's address says both words. The
/// site can: the call is asked with one input at a time replaced by a word nobody uses, and a path piece whose
/// replacement is no call at all, while a replaced word elsewhere is still answered, is where the call lives. It is
/// kept as walked and no longer offered to the caller. With no other word to tell it from, or when both fail or
/// both answer, nothing is concluded. Learn time only, and only where the site can spare the asks.
pub(crate) fn the_calls_address(route: Route) -> Route {
    if !spares(&route, 2) {
        return route;
    }
    let mut answers = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        let mut client = unbrowse_learn::RouteClient::new(g.clone()).with_chrome_transport().with_session_store(store::jars_dir());
        client.call_with_ledger(i).0.is_ok()
    };
    the_calls_address_with(route, &mut answers)
}

fn the_calls_address_with(mut route: Route, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> bool) -> Route {
    use unbrowse_learn::graph::Class;
    use unbrowse_learn::Loc;
    if route.write || route.socket.is_some() || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return route;
    }
    // Held, nothing is concluded: every piece stays the caller's, as when both fail or both answer.
    if own_asks::held_at(own_asks::Ask::Nonsense, "learn::the_calls_address_with") {
        return route;
    }
    let Some(target) = route.graph.steps.last() else { return route };
    let named = |loc_is_path: bool| -> Vec<String> {
        target.fields.iter().filter(|f| matches!(f.loc, Loc::Path(_)) == loc_is_path).filter_map(|f| match &f.class {
            Class::Input { name, .. } => Some(name.clone()),
            _ => None,
        }).collect()
    };
    let word = |name: &String| route.inputs.iter().any(|i| &i.name == name && !i.secret && i.default.as_deref().is_some_and(a_word));
    let in_path: Vec<String> = named(true).into_iter().filter(word).collect();
    let Some(elsewhere) = named(false).into_iter().find(|n| word(n) && !in_path.contains(n)) else { return route };
    if in_path.is_empty() {
        return route;
    }
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let mut asked_with = |name: &String| {
        let mut moved = walked.clone();
        moved.insert(name.clone(), NOBODYS_WORD.to_string());
        answers(&route.graph, &moved)
    };
    // The word elsewhere first: a call that fails for any made-up word says nothing of where it lives.
    if !asked_with(&elsewhere) {
        return route;
    }
    let address: Vec<String> = in_path.into_iter().filter(|name| !asked_with(name)).collect();
    if address.is_empty() {
        return route;
    }
    eprintln!("   [route] {} in the call's path {} its address: the site has no such call without {}, and answers another {elsewhere}", address.join(", "), if address.len() == 1 { "is" } else { "are" }, if address.len() == 1 { "it" } else { "them" });
    for step in route.graph.steps.iter_mut() {
        let mut written: Vec<(String, String)> = Vec::new();
        for f in step.fields.iter_mut() {
            if let Class::Input { name, default: Some(value), .. } = &f.class {
                if address.contains(name) {
                    // The address says the piece again where it had a place for a value.
                    if let Loc::Path(at) = &f.loc {
                        written.push((format!("{{path[{at}]}}"), value.clone()));
                    }
                    f.class = Class::Constant { value: value.clone(), origin: None };
                }
            }
        }
        for (hole, value) in &written {
            step.url = step.url.replace(hole, value);
            route.path = route.path.replace(hole, value);
        }
        step.held.retain(|h| !address.contains(&h.input));
    }
    route.inputs.retain(|i| !address.contains(&i.name));
    route
}

/// Whether a value the page was asked is a word: letters in it, no flag. Two characters is a word in many scripts, and
/// a short one in any (`5G`).
fn a_word(v: &str) -> bool {
    v.chars().any(char::is_alphabetic) && !unbrowse_learn::slots::is_flag(v) && v.chars().count() >= 2
}

/// The words among what the page was asked.
fn words_of(asked: &[String]) -> Vec<String> {
    asked.iter().filter(|v| a_word(v)).cloned().collect()
}

/// The route's inputs that carry a word the page was asked (`asked` holds no flag and no bare number): what a trial
/// puts another word in place of.
fn words_asked<'r>(route: &'r Route, asked: &[String]) -> Vec<&'r store::RouteInput> {
    route.inputs.iter().filter(|i| !i.secret && !i.file).filter(|i| i.default.as_deref().is_some_and(|d| a_word(d) && asked.iter().any(|a| a.eq_ignore_ascii_case(d)))).collect()
}

/// Whether an answer holds a list of named records near its top: two or more objects, each with a word among its
/// values (a name, a symbol), not just figures. A search that found nothing (an empty list, a frame of counts) holds
/// none, however often it says the ask back. The one reader of "it holds records" for an answer a reply hands back
/// (`api::pages`) and for a confirming browse (`confirm::compared`).
pub(crate) fn holds_records(v: &serde_json::Value) -> bool {
    use serde_json::Value;
    fn named(x: &Value) -> bool {
        x.as_object().is_some_and(|o| o.values().any(|v| v.as_str().is_some_and(|s| s.chars().any(char::is_alphabetic))))
    }
    fn at(v: &Value, depth: usize) -> bool {
        match v {
            Value::Array(a) => a.iter().filter(|x| named(x)).count() >= 2 || (depth < 4 && a.iter().any(|x| at(x, depth + 1))),
            Value::Object(o) => depth < 4 && o.values().any(|x| at(x, depth + 1)),
            _ => false,
        }
    }
    at(v, 0)
}

/// Whether `walk` and `other`, another walk of the page, part on records where the page answered its ask: a call of
/// `walk` that is the call a pair of them would settle on (`at`), or one that sends a value `walk` was asked, answered
/// as data with records (`holds_records`) on one walk and with none on the other, the same call there
/// (`graph::the_same_call_there`). A walk whose ask found nothing is no sighting of the answer: paired with one that
/// found records, the build settles on whatever answers alike when there is nothing to find (a frame of counts), or
/// takes the empty answer as the call's. A reply that is no data (a page, a script) is not judged here.
fn parts_on_records(walk: &Trace, at: Option<usize>, other: &Trace) -> bool {
    let asked: Vec<String> = walk.inputs.iter().filter(|i| !i.secret && i.value.trim().chars().count() >= 2).map(|i| i.value.to_lowercase()).collect();
    let sends = |e: &Exchange| unbrowse_learn::slots::slots(e).iter().any(|s| asked.iter().any(|v| s.value.to_lowercase().contains(v.as_str())));
    // An answer that is no answer (a refusal, the site's challenge, one that says it failed: a wall's own page asked at
    // an address that names the word) says nothing of what the ask found, records or none.
    let holds = |e: &Exchange| if (200..300).contains(&e.status) && unbrowse_learn::answer::not_an_answer(e, false).is_none() { e.own_json().map(|v| holds_records(&v)) } else { None };
    (0..walk.exchanges.len())
        .filter(|&i| Some(i) == at || (!walk.exchanges[i].is_asset() && sends(&walk.exchanges[i])))
        .filter_map(|i| Some((i, holds(&walk.exchanges[i])?)))
        .any(|(i, here)| unbrowse_learn::graph::the_same_call_there(walk, i, other, &[], None).and_then(|j| holds(&other.exchanges[j])).is_some_and(|there| there != here))
}

/// An answer with fewer lines than this says too little to tell two answers apart.
const TOO_LITTLE_TO_TELL: usize = 5;

/// What an answer says, line by line, with the words it was asked struck out wherever they stand: an answer that only
/// says the ask back (in a title, in its own address) then reads the same for any word, and one whose every record
/// names the word still reads as its records. One reader for the probe with a word nobody searches for (`hears`) and
/// for two walks of one page (`experiment`).
fn said_lines(v: &serde_json::Value, words: &[&str]) -> std::collections::BTreeSet<String> {
    unbrowse_learn::slots::json_leaves(v)
        .into_iter()
        .flat_map(|(_, leaf)| leaf.lines().map(|l| l.trim().to_lowercase()).collect::<Vec<_>>())
        .map(|l| words.iter().filter(|w| !w.is_empty()).fold(l, |l, w| l.replace(&w.to_lowercase(), "\u{a7}")))
        .filter(|l| l.chars().filter(|c| c.is_alphabetic()).count() >= 4)
        .collect()
}

/// Whether `was` has nothing of its own beside `now`: a line or two may differ by a clock or an id, never the
/// records. A share of what the two have in common says little, since a results page is mostly its filters and its
/// menus whatever was asked (a package index's page shares nine lines in ten with its own "nothing found").
fn nothing_of_its_own(was: &std::collections::BTreeSet<String>, now: &std::collections::BTreeSet<String>) -> bool {
    was.len() - was.intersection(now).count() <= (was.len() / 50).max(2)
}

/// Whether the site answers this call: the trial's oracle.
fn call_answers(graph: &unbrowse_learn::Graph, inputs: &HashMap<String, String>) -> bool {
    let mut client = unbrowse_learn::RouteClient::new(graph.clone()).with_chrome_transport().with_session_store(store::jars_dir());
    client.call_with_ledger(inputs).0.is_ok()
}

/// The value the walk sent for a header on a step's call: the last request the walk made at the step's method and path,
/// as that is the one the route's shape was taken from.
fn walked_value(walked: &Trace, step: &unbrowse_learn::Step, name: &str) -> Option<String> {
    let path = url::Url::parse(&step.url).map(|u| u.path().to_string()).unwrap_or_else(|_| step.url.split('?').next().unwrap_or_default().to_string());
    let url = walked.exchanges.iter().rev().find(|e| e.method.eq_ignore_ascii_case(&step.method) && e.url.path() == path)?;
    url.request_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
}

/// An input the request sends, with a different value: a date moves a day, a number moves one, anything else gets a
/// letter. A value the site refuses makes the trial fail, and the producer stays — a false negative is safe.
fn moved_input(route: &Route, defaults: &HashMap<String, String>) -> Option<(String, String)> {
    let sent: HashSet<&str> = route.graph.steps.iter().flat_map(|s| &s.fields).filter_map(|f| match &f.class {
        unbrowse_learn::graph::Class::Input { name, .. } => Some(name.as_str()),
        _ => None,
    }).collect();
    let is_date = |v: &str| v.len() == 10 && v.as_bytes().get(4) == Some(&b'-') && v.as_bytes().get(7) == Some(&b'-') && v.chars().all(|c| c.is_ascii_digit() || c == '-');
    let mut values: Vec<(&String, &String)> = defaults.iter().filter(|(k, _)| sent.contains(k.as_str())).collect();
    values.sort_by(|a, b| a.0.cmp(b.0));
    let pick = values.iter().find(|(_, v)| is_date(v)).or_else(|| values.iter().find(|(_, v)| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))).or_else(|| values.first())?;
    let moved = match pick.1.as_bytes().iter().rposition(|b| b.is_ascii_digit()) {
        Some(i) => {
            let mut bytes = pick.1.as_bytes().to_vec();
            bytes[i] = if bytes[i] == b'9' { b'8' } else { bytes[i] + 1 };
            String::from_utf8_lossy(&bytes).into_owned()
        }
        // A word is moved by the case of its first letter: other bytes for anything that signs the request, and
        // the same word to a site that searches for it. A letter added on makes a word nobody uses, and a site that
        // honestly finds nothing for it (a place that does not exist) reads as a site that refused the call.
        None => match recased(pick.1) {
            Some(word) => word,
            None => format!("{}x", pick.1),
        },
    };
    Some((pick.0.clone(), moved))
}

/// `word` with the case of its first letter changed, where it has a letter that has another case.
fn recased(word: &str) -> Option<String> {
    let (at, first) = word.char_indices().find(|(_, c)| c.is_alphabetic())?;
    let other: String = if first.is_lowercase() { first.to_uppercase().collect() } else { first.to_lowercase().collect() };
    (other != first.to_string()).then(|| format!("{}{}{}", &word[..at], other, &word[at + first.len_utf8()..]))
}

/// The browser the page's own code saw, as this machine's walk recorded it: the fingerprint sample and the two
/// storages, kept beside the jar. A generated program that copies page code reads the same environment the page read;
/// it is the walk's, never a site's.
fn environment_of(graph: &unbrowse_learn::graph::Graph, walk: &Trace, root: &str) -> unbrowse_learn::generated::Environment {
    let Some(name) = unbrowse_learn::client::jar_name(graph) else { return unbrowse_learn::generated::Environment::default() };
    let dir = store::jars_dir();
    let fingerprint: serde_json::Value = unbrowse_files::JAR.read_at(&unbrowse_learn::client::fingerprint_path(&dir, &name)).ok().flatten().unwrap_or(serde_json::Value::Null);
    let storage: unbrowse_learn::sandbox::Storage = unbrowse_files::JAR.read_at(&unbrowse_learn::client::storage_path(&dir, &name)).ok().flatten().unwrap_or_default();
    unbrowse_learn::generated::Environment {
        fingerprint,
        storage,
        page_url: Some(root.to_string()),
        html: unbrowse_learn::trace::page_html_of(walk, &name),
        answers: unbrowse_learn::signing::answers(walk, &name),
        scripts: Vec::new(),
    }
}

/// Whether a learn writes its route by example where it has two walks of the page (`docs/REBUILD.md`), and a call of a
/// route that keeps the body it was learned as runs that body (`run`): the default since the A/B of 15 November (the
/// matrix 25 of 25 by example, 16 of 25 by the classifier); `UNBROWSE_LEARN_BY_EXAMPLE=0` learns by the classifier
/// alone, kept for one release. Read once.
pub(crate) fn learns_by_example() -> bool {
    #[cfg(test)]
    if BY_THE_CLASSIFIER.with(std::cell::Cell::get) {
        return false;
    }
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("UNBROWSE_LEARN_BY_EXAMPLE").ok().as_deref().map(str::trim) != Some("0"))
}

#[cfg(test)]
thread_local! {
    static BY_THE_CLASSIFIER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Holds this thread to the classifier's learn (`UNBROWSE_LEARN_BY_EXAMPLE=0`) while it lives: a test of what the
/// classifier keeps takes it on its first line.
#[cfg(test)]
pub(crate) struct ByTheClassifier(bool);

#[cfg(test)]
impl Drop for ByTheClassifier {
    fn drop(&mut self) {
        BY_THE_CLASSIFIER.with(|c| c.set(self.0));
    }
}

#[cfg(test)]
pub(crate) fn by_the_classifier() -> ByTheClassifier {
    ByTheClassifier(BY_THE_CLASSIFIER.with(|c| c.replace(true)))
}

/// Candidate `index` of a trace, as a route rooted at `root`: the dependency graph from the page to that call, with
/// the trace's inputs as the caller's values. `on_load` says the page sent every call in the trace by itself, as it
/// loaded, with nothing done on it (a walk). A call that is no answer (`answer::not_an_answer`), or a page the site
/// sent the browser to instead of `root`, naming `root` to come back to (a sign-in, a wall), is never kept.
#[allow(clippy::too_many_arguments)]
fn route_of(trace: &Trace, index: usize, what: &str, root: &str, on_load: bool, probes: &[unbrowse_learn::trace::Probe], history: &[(Trace, Vec<unbrowse_learn::trace::Probe>)], visited: Option<&[String]>) -> Result<Route, String> {
    route_of_by(trace, index, what, root, on_load, probes, history, visited, learns_by_example())
}

thread_local! {
    /// The recording of the walk the route being built is of, set by `keep_as` around the build: `body_by_example`
    /// reads the sender script's constants from it. None for every other build.
    static THE_RECORDING: std::cell::RefCell<Option<unbrowse_learn::recording::Recording>> = const { std::cell::RefCell::new(None) };
}

thread_local! {
    /// What each other walk of the page kept in its storage, by the walk it is of (`walked_as`), set by `keep_as`
    /// around the build beside `THE_RECORDING`: a function of the sending script that reads the page's storage is held
    /// to each walk with its own. Empty for every other build.
    static THE_OTHERS_STORED: std::cell::RefCell<Vec<(String, unbrowse_learn::sandbox::Storage)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Which walk a trace is, as `THE_OTHERS_STORED` keys it: the page its main frame went to and how many calls it holds.
fn walked_as(trace: &Trace) -> String {
    format!("{}#{}", trace.exchanges.iter().find(|e| e.is_main_document()).map(|e| e.url.as_str()).unwrap_or_default(), trace.exchanges.len())
}

/// What each other walk of the page in memory kept in its storage, by `walked_as`, where its recording held any.
fn stored_of_others(walks: &HashMap<String, Walk>, id: &str, url: &str) -> Vec<(String, unbrowse_learn::sandbox::Storage)> {
    walks
        .iter()
        .filter(|(k, _)| k.as_str() != id)
        .filter_map(|(_, w)| Some((walked_as(&w.trace), unbrowse_learn::lab::compile::storage_when_called(w.recording.as_ref()?, url)?)))
        .collect()
}

/// `f`, with `stored` the other walks' storage for the build it runs (`THE_OTHERS_STORED`), restored after.
fn with_the_others_stored<T>(stored: Vec<(String, unbrowse_learn::sandbox::Storage)>, f: impl FnOnce() -> T) -> T {
    let was = THE_OTHERS_STORED.with(|r| r.replace(stored));
    let out = f();
    THE_OTHERS_STORED.with(|r| *r.borrow_mut() = was);
    out
}

/// `f`, with `recording` the walk's for the build it runs (`THE_RECORDING`), restored after.
fn with_the_recording<T>(recording: Option<unbrowse_learn::recording::Recording>, f: impl FnOnce() -> T) -> T {
    let was = THE_RECORDING.with(|r| r.replace(recording));
    let out = f();
    THE_RECORDING.with(|r| *r.borrow_mut() = was);
    out
}

/// [`route_of`], with the learner chosen: `by_example`, the graph is learned by example from the two walks where
/// there are two, in place of the classifier's.
///
/// `visited` is every address the walk's browser was at, fragment and all (`walk::addresses_from_walk`), when the walk
/// recorded them; None when it couldn't say, which is read as a walk that may have been at an address with a fragment.
#[allow(clippy::too_many_arguments)]
/// A value the page's code wrote a session cookie into (a visitor id the site handed the browser, inside a JSON
/// parameter) is the walker's as it stands, however alike the owner's own walks all sent it. Where one cookie the
/// request sent stands in it, whole, it becomes that cookie written into the rest (`Class::CookieIn`): each caller
/// writes their own. A value fixed across the walks is that already; one that differed is so only where every other
/// walk's same call sent the same text with that walk's own cookie (or none) in its place. Anything else that carries
/// a sent cookie goes back to unconfirmed, held to what a value seen once with no source is held to
/// (`recipe::compile` keeps it off a shared body). Only a value long enough to be the walker's (`OWNED`).
/// `address` with its query value for `key` written as `{key}`: the place a call writes its own value into. None when
/// the address names `key` other than once.
fn with_its_place(address: &str, key: &str) -> Option<String> {
    let (head, rest) = address.split_once('?')?;
    let (query, fragment) = match rest.split_once('#') {
        Some((q, f)) => (q, Some(f)),
        None => (rest, None),
    };
    let mut found = 0;
    let pairs: Vec<String> = query
        .split('&')
        .map(|pair| {
            let name = pair.split('=').next().unwrap_or_default();
            if percent_encoding::percent_decode_str(&name.replace('+', " ")).decode_utf8_lossy() == key {
                found += 1;
                format!("{name}={{{key}}}")
            } else {
                pair.to_string()
            }
        })
        .collect();
    (found == 1).then(|| format!("{head}?{}{}", pairs.join("&"), fragment.map(|f| format!("#{f}")).unwrap_or_default()))
}

fn the_walkers_cookies_in_values(graph: &mut unbrowse_learn::Graph, trace: &Trace, history: &[(Trace, Vec<unbrowse_learn::trace::Probe>)]) {
    use unbrowse_learn::{graph::COOKIE_IN, Class};
    const OWNED: usize = 12;
    let carries = |value: &str, v: &str| {
        let decoded = percent_encoding::percent_decode_str(&value.replace('+', " ")).decode_utf8_lossy().into_owned();
        value.contains(v) || decoded.contains(v)
    };
    for step in &mut graph.steps {
        let Some(sent) = trace.exchanges.get(step.exchange).map(|e| e.cookies()) else { continue };
        let sent: Vec<(String, String)> = sent.into_iter().filter(|(_, v)| v.len() >= OWNED).collect();
        for f in &mut step.fields {
            if matches!(f.loc, unbrowse_learn::Loc::Cookie(_)) {
                continue;
            }
            let (value, fixed) = match &f.class {
                Class::Constant { value, origin: None } => (value.clone(), true),
                Class::Unconfirmed { value } => (value.clone(), false),
                _ => continue,
            };
            if !sent.iter().any(|(_, v)| carries(&value, v)) {
                continue;
            }
            // The longest cookie standing whole in the value, and nothing else of the session's left in the rest.
            let Some((name, v)) = sent.iter().filter(|(_, v)| value.contains(v.as_str())).max_by_key(|(_, v)| v.len()) else {
                f.class = Class::Unconfirmed { value };
                continue;
            };
            let template = value.replace(v.as_str(), COOKIE_IN);
            let clean = !value.contains(COOKIE_IN) && !sent.iter().any(|(_, other)| carries(&template.replace(COOKIE_IN, ""), other));
            let seen_so = || {
                let mut sightings = history.iter().filter_map(|(t, _)| {
                    let j = unbrowse_learn::graph::the_same_call_there(trace, step.exchange, t, &[], None)?;
                    let there = &t.exchanges[j];
                    let theirs = unbrowse_learn::slots::slots(there).into_iter().find(|s| s.loc == f.loc)?.value;
                    let cookie = there.cookies().into_iter().find(|(k, _)| k == name).map(|(_, v)| v);
                    Some(theirs == Class::cookie_in(&template, cookie.as_deref()))
                });
                let first = sightings.next();
                first == Some(true) && sightings.all(|same| same)
            };
            // Only a query's value for now: the step's address holds its place as `{key}`, as for any value the call
            // writes, so the walker's id leaves the address too. One in a body or a header stays unconfirmed.
            let unbrowse_learn::Loc::Query(key) = &f.loc else {
                f.class = Class::Unconfirmed { value };
                continue;
            };
            if !(clean && (fixed || seen_so())) {
                f.class = Class::Unconfirmed { value };
                continue;
            }
            let Some(url) = with_its_place(&step.url, key) else {
                f.class = Class::Unconfirmed { value };
                continue;
            };
            step.url = url;
            f.class = Class::CookieIn { template, name: name.clone() };
        }
    }
}

fn route_of_by(trace: &Trace, index: usize, what: &str, root: &str, on_load: bool, probes: &[unbrowse_learn::trace::Probe], history: &[(Trace, Vec<unbrowse_learn::trace::Probe>)], visited: Option<&[String]>, by_example: bool) -> Result<Route, String> {
    let mut picked = trace.exchanges.get(index).ok_or("no such call in the walk")?.clone();
    // The walk before its assets are set aside: a page's scripts are where the values its own code makes come from.
    let walked = trace;
    // A page the door let the browser through to by its own form: the door stood at the page's address, posted its
    // answer back there, and the site served the page. The post is the door's last step, its fields the door's
    // tokens, dead once used. The page a person asked for is that address fetched as any page is.
    let through_a_door = |e: &Exchange| {
        e.is_main_document()
            && e.method.eq_ignore_ascii_case("POST")
            && trace.exchanges.iter().take_while(|d| !std::ptr::eq(*d, e)).any(|d| {
                d.is_main_document() && d.method.eq_ignore_ascii_case("GET") && d.url == e.url && unbrowse_learn::page::a_door(d.status, d.response_body.as_deref().unwrap_or_default(), &d.url)
            })
    };
    let as_asked = |e: &Exchange| {
        let mut page = e.clone();
        page.method = "GET".into();
        page.request_body = None;
        page.request_headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type") && !k.eq_ignore_ascii_case("content-length") && !k.eq_ignore_ascii_case("origin"));
        page
    };
    let passed: Vec<usize> = (0..trace.exchanges.len()).filter(|&i| through_a_door(&trace.exchanges[i])).collect();
    let reread: Trace;
    let trace = match passed.is_empty() {
        true => trace,
        false => {
            reread = Trace { exchanges: trace.exchanges.iter().enumerate().map(|(i, e)| if passed.contains(&i) { as_asked(e) } else { e.clone() }).collect(), inputs: trace.inputs.clone() };
            if passed.contains(&index) {
                picked = reread.exchanges[index].clone();
            }
            &reread
        }
    };
    // A page's scripts can run to megabytes, and nearly all of them say nothing of the call: the graph is built
    // without them. One that spells out a value the call sends stays, since that may be where the value comes from
    // (a widget's loader, written for the visit with the token its calls send). Whether it is, a second sighting
    // says: one walk reads such a value as the site's constant.
    let sent: Vec<String> = unbrowse_learn::slots::slots(&picked).into_iter().map(|s| s.value).filter(|v| v.len() >= 12).collect();
    let spells_a_value = |e: &Exchange| e.is_static_code() && e.response_body.as_deref().is_some_and(|b| sent.iter().any(|v| b.contains(v.as_str())));
    let mut lean = Trace {
        exchanges: trace.exchanges.iter().filter(|e| !e.is_asset() || (e.method == picked.method && e.url == picked.url) || spells_a_value(e)).cloned().collect(),
        inputs: trace.inputs.clone(),
    };
    // The values the page's address carries into its own calls (`/search/climate` -> `?query=climate`) are the
    // caller's: the walk reached the page by the address, not by typing, and the same rule that names a path piece
    // for the decision names it for the route. A typed value already in the walk is left as it is.
    for (name, value) in path_inputs(root, what, &lean).0 {
        if lean.inputs.iter().any(|i| i.value == value || (i.name == name && i.value != value)) {
            continue;
        }
        lean.inputs.push(Input::new(&name, &value));
    }
    let trace = &lean;
    let (target, readings) = first_of_repeats(trace, &picked);
    // Another walk of the page already in memory that made this call too is a second sighting of it (the walk for a
    // second word, made behind every learn): the builder settles from the two what one walk leaves unexplained. A
    // value the same on both is the site's constant; one that moved is traced to whatever handed it over each time.
    // Made this call: the same call by the one reader for that (`graph::the_same_call_there`), never just some call
    // at its address. A walk that met a door made the page's other calls and not this one.
    let here = trace.exchanges.iter().position(|e| e.method == target.method && e.url == target.url && e.request_body == target.request_body);
    // A walk whose ask found nothing where this one found records, or found records where this one found nothing, is
    // no sighting of the answer (`parts_on_records`): the next walk is the second sighting, else this walk stands alone.
    // The signer still reads every walk (`signing::discover`): a header is sent alike whatever the ask found.
    let sighted: Vec<&Trace> = history
        .iter()
        .map(|(t, _)| t)
        .filter(|t| {
            let parted = parts_on_records(trace, here, t);
            if parted {
                eprintln!("   [route] a walk of the page whose ask found nothing is no sighting of the answer: passed over");
            }
            !parted
        })
        .collect();
    let again = sighted.iter().copied().find(|t| here.and_then(|i| unbrowse_learn::graph::the_same_call_there(trace, i, t, &[], None)).is_some_and(|j| (200..300).contains(&t.exchanges[j].status)));
    let sightings: Vec<Trace> = std::iter::once(trace.clone()).chain(again.cloned()).collect();
    if again.is_some() && std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [route] built from two walks of the page: the second settles what the first left unexplained");
    }
    let is_target = |e: &Exchange| e.method == target.method && e.url == target.url && e.request_body == target.request_body;
    let mut graph = unbrowse_learn::build(&sightings, is_target).map_err(|e| format!("couldn't build the route: {e}"))?;
    // By example: the same two walks, read by the learner by example, write the graph in the classifier's place. Where
    // it writes none, the classifier's stands, and says why. The body it writes is kept beside whichever graph stands.
    // One walk is enough to write one: what one sighting can say (`compile::body_by_example`), so the first ask, and a
    // page whose door refused the second walk, are answered from the body too.
    let mut body = None;
    if by_example {
        use unbrowse_learn::lab::compile::{body_by_example_stored, counted, counted_body};
        // Every walk of the page in hand that made the call, not the newest alone.
        // The same call by the one reader for that (`graph::the_same_call_there`): a walk for another word asks it at an
        // address that names that word (`/tag/airpods/` beside `/tag/mechanical-keyboard/`), and is a sighting all the same.
        let made_it = |t: &&Trace| {
            t.exchanges.iter().any(|e| e.method == target.method && e.url.host_str() == target.url.host_str() && e.url.path() == target.url.path() && (200..300).contains(&e.status))
                || here.and_then(|i| unbrowse_learn::graph::the_same_call_there(trace, i, t, &[], None)).is_some_and(|j| (200..300).contains(&t.exchanges[j].status))
        };
        let others: Vec<&Trace> = sighted.iter().copied().filter(made_it).collect();
        let others_stored: Vec<Option<unbrowse_learn::sandbox::Storage>> = THE_OTHERS_STORED.with(|s| others.iter().map(|t| s.borrow().iter().find(|(k, _)| *k == walked_as(t)).map(|(_, v)| v.clone())).collect());
        let learned = THE_RECORDING.with(|rec| body_by_example_stored(trace, root, &others, is_target, rec.borrow().as_ref(), &others_stored));
        match learned {
            Ok(learned) => {
                // Where a graph says the body, the graph is the body, and every later pass edits it. The body is kept
                // beside the graph all the same, for what only it holds: its tests and its plan, what it was learned
                // against and how to learn it again. A call lays over the graph only what a graph cannot say
                // (`body::overlay`), so a body a graph says lays nothing, and the graph runs.
                let mut kept = learned.body;
                // Every value the learn took as the caller's, as the walk came in (the address's own, and the pieces of
                // its path the site said are the caller's), not the path's reading added here: the values the trial
                // asks the page again for another word. The page is learned again from all of them, whether or not
                // the call takes each.
                let asked: Vec<(String, String)> = walked.inputs.iter().filter(|i| !i.secret).map(|i| (i.name.clone(), i.value.clone())).collect();
                let secret: Vec<(String, String)> = trace.inputs.iter().filter(|i| i.secret).map(|i| (i.name.clone(), i.value.clone())).collect();
                // The page this walk went to, set beside the page each other walk went to (its first main-frame
                // document on the page's own site): what they differ by is what was asked (`compile::plan_of`).
                let site = url::Url::parse(root).ok().and_then(|u| u.host_str().map(String::from));
                let went_to = |t: &Trace| t.exchanges.iter().find(|e| e.is_main_document() && e.url.host_str().map(String::from) == site).map(|e| e.url.to_string());
                let again: Vec<String> = others.iter().filter_map(|t| went_to(t)).collect();
                kept.plan = unbrowse_learn::lab::compile::plan_of(root, &again.iter().map(String::as_str).collect::<Vec<_>>(), what, &asked, &secret, Vec::new());
                match learned.graph {
                    Ok(said) => {
                        eprintln!("   [route] learned by example: {} (the classifier's reading of the same walks: {})", counted(&said), counted(&graph));
                        graph = said;
                        the_sites_own_kept(&mut graph, walked, root);
                    }
                    Err(unsaid) => {
                        eprintln!("   [route] learned by example: {}, which a graph cannot say ({unsaid}); the classifier's graph is kept beside it", counted_body(&kept));
                        let read = sent_from_the_graphs_sources(&mut kept, &graph);
                        if !read.is_empty() {
                            eprintln!("   [route] the body reads {} from the earlier answer the graph reads them from, not as walked", read.join(", "));
                        }
                    }
                }
                body = Some(kept);
            }
            Err(why) => eprintln!("   [route] not learned by example, so the classifier's graph stands: {why}"),
        }
    }
    if let Some(step) = graph.steps.last_mut() {
        readings.iter().for_each(|r| unbrowse_learn::paging::apply(step, r));
        // Sent by the page as it loaded, answering with data of the server's own: every visit sends it again.
        // So do the calls before it in the chain: the page sent them too, with nothing done on it.
        step.on_load = on_load && (200..300).contains(&target.status) && target.response_body.as_deref().is_some_and(|b| !b.trim().is_empty()) && !target.echoes_its_request();
    }
    // A cookie that came back on one sighting of a call and not on another was not the call's doing: the site's edge
    // hands one out on whichever answer it likes. Only a call that sets one every time it is made establishes
    // something by being made.
    if let Some(step) = graph.steps.last_mut().filter(|s| s.sets_cookie) {
        let again = trace.exchanges.iter().filter(|e| e.method == target.method && e.url.host_str() == target.url.host_str() && e.url.path() == target.url.path() && (200..300).contains(&e.status));
        // Nor is one on the answer to a call that asked: it sends what the caller asked for, and its answer lists
        // records that say it back. A search answers a question, whatever its edge sets beside the answer.
        let asked: Vec<&str> = trace.inputs.iter().filter(|i| !i.secret && i.value.chars().count() >= 3).map(|i| i.value.as_str()).collect();
        let sends = |v: &str| unbrowse_learn::trace::carries_whole(target.url.as_str(), v) || target.request_body.as_deref().is_some_and(|b| unbrowse_learn::trace::carries_whole(b, v));
        let says_back = |v: &str| target.own_json().is_some_and(|json| longest_list(&json) >= 2 && said_lines(&json, &[]).iter().filter(|line| line.contains(&v.to_lowercase())).count() >= 2);
        let asks = on_load && asked.iter().any(|v| sends(v) && says_back(v));
        if asks || (again.clone().count() >= 2 && again.clone().any(|e| e.set_cookies().is_empty())) {
            step.sets_cookie = false;
        }
    }
    if on_load {
        let before = graph.steps.len().saturating_sub(1);
        graph.steps[..before].iter_mut().filter(|s| (200..300).contains(&s.status)).for_each(|s| s.on_load = true);
    }
    let write = graph.steps.last().is_some_and(unbrowse_learn::ledger::writes);
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        for f in graph.steps.last().into_iter().flat_map(|s| &s.fields).filter(|f| !matches!(f.loc, unbrowse_learn::Loc::Path(_) | unbrowse_learn::Loc::Cookie(_)) && !matches!(f.class, unbrowse_learn::Class::Constant { .. } | unbrowse_learn::Class::Input { .. })) {
            let class = serde_json::to_value(&f.class).unwrap_or_default();
            eprintln!("   [route] as built, {:?} is {}", f.loc, serde_json::json!({ "class": class["class"] }));
        }
    }
    if let Some(why) = unbrowse_learn::answer::not_an_answer(&target, write) {
        return Err(format!("that call is no answer, so no route was kept: {why}"));
    }
    if let Ok(asked) = url::Url::parse(root) {
        if target.is_main_document() && unbrowse_learn::answer::detour(&asked, &target.url) {
            return Err(format!("the site sent the page to {} instead, naming it to come back to (a sign-in or a wall), so no route was kept", target.url.path()));
        }
    }
    // The graph rides on the route to disk: a secret input keeps no value there either, only a vault login's or
    // card's name.
    for f in graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
        if let unbrowse_learn::Class::Input { secret: true, default, .. } = &mut f.class {
            if default.as_deref().is_some_and(|d| !crate::vault::is_ref(d)) {
                *default = None;
            }
        }
    }
    // A header value seen once with no source (a bearer token the page held) is the session's: the jar keeps it,
    // beside the cookies, and the route on disk only names it.
    let mut held = unbrowse_learn::graph::session_headers(&mut graph, walked);
    // What the page kept in its storage under the same name a call sends: the session's too. The walk's storages are
    // beside the session, written where the browser was read; the jar takes the values (a route stores no storage).
    let host = url::Url::parse(root).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let stored: unbrowse_learn::sandbox::Storage = store::read_json(&unbrowse_learn::client::storage_path(&store::jars_dir(), &host), &unbrowse_files::JAR);
    if !stored.local.is_empty() || !stored.session.is_empty() {
        held.extend(unbrowse_learn::graph::session_storage(&mut graph, &stored));
    }
    // What the walk saw twice, the same, needed no source: the call's own setting. What differs between the sightings
    // is what the page computes per call, and stays for a producer.
    if let Some(again) = repeat_of(trace, &target) {
        settle_repeats(&mut graph, &again);
    }
    graph.page_origin = unbrowse_learn::graph::origin_of(root);
    let jar = unbrowse_learn::client::jar_name(&graph);
    // One address can answer many operations (a GraphQL endpoint): the body's values that name the operation are part
    // of which call it is, so two operations are two routes, never one that a judgment of either rewrites.
    let id = {
        let operation = graph.steps.last().map(operation_of).unwrap_or_default();
        let h = Keccak256::digest(format!("{} {}{operation}", target.method, target.url).as_bytes());
        hex::encode(&h[..8])
    };
    let what = if what.trim().is_empty() { format!("{} {}", target.method, target.url.path()) } else { what.trim().to_string() };
    let offered = offered_by(&target, &readings, &mut graph);
    // A page that links to its own next page says how it is read on, with nothing clicked: the link is its own
    // address with one value more, and that value is 2 (`next_page_linked`).
    let linked = offered.paging.is_none().then(|| next_page_linked(&target)).flatten();
    if let (Some(key), Some(step)) = (&linked, graph.steps.last_mut()) {
        if !step.fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Query(key.clone())) {
            unbrowse_learn::paging::place_optional(step, &unbrowse_learn::Loc::Query(key.clone()), key, Some("2"));
        }
    }
    let mut route = Route::from_graph(id, what, root.to_string(), graph).ok_or_else(|| "the route has no target step".to_string())?;
    route.body = body;
    route.offer_the_bodys_slots();
    route.paging = offered.paging.or_else(|| linked.filter(|key| route.inputs.iter().any(|i| i.name == *key && i.optional)).map(|input| unbrowse_learn::paging::Paging::Count { input, step: 1 }));
    // A header the page's own code writes is a value with a producer the walk recorded, not one only a browser can
    // make: the walk's scripts name it, and replay asks the transport to run it (`Class::Script`).
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        eprintln!("   [sign] {} probes for the route learned on {}", probes.len(), target.url.path());
    }
    let env = environment_of(&route.graph, walked, root);
    unbrowse_learn::signing::discover(&mut route.graph, walked, probes, &env, history);
    // The page itself: a bundle that reads a `<meta>` or a config `<script>` when it signs finds what this walk saw,
    // and a step that reads the page answers from it. A route with neither carries no page.
    if !route.graph.scripts.is_empty() || route.graph.steps.iter().any(|s| s.reads_page) {
        let site = target.url.host_str().unwrap_or_default();
        // The data the page read, before the page it painted: a bundle's start-up asks its own config, and the walk
        // already holds the answer. The markup stays as the fallback for a script that reads the DOM.
        unbrowse_learn::signing::record(&mut route.graph, walked, site);
        route.graph.page_html = unbrowse_learn::trace::page_html_of(walked, site);
        // The set of scripts a route keeps is the page's whole document, and its call needs only part of it
        // (`signing::compact`): each script is dropped only while the page still makes the call in the sandbox, so the
        // reduced set is verified by execution. Off by default — it costs one boot per script — and a page that makes
        // no such call in the sandbox keeps the full set, which the bridge runs as before.
        if std::env::var_os("UNBROWSE_COMPACT").is_some() {
            if let Some(tip) = route.graph.steps.last().cloned() {
                if let Some(c) = unbrowse_learn::signing::compact(&mut route.graph, &tip) {
                    eprintln!("   [sign] scripts {} -> {} ({:.0} KB -> {:.0} KB)", c.before, c.after, c.before_bytes as f64 / 1024.0, c.after_bytes as f64 / 1024.0);
                }
            }
        }
    }
    // The wall the walk met, if it met one: a call that meets it again is told what it is (and what earns a fresh
    // credential) instead of treating it as the site drifting.
    route.graph.door = unbrowse_learn::graph::Door::met(walked, &unbrowse_learn::identity::site_of(target.url.host_str().unwrap_or_default()));
    // The page a signing bridge boots the scripts against, with the caller's values as `{name}` where the walk's own
    // rode: the page then reads what this call asks, not what the walk asked. Only a query value is templated, and
    // only where it is the whole value: a value that is part of the path (`ow` in `showfarefirst`) stays the path.
    let mut page = root.to_string();
    if let Ok(mut u) = url::Url::parse(root) {
        let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let mut changed = false;
        if !pairs.is_empty() {
            u.query_pairs_mut().clear();
            for (k, v) in pairs {
                let named = route.inputs.iter().find(|i| i.default.as_deref() == Some(v.as_str()) && !unbrowse_learn::slots::bound_by_key(&v)).map(|i| format!("{{{}}}", i.name));
                changed |= named.is_some();
                u.query_pairs_mut().append_pair(&k, named.as_deref().unwrap_or(&v));
            }
        }
        // A page asked through its fragment (`#q=dividend`, `trace::asked_pairs`) is templated there the same way.
        if let Some(fragment) = u.fragment().map(String::from).filter(|f| f.contains('=')) {
            let (head, asked) = fragment.split_once('?').map(|(h, q)| (format!("{h}?"), q.to_string())).unwrap_or_else(|| (String::new(), fragment.clone()));
            let mut named_any = false;
            let again: Vec<String> = asked
                .split('&')
                .map(|pair| match pair.split_once('=') {
                    Some((k, v)) => {
                        let value = url::form_urlencoded::parse(format!("v={v}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default();
                        match route.inputs.iter().find(|i| i.default.as_deref() == Some(value.as_str()) && !unbrowse_learn::slots::bound_by_key(&value)) {
                            Some(i) => {
                                named_any = true;
                                format!("{k}={{{}}}", i.name)
                            }
                            None => pair.to_string(),
                        }
                    }
                    None => pair.to_string(),
                })
                .collect();
            if named_any {
                u.set_fragment(Some(&format!("{head}{}", again.join("&"))));
                changed = true;
            }
        }
        if changed {
            page = u.to_string().replace("%7B", "{").replace("%7D", "}");
        }
        // A piece of the path that is, whole, a word the caller gives (`/search/climate`) is templated too: a page
        // opened for another word must be that word's page, or its own code makes the walked word's call again.
        let named: Vec<(usize, String)> = u
            .path_segments()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(n, piece)| {
                let piece = percent_encoding::percent_decode_str(piece).decode_utf8_lossy().into_owned();
                route.inputs.iter().find(|i| !i.secret && i.default.as_deref() == Some(piece.as_str()) && a_word(&piece) && !address_setting(&piece)).map(|i| (n, i.name.clone()))
            })
            .collect();
        if !named.is_empty() {
            if let Some((head, rest)) = page.split_once("://").and_then(|(scheme, after)| after.split_once('/').map(|(host, rest)| (format!("{scheme}://{host}"), rest.to_string()))) {
                let (path, tail) = match rest.find(['?', '#']) {
                    Some(at) => (rest[..at].to_string(), rest[at..].to_string()),
                    None => (rest.clone(), String::new()),
                };
                let pieces: Vec<String> = path.split('/').enumerate().map(|(n, p)| named.iter().find(|(at, _)| *at == n).map_or(p.to_string(), |(_, name)| format!("{{{name}}}"))).collect();
                page = format!("{head}/{}{tail}", pieces.join("/"));
            }
        }
    }
    route.graph.page = Some(page);
    for i in &mut route.inputs {
        i.options = offered.keys.get(&i.name).cloned().unwrap_or_default();
    }
    // No session is kept for a host the owner excluded; the route itself is refused when it is kept.
    if let Some(name) = jar.filter(|_| !held.is_empty() && store::excluded_host(&route, &store::load_settings().excluded).is_none()) {
        let path = store::jar_path(&name);
        let mut jar: std::collections::BTreeMap<String, String> = store::read_json(&path, &unbrowse_files::JAR);
        jar.extend(held);
        store::write_json(&path, &unbrowse_files::JAR, &jar)?;
    }
    the_walkers_cookies_in_values(&mut route.graph, trace, history);
    withhold_secrets(&mut route, &trace.inputs)?;
    // Read from the whole walk, its scripts included: the lean trace the graph was built from sets them aside.
    route.page_made = page_made(&route.graph, walked, root);
    route.walk_without_fragment = walk_without_fragment(root, visited, walked);
    if target.is_main_document() && !route.write && goal::only_reads(&route.what) && !wants_one(&route.what) {
        let fields = goal::fields(&route.what);
        let values: Vec<String> = route.inputs.iter().filter(|input| !input.secret && !input.optional)
            .filter_map(|input| input.default.as_ref()).filter(|value| a_word(value) && !address_setting(value)).cloned().collect();
        if let Some(term) = values.iter().max_by_key(|value| (value.split_whitespace().count(), value.len()))
            .filter(|_| fields.iter().any(|field| field.shape == goal::Shape::Link))
        {
            route.heard.records_at = confirm::as_the_route_reads(&route, &target, &values)
                .and_then(|answer| {
                    let anchors = std::cell::OnceCell::new();
                    confirm::observed_search_list(&answer, term, |rows| {
                        let holding = goal::holding_for_goal(rows, &fields, &values, &route.what);
                        if holding.has_shapes() && holding.has_record_fields(&route.what, &fields) {
                            return Some(holding.covered.len());
                        }
                        let anchors = anchors.get_or_init(|| unbrowse_learn::page::links_beside_state(
                            target.response_body.as_deref().unwrap_or_default(), &target.url, &answer,
                        ));
                        goal::holding_with_rendered_links(rows, anchors, &fields, &values, &route.what)
                            .map(|result| result.holding.covered.len())
                    })
                });
            route.heard.document_records = route.heard.records_at.is_some();
        }
    }
    // Both judged now, by this build's rules: a route judged by others is read as unjudged.
    route.read_by = Some(store::ReadBy::current());
    Ok(route)
}

/// The body kept beside the classifier's graph sends a place from where the graph reads it: where the graph has that
/// place read from an earlier step's answer (`Derived`) and the body has a step for that answer, the body's own ways
/// for it (a walked literal, a caller's value spliced into one) give way to the graph's read. A value the walk saw
/// once is the walk's; one a step answers each time is read from that answer on every call, so state the page hands
/// over on each load (a cursor, a session, a token) is never sent as recorded. A place the body already reads from
/// an earlier answer keeps its own reading. Answers the places it changed.
fn sent_from_the_graphs_sources(body: &mut unbrowse_learn::route::Route, graph: &unbrowse_learn::Graph) -> Vec<String> {
    let from = unbrowse_learn::body::from_graph(graph, &body.site);
    let ids: Vec<String> = body.steps.iter().map(|s| s.id.clone()).collect();
    let mut changed = Vec::new();
    for step in &mut body.steps {
        // The graph's step for this one: the same step, or the same call learned from another sighting of it (the body
        // and the graph may each have taken a different one of a call the page made several times).
        let address = |url: &str| url.split('?').next().unwrap_or_default().to_string();
        let Some(theirs) = from.steps.iter().find(|s| s.id == step.id).or_else(|| from.steps.iter().find(|s| s.method == step.method && address(&s.url) == address(&step.url))) else { continue };
        for hole in &mut step.holes {
            if hole.ways.iter().any(|w| !w.expr.reads().is_empty()) {
                continue;
            }
            let Some(read) = theirs.holes.iter().find(|h| h.at == hole.at) else { continue };
            let reads: Vec<&str> = read.ways.iter().flat_map(|w| w.expr.reads()).collect();
            let answered_here = |id: &str| ids.iter().position(|s| s == id).is_some_and(|at| ids.iter().position(|s| *s == step.id).is_some_and(|me| at < me));
            if reads.is_empty() || !reads.iter().all(|id| answered_here(id)) {
                continue;
            }
            hole.ways = read.ways.clone();
            hole.open = false;
            changed.push(format!("{} {}", step.id, hole.at));
        }
    }
    // What the body says it learned of those places says so too.
    for test in &mut body.tests {
        for seen in test.sightings.iter_mut().flat_map(|s| s.seen.iter_mut()) {
            if changed.iter().any(|c| *c == format!("{} {}", test.step, seen.at)) {
                seen.from = unbrowse_learn::route::Source::Read;
            }
        }
    }
    changed
}

/// A value the learner by example left open for want of a second sighting (`Unconfirmed`) that the site served whole
/// before any of the walk's page code ran (the walk's first document and what it names that was fetched before then,
/// [`sources_before_code`]) is the site's own constant: no page code made it, from the fragment or anything else. It is
/// kept as the classifier keeps it, so the sharing boundary lists a route whose only open values are the site's
/// (`recipe::compile_with`). A cookie or a header stays as it was: those are the session's, however the site wrote them.
fn the_sites_own_kept(graph: &mut unbrowse_learn::Graph, walked: &Trace, root: &str) {
    let Ok(mut bare) = url::Url::parse(root) else { return };
    bare.set_fragment(None);
    let (_, served) = sources_before_code(walked, &bare);
    for f in graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
        if matches!(f.loc, unbrowse_learn::slots::Loc::Cookie(_) | unbrowse_learn::slots::Loc::Header(_)) {
            continue;
        }
        if let unbrowse_learn::Class::Unconfirmed { value } = &f.class {
            if !value.is_empty() && served.iter().any(|b| unbrowse_learn::trace::carries_whole(b, value)) {
                f.class = unbrowse_learn::Class::Constant { value: value.clone(), origin: None };
            }
        }
    }
    graph.provisional = graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, unbrowse_learn::Class::Unconfirmed { .. }));
}

/// The version of what explains a constant ([`page_made`], [`sources_before_code`]). Bump it whenever that changes: a
/// `page_made` judged by another version is never read as explained (`recipe::compile_with`). 1 read pairs in the
/// walked address's own fragment; 2 any fragment of it, from the navigated document and what it names; 3 the walk's
/// first document only, never one that came with a cookie or a later one; 4 every walked value a field sends, one the
/// learner left open (`Unconfirmed`) as much as a constant.
pub const PAGE_MADE_RULE: u32 = 4;

/// The texts the route carries that the walk wrote and that no source the page's own code couldn't have shaped explains,
/// by where each goes (`step N <place>`). Read for every route; it decides listing for one whose walk was at an address
/// with a fragment, or can't say it wasn't ([`walk_without_fragment`]).
///
/// A fragment never reaches a server, and the page's code reads it whole (`location.hash`), so everything after a `#`
/// is the owner's alone, however it is written: nothing here depends on recognising its pieces. What the page's code
/// makes from it (a piece cut out, two joined, one wrapped in base64 or a token, a cookie set from it that a later
/// page says back) can't be found by its text, so a text counts as the site's only when bytes no page code could have
/// shaped hold it whole ([`sources_before_code`]): the walked address outside its fragment, the walk's first document,
/// and what that document names that was fetched before any of the page's code could run. Anything else may be the
/// page's own work on the fragment, and such a route isn't listed (`recipe::compile_with`). An answer to a call the page
/// made never counts, whatever its method and however the document names it: the site could say back what it was
/// sent. A header the page's script can't set (a `sec-` header, `referer`) and a header value the browser itself sent
/// on its first navigation are the browser's.
///
/// [`PAGE_MADE_RULE`] names this rule's version: bump it whenever what counts as a source changes.
fn page_made(graph: &unbrowse_learn::Graph, trace: &Trace, root: &str) -> Option<Vec<String>> {
    let walked = url::Url::parse(root).ok()?;
    let mut bare = walked.clone();
    bare.set_fragment(None);
    let (navigated, served) = sources_before_code(trace, &bare);
    let browsers_own = |loc: &unbrowse_learn::slots::Loc, v: &str| match loc {
        unbrowse_learn::slots::Loc::Header(h) => unbrowse_learn::sandbox::forbidden_header(h) || navigated.iter().any(|(k, nv)| k.eq_ignore_ascii_case(h) && nv == v),
        _ => false,
    };
    let checks: Vec<_> = graph.steps.iter().map(|step| {
        let host = unbrowse_learn::replay::step_host(&step.url).filter(|host| !bare.host_str().is_some_and(|h| h.eq_ignore_ascii_case(host)));
        let fields: Vec<_> = step.fields.iter().map(|field| {
            let value = match &field.class {
                unbrowse_learn::Class::Constant { value, .. } | unbrowse_learn::Class::Unconfirmed { value }
                    if !matches!(field.loc, unbrowse_learn::slots::Loc::Cookie(_)) && !browsers_own(&field.loc, value) => Some(value.as_str()),
                _ => None,
            };
            let browser_key = matches!(&field.loc, unbrowse_learn::slots::Loc::Header(h) if unbrowse_learn::sandbox::forbidden_header(h) || navigated.iter().any(|(k, _)| k.eq_ignore_ascii_case(h)));
            let keys = if browser_key { Vec::new() } else { loc_words(&field.loc) };
            (&field.loc, value, keys)
        }).collect();
        let mut keys = Vec::new();
        shape_keys(step.response_shape.as_ref(), &mut keys);
        (host, fields, keys)
    }).collect();
    let words = checks.iter().flat_map(|(host, fields, keys)| {
        let field_words = fields.iter().flat_map(|(_, value, keys)| value.iter().copied().chain(keys.iter().map(String::as_str)));
        host.as_deref().into_iter().chain(field_words).chain(keys.iter().map(String::as_str))
    });
    let explained = unbrowse_learn::trace::whole_values(std::iter::once(bare.as_str()).chain(served), words);
    // Every text the route would carry that the walk wrote, not only a value: the key a value goes under (a query
    // name, a header name, a JSON or form key, a cookie name), the host a step goes to, and the keys of the answer it
    // expects. Any of them may be the page's own work on the fragment as much as a value may.
    let unexplained = |word: &str| !explained.contains(&word.to_lowercase());
    let mut made = Vec::new();
    for (n, (host, fields, keys)) in checks.into_iter().enumerate() {
        let at = |what: String| format!("step {} {what}", n + 1);
        if let Some(host) = host.filter(|host| unexplained(host)) {
            made.push(at(format!("host {host}")));
        }
        for (loc, value, keys) in fields {
            // Every value the walk sent that the route sends again, whichever learner made the graph and however it
            // classed the value: a constant, or one left open for the caller to fill (`Unconfirmed`). A value the page
            // made from the fragment is the owner's either way, and a route that asks for it isn't shared, even empty.
            if value.is_some_and(unexplained) {
                made.push(at(loc.to_string()));
            }
            if let Some(key) = keys.into_iter().find(|w| !w.is_empty() && unexplained(w)) {
                made.push(at(format!("key {key} ({loc})")));
            }
        }
        if let Some(key) = keys.into_iter().find(|k| !k.is_empty() && unexplained(k)) {
            made.push(at(format!("answer key {key}")));
        }
    }
    Some(made)
}

/// The words a field's place is named by: a query or form name, a header or cookie name, each key of a JSON pointer
/// (array positions are places, not words), a part's name and its pointer's keys.
fn loc_words(loc: &unbrowse_learn::slots::Loc) -> Vec<String> {
    use unbrowse_learn::slots::Loc;
    let pointer = |p: &str| -> Vec<String> { p.split('/').skip(1).map(|k| k.replace("~1", "/").replace("~0", "~")).filter(|k| k.parse::<usize>().is_err()).collect() };
    match loc {
        Loc::Query(k) | Loc::Form(k) | Loc::Header(k) | Loc::Cookie(k) => vec![k.clone()],
        Loc::Json(p) => pointer(p),
        Loc::Part(k, p) => std::iter::once(k.clone()).chain(pointer(p)).collect(),
        Loc::Path(_) | Loc::Url => Vec::new(),
    }
}

/// Every key of an answer's recorded shape.
fn shape_keys(shape: Option<&serde_json::Value>, out: &mut Vec<String>) {
    match shape {
        Some(serde_json::Value::Object(m)) => m.iter().for_each(|(k, v)| {
            out.push(k.clone());
            shape_keys(Some(v), out);
        }),
        Some(serde_json::Value::Array(items)) => items.iter().for_each(|v| shape_keys(Some(v), out)),
        _ => {}
    }
}

/// What the site served before any of the walk's page code could run, read from the capture: the headers the browser
/// sent on the walk's first navigation, and the bodies of that document and of what it names that the browser fetched
/// before code could run. Nothing later in the walk: any page code that ran before it may have shaped it.
///
/// The capture records each request's resource type and the order requests were made, not what started one: a script
/// the page inserts is a `Script` request like one the parser found. So a request counts only when it provably came
/// before the first of the page's code ran: the walk's first document, when it runs no code of its own as it is parsed
/// (a `<script>` with code in it runs before anything it names arrives), and what was asked after it and no later than
/// the first script request (none of whose code has run when it is sent), whose address is written in the document (the
/// server wrote it, not the page's code), a `GET` with no body, every header the browser's own (one no script may set,
/// or the value the navigation itself sent). And none that carried a cookie, the first document included: a cookie is
/// state page code may have set (in this walk or an earlier one, from a fragment), and a site can say it back in what
/// it serves. A later document, every request after the first script, and a call the page's code made, whatever its
/// method or address, are never sources. A walk whose first exchange is not a document has no source at all.
fn sources_before_code<'a>(trace: &'a Trace, _bare: &url::Url) -> (Vec<&'a (String, String)>, Vec<&'a str>) {
    let Some(nav) = trace.exchanges.iter().position(|e| e.is_main_document()) else { return (Vec::new(), Vec::new()) };
    let carries_state = |e: &Exchange| e.request_headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("cookie"));
    let navigation = &trace.exchanges[nav];
    let navigated: Vec<&(String, String)> = navigation.request_headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie")).collect();
    // Requests before the first document came from no page of this walk; anything after it may have.
    if trace.exchanges[..nav].iter().any(|e| e.resource_type.as_deref() == Some("Script")) || carries_state(navigation) {
        return (navigated, Vec::new());
    }
    let Some(document) = navigation.response_body.as_deref() else { return (navigated, Vec::new()) };
    let mut served = vec![document];
    if unbrowse_learn::page::runs_code_as_parsed(document) {
        return (navigated, served);
    }
    let browsers_own = |(k, v): &(String, String)| unbrowse_learn::sandbox::forbidden_header(k) && !k.eq_ignore_ascii_case("cookie") || navigated.iter().any(|(nk, nv)| nk.eq_ignore_ascii_case(k) && nv == v);
    let written = |e: &Exchange| {
        let at = match e.url.query() {
            Some(q) => format!("{}?{q}", e.url.path()),
            None => e.url.path().to_string(),
        };
        e.url.path().len() > 1 && (document.contains(&at) || document.contains(&at.replace('&', "&amp;")))
    };
    for e in &trace.exchanges[nav + 1..] {
        let script = e.resource_type.as_deref() == Some("Script");
        let plain = e.method.eq_ignore_ascii_case("GET") && e.request_body.as_deref().is_none_or(str::is_empty) && e.request_headers.iter().all(browsers_own) && !carries_state(e);
        if plain && written(e) && !e.is_main_document() {
            served.extend(e.response_body.as_deref());
        }
        if script || e.is_main_document() {
            break;
        }
    }
    (navigated, served)
}

/// Whether the walk shows it was never at an address with a fragment: the walked address has none, the walk recorded
/// every address its browser was at (`visited`) and none has one, and no redirect it followed named one in its
/// `Location`. A walk that can't say (`visited` is None: a capture that doesn't record addresses) is not one.
fn walk_without_fragment(root: &str, visited: Option<&[String]>, trace: &Trace) -> bool {
    let fragment = |u: &str| u.split_once('#').is_some_and(|(_, f)| !f.is_empty());
    let Some(visited) = visited else { return false };
    let redirected = trace.exchanges.iter().filter(|e| (300..400).contains(&e.status)).filter_map(|e| e.response_header("location")).any(fragment);
    !fragment(root) && !visited.iter().any(|u| fragment(u)) && !redirected
}


/// A secret input's walked value never rides with the route, wherever the walk put it: the page the route carries and
/// the address it was learned on ask for it by name (`{name}`), and anywhere else it sits (a constant, an answer the
/// page read, the page's markup) it is cleared. A route kept or shared then carries nothing of a password the owner
/// typed or a credential the page read from its address's fragment. A vault's name for a secret is not its value, and
/// stays.
fn withhold_secrets(route: &mut Route, inputs: &[Input]) -> Result<(), String> {
    let secrets: Vec<(&str, &str)> = inputs
        .iter()
        .filter(|i| i.secret && !i.value.is_empty() && !i.value.starts_with("secret:") && !crate::vault::is_ref(&i.value))
        .map(|i| (i.name.as_str(), i.value.as_str()))
        .collect();
    if secrets.is_empty() {
        return Ok(());
    }
    route.root = asked_by_name(&route.root, &secrets);
    if let Some(page) = route.graph.page.as_mut() {
        *page = asked_by_name(page, &secrets);
    }
    // Every other place, as the route is written: each text in it, the value and the ways an address writes it.
    // A value too short to be told apart from other text (`provenance::MIN_TRACEABLE`) is withheld where it was asked
    // for and as a default, and not hunted for elsewhere: it would take pieces out of everything else.
    let forms: Vec<String> = secrets
        .iter()
        .filter(|(_, v)| v.len() >= unbrowse_learn::provenance::MIN_TRACEABLE)
        .flat_map(|(_, v)| [v.to_string(), url::form_urlencoded::byte_serialize(v.as_bytes()).collect::<String>(), percent_encoding::utf8_percent_encode(v, percent_encoding::NON_ALPHANUMERIC).to_string()])
        .collect();
    fn clear(v: &mut serde_json::Value, forms: &[String]) {
        match v {
            serde_json::Value::String(t) => {
                for f in forms {
                    if t.contains(f.as_str()) {
                        *t = t.replace(f.as_str(), "");
                    }
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|i| clear(i, forms)),
            serde_json::Value::Object(m) => m.values_mut().for_each(|i| clear(i, forms)),
            _ => {}
        }
    }
    let mut written = serde_json::to_value(&*route).map_err(|e| format!("the route couldn't be read to withhold a secret: {e}"))?;
    clear(&mut written, &forms);
    *route = serde_json::from_value(written).map_err(|e| format!("the route couldn't be kept without its secret: {e}"))?;
    Ok(())
}

/// `address` with each query or fragment pair that holds a secret's value asking for it by name instead (`k={name}`).
fn asked_by_name(address: &str, secrets: &[(&str, &str)]) -> String {
    let named = |pairs: &str| -> String {
        pairs
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some((k, v)) => {
                    let value = url::form_urlencoded::parse(format!("v={v}").as_bytes()).next().map(|(_, v)| v.into_owned()).unwrap_or_default();
                    match secrets.iter().find(|(_, s)| *s == value) {
                        Some((name, _)) => format!("{k}={{{name}}}"),
                        None => pair.to_string(),
                    }
                }
                None => pair.to_string(),
            })
            .collect::<Vec<_>>()
            .join("&")
    };
    let (before, fragment) = address.split_once('#').map(|(b, f)| (b, Some(f))).unwrap_or((address, None));
    let before = match before.split_once('?') {
        Some((head, query)) => format!("{head}?{}", named(query)),
        None => before.to_string(),
    };
    match fragment {
        Some(f) => match f.split_once('?') {
            Some((head, query)) => format!("{before}#{head}?{}", named(query)),
            None => format!("{before}#{}", named(f)),
        },
        None => before,
    }
}

/// What the target can do besides what the walk asked of it: what its repeats showed, and, when it is a page, what the
/// page offers in its own markup (`controls::read`), each query key of it an input the route now takes. A value the
/// call already sends stands as its default; an input of the caller's keeps its place and gains the choices.
fn offered_by(target: &Exchange, readings: &[unbrowse_learn::paging::Reading], graph: &mut unbrowse_learn::Graph) -> unbrowse_learn::controls::Controls {
    use unbrowse_learn::{controls::Choice, paging::Reading, slots::Loc, Class};
    let mut offered = unbrowse_learn::controls::Controls::default();
    for r in readings {
        match r {
            Reading::Paging { paging, .. } if offered.paging.is_none() => offered.paging = Some(paging.clone()),
            Reading::Choice { name, values, .. } => {
                offered.keys.insert(name.clone(), values.iter().map(|v| Choice { value: v.clone(), label: None }).collect());
            }
            _ => {}
        }
    }
    let Some(step) = graph.steps.last_mut() else { return offered };
    let page = target.response_body.as_deref().filter(|_| target.is_main_document() && target.method.eq_ignore_ascii_case("GET"));
    let Some(page) = page else { return offered };
    let read = unbrowse_learn::controls::read(page, &target.url);
    let mut bind = |key: &str, sample: Option<&str>| {
        let loc = Loc::Query(key.to_string());
        match step.fields.iter_mut().find(|f| f.loc == loc) {
            // The page's own value for it: a caller may set another, and a call that doesn't keeps this one.
            Some(f) => {
                if let Class::Constant { value, .. } | Class::Unconfirmed { value } = &f.class {
                    f.class = Class::Input { name: key.to_string(), secret: false, default: Some(value.clone()), optional: true };
                }
            }
            None => unbrowse_learn::paging::place_optional(step, &loc, key, sample),
        }
    };
    if offered.paging.is_none() {
        if let Some(p) = read.paging {
            bind(p.input(), None);
            offered.paging = Some(p);
        }
    }
    for (key, choices) in read.keys {
        if offered.paging.as_ref().is_some_and(|p| p.input() == key) {
            continue;
        }
        bind(&key, choices.first().map(|c| c.value.as_str()));
        let held = offered.keys.entry(key).or_default();
        for c in choices {
            match held.iter_mut().find(|h| h.value == c.value) {
                Some(h) => h.label = h.label.take().or(c.label),
                None => held.push(c),
            }
        }
    }
    offered
}

fn save_learned(route: Route, who: &str) -> Result<Route, String> {
    if let Some(host) = store::excluded_host(&route, &store::load_settings().excluded) {
        return Err(format!("{host} is excluded from mapping in Settings: a route that reaches it isn't kept"));
    }
    // The site's sign-in is the vault's, sent by the node itself when a call finds its session gone (`setups`): never a
    // route an agent can list, or call with a login.
    if crate::setups::is_the_sign_in(&route) {
        return Err(format!("{} is this site's sign-in: the vault keeps it, and the node signs in with it itself when a call needs it, so it isn't kept as a route", route.what));
    }
    let (route, kept) = store::keep_learned(route)?;
    // The same call already held as a listed route or the owner's own stands as it is: say so, not that it was learned.
    if !kept {
        store::log_activity(&Activity {
            at: store::now(),
            who: who.to_string(),
            site: route.site.clone(),
            what: format!("Already knows {}", route.what),
            kind: "learn".into(),
            result: "skipped".into(),
            ms: None,
            unb: None,
            tx: None,
            note: Some(if route.listing.is_some() { "it is listed, so it stays as listed" } else { "it is the owner's own, so it stays theirs" }.into()),
        });
        return Ok(route);
    }
    store::log_activity(&Activity {
        at: store::now(),
        who: who.to_string(),
        site: route.site.clone(),
        what: format!("Learned {}", route.what),
        kind: "learn".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: Some(format!("{} steps, {} inputs{}", route.steps, route.inputs.len(), if route.provisional { ", one sighting so far" } else { "" })),
    });
    Ok(route)
}

/// Whether two requests to one address are the same operation, as a repeat of a call for the next page or with a filter
/// set is: the same query keys, and the same value wherever both bodies hold, at their top, one that reads as a name
/// (letters, no digits: a GraphQL `operationName`), the caller's own values aside. A cursor, or a filter's choice (a
/// query's `sort=price`, a body's variables) may differ; another method at the same address (`method=photos.search`
/// with its own keys, beside `tags.getRelated`) is another call.
fn same_operation(a: &unbrowse_learn::Exchange, b: &unbrowse_learn::Exchange, asked: &[&str]) -> bool {
    let name = |v: &str| !v.is_empty() && v.chars().any(char::is_alphabetic) && !v.chars().any(|c| c.is_ascii_digit()) && !asked.contains(&v);
    let query = |e: &unbrowse_learn::Exchange| e.url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect::<std::collections::BTreeMap<_, _>>();
    let (qa, qb) = (query(a), query(b));
    if qa.keys().ne(qb.keys()) {
        // Two operations at one address name themselves in a common key (`method=photos.tags.getRelated` against
        // `method=photos.photos.search`): a word that differs there is another call, whatever else changed.
        let another = qa.iter().any(|(k, v)| {
            qb.get(k).is_some_and(|w| v != w && name(v) && name(w))
        });
        if another {
            return false;
        }
        // A later page of the same call adds the cursor or session token the previous answer handed it (`feedSessionId`,
        // `next`), and the first page has no such key. The key sets differ, but the call is the same: ignore an extra
        // key whose value is not a word (a token, an id, a number). A caller's value or a filter's word still tells
        // two calls apart.
        let only = |x: &std::collections::BTreeMap<String, String>, y: &std::collections::BTreeMap<String, String>| {
            x.iter().filter(|(k, _)| !y.contains_key(*k)).all(|(_, v)| !name(v))
        };
        // A first page also asks for what it shows once beside the list (`aggregations[...]=category.slug`, words),
        // which its later pages leave out, sending the cursor they were handed in their place: words only one call
        // sends, while the other alone sends a cursor, are that first page's, not another operation's.
        let a_cursor = |x: &std::collections::BTreeMap<String, String>, y: &std::collections::BTreeMap<String, String>| {
            x.iter().any(|(k, v)| !y.contains_key(k) && !name(v) && v.chars().count() >= 8)
        };
        let read_on = |x: &std::collections::BTreeMap<String, String>, y: &std::collections::BTreeMap<String, String>| only(x, y) && a_cursor(x, y);
        if !(only(&qa, &qb) && only(&qb, &qa)) && !read_on(&qa, &qb) && !read_on(&qb, &qa) {
            return false;
        }
    }
    let json = |e: &unbrowse_learn::Exchange| e.request_body.as_deref().and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok());
    match (json(a), json(b)) {
        (Some(serde_json::Value::Object(ja)), Some(serde_json::Value::Object(jb))) => {
            !ja.iter().any(|(k, va)| matches!((va, jb.get(k)), (serde_json::Value::String(x), Some(serde_json::Value::String(y))) if name(x) && name(y) && x != y))
        }
        _ => true,
    }
}

/// The keys at the top of a JSON object and under each of its members: what kind of thing an answer, or the shape
/// kept of one, is. None for anything but an object.
fn keys_of_an_answer(top: &serde_json::Value) -> Option<std::collections::BTreeSet<String>> {
    let top = top.as_object()?;
    Some(top.iter().flat_map(|(k, v)| match v.as_object() {
        Some(under) if !under.is_empty() => under.keys().map(|u| format!("{}/{}", kind_of_key(k), kind_of_key(u))).collect::<Vec<_>>(),
        _ => vec![kind_of_key(k)],
    }).collect())
}

/// Whether two answers' keys (`keys_of_an_answer`) are one kind of answer: the same members at the top, and under each
/// the same keys, where both have any. A member one answer leaves empty (a box that had nothing to show on a later
/// page) says nothing of the kind: only what both fill is held against the other.
fn of_one_kind(a: &std::collections::BTreeSet<String>, b: &std::collections::BTreeSet<String>) -> bool {
    let grouped = |keys: &std::collections::BTreeSet<String>| -> std::collections::BTreeMap<String, std::collections::BTreeSet<String>> {
        let mut out: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> = Default::default();
        for key in keys {
            match key.split_once('/') {
                Some((top, under)) => out.entry(top.to_string()).or_default().insert(under.to_string()),
                None => out.entry(key.clone()).or_default().insert(String::new()),
            };
        }
        out
    };
    let (a, b) = (grouped(a), grouped(b));
    let bare = |under: &std::collections::BTreeSet<String>| under.len() == 1 && under.contains("");
    a.len() == b.len() && a.iter().all(|(top, under)| b.get(top).is_some_and(|other| bare(under) || bare(other) || under == other))
}

/// A key as the kind of thing it names: a made-up id inside it (a run of twelve or more letters and digits holding
/// both, or of eight or more digits) is this answer's own, so `fetch__14a01385f61fa2315d41bfa117db11a8` and the
/// next page's `fetch__38276b755a394d6a3747294ddf878ae8` are one key. A word, however long, has no digit in it.
fn kind_of_key(key: &str) -> String {
    let mut out = String::new();
    let mut run = String::new();
    let close = |run: &mut String, out: &mut String| {
        let digits = run.chars().filter(char::is_ascii_digit).count();
        let made_up = (run.len() >= 12 && digits > 0 && digits < run.len()) || (digits == run.len() && digits >= 8);
        out.push_str(if made_up { "*" } else { run.as_str() });
        run.clear();
    };
    for c in key.chars() {
        if c.is_ascii_alphanumeric() {
            run.push(c);
        } else {
            close(&mut run, &mut out);
            out.push(c);
        }
    }
    close(&mut run, &mut out);
    out
}

/// Whether two calls to one address answered with the same kind of thing: where both answered with a JSON object, the
/// same keys at its top and under each. A repeat of a call (its next page, a filter set) does; two operations sharing
/// an address (a news ticker and a search, both named in one query key) do not, however alike their requests read.
/// An answer that is no object says nothing either way.
fn answers_alike(a: &unbrowse_learn::Exchange, b: &unbrowse_learn::Exchange) -> bool {
    let keys = |e: &unbrowse_learn::Exchange| e.own_json().as_ref().and_then(keys_of_an_answer);
    match (keys(a), keys(b)) {
        (Some(x), Some(y)) => of_one_kind(&x, &y),
        _ => true,
    }
}

/// When the reader asked for more, or set a filter, the walk holds the same call several times. The route is the
/// first of them that sends what the caller asked for (the same call made before it, as the page opened with nothing
/// typed yet, asked for something else), and whatever changed between it and the ones after it while the caller's
/// values stayed put says what the call can do besides (`paging::read`): read on, or take a choice. Replayed as it
/// stood, such a value would pin a new query to the old search's next page, so the first call's value is the default.
/// A slot holding one of the caller's values is theirs.
fn first_of_repeats(trace: &unbrowse_learn::Trace, picked: &unbrowse_learn::Exchange) -> (unbrowse_learn::Exchange, Vec<unbrowse_learn::paging::Reading>) {
    use unbrowse_learn::slots::slots;
    // A repeat that answered with nothing (a challenge's first load of the page, an interstitial the page replaced at
    // once) isn't the call, whatever it sent: the copy that answered is.
    // Nor is one the site held back (a 202 with a check's script in it, before the same address answered): what it
    // sent is no answer (`answer::not_an_answer`), though it is not empty.
    let answered = |e: &unbrowse_learn::Exchange| e.response_body.as_deref().is_some_and(|b| !b.trim().is_empty()) && unbrowse_learn::answer::not_an_answer(e, false).is_none();
    let same = |e: &unbrowse_learn::Exchange| e.method == picked.method && e.url.host_str() == picked.url.host_str() && e.url.path() == picked.url.path();
    let any_answered = answered(picked) || trace.exchanges.iter().any(|e| same(e) && answered(e));
    // A value too short to say anything (`slots::bound_by_key`) never tells one repeat from another: `page=2` is the
    // reader's next page, whatever `adults=2` asked.
    let asked: Vec<&str> = trace.inputs.iter().map(|i| i.value.as_str()).filter(|v| !v.is_empty() && !unbrowse_learn::slots::bound_by_key(v)).collect();
    let repeats: Vec<&unbrowse_learn::Exchange> = trace
        .exchanges
        .iter()
        .filter(|e| e.method == picked.method && e.url.host_str() == picked.url.host_str() && e.url.path() == picked.url.path())
        .filter(|e| same_operation(e, picked, &asked))
        .filter(|e| answers_alike(e, picked))
        .filter(|e| !any_answered || answered(e))
        .collect();
    // The first that sends the most of what was asked: a page that asks as it opens, before anything is typed, already
    // sends what its address says (a language), and is not the call that carries the word typed after.
    let sends_asked = |e: &unbrowse_learn::Exchange| asked.iter().filter(|v| slots(e).iter().any(|s| s.value == **v)).count();
    let most = repeats.iter().map(|e| sends_asked(e)).max().unwrap_or(0);
    let from = repeats.iter().position(|e| most > 0 && sends_asked(e) == most).unwrap_or(0);
    let repeats = &repeats[from.min(repeats.len())..];
    let first = repeats.first().map(|e| (*e).clone()).unwrap_or_else(|| picked.clone());
    if repeats.len() < 2 {
        return (first, Vec::new());
    }
    let readings = unbrowse_learn::paging::read(&first, &repeats[1..], &asked);
    (first, readings)
}

/// The walk's other sighting of this call: the same call asked again (the next page, a reload), with an address or body
/// that differs. `None` when the walk asked it once.
fn repeat_of(trace: &unbrowse_learn::Trace, target: &unbrowse_learn::Exchange) -> Option<unbrowse_learn::Exchange> {
    let asked: Vec<&str> = trace.inputs.iter().map(|i| i.value.as_str()).filter(|v| !v.is_empty() && !unbrowse_learn::slots::bound_by_key(v)).collect();
    trace
        .exchanges
        .iter()
        .filter(|e| e.method == target.method && e.url.host_str() == target.url.host_str() && e.url.path() == target.url.path())
        .filter(|e| same_operation(e, target, &asked) && answers_alike(e, target))
        .filter(|e| e.url != target.url || e.request_body != target.request_body)
        .find(|e| e.response_body.as_deref().is_some_and(|b| !b.trim().is_empty()))
        .cloned()
}

/// A value the walk saw once with no source, and saw again the same on another page of the same call, is that call's
/// setting — a locale, a location — not a signature: the site's own code sent it for a different page. What changes
/// between the two sightings stays the page's to compute.
fn settle_repeats(graph: &mut unbrowse_learn::Graph, again: &unbrowse_learn::Exchange) {
    let there = unbrowse_learn::slots::slots(again);
    let Some(step) = graph.steps.last_mut() else { return };
    for f in step.fields.iter_mut() {
        let unbrowse_learn::Class::Unconfirmed { value } = &f.class else { continue };
        let Some(s) = there.iter().find(|s| s.loc == f.loc) else { continue };
        if &s.value == value {
            f.class = unbrowse_learn::Class::Constant { value: value.clone(), origin: None };
        }
    }
}

fn words(s: &str) -> Vec<String> {
    s.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 3)
        .map(String::from)
        .collect()
}

/// What a goal is about: its words, without the ones that ask for something rather than name it. `search`, `find` and
/// `list` are in every goal and in half the calls on a page (`/api/certified-search`), so they name no answer; a subject
/// (`availability`, `restaurants`, `listings`) does.
fn subject_words(goal: &str) -> Vec<String> {
    const ASKS: &[&str] = &[
        "search", "find", "list", "get", "show", "browse", "return", "give", "fetch", "look", "want", "need", "all",
        "every", "each", "with", "from", "that", "this", "their", "them", "what", "page", "the", "and", "for",
    ];
    words(goal).into_iter().filter(|w| w.chars().count() >= 4 && !ASKS.contains(&w.as_str())).collect()
}

/// Whether a call's own address names what the goal is about: `opname=RestaurantsAvailability` for a goal about
/// restaurant availability. The site's own word for the call, in its path or its query, is the strongest evidence a
/// call answers the goal when its answer names nothing (`data.availability[].restaurantId`) — the site answered by its
/// own ids, not by repeating the words it was asked.
fn names_the_goal(e: &Exchange, goal: &str) -> bool {
    // The site's own name is in every goal on the site and in many of its addresses (`…lazadarecommend.recommend`): a
    // call that says it names the site, not what the goal asks of it.
    let site = site_of(e.url.host_str().unwrap_or_default());
    let own = site.split('.').next().unwrap_or_default().to_lowercase();
    let subject: Vec<String> = subject_words(goal).into_iter().filter(|w| own.is_empty() || *w != own).collect();
    if subject.is_empty() {
        return false;
    }
    let mut said = path_words(e.url.path());
    said.extend(path_words(e.url.query().unwrap_or_default()));
    subject.iter().any(|w| said.iter().any(|p| p.starts_with(w.as_str())))
}

/// The walked page's address, host and path, as a beacon would send it back: `www.sistic.com.sg/search-results`.
fn page_address(url: &str) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    // As read, not as escaped: a beacon escapes the address its own way, and is read back to plain text to match.
    let path = percent_encoding::percent_decode_str(u.path()).decode_utf8_lossy().into_owned();
    Some(format!("{}{}", u.host_str()?, path).to_lowercase())
}

/// Whether a call sends the page's own address: an ad conversion, an analytics hit, a tag reporting where it fired.
/// The goal's words it carries are the page's, echoed back, not an answer to the goal.
fn reports_the_page(url: &url::Url, body: Option<&str>, page: &str) -> bool {
    carries_text(url.query().unwrap_or_default(), page) || body.is_some_and(|b| carries_text(b, page))
}

/// Whether the model's pick stands against the best call that passes the rule: it may differ from the rule, but not
/// choose a call the rule scores far below the best (a goal that names a call's own words is read by the rule).
fn model_stands(model: Option<usize>, top: Option<(f64, usize)>, score_of: impl Fn(usize) -> Option<f64>) -> bool {
    model.is_some_and(|i| top.is_none_or(|(best, at)| at == i || score_of(i).is_some_and(|s| s + 1.0 >= best)))
}

/// The rule (FR-27b: answer by rule first where a rule is exact, a model otherwise): score each candidate by how
/// much of the goal it carries, in its path, its answer's keys and its answer's text, how much data it answers
/// with, and whether it is the site's own call; noise never wins. Every candidate, best first, with the reasons.
fn rule_scores(trace: &Trace, view: &WalkView, goal: &str, query_values: &[String], read: &[String]) -> Vec<(f64, usize, bool, Vec<String>)> {
    let goal_words = goal_words_of(goal, &view.site);
    let read = read_words(read, &goal_words);
    let page = page_address(&view.url);
    // A call that asks for the page's value, or answers with it, is the one the page's reader came for. When one
    // candidate does and another does neither (a page's modules, a menu, a recommendation strip), the second is not
    // the answer to the ask, however much of the page it repeats.
    let carries = |e: &Exchange| query_values.iter().any(|v| sends_its_own_ask(e, v, page.as_deref()) || carries_text(answer_of(e).as_ref(), v));
    let any_carries = view.candidates.iter().any(|c| !c.page && carries(&trace.exchanges[c.index]));
    // A page's own text says what it was asked; a client-rendered shell's does not (its results come later). When a
    // data call asks for the value and the page's text does not say it, the page is the browser's job, not the route.
    let page_says = |e: &Exchange| {
        let body = e.response_body.as_deref().unwrap_or_default();
        let read = unbrowse_learn::page::read(body, &e.url);
        let said = format!("{}\n{}", read["title"].as_str().unwrap_or_default(), read["text"].as_str().unwrap_or_default()).to_lowercase();
        query_values.iter().any(|v| !v.is_empty() && said.contains(&v.to_lowercase()))
    };
    let data_asks = view.candidates.iter().any(|c| !c.page && query_values.iter().any(|v| sends_its_own_ask(&trace.exchanges[c.index], v, page.as_deref())));
    // What the page showed the person (`unbrowse_learn::shown`): the judge of whether an answer holds what was asked.
    let shown = page_shown(&trace.exchanges, &view.url, &read);
    let mut out = Vec::new();
    for c in &view.candidates {
        let e = &trace.exchanges[c.index];
        // A call naming the page's address reports it (a beacon, an ad bid), unless it is the site's own call, or one
        // that sends what was asked as a value of its own, and its answer says that back: a search API that passes the
        // page along (`client_url=`) answers the page, on the site's host or the search provider's.
        let answers_the_ask = (unbrowse_learn::identity::on_site(&c.host, &view.site) || query_values.iter().any(|v| sends_as_its_own(e, v)))
            && e.response_body.as_deref().is_some_and(|b| query_values.iter().any(|v| v.chars().count() >= 2 && carries_text(b, v)) && answer_of(e).len() > 2);
        if !c.page && !answers_the_ask && page.as_deref().is_some_and(|p| reports_the_page(&e.url, e.request_body.as_deref(), p)) {
            out.push((0.0, c.index, true, vec!["it reports the page it fired on, never the data".to_string()]));
            continue;
        }
        // The call's own name, not the values it carries: a query echoes whatever the page put in it. Read by its
        // words (`unread-message-count` is unread, message, count), never by letters inside one (`read` in `unread`).
        let path = path_words(&bare(&c.path));
        let body = answer_of(e).to_lowercase();
        // What the answer calls its own data, at any depth: a GraphQL call names what it answers in its body
        // (`data.availability`), not in its path (`/dapi/fe/gql`), and a stream names it in each event.
        let keys = answer_key_words(e);
        let mut score = 0.0;
        let mut reasons = Vec::new();
        if any_carries && !c.page && !carries(e) {
            score -= 20.0;
            reasons.push("it neither asks nor answers the page's value".to_string());
        }
        // The page's own script writes this call's keys: those values are computable in the sandbox, so a route on
        // this call can be built without the browser. That is the slice the route carries when it is kept.
        if c.writes {
            score += 2.0;
            reasons.push("the page's own code writes a value the walk can't source".to_string());
        }
        if data_asks && c.page && !page_says(e) {
            score -= 20.0;
            reasons.push("a data call asks for the page's value; the page doesn't".to_string());
        }
        let (mut in_path, mut in_keys, mut in_body) = (Vec::new(), Vec::new(), 0);
        for w in &goal_words {
            if path.iter().any(|p| p.starts_with(w.as_str())) {
                score += 3.0;
                in_path.push(w.clone());
            }
            // A key named for a goal word is the answer's when the answer says what the page showed: a name alone is
            // a word match (an address template under `<word>_url`), not data of that kind. Where the page shows too
            // little to judge by, the name counts as before.
            if keys.iter().any(|k| k.starts_with(w.as_str())) && (!shown.judges() || shown.says(e)) {
                score += 2.0;
                in_keys.push(w.clone());
            }
            if body.contains(w.as_str()) {
                score += 1.0;
                in_body += 1;
            }
        }
        if !in_path.is_empty() {
            reasons.push(format!("its path says {}", in_path.join(", ")));
        }
        if !in_keys.is_empty() {
            reasons.push(format!("its answer has {}", in_keys.join(", ")));
        }
        if in_body > 0 && in_path.is_empty() && in_keys.is_empty() {
            reasons.push(format!("its answer mentions {in_body} of the goal's words"));
        }
        // The value the owner asked the page for shows up in the call that answers it. The page's own address is the
        // ask itself: it carries every value it was asked with by being asked, so counting them would make the page the
        // answer to every question, ahead of the call whose path and answer name it (Trip.com's `FlightListSearchSSE`
        // against the `showfarefirst` page it fills).
        for v in query_values.iter().filter(|_| !c.page) {
            let v = v.to_lowercase();
            if sends_its_own_ask(e, &v, page.as_deref()) {
                score += 6.0;
                reasons.push(format!("it sends the page's \"{v}\""));
            }
        }
        // What the agent read off the page is in the answer that filled it.
        if !read.is_empty() {
            let held = read.iter().filter(|w| body.contains(w.as_str())).count();
            let share = held as f64 / read.len() as f64;
            if share >= 0.2 {
                score += 12.0 * share;
                reasons.push(format!("its answer holds {}% of what was read off the page", (share * 100.0).round()));
            }
        }
        // A data call over the page's HTML. A call answering markup (more of the page's results, a fragment) is a
        // piece of a page, not data: it earns nothing over the page it belongs to.
        let markup = unbrowse_learn::page::is_markup(e.response_header("content-type").unwrap_or(&e.response_mime), e.response_body.as_deref().unwrap_or_default());
        if !c.page && !markup {
            score += 2.0;
        }
        if unbrowse_learn::identity::on_site(&c.host, &view.site) {
            score += 1.0;
        }
        score += (c.bytes as f64 / 1024.0).ln_1p();
        reasons.push(format!("{} of data", if c.bytes >= 1024 { format!("{} KB", c.bytes / 1024) } else { format!("{} bytes", c.bytes) }));
        // The answer that carries the list is the data call: a search's itineraries, a listing page's results. A call
        // answering a few policies beside the same search is a piece of the answer, and a page's menu is not one.
        let answer = answer_of(e);
        // The call's own JSON in any wrapping, else the state a page carries (`answer_of`).
        let parsed = e.own_json().or_else(|| serde_json::from_str::<serde_json::Value>(&answer).ok());
        if let Some(parsed) = parsed {
            let longest = longest_list(&parsed);
            if longest >= 3 {
                score += (longest as f64).ln_1p() * 1.5;
                reasons.push(format!("its answer lists {longest} records"));
            }
        }
        // The same site often offers both: a call that answers with records a reader came for (names, prices) and one
        // that answers with identifiers. The first is the answer; the second is a hint at it.

        out.push((score, c.index, false, reasons));
    }
    out.sort_by(|a, b| b.0.total_cmp(&a.0));
    out
}



/// The longest list anywhere in an answer: how many records the call actually carried.
/// The words in an answer's own key names, wherever they sit: a JSON body's keys at any depth, or a stream's events'
/// keys. A GraphQL call names what it answers in its body (`data.availability`), not in its path (`/dapi/fe/gql`), and a
/// stream names it in each event. Bounded: the first 256 KB, four levels, four items of a list, and 400 words.
fn answer_key_words(e: &Exchange) -> Vec<String> {
    fn walk(v: &serde_json::Value, depth: usize, out: &mut Vec<String>) {
        if depth > 4 || out.len() > 400 {
            return;
        }
        match v {
            serde_json::Value::Object(o) => {
                for (k, x) in o {
                    out.extend(goal::key_words(k));
                    walk(x, depth + 1, out);
                }
            }
            serde_json::Value::Array(a) => {
                for x in a.iter().take(4) {
                    walk(x, depth + 1, out);
                }
            }
            _ => {}
        }
    }
    let body = e.response_body.as_deref().unwrap_or_default();
    let body = if body.len() > 262_144 {
        let mut end = 262_144;
        while end > 0 && !body.is_char_boundary(end) {
            end -= 1;
        }
        &body[..end]
    } else {
        body
    };
    let mut out = Vec::new();
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => walk(&v, 0, &mut out),
        // A stream: each event is its own JSON, and the keys it carries are the answer's.
        Err(_) => {
            for line in body.lines().take(400) {
                let line = line.trim();
                let line = line.strip_prefix("data:").or_else(|| line.strip_prefix("event:")).unwrap_or(line).trim();
                if !line.starts_with('{') {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    walk(&v, 0, &mut out);
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn longest_list(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::Array(a) => a.len().max(a.iter().map(longest_list).max().unwrap_or(0)),
        serde_json::Value::Object(o) => o.values().map(longest_list).max().unwrap_or(0),
        _ => 0,
    }
}

/// Whether a call the page made as it loaded, with nothing typed, answers `goal`: it sends a value the url asked
/// for (`?q=rust`), or its own path or its answer's keys say one of the goal's words. Answering with the most data
/// is the page loading, not an answer: a goal that needs clicks or typing gets nothing from it. The goal's short
/// words are left out, since any path or key may hold them (`for` in `/forms`).
fn answers_goal(e: &Exchange, c: &Candidate, goal: &str, query_values: &[String]) -> bool {
    let sent = |v: &String| sends_value(e, v);
    let (path, keys) = (path_words(&bare(&c.path)), c.keys.iter().flat_map(|k| goal::key_words(k)).collect::<Vec<_>>());
    query_values.iter().any(sent) || words(goal).iter().filter(|w| w.chars().count() >= 4).any(|w| path.iter().chain(&keys).any(|p| p.starts_with(w.as_str())))
}

/// Whether a call sends `value` as a value of its own: a query's, a form's, or a JSON body's string, whole, or a string
/// of the JSON a query or a form value holds (`data={"options":{"query":"cats"}}`).
fn sends_as_its_own(e: &Exchange, value: &str) -> bool {
    let v = value.trim().to_lowercase();
    if v.chars().count() < 2 {
        return false;
    }
    let same = |s: &str| s.trim().to_lowercase() == v;
    fn walk<'a>(v: &'a serde_json::Value, out: &mut Vec<&'a str>) {
        match v {
            serde_json::Value::String(s) => out.push(s),
            serde_json::Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
            serde_json::Value::Object(o) => o.values().for_each(|x| walk(x, out)),
            _ => {}
        }
    }
    let holds = |text: &str| {
        let json = serde_json::from_str::<serde_json::Value>(text).unwrap_or(serde_json::Value::Null);
        let mut strings = Vec::new();
        walk(&json, &mut strings);
        strings.iter().any(|s| same(s))
    };
    let body = e.request_body.as_deref().unwrap_or_default();
    // Only a form body is form fields. A JSON body that carries a page along (`{"url":"…?dcity=sin&acity=tyo"}`) reads
    // as form pairs too, and `dcity=sin` inside the page's address would pass for a value of the call's own.
    let pairs = |b: &str| url::form_urlencoded::parse(b.as_bytes()).any(|(_, p)| same(&p) || holds(&p));
    let form = matches!(unbrowse_learn::slots::body_kind(e), unbrowse_learn::slots::BodyKind::Form);
    e.url.query_pairs().any(|(_, q)| same(&q) || holds(&q)) || (form && pairs(body)) || holds(body)
}

/// Whether a call carries the page's own path (`/search/cats/videos`) in its query or its body, as sent or form-encoded.
fn carries_the_path(e: &Exchange, path: &str) -> bool {
    let body = e.request_body.as_deref().unwrap_or_default();
    let lower = body.to_lowercase();
    e.url.query_pairs().any(|(_, q)| q.to_lowercase().contains(path))
        || lower.contains(path)
        || lower.contains(&path.replace('/', "\\/"))
        || url::form_urlencoded::parse(body.as_bytes()).any(|(_, b)| b.to_lowercase().contains(path))
}

/// Whether a call sends `value`, read as the site reads it: its address as sent and decoded (`apollo+11` and
/// `apollo%2011` are both "apollo 11"), and its body as sent and form-decoded.
fn sends_value(e: &Exchange, value: &str) -> bool {
    let v = value.trim().to_lowercase();
    if v.is_empty() {
        return false;
    }
    let has = |t: &str| t.to_lowercase().contains(&v);
    let body = e.request_body.as_deref().unwrap_or_default();
    has(e.url.as_str())
        || has(&percent_encoding::percent_decode_str(e.url.path()).decode_utf8_lossy())
        || e.url.query_pairs().any(|(_, q)| has(&q))
        || has(body)
        || url::form_urlencoded::parse(body.as_bytes()).any(|(k, b)| has(&k) || has(&b))
        // A binary body's fields, where a codec opens it: its bytes are no text to look in.
        || unbrowse_learn::slots::wire_texts(e).iter().any(|t| has(t))
        // An asked date, time or number the call sends in the site's own written form (`14/03/2026` for `2026-03-14`).
        || unbrowse_learn::lab::forms::sent_in_a_format(e, value)
}

/// Whether a call sends `value` as an ask of its own, never counting what the page's own address brings with it. A
/// call that carries the page along (`"url":"https://…/showfarefirst?dcity=sin&acity=tyo"`, what a site's header asks
/// its settings by) contains every value the page was asked with without asking for any of them: the address is where
/// it fired, not its ask. A call that sends the value itself (`"departCode":"SIN"` in a search's criteria) asks it.
fn sends_its_own_ask(e: &Exchange, value: &str, page: Option<&str>) -> bool {
    match page {
        Some(p) if reports_the_page(&e.url, e.request_body.as_deref(), p) => sends_as_its_own(e, value),
        _ => sends_value(e, value),
    }
}

/// Whether a call asks for `value`: in its query, in its body, or as the last piece of its address.
fn asks_by_value(e: &Exchange, value: &str) -> bool {
    let v = value.trim().to_lowercase();
    if v.is_empty() {
        return false;
    }
    let has = |t: &str| t.to_lowercase().contains(&v);
    let body = e.request_body.as_deref().unwrap_or_default();
    let last = e.url.path_segments().and_then(|mut p| p.rfind(|s| !s.is_empty()).map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().to_lowercase()));
    last.as_deref() == Some(v.as_str())
        || e.url.query_pairs().any(|(_, q)| has(&q))
        || has(body)
        || url::form_urlencoded::parse(body.as_bytes()).any(|(_, b)| has(&b))
        // A binary body's fields, where a codec opens it.
        || unbrowse_learn::slots::wire_texts(e).iter().any(|t| has(t))
        // An asked date, time or number the call sends in the site's own written form asks by it all the same.
        || unbrowse_learn::lab::forms::sent_in_a_format(e, value)
}

/// Whether a call's answer says `value` back.
fn says_back(e: &Exchange, value: &str) -> bool {
    let v = value.trim().to_lowercase();
    !v.is_empty() && e.response_body.as_deref().is_some_and(|b| b.to_lowercase().contains(&v))
}

/// Whether a call's answer says none of the words (three letters or more) of the values asked. Values with no such
/// word (a date, a number) say nothing either way, and when none has one, nothing is said.
fn never_says_a_word(e: &Exchange, asked: &[String]) -> bool {
    let words: Vec<String> = asked
        .iter()
        .flat_map(|v| v.split(|c: char| !c.is_alphanumeric()).map(str::to_lowercase).collect::<Vec<_>>())
        .filter(|w| w.chars().count() >= 3 && w.chars().all(char::is_alphabetic))
        .collect();
    let body = e.response_body.as_deref().unwrap_or_default().to_lowercase();
    if words.is_empty() || body.is_empty() {
        return false;
    }
    if words.iter().any(|w| body.contains(w.as_str())) {
        return false;
    }
    // A site that matches a word by its stem lists "Surf" for "surfing": the word with its ending off, at the start
    // of a word the answer says, is the word said. The stem is most of the word and never under four letters, so
    // "phone" in an answer says nothing of "iphone", which it ends and does not begin.
    let stems: Vec<String> = words
        .iter()
        .filter_map(|w| {
            let letters = w.chars().count();
            let stem = 4.max((letters * 11).div_ceil(20));
            (letters > stem).then(|| w.chars().take(stem).collect())
        })
        .collect();
    stems.is_empty() || !body.split(|c: char| !c.is_alphanumeric()).any(|said| stems.iter().any(|stem| said.starts_with(stem.as_str())))
}

/// The words of a call's path: each piece split at its punctuation and its case changes (`/api/v1/getMarket_v2` is
/// api, v1, get, market, v2).
fn path_words(path: &str) -> Vec<String> {
    path.split(|c: char| !c.is_alphanumeric() && c != '_').flat_map(goal::key_words).collect()
}

/// What an answer must name to be kept for a goal: for a goal for one thing, the thing the page names (the last piece
/// of its address, split at its dashes: `bitcoin-btc` is bitcoin and btc); and the names a goal spells in capitals
/// (`BTC ETH SOL`).
fn named_things(page: &str, goal: &str) -> (Vec<String>, Vec<String>) {
    let mut subject = Vec::new();
    // An item is named under a collection (`/prices/bitcoin`, `/crates/serde`); a page at the top (`/inbox`) is a
    // section of the site, not a thing its answer must name.
    let pieces: Vec<String> = url::Url::parse(page).ok().and_then(|u| u.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(String::from).collect())).unwrap_or_default();
    if wants_one(goal) && pieces.len() >= 2 {
        if let Some(last) = pieces.last() {
            let last = percent_encoding::percent_decode_str(last).decode_utf8_lossy().to_lowercase();
            subject.extend(last.split(['-', '_', '.']).filter(|t| t.chars().count() >= 3 && t.chars().any(char::is_alphabetic)).map(String::from));
        }
    }
    let capitals: Vec<String> = goal
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| (2..=6).contains(&w.chars().count()) && w.chars().filter(|c| c.is_ascii_uppercase()).count() >= 2 && !w.chars().any(|c| c.is_lowercase()))
        .map(str::to_lowercase)
        .collect();
    (subject, capitals)
}

/// Whether `text` (lowercase) names `thing`: at the start of a word (`btc` in `BTCUSDT`, `ethereum` for `eth`), never
/// inside one (`eth` in `method`).
fn names_it(text: &str, thing: &str) -> bool {
    text.match_indices(thing).any(|(at, _)| at == 0 || !text[..at].chars().next_back().is_some_and(char::is_alphanumeric))
}

/// What the walked page `url` showed in `trace`: its own documents as the site served them (on its site, answered
/// 2xx), and `read`, what the agent read off it.
fn page_shown<'e>(pages: impl IntoIterator<Item = &'e Exchange>, url: &str, read: &[String]) -> unbrowse_learn::shown::Shown {
    let pages: Vec<&Exchange> = pages.into_iter().collect();
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    let site = walked_site(pages.iter().copied(), &host);
    let own = |e: &&Exchange| e.is_main_document() && (200..300).contains(&e.status) && unbrowse_learn::identity::on_site(e.url.host_str().unwrap_or_default(), &site);
    unbrowse_learn::shown::Shown::of(pages.into_iter().filter(own), read, url)
}

/// The site a walk of a page on `host` was let through to: the page's own site, unless the walk ended on a page of
/// another site that answered, and is a page rather than a door (`page::a_door`: a script that waits, linking nowhere)
/// and isn't a page sending the reader back (`answer::detour`): the site moved itself there (a country's own domain,
/// `airbnb.com` serving `airbnb.com.sg`), and the walk is judged on the site it is now. A waiting room on another
/// host is a door, so the asked site stays.
fn walked_site<'e>(exchanges: impl IntoIterator<Item = &'e Exchange>, host: &str) -> String {
    let asked = site_of(host);
    let landed = exchanges.into_iter().filter(|e| e.is_main_document() && e.has_final_http_response() && matches!(e.url.scheme(), "http" | "https")).last();
    let Some(e) = landed.filter(|e| (200..300).contains(&e.status)) else { return asked };
    let there = e.url.host_str().unwrap_or_default();
    let body = e.response_body.as_deref().unwrap_or_default();
    let sends_back = url::Url::parse(&format!("https://{host}/")).is_ok_and(|a| unbrowse_learn::answer::detour(&a, &e.url));
    if unbrowse_learn::identity::on_site(there, &asked) || body.trim().is_empty() || unbrowse_learn::page::a_door(e.status, body, &e.url) || sends_back {
        return asked;
    }
    site_of(there)
}

/// Whether a call sends `value` as a whole field of its own: a value of its query, or a text its JSON or form body
/// holds, and nothing more beside it there.
fn sends_as_a_field(e: &Exchange, value: &str) -> bool {
    let is = |v: &str| v.trim().eq_ignore_ascii_case(value.trim());
    if e.url.query_pairs().any(|(_, v)| is(&v)) {
        return true;
    }
    let Some(body) = e.request_body.as_deref() else { return false };
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(json) => unbrowse_learn::slots::json_leaves(&json).iter().any(|(_, v)| is(v)),
        Err(_) => url::form_urlencoded::parse(body.as_bytes()).any(|(_, v)| is(&v)),
    }
}

/// Why a call isn't the page's answer by what the page showed (`unbrowse_learn::shown`), or None when it may be. A
/// call whose answer says none of what the page showed is no answer to it, however much it answers or however many
/// of the goal's words its settings happen to hold: a session recorder's config, a sign-in widget's status. And a call
/// to a host the page's site doesn't own, which the site's policy doesn't declare its own (R2.27 (b)), is the site's
/// answer only when it says what the page showed, even where the page shows too little to judge others by. A call
/// that sends what the page was asked for (a search, the coin a price page is for) asks for what the page shows, and
/// is never held to how its answer writes it; neither is the page's own document.
fn shows_nothing(e: &Exchange, shown: &unbrowse_learn::shown::Shown, site: &str, asked: &[String], goal: &str) -> Option<String> {
    let host = e.url.host_str().unwrap_or_default();
    let own = unbrowse_learn::identity::on_site(host, site);
    if own && e.is_main_document() {
        return None;
    }
    // What the page was asked for, as the caller chose it: not a flag any call may send, nor two letters any address
    // holds by chance. A call that sends it is asking for what the page shows, however its answer writes it. A word
    // the goal itself spells is the caller's however short (a search for "5G"): it counts where the call sends it as
    // a field of its own, which chance does not do.
    let sends_asked = asked.iter().filter(|v| !unbrowse_learn::slots::is_flag(v)).any(|v| {
        if v.chars().count() >= 3 {
            unbrowse_learn::trace::carries_whole(e.url.as_str(), v) || e.request_body.as_deref().is_some_and(|b| unbrowse_learn::trace::carries_whole(b, v))
        } else {
            unbrowse_learn::trace::carries_whole(goal, v) && sends_as_a_field(e, v)
        }
    });
    // A call the page's own script spells (`Shown::asks_for`) is the page filling itself: what it showed as served is
    // its frame, not the answer. A page whose own document lists records of the value asked (`Shown::lists`) showed
    // its answer: a call to another site that sends that value asks that site about the page's subject (its
    // repository, its ads for it), did not make what the page showed, and answers only by saying it. A page that is a
    // shell lists none, its records come from elsewhere, and a call that sends its value may be what fills it.
    let foreign = !own && !crate::sitepolicy::declares(site, &e.url);
    let answered_by_the_page = foreign && shown.lists(asked);
    // Where the page showed its answer, a call about its subject says something only beyond naming what was asked.
    let says = if answered_by_the_page { shown.says_besides(e, asked) } else { shown.says(e) };
    if (sends_asked && !answered_by_the_page) || says || (own && shown.asks_for(e)) {
        return None;
    }
    if shown.judges() {
        return Some("its answer says none of what the page showed".into());
    }
    if foreign {
        return Some(format!("it goes to {host}, a host the page's site doesn't own or declare, and its answer says none of what the page showed"));
    }
    None
}

/// Why a call's answer doesn't answer `goal` on `page`, or None when it does. Every pick is held to this before it is
/// kept, whoever made it (the rule, the decision model, the page itself, a browsing): its answer holds every field
/// the goal asks for that has a look of its own (a price, a link, a day), and names what it is about, the thing the
/// page names for a goal for one thing, or every name a goal for a list spells in capitals. A call that fails is never
/// kept for the goal, or every later call for it would answer something else.
/// Whether `e` is the page `page` itself: the walk's main document at the page's own address (its host and path), as a
/// page that is its own data is walked. A route's call that is the page is read the same way at call time
/// (`api::goal::calls_the_page_itself`).
fn is_the_page_itself(e: &Exchange, page: &str) -> bool {
    let Ok(page) = url::Url::parse(page) else { return false };
    e.is_main_document() && e.url.host_str() == page.host_str() && e.url.path().trim_end_matches('/') == page.path().trim_end_matches('/')
}

/// A short main document that says it wants a person is a check. A long page can mention it among its records.
fn page_asks_for_person(e: &Exchange) -> bool {
    e.is_main_document() && e.response_body.as_deref().filter(|b| unbrowse_learn::page::is_markup(&e.response_mime, b)).is_some_and(|b| {
        let read = unbrowse_learn::page::read(b, &e.url);
        read["text"].as_str().is_some_and(|t| t.chars().count() < 4000 && crate::challenge::wants_a_person(t))
    })
}

fn fails_goal(e: &Exchange, goal: &str, page: &str, asked: &[String], landed: &str, trace: &Trace) -> Option<String> {
    if page_asks_for_person(e) {
        return Some("the page asks for a person: it is the site's check, not the page that was asked for".into());
    }
    // A page that links nowhere and says nothing of what was asked is a check or a wall: read back, it fails the call
    // (`page::a_check_not_the_page`), so it is never kept as the route that answers. A page as served that says none of
    // it anywhere, for all it links to, is a shell whose script draws the answer: it answers every value the same.
    // A call answered with a door's page (a check a site puts in a call's way after the page loaded: it runs code,
    // asks nothing and links nowhere) is the door, however much of the ask its own address carries along.
    if !e.is_main_document() && unbrowse_learn::page::a_door(e.status, e.response_body.as_deref().unwrap_or_default(), &e.url) {
        return Some("its answer is a page that only waits on its own code: a check in the call's way, not the call's answer".into());
    }
    if e.is_main_document() {
        let body = e.response_body.as_deref().unwrap_or_default();
        let values: Vec<&str> = asked.iter().map(String::as_str).collect();
        let (read, is_read) = unbrowse_learn::page::answer_asked(body, &e.url, &values);
        if let Some(why) = is_read.then(|| unbrowse_learn::page::a_check_not_the_page(&read, &values)).flatten() {
            return Some(why);
        }
        if is_read && !unbrowse_learn::page::says_any(&read, &values) {
            return Some(format!("the page as served never says \"{}\": its script draws what was asked", asked.join("\" or \"")));
        }
    }
    // A page asked for something is answered by a call that asks the site for it. One that doesn't (a config, a set of
    // flags, an ad slot) answers the same whatever the page was asked, so it answers none of it, whatever words it
    // happens to hold: a route made of it could never send another value. A call fed by one that did ask (a search's
    // id, read back) asks too, if it says it back. The page itself is held to what it shows, above.
    // A list's call asks by a value of its own: a word in the middle of its address (`search` in `/api/product/search/`,
    // a locale) is the site's route, even where the page's address holds the same word.
    let list = !wants_one(goal);
    let address = page_address(page);
    // A call that carries the page's own address along contains every value the page was asked with, without asking
    // for any of them: the address is where it fired, not its ask. It counts only where it sends the value itself.
    let carries_page = address.as_deref().is_some_and(|p| reports_the_page(&e.url, e.request_body.as_deref(), p));
    let sends = |v: &String| {
        if carries_page && !sends_as_its_own(e, v) {
            return false;
        }
        (if list { asks_by_value(e, v) } else { sends_value(e, v) })
        // The page turned the caller's word into the site's code by a table its own script ships: the call sends it.
        || unbrowse_learn::slice::sent_by_a_shipped_table(trace, e, v)
    };
    if !asked.is_empty() && !e.is_main_document() && !asked.iter().any(sends) {
        // A goal for one thing may be answered by a list that holds it (every coin, for one coin's page): such a call
        // never sends what the page names, and says it back all the same.
        let says = asked.iter().any(|v| says_back(e, v));
        if !says || (list && !fed_by_the_ask(trace, e, asked)) {
            return Some(format!("it never sends \"{}\"", asked.join("\" or \"")));
        }
    }
    // Records the call sent are what the page reported, whatever they say of what was asked: the site found none of them.
    if !e.is_main_document() && e.records_are_what_it_sent() {
        return Some("its records are the ones it sent: it reports them, and answers nothing".into());
    }
    let fields = goal::fields(goal);
    let h = holding_of(e, &fields, asked, goal);
    // Another site's call whose answer lists nothing and holds none of what the goal asks for was told about the page
    // (its address, its title, the word in it) and answers nothing: a route made of it hands every caller the same
    // few lines. A search service the page uses on another site lists what it found, and is not this. A goal for one
    // thing is left to the readers that judge one thing.
    let elsewhere = url::Url::parse(page).ok().and_then(|p| p.host_str().map(site_of)).zip(e.url.host_str().map(site_of)).is_some_and(|(here, there)| here != there);
    if list && !e.is_main_document() && elsewhere && h.covered.is_empty() && h.records <= 1 {
        return Some("it is another site's call, and its answer lists nothing and holds none of what was asked for: it was told about the page, and answers nothing".into());
    }
    if !h.has_shapes() {
        let shaped: Vec<&str> = fields.iter().filter(|f| f.shape != goal::Shape::Plain).map(|f| f.word.as_str()).collect();
        return Some(format!("its answer holds no {}", shaped.join(" or ")));
    }
    if !h.has_record_fields(goal, &fields) && (!e.is_main_document() || !shows_document_records(e)) {
        return Some("its links do not come with the requested record fields".into());
    }
    // A search's answer is its results: a list, a call that asks for what was searched by itself, or what says it
    // back. One record from a call carrying the word only inside another value (the page's title), saying none of it
    // back, is about the page the search ran on (its ad slot, its settings).
    // How many it lists is read off the answer itself: the reading that holds most of the goal's words may be the
    // answer taken as one record, with twenty videos listed beneath it.
    let listed = e.json_body().as_ref().map_or(0, longest_list);
    if !wants_one(goal) && !asked.is_empty() && h.records.max(listed) < 2 && !e.is_main_document() && asks_for_itself(e, asked) != Some(true) && !asked.iter().any(|v| says_back(e, v)) {
        return Some(format!("its answer is {} records and never says back \"{}\"", h.records, asked.join("\" or \"")));
    }
    // A list a search answers says something of what was searched, somewhere in it: its titles, the place it searched,
    // the words it matched. A list that says not one word of it (a strip of featured items, a banner's cards) answers
    // whatever was searched the same, and a route made of it would hand every search that strip.
    // A call that asks for it by itself is a search, whatever its answer echoes: the call-time check reads its answers.
    // A call that sends it as a value of its own (`variables: {term: "london"}`) asks the site for it too; the answer
    // names what it found by the site's own ids (a metro id, a restaurant id), and need not repeat the word.
    if !wants_one(goal)
        && !e.is_main_document()
        && asks_for_itself(e, asked) != Some(true)
        && !names_the_goal(e, goal)
        && never_says_a_word(e, asked)
    {
        return Some(format!("its answer never says a word of \"{}\"", asked.join("\" or \"")));
    }
    if short_for_a_list(&h, goal, asked) && !e.is_main_document() {
        return Some(format!("its answer is {} records, not a list", h.records));
    }
    let (mut subject, capitals) = named_things(page, goal);
    // A page the site sent elsewhere names its thing by the site's own word too (`/prices/ethereum` lands on
    // `/prices/ether`, whose calls say Ether).
    if !subject.is_empty() && !landed.is_empty() {
        subject.extend(named_things(landed, goal).0.into_iter().filter(|t| !subject.contains(t)).collect::<Vec<_>>());
    }
    if subject.is_empty() && capitals.is_empty() {
        return None;
    }
    let text = e.response_body.as_deref().unwrap_or_default().to_lowercase();
    // Several names in capitals are several things: an answer for them names every one.
    if capitals.len() >= 2 {
        let named = capitals.iter().filter(|t| names_it(&text, t)).count();
        return (named < capitals.len()).then(|| format!("its answer names {named} of {}", capitals.join(", ").to_uppercase()));
    }
    // A call that asks for the thing by name answers about it without saying it back, unless it answers with a list
    // of other things (a ranking that holds the coin on one page and not on the next).
    if !subject.is_empty() && !subject.iter().chain(&capitals).any(|t| names_it(&text, t)) && (asks_for_itself(e, &subject) != Some(true) || h.records >= 2) {
        return Some(format!("its answer never names {}", subject.join(" or ")));
    }
    // A list answers a page for one thing only when one of its records is that thing: a ranking of others that names
    // it elsewhere (a heading, a tag) is about something else. A page that is its own data (the document at the
    // page's own address answered with JSON) is no page for one thing answered by a list: its list is the page
    // (a package's downloads by day, named once at its head).
    if !subject.is_empty() && h.records >= 2 && !is_the_page_itself(e, page) && e.json_body().is_some_and(|v| lists_others(&v, &subject)) {
        return Some(format!("its records never name {}", subject.join(" or ")));
    }
    None
}

/// Whether a call sends a value an earlier call's answer gave, and that earlier call asked the site for what the page
/// was asked: a search that answers with an id, and the call that reads its results by that id.
fn fed_by_the_ask(trace: &Trace, e: &Exchange, asked: &[String]) -> bool {
    // An id in what the call asks, not a word (the words of a call's own address turn up in any page) nor a header (a
    // page hands its session's to every call).
    let id_like = |v: &str| v.len() >= 8 && v.chars().any(|c| c.is_ascii_digit()) && !v.contains(char::is_whitespace);
    let sent: Vec<String> = unbrowse_learn::slots::slots(e).into_iter().filter(|s| !matches!(s.loc, unbrowse_learn::Loc::Cookie(_) | unbrowse_learn::Loc::Header(_)) && id_like(&s.value)).map(|s| s.value).collect();
    let before = trace.exchanges.iter().take_while(|x| !std::ptr::eq(*x, e));
    before.filter(|x| !x.is_asset() && asked.iter().any(|v| sends_value(x, v))).any(|x| x.response_body.as_deref().is_some_and(|b| sent.iter().any(|v| b.contains(v.as_str()))))
}

/// Whether an answer's longest list of records has none that names any of `subject`.
fn lists_others(v: &serde_json::Value, subject: &[String]) -> bool {
    fn longest<'v>(v: &'v serde_json::Value, depth: usize, best: &mut Option<&'v Vec<serde_json::Value>>) {
        match v {
            serde_json::Value::Array(a) => {
                if a.iter().filter(|x| x.is_object()).count() >= 2 && best.is_none_or(|b| a.len() > b.len()) {
                    *best = Some(a);
                }
                if depth < 5 {
                    a.iter().take(50).for_each(|x| longest(x, depth + 1, best));
                }
            }
            serde_json::Value::Object(o) if depth < 5 => o.values().for_each(|x| longest(x, depth + 1, best)),
            _ => {}
        }
    }
    let mut best = None;
    longest(v, 0, &mut best);
    best.is_some_and(|records| !records.iter().any(|r| { let t = r.to_string().to_lowercase(); subject.iter().any(|s| names_it(&t, s)) }))
}

/// Why the walk never reached the page it was sent to, read from its main document: the site has no such page (404,
/// 410, and nothing after it), or sent the page to another that names it to come back to (a sign-in, a wall, a check).
/// Whatever that page loads is that page's, so no call of the walk answers the one asked for.
fn not_the_page(trace: &Trace, url: &str) -> Option<String> {
    page_gone(trace).or_else(|| page_detoured(trace, url)).or_else(|| page_turned_away(trace, url))
}

fn main_document_requests(trace: &Trace) -> impl DoubleEndedIterator<Item = &Exchange> {
    trace.exchanges.iter().filter(|e| e.is_main_document() && matches!(e.url.scheme(), "http" | "https"))
}

/// A main document can only replace the page once the browser has received a final HTTP response.
/// The capture uses status 0 when the request received no response. Redirects lead to another document.
fn main_pages(trace: &Trace) -> impl DoubleEndedIterator<Item = &Exchange> {
    main_document_requests(trace).filter(|e| e.has_final_http_response() && !(300..400).contains(&e.status))
}

/// What the site said when it answered that the page isn't there and never went on to serve one.
fn page_gone(trace: &Trace) -> Option<String> {
    let mut pages = main_pages(trace);
    let first = pages.next()?;
    if !matches!(first.status, 404 | 410) || pages.any(|e| (200..300).contains(&e.status)) {
        return None;
    }
    let said = unbrowse_learn::answer::site_said(first.response_body.as_deref().unwrap_or_default());
    Some(if said.is_empty() { format!("the site answered {} for this page", first.status) } else { format!("the site answered {} for this page: {said}", first.status) })
}

/// Where the site sent the page instead, naming it to come back to. A site may answer the page first and move it on
/// from a script, so the page it ended on is the one that counts.
fn page_detoured(trace: &Trace, url: &str) -> Option<String> {
    let asked = url::Url::parse(url).ok()?;
    let last = main_pages(trace).next_back()?;
    if unbrowse_learn::answer::detour(&asked, &last.url) {
        return Some(format!("the site sent the page to {} instead, naming it to come back to (a sign-in or a wall), so no route was kept", last.url.path()));
    }
    // Or to another page that asks for a password, naming nothing: the page is for someone signed in.
    unbrowse_learn::answer::sent_to_sign_in(&asked, last).then(|| format!("the site sent the page to {} instead, which asks for a password: the page is for someone signed in. Sign in first (drive that page, or call the route that signs in), then ask again", last.url.path()))
}

/// Where the site turned the value asked away: the walk ended on another page than the one asked, whose address
/// carries none of the values the asked address did (`asked_values`), and which says none of them back (`said_lines`,
/// on two lines, as a confirm holds an answer to saying a new value back). A page that moved keeps the value
/// (`/search?q=phone` to `/find?q=phone`); a front page or an error page a site sends a value it cannot place to keeps
/// none of it, whatever marker of its own it adds. Whatever that page loads answers another page, never the value.
fn page_turned_away(trace: &Trace, url: &str) -> Option<String> {
    let asked = url::Url::parse(url).ok()?;
    let values = asked_values(url, &[]);
    if values.is_empty() {
        return None;
    }
    let last = main_pages(trace).rfind(|e| (200..300).contains(&e.status))?;
    let page = |u: &url::Url| format!("{}{}", u.host_str().unwrap_or_default(), u.path().trim_end_matches('/'));
    if page(&last.url) == page(&asked) || values.iter().any(|v| unbrowse_learn::trace::carries_text(last.url.as_str(), v)) {
        return None;
    }
    let read = unbrowse_learn::page::read(last.response_body.as_deref().unwrap_or_default(), &last.url);
    let lines = said_lines(&read, &[]);
    if values.iter().any(|v| lines.iter().filter(|l| l.contains(&v.to_lowercase())).count() >= 2) {
        return None;
    }
    // Nor did the page it landed on ask for the value by a call of its own: a site that moves its search to another
    // page, whose script then searches, kept the value. A value turned away is gone from everything after the landing.
    let landed_at = trace.exchanges.iter().position(|e| std::ptr::eq(e, last)).unwrap_or(0);
    let sends = |e: &Exchange| values.iter().any(|v| unbrowse_learn::trace::carries_text(e.url.as_str(), v) || e.request_body.as_deref().is_some_and(|b| unbrowse_learn::trace::carries_text(b, v)));
    if trace.exchanges.iter().skip(landed_at + 1).any(sends) {
        return None;
    }
    Some(format!("the site sent the browser to another page ({}) instead of the page for {}, and that page carries none of it: the site has nothing for that value. No answer page came back at all, which is not an answer that lists nothing", last.url.path(), values.join(", ")))
}

/// Why a walk didn't reach the page asked for, as what comes next: a page the site says isn't there has nothing to
/// drive, a sign-in or a wall it was sent to is what hands are for, and a value the site turned away to another page
/// is one it has nothing for.
fn page_unreached(trace: &Trace, url: &str) -> Option<Unlearned> {
    page_gone(trace)
        .map(Unlearned::Gone)
        .or_else(|| page_detoured(trace, url).map(|why| stood_in_the_way(trace, url, Unlearned::Hands(why))))
        .or_else(|| page_turned_away(trace, url).map(|why| turned_to_a_check(trace).unwrap_or(Unlearned::Elsewhere(why))))
}

/// A walk the site sent to another page that asks for a person (`challenge::asks_a_person`, the reading
/// `browse::came_to_page` gives the same landing): a check stood in the way, and nothing was asked of the site. Never
/// a value the site has nothing for, which an agent reads as an answer and stops on.
fn turned_to_a_check(trace: &Trace) -> Option<Unlearned> {
    let last = main_pages(trace).rfind(|e| (200..300).contains(&e.status))?;
    unbrowse_learn::challenge::asks_a_person(last.response_body.as_deref().unwrap_or_default(), &last.url).then(|| {
        Unlearned::Check(
            format!("the site sent the browser to {} instead of the page asked for: a check that asks for a person, so nothing was read for this value. Meet it with unbrowse_challenge, then ask again", last.url.path()),
            "challenge.asks_a_person",
        )
    })
}

/// The page a walk landed on, when the site answered its address with another (a redirect): the first page it loaded.
fn landed(trace: &Trace) -> String {
    main_pages(trace)
        .find(|e| (200..300).contains(&e.status))
        .map(|e| e.url.to_string())
        .unwrap_or_default()
}

/// Whether an answer is too short to be the list a goal asks for, with nothing searched, of things with a look of their
/// own (`list crypto prices`): fewer than five. A handful of settings with a price-named key is the page's config.
fn short_for_a_list(h: &goal::Holding, goal: &str, asked: &[String]) -> bool {
    !wants_one(goal) && asked.is_empty() && h.shaped_asked > 0 && h.records < goal::FEWEST
}

/// What a call's answer holds of the goal, read the way its route will answer (`RouteClient`): its JSON, or for a page
/// the state it embeds when that holds what the page shows, else the page as the replay reads it (its text and its
/// links: `page::answer`). A page whose state is a scrap of config answers with what it renders, not with that scrap.
fn holding_of(e: &Exchange, fields: &[goal::Field], asked: &[String], goal: &str) -> goal::Holding {
    let body = e.response_body.as_deref().unwrap_or_default();
    let content_type = e.response_header("content-type").unwrap_or(&e.response_mime);
    if unbrowse_learn::page::is_markup(content_type, body) && serde_json::from_str::<serde_json::Value>(body).is_err() {
        let values: Vec<&str> = asked.iter().map(String::as_str).collect();
        return match unbrowse_learn::page::answer_asked(body, &e.url, &values) {
            (page, true) => goal::page_holding(&page, fields, asked),
            (state, false) => {
                let held = goal::holding_for_goal(&state, fields, asked, goal);
                if (!held.has_shapes() || !held.has_record_fields(goal, fields)) && fields.iter().any(|f| f.shape == goal::Shape::Link) {
                    let links = unbrowse_learn::page::links_beside_state(body, &e.url, &state);
                    if let Some(linked) = goal::holding_with_rendered_links(&state, &links, fields, asked, goal) {
                        return linked.holding;
                    }
                }
                held
            }
        };
    }
    if let Some(v) = e.json_body() {
        return goal::holding_for_goal(&v, fields, asked, goal);
    }
    goal::holding(&serde_json::Value::Null, fields, asked)
}

fn shows_document_records(e: &Exchange) -> bool {
    let Some(body) = e.response_body.as_deref().filter(|b| unbrowse_learn::page::is_markup(&e.response_mime, b)) else { return false };
    let page = unbrowse_learn::page::read(body, &e.url);
    goal::has_rendered_links(&page)
}

/// The rule's pick (`rule_scores` best first): of the calls whose answer holds the goal, the one whose records say
/// back what the url asked for, then the one holding most of the goal, then the best score. An answer holds the goal
/// when it carries every field the goal asks for that has a look of its own (a price, a link, a date), and either
/// some of the goal's fields or the goal's words in its own name. The rule always has a best call; one that holds
/// nothing of the goal is never kept for it, or it would be called for that goal from then on.
/// How many of a page's own links, or of the records it embeds, must say what it was asked before the page is said to
/// list its results itself.
const LISTS_IT: usize = 5;

fn rule_pick(trace: &Trace, view: &WalkView, goal: &str, query_values: &[String], scores: Vec<(f64, usize, bool, Vec<String>)>) -> Result<(usize, Vec<String>), String> {
    let fields = goal::fields(goal);
    let shown = page_shown(&trace.exchanges, &view.url, &[]);
    let mut held: Vec<(goal::Holding, f64, usize, Vec<String>)> = Vec::new();
    for (score, i, noise, reasons) in scores {
        // An ask that gave up is answered by no pick: the learn returns rather than weigh the rest of the walk's calls.
        if unbrowse_learn::mint::asked_to_stop() {
            return Err(agent_browser_core::session::STOPPED.to_string());
        }
        let (Some(c), false) = (view.candidates.iter().find(|c| c.index == i), noise) else { continue };
        let e = &trace.exchanges[i];
        let h = holding_of(e, &fields, query_values, goal);
        let shapes = h.has_shapes();
        let covered = !h.covered.is_empty();
        let answers = shapes && (covered || answers_goal(e, c, goal, query_values));
        let fails = fails_goal(e, goal, &view.url, query_values, &landed(trace), trace);
        let nothing = shapes.then(|| shows_nothing(e, &shown, &view.site, query_values, goal)).flatten();
        // Why a call the score likes never reaches the ranking: the gate's four answers, for the owner's debugging.
        if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() && !(answers && fails.is_none() && nothing.is_none()) {
            eprintln!(
                "   [held] {} {} {} score {score:.1}: shapes={shapes} covered={covered} answers={answers} fails={} nothing={}",
                c.method,
                c.host,
                c.path.chars().take(60).collect::<String>(),
                fails.as_deref().unwrap_or("-"),
                nothing.as_deref().unwrap_or("-")
            );
        }
        if answers
            && fails.is_none()
            && nothing.is_none()
        {
            held.push((h, score, i, reasons));
        }
    }
    // A search's suggestions echo the term back in strings while the call that answers — or the page that renders it —
    // holds records. When the walk holds either, the words are a hint, never the answer: an autocomplete endpoint was
    // beating the results page for a goal that asks for articles. The page counts only because it is already in
    // `held`, which means its own answer held the goal's shapes. A goal for one thing is not a list question.
    if !wants_one(goal) {
        let shape = |i: usize| view.candidates.iter().find(|c| c.index == i).map(|c| c.shape.as_str()).unwrap_or("");
        let holds_a_list = |i: usize| matches!(shape(i), "records" | "page");
        if held.iter().any(|(_, _, i, _)| holds_a_list(*i)) {
            held.retain(|(_, _, i, _)| shape(*i) != "words");
        }
    }
    // A search box's suggestion call is a hint, never the answer, when a call beside it answers with results: its path
    // or its own keys say what it is (`autocomplete`, `suggest`, `typeahead`), and its records are the words it offers
    // back, not what the reader came for (itch.io's `/autocomplete` beat `/search`; roblox's `get-suggestion`, its list).
    // A results call may carry suggestions beside its results (a corrected spelling, related searches): a member named
    // for them marks the call only when it holds most of what the answer holds, never when the results sit beside it
    // (a site's own search API, answering `results` and `suggestions`, was dropped for the page that frames it).
    let suggests = |i: usize| {
        let found = view.candidates.iter().find(|c| c.index == i);
        let path = found.map(|c| c.path.to_lowercase()).unwrap_or_default();
        let named = |k: &str| ["autocomplete", "suggest", "typeahead"].iter().any(|w| k.to_lowercase().contains(w));
        if named(&path) {
            return true;
        }
        let Some(answer) = trace.exchanges[i].json_body() else { return false };
        let Some(members) = answer.as_object() else { return false };
        let size = |v: &serde_json::Value| if v.is_array() || v.is_object() { v.to_string().len() } else { 0 };
        let offered: usize = members.iter().filter(|(k, _)| named(k)).map(|(_, v)| size(v).max(1)).sum();
        let beside: usize = members.iter().filter(|(k, _)| !named(k)).map(|(_, v)| size(v)).sum();
        offered > 0 && offered >= beside
    };
    if held.iter().any(|(_, _, i, _)| !suggests(*i)) {
        held.retain(|(_, _, i, _)| !suggests(*i));
    }
    // Another site's call is never this page's answer while the site's own page or a call of its own is held. An ad
    // exchange or a recommendation strip carries a copy of the value and answers with something else entirely
    // (asos.com's pick was `d.eu.criteo.com/delivery/retailmedia`). A site's own API on a subdomain is on the site.
    // A vendor's search service may be another site's host, so an off-site call is only dropped when its *answer*
    // never names the value: a JSONP results feed does, an ad exchange's banner set does not.
    let on_site = |i: usize| view.candidates.iter().find(|c| c.index == i).is_some_and(|c| unbrowse_learn::identity::on_site(&c.host, &view.site));
    let names_value = |i: usize| query_values.iter().any(|v| carries_text(answer_of(&trace.exchanges[i]).as_ref(), v));
    if held.iter().any(|(_, _, i, _)| on_site(*i)) {
        held.retain(|(_, _, i, _)| on_site(*i) || names_value(*i));
    }
    let bytes_of = |i: usize| view.candidates.iter().find(|c| c.index == i).map(|c| c.bytes).unwrap_or(0);
    let shape_of = |i: usize| view.candidates.iter().find(|c| c.index == i).map(|c| c.shape.as_str()).unwrap_or("");
    // A page whose own markup says the value is the answer's home; a few-hundred-byte answer beside it says nothing of
    // the value and is no answer at all (booking.com kept a 333-byte recommendation call over the page that lists the
    // hotels). Only a page of real size counts: a tiny page is one line the call beside it may be filling.
    // A page's own size is its markup, not its embedded state: `answer_of` reports a page by the state it carries, and
    // a page that renders its results server-side carries none.
    let big_page = trace.exchanges.iter().any(|e| {
        e.is_main_document()
            && e.response_body.as_deref().unwrap_or_default().len() >= 4096
            && query_values.iter().any(|v| carries_text(e.response_body.as_deref().unwrap_or_default(), v))
    });
    // And a call that answers in a few hundred bytes with no list is a lookup — an echo of the ask, a recommendation
    // strip, an ad slot — where the walk holds a call whose answer carries records (booking.com's pick was a 333-byte
    // recommendation call beside the site's own search).
    if big_page || held.iter().any(|(_, _, i, _)| shape_of(*i) == "records" && bytes_of(*i) >= 4096) {
        held.retain(|(_, _, i, _)| !(bytes_of(*i) < 1024 && shape_of(*i) != "page"));
    }
    // A call that sends what the page was asked as a value of its own (`query: "cats"`) asks the site for it; one that
    // carries it only inside the page's own address (`uri: "/search/cats/videos"`) asks about the page. Where the walk
    // holds the first, the second answers nothing asked.
    if let Some(path) = url::Url::parse(&view.url).ok().map(|u| percent_encoding::percent_decode_str(u.path()).decode_utf8_lossy().to_lowercase()).filter(|p| p.matches('/').count() >= 2) {
        let own = |i: usize| query_values.iter().any(|v| sends_as_its_own(&trace.exchanges[i], v));
        if held.iter().any(|h| own(h.2)) {
            held.retain(|h| own(h.2) || !carries_the_path(&trace.exchanges[h.2], &path));
        }
    }
    // A goal for one thing on a page that names it (`/price/btc`, `/crates/serde`) is answered by the call that asks
    // for that thing by itself; a list that only mentions it, or a part of it, answers something else.
    // The thing the page names: what it was asked for, and the last piece of its own address (`/price/bitcoin`).
    let mut subject: Vec<String> = query_values.to_vec();
    if let Some(last) = url::Url::parse(&view.url).ok().and_then(|u| u.path_segments().and_then(|mut s| s.rfind(|p| !p.is_empty()).map(String::from))) {
        subject.push(last);
    }
    let one = wants_one(goal) && !subject.is_empty();
    // What the call itself calls its ask: a call whose own address names what the goal names (`opname=RestaurantsAvailability`,
    // `/availability`) is the goal's answer, ahead of a call that only echoes the words it was asked back.
    // A page's address naming the goal's word is the ask, not the page naming what it answers: `/flights/showfarefirst`
    // for a goal about flights names the page's own route, and ranking it ahead of the call whose own path says
    // `FlightListSearch` (and whose answer lists the flights) made the page the answer to every search.
    let named: std::collections::HashMap<usize, bool> = held
        .iter()
        .map(|(_, _, i, _)| (*i, !trace.exchanges[*i].is_main_document() && names_the_goal(&trace.exchanges[*i], goal)))
        .collect();
    let names_goal = |i: usize| named.get(&i).copied().unwrap_or(false);
    // Of the calls that ask for it by itself, the site's data call over the page that renders it.
    // A call for a part of it (`/repos/react/react/pulls`) comes after one that doesn't name it at all.
    let markup = |e: &Exchange| unbrowse_learn::page::is_markup(e.response_header("content-type").unwrap_or(&e.response_mime), e.response_body.as_deref().unwrap_or_default());
    // A page's address asks for more than the search (a locale, a tab), and a site's header can mention any word. A data
    // call that asks for one of them as a value of its own and says it back is the page's own question and answer. A
    // locale at the head of an address, or the page's address carried along, asks nothing by itself.
    let answers = |i: usize| {
        let e = &trace.exchanges[i];
        let last = e.url.path_segments().and_then(|mut p| p.rfind(|s| !s.is_empty()).map(|s| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()));
        let asks = |v: &String| {
            last.as_ref().is_some_and(|l| l.eq_ignore_ascii_case(v))
                || sends_as_its_own(e, v)
                || unbrowse_learn::slots::slots(e).iter().any(|s| !matches!(s.loc, unbrowse_learn::Loc::Path(_) | unbrowse_learn::Loc::Cookie(_) | unbrowse_learn::Loc::Header(_)) && s.value.eq_ignore_ascii_case(v))
        };
        !e.is_main_document() && !markup(e) && query_values.iter().any(|v| v.chars().count() >= 3 && asks(v) && says_back(e, v))
    };
    // Then the call that carries most of what the page was asked. The page carries all of it by being the page.
    let carried = |i: usize| {
        let e = &trace.exchanges[i];
        if e.is_main_document() || markup(e) { 0 } else { query_values.iter().filter(|v| sends_value(e, v)).count() }
    };
    // Whether the page itself lists what it was asked: a page that renders its own results links to each of them, and
    // several of those links say the word. A page that only mentions the word in its text (a heading, a paragraph)
    // lists nothing, and the call that fills it is still the answer.
    let page_says_it_back = held.iter().any(|(h, _, i, _)| {
        let e = &trace.exchanges[*i];
        // Its results may sit in the state the page embeds, as records that say the word back, or in its markup, as
        // links that do.
        e.is_main_document() && (h.echoes && h.records >= LISTS_IT) || e.is_main_document() && {
            let read = unbrowse_learn::page::read(e.response_body.as_deref().unwrap_or_default(), &e.url);
            let said = |text: &str| query_values.iter().any(|v| v.chars().count() >= 3 && text.to_lowercase().contains(&v.to_lowercase()));
            read["links"].as_array().is_some_and(|links| links.iter().filter(|l| l["text"].as_str().is_some_and(said)).count() >= LISTS_IT)
        }
    });
    let linked_document_answers = fields.iter().any(|field| field.shape == goal::Shape::Link)
        && held.iter().any(|(h, _, i, _)| h.echoes && h.records >= LISTS_IT && is_the_page_itself(&trace.exchanges[*i], &view.url));
    // The one thing the page is about is the last piece of its address (`/title/tt0111161/`): the record that names it
    // is the thing's own, and a field it holds is the thing's (`thing_holding`).
    let thing = goal::thing_of(&view.url);
    let thing_held = |i: usize| -> Option<goal::Holding> {
        let thing = thing.as_deref()?;
        let e = &trace.exchanges[i];
        let body = e.response_body.as_deref().unwrap_or_default();
        let answer = if markup(e) && e.own_json().is_none() {
            let values: Vec<&str> = query_values.iter().map(String::as_str).collect();
            match unbrowse_learn::page::answer_asked(body, &e.url, &values) {
                (page, true) => page.get("state").cloned().unwrap_or_default(),
                (state, false) => state,
            }
        } else {
            e.own_json().unwrap_or_default()
        };
        Some(goal::thing_holding(&answer, &fields, thing)).filter(|h| !h.covered.is_empty())
    };
    let thing_has = |i: usize| thing_held(i).map_or(0, |h| h.covered.len());
    let rank = |h: &goal::Holding, i: usize| -> (bool, bool, usize, bool, bool, bool, bool, bool, usize, usize, usize) {
        let e = &trace.exchanges[i];
        let names = asks_for_itself(e, &subject);
        let itself = one && (names == Some(true) || says_its_name(e, &subject));
        // A page or a call that answers with data, over a fragment of markup: the page's "more results" is a piece of
        // the page that renders it, and earns nothing over it (it once outranked its page on the score alone, once the
        // page's own query values stopped counting for it).
        let page_or_data = e.is_main_document() || !markup(e);
        if one {
            // Then, of the rest, a data call over the page: it holds the thing's figures, the page its words about it.
            // Of those, the one whose record of the thing holds the goal's fields itself, over one that holds them only
            // in a list of other records it carries (a title's featured reviews, each with a rating of its own).
            (true, itself, if itself { thing_has(i) } else { 0 }, itself && !e.is_main_document(), names != Some(false), page_or_data, h.echoes, h.shaped > 0, h.shaped, h.covered.len(), 0)
        } else {
            // The site's data call before the page that renders it: HTML is the fallback, and a call that answers the
            // same question with records is the route. A call whose own address names the goal (`opname=…Availability`)
            // comes before one that only echoes the words it was asked: a search box's suggestions echo the term and
            // hold many more records than the answer, and counting them picked the wrong call.
            // Of the calls whose answer holds the goal: the one whose records say back what the page was asked
            // (`h.echoes`), then the one holding most of it, and only then how many of its values the call repeats.
            // Trip.com's flight list says back the route and the day; the neighbouring-days calendar repeats the query
            // but answers other days, and holding none of the goal's fields.
            // Before all of that: where the page lists what was asked itself and a call's records mostly do not say
            // it, the call lists something else than what the page shows for the word (a strip of the site's own
            // picks, beside the results). It took the word and answers with its records all the same, so it looked
            // like the search; it is a list at the side of it, and the page is the answer.
            // The document already shows a full list of linked records. A smaller neighbouring list cannot supply
            // the requested list just because its cards mention the same search.
            let beside = !e.is_main_document() && !markup(e)
                && ((page_says_it_back && !h.echoes) || (linked_document_answers && h.records < LISTS_IT));
            (!beside, answers(i) || (names_goal(i) && !e.is_main_document() && !markup(e)), 0, !e.is_main_document() && !markup(e), names_goal(i), page_or_data, h.echoes, h.shaped > 0, h.shaped, h.covered.len(), carried(i))
        }
    };
    held.sort_by(|a, b| rank(&b.0, b.2).cmp(&rank(&a.0, a.2)).then(b.1.total_cmp(&a.1)));
    // The order the held calls came out in, and what each was ranked by: for the owner's debugging, beside `[held]`.
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() {
        for (h, score, i, _) in held.iter().take(6) {
            let e = &trace.exchanges[*i];
            eprintln!("   [rank] {} {}{} score {score:.1}: {:?}", e.method, e.url.host_str().unwrap_or_default(), e.url.path().chars().take(60).collect::<String>(), rank(h, *i));
        }
    }
    let (h, _, i, mut reasons) = held.into_iter().next().ok_or(NEEDS_HANDS)?;
    reasons.insert(0, h.said());
    if let Some(own) = thing_held(i).filter(|_| one) {
        reasons.insert(0, format!("its record of {} holds {} itself", thing.as_deref().unwrap_or_default(), own.covered.join(", ")));
    }
    Ok((i, reasons))
}

/// Whether a goal asks for one thing rather than a list: `goal::wants_one`, the one reader.
pub(crate) fn wants_one(goal: &str) -> bool {
    goal::wants_one(goal)
}

/// Whether a call asks for the thing a page names by itself: a value the page was asked for is the last piece of the
/// call's path, or one of its query's values (`Some(true)`); or a piece of its path with more after it, asking for a
/// part of that thing (`Some(false)`, `/crates/serde/downloads`). None when the call doesn't name it.
fn asks_for_itself(e: &Exchange, values: &[String]) -> Option<bool> {
    let segs: Vec<String> = e.url.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(|p| p.to_lowercase()).collect()).unwrap_or_default();
    let query: Vec<String> = e.url.query_pairs().map(|(_, v)| v.to_lowercase()).collect();
    let mut found = None;
    for v in values.iter().map(|v| v.to_lowercase()).filter(|v| v.chars().count() >= 2) {
        if segs.last() == Some(&v) || query.contains(&v) {
            return Some(true);
        }
        if segs.contains(&v) {
            found = Some(false);
        }
    }
    found
}

/// What a call's answer was, where it is no answer but the way to the site's check: its JSON says a failure code,
/// holds no record, and holds the address of another page of the site; or its JSON holds the address of a
/// page of the site, the walk then went to that address, and what it met there is the check (a page that only waits
/// on its own code, or one that asks for a person: `fails_goal` reads both). The site answered the call by sending
/// it to be checked, in whatever words and under whatever key it names the address. None for any other answer.
fn sent_to_a_check(e: &Exchange, trace: &Trace, page: &str, site: &str) -> Option<String> {
    fn addresses(v: &serde_json::Value, out: &mut Vec<url::Url>) {
        match v {
            serde_json::Value::String(s) if s.starts_with("http") => out.extend(url::Url::parse(s).ok()),
            serde_json::Value::Array(a) => a.iter().for_each(|x| addresses(x, out)),
            serde_json::Value::Object(o) => o.values().for_each(|x| addresses(x, out)),
            _ => {}
        }
    }
    let mut handed = Vec::new();
    let answer = e.own_json()?;
    addresses(&answer, &mut handed);
    // A failure code, no record, and the address of another page of the site: the site said the call failed and where
    // to go instead, whether or not the walk then went there.
    if let Some(code) = unbrowse_learn::answer::failed_by_code(&answer) {
        if handed.iter().any(|to| to.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, site))) {
            return Some(format!("it answered {code} and the address of another page of the site, not what was asked for"));
        }
    }
    let at = trace.exchanges.iter().position(|x| std::ptr::eq(x, e))?;
    let a_check = |d: &Exchange| fails_goal(d, "", page, &[], "", trace).is_some_and(|why| why.starts_with("the page asks for a person") || why.contains("a check in the call's way"));
    handed
        .iter()
        .filter(|to| to.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, site)))
        .any(|to| trace.exchanges[at + 1..].iter().any(|d| d.url.host_str() == to.host_str() && d.url.path() == to.path() && a_check(d)))
        .then(|| "it answered with the address of the site's check for a person, and the walk was sent there".to_string())
}

/// What the site said when it refused the page's own ask: a call on the page's site that sent a word of the page's
/// address as a value of its own (`variables: {query: "surfing"}` for `/search/surfing/videos`) and was answered
/// with a failure in the site's own words, or told it asked too often, or handed the address of a page of the site
/// where the walk then met the site's check (`sent_to_a_check`), while no call that sent that word was
/// answered. The page drew nothing for the word, so whatever else it fetched (a strip of featured items, its own
/// title) is not the answer, and a route made of it would be a wrong answer kept. None when nothing was refused.
fn the_pages_ask_was_refused(trace: &Trace, url: &str, site: &str) -> Option<String> {
    let page = url::Url::parse(url).ok()?;
    let mut words: Vec<String> = page
        .path_segments()
        .into_iter()
        .flatten()
        .map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned())
        .chain(page.query_pairs().map(|(_, v)| v.into_owned()))
        .filter(|w| w.chars().count() >= 3 && w.chars().any(char::is_alphabetic))
        .collect();
    words.dedup();
    // The page's own ask may be made of another host the page itself brings in: a search widget whose loader the
    // page's markup names. A host the walked page spells out, or its site declares, is the page's as its own is; an
    // advert service the page never names is not. The page's markup or the site's own code may do the naming.
    let own_host = |e: &Exchange| e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, site));
    let named: Vec<&str> = trace
        .exchanges
        .iter()
        .filter(|e| own_host(e) && ((e.is_main_document() && e.url.path() == page.path()) || e.is_static_code()))
        .filter_map(|e| e.response_body.as_deref())
        .collect();
    let ours = |e: &Exchange| {
        !e.is_main_document()
            && e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, site) || crate::sitepolicy::declares(site, &e.url) || named.iter().any(|html| html.contains(h)))
    };
    let said = |e: &Exchange| -> Option<String> {
        if e.status == 429 {
            return Some("it was asked too often (429)".into());
        }
        // The answer's JSON in whatever the site wrapped it in: a widget's call is answered inside a callback.
        e.own_json().as_ref().and_then(unbrowse_learn::answer::said_failure).or_else(|| sent_to_a_check(e, trace, url, site))
    };
    for word in &words {
        let asked: Vec<&Exchange> = trace.exchanges.iter().filter(|e| ours(e) && sends_as_its_own(e, word)).collect();
        if asked.is_empty() || asked.iter().any(|e| (200..300).contains(&e.status) && said(e).is_none()) {
            continue;
        }
        if let Some(why) = asked.iter().find_map(|e| said(e)) {
            return Some(format!("the site refused the page's own call for \"{word}\": {why}"));
        }
    }
    None
}

/// Whether a call answers with one thing that names the page's subject as one of its own values (`"toDisplayName":
/// "Bitcoin"` for `/prices/bitcoin`): the thing itself, asked for by another name (`/details/BTCUSD`). A list that
/// mentions it among others, or a text that does, is not.
fn says_its_name(e: &Exchange, subject: &[String]) -> bool {
    fn named(v: &serde_json::Value, subject: &[String], depth: usize) -> bool {
        if depth > 4 {
            return false;
        }
        match v {
            serde_json::Value::String(s) => subject.iter().any(|w| s.trim().eq_ignore_ascii_case(w)),
            serde_json::Value::Object(m) => m.values().any(|x| named(x, subject, depth + 1)),
            serde_json::Value::Array(a) if a.iter().filter(|i| i.is_object()).count() < 3 => a.iter().any(|x| named(x, subject, depth + 1)),
            _ => false,
        }
    }
    let subject: Vec<String> = subject.iter().filter(|w| w.chars().count() >= 3).cloned().collect();
    !e.is_main_document() && e.json_body().is_some_and(|v| v.is_object() && named(&v, &subject, 0))
}

/// The opening document when it serves the answer in its content. A walk can read on into more pages, so use the
/// first successful main document on the site with substantial HTML. Redirect responses and doors do not answer.
fn document_answer(trace: &Trace, site: &str) -> Option<usize> {
    use unbrowse_learn::{identity::on_site, page};
    trace.exchanges.iter().enumerate().find_map(|(i, e)| {
        let opened = e.is_main_document() && e.method.eq_ignore_ascii_case("GET")
            && (200..300).contains(&e.status) && e.url.host_str().is_some_and(|host| on_site(host, site));
        if !opened || its_data_failed(trace, i) {
            return None;
        }
        let body = e.response_body.as_deref()?;
        if !page::is_html(body) || page::a_door(e.status, body, &e.url) {
            return None;
        }
        let page = page::read(body, &e.url);
        let links = page["links"].as_array().map(|a| a.len()).unwrap_or(0);
        let text = page["text"].as_str().map(str::len).unwrap_or(0);
        (links >= 5 || text >= 1000).then_some(i)
    })
}

/// Whether the page at `i` sent its own site a call for data while it loaded and the call failed. Such a page, as
/// served, shows what it shows when its data doesn't come: an empty table, and the error it keeps hidden until then.
/// The walk that exposed it: a demo bank's accounts overview, walked signed out, whose accounts call failed, kept as a
/// route that read "An internal error has occurred" on every call. Loading such a page answers nothing; a person
/// signed in, or the call itself, does.
fn its_data_failed(trace: &Trace, i: usize) -> bool {
    let Some(host) = trace.exchanges[i].url.host_str() else { return false };
    trace.exchanges[i + 1..].iter().take_while(|x| !x.is_main_document()).any(|x| {
        matches!(x.resource_type.as_deref(), Some("XHR" | "Fetch"))
            && x.status >= 400
            && x.url.host_str().is_some_and(|h| unbrowse_learn::identity::same_site(h, host))
    })
}

/// The distinctive words of what the agent read: names, numbers, handles; not the goal's words, and not the short
/// words any page has.
fn read_words(read: &[String], goal: &[String]) -> Vec<String> {
    let mut out: Vec<String> = read
        .iter()
        .flat_map(|t| t.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ':' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '|')))
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase())
        .filter(|w| w.chars().count() >= 6 && w.chars().any(|c| c.is_alphabetic()) && !goal.contains(w))
        .collect();
    out.sort();
    out.dedup();
    out.truncate(400);
    out
}

/// The decision model's pick (TypeSafe System One), when a key is configured and it is confident.
fn model_pick(trace: &Trace, view: &WalkView, goal: &str, query_values: &[String]) -> Option<usize> {
    use unbrowse_learn::judge::{Judge, Judgment};
    // Nothing to choose from is no question.
    if view.candidates.is_empty() {
        return None;
    }
    let judge = clef()?;
    let rows = model_rows(trace, view, goal, query_values);
    let a = judge.ask(Judgment::GoalRequest { goal, candidates: &rows })?;
    let picked = a.picked?;
    // Only a candidate the model was shown can be its pick: any other index names no call of this walk's.
    let offered = view.candidates.iter().any(|c| c.index == picked && c.index < trace.exchanges.len());
    (offered && a.trusted(judge.probability_bar, judge.confidence_bar)).then_some(picked)
}

/// The walk's candidates as the decision model sees them: each call's names (`judge::ExchangeRow`), and what the node
/// read of its answer, said as facts: its size, its records, the goal's field words they hold, and whether it says back
/// what the page was asked for. Names alone can't tell a GraphQL call that lists hotels from one that lists menu links.
fn model_rows(trace: &Trace, view: &WalkView, goal: &str, query_values: &[String]) -> Vec<unbrowse_learn::judge::ExchangeRow> {
    let fields = goal::fields(goal);
    view.candidates
        .iter()
        .map(|c| {
            let e = &trace.exchanges[c.index];
            let h = holding_of(e, &fields, query_values, goal);
            unbrowse_learn::judge::ExchangeRow {
                index: c.index,
                method: c.method.clone(),
                host: c.host.clone(),
                path: c.path.clone(),
                mime: e.response_mime.clone(),
                resource_type: e.resource_type.clone().unwrap_or_default(),
                status: c.status,
                carries: unbrowse_learn::judge::carried_names(e),
                shape: e.json_body().map(|v| unbrowse_learn::judge::shape_of(&v)).unwrap_or_default(),
                answers: c.keys.clone(),
                bytes: c.bytes,
                records: h.records,
                holds: h.covered,
                says_back: query_values.iter().any(|v| v.chars().count() >= 2 && says_back(e, v)),
            }
        })
        .collect()
}

/// What a plain request for the page an agent named says, before any browser opens.
#[derive(Debug)]
pub enum Plain {
    /// The page answers with data itself: its own route, kept.
    Route(Route),
    /// The site answered the page with data saying it can't: what it said. The browser could only show the same.
    Refused(String),
    /// A page for the browser to walk; with what the site said, when it refused the plain request (a browser may
    /// get past a check a plain request can't, so the walk still runs, and says this if it fails).
    Page(Option<String>),
}

/// A page that answers with data itself (JSON, XML, a feed, plain text, Markdown) is its own route, learned without
/// the browser: fetched once over the node's own transport, asked for the way a browser asks for a page, a 2xx answer
/// that is data rather than a page is kept as a one-step route whose inputs are the url's query and the pieces of
/// its path the caller chose. A page is the browser's to walk. A refusal is said in the site's words: one answered
/// with data the browser can't change (gone, too many requests, the site's own failure) ends here; any other is
/// left to the walk, which may pass what a plain request can't, and its words go with the walk's failure.
pub fn learn_plain(url: &str, goal: &str, who: &str) -> Plain {
    let Ok(parsed) = url::Url::parse(url.trim()) else { return Plain::Page(None) };
    let Some(host) = parsed.host_str().filter(|_| matches!(parsed.scheme(), "http" | "https")) else { return Plain::Page(None) };
    // The walk says why an excluded host is never walked.
    if store::load_settings().excluded.iter().any(|e| unbrowse_learn::identity::at_or_under(host, e)) {
        return Plain::Page(None);
    }
    let Ok(mut transport) = unbrowse_learn::http::ChromeFetch::new() else { return Plain::Page(None) };
    let req = unbrowse_learn::replay::Request { method: "GET".into(), url: parsed.clone(), exchange: 0, headers: Vec::new(), body: None };
    let Ok(got) = unbrowse_learn::replay::Fetch::fetch(&mut transport, &req) else { return Plain::Page(None) };
    let body = got.response_body.clone().unwrap_or_default();
    let content_type = got.response_header("content-type").unwrap_or_default().to_string();
    let page = unbrowse_learn::page::is_html(&body) || content_type.to_ascii_lowercase().contains("html");
    // Data holds something: an object or a list with something in it, or text of more than a bare line. A site that
    // answers a request it does not take for a browser with an acknowledgement (`200-OK`, under a JSON content type)
    // has said nothing, and kept as the route it answered every value with those six characters.
    let data = !page && plain_data(got.own_json().as_ref(), unbrowse_learn::answer::text_answer(&content_type, &body).is_some(), &body);
    let said = unbrowse_learn::answer::site_said(&body);
    if got.status >= 400 {
        let told = if said.is_empty() { format!("the site answered {}", got.status) } else { format!("the site answered {}: {said}", got.status) };
        // Only a session may change a 401 or a 403, and the browser holds the site's: it walks.
        return if data && !matches!(got.status, 401 | 403) { Plain::Refused(told) } else { Plain::Page(Some(format!("{told} (to a plain request for the page)"))) };
    }
    // An address that answers with a file (a document to download, a picture, an archive) is neither a page to walk
    // nor data to call: it is said as what it is, where a walk would end "the page needs clicks or typing".
    if (200..300).contains(&got.status) && a_file(&content_type, page, data) {
        return Plain::Refused(format!("the address answers with a file ({}), not a page or data: fetch it as a file", content_type.split(';').next().unwrap_or_default().trim()));
    }
    if !data || !(200..300).contains(&got.status) {
        return Plain::Page(None);
    }
    let ex = Exchange {
        method: "GET".into(),
        // The route asks for the page as it was named; redirects are followed on every call, as here.
        url: parsed,
        request_headers: Vec::new(),
        request_body: None,
        status: got.status,
        response_headers: got.response_headers.clone(),
        response_body: Some(body),
        response_mime: content_type,
        resource_type: Some("Document".into()),
        main_frame: Some(true),
    };
    if let Some(why) = unbrowse_learn::answer::not_an_answer(&ex, false) {
        return Plain::Refused(why);
    }
    let mut trace = Trace { exchanges: vec![ex], inputs: Vec::new() };
    let (in_path, _) = path_inputs(url, goal, &trace);
    let in_path = with_other_pages(url, in_path, &pages_learned_for(url, goal));
    trace.inputs = walk_inputs(url, &in_path, &trace.exchanges);
    // A plain request: no page ran, so the address asked is the only one there was.
    let asked = [url.to_string()];
    match route_of(&trace, 0, goal, url, false, &[], &[], Some(&asked)).and_then(|r| save_learned(r, who)) {
        // An address that answers a plain request with data is a route only when it hears what it is asked (`hears`):
        // one that answers the same for a word nobody searches for is a frame its page fills in, and the page is walked.
        Ok(route) => match hears(&route, &asked_values(url, &in_path)) {
            Hears::Deaf(names) => {
                eprintln!("   [hears] a plain request for {} answers the same whatever {} says: the page is walked", route.path.chars().take(60).collect::<String>(), names.join(", "));
                let _ = store::drop_learned(&route.id);
                Plain::Page(None)
            }
            Hears::Yes => {
                let mut route = route;
                route.heard = store::Heard { probed: true, deaf: Vec::new(), ..Default::default() };
                let _ = store::save_route(&route);
                Plain::Route(route)
            }
            Hears::Unasked(_) => Plain::Route(route),
        },
        Err(e) => Plain::Page(Some(e)),
    }
}

/// Whether the page at `url`, asked for plainly as `learn_plain` asks for it, lists results of `goal` that say back
/// what it was asked (`asked`, the caller's values): then the site has found something for them, whatever one of the
/// page's other calls answered. A page that can't be read plainly, or shows no such list, says nothing either way.
pub fn page_lists(url: &str, goal: &str, asked: &[String]) -> bool {
    let Ok(parsed) = url::Url::parse(url.trim()) else { return false };
    let Some(host) = parsed.host_str().filter(|_| matches!(parsed.scheme(), "http" | "https")) else { return false };
    if store::load_settings().excluded.iter().any(|e| unbrowse_learn::identity::at_or_under(host, e)) {
        return false;
    }
    let Ok(mut transport) = unbrowse_learn::http::ChromeFetch::new() else { return false };
    let req = unbrowse_learn::replay::Request { method: "GET".into(), url: parsed.clone(), exchange: 0, headers: Vec::new(), body: None };
    let Ok(got) = unbrowse_learn::replay::Fetch::fetch(&mut transport, &req) else { return false };
    if !(200..300).contains(&got.status) {
        return false;
    }
    let ex = Exchange {
        method: "GET".into(),
        url: parsed,
        request_headers: Vec::new(),
        request_body: None,
        status: got.status,
        response_headers: got.response_headers.clone(),
        response_mime: got.response_header("content-type").unwrap_or_default().to_string(),
        response_body: got.response_body.clone(),
        resource_type: Some("Document".into()),
        main_frame: Some(true),
    };
    lists_the_ask(&ex, goal, asked)
}

/// Whether a page's answer lists results of `goal` that say back `asked`: records holding every field of the goal
/// with a look of its own (`has_shapes`), most of them saying the value back (`echoes`), read as its route would
/// read it (`holding_of`). A page that found nothing shows no records, or others it suggests, which don't say it.
pub(crate) fn lists_the_ask(e: &Exchange, goal: &str, asked: &[String]) -> bool {
    if asked.is_empty() {
        return false;
    }
    let h = holding_of(e, &goal::fields(goal), asked, goal);
    h.has_shapes() && !h.covered.is_empty() && h.echoes && h.records >= 2
}

/// Why a walk of a page kept no route, which says what comes next. Handing the page over is right only where someone
/// on the page could get further than loading it did: an address that can't be walked, or a page the site says isn't
/// there, has nothing to click.
#[derive(Debug, Clone, PartialEq)]
pub enum Unlearned {
    /// Loading the page sends no call that answers the goal: it is driven from here. The one kind a warm browser may
    /// still answer.
    Loading,
    /// Something stood between the walk and an answer that no reader of the walk named: someone on the page may pass it.
    Hands(String),
    /// The site's door refused the walk and held to its end (`Trace::door`), or refused the page's own ask. Each of
    /// these three carries what it says and the reader that read it.
    Door(String, &'static str),
    /// The site sent the page to a sign-in: only someone with an account gets further.
    SignIn(String, &'static str),
    /// The walk's last page asks for a person: a check someone on the page may pass.
    Check(String, &'static str),
    /// The address is never walked, whoever asks: not a page, or the owner excluded it.
    Unwalkable(String),
    /// The site answered that the page isn't there, to a browser holding the site's session.
    Gone(String),
    /// The site turned the value asked away to another page (`page_turned_away`): it has nothing for that value, and
    /// what that page loads is no answer to it.
    Elsewhere(String),
    /// The walk's answer lists nothing for the value the page was asked (`the_walk_found_nothing`, by the one reader of
    /// an empty answer): the site answered and has nothing for it. No route is kept from a walk that saw no record.
    Nothing(String),
    /// The page's answer is read only by the page's own code, and this machine runs none (`sandbox::Unheld`: no runtime,
    /// or one that can't be held): what a held runtime would read, the browser still can.
    Runtime(String),
    /// The walk's capture holds nothing from the walked page's own site, not even its document (`unseen`): the capture
    /// failed, and says nothing of what loading the page sends. Never a page that needs hands.
    Unseen(String),
}

impl std::fmt::Display for Unlearned {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Unlearned::Loading => NEEDS_HANDS,
            Unlearned::Hands(why) | Unlearned::Unwalkable(why) | Unlearned::Gone(why) | Unlearned::Elsewhere(why) | Unlearned::Runtime(why) | Unlearned::Unseen(why) => why,
            Unlearned::Door(why, _) | Unlearned::SignIn(why, _) | Unlearned::Check(why, _) => why,
            Unlearned::Nothing(why) => why,
        })
    }
}

impl Unlearned {
    /// What the reply says it came to, and the reader that said so.
    pub fn outcome(&self) -> (crate::outcome::Outcome, &'static str) {
        use crate::outcome::Outcome;
        match self {
            Unlearned::Loading => (Outcome::NeedsHands, "learn.loading"),
            Unlearned::Hands(_) => (Outcome::NeedsHands, "unread"),
            Unlearned::Door(_, by) => (Outcome::Refused, by),
            Unlearned::SignIn(_, by) => (Outcome::NeedsPerson, by),
            Unlearned::Check(_, by) => (Outcome::Challenge, by),
            Unlearned::Unwalkable(_) => (Outcome::NotAllowed, "learn.unwalkable"),
            Unlearned::Gone(_) => (Outcome::Gone, "learn.gone"),
            // The site turned the value away: an answer, of nothing for that value.
            Unlearned::Elsewhere(_) => (Outcome::AnsweredEmpty, "learn.elsewhere"),
            // The walk's own answer lists nothing for the value: the site answered, with nothing for it.
            Unlearned::Nothing(_) => (Outcome::AnsweredEmpty, "learn.nothing"),
            // Only the page's own code reads the answer, and this machine runs none: the sandbox's reader says which
            // (no runtime, or one too old), asked again rather than read back from the words.
            Unlearned::Runtime(_) => (Outcome::NoRoute, unbrowse_learn::sandbox::unheld().as_ref().map(crate::outcome::unheld_from).unwrap_or("sandbox.unheld")),
            // The walk's capture held nothing from the page's own site, twice: nothing was learned, and the page was
            // never seen, so nothing says it needs hands.
            Unlearned::Unseen(_) => (Outcome::NoRoute, "learn.unseen"),
        }
    }

    /// The same kind, with more said after what it says. A page that needed hands, told more, still needs them.
    pub fn and(self, more: &str) -> Unlearned {
        let said = |why: String| format!("{why}; {more}");
        match self {
            Unlearned::Loading => Unlearned::Hands(said(NEEDS_HANDS.to_string())),
            Unlearned::Hands(why) => Unlearned::Hands(said(why)),
            Unlearned::Door(why, by) => Unlearned::Door(said(why), by),
            Unlearned::SignIn(why, by) => Unlearned::SignIn(said(why), by),
            Unlearned::Check(why, by) => Unlearned::Check(said(why), by),
            other => other,
        }
    }

    /// Whether it is a page someone on it may get further on: what hands, a person or a check are for.
    pub fn for_hands(&self) -> bool {
        !matches!(self, Unlearned::Unwalkable(_) | Unlearned::Gone(_) | Unlearned::Elsewhere(_) | Unlearned::Nothing(_) | Unlearned::Runtime(_))
    }
}

/// What stood in a walk's way, read from the walk once it ended: a page left with no reader's name for its cause
/// (`Hands`, `Loading`, or a door) is said as what the walk shows. The walk's last page asks for a person
/// (`challenge::asks_a_person`): a check. It was sent to a sign-in (`answer::sent_to_sign_in`, or the page a sign-in the
/// node knows starts on, `sign_in_asked`): a sign-in. The door held to the walk's end (`Trace::door`, its last main
/// document still inside it): a door. Else it stays what it was. What it says is kept as said.
pub(crate) fn stood_in_the_way(trace: &Trace, url: &str, why: Unlearned) -> Unlearned {
    if !matches!(why, Unlearned::Hands(_) | Unlearned::Loading | Unlearned::Door(..)) {
        return why;
    }
    let site = url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)).unwrap_or_default();
    let words = |why: &Unlearned| why.to_string();
    let last = trace.exchanges.iter().rev().find(|e| e.is_main_document() && e.main_frame != Some(false) && e.response_body.is_some());
    if last.is_some_and(|e| unbrowse_learn::challenge::asks_a_person(e.response_body.as_deref().unwrap_or_default(), &e.url)) {
        return Unlearned::Check(words(&why), "challenge.asks_a_person");
    }
    // The page's own ask was answered with a failure code and the address of the site's check page
    // (`answer::check_url`): the site turned the ask away to a check, so this is a check to pass, not a page that
    // needs clicks — even when no check document loaded in the walk (the check lives at the named address).
    let on_site = |e: &Exchange| e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, &site));
    if trace.exchanges.iter().any(|e| on_site(e) && e.own_json().as_ref().and_then(unbrowse_learn::answer::check_url).is_some()) {
        return Unlearned::Check(words(&why), "answer.check_url");
    }
    // A page that only runs its own code stood in the walk's door stretch (`page::a_door`), and the walk ended without
    // a page that answers what it was asked: a check that serves itself, whose pass a script earns. The check's own page
    // may be the last document, or the site's "access denied" after it — the answer a failed check gives — so the
    // ending is read too: a page that says what the walk was asked (a real page, empty results included) is a page.
    let door = trace.door(&site);
    let check_in_door = door.iter().any(|i| {
        let e = &trace.exchanges[*i];
        e.is_main_document()
            && !e.is_refused()
            && unbrowse_learn::page::a_door(e.status, e.response_body.as_deref().unwrap_or_default(), &e.url)
    });
    let ended = trace.exchanges.iter().rposition(|e| e.is_main_document() && (on_site(e) || e.main_frame == Some(true)));
    let says_the_ask = url::Url::parse(url).ok().is_some_and(|asked| {
        let asked: Vec<String> = unbrowse_learn::trace::asked_pairs(&asked).into_iter().map(|(_, v)| v.to_lowercase()).filter(|v| v.chars().count() > 2).collect();
        ended.map(|i| &trace.exchanges[i]).is_some_and(|e| {
            let said = e.response_body.as_deref().unwrap_or_default().to_lowercase();
            !asked.is_empty() && asked.iter().any(|v| said.contains(v))
        })
    });
    if check_in_door && !says_the_ask {
        return Unlearned::Check(words(&why), "trace.door");
    }
    if matches!(why, Unlearned::Door(..)) {
        return why;
    }
    let asked = url::Url::parse(url).ok();
    if last.zip(asked.as_ref()).is_some_and(|(e, asked)| unbrowse_learn::answer::sent_to_sign_in(asked, e)) {
        return Unlearned::SignIn(words(&why), "answer.sent_to_sign_in");
    }
    if sign_in_asked(trace, url, &site).is_some() {
        return Unlearned::SignIn(words(&why), "learn.sign_in_asked");
    }
    let own = |e: &Exchange| e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, &site));
    let ended = trace.exchanges.iter().rposition(|e| e.is_main_document() && (own(e) || e.main_frame == Some(true)));
    if ended.is_some_and(|i| trace.door(&site).contains(&i)) {
        return Unlearned::Door(words(&why), "trace.door");
    }
    why
}

/// Whether the walk met a clearable check: an on-site call the site answered with a failure code that names its check
/// page (`answer::check_url`). Like a sign-in, the owner's own browser may hold a live session for the site — its
/// clearance cookie included — so this is treated the same: the session is taken in and the page walked again, no
/// person asked. General: read from the answer's shape, no site name in the engine.
pub(crate) fn walk_met_a_clearable_check(trace: &Trace, site: &str) -> bool {
    trace.exchanges.iter().any(|e| {
        e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, site))
            && e.own_json().as_ref().and_then(unbrowse_learn::answer::check_url).is_some()
    })
}

/// A walk whose browser gave up, said as what stood in its way: the engine's own word that the site kept challenging
/// it, else what its capture shows (`stood_in_the_way`). Reading the engine's words is a stopgap until the engine
/// hands its state over typed: they are its own fixed text (`mint unresolved (challenge)`, the mint's "kept
/// challenging"), never a site's.
/// A walk its ask stopped says what its capture shows it stood at, so the stop hides nothing.
pub(crate) fn walk_failed(engine: &str, why: String, capture: Option<&Trace>, url: &str) -> Unlearned {
    if engine.contains("mint unresolved (challenge)") || engine.contains("the site kept challenging the browser") {
        return Unlearned::Check(why, "mint.state");
    }
    let read = match capture {
        Some(trace) => stood_in_the_way(trace, url, Unlearned::Hands(why)),
        None => Unlearned::Hands(why),
    };
    if engine != agent_browser_core::session::STOPPED {
        return read;
    }
    match read {
        Unlearned::Check(why, by) => Unlearned::Check(format!("{why}, on a page that asks for a person"), by),
        Unlearned::SignIn(why, by) => Unlearned::SignIn(format!("{why}, on the sign-in the site sent the page to"), by),
        Unlearned::Door(why, by) => Unlearned::Door(format!("{why}, at the site's door, which had refused the page"), by),
        other => other,
    }
}

impl From<String> for Unlearned {
    fn from(why: String) -> Self {
        Unlearned::Hands(why)
    }
}

impl From<&str> for Unlearned {
    fn from(why: &str) -> Self {
        Unlearned::Hands(why.to_string())
    }
}

/// What an agent asks for: walk `url`, find the call that answers `goal`, keep it as a route. No one picks by hand.
#[cfg(test)]
pub fn learn_goal(walks: &Walks, url: &str, goal: &str) -> Result<(Route, &'static str), Unlearned> {
    learn_goal_as(walks, url, goal, "You", &no_eye, None)
}

/// The same, for agent `who`, with the walk reported to `eye` as it happens.
/// `node` opens the vault, should the walk find the site asking for a sign-in the node knows.
#[cfg(test)]
pub fn learn_goal_as(walks: &Walks, url: &str, goal: &str, who: &str, eye: Sink, node: Option<&crate::Node>) -> Result<(Route, &'static str), Unlearned> {
    learn_goal_walked(walks, url, goal, who, eye, node).map(|(route, by, _)| (route, by))
}

/// `learn_goal_as`, saying also which walk the route was learned from: the walk the experiment is then run on
/// (`verify_learned`).
pub fn learn_goal_walked(walks: &Walks, url: &str, goal: &str, who: &str, eye: Sink, node: Option<&crate::Node>) -> Result<(Route, &'static str, String), Unlearned> {
    let id = walk_id(url);
    let r = learn_goal_from(walks, url, goal, who, eye, node, &id);
    // The site's page was loaded in the browser now, for the values its address holds: what a call made after it reads.
    sighted::page_loaded(url);
    r.map(|(route, by)| (route, by, id))
}

thread_local! {
    /// A learn again is under way on this thread: the calls it makes of the routes it learns never learn again.
    static LEARNING_AGAIN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// What learns a page again in a test: the page and the goal in, the route that stands out.
#[cfg(test)]
type Learner = std::rc::Rc<dyn Fn(&str, &str) -> Result<Route, String>>;

#[cfg(test)]
thread_local! {
    static LEARNER: std::cell::RefCell<Option<Learner>> = const { std::cell::RefCell::new(None) };
}

/// `f`, with the switch on for this thread's calls, and a learn again made by `learner` (the page it is handed, the
/// goal) where the node would walk: a test has no browser, and its site is made up.
#[cfg(test)]
pub(crate) fn learning_again_by<T>(learner: impl Fn(&str, &str) -> Result<Route, String> + 'static, f: impl FnOnce() -> T) -> T {
    LEARNER.with(|l| *l.borrow_mut() = Some(std::rc::Rc::new(learner)));
    let out = f();
    LEARNER.with(|l| *l.borrow_mut() = None);
    out
}

/// Whether a call of `route` (`writes` where it may change the site) that finds the site drifted learns the route
/// again from its plan, rather than healing it in place: behind the switch, for a route whose body carries its plan,
/// never a write (a write's route is its owner's to redo), and never a call a learn again makes.
pub(crate) fn learns_again(route: &Route, writes: bool) -> bool {
    #[cfg(test)]
    let on = LEARNER.with(|l| l.borrow().is_some());
    #[cfg(not(test))]
    let on = learns_by_example();
    on && !writes && !LEARNING_AGAIN.get() && route.body.as_ref().is_some_and(|b| b.plan.is_some())
}

/// `f`, with no call it makes learning a route again: the call of a route just learned again is answered by it as it
/// stands, so a learn again never leads to another.
pub(crate) fn not_learning_again<T>(f: impl FnOnce() -> T) -> T {
    let was = LEARNING_AGAIN.replace(true);
    let out = f();
    LEARNING_AGAIN.set(was);
    out
}

/// The names a page written from a plan still asks for: each `{name}` it holds.
fn still_asked(page: &str) -> Vec<String> {
    let page = page.replace("%7B", "{").replace("%7D", "}");
    page.split('{').skip(1).filter_map(|rest| rest.split_once('}').map(|(name, _)| name.to_string())).filter(|n| !n.is_empty() && !n.contains(char::is_whitespace)).collect()
}

/// `route`, learned again from its plan for a call whose values are `values` (`docs/REBUILD.md` phase 8): the plan's
/// page written with them, walked, and learned as any learn is, its second look and its check included. The route
/// that stands takes the old one's place (`store::retire_route_for`, as `verify_learned` does); the old route is never
/// edited. A learn that lands on the same call writes it under its id, as learning a call again does. Err: why it was
/// not learned again, and nothing changed.
pub(crate) fn learned_again(route: &Route, values: &HashMap<String, String>, who: &str, node: Option<&crate::Node>) -> Result<Route, String> {
    let plan = route.body.as_ref().and_then(|b| b.plan.as_ref()).ok_or("the route carries no plan")?;
    // A learn walks the page twice and asks the site several times more: on a site that says it has few asks left,
    // those are the caller's.
    if !spares(route, SECOND_LOOK_ASKS) {
        return Err("the site says it has few asks left, and learning the route again would spend them".into());
    }
    let mut given: HashMap<String, String> = HashMap::new();
    for asked in &plan.asked {
        let value = values.get(&asked.slot).ok_or_else(|| format!("its page asks {}, and the call gives no value for it", asked.slot))?;
        given.insert(asked.slot.clone(), value.clone());
    }
    let page = plan.address(&given).ok_or("the plan's page does not read as an address")?;
    if let Some(name) = still_asked(&page).into_iter().next() {
        return Err(format!("its page still asks {name}, which the call does not give"));
    }
    eprintln!("   [call] {} is learned again from its plan: {page}, for {:?}", route.id, plan.goal);
    #[cfg(test)]
    let learned = not_learning_again(|| match LEARNER.with(|l| l.borrow().clone()) {
        Some(learner) => learner(&page, &plan.goal),
        None => Err("no learner for this test".into()),
    });
    #[cfg(not(test))]
    let learned = not_learning_again(|| learn_the_page_again(&page, &plan.goal, who, node));
    let _ = (who, node);
    let standing = learned?;
    if standing.id != route.id {
        match store::retire_route_for(&route.id, &standing.id) {
            Ok(true) => {}
            Ok(false) => eprintln!("   [call] {} stands beside {}: it is the owner's own or listed, and is not retired", route.id, standing.id),
            Err(e) => eprintln!("   [call] {} could not be retired for {}: {e}", route.id, standing.id),
        }
    }
    Ok(standing)
}

/// The node's learn of `page` for `goal`, as an ask's learn is (`api::goal::learn_page`), with its second look and its
/// check run before it returns: the route that stands after them.
#[cfg(not(test))]
fn learn_the_page_again(page: &str, goal: &str, who: &str, node: Option<&crate::Node>) -> Result<Route, String> {
    let own = Walks::default();
    let walks = node.map(|n| &n.walks).unwrap_or(&own);
    let (first, _, walk) = learn_goal_walked(walks, page, goal, who, &|_| {}, node).map_err(|e| e.to_string())?;
    // A held second look keeps the relearn and skips the walk it is held to; the site is never marked as verifying,
    // so no ask waits for a verdict that never comes.
    if !own_asks::held_at(own_asks::Ask::SecondLook, "learn::learn_the_page_again") {
        verification_begins(page);
        verify_learned(walks, page, goal, who, &walk, &first, node);
    }
    store::load_route(&first.id).or_else(|| store::took_the_place_of(&first.id)).ok_or_else(|| "the route its second look stood by was let go".to_string())
}

/// The sites whose just-learned route is being held to a second walk (`verify_learned`), while the node runs: an ask
/// of one waits for the verdict, so it is answered by the route that stood and not the one about to be replaced.
static VERIFYING: std::sync::LazyLock<Mutex<HashSet<String>>> = std::sync::LazyLock::new(Default::default);

/// Whether a route of `url`'s site is being verified now.
pub fn verifying(url: &str) -> bool {
    url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)).is_some_and(|site| VERIFYING.locked().contains(&site))
}

/// How many things an answer lists: a page's links where the answer is a page read, else its longest list.
fn things_in(answer: &serde_json::Value) -> usize {
    match (answer.get("links").and_then(|l| l.as_array()), answer.get("text")) {
        (Some(links), Some(_)) => links.len(),
        _ => longest_list(answer),
    }
}

/// How many things a route's answer lists, asked as its walk asked it. None when it does not answer.
fn things_listed(route: &Route) -> Option<usize> {
    let values: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    let called = crate::run::call_watched(route.clone(), &crate::vault::Filled { values, secrets: Vec::new(), held: Vec::new() }, "the node", None, &["*".to_string()], None).ok()?;
    called.data.filter(|_| called.ok).as_ref().map(things_in)
}

/// Whether an answer listing `new` things lists far less than one listing `was`: under half, of a list worth the
/// name. An answer that could not be had says nothing.
fn lists_far_less(new: Option<usize>, was: Option<usize>) -> bool {
    matches!((new, was), (Some(new), Some(was)) if was >= 6 && new * 2 < was)
}

/// Marks `url`'s site as being verified; `verify_learned` clears it.
pub fn verification_begins(url: &str) {
    if let Some(site) = url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)) {
        VERIFYING.locked().insert(site);
    }
}

/// Holds `first`, just learned from walk `id` of `url` and already answering, to the experiment: the page is walked
/// for a second word and the pick is made again with both walks in hand (`pick_and_keep`). The first ask was
/// answered after one walk; this runs behind it. A route that comes out another call takes `first`'s place.
/// The site's word on whether a route hears its caller, after a second look at the same call. A route the site
/// answered differently for two words hears: that was shown, and a later probe answered alike for every word does
/// not unshow it. It says the site answered that probe with something other than the route's answer: a site asked a
/// good deal by then gives every word the same page. Deaf stands where the first look never showed otherwise, and a
/// second look that asked is otherwise the later word.
fn heard_after(first: &store::Heard, second: &store::Heard) -> store::Heard {
    let mut heard = match (first.probed && first.deaf.is_empty(), second.deaf.is_empty()) {
        (true, false) => first.clone(),
        _ if second.probed => second.clone(),
        _ => first.clone(),
    };
    if first.document_records {
        heard.records_at.clone_from(&first.records_at);
        heard.document_records = true;
    }
    heard
}

/// What the walk `id` that taught `route` answered the ask with, for the values `given` (`confirm::walks_answer`):
/// None where the walk is gone or made no answered call of the route.
pub fn walks_answer(walks: &Walks, id: &str, route: &Route, given: &HashMap<String, String>) -> Option<crate::run::WholeAnswer> {
    let guard = walks.0.locked();
    let walk = guard.get(id)?;
    confirm::walks_answer(route, &walk.trace, given)
}

pub fn verify_learned(walks: &Walks, url: &str, goal: &str, who: &str, id: &str, first: &Route, node: Option<&crate::Node>) {
    // The mark goes when this look ends, however it ends: one that failed part way must not leave the site's asks
    // waiting on a verdict that will never come.
    struct Over(Option<String>);
    impl Drop for Over {
        fn drop(&mut self) {
            if let Some(site) = self.0.take() {
                VERIFYING.locked().remove(&site);
            }
        }
    }
    let _over = Over(url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)));
    // A held second look walks nothing; the site's mark goes with `_over`, as the end of a look clears it, for a caller
    // that marked it before asking.
    if own_asks::held_at(own_asks::Ask::SecondLook, "learn::verify_learned") {
        return;
    }
    // A second look walks the page again and asks the site several times more. On a site that has said it has few
    // asks left, those are the caller's: the route stands as first learned, already held to the site once.
    if !spares(first, SECOND_LOOK_ASKS) {
        eprintln!("   [verify] {} {} stands as first learned: the site says it has few asks left, and a second look would spend them", first.method, first.site);
        return;
    }
    // The reading that lets a ciphered answer read as what the page showed is held over the whole second look, so the
    // four tests (`checked_by_the_site`, real calls whose replies are byte-identical to the walk's) read the answer as
    // the page did (`trace::DecodedGuard`). Computed from the walk's recording; empty when no reply needs it.
    let _decoded = {
        let guard = walks.0.locked();
        guard.get(id).map(|w| {
            let site = url::Url::parse(&w.url).ok().and_then(|u| u.host_str().map(site_of)).unwrap_or_default();
            unbrowse_learn::trace::DecodedGuard::set(decoded_overlay_of(&w.trace, w.recording.as_ref(), &site))
        })
    };
    let verdict = pick_and_keep(walks, url, goal, who, id, &|_| {}, node, true);
    // Another call named in the first's place is held against it by what each lists. The first already answers,
    // plain, and whoever named the other read two walks and not how much each answer holds: a suggestions call
    // answers both words too, with five of the thousand things the results page lists.
    let verdict = match verdict {
        Ok((route, by)) if route.id != first.id && !needs_the_page(first) && lists_far_less(things_listed(&route), things_listed(first)) => {
            eprintln!("   [verify] {} {}{} stands: the call {by} named lists far less than it does", first.method, first.site, first.path.chars().take(40).collect::<String>());
            let _ = store::delete_route(&route.id);
            let _ = store::save_route(first);
            Ok((first.clone(), by))
        }
        other => other,
    };
    let standing: String = match &verdict {
        Ok((route, _)) if route.id != first.id && !(needs_the_page(route) && !needs_the_page(first)) => route.id.clone(),
        _ => first.id.clone(),
    };
    match verdict {
        // A route that answers over plain calls, and that the site shows hears its caller, is not given up for one
        // only the page can make: whoever named the other (a proposer reads two walks, never the cost of a call), the
        // first already does the goal, faster, for every value.
        Ok((route, by)) if route.id != first.id && needs_the_page(&route) && !needs_the_page(first) && {
            let asked: Vec<String> = first.inputs.iter().filter_map(|i| i.default.clone()).collect();
            hears(first, &asked) == Hears::Yes
        } => {
            let _ = store::drop_learned(&route.id);
            let _ = store::save_route(first);
            eprintln!("   [verify] {} {}{} stands: it answers plain and hears its caller, and the call {by} named needs the page", first.method, first.site, first.path.chars().take(40).collect::<String>());
        }
        Ok((route, by)) if route.id != first.id => {
            let _ = store::retire_route_for(&first.id, &route.id);
            eprintln!("   [verify] {} {}{} takes the place of {} {}{}, by {by}", route.method, route.site, route.path.chars().take(40).collect::<String>(), first.method, first.site, first.path.chars().take(40).collect::<String>());
        }
        // The same call, learned again behind the first answer: its trials ran a second time, against a site that
        // has now been asked a good deal. Where the first came out plain and this one needs the page, the site's
        // refusal of the second trial is all that changed, and the route that answered is put back.
        Ok((route, _)) if needs_the_page(&route) && !needs_the_page(first) => {
            let mut kept = first.clone();
            kept.heard = heard_after(&first.heard, &route.heard);
            let _ = store::save_route(&kept);
            eprintln!("   [verify] {} {} stands as first learned: plain, where the second look's trial was refused", first.method, first.site);
        }
        Ok((route, _)) => {
            // The same call, looked at twice: what the site showed of its hearing the first time is not unshown.
            let heard = heard_after(&first.heard, &route.heard);
            if heard != route.heard {
                let mut kept = route.clone();
                kept.heard = heard;
                let _ = store::save_route(&kept);
                eprintln!("   [verify] {} {} hears its caller, as the site showed when it was first learned: the second look's probe was answered alike for every word", first.method, first.site);
            }
            eprintln!("   [verify] {} {} stands", first.method, first.site)
        }
        Err(e) => eprintln!("   [verify] {} {} stands, the second look settled nothing: {e}", first.method, first.site),
    }
    // The route that stands, where it is a chain or needs the page, is laid out for a proposer: which of its ties
    // are real is not in one walk, and the site verifies what is proposed (`links`).
    let walked = walks.0.locked().get(id).map(|w| w.trace.clone());
    // The same page walked for another word, where the learn made that walk: what the two sent is measured.
    let again = walks.0.locked().get(&format!("{id}c")).map(|w| w.trace.clone());
    if let (Some(route), Some(walked)) = (store::load_route(&standing), walked) {
        if !route.write {
            let route = links::with_proposed_links(route, &walked, again.as_deref(), url, goal);
            links::with_proposed_fields(route, &walked, again.as_deref(), goal);
        }
    }
    // With the switch on, the route that stands is put to the site: its four tests, then the smallest request it
    // accepts (`checked`). Written onto the record as it is on disk now: a route changed while the check ran keeps
    // the change, and only what the site said is added.
    if learns_by_example() {
        if let Some(route) = store::load_route(&standing) {
            let (agent, offered) = match walks.0.locked().get(id) {
                Some(w) => {
                    let asked: Vec<String> = route.inputs.iter().filter_map(|i| i.default.clone()).collect();
                    // A slot whose kind the body says (a date, one of the site's listed words) is asked another value
                    // of that kind first: the page's own words are words, and a date slot takes none of them.
                    let of_its_kind = route.body.as_ref().map(unbrowse_learn::lab::meaning::other_values).unwrap_or_default();
                    let offered: Vec<String> = of_its_kind.into_iter().chain(trial::offered_words(&w.trace, url, &asked)).collect();
                    (w.trace.exchanges.iter().find_map(|e| e.request_header("user-agent").map(String::from)), offered)
                }
                None => (None, Vec::new()),
            };
            let checking = checked::checked_by_the_site(&route, agent.as_deref(), &offered);
            eprintln!("   {}", checking.said);
            let graph_before = serde_json::to_value(&route.graph).ok();
            let _ = store::update_route(&route.id, |now| {
                if serde_json::to_value(&now.graph).ok() == graph_before {
                    now.steps = checking.route.steps;
                    now.graph = checking.route.graph.clone();
                }
                now.checked = checking.route.checked.clone();
            });
        }
    }
    // The first route's id was handed to whoever asked. Where it is gone and another stands, the id leads there.
    if standing != first.id && store::load_route(&first.id).is_none() && store::load_route(&standing).is_some() {
        store::succeeded(&first.id, &standing);
    }
}

/// The query key by which a page links to its own next page: a link on it to its own address (the same host and
/// path, every value its query asked kept as it was) with other values added, exactly one of which is `2`, under a
/// key the page's own address does not send. None for anything but a page, or where no link or more than one key
/// says so.
fn next_page_linked(page: &Exchange) -> Option<String> {
    if !page.is_main_document() || !page.method.eq_ignore_ascii_case("GET") {
        return None;
    }
    let asked: Vec<(String, String)> = page.url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let body = page.response_body.as_deref()?;
    let mut keys = std::collections::BTreeSet::new();
    for href in body.split("href=").skip(1).filter_map(|rest| {
        let quote = rest.chars().next().filter(|c| matches!(c, '"' | '\''))?;
        rest[1..].split(quote).next()
    }) {
        let Ok(link) = page.url.join(&href.replace("&amp;", "&").replace("&#038;", "&").replace("&#38;", "&")) else { continue };
        // The same page: its path, or its path under a prefix the site puts before it (a language: `/-/en/s` for `/s`).
        // Or another address of the site's that carries everything this page was asked: a site may answer a search
        // at its front page and read on from its search page. Whether the value reads on at this page's own
        // address is the site's to say, when the route is asked for its next page (`read_on_by_trial_for`).
        let same_page = link.path() == page.url.path() || (page.url.path().len() > 1 && link.path().ends_with(page.url.path()));
        let sent: Vec<(String, String)> = link.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let carries_the_ask = !asked.is_empty() && asked.iter().all(|pair| sent.contains(pair));
        if link.host_str() != page.url.host_str() || !(same_page || carries_the_ask) {
            continue;
        }
        if !asked.iter().all(|pair| sent.contains(pair)) {
            continue;
        }
        let twos: Vec<&String> = sent.iter().filter(|(k, v)| v == "2" && !asked.iter().any(|(a, _)| a == k)).map(|(k, _)| k).collect();
        if let [key] = twos[..] {
            keys.insert(key.clone());
        }
    }
    match keys.len() {
        1 => keys.into_iter().next(),
        _ => None,
    }
}

/// Whether an answer is a file: the site names a kind for it that is no page, no data and no text.
fn a_file(content_type: &str, page: bool, data: bool) -> bool {
    let kind = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    let readable = kind.is_empty() || kind.starts_with("text/") || kind.contains("json") || kind.contains("xml") || kind.contains("javascript") || kind.contains("html");
    !page && !data && !readable
}

/// Whether a plain request's answer is data: JSON holding something, or text that says more than one bare line.
fn plain_data(json: Option<&serde_json::Value>, text: bool, body: &str) -> bool {
    match json {
        Some(serde_json::Value::Object(o)) => !o.is_empty(),
        Some(serde_json::Value::Array(a)) => !a.is_empty(),
        Some(_) => false,
        None => text && (body.trim().lines().count() > 1 || body.trim().chars().count() >= 64),
    }
}

/// A route an agent picked from a walk (`unbrowse_walk`), held to the site as a learned one is: the same links
/// step, behind the reply. The site's verification mark is cleared when it ends.
pub fn hold_picked(walks: &Walks, walk: &str, id: &str, url: &str, goal: &str) {
    let walked = walks.0.locked().get(walk).map(|w| w.trace.clone());
    if let (Some(route), Some(walked)) = (store::load_route(id), walked) {
        if !route.write {
            links::with_proposed_links(route, &walked, None, url, goal);
        }
    }
    if let Some(site) = url::Url::parse(url).ok().and_then(|u| u.host_str().map(site_of)) {
        VERIFYING.locked().remove(&site);
    }
}

/// What a walk's own site answered with, and the scripts its page ran wherever they are served from, as text: where
/// the addresses the page links to, and the ones its own code writes, are read from.
fn walked_text(walks: &Walks, walk: &str, site: &str) -> String {
    walks.0.locked().get(walk).map(|w| {
        w.trace.exchanges.iter().filter(|e| e.resource_type.as_deref() == Some("Script") || e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, site))).filter_map(|e| e.response_body.as_deref()).filter(|b| b.len() < 2_000_000).collect::<Vec<_>>().join("\n")
    }).unwrap_or_default()
}

/// Whether a route runs only with the page: a step of it is the page's own to make.
fn needs_the_page(route: &Route) -> bool {
    let graph_needs = route.browser_assisted || route.graph.steps.iter().any(|s| s.needs_browser || s.is_page_signed());
    if !graph_needs || route.browser_assisted || !learns_by_example() {
        return graph_needs;
    }
    // What a call runs with the switch on is the graph with the stored body laid over it (`body::overlay`): where the
    // body makes plainly every value the graph left to the page (the caller's date in the site's format, which no
    // class of a graph says), no step of it needs the page.
    let Some(body) = route.body.as_ref() else { return true };
    let laid = unbrowse_learn::body::overlay(&route.graph, Some(body)).body;
    laid.steps.iter().any(|s| s.page || s.holes.iter().any(|h| h.ways.first().is_none_or(|w| w.rung >= 3)))
}

/// A wall the walk shows read from a walk that ended on `Loading` (`stood_in_the_way`): a sign-in, a check or a door.
/// `None` when the walk only loaded a page with no wall — then a warm rewalk is still worth it. This lets a bounced
/// walk be read from its own trace before a rewalk would mask the bounce with a second `Loading`.
fn wall_read(trace: &Trace, url: &str) -> Option<Unlearned> {
    match stood_in_the_way(trace, url, Unlearned::Loading) {
        Unlearned::Loading => None,
        read => Some(read),
    }
}

fn learn_goal_from(walks: &Walks, url: &str, goal: &str, who: &str, eye: Sink, node: Option<&crate::Node>, id: &str) -> Result<(Route, &'static str), Unlearned> {
    let id = id.to_string();
    eye(Eye::Started { walk: id.clone(), url: url.to_string(), goal: goal.to_string(), agent: who.to_string() });
    let mut r = pick_and_keep(walks, url, goal, who, &id, eye, node, false);
    // A walk the site bounced to a sign-in or a wall is already read from this walk (`wall_read`): it won't be helped
    // by a warm rewalk (the site bounces it again), and it must not be surfaced as "the page needs clicks". Read it
    // now, before the rewalk below would mask it with a second Loading on a trace that no longer holds the bounce.
    if matches!(r, Err(Unlearned::Loading)) {
        if let Some(read) = walks.0.locked().get(&id).and_then(|w| wall_read(&w.trace, url)) {
            r = Err(read);
        }
    }
    // A cold browser can end its walk before the page's script asks for anything. The page is walked once more, warm,
    // before it is handed over: what it asked for may have been a moment away.
    if matches!(r, Err(Unlearned::Loading)) && unbrowse_learn::goal::only_reads(goal) && !asked_values(url, &[]).is_empty() && !own_asks::held_at(own_asks::Ask::Rewalk, "learn::learn_goal_from") {
        r = pick_and_keep(walks, url, goal, who, &id, eye, node, false);
    }
    // A walk whose capture holds nothing from the page's own site never saw the page: it is walked again, once, whatever
    // the page asks for. A second capture that fails says so (`Unlearned::Unseen`), never that the page needs hands.
    if matches!(r, Err(Unlearned::Unseen(_))) && !own_asks::held_at(own_asks::Ask::Rewalk, "learn::learn_goal_from") {
        eprintln!("   [learn] the walk's capture holds nothing from the page's own site: walked once more");
        r = pick_and_keep(walks, url, goal, who, &id, eye, node, false);
    }
    // What stood in the way, read once from the walk itself where nothing on the way named it.
    let r = r.map_err(|why| match walks.0.locked().get(&id) {
        Some(w) => stood_in_the_way(&w.trace, url, why),
        None => why,
    });
    if let Err(e) = &r {
        eye(Eye::Failed { walk: id, error: e.to_string() });
    }
    r
}

/// Why a walk never saw the page it was sent to, when it didn't: its capture holds no exchange from the walked page's
/// own site, not its document and not one of its calls (only the browser's own pages, `chrome://` and the like, or
/// nothing). Such a walk is a capture that failed, not a reading of the page: whatever the page does as it loads is
/// not in it. None when anything of the site's is there, however little.
///
/// The site read is where the walk landed (`walked_site`): a site that moves its page to another name answered from
/// there, and the capture holds that page whole. Only a capture that holds nothing of the page *anywhere* is a
/// capture that failed.
fn unseen(trace: &Trace, url: &str) -> Option<String> {
    let host = url::Url::parse(url).ok()?.host_str()?.to_string();
    let site = walked_site(&trace.exchanges, &host);
    let theirs = |e: &Exchange| matches!(e.url.scheme(), "http" | "https") && e.url.host_str().is_some_and(|h| unbrowse_learn::identity::on_site(h, &site));
    if trace.exchanges.iter().any(theirs) {
        return None;
    }
    let own = trace.exchanges.iter().filter(|e| !matches!(e.url.scheme(), "http" | "https")).count();
    Some(format!(
        "the walk's capture recorded nothing from {site} (not the page's document, nor any of its calls; {own} request(s) of the browser's own pages): the capture failed, which says nothing of whether the page needs clicks or typing"
    ))
}

/// The calls agents rejected for `page` (`unbrowse_judge`): the target call of each route judged wrong for the page, and,
/// for a stated `goal`, of each route an agent renamed to say it does something other than that goal. A learner passes
/// them over and keeps its next pick, so a page is never learned back into a call an agent said doesn't answer it.
fn rejected_calls(page: &str, goal: Option<&str>) -> Vec<unbrowse_learn::Step> {
    let said = goal.map(unbrowse_learn::goal::words);
    store::load_routes()
        .into_iter()
        .filter(|r| r.wrong_for(page).is_some() || (r.judged.named && said.as_ref().is_some_and(|w| unbrowse_learn::goal::words(&r.what) != *w)))
        .filter_map(|r| r.graph.steps.last().cloned())
        .collect()
}

/// Whether exchange `e` is one of the rejected calls (`same_call`).
fn is_rejected(rejected: &[unbrowse_learn::Step], e: &Exchange) -> bool {
    rejected.iter().any(|s| same_call(s, &e.method, &e.url, e.request_body.as_deref()))
}

/// The value a field fixes that names which call it is: a constant, or a value seen once that reads as a name (letters,
/// no digits), which a key or a token never does.
fn naming_value(class: &unbrowse_learn::graph::Class) -> Option<&String> {
    use unbrowse_learn::graph::Class;
    match class {
        Class::Constant { value, .. } => Some(value),
        Class::Unconfirmed { value } if value.chars().any(char::is_alphabetic) && !value.chars().any(|c| c.is_ascii_digit()) => Some(value),
        _ => None,
    }
}

/// What a step's body says of which operation it is: each body key it fixes to a naming value (`naming_value`), in
/// order. Empty for a body that fixes none, and for no body: such a call is told apart by its address alone.
fn operation_of(step: &unbrowse_learn::Step) -> String {
    use unbrowse_learn::slots::Loc;
    let mut named: Vec<String> = step
        .fields
        .iter()
        .filter(|f| matches!(f.loc, Loc::Json(_) | Loc::Form(_)))
        .filter_map(|f| naming_value(&f.class).map(|v| format!("{:?}={v}", f.loc)))
        .collect();
    named.sort();
    if named.is_empty() { String::new() } else { format!(" {}", named.join("&")) }
}

/// Whether a request names the operation `step` names, where the step's template can't say it: every value the step
/// fixes at a key of the query or the body (`method=flickr.photos.search`, a JSON body's `operationName`) is the same
/// in the request, where the request sends that key. A template writes a fixed query value as a placeholder too, and an
/// API that answers every operation at one address (`POST /graphql`) tells them apart only by these. A value seen once
/// counts when it reads as a name (letters, no digits): a key or a token seen once is still free to change.
fn names_the_same_operation(step: &unbrowse_learn::Step, u: &url::Url, body: Option<&str>) -> bool {
    use unbrowse_learn::slots::Loc;
    let json: Option<serde_json::Value> = body.and_then(|b| serde_json::from_str(b).ok());
    let form: Vec<(String, String)> = body.filter(|_| json.is_none()).map(|b| url::form_urlencoded::parse(b.as_bytes()).into_owned().collect()).unwrap_or_default();
    step.fields.iter().all(|f| {
        let Some(fixed) = naming_value(&f.class) else { return true };
        let sent = match &f.loc {
            Loc::Query(k) => u.query_pairs().find(|(q, _)| q == k).map(|(_, v)| v.into_owned()),
            Loc::Form(k) => form.iter().find(|(q, _)| q == k).map(|(_, v)| v.clone()),
            Loc::Json(p) => json.as_ref().and_then(|j| j.pointer(p)).map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())),
            _ => return true,
        };
        sent.is_none_or(|v| &v == fixed)
    })
}

/// Whether a request is the call `step` makes, whatever values it sends: the same method and host, the same path with
/// any piece the step fills (an input, a session value, an earlier answer's) taking any value, and every query value
/// the step fixes the same where the request sends that key. A different fixed value (`type=suggest` against
/// `type=full`) is another call; a different search is the same one.
fn same_call(step: &unbrowse_learn::Step, method: &str, u: &url::Url, body: Option<&str>) -> bool {
    let Ok(at) = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")) else { return false };
    if !step.method.eq_ignore_ascii_case(method) || at.host_str() != u.host_str() {
        return false;
    }
    let pieces = |x: &url::Url| -> Vec<String> {
        x.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default()
    };
    let filled = |v: &str| v.starts_with('{') && v.ends_with('}');
    let (want, got) = (pieces(&at), pieces(u));
    want.len() == got.len()
        && want.iter().zip(&got).all(|(w, g)| filled(w) || w == g)
        && at.query_pairs().all(|(k, v)| filled(&v) || u.query_pairs().find(|(gk, _)| *gk == k).is_none_or(|(_, gv)| gv == v))
        && names_the_same_operation(step, u, body)
}

/// The walk's candidates without the rejected calls.
fn pass_over(view: &mut WalkView, trace: &Trace, rejected: &[unbrowse_learn::Step]) {
    view.candidates.retain(|c| trace.exchanges.get(c.index).is_none_or(|e| !is_rejected(rejected, e)));
}

/// The choice the site asked again on this walk, if its last page is a question the owner's browsing answered.
fn choice_asked(trace: &Trace, site: &str) -> Option<unbrowse_learn::setup::Setup> {
    let page = trace.exchanges.iter().rfind(|e| e.is_main_document() && e.status < 400)?;
    let read = unbrowse_learn::page::read(page.response_body.as_deref()?, &page.url);
    crate::setups::load(site).into_iter().find(|s| s.asked_by(&read))
}

/// The sign-in the node knows for `site`, when the walk of `url` was sent to the page it starts on.
fn sign_in_asked(trace: &Trace, url: &str, site: &str) -> Option<unbrowse_learn::setup::Setup> {
    let landed = trace.exchanges.iter().rfind(|e| e.is_main_document() && (200..300).contains(&e.status))?;
    let same = |a: &url::Url, b: &url::Url| a.host_str() == b.host_str() && a.path().trim_end_matches('/') == b.path().trim_end_matches('/');
    if url::Url::parse(url).ok().is_some_and(|asked| same(&asked, &landed.url)) {
        return None;
    }
    crate::setups::load(site).into_iter().find(|s| s.kind == unbrowse_learn::setup::Kind::SignIn && url::Url::parse(&s.page).ok().is_some_and(|p| same(&p, &landed.url)))
}

/// Whether call `i` of a walk may be kept for the goal, read from the walk alone: a page whose own data call failed,
/// an answer that fails the goal (`fails_goal`) or one that shows nothing of what the page showed may not.
fn may_answer(trace: &Trace, i: usize, goal: &str, url: &str, query_values: &[String], shown: &unbrowse_learn::shown::Shown, site: &str) -> bool {
    let e = &trace.exchanges[i];
    !(e.is_main_document() && its_data_failed(trace, i)) && fails_goal(e, goal, url, query_values, &landed(trace), trace).is_none() && shows_nothing(e, shown, site, query_values, goal).is_none()
}

/// What a walk's own traffic picks, with no site asked: the call, who picked it and why. One reader for a live learn
/// and for a kept walk read again (`corpus`), so a change to picking is measured on every walk kept.
fn walk_pick(trace: &Trace, view: &WalkView, goal: &str, query_values: &[String], scores: Vec<(f64, usize, bool, Vec<String>)>, passes: &dyn Fn(usize) -> bool, model: Option<usize>) -> Option<(usize, &'static str, Vec<String>)> {
    // The model may choose, but not a call the rule scores far below one that passes: a goal that names a call's own
    // words (`FlightListSearchSSE`) is read by the rule, and a model pick of a weaker call is not trusted over it.
    let score_of = |i: usize| scores.iter().find(|(_, j, _, _)| *j == i).map(|s| s.0);
    let top = scores.iter().filter(|(_, i, noise, _)| !*noise && passes(*i)).max_by(|a, b| a.0.total_cmp(&b.0));
    if model_stands(model, top.map(|(best, at, _, _)| (*best, *at)), score_of) {
        return Some((model.expect("a model pick that stands"), "the decision model", vec!["the decision model was confident it answers the goal".to_string()]));
    }
    match rule_pick(trace, view, goal, query_values, scores) {
        Ok((i, reasons)) => Some((i, "the rule", reasons)),
        // A stopped ask picks nothing, not the page in the call's place.
        Err(_) if unbrowse_learn::mint::asked_to_stop() => None,
        // No call answers, but a page the agent opened that serves the answer in its own content is the answer
        // itself: for a server-rendered page the route is just the GET that returns the HTML.
        Err(_) => document_answer(trace, &view.site).filter(|&i| passes(i)).map(|i| (i, "the page itself", vec!["the page the agent opened serves the answer in its own content; no call is needed".to_string()])),
    }
}

/// Whether a learn walks its page a second time, for a word nobody searches for, before it keeps a call
/// (`UNBROWSE_SECOND_WALK`). Off unless asked for: it is a page load nobody asked the node to make. The test bank
/// turns it on; a route learned without it is held to the caller's own second value when that comes.
fn second_walk() -> bool {
    std::env::var("UNBROWSE_SECOND_WALK").is_ok_and(|v| !v.trim().is_empty() && v.trim() != "0")
}

/// The first walk's candidates a second walk shows deaf, with the names of the inputs they ignore: the page is walked
/// again with every word it was asked replaced by one nobody searches for, and a call the page makes both times with
/// the same answer does not hear the caller (`experiment::told`). Nothing when the page was asked no word, or the
/// second walk fails: then nothing was learned, and the first walk stands as it would have.
fn deaf_on_a_second_walk(walks: &Walks, view: &WalkView, url: &str, in_path: &[(String, String)], id: &str, who: &str) -> (Vec<usize>, Vec<String>) {
    let asked = {
        let guard = walks.0.locked();
        let Some(w) = guard.get(&view.walk) else { return Default::default() };
        walk_inputs(url, in_path, &w.trace.exchanges)
    };
    let values: Vec<String> = asked.iter().map(|i| i.value.clone()).collect();
    let Some(other) = experiment::for_another_word(url, &values, NOBODYS_WORD) else { return Default::default() };
    let (was, now) = experiment::asked_apart(url, &other);
    let names: Vec<String> = asked.iter().filter(|i| was.contains(&i.value)).map(|i| i.name.clone()).collect();
    let second = match walk_as(walks, &other, &format!("{id}b"), who, &|_| {}) {
        Ok(second) => second,
        Err(why) => {
            eprintln!("   [second walk] not made: {why}");
            return Default::default();
        }
    };
    let guard = walks.0.locked();
    let (Some(first), Some(second)) = (guard.get(&view.walk), guard.get(&second.walk)) else { return Default::default() };
    let deaf: Vec<usize> = view.candidates.iter().map(|c| c.index).filter(|&i| experiment::told(&first.trace, i, &was, &second.trace, &now) == experiment::Told::Deaf).collect();
    eprintln!("   [second walk] {} of {} candidates answer the same for a word nobody searches for", deaf.len(), view.candidates.len());
    (deaf, names)
}

/// `experiment` says the walk `id` was already made and its route already answers: the pick is made again from that
/// same walk with a second walk of the page beside it (`trial`), never walking the first page twice.
#[allow(clippy::too_many_arguments)]
fn pick_and_keep(walks: &Walks, url: &str, goal: &str, who: &str, id: &str, eye: Sink, node: Option<&crate::Node>, experiment: bool) -> Result<(Route, &'static str), Unlearned> {
    if let Some(why) = unwalkable(url, &store::load_settings().excluded) {
        return Err(Unlearned::Unwalkable(why));
    }
    let mut view = if experiment { view(walks, id).ok_or(Unlearned::Loading)? } else { walk_read(walks, url, id, who, eye)? };
    if let Some(why) = walks.0.locked().get(&view.walk).and_then(|w| unseen(&w.trace, url)) {
        return Err(Unlearned::Unseen(why));
    }
    // One reading for this learn: a reply no standard reader reads, that the page's own code unpacked, reads as what
    // it was turned into, everywhere recognition and the build ask `own_json` (`trace::DecodedGuard`). Computed once
    // from the walk's recording; empty when no reply needs it.
    let _decoded = {
        let guard = walks.0.locked();
        guard.get(&view.walk).map(|w| unbrowse_learn::trace::DecodedGuard::set(decoded_overlay_of(&w.trace, w.recording.as_ref(), &view.site)))
    };
    // The candidates were gathered before the reading was set (the walk had to run first to hold its recording): with
    // the reading in hand, gather them again, so a call whose reply only the page's own code reads is a candidate.
    if _decoded.as_ref().is_some_and(|g| !g.is_empty()) {
        if let Some(again) = crate::learn::view(walks, &view.walk) {
            view = WalkView { cookies: view.cookies, ..again };
        }
    }
    if by_loading(goal).is_err() {
        return Err(Unlearned::Loading);
    }
    // The site asked what the owner's browsing already answered once: a question, or the sign-in its page was sent to.
    // It is answered the same way, in the browser the walk then runs in, so the walk reads what that leads to.
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    // The site the walk is of: where its browser landed, not only the address it was asked for. A site that moves a
    // page to another of its own names (a country's store, a search the site hosts elsewhere) is the walk of where it
    // landed (`walked_site`), which is how a live walk was already read.
    let site = walks.0.locked().get(&view.walk).map_or_else(|| site_of(&host), |w| walked_site(&w.trace.exchanges, &host));
    let taken = walks.0.locked().get(&view.walk).and_then(|w| door_taken(id, &w.trace, &view.site));
    if let Some(taken) = taken {
        eye(taken);
    }
    let asked = if experiment {
        None
    } else {
        let guard = walks.0.locked();
        guard.get(&view.walk).and_then(|w| choice_asked(&w.trace, &site).or_else(|| node.and_then(|_| sign_in_asked(&w.trace, url, &site))))
    };
    if let Some(setup) = asked.filter(|_| !own_asks::held_at(own_asks::Ask::Setups, "learn::setups::run")) {
        let done = crate::setups::run(&setup, &site, who, node);
        let again = done.is_ok().then(|| walk_read(walks, url, id, who, eye));
        crate::browse::heal_done(&site);
        if let Some(again) = again {
            view = again?;
            // Walked again, the site no longer asks: that took, as a call that passes would say.
            let guard = walks.0.locked();
            let asks = guard.get(&view.walk).is_none_or(|w| choice_asked(&w.trace, &site).is_some() || node.is_some() && sign_in_asked(&w.trace, url, &site).is_some());
            drop(guard);
            if !asks {
                crate::setups::took(&site);
            }
        }
    }
    // Still sent to a sign-in: the owner's own browser on this machine may be signed in to the site. Its session is
    // taken in and the page walked again, so the owner isn't asked for what their browser already holds.
    if !experiment && node.is_some() {
        let sent = walks.0.locked().get(&view.walk).and_then(|w| {
            page_detoured(&w.trace, url)
                .or_else(|| walk_met_a_clearable_check(&w.trace, &site).then(|| "the site's check turned the page's own ask away".to_string()))
        });
        // Only on the owner's yes, asked in the node's window and naming who the walk is for (`import::owner_lets`).
        let take_in = |h: &str| crate::import::when_signed_out(h, who, |q| crate::import::ask_in_the_nodes_window(node, q));
        if let Some(again) = crate::import::again_signed_in("learn", sent.as_deref(), &host, take_in, || walk_as(walks, url, id, who, eye)) {
            view = again?;
        }
    }
    // What the site's answers on this walk say of how many asks it has left (`budget`).
    if let Some(w) = walks.0.locked().get(&view.walk) {
        w.trace.exchanges.iter().for_each(unbrowse_learn::budget::note);
    }
    // The walk's browser ended on a page that asks for a person: that is what stood between the walk and an answer,
    // and the caller is told so, not that the page needs typing.
    let checked = walks.0.locked().get(&view.walk).is_some_and(|w| {
        w.trace.exchanges.iter().rev().find(|e| e.is_main_document() && e.main_frame != Some(false) && e.response_body.is_some()).is_some_and(page_asks_for_person)
    });
    if checked {
        let why = "the site sent the page to its check for a person, so the walk read no answer: someone on the page may pass it".to_string();
        eprintln!("   [learn] {why}");
        return Err(Unlearned::Check(why, "learn.fails_goal"));
    }
    // The site refused the page's own ask on this walk: nothing else the page fetched is that answer. Refused, unless
    // the walk was sent on to a check.
    let refused = walks.0.locked().get(&view.walk).and_then(|w| the_pages_ask_was_refused(&w.trace, url, &site).map(|why| (why.clone(), stood_in_the_way(&w.trace, url, Unlearned::Door(why, "learn.the_pages_ask_was_refused")))));
    if let Some((why, refused)) = refused {
        eprintln!("   [learn] {why}");
        return Err(refused);
    }
    // The calls the site showed deaf to the caller on this walk, with the inputs they ignore, and the one that stands
    // when none of the rest hears.
    let mut unheard: Vec<(usize, Vec<String>)> = Vec::new();
    let mut settled: Option<(usize, Vec<String>)> = None;
    // The calls a second walk of the page, for a word nobody searches for, showed deaf (`second_walk`): none is a
    // candidate while another call passes. When no other does, the pick is made among them all and stands marked deaf.
    // The pieces of the page's path that are the caller's, on the site's word (`trial::callers_own`): asked once,
    // before anything is probed with them, so no probe replaces a word of the address.
    let read_path = || {
        let read = walks.0.locked().get(&view.walk).map(|w| (path_inputs(url, goal, &w.trace), w.trace.exchanges.iter().find_map(|e| e.request_header("user-agent").map(String::from))));
        read.map(|((in_path, by), walked)| (if node.is_some() { trial::callers_own(url, in_path, walked.as_deref()) } else { in_path }, by))
    };
    let mut callers_path = read_path();
    let (mut walk_deaf, deaf_names) = if second_walk() { deaf_on_a_second_walk(walks, &view, url, callers_path.as_ref().map(|(p, _)| p.as_slice()).unwrap_or_default(), id, who) } else { Default::default() };
    let mut stands_deaf = false;
    // The page walked for a second word, and the answer the two walks agree on: what a learn with a node is judged
    // by. One walk ranks calls by what they carry and how they are named; two measure which one answers.
    // The first ask is answered after one walk. The second walk is made behind it (`experiment`), on the walk the
    // route was learned from.
    let second = match (&callers_path, node) {
        (Some((in_path, _)), Some(_)) if experiment => trial::second_walk(walks, &view.walk, url, goal, id, who, in_path),
        _ => None,
    };
    // What the second walk showed of the page's address is the site's word (`note_address`): the path is read
    // again without those pieces, so no route takes one for a value. And the value the word went in place of is
    // called what a proposer said, where it was only named for its place.
    if let Some(second) = &second {
        if !second.address.is_empty() {
            note_address(url, &second.address);
            callers_path = read_path();
        }
        if let (Some((value, name)), Some((in_path, _))) = (&second.called, callers_path.as_mut()) {
            if !in_path.iter().any(|(n, _)| n == name) && !walk_inputs(url, &[], &[]).iter().any(|i| i.name == *name) {
                for (n, v) in in_path.iter_mut().filter(|(n, v)| v == value && n.starts_with("part") && n[4..].chars().all(|c| c.is_ascii_digit())) {
                    eprintln!("   [trial] \"{v}\" is called {name}, as the proposer says, where it was named {n} for its place");
                    *n = name.clone();
                }
            }
        }
    }
    let mut agreed = second.as_ref().and_then(|second| trial::agreed(walks, &view, url, goal, second));
    // And the call a proposer names from the two walks laid out as one graph, when one is configured: which of the
    // calls that answer is the one a person came for is not in the traffic. It is held to the same tests as any pick.
    let mut proposed = second.as_ref().and_then(|second| trial::proposed_answer(walks, &view, url, goal, second));
    let (route, by) = loop {
        let guard = walks.0.locked();
        let trace = &guard.get(&view.walk).ok_or("the walk vanished")?.trace;
        if let Some(why) = page_unreached(trace, url) {
            return Err(why);
        }
        // A call an agent rejected for this page, or renamed as something else, is no candidate (`rejected_calls`).
        let rejected = rejected_calls(url, Some(goal));
        pass_over(&mut view, trace, &rejected);
        let (in_path, inputs_by) = callers_path.clone().unwrap_or_else(|| path_inputs(url, goal, trace));
        let in_path = with_other_pages(url, in_path, &pages_learned_for(url, goal));
        let query_values = asked_values(url, &in_path);
        // A call the site has just shown not to hear the caller (`unheard`) is no candidate for this page.
        let scores: Vec<_> = rule_scores(trace, &view, goal, &query_values, &[]).into_iter().filter(|(_, i, _, _)| !unheard.iter().any(|(j, _)| j == i) && !walk_deaf.contains(i)).collect();
        let at = |i: usize| view.candidates.iter().find(|c| c.index == i);
        if unheard.is_empty() {
        eye(Eye::Scored {
            walk: id.to_string(),
            exchanges: view.exchanges,
            candidates: scores
                .iter()
                .take(12)
                .filter_map(|(score, i, noise, _)| {
                    let c = at(*i)?;
                    Some(Scored { index: *i, method: c.method.clone(), host: c.host.clone(), path: bare(&c.path), score: (score * 10.0).round() / 10.0, noise: *noise })
                })
                .collect(),
        });
        }
        // Whoever picks, the pick is kept only when its answer answers the goal (`may_answer`), and never a call an
        // agent rejected or the site has just shown deaf.
        let shown = page_shown(&trace.exchanges, url, &[]);
        let passes = |i: usize| !is_rejected(&rejected, &trace.exchanges[i]) && !unheard.iter().any(|(j, _)| *j == i) && !walk_deaf.contains(&i) && may_answer(trace, i, goal, url, &query_values, &shown, &view.site);
        let model = model_pick(trace, &view, goal, &query_values).filter(|&i| passes(i));
        let (index, by, reasons) = if let Some((i, _)) = &settled {
            (*i, "the rule", vec!["no other call on the page hears the caller either, so the first pick stands for this page alone".to_string()])
        } else {
            // Two walks overrule one walk's pick only where they speak against it. The rule and the model read what a
            // call is for, which lines that say a word back cannot (a search's suggestions say it back on every
            // line), so their pick stands unless the second walk made the same call and it answered the same, or
            // answered with nothing of its own word. Then the call the two walks agree on takes its place.
            let one_walk = walk_pick(trace, &view, goal, &query_values, scores, &passes, model);
            let spoken_against = match (&one_walk, &second) {
                (Some((i, _, _)), Some(second)) => guard.get(&second.view.walk).is_some_and(|other| {
                    let (asked, others) = experiment::asked_apart(url, &second.url);
                    experiment::speaks_against(trace, *i, &asked, &other.trace, &others)
                }),
                // No pick from one walk: what two agree on is all there is.
                (None, Some(_)) => true,
                _ => false,
            };
            let overruled = if spoken_against { agreed.take().filter(|&i| passes(i)) } else { None };
            // A proposer's pick comes before both, unless the second walk made the call and it answered the same. An
            // answer that changed and never spells the value is left to the proposer's reading: a flight list names
            // cities and airports, never the code the page was asked with.
            let named = proposed.take().filter(|&i| passes(i)).filter(|&i| {
                second.as_ref().and_then(|second| guard.get(&second.view.walk).map(|other| (second, other))).is_none_or(|(second, other)| {
                    let (asked, others) = experiment::asked_apart(url, &second.url);
                    experiment::told(trace, i, &asked, &other.trace, &others) != experiment::Told::Deaf
                })
            });
            match named.map(|i| (i, "the proposer", vec!["a proposer shown both walks of the page named this call as the answer, and the second walk does not show it deaf".to_string()])).or(overruled.map(|i| (i, "two walks of the page", vec!["the page made this call for both words, its answer changed with the word, and it says each word back on the most lines".to_string()]))).or(one_walk) {
                Some(pick) => pick,
                // Every call that answered was shown deaf: the first of them still answers this page.
                None => match unheard.first().cloned() {
                    Some(first) => {
                        settled = Some(first);
                        continue;
                    }
                    // Every call the second walk left was no answer: the pick is made among the deaf ones too.
                    None if !walk_deaf.is_empty() => {
                        walk_deaf.clear();
                        stands_deaf = true;
                        continue;
                    }
                    // No call answers. Where the walk holds a reply only the page's own code reads and this machine runs
                    // none, that is why: said so, not as a page that needs hands.
                    None => {
                        let unread = guard.get(&view.walk).and_then(|w| left_to_page_code(&w.trace, w.recording.as_ref(), &view.site));
                        return Err(unread.map_or(Unlearned::Loading, |why| Unlearned::Runtime(format!("the page's answer is read only by the page's own code: {}", why.said()))));
                    }
                },
            }
        };
        let picked_the_page = trace.exchanges[index].is_main_document();
        drop(guard);
        if let Some(c) = at(index) {
            eye(Eye::Picked { walk: id.to_string(), index, method: c.method.clone(), host: c.host.clone(), path: bare(&c.path), by, reasons });
        }
        let mut route = keep_as(walks, &view.walk, index, goal, &in_path, who, node.is_some())?;
        // The site has nothing for the value the page was asked: the walk's answer lists nothing, judged by the walk's
        // own page. A walk that saw no record teaches no route.
        let nothing = walks.0.locked().get(&view.walk).and_then(|w| the_walk_found_nothing(&w.trace, index, &route, url, &query_values));
        if let Some(why) = nothing {
            eprintln!("   [learn] {why}");
            let _ = store::delete_route(&route.id);
            return Err(Unlearned::Nothing(why));
        }
        // The pick is a proposal read from one walk; the site says whether it hears the caller (`hears`). A call that
        // answers the same for a word nobody searches for gives way to the next, twice at most, and when none hears, the
        // first stands marked deaf: it answers this page, and an ask for another value walks that page.
        match &settled {
            Some((_, names)) => {
                route.heard.probed = true;
                route.heard.deaf.clone_from(names);
                let _ = store::save_route(&route);
            }
            None if stands_deaf => {
                eprintln!("   [second walk] no call on the page hears the caller: {} {} stands for this page alone", route.method, route.site);
                route.heard.probed = true;
                route.heard.deaf.clone_from(&deaf_names);
                let _ = store::save_route(&route);
            }
            // The page was asked a word and the route has no slot for it (the word reached its call as something
            // the page worked out: a place's id, a category): it answers this word and can be asked no other. It
            // gives way to the next call, as one the site showed deaf does, and stands only when none takes the word.
            None if unheard.len() < 2 && words_asked(&route, &query_values).is_empty() && !words_of(&query_values).is_empty() && !route.write && route.socket.is_none() => {
                let words = words_of(&query_values);
                eprintln!("   [hears] {} {}{}: no input of it takes {}, so it can be asked no other", route.method, route.site, route.path.chars().take(60).collect::<String>(), words.join(", "));
                let _ = store::drop_learned(&route.id);
                unheard.push((index, words));
                continue;
            }
            // A route that answers a real second word hears its caller: the site is not asked again with a word
            // nobody searches for. Every plain call at learn time is one more ask of a site that counts them.
            None if {
                let (tried, answered) = trial::with_another_word(walks, route, url, goal, who, &in_path, second.as_ref(), picked_the_page, by == "two walks of the page");
                route = tried;
                answered
            } => {
                // It hears its caller. How it writes a value of two words in its address is still to learn.
                let walked = walked_text(walks, &view.walk, &view.site);
                let written = spaced_as_the_site_writes(route.clone(), &walked);
                if written.graph.steps.last().map(|s| &s.held) != route.graph.steps.last().map(|s| &s.held) {
                    route = written;
                    let _ = store::save_route(&route);
                }
                let had = (route.paging.clone(), route.inputs.len());
                route = read_on_by_trial_for(the_calls_address(route), second.as_ref().map(|s| s.word.as_str()), !experiment);
                if (route.paging.clone(), route.inputs.len()) != had {
                    let _ = store::save_route(&route);
                }
            }
            None => match hears(&route, &query_values) {
                Hears::Deaf(names) => {
                    eprintln!("   [hears] {} {}{}: the same answer for a word nobody searches for, so it does not hear {}", route.method, route.site, route.path.chars().take(60).collect::<String>(), names.join(", "));
                    if unheard.len() < 2 {
                        let _ = store::drop_learned(&route.id);
                        unheard.push((index, names));
                        continue;
                    }
                    route.heard.probed = true;
                    route.heard.deaf = names;
                    let _ = store::save_route(&route);
                }
                Hears::Yes => {
                    let walked = walked_text(walks, &view.walk, &view.site);
                    route = read_on_by_trial_for(spaced_as_the_site_writes(held_where_the_site_hears(the_calls_address(route)), &walked), second.as_ref().map(|s| s.word.as_str()), !experiment);
                    route.heard.probed = true;
                    route.heard.deaf.clear();
                    let _ = store::save_route(&route);
                }
                Hears::Unasked(why) => eprintln!("   [hears] not asked: {why}"),
            },
        }
        if !in_path.is_empty() {
            eprintln!("learn: {} from the path, by {inputs_by}", in_path.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", "));
        }
        eye(Eye::Saved {
            walk: id.to_string(),
            route: route.id.clone(),
            what: route.what.clone(),
            site: route.site.clone(),
            steps: route.steps,
            inputs: route.inputs.iter().map(|i| i.name.clone()).collect(),
        });
        if !picked_the_page && !route.write && route.graph.steps.len() > 1 && goal::only_reads(goal) && !query_values.is_empty() {
            let opening = walks.0.locked().get(&view.walk).and_then(|w| {
                let i = document_answer(&w.trace, &view.site)?;
                let page = &w.trace.exchanges[i];
                let asked = url::Url::parse(url).ok()?;
                let requested = unbrowse_learn::trace::asked_pairs(&asked);
                // The settled page can add its own parameters. Every input the caller gave must still be there,
                // without an extra occurrence of a name the caller supplied.
                let kept_the_ask = unbrowse_learn::trace::asked_pairs(&page.url).into_iter()
                    .filter(|(name, _)| requested.iter().any(|(key, _)| key == name))
                    .eq(requested.iter().cloned());
                let same_page = page.url.origin() == asked.origin()
                    && page.url.path().trim_end_matches('/') == asked.path().trim_end_matches('/')
                    && kept_the_ask;
                (i < index && same_page && !is_rejected(&rejected, page) && lists_the_ask(page, goal, &query_values)).then_some(i)
            });
            if let Some(opening) = opening {
                match keep_as(walks, &view.walk, opening, goal, &in_path, who, false) {
                    Ok(page) => {
                        eprintln!("   [route] opening document {} kept beside {} for its own results", page.id, route.id);
                        walks.remember_companion(id, &route.id, page.id);
                    }
                    Err(why) => eprintln!("   [route] opening document could not be kept beside {}: {why}", route.id),
                }
            }
        }
        break (route, by);
    };
    try_the_page_later(&route, "learn::pick_and_keep");
    Ok((route, by))
}

/// Why the walk's answer to its call `index`, kept as `route`, lists nothing for the values the page `url` was asked
/// (`asked`): read as the route reads it, by the one reader of an empty answer, with what the walk holds to judge it by
/// alone (`answer::Walked`: what the request sent, what the page showed, the page's own document). None where the
/// page was asked no value: an answer for nothing in particular is not judged empty here.
pub(crate) fn the_walk_found_nothing(trace: &Trace, index: usize, route: &Route, url: &str, asked: &[String]) -> Option<String> {
    if asked.is_empty() {
        return None;
    }
    let e = trace.exchanges.get(index)?;
    if saw_records_for(trace, asked) {
        return None;
    }
    let read = confirm::as_the_route_reads(route, e, asked)?;
    let shown = page_shown(&trace.exchanges, url, &[]);
    let values: Vec<&str> = asked.iter().map(String::as_str).collect();
    let walked = unbrowse_learn::answer::Walked::of(e, Some(&shown));
    unbrowse_learn::answer::lists_nothing_walked(&read, &values, None, Some(&walked)).then(|| {
        format!("the site answered the page's ask for {} and lists nothing for it: a walk that saw no record teaches no route", values.iter().map(|v| format!("\"{v}\"")).collect::<Vec<_>>().join(", "))
    })
}

/// Whether the walk saw records for a value it was asked (`asked`): one of its calls sends the value (a piece of its
/// address, a key of its query, its body) and answered, 2xx, with a list of records (two objects or more). Such a walk
/// did not find nothing, whichever of its calls was picked: a page that draws its charts from calls carrying its own
/// address's word reads as its headings alone, and the calls hold the records.
fn saw_records_for(trace: &Trace, asked: &[String]) -> bool {
    fn lists_records(v: &serde_json::Value, depth: usize) -> bool {
        match v {
            _ if depth > 32 => false,
            serde_json::Value::Array(items) => items.iter().filter(|x| x.is_object()).count() >= 2 || items.iter().any(|x| lists_records(x, depth + 1)),
            serde_json::Value::Object(o) => o.values().any(|x| lists_records(x, depth + 1)),
            _ => false,
        }
    }
    let asked: Vec<String> = asked.iter().map(|a| a.trim().to_lowercase()).filter(|a| a.chars().count() >= 3).collect();
    trace.exchanges.iter().any(|e| {
        (200..300).contains(&e.status)
            && unbrowse_learn::slots::slots(e).iter().any(|s| asked.iter().any(|a| s.value.trim().eq_ignore_ascii_case(a)))
            && e.own_json().is_some_and(|v| lists_records(&v, 0))
    })
}

/// Whether loading a page can do `goal`. A walk only loads the page, and loading changes nothing, so a goal that opens
/// by asking for a change (`goal::opens_with_a_change`: submit the order, register, log in) is done by a step taken on
/// the page, never by a call it sent by itself: its form page, or a call it fetched as it loaded, is no answer, and
/// keeping one would answer the change with a read from then on.
fn by_loading(goal: &str) -> Result<(), String> {
    match unbrowse_learn::goal::opens_with_a_change(goal) {
        true => Err(NEEDS_HANDS.into()),
        false => Ok(()),
    }
}

/// Why a walk kept no route: the page has to be driven.
const NEEDS_HANDS: &str = "loading the page sends no call that answers the goal: it needs clicks or typing";

/// How many tries of a route's page may fail before the node stops: each runs a browser, and a site that refuses an empty
/// profile would refuse it every time.
const PAGE_TRIES: u8 = 3;

/// How long after a try that read nothing the next may run, however often the route is called.
const PAGE_TRY_GAP: u64 = 6 * 3600;

/// Whether `route`'s page may be tried at `now`.
fn page_try_due(route: &Route, now: u64) -> bool {
    !route.write && !route.tried_page && route.socket.is_none() && route.fetched.is_none() && route.page_tries.failed < PAGE_TRIES && now >= route.page_tries.at.saturating_add(PAGE_TRY_GAP)
}

/// What a try of the page leaves on the route, which reads it (`trace`) or doesn't. What didn't read the page says nothing
/// of what it offers, so the route stays to be tried again, until `PAGE_TRIES` have failed.
fn page_tried(route: &mut Route, trace: Option<&Trace>, now: u64) {
    match trace {
        Some(t) => {
            route.tried_page = true;
            what_the_page_took(route, t);
        }
        None => {
            route.page_tries.failed = route.page_tries.failed.saturating_add(1);
            route.page_tries.at = now;
            route.tried_page = route.page_tries.failed >= PAGE_TRIES;
        }
    }
}

/// Tries the route's page in the background, so the reply isn't held for it: the next call has what it found. `at` is
/// the function that asked for the try, as a held try says it.
fn try_the_page_later(route: &Route, at: &str) {
    if !cfg!(test) && page_try_starts(route, store::now(), at) {
        let id = route.id.clone();
        // Work of the ask that learned or called the route, behind its reply, and ending on its stop flag.
        crate::api::asks::spawn_behind("page_try", move || try_the_page(&id));
    }
}

/// Whether a try of `route`'s page starts now: it is due (`page_try_due`), and tries are not held
/// (`UNBROWSE_NO_TRY`). Only a try that was due is said as held.
fn page_try_starts(route: &Route, now: u64, at: &str) -> bool {
    page_try_due(route, now) && !own_asks::held_at(own_asks::Ask::Try, at)
}

/// A call of `route` passed: a route in use whose page a try didn't read is worth trying again, within the same bounds. A
/// route no try has come up for yet (one from before tries) isn't: nothing failed, and a passed call is no reason to
/// start browsers for every old route at once.
pub(crate) fn try_the_page_again(route: &Route) {
    if route.page_tries.at > 0 {
        try_the_page_later(route, "run::call (learn::try_the_page_again)");
    }
}

/// Finds what the route's page offers by trying it: its filters and sort, one at a time, and its next page. A click on a
/// page can change what an account holds, so this runs in a new, empty profile, thrown away after: nothing in it is signed
/// in, whatever the page does. A site that won't answer an empty profile simply shows nothing here.
fn try_the_page(id: &str) {
    // Trying a page launches a browser, which a public peer never does (UNB-234).
    if crate::remote::public_home() {
        return;
    }
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let Ok(_one) = ONE_AT_A_TIME.try_lock() else {
        // Another route's try has the one place: this one's comes up again on a call that passes.
        let _ = store::update_route(id, |r| r.page_tries.at = store::now());
        return;
    };
    let settings = store::load_settings();
    let Some(route) = store::load_route(id).filter(|r| !settings.paused && store::excluded_host(r, &settings.excluded).is_none()) else { return };
    let Some(host) = url::Url::parse(&route.root).ok().and_then(|u| u.host_str().map(String::from)) else { return };
    crate::browsers::apply();
    // The throwaway profile and the walk's log, where only the owner can write.
    let Ok(scratch) = unbrowse_files::private::scratch() else { return };
    let dir = scratch.join("tries").join(id);
    let _ = std::fs::remove_dir_all(&dir);
    let session = format!("try_{id}");
    let mut mint = BrowserMint {
        try_controls: true,
        browser: crate::browse::step_program().unwrap_or_else(|| "in-process".into()),
        session: session.clone(),
        capture_dir: dir.clone(),
        profile: Some(dir.join("profile").to_string_lossy().into_owned()),
        _host: host,
        user_agent: None,
        cdp_endpoint: None,
        frames: None,
        seed: Vec::new(),
    };
    let walked = url::Url::parse(&route.root).ok().map(|u| mint.mint(&u));
    let trace = walked.filter(Result::is_ok).and_then(|_| trace_from_walk(&dir, &session));
    let _ = std::fs::remove_dir_all(&dir);
    let found = store::update_route(id, |r| page_tried(r, trace.as_ref(), store::now()));
    if let (Ok(Some(r)), true) = (found, trace.is_some()) {
        eprintln!("   [try] {}: takes {}", r.what, r.inputs.iter().filter(|i| i.optional).map(|i| i.name.as_str()).collect::<Vec<_>>().join(", "));
    }
}

/// Takes in what the page's own calls did when its controls were tried (`trace`): the values the route's target sent
/// differently, read as any repeats are (`paging::read`). A value the route holds another way (one from an earlier
/// answer, the session's) stays what it is, and nothing is taken from a call the route doesn't make.
fn what_the_page_took(route: &mut Route, trace: &Trace) {
    use unbrowse_learn::{controls::Choice, paging::Reading, Class};
    let Some(step) = route.graph.steps.last_mut() else { return };
    let Ok(at) = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")) else { return };
    // A repeat is the route's own call made again: at its address, sending every key its query sends, and the same
    // name wherever its body names the operation (a GraphQL `operationName`), as `same_operation` reads two calls. The
    // page at that address (`/tag/airpods/?q=` beside its `?ajax=true&q=` data call) is another call, and read as the
    // first of them it would turn the data call's own keys into options nobody sends.
    let sends_its_keys = |e: &Exchange| at.query_pairs().all(|(k, _)| e.url.query_pairs().any(|(q, _)| q == k));
    let a_name = |v: &str| v.chars().any(char::is_alphabetic) && !v.chars().any(|c| c.is_ascii_digit());
    let same_operation = |e: &Exchange| {
        let body: Option<serde_json::Value> = e.request_body.as_deref().and_then(|b| serde_json::from_str(b).ok());
        step.fields.iter().all(|f| match (&f.loc, &f.class) {
            (unbrowse_learn::Loc::Json(p), Class::Constant { value, .. } | Class::Unconfirmed { value }) if a_name(value) => {
                body.as_ref().and_then(|b| b.pointer(p)).and_then(|v| v.as_str()).is_none_or(|v| v == value)
            }
            _ => true,
        })
    };
    // Its address with each piece the route fills (`{path[1]}`, the search) taking whatever the page sent there.
    let pieces = |u: &url::Url| -> Vec<String> { u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default() };
    let want = pieces(&at);
    let at_its_address = |e: &Exchange| {
        let got = pieces(&e.url);
        e.url.host_str() == at.host_str() && got.len() == want.len() && want.iter().zip(&got).all(|(w, g)| (w.starts_with('{') && w.ends_with('}')) || w == g)
    };
    // And it answers with the kind of thing the route's call answered with (`answers_alike`): another operation at
    // the same address (a ticker beside a search, each named in one query key) is no repeat, and read as one it made
    // the operation's name a choice the caller may set, and the route answer the ticker.
    let answered = step.response_shape.as_ref().and_then(keys_of_an_answer);
    let answers_as_it_did = |e: &Exchange| match (&answered, e.own_json().as_ref().and_then(keys_of_an_answer)) {
        (Some(was), Some(now)) => *was == now,
        _ => true,
    };
    let repeats: Vec<&Exchange> = trace
        .exchanges
        .iter()
        .filter(|e| e.method == step.method && at_its_address(e))
        .filter(|e| (200..300).contains(&e.status) && sends_its_keys(e) && same_operation(e) && answers_as_it_did(e))
        .collect();
    let Some((first, rest)) = repeats.split_first() else { return };
    let asked: Vec<&str> = route.inputs.iter().filter(|i| !i.optional).filter_map(|i| i.default.as_deref()).filter(|v| !unbrowse_learn::slots::bound_by_key(v)).collect();
    let taken = |r: &Reading, loc: &unbrowse_learn::Loc, name: &str| {
        let open = step.fields.iter().find(|f| f.loc == *loc).is_none_or(|f| matches!(f.class, Class::Constant { .. } | Class::Unconfirmed { .. } | Class::Input { optional: true, .. }));
        let free = !route.inputs.iter().any(|i| i.name == name && !i.optional);
        (open && free).then(|| r.clone())
    };
    let readings: Vec<Reading> = unbrowse_learn::paging::read(first, rest, &asked)
        .iter()
        .filter_map(|r| match r {
            Reading::Paging { loc, paging, .. } => taken(r, loc, paging.input()),
            Reading::Choice { loc, name, .. } => taken(r, loc, name),
            Reading::Pinned { .. } => None,
        })
        .collect();
    readings.iter().for_each(|r| unbrowse_learn::paging::apply(step, r));
    let kept = std::mem::take(&mut route.inputs);
    let Some(fresh) = Route::from_graph(route.id.clone(), route.what.clone(), route.root.clone(), route.graph.clone()) else {
        route.inputs = kept;
        return;
    };
    route.inputs = fresh.inputs;
    route.offer_the_bodys_slots();
    for i in &mut route.inputs {
        let had = kept.iter().find(|k| k.name == i.name);
        i.options = had.map(|k| k.options.clone()).unwrap_or_default();
        i.default = i.default.take().or(had.and_then(|k| k.default.clone()));
    }
    for r in readings {
        match r {
            Reading::Paging { paging, .. } => route.paging = route.paging.take().or(Some(paging)),
            Reading::Choice { name, values, .. } => {
                if let Some(i) = route.inputs.iter_mut().find(|i| i.name == name) {
                    for value in values {
                        if !i.options.iter().any(|c| c.value == value) {
                            i.options.push(Choice { value, label: None });
                        }
                    }
                }
            }
            Reading::Pinned { .. } => {}
        }
    }
}

/// Reads what the site's browsing shows it needs done (`setups::note`), apart from any learning.
pub fn note_setups(site: &str) {
    let site = site_of(site);
    let _ = from_log(&site, Marks::read(&site).at, |session| {
        crate::setups::note(&site, &session);
        Ok(())
    });
    give_back_freed();
}

/// Learns as the agent browses, with nobody asking: run after every command in the node's browser. A call that
/// sent what was typed is learned as soon as it lands. When the agent leaves a page (`until`: the moment it opened
/// the next one, or closed the browser), the flow ends: a page that was only read is learned from the call that
/// answered with the page's own inputs, or that answers the goal the agent gave for it, and typing that left by no recorded call is noted. What the node already
/// knows isn't learned twice. The final read waits its turn before the browser can leave the flow. With the route
/// comes the time the call it was learned from went out, so the node can tell whose step set it off.
pub fn learn_auto(site: &str, session: &str, until: Option<f64>, who: &str, eye: Sink) -> Option<(Route, f64)> {
    learn_with(site, session, until, who, eye, false)
}

/// Learns what the command just done sent, for the command's own reply: it waits its turn behind a learn already
/// running (a few seconds at most) instead of leaving it to the next one.
pub fn learn_now(site: &str, session: &str, who: &str, eye: Sink) -> Option<(Route, f64)> {
    learn_with(site, session, None, who, eye, true)
}

static BROWSE_LEARN: Mutex<()> = Mutex::new(());

fn learn_with(site: &str, browsing: &str, until: Option<f64>, who: &str, eye: Sink, patient: bool) -> Option<(Route, f64)> {
    let since = std::time::Instant::now();
    let mut waiting_to_leave = false;
    let _one = loop {
        if unbrowse_learn::mint::asked_to_stop() {
            return None;
        }
        match BROWSE_LEARN.try_lock() {
            Ok(one) => break one,
            // A learn that failed partway holds nothing the next one needs: the lock only keeps them one at a time.
            Err(std::sync::TryLockError::Poisoned(p)) => break p.into_inner(),
            Err(_) if until.is_some() => {
                // Leaving advances the capture mark. A cancelled command stops waiting before it can leave.
                if !waiting_to_leave {
                    eprintln!("   [learn] {site}: waiting for the running learn before leaving the page");
                    waiting_to_leave = true;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) if patient && since.elapsed() < std::time::Duration::from_secs(5) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => {
                eprintln!("   [learn] {site}: another learn is running; this one is skipped");
                return None;
            }
        }
    };
    // Goals are kept under the site as the browsing named it.
    let goal = crate::browse::goal_of(site, browsing);
    let site = site_of(site);
    let marks = Marks::read(&site);
    let flow = marks.flow.max(flow_of(&site, browsing));
    let id = walk_id(&site);
    // The page the browsing is on, when the part of the log read starts after it was opened: kept beside the log.
    let known_page = std::fs::read_to_string(crate::browse::page_file(&site)).ok().filter(|p| !p.trim().is_empty());
    let decisions = Mutex::new(Vec::new());
    let outcome = from_log(&site, marks.at, |session| {
        crate::setups::note(&site, &session);
        // Only this session's steps are its flow: the same browser may be serving another's (`browse::acting_at`).
        // Moved out of the session read, not copied: a page's flow can be hundreds of MB of answers.
        let own = session.into_only(|t| crate::browse::acting_at(&site, t).is_none_or(|w| w == browsing));
        let mut own = own;
        learn_from_flow(&mut own, &site, goal.as_deref(), flow, marks.sent, until.unwrap_or(f64::INFINITY), &id, &|event| decisions.locked().push(event), known_page.as_deref())
    });
    eprintln!("   [learn] {site} until={until:?}: {}", match &outcome { Ok(Outcome::Route { by, .. }) => format!("route by {by}"), Ok(Outcome::Unsent(w)) => format!("unsent: {w}"), Ok(Outcome::Nothing(w)) => format!("nothing: {w}"), Err(e) => format!("err: {e}") });
    let learned = match outcome {
        Ok(Outcome::Route { route, .. }) if goal.as_deref().is_some_and(unbrowse_learn::goal::opens_with_a_read) && route.write => {
            let last = route.graph.steps.last();
            eprintln!("   [learn] {site}: the call found ({} {}{}) may change something and the goal only reads, so it is not kept (sent on load: {}, sets a cookie: {})", route.method, route.site, route.path.chars().take(60).collect::<String>(), last.is_some_and(|s| s.on_load), last.is_some_and(|s| s.sets_cookie));
            None
        }
        // A page only read is kept when what answered it is plain: the call that carries the page's own inputs, or
        // the one the agent's stated goal for the page picks.
        Ok(Outcome::Route { route, by, at, carries_page, notes, secrets }) if by == "what was typed" || (until.is_some() && (carries_page || goal.is_some())) => {
            // A value the walk shows the site only checks leaves the record, now that it is known to be one.
            for value in &secrets {
                if let Err(why) = crate::browse::forget(&site, value) {
                    eprintln!("   [learn] {site}: a value the site only checks may still be in its walk record: {why}");
                }
            }
            let kept = match known(&route) {
                Some(old) => {
                    refresh_jar(&old.site, &site);
                    store::log_activity(&Activity {
                        at: store::now(),
                        who: who.to_string(),
                        site: old.site.clone(),
                        what: format!("Already knows {}", old.what),
                        kind: "learn".into(),
                        result: "skipped".into(),
                        ms: None,
                        unb: None,
                        tx: None,
                        note: None,
                    });
                    Some(old)
                }
                None => {
                    let origin = url::Url::parse(&route.root).map(|page| page.origin().ascii_serialization()).unwrap_or_else(|_| format!("https://{site}/"));
                    eye(Eye::Started { walk: id.clone(), url: origin, goal: goal.clone().unwrap_or_else(|| route.what.clone()), agent: who.to_string() });
                    for event in decisions.into_inner().unwrap_or_else(|err| err.into_inner()) {
                        eye(event);
                    }
                    // A route the browsing found and the node could not keep is said, never dropped in silence: the
                    // agent was told its steps become a route.
                    let kept = keep_browsed(route, &site, who, &id, eye).map_err(|why| eprintln!("   [learn] {site}: the route the browsing found was not kept: {why}")).ok();
                    // What the browser saw leave by no call it could record is the owner's to know: the route
                    // may not carry all of it.
                    if let (Some(r), false) = (&kept, notes.is_empty()) {
                        store::log_activity(&Activity {
                            at: store::now(),
                            who: who.to_string(),
                            site: r.site.clone(),
                            what: format!("Learned {}, with something it can't send", r.what),
                            kind: "learn".into(),
                            result: "done".into(),
                            ms: None,
                            unb: None,
                            tx: None,
                            note: Some(notes.join(" ")),
                        });
                    }
                    kept
                }
            };
            if by == "what was typed" {
                Marks { sent: at, ..marks }.write(&site);
            }
            kept.map(|r| (r, at))
        }
        Ok(Outcome::Unsent(why)) if until.is_some() => {
            store::log_activity(&Activity {
                at: store::now(),
                who: who.to_string(),
                site: site.clone(),
                what: "Nothing to learn from that page".into(),
                kind: "learn".into(),
                result: "skipped".into(),
                ms: None,
                unb: None,
                tx: None,
                note: Some(why),
            });
            None
        }
        Ok(Outcome::Nothing(_)) if until.is_some() => {
            if let Some(goal) = goal {
                let origin = known_page.as_deref().and_then(|page| url::Url::parse(page.trim()).ok())
                    .map(|page| page.origin().ascii_serialization()).unwrap_or_else(|| format!("https://{site}/"));
                eye(Eye::Started { walk: id.clone(), url: origin, goal, agent: who.to_string() });
                let failure = decisions.into_inner().unwrap_or_else(|err| err.into_inner())
                    .into_iter().find(|event| matches!(event, Eye::Failed { .. }));
                eye(failure.unwrap_or_else(|| Eye::Failed { walk: id, error: "the recorded browser flow ended without an answering route".into() }));
            }
            None
        }
        _ => None,
    };
    give_back_freed();
    learned
}

/// Hands what a learn freed back to the system. glibc keeps freed memory in the arena of the thread that freed it, and
/// learns run on the blocking pool's threads, each with an arena of its own: without this a node held the largest learn
/// each of those threads ever ran, all at once, and grew with every page it browsed long enough (UNB-208: a staging
/// node went from 57 MB to 3.6 GB in 13 minutes of the bank).
fn give_back_freed() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    // SAFETY: malloc_trim only returns free pages of the allocator's own arenas to the system; it touches no live allocation.
    unsafe {
        libc::malloc_trim(0);
    }
}

/// Where each browsing session's flow on a site starts, when that is later than the site's: (site, session, time).
/// Memory only: a restart falls back on the site's mark, and what is read twice is known already (`known`).
static FLOWS: Mutex<Vec<(String, String, f64)>> = Mutex::new(Vec::new());
const FLOWS_KEPT: usize = 512;

/// Where `session`'s own flow on `site` starts; 0 when nothing but the site's mark says.
fn flow_of(site: &str, session: &str) -> f64 {
    FLOWS.locked().iter().find(|(s, w, _)| s == site && w == session).map_or(0.0, |(.., t)| *t)
}

/// A step that would end a flow, as it was when the step started: the flow ends only once the step has left the page.
pub struct Leaving {
    site: String,
    session: String,
    end: Marks,
    /// The page the session's tab was on.
    page: Option<String>,
}

/// Notes that `session` is about to leave what it browsed on `site`, at `end`. The place in the log is taken here, before
/// the step can add to it: a request of the old page may land after the step, and is read again from a little before.
pub fn leaving(site: &str, session: &str, end: f64) -> Leaving {
    let site = site_of(site);
    let page = crate::browse::page_url(&site, Some(&crate::browse::tab_of(session)));
    Leaving { end: Marks::ended(&site, end), site, session: session.to_string(), page }
}

impl Leaving {
    /// The step is over. It left the page when it says so, or when its tab is elsewhere whatever it said: a command that
    /// timed out may have done its work. Return whether the command completed or the tab reached a different page.
    pub fn over(self, done: bool, learning: bool) -> bool {
        let now = crate::browse::page_url(&self.site, Some(&crate::browse::tab_of(&self.session)));
        self.over_at(done, learning, now.as_deref())
    }

    fn over_at(self, done: bool, learning: bool, now: Option<&str>) -> bool {
        let left = left_the_page(done, self.page.as_deref(), now);
        if learning && left {
            self.ended();
        }
        done || (left && now.is_some())
    }

    /// Ends the session's flow. Another session's goes on: the site's mark moves only when nobody else acted since it
    /// was set, or their flow would lose its start.
    fn ended(self) {
        let mut flows = FLOWS.locked();
        flows.retain(|(s, w, _)| !(*s == self.site && *w == self.session));
        flows.push((self.site.clone(), self.session.clone(), self.end.flow));
        let n = flows.len();
        if n > FLOWS_KEPT {
            flows.drain(..n - FLOWS_KEPT);
        }
        drop(flows);
        if !crate::browse::others_acted(&self.site, &self.session, Marks::read(&self.site).flow) {
            self.end.write(&self.site);
        }
    }
}

/// Whether a step left the page: it says it did, or the tab isn't on the page it was.
fn left_the_page(done: bool, before: Option<&str>, after: Option<&str>) -> bool {
    done || before != after
}

/// Where a site's browsing stands for the learner, kept beside its log: the flow starts after `flow`, and a call
/// that sent what was typed counts only after `sent` (the last one learned). `at` is how long the log was when the
/// flow mark was set: nothing much before it is read again.
struct Marks {
    flow: f64,
    sent: f64,
    at: u64,
}

impl Marks {
    fn path(site: &str) -> std::path::PathBuf {
        crate::browse::capture_dir().join(format!("{}.flow", crate::browse::session_of(site)))
    }

    fn read(site: &str) -> Self {
        let text = std::fs::read_to_string(Self::path(site)).unwrap_or_default();
        let mut n = text.split_whitespace().filter_map(|w| w.parse::<f64>().ok());
        let flow = n.next().unwrap_or(0.0);
        let sent = n.next().unwrap_or(flow);
        Marks { flow, sent, at: n.next().map(|a| a as u64).unwrap_or(0) }
    }

    /// Keeps these marks, moved on from what is on disk and never back: a learn reads the marks, works for a while, and
    /// writes them, and in between the owner may have taken the page (`end_flow`). Written back as read, that cut would be
    /// undone and the owner's typing read into the next route. Written whole, since a learn reading half of it starts over.
    fn write(&self, site: &str) {
        let was = Self::read(site);
        let path = Self::path(site);
        let part = path.with_extension("flow.part");
        // `at` is a place in the log, which a secret taken out of it can shorten: it goes with the flow it marks.
        let at = if self.flow < was.flow { was.at } else { self.at };
        let text = format!("{} {} {at}", self.flow.max(was.flow), self.sent.max(was.sent));
        if std::fs::write(&part, text).is_ok() {
            let _ = std::fs::rename(&part, &path);
        }
    }

    /// The flow ends at `end`: the next one starts there, and its reading starts where the log is now.
    fn ended(site: &str, end: f64) -> Self {
        Marks { flow: end, sent: end, at: std::fs::metadata(log_of(site)).map(|m| m.len()).unwrap_or(0) }
    }
}

/// Ends `site`'s flow now: the learner's next flow starts here, and nothing before it is read with what comes after.
/// For a stretch of browsing that is the owner's alone (`hands`), never a route's.
pub fn end_flow(site: &str) {
    let site = site_of(site);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    Marks::ended(&site, now).write(&site);
}

fn log_of(site: &str) -> std::path::PathBuf {
    crate::browse::capture_dir().join(format!("{}.jsonl", crate::browse::session_of(site)))
}

/// How far before a flow mark's place in the log reading starts again: lines land when their request settles, so a
/// request that started just before the mark may sit a little earlier in the file than the mark's place.
const REREAD: u64 = 4 << 20;

/// Learns from the site's browsing read from the mark's place in the log, and from further back when what the flow
/// needs began earlier: a socket opened on a page long before the frame sent over it.
fn from_log<T>(site: &str, at: u64, learn: impl Fn(unbrowse_learn::session::Session) -> Result<T, Unread>) -> Result<T, String> {
    read_back(at, |(start, sockets)| learn(browsed_from(site, start, sockets)?))
}

/// `read` from `at` less each of the distances back, until it stops needing more of the log. Each read is (where the log
/// is read from, where its sockets are read from): the last goes back to the log's start for a socket's opening alone,
/// since the requests before the furthest window are never what a frame needs, and a log can be gigabytes.
fn read_back<T>(at: u64, read: impl Fn((u64, u64)) -> Result<T, Unread>) -> Result<T, String> {
    let mut tried = None;
    let far = at.saturating_sub(64 << 20);
    for reach in [(at.saturating_sub(REREAD), at.saturating_sub(REREAD)), (far, far), (far, 0)] {
        if tried == Some(reach) {
            break;
        }
        tried = Some(reach);
        match read(reach) {
            Err(Unread::Earlier) => continue,
            Err(Unread::Failed(e)) => return Err(e),
            Ok(r) => return Ok(r),
        }
    }
    Err("the socket opened before the browsing read; open the page again".into())
}

/// Why browsing read from the log taught nothing.
#[derive(Debug)]
enum Unread {
    /// What the flow needs began before the part of the log read: the socket's opening, for a frame sent over it.
    Earlier,
    Failed(String),
}

impl std::fmt::Display for Unread {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Unread::Earlier => "the socket opened before the browsing read",
            Unread::Failed(why) => why,
        })
    }
}

impl From<String> for Unread {
    fn from(why: String) -> Self {
        Unread::Failed(why)
    }
}

impl From<&str> for Unread {
    fn from(why: &str) -> Self {
        Unread::Failed(why.to_string())
    }
}

/// The site's browsing from `start` bytes into its log, as a session, with the page's socket events from `sockets` on
/// (no later than `start`). The flow is picked from it by time.
fn browsed_from(site: &str, start: u64, sockets: u64) -> Result<unbrowse_learn::session::Session, String> {
    use std::io::BufRead;
    let mut f = std::fs::File::open(log_of(site)).map_err(|_| format!("the node hasn't browsed {site}; browse it with unbrowse_browse first"))?;
    let mut at = sockets.min(start);
    f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
    // A line at a time: what is held is the session made of them, never the stretch of log read as well (UNB-208).
    let mut f = std::io::BufReader::new(f);
    let mut failed = None;
    let lines = std::iter::from_fn(|| loop {
        let mut line = Vec::new();
        let began = at;
        match f.read_until(b'\n', &mut line) {
            Ok(0) => return None,
            Ok(n) => {
                at += n as u64;
                let text = String::from_utf8(line).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
                let text = text.trim_end_matches(['\n', '\r']);
                // Before `start`, only what a page's socket did: a frame's socket may have opened long before.
                if began < start && serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| t == "socket")) != Some(true) {
                    continue;
                }
                return Some(text.to_string());
            }
            Err(e) => {
                failed = Some(e.to_string());
                return None;
            }
        }
    });
    // A read that starts mid-line drops that piece: it isn't JSON, and `browsed_lines` skips it.
    let session = browsed_lines(lines);
    if let Some(why) = failed {
        return Err(why);
    }
    let mut session = session?;
    // What the agent read off the pages, as actions of its own: the browser records what was done, the node what
    // was read.
    for (t, text) in crate::browse::reads(site) {
        session.actions.push(unbrowse_learn::Action { t, kind: "read".into(), selector: None, field: None, locator: None, value: Some(text), secret: false , submit: false});
    }
    session.actions.sort_by(|a, b| a.t.total_cmp(&b.t));
    Ok(session)
}

/// A route the node already has: the same call on the same site, by its method and path, taking the same inputs.
/// The same call asked with other values (a sort order, a filter) is another route.
fn known(route: &Route) -> Option<Route> {
    // Two routes are the same call when their paths are the same *shape*: a segment one takes from the caller (`{q}`,
    // `{path[1]}`) matches whatever value this page put there. Comparing the text alone made every value a new route:
    // foodnetwork's `/search/chicken-` re-learned a route it already had (`/search/{path[1]}`), with the browser.
    let shape = |p: &str| p.split('?').next().unwrap_or_default().split('/').map(|s| {
        let hole = s.starts_with('{') && s.ends_with('}');
        if hole { "{}" } else { s }.to_string()
    }).collect::<Vec<_>>();
    let names = |r: &Route| r.inputs.iter().map(|i| i.name.clone()).collect::<std::collections::BTreeSet<_>>();
    store::load_routes()
        .into_iter()
        .find(|r| r.site == route.site && r.method == route.method && shape(&r.path) == shape(&route.path) && names(r) == names(route))
}

/// The host's jar takes the cookies the node's browser would send it now: the session a route browsed again runs
/// with from then on.
pub(crate) fn refresh_jar(host: &str, site: &str) {
    let excluded = store::load_settings().excluded;
    if excluded.iter().any(|e| unbrowse_learn::identity::at_or_under(host, e)) {
        return;
    }
    let jar_path = store::jar_path(host);
    let old: std::collections::BTreeMap<String, String> = store::read_json(&jar_path, &unbrowse_files::JAR);
    let stays = walk_cant_see(host, &old);
    let answer = crate::browse::cookies_answer(site);
    // One cookie per name, each with its own line's reach and facts (`mint::browser_lines`).
    let held = unbrowse_learn::mint::held_for(&answer, host);
    let before: HashMap<String, String> = old.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    // A browser that answered is the judge of what the jar holds, even when it holds nothing for the host: a session the
    // site ended there leaves the jar too. No browser asked changes nothing.
    let answered = unbrowse_learn::mint::browser_answered(&answer);
    let jar = if held.is_empty() && answered { old.into_iter().filter(|(k, _)| stays.contains(k)).collect() } else { unbrowse_learn::mint::jar_with(old, &held, host, &stays) };
    if !jar.is_empty() || answered {
        let _ = store::write_json(&jar_path, &unbrowse_files::JAR, &jar);
        unbrowse_learn::client::note_cookie_facts(&store::jars_dir(), host, &unbrowse_learn::mint::facts_of(&answer, host), &before);
        // The browser is the truth for cookies, and for how far each goes: the reach of a cookie it holds set for
        // the site's domain is rewritten beside the jar with it, so a call sends each cookie where this browser
        // would — down the site, while a cookie set for the one host stays the jar's word alone. A browser holding
        // nothing changes neither, as `jar_with` has it.
        if !held.is_empty() || answered {
            let scope = unbrowse_learn::mint::scopes_of(&answer, host);
            let _ = store::write_json(&store::jar_scope_path(host), &unbrowse_files::JAR, &scope);
        }
    }
}

/// The names in `host`'s jar that are values its routes send in a header (a bearer token, an API key), not cookies.
fn header_tokens(host: &str) -> std::collections::HashSet<String> {
    store::load_routes()
        .into_iter()
        .filter(|r| r.site == host)
        .flat_map(|r| r.graph.steps.into_iter().flat_map(|s| s.fields))
        .filter_map(|f| match f.class {
            unbrowse_learn::graph::Class::Minted { name } if !matches!(f.loc, unbrowse_learn::slots::Loc::Cookie(_)) => Some(name),
            _ => None,
        })
        .collect()
}

/// The trace of a walk's capture, its session values noted for every answer to an agent to hide
/// (`session_held::note_trace`): the one way the node reads a walk.
fn trace_from_walk(capture_dir: &std::path::Path, session: &str) -> Option<unbrowse_learn::Trace> {
    let trace = unbrowse_learn::walk::trace_from_walk(capture_dir, session)?;
    crate::session_held::note_trace(&trace);
    Some(trace)
}

/// The session the node keeps for `host`, for a walk's browser to start with: the cookies of its jar, each set where
/// the site set it (`jar_scope_path`), and none of its header tokens, which ride in headers. An agent that signed in by
/// browsing left it there (`refresh_jar`), so the page it then asks `unbrowse_do` about is walked signed in (spec §104).
/// Nothing when the owner keeps signed-in calls off.
fn kept_session(host: &str) -> Vec<unbrowse_learn::mint::SeedCookie> {
    if !store::load_settings().signed_in_calls {
        return Vec::new();
    }
    let jar: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path(host), &unbrowse_files::JAR);
    let scope: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_scope_path(host), &unbrowse_files::JAR);
    // Each cookie's path and whether a page's script may read it, as the browser that earned it had them: a cookie whose
    // HttpOnly was never recorded is set HttpOnly, out of the page's script's reach.
    let meta: std::collections::BTreeMap<String, unbrowse_learn::client::CookieMeta> =
        unbrowse_files::JAR.read_at(&unbrowse_learn::client::meta_path(&store::jars_dir(), host)).ok().flatten().unwrap_or_default();
    let tokens = header_tokens(host);
    jar.into_iter()
        .filter(|(name, _)| !tokens.contains(name))
        .map(|(name, value)| unbrowse_learn::mint::SeedCookie {
            domain: scope.get(&name).cloned(),
            path: meta.get(&name).map(|m| m.path.clone()),
            http_only: meta.get(&name).and_then(|m| m.http_only),
            name,
            value,
        })
        .collect()
}

/// Keeps a route learned from the owner's browsing: theirs alone, run with the session the browsing used (the
/// owner's cookies for its host, merged into the jar).
fn keep_browsed(mut route: Route, site: &str, who: &str, id: &str, eye: Sink) -> Result<Route, String> {
    route.yours = true;
    refresh_jar(&route.site, site);
    let route = save_learned(route, who)?;
    eye(Eye::Saved {
        walk: id.to_string(),
        route: route.id.clone(),
        what: route.what.clone(),
        site: route.site.clone(),
        steps: route.steps,
        inputs: route.inputs.iter().map(|i| i.name.clone()).collect(),
    });
    try_the_page_later(&route, "learn::keep_browsed");
    Ok(route)
}

/// [`browsed_lines`] of a whole log's text.
#[cfg(test)]
fn browsed_session(raw: &str) -> Result<unbrowse_learn::session::Session, String> {
    browsed_lines(raw.lines())
}

/// A browsing log as a session, from its lines as they are read: its actions and finished requests. A line still being
/// written, or of a kind the learner doesn't read, is skipped rather than failing the whole log.
fn browsed_lines<S: AsRef<str>>(lines: impl Iterator<Item = S>) -> Result<unbrowse_learn::session::Session, String> {
    let kept = lines.filter(|l| {
        serde_json::from_str::<serde_json::Value>(l.as_ref())
            .ok()
            .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(|t| matches!(t, "action" | "exchange" | "socket")))
            .unwrap_or(false)
    });
    let mut session = unbrowse_learn::session::Session::from_lines(kept).map_err(|e| format!("the browsing log didn't read: {e}"))?;
    chosen_as_sent(&mut session);
    Ok(session)
}

/// A choice in a select as the site gets it: the browser logs the option's label (`SAVINGS`) and the form sends its value
/// (`1`), so a call that carries it would never be matched. The option is read from the page the choice was made on.
fn chosen_as_sent(session: &mut unbrowse_learn::session::Session) {
    for i in 0..session.actions.len() {
        let a = &session.actions[i];
        let (Some(label), "select") = (a.value.as_deref(), a.kind.as_str()) else { continue };
        let at = a.t;
        let pages = session.trace.exchanges.iter().enumerate().rev().filter(|(n, e)| session.time_of(*n) <= at && e.response_mime.contains("html"));
        let sent = pages.filter_map(|(_, e)| e.response_body.as_deref()).find_map(|body| unbrowse_learn::page::option_value(body, label));
        if let Some(sent) = sent {
            session.actions[i].value = Some(sent);
        }
    }
}

/// What the call at `index` sent from a select nobody moved. A form sends every select it holds, so the account a transfer
/// comes from reaches the site though the agent only chose where it goes, and a route that held it fixed could never send
/// from another. A key the page offers as a select is the caller's to choose, with what the page had set as its default.
/// Hidden fields and a page's own tokens are no selects, so they stay as the walk found them.
fn left_as_set(trace: &Trace, index: usize, inputs: &[Input]) -> Vec<Input> {
    let pages: Vec<&str> = trace.exchanges[..index].iter().rev().filter(|e| e.response_mime.contains("html")).filter_map(|e| e.response_body.as_deref()).collect();
    unbrowse_learn::slots::slots(&trace.exchanges[index])
        .into_iter()
        .filter(|s| !matches!(s.loc, unbrowse_learn::Loc::Header(_) | unbrowse_learn::Loc::Cookie(_)))
        .filter_map(|s| Some((unbrowse_learn::graph::key_of(&s.loc)?, s.value)))
        .filter(|(key, value)| !inputs.iter().any(|i| i.name == *key || i.value == *value))
        .filter(|(key, _)| pages.iter().any(|p| unbrowse_learn::page::offers_a_choice(p, key)))
        .map(|(key, value)| Input::new(&key, &value))
        .collect()
}

/// What a flow of browsing comes to.
enum Outcome {
    /// A route: the call that sent what was typed (`by` "what was typed", sent at `at`), or for a flow that only
    /// read, the call that answered (`carries_page`: it sent the page's own inputs).
    /// `secrets`: what was typed that the walk shows the site only checks, still written as typed in the record.
    Route { route: Route, by: &'static str, notes: Vec<String>, at: f64, carries_page: bool, secrets: Vec<String> },
    /// Something was typed, but it left by no call the browser records.
    Unsent(String),
    /// Nothing to learn.
    Nothing(String),
}

/// What sent a typed value: a request of the trace, or a frame of the page's sockets.
#[derive(Clone, Copy)]
enum Sent {
    Call(usize),
    Frame(usize),
}

/// Whether a frame's text carries a value, as typed or as it would sit inside a JSON string.
pub fn frame_carries(data: &str, value: &str) -> bool {
    carries_text(data, value)
}

fn json_escaped(v: &str) -> String {
    let quoted = serde_json::to_string(v).unwrap_or_default();
    quoted[1..quoted.len().saturating_sub(1)].to_string()
}

/// The leading word of a frame, which many socket protocols name the frame's kind with (`MESG{…}`, `42["chat"…`
/// has none): how the answer to a frame is told from the rest of what the socket says.
pub fn frame_word(frame: &str) -> &str {
    let end = frame.find(|c: char| !(c.is_ascii_alphabetic() || c == '_')).unwrap_or(frame.len());
    &frame[..end]
}

/// The frame's kind from its pieces: the leading word of the text the route keeps, never of a caller's value.
pub fn frame_kind(pieces: &[crate::store::Piece]) -> String {
    match pieces.first() {
        Some(crate::store::Piece::Text { text }) if pieces.len() > 1 || !text.is_empty() => {
            let word = frame_word(text);
            // A word running into a caller's value is that value's start, not a kind.
            if word.len() == text.len() && pieces.len() > 1 { String::new() } else { word.to_string() }
        }
        _ => String::new(),
    }
}

/// Headers a page chose to open its socket with, which the route sends again: not the browser's own (its key, the
/// upgrade, compression it negotiates) and not its cookies, which come from the jar when the route runs.
pub fn chosen_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    !matches!(
        n.as_str(),
        "host" | "connection" | "upgrade" | "sec-websocket-key" | "sec-websocket-version" | "sec-websocket-extensions" | "accept-encoding" | "cache-control" | "pragma" | "cookie"
    )
}

/// The caller's values in a frame: what was typed in the flow, and the ids in the page's own address (the chat,
/// the item the page is about), each named for the path word before it.
fn frame_values(session: &unbrowse_learn::session::Session, since: f64, until: f64, page: &str) -> Vec<(String, String, bool)> {
    let mut out: Vec<(String, String, bool)> = session
        .actions
        .iter()
        .filter(|a| a.t > since && a.t <= until && a.gives_a_value())
        .filter_map(|a| {
            let name = a.field.clone().or_else(|| a.selector.clone())?;
            let value = a.value.clone().filter(|v| v.trim().len() >= 2)?;
            let secret = a.secret || kept_secret(session, &value, a.t, until);
            Some((name, value, secret))
        })
        .collect();
    out.extend(address_ids(page).into_iter().map(|(n, v)| (n, v, false)));
    let mut seen = std::collections::HashSet::new();
    out.retain(|(n, _, _)| seen.insert(n.clone()));
    out
}

/// The ids in a page's address (`/inbox/2193857599/`, `/p/1321463987/`), each named for the segment before it when
/// that is a word, else `id`.
fn address_ids(page: &str) -> Vec<(String, String)> {
    let Ok(u) = url::Url::parse(page) else { return Vec::new() };
    let segs: Vec<&str> = u.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default();
    segs.iter()
        .enumerate()
        .filter(|(_, seg)| seg.len() >= 4 && seg.chars().any(|c| c.is_ascii_digit()) && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .map(|(i, seg)| {
            let word = i.checked_sub(1).map(|j| segs[j]).filter(|p| p.len() >= 3 && p.chars().all(|c| c.is_ascii_alphabetic() || c == '-'));
            (word.unwrap_or("id").replace('-', "_"), seg.to_string())
        })
        .collect()
}

/// A frame's text as pieces: the caller's values where they sit, as typed or JSON-escaped, and the rest as it was.
fn pieces_of(text: &str, values: &[(String, String, bool)]) -> Vec<crate::store::Piece> {
    use crate::store::Piece;
    let mut out = Vec::new();
    let mut rest = text;
    loop {
        let found = values
            .iter()
            .flat_map(|(name, v, _)| [v.clone(), json_escaped(v)].into_iter().filter(|f| !f.is_empty()).map(move |f| (name, f)))
            .filter_map(|(name, f)| rest.find(&f).map(|at| (at, std::cmp::Reverse(f.len()), name.clone(), f)))
            .min();
        let Some((at, _, name, f)) = found else { break };
        if at > 0 {
            out.push(Piece::Text { text: rest[..at].to_string() });
        }
        out.push(Piece::Input { name });
        rest = &rest[at + f.len()..];
    }
    if !rest.is_empty() {
        out.push(Piece::Text { text: rest.to_string() });
    }
    out
}

/// A route from frame `j`, sent over a page's socket: the socket's address and chosen headers, the frames its
/// protocol opened with, and the frame with the caller's values in it.
fn socket_route(session: &unbrowse_learn::session::Session, j: usize, since: f64, until: f64, page: &str, goal: Option<&str>) -> Result<Route, Unread> {
    use crate::store::{Piece, RouteInput, SocketRoute};
    let frame = &session.sockets[j];
    let mine: Vec<&unbrowse_learn::SocketEvent> = session.sockets.iter().filter(|e| e.id == frame.id).collect();
    let open = mine.iter().rev().find(|e| e.kind == "open").ok_or(Unread::Earlier)?;
    let url = open.url.clone().ok_or("the socket's address wasn't recorded")?;
    let headers = mine.iter().rev().find(|e| e.kind == "handshake").map(|h| h.headers.iter().filter(|(k, _)| chosen_header(k)).cloned().collect()).unwrap_or_default();
    let first = |kind: &str| mine.iter().find(|e| e.kind == kind).map(|e| e.t);
    let server_first = match (first("received"), first("sent")) {
        (Some(r), Some(s)) => r < s,
        (r, _) => r.is_some(),
    };
    let values = frame_values(session, since, until, page);
    let carries_a_value = |d: &str| values.iter().any(|(_, v, _)| frame_carries(d, v));
    let opening = mine
        .iter()
        .filter(|e| e.kind == "sent" && e.opcode == 1 && e.t <= open.t + 3.0 && e.t < frame.t)
        .filter_map(|e| e.data.clone())
        .filter(|d| !carries_a_value(d))
        .collect();
    let text = frame.data.clone().unwrap_or_default();
    let pieces = pieces_of(&text, &values);
    let mut inputs: Vec<RouteInput> = Vec::new();
    for p in &pieces {
        if let Piece::Input { name } = p {
            if let (Some((_, v, secret)), false) = (values.iter().find(|(n, _, _)| n == name), inputs.iter().any(|i| &i.name == name)) {
                inputs.push(RouteInput { name: name.clone(), secret: *secret, default: (!secret).then(|| v.clone()), file: false, optional: false, options: Vec::new() });
            }
        }
    }
    let word = frame_kind(&pieces);
    let ws: url::Url = url.parse().map_err(|e| format!("the socket's address didn't read: {e}"))?;
    let site = url::Url::parse(page).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| ws.host_str().unwrap_or_default().to_string());
    let names: Vec<&str> = inputs.iter().map(|i| i.name.as_str()).collect();
    let id = hex::encode(&Keccak256::digest(format!("WS {}{} {word} {}", ws.host_str().unwrap_or_default(), ws.path(), names.join(",")).as_bytes())[..8]);
    let what = match goal.filter(|g| !g.trim().is_empty()) {
        Some(g) => g.trim().to_string(),
        None => format!("Send {} over the socket on {}", if word.is_empty() { "a message".to_string() } else { word.clone() }, site_of(&site)),
    };
    Ok(Route {
        plain_trial: None,
        paging: None,
        tried_page: false,
        page_tries: store::PageTries::default(),
        asked: Vec::new(),
        id,
        site,
        what,
        method: "WS".into(),
        path: format!("{}{} {word}", ws.host_str().unwrap_or_default(), ws.path()),
        root: page.to_string(),
        inputs,
        steps: 1,
        browser_assisted: false,
        write: true,
        provisional: true,
        learned_at: store::now(),
        stats: Default::default(),
        listing: None,
        yours: true,
        local: None,
        socket: Some(SocketRoute { url, headers, opening, server_first, frame: pieces }),
        fetched: None,
        share: None,
        fields: Vec::new(),
        judged: Default::default(),
        heard: Default::default(),
        page_made: None,
        walk_without_fragment: false,
        read_by: None,
        given: Vec::new(),
        session_gave: false,
        body: None,
        checked: None,
        graph: unbrowse_learn::Graph { steps: Vec::new(), provisional: true, page_origin: None, ..unbrowse_learn::Graph::default() },
    })
}

/// A route's name when nobody gave one: what the call does, read from its own path, and where.
fn name_of(e: &Exchange, write: bool) -> String {
    let words: Vec<String> = e
        .url
        .path_segments()
        .into_iter()
        .flatten()
        .filter(|s| s.len() > 1 && s.chars().all(|c| c.is_ascii_alphabetic() || c == '-' || c == '_'))
        .map(|s| s.replace(['-', '_'], " "))
        .collect();
    let tail = words[words.len().saturating_sub(3)..].join(" ");
    let site = site_of(e.url.host_str().unwrap_or_default());
    format!("{} {} on {site}", if write { "Send" } else { "Read" }, if tail.is_empty() { "the page".to_string() } else { tail })
}

/// [`learn_from_flow`] of a session the caller keeps.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn learn_from_session(
    session: &unbrowse_learn::session::Session,
    site: &str,
    goal: Option<&str>,
    since: f64,
    sent: f64,
    until: f64,
    id: &str,
    eye: Sink,
    known_page: Option<&str>,
) -> Result<Outcome, Unread> {
    learn_from_flow(&mut session.clone(), site, goal, since, sent, until, id, eye, known_page)
}

/// `check` of a trace of only the session's requests made at the times `within` says, lent out of the session and put
/// back as it was: moved, never copied, since a page's flow can be hundreds of MB of answers (UNB-208). The requests
/// are in the order they started, so a flow's are one run of them; were they not, they are copied, as they once were.
fn with_flow<T>(session: &mut unbrowse_learn::session::Session, within: impl Fn(f64) -> bool, check: impl FnOnce(&Trace) -> T) -> T {
    let n = session.trace.exchanges.len();
    let first = (0..n).find(|&i| within(session.time_of(i)));
    let (lo, hi) = first.map_or((0, 0), |lo| (lo, (lo..n).rfind(|&i| within(session.time_of(i))).map_or(lo, |last| last + 1)));
    if !(lo..hi).all(|i| within(session.time_of(i))) {
        let exchanges = (0..n).filter(|&i| within(session.time_of(i))).map(|i| session.trace.exchanges[i].clone()).collect();
        return check(&Trace { exchanges, inputs: Vec::new() });
    }
    let mut after = session.trace.exchanges.split_off(hi);
    let flow = Trace { exchanges: session.trace.exchanges.split_off(lo), inputs: Vec::new() };
    let out = check(&flow);
    session.trace.exchanges.extend(flow.exchanges);
    session.trace.exchanges.append(&mut after);
    out
}

/// The pick, from the flow of a browsed session: after `since`, up to `until`. Each value typed in the flow is sent
/// by the first call after it that carries it (and after `sent`, the last send already learned); the route is the
/// latest such send. A flow that typed nothing was reading: its page's own inputs (the query, a searched path) are
/// the route's, and the call that answers is scored by the same rule as a walk (or the decision model). What was
/// typed and left by no recorded call (a socket, a form never submitted) is said in the notes, and a flow whose
/// typing all left that way has nothing to learn.
#[allow(clippy::too_many_arguments)]
fn learn_from_flow(
    session: &mut unbrowse_learn::session::Session,
    site: &str,
    goal: Option<&str>,
    since: f64,
    sent: f64,
    until: f64,
    id: &str,
    eye: Sink,
    known_page: Option<&str>,
) -> Result<Outcome, Unread> {
    let within = |t: f64| t > since && t <= until;
    // The page the flow is on: the last one opened, in the part of the log read, else the one the node noted when it
    // was opened (`known_page`); the site's front page only when neither is known.
    let page = session
        .actions
        .iter()
        .rev()
        .find(|a| a.kind == "navigate" && within(a.t))
        .or_else(|| session.actions.iter().rev().find(|a| a.kind == "navigate" && a.t <= until))
        .and_then(|a| a.value.clone())
        .or_else(|| known_page.map(String::from))
        .unwrap_or_else(|| format!("https://{site}/"));
    let typed_value = |a: &unbrowse_learn::Action| within(a.t) && a.gives_a_value() && !a.secret && a.value.as_deref().is_some_and(|v| v.trim().len() >= 2);
    // A page only opened, that the site doesn't have or sent elsewhere, teaches nothing: the same as a walk of it.
    // Nor does a page whose own ask the site refused while it was open: what it drew then is its frame, not its
    // answer, and a walk of the same page is held to the same (`the_pages_ask_was_refused`). Kept as "the page,
    // read", it would answer every value with a title, a header and a footer.
    if !session.actions.iter().any(typed_value) {
        if let Some(why) = with_flow(session, within, |flow| {
            let (why, reason) = not_the_page(flow, &page).map(|why| (why, "the captured navigation did not reach the requested page"))
                .or_else(|| the_pages_ask_was_refused(flow, &page, site).map(|why| (why, "the captured page's own request was refused")))?;
            let mut statuses: Vec<_> = main_document_requests(flow).rev().take(4).map(|doc| doc.status).collect();
            statuses.reverse();
            eye(Eye::Failed { walk: id.to_string(), error: format!("{reason} ({} exchanges, main document statuses {statuses:?})", flow.exchanges.len()) });
            Some(why)
        }) {
            return Ok(Outcome::Nothing(why));
        }
    }
    let session = &*session;
    let trace = &session.trace;
    // The site the browsing is on now: a step may have taken the page to another site's own page (a search a company
    // runs on its parent's domain), which is a page there, not a waiting room (`walked_site`). Its calls are the
    // flow's, and only what stands between the two is a door.
    let door = trace.door(&walked_site(&trace.exchanges, site));
    let in_flow = |i: usize| within(session.time_of(i));
    let typed: Vec<&unbrowse_learn::Action> = session.actions.iter().filter(|a| typed_value(a)).collect();
    // What sent each typed value: the first request after it that carries it, or the first frame the page sent
    // over a socket with it, whichever went first.
    let when = |s: Sent| match s {
        Sent::Call(i) => session.time_of(i),
        Sent::Frame(j) => session.sockets[j].t,
    };
    // The pages the flow was on, as a beacon reports them: an ad bid or an analytics hit carries the page's address,
    // and with it whatever the page's address holds (the search typed into it), but it reports the page, it didn't
    // send what was typed.
    let pages: Vec<String> = (0..trace.exchanges.len())
        .filter(|&i| trace.exchanges[i].is_main_document() && session.time_of(i) <= until)
        .filter_map(|i| page_address(trace.exchanges[i].url.as_str()))
        .chain(page_address(&page))
        .collect();
    // A call that carries one of them along asked for the value only where it also sends it as its own
    // (`sends_its_own_ask`): a search whose client context names the results page it opens sent the word in its query.
    let reports_a_page = |e: &Exchange, value: &str| pages.iter().any(|p| reports_the_page(&e.url, e.request_body.as_deref(), p)) && !sends_as_its_own(e, value);
    // A beacon that happens to carry what was typed is not the call that sent it: a named telemetry endpoint, or a
    // third-party POST to a root path that answers with nothing (the typed word rode along in an opaque body) is
    // reporting, not the page's data (#24). The automatic path filters these the way goal learning does.
    let reporting = |e: &Exchange| {
        let req: Option<serde_json::Value> = e.request_body.as_deref().and_then(|b| serde_json::from_str(b).ok());
        if unbrowse_learn::verify::telemetry_endpoint(&e.url, req.as_ref(), None) {
            return true;
        }
        let off_site = e.url.host_str().is_some_and(|h| !unbrowse_learn::identity::on_site(h, site));
        let root = matches!(e.url.path(), "" | "/");
        let no_answer = e.response_body.as_deref().map(|b| b.trim().is_empty()).unwrap_or(true);
        e.method.eq_ignore_ascii_case("POST") && off_site && root && no_answer
    };
    // Under a goal that only reads, the page a typed word lands on is the answer only where it answers: a page as
    // served that says nothing of the word (a chat's empty frame, a shell its script fills) carried the word in its
    // address and nothing else, and the call that answers comes after it.
    let reads = goal.filter(|g| unbrowse_learn::goal::only_reads(g));
    // A page as served that never says the word it was sent is a frame its script fills: the word is in its address
    // and nowhere in it.
    let an_empty_landing = |e: &Exchange, value: &String| {
        reads.is_some_and(|g| {
            e.is_main_document() && (!unbrowse_learn::trace::carries_whole(e.response_body.as_deref().unwrap_or_default(), value) || fails_goal(e, g, &page, std::slice::from_ref(value), &landed(trace), trace).is_some())
        })
    };
    let send_of = |a: &unbrowse_learn::Action| -> Option<Sent> {
        let value = a.value.clone().unwrap_or_default();
        // The first call from `from` on that carries it, by when it was sent: the log holds calls in the order they
        // ended, and a long answer ends after a short one sent later.
        let call_from = |from: f64| {
            (0..trace.exchanges.len())
                .filter(|&i| {
                    let (e, t) = (&trace.exchanges[i], session.time_of(i));
                    // A preflight is the browser asking leave to send the call, never the call.
                    t >= from && t > sent && t <= until && !door.contains(&i) && !e.is_asset() && !e.method.eq_ignore_ascii_case("OPTIONS") && e.status < 400 && carries(e, std::slice::from_ref(&value)) && !reports_a_page(e, &value) && !reports_an_event(e, site) && !reporting(e) && !an_empty_landing(e, &value)
                })
                .min_by(|x, y| session.time_of(*x).total_cmp(&session.time_of(*y)))
        };
        let frame_from = |from: f64| {
            session.sockets.iter().position(|f| {
                f.kind == "sent" && f.opcode == 1 && f.t >= from && f.t > sent && f.t <= until && f.data.as_deref().is_some_and(|d| frame_carries(d, &value))
            })
        };
        // A value the flow then handed over (Enter, a button, a fill that submitted its form) was sent by what came
        // after that step: a call made while it was being typed answered the field (its suggestions), not the asking.
        // A flow whose page sends nothing after it (a search that answers as it is typed) is read from the typing.
        let handed = session.actions.iter().filter(|s| s.t > a.t && s.submits()).map(|s| s.t).min_by(f64::total_cmp);
        let (call, frame) = handed
            .map(|h| (call_from(h), frame_from(h)))
            .filter(|(c, f)| c.is_some() || f.is_some())
            .unwrap_or_else(|| (call_from(a.t), frame_from(a.t)));
        match (call.map(Sent::Call), frame.map(Sent::Frame)) {
            (Some(c), Some(f)) => Some(if when(f) < when(c) { f } else { c }),
            (c, f) => c.or(f),
        }
    };
    let sends: Vec<(&unbrowse_learn::Action, Option<Sent>)> = typed.iter().map(|a| (*a, send_of(a))).collect();
    let field = |a: &unbrowse_learn::Action| a.field.clone().or_else(|| a.selector.clone()).unwrap_or_else(|| "a field".into());
    let latest = sends.iter().filter_map(|(_, s)| *s).max_by(|x, y| when(*x).total_cmp(&when(*y)));
    let unsent: Vec<String> = sends.iter().filter(|(a, s)| s.is_none() && latest.is_none_or(|l| a.t > when(l))).map(|(a, _)| field(a)).collect();
    let mut notes: Vec<String> =
        unsent.iter().map(|f| format!("what was typed into {f} left by nothing the browser recorded (never sent, or sent in a form it can't read), so it isn't part of the route")).collect();
    notes.dedup();
    if let Some(Sent::Frame(j)) = latest {
        let route = socket_route(session, j, since, until, &page, goal)?;
        eye(Eye::Picked { walk: id.to_string(), index: j, method: "WS".into(), host: route.site.clone(), path: route.path.clone(), by: "what was typed", reasons: vec!["it sent the latest thing typed, over the page's socket".into()] });
        let secrets = unnamed(frame_values(session, since, until, &page).into_iter().filter(|(_, _, secret)| *secret).map(|(_, v, _)| v));
        return Ok(Outcome::Route { route, by: "what was typed", notes, at: session.sockets[j].t, carries_page: false, secrets });
    }
    let latest = latest.map(|s| match s {
        Sent::Call(i) => i,
        Sent::Frame(_) => unreachable!("a frame returned above"),
    });
    let page_inputs = walk_inputs(&page, &path_inputs(&page, goal.unwrap_or_default(), trace).0, &trace.exchanges);
    let (index, by, reasons) = match latest {
        Some(i) => (i, "what was typed", vec!["it sent the latest thing typed".to_string()]),
        None if !typed.is_empty() => {
            return Ok(Outcome::Unsent(format!(
                "nothing typed in this flow left the browser by anything it records: {} was never sent, or went in a form the browser can't read, so there's no route to keep",
                unsent.join(", ")
            )))
        }
        None => {
            let values: Vec<String> = page_inputs.iter().map(|i| i.value.clone()).filter(|v| !unbrowse_learn::slots::bound_by_key(v)).collect();
            let mut view = view_of(id, &page, site, trace, 0);
            // Of the pages, only the one the flow opened was read: a page the site went to by itself meanwhile (a
            // chat it opened, a frame) answers nothing the agent read.
            let opened = url::Url::parse(&page).ok().map(|u| (u.host_str().map(String::from), u.path().trim_end_matches('/').to_string()));
            let is_opened = |e: &Exchange| opened.as_ref().is_some_and(|(h, p)| e.url.host_str().map(String::from) == *h && e.url.path().trim_end_matches('/') == p);
            view.candidates.retain(|c| in_flow(c.index) && (!c.page || is_opened(&trace.exchanges[c.index])));
            pass_over(&mut view, trace, &rejected_calls(&page, goal));
            if view.candidates.is_empty() {
                eye(Eye::Failed { walk: id.to_string(), error: format!("no recorded call reached candidate scoring ({} exchanges)", view.exchanges) });
                return Ok(Outcome::Nothing("the browsing made no call that answers with data".into()));
            }
            let read: Vec<String> = session.actions.iter().filter(|a| a.kind == "read" && within(a.t)).filter_map(|a| a.value.clone()).collect();
            let scores = rule_scores(trace, &view, goal.unwrap_or_default(), &values, &read);
            let at = |i: usize| view.candidates.iter().find(|c| c.index == i);
            eye(Eye::Scored {
                walk: id.to_string(),
                exchanges: view.exchanges,
                candidates: scores
                    .iter()
                    .take(12)
                    .filter_map(|(score, i, noise, _)| {
                        let c = at(*i)?;
                        Some(Scored { index: *i, method: c.method.clone(), host: c.host.clone(), path: bare(&c.path), score: (score * 10.0).round() / 10.0, noise: *noise })
                    })
                    .collect(),
            });
            // A page read for a stated goal keeps only a call whose answer answers it (`fails_goal`); with no goal
            // stated, what was read off the page says which call filled it. Either way the call's answer says something
            // the page showed: the page the flow opened, as its document was served, and what the agent read off it
            // (`shows_nothing`).
            let shown = page_shown((0..trace.exchanges.len()).filter(|&i| in_flow(i) && is_opened(&trace.exchanges[i])).map(|i| &trace.exchanges[i]), &page, &read);
            // A call the page's own script spells, answering with data, is what the page shows: its document scores higher
            // for being the page, and replayed alone is the empty table the script fills. The script asked for it, so the
            // pieces of the page's address say nothing of it (a file name is no subject, and nothing to send): it is held
            // to what the goal asks, and to what the page's query asked.
            let fills = |i: usize| !trace.exchanges[i].is_main_document() && trace.exchanges[i].json_body().is_some() && shown.asks_for(&trace.exchanges[i]);
            let queried = asked_values(&page, &[]);
            let passes = |i: usize| {
                goal.is_none_or(|g| {
                    let (about, asked) = if fills(i) { ("", &queried) } else { (page.as_str(), &values) };
                    fails_goal(&trace.exchanges[i], g, about, asked, &landed(trace), trace).is_none()
                }) && shows_nothing(&trace.exchanges[i], &shown, site, &values, goal.unwrap_or_default()).is_none()
            };
            // With a goal, the rule picks as a walk's does (`rule_pick`): by what each answer holds of the goal (records
            // that say back what was asked over a call that only scores higher), not by score alone.
            let ruled = goal.and_then(|g| rule_pick(trace, &view, g, &values, scores.clone()).ok()).filter(|(i, _)| passes(*i));
            // Over the page, the call that fills it, when one holds what the goal asks.
            let filler = scores.iter().find(|c| !c.2 && fills(c.1) && passes(c.1)).map(|c| (c.1, c.3.clone()));
            let ruled = match (ruled, filler) {
                (Some((i, _)), Some(call)) if trace.exchanges[i].is_main_document() => Some(call),
                (ruled, _) => ruled,
            };
            match goal.and_then(|g| model_pick(trace, &view, g, &values)).filter(|&i| passes(i)) {
                Some(i) => (i, "the decision model", vec!["the decision model was confident it answers the goal".to_string()]),
                None => match ruled {
                    Some((i, reasons)) => (i, "the rule", reasons),
                    None => {
                        let passing: Vec<_> = scores.into_iter().filter(|s| !s.2 && passes(s.1)).collect();
                        let best = passing.iter().position(|s| fills(s.1)).unwrap_or(0);
                        match passing.into_iter().nth(best) {
                            Some((_, i, _, reasons)) => (i, "the rule", reasons),
                            None => {
                                eye(Eye::Failed { walk: id.to_string(), error: "none of the scored browser calls answered the goal".into() });
                                return Ok(Outcome::Nothing("the browsing made no call whose answer answers the goal".into()));
                            }
                        }
                    }
                },
            }
        }
    };
    let Some(picked) = trace.exchanges.get(index) else { return Ok(Outcome::Nothing("the pick names no call the browsing made".into())) };
    let c = candidate(index, picked);
    eye(Eye::Picked { walk: id.to_string(), index, method: c.method.clone(), host: c.host.clone(), path: bare(&c.path), by, reasons });
    // The route is this flow, up to the target. What came before it (logging in, looking around) is the owner's
    // session: its values come from the jar, never from replaying it. Its inputs are what was typed in the flow, or
    // for a page that was only read, the page's own inputs; never every address visited.
    let flow: Vec<usize> = (0..=index).filter(|&i| in_flow(i)).collect();
    let Some(last) = flow.len().checked_sub(1) else { return Ok(Outcome::Nothing("the pick is outside this flow".into())) };
    let inputs = if by == "what was typed" {
        session
            .actions
            .iter()
            .filter(|a| within(a.t) && a.gives_a_value())
            .filter_map(|a| {
                let name = a.field.clone().or_else(|| a.selector.clone())?;
                let value = a.value.clone()?;
                Some(unbrowse_learn::Input { secret: a.secret || kept_secret(session, &value, a.t, until), name, value })
            })
            .collect()
    } else {
        page_inputs.clone()
    };
    let target = &trace.exchanges[index];
    let carries_page = carries(target, &page_inputs.iter().map(|i| i.value.clone()).collect::<Vec<_>>()) && !page_inputs.is_empty();
    // The page the flow opened is the one it acted on, so the address it was opened at names the thing acted on:
    // its ids are the caller's to choose (which item to message, which order to change). The page the browser
    // landed on is fetched from that address again; a site that redirects a short address to a long one does so
    // for the route too.
    let mut inputs = inputs;
    if by == "what was typed" {
        for (name, value) in address_ids(&page) {
            if !inputs.iter().any(|i| i.name == name || i.value == value) {
                inputs.push(unbrowse_learn::Input::new(&name, &value));
            }
        }
        let left = left_as_set(trace, index, &inputs);
        inputs.extend(left);
    }
    let opened = url::Url::parse(&page).ok();
    let landed = flow.iter().position(|&i| trace.exchanges[i].is_main_document());
    let upto = Trace {
        exchanges: flow
            .iter()
            .enumerate()
            .map(|(n, &i)| {
                let mut e = trace.exchanges[i].clone();
                if let Some(u) = opened.as_ref().filter(|u| Some(n) == landed && u.host_str() == e.url.host_str()) {
                    e.url = u.clone();
                }
                e
            })
            .collect(),
        inputs,
    };
    let secrets = unnamed(upto.inputs.iter().filter(|i| i.secret).map(|i| i.value.clone()));
    // The page the browser landed on stands for the one opened only when the site didn't send it elsewhere to come
    // back (a sign-in, a wall).
    if let Ok(opened) = url::Url::parse(&page) {
        if target.is_main_document() && unbrowse_learn::answer::detour(&opened, &target.url) {
            return Ok(Outcome::Nothing(format!("the site sent the page to {} instead, naming it to come back to (a sign-in or a wall): nothing to learn", target.url.path())));
        }
    }
    // A browsing session's capture says what was asked, not every address its page was at: it is read as a walk that
    // may have been at an address with a fragment.
    // A step that lands on a new page ends there: what that page then sends by itself, nothing done on it since its
    // document arrived, is what every visit to it sends (`ledger::writes`). A search box that hands its word to the
    // results page's address, whose script then posts it, is such a call: a read, however its path is named.
    // And a call the page also sent by itself as it loaded, asked again with what was typed in place of a value it
    // sent then (a search page that asks for an empty word before one is typed, then asks again in place), is that
    // same read. Only what was typed may differ: a call that differs in anything else (the operation it names, an
    // action, an id it was not given) is another call on the same address, and is held to the write rules.
    let typed = typed_words(session, within);
    let addressed = addressed_values(&session.trace);
    let on_load = (0..session.trace.exchanges.len()).any(|i| asked_again_with_what_was_typed(&session.trace.exchanges[i], target, &typed, &addressed) && sent_by_a_page_since_loaded(session, i, until));
    let mut route = route_of(&upto, last, goal.unwrap_or_default(), &page, on_load, &session.probes, &[], None)?;
    // What the owner's session gave the page (typed, selected, or chosen by a click): a shared route carries none of it.
    route.given = session.actions.iter().filter(|a| within(a.t) && a.gives_a_value()).filter_map(|a| a.field.clone().or_else(|| a.selector.clone())).collect();
    // The owner's own session gave them, not a caller's word: the route is held to the fragment guard's sources.
    route.session_gave = !route.given.is_empty();
    // The route is named for the agent's goal only when something tied it to the goal: it sent what was typed, or the
    // decision model said it answers it, or a cold document showed the queried records at a stable place. The rule's
    // pick alone is the page's best call by score and by the goal's words, which
    // a feed the page polls by itself can match: named for the goal, it would answer that goal from then on. It is named
    // from its own call, as with no goal stated.
    let tied_to_the_goal = matches!(by, "what was typed" | "the decision model") || route.heard.records_at.is_some();
    if goal.is_none_or(|g| g.trim().is_empty()) || !tied_to_the_goal {
        route.what = name_of(target, route.write);
    }
    Ok(Outcome::Route { route, by, notes, at: session.time_of(index), carries_page, secrets })
}

/// Whether two calls are one call sent with other values: the same method, host and path, the same query keys, and a
/// body of the same keys (or none).
fn same_call_but_its_values(a: &Exchange, b: &Exchange) -> bool {
    let keys = |e: &Exchange| e.url.query_pairs().map(|(k, _)| k.into_owned()).collect::<std::collections::BTreeSet<_>>();
    let body = |e: &Exchange| match e.request_body.as_deref().map(serde_json::from_str::<serde_json::Value>) {
        Some(Ok(json)) => unbrowse_learn::slots::json_leaves(&json).into_iter().map(|(at, _)| at).collect::<std::collections::BTreeSet<_>>(),
        Some(Err(_)) => e.request_body.as_deref().map(|b| url::form_urlencoded::parse(b.as_bytes()).map(|(k, _)| k.into_owned()).collect()).unwrap_or_default(),
        None => Default::default(),
    };
    a.method == b.method && a.url.host_str() == b.url.host_str() && a.url.path() == b.url.path() && keys(a) == keys(b) && body(a) == body(b)
}

/// What a session typed as free text (`fill`, `type`), in the steps `within` says count. A choice among the page's
/// own options (a select, a box, a button) is not here: the page wrote those values, and one of them may name what
/// to do.
fn typed_words(session: &unbrowse_learn::session::Session, within: impl Fn(f64) -> bool) -> Vec<String> {
    session.actions.iter().filter(|a| within(a.t) && !a.secret && matches!(a.kind.as_str(), "fill" | "type")).filter_map(|a| a.value.clone()).filter(|v| !v.trim().is_empty()).collect()
}

/// Every value the addresses of the session's pages carried (their query values and path pieces): what each page
/// was asked by its address.
fn addressed_values(trace: &Trace) -> Vec<String> {
    trace
        .exchanges
        .iter()
        .filter(|e| e.is_main_document())
        .flat_map(|e| {
            let query = e.url.query_pairs().map(|(_, v)| v.into_owned());
            let path = e.url.path_segments().into_iter().flatten().map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned());
            query.chain(path).collect::<Vec<_>>()
        })
        .filter(|v| !v.trim().is_empty())
        .collect()
}

/// Whether `target` is the call `loaded` asked again with what was typed: one call but for its values
/// (`same_call_but_its_values`), where each value of `target` that differs from `loaded`'s, at the same place, is a
/// word the session typed as free text, put where `loaded` sent nothing or sent what its page's address carried: the
/// place the page puts what it is asked. A call on the same address that differs anywhere else is not the page's own
/// read asked with another word. An operation, an action or an id names another thing to do, whether nobody typed
/// it, it was chosen from the page's options, or it was typed where the page had written its own word.
fn asked_again_with_what_was_typed(loaded: &Exchange, target: &Exchange, typed: &[String], addressed: &[String]) -> bool {
    if !same_call_but_its_values(loaded, target) {
        return false;
    }
    let is_in = |values: &[String], v: &str| values.iter().any(|t| t.trim().eq_ignore_ascii_case(v.trim()));
    let (then, now) = (sitegraph::parts(loaded), sitegraph::parts(target));
    then.len() == now.len() && then.iter().zip(&now).all(|((at_a, a), (at_b, b))| at_a == at_b && (a == b || (is_in(typed, b) && (a.trim().is_empty() || is_in(addressed, a)))))
}

/// Whether the call at `index` was sent by a page the browser fetched as anyone visiting would (a GET document,
/// answered 2xx) after the last thing done in the session before the call: the page sent it as it loaded.
fn sent_by_a_page_since_loaded(session: &unbrowse_learn::session::Session, index: usize, until: f64) -> bool {
    let sent = session.time_of(index);
    let done = session.actions.iter().map(|a| a.t).filter(|&t| t <= sent && t <= until).fold(f64::NEG_INFINITY, f64::max);
    (0..session.trace.exchanges.len()).any(|i| {
        let (e, t) = (&session.trace.exchanges[i], session.time_of(i));
        i != index && t > done && t <= sent && e.method == "GET" && e.is_main_document() && (200..300).contains(&e.status)
    })
}

/// The secrets among `values` the record still holds as typed: not already a name the engine or the vault gave it.
fn unnamed(values: impl Iterator<Item = String>) -> Vec<String> {
    values.filter(|v| !v.starts_with("secret:") && !crate::vault::is_ref(v)).collect()
}

/// Whether a value typed at `after` is one the site only checks: a password, a code, a card's security number. Its
/// field's label says nothing the learner can rely on (sites word it every way, in every language), but the walk
/// does: a site says back what it was given to use (the search it ran, the message it posted, the price it set), in
/// the answer to the call that sent it or on the socket after, and never what it was given to check. A value nothing
/// says back whole is kept secret, so no default of it is kept; a field the page itself marks secret already is.
/// The account a vault login was sent with is not: the site checks it with the password, but it names who signs in,
/// the vault keeps the password and not it, and a sign-in can't be typed again without it (`setup::read`). This only
/// reads a field the page shows as typed: a PIN or a code box beside the password is one the page hides, and stays secret.
fn kept_secret(session: &unbrowse_learn::session::Session, value: &str, after: f64, until: f64) -> bool {
    use unbrowse_learn::trace::carries_whole;
    if sent_beside_a_login(session, value, after, until) {
        return false;
    }
    let sent_and_answered = (0..session.trace.exchanges.len()).any(|i| {
        let (e, t) = (&session.trace.exchanges[i], session.time_of(i));
        t >= after && t <= until && carries(e, &[value.to_string()]) && e.response_body.as_deref().is_some_and(|b| carries_whole(b, value))
    });
    let framed = session.sockets.iter().any(|f| f.kind == "received" && f.t >= after && f.t <= until && f.data.as_deref().is_some_and(|d| carries_whole(d, value)));
    !sent_and_answered && !framed
}

/// Whether `value`, typed at `after`, went out in the same request as a login the vault typed: the record writes the
/// login's vault name where its password went, so the request carries both.
fn sent_beside_a_login(session: &unbrowse_learn::session::Session, value: &str, after: f64, until: f64) -> bool {
    let logins: Vec<String> = session.actions.iter().filter(|a| a.secret).filter_map(|a| a.value.clone()).filter(|v| crate::vault::is_ref(v) && *v != value).collect();
    !logins.is_empty()
        && (0..session.trace.exchanges.len()).any(|i| {
            let (e, t) = (&session.trace.exchanges[i], session.time_of(i));
            t >= after && t <= until && carries(e, &[value.to_string()]) && carries(e, &logins)
        })
}

/// Routes that match an agent's words, best first (`rank`): by what they do, their site, their path and the fields their
/// answer holds. No words lists them all.
pub fn search(query: &str) -> Vec<Route> {
    // Ranked as the cache holds them, and only the ones that match are copied out.
    rank::ranked(query, store::load_routes_shared(), |r| doc_of(r)).iter().map(|r| store::relabeled(r)).collect()
}

/// What a route is found by: what it does, its site and its path, and the names of the fields its recorded answer holds.
pub fn doc_of(r: &Route) -> rank::Doc {
    fn keys(v: &serde_json::Value, out: &mut Vec<String>) {
        match v {
            serde_json::Value::Object(m) => m.iter().for_each(|(k, v)| {
                out.push(k.clone());
                keys(v, out)
            }),
            serde_json::Value::Array(items) => items.iter().for_each(|v| keys(v, out)),
            _ => {}
        }
    }
    let mut fields = Vec::new();
    if let Some(shape) = r.graph.steps.last().and_then(|s| s.response_shape.as_ref()) {
        keys(shape, &mut fields);
    }
    rank::Doc::new(&format!("{} {} {}", r.what, r.site, r.path), fields)
}

mod checked;
// Tests of the walk and keep path, apart from `tests` so two writers don't share one module (UNB-208).
#[cfg(test)]
mod cov_walk;
#[cfg(test)]
mod cov_pick;
pub(crate) mod confirm;
pub(crate) mod sighted;
mod experiment;
pub(crate) mod own_asks;
mod trial;

#[cfg(test)]
mod corpus;

mod sitegraph;
mod links;

/// A route as an agent wired it, held to the site (`links::wired_by_an_agent`): the route as kept, or why nothing
/// was.
pub fn wired_by_an_agent(walks: &Walks, route: Route, links: &[(usize, String, String)], word: Option<&str>) -> Result<Route, String> {
    links::wired_by_an_agent(walks, route, links, word)
}

/// How a value's place in a request is named to whoever wires a route (`header:x-request-id`, `json:/variables/id`).
pub fn place_of(loc: &unbrowse_learn::Loc) -> String {
    links::place(loc)
}

#[cfg(test)]
mod tests {
    /// The hand-off reconnects only to the browser the walk launched on this machine, read from the engine's own
    /// words: a socket elsewhere, a page's words in front of the engine's, or anything but a DevTools browser socket
    /// is never connected to.
    #[test]
    fn a_handoff_reconnects_only_to_the_browser_the_walk_opened() {
        let ours = "mint unresolved (challenge); browser left open for verification; reconnect at ws://127.0.0.1:54051/devtools/browser/9f1c-2a";
        assert_eq!(handoff_endpoint(ours).as_deref(), Some("ws://127.0.0.1:54051/devtools/browser/9f1c-2a"));
        for refused in [
            "mint unresolved (challenge); browser left open for verification; reconnect at ws://attacker.example:9222/devtools/browser/x",
            "mint unresolved (challenge); browser left open for verification; reconnect at ws://10.0.0.5:9222/devtools/browser/x",
            "mint unresolved (challenge); browser left open for verification; reconnect at wss://127.0.0.1:9222/devtools/browser/x",
            "mint unresolved (challenge); browser left open for verification; reconnect at ws://127.0.0.1/devtools/browser/x",
            "mint unresolved (challenge); browser left open for verification; reconnect at ws://127.0.0.1:9222/devtools/page/x",
            "mint unresolved (challenge); browser left open for verification; reconnect at ws://user@127.0.0.1:9222/devtools/browser/x",
            "mint unresolved (Just a moment; reconnect at ws://127.0.0.1:1/devtools/browser/x); the walk's tab is closed",
            "the page said: reconnect at ws://127.0.0.1:9222/devtools/browser/x",
            "mint unresolved (refused); the browser is closed: only a window could ask again, and the owner keeps windows off",
        ] {
            assert_eq!(handoff_endpoint(refused), None, "{refused}");
        }
    }


    /// A site a door has just refused is rested, and asked again once the rest is over.
    #[test]
    fn a_site_whose_door_refused_is_rested_then_asked_again() {
        assert_eq!(rest_left(Duration::from_secs(20)), Some(Duration::from_secs(280)));
        assert_eq!(rest_left(REST_AFTER_REFUSAL), None);
        assert_eq!(rest_left(Duration::from_secs(900)), None);
    }

    /// A page-signed step whose page values the site does not need is made plain by the call, not by a pruning pass:
    /// the trial sends the route's own fields, and an answer drops the producers, the scripts and the page.
    #[test]
    fn a_page_signed_step_the_site_answers_without_is_made_plain() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://shop.example/search",
            "page_html": "<html></html>",
            "scripts": [{ "url": "https://shop.example/app.js", "body": "headers['x-sig']=1" }],
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200,
                "url": "https://shop.example/api/search", "needs_browser": true,
                "page_signed": true,
                "page_producers": [{ "loc": { "in": "header", "key": "x-sig" }, "producer": { "script": "https://shop.example/app.js", "at": 1 } }],
                "fields": [{ "loc": { "in": "header", "key": "content-type" }, "class": "constant", "value": "application/json" }]
            }]
        }))
        .unwrap();
        let mut route = Route::from_graph("r".into(), "search".into(), "https://shop.example/".into(), graph).unwrap();
        route.browser_assisted = true;
        let mut tried: Option<unbrowse_learn::Graph> = None;
        let mut answers = |g: &unbrowse_learn::Graph, _i: &HashMap<String, String>| {
            tried = Some(g.clone());
            true
        };
        let out = mint_trial(route, &Trace { exchanges: vec![], inputs: vec![] }, &mut answers);
        let trial = tried.expect("the plain trial ran");
        assert!(!trial.steps[0].is_page_signed(), "the trial sends no page");
        assert!(trial.scripts.is_empty() && trial.page.is_none() && trial.api.is_empty());
        assert!(!trial.steps[0].needs_browser);
        assert!(trial.steps[0].fields.iter().all(|f| f.loc != unbrowse_learn::slots::Loc::Header("x-sig".into())));
        assert!(!out.graph.steps[0].is_page_signed(), "the route keeps the plain step");
        assert!(out.graph.scripts.is_empty());
        assert!(!out.browser_assisted);
    }

    /// The walk that exposed it: a video site's search, whose page sends an app id its code writes. Without it the
    /// site answers 200 with the frame and an empty list, for any word. The trial moved the word and saw a 200, the
    /// step was made plain, and every later call found nothing. Asked what the walk asked, a call that comes back
    /// with its lists emptied was given nothing: the page's values stay.
    #[test]
    fn a_call_answered_with_its_lists_emptied_was_not_answered() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let was = serde_json::json!({ "data": { "search": { "videos": { "edges": [{ "node": { "title": "a" } }], "pageInfo": { "hasNextPage": true } } } } });
        let emptied = serde_json::json!({ "data": { "search": { "videos": { "edges": [], "pageInfo": { "hasNextPage": false } } } } });
        let gone = serde_json::json!({ "data": { "search": { "videos": { "edges": null } } } });
        let other = serde_json::json!({ "data": { "search": { "videos": { "edges": [{ "node": { "title": "b" } }] } } } });
        let narrower = serde_json::json!({ "data": { "search": {} } });
        assert!(lists_emptied(&was, &emptied) && lists_emptied(&was, &gone));
        assert!(!lists_emptied(&was, &other), "other records are an answer");
        assert!(!lists_emptied(&was, &narrower), "a key left out says nothing");
        assert!(!lists_emptied(&emptied, &emptied), "a list the walk's answer left empty may stay empty");

        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://video.example/search",
            "page_html": "<html></html>",
            "scripts": [{ "url": "https://video.example/app.js", "body": "headers['x-app']=1" }],
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200,
                "url": "https://video.example/api/search", "needs_browser": true,
                "page_signed": true,
                "page_producers": [{ "loc": { "in": "header", "key": "x-app" }, "producer": { "script": "https://video.example/app.js", "at": 1 } }],
                "fields": [{ "loc": { "in": "header", "key": "content-type" }, "class": "constant", "value": "application/json" }]
            }]
        }))
        .unwrap();
        let route = || {
            let mut r = Route::from_graph("r".into(), "search".into(), "https://video.example/".into(), graph.clone()).unwrap();
            r.browser_assisted = true;
            r
        };
        let mut answers = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| true;
        let kept = mint_trial_as_walked(route(), &Trace { exchanges: vec![], inputs: vec![] }, &mut answers, &mut |_| false);
        assert!(kept.graph.steps[0].is_page_signed(), "given nothing, the step keeps what the page writes");
        assert_ne!(kept.plain_trial, Some(true));
        let plain = mint_trial_as_walked(route(), &Trace { exchanges: vec![], inputs: vec![] }, &mut answers, &mut |_| true);
        assert!(!plain.graph.steps[0].is_page_signed());
    }

    /// The site says whether a route hears its caller: the same answer for a word nobody searches for is a route that
    /// answers the walked page whatever it is sent (a recommendation strip, a page's frame), and a changed answer, a
    /// refusal or nothing found is the site hearing the word. A route the page signs, or one that writes, is not asked.
    #[test]
    fn the_site_says_whether_a_route_hears_its_caller() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let route = |signed: bool| {
            let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
                "provisional": false,
                "steps": [{
                    "exchange": 0, "method": "GET", "status": 200, "url": "https://api.shop.example/search?q={q}&size=20", "needs_browser": false, "page_signed": signed,
                    "fields": [
                        { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "flask" },
                        { "loc": { "in": "query", "key": "size" }, "class": "constant", "value": "20", "origin": null }
                    ]
                }]
            }))
            .unwrap();
            Route::from_graph("r".into(), "search the shop".into(), "https://shop.example/search?q=flask".into(), graph).unwrap()
        };
        let list = |of: &str| serde_json::json!({ "items": (0..8).map(|n| serde_json::json!({ "name": format!("{of} number {n}"), "maker": format!("{of} works {n}") })).collect::<Vec<_>>() });
        let asked = vec!["flask".to_string()];
        // The same strip of "popular" items whatever was asked.
        let mut deaf = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(list("popular lamp"));
        assert_eq!(hears_with(&route(false), &asked, &mut deaf), Hears::Deaf(vec!["q".to_string()]));
        // Results for the word, and other results for the other word.
        let mut hears = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| Some(list(if i["q"] == "flask" { "steel flask" } else { "nothing like it" }));
        assert_eq!(hears_with(&route(false), &asked, &mut hears), Hears::Yes);
        // The site answers the nonsense word with an error: it heard it.
        let mut refuses = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| (i["q"] == "flask").then(|| list("steel flask"));
        assert_eq!(hears_with(&route(false), &asked, &mut refuses), Hears::Yes);
        // A results page that is mostly its filters and menus still has its results: nine shared lines in ten is no
        // deaf route when the tenth is the answer.
        let mut framed = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
            let mut lines: Vec<String> = (0..180).map(|n| format!("filter option {n}")).collect();
            lines.extend((0..20).map(|n| if i["q"] == "flask" { format!("steel flask number {n}") } else { "there were no results".to_string() }));
            Some(serde_json::json!({ "text": lines.join("\n") }))
        };
        assert_eq!(hears_with(&route(false), &asked, &mut framed), Hears::Yes);
        // An answer that only says the word back differs by nothing else: still deaf.
        let mut echoes = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
            let mut v = list("popular lamp");
            v["query"] = serde_json::json!(i["q"]);
            Some(v)
        };
        assert_eq!(hears_with(&route(false), &asked, &mut echoes), Hears::Deaf(vec!["q".to_string()]));
        // A setting beside the word (`kind=shop`) breaks the call when it is moved; the word moved by itself leaves
        // the answer as it was. The broken call says nothing: the route is deaf to the word.
        let two = {
            let mut r = route(false);
            r.inputs.push(store::RouteInput { name: "kind".into(), secret: false, default: Some("shop".into()), file: false, optional: false, options: Vec::new() });
            r
        };
        let both = vec!["flask".to_string(), "shop".to_string()];
        let mut setting = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| (i["kind"] == "shop").then(|| list("popular lamp"));
        assert_eq!(hears_with(&two, &both, &mut setting), Hears::Deaf(vec!["q".to_string()]));
        // The walk that exposed it: a stays search whose call takes the city and a piece of the page's address. Moving
        // the piece changed the answer, so the route was said to hear, and the city, which changed nothing, was
        // forgotten: three cities were then answered with the same page of settings. Each input is asked, and the
        // ones the site showed deaf are kept, whatever another one showed.
        let mut one_hears = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| Some(if i["kind"] == "shop" { list("popular lamp") } else { list("another thing") });
        assert_eq!(hears_with(&two, &both, &mut one_hears), Hears::Deaf(vec!["q".to_string()]), "deaf to the word, though it hears the other input");
        // Not asked: the page makes the call, or the page was asked nothing the route takes.
        let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| -> Option<serde_json::Value> { panic!("a route that is not asked sends nothing") };
        assert!(matches!(hears_with(&route(true), &asked, &mut never), Hears::Unasked(_)));
        assert!(matches!(hears_with(&route(false), &["lamp".to_string()], &mut never), Hears::Unasked(_)));
    }

    /// An input a call needn't give (the next page's token, a filter) has no default and is left out of the call: the
    /// trial still runs. A search whose page writes only a tracing header went to the browser on every call for it.
    #[test]
    fn an_optional_input_the_walk_never_set_does_not_stop_the_trial() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://shop.example/search?q={q}",
            "scripts": [{ "url": "https://shop.example/app.js", "body": "headers['traceparent']=id()" }],
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200,
                "url": "https://api.shop.example/search?q={q}&pageToken={pageToken}", "needs_browser": true,
                "page_signed": true,
                "page_producers": [{ "loc": { "in": "header", "key": "traceparent" }, "producer": { "script": "https://shop.example/app.js", "at": 1 } }],
                "fields": [
                    { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "flask" },
                    { "loc": { "in": "query", "key": "pageToken" }, "class": "input", "name": "pageToken", "secret": false, "default": null, "optional": true }
                ]
            }]
        }))
        .unwrap();
        let route = Route::from_graph("r".into(), "search".into(), "https://shop.example/".into(), graph).unwrap();
        assert!(route.inputs.iter().any(|i| i.name == "pageToken" && i.optional && i.default.is_none()), "{:?}", route.inputs);
        let mut asked: Option<HashMap<String, String>> = None;
        let mut answers = |_g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
            asked = Some(i.clone());
            true
        };
        let out = mint_trial(route, &Trace { exchanges: vec![], inputs: vec![] }, &mut answers);
        let asked = asked.expect("the plain trial ran");
        assert!(!asked.contains_key("pageToken"), "nothing is sent for it: {asked:?}");
        assert_eq!(out.plain_trial, Some(true));
        assert!(!out.graph.steps[0].is_page_signed() && out.graph.scripts.is_empty());
    }

    /// The walk that exposed it: a news search that sends a challenge's token in a header. Tried a moment after the
    /// walk with the walk's own token, the site still answered, so the token was filed as the session's and every
    /// later call was refused. A value a call issued during the visit is made anew each time: it stays the page's.
    /// The same header with no call in the walk that issued it (a key the page kept) is still the session's.
    #[test]
    fn a_value_a_call_issued_during_the_visit_is_never_kept_as_the_sessions() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let token = "03AFcWeA7mG2kq9vXtR5nB8yLpZ1dQ4sU6wJ0hC3eK";
        let route = || {
            let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
                "provisional": false,
                "page": "https://news.example/search/{search}",
                "steps": [{
                    "exchange": 1, "method": "GET", "status": 200,
                    "url": "https://news.example/graphql?q={search}", "needs_browser": true, "page_signed": true,
                    "page_producers": [{ "loc": { "in": "header", "key": "challenge-token" }, "producer": { "script": "https://news.example/app.js", "at": 1 } }],
                    "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "search", "secret": false, "default": "climate" }]
                }]
            }))
            .unwrap();
            Route::from_graph("r".into(), "search the news".into(), "https://news.example/search/climate".into(), graph).unwrap()
        };
        let mut search = walked("GET", "https://news.example/graphql?q=climate", r#"{"data":{"posts":[{"title":"a"}]}}"#, false);
        search.request_headers = vec![("challenge-token".into(), token.into())];
        let reload = walked("POST", "https://challenge.example/reload", &format!(r#"["rresp","{token}",null,120]"#), false);
        // The site answers only when the header is sent: the walk's token still works a moment later.
        let mut answers = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps[0].fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Header("challenge-token".into()));
        let issued = mint_trial(route(), &Trace { exchanges: vec![reload, search.clone()], inputs: vec![] }, &mut answers);
        assert!(issued.graph.steps[0].is_page_signed(), "made anew by the page each time");
        store::scratch_home("issued-this-visit");
        let kept = mint_trial(route(), &Trace { exchanges: vec![search], inputs: vec![] }, &mut answers);
        assert!(!kept.graph.steps[0].is_page_signed(), "no call issued it: the session's, as before");
    }

    /// The walk that exposed it: a video search whose page writes three headers, the app's name among them and a
    /// visitor id a call issued during the visit. The site answers only when told the app's name. One value issued
    /// this visit left all three with the page, and every call went through the browser. The value of the visit is
    /// left out and the rest are tried as the walk sent them: the session keeps what the site answered to.
    #[test]
    fn a_value_issued_this_visit_is_left_out_and_the_rest_are_tried() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let visitor = "3B95790B58A541D9AE4A2EF3A549214A";
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://video.example/search/{search}",
            "steps": [{
                "exchange": 1, "method": "GET", "status": 200,
                "url": "https://video.example/api?q={search}", "needs_browser": true, "page_signed": true,
                "page_producers": [
                    { "loc": { "in": "header", "key": "x-app" }, "producer": { "script": "https://video.example/app.js", "at": 1 } },
                    { "loc": { "in": "header", "key": "x-visitor" }, "producer": { "script": "https://video.example/app.js", "at": 2 } }
                ],
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "search", "secret": false, "default": "surfing" }]
            }]
        }))
        .unwrap();
        let route = Route::from_graph("r".into(), "search videos".into(), "https://video.example/search/surfing".into(), graph).unwrap();
        let mut search = walked("GET", "https://video.example/api?q=surfing", r#"{"data":{"videos":[{"title":"a"}]}}"#, false);
        search.request_headers = vec![("x-app".into(), "example.video.web.app".into()), ("x-visitor".into(), visitor.into())];
        let hello = walked("POST", "https://video.example/hello", &format!(r#"{{"visitor":"{visitor}"}}"#), false);
        // The app's name is spelled out in the page's script: written in the page, not issued to it.
        let mut code = walked("GET", "https://video.example/app.js", r#"var app="example.video.web.app";"#, false);
        code.resource_type = Some("Script".into());
        let header = |g: &unbrowse_learn::Graph, name: &str| g.steps[0].fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Header(name.into()));
        // The site answers a call that names the app, whoever the visitor.
        let mut tried_with_visitor = false;
        let mut answers = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            tried_with_visitor |= header(g, "x-visitor");
            header(g, "x-app")
        };
        store::scratch_home("issued-left-out");
        let out = mint_trial(route, &Trace { exchanges: vec![code, hello, search], inputs: vec![] }, &mut answers);
        assert!(!tried_with_visitor, "the visit's value is never sent as the session's");
        assert!(!out.graph.steps[0].is_page_signed() && !out.browser_assisted, "the step is plain");
        assert!(header(&out.graph, "x-app") && !header(&out.graph, "x-visitor"));
    }

    /// The walk that exposed it: an archive's search, whose answer files its cache notes under a key holding a hash
    /// of the request. The next page's answer had another hash, read as another kind of answer, and a call the site
    /// answered with a hundred new records was not offered as a way to read on. A made-up id in a key is the
    /// answer's own; the kind is what is left.
    #[test]
    fn a_key_holding_a_made_up_id_names_an_entry_not_a_kind() {
        let first = serde_json::json!({ "caching": { "title_fetch__14a01385f61fa2315d41bfa117db11a8": { "ttl": 1 } }, "response": { "body": {}, "header": {} } });
        let next = serde_json::json!({ "caching": { "title_fetch__38276b755a394d6a3747294ddf878ae8": { "ttl": 1 } }, "response": { "body": {}, "header": {} } });
        assert_eq!(keys_of_an_answer(&first), keys_of_an_answer(&next));
        let other = serde_json::json!({ "caching": { "title_fetch__38276b755a394d6a3747294ddf878ae8": { "ttl": 1 } }, "ticker": { "items": [] } });
        assert_ne!(keys_of_an_answer(&first), keys_of_an_answer(&other), "another operation is still another kind");
        // The walk that exposed it: a fund search whose first page fills a question-and-answer box and whose next
        // page leaves it empty. The box left empty says nothing: the two are one kind, and the search reads on.
        let boxed = serde_json::json!({ "results": [1, 2], "questionAnswer": { "answerFound": true, "question": "q" }, "totalCount": 9 });
        let unboxed = serde_json::json!({ "results": [3, 4], "questionAnswer": {}, "totalCount": 9 });
        assert!(of_one_kind(&keys_of_an_answer(&boxed).unwrap(), &keys_of_an_answer(&unboxed).unwrap()));
        assert!(!of_one_kind(&keys_of_an_answer(&first).unwrap(), &keys_of_an_answer(&other).unwrap()));
        // A next page is told by its list: the same kind of record in the same place, whatever else the answer holds.
        let page = |from: usize, extra: bool| {
            let mut v = serde_json::json!({ "results": (from..from + 10).map(|i| serde_json::json!({ "title": format!("t{i}"), "uri": "u", "raw": {} })).collect::<Vec<_>>(), "totalCount": 90 });
            if extra {
                v["questionAnswer"] = serde_json::json!({ "answerFound": true });
            }
            v
        };
        assert!(lists_the_same_kind(&page(0, true), &page(10, false)));
        // The walk that exposed it: a marketplace whose answer lists 65 filters beside 40 products. The filters are
        // the longest list and never change; the products sit in their own place and are other records on page two.
        let market = |from: usize| serde_json::json!({ "mods": { "filter": (0..65).map(|i| serde_json::json!({ "title": format!("brand {i}") })).collect::<Vec<_>>(), "listItems": (from..from + 40).map(|i| serde_json::json!({ "name": format!("item {i}"), "priceShow": "$1" })).collect::<Vec<_>>() } });
        assert!(lists_the_same_kind(&market(0), &market(40)));
        assert!(!lists_the_same_kind(&market(0), &market(0)), "the same records are no next page");
        assert!(!lists_the_same_kind(&page(0, true), &serde_json::json!({ "suggestions": (0..10).map(|i| serde_json::json!({ "term": i })).collect::<Vec<_>>() })));
        assert!(!lists_the_same_kind(&page(0, true), &serde_json::json!({ "results": (0..10).map(|i| serde_json::json!({ "term": i })).collect::<Vec<_>>() })), "another kind of record in the same place");
        let refilled = serde_json::json!({ "results": [3, 4], "questionAnswer": { "error": "x" }, "totalCount": 9 });
        assert!(!of_one_kind(&keys_of_an_answer(&boxed).unwrap(), &keys_of_an_answer(&refilled).unwrap()), "filled otherwise is another kind");
        assert_eq!(kind_of_key("hits_per_page"), "hits_per_page");
        assert_eq!(kind_of_key("internationalization"), "internationalization", "a long word is a word");
        assert_eq!(kind_of_key("item_1321463987"), "item_*");
        assert_eq!(kind_of_key("page2"), "page2");
    }

    /// The walk that exposed it: a video site's search for "surfing", answered with twenty videos titled "Surf ..."
    /// and not one "surfing". The call was passed over for never saying the word back, read as one record because
    /// the answer taken whole held more of the goal's words than its list did, and the query that names the page was
    /// kept. A site matches a word by its stem, and an answer that lists twenty things is a list.
    #[test]
    fn a_list_that_says_the_words_stem_says_the_word() {
        let asked = vec!["surfing".to_string()];
        let edges: Vec<serde_json::Value> = (0..20).map(|i| serde_json::json!({ "node": { "title": format!("Surf God's Revenge {i}"), "url": format!("https://www.video.example/video/x{i}") } })).collect();
        let mut search = walked("POST", "https://search.video.example/v1", &serde_json::json!({ "data": { "search": { "videos": { "edges": edges } } } }).to_string(), false);
        search.request_body = Some(r#"{"operationName":"SEARCH","variables":{"query":"surfing","page":1}}"#.into());
        assert!(!never_says_a_word(&search, &asked));
        assert_eq!(fails_goal(&search, "search videos", "https://www.video.example/search/surfing/videos", &asked, "", &Trace { exchanges: vec![search.clone()], inputs: vec![] }), None);
        let other = walked("GET", "https://www.video.example/api/featured", r#"{"items":[{"title":"Players will not face charges"},{"title":"Weather"}]}"#, false);
        assert!(never_says_a_word(&other, &asked));
        assert!(never_says_a_word(&other, &["lamp".to_string()]), "a short word has no stem shorter than itself");
    }

    /// The walk that exposed it: a video site that allows twenty searches and then answers its own page's search
    /// with "Maximum attempts reached". The page drew no results, a strip of featured videos was kept as the search,
    /// and every later search was handed that strip. The site's refusal of the page's own ask is the learn's answer.
    #[test]
    fn a_page_whose_own_ask_the_site_refused_teaches_nothing() {
        let page = "https://www.video.example/search/surfing/videos";
        let ask = |body: &str| {
            let mut e = walked("POST", "https://search.video.example/v1", body, false);
            e.request_body = Some(r#"{"variables":{"query":"surfing"}}"#.into());
            e
        };
        let limited = ask(r#"{"data":{"search":{"id":"x","videos":null,"__typename":"Search"}},"errors":[{"message":"Maximum attempts reached. Please try again later."}]}"#);
        let featured = walked("POST", "https://api.video.example/v1", r#"{"data":{"featuredVideos":{"edges":[{"node":{"title":"a"}}]}}}"#, false);
        let refused = the_pages_ask_was_refused(&Trace { exchanges: vec![featured.clone(), limited.clone()], inputs: vec![] }, page, "video.example");
        assert!(refused.is_some_and(|w| w.contains("surfing") && w.contains("Maximum attempts")));
        // Asked again and answered, the page was answered: one refusal beside it settles nothing.
        let answered = ask(r#"{"data":{"search":{"videos":{"edges":[{"node":{"title":"Surf"}}]}}}}"#);
        assert_eq!(the_pages_ask_was_refused(&Trace { exchanges: vec![limited.clone(), answered], inputs: vec![] }, page, "video.example"), None);
        // Another site's call that failed is not the page's ask.
        let mut theirs = limited.clone();
        theirs.url = url::Url::parse("https://ads.example/v1").unwrap();
        assert_eq!(the_pages_ask_was_refused(&Trace { exchanges: vec![theirs, featured], inputs: vec![] }, page, "video.example"), None);
        // The walk that exposed it: a docs site whose search is another host's widget, its loader named in the page.
        // The widget's call was told "unusual traffic", inside a callback, and the caller heard only that the page
        // needs typing. A host the page itself names is the page's.
        let doc = walked("GET", "https://docs.example/search/?q=ingress", r#"<html><body><script src="https://widget.example/loader.js?cx=1"></script><div id="results"></div></body></html>"#, true);
        let mut widget = walked("GET", "https://widget.example/element/v1?q=ingress&callback=api123", r#"/*O_o*/ api123({"error":{"code":429,"message":"Our systems have detected unusual traffic from your network."}});"#, false);
        widget.resource_type = Some("Script".into());
        let told = the_pages_ask_was_refused(&Trace { exchanges: vec![doc, widget], inputs: vec![] }, "https://docs.example/search/?q=ingress", "docs.example");
        assert!(told.is_some_and(|w| w.contains("ingress") && w.contains("unusual traffic")));
        // The site's own script may be what names the widget's host, the page's markup holding only its tag.
        let bare = walked("GET", "https://docs.example/search/?q=ingress", "<html><body><widget:results></widget:results></body></html>", true);
        let mut code = walked("GET", "https://docs.example/js/main.js", r#"load("https://widget.example/loader.js?cx=1")"#, false);
        code.resource_type = Some("Script".into());
        let mut again = walked("GET", "https://widget.example/element/v1?q=ingress&callback=api123", r#"api123({"error":{"code":429,"message":"unusual traffic"}});"#, false);
        again.resource_type = Some("Script".into());
        assert!(the_pages_ask_was_refused(&Trace { exchanges: vec![bare, code, again], inputs: vec![] }, "https://docs.example/search/?q=ingress", "docs.example").is_some());
    }

    /// The walk that exposed it: a stays search whose page tells an advertising service, on another site, that the
    /// page was opened, with the page's title and the caller's word in the address of that call. On one walk nothing
    /// better stood, the call was picked "by the rule" with the engine's own reason that it held none of the goal's
    /// fields, and every caller was handed its three kilobytes of script as the search's answer. A call to another
    /// site that lists nothing and holds nothing of what was asked for was told about the page. It answers nothing.
    #[test]
    fn another_sites_call_that_lists_nothing_was_told_about_the_page_and_answers_nothing() {
        let page = "https://www.stay.example/s/lamps/homes?s=lamps";
        let asked = vec!["lamps".to_string()];
        let told = walked("GET", "https://ads.elsewhere.example/conversion/1/?s=lamps&title=Lamps%20%7C%20Stay", r#"{"ok":1,"id":"abc"}"#, false);
        let trace = Trace { exchanges: vec![told.clone()], inputs: vec![] };
        let why = fails_goal(&told, "search stays", page, &asked, "", &trace);
        assert!(why.as_deref().is_some_and(|w| w.contains("another site's call")), "{why:?}");
        // A search service on another site that lists what it found is the page's search, and stands.
        let found = walked("GET", "https://search.elsewhere.example/v2?q=lamps", r#"{"results":[{"title":"Lamps by the sea","price":"$90","url":"https://www.stay.example/h/1"},{"title":"Lamps house","price":"$70","url":"https://www.stay.example/h/2"},{"title":"Old lamps loft","price":"$60","url":"https://www.stay.example/h/3"}]}"#, false);
        let trace = Trace { exchanges: vec![found.clone()], inputs: vec![] };
        let why = fails_goal(&found, "search stays", page, &asked, "", &trace);
        assert!(!why.as_deref().is_some_and(|w| w.contains("another site's call")), "{why:?}");
        // The page's own site answering with little is judged by the other readers, not this one.
        let own = walked("GET", "https://www.stay.example/api/ping?s=lamps", r#"{"ok":1,"id":"abc"}"#, false);
        let trace = Trace { exchanges: vec![own.clone()], inputs: vec![] };
        assert!(!fails_goal(&own, "search stays", page, &asked, "", &trace).as_deref().is_some_and(|w| w.contains("another site's call")));
    }

    /// The walk that exposed it: a shop's search was learned and the site answered two words differently, so the
    /// route heard its caller. The second look, minutes and many asks later, probed it again and got one short page
    /// for both words. The route was marked deaf, no later word was sent to it, and each walked the page into the
    /// site's check. What the site showed once is not unshown by a probe it answered alike.
    #[test]
    fn a_route_the_site_showed_hears_is_not_made_deaf_by_a_later_probe() {
        let heard = store::Heard { probed: true, ..Default::default() };
        let said_back = store::Heard { probed: true, said_back: Some("lamps".into()), ..Default::default() };
        let deaf = store::Heard { probed: true, deaf: vec!["q".into()], ..Default::default() };
        let unasked = store::Heard::default();
        assert_eq!(heard_after(&heard, &deaf), heard);
        assert_eq!(heard_after(&said_back, &deaf), said_back);
        // Never shown to hear, and the second look finds it deaf: deaf.
        assert_eq!(heard_after(&unasked, &deaf), deaf);
        assert_eq!(heard_after(&deaf, &deaf), deaf);
        // Deaf at first and heard on the second look: the later word, which is evidence of hearing.
        assert_eq!(heard_after(&deaf, &said_back), said_back);
        // A second look that did not ask leaves the first's word.
        assert_eq!(heard_after(&said_back, &unasked), said_back);
    }

    /// The walk that exposed it: a shop whose page asks its own address for the results, and the site answered that
    /// call with nothing but the address of its check, where the walk was then sent. The page drew its header and
    /// footer, that shell was kept as the search, and every later search was handed it with `ok`. A call answered
    /// with the way to the site's check was refused, in whatever words: the learn says the check stood in the way.
    #[test]
    fn a_page_whose_own_ask_was_sent_to_the_sites_check_teaches_nothing() {
        let page = "https://www.shop.example/find/lamps/?q=lamps";
        let ask = |body: &str| walked("GET", "https://www.shop.example/find/lamps/?data=true&q=lamps", body, false);
        let sent = ask(r#"{"state":["HELD"],"data":{"go":"https://www.shop.example:443/find/lamps/hold/on?t=abc"}}"#);
        let door = r#"<html><head><title>One moment</title><script src="/hold.js"></script></head><body><p>Please wait.</p></body></html>"#;
        let check = walked("GET", "https://www.shop.example/find/lamps/hold/on?t=abc", door, false);
        let refused = the_pages_ask_was_refused(&Trace { exchanges: vec![sent.clone(), check.clone()], inputs: vec![] }, page, "shop.example");
        assert!(refused.is_some_and(|w| w.contains("lamps") && w.contains("check")));
        // The same answer where the walk never went there, or went to a page of the site that is no check, refused nothing.
        assert_eq!(the_pages_ask_was_refused(&Trace { exchanges: vec![sent.clone()], inputs: vec![] }, page, "shop.example"), None);
        let plain = walked("GET", "https://www.shop.example/find/lamps/hold/on?t=abc", r#"<html><body><a href="/find/lamps/">Lamps</a><p>Forty lamps, sorted by price.</p></body></html>"#, false);
        assert_eq!(the_pages_ask_was_refused(&Trace { exchanges: vec![sent.clone(), plain], inputs: vec![] }, page, "shop.example"), None);
        // The site said a failure code beside the address: refused, whether or not the walk went there.
        let coded = ask(r#"{"ret":["FAIL_SYS_USER_VALIDATE","GATE7_ERROR::SM::busy"],"data":{"url":"https://www.shop.example:443/find/lamps/hold/on?t=abc","size":{"w":"420"}},"size":{"w":"420"}}"#);
        let refused = the_pages_ask_was_refused(&Trace { exchanges: vec![coded.clone()], inputs: vec![] }, page, "shop.example");
        assert!(refused.is_some_and(|w| w.contains("lamps") && w.contains("FAIL_SYS_USER_VALIDATE")));
        // Asked again and answered with results, the page was answered.
        let answered = ask(r#"{"items":[{"name":"Lamp","price":"12.00"}]}"#);
        assert_eq!(the_pages_ask_was_refused(&Trace { exchanges: vec![sent, check, answered], inputs: vec![] }, page, "shop.example"), None);
    }

    /// A page's own ask answered with a failure code and the address of the site's check page is a check to pass
    /// (`Outcome::Challenge`), not a page that "needs clicks or typing" — even when no check document loaded in the
    /// walk, the check lives at the named address. General: read from `answer::check_url`; the site is a fixture.
    #[test]
    fn a_call_answered_with_a_failure_code_naming_its_check_page_is_a_check() {
        let url = "https://www.shop.example/find/lamps/?q=lamps";
        let walled = walked(
            "GET",
            "https://www.shop.example/find/lamps/?data=true&q=lamps",
            r#"{"ret":["FAIL_SYS_USER_VALIDATE","GATE7_ERROR::SM::busy"],"data":{"url":"https://www.shop.example/find/lamps/hold/on?t=abc"}}"#,
            false,
        );
        let refused = Unlearned::Hands("the site refused the page's own call for \"lamps\": FAIL_SYS_USER_VALIDATE".to_string());
        let got = stood_in_the_way(&Trace { exchanges: vec![walled], inputs: vec![] }, url, refused);
        assert!(matches!(got, Unlearned::Check(_, "answer.check_url")), "{got}");
        // A healthy answer with records is no check: it stays what it was.
        let ok = walked("GET", "https://www.shop.example/find/lamps/?data=true&q=lamps", r#"{"items":[{"name":"Lamp","price":"12.00"}]}"#, false);
        assert!(matches!(stood_in_the_way(&Trace { exchanges: vec![ok], inputs: vec![] }, url, Unlearned::Hands("x".into())), Unlearned::Hands(_)));
    }

    /// A walk stopped by a check that serves itself — a document that runs a script, asks nothing, links nowhere on its
    /// site and says a few lines — is a check to pass (`Outcome::Challenge`), not a page that needs clicks. The check may
    /// be the walk's last document, or an earlier one the walk ended on before the site answered "access denied": both
    /// are in the walk's door stretch, and a walk let through to a page of the site is neither.
    #[test]
    fn a_walk_stopped_by_a_check_that_serves_itself_is_a_check() {
        let url = "https://www.shop.example/find/lamps/?q=lamps";
        let check = walked(
            "GET",
            url,
            r#"<html><head><title>One moment</title><script src="/hold.js"></script></head><body><p>Please wait.</p></body></html>"#,
            true,
        );
        // The check alone: the last document is the check, read by the one reader of a page that asks for something.
        let got = stood_in_the_way(&Trace { exchanges: vec![check.clone()], inputs: vec![] }, url, Unlearned::Hands("x".into()));
        assert!(matches!(&got, Unlearned::Check(_, "challenge.asks_a_person")), "{got}");
        assert_eq!(got.outcome().0, crate::outcome::Outcome::Challenge);
        // The check, then the site's "access denied" page: the check is still the door the walk was stopped at.
        let denied = walked("GET", url, "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1><a href=\"/\">Go home</a></body></html>", true);
        let stopped_trace = Trace { exchanges: vec![check, denied], inputs: vec![] };
        assert_eq!(stopped_trace.door("shop.example"), vec![0], "the check is the walk's door");
        let stopped = stood_in_the_way(&stopped_trace, url, Unlearned::Hands("x".into()));
        assert!(matches!(&stopped, Unlearned::Check(_, "trace.door")), "{stopped}");
        assert_eq!(stopped.outcome().0, crate::outcome::Outcome::Challenge);
        // A walk let through to a page of the site is no check, whatever it passed on the way.
        let through = walked("GET", url, "<html><body><a href=\"/lamps/1\">Brass lamp</a><p>Forty lamps, sorted by price.</p></body></html>", true);
        let page = stood_in_the_way(&Trace { exchanges: vec![walked("GET", url, "<html><head><script src=\"/hold.js\"></script></head><body><p>Wait.</p></body></html>", true), through], inputs: vec![] }, url, Unlearned::Hands("x".into()));
        assert!(matches!(page, Unlearned::Hands(_)), "{page}");
    }

    /// A check that serves itself is a door on the route, with no vendor's mark: `Unknown`, its pass earned by its own
    /// code (`Earn::Recompute`, since nothing device-bound marks it), standing at the address the walk met it at.
    /// What the door took is said once, before any call is a candidate: each call it took with why, and assets only
    /// counted, so a learn that kept nothing shows where its calls went (the x-ray's pick reads this line).
    #[test]
    fn the_eye_says_what_the_door_took_and_why() {
        let url = "https://www.shop.example/lamps";
        let mut refused = walked("GET", url, "<html><body>Forbidden</body></html>", true);
        refused.status = 403;
        let ping = walked("POST", "https://www.shop.example/.check/ping", "{}", false);
        let mut script = walked("GET", "https://www.shop.example/.check/c.js", "var a=1;", false);
        script.resource_type = Some("Script".into());
        script.response_mime = "text/javascript".into();
        let page = walked("GET", url, "<html><body><h1>Lamps</h1><a href=\"/lamps/1\">Brass lamp</a></body></html>", true);
        let api = walked("GET", "https://www.shop.example/api/lamps", r#"{"lamps":[]}"#, false);
        let trace = Trace { exchanges: vec![refused, ping, script, page, api], inputs: vec![] };
        let Some(Eye::Door { walk, took, assets, calls }) = door_taken("w1", &trace, "shop.example") else { panic!("the door took calls") };
        assert_eq!((walk.as_str(), took, assets), ("w1", 3, 1));
        let said: Vec<(usize, &str, &str, &str, usize)> = calls.iter().map(|c| (c.index, c.method.as_str(), c.path.as_str(), c.why, c.by)).collect();
        assert_eq!(said, vec![(0, "GET", "/lamps", "refused", 0), (1, "POST", "/.check/ping", "refused", 0)]);
        let through = Trace { exchanges: trace.exchanges[3..].to_vec(), inputs: vec![] };
        assert!(door_taken("w2", &through, "shop.example").is_none(), "nothing taken, nothing said");
    }

    #[test]
    fn a_check_that_serves_itself_is_a_door_of_unknown_kind() {
        let url = "https://www.shop.example/find/lamps/?q=lamps";
        let check = walked("GET", url, r#"<html><head><title>One moment</title><script src="/hold.js"></script></head><body><p>Please wait.</p></body></html>"#, true);
        let met = unbrowse_learn::graph::Door::met(&Trace { exchanges: vec![check], inputs: vec![] }, "shop.example").expect("a door");
        assert_eq!(met.kind, unbrowse_learn::graph::DoorKind::Unknown);
        assert_eq!(met.earn, unbrowse_learn::graph::Earn::Recompute);
        assert_eq!(met.at.as_deref(), Some(url));
        // A bare refusal names no page to run, and stays the site's own answer.
        let refused_page = walked("GET", url, "<html><body><h1>Forbidden</h1></body></html>", true);
        let mut refused = refused_page.clone();
        refused.status = 403;
        assert!(unbrowse_learn::graph::Door::met(&Trace { exchanges: vec![refused], inputs: vec![] }, "shop.example").is_none());
    }

    /// A walk whose own ask a check walled (an on-site call answered with a failure code naming its check page) takes
    /// in the owner's browser session — the same primitive a sign-in uses, since the owner's live session may carry
    /// the site's clearance cookie. A healthy answer, or an off-site check, triggers no import.
    #[test]
    fn a_walk_walled_by_a_check_takes_the_owners_session() {
        let walled = walked("GET", "https://www.shop.example/find/lamps/?data=true&q=lamps", r#"{"ret":["FAIL_SYS_USER_VALIDATE"],"data":{"url":"https://www.shop.example/find/lamps/hold/on?t=abc"}}"#, false);
        assert!(walk_met_a_clearable_check(&Trace { exchanges: vec![walled], inputs: vec![] }, "shop.example"));
        let ok = walked("GET", "https://www.shop.example/find/lamps/?data=true&q=lamps", r#"{"items":[{"name":"Lamp","price":"12.00"}]}"#, false);
        assert!(!walk_met_a_clearable_check(&Trace { exchanges: vec![ok], inputs: vec![] }, "shop.example"));
        let offsite = walked("GET", "https://cdn.other.example/v?q=lamps", r#"{"ret":["FAIL_SYS_USER_VALIDATE"],"data":{"url":"https://cdn.other.example/punish"}}"#, false);
        assert!(!walk_met_a_clearable_check(&Trace { exchanges: vec![offsite], inputs: vec![] }, "shop.example"));
    }

    /// The walk that exposed it: a server search whose call carried an installation id from an earlier call's answer.
    /// Two walks showed the page's own headers were the session's, so nothing of the page rode on the route and the
    /// trial that tries a call alone was never run: the route kept the earlier call, whose answer hands the id over
    /// once and not again, and every call failed. A chain that does not answer as built is tried shorter, whether or
    /// not the page signs it.
    #[test]
    fn a_chain_that_does_not_answer_is_tried_shorter_though_no_page_signs_it() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://chat.example/api/experiments", "needs_browser": false, "fields": [] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://chat.example/api/servers/search?query={query}", "needs_browser": false,
                  "fields": [
                    { "loc": { "in": "query", "key": "query" }, "class": "input", "name": "query", "secret": false, "default": "gaming" },
                    { "loc": { "in": "header", "key": "x-installation-id" }, "class": "derived", "origin": { "exchange": 0, "url": "https://chat.example/api/experiments", "at": { "from": "json", "pointer": "/installation" } } }
                  ] }
            ]
        }))
        .unwrap();
        let route = || Route::from_graph("r".into(), "search servers".into(), "https://chat.example/servers?query=gaming".into(), graph.clone()).unwrap();
        let none = Trace { exchanges: vec![], inputs: vec![] };
        // The site answers the call by itself and no longer hands the id over: the chain fails, the call alone answers.
        let mut site = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.len() == 1;
        let out = mint_trial(route(), &none, &mut site);
        assert_eq!(out.graph.steps.len(), 1);
        assert!(out.graph.steps[0].fields.iter().all(|f| f.loc != unbrowse_learn::Loc::Header("x-installation-id".into())));
        // A chain that answers as built is left as built, and asked once.
        let mut asks = 0;
        let mut answers_whole = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            asks += 1;
            true
        };
        assert_eq!(mint_trial(route(), &none, &mut answers_whole).graph.steps.len(), 2);
        assert_eq!(asks, 1);
    }

    /// The walk that exposed it: a search engine sent the walk's browser to its captcha page, nothing on that page
    /// took the search word, and the page itself was kept as the route for the search. A page that asks for a person
    /// is the site's check and is never picked; a results page that happens to say the word is not one.
    #[test]
    fn a_page_that_asks_for_a_person_is_never_the_answer() {
        let asked = vec!["weather".to_string()];
        let check = walked("GET", "https://www.find.example/captcha/?from=%2Fweb%3Fquery%3Dweather", "<html><head><title>Verify</title></head><body><p>Please enter the captcha to continue.</p><form><input name=code><a href='/help'>Help with this check</a></form></body></html>", true);
        let trace = Trace { exchanges: vec![check.clone()], inputs: vec![] };
        assert!(fails_goal(&check, "search the web", "https://www.find.example/web?query=weather", &asked, "", &trace).is_some_and(|why| why.contains("asks for a person")));
        let results: String = (0..40).map(|i| format!("<li><a href='/r/{i}'>Weather report number {i} for the week ahead in the city</a></li>")).collect();
        let page = walked("GET", "https://www.find.example/web?query=weather", &format!("<html><head><title>weather - Find</title></head><body><ul>{results}</ul></body></html>"), true);
        let trace = Trace { exchanges: vec![page.clone()], inputs: vec![] };
        assert!(!fails_goal(&page, "search the web", "https://www.find.example/web?query=weather", &asked, "", &trace).is_some_and(|why| why.contains("asks for a person")));
    }

    /// The walk that exposed it: a hotel site whose search call sends a query's text and an app's version that its
    /// page spells out. The route read them off the page on every call, and the site answers a plain request for
    /// that page with a wall, so no variant of the route could run plain. Tried without the page, what it took from
    /// it sent as the walk sent it: a site that answers needed the call, not the page.
    #[test]
    fn a_chain_is_tried_without_the_pages_it_reads() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://stay.example/en/search/?query={query}",
            "scripts": [{ "url": "https://stay.example/app.js", "body": "headers['trace']=id()" }],
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://stay.example/en/search/?query={query}", "needs_browser": false,
                  "fields": [{ "loc": { "in": "query", "key": "query" }, "class": "input", "name": "query", "secret": false, "default": "paris" }] },
                { "exchange": 1, "method": "GET", "status": 200, "url": "https://stay.example/graphql?app={app}&q={q}", "needs_browser": true, "page_signed": true,
                  "page_producers": [{ "loc": { "in": "header", "key": "trace" }, "producer": { "script": "https://stay.example/app.js", "at": 1 } }],
                  "fields": [
                    { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "query", "secret": false, "default": "paris" },
                    { "loc": { "in": "query", "key": "app" }, "class": "derived", "origin": { "exchange": 0, "url": "https://stay.example/en/search/", "at": { "from": "text", "before": "appVersion\":\"", "after": "\"", "nth": 0 } } }
                  ] }
            ]
        }))
        .unwrap();
        let route = || {
            let mut r = Route::from_graph("r".into(), "search hotels".into(), "https://stay.example/en/search/?query=paris".into(), graph.clone()).unwrap();
            r.browser_assisted = true;
            r
        };
        let page = walked("GET", "https://stay.example/en/search/?query=paris", r#"<html><script>{"appVersion":"dx-shop:1154713"}</script></html>"#, true);
        let call = walked("GET", "https://stay.example/graphql?app=dx-shop:1154713&q=paris", r#"{"data":{"hotels":[{"name":"a"},{"name":"b"}]}}"#, false);
        let trace = Trace { exchanges: vec![page, call], inputs: vec![] };
        // The site walls the page and answers the call.
        let mut site = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.len() == 1;
        let out = mint_trial(route(), &trace, &mut site);
        assert_eq!(out.graph.steps.len(), 1, "the page is left out");
        assert!(!out.browser_assisted);
        assert!(out.graph.steps[0].fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Query("app".into()) && matches!(&f.class, unbrowse_learn::graph::Class::Unconfirmed { value } if value == "dx-shop:1154713")));
        // The call by itself, where a step between still fails: what it took from that step is sent as walked too.
        let mut only_alone = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.len() == 1 && g.steps[0].url.contains("/graphql");
        assert_eq!(the_call_as_walked(&route().graph, &trace).map(|g| g.steps.len()), Some(1));
        assert_eq!(mint_trial(route(), &trace, &mut only_alone).graph.steps.len(), 1);
        // A site that refuses the bare call too keeps the route as it was.
        let mut walls_all = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| false;
        assert_eq!(mint_trial(route(), &trace, &mut walls_all).graph.steps.len(), 2);
    }

    /// The walk that exposed it: a hotel search whose trial asked for "parisx". The site's place lookup answered
    /// "Not Found", which is true, and the trial took it for a refusal. A word is moved by its case: other bytes, the
    /// same search. A value with no case to change still gets a letter.
    #[test]
    fn a_word_is_moved_by_its_case() {
        assert_eq!(recased("paris").as_deref(), Some("Paris"));
        assert_eq!(recased("New York").as_deref(), Some("new York"));
        assert_eq!(recased("5g phones").as_deref(), Some("5G phones"));
        assert_eq!(recased("天気"), None);
        assert_eq!(recased("2027"), None);
    }

    /// A call whose authorization an earlier step earned is not tried without that step: the site can only refuse
    /// it, and a site that counts its asks has one fewer left for the call that matters.
    #[test]
    fn a_call_is_not_tried_without_the_authorization_a_step_earned() {
        let graph = |header: &str| -> unbrowse_learn::Graph {
            serde_json::from_value(serde_json::json!({
                "provisional": false,
                "steps": [
                    { "exchange": 0, "method": "POST", "status": 200, "url": "https://auth.video.example/token", "needs_browser": false, "fields": [] },
                    { "exchange": 1, "method": "POST", "status": 200, "url": "https://search.video.example/v1", "needs_browser": false,
                      "fields": [{ "loc": { "in": "header", "key": header }, "class": "derived", "origin": { "exchange": 0, "url": "https://auth.video.example/token", "at": { "from": "json", "pointer": "/access_token" } } }] }
                ]
            }))
            .unwrap()
        };
        let none = Trace { exchanges: vec![], inputs: vec![] };
        assert!(the_call_alone(&graph("Authorization")).is_none() && the_least_chain(&graph("authorization"), &none).is_none());
        assert!(the_call_alone(&graph("x-installation")).is_some_and(|g| g.steps.len() == 1), "another header an earlier step filled is still left out");
    }

    /// The walk that exposed it: a paper index whose page is `/search/searchresult.jsp?queryText=robotics` and whose
    /// call is `POST /rest/search`. The page's address says "search", the call's path says it too, and the route
    /// offered its caller the word as a value. Asked for `/rest/<a word nobody uses>` the site has no such call;
    /// asked for a made-up query it still answers. The piece is where the call lives.
    #[test]
    fn a_path_piece_the_call_cannot_do_without_is_its_address() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200, "url": "https://papers.example/rest/{path[1]}?queryText={queryText}", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "path", "key": 0 }, "class": "constant", "value": "rest" },
                    { "loc": { "in": "path", "key": 1 }, "class": "input", "name": "part0", "secret": false, "default": "search" },
                    { "loc": { "in": "query", "key": "queryText" }, "class": "input", "name": "queryText", "secret": false, "default": "robotics" }
                ]
            }]
        }))
        .unwrap();
        let route = || Route::from_graph("r".into(), "search papers".into(), "https://papers.example/search/searchresult.jsp?queryText=robotics".into(), graph.clone()).unwrap();
        // The site: no call at a made-up path, an answer for a made-up query.
        let mut site = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| i.get("part0").map(String::as_str) == Some("search");
        let out = the_calls_address_with(route(), &mut site);
        assert_eq!(out.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["queryText"]);
        assert!(matches!(&out.graph.steps[0].fields[1].class, unbrowse_learn::graph::Class::Constant { value, .. } if value == "search"));
        assert_eq!(out.graph.steps[0].url, "https://papers.example/rest/search?queryText={queryText}");
        // A site that answers a made-up piece takes it as a value; one that fails any made-up word says nothing.
        let mut takes_both = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| true;
        assert_eq!(the_calls_address_with(route(), &mut takes_both).inputs.len(), 2);
        let mut fails_all = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| !i.values().any(|v| v == NOBODYS_WORD);
        assert_eq!(the_calls_address_with(route(), &mut fails_all).inputs.len(), 2);
    }

    /// The walk that exposed it: a games site whose search page lists a hundred and fifty links for a word, and whose
    /// suggestions call answers the same word with five games. Both answer a second word, the suggestions call was
    /// named the answer, and it took the page's place. What each lists is held against the other first.
    #[test]
    fn a_call_that_lists_far_less_does_not_take_the_place_of_one_that_answers() {
        let page = serde_json::json!({ "title": "Search", "text": "…", "links": (0..150).map(|i| serde_json::json!({ "text": format!("game {i}"), "url": format!("/g/{i}") })).collect::<Vec<_>>() });
        let suggestions = serde_json::json!({ "games": (0..5).map(|i| serde_json::json!({ "name": format!("game {i}") })).collect::<Vec<_>>(), "jams": [], "tags": ["a", "b"] });
        assert_eq!((things_in(&page), things_in(&suggestions)), (150, 5));
        assert!(lists_far_less(Some(5), Some(150)));
        assert!(!lists_far_less(Some(24), Some(1)), "a config beside the products is the one replaced");
        assert!(!lists_far_less(Some(20), Some(24)) && !lists_far_less(Some(2), Some(4)));
        assert!(!lists_far_less(None, Some(150)) && !lists_far_less(Some(5), None));
    }

    /// The walk that exposed it: a server search whose call carried an installation id from an earlier call's answer
    /// and a tracing header the page writes. Asked plainly the site answers the search by itself, but the trial kept
    /// the earlier call, could not source the id again, and never asked. The call is tried alone; a site that needs
    /// the id keeps its chain.
    #[test]
    fn a_read_whose_headers_earlier_steps_filled_is_tried_alone() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let route = || {
            let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
                "provisional": false,
                "page": "https://chat.example/servers?query={query}",
                "scripts": [{ "url": "https://chat.example/app.js", "body": "headers['trace']=id()" }],
                "steps": [
                    { "exchange": 0, "method": "GET", "status": 200, "url": "https://chat.example/api/experiments", "needs_browser": false, "fields": [] },
                    { "exchange": 1, "method": "GET", "status": 200, "url": "https://chat.example/api/servers/search?query={query}", "needs_browser": true, "page_signed": true,
                      "page_producers": [{ "loc": { "in": "header", "key": "trace" }, "producer": { "script": "https://chat.example/app.js", "at": 1 } }],
                      "fields": [
                        { "loc": { "in": "query", "key": "query" }, "class": "input", "name": "query", "secret": false, "default": "minecraft" },
                        { "loc": { "in": "header", "key": "x-installation-id" }, "class": "derived", "origin": { "exchange": 0, "url": "https://chat.example/api/experiments", "at": { "from": "json", "pointer": "/fingerprint" } } }
                      ] }
                ]
            }))
            .unwrap();
            Route::from_graph("r".into(), "search servers".into(), "https://chat.example/servers?query=minecraft".into(), graph).unwrap()
        };
        let trace = || Trace { exchanges: vec![], inputs: vec![] };
        // The site answers the search whenever it is asked by itself; the chain cannot be made again.
        let mut alone = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| g.steps.len() == 1;
        let out = mint_trial(route(), &trace(), &mut alone);
        assert_eq!((out.graph.steps.len(), out.steps, out.plain_trial), (1, 1, Some(true)));
        assert!(!out.graph.steps[0].is_page_signed() && !out.graph.steps[0].fields.iter().any(|f| matches!(f.loc, unbrowse_learn::Loc::Header(_))));
        // A site that never answers the bare call keeps what it had.
        let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| false;
        assert_eq!(mint_trial(route(), &trace(), &mut never).graph.steps.len(), 2);
    }

    /// The walk that exposed it: a recipe search at `/search/<word>-`. One word shows nothing of how two are written;
    /// the site, asked the word twice over each way, answers only the dashed one with results of its own.
    #[test]
    fn two_words_go_into_the_address_the_way_the_site_answers_them() {
        let _old = crate::learn::own_asks::as_the_old_node();
        use unbrowse_learn::graph::Written;
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200, "url": "https://www.recipes.example/search/{path[1]}", "needs_browser": false,
                "held": [{ "loc": { "in": "path", "key": 1 }, "input": "search", "sits": "chicken", "written": "plain" }],
                "fields": [{ "loc": { "in": "path", "key": 1 }, "class": "constant", "value": "chicken-", "origin": null }]
            }]
        }))
        .unwrap();
        let mut route = Route::from_graph("r".into(), "search recipes".into(), "https://www.recipes.example/search/chicken-".into(), graph).unwrap();
        route.inputs = vec![store::RouteInput { name: "search".into(), secret: false, default: Some("chicken".into()), file: false, optional: false, options: Vec::new() }];
        let page = |rows: &str| Some(serde_json::json!({ "text": (0..20).map(|n| format!("{rows} {n}")).collect::<Vec<_>>().join("\n") }));
        let mut dashes = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| match (g.steps[0].held[0].written, i["search"].as_str()) {
            (Written::Dashed, "chicken chicken") => page("roast chicken recipe"),
            _ => page("nothing matched, try these"),
        };
        assert_eq!(spaced_with(route.clone(), "", &mut dashes).graph.steps[0].held[0].written, Written::Dashed);
        // A site that answers the escaped space keeps it, and one that answers no writing is left as learned.
        let mut escaped = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| if i["search"] == "chicken chicken" { page("roast chicken recipe") } else { page("nothing matched, try these") };
        assert_eq!(spaced_with(route.clone(), "", &mut escaped).graph.steps[0].held[0].written, Written::Plain);
        let mut none = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| page("nothing matched, try these");
        assert_eq!(spaced_with(route.clone(), "", &mut none).graph.steps[0].held[0].written, Written::Plain);
        // A piece that is the word itself (`/tag/<word>/`), on a site with no page at all for a word it does not
        // know: asked the same way, and the piece becomes the walked word with the caller's held in it.
        let mut whole = route;
        whole.graph.steps[0].held.clear();
        whole.graph.steps[0].fields = vec![unbrowse_learn::Field { loc: unbrowse_learn::Loc::Path(1), class: unbrowse_learn::Class::Input { name: "search".into(), secret: false, default: Some("chicken".into()), optional: false } }];
        let mut tags = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| match (g.steps[0].held.first().map(|h| h.written), i["search"].as_str()) {
            (Some(Written::Dashed), "chicken chicken") => page("roast chicken recipe"),
            _ => None,
        };
        let out = spaced_with(whole.clone(), "", &mut tags);
        assert_eq!(out.graph.steps[0].held.iter().map(|h| h.written).collect::<Vec<_>>(), [Written::Dashed]);
        // A site with no page for a made-up pair answers no writing of it: its own links say how it joins words.
        let mut no_such_tag = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| None;
        let links = r#"<a href="/search/rice-cooker/">Rice cookers</a> <a href="/search/phone-case/">Cases</a> <a href="/search/lamp/">Lamps</a>"#;
        let out = spaced_with(whole.clone(), links, &mut no_such_tag);
        assert_eq!(out.graph.steps[0].held.iter().map(|h| h.written).collect::<Vec<_>>(), [Written::Dashed]);
        assert!(spaced_with(whole, r#"<a href="/search/lamp/">Lamps</a>"#, &mut no_such_tag).graph.steps[0].held.is_empty(), "nothing shows it");
    }

    /// The walk that exposed it: a places search whose call sends the word as `q` and again inside a packed value,
    /// after a type mark. With only `q` moved the site still answers the walked word's places. The word is proposed
    /// there too and kept because the site then answers none of them; where the site answers the same either way,
    /// the run of letters was chance and the route is left alone.
    #[test]
    fn a_word_inside_a_packed_value_is_kept_where_the_site_hears_it() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{
                "exchange": 0, "method": "GET", "status": 200, "url": "https://maps.example/search?q={q}&pb=%211sramen%217i20", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "search", "secret": false, "default": "ramen" },
                    { "loc": { "in": "query", "key": "pb" }, "class": "constant", "value": "!1sramen!7i20", "origin": null }
                ]
            }]
        }))
        .unwrap();
        let route = Route::from_graph("r".into(), "search places".into(), "https://maps.example/maps/search/ramen".into(), graph).unwrap();
        let places = |kind: &str| Some(serde_json::json!({ "places": (0..20).map(|n| format!("{kind} house number {n}")).collect::<Vec<_>>() }));
        let packed = |g: &unbrowse_learn::Graph| !g.steps[0].held.is_empty();
        let mut reads_the_packed_word = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| if i["search"] == "ramen" || !packed(g) { places("noodle") } else { places("unrelated") };
        let kept = held_where_with(route.clone(), &mut reads_the_packed_word);
        assert_eq!(kept.graph.steps[0].held.len(), 1);
        assert_eq!(unbrowse_learn::graph::swapped("!1sramen!7i20", "ramen", "dim sum"), "!1sdim sum!7i20");
        let mut reads_only_q = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| if i["search"] == "ramen" { places("noodle") } else { places("unrelated") };
        assert!(held_where_with(route, &mut reads_only_q).graph.steps[0].held.is_empty());
    }

    /// The walk that exposed it: a hotel search whose call takes its operation from the page it was learned on, and
    /// which the walk also tied to a sensor's post and to an advert service that happened to answer with a number
    /// the call sends. The route carried all of them and failed when one did. The least chain is the page and the
    /// call; the number goes as the walk sent it; the site's answer decides.
    #[test]
    fn a_route_is_tried_with_only_the_steps_its_answer_needs() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [
                { "exchange": 0, "method": "GET", "status": 200, "url": "https://www.stay.example/search?dest={dest}", "needs_browser": false,
                  "fields": [{ "loc": { "in": "query", "key": "dest" }, "class": "input", "name": "dest", "secret": false, "default": "paris" }] },
                { "exchange": 1, "method": "POST", "status": 200, "url": "https://www.stay.example/_s/report", "needs_browser": false, "fields": [] },
                { "exchange": 2, "method": "POST", "status": 200, "url": "https://ads.example/deliver", "needs_browser": false, "fields": [] },
                { "exchange": 3, "method": "POST", "status": 200, "url": "https://www.stay.example/query/{path[1]}", "needs_browser": false,
                  "body": { "kind": "json", "template": { "distance": null, "dest": null }, "types": { "/distance": "number", "/dest": "string" } },
                  "fields": [
                    { "loc": { "in": "path", "key": 1 }, "class": "derived", "origin": { "exchange": 0, "url": "https://www.stay.example/search", "at": { "from": "json", "pointer": "/props/signature" } } },
                    { "loc": { "in": "json", "key": "/dest" }, "class": "input", "name": "dest", "secret": false, "default": "paris" },
                    { "loc": { "in": "json", "key": "/distance" }, "class": "derived", "origin": { "exchange": 2, "url": "https://ads.example/deliver", "at": { "from": "text", "before": "\"d\":", "after": ",", "nth": 0 } } },
                    { "loc": { "in": "header", "key": "x-request-id" }, "class": "derived", "origin": { "exchange": 1, "url": "https://www.stay.example/_s/report", "at": { "from": "header", "name": "x-request-id" } } }
                  ] }
            ]
        }))
        .unwrap();
        let mut call = walked("POST", "https://www.stay.example/query/abc123", r#"{"hotels":[{"name":"a"}]}"#, false);
        call.request_body = Some(r#"{"distance":50,"dest":"paris"}"#.into());
        let least = the_least_chain(&graph, &Trace { exchanges: vec![call], inputs: Vec::new() }).expect("a shorter chain");
        assert_eq!(least.steps.iter().map(|s| s.exchange).collect::<Vec<_>>(), [0, 3]);
        let target = least.steps.last().unwrap();
        assert!(target.fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Json("/distance".into()) && f.class == unbrowse_learn::Class::Unconfirmed { value: "50".into() }));
        assert!(!target.fields.iter().any(|f| matches!(f.loc, unbrowse_learn::Loc::Header(_))));
        assert!(target.fields.iter().any(|f| matches!(f.class, unbrowse_learn::Class::Derived { .. })), "the page's own value is still read from the page");
    }

    /// The walk that exposed it: a shop's search call that sends `page=1` beside two flags that are also 1. Nothing on
    /// the walk turned the page. Asked with each moved, only the page answers with other records; and an offset that
    /// starts at zero moves by the number of records listed.
    #[test]
    fn a_counting_value_the_site_answers_the_next_of_is_how_a_route_reads_on() {
        let route = |query: &str| {
            let url = format!("https://www.shop.example/api/list?q=lamp&{query}");
            let call = walked("GET", &url, "{}", false);
            let trace = Trace { exchanges: vec![call], inputs: vec![unbrowse_learn::Input::new("q", "lamp")] };
            route_of(&trace, 0, "search the shop", "https://www.shop.example/search?q=lamp", true, &[], &[], None).unwrap()
        };
        let items = |from: u64| Some(serde_json::json!({ "items": (from..from + 10).map(|n| format!("brass lamp number {n}")).collect::<Vec<_>>() }));
        let sent = |g: &unbrowse_learn::Graph, key: &str| -> u64 {
            g.steps[0].fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query(key.into())).and_then(|f| match &f.class {
                unbrowse_learn::Class::Constant { value, .. } | unbrowse_learn::Class::Unconfirmed { value } => value.parse().ok(),
                unbrowse_learn::Class::Input { default: Some(v), .. } => v.parse().ok(),
                _ => None,
            }).unwrap_or(0)
        };
        let mut pages = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| items((sent(g, "page") - 1) * 10);
        let paged = read_on_with(route("ajax=true&page=1"), &mut pages);
        assert_eq!(paged.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }));
        assert!(paged.inputs.iter().any(|i| i.name == "page" && i.optional && i.default.as_deref() == Some("1")));
        let mut offsets = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| items(sent(g, "offset"));
        assert_eq!(read_on_with(route("offset=0"), &mut offsets).paging, Some(unbrowse_learn::paging::Paging::Count { input: "offset".into(), step: 10 }));
        // The walk that exposed it: a game site's search, 917 results, 24 to a page, its call sending no page at all
        // and its answer saying `"page": 1`. The answer's own name for the count is put to the site as the call's.
        let counted_in_the_answer = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            let page = sent(g, "page").max(1);
            Some(serde_json::json!({ "result": { "page": page, "numFound": 917, "results": ((page - 1) * 10..page * 10).map(|n| serde_json::json!({ "title": format!("brass lamp number {n}") })).collect::<Vec<_>>() } }))
        };
        let mut site = counted_in_the_answer;
        let by_answer = read_on_with(route("pageSize=24"), &mut site);
        assert_eq!(by_answer.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }));
        assert!(by_answer.inputs.iter().any(|i| i.name == "page" && i.optional && i.default.is_none()));
        // A site that ignores the name answers 1 again: nothing is offered.
        let mut ignores = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(serde_json::json!({ "result": { "page": 1, "results": (0..10).map(|n| serde_json::json!({ "title": format!("brass lamp number {n}") })).collect::<Vec<_>>() } }));
        assert_eq!(read_on_with(route("pageSize=24"), &mut ignores).paging, None);
        // The walk that exposed it: a help site's search, 79 results, ten to an answer, each answer handing over a
        // `page_handle` its call never sent. Sent back under its own name, it is how the list reads on.
        let mut hands_over = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            let at = g.steps[0].fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query("page_handle".into())).and_then(|f| match &f.class {
                unbrowse_learn::Class::Unconfirmed { value } => Some(value.clone()),
                _ => None,
            });
            let from: u64 = if at.is_some() { 10 } else { 0 };
            Some(serde_json::json!({ "total": 79, "page_handle": format!("ZnJvbT0xMCZhbGc9amV0cGFjay{from}"), "results": (from..from + 10).map(|n| serde_json::json!({ "title": format!("brass lamp number {n}") })).collect::<Vec<_>>() }))
        };
        let by_token = read_on_with(route("size=10"), &mut hands_over);
        assert_eq!(by_token.paging, Some(unbrowse_learn::paging::Paging::Token { input: "page_handle".into(), from: "/page_handle".into() }));
        // The walk that exposed it: a shop whose search sends two counters, one its older page read and one it reads
        // now. Asked with each moved by itself, the site answers to one: that one is how it reads on.
        let mut one_of_two = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| items(sent(g, "v2_index"));
        assert_eq!(read_on_with(route("index=0&v2_index=0"), &mut one_of_two).paging, Some(unbrowse_learn::paging::Paging::Count { input: "v2_index".into(), step: 10 }));
        // The walk that exposed it: a phone maker's shop walked for a word that finds one product. Nothing reads on
        // from one, so the question was never put. The second word the site answered finds forty, and is asked with.
        let mut few_for_the_walked = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
            if i.get("q").map(String::as_str) == Some("lamp") {
                return Some(serde_json::json!({ "items": ["the only brass lamp there is"] }));
            }
            items(sent(g, "offset"))
        };
        let mut heard_another = route("offset=0");
        heard_another.heard.said_back = Some("chandelier".into());
        assert_eq!(read_on_with(heard_another, &mut few_for_the_walked).paging, Some(unbrowse_learn::paging::Paging::Count { input: "offset".into(), step: 10 }));
        assert_eq!(read_on_with(route("offset=0"), &mut few_for_the_walked).paging, None, "with no second word, one record reads on nowhere");
        // The walk that exposed it: a fund search whose answer lists ten results beside eleven filters. The longest
        // list is the filters, and an offset moved by eleven skips a result on every page. The call says it asked
        // for ten, and the list of ten is the page.
        let mut with_filters = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            let from = sent(g, "first");
            Some(serde_json::json!({ "results": (from..from + 10).map(|n| serde_json::json!({ "title": format!("brass lamp number {n}") })).collect::<Vec<_>>(), "filters": (0..11).map(|n| format!("filter number {n} of the shop")).collect::<Vec<_>>() }))
        };
        assert_eq!(read_on_with(route("count=10&first=0"), &mut with_filters).paging, Some(unbrowse_learn::paging::Paging::Count { input: "first".into(), step: 10 }));
        // A tab beside the page: both list other records when moved, so neither is taken.
        let mut tabs = |g: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            let (tab, page) = (sent(g, "tab"), sent(g, "page"));
            items(tab * 1000 + (page - 1) * 10).map(|mut v| {
                v["total"] = serde_json::json!(if tab == 1 { 4820 } else { 317 });
                v
            })
        };
        assert_eq!(read_on_with(route("tab=1&page=1"), &mut tabs).paging, None, "two counting values: nothing says which reads on");
        // A way on already offered that the site answers the same for is taken back.
        let mut offered = route("ajax=true");
        offered.paging = Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 });
        offered.inputs.push(store::RouteInput { name: "page".into(), secret: false, default: None, file: false, optional: true, options: Vec::new() });
        let mut shell = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| items(0);
        let taken = read_on_with(offered.clone(), &mut shell);
        assert!(taken.paging.is_none() && !taken.inputs.iter().any(|i| i.name == "page"));
        let mut turns = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| items(i.get("page").and_then(|p| p.parse::<u64>().ok()).map_or(0, |p| (p - 1) * 10));
        assert!(read_on_with(offered, &mut turns).paging.is_some());
        let mut same = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| items(0);
        assert_eq!(read_on_with(route("ajax=true&page=1"), &mut same).paging, None, "nothing moves the answer");
    }

    /// The call whose answer lists the records wins: a search of itineraries beside a call answering a few policies.
    #[test]
    fn the_longest_list_is_how_many_records_an_answer_carried() {
        let search = serde_json::json!({"data": {"itineraryList": vec![1; 78], "head": {}}});
        let policies = serde_json::json!({"policyList": vec![1; 3], "head": {}});
        assert_eq!(longest_list(&search), 78);
        assert_eq!(longest_list(&policies), 3);
        assert_eq!(longest_list(&serde_json::json!({"a": "b"})), 0);
    }

    /// A try that read nothing says nothing of the page: the route stays to be tried, but a site that refuses an empty
    /// profile costs a browser `PAGE_TRIES` times at most, however often the route is called.
    #[test]
    fn a_try_that_read_nothing_is_tried_again_a_few_times_at_most() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "fields": [], "needs_browser": false }] })).unwrap();
        let mut route = Route::from_graph("r".into(), "list items".into(), "https://shop.example/".into(), graph).unwrap();
        let start = 1_000_000;
        assert!(page_try_due(&route, start), "a route just learned");
        page_tried(&mut route, None, start);
        assert!(!route.tried_page, "a browser that didn't start read nothing");
        assert!(!page_try_due(&route, start + 60), "and not again on the next call");
        assert!(page_try_due(&route, start + PAGE_TRY_GAP));
        let mut browsers = 1;
        for minute in 1..(60 * 24 * 30) {
            let now = start + minute * 60;
            if page_try_due(&route, now) {
                browsers += 1;
                page_tried(&mut route, None, now);
            }
        }
        assert_eq!(browsers, PAGE_TRIES, "a call a minute for a month");
        assert!(route.tried_page, "and the node stops");
        // A try that reads the page ends it, whatever came before.
        let mut read = Route { tried_page: false, page_tries: store::PageTries { failed: 1, at: start }, ..route.clone() };
        page_tried(&mut read, Some(&Trace { exchanges: Vec::new(), inputs: Vec::new() }), start + PAGE_TRY_GAP);
        assert!(read.tried_page && !page_try_due(&read, start + 2 * PAGE_TRY_GAP));
        assert_eq!(read.page_tries.failed, 1);
        // Learning the call again says nothing of the page: the count stands, and no browser comes of it.
        let _home = store::scratch_home("page-tries");
        store::save_route(&route).unwrap();
        let fresh = Route { tried_page: false, page_tries: store::PageTries::default(), ..route.clone() };
        let (again, _) = store::keep_learned(fresh).unwrap();
        assert!(!page_try_due(&again, start + 100 * PAGE_TRY_GAP));
    }

    /// A step refused, or that never reached the browser, leaves the flow as it was. One that timed out still counts if
    /// its tab moved on.
    #[test]
    fn a_flow_ends_only_when_the_step_left_the_page() {
        let (a, b) = (Some("https://s.example/a"), Some("https://s.example/b"));
        assert!(left_the_page(true, a, a), "it said so: a page that reloads itself is left");
        assert!(left_the_page(false, a, b), "it timed out, and the page moved on anyway");
        assert!(left_the_page(false, a, None), "the tab is gone");
        assert!(!left_the_page(false, a, a), "refused: still on the page");
        assert!(!left_the_page(false, None, None), "no browser, nothing left");
    }

    /// A browser serves a site's sessions at once. One leaving its page ends its own flow, never the other's, whose start
    /// the site's mark still holds; the owner's cut ends everyone's.
    #[test]
    fn one_sessions_leaving_is_no_cut_in_anothers_flow() {
        let _home = store::scratch_home("flow-sessions");
        std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
        let site = "two-sessions.example";
        Marks { flow: 10.0, sent: 10.0, at: 0 }.write(site);
        crate::browse::note_acted(site, "1:a", 11.0);
        crate::browse::note_acted(site, "2:b", 12.0);
        let end = |session: &str, t: f64| Leaving { site: site.into(), session: session.into(), end: Marks { flow: t, sent: t, at: 0 }, page: None }.ended();
        end("1:a", 20.0);
        assert_eq!(flow_of(site, "1:a"), 20.0, "its own flow starts anew");
        assert_eq!(Marks::read(site).flow, 10.0, "and the other's stays whole");
        assert_eq!(flow_of(site, "2:b"), 0.0);
        // With nobody else there, the site's mark moves as it always did.
        let alone = "one-session.example";
        Marks { flow: 10.0, sent: 10.0, at: 0 }.write(alone);
        crate::browse::note_acted(alone, "1:a", 11.0);
        Leaving { site: alone.into(), session: "1:a".into(), end: Marks { flow: 20.0, sent: 20.0, at: 0 }, page: None }.ended();
        assert_eq!(Marks::read(alone).flow, 20.0);
    }

    /// What another session did in the same browser isn't this flow's: its call is never kept under this session's goal.
    #[test]
    fn a_flow_reads_only_its_own_sessions_steps() {
        let call = |t: f64, url: &str, body: &str| serde_json::json!({ "type": "exchange", "t": t, "resourceType": "XHR", "entry": { "request": { "method": "GET", "url": url, "headers": [] }, "response": { "status": 200, "headers": [{ "name": "content-type", "value": "application/json" }], "content": { "mimeType": "application/json", "text": body } } } });
        let log = [
            serde_json::json!({ "type": "action", "t": 1.0, "action": "navigate", "value": "https://s.example/a" }),
            call(1.5, "https://s.example/api/mine", "{}"),
            serde_json::json!({ "type": "action", "t": 2.0, "action": "navigate", "value": "https://s.example/b" }),
            call(2.5, "https://s.example/api/theirs", "{}"),
        ];
        let session = unbrowse_learn::session::Session::from_log(&log.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let own = session.only(|t| t < 2.0);
        assert_eq!(own.actions.len(), 1);
        assert_eq!(own.trace.exchanges.iter().map(|e| e.url.path()).collect::<Vec<_>>(), ["/api/mine"]);
        assert_eq!(own.time_of(0), 1.5, "times stay with their requests");
    }

    /// Only a part of the log that lacks what the flow needs is read further back, and that is a kind of answer, not a
    /// form of words a failure might happen to start with.
    #[test]
    fn only_a_socket_opened_earlier_reads_further_back() {
        let reads = std::cell::Cell::new(0);
        let found = read_back(u64::MAX, |_: (u64, u64)| {
            reads.set(reads.get() + 1);
            if reads.get() == 1 { Err(Unread::Earlier) } else { Ok(reads.get()) }
        });
        assert_eq!(found, Ok(2));
        reads.set(0);
        let failed: Result<(), String> = read_back(u64::MAX, |_: (u64, u64)| {
            reads.set(reads.get() + 1);
            Err("the socket opened before the browsing read, the site said".into())
        });
        assert_eq!((reads.get(), failed.unwrap_err().contains("the site said")), (1, true), "the same words from anywhere else are a failure");
        assert!(read_back::<()>(u64::MAX, |_| Err(Unread::Earlier)).unwrap_err().contains("open the page again"));
    }

    /// A page of browsing as a fresh node's first page on `site` leaves it: opened, then `pages` answers of about 0.9 MB
    /// each (a long list the agent kept asking for more of), all in the one flow. The log's length in bytes.
    fn a_long_page_of_browsing(site: &str, pages: usize) -> usize {
        std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
        let items = (0..6000).map(|i| format!(r#"{{"id":{i},"title":"item {i}","blurb":"{}"}}"#, "x".repeat(120))).collect::<Vec<_>>().join(",");
        let body = format!(r#"{{"items":[{items}]}}"#);
        let mut log = vec![serde_json::json!({ "type": "action", "t": 1.0, "action": "navigate", "value": format!("https://{site}/list") }).to_string()];
        for page in 0..pages {
            log.push(serde_json::json!({ "type": "exchange", "t": 2.0 + page as f64, "resourceType": "Fetch", "entry": { "request": { "method": "GET", "url": format!("https://{site}/api/items?page={page}"), "headers": [] }, "response": { "status": 200, "headers": [{ "name": "content-type", "value": "application/json" }], "content": { "mimeType": "application/json", "text": body } } } }).to_string());
        }
        std::fs::write(log_of(site), log.join("\n") + "\n").unwrap();
        // The page was the first the node opened on the site: its flow starts where the log does.
        Marks { flow: 0.5, sent: 0.5, at: 0 }.write(site);
        std::fs::metadata(log_of(site)).unwrap().len() as usize
    }

    /// A frame whose socket opened long before the flow reads further back for the socket's opening, and only for it:
    /// the requests from before the last stretch of log are left on disk (L20, UNB-208). Read whole, a 2.4 GB log (the
    /// Deck's google.com) was all held at once for one frame.
    #[test]
    fn a_socket_opened_long_before_reads_back_for_the_socket_alone() {
        let _home = store::scratch_home("socket-reads-back");
        std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
        let site = "sockets.example";
        let body = "x".repeat(1 << 20);
        let call = |t: f64| serde_json::json!({ "type": "exchange", "t": t, "resourceType": "XHR", "entry": { "request": { "method": "GET", "url": format!("https://{site}/api/{t}"), "headers": [] }, "response": { "status": 200, "headers": [], "content": { "mimeType": "text/plain", "text": body } } } }).to_string();
        let mut log = vec![serde_json::json!({ "type": "socket", "t": 1.0, "id": "s1", "event": "open", "url": format!("wss://{site}/ws") }).to_string()];
        log.extend((0..80).map(|i| call(2.0 + i as f64)));
        std::fs::write(log_of(site), log.join("\n") + "\n").unwrap();
        let at = std::fs::metadata(log_of(site)).unwrap().len();
        let passes = std::cell::RefCell::new(Vec::new());
        let read = from_log(site, at, |session| {
            let opened = session.sockets.iter().any(|e| e.kind == "open");
            passes.borrow_mut().push((session.trace.exchanges.len(), opened));
            if opened { Ok(session.trace.exchanges.len()) } else { Err(Unread::Earlier) }
        });
        let passes = passes.into_inner();
        assert_eq!(passes.iter().map(|p| p.1).collect::<Vec<_>>(), [false, false, true], "two windows, then the socket's opening: {passes:?}");
        assert!(read.unwrap() <= 65, "the last pass holds the last 64 MB of requests and the socket, not all 80: {passes:?}");
    }

    /// A flow's requests are lent out of the session read for the checks that need only them, and the session gets
    /// back every request, in its order, with its own time: what is learned after the checks reads the session whole.
    #[test]
    fn a_flow_lent_out_comes_back_as_it_was() {
        let call = |t: f64, path: &str| serde_json::json!({ "type": "exchange", "t": t, "resourceType": "XHR", "entry": { "request": { "method": "GET", "url": format!("https://s.example{path}"), "headers": [] }, "response": { "status": 200, "headers": [], "content": { "mimeType": "application/json", "text": "{}" } } } }).to_string();
        let log = [call(1.0, "/before"), call(2.0, "/in-1"), call(3.0, "/in-2"), call(4.0, "/after")].join("\n");
        let mut session = unbrowse_learn::session::Session::from_log(&log).unwrap();
        let paths = |t: &Trace| t.exchanges.iter().map(|e| e.url.path().to_string()).collect::<Vec<_>>();
        let whole = (paths(&session.trace), (0..4).map(|i| session.time_of(i)).collect::<Vec<_>>());
        assert_eq!(with_flow(&mut session, |t| t > 1.5 && t <= 3.5, paths), ["/in-1", "/in-2"]);
        assert_eq!((paths(&session.trace), (0..4).map(|i| session.time_of(i)).collect::<Vec<_>>()), whole, "every request back, in its place");
        assert_eq!(with_flow(&mut session, |t| t > 9.0, paths), Vec::<String>::new());
        assert_eq!(with_flow(&mut session, |_| true, paths), whole.0);
        // Times that aren't one run (a flow can't be, but the lending doesn't rest on it) are copied instead.
        assert_eq!(with_flow(&mut session, |t| t == 1.0 || t == 4.0, paths), ["/before", "/after"]);
        assert_eq!(paths(&session.trace), whole.0);
    }

    /// A learn holds the browsing it reads from the log once at most (L20, UNB-208). The node learns after every
    /// command, from the page's flow mark to the log's end: held three or four times over (the bytes read, the lines
    /// joined again, the session, and the session's own steps copied out of it), a staging node grew with the page's
    /// log, 57 MB to 3.6 GB in 13 minutes of the bank.
    #[test]
    fn a_learn_holds_the_browsing_it_reads_once() {
        let _home = store::scratch_home("learn-holds-once");
        let site = "memshop.example";
        let read = a_long_page_of_browsing(site, 24);
        let (_, held) = crate::test_alloc::peak_of(|| learn_auto(site, "1:a", None, "agent", &|_| {}));
        assert!(held < read * 3 / 2, "a learn over {} MB of browsing held {} MB at once", read >> 20, held >> 20);
    }

    #[test]
    fn an_ending_flow_waits_for_background_learning() {
        let home = store::scratch_home("ending-flow-waits");
        let busy = BROWSE_LEARN.lock().unwrap();
        let (begin, began) = std::sync::mpsc::sync_channel(0);
        let (finish, finished) = std::sync::mpsc::channel();
        std::thread::scope(|threads| {
            threads.spawn(|| {
                store::use_home(&home);
                begin.send(()).unwrap();
                let _ = learn_auto("shop.example", "1:a", Some(2.0), "agent", &|_| {});
                finish.send(()).unwrap();
            });
            began.recv().unwrap();
            let returned_while_busy = finished.recv_timeout(std::time::Duration::from_millis(300)).is_ok();
            drop(busy);
            assert!(!returned_while_busy, "the departing tab cannot retry a skipped learn on its next command");
            finished.recv_timeout(std::time::Duration::from_secs(5)).expect("the closing learn runs after the background learn");
        });
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A learn reads the marks, works, and writes them. The owner taking the page meanwhile moved them on, and that cut
    /// stands: nothing typed by hand is read into a flow by the learn that started before it.
    #[test]
    fn a_learn_never_takes_back_the_owners_cut() {
        let _home = store::scratch_home("flow-cut");
        std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
        let site = "cut.example";
        Marks { flow: 10.0, sent: 10.0, at: 5 }.write(site);
        let read_by_the_learn = Marks::read(site);
        Marks { flow: 90.0, sent: 90.0, at: 50 }.write(site);
        read_by_the_learn.write(site);
        let now = Marks::read(site);
        assert_eq!((now.flow, now.sent, now.at), (90.0, 90.0, 50));
        Marks { sent: 95.0, ..now }.write(site);
        assert_eq!(Marks::read(site).sent, 95.0, "and marks still move on");
    }

    /// A node up for months walks thousands of pages: only the newest are held, each a whole trace in memory.
    #[test]
    fn only_the_newest_walks_stay_in_memory() {
        let mut walks = HashMap::new();
        for n in 0..(WALKS_KEPT + 5) {
            let trace = Trace { exchanges: Vec::new(), inputs: Vec::new() };
            keep_walk(&mut walks, format!("w{n}"), Walk { url: String::new(), trace: trace.into(), probes: Vec::new(), recording: None, at: std::time::Instant::now() + std::time::Duration::from_secs(n as u64), addresses: None });
        }
        assert_eq!(walks.len(), WALKS_KEPT);
        assert!(!walks.contains_key("w0") && walks.contains_key(&format!("w{}", WALKS_KEPT + 4)));
    }

    /// A walk speaks for what its browser held and nothing else. A session the browser dropped goes, or it would be sent
    /// for ever; a cookie no browser of the node's ever had, and a token its routes mint, are things it has no news of.
    #[test]
    fn a_walk_replaces_what_it_saw_and_keeps_what_it_never_could() {
        let _home = store::scratch_home("walk-jar");
        std::fs::create_dir_all(store::jars_dir()).unwrap();
        let host = "shop.example";
        let map = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<std::collections::BTreeMap<String, String>>();
        let later = store::now() as f64 + 3600.0;
        let only = |value: &str, until: f64| store::JarOnly { value: value.into(), until };
        store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &map(&[("imported", "i1"), ("ran_out", "r1"), ("seen", "old"), ("replaced", "site's"), ("dropped", "d1")])).unwrap();
        store::write_json(&store::jar_scope_path(host), &unbrowse_files::JAR, &map(&[("imported", ".shop.example"), ("dropped", ".shop.example")])).unwrap();
        let held = std::collections::BTreeMap::from([("imported".to_string(), only("i1", later)), ("ran_out".to_string(), only("r1", 1.0)), ("seen".to_string(), only("old", later)), ("replaced".to_string(), only("mine", later))]);
        store::write_json(&store::jar_only_path(host), &unbrowse_files::JAR, &held).unwrap();
        walked_into_jar(host, map(&[("clearance", "c1"), ("seen", "new")]), map(&[("clearance", ".shop.example")]));
        let jar: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path(host), &unbrowse_files::JAR);
        assert_eq!(jar, map(&[("clearance", "c1"), ("imported", "i1"), ("seen", "new")]));
        let scope: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_scope_path(host), &unbrowse_files::JAR);
        assert_eq!(scope, map(&[("clearance", ".shop.example"), ("imported", ".shop.example")]), "a cookie kept keeps how far it goes");
    }

    use super::*;

    /// The rule's pick from a walk already recorded, without a browser: `UNBROWSE_WALK` is a capture log
    /// (`…/learn_<id>.jsonl`), `UNBROWSE_URL` the page it walked, `UNBROWSE_GOAL` the goal. Prints every candidate
    /// with its score and what its answer holds, then the pick.
    #[test]
    fn two_pages_of_one_goal_differ_where_they_are_asked_for_different_things() {
        let earlier = ["https://shop.example/c/shoes/item/a1b2c3/red-runner/".to_string()];
        let got = with_other_pages("https://shop.example/c/hats/item/z9y8x7/wool-cap/", Vec::new(), &earlier);
        assert_eq!(
            got,
            [("c".to_string(), "hats".to_string()), ("item".to_string(), "z9y8x7".to_string()), ("part4".to_string(), "wool-cap".to_string())]
        );
        // What the walk found already stays as it was named when the other pages add nothing.
        let found = vec![("q".to_string(), "hats".to_string())];
        assert_eq!(with_other_pages("https://shop.example/c/hats/", found.clone(), &["https://shop.example/c/shoes/".to_string()][..0]), found);
        // A page of another shape, or on another host, says nothing.
        assert!(with_other_pages("https://shop.example/c/hats/item/z9y8x7/", Vec::new(), &earlier).is_empty());
        assert!(with_other_pages("https://other.example/c/hats/item/z9y8x7/wool-cap/", Vec::new(), &earlier).is_empty());
    }

    /// Compact a recorded route's scripts with the sandbox as the oracle, off the stored file, so a route can be
    /// reduced without a fresh walk: `UNBROWSE_ROUTE=<route.json>`.
    /// Rebuild a route from a recorded walk and print the steps it keeps: the target and what it needs, not every call
    /// the page made. `UNBROWSE_WALK=<capture.jsonl> UNBROWSE_TARGET=<path substring>`.
    #[test]
    #[ignore]
    fn rebuild_a_recorded_walk() {
        let Ok(log) = std::env::var("UNBROWSE_WALK") else { return };
        let needle = std::env::var("UNBROWSE_TARGET").unwrap_or_default();
        let path = std::path::PathBuf::from(&log);
        let session = path.file_stem().unwrap().to_string_lossy().into_owned();
        let trace = trace_from_walk(path.parent().unwrap(), &session).expect("a walk");
        // A second sighting of the same page: a value that changed is the site's per call, one that held is carried.
        let second = std::env::var("UNBROWSE_WALK2").ok().map(|p| {
            let p = std::path::PathBuf::from(p);
            let s = p.file_stem().unwrap().to_string_lossy().into_owned();
            trace_from_walk(p.parent().unwrap(), &s).expect("a second walk")
        });
        let traces: Vec<unbrowse_learn::trace::Trace> = std::iter::once(trace.clone()).chain(second).collect();
        let probes = unbrowse_learn::walk::probes_from_walk(path.parent().unwrap(), &session);
        let mut g = unbrowse_learn::build(&traces, |e| e.url.path().contains(&needle)).expect("a graph");
        unbrowse_learn::signing::discover(&mut g, &trace, &probes, &unbrowse_learn::generated::Environment::default(), &[]);
        println!("steps {} of {} exchanges ({} walks), {} probes", g.steps.len(), trace.exchanges.len(), traces.len(), probes.len());
        println!("scripts {} ({:.0} KB)", g.scripts.len(), g.scripts.iter().map(|s| s.body.len()).sum::<usize>() as f64 / 1024.0);
        for f in &g.steps.last().unwrap().fields {
            if matches!(&f.class, unbrowse_learn::Class::Recipe { .. }) {
                println!("recipe at {}: {:?}", f.loc, f.class);
            }
        }
        for s in &g.steps {
            println!("  {} {}", s.method, s.url);
        }
    }

    #[test]
    #[ignore]
    fn compact_a_recorded_route() {
        let Ok(path) = std::env::var("UNBROWSE_ROUTE") else { return };
        let text = std::fs::read_to_string(&path).expect("a route file");
        let v: serde_json::Value = serde_json::from_str(&text).expect("route json");
        let graph = v.get("graph").cloned().unwrap_or(v);
        let mut graph: unbrowse_learn::Graph = serde_json::from_value(graph).expect("a graph");
        println!("scripts {} ({:.0} KB)", graph.scripts.len(), graph.scripts.iter().map(|s| s.body.len()).sum::<usize>() as f64 / 1024.0);
        let tip = graph.steps.last().cloned().expect("a target step");
        match unbrowse_learn::signing::compact(&mut graph, &tip) {
            Some(c) => println!("compacted {} -> {} ({:.0} KB -> {:.0} KB): {:?}", c.before, c.after, c.before_bytes as f64 / 1024.0, c.after_bytes as f64 / 1024.0, graph.scripts.iter().map(|s| s.url.rsplit('/').next().unwrap_or_default().to_string()).collect::<Vec<_>>()),
            None => println!("nothing verified: the page makes no such call in the sandbox"),
        }
    }

    #[test]
    #[ignore]
    fn pick_from_a_recorded_walk() {
        let (Ok(log), Ok(url), Ok(goal)) = (std::env::var("UNBROWSE_WALK"), std::env::var("UNBROWSE_URL"), std::env::var("UNBROWSE_GOAL")) else { return };
        let log = std::path::PathBuf::from(log);
        let session = log.file_stem().unwrap().to_string_lossy().into_owned();
        let trace = trace_from_walk(log.parent().unwrap(), &session).expect("a walk");
        let site = site_of(url::Url::parse(&url).unwrap().host_str().unwrap());
        let view = view_of("offline", &url, &site, &trace, 0);
        let (in_path, _) = path_inputs(&url, &goal, &trace);
        let values: Vec<String> = walk_inputs(&url, &in_path, &trace.exchanges).into_iter().map(|i| i.value).collect();
        let scores = rule_scores(&trace, &view, &goal, &values, &[]);
        let fields = goal::fields(&goal);
        println!("{url}  asked={values:?}  door={} of {}", trace.door(&site).len(), trace.exchanges.len());
        for (score, i, noise, _) in scores.iter().take(15) {
            let c = view.candidates.iter().find(|c| c.index == *i).unwrap();
            let h = holding_of(&trace.exchanges[*i], &fields, &values, &goal);
            println!("  {score:6.1} {}{} {} {} | {}", if *noise { "noise " } else { "" }, c.method, c.host, bare(&c.path), h.said() + if h.has_shapes() { "" } else { " [missing a shaped field]" });
        }
        // The pick itself is the live learn's (`walk_pick`), so this prints what a walk of the page would keep.
        let shown = page_shown(&trace.exchanges, &url, &[]);
        let passes = |i: usize| may_answer(&trace, i, &goal, &url, &values, &shown, &view.site);
        match walk_pick(&trace, &view, &goal, &values, scores, &passes, None) {
            Some((i, by, reasons)) => println!("PICK {} {}{}  (by {by}: {})", trace.exchanges[i].method, trace.exchanges[i].url.host_str().unwrap(), trace.exchanges[i].url.path(), reasons.join("; ")),
            None => println!("NONE {NEEDS_HANDS}"),
        }
    }

    /// UNB-165. A search page that lists the value (Carousell's, for `macbook air`: dozens of cards, each named and
    /// priced) says the site found something for it, whatever a call beside it answered; one that found nothing and
    /// suggests other things, or lists nothing, says nothing of the kind. Checked on the live pages of 17 November
    /// 2026 too: 49 priced records saying the value back, and 1 record for a word nobody searches for.
    #[test]
    fn a_page_lists_the_ask_only_with_priced_results_that_say_it_back() {
        let goal = "search listings with titles and prices";
        let card = |href: &str, title: &str, price: &str| format!("<div class=\"card\"><a href=\"{href}\"><img alt=\"{title}\"><p>{title}</p></a><p>{price}</p><p>Used</p></div>");
        let listed: String = [
            card("/p/apple-macbook-air-m1-13-1401/", "Apple MacBook Air M1 13.3-inch 8GB RAM", "S$650"),
            card("/p/macbook-air-m2-2022-1402/", "MacBook Air M2 2022 Midnight", "S$980"),
            card("/p/macbook-air-13-m3-1403/", "MacBook Air 13 M3 16GB", "S$1,250"),
            card("/p/macbook-air-2020-intel-1404/", "MacBook Air 2020 Intel i5", "S$320"),
            card("/p/macbook-air-15-m2-1405/", "MacBook Air 15 M2 512GB", "S$1,100"),
        ]
        .concat();
        let page = format!("<html><head><title>macbook air - View all macbook air ads in Carousell Singapore</title></head><body><h1>macbook air</h1>{listed}</body></html>");
        let asked = ["macbook air".to_string()];
        assert!(lists_the_ask(&main_page(200, "https://www.market.example/search/macbook%20air/", &page), goal, &asked));
        // A page that found nothing, with things it suggests instead: they don't say the value.
        let suggested: String = [card("/p/desk-lamp-1/", "Brass desk lamp", "S$20"), card("/p/sofa-2/", "Three seat sofa", "S$150"), card("/p/bike-3/", "Folding bike", "S$90")].concat();
        let none = format!("<html><head><title>zqdqxmhdqsfv - Carousell Singapore</title></head><body><h1>zqdqxmhdqsfv</h1><p>No results found</p><h2>You may also like</h2>{suggested}</body></html>");
        let nonsense = ["zqdqxmhdqsfv".to_string()];
        assert!(!lists_the_ask(&main_page(200, "https://www.market.example/search/zqdqxmhdqsfv/", &none), goal, &nonsense));
        // Nothing asked, nothing to say back.
        assert!(!lists_the_ask(&main_page(200, "https://www.market.example/search/macbook%20air/", &page), goal, &[]));
    }

    fn no_walk() -> Trace {
        Trace { exchanges: vec![], inputs: vec![] }
    }

    fn main_page(status: u16, url: &str, html: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: vec![("content-type".into(), "text/html".into())],
            response_body: Some(html.to_string()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        }
    }

    /// A walk kept on disk is learned again with no browser: its capture, read as the walk the node had just made,
    /// keeps the call that answers the goal as a route in this home, under the value the page was asked for. Nothing
    /// is walked: the test has no browser, and a learn that tried to start one would fail here.
    #[test]
    fn a_kept_walk_is_learned_again_without_a_browser() {
        let home = store::scratch_home("learn-kept-walk");
        let walks = home.join("walks");
        std::fs::create_dir_all(&walks).unwrap();
        let url = "https://shop.example/search?q=lamp";
        let page = "<html><body><form><input name=q value=lamp></form><div id=results></div></body></html>";
        let answer = r#"{"items":[{"name":"Lamp shade","price":"12.00"},{"name":"Desk lamp","price":"34.00"},{"name":"Floor lamp","price":"80.00"}]}"#;
        let line = |v: serde_json::Value| v.to_string();
        let capture = [
            line(serde_json::json!({ "type": "mint", "url": url, "t": 1.0 })),
            line(serde_json::json!({ "type": "request", "t": 1.1, "requestId": "1.1", "method": "GET", "url": url,
                "headers": { "Accept": "text/html" }, "postData": null, "resourceType": "Document", "frameId": "F1" })),
            line(serde_json::json!({ "type": "response", "t": 1.2, "requestId": "1.1", "url": url, "status": 200,
                "mimeType": "text/html", "headers": { "content-type": "text/html" }, "body": page })),
            line(serde_json::json!({ "type": "request", "t": 1.3, "requestId": "1.2", "method": "GET",
                "url": "https://shop.example/api/search?q=lamp", "headers": { "Accept": "application/json", "Referer": url },
                "postData": null, "resourceType": "Fetch", "frameId": "F1" })),
            line(serde_json::json!({ "type": "response", "t": 1.4, "requestId": "1.2", "url": "https://shop.example/api/search?q=lamp",
                "status": 200, "mimeType": "application/json", "headers": { "content-type": "application/json" }, "body": answer })),
        ]
        .join("\n");
        let path = walks.join("learn_walk_kept.jsonl");
        std::fs::write(&path, capture + "\n").unwrap();

        let route = learn_kept_walk(&path, url, "search the shop for lamps").expect("the kept walk is learned");
        assert_eq!(route.site, "shop.example");
        assert!(route.path.starts_with("/api/search"), "the call that answers is kept, not the page: {}", route.path);
        assert!(route.inputs.iter().any(|i| i.default.as_deref() == Some("lamp")), "the asked value is the route's input: {:?}", route.inputs.iter().map(|i| (&i.name, &i.default)).collect::<Vec<_>>());
        assert!(store::load_route(&route.id).is_some(), "the route is kept in this home");
        assert_eq!(store::load_routes().len(), 1, "the opening shell holds no search results");
        assert!(learn_kept_walk(&walks.join("learn_none.jsonl"), url, "search").is_err(), "a capture that isn't there is no walk");
    }

    #[test]
    fn a_cold_read_keeps_its_opening_results_alongside_the_dependent_call() {
        let _home = store::scratch_home("opening-search-route");
        let url = "https://shop.example/search?q=lamp";
        let rendered_url = "https://shop.example/search?q=lamp&view=cards";
        let what = "search listings for lamp and list the title, price, availability and link of each result";
        let session = "fixture-page-session-9eddbbbe61";
        let cards: Vec<_> = (1..=6).map(|n| serde_json::json!({
            "title": format!("Desk lamp model {n}"),
            "price": "$36.00",
            "availability": "in stock",
            "photo": format!("https://shop.example/photos/{n}.jpg")
        })).collect();
        let suggestions: Vec<_> = (1..=8).map(|n| serde_json::json!({
            "title": format!("Lamp suggestion {n}"), "url": format!("https://shop.example/suggest/{n}")
        })).collect();
        let recommendations: Vec<_> = suggestions.iter().cloned().map(|mut row| {
            row["price"] = "$29.00".into();
            row
        }).collect();
        let state = serde_json::json!({"search":{"session":session,"results":cards,"suggestions":suggestions,"recommendations":recommendations}});
        let offers: String = (1..=6).map(|n| format!(
            "<article><a href='/products/{n}'>Desk lamp model {n}</a><span>$36.00</span></article>"
        )).collect();
        let page = format!("<html><body>{offers}<script type='application/json'>{state}</script></body></html>");
        let api_cards: Vec<_> = cards.iter().cloned().enumerate().map(|(i, mut card)| {
            card["url"] = format!("https://shop.example/products/{}", i + 1).into();
            card
        }).collect();
        let mut api = walked("POST", "https://shop.example/api/search", &serde_json::json!({"results":api_cards}).to_string(), false);
        api.request_headers.push(("content-type".into(), "application/json".into()));
        api.request_body = Some(serde_json::json!({"query":"lamp","session":session}).to_string());
        let trace = Trace { exchanges: vec![main_page(200, rendered_url, &page), api], inputs: vec![] };
        let mut fewer = trace.clone();
        let mut short = fewer.exchanges[1].own_json().unwrap();
        short["results"].as_array_mut().unwrap().truncate(4);
        fewer.exchanges[1].response_body = Some(short.to_string());
        let walks = Walks::default();
        keep_walk(&mut walks.0.locked(), "opening".into(), Walk {
            url: url.into(), trace: trace.into(), probes: vec![], recording: None,
            at: std::time::Instant::now(), addresses: None,
        });
        let (primary, _) = pick_and_keep(&walks, url, what, "You", "opening", &|_| {}, None, true).expect("the original API route");
        assert_eq!((primary.method.as_str(), primary.graph.steps.len()), ("POST", 2));
        let routes = store::load_routes();
        let opening = routes.iter().find(|r| r.method == "GET").expect("the opening document supplies an independent answer");
        assert_eq!(opening.what, what);
        assert_eq!(opening.graph.steps.len(), 1);
        assert_eq!(walks.companions("opening", &primary.id), vec![opening.id.clone()]);
        assert!(walks.companions("another-walk", &primary.id).is_empty());
        assert!(opening.inputs.iter().any(|i| i.default.as_deref() == Some("lamp")));
        let records = opening.heard.records_at.as_deref().expect("the cold document showed a search result list");
        assert!(records.ends_with("/results"), "{records}");
        let a_different_list = serde_json::json!({"catalog": {"results": cards}});
        assert!(confirm::lacks_its_records(opening, &a_different_list));
        keep_walk(&mut walks.0.locked(), "short-strip".into(), Walk {
            url: url.into(), trace: fewer.into(), probes: vec![], recording: None,
            at: std::time::Instant::now(), addresses: None,
        });
        let (complete, _) = pick_and_keep(&walks, url, what, "You", "short-strip", &|_| {}, None, true).expect("the complete list is on the document");
        assert_eq!(complete.method, "GET", "a shorter strip of related results cannot outrank the complete linked list");
    }

    /// A network block that answers 200 with a title and one line: read back, the call fails, so it is never kept. A
    /// page that says what was asked, or links to anything, is a page.
    #[test]
    fn a_page_that_says_nothing_of_what_was_asked_is_never_kept_for_it() {
        let asked = vec!["rust programming".to_string()];
        let url = "https://www.site.example/search/?q=rust%20programming";
        let block = main_page(200, url, "<html><head><title>Site</title></head><body>You've been blocked by network security.</body></html>");
        assert!(fails_goal(&block, "search site posts", url, &asked, "", &no_walk()).is_some_and(|w| w.contains("links nowhere")));
        let none = main_page(200, url, "<html><head><title>Site</title></head><body>No results for rust programming</body></html>");
        assert_eq!(fails_goal(&none, "search site posts", url, &asked, "", &no_walk()), None);
    }

    /// A walk sent to a page the site doesn't have learns nothing from what that page loads: its header's and footer's
    /// calls answer every missing page alike.
    #[test]
    fn a_walk_of_a_page_the_site_does_not_have_keeps_nothing() {
        let url = "https://www.site.example/search?q=phone";
        let missing = Trace { exchanges: vec![main_page(404, url, "<html><head><title>Page not found</title></head><body>Sorry</body></html>")], inputs: vec![] };
        assert!(not_the_page(&missing, url).is_some_and(|w| w.contains("404") && w.contains("Page not found")));
        let moved = Trace { exchanges: vec![main_page(301, url, ""), main_page(200, "https://www.site.example/find?q=phone", "<html><body>Phones</body></html>")], inputs: vec![] };
        assert_eq!(not_the_page(&moved, url), None, "a page that moved is the page");
        let recovered = Trace { exchanges: vec![main_page(404, url, "<html></html>"), main_page(200, url, "<html><body>Phones</body></html>")], inputs: vec![] };
        assert_eq!(not_the_page(&recovered, url), None, "a page the site went on to serve");
    }

    /// A page that is its own data, the document at the agent's own address answered with JSON, is the page whatever its
    /// list holds: a package's downloads by day, named once at its head, are not a list of other things on a page about
    /// the package (a live data address: its confirming browse learned nothing and a right route was marked failing).
    /// The same list from another call, on a page for the package, still lists others.
    #[test]
    fn a_page_that_is_its_own_data_is_not_held_to_a_list_of_others() {
        let url = "https://api.reg.example/downloads/range/2026-09-01:2026-09-30/kettlejs";
        let days: Vec<serde_json::Value> = (1..=30).map(|d| serde_json::json!({ "day": format!("2026-09-{d:02}"), "downloads": 40_000 + d * 17 })).collect();
        let body = serde_json::json!({ "start": "2026-09-01", "end": "2026-09-30", "package": "kettlejs", "downloads": days }).to_string();
        let mut doc = main_page(200, url, &body);
        doc.response_mime = "application/json".into();
        doc.response_headers = vec![("content-type".into(), "application/json".into())];
        let walk = Trace { exchanges: vec![doc.clone()], inputs: walk_inputs(url, &[], &[]) };
        let goal = "get daily download counts for an npm package over a date range";
        let asked = vec!["2026-09-01:2026-09-30".to_string(), "kettlejs".to_string()];
        assert!(is_the_page_itself(&walk.exchanges[0], url));
        assert_eq!(fails_goal(&walk.exchanges[0], goal, url, &asked, "", &walk), None);
        let page = "https://reg.example/package/kettlejs";
        let mut call = doc;
        call.url = "https://api.reg.example/v1/trending?range=month".parse().unwrap();
        call.main_frame = None;
        call.resource_type = Some("XHR".into());
        assert!(!is_the_page_itself(&call, page));
    }

    /// A page that draws its charts from calls carrying its own address's word reads as its headings alone, and its
    /// calls hold the records: the walk saw records for the value and did not find nothing, whichever call was picked
    /// (a live stats page answered `answered_empty` though its calls listed 24 and 7 records). A call carrying the
    /// value that lists no records (names, a count) is no such sighting.
    #[test]
    fn a_walk_whose_calls_listed_records_for_the_value_did_not_find_nothing() {
        let url = "https://chain.example/en/stats/miner";
        let page = main_page(200, url, "<html><head><title>Miner stats</title></head><body><main><h1>Miner stats</h1><h2>Network power</h2><p>miner</p></main></body></html>");
        let series: Vec<serde_json::Value> = (0..24).map(|n| serde_json::json!({ "height": 5_000_000 + n, "timestamp": 1_794_000_000 + n * 3600, "rewardPerByte": 0.000_12 })).collect();
        let call = |at: &str, body: String| Exchange {
            method: "GET".into(),
            url: at.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(body),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let walk = Trace { exchanges: vec![page.clone(), call("https://chain.example/api/v1/stats/miner/reward-per-byte?duration=24h", serde_json::Value::Array(series).to_string())], inputs: walk_inputs(url, &[], &[]) };
        let asked = vec!["miner".to_string()];
        let route = route_of(&walk, 0, "get mining charts", url, true, &[], &[], None).expect("the page as a route");
        assert_eq!(the_walk_found_nothing(&walk, 0, &route, url, &asked), None);
        let names = Trace { exchanges: vec![page, call("https://chain.example/api/v1/stats/miner/names", r#"{"names":["f01","f02"],"count":2}"#.into())], inputs: walk_inputs(url, &[], &[]) };
        assert!(!saw_records_for(&names, &asked), "names and a count are no records");
        assert!(saw_records_for(&walk, &asked));
    }

    /// A value the site cannot place, turned away to another page (its front page, with a marker of its own and none of
    /// the value): that page's own calls answer the front page, never the value, so nothing is kept and the site is
    /// said to have nothing for it. A page that moved and kept the value, or one that says the value back from an
    /// address that does not carry it, is the page.
    #[test]
    fn a_value_the_site_turned_away_to_another_page_keeps_nothing() {
        let url = "https://stay.example/results?city=zqxvkjwpf";
        let front = "https://stay.example/index.html?label=gen1&error_city_unknown=city";
        let copy = r#"{"copy":{"title":"Find your next stay","search_label":"Where are you going?","deals":"Deals for the weekend"}}"#;
        let xhr = |at: &str, body: &str| Exchange {
            method: "GET".into(),
            url: at.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let turned = Trace {
            exchanges: vec![main_page(302, url, ""), main_page(200, front, "<html><head><title>Stays</title></head><body><h1>Find your next stay</h1><a href=\"/deals\">Deals</a></body></html>"), xhr("https://stay.example/api/copy?lang=en", copy)],
            inputs: walk_inputs(url, &[], &[]),
        };
        let why = not_the_page(&turned, url).expect("a value turned away is not the page");
        assert!(why.contains("/index.html") && why.contains("nothing for that value"), "{why}");
        assert!(matches!(page_unreached(&turned, url), Some(Unlearned::Elsewhere(_))));
        store::scratch_home("turned-away");
        let learned = corpus::read(url, "search stays", turned, &[], None);
        assert!(learned.call.is_empty() && learned.none.as_deref().is_some_and(|w| w.contains("nothing for that value")), "no route from the page it was sent to: {learned:?}");
        // The page moved and kept the value: the page.
        let kept = Trace { exchanges: vec![main_page(301, "https://stay.example/results?city=lisbon", ""), main_page(200, "https://stay.example/stays/lisbon", "<html><body>Stays</body></html>")], inputs: vec![] };
        assert_eq!(not_the_page(&kept, "https://stay.example/results?city=lisbon"), None);
        // Another page, whose own call then searches for the value: the page (the site moved its search there).
        let moved_search = Trace {
            exchanges: vec![
                main_page(302, "https://www.db.example/search?q=replication", ""),
                main_page(200, "https://search.vendor.example/db", "<html><body><div id=app></div></body></html>"),
                xhr("https://search.vendor.example/api/db?q=replication&lang=en", r#"{"hits":[{"title":"Replication in depth"},{"title":"Replication howto"}]}"#),
            ],
            inputs: vec![],
        };
        assert_eq!(not_the_page(&moved_search, "https://www.db.example/search?q=replication"), None, "the page's own call searched for it");
        // Another address, which says the value back: the page.
        let said = "<html><body><h1>Stays in Lisbon</h1><ul><li>Lisbon Old Town flat</li><li>Alfama, Lisbon house</li></ul></body></html>";
        let by_id = Trace { exchanges: vec![main_page(302, "https://stay.example/results?city=lisbon", ""), main_page(200, "https://stay.example/r/88120", said)], inputs: vec![] };
        assert_eq!(not_the_page(&by_id, "https://stay.example/results?city=lisbon"), None);
    }

    /// A walk the site redirected to a page that asks for a person (only a script and a few words: a check's shell)
    /// met a check; it never asked the site for the value. Said as a challenge, from the reader browse uses for the same
    /// landing, never as "the site has nothing for that value": an agent stops on that, believing no flights exist,
    /// while the check stands. From the walk that showed it: skyscanner.com.sg's search sent to its `/sttc/px/`
    /// check, its return address in base64 so no detour reads it.
    #[test]
    fn a_value_sent_to_a_check_is_a_check_not_nothing() {
        let url = "https://www.skyscanner.com.sg/transport/flights/sin/tyoa/261201/?adultsv2=1&cabinclass=economy&rtn=0";
        let check = "https://www.skyscanner.com.sg/sttc/px/captcha-v2/index.html?url=L3RyYW5zcG9ydC9mbGlnaHRzL3Npbi90eW9hLzI2MTIwMS8/cnRuPTAmYWR1bHRzdjI9MSZjYWJpbmNsYXNzPWVjb25vbXk=&uuid=67c42140&vid=1dfb5815";
        let shell = r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=no"><link rel="manifest" href="./manifest.json"><title>Skyscanner</title><script type="text/javascript">window.__pageLoadedTime=Date.now()</script><script defer="defer" src="./static/js/main.81dbcf5a.js"></script><link href="./static/css/main.7fb0b9a7.css" rel="stylesheet"></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>"#;
        let met = Trace { exchanges: vec![main_page(307, url, ""), main_page(200, check, shell)], inputs: walk_inputs(url, &[], &[]) };
        let unreached = page_unreached(&met, url).expect("a check is not the page");
        assert!(matches!(unreached, Unlearned::Check(_, "challenge.asks_a_person")), "{unreached:?}");
        assert_eq!(unreached.outcome().0, crate::outcome::Outcome::Challenge);
        assert!(!unreached.to_string().contains("nothing for that value"), "{unreached}");
        // A page it was sent to that is a page of the site, saying none of the value, is still a value turned away.
        let front = Trace {
            exchanges: vec![main_page(302, url, ""), main_page(200, "https://www.skyscanner.com.sg/?error=1", "<html><head><title>Flights</title><script src=\"/a.js\"></script></head><body><h1>Find cheap flights</h1><a href=\"/hotels\">Hotels</a></body></html>")],
            inputs: walk_inputs(url, &[], &[]),
        };
        assert!(matches!(page_unreached(&front, url), Some(Unlearned::Elsewhere(_))));
    }

    /// A walk whose answer is a reply only the page's own code reads (ciphered, sent and read by a script of the page)
    /// on a machine that runs no page code: why no call answers is the runtime, said as `sandbox::Unheld` says it, not
    /// a page that needs hands. With a runtime, or for a reply a standard reader reads, nothing is said.
    /// Decoders are cut only for a data call a script sent and read, and whether page code can run here is asked only
    /// then. An ordinary page (its document, three scripts and two stylesheets, a chunk, a worker's imported script and
    /// one stylesheet sent by its own script, and one JSON data call) has no such reply: no decoder is cut and the runtime is never asked,
    /// so the learn starts no child process for either. A page whose data call's answer only its own function unpacks
    /// has one: the runtime is asked once, and that call's script is cut as the decoder.
    #[test]
    fn decoders_are_cut_only_for_a_reply_a_script_was_handed() {
        let dir = std::env::temp_dir().join(format!("unbrowse-decoder-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let app = "(function () {\n  function unpack(t) { var raw = atob(t), out = ''; for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a); return JSON.parse(out); }\n  window.searchCipher = function (q, done) {\n    fetch('/api/cipher/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n  };\n  import('/s/chunk.js'); var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/s/late.css'; document.head.appendChild(l);\n})();\n";
        let ciphered = "Zx9#q!w-ciphered*answer~that*no*reader*reads";
        let sent = |url: &str, kind: &str, mime: &str, body: &str| serde_json::json!({"type": "exchange", "t": 3.0, "resourceType": kind, "entry": {
            "_initiator": {"type": "script", "frames": [{"scriptId": "7", "url": "https://shop.example/s/app.js", "function": "load", "line": 0, "column": 20}]},
            "request": {"method": "GET", "url": url, "headers": []},
            "response": {"status": 200, "headers": [], "content": {"mimeType": mime, "text": body}}}});
        let lines = [
            sent("https://shop.example/s/chunk.js", "Script", "application/javascript", "export const x = 1;"),
            sent("https://shop.example/s/pixel.js", "Other", "text/javascript", "self.track = function () {};"),
            sent("https://shop.example/s/late.css", "Stylesheet", "text/css", "body{margin:0}"),
            sent("https://shop.example/api/cipher/search?q=lamp", "Fetch", "text/plain", ciphered),
            serde_json::json!({"type": "script", "t": 1.0, "scriptId": "7", "url": "https://shop.example/s/app.js", "language": "js", "sha256": unbrowse_learn::blobs::sha256_hex(app.as_bytes()), "length": app.len(), "source": app}),
        ];
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(agent_browser_core::session::capture_path(&dir, "w"), text).unwrap();
        let rec = unbrowse_learn::recording::Recording::read(&dir, "w").expect("a recording");
        let ex = |url: &str, kind: &str, mime: &str, body: &str| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), mime.into())],
            response_body: Some(body.into()),
            response_mime: mime.into(),
            resource_type: Some(kind.into()),
            main_frame: Some(true),
        };
        let ordinary = Trace {
            exchanges: vec![
                ex("https://shop.example/blogs/read/a-day-out", "Document", "text/html", "<!doctype html><html><head><title>A day out</title></head><body>A day out</body></html>"),
                ex("https://shop.example/s/app.js", "Script", "application/javascript", app),
                ex("https://shop.example/s/chunk.js", "Script", "application/javascript", "export const x = 1;"),
                // A script a worker imported, which the recording says the page's script sent: `Other`, declared a script.
                ex("https://shop.example/s/pixel.js", "Other", "text/javascript", "self.track = function () {};"),
                ex("https://shop.example/s/theme.css", "Stylesheet", "text/css", "article{font:16px serif}"),
                ex("https://shop.example/s/late.css", "Stylesheet", "text/css", "body{margin:0}"),
                ex("https://shop.example/api/articles/a-day-out", "Fetch", "application/json", r#"{"title":"A day out"}"#),
            ],
            inputs: vec![],
        };
        let asked = std::cell::Cell::new(0);
        let held = || {
            asked.set(asked.get() + 1);
            true
        };
        assert!(decoded_overlay_of_for(&ordinary, Some(&rec), "shop.example", &held).is_empty(), "no reply of the ordinary page is the page's code's to unpack");
        assert_eq!(asked.get(), 0, "and the runtime was never asked: no child process");
        let lacks = || unbrowse_learn::sandbox::Unheld::Lacks("has no permission model".into());
        assert_eq!(left_to_page_code_for(&ordinary, Some(&rec), "shop.example", Some(lacks())), None);
        let mut with_cipher = ordinary.clone();
        with_cipher.exchanges.push(ex("https://shop.example/api/cipher/search?q=lamp", "Fetch", "text/plain", ciphered));
        let programs = decoded_overlay_of_for(&with_cipher, Some(&rec), "shop.example", &held);
        assert_eq!(asked.get(), 1, "the runtime is asked once, for the one reply a script was handed");
        assert_eq!(programs.len(), 1, "the script that sent and read the ciphered call is cut as its decoder");
        assert!(programs[0].contains("unpack"), "{}", programs[0]);
        assert_eq!(left_to_page_code_for(&with_cipher, Some(&rec), "shop.example", Some(lacks())), Some(lacks()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_reply_only_the_pages_code_reads_on_a_machine_that_runs_none_says_why() {
        use unbrowse_learn::sandbox::Unheld;
        let dir = std::env::temp_dir().join(format!("unbrowse-left-to-page-code-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let script = "function load(){ return fetch('/api/data').then(r => r.text()).then(unpack); }";
        let ciphered = "Zx9#q!w-ciphered*answer~that*no*reader*reads";
        let lines = [
            serde_json::json!({"type": "exchange", "t": 3.0, "resourceType": "Fetch", "entry": {
                "_initiator": {"type": "script", "frames": [{"scriptId": "7", "url": "https://shop.example/app.js", "function": "load", "line": 0, "column": 20}]},
                "request": {"method": "GET", "url": "https://shop.example/api/data", "headers": []},
                "response": {"status": 200, "headers": [], "content": {"mimeType": "text/plain", "text": ciphered}}}}),
            serde_json::json!({"type": "script", "t": 1.0, "scriptId": "7", "url": "https://shop.example/app.js", "language": "js", "sha256": unbrowse_learn::blobs::sha256_hex(script.as_bytes()), "length": script.len(), "source": script}),
        ];
        let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(agent_browser_core::session::capture_path(&dir, "w"), text).unwrap();
        let rec = unbrowse_learn::recording::Recording::read(&dir, "w").expect("a recording");
        let reply = |body: &str| Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/data".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "text/plain".into())],
            response_body: Some(body.into()),
            response_mime: "text/plain".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let walk = |body: &str| Trace { exchanges: vec![reply(body)], inputs: vec![] };
        let lacks = || Unheld::Lacks("has no permission model (process.permission); a newer Node has it".into());
        assert_eq!(left_to_page_code_for(&walk(ciphered), Some(&rec), "shop.example", Some(lacks())), Some(lacks()));
        assert_eq!(left_to_page_code_for(&walk(ciphered), Some(&rec), "shop.example", None), None, "a runtime that can be held reads it");
        assert_eq!(left_to_page_code_for(&walk(r#"{"items":[]}"#), Some(&rec), "shop.example", Some(lacks())), None, "a reply a standard reader reads");
        assert_eq!(left_to_page_code_for(&walk(ciphered), None, "shop.example", Some(lacks())), None, "no recording, no sender");
        let why = Unlearned::Runtime(format!("the page's answer is read only by the page's own code: {}", lacks().said())).to_string();
        assert!(why.contains("has no permission model") && !why.contains("clicks or typing"), "{why}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A walk the site sent to a check that names the page to come back to: what that check loads is the check's, so a
    /// call of its own is never the answer, whatever it says.
    #[test]
    fn a_walk_sent_to_a_page_that_names_it_to_come_back_to_keeps_nothing() {
        let url = "https://so.site.example/search_video/q_film";
        let check = "https://so.site.example/search_video/q_film/check/gate?back=%2Fsearch_video%2Fq_film";
        let held = Trace { exchanges: vec![main_page(302, url, ""), main_page(200, check, "<html><body>Slide to verify</body></html>")], inputs: vec![] };
        assert!(not_the_page(&held, url).is_some_and(|w| w.contains("naming it to come back to")));
        let by_script = Trace { exchanges: vec![main_page(200, url, "<html><script>location.replace('…')</script></html>"), main_page(200, check, "<html></html>")], inputs: vec![] };
        assert!(not_the_page(&by_script, url).is_some(), "a page its own script moved on");
    }


    /// HTML is the fallback: when a walk holds both the page and the call that fills it, the call is the route. A page
    /// that mentions what was asked more often than the call's records are numerous is still the page, not the answer.
    #[test]
    fn a_data_call_beats_the_page_that_renders_it() {
        let url = "https://shop.example/search?q=kettle";
        let html = format!("<html><head><title>Kettle</title></head><body>{}</body></html>", "<p>kettle kettle</p>".repeat(120));
        let page = main_page(200, url, &html);
        let data = Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/search?q=kettle".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(serde_json::json!({ "items": (0..20).map(|i| serde_json::json!({ "id": i, "price": i })).collect::<Vec<_>>() }).to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = Trace { exchanges: vec![page, data], inputs: vec![] };
        let site = site_of("shop.example");
        let view = view_of("t", url, &site, &trace, 0);
        let values = vec!["kettle".to_string()];
        let scores = rule_scores(&trace, &view, "find listings for kettle", &values, &[]);
        let (i, _) = rule_pick(&trace, &view, "find listings for kettle", &values, scores).expect("a pick");
        assert_eq!(trace.exchanges[i].url.path(), "/api/search", "the call, not the page that renders it");
    }

    /// The walk that exposed it: a marketplace's search page renders its listings itself, each naming what was asked,
    /// and beside them fetches a strip of the site's certified items. The strip's call takes the word and answers
    /// with priced records, so it ranked as the search; its records are the same for every word of a kind, and three
    /// words were answered alike. Where the page's own records say the word back and a call's mostly do not, the
    /// call lists something else than the page shows for the word.
    #[test]
    fn a_list_beside_the_results_does_not_beat_the_page_that_shows_them() {
        let url = "https://market.example/search/kettle/";
        let listings: String = (0..24).map(|i| format!("<div class=\"card\"><a href=\"/p/{i}\">Steel kettle number {i}</a><span>${i}.00</span></div>")).collect();
        let page = main_page(200, url, &format!("<html><head><title>kettle</title></head><body><main>{listings}</main></body></html>"));
        let strip = Exchange {
            method: "POST".into(),
            url: "https://market.example/api/certified-search/".parse().unwrap(),
            request_headers: vec![],
            request_body: Some(r#"{"query":{"queryString":"kettle"}}"#.into()),
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(serde_json::json!({ "searched": "kettle", "results": (0..15).map(|i| serde_json::json!({ "id": format!("P{i}"), "name": format!("Certified phone {i}"), "price": format!("${i}99.00") })).collect::<Vec<_>>() }).to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = Trace { exchanges: vec![page, strip], inputs: vec![] };
        let site = site_of("market.example");
        let view = view_of("t", url, &site, &trace, 0);
        let values = vec!["kettle".to_string()];
        let scores = rule_scores(&trace, &view, "find listings for kettle", &values, &[]);
        let (i, _) = rule_pick(&trace, &view, "find listings for kettle", &values, scores).expect("a pick");
        assert!(trace.exchanges[i].is_main_document(), "the page that shows the results, not the strip beside them: {}", trace.exchanges[i].url.path());
    }

    /// A goal for one thing names one thing (`price of bitcoin`); a plural names a list of them (`flights from
    /// Singapore to Tokyo`), even where the caller left out a list's verb. The endings that look plural and are not
    /// (`status`, `analysis`) and a number's pieces are not plurals.
    #[test]
    fn a_plural_goal_wants_a_list() {
        assert!(wants_one("price of bitcoin"));
        assert!(wants_one("who is the ceo of openai"));
        assert!(wants_one("status of the order"));
        assert!(wants_one("analysis of the market"));
        assert!(!wants_one("flights from Singapore to Tokyo on 2026-12-01"));
        assert!(!wants_one("hotels in Tokyo"));
        assert!(!wants_one("find listings for kettle"));
    }

    /// The page's own address is the ask: a page asked `?dcity=sin&acity=tyo` carries both values by being asked, so
    /// counting them as evidence made it the answer to every question ahead of the call whose path names the goal and
    /// whose answer lists the flights (Trip.com's `FlightListSearchSSE` against the `showfarefirst` page it fills).
    #[test]
    fn the_pages_own_query_is_the_ask_not_evidence_it_answers() {
        let url = "https://sg.trip.com/flights/showfarefirst?dcity=sin&acity=tyo&ddate=2026-12-01";
        let html = format!("<html><head><title>Flights</title></head><body>{}</body></html>", "<p>sin tyo 2026-12-01 flights</p>".repeat(60));
        let page = main_page(200, url, &html);
        let flights = serde_json::json!({"flightList": (0..40).map(|i| serde_json::json!({"price": 300 + i, "depart": "SIN", "arrive": "TYO", "departDateTime": "2026-12-01 09:30:00"})).collect::<Vec<_>>()});
        let sse = Exchange {
            method: "POST".into(),
            url: "https://sg.trip.com/restapi/soa2/27015/FlightListSearchSSE".parse().unwrap(),
            request_headers: vec![],
            request_body: Some(serde_json::json!({"departCityCode": "SIN", "arriveCityCode": "TYO", "departDate": "2026-12-01"}).to_string()),
            status: 200,
            response_headers: vec![("content-type".into(), "text/event-stream".into())],
            response_body: Some(format!("data:{flights}")),
            response_mime: "text/event-stream".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        // The site's header asks its own settings by carrying the page's address along (`"url": "…?dcity=sin&acity=tyo"`):
        // it "contains" every value the page was asked with without asking for any of them, and it answered before the
        // search did. It is not the answer to the search.
        let header = Exchange {
            method: "POST".into(),
            url: "https://sg.trip.com/m/home/getHeaderInfo?locale=en-SG".parse().unwrap(),
            request_headers: vec![],
            request_body: Some(serde_json::json!({"channel": "flights", "locale": "en-SG", "currency": "SGD", "url": url}).to_string()),
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(serde_json::json!({"localeName": "English (Singapore)", "flag": [0, 5], "plugins": [{"id": "a"}, {"id": "b"}]}).to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let inputs = vec![Input::new("dcity", "sin"), Input::new("acity", "tyo"), Input::new("ddate", "2026-12-01")];
        let trace = Trace { exchanges: vec![page, header, sse], inputs };
        let site = site_of("sg.trip.com");
        let view = view_of("t", url, &site, &trace, 0);
        let values = vec!["sin".to_string(), "tyo".to_string(), "2026-12-01".to_string()];
        let goal = "flights from Singapore to Tokyo on 2026-12-01";
        let scores = rule_scores(&trace, &view, goal, &values, &[]);
        let (i, reasons) = rule_pick(&trace, &view, goal, &values, scores).expect("a pick");
        assert_eq!(trace.exchanges[i].url.path(), "/restapi/soa2/27015/FlightListSearchSSE", "the streamed call, not the page that renders it: {reasons:?}");
    }

    /// A goal for one thing (`IMDb rating of The Shawshank Redemption`, on the thing's own page `/title/tt0111161/`) is
    /// answered where the thing's own record holds the field: the record that names it (`id: "tt0111161"`) carrying a
    /// rating of its own (`ratingsSummary.aggregateRating`). A call about the thing whose ratings belong to a list of
    /// other records under it (each featured review's `authorRating`) answers something else. Steve, UNB-300: IMDb's
    /// route was its featured reviews, while only the title page's embedded state carried the title's rating (9.3); the
    /// rank put a data call over the page whenever both named the thing. The cut is that walk's page (its title and the
    /// state of the title) and its reviews call, reviewers scrubbed.
    #[test]
    fn a_goal_for_one_thing_is_answered_by_the_things_own_record_not_a_list_under_it() {
        store::scratch_home("one-thing");
        let session = browsed_session(&cut("title-page-and-its-reviews.jsonl")).unwrap();
        let out = learn_from_session(&session, "imdb.com", Some("IMDb rating of The Shawshank Redemption"), 1795540000.0, 1795540000.0, 1795540004.0, "w", &no_eye, None).unwrap();
        let Outcome::Route { route, .. } = out else { panic!("the page answers") };
        assert_eq!(route.site, "www.imdb.com", "the page whose state holds the title's own rating, not the reviews call: {} {}", route.site, route.path);
        assert!(!route.path.contains("operationName"), "the title page, not {}", route.path);
    }

    /// A call that carries the page's address along holds every value the page was asked with, and each one reads as a
    /// form field of the address (`dcity=sin`) although the call's body is JSON. It sends none of them: its own values
    /// are the two locale settings. A call that sends the value itself does.
    #[test]
    fn a_page_carried_along_sends_none_of_its_values() {
        let body = serde_json::json!({"locale": "en-SG", "url": "https://sg.example/flights?dcity=sin&acity=tyo&ddate=2026-12-01"});
        let mut e = walked("POST", "https://sg.example/m/home/getHeaderInfo?locale=en-SG", &body.to_string(), false);
        e.request_headers = vec![("content-type".into(), "application/json".into())];
        e.request_body = Some(body.to_string());
        let address = page_address("https://sg.example/flights?dcity=sin&acity=tyo&ddate=2026-12-01");
        assert!(!sends_its_own_ask(&e, "sin", address.as_deref()), "the page's value is in the address it carries");
        assert!(!sends_its_own_ask(&e, "2026-12-01", address.as_deref()));
        assert!(sends_its_own_ask(&e, "en-sg", address.as_deref()), "its own value");
        // A JSON body's words are not form fields: `dcity=sin` inside the carried address is not a pair the call sent.
        assert!(!sends_as_its_own(&e, "sin"));
    }

    /// A search box's suggestions echo the term and hold many more records than the answer. The call whose own answer
    /// names the goal (`availability` for a goal about availability) is the answer — the shape OpenTable's
    /// `RestaurantsAvailability` has against its `Autocomplete`, told apart by the answer's keys, not its path (both are
    /// `/dapi/fe/gql`).
    #[test]
    fn a_calls_own_answer_beats_a_suggestion_list_that_echoes_the_term() {
        let url = "https://book.example/s/?covers=2&term=london";
        let html = format!("<html><head><title>London</title></head><body>{}</body></html>", "<p>london</p>".repeat(120));
        let page = main_page(200, url, &html);
        let post = |op: &str, body: serde_json::Value| Exchange {
            method: "POST".into(),
            url: url::Url::parse(&format!("https://book.example/dapi/fe/gql?optype=query&opname={op}")).unwrap(),
            request_headers: vec![],
            request_body: Some(serde_json::json!({ "variables": { "term": "london", "covers": 2 } }).to_string()),
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(body.to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let suggestions = post("Autocomplete", serde_json::json!({ "data": { "autocomplete": { "autocompleteResults": (0..40).map(|i| serde_json::json!({ "id": i, "name": format!("London {i}"), "macroName": null })).collect::<Vec<_>>() } } }));
        let availability = post("RestaurantsAvailability", serde_json::json!({ "data": { "availability": (0..3).map(|i| serde_json::json!({ "restaurantId": i, "availabilityDays": [{ "slots": [{ "time": "19:00", "isAvailable": true }] }] })).collect::<Vec<_>>() } }));
        let trace = Trace { exchanges: vec![page, suggestions, availability], inputs: vec![] };
        let site = site_of("book.example");
        let view = view_of("t", url, &site, &trace, 0);
        let values = vec!["london".to_string()];
        let scores = rule_scores(&trace, &view, "find restaurant availability", &values, &[]);
        let (i, reasons) = rule_pick(&trace, &view, "find restaurant availability", &values, scores).expect("a pick");
        assert_eq!(trace.exchanges[i].url.query_pairs().find(|(k, _)| k == "opname").map(|(_, v)| v.to_string()).as_deref(), Some("RestaurantsAvailability"), "the availability call, not the suggestions: {reasons:?}");
    }

    /// A page is handed over only where someone on it could get further: a sign-in or a wall is what hands are for, and
    /// a page the site says isn't there, or an address never walked, has nothing to click.
    #[test]
    fn hands_are_for_a_page_that_was_reached() {
        let url = "https://shop.example/items/9";
        let page = |at: &str, status: u16| Exchange { method: "GET".into(), url: url::Url::parse(at).unwrap(), request_headers: Vec::new(), request_body: None, status, response_headers: Vec::new(), response_body: Some("<html></html>".into()), response_mime: "text/html".into(), resource_type: Some("Document".into()), main_frame: Some(true) };
        let walk = |exchanges| Trace { exchanges, inputs: Vec::new() };
        assert!(matches!(page_unreached(&walk(vec![page(url, 404)]), url), Some(Unlearned::Gone(_))));
        assert!(matches!(page_unreached(&walk(vec![page("https://shop.example/login?next=/items/9", 200)]), url), Some(Unlearned::Hands(_))));
        assert_eq!(page_unreached(&walk(vec![page(url, 200)]), url), None);
        assert!(unwalkable("not an address", &[]).is_some());
        assert!(unwalkable("ftp://shop.example/x", &[]).is_some());
        assert!(unwalkable(url, &["shop.example".to_string()]).is_some_and(|w| w.contains("excluded")));
        assert_eq!(unwalkable(url, &[]), None);
        // Refused before any browser starts, as what it is.
        let walks = Walks::default();
        assert!(matches!(learn_goal(&walks, "ftp://shop.example/x", "list items"), Err(Unlearned::Unwalkable(_))));
    }

    /// A choice in a select reaches the site as its option's value, not the label the browser logs. A write whose only
    /// choices are selects is learned, with the value as the input's default.
    #[test]
    fn a_select_is_matched_by_the_value_its_option_sends() {
        let form = r#"<html><body><form><select id="type"><option value="0">CHECKING</option><option value="1"> SAVINGS </option></select></form></body></html>"#;
        let line = |v: serde_json::Value| v.to_string();
        let log = [
            line(serde_json::json!({"type":"action","t":1.0,"action":"navigate","value":"https://bank.example/open","secret":false})),
            line(serde_json::json!({"type":"exchange","t":1.5,"resourceType":"Document","entry":{"request":{"method":"GET","url":"https://bank.example/open","headers":[]},"response":{"status":200,"headers":[],"content":{"mimeType":"text/html","text":form}}}})),
            line(serde_json::json!({"type":"action","t":2.0,"action":"select","selector":"@e7","field":"type","value":"SAVINGS","secret":false})),
            line(serde_json::json!({"type":"exchange","t":3.0,"resourceType":"XHR","entry":{"request":{"method":"POST","url":"https://bank.example/api/accounts?kind=1","headers":[]},"response":{"status":200,"headers":[],"content":{"mimeType":"application/json","text":r#"{"id":1234567,"created":true}"#}}}})),
        ].join("\n");
        let session = browsed_session(&log).unwrap();
        assert_eq!(session.actions.iter().find(|a| a.kind == "select").and_then(|a| a.value.as_deref()), Some("1"));
        // A label no page offers stays as it was logged.
        let other = log.replace(r#""value":"SAVINGS""#, r#""value":"BONDS""#);
        assert_eq!(browsed_session(&other).unwrap().actions.iter().find(|a| a.kind == "select").and_then(|a| a.value.as_deref()), Some("BONDS"));
    }

    /// A transfer the agent only chose the destination of. The form still sends the account its first select was left on,
    /// and the caller of the route has to be able to send from another (`Bank`'s check 3): the demo bank fills both selects
    /// from its accounts call, so the page names them and holds no option. A hidden token next to them is no choice.
    #[test]
    fn a_select_nobody_moved_is_still_the_callers_to_choose() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let form = r#"<html><body><form><input type=hidden name=token value=abc123456><input id=amount><select id=fromAccountId></select><select id=toAccountId></select></form></body></html>"#;
        let accounts = r#"[{"id":28329,"balance":100},{"id":28440,"balance":50}]"#;
        let done = r#"{"message":"Successfully transferred $1 from account #28329 to account #28440"}"#;
        let call = "https://bank.example/services/transfer?fromAccountId=28329&toAccountId=28440&amount=1&token=abc123456";
        let exchange = |t: f64, kind: &str, method: &str, url: &str, mime: &str, text: &str| {
            serde_json::json!({"type":"exchange","t":t,"resourceType":kind,"entry":{"request":{"method":method,"url":url,"headers":[]},"response":{"status":200,"headers":[],"content":{"mimeType":mime,"text":text}}}}).to_string()
        };
        let action = |t: f64, action: &str, selector: &str, value: &str| {
            serde_json::json!({"type":"action","t":t,"action":action,"selector":selector,"value":value,"secret":false}).to_string()
        };
        let log = [
            serde_json::json!({"type":"action","t":1.0,"action":"navigate","value":"https://bank.example/transfer","secret":false}).to_string(),
            exchange(1.5, "Document", "GET", "https://bank.example/transfer", "text/html", form),
            exchange(1.6, "XHR", "GET", "https://bank.example/services/accounts", "application/json", accounts),
            action(2.0, "fill", "@e5", "1"),
            action(2.5, "select", "@e7", "28440"),
            exchange(3.0, "XHR", "POST", call, "application/json", done),
        ]
        .join("\n");
        store::scratch_home("left-as-set");
        let session = browsed_session(&log).unwrap();
        let Ok(Outcome::Route { route, .. }) = learn_from_session(&session, "bank.example", Some("transfer money"), 0.5, 0.5, 4.0, "w", &|_| {}, None) else { panic!("no route") };
        let mut names: Vec<&str> = route.inputs.iter().map(|i| i.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["amount", "fromAccountId", "toAccountId"]);
        let from = route.inputs.iter().find(|i| i.name == "fromAccountId").unwrap();
        assert_eq!(from.default.as_deref(), Some("28329"));
    }

    /// A walk starts with the site's kept session: the jar's cookies, each where the site set it, and not the tokens its
    /// routes send in headers. With signed-in calls off it starts with nothing.
    #[test]
    fn a_walk_starts_with_the_sites_kept_session() {
        store::scratch_home("kept-session");
        let jar = std::collections::BTreeMap::from([("JSESSIONID".to_string(), "a1".to_string()), ("pref".to_string(), "b2".to_string()), ("x-api-key".to_string(), "k3".to_string())]);
        store::write_json(&store::jar_path("bank.site.example"), &unbrowse_files::JAR, &jar).unwrap();
        let scope = std::collections::BTreeMap::from([("pref".to_string(), ".site.example".to_string())]);
        store::write_json(&store::jar_scope_path("bank.site.example"), &unbrowse_files::JAR, &scope).unwrap();
        let url = "https://bank.site.example/parabank/services/accounts";
        let route: store::Route = serde_json::from_value(serde_json::json!({
            "id": "kept", "site": "bank.site.example", "what": "read the accounts", "method": "GET", "path": "/parabank/services/accounts",
            "root": url, "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }] }
        }))
        .unwrap();
        let mut route = route;
        route.graph.steps[0].fields.push(unbrowse_learn::graph::Field {
            loc: unbrowse_learn::slots::Loc::Header("x-api-key".into()),
            class: unbrowse_learn::graph::Class::Minted { name: "x-api-key".into() },
        });
        store::save_route(&route).unwrap();
        let seed = kept_session("bank.site.example");
        assert_eq!(
            seed,
            [
                unbrowse_learn::mint::SeedCookie { name: "JSESSIONID".into(), value: "a1".into(), domain: None, ..Default::default() },
                unbrowse_learn::mint::SeedCookie { name: "pref".into(), value: "b2".into(), domain: Some(".site.example".into()), ..Default::default() },
            ]
        );
        let mut s = store::load_settings();
        s.signed_in_calls = false;
        store::save_settings(&s).unwrap();
        assert!(kept_session("bank.site.example").is_empty());
    }

    /// A scrubbed cut of a walk the node recorded (`tests/fixtures/walks`), as a browsing session.
    fn cut(name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/walks").join(name)).expect("the cut")
    }

    /// The walk that exposed it: a company's reviews page opened signed out. Its own document shows the reviews; beside
    /// it the page's scripts fetched a session recorder's config, a sign-in widget's status and the sign-up modal's
    /// markup, which names the company and the word reviews in its prompt and is bigger than all of them. None of
    /// those says anything the page showed; the page itself does.
    #[test]
    fn a_call_whose_answer_carries_nothing_the_page_showed_never_wins() {
        store::scratch_home("shown");
        let session = browsed_session(&cut("reviews-page-signed-out.jsonl")).unwrap();
        let out = learn_from_session(&session, "glassdoor.sg", Some("read a company's Glassdoor reviews"), 1793599310.0, 1793599310.0, 1793599312.53, "w", &no_eye, None).unwrap();
        let Outcome::Route { route, .. } = out else { panic!("the page itself answers") };
        assert_eq!((route.site.as_str(), route.method.as_str()), ("www.glassdoor.sg", "GET"), "{}", route.path);
        assert!(route.path.starts_with("/Reviews/"), "the page, not {}", route.path);
    }

    /// A package's page asked for its release history. The page's own document lists every release; the page also
    /// calls another site's API about the package's code, sending the package's name, and that answer names releases
    /// only in a key (`releases_url`, an address template). Sending the page's subject to another site asks that site
    /// about it: it is held to what the page showed, and says none of it. A call to another site that does say what
    /// the page showed (a search service the page draws its list from) still answers.
    #[test]
    fn a_call_to_another_site_about_the_pages_subject_is_not_the_pages_answer() {
        let call = |url: &str, document: bool, answer: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(answer.into()),
            response_mime: if document { "text/html" } else { "application/json" }.into(),
            resource_type: Some(if document { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let rows: String = (0..24).map(|n| format!("<li><a href=\"/project/widget/3.{n}.0/\">widget 3.{n}.0 released on day {n} of the month</a></li>")).collect();
        let page = call("https://pkgs.example/project/widget/", true, &format!("<html><body><h1>widget</h1><h2>Release history</h2><ul>{rows}</ul></body></html>"));
        let shown = page_shown([&page], page.url.as_str(), &[]);
        assert!(shown.judges(), "the fixture's page shows enough to judge by");
        let asked = vec!["widget".to_string()];
        assert!(shown.lists(&asked), "the page's own document lists the releases");
        let goal = "release history of this package";
        let repo = call("https://api.code.example/repos/acme/widget", false, r#"{"id":41,"full_name":"acme/widget","releases_url":"https://api.code.example/repos/acme/widget/releases{/id}","forks_url":"https://api.code.example/repos/acme/widget/forks","stargazers_count":5100}"#);
        assert!(shows_nothing(&repo, &shown, "pkgs.example", &asked, goal).is_some(), "another site's record about the subject");
        assert_eq!(shows_nothing(&page, &shown, "pkgs.example", &asked, goal), None, "the page itself");
        let listed: Vec<serde_json::Value> = (0..24).map(|n| serde_json::json!({ "version": format!("3.{n}.0"), "note": format!("widget 3.{n}.0 released on day {n} of the month") })).collect();
        let search = call("https://search-service.example/q?pkg=widget", false, &serde_json::json!({ "hits": listed }).to_string());
        assert_eq!(shows_nothing(&search, &shown, "pkgs.example", &asked, goal), None, "another site that says what the page showed");
        // As the live record has it: the record names the subject, as the page's address does. Naming what was asked
        // says nothing the page showed.
        let named = call("https://api.code.example/repos/acme/widget", false, r#"{"id":41,"name":"widget","full_name":"acme/widget","topics":["widget","python"],"releases_url":"https://api.code.example/repos/acme/widget/releases{/id}","stargazers_count":5100}"#);
        assert!(shows_nothing(&named, &shown, "pkgs.example", &asked, goal).is_some(), "another site's record naming the subject");
        // And sharing the subject's one line of summary, which the page shows above its listing.
        let summed = call("https://pkgs.example/project/widget/", true, &format!("<html><body><h1>widget</h1><p>A small, sturdy widget for every workshop.</p><h2>Release history</h2><ul>{rows}</ul></body></html>"));
        let shown = page_shown([&summed], summed.url.as_str(), &[]);
        let about = call("https://api.code.example/repos/acme/widget", false, r#"{"id":41,"name":"widget","full_name":"acme/widget","description":"A small, sturdy widget for every workshop.","releases_url":"https://api.code.example/repos/acme/widget/releases{/id}"}"#);
        assert!(shows_nothing(&about, &shown, "pkgs.example", &asked, goal).is_some(), "the subject's summary is not the page's listing");
        assert_eq!(shows_nothing(&search, &shown, "pkgs.example", &asked, goal), None, "another site that says what the page lists still answers");
    }

    /// The walk that exposed it: a company's site searched for "5G". The page's search call posts the word as one
    /// field of its body and answers with articles the served page never showed (its script draws them). Two letters
    /// are too few to find in an address by chance, so the call was held as saying nothing of the page and the empty
    /// page was kept. A word the goal spells, sent as a field of its own, is what the page was asked for; the same
    /// two letters inside a longer field, or under a goal that never says them, are not.
    #[test]
    fn a_short_word_the_goal_spells_counts_when_a_call_sends_it_as_a_field() {
        let call = |url: &str, sent: Option<&str>, document: bool, answer: &str| Exchange {
            method: if sent.is_some() { "POST" } else { "GET" }.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: sent.map(String::from),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(answer.into()),
            response_mime: if document { "text/html" } else { "application/json" }.into(),
            resource_type: Some(if document { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let rows: String = (0..30).map(|n| format!("<li><a href=\"/about/office-{n}\">Regional office number {n} opening hours</a></li>")).collect();
        let page = call("https://www.corp.example/en/searchresult?keywords=5G", None, true, &format!("<html><body><h1>Search Results</h1><ul>{rows}</ul></body></html>"));
        let shown = page_shown([&page], page.url.as_str(), &[]);
        assert!(shown.judges(), "the fixture's page shows enough to judge by");
        let asked = vec!["5G".to_string()];
        let answer = r#"{"data":[{"title":"Private networks for ports"},{"title":"Fixed wireless access"}]}"#;
        let search = call("https://www.corp.example/api/search", Some(r#"{"searchTxt":"5G","pageNum":1}"#), false, answer);
        assert_eq!(shows_nothing(&search, &shown, "corp.example", &asked, "search corp.example for 5G"), None);
        let inside = call("https://www.corp.example/api/log", Some(r#"{"session":"a5g7"}"#), false, answer);
        assert!(shows_nothing(&inside, &shown, "corp.example", &asked, "search corp.example for 5G").is_some());
        assert!(shows_nothing(&search, &shown, "corp.example", &asked, "search corp.example").is_some(), "a goal that never says the word");
    }

    /// The same walk's search page, read from after its document loaded (the part of the log a later learn reads): the
    /// page's own calls left are its search suggestions, a session recorder's config on the recorder's host and a
    /// sign-in widget's status on the widget's. Neither vendor's host is the site's, the site never declared either,
    /// and neither answer says what the page showed or sends what it was asked for: neither is kept for the page.
    #[test]
    fn a_call_to_a_host_the_site_never_declared_is_its_answer_only_when_it_says_what_the_page_showed() {
        store::scratch_home("vendor");
        let log: String = cut("search-results-page.jsonl").lines().filter(|l| !l.contains(r#""resourceType": "Document""#)).collect::<Vec<_>>().join("\n");
        let session = browsed_session(&log).unwrap();
        // With no goal stated, the biggest answer the rule scores best: the recorder's config, on main.
        let out = learn_from_session(&session, "glassdoor.sg", None, 1793599267.0, 1793599267.0, 1793599280.09, "w", &no_eye, None).unwrap();
        let Outcome::Route { route, .. } = out else { panic!("the site's own suggestions answer the page") };
        assert_eq!(route.site, "www.glassdoor.sg", "a vendor's call was kept for the page: {} {}", route.site, route.path);
        let out = learn_from_session(&session, "glassdoor.sg", Some("read a company's Glassdoor reviews"), 1793599267.0, 1793599267.0, 1793599280.09, "w", &no_eye, None).unwrap();
        if let Outcome::Route { route, .. } = out {
            assert_eq!(route.site, "www.glassdoor.sg", "a vendor's call was kept for the page: {} {}", route.site, route.path);
        }
    }

    /// The check against another site's walk: a travel site's front page, with its ad exchange's price floors (a big
    /// JSON, the biggest answer the page loaded) and a messaging vendor's config, whose categories share a few single
    /// words with the page's tabs. Neither says what the page showed.
    #[test]
    fn an_ad_config_on_another_site_never_wins_either() {
        store::scratch_home("ads");
        let session = browsed_session(&cut("front-page-with-ad-config.jsonl")).unwrap();
        let out = learn_from_session(&session, "tripadvisor.com", None, 1793133661.6, 1793133661.6, 1793135035.8, "w", &no_eye, None).unwrap();
        if let Outcome::Route { route, .. } = out {
            assert_eq!(route.site, "www.tripadvisor.com", "a vendor's call was kept for the page: {} {}", route.site, route.path);
        }
    }

    /// The learner's pick for each flow of a browsing the node recorded, without a browser: `REPRO_LOG` is a site's
    /// browse log (`~/.unbrowse/browse/browse_<site>.jsonl`, read only), `REPRO_SITE` its site, `REPRO_GOAL` the goal
    /// (none when unset). Each stretch between two of the agent's steps is read as a flow, and its pick printed.
    #[test]
    #[ignore]
    fn pick_from_a_recorded_browsing() {
        let (Ok(log), Ok(site)) = (std::env::var("REPRO_LOG"), std::env::var("REPRO_SITE")) else { return };
        let goal = std::env::var("REPRO_GOAL").ok();
        store::scratch_home("repro");
        let raw = std::fs::read_to_string(log).unwrap();
        let session = browsed_session(&raw).unwrap();
        let mut navs: Vec<f64> = session.actions.iter().filter(|a| a.kind != "read").map(|a| a.t).collect();
        // The stretch after the last step too: what the last step sent lands after it.
        navs.push(f64::INFINITY);
        for w in navs.windows(2) {
            let (since, until) = (w[0] - 0.5, w[1] - 0.01);
            let out = learn_from_session(&session, &site, goal.as_deref(), since, since, until, "w", &|e| if let Eye::Scored { candidates, .. } = e { for c in candidates { eprintln!("    {:6.1} {} {} {}{}", c.score, c.method, c.host, c.path, if c.noise { " noise" } else { "" }); } }, None);
            match out {
                Ok(Outcome::Route { route, by, .. }) => println!("{since}..{until}: ROUTE by {by}: {} {} {} inputs={:?}", route.method, route.site, route.path, route.inputs.iter().map(|i| &i.name).collect::<Vec<_>>()),
                Ok(Outcome::Nothing(w)) => println!("{since}..{until}: nothing: {w}"),
                Ok(Outcome::Unsent(w)) => println!("{since}..{until}: unsent: {w}"),
                Err(e) => println!("{since}..{until}: err {e}"),
            }
        }
    }

    /// A route an input of which the owner's own browsing session gave is held to the fragment guard's sources, whatever
    /// its walk's addresses say: a code the owner typed that the page wraps in base64 and sends under another name can't
    /// be found by its text, so the route isn't listed. A route whose input a caller named for the walk (their own
    /// word) and whose constants the document explains still lists.
    #[test]
    fn a_route_carrying_what_the_owners_session_gave_is_held_to_the_guard() {
        let start = "https://bank.example.com/start";
        let learned = |body: &str| {
            let page = walked("GET", start, r#"<html><head><script src="/app.js"></script></head><body>sign in</body></html>"#, true);
            let mut app = walked("GET", "https://bank.example.com/app.js", "fetch('/api/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: btoa(code), q: q, mode: 'search' }) }).then((r) => r.results.map((x) => x.name));", false);
            app.resource_type = Some("Script".into());
            let mut call = walked("POST", "https://bank.example.com/api/exchange", r#"{"results":[{"name":"Lamps for reading"},{"name":"Desk lamps"}]}"#, false);
            call.request_body = Some(body.into());
            call.request_headers.push(("content-type".into(), "application/json".into()));
            let trace = Trace { exchanges: vec![page, app, call], inputs: Vec::new() };
            let mut route = route_of(&trace, 2, "exchange the code", start, true, &[], &[], Some(&[start.to_string()])).unwrap();
            // However the learner kept the page's wrap of the owner's code, it is a constant here.
            for f in route.graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
                if f.loc == unbrowse_learn::slots::Loc::Json("/v".into()) {
                    let value = match &f.class {
                        unbrowse_learn::Class::Constant { value, .. } | unbrowse_learn::Class::Unconfirmed { value } => value.clone(),
                        _ => "QUJDMTIz".into(),
                    };
                    f.class = unbrowse_learn::Class::Constant { value, origin: None };
                }
            }
            route.page_made = page_made(&route.graph, &trace, start);
            route
        };
        let mut typed = learned(r#"{"v":"QUJDMTIz","mode":"search"}"#);
        assert!(typed.walk_without_fragment, "the walk itself says nothing of a fragment");
        typed.given = vec!["code".into()];
        typed.session_gave = true;
        assert!(crate::recipe::compile(&typed).is_err_and(|why| why.contains("body /v") && why.contains("owner's session")), "{:?}", crate::recipe::compile(&typed).err());
        // A search term a caller named for the walk: their own word, and the document explains every constant.
        let mut named = learned(r#"{"q":"lamps","mode":"search"}"#);
        named.given = vec!["q".into()];
        assert!(crate::recipe::compile(&named).is_ok(), "{:?}", crate::recipe::compile(&named).err());
    }

    /// The fragment guard is the walk's, not one address's: a walk that went on to an address with a fragment (a callback
    /// the page reached, a redirect's `Location`), or whose capture can't say it didn't, is held to it, so a code the
    /// page read there and posted as a constant isn't listed. Only bytes served before any of the walk's page code ran
    /// explain a text: never a document that came with a cookie (page code may have set it, and the site say it back),
    /// never a later document. A walk shown never to have been at an address with a fragment lists as before.
    #[test]
    fn a_walk_that_was_at_any_address_with_a_fragment_is_held_to_the_guard() {
        let start = "https://bank.example.com/start";
        let learned = |visited: Option<&[String]>, before: Vec<Exchange>, cookie: Option<&str>, document: &str| {
            let mut page = walked("GET", start, document, true);
            if let Some(c) = cookie {
                page.request_headers.push(("cookie".into(), c.into()));
            }
            let mut app = walked("GET", "https://bank.example.com/app.js", "fetch('/api/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: code, mode: 'search' }) }).then((r) => r.results.map((x) => x.name));", false);
            app.resource_type = Some("Script".into());
            let mut call = walked("POST", "https://bank.example.com/api/exchange", r#"{"results":[{"name":"Lamps for reading"},{"name":"Desk lamps"}]}"#, false);
            call.request_body = Some(r#"{"v":"7391","mode":"search"}"#.into());
            call.request_headers.push(("content-type".into(), "application/json".into()));
            let mut exchanges = vec![page, app];
            exchanges.extend(before);
            exchanges.push(call);
            let trace = Trace { exchanges, inputs: Vec::new() };
            route_of(&trace, trace.exchanges.len() - 1, "exchange the code", start, true, &[], &[], visited).unwrap()
        };
        let shell = r#"<html><head><script src="/app.js"></script></head><body>sign in</body></html>"#;
        let refused = |route: &Route| crate::recipe::compile(route).is_err_and(|why| why.contains("fragment"));
        // Never at an address with a fragment, and the walk says so: listed as before.
        let plain = learned(Some(&[start.to_string()]), vec![], None, shell);
        assert!(plain.walk_without_fragment && crate::recipe::compile(&plain).is_ok(), "{:?}", crate::recipe::compile(&plain).err());
        // The page went on to a callback whose fragment held the code.
        let callback = learned(Some(&[start.to_string(), "https://bank.example.com/callback#code=7391".to_string()]), vec![], None, shell);
        assert!(!callback.walk_without_fragment && refused(&callback), "{:?}", callback.page_made);
        // A redirect the walk followed named one in its Location.
        let mut moved = walked("GET", "https://bank.example.com/go", "", false);
        moved.status = 302;
        moved.response_headers.push(("location".into(), "/callback#code=7391".into()));
        assert!(refused(&learned(Some(&[start.to_string()]), vec![moved], None, shell)));
        // A walk whose capture can't say where its browser was.
        assert!(refused(&learned(None, vec![], None, shell)));
        // The first document says the code back, but it came with a cookie: earlier page code may have set it.
        let said_back = r#"<html><head><script src="/app.js"></script></head><body>sign in 7391</body></html>"#;
        let callback_at = [start.to_string(), "https://bank.example.com/callback#code=7391".to_string()];
        assert!(refused(&learned(Some(&callback_at), vec![], Some("seen=7391"), said_back)));
        // A later document that says it back is never a source either: the walk's page code ran before it.
        let later = walked("GET", "https://bank.example.com/callback", said_back, true);
        assert!(refused(&learned(Some(&callback_at), vec![later], None, shell)));
    }

    /// The fragment guard holds whichever learner made the graph: a code the page read from a callback's fragment and
    /// posted is refused at the sharing boundary when the learner by example leaves it open for the caller
    /// (`Unconfirmed`) as when the classifier keeps it as a constant. A route that takes a login callback's code as the
    /// caller's input isn't shared, even with the value stripped.
    #[test]
    fn a_value_the_page_made_from_a_fragment_is_held_to_the_guard_however_it_was_learned() {
        let start = "https://bank.example.com/start";
        let shell = r#"<html><head><script src="/app.js"></script></head><body>sign in</body></html>"#;
        let page = walked("GET", start, shell, true);
        let mut app = walked("GET", "https://bank.example.com/app.js", "fetch('/api/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: code, mode: 'search' }) }).then((r) => r.results.map((x) => x.name));", false);
        app.resource_type = Some("Script".into());
        let mut call = walked("POST", "https://bank.example.com/api/exchange", r#"{"results":[{"name":"Lamps for reading"},{"name":"Desk lamps"}]}"#, false);
        call.request_body = Some(r#"{"v":"7391","mode":"search"}"#.into());
        call.request_headers.push(("content-type".into(), "application/json".into()));
        let trace = Trace { exchanges: vec![page, app, call], inputs: Vec::new() };
        let visited = [start.to_string(), "https://bank.example.com/callback#code=7391".to_string()];
        for by_example in [true, false] {
            let route = route_of_by(&trace, 2, "exchange the code", start, true, &[], &[], Some(&visited), by_example).unwrap();
            let open = route.graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(&f.class, unbrowse_learn::Class::Unconfirmed { value } if value == "7391"));
            assert!(!by_example || open, "the learner by example leaves the code open: the case this test is for");
            assert!(route.page_made.as_ref().is_some_and(|m| m.iter().any(|w| w.contains("body /v"))), "by_example={by_example}: {:?}", route.page_made);
            let compiled = crate::recipe::compile(&route);
            assert!(compiled.as_ref().is_err_and(|why| why.contains("fragment")), "by_example={by_example}: {:?}", compiled.map(|r| serde_json::to_string(&r).unwrap()));
        }
    }

    /// Where the graph reads a place from an earlier step's answer, the body kept beside it sends that place from the
    /// same answer, never as the walk recorded it: a cursor the page hands over on each load, held in the body as the
    /// walk's literal (or as a literal a caller's value was spliced into), would carry the first query's state into
    /// every later call. A place the body has no earlier step for, and one it already reads, keep their own ways.
    #[test]
    fn a_place_the_graph_reads_from_an_earlier_answer_is_never_sent_as_walked() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/search/lamp/", "fields": [], "needs_browser": false, "sets_cookie": false },
            { "exchange": 1, "method": "POST", "status": 200, "url": "https://shop.example/api/search", "fields": [
                { "loc": { "in": "json", "key": "/session" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/search/lamp/", "at": { "from": "json", "pointer": "/listing/session" } } },
                { "loc": { "in": "json", "key": "/query" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }
            ], "needs_browser": false, "sets_cookie": false }
        ]}))
        .unwrap();
        let mut body = unbrowse_learn::body::from_graph(&graph, "shop.example");
        let api = body.steps.iter().position(|s| s.method == "POST").unwrap();
        let cursor = || unbrowse_learn::route::Expr::text("eyJxdWVyeSI6ImxhbXAiLCJvZmZzZXQiOjQ4fQ==");
        // The body as the learner by example held it: the walk's cursor, open.
        let session = body.steps[api].holes.iter_mut().find(|h| h.at == unbrowse_learn::route::Place::Json("/session".into())).unwrap();
        session.ways = vec![unbrowse_learn::route::Way { rung: 0, expr: cursor() }];
        session.open = true;
        let query_before = body.steps[api].holes.iter().find(|h| h.at == unbrowse_learn::route::Place::Json("/query".into())).unwrap().ways.clone();
        let changed = sent_from_the_graphs_sources(&mut body, &graph);
        assert_eq!(changed.len(), 1, "{changed:?}");
        let session = body.steps[api].holes.iter().find(|h| h.at == unbrowse_learn::route::Place::Json("/session".into())).unwrap();
        assert!(!session.open && session.ways.iter().all(|w| !w.expr.reads().is_empty() || w.expr != cursor()), "{:?}", session.ways);
        assert!(session.ways[0].expr.reads() == vec![body.steps[0].id.as_str()], "read from the page's answer: {:?}", session.ways);
        assert_eq!(body.steps[api].holes.iter().find(|h| h.at == unbrowse_learn::route::Place::Json("/query".into())).unwrap().ways, query_before, "the caller's place keeps its way");
        // A body with no step for the answer the graph reads keeps the walk's value: there is nothing to read it from.
        let mut alone = unbrowse_learn::body::from_graph(&graph, "shop.example");
        alone.steps.retain(|s| s.method == "POST");
        let session = alone.steps[0].holes.iter_mut().find(|h| h.at == unbrowse_learn::route::Place::Json("/session".into())).unwrap();
        session.ways = vec![unbrowse_learn::route::Way { rung: 0, expr: cursor() }];
        assert!(sent_from_the_graphs_sources(&mut alone, &graph).is_empty());
        // The body learned from another sighting of the same call (another step id, the same method and address) is
        // still that call: its place is read from the earlier answer too.
        let mut other = unbrowse_learn::body::from_graph(&graph, "shop.example");
        let api = other.steps.iter().position(|s| s.method == "POST").unwrap();
        other.steps[api].id = "x9".into();
        let session = other.steps[api].holes.iter_mut().find(|h| h.at == unbrowse_learn::route::Place::Json("/session".into())).unwrap();
        session.ways = vec![unbrowse_learn::route::Way { rung: 0, expr: cursor() }];
        assert_eq!(sent_from_the_graphs_sources(&mut other, &graph).len(), 1, "another sighting of the same call");
    }

    /// A walk whose capture holds nothing from the walked page's own site (only the browser's start page) never saw
    /// the page: it reads as a capture that failed, never as a page that needs hands. Anything of the site's, its
    /// document on another of its hosts included, is the page seen.
    #[test]
    fn a_walk_with_nothing_from_the_pages_own_site_is_a_capture_that_failed() {
        let url = "https://www.shop.example/search/m3%20screws";
        let start_page = |path: &str| walked("GET", &format!("chrome://new-tab-page/{path}"), "", false);
        let blind = Trace { exchanges: vec![start_page("strings.m.js"), start_page("icons/search.svg")], inputs: Vec::new() };
        let why = unseen(&blind, url).expect("nothing of the site's is in the walk");
        assert!(why.contains("shop.example") && why.contains("capture failed") && why != NEEDS_HANDS, "{why}");
        assert_ne!(Unlearned::Unseen(why).to_string(), Unlearned::Loading.to_string());
        assert!(unseen(&Trace { exchanges: Vec::new(), inputs: Vec::new() }, url).is_some(), "an empty capture saw nothing either");
        let mut seen = blind.clone();
        seen.exchanges.push(walked("GET", "https://shop.example/search/m3%20screws", "<html>results</html>", true));
        assert_eq!(unseen(&seen, url), None, "the site's document on another of its hosts is the page seen");
        let mut called = blind.clone();
        called.exchanges.push(walked("POST", "https://api.shop.example/search", "{}", false));
        assert_eq!(unseen(&called, url), None, "one call of the site's is the page seen");
        let mut elsewhere = blind;
        elsewhere.exchanges.push(walked("GET", "https://cdn.other.example/app.js", "", false));
        assert!(unseen(&elsewhere, url).is_some(), "another site's traffic is not the page");
    }

    /// A site that moves its page to another of its names (a country's store, a search it hosts elsewhere) answered
    /// from there, and the capture holds that page whole: the walk is read at the site it landed on — that page and
    /// its calls, from the list a learn picks from — never as a capture that failed because nothing came from the
    /// address that was asked. A waiting room on another host is the door, so a walk with nothing of the asked site
    /// but it is still a capture that failed.
    #[test]
    fn a_walk_the_site_moved_to_another_name_is_read_there_not_as_a_capture_that_failed() {
        let asked = "https://www.shop.example/s?k=lamps";
        let mut moved = walked("GET", asked, "", true);
        moved.status = 302;
        let mut there = walked("GET", "https://www.shop.example.sg/s?k=lamps&ref=local", "<html><body>lamps in Singapore</body></html>", true);
        there.main_frame = Some(true);
        let called = walked("POST", "https://api.example.sg/search", r#"{"records":[{"name":"lamps, desk","price":"19.00"},{"name":"lamps, floor","price":"39.00"},{"name":"lamps, ceiling","price":"59.00"}]}"#, false);
        let trace = Trace { exchanges: vec![moved, there, called], inputs: walk_inputs(asked, &[], &[]) };
        assert_eq!(walked_site(&trace.exchanges, "www.shop.example"), "example.sg", "the walk is of where it landed");
        assert_eq!(unseen(&trace, asked), None, "the page the site moved to is the page the walk saw");
        // The calls a learn picks from are the site it landed on's, while the walk keeps the address it was asked.
        let walks = Walks::default();
        let id = "moved".to_string();
        let held = Walk { url: asked.into(), trace: trace.clone().into(), probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None };
        keep_walk(&mut walks.0.locked(), id.clone(), held);
        let view = view(&walks, &id).expect("the walk is held");
        assert_eq!(view.url, asked, "the walk says the address it was asked");
        assert_eq!(view.site, "example.sg", "and the site it read");
        assert!(view.candidates.iter().any(|c| c.host == "api.example.sg"), "the landing site's call is a candidate: {:?}", view.candidates.iter().map(|c| c.host.clone()).collect::<Vec<_>>());
        // A waiting room on another host is the door, not a page the site moved to: nothing of the asked site is the
        // capture that failed.
        let mut room = walked("GET", "https://queue.gate.example/wait?c=stay", "<html><head><script>setTimeout(()=>location.reload(),5000)</script></head><body>Please wait</body></html>", true);
        room.main_frame = Some(true);
        let queued = Trace { exchanges: vec![room], inputs: Vec::new() };
        assert!(unseen(&queued, asked).is_some(), "a waiting room is not the page the walk was sent for");
    }

    /// A walked address with a fragment of any shape keeps what the page made from it at home: a token in a path-style
    /// fragment (`#/reset/…`), a bare one (`#…`), and one the site echoed from a call the document names are never
    /// explained by anything the page's code could have shaped, so a route that sends them as a constant isn't listed.
    /// A search term in the fragment, with ordinary constants the document and its script hold, still lists.
    #[test]
    fn a_fragment_of_any_shape_keeps_what_the_page_made_from_it_home() {
        let shell = r#"<html><head><script src="/app.js"></script></head><body><a href="/api/bootstrap">x</a></body></html>"#;
        let route_with = |root: &str, before_script: Vec<Exchange>, body: &str, value: &str| {
            let page = walked("GET", root.split('#').next().unwrap(), shell, true);
            let mut app = walked("GET", "https://app.shop.example.com/app.js", "const json = { 'content-type': 'application/json', mode: 'search', limit: '20' }; fetch('/api/search').then((r) => r.results.map((x) => x.name)); const asks = ['q', 'v'];", false);
            app.resource_type = Some("Script".into());
            let mut call = walked("POST", "https://app.shop.example.com/api/search", r#"{"results":[{"name":"Lamps for reading"},{"name":"Desk lamps"}]}"#, false);
            call.request_body = Some(body.to_string());
            call.request_headers.push(("content-type".into(), "application/json".into()));
            let mut exchanges = vec![page];
            exchanges.extend(before_script);
            exchanges.extend([app, call]);
            let mut trace = Trace { exchanges, inputs: Vec::new() };
            trace.inputs = walk_inputs(root, &[], &trace.exchanges);
            let mut route = route_of(&trace, trace.exchanges.len() - 1, "search the shop", root, true, &[], &[], None).unwrap();
            // However the learner kept the page-made value, it is a constant here: the share boundary must hold it.
            for f in route.graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
                if f.loc == unbrowse_learn::slots::Loc::Json("/v".into()) && !value.is_empty() {
                    f.class = unbrowse_learn::Class::Constant { value: value.into(), origin: None };
                }
            }
            route.page_made = page_made(&route.graph, &trace, root);
            route
        };
        let stays_home = |route: &Route, value: &str| {
            let compiled = crate::recipe::compile(route);
            assert!(compiled.as_ref().is_err_and(|why| why.contains("fragment")), "{value}: {:?}", compiled.map(|r| serde_json::to_string(&r).unwrap()));
        };
        let token = "ab12cd34ef56";
        stays_home(&route_with(&format!("https://app.shop.example.com/results#/reset/{token}"), vec![], &format!(r#"{{"v":"{token}","mode":"search"}}"#), token), token);
        stays_home(&route_with(&format!("https://app.shop.example.com/results#{token}"), vec![], &format!(r#"{{"v":"{token}","mode":"search"}}"#), token), token);
        // The document names the call, and the call's answer says the token back: the page's own call explains nothing.
        let mut bootstrap = walked("GET", "https://app.shop.example.com/api/bootstrap", &format!(r#"{{"token":"{token}"}}"#), false);
        bootstrap.request_headers.push(("x-token".into(), token.into()));
        let echoed = route_with(&format!("https://app.shop.example.com/results#token={token}"), vec![bootstrap], &format!(r#"{{"v":"{token}","mode":"search"}}"#), token);
        assert!(echoed.page_made.as_ref().is_some_and(|m| !m.is_empty()), "{:?}", echoed.page_made);
        stays_home(&echoed, token);
        // A search term, with constants the document and its script hold: listed, the caller filling q.
        let search = route_with("https://app.shop.example.com/results#q=lamps", vec![], r#"{"q":"lamps","mode":"search","limit":"20"}"#, "");
        assert_eq!(search.page_made.as_deref(), Some(&[][..]), "{:?}", search.page_made);
        let recipe = crate::recipe::compile(&search).unwrap();
        assert!(recipe.params.iter().any(|p| p.name == "q" && p.default.is_none()), "{:?}", recipe.params);
        // The page's work on the fragment can sit anywhere the route carries text, not only in a value: under a key, as
        // the host a step goes to, as a key of the answer it expects. Each is held to the same sources.
        let walk = || {
            let page = walked("GET", "https://app.shop.example.com/results", shell, true);
            let mut app = walked("GET", "https://app.shop.example.com/app.js", "const json = { 'content-type': 'application/json', mode: 'search', limit: '20' }; fetch('/api/search').then((r) => r.results.map((x) => x.name)); const asks = ['q', 'v'];", false);
            app.resource_type = Some("Script".into());
            Trace { exchanges: vec![page, app], inputs: Vec::new() }
        };
        let root = format!("https://app.shop.example.com/results#{token}");
        let mut keyed = search.clone();
        keyed.graph.steps.last_mut().unwrap().fields.push(unbrowse_learn::Field { loc: unbrowse_learn::slots::Loc::Json(format!("/{token}")), class: unbrowse_learn::Class::Constant { value: "search".into(), origin: None } });
        assert!(page_made(&keyed.graph, &walk(), &root).is_some_and(|m| m.iter().any(|w| w.contains(token))), "a key");
        let mut answered = search.clone();
        answered.graph.steps.last_mut().unwrap().response_shape = Some(serde_json::json!({ token: { "name": "string" } }));
        assert!(page_made(&answered.graph, &walk(), &root).is_some_and(|m| m.iter().any(|w| w.contains("answer key"))), "an answer's key");
        let mut hosted = search.clone();
        hosted.graph.steps.last_mut().unwrap().url = format!("https://{token}.shop.example.com/api/search");
        assert!(page_made(&hosted.graph, &walk(), &root).is_some_and(|m| m.iter().any(|w| w.contains("host"))), "a host");
    }

    /// A value the page makes from what its address's fragment held (two of its values joined, one wrapped in base64)
    /// and sends as a fixed field is never shared, however the learner keeps it: a constant the walk shows no source for
    /// but the page's own code keeps the route unlisted, and a value it keeps unconfirmed goes out as the caller's to
    /// fill. A constant the site's own document and the scripts it names hold (`mode`, `limit`) is the site's, and shares.
    #[test]
    fn a_value_the_page_made_from_its_fragment_is_never_shared() {
        let learned = |fragment: &str, body: &str, twice: bool| {
            let root = format!("https://app.shop.example.com/results#{fragment}");
            let page = walked("GET", "https://app.shop.example.com/results", r#"<html><head><script src="/app.js"></script></head><body>results</body></html>"#, true);
            let mut app = walked("GET", "https://app.shop.example.com/app.js", "fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k, mode: 'search', limit: '20' }) }).then((r) => r.results.map((x) => x.name));", false);
            app.resource_type = Some("Script".into());
            let mut api = walked("POST", "https://app.shop.example.com/api/search", r#"{"results":[{"name":"Lamps for reading"},{"name":"Desk lamps"}]}"#, false);
            api.request_body = Some(body.to_string());
            api.request_headers.push(("content-type".into(), "application/json".into()));
            let mut exchanges = vec![page, app, api.clone()];
            if twice {
                exchanges.push(api);
            }
            let mut trace = Trace { exchanges, inputs: Vec::new() };
            trace.inputs = walk_inputs(&root, &[], &trace.exchanges);
            route_of(&trace, trace.exchanges.len() - 1, "search the shop", &root, true, &[], &[], None).unwrap()
        };
        let never_shared = |route: &Route, value: &str| match crate::recipe::compile(route) {
            Ok(r) => assert!(!serde_json::to_string(&r).unwrap().contains(value), "{value} rides in what is shared"),
            Err(why) => assert!(why.contains("fragment"), "{why}"),
        };
        // Two of the fragment's values joined: a plain word the learner keeps as a constant.
        let joined = learned("a=foo&b=bar", r#"{"key":"foobar","mode":"search","limit":"20"}"#, false);
        assert_eq!(joined.page_made.as_deref().map(|m| m.iter().any(|w| w.contains("key"))), Some(true), "{:?}", joined.page_made);
        never_shared(&joined, "foobar");
        assert!(crate::recipe::compile(&joined).is_err_and(|why| why.contains("fragment")));
        // One of them wrapped in base64, seen once and seen twice alike.
        for twice in [false, true] {
            let wrapped = learned("t=foobar", r#"{"key":"Zm9vYmFy","mode":"search","limit":"20"}"#, twice);
            never_shared(&wrapped, "Zm9vYmFy");
        }
        // What the site's document and its script hold is the site's own: such a route shares, the caller filling q.
        let search = learned("q=lamps", r#"{"key":"lamps","mode":"search","limit":"20"}"#, false);
        assert_eq!(search.page_made.as_deref(), Some(&[][..]), "{:?}", search.page_made);
        let recipe = crate::recipe::compile(&search).unwrap();
        assert!(recipe.params.iter().any(|p| p.name == "q" && p.default.is_none()), "{:?}", recipe.params);
    }

    /// What the walked address carried only in its fragment never leaves this node with a shared route, whatever the
    /// site answers and however short it is: a token the page posts and the site echoes back, a five-character code, and
    /// a search term all go out as inputs the caller fills, with no walked default and the value nowhere in the body.
    /// The owner's own copy keeps the search term as its default: it came from the owner's own address and stays on
    /// this machine.
    #[test]
    fn what_the_fragment_carried_never_leaves_with_a_shared_route() {
        let shared = |name: &str, value: &str, call: &str, body: &str, answer: &str| {
            let root = format!("https://app.shop.example.com/results#{name}={value}");
            let page = walked("GET", "https://app.shop.example.com/results", r#"<html><head><script src="/app.js"></script></head><body>results</body></html>"#, true);
            let mut app = walked("GET", "https://app.shop.example.com/app.js", "const json = { 'content-type': 'application/json' }; fetch('/api/session'); fetch('/api/verify'); fetch('/api/search'); const read = ['access_token', 'code', 'q', 'echo', 'items', 'name', 'ok', 'results'];", false);
            app.resource_type = Some("Script".into());
            let mut api = walked("POST", call, answer, false);
            api.request_body = Some(body.to_string());
            api.request_headers.push(("content-type".into(), "application/json".into()));
            let mut trace = Trace { exchanges: vec![page, app, api], inputs: Vec::new() };
            trace.inputs = walk_inputs(&root, &[], &trace.exchanges);
            let mut route = route_of(&trace, 2, "search the shop", &root, true, &[], &[], None).unwrap();
            // A default the page itself offers is one a shared route may carry; the fragment's is not, even then.
            for f in route.graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
                if let unbrowse_learn::Class::Input { name: n, optional, .. } = &mut f.class {
                    if n == name {
                        *optional = true;
                    }
                }
            }
            let recipe = crate::recipe::compile(&route).unwrap_or_else(|e| panic!("{name}: {e}"));
            let written = serde_json::to_string(&recipe).unwrap();
            assert!(!written.contains(value), "{name}: the walked value rides nowhere in what is shared: {written}");
            let param = recipe.params.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("{name} is the caller's: {:?}", recipe.params));
            assert_eq!(param.default, None, "{name}");
            route
        };
        let token = "tok_9f8e7d6c5b4a3f2e";
        shared("access_token", token, "https://app.shop.example.com/api/session", &format!(r#"{{"access_token":"{token}"}}"#), &format!(r#"{{"echo":"{token}","items":[{{"name":"Lamps"}}]}}"#));
        shared("code", "a1b2c", "https://app.shop.example.com/api/verify", r#"{"code":"a1b2c"}"#, r#"{"code":"a1b2c","ok":true,"items":[{"name":"Lamps"}]}"#);
        let own = shared("q", "lamps", "https://app.shop.example.com/api/search", r#"{"q":"lamps"}"#, r#"{"results":[{"name":"Lamps for reading"},{"name":"Desk lamps"}]}"#);
        assert!(own.inputs.iter().any(|i| i.name == "q" && i.default.as_deref() == Some("lamps")), "the owner's own copy keeps its search: {:?}", own.inputs);
    }

    /// A credential the page read from its address's fragment and sent as one is never kept with the route: not as a
    /// default, not in the address it was learned on, not in the page it carries. A search term in the same fragment
    /// that the call sends as its query, and the site says back, stays an ordinary input with its walked default.
    #[test]
    fn a_credential_from_the_fragment_never_rides_with_the_route() {
        let token = "tok_9f8e7d6c5b4a3f2e";
        let root = format!("https://app.shop.example/results#access_token={token}&q=lamps");
        let page = walked("GET", "https://app.shop.example/results", "<html><body>results</body></html>", true);
        let mut api = walked("GET", "https://app.shop.example/api/search?q=lamps", r#"{"results":[{"id":"p1","name":"Lamps for reading"}]}"#, false);
        api.request_headers.push(("authorization".into(), format!("Bearer {token}")));
        let mut trace = Trace { exchanges: vec![page, api], inputs: Vec::new() };
        trace.inputs = walk_inputs(&root, &[], &trace.exchanges);
        assert!(trace.inputs.iter().any(|i| i.name == "access_token" && i.secret), "{:?}", trace.inputs);
        assert!(trace.inputs.iter().any(|i| i.name == "q" && !i.secret));
        let route = route_of(&trace, 1, "search the shop", &root, true, &[], &[], None).unwrap();
        let written = serde_json::to_string(&route).unwrap();
        assert!(!written.contains(token), "the walked credential rides nowhere in the route: {written}");
        assert!(route.root.contains("access_token={access_token}"), "{}", route.root);
        assert!(route.inputs.iter().any(|i| i.name == "q" && !i.secret && i.default.as_deref() == Some("lamps")), "the search keeps its default: {:?}", route.inputs);
        assert!(route.inputs.iter().all(|i| i.name != "access_token" || i.default.is_none()), "{:?}", route.inputs);
    }

    /// Every placeholder a route sends comes from an input. A route that says `q={q}` with no input in `inputs`
    /// cannot be reused: every query learns it again (the Eden report's Google Maps routes).
    #[test]
    fn every_placeholder_a_route_sends_is_an_input() {
        let root = "https://shop.example/search?q=lamp&page=2&adults=2";
        let page = walked("GET", root, "<html><body>a shop</body></html>", true);
        let api = walked("GET", "https://shop.example/api/search?q=lamp&page=2", r#"{"results":[{"id":"p1","name":"Lamp"}]}"#, false);
        let trace = Trace { exchanges: vec![page, api], inputs: walk_inputs(root, &[], &[]) };
        let route = route_of(&trace, 1, "search the shop for lamps", root, true, &[], &[], None).unwrap();
        let mut unproduced: Vec<String> = Vec::new();
        let mut seen = 0usize;
        for step in &route.graph.steps {
            for (i, _) in step.url.match_indices('{') {
                let Some(len) = step.url[i + 1..].find('}') else { continue };
                let slot = &step.url[i + 1..i + 1 + len];
                seen += 1;
                let produced = step.fields.iter().any(|f| {
                    let input = matches!(f.class, unbrowse_learn::graph::Class::Input { .. });
                    match (&f.loc, slot.strip_prefix("path[")) {
                        (unbrowse_learn::Loc::Path(n), Some(rest)) => input && rest.trim_end_matches(']').parse::<usize>().ok() == Some(*n),
                        (unbrowse_learn::Loc::Query(k), None) => input && k == slot,
                        _ => false,
                    }
                });
                if !produced {
                    unproduced.push(format!("{{{slot}}} in {}", step.url));
                }
            }
        }
        assert!(seen > 0, "the route sent no placeholder, so this test held nothing: {:?}", route.graph.steps.iter().map(|s| &s.url).collect::<Vec<_>>());
        assert!(unproduced.is_empty(), "a placeholder no input fills: {unproduced:?} (inputs {:?})", route.inputs);
        assert!(route.inputs.iter().any(|i| i.name == "q"), "the search is an input: {:?}", route.inputs);
    }

    /// A page's modules strip repeats the page's words but asks for none of its values: when another call sends the
    /// value (or answers with it), the strip is not the answer, however much of the page it mentions.
    #[test]
    fn a_strip_that_neither_asks_nor_answers_the_value_never_wins() {
        let url = "https://shop.example/search?q=lamp";
        let page = walked("GET", url, "<html><body>a shop</body></html>", true);
        let modules = walked(
            "GET",
            "https://shop.example/api/modules",
            r#"{"modules":[{"title":"Popular in the shop","name":"Popular"},{"title":"New this week","name":"New"},{"title":"Shop by category","name":"Categories"}]}"#,
            false,
        );
        let search = walked(
            "GET",
            "https://shop.example/api/search?q=lamp",
            r#"{"results":[{"name":"Lamp one","price":20},{"name":"Lamp two","price":30},{"name":"Lamp three","price":40}]}"#,
            false,
        );
        assert_eq!(picked(url, "search the shop for lamps", vec![page, modules, search]).unwrap(), "GET /api/search");
    }

    /// A call that reads on adds the cursor its previous answer handed it (`feedSessionId`, `next`), so the later
    /// page has a key the first has not. That is the same call, not another operation: the first page is the route,
    /// and the page number is what the caller may move.
    #[test]
    fn a_later_page_that_adds_a_cursor_is_the_same_call() {
        let first = walked("GET", "https://shop.example/api/search?query=lamp&page=0", r#"{"results":[{"id":"p1","name":"Lamp one"}]}"#, false);
        let later = walked("GET", "https://shop.example/api/search?query=lamp&page=1&feedSessionId=8f14e45f", r#"{"results":[{"id":"p2","name":"Lamp two"}]}"#, false);
        assert!(same_operation(&later, &first, &["lamp"]), "the later page is the same call");
        let filter = walked("GET", "https://shop.example/api/search?query=lamp&page=0&sort=relevance", r#"{"results":[{"id":"p3","name":"Lamp three"}]}"#, false);
        assert!(!same_operation(&filter, &first, &["lamp"]), "a filter's word is another operation");
        let trace = Trace { exchanges: vec![first, later], inputs: Vec::new() };
        let picked = trace.exchanges[1].clone();
        let (target, _) = first_of_repeats(&trace, &picked);
        assert!(target.url.query_pairs().any(|(k, v)| k == "page" && v == "0"), "the first page is the route: {}", target.url);
    }

    /// The walk that exposed it (WordPress.com's support search, UNB-208 step 8): the first page also asks for what it
    /// shows once beside the list (`aggregations[...]=category.slug`, words), and each later page leaves that out and
    /// sends the cursor the answer before it handed over (`page_handle`) instead. Read as two operations, the route
    /// chained the first call to a later page and answered page five's titles as the search's first five: confidently
    /// wrong. They are one call read on, and the first page is the route; a filter's word with no cursor beside it is
    /// still another operation.
    #[test]
    fn a_first_page_that_asks_for_its_facets_once_is_the_same_call_as_its_later_pages() {
        let first = walked(
            "GET",
            "https://api.shop.example/search?query=lamp&aggregations%5Bt0%5D%5Bfield%5D=category.slug&size=10",
            r#"{"results":[{"id":"p1","title":"Lamp one"}],"page_handle":"ZnJvbT0xMCZhbGc9","aggregations":{"t0":[]}}"#,
            false,
        );
        let later = walked("GET", "https://api.shop.example/search?query=lamp&size=10&page_handle=ZnJvbT0xMCZhbGc9", r#"{"results":[{"id":"p11","title":"Lamp eleven"}],"page_handle":"ZnJvbT0yMCZhbGc9","aggregations":{"t0":[]}}"#, false);
        let fifth = walked("GET", "https://api.shop.example/search?query=lamp&size=10&page_handle=ZnJvbT0yMCZhbGc9", r#"{"results":[{"id":"p21","title":"Lamp twenty-one"}],"page_handle":"ZnJvbT0zMCZhbGc9","aggregations":{"t0":[]}}"#, false);
        assert!(same_operation(&later, &first, &["lamp"]) && same_operation(&first, &later, &["lamp"]), "a later page is the first page's call");
        let filter = walked("GET", "https://api.shop.example/search?query=lamp&aggregations%5Bt0%5D%5Bfield%5D=category.slug&size=10&brand=ikea", r#"{"results":[]}"#, false);
        assert!(!same_operation(&filter, &first, &["lamp"]), "a filter's word, with no cursor beside it, is another operation");
        let trace = Trace { exchanges: vec![first, later, fifth], inputs: Vec::new() };
        let (target, _) = first_of_repeats(&trace, &trace.exchanges[2].clone());
        assert!(target.url.query().unwrap_or_default().contains("aggregations"), "the first page is the route: {}", target.url);
    }

    /// A search box's suggestion call is a hint: `autocomplete`/`suggest`/`typeahead` say so, and a call beside it that
    /// answers with results is the answer (itch.io, roblox).
    #[test]
    fn a_suggestion_call_never_beats_the_results() {
        let url = "https://games.example/search?q=platformer";
        let page = walked("GET", url, "<html><body><h1>platformer</h1><a href='/g/1'>Platformer One</a><a href='/g/2'>Platformer Two</a><a href='/g/3'>Platformer Three</a></body></html>", true);
        let suggest = walked("GET", "https://games.example/autocomplete?query=platformer", r#"{"tags":[{"id":1,"name":"platformer"},{"id":2,"name":"platform"},{"id":3,"name":"pixel"}],"query":"platformer"}"#, false);
        assert_eq!(picked(url, "search games", vec![page, suggest]).unwrap(), "GET /search", "the page's results, not the suggestion call");
    }

    /// A results call that offers suggestions beside its results is still the results: the member named for them marks
    /// a call only when it is most of the answer. A site's search API answering `results` and `suggestions` was dropped
    /// for the page that frames it, which reads the same for every search.
    #[test]
    fn suggestions_beside_the_results_do_not_make_a_suggestion_call() {
        let url = "https://help.example/support/?s=domain";
        let page = walked("GET", url, "<html><body><h1>Support</h1><p>Search our guides for domain</p><a href='/a'>Contact us</a></body></html>", true);
        let results: Vec<String> = (0..10).map(|n| format!(r#"{{"id":{n},"title":"Domain guide {n}","url":"https://help.example/domain-{n}","excerpt":"How to connect a domain, part {n}"}}"#)).collect();
        let search = walked("GET", "https://api.help.example/v1/sites/7/search?query=domain", &format!(r#"{{"total":10,"results":[{}],"suggestions":[],"corrected_query":false}}"#, results.join(",")), false);
        assert_eq!(picked(url, "search the support guides", vec![page.clone(), search]).unwrap(), "GET /v1/sites/7/search", "the search call, whatever rides beside its results");
        // An answer that is its suggestions is still a hint.
        let hint = walked("GET", "https://api.help.example/v1/sites/7/complete?query=domain", r#"{"query":"domain","suggestions":[{"id":1,"name":"domain"},{"id":2,"name":"domains"},{"id":3,"name":"domain mapping"}]}"#, false);
        assert_eq!(picked(url, "search the support guides", vec![page, hint]).unwrap(), "GET /support/", "the page, not the hint");
    }

    /// The site's own name is not a goal word: "search MySQL site" asks for the search, and a path that spells the name
    /// (`/mysql`, 838 bytes of suggestions) otherwise earns the points a search's path earns over the API with the results.
    #[test]
    fn the_sites_own_name_is_not_a_goal_word() {
        let asked = goal_words_of("search MySQL site", "www.mysql.com");
        assert!(!asked.contains(&"mysql".to_string()), "the site's name: {asked:?}");
        assert!(asked.contains(&"search".to_string()), "{asked:?}");
        let pypi = goal_words_of("search PyPI packages", "pypi.org");
        assert!(!pypi.contains(&"pypi".to_string()) && !pypi.contains(&"org".to_string()), "{pypi:?}");
    }

    /// A page that says the value itself is an answer; a call beside it whose own answer says nothing of it is not
    /// better than the page (booking.com kept a recommendation call over the page listing the hotels found).
    #[test]
    fn a_page_that_says_the_value_beats_a_call_that_says_nothing() {
        let url = "https://hotels.example/search?ss=paris";
        let hotels: String = (0..60).map(|n| format!("<a href='/h/{n}'>Hotel Paris {n}</a><p>Paris, {n} rue de Rivoli, from 120 EUR a night</p>")).collect();
        let page = walked("GET", url, &format!("<html><body><h1>Paris</h1>{hotels}</body></html>"), true);
        let recommend = walked("POST", "https://hotels.example/dml/graphql?ss=paris", r#"{"data":{"recommendationPlatform":{"crossProductRecommendedSearches":{"latency":{"ms":45},"items":[]}}}}"#, false);
        assert_eq!(picked(url, "search hotels in paris", vec![page, recommend]).unwrap(), "GET /search", "the page that names Paris");
    }

    /// Another site's call never answers this page while the site's own page or a call of its own is held: an ad
    /// exchange carries a copy of the value and answers with a banner (asos.com's pick was criteo's retailmedia).
    #[test]
    fn another_sites_call_never_answers_the_page() {
        let url = "https://shop.example/search?q=lamp";
        let page = walked("GET", url, "<html><body><h1>Lamps</h1><a href='/i/1'>Lamp one</a><a href='/i/2'>Lamp two</a><a href='/i/3'>Lamp three</a></body></html>", true);
        let ad = walked("GET", "https://ads.example/delivery/retailmedia?q=lamp", r#"{"slots":[{"id":"1","name":"Banner"},{"id":"2","name":"Rail"},{"id":"3","name":"Footer"}]}"#, false);
        assert_eq!(picked(url, "search the shop for lamps", vec![page, ad]).unwrap(), "GET /search", "the site's own page, not the ad exchange's");
    }

    /// A few-hundred-byte answer with no list is a lookup beside a call whose answer carries records: an echo, a
    /// recommendation strip, an ad slot. Booking.com's pick was a 333-byte recommendation call.
    #[test]
    fn a_tiny_answer_never_beats_the_call_that_holds_records() {
        let url = "https://shop.example/search?q=lamp";
        let results: Vec<serde_json::Value> = (0..30).map(|i| serde_json::json!({"id": i, "name": format!("Lamp {i}"), "price": 10 + i})).collect();
        let big = walked("GET", "https://shop.example/api/search?q=lamp", &serde_json::json!({"results": results}).to_string(), false);
        let tiny = walked("GET", "https://shop.example/api/recommend?q=lamp", r#"{"latency":{"ms":45,"at":"2026-11-10"},"echo":"lamp"}"#, false);
        assert_eq!(picked(url, "search the shop for lamps", vec![big, tiny]).unwrap(), "GET /api/search");
    }

    /// A list of words is a hint, not the answer. A search's suggestions repeat the query in strings while the call
    /// that answers holds records: with both in the walk, the records win; with only the page and the suggestions,
    /// the page does.
    #[test]
    fn a_list_of_words_never_beats_records() {
        let url = "https://shop.example/search?q=lamp";
        let page = walked("GET", url, "<html><body><h1>Lamps</h1><a href='/i/1'>Lamp one</a><a href='/i/2'>Lamp two</a><a href='/i/3'>Lamp three</a></body></html>", true);
        let suggest = walked(
            "GET",
            "https://shop.example/api/suggest?q=lamp",
            r#"{"suggestions":["lamp","lampshade","lamps","lantern","light bulb","floor lamp"]}"#,
            false,
        );
        let results = walked(
            "GET",
            "https://shop.example/api/results?q=lamp",
            r#"{"results":[{"id":"1","name":"Lamp one"},{"id":"2","name":"Lamp two"},{"id":"3","name":"Lamp three"}]}"#,
            false,
        );
        assert_eq!(
            picked(url, "search the shop for lamps", vec![page.clone(), suggest.clone(), results.clone()]).unwrap(),
            "GET /api/results",
            "records beat words"
        );
        assert_eq!(
            picked(url, "search the shop for lamps", vec![page, suggest]).unwrap(),
            "GET /search",
            "with only words in the walk, the page answers"
        );
    }

    /// A request key the page's own script writes whose value the walk cannot source is exposed on the candidate: the
    /// page's code made the value, so a route on this call computes it in the sandbox, and the picker can see that the
    /// browserless path closes here. The name alone is no evidence — scripts write `id` and every answer carries ids —
    /// so a call whose values the walk sources is not flagged.
    #[test]
    fn a_request_key_the_page_writes_is_exposed_as_computable() {
        let url = "https://shop.example/search?q=lamp";
        let site = site_of(url::Url::parse(url).unwrap().host_str().unwrap());
        let page = walked("GET", url, "<html><body>a shop of lamps</body></html>", true);
        let script = Exchange {
            method: "GET".into(),
            url: url::Url::parse("https://shop.example/app.js").unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(r#"fetch('/api/search?query=lamp', { headers: { 'x-sig': signed() } });"#.into()),
            response_mime: "text/javascript".into(),
            resource_type: Some("Script".into()),
            main_frame: Some(true),
        };
        let records = r#"{"results":[{"id":"1","name":"Lamp one"},{"id":"2","name":"Lamp two"},{"id":"3","name":"Lamp three"}]}"#;
        let mut signed_call = walked("GET", "https://shop.example/api/search?query=lamp", records, false);
        // The value no earlier exchange holds, and the script writes its name: the page's code made it.
        signed_call.request_headers = vec![("x-sig".into(), "9f2c1dab77e5c0a4b8d3".into())];
        let trace = Trace { exchanges: vec![page, script, signed_call], inputs: walk_inputs(url, &[], &[]) };
        let view = view_of("t", url, &site, &trace, 0);
        let hit = view.candidates.iter().find(|c| c.path.starts_with("/api/search")).expect("the call is a candidate");
        assert!(hit.writes, "the page's script writes `x-sig`, and no answer the walk holds carries its value");
        assert_eq!(hit.shape, "records", "its answer holds records");
        let shell = view.candidates.iter().find(|c| c.page).expect("the page is a candidate");
        assert!(!shell.writes, "no script writes the page's own key `q`");
        assert_eq!(shell.shape, "page");

        // The same call without the header: the script still writes `query`, and the page's own markup holds its value,
        // so there is nothing for the page's code to compute.
        let plain = walked("GET", "https://shop.example/api/search?query=lamp", records, false);
        let trace = Trace { exchanges: vec![walked("GET", url, "<html><body>a shop of lamps</body></html>", true), walked("GET", "https://shop.example/app.js", r#"fetch('/api/search?query=lamp');"#, false), plain], inputs: walk_inputs(url, &[], &[]) };
        let view = view_of("t", url, &site, &trace, 0);
        assert!(!view.candidates.iter().find(|c| c.path.starts_with("/api/search")).expect("the call").writes, "a sourced value is not the page's to compute");
    }

    /// A language or version segment is the site's address, not the caller's word: `/en/searchresult?keyword=…` asks
    /// for a keyword, and binding `en` made the picker keep a labels call that sends `en` over the search (Huawei).
    #[test]
    fn a_language_segment_is_the_address_not_the_callers() {
        for piece in ["en", "en-gb", "de", "v2", "v13"] {
            assert!(address_setting(piece), "{piece} is the address's");
        }
        for piece in ["lamp", "search", "new-york", "2026-11-10", "sale"] {
            assert!(!address_setting(piece), "{piece} may be the caller's");
        }
    }

    /// A page reached by its address (`/search/lamp`) hands that value to its own call (`?query=lamp`): the value is
    /// the caller's, so the route asks for it instead of freezing the walk's. Without this a search page opened by
    /// URL can never answer another search.
    #[test]
    fn a_path_value_the_page_hands_to_its_call_is_an_input() {
        let root = "https://shop.example/search/lamp";
        let page = walked("GET", root, "<html><body>a shop</body></html>", true);
        let api = walked("GET", "https://shop.example/api/search?query=lamp", r#"{"results":[{"id":"p1","name":"Lamp","description":"a bright desk lamp with a warm shade"}]}"#, false);
        let trace = Trace { exchanges: vec![page, api], inputs: walk_inputs(root, &[], &[]) };
        let route = route_of(&trace, 1, "search the shop for lamps", root, true, &[], &[], None).unwrap();
        assert!(route.inputs.iter().any(|i| i.default.as_deref() == Some("lamp")), "the path value is an input: {:?}", route.inputs);
        let step = route.graph.steps.last().unwrap();
        assert!(
            step.fields.iter().any(|f| matches!(&f.class, unbrowse_learn::graph::Class::Input { name, .. } if name == "search")),
            "the call asks for the path's value: {:?}",
            step.fields
        );
    }

    /// A value the walk saw on two pages of the same call, the same both times, is the call's setting: no producer is
    /// needed for it. One that differs between the pages is the page's to compute per call — a signature.
    #[test]
    fn a_value_the_same_on_two_pages_is_the_calls_setting() {
        let call = |page: &str, loc: &str, sig: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(&format!("https://shop.example/api/search?page={page}")).unwrap(),
            request_headers: vec![("x-loc".into(), loc.into()), ("x-sig".into(), sig.into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"results":[{"id":"1","name":"a"},{"id":"2","name":"b"}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let first = call("1", "en-GB-7", "aaaa1111");
        let again = call("2", "en-GB-7", "bbbb2222");
        let trace = Trace { exchanges: vec![first.clone()], inputs: walk_inputs("https://shop.example/search", &[], &[]) };
        let mut graph = unbrowse_learn::build(&[trace], |e| e.url == first.url).expect("a graph");
        settle_repeats(&mut graph, &again);
        let class = |name: &str| graph.steps.last().unwrap().fields.iter().find(|f| matches!(&f.loc, unbrowse_learn::slots::Loc::Header(h) if h == name)).map(|f| f.class.clone()).expect("the header");
        assert!(matches!(class("x-loc"), unbrowse_learn::Class::Constant { .. }), "the same on both pages: {:?}", class("x-loc"));
        assert!(matches!(class("x-sig"), unbrowse_learn::Class::Unconfirmed { .. }), "changed between pages, so the page's: {:?}", class("x-sig"));

        let trace = Trace { exchanges: vec![first.clone(), again.clone()], inputs: Vec::new() };
        assert!(repeat_of(&trace, &first).is_some(), "the walk asked the same call twice");
    }

    /// The candidate that carries the caller's word is the one kept, and it is a route of its own: a page asked for
    /// `/search/gaza` whose own search call puts the word inside a GraphQL `variables` JSON gives a step that keeps the
    /// JSON, records the word as held, and takes an id that the same endpoint asked with `variables={}` does not —
    /// so re-picking the right call supersedes the stale route instead of merging into the one that binds nothing
    /// (aljazeera.com's `SearchQuery`, 2026-11-11).
    #[test]
    fn a_picked_call_that_carries_the_callers_word_is_a_route_of_its_own() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let root = "https://www.news.example/search/gaza";
        let page = walked("GET", root, "<html></html>", true);
        let variables = r#"{"query":"gaza","start":1,"sort":"relevance"}"#;
        let carried = format!(
            "https://www.news.example/graphql?wp-site=aje&operationName=SearchQuery&variables={}&extensions=%7B%7D",
            url::form_urlencoded::byte_serialize(variables.as_bytes()).collect::<String>()
        );
        let with_word = walked("GET", &carried, r#"{"data":{"searchPosts":[{"title":"gaza"}]}}"#, false);
        let empty = walked(
            "GET",
            "https://www.news.example/graphql?wp-site=aje&operationName=SearchQuery&variables=%7B%7D&extensions=%7B%7D",
            r#"{"data":{"searchPosts":[]}}"#,
            false,
        );
        // The walk named the word: the page was asked for it by its own address (`/search/gaza`), which is what
        // `path_inputs` hands the graph for a page the caller reached by address.
        // The walk that named the word (what `path_inputs` hands it for a page reached by address), and the earlier
        // walk that did not — the one the stale route came from.
        let named = Trace { exchanges: vec![page.clone(), with_word, empty.clone()], inputs: vec![unbrowse_learn::trace::Input::new("search", "gaza")] };
        let unnamed = Trace { exchanges: vec![page, empty], inputs: Vec::new() };
        // The classifier's graph says how the word rides (`UNBROWSE_LEARN_BY_EXAMPLE=0`); the twin below holds the
        // default learner to the same behaviour.
        let carried = route_of_by(&named, 1, "search the news", root, true, &[], &[], None, false).expect("the call that carries the word");
        let stale = route_of_by(&unnamed, 1, "search the news", root, true, &[], &[], None, false).expect("the call that binds nothing");
        let step = carried.graph.steps.last().expect("a target");
        let held = step.held.iter().find(|h| h.sits == "gaza").unwrap_or_else(|| panic!("the word is held: {:?}", step.held));
        assert_eq!(held.written, unbrowse_learn::graph::Written::Json, "it rides inside the JSON");
        // The word rides inside a value the route takes: the `variables` JSON itself, which a caller sends anew.
        assert!(
            carried.inputs.iter().any(|i| i.name == "variables") || carried.inputs.iter().any(|i| i.name == held.input),
            "the JSON the word rides in is the caller's: {:?}",
            carried.inputs
        );
        assert_ne!(carried.id, stale.id, "the call that carries the word is a route of its own");
        let stale_step = stale.graph.steps.last().expect("a target");
        assert!(stale_step.held.iter().all(|h| h.sits != "gaza"), "the one from the walk that never named the word binds nothing");
        assert!(stale_step.url.contains("%7B%7D"), "and keeps the empty JSON: {}", stale_step.url);
    }

    /// [`a_picked_call_that_carries_the_callers_word_is_a_route_of_its_own`] on the default learner: the call that
    /// carries the caller's word inside its JSON takes the word from the caller, and is a route of its own beside the
    /// same endpoint asked with `variables={}`, which binds nothing and keeps its empty JSON.
    #[test]
    fn by_default_a_picked_call_that_carries_the_callers_word_is_a_route_of_its_own() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let root = "https://www.news.example/search/gaza";
        let page = walked("GET", root, "<html></html>", true);
        let variables = r#"{"query":"gaza","start":1,"sort":"relevance"}"#;
        let carried = format!(
            "https://www.news.example/graphql?wp-site=aje&operationName=SearchQuery&variables={}&extensions=%7B%7D",
            url::form_urlencoded::byte_serialize(variables.as_bytes()).collect::<String>()
        );
        let with_word = walked("GET", &carried, r#"{"data":{"searchPosts":[{"title":"gaza"}]}}"#, false);
        let empty = walked("GET", "https://www.news.example/graphql?wp-site=aje&operationName=SearchQuery&variables=%7B%7D&extensions=%7B%7D", r#"{"data":{"searchPosts":[]}}"#, false);
        let named = Trace { exchanges: vec![page.clone(), with_word, empty.clone()], inputs: vec![unbrowse_learn::trace::Input::new("search", "gaza")] };
        let unnamed = Trace { exchanges: vec![page, empty], inputs: Vec::new() };
        let carried = route_of(&named, 1, "search the news", root, true, &[], &[], None).expect("the call that carries the word");
        let stale = route_of(&unnamed, 1, "search the news", root, true, &[], &[], None).expect("the call that binds nothing");
        let takes_the_word = |r: &Route| r.inputs.iter().any(|i| i.default.as_deref().is_some_and(|d| d.contains("gaza")));
        assert!(takes_the_word(&carried), "the word is the caller's: {:?}", carried.inputs);
        assert_ne!(carried.id, stale.id, "the call that carries the word is a route of its own");
        assert!(!takes_the_word(&stale), "the one from the walk that never named the word binds nothing: {:?}", stale.inputs);
        let stale_step = stale.graph.steps.last().expect("a target");
        assert!(stale_step.url.contains("%7B%7D"), "and keeps the empty JSON: {}", stale_step.url);
    }

    fn walked(method: &str, url: &str, body: &str, doc: bool) -> Exchange {
        Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        }
    }

    /// The walks that exposed it, each the first ask on a fresh node, made up: a value the site has nothing for. A
    /// library's search page, a shell, whose own call answered its envelope alone (the ask said back, the cache's
    /// bookkeeping, no records place), and a shop's search page rendered on the server that said under its headings
    /// it found nothing and linked only from its frame. Each was learned into a route and its answer said as
    /// answered. A walk that saw no record teaches no route, and says the site has nothing for the value; the same
    /// walks for a value with records learn their call.
    #[test]
    fn a_first_walk_of_a_value_the_site_has_nothing_for_keeps_no_route() {
        store::scratch_home("first-walk-nothing");
        let goal = "items matching this search";
        let shell = "<!doctype html><html><head><title>Search</title><script src=\"/app.js\"></script></head><body><app-root></app-root></body></html>";
        let search = |q: &str, hits: serde_json::Value| {
            let page = format!("https://lib.example/search?query={q}");
            let mut answer = serde_json::json!({ "request": { "client_request_parameters": { "client_url": page, "user_query": q } },
                "caching": { "search": { "name": "PX-1x7o:XX-T:sr-Q:9ad9ba12+CS:some", "acceptable_names": ["PX-1x7o:XX-T:std-Q:9ad9ba12+CS:some"], "statsd_bucket": "search.cache.metadata.search_results" } } });
            if !hits.is_null() {
                answer["response"] = serde_json::json!({ "body": { "hits": { "hits": hits } } });
            }
            let call = format!("https://lib.example/services/search/page?user_query={q}&hits_per_page=50&client_url=https%3A%2F%2Flib.example%2Fsearch%3Fquery%3D{q}");
            let trace = Trace { exchanges: vec![walked("GET", &page, shell, true), walked("GET", &call, &answer.to_string(), false)], inputs: walk_inputs(&page, &[], &[]) };
            corpus::read(&page, goal, trace, &[], None)
        };
        let none = search("qzxvkjw", serde_json::Value::Null);
        assert!(none.call.is_empty() && none.none.as_deref().is_some_and(|w| w.contains("lists nothing")), "the envelope alone: {none:?}");
        let hits: Vec<serde_json::Value> = ["The road goes ever on", "Letters from the hills", "Maps of the far west"].iter().map(|t| serde_json::json!({ "title": format!("Tolkien: {t}"), "identifier": t.replace(' ', "-") })).collect();
        let found = search("tolkien", serde_json::json!(hits));
        assert!(found.call.contains("/services/search/page"), "with records: {found:?}");

        let rendered = |q: &str, found: &str| {
            let page = format!("https://shop.example/search/?q={q}");
            let body = format!(
                "<!doctype html><html><head><title>Search</title></head><body><a href=\"#content\">Skip to main content</a><header><nav><a href=\"/\">Home</a><a href=\"/help/\">Help</a></nav></header>\
                 <main id=\"content\"><div><h2>Filter by <a href=\"/categories/\">category</a></h2><form><ul><li><input type=\"checkbox\" id=\"c1\"><label for=\"c1\">Lamps</label></li></ul></form></div>\
                 <div><h2>Search results</h2><p><strong>{n}</strong> items for \"{q}\"</p>{found}</div></main><footer><a href=\"/about/\">About</a></footer>\
                 <div><a href=\"https://sponsor-one.example/\">Sponsor One, gold sponsor</a><a href=\"https://sponsor-two.example/\">Sponsor Two, silver sponsor</a><a href=\"/sitemap/\">Site map</a></div></body></html>",
                n = if found.contains("card") { 3 } else { 0 }
            );
            let trace = Trace { exchanges: vec![walked("GET", &page, &body, true)], inputs: walk_inputs(&page, &[], &[]) };
            corpus::read(&page, goal, trace, &[], None)
        };
        let none = rendered("qzxvkjw", "<div><p>There was nothing for 'qzxvkjw'</p></div>");
        assert!(none.call.is_empty() && none.none.as_deref().is_some_and(|w| w.contains("lists nothing")), "the page's frame alone: {none:?}");
        let cards: String = ["brass", "desk", "floor"].iter().map(|k| format!("<a class=\"card\" href=\"/item/{k}-lamp/\"><h3>{k} lamp</h3><p>A {k} lamp for the reading corner, in three finishes.</p></a>")).collect();
        let found = rendered("lamp", &cards);
        assert!(found.call.contains("/search/"), "with results, the page: {found:?}");
    }

    /// Two walks of a shop's search for two words, as a learn has them: the page, an earlier call, and the search.
    fn walked_twice(earlier: &dyn Fn(&str) -> Exchange, search: &dyn Fn(&str) -> Exchange) -> (Trace, Vec<(Trace, Vec<unbrowse_learn::trace::Probe>)>) {
        let walk = |word: &str| {
            let root = format!("https://shop.example/search?q={word}");
            Trace { exchanges: vec![walked("GET", &root, "<html><body>a shop</body></html>", true), earlier(word), search(word)], inputs: walk_inputs(&root, &[], &[]) }
        };
        (walk("lamp"), vec![(walk("sofa"), Vec::new())])
    }

    fn records(word: &str) -> String {
        format!(r#"{{"results":[{}]}}"#, (0..6).map(|n| format!(r#"{{"id":"p{n}","name":"{word} number {n}"}}"#)).collect::<Vec<_>>().join(","))
    }

    /// A walk of a shop's search page for `word`, as a learn has it: the page, its results call (records, or an empty
    /// list for a word nobody searches for), and a counts call at the same address that asks no results and answers a
    /// frame of counts either way.
    fn a_search_walk(word: &str, found: bool) -> Trace {
        let root = format!("https://shop.example/search?q={word}");
        let results = if found { records(word) } else { r#"{"results":[]}"#.to_string() };
        let n = if found { 14 } else { 0 };
        let counts = format!(r#"{{"query":"{word}","results":[],"counts":{{"lamps":{n},"jars":{}}}}}"#, n / 2);
        Trace {
            exchanges: vec![
                walked("GET", &root, "<html><body>a shop</body></html>", true),
                walked("GET", &format!("https://shop.example/api/find?q={word}&per=20"), &results, false),
                walked("GET", &format!("https://shop.example/api/find?q={word}&per=0"), &counts, false),
            ],
            inputs: walk_inputs(&root, &[], &[]),
        }
    }

    /// A call that sends the word and is answered by the site's wall, saying it failed (a challenge asked at an address
    /// that names the word), says nothing of what the ask found: two walks that both found records are two sightings,
    /// whatever their walls said.
    #[test]
    fn a_walls_failure_parts_no_walks() {
        let walk = |word: &str, wall: &str| {
            let mut t = a_search_walk(word, true);
            t.exchanges.push(walked("GET", &format!("https://shop.example/search/{word}/_check/verify"), wall, false));
            t
        };
        let (blocked, through) = (walk("lantern", r#"{"ret":["FAIL_SYS_USER_VALIDATE::the request was refused"],"data":{"url":"https://shop.example/_check"}}"#), walk("kettle", &records("kettle")));
        assert!(unbrowse_learn::answer::not_an_answer(&blocked.exchanges[3], false).is_some(), "the wall's answer says it failed");
        assert!(!parts_on_records(&blocked, Some(1), &through), "a wall's failure is no answer to part on");
        assert!(parts_on_records(&blocked, Some(1), &a_search_walk("qzxvorb", false)), "an empty answer still parts");
    }

    /// A visitor id the site handed the browser in a cookie, written by the page's code into a call's JSON parameter,
    /// is the caller's own cookie written into the rest: fixed across the owner's walks (both sent the owner's id), or
    /// differing where every other walk's call sent the same text with its own cookie in the id's place. The address
    /// holds the value's place, and no walker's id rides in the route. A value no other walk sent with its own cookie
    /// there, or seen once, stays unconfirmed.
    #[test]
    fn a_cookie_the_page_wrote_into_a_value_is_the_callers_own() {
        store::scratch_home("cookie-in");
        let call = |id: Option<&str>, n: u32| {
            let data = match id {
                Some(id) => format!(r#"{{"anonymous_id":"{id}","pageSize":50}}"#),
                None => r#"{"pageSize":50}"#.to_string(),
            };
            let url = format!("https://api.shop.example/h5/recommend/1.0/?appKey=1234&data={}", url::form_urlencoded::byte_serialize(data.as_bytes()).collect::<String>());
            let mut e = walked("GET", &url, &records(&format!("lamp{n}")), false);
            e.request_headers = vec![("cookie".into(), format!("lang=en{}", id.map(|id| format!("; cna={id}")).unwrap_or_default()))];
            e
        };
        let root = "https://www.shop.example/";
        let walk = |id: Option<&str>, n: u32| Trace { exchanges: vec![walked("GET", root, "<html><body>a shop</body></html>", true), call(id, n)], inputs: walk_inputs(root, &[], &[]) };
        let learn = |first: Trace, others: Vec<Trace>| {
            let history: Vec<_> = others.into_iter().map(|t| (t, Vec::new())).collect();
            route_of_by(&first, 1, "list the shop's picks", root, true, &[], &history, None, true).unwrap()
        };
        let data = |r: &store::Route| r.graph.steps.last().unwrap().fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query("data".into())).map(|f| f.class.clone());
        let template = format!(r#"{{"anonymous_id":"{}","pageSize":50}}"#, unbrowse_learn::graph::COOKIE_IN);
        let theirs = Some(unbrowse_learn::Class::CookieIn { template: template.clone(), name: "cna".into() });
        let (owner, other) = ("qC6EI4RJtwUCAbT/dirWksqV", "IDCFI/94iW8CAYrHPAzqsjUR");
        // The owner's two walks, the owner's id in both.
        let r = learn(walk(Some(owner), 1), vec![walk(Some(owner), 2)]);
        assert_eq!(data(&r), theirs, "fixed across the owner's walks");
        let target = &r.graph.steps.last().unwrap().url;
        assert!(target.contains("data={data}") && !target.contains("qC6EI4RJ"), "the address holds its place: {target}");
        assert!(!serde_json::to_string(&r.graph).unwrap().contains(owner), "no walker's id in the route");
        // Two walks, each its own id.
        assert_eq!(data(&learn(walk(Some(owner), 1), vec![walk(Some(other), 2)])), theirs, "each walk's own cookie in the same place");
        // Another walk's call sent no id at all: no sighting of the same text.
        assert!(matches!(data(&learn(walk(Some(owner), 1), vec![walk(None, 2)])), Some(unbrowse_learn::Class::Unconfirmed { .. })));
        // Seen once.
        assert!(matches!(data(&learn(walk(Some(owner), 1), vec![])), Some(unbrowse_learn::Class::Unconfirmed { .. })));
    }

    /// The learner by example takes a walk of the page for another word as a sighting of the same call even where the
    /// word sits in the call's path (`/tag/red-lamp/` beside `/tag/blue-sofa/`): what both walks sent alike is the
    /// call's own, settled, not left unconfirmed.
    #[test]
    fn a_word_in_the_path_still_makes_two_sightings() {
        store::scratch_home("word-in-path");
        let walk = |word: &str| {
            let root = format!("https://shop.example/catalog/?q={}", word.replace(' ', "+"));
            let call = format!("https://shop.example/tag/{}/?ajax=true&page=1&q={}", word.replace(' ', "-"), word.replace(' ', "%20"));
            Trace { exchanges: vec![walked("GET", &root, "<html><body>a shop</body></html>", true), walked("GET", &call, &records(word), false)], inputs: walk_inputs(&root, &[], &[]) }
        };
        let (first, history) = (walk("red lamp"), vec![(walk("blue sofa"), Vec::new())]);
        let route = route_of_by(&first, 1, "search the shop", "https://shop.example/catalog/?q=red+lamp", true, &[], &history, None, true).unwrap();
        let class = |key: &str| route.graph.steps.last().unwrap().fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query(key.into())).map(|f| f.class.clone());
        assert!(matches!(class("ajax"), Some(unbrowse_learn::Class::Constant { .. })), "{:?}", class("ajax"));
        assert!(matches!(class("page"), Some(unbrowse_learn::Class::Constant { .. })), "{:?}", class("page"));
        assert!(!route.graph.provisional, "nothing left unconfirmed");
    }

    /// The page walked for a word nobody searches for found nothing: its results call answered an empty list where
    /// this walk's answered records. It is no sighting of the answer: the learn passes it over for the next walk with
    /// records, else the walk stands alone, as if it had never been walked. Learned from the walk that found nothing,
    /// the walk with records is no sighting of its counts call either.
    #[test]
    fn a_walk_that_found_nothing_is_no_sighting_of_the_answer() {
        let (now, nothing, kettle) = (a_search_walk("lantern", true), a_search_walk("qzxvorb", false), a_search_walk("kettle", true));
        assert!(parts_on_records(&now, Some(1), &nothing), "the results call holds records here and none there");
        assert!(parts_on_records(&now, Some(2), &nothing), "the counts call is settled on, and the page's own call for the word parts them");
        assert!(!parts_on_records(&now, Some(1), &kettle), "two walks with records are two sightings");
        assert!(parts_on_records(&nothing, Some(2), &kettle), "the walk that found nothing, learned with one that found records");
        let root = "https://shop.example/search?q=lantern";
        let graph = |history: &[&Trace], by_example: bool| {
            let history: Vec<(Trace, Vec<unbrowse_learn::trace::Probe>)> = history.iter().map(|t| ((*t).clone(), Vec::new())).collect();
            let route = route_of_by(&now, 1, "search the shop", root, true, &[], &history, None, by_example).unwrap();
            (serde_json::to_string(&route.graph).unwrap(), route.body.map(|b| b.tests.iter().map(|t| t.sightings.len()).collect::<Vec<_>>()))
        };
        for by_example in [false, true] {
            assert_eq!(graph(&[&nothing, &kettle], by_example), graph(&[&kettle], by_example), "the next walk with records is the second sighting (by example: {by_example})");
            assert_eq!(graph(&[&nothing], by_example), graph(&[], by_example), "else the walk stands alone (by example: {by_example})");
        }
        assert_ne!(graph(&[&kettle], true).1, graph(&[], true).1, "a walk with records is a second sighting of the call");
    }

    /// The route `route_of` gives with the switch off (`UNBROWSE_LEARN_BY_EXAMPLE=0`, the classifier's), on this thread.
    fn as_every_caller_gets(trace: &Trace, index: usize, root: &str, history: &[(Trace, Vec<unbrowse_learn::trace::Probe>)]) -> Option<String> {
        let _classifier = by_the_classifier();
        Some(serde_json::to_string(&route_of(trace, index, "search the shop", root, true, &[], history, None).unwrap()).unwrap())
    }

    /// One walk ties a number the search sends to an advert's earlier reply that holds it; both walks send the same
    /// number. By example the route is one plain step, the number its own text. With the switch off the route is the
    /// one `route_of` gives every caller.
    #[test]
    fn by_example_a_value_two_walks_send_the_same_is_the_calls_own_text() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let advert = |_: &str| walked("GET", "https://ads.shop.example/slot", r#"{"placement":"8842190117"}"#, false);
        let search = |word: &str| walked("GET", &format!("https://shop.example/api/search?q={word}&placement=8842190117"), &records(word), false);
        let (first, history) = walked_twice(&advert, &search);
        let root = "https://shop.example/search?q=lamp";
        let by = route_of_by(&first, 2, "search the shop", root, true, &[], &history, None, true).unwrap();
        assert_eq!(by.graph.steps.len(), 1, "{:?}", by.graph.steps.iter().map(|s| &s.url).collect::<Vec<_>>());
        let step = &by.graph.steps[0];
        assert!(step.fields.iter().any(|f| f.loc == unbrowse_learn::Loc::Query("placement".into()) && matches!(&f.class, unbrowse_learn::graph::Class::Constant { value, .. } if value == "8842190117")), "{:?}", step.fields);
        assert!(!step.fields.iter().any(|f| matches!(f.class, unbrowse_learn::graph::Class::Derived { .. })), "a plain step reads no earlier reply");
        assert_eq!(by.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["q"]);
        let off = serde_json::to_string(&route_of_by(&first, 2, "search the shop", root, true, &[], &history, None, false).unwrap()).unwrap();
        if let Some(every) = as_every_caller_gets(&first, 2, root, &history) {
            assert_eq!(off, every, "with the switch off, the route is the one every caller gets");
        }
        assert_ne!(off, serde_json::to_string(&by).unwrap(), "the switch is what changed the route");
    }

    /// A page whose call the learner cannot say as a graph (a leaf of its body read from an earlier reply, which a
    /// graph sends as its template's empty leaf when the reply lacks it, and the body does not) keeps the classifier's
    /// route: the same route by example as with the switch off, with the body it was learned as beside it.
    #[test]
    fn by_example_a_call_the_learner_cannot_say_as_a_graph_keeps_the_classifiers_route() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let token = |word: &str| walked("GET", "https://shop.example/api/token", &format!(r#"{{"token":"tok_{}"}}"#, if word == "lamp" { "9f8e7d6c5b4a" } else { "1a2b3c4d5e6f" }), false);
        let search = |word: &str| {
            let mut e = walked("POST", "https://shop.example/api/search", &records(word), false);
            e.request_headers = vec![("content-type".into(), "application/json".into())];
            e.request_body = Some(format!(r#"{{"token":"tok_{}","q":"{word}"}}"#, if word == "lamp" { "9f8e7d6c5b4a" } else { "1a2b3c4d5e6f" }));
            e
        };
        let (first, history) = walked_twice(&token, &search);
        let root = "https://shop.example/search?q=lamp";
        let by = route_of_by(&first, 2, "search the shop", root, true, &[], &history, None, true).unwrap();
        assert!(by.body.as_ref().is_some_and(|b| unbrowse_learn::body::to_graph(b).is_err()), "the body no graph says is kept beside the classifier's");
        let by = serde_json::to_string(&by.shown()).unwrap();
        let off = serde_json::to_string(&route_of_by(&first, 2, "search the shop", root, true, &[], &history, None, false).unwrap()).unwrap();
        // The routes are made a moment apart, and each says when it was learned: every field but that one is compared.
        let but_when = |route: &str| {
            let mut v: serde_json::Value = serde_json::from_str(route).unwrap();
            v.as_object_mut().unwrap().remove("learned_at");
            v
        };
        assert_eq!(but_when(&by), but_when(&off));
        if let Some(every) = as_every_caller_gets(&first, 2, root, &history) {
            assert_eq!(but_when(&off), but_when(&every));
        }
    }

    /// A shop on this machine: any page is its search page, and `/api/search` lists records saying the word it was
    /// sent as `q`. It keeps the address of every request it is asked, as sent.
    fn a_shop_on_this_machine() -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", site.local_addr().unwrap().port());
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let target = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                kept.locked().push(target.clone());
                let url = url::Url::parse(&format!("http://127.0.0.1{target}")).unwrap();
                let word = url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
                let (kind, body) = if url.path() == "/api/search" { ("application/json", records(&word)) } else { ("text/html", "<html><body>a shop</body></html>".to_string()) };
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (base, asked)
    }

    /// Two walks of a shop at `base`, for `red lamp` and `blue sofa`: its page asked for the word, and its search,
    /// whose address `search` writes for the word.
    fn two_walks_of(base: &str, search: &dyn Fn(&str) -> String) -> (Trace, Vec<(Trace, Vec<unbrowse_learn::trace::Probe>)>) {
        let walk = |word: &str| {
            let root = format!("{base}/search?q={}", word.replace(' ', "+"));
            Trace { exchanges: vec![walked("GET", &root, "<html><body>a shop</body></html>", true), walked("GET", &search(word), &records(word), false)], inputs: walk_inputs(&root, &[], &[]) }
        };
        (walk("red lamp"), vec![(walk("blue sofa"), Vec::new())])
    }

    /// The address of the last search the shop was asked for.
    fn last_search(asked: &Mutex<Vec<String>>) -> String {
        asked.locked().iter().rev().find(|t| t.starts_with("/api/search")).cloned().unwrap_or_default()
    }

    /// By example, a route whose body a graph can say is that graph, and every pass after the learn edits the graph.
    /// The body is kept beside it for what only it holds, its tests and its plan, and lays nothing over the graph: a
    /// call with the switch on sends what the graph says. From the plan alone, the page for another word is the
    /// address the trial walks for it.
    #[test]
    fn by_example_a_body_a_graph_says_is_the_graph_and_its_body_keeps_its_tests_and_plan() {
        store::scratch_home("by-example-said");
        let (base, asked) = a_shop_on_this_machine();
        let (first, history) = two_walks_of(&base, &|word| format!("{base}/api/search?q={}&placement=8842190117", word.replace(' ', "+")));
        let root = format!("{base}/search?q=red+lamp");
        let route = route_of_by(&first, 1, "search the shop", &root, true, &[], &history, None, true).unwrap();
        assert_eq!(route.graph.steps.len(), 1, "the graph the body is said as");
        let body = route.body.as_ref().expect("the body is kept for its tests and plan");
        assert!(unbrowse_learn::body::to_graph(body).is_ok(), "a graph says it");
        assert!(body.tests.iter().any(|t| t.step == body.answer.step && !t.sightings.is_empty()), "the answer's step keeps what it was learned against: {:?}", body.tests);
        let plan = body.plan.as_ref().expect("the plan to learn it again");
        assert_eq!(plan.page, format!("{base}/search?q={{q}}"));
        assert_eq!(plan.asked.iter().map(|a| (a.slot.as_str(), a.by)).collect::<Vec<_>>(), [("q", unbrowse_learn::route::AskedBy::TwoWalks)], "read from what the two walks' pages differ by");
        assert_eq!(plan.goal, "search the shop");
        assert_eq!(unbrowse_learn::lab::compile::page_for_another_word(plan, "chair"), experiment::for_another_word(&root, &["red lamp".to_string()], "chair"));
        assert!(unbrowse_learn::body::overlay(&route.graph, Some(body)).laid.is_empty(), "a body a graph says lays nothing over it");
        store::save_route(&route).unwrap();
        let chair = HashMap::from([("q".to_string(), "chair".to_string())]);
        let on = crate::run::calling_the_body(true, || crate::run::call(&route.id, &chair, "You")).unwrap();
        assert!(on.ok, "{:?}", on.error);
        assert!(last_search(&asked).contains("placement=8842190117") && last_search(&asked).contains("q=chair"), "{}", last_search(&asked));
    }

    /// The first site driven live through the node: a search box hands its word to the address with a plus for each
    /// space, and the address writes that again (`red lamp` is sent as `q=red%252Blamp`). No graph says a value
    /// written one way after another. By example the classifier's graph stands and the body is kept beside it; with
    /// the switch on a call sends the body's request, the new word written twice over. With it off the graph runs, and
    /// it reads that value as one the page computes: it sends nothing, and asks for a browser.
    #[test]
    fn by_example_a_body_no_graph_says_is_kept_beside_the_classifiers_graph_and_a_call_sends_its_request() {
        store::scratch_home("by-example-unsaid");
        let (base, asked) = a_shop_on_this_machine();
        let twice = |word: &str| url::form_urlencoded::byte_serialize(word.replace(' ', "+").as_bytes()).collect::<String>().replace('%', "%25");
        let (first, history) = two_walks_of(&base, &|word| format!("{base}/api/search?q={}", twice(word)));
        let root = format!("{base}/search?q=red+lamp");
        let route = route_of_by(&first, 1, "search the shop", &root, true, &[], &history, None, true).unwrap();
        let body = route.body.clone().expect("the body is kept");
        let unsaid = unbrowse_learn::body::to_graph(&body).expect_err("no graph says a value written twice over");
        let off = route_of_by(&first, 1, "search the shop", &root, true, &[], &history, None, false).unwrap();
        assert!(off.body.is_none(), "with the switch off a learn keeps no body");
        // The route offers what its body asks and its graph takes no input for: the word, optional, as walked.
        assert!(off.inputs.is_empty(), "the classifier's graph takes no input: {:?}", off.inputs);
        assert_eq!(route.inputs.iter().map(|i| (i.name.as_str(), i.default.as_deref(), i.optional)).collect::<Vec<_>>(), [("q", Some("red lamp"), true)]);
        let mut graphs = route.clone().shown();
        graphs.inputs = off.inputs.clone();
        // Learned a moment apart, the two may fall either side of a second: when is no part of what they say.
        graphs.learned_at = off.learned_at;
        // The page a signing bridge boots is written with the caller's value where the route takes one: now it does.
        assert_eq!(route.graph.page.as_deref(), Some(format!("{base}/search?q={{q}}").as_str()));
        graphs.graph.page = off.graph.page.clone();
        let (ours, theirs) = (serde_json::to_value(&graphs).unwrap(), serde_json::to_value(&off).unwrap());
        let parted: Vec<String> = ours.as_object().unwrap().iter().filter(|(k, v)| theirs.get(k.as_str()) != Some(*v)).flat_map(|(k, v)| match v.as_object() {
            Some(inner) => inner.iter().filter(|(j, w)| theirs[k.as_str()].get(j.as_str()) != Some(*w)).map(|(j, w)| format!("{k}.{j} = {w} against {}", theirs[k.as_str()][j.as_str()])).collect::<Vec<_>>(),
            None => vec![k.clone()],
        }).collect();
        assert!(parted.is_empty(), "the classifier's graph stands ({unsaid}); the routes part at {parted:?}");
        store::save_route(&route).unwrap();
        let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
        let on = crate::run::calling_the_body(true, || crate::run::call(&route.id, &chair, "You")).unwrap();
        assert!(on.ok, "{:?}", on.error);
        assert!(last_search(&asked).ends_with(&format!("q={}", twice("green chair"))), "the word written twice over: {}", last_search(&asked));
        let searches = |asked: &Mutex<Vec<String>>| asked.locked().iter().filter(|t| t.starts_with("/api/search")).count();
        let before = searches(&asked);
        let by_graph = crate::run::calling_the_body(false, || crate::run::call(&route.id, &chair, "You")).unwrap();
        assert!(!by_graph.ok && by_graph.error.as_deref().is_some_and(|e| e.contains("needs a browser")), "{:?}", by_graph.error);
        assert!(!by_graph.browser, "a test opens no browser for a heal: it named none");
        assert_eq!(searches(&asked), before, "the graph sent no search of its own");
    }

    /// The live run that exposed it: a pass after the learn (reading on to the next page) opened an input on the graph
    /// that the body, written before it, knows nothing of. What runs is the graph with the body's own hole laid over
    /// it, so a call for the next page sends the page's handle, and the word as the page writes it; the body's word
    /// stays one of the route's inputs through the pass's rewriting of them.
    #[test]
    fn by_example_a_call_for_the_next_page_sends_what_a_later_pass_opened_through_the_body() {
        store::scratch_home("by-example-next-page");
        let (base, asked) = a_shop_on_this_machine();
        let twice = |word: &str| url::form_urlencoded::byte_serialize(word.replace(' ', "+").as_bytes()).collect::<String>().replace('%', "%25");
        let (first, history) = two_walks_of(&base, &|word| format!("{base}/api/search?q={}", twice(word)));
        let root = format!("{base}/search?q=red+lamp");
        let mut route = route_of_by(&first, 1, "search the shop", &root, true, &[], &history, None, true).unwrap();
        assert!(route.body.is_some());
        // The paging pass, as it writes the graph and the route's inputs again (`what_the_page_took`).
        let step = route.graph.steps.last_mut().unwrap();
        unbrowse_learn::paging::place_optional(step, &unbrowse_learn::Loc::Query("page_handle".into()), "page_handle", None);
        route.inputs = Route::from_graph(route.id.clone(), route.what.clone(), route.root.clone(), route.graph.clone()).unwrap().inputs;
        route.offer_the_bodys_slots();
        assert_eq!(route.inputs.iter().map(|i| i.name.as_str()).collect::<std::collections::BTreeSet<_>>(), ["page_handle", "q"].into_iter().collect());
        store::save_route(&route).unwrap();
        let next = HashMap::from([("q".to_string(), "green chair".to_string()), ("page_handle".to_string(), "after-6".to_string())]);
        let called = crate::run::calling_the_body(true, || crate::run::call(&route.id, &next, "You")).unwrap();
        assert!(called.ok, "{:?}", called.error);
        let sent = last_search(&asked);
        assert!(sent.contains("page_handle=after-6") && sent.contains(&format!("q={}", twice("green chair"))), "the next page, through the body: {sent}");
    }

    /// The first ask, learned from one walk: the body by example is written from that one sighting, and a pass after
    /// the learn (reading on to the next page) edits the graph the body is laid over, so a call for the next page sends
    /// the page's handle through the body, and the word as the page writes it.
    #[test]
    fn by_example_from_one_walk_a_call_for_the_next_page_sends_what_a_later_pass_opened() {
        store::scratch_home("by-example-one-walk-next-page");
        let (base, asked) = a_shop_on_this_machine();
        let twice = |word: &str| url::form_urlencoded::byte_serialize(word.replace(' ', "+").as_bytes()).collect::<String>().replace('%', "%25");
        let (first, _) = two_walks_of(&base, &|word| format!("{base}/api/search?q={}", twice(word)));
        let root = format!("{base}/search?q=red+lamp");
        let mut route = route_of_by(&first, 1, "search the shop", &root, true, &[], &[], None, true).unwrap();
        assert!(route.body.is_some(), "one walk writes a body");
        let step = route.graph.steps.last_mut().unwrap();
        unbrowse_learn::paging::place_optional(step, &unbrowse_learn::Loc::Query("page_handle".into()), "page_handle", None);
        route.inputs = Route::from_graph(route.id.clone(), route.what.clone(), route.root.clone(), route.graph.clone()).unwrap().inputs;
        route.offer_the_bodys_slots();
        store::save_route(&route).unwrap();
        let next = HashMap::from([("q".to_string(), "green chair".to_string()), ("page_handle".to_string(), "after-6".to_string())]);
        let called = crate::run::calling_the_body(true, || crate::run::call(&route.id, &next, "You")).unwrap();
        assert!(called.ok, "{:?}", called.error);
        let sent = last_search(&asked);
        assert!(sent.contains("page_handle=after-6") && sent.contains(&format!("q={}", twice("green chair"))), "the next page, through the body: {sent}");
    }

    /// A shop on this machine that answers each request as `answer` says (its status, type and body), and keeps the
    /// address of every request it is asked, as sent.
    fn a_site_on_this_machine(answer: impl Fn(&url::Url) -> (u16, &'static str, String) + Send + 'static) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{BufRead, Write};
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", site.local_addr().unwrap().port());
        let asked = std::sync::Arc::new(Mutex::new(Vec::new()));
        let kept = asked.clone();
        std::thread::spawn(move || {
            for stream in site.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                let _ = reader.read_line(&mut first);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let target = first.split_whitespace().nth(1).unwrap_or("/").to_string();
                kept.locked().push(target.clone());
                let (status, kind, body) = answer(&url::Url::parse(&format!("http://127.0.0.1{target}")).unwrap());
                let mut out = stream;
                let _ = write!(out, "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        (base, asked)
    }

    /// A shop whose search moved since its route was learned: the old address says it is gone, and the new one lists
    /// what the old one did.
    fn a_shop_whose_search_moved(u: &url::Url) -> (u16, &'static str, String) {
        let word = u.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
        match u.path() {
            "/api/search" => (410, "application/json", r#"{"error":"gone"}"#.to_string()),
            "/api/v2/search" => (200, "application/json", records(&word)),
            _ => (200, "text/html", "<html><body>a shop</body></html>".to_string()),
        }
    }

    /// The route learned by example from two walks of the shop at `base` whose search is at `path`, kept: its body
    /// carries the plan it was learned by.
    fn learned_by_example_on(base: &str, path: &str) -> Route {
        let (first, history) = two_walks_of(base, &|word| format!("{base}{path}?q={}", word.replace(' ', "+")));
        let route = route_of_by(&first, 1, "search the shop", &format!("{base}/search?q=red+lamp"), true, &[], &history, None, true).unwrap();
        store::save_route(&route).unwrap();
        route
    }

    /// What a learner was handed, and a learner that learns the shop's search at `path` whatever it is handed.
    type Handed = std::rc::Rc<std::cell::RefCell<Vec<(String, String)>>>;
    fn a_learner(base: &str, path: &'static str) -> (Handed, impl Fn(&str, &str) -> Result<Route, String> + 'static) {
        let handed = Handed::default();
        let (seen, base) = (handed.clone(), base.to_string());
        (handed, move |page: &str, goal: &str| {
            seen.borrow_mut().push((page.to_string(), goal.to_string()));
            Ok(learned_by_example_on(&base, path))
        })
    }

    /// A route whose call finds the site drifted (its search answers that it is gone) is not healed in place: its
    /// plan's page, written with the caller's value, is learned again for its goal, the route learned takes its place,
    /// and the caller gets that route's answer and is told so. The old route is retired as it was learned, its graph
    /// and body untouched.
    #[test]
    fn a_route_whose_call_drifts_is_replaced_by_one_learned_from_its_plan_and_the_old_is_retired_not_edited() {
        let _old = crate::learn::own_asks::as_the_old_node();
        store::scratch_home("learned-again");
        let (base, asked) = a_site_on_this_machine(a_shop_whose_search_moved);
        let old = learned_by_example_on(&base, "/api/search");
        assert!(old.body.as_ref().and_then(|b| b.plan.as_ref()).is_some(), "the route carries its plan");
        let (handed, learner) = a_learner(&base, "/api/v2/search");
        let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
        let called = learning_again_by(learner, || crate::run::call(&old.id, &chair, "You")).unwrap();
        assert!(called.ok, "{:?}", called.error);
        assert_eq!(handed.borrow().as_slice(), [(format!("{base}/search?q=green+chair"), "search the shop".to_string())], "the plan's page, for the caller's value");
        let new = called.learned_again.clone().expect("the reply says the route was learned again");
        assert_ne!(new, old.id);
        assert!(called.fell_back.iter().any(|n| n.contains("learned it again")), "{:?}", called.fell_back);
        assert!(called.data.as_ref().is_some_and(|d| d.to_string().contains("green chair")), "{:?}", called.data);
        assert!(asked.locked().iter().any(|t| t == "/api/v2/search?q=green+chair"), "{:?}", asked.locked());
        assert!(store::load_route(&old.id).is_none(), "the old route no longer stands");
        let retired = store::load_retired(&old.id).expect("the old route is retired");
        assert_eq!((serde_json::to_value(&retired.graph).unwrap(), retired.body.clone()), (serde_json::to_value(&old.graph).unwrap(), old.body.clone()), "retired as it was learned");
        assert_eq!(store::took_the_place_of(&old.id).map(|r| r.id), Some(new));
    }

    /// A wall, a door's refusal or a site out of asks is no drift: the call fails and says what the site said, and
    /// nothing is learned again. The route stands as it was.
    #[test]
    fn a_wall_or_a_site_out_of_asks_is_reported_and_never_learned_again() {
        store::scratch_home("learned-again-wall");
        let walls: [fn(&url::Url) -> (u16, &'static str, String); 2] = [
            |u| if u.path() == "/api/search" { (503, "text/html", "<html><body>Checking your browser before you reach the shop</body></html>".into()) } else { (200, "text/html", "<html><body>a shop</body></html>".into()) },
            |u| if u.path() == "/api/search" { (429, "application/json", r#"{"error":"too many requests"}"#.into()) } else { (200, "text/html", "<html><body>a shop</body></html>".into()) },
        ];
        for wall in walls {
            let (base, _) = a_site_on_this_machine(wall);
            let old = learned_by_example_on(&base, "/api/search");
            let (handed, learner) = a_learner(&base, "/api/v2/search");
            let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
            let called = learning_again_by(learner, || crate::run::call(&old.id, &chair, "You")).unwrap();
            assert!(!called.ok && called.learned_again.is_none(), "{:?}", called.error);
            assert!(handed.borrow().is_empty(), "nothing was learned again: {:?}", called.error);
            assert_eq!(store::load_route(&old.id).map(|r| serde_json::to_value(&r.graph).unwrap()), Some(serde_json::to_value(&old.graph).unwrap()));
        }
    }

    /// A route that carries no plan is met as before when its site drifts: nothing is learned again, and the call
    /// fails as it does with the switch off.
    #[test]
    fn a_route_with_no_plan_heals_as_today() {
        store::scratch_home("learned-again-no-plan");
        let (base, _) = a_site_on_this_machine(a_shop_whose_search_moved);
        let mut old = learned_by_example_on(&base, "/api/search");
        old.body.as_mut().unwrap().plan = None;
        store::save_route(&old).unwrap();
        let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
        let off = crate::run::call(&old.id, &chair, "You").unwrap();
        let (handed, learner) = a_learner(&base, "/api/v2/search");
        let on = learning_again_by(learner, || crate::run::call(&old.id, &chair, "You")).unwrap();
        assert!(handed.borrow().is_empty());
        assert!(!on.ok && on.learned_again.is_none());
        assert_eq!((on.error, on.fell_back), (off.error, off.fell_back), "as with the switch off");
        assert!(store::load_route(&old.id).is_some());
    }

    /// A plan whose page asks a value the call does not give is not learned again: its page cannot be written, and
    /// nothing is walked or retired.
    #[test]
    fn a_plan_the_call_gives_no_value_for_is_not_learned_again() {
        store::scratch_home("learned-again-unfilled");
        let (base, _) = a_site_on_this_machine(a_shop_whose_search_moved);
        let old = learned_by_example_on(&base, "/api/search");
        let (handed, learner) = a_learner(&base, "/api/v2/search");
        let not = learning_again_by(learner, || learned_again(&old, &HashMap::new(), "You", None)).expect_err("no value for its page");
        assert!(not.contains("asks q") && not.contains("gives no value"), "{not}");
        assert!(handed.borrow().is_empty() && store::load_route(&old.id).is_some());
    }

    /// A write is never learned again: its route is its owner's to redo. Here the write is one an agent saw change the
    /// site, which is a write whatever the rule reads of its request.
    #[test]
    fn a_write_is_not_learned_again() {
        store::scratch_home("learned-again-write");
        let (base, _) = a_site_on_this_machine(a_shop_whose_search_moved);
        let mut old = learned_by_example_on(&base, "/api/search");
        old.judged.writes = true;
        store::save_route(&old).unwrap();
        let (handed, learner) = a_learner(&base, "/api/v2/search");
        let chair = HashMap::from([("q".to_string(), "green chair".to_string())]);
        let called = learning_again_by(learner, || crate::run::call(&old.id, &chair, "You")).unwrap();
        assert!(!called.ok && called.learned_again.is_none(), "{:?}", called.error);
        assert!(handed.borrow().is_empty());
        assert!(store::load_route(&old.id).is_some_and(|r| r.write));
    }

    /// The walk that exposed it: a hotel search whose page the site first held back (202, a check's script in it) and
    /// then served at the same address. The route for the page is the copy that answered, not the first the walk saw.
    #[test]
    fn of_a_page_held_back_and_then_served_the_route_is_the_copy_that_answered() {
        let url = "https://www.stays.example/searchresults.html?ss=Lisbon";
        let mut held = walked("GET", url, "<html><script>check()</script></html>", true);
        held.status = 202;
        let served = walked("GET", url, "<html><body><h3>Hotel Avenida</h3><span>S$ 210</span></body></html>", true);
        let trace = Trace { exchanges: vec![held.clone(), served.clone()], inputs: walk_inputs(url, &[], &[]) };
        for picked in [&held, &served] {
            let (first, _) = first_of_repeats(&trace, picked);
            assert_eq!(first.status, 200, "whichever copy was picked");
        }
    }

    /// The walk that exposed it: a news site whose page asks one address for its breaking-news ticker and then for
    /// the search, each naming itself in the same query key. They are two calls, told apart by what they answer
    /// with; the search's own next page is still a repeat of it.
    #[test]
    fn two_operations_at_one_address_are_told_apart_by_what_they_answer() {
        let at = |op: &str, vars: &str| format!("https://www.news.example/graphql?operationName={op}&variables={}", urlencoding(vars));
        let ticker = walked("GET", &at("TickerQuery", "{}"), r#"{"data":{"breakingNews":{"post":null}}}"#, false);
        let search = walked("GET", &at("SearchQuery", r#"{"query":"climate","start":1}"#), r#"{"data":{"searchPosts":{"items":[{"title":"Climate talks open"}]}}}"#, false);
        let more = walked("GET", &at("SearchQuery", r#"{"query":"climate","start":11}"#), r#"{"data":{"searchPosts":{"items":[{"title":"Climate talks close"}]}}}"#, false);
        let trace = Trace { exchanges: vec![ticker, search.clone(), more], inputs: Vec::new() };
        let (first, _) = first_of_repeats(&trace, &search);
        assert_eq!(first.url, search.url);
    }

    fn urlencoding(v: &str) -> String {
        url::form_urlencoded::byte_serialize(v.as_bytes()).collect()
    }

    /// The walk that exposed it: a news search at `/search/<word>` whose call sends the word inside a JSON value of
    /// its query. The address handed the word to the call, so it is the caller's; a word that is only part of some
    /// longer text there was not handed on.
    #[test]
    fn a_word_of_the_address_sent_inside_a_json_value_is_the_callers() {
        let url = "https://www.news.example/search/climate";
        let page = walked("GET", url, "<html><body>Search</body></html>", true);
        let call = |vars: &str| walked("GET", &format!("https://www.news.example/graphql?operationName=SearchQuery&variables={}", urlencoding(vars)), r#"{"data":{"searchPosts":{"items":[{"title":"Talks open in Bonn"},{"title":"Floods in the delta"}]}}}"#, false);
        let read = |vars: &str| path_inputs_read(url, "search the news", &Trace { exchanges: vec![page.clone(), call(vars)], inputs: Vec::new() }).0;
        assert_eq!(read(r#"{"query":"climate","start":1}"#), [("search".to_string(), "climate".to_string())]);
        assert!(read(r#"{"query":"the climate desk","start":1}"#).is_empty(), "part of a longer text");
    }

    /// The walk that exposed it: a recipe search at `/search/chicken-`, a page the server renders, with the site's
    /// own dash after the word. The page names itself by the word, so the word is what was asked and the dash is the
    /// address's. A piece the title never says, or a goal for one thing, reads as before.
    #[test]
    fn a_word_the_address_wraps_in_its_own_marks_is_read_where_the_page_names_itself_by_it() {
        let url = "https://www.recipes.example/search/chicken-";
        let read = |title: &str, goal: &str| {
            let page = walked("GET", url, &format!("<html><head><title>{title}</title></head><body><a href=\"/r/1\">Roast</a></body></html>"), true);
            path_inputs_read(url, goal, &Trace { exchanges: vec![page], inputs: Vec::new() }).0
        };
        assert_eq!(read("chicken | Recipes", "search recipes"), [("search".to_string(), "chicken".to_string())]);
        assert!(read("Search | Recipes", "search recipes").is_empty(), "the page never names itself by it");
    }

    /// The walk that exposed it: a shop's search, beside a recommendations call whose address holds the shop's own
    /// name. The goal names the shop too, so that call "named the goal" and was kept over the search. A call that
    /// says the site's name names the site.
    #[test]
    fn a_call_that_says_the_sites_own_name_does_not_name_the_goal() {
        let recommend = walked("GET", "https://api.bigshop.example/h5/mtop.bigshoprecommend.recommend/1.0/", "{}", false);
        assert!(!names_the_goal(&recommend, "search Bigshop products"));
        let availability = walked("GET", "https://api.bigshop.example/gql?opname=ProductsAvailability", "{}", false);
        assert!(names_the_goal(&availability, "search Bigshop products"));
    }

    /// The walk that exposed it: a shop whose search call was sent to a check, at an address that carries the page's
    /// own and the searched word with it. Two walks agreed on that call and it was kept as the route. A call
    /// answered with a door's page is the door.
    #[test]
    fn a_call_answered_with_a_checks_page_is_never_the_answer() {
        let url = "https://www.shop.example/tag/umbrella/?q=umbrella";
        let page = walked("GET", url, "<html><body><a href=\"/tag/umbrella/\">Umbrellas</a><p>40 items</p></body></html>", true);
        let mut check = walked("GET", "https://www.shop.example/tag/umbrella/_check_/wait?data=umbrella", "<html><head><script>solve()</script></head><body><div id=\"box\"></div></body></html>", false);
        check.response_mime = "text/html".into();
        let trace = Trace { exchanges: vec![page, check], inputs: walk_inputs(url, &[], &[]) };
        let why = fails_goal(&trace.exchanges[1], "search the shop", url, &["umbrella".to_string()], url, &trace);
        assert!(why.is_some_and(|w| w.contains("a check")));
    }

    /// The walk that exposed it: an encyclopedia's search behind a door that stands at the page's own address, posts
    /// its answer back there and is then served the page. The route was that post, with the door's tokens as its
    /// body: replayed, the site answered a menu. The page is the address fetched as a page.
    #[test]
    fn a_page_reached_through_a_doors_own_form_is_asked_for_as_a_page() {
        let url = "https://www.books.example/search?query=volcano";
        let mut door = walked("GET", url, "<html><head><script>check()</script></head><body></body></html>", true);
        door.status = 403;
        let rows: String = (0..8).map(|n| format!("<li><a href=\"/topic/volcano-{n}\">Volcano article {n}</a></li>")).collect();
        let mut through = walked("POST", url, &format!("<html><body><h1>Results</h1><ul>{rows}</ul></body></html>"), true);
        through.request_body = Some("33e8e1ac=a1b2c3&f58a3b1b=d4e5f6".into());
        through.request_headers = vec![("content-type".into(), "application/x-www-form-urlencoded".into())];
        let trace = Trace { exchanges: vec![door, through], inputs: walk_inputs(url, &[], &[]) };
        let route = route_of(&trace, 1, "search the encyclopedia", url, true, &[], &[], None).unwrap();
        assert_eq!(route.method, "GET");
        assert!(route.graph.steps.last().unwrap().body.is_none() && !route.write);
        assert!(route.inputs.iter().any(|i| i.name == "query"));
    }

    /// The walk that exposed it: a travel site that answers a request it does not take for a browser with the six
    /// characters `200-OK`, under a JSON content type. It was kept as the page's data and answered every search.
    #[test]
    fn a_bare_acknowledgement_is_not_a_plain_requests_data() {
        // A link followed to a document: a file, said as one; a page, data or text with no kind named is not.
        assert!(a_file("application/pdf", false, false) && a_file("image/png; q=1", false, false));
        assert!(!a_file("text/html; charset=utf-8", true, false) && !a_file("application/json", false, true) && !a_file("", false, false) && !a_file("text/plain", false, false));
        assert!(!plain_data(None, true, "200-OK"));
        assert!(!plain_data(Some(&serde_json::json!("ok")), true, "\"ok\""));
        assert!(!plain_data(Some(&serde_json::json!({})), false, "{}"));
        assert!(plain_data(Some(&serde_json::json!({"hotels": [{"name": "a"}]})), false, ""));
        assert!(plain_data(None, true, "id,name\n1,Avenida\n2,Baixa"));
    }

    /// The walk that exposed it: a shop's results page, rendered by the server, with a link to its next page that is
    /// its own address plus `page=2` and a tracking value. Nothing on the walk turned the page, so the route offered
    /// none. The page's own link says how it is read on; a link that changes what was asked, or goes elsewhere, does not.
    #[test]
    fn a_page_that_links_to_its_own_next_page_offers_it() {
        let url = "https://www.shop.example/s?k=flask";
        let page = |links: &str| walked("GET", url, &format!("<html><body><a href=\"/p/1\">Steel flask</a>{links}</body></html>"), true);
        let route = |links: &str| route_of(&Trace { exchanges: vec![page(links)], inputs: walk_inputs(url, &[], &[]) }, 0, "search the shop", url, true, &[], &[], None).unwrap();
        let next = route(r#"<a href="/s?k=flask&amp;page=2&amp;ref=sr_pg_2">Next</a><a href="/s?k=flask&amp;page=3&amp;ref=sr_pg_3">3</a>"#);
        assert_eq!(next.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }));
        assert!(next.inputs.iter().any(|i| i.name == "page" && i.optional && i.default.is_none()));
        assert_eq!(route(r#"<a href="/s?k=bottle&amp;page=2">Bottles</a><a href="/deals?page=2">Deals</a>"#).paging, None);
        assert_eq!(next_page_linked(&page(r#"<a href="/-/en/s?k=flask&amp;page=2&amp;qid=17">Next</a>"#)).as_deref(), Some("page"), "under the site's language prefix");
        assert_eq!(next_page_linked(&page(r#"<a href="/search/?k=flask&#038;search_page=2">Go to next page</a>"#)).as_deref(), Some("search_page"), "from the site's search page, carrying the ask");
        assert_eq!(next_page_linked(&page(r#"<a href="/s?k=flask&amp;page=2">Next</a><a href="/s?k=flask&amp;size=2">Size 2</a>"#)), None, "two keys say 2: nothing to choose by");
    }

    /// What stood between a walk and an answer is read from the walk once it ends, by the readers there are: the last
    /// page asks for a person (a check), the site sent the page to one that asks for a password (a sign-in), the door
    /// refused the page and held to the walk's end (a door). A walk none of them reads stays a page for hands, unread.
    #[test]
    fn hands_says_whether_a_door_a_sign_in_or_a_check_stood_in_the_way() {
        use crate::outcome::Outcome;
        let url = "https://shop.example/items?q=lamp";
        let at = |status: u16, e: Exchange| Exchange { status, ..e };
        let walk = |exchanges: Vec<Exchange>| Trace { exchanges, inputs: Vec::new() };
        let unread = || Unlearned::Hands("no call of the walk answers the goal".into());
        let read = |exchanges: Vec<Exchange>| stood_in_the_way(&walk(exchanges), url, unread());
        let check = walked("GET", "https://shop.example/items?q=lamp", "<html><head><script src=\"/check.js\"></script></head><body><p>One moment.</p></body></html>", true);
        let widget = walked("GET", "https://shop.example/items?q=lamp", "<html><body><h1>Lamps</h1><p>Before we go on, a quick check.</p><div class=\"box\" data-sitekey=\"k\"></div></body></html>", true);
        let sign_in = walked("GET", "https://shop.example/login", "<html><body><form><input name=\"email\"><input type=\"password\" name=\"password\"></form></body></html>", true);
        let refused = at(403, walked("GET", "https://shop.example/items?q=lamp", "<html><body><h1>Access denied</h1><p>This request was refused.</p></body></html>", true));
        let page = walked("GET", "https://shop.example/items?q=lamp", "<html><body><h1>Lamps</h1><a href=\"/a\">a</a><p>Four lamps</p></body></html>", true);
        let kind = |u: &Unlearned| (u.outcome().0, std::mem::discriminant(u));
        for (exchanges, want, from) in [
            (vec![check.clone()], Outcome::Challenge, "challenge.asks_a_person"),
            (vec![page.clone(), widget], Outcome::Challenge, "challenge.asks_a_person"),
            (vec![sign_in.clone()], Outcome::NeedsPerson, "answer.sent_to_sign_in"),
            (vec![refused.clone()], Outcome::Refused, "trace.door"),
            (vec![page.clone()], Outcome::NeedsHands, "unread"),
        ] {
            let u = read(exchanges);
            assert_eq!(u.outcome(), (want, from), "{u}");
            assert_eq!(u.to_string(), "no call of the walk answers the goal", "what it says is kept as said");
        }
        // A door the walk got through is no longer in the way.
        assert!(matches!(read(vec![refused.clone(), page.clone()]), Unlearned::Hands(_)));
        // Loading the page answered nothing, and the walk ended at the door: the door, saying what loading said.
        let door = stood_in_the_way(&walk(vec![refused.clone()]), url, Unlearned::Loading);
        assert_eq!(kind(&door).0, Outcome::Refused);
        assert_eq!(door.to_string(), NEEDS_HANDS);
        // `wall_read`: a Loading walk that shows a wall is read as that wall (so a warm rewalk can't mask a bounce);
        // a plain page that merely loaded is None, and a rewalk is still worth it.
        assert_eq!(wall_read(&walk(vec![check.clone()]), url).map(|u| u.outcome().0), Some(Outcome::Challenge));
        assert_eq!(wall_read(&walk(vec![sign_in.clone()]), url).map(|u| u.outcome().0), Some(Outcome::NeedsPerson));
        assert!(wall_read(&walk(vec![page.clone()]), url).is_none());
        assert!(matches!(stood_in_the_way(&walk(vec![page.clone()]), url, Unlearned::Loading), Unlearned::Loading), "nothing read, nothing changed");
        // The page's own ask refused is a door, unless the walk was sent on to a check.
        let asked = Unlearned::Door("the site refused the page's own call for \"lamp\": it was asked too often (429)".into(), "learn.the_pages_ask_was_refused");
        assert_eq!(stood_in_the_way(&walk(vec![page.clone()]), url, asked.clone()).outcome(), (Outcome::Refused, "learn.the_pages_ask_was_refused"));
        assert_eq!(stood_in_the_way(&walk(vec![page.clone(), check.clone()]), url, asked).outcome().0, Outcome::Challenge);
        // A page sent to a sign-in naming it to come back to is that sign-in; to an empty page, still unread.
        let sent = walked("GET", "https://shop.example/login?next=/items", "<html><body><form><input name=\"email\"><input type=\"password\" name=\"password\"></form></body></html>", true);
        assert_eq!(page_unreached(&walk(vec![sent]), url).map(|u| u.outcome().0), Some(Outcome::NeedsPerson));
        let bare = walked("GET", "https://shop.example/login?next=/items", "<html></html>", true);
        assert!(matches!(page_unreached(&walk(vec![bare]), url), Some(Unlearned::Hands(_))));
        // The engine's own word that the site kept challenging the browser is a check, whatever the capture holds.
        assert_eq!(walk_failed("mint unresolved (challenge); attached browser left open for verification", "the walk failed: …".into(), None, url).outcome(), (Outcome::Challenge, "mint.state"));
        assert_eq!(walk_failed("running the browser: the site kept challenging the browser", "the walk failed: …".into(), Some(&walk(vec![page.clone()])), url).outcome().0, Outcome::Challenge);
        assert!(matches!(walk_failed("the page never loaded", "the walk failed: the page never loaded".into(), Some(&walk(vec![page])), url), Unlearned::Hands(_)));
    }

    /// The walk that exposed it: a page for members, asked as a guest. The site sent the browser to its sign-in page,
    /// and the agent was told the page "needs clicks or typing". It is told the page is for someone signed in.
    #[test]
    fn a_page_for_someone_signed_in_says_so_to_a_guest() {
        let url = "https://club.example/secure";
        let form = walked("GET", "https://club.example/login", "<html><body><form><input name=\"username\"><input type=\"password\" name=\"password\"></form></body></html>", true);
        let why = page_detoured(&Trace { exchanges: vec![form], inputs: Vec::new() }, url);
        assert!(why.is_some_and(|w| w.contains("asks for a password") && w.contains("Sign in first")));
        let page = walked("GET", "https://club.example/about", "<html><body><p>About the club</p></body></html>", true);
        assert_eq!(page_detoured(&Trace { exchanges: vec![page], inputs: Vec::new() }, url), None);
    }

    /// The rule's pick for `goal` from a walk of `url` that saw `exchanges`, as `pick_and_keep` makes it.
    fn picked(url: &str, goal: &str, exchanges: Vec<Exchange>) -> Result<String, String> {
        let trace = Trace { exchanges, inputs: Vec::new() };
        let site = site_of(url::Url::parse(url).unwrap().host_str().unwrap());
        let view = view_of("t", url, &site, &trace, 0);
        let (in_path, _) = path_inputs(url, goal, &trace);
        let values: Vec<String> = walk_inputs(url, &in_path, &[]).into_iter().map(|i| i.value).collect();
        let scores = rule_scores(&trace, &view, goal, &values, &[]);
        rule_pick(&trace, &view, goal, &values, scores).map(|(i, _)| format!("{} {}", trace.exchanges[i].method, trace.exchanges[i].url.path()))
    }

    #[test]
    fn a_list_of_asset_urls_cannot_answer_for_linked_records() {
        let url = "https://reading.example/saved";
        let goal = "my saved posts: each post's text, author handle and its link, newest first";
        let assets = serde_json::Value::Array((0..30).map(|i| serde_json::json!({
            "hashtag": format!("tag-{i}"),
            "asset_url": format!("https://static.example/assets/{i}.png")
        })).collect()).to_string();
        let shell = walked("GET", url, "<html><title>Saved</title><body><main></main><script src='/app.js'></script></body></html>", true);
        let flags = walked("GET", "https://reading.example/api/assets.json", &assets, false);
        assert!(picked(url, goal, vec![shell.clone(), flags.clone()]).is_err());

        let entries: Vec<_> = (0..8).map(|i| serde_json::json!({
            "content": {"itemContent": {"post_results": {"result": {
                "legacy": {"full_text": format!("Saved note {i}")},
                "author": {"handle": "reader"},
                "url": format!("https://reading.example/posts/{i}")
            }}}}
        })).collect();
        let timeline = serde_json::json!({"data": {"saved_timeline": {"timeline": {"instructions": [{"entries": entries}]}}}}).to_string();
        let answer = walked("GET", "https://reading.example/api/graphql/operation/Saved", &timeline, false);
        assert_eq!(picked(url, goal, vec![shell, flags, answer]).as_deref(), Ok("GET /api/graphql/operation/Saved"));
    }

    /// A call an agent rejected for a page (`unbrowse_judge`) is never the learner's pick for it again: the learner keeps
    /// its next pick instead, whatever the rule scored highest. The rejected call is matched by its route's template,
    /// so another value in its query is the same call.
    /// The walk that exposed it: a library's search page fills itself from the site's own search API, which passes
    /// the page's address along (`client_url=`) for its logs. That call answers the search (its records say back the
    /// query); a third-party call carrying the address with nothing to show is still only reporting the page.
    #[test]
    fn the_sites_own_search_that_passes_the_page_along_still_answers_it() {
        let url = "https://lib.example/search?query=apollo%2011";
        let hits = serde_json::json!({ "user_query": "apollo 11", "hits": (0..5).map(|i| serde_json::json!({ "title": format!("Apollo 11 film {i}"), "identifier": format!("apollo-{i}") })).collect::<Vec<_>>() }).to_string();
        let got = picked(url, "search library items", vec![
            walked("GET", url, "<html><body><app-root></app-root></body></html>", true),
            walked("GET", "https://ads.example/bid?page=https%3A%2F%2Flib.example%2Fsearch%3Fquery%3Dapollo%252011", r#"{"seatbid":[]}"#, false),
            walked("GET", "https://lib.example/services/search/page?user_query=apollo+11&client_url=https%3A%2F%2Flib.example%2Fsearch%3Fquery%3Dapollo%252011", &hits, false),
        ]);
        assert_eq!(got.as_deref(), Ok("GET /services/search/page"));
    }

    /// A site that challenges a cold browser loads the page twice: the challenge's interstitial (empty, replaced at
    /// once), then the page. The route is the copy that answered, never the empty first load, even though both sent
    /// what was asked.
    #[test]
    fn a_page_loaded_behind_a_challenge_is_learned_from_the_load_that_answered() {
        let url = "https://pkg.example/search/?q=requests";
        let challenge = walked("GET", url, "", true);
        let page = walked("GET", url, "<html><body><h1>requests</h1><ul><li>requests 2.32</li></ul></body></html>", true);
        let trace = Trace { exchanges: vec![challenge, page.clone()], inputs: Vec::new() };
        let (first, cursors) = first_of_repeats(&trace, &page);
        assert!(first.response_body.as_deref().is_some_and(|b| b.contains("requests 2.32")), "the load that answered");
        assert!(cursors.is_empty());
    }

    /// A walk that read on holds the call twice, a page apart. The route answers the caller's search from the list's
    /// start, and says how to read on from it.
    #[test]
    fn a_route_reads_on_from_what_its_repeats_showed() {
        let url = "https://shop.example/search?q=desk%20lamp";
        let answer = |n: u32| serde_json::json!({ "results": [{ "id": n, "title": format!("desk lamp {n}") }] }).to_string();
        let trace = Trace {
            exchanges: vec![
                walked("GET", "https://shop.example/api/search?q=desk+lamp&page=1", &answer(1), false),
                walked("GET", "https://shop.example/api/search?q=desk+lamp&page=2", &answer(2), false),
            ],
            inputs: walk_inputs(url, &[], &[]),
        };
        let route = route_of(&trace, 0, "search lamps", url, true, &[], &[], None).unwrap();
        assert_eq!(route.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }));
        let page = route.inputs.iter().find(|i| i.name == "page").expect("the route takes the page");
        assert_eq!(page.default.as_deref(), Some("1"), "a call that says nothing asks for the first page");
    }

    /// What a server-rendered list offers in its own markup becomes what its route takes, with nothing clicked: a
    /// value left unset isn't sent, so the call is the page as it was walked.
    #[test]
    fn a_page_route_takes_what_the_page_offers() {
        let url = "https://shop.example/search?q=desk";
        let page = r#"<html><body><h1>desk lamps</h1><ul><li>desk lamp</li></ul>
            <form action="/search"><input name="q"><select name="sort"><option value="price">Price</option><option value="new">Newest</option></select></form>
            <a href="?q=desk&pg=2">2</a><a href="?q=desk&pg=3">3</a></body></html>"#;
        let trace = Trace { exchanges: vec![walked("GET", url, page, true)], inputs: walk_inputs(url, &[], &[]) };
        let route = route_of(&trace, 0, "search lamps", url, true, &[], &[], None).unwrap();
        assert_eq!(route.paging, Some(unbrowse_learn::paging::Paging::Count { input: "pg".into(), step: 1 }));
        let sort = route.inputs.iter().find(|i| i.name == "sort").expect("the page offers a sort");
        assert!(sort.optional && sort.default.is_none());
        assert_eq!(sort.options.iter().map(|c| c.label.as_deref().unwrap()).collect::<Vec<_>>(), ["Price", "Newest"]);
        assert!(route.inputs.iter().any(|i| i.name == "q" && !i.optional), "the search stays the caller's");
    }

    /// The walk that exposed it: a news search kept as a route, whose page also asks the same address for a ticker
    /// under another operation name. Trying the page read the ticker as the search made again, made the operation's
    /// name a choice, and the route answered the ticker. A call that answers with another kind of thing is no repeat.
    #[test]
    fn another_operation_at_the_routes_address_is_not_the_route_made_again() {
        let url = "https://www.news.example/search?q=climate";
        let at = |op: &str, q: &str| format!("https://www.news.example/graphql?operationName={op}&q={q}");
        let search = walked("GET", &at("SearchQuery", "climate"), r#"{"data":{"searchPosts":{"items":[{"title":"Climate talks open"}]}}}"#, false);
        let ticker = walked("GET", &at("TickerQuery", "climate"), r#"{"data":{"breakingNews":{"post":null}}}"#, false);
        let mut route = route_of(&Trace { exchanges: vec![search.clone()], inputs: walk_inputs(url, &[], &[]) }, 0, "search the news", url, true, &[], &[], None).unwrap();
        what_the_page_took(&mut route, &Trace { exchanges: vec![ticker, search], inputs: Vec::new() });
        assert!(!route.inputs.iter().any(|i| i.name == "operationName"), "{:?}", route.inputs.iter().map(|i| &i.name).collect::<Vec<_>>());
    }

    /// What trying the page showed goes onto the route already kept: the filter each control sent, offered as an input,
    /// and left unsent until a caller sets it. The caller's own search stays theirs, and nothing moves a session value.
    #[test]
    fn trying_the_page_adds_what_its_controls_sent() {
        let url = "https://shop.example/search?q=desk%20lamp";
        let answer = serde_json::json!({ "results": [{ "id": 1, "title": "desk lamp" }] }).to_string();
        let call = |query: &str| walked("GET", &format!("https://shop.example/api/search?q=desk+lamp{query}"), &answer, false);
        let learned = Trace { exchanges: vec![call("")], inputs: walk_inputs(url, &[], &[]) };
        let mut route = route_of(&learned, 0, "search lamps", url, true, &[], &[], None).unwrap();
        let tried = Trace { exchanges: vec![call(""), call("&material=brass"), call(""), call("&sort=price_asc"), call("&page=2")], inputs: Vec::new() };
        what_the_page_took(&mut route, &tried);
        let input = |n: &str| route.inputs.iter().find(|i| i.name == n);
        assert_eq!(input("material").unwrap().options.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["brass"]);
        assert!(input("material").unwrap().optional && input("material").unwrap().default.is_none());
        assert!(input("sort").unwrap().optional);
        assert_eq!(route.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }));
        assert!(!input("q").unwrap().optional, "the search is the caller's");
    }

    /// The page's trial walk is no reason to change a call it didn't make.
    #[test]
    fn trying_the_page_leaves_other_calls_alone() {
        let url = "https://shop.example/search?q=lamp";
        let answer = serde_json::json!({ "results": [{ "id": 1, "title": "lamp" }] }).to_string();
        let learned = Trace { exchanges: vec![walked("GET", "https://shop.example/api/search?q=lamp", &answer, false)], inputs: walk_inputs(url, &[], &[]) };
        let mut route = route_of(&learned, 0, "search lamps", url, true, &[], &[], None).unwrap();
        let before = route.inputs.len();
        let tried = Trace { exchanges: vec![walked("GET", "https://shop.example/api/recs?slot=a", &answer, false), walked("GET", "https://shop.example/api/recs?slot=b", &answer, false)], inputs: Vec::new() };
        what_the_page_took(&mut route, &tried);
        assert_eq!(route.inputs.len(), before);
    }

    /// A page and its data call can share an address (`/tag/lamp/?q=lamp`, and `/tag/lamp/?ajax=true&q=lamp` answering
    /// its results): trying the page sees both, and the page is no repeat of the call. Read as the first of them, it
    /// would turn the call's own `ajax=true` into an option nobody sends, and every call after into the page.
    #[test]
    fn trying_the_page_never_takes_the_page_for_a_repeat_of_its_data_call() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let url = "https://shop.example/tag/lamp/?q=lamp";
        let answer = serde_json::json!({ "mods": { "listItems": [{ "name": "desk lamp", "price": "9.99" }] } }).to_string();
        let data = |page: &str| walked("GET", &format!("https://shop.example/tag/lamp/?ajax=true&page={page}&q=lamp"), &answer, false);
        let learned = Trace { exchanges: vec![data("1")], inputs: walk_inputs(url, &[], &[]) };
        // The classifier's graph (`UNBROWSE_LEARN_BY_EXAMPLE=0`) says the call's own `ajax=true` is its constant; the
        // twin below holds the default learner to the same behaviour.
        let mut route = route_of_by(&learned, 0, "search lamps", url, true, &[], &[], None, false).unwrap();
        let tried = Trace { exchanges: vec![walked("GET", url, "<html><body>lamps</body></html>", true), data("1"), data("2")], inputs: Vec::new() };
        what_the_page_took(&mut route, &tried);
        let step = route.graph.steps.last().unwrap();
        let ajax = step.fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query("ajax".into())).unwrap();
        assert!(matches!(&ajax.class, unbrowse_learn::Class::Constant { value, .. } if value == "true"), "{:?}", ajax.class);
        assert!(route.inputs.iter().all(|i| i.name != "ajax"), "{:?}", route.inputs);
        assert_eq!(route.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }), "its own repeats still say what it does");
    }

    /// [`trying_the_page_never_takes_the_page_for_a_repeat_of_its_data_call`] on the default learner: after trying the
    /// page, the call still sends its own `ajax=true`, nobody is asked for it, and its own repeats say how it pages.
    #[test]
    fn by_default_trying_the_page_never_takes_the_page_for_a_repeat_of_its_data_call() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let url = "https://shop.example/tag/lamp/?q=lamp";
        let answer = serde_json::json!({ "mods": { "listItems": [{ "name": "desk lamp", "price": "9.99" }] } }).to_string();
        let data = |page: &str| walked("GET", &format!("https://shop.example/tag/lamp/?ajax=true&page={page}&q=lamp"), &answer, false);
        let learned = Trace { exchanges: vec![data("1")], inputs: walk_inputs(url, &[], &[]) };
        let mut route = route_of(&learned, 0, "search lamps", url, true, &[], &[], None).unwrap();
        let tried = Trace { exchanges: vec![walked("GET", url, "<html><body>lamps</body></html>", true), data("1"), data("2")], inputs: Vec::new() };
        what_the_page_took(&mut route, &tried);
        let step = route.graph.steps.last().unwrap();
        // Its own value, whether the learner calls it the site's constant or, from one walk, a value sent as walked.
        let sends_its_own = step.fields.iter().any(|f| {
            f.loc == unbrowse_learn::Loc::Query("ajax".into())
                && matches!(&f.class, unbrowse_learn::Class::Constant { value, .. } | unbrowse_learn::Class::Unconfirmed { value } if value == "true")
        });
        assert!(sends_its_own, "the call sends its own ajax=true: {} {:?}", step.url, step.fields);
        assert!(route.inputs.iter().all(|i| i.name != "ajax"), "{:?}", route.inputs);
        assert_eq!(route.paging, Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 }), "its own repeats still say what it does");
    }

    /// A site that moves its page to its own country's domain (`stayhere.com` answering from `stayhere.com.sg`) is
    /// judged on the site it moved to: that page and its calls are the walk's, not a door. A waiting room on another
    /// host, a page that only runs a script and links nowhere, is still the door, and the asked site stays.
    #[test]
    fn a_page_the_site_moved_to_its_own_country_domain_is_the_site() {
        let listings: String = (0..30).map(|i| format!("<a href=\"/rooms/{i}\">Home {i} in Bangkok, S$ {i}0 a night</a>")).collect();
        let mut moved = walked("GET", "https://www.stayhere.com/s/Bangkok/homes?adults=2", "", true);
        moved.status = 301;
        let mut there = walked("GET", "https://www.stayhere.com.sg/s/Bangkok/homes?adults=2", &format!("<html><body>{listings}</body></html>"), true);
        there.main_frame = Some(true);
        assert_eq!(walked_site([&moved, &there], "www.stayhere.com"), "stayhere.com.sg");
        let mut room = walked("GET", "https://queue.gate.example/wait?c=stay", "<html><head><script>setTimeout(()=>location.reload(),5000)</script></head><body>Please wait</body></html>", true);
        room.main_frame = Some(true);
        assert_eq!(walked_site([&moved, &room], "www.stayhere.com"), "stayhere.com", "a waiting room is the door");
        let unanswered = Exchange { status: 0, response_body: None, ..room };
        assert_eq!(walked_site([&moved, &there, &unanswered], "www.stayhere.com"), "stayhere.com.sg", "an unanswered request cannot replace the page reached");
        let trace = Trace { exchanges: vec![moved, there], inputs: Vec::new() };
        let view = view_of("w", "https://www.stayhere.com/s/Bangkok/homes?adults=2", &walked_site(&trace.exchanges, "www.stayhere.com"), &trace, 0);
        assert!(view.candidates.iter().any(|c| c.index == 1 && c.page), "the page it moved to is a candidate: {:?}", view.candidates.iter().map(|c| (c.index, c.page)).collect::<Vec<_>>());
    }

    /// A guest count is asked for as much as a city: `adults=2` is an input, so `adults=1` is the same route asked
    /// again, not a page learned anew. Too short to say anything by itself, it never counts as a call sending what the
    /// page was asked for.
    #[test]
    fn a_one_character_value_the_page_was_asked_is_an_input() {
        let url = "https://stay.example/s/bangkok/homes?city=bangkok&adults=2";
        assert!(walk_inputs(url, &[], &[]).iter().any(|i| i.name == "adults" && i.value == "2"));
        assert_eq!(asked_values(url, &[]), ["bangkok"]);
        let page = format!("<html><body>{}</body></html>", (0..30).map(|i| format!("<a href=\"/rooms/{i}\">Home {i} in Bangkok, S$ {i}0 a night</a>")).collect::<String>());
        let trace = Trace { exchanges: vec![walked("GET", url, &page, true)], inputs: walk_inputs(url, &[], &[]) };
        let route = route_of(&trace, 0, "search stays", url, true, &[], &[], None).unwrap();
        assert!(route.inputs.iter().any(|i| i.name == "adults" && i.default.as_deref() == Some("2")), "{:?}", route.inputs);
    }

    /// Data is data however the site sends it: a search that streams its results as events of JSON is a call that
    /// answers, as one that sends them at once is.
    #[test]
    fn a_search_streaming_its_results_is_a_candidate() {
        let events = (0..3).map(|i| format!("data:{{\"flights\":[{{\"no\":\"SQ{i}\",\"price\":\"S$ 2{i}1\"}}]}}\n\n")).collect::<String>();
        let mut stream = walked("POST", "https://air.example/restapi/FlightListSearchSSE", &events, false);
        stream.response_mime = "text/event-stream".into();
        assert!(is_candidate(&stream, "air.example"));
        assert_eq!(candidate(0, &stream).keys, ["flights"], "the last event carries the answer's keys");
        let mut chatter = walked("POST", "https://air.example/restapi/notify", "event: ping\ndata: still here\n\n", false);
        chatter.response_mime = "text/event-stream".into();
        assert!(!is_candidate(&chatter, "air.example"), "a stream that holds no data answers nothing");
        // Chunks of markup joined by a separator, typed as a JSON of the site's own: the route's call could never read
        // it back, so it answers nothing. A script-safe JSON behind a prefix is text the site serves as data, and does.
        let mut chunks = walked("POST", "https://air.example/s/query?k=lamp&page=2", &"[ \"dispatch\", \"slot-1\", {\"html\":\"<div>lamp</div>\"} ]&&&\n".repeat(4), false);
        chunks.response_mime = "application/json-ui-streaming".into();
        assert!(!is_candidate(&chunks, "air.example"));
        let mut guarded = walked("GET", "https://air.example/search?q=lamp", &format!(")]}}'\n{}", serde_json::json!([["lamp", [[null, "Lamp shop", 4.5]]]])).repeat(2), false);
        guarded.response_mime = "application/json".into();
        assert!(is_candidate(&guarded, "air.example"));
    }

    /// A site that writes the search into its address the way a form does (`/maps/search/coffee+shops/`) asks its own
    /// call for it with spaces (`q=coffee shops`): the piece is the caller's, as the call sends it. A plus the calls
    /// send as it is (`c++`) is the piece's own.
    #[test]
    fn a_path_written_with_pluses_is_asked_with_spaces() {
        let places = serde_json::json!({ "places": [{ "name": "Kopi Bar", "rating": 4.5 }, { "name": "Bean There", "rating": 4.2 }] }).to_string();
        let url = "https://maps.example/maps/search/coffee+shops/";
        let trace = Trace { exchanges: vec![walked("GET", url, "<html><body>coffee shops</body></html>", true), walked("GET", "https://maps.example/search?tbm=map&q=coffee+shops", &places, false)], inputs: vec![] };
        assert_eq!(path_inputs(url, "search places", &trace).0, [("search".to_string(), "coffee shops".to_string())]);
        let url = "https://code.example/tags/c++/";
        let trace = Trace { exchanges: vec![walked("GET", url, "<html><body>c++</body></html>", true), walked("GET", "https://code.example/api/q?tag=c%2B%2B", &places, false)], inputs: vec![] };
        assert_eq!(path_inputs(url, "search questions", &trace).0, [("tags".to_string(), "c++".to_string())]);
    }

    /// The decision model is told what each answer holds, as facts the node read: a list of records holding the goal's
    /// fields that says back the search, beside a call whose top keys read the same and holds none of it.
    #[test]
    fn the_model_is_told_what_each_answer_holds() {
        let url = "https://stay.example/searchresults?ss=bangkok";
        let hotels = serde_json::json!({ "data": { "results": (0..5).map(|i| serde_json::json!({ "name": format!("Bangkok hotel {i}"), "price": format!("S$ {i}9") })).collect::<Vec<_>>() }, "extensions": {} }).to_string();
        let menu = serde_json::json!({ "data": { "menu": { "links": ["Stays", "Flights", "Car rentals", "Attractions", "Airport taxis"] } }, "extensions": {} }).to_string();
        let trace = Trace { exchanges: vec![walked("POST", "https://stay.example/dml/graphql", &hotels, false), walked("POST", "https://stay.example/dml/graphql", &menu, false)], inputs: walk_inputs(url, &[], &[]) };
        let view = view_of("w", url, "stay.example", &trace, 0);
        let rows = model_rows(&trace, &view, "search hotels with prices", &asked_values(url, &[]));
        let row = |i: usize| rows.iter().find(|r| r.index == i).unwrap();
        assert!(row(0).records >= 5 && !row(0).holds.is_empty() && row(0).says_back, "{:?}", row(0));
        assert!(!row(1).says_back && row(1).holds.is_empty(), "{:?}", row(1));
        assert_eq!(row(0).answers, row(1).answers, "by their names alone the two read the same");
    }

    #[test]
    fn a_call_an_agent_rejected_is_passed_over_for_the_next_pick() {
        let url = "https://shop.example/search?q=desk%20lamp";
        let goal = "search shop listings";
        let records = |kind: &str| {
            serde_json::json!({ "results": (0..6).map(|i| serde_json::json!({ "id": i, "title": format!("desk lamp {kind} {i}"), "price": format!("${i}.99"),
                "url": format!("https://shop.example/item/{kind}{i}") })).collect::<Vec<_>>() }).to_string()
        };
        let exchanges = vec![
            walked("GET", url, "<html><body>desk lamp results</body></html>", true),
            walked("GET", "https://shop.example/api/carousel?q=desk%20lamp", &records("carousel"), false),
            walked("GET", "https://shop.example/api/search?q=desk%20lamp", &records("listing"), false),
        ];
        let trace = Trace { exchanges: exchanges.clone(), inputs: Vec::new() };
        let first = picked(url, goal, exchanges).expect("a pick");
        let at = trace.exchanges.iter().position(|e| format!("{} {}", e.method, e.url.path()) == first).unwrap();
        // The agent rejects that call, as its route's template: a later walk sends another value in its query.
        let template = format!("{}://{}{}?q={{q}}", trace.exchanges[at].url.scheme(), trace.exchanges[at].url.host_str().unwrap(), trace.exchanges[at].url.path());
        let rejected: unbrowse_learn::Step = serde_json::from_value(serde_json::json!({ "exchange": at, "method": "GET", "status": 200, "url": template,
            "needs_browser": false, "response_shape": {}, "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "desk lamp" }] }))
            .unwrap();
        let site = site_of("shop.example");
        let mut view = view_of("t", url, &site, &trace, 0);
        pass_over(&mut view, &trace, std::slice::from_ref(&rejected));
        assert!(!view.candidates.iter().any(|c| c.index == at), "the rejected call is no candidate");
        let (in_path, _) = path_inputs(url, goal, &trace);
        let values: Vec<String> = walk_inputs(url, &in_path, &[]).into_iter().map(|i| i.value).collect();
        let scores = rule_scores(&trace, &view, goal, &values, &[]);
        let next = rule_pick(&trace, &view, goal, &values, scores).map(|(i, _)| i);
        assert!(next.as_ref().is_ok_and(|i| *i != at), "the next pick is another call: {next:?}");
        // The same call with another search in its query is still the rejected one.
        let mut other = trace.exchanges[at].clone();
        other.url.set_query(Some("q=office%20chair"));
        assert!(is_rejected(std::slice::from_ref(&rejected), &other));
        other.method = "POST".into();
        assert!(!is_rejected(std::slice::from_ref(&rejected), &other), "another method is another call");
        // A piece the route fills from the session or an earlier answer takes any value; a fixed query value doesn't.
        let step = |url: &str| -> unbrowse_learn::Step {
            serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": url, "needs_browser": false, "response_shape": {}, "fields": [] })).unwrap()
        };
        let flags = step("https://shop.example/api/v1/raw/{path[4]}/s?term={term}&state=IA");
        let at = |u: &str| url::Url::parse(u).unwrap();
        assert!(same_call(&flags, "GET", &at("https://shop.example/api/v1/raw/x9f/s?term=lego&state=IA&visitor=1"), None));
        assert!(!same_call(&flags, "GET", &at("https://shop.example/api/v1/raw/x9f/s?term=lego&state=CA"), None), "another fixed value is another call");
        assert!(!same_call(&flags, "GET", &at("https://shop.example/api/v1/raw/x9f/t?term=lego"), None), "another path is another call");
    }

    /// Of two calls to one GraphQL address, the one that sends the search as its own value answers the search page, not
    /// the one that sends the page's address for its metadata. The walk that exposed it: a video site's search page,
    /// whose metadata call (`uri: "/search/cats/videos"`) says "cats" back in the page's title.
    #[test]
    fn a_call_sending_the_value_beats_one_sending_the_pages_address() {
        let url = "https://www.video.example/search/cats/videos";
        let mut meta = walked("POST", "https://api.video.example/v1/graphql", r#"{"data":{"metadata":{"title":"cats videos - Video Site","description":"Watch cats videos"}}}"#, false);
        meta.request_body = Some(r#"{"operationName":"METADATA_QUERY","variables":{"uri":"/search/cats/videos"}}"#.into());
        let hits: String = (0..10).map(|i| format!(r#"{{"node":{{"title":"Funny cats {i}","xid":"x{i}"}}}}"#)).collect::<Vec<_>>().join(",");
        let mut search = walked("POST", "https://search.video.example/v1", &format!(r#"{{"data":{{"search":{{"videos":{{"edges":[{hits}]}}}}}}}}"#), false);
        search.request_body = Some(r#"{"operationName":"SEARCH_QUERY","variables":{"query":"cats","shouldIncludeVideos":true}}"#.into());
        let got = picked(url, "search the site's videos", vec![meta, search]);
        assert_eq!(got.as_deref(), Ok("POST /v1"), "{got:?}");
        assert!(got.is_ok_and(|_| true));
    }

    /// Another method at one address is another call, not a repeat of it: the photo search a page sent after its
    /// related-tags call, both to `/services/rest`, is kept as itself. A repeat for the next page (a cursor with digits)
    /// still is the same call.
    #[test]
    fn another_method_at_one_address_is_no_repeat() {
        let tags = walked("GET", "https://api.photos.example/services/rest?tag=lighthouse&method=photos.tags.getRelated&format=json", r#"{"tags":{"source":"lighthouse","tag":[{"_content":"sea"}]}}"#, false);
        let photos = walked("GET", "https://api.photos.example/services/rest?text=lighthouse&method=photos.photos.search&format=json&page=1", r#"{"photos":{"photo":[{"title":"Lighthouse at dusk"}]}}"#, false);
        let page2 = walked("GET", "https://api.photos.example/services/rest?text=lighthouse&method=photos.photos.search&format=json&page=2", r#"{"photos":{"photo":[{"title":"Old lighthouse"}]}}"#, false);
        let trace = Trace { exchanges: vec![tags.clone(), photos.clone(), page2.clone()], inputs: vec![unbrowse_learn::Input::new("text", "lighthouse")] };
        let (first, readings) = first_of_repeats(&trace, &photos);
        assert!(first.url.query().unwrap_or_default().contains("photos.search"), "{}", first.url);
        use unbrowse_learn::paging::Reading;
        let loc_of = |r: &Reading| match r {
            Reading::Paging { loc, .. } | Reading::Choice { loc, .. } | Reading::Pinned { loc } => loc.clone(),
        };
        assert_eq!(readings.iter().map(loc_of).collect::<Vec<_>>(), vec![unbrowse_learn::Loc::Query("page".into())]);
        assert!(!same_operation(&tags, &photos, &["lighthouse"]) && same_operation(&photos, &page2, &["lighthouse"]));
    }

    /// Two operations at one address are two routes: their ids differ by the body's naming values, and a body that
    /// names none (or no body) leaves the id as the address alone.
    #[test]
    fn two_operations_at_one_address_are_two_routes() {
        let step = |videos: bool| -> unbrowse_learn::Step {
            serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "POST", "status": 200, "url": "https://search.video.example/v1", "needs_browser": false, "response_shape": {},
                "fields": [{ "loc": { "in": "json", "key": "/operationName" }, "class": "unconfirmed", "value": "SEARCH_QUERY" }, { "loc": { "in": "json", "key": "/variables/shouldIncludeVideos" }, "class": "constant", "value": videos.to_string(), "origin": null }, { "loc": { "in": "json", "key": "/variables/query" }, "class": "input", "name": "search", "secret": false, "default": "cats" }] })).unwrap()
        };
        assert_ne!(operation_of(&step(true)), operation_of(&step(false)));
        let plain: unbrowse_learn::Step = serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/s?q={q}", "needs_browser": false, "response_shape": {}, "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }] })).unwrap();
        assert_eq!(operation_of(&plain), "");
    }

    /// One address that answers many operations (a REST method in the query, a GraphQL operation in the body) tells
    /// them apart only by the value the step fixes there: rejecting one operation passes over no other. The walks that
    /// exposed it: a photo site's related-tags call (`method=` a constant its template writes as a placeholder) and a
    /// video site's stories operation at one GraphQL address; judging each wrong passed over the search beside it.
    #[test]
    fn rejecting_one_operation_at_an_address_passes_over_no_other() {
        let rest: unbrowse_learn::Step = serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://api.photos.example/services/rest?tag={tag}&method={method}", "needs_browser": false, "response_shape": {},
            "fields": [{ "loc": { "in": "query", "key": "tag" }, "class": "input", "name": "text", "secret": false, "default": "sunset" }, { "loc": { "in": "query", "key": "method" }, "class": "constant", "value": "photos.tags.getRelated", "origin": null }] })).unwrap();
        let at = |u: &str| url::Url::parse(u).unwrap();
        assert!(same_call(&rest, "GET", &at("https://api.photos.example/services/rest?tag=bridge&method=photos.tags.getRelated"), None));
        assert!(!same_call(&rest, "GET", &at("https://api.photos.example/services/rest?text=bridge&method=photos.photos.search"), None));
        let gql: unbrowse_learn::Step = serde_json::from_value(serde_json::json!({ "exchange": 0, "method": "POST", "status": 200, "url": "https://search.video.example/v1", "needs_browser": false, "response_shape": {},
            "fields": [{ "loc": { "in": "json", "key": "/operationName" }, "class": "unconfirmed", "value": "SEARCH_STORIES" }, { "loc": { "in": "json", "key": "/variables/query" }, "class": "input", "name": "search", "secret": false, "default": "cats" }, { "loc": { "in": "json", "key": "/extensions/key" }, "class": "unconfirmed", "value": "k9f3a77c" }] })).unwrap();
        let body = |op: &str, key: &str| format!(r#"{{"operationName":"{op}","variables":{{"query":"dogs"}},"extensions":{{"key":"{key}"}}}}"#);
        assert!(same_call(&gql, "POST", &at("https://search.video.example/v1"), Some(&body("SEARCH_STORIES", "k9f3a77c"))));
        assert!(same_call(&gql, "POST", &at("https://search.video.example/v1"), Some(&body("SEARCH_STORIES", "z1z1z1z1"))), "a key seen once may change");
        assert!(!same_call(&gql, "POST", &at("https://search.video.example/v1"), Some(&body("SEARCH_VIDEOS", "k9f3a77c"))), "another operation is another call");
    }

    /// A settings file names every word somewhere deep inside it, and on/off switches named for them: it holds none of
    /// the goal's fields. The list of priced records does.
    #[test]
    fn a_config_that_names_every_word_deep_inside_never_wins() {
        let goal = "get the live price of a coin on this exchange's price page";
        let config = serde_json::json!({"integrations": {"Tracker": {"livePriceEnabled": true, "coinPage": false, "exchangeView": true,
            "settings": {"priceExperiment": "variant-b", "pageType": "coin"}}}, "plan": {"track": {"__default": {"enabled": true}}}});
        let assets: Vec<serde_json::Value> = ["Bitcoin", "Ether", "Solana", "Dogecoin"].iter().enumerate()
            .map(|(i, n)| serde_json::json!({"name": n, "symbol": format!("C{i}"), "price": format!("{}.50", 100 * (i + 1))})).collect();
        let got = picked("https://ex.example/prices/bitcoin", goal, vec![
            walked("GET", "https://ex.example/prices/bitcoin", "<html><body>Bitcoin</body></html>", true),
            walked("GET", "https://cdn.tags.example/v1/projects/abc/settings", &serde_json::json!(config).to_string().clone(), false),
            walked("GET", "https://api.ex.example/markets/all/assets", &serde_json::json!({"result": {"data": assets}}).to_string(), false),
        ]);
        assert_eq!(got.as_deref(), Ok("GET /markets/all/assets"));
    }

    /// A page's words for prices ("{price} for orders over {threshold}", `"price_label": "Price"`) are labels: a
    /// phrasebook answers no goal that asks for prices.
    #[test]
    fn a_label_for_a_price_is_not_a_price() {
        let phrases = serde_json::json!({"from_price": "Starting at {price}", "price_label": "Price", "free_over": "Free for orders over $35 with a card",
            "price_per_item": "/piece", "delivery_price": "From {price}"});
        let got = picked("https://shop.example/search/?q=desk", "search shop products with price", vec![
            walked("GET", "https://shop.example/search/?q=desk", "<html><body>Search</body></html>", true),
            walked("GET", "https://shop.example/data/phrase/en-US.json", &phrases.to_string(), false),
        ]);
        assert!(got.is_err(), "{got:?}");
    }

    /// A goal for one thing, on a page that names it, is answered by the call for that thing, not by a call for a
    /// part of it, however much the part says the name back.
    #[test]
    fn the_item_itself_beats_a_part_of_it() {
        let downloads: Vec<serde_json::Value> = (0..5).map(|i| serde_json::json!({"crate": "serde", "version": i, "downloads": 10 * i})).collect();
        let got = picked("https://crates.example/crates/serde", "get a crate's details", vec![
            walked("GET", "https://crates.example/api/v1/crates/serde/downloads", &serde_json::json!({"version_downloads": downloads}).to_string(), false),
            walked("GET", "https://crates.example/api/v1/crates/serde", &serde_json::json!({"crate": {"name": "serde", "description": "A serialization framework", "downloads": 9}, "versions": [{"num": "1"}, {"num": "2"}, {"num": "3"}]}).to_string(), false),
        ]);
        assert_eq!(got.as_deref(), Ok("GET /api/v1/crates/serde"));
    }

    /// A list of other things that each mention the coin (bots trading it) loses to the call that asks for the coin's
    /// price by itself, and to an answer that names the coin as its own (asked for by another name).
    #[test]
    fn a_list_that_mentions_the_item_loses_to_the_call_for_it() {
        let goal = "get the live price of a coin on this exchange's price page";
        let bots: Vec<serde_json::Value> = (0..15).map(|i| serde_json::json!({"symbol": "btcusdt", "minPrice": format!("{}", 60000 + i), "maxPrice": "90000"})).collect();
        let bots = walked("GET", "https://ex.example/v1/robots/recommended?symbol=btcusdt", &serde_json::json!({"data": bots}).to_string(), false);
        let got = picked("https://ex.example/price/btc/", goal, vec![
            bots.clone(),
            walked("GET", "https://ex.example/v1/market/queryPriceInfo?currency=btc", &serde_json::json!({"code": 200, "data": {"price": "78025.9", "change": "0.4", "high": "79100.2", "low": "77002.5"}}).to_string(), false),
        ]);
        assert_eq!(got.as_deref(), Ok("GET /v1/market/queryPriceInfo"));
        let got = picked("https://ex.example/prices/bitcoin", goal, vec![
            bots,
            walked("GET", "https://ex.example/api/details/BTCUSD/1m", &serde_json::json!({"symbol": "BTCUSD", "toDisplayName": "Bitcoin", "lastPrice": "78025.9"}).to_string(), false),
        ]);
        assert_eq!(got.as_deref(), Ok("GET /api/details/BTCUSD/1m"));
    }

    /// Whoever picks, a call is kept only when its answer names what the page is about and holds the goal's priced
    /// field: a settings file with a price-named number, and a list of other coins, answer nothing about bitcoin.
    #[test]
    fn a_kept_call_names_what_the_page_is_about() {
        let goal = "read live BTC price on this exchange's price page";
        let settings = walked("GET", "https://cdn.tags.example/v1/projects/abc/settings", &serde_json::json!({"plan": {"priceTier": 3, "pageSize": 20, "region": "eu", "flags": ["a", "b"]}}).to_string(), false);
        let others: Vec<serde_json::Value> = ["Solana", "Cardano", "Tron", "Litecoin", "Polkadot"].iter().map(|n| serde_json::json!({"name": n, "price": "1.5"})).collect();
        let others = walked("GET", "https://api.ex.example/v1/trending", &serde_json::json!({"data": others}).to_string(), false);
        assert!(fails_goal(&settings, goal, "https://ex.example/prices/bitcoin", &[], "", &no_walk()).is_some());
        assert!(fails_goal(&others, goal, "https://ex.example/prices/bitcoin", &[], "", &no_walk()).is_some());
        let btc = walked("GET", "https://api.ex.example/v1/ticker?pair=BTCUSD", &serde_json::json!({"pair": "BTCUSD", "name": "Bitcoin", "last_price": "77950.1"}).to_string(), false);
        assert_eq!(fails_goal(&btc, goal, "https://ex.example/prices/bitcoin", &[], "", &no_walk()), None);
        assert!(picked("https://ex.example/prices/bitcoin", goal, vec![settings, others]).is_err(), "nothing passes: the page needs browsing");
    }

    /// A goal for a list that spells names in capitals is answered by a list that names every one of them, and a
    /// handful of settings with a price-named key is no list.
    #[test]
    fn a_list_answers_every_name_the_goal_spells() {
        let goal = "read live crypto prices for BTC ETH DOGE";
        let rows = |names: &[&str]| -> String {
            serde_json::json!({"data": names.iter().map(|n| serde_json::json!({"symbol": n, "price": "2.5"})).collect::<Vec<_>>()}).to_string()
        };
        let partial = walked("GET", "https://ex.example/api/etf", &rows(&["BTC", "ETH", "IBIT", "FBTC", "ARKB"]), false);
        let all = walked("GET", "https://ex.example/api/markets", &rows(&["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"]), false);
        assert!(fails_goal(&partial, goal, "https://ex.example/prices", &[], "", &no_walk()).is_some());
        assert_eq!(fails_goal(&all, goal, "https://ex.example/prices", &[], "", &no_walk()), None);
        let config = walked("GET", "https://ex.example/api/config", &rows(&["A", "B", "C"]), false);
        assert!(fails_goal(&config, "list crypto prices with name and price", "https://ex.example/prices", &[], "", &no_walk()).is_some());
    }

    /// A page read by browsing, with what the node's browser logged of it: the document and the calls after it.
    fn read_by_browsing(document: &str, calls: &[(&str, &str)]) -> unbrowse_learn::session::Session {
        let entry = |t: f64, kind: &str, url: &str, mime: &str, body: &str| {
            serde_json::json!({ "type": "exchange", "t": t, "resourceType": kind, "entry": { "_resourceType": kind,
                "request": { "method": "GET", "url": url, "headers": [] },
                "response": { "status": 200, "headers": [], "content": { "mimeType": mime, "text": body } } } })
        };
        let page = "https://bank.example/bank/overview.htm";
        let mut lines = vec![
            serde_json::json!({ "type": "action", "t": 1.0, "action": "navigate", "value": page }),
            entry(1.5, "Document", page, "text/html", document),
        ];
        lines.extend(calls.iter().enumerate().map(|(n, (url, body))| entry(2.0 + n as f64, "XHR", url, "application/json", body)));
        unbrowse_learn::session::Session::from_log(&lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap()
    }

    /// The walk that exposed it: an accounts page serves an empty table, and its script fills it from a call the script
    /// spells. Read by browsing with no goal stated, the document outscored the call, so the route read an empty table
    /// for ever after and answered ok. The call the page asks for is what the page shows.
    #[test]
    fn a_page_its_script_fills_is_learned_from_the_call() {
        let document = r#"<html><head><title>Accounts Overview</title></head><body><h1>Accounts Overview</h1>
            <table id="accounts"><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody></tbody></table>
            <a href="about.htm">About</a><a href="contact.htm">Contact</a><a href="services.htm">Services</a><a href="news.htm">News</a><a href="admin.htm">Admin</a>
            <p>Balance includes deposits that may be subject to holds. Please review the terms of your account for more details about when funds become available.</p>
            <script>$.get("services_proxy/bank/customers/" + 29528 + "/accounts", draw);</script></body></html>"#;
        let accounts = r#"[{"id":103254,"customerId":29528,"type":"CHECKING","balance":515.5},{"id":103255,"customerId":29528,"type":"SAVINGS","balance":100.0}]"#;
        let session = read_by_browsing(document, &[("https://bank.example/bank/services_proxy/bank/customers/29528/accounts", accounts)]);
        let Ok(Outcome::Route { route, .. }) = learn_from_session(&session, "bank.example", None, 0.0, 0.0, 100.0, "w", &no_eye, None) else { panic!("a route") };
        assert!(route.path.ends_with("/customers/29528/accounts"), "{}", route.path);
        let Ok(Outcome::Route { route, .. }) = learn_from_session(&session, "bank.example", Some("read the account balances"), 0.0, 0.0, 100.0, "w", &no_eye, None) else { panic!("a route") };
        assert!(route.path.ends_with("/customers/29528/accounts"), "with a goal too: {}", route.path);
    }

    /// Being spelled by the page's script doesn't make a call the answer: it must still hold what the goal asks. A page
    /// that fetches its menu that way, and a goal for prices the menu doesn't hold, doesn't get the menu.
    #[test]
    fn a_call_the_script_spells_is_still_held_to_the_goal() {
        let rows: String = (0..30).map(|n| format!("<tr><td>Lamp {n}</td><td>${n}.00</td></tr>")).collect();
        let document = format!(r#"<html><head><title>Lamps</title></head><body><h1>Lamps</h1><table>{rows}</table>
            <a href="a.htm">A</a><a href="b.htm">B</a><a href="c.htm">C</a><a href="d.htm">D</a><a href="e.htm">E</a>
            <script>$.get("services_proxy/menu/items/" + 29528 + "/links", draw);</script></body></html>"#);
        let menu = r#"[{"label":"Home","href":"/"},{"label":"About","href":"/about"},{"label":"Contact","href":"/contact"}]"#;
        let session = read_by_browsing(&document, &[("https://bank.example/bank/services_proxy/menu/items/29528/links", menu)]);
        let out = learn_from_session(&session, "bank.example", Some("read the lamp prices"), 0.0, 0.0, 100.0, "w", &no_eye, None);
        if let Ok(Outcome::Route { route, .. }) = out {
            assert!(!route.path.contains("menu"), "{}", route.path);
        }
    }

    /// A page that reads another host's search through a script tag: the browser logs a script, and the page is a shell
    /// that answers every value the same. The call sends what was asked, names the page it fired on, and comes back
    /// inside the name its own address gave it, so it is the page's data.
    #[test]
    fn a_page_reading_its_results_through_a_script_tag_is_learned_from_that_call() {
        let page = "https://docs.example/search/?q=pod";
        let links: String = (0..8).map(|n| format!(r#"<a href="/docs/{n}">Docs {n}</a>"#)).collect();
        let shell = format!("<html><head><title>Search results for pod</title></head><body><h1>Search results</h1>{links}<p>{}</p></body></html>", "Read the docs and find what you need here. ".repeat(40));
        let found = r#"{"cursor":{"resultCount":"20"},"results":[{"title":"Pods","url":"https://docs.example/pods/"},{"title":"Pod lifecycle","url":"https://docs.example/pods/life/"},{"title":"Pod overview","url":"https://docs.example/pods/all/"}]}"#;
        let mut search = walked("GET", "https://find.vendor.example/element/v1?num=10&q=pod&tok=AbC123%3A1793&callback=find.api123&rurl=https%3A%2F%2Fdocs.example%2Fsearch%2F%3Fq%3Dpod", &format!("/*O_o*/\nfind.api123({found});"), false);
        search.resource_type = Some("Script".into());
        search.response_mime = "application/javascript".into();
        let mut code = walked("GET", "https://docs.example/js/main.js?v=9", "(function(){var q='pod';find.go(q,{results:[1,2,3]});})();", false);
        code.resource_type = Some("Script".into());
        code.response_mime = "application/javascript".into();
        let got = picked_full(page, "search docs", vec![walked("GET", page, &shell, true), code, search]).unwrap();
        assert_eq!(got, "GET /element/v1");
    }

    /// A page that shows its data in what it serves stays the page: a call beside it that its script never spells isn't
    /// what fills it.
    #[test]
    fn a_page_holding_its_own_data_stays_the_page() {
        let rows: String = (0..30).map(|n| format!("<tr><td>Lamp number {n}</td><td>${n}.00</td></tr>")).collect();
        let document = format!(r#"<html><head><title>Lamps</title></head><body><h1>Lamps</h1><table>{rows}</table>
            <a href="a.htm">A</a><a href="b.htm">B</a><a href="c.htm">C</a><a href="d.htm">D</a><a href="e.htm">E</a></body></html>"#);
        let session = read_by_browsing(&document, &[("https://bank.example/bank/api/flags", r#"[{"id":1,"on":true},{"id":2,"on":false}]"#)]);
        let Ok(Outcome::Route { route, .. }) = learn_from_session(&session, "bank.example", None, 0.0, 0.0, 100.0, "w", &no_eye, None) else { panic!("a route") };
        assert!(route.path.contains("overview.htm") || route.path.contains("{path"), "{}", route.path);
    }

    /// With no goal stated, nothing was asked for, so no piece of a page's own address is a caller's value: a file name
    /// read as "the thing the page is about" came out as an input named for the word before it.
    #[test]
    fn with_no_goal_a_pages_address_holds_no_input() {
        let trace = Trace { exchanges: vec![walked("GET", "https://bank.example/bank/overview.htm", "<html><body>Overview</body></html>", true)], inputs: Vec::new() };
        assert_eq!(path_inputs("https://bank.example/bank/overview.htm", "", &trace).0, Vec::<(String, String)>::new());
    }

    /// A site's API that takes its arguments as JSON in one query value, beside a form POST that only says which page it
    /// fired on. The search asks by a string inside that JSON, and that is the call that answers. The POST carries the
    /// page's address under form encoding, which hides it from a plain look at the body, and sends nothing of its own.
    #[test]
    fn a_search_asking_inside_the_json_it_sends_beats_a_call_that_names_the_page() {
        let page = "https://pins.example/search/pins/?q=kitchen";
        let links: String = (0..8).map(|n| format!(r#"<a href="/p/{n}">Pin {n}</a>"#)).collect();
        let shell = format!("<html><head><title>Pins</title></head><body>{links}<p>{}</p></body></html>", "Find ideas for every room in your home. ".repeat(40));
        let data = url::form_urlencoded::byte_serialize(br#"{"options":{"query":"kitchen","scope":"pins"}}"#).collect::<String>();
        let at = url::form_urlencoded::byte_serialize(b"/search/pins/?q=kitchen").collect::<String>();
        let search = walked("GET", &format!("https://pins.example/resource/Search/get/?source_url={at}&data={data}"), r#"{"results":[{"title":"Oak kitchen"},{"title":"White kitchen"},{"title":"Small kitchen"}]}"#, false);
        let mut report = walked("POST", "https://pins.example/resource/Print/create/", r#"{"status":"ok","context":{"search":"on","pins":"on","kitchen":"on"}}"#, false);
        report.request_body = Some(format!("source_url={at}&data=%7B%22fingerprint%22%3A%22ea757d13%22%7D"));
        report.request_headers = vec![("content-type".into(), "application/x-www-form-urlencoded".into())];
        // A suggestion box asks by the word as a plain value, which set the search, asking only inside its JSON, aside.
        let suggest = walked("GET", "https://pins.example/resource/Suggest/get/?term=kitchen", r#"{"items":[{"term":"kitchen ideas with a long tail of words"},{"term":"kitchen sink"}]}"#, false);
        let got = picked_full(page, "search pins", vec![walked("GET", page, &shell, true), suggest, search, report]).unwrap();
        assert_eq!(got, "GET /resource/Search/get/");
    }

    /// A path is read by its words: `read` names nothing in `unread-message-count`.
    #[test]
    fn a_path_is_read_by_its_words() {
        assert_eq!(path_words("/priapi/v1/assistant/session/unread-message-count"), ["priapi", "v1", "assistant", "session", "unread", "message", "count"]);
        assert!(!path_words("/v1/unread-message-count").iter().any(|w| w.starts_with("read")));
        assert!(names_it("{\"symbol\": \"btcusdt\"}", "btc") && !names_it("the method", "eth"));
    }

    /// Like `picked`, but with the document fallback `pick_and_keep` applies when no call answers.
    fn picked_full(url: &str, goal: &str, exchanges: Vec<Exchange>) -> Result<String, String> {
        by_loading(goal)?;
        let trace = Trace { exchanges, inputs: Vec::new() };
        let site = site_of(url::Url::parse(url).unwrap().host_str().unwrap());
        let view = view_of("t", url, &site, &trace, 0);
        let (in_path, _) = path_inputs(url, goal, &trace);
        let values: Vec<String> = walk_inputs(url, &in_path, &[]).into_iter().map(|i| i.value).collect();
        let scores = rule_scores(&trace, &view, goal, &values, &[]);
        let i = match rule_pick(&trace, &view, goal, &values, scores) {
            Ok((i, _)) => i,
            Err(e) => document_answer(&trace, &site).ok_or(e)?,
        };
        Ok(format!("{} {}", trace.exchanges[i].method, trace.exchanges[i].url.path()))
    }

    /// A server-rendered page is its own answer: no call carries the goal words, but the page the agent opened
    /// serves the content, so its GET is kept as the route. A bare login page, with little content, is not — it
    /// needs interaction (the Hacker News front page vs a login form) (#1 of the QA report).
    #[test]
    fn a_server_rendered_page_is_its_own_route() {
        // The HN front page: one GET, many story links, no API call. No word of "top stories" in it.
        let stories: String = (0..30).map(|i| format!("<tr><td><a href='https://news.ycombinator.com/item?id={i}'>A deep dive into widget number {i}</a></td></tr>")).collect();
        let hn = walked("GET", "https://news.ycombinator.com/", &format!("<html><body><table>{stories}</table></body></html>"), true);
        assert_eq!(picked_full("https://news.ycombinator.com/", "top stories", vec![hn]).as_deref(), Ok("GET /"));

        // A login form: a GET with a couple of links and a password field, little content. It needs typing, so it
        // stays browse, not a route.
        let login = walked("GET", "https://the-internet.herokuapp.com/login", r#"<html><body><h2>Login Page</h2><form><input type="text"/><input type="password"/><button>Login</button></form><a href="/">home</a></body></html>"#, true);
        assert!(picked_full("https://the-internet.herokuapp.com/login", "sign in", vec![login]).is_err(), "a bare login form is not a document route");
    }

    #[test]
    fn a_page_route_answers_the_opening_document_when_the_walk_reads_on() {
        let page = |at: &str, kind: &str| {
            let links: String = (0..30).map(|i| format!("<li><a href='/posts/{kind}-{i}'>An article about {kind} {i}</a></li>")).collect();
            walked("GET", at, &format!("<html><body><ol>{links}</ol></body></html>"), true)
        };
        let first = page("https://news.example/", "new");
        let later = page("https://news.example/page/5", "old");
        assert_eq!(picked_full("https://news.example/", "top stories", vec![first.clone(), later.clone()]).as_deref(), Ok("GET /"));

        let mut redirect = page("https://news.example/latest", "redirect");
        redirect.status = 302;
        assert_eq!(picked_full("https://news.example/latest", "top stories", vec![redirect, first, later]).as_deref(), Ok("GET /"));
    }

    /// A demo bank's accounts overview as it is served: the table's head and foot, its rows left to a script.
    const OVERVIEW: &str = r#"



<!-- <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
 -->
<!DOCTYPE html>
<html>
	<head>
		<meta charset="UTF-8">
		<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
		<title>ParaBank | Accounts Overview</title>
		<link href="template.css" rel="stylesheet"
			type="text/css" />
		<link href="style.css" rel="stylesheet"
			type="text/css" />
		<script src="webjars/jquery/4.0.0/jquery.min.js"></script>
	</head>

	<body
		>
		<div id="mainPanel">
			
				
				
					



<div id="topPanel">
  <a href="admin.htm"><img src="images/clear.gif" width="56" height="42" border="0" class="admin"/></a>
  <a href="index.htm"><img src="images/logo.gif" alt="ParaBank" width="136" height="31" border="0" class="logo" title="ParaBank"/></a>
  <p class="caption">Experience the difference</p>
</div>
<div id="headerPanel" style="background: url(images/header-customer.jpg) 0 0 no-repeat;">
  


<ul class="leftmenu">
  <li class="Solutions">Solutions</li>
  <li><a href="about.htm">About Us</a></li>
  <li><a href="services.htm">Services</a></li>
  <li><a href="http://www.parasoft.com/jsp/products.jsp">Products</a></li>
  <li><a href="http://www.parasoft.com/jsp/pr/contacts.jsp">Locations</a></li>
  <li><a href="admin.htm">Admin Page</a></li>
  
</ul>
  


<ul class="button">
  <li class="home"><a href="index.htm">home</a></li>
  <li class="aboutus"><a href="about.htm">about</a></li>
  <li class="contact"><a href="contact.htm">contact</a></li>
</ul>
</div>
				
			
			<div id="bodyPanel">
				<div id="leftPanel">
					
						
						
							


<p class="smallText"><b>Welcome</b> Ada Customer</p>

<h2>Account Services</h2>



<ul>
  <li><a href="openaccount.htm">Open New Account</a></li>
  <li><a href="overview.htm">Accounts Overview</a></li>
  <li><a href="transfer.htm">Transfer Funds</a></li>
  <li><a href="billpay.htm">Bill Pay</a></li>
  <li><a href="findtrans.htm">Find Transactions</a></li>
  <li><a href="updateprofile.htm">Update Contact Info</a></li>
  <li><a href="requestloan.htm">Request Loan</a></li>
  <li><a href="logout.htm">Log Out</a></li>
</ul>
						
					
				</div>
				<div id="rightPanel">
					


<div id="overviewAccountsApp">
	<div id="showOverview">
		<h1 class="title">
			Accounts Overview
		</h1>
		<table id="accountTable" class="gradient-style">
			<thead>
				<tr>
					<th>Account</th>
					<th>Balance*</th>
					<th>Available Amount</th>
				</tr>
			</thead>
			<tbody></tbody>
			<tfoot>
				<tr>
					<td colspan="3">*Balance includes deposits that may be subject to holds</td>
				</tr>
			</tfoot>
		</table>
	</div>

	<div id="showError" style="display: none">
		<h1 class="title">
			Error!
		</h1>
		<p class="error">
			An internal error has occurred and has been logged.
		</p>
	</div>
</div>

<script>
$(document).ready(function() {
      
      function formatCurrency(amount) {
      	if (amount == null) {
      		return "$0.00";
      	}
          amount = parseFloat(amount);
          var isNegative = amount < 0;
          amount = Math.abs(amount);
          var formattedAmount = amount.toFixed(2);
          formattedAmount = (isNegative ? '-$' : '$') + formattedAmount;
          return formattedAmount;
      }
    
    var $overviewTable = $('#accountTable tbody');
    var $showOverview = $('#showOverview');
    var $showError = $('#showError');

    $.ajax({
        url: "services_proxy/bank/customers/" + 29528 + "/accounts",
        type: "GET",
        timeout: 30000,
        success: function(response) {
            var accounts = response;
            var totalBalance = 0;
            
            $.each(accounts, function(index, account) {
                var availableBalance = account.balance < 0 ? 0 : account.balance;
                totalBalance += parseFloat(account.balance);
                
                var row = '<tr>' +
                            '<td><a href="activity.htm?id=' + account.id + '">' + account.id + '</a></td>' +
                            '<td>' + formatCurrency(account.balance) + '</td>' +
                            '<td>' + formatCurrency(availableBalance) + '</td>' +
                          '</tr>';
                          
                $overviewTable.append(row);
            });
            
            var totalRow = '<tr>' +
                              '<td align="right"><b>Total</b></td>' +
                              '<td><b>' + formatCurrency(totalBalance) + '</b></td>' +
                              '<td>&nbsp;</td>' +
                            '</tr>';
                            
            $overviewTable.append(totalRow);
            
            $showOverview.show();
        },
        error: function(xhr, status, error) {
            $showOverview.hide();
            $showError.show();
            console.error("Server returned " + status + ": " + error);
        }
    });
});
</script>

				</div>
			</div>
		</div>
		


<div id="footermainPanel">
  <div id="footerPanel">
    <ul>
      <li><a href="index.htm">Home</a>| </li>
      <li><a href="about.htm">About Us</a>| </li>
      <li><a href="services.htm">Services</a>| </li>
      <li><a href="http://www.parasoft.com/jsp/products.jsp">Products</a>| </li>
      <li><a href="http://www.parasoft.com/jsp/pr/contacts.jsp">Locations</a>| </li>
      <li><a href="sitemap.htm">Site Map</a>| </li>
      <li><a href="contact.htm">Contact Us</a></li>
    </ul>
    <p class="copyright">&copy; Parasoft. All rights reserved.</p>
    <ul class="visit">
      <li>Visit us at:</li>
      <li><a href="http://www.parasoft.com/" target="_blank">www.parasoft.com</a></li>
    </ul>
  </div>
</div>
	</body>
</html>
"#;

    /// A signed-in page that fills its table from the site's own call answers a goal for that table with the call.
    /// The walk that exposed it: a demo bank's accounts overview, whose rows come from
    /// `/services_proxy/bank/customers/{id}/accounts` (id, type, balance), answered "needs clicks or typing".
    #[test]
    fn a_table_filled_by_the_sites_own_call_is_answered_by_it() {
        let doc = walked("GET", "https://bank.example/parabank/overview.htm", OVERVIEW, true);
        let accounts = walked("GET", "https://bank.example/parabank/services_proxy/bank/customers/29528/accounts", r#"[{"id":36210,"customerId":29528,"type":"CHECKING","balance":400.50},{"id":36321,"customerId":29528,"type":"SAVINGS","balance":115.00}]"#, false);
        let got = picked_full("https://bank.example/parabank/overview.htm", "list my account balances", vec![doc, accounts]);
        assert_eq!(got.as_deref(), Ok("GET /parabank/services_proxy/bank/customers/29528/accounts"), "{got:?}");
    }

    /// The same page walked signed out: its accounts call fails, so the page shows its hidden error and an empty table.
    /// No route is kept from it, and the page is handed to hands. A page whose failing call went to another site (an ad,
    /// a tracker) is still its own answer.
    #[test]
    fn a_page_whose_own_data_call_failed_is_no_answer() {
        let doc = walked("GET", "https://bank.example/parabank/overview.htm", OVERVIEW, true);
        let mut failed = walked("GET", "https://bank.example/parabank/services_proxy/bank/customers/NaN", r#"{"error":"Could not find customer"}"#, false);
        failed.status = 400;
        assert!(picked_full("https://bank.example/parabank/overview.htm", "list my account balances", vec![doc.clone(), failed.clone()]).is_err());
        let stories: String = (0..30).map(|i| format!("<tr><td><a href='https://news.example/item?id={i}'>A deep dive into widget number {i}</a></td></tr>")).collect();
        let news = walked("GET", "https://news.example/", &format!("<html><body><table>{stories}</table></body></html>"), true);
        let mut ad = walked("GET", "https://ads.vendor.example/bid", r#"{"error":"no fill"}"#, false);
        ad.status = 404;
        assert_eq!(picked_full("https://news.example/", "top stories", vec![news.clone(), ad]).as_deref(), Ok("GET /"));
        let mut own = walked("GET", "https://news.example/api/flags", r#"{"error":"down"}"#, false);
        own.status = 503;
        assert!(picked_full("https://news.example/", "top stories", vec![news, own]).is_err(), "its own data call failed");
    }

    /// A goal that asks for a change is never answered by loading the page: its form page, however much it shows, is
    /// a read of the form. The walk that exposed it: a demo bank's sign-up page (a form, a menu, a footer of links),
    /// kept as the route for "register a new customer account", so every later register only read the empty form.
    #[test]
    fn a_change_is_never_answered_by_loading_its_page() {
        let links: String = (0..20).map(|i| format!("<li><a href='/bank/page{i}.htm'>Services and products page {i}</a></li>")).collect();
        let form = format!("<html><head><title>Bank | Register for Free Online Account Access</title></head><body><h1>Signing up is easy!</h1><p>If you have an account with us you can sign-up for free instant online access. You will have to provide some personal information.</p><form><label>First Name:</label><input name='customer.firstName'/><label>Last Name:</label><input name='customer.lastName'/><label>Username:</label><input name='customer.username'/><label>Password:</label><input type='password' name='customer.password'/><button>Register</button></form><ul>{links}</ul></body></html>");
        let page = walked("GET", "https://bank.example/bank/register.htm", &form, true);
        assert!(picked_full("https://bank.example/bank/register.htm", "register a new customer account", vec![page.clone()]).is_err());
        assert!(picked_full(
            "https://bank.example/bank/register.htm",
            "On the demo bank, register a fresh account, then read Accounts Overview.",
            vec![page.clone()],
        ).is_err());
        // The same page answers a goal that reads it.
        assert!(picked_full("https://bank.example/bank/register.htm", "read the bank's services page", vec![page]).is_ok());
    }

    fn card(name: &str, price: &str) -> serde_json::Value {
        serde_json::json!({"productCard": {"infoFields": [{"text": name}, {"text": format!("From {price}")}]}})
    }

    /// A search page and a promoted widget beside it both answer with priced things, and the widget's call even
    /// says "search" and is the walk's favourite by the old score. Only the page's records say back what was searched
    /// for, so only the page answers the goal (the walk of a marketplace's search, where the widget won).
    #[test]
    fn the_call_whose_records_say_back_the_search_wins() {
        let url = "https://www.market.example/search/iphone%2015";
        let goal = "search listings for a product, return listing title and price";
        let widget = serde_json::json!({"results": (0..12).map(|i| card(&format!("Phone {i}"), "S$828")).collect::<Vec<_>>()});
        let mut widget = walked("POST", "https://www.market.example/api/certified-search/", &widget.to_string(), false);
        widget.request_body = Some(r#"{"query":"iphone 15"}"#.into());
        let state = serde_json::json!({"Search": {"results": (0..40).map(|i| card(&format!("iPhone 15 {i}GB"), "S$650")).collect::<Vec<_>>()}});
        let page = walked("GET", "https://www.market.example/search/iphone%2015/", &format!(r#"<html><body><script id="state" type="application/json">{state}</script></body></html>"#), true);
        assert_eq!(picked(url, goal, vec![page, widget]).as_deref(), Ok("GET /search/iphone%2015/"));
    }

    /// The same widget with the page's own search out of the walk: it sends the search and answers priced records, and
    /// says not one word of what was searched. It answers every search the same, so it is no route for this one.
    #[test]
    fn a_list_that_says_no_word_of_the_search_is_not_its_answer() {
        let url = "https://www.market.example/search/iphone%2015";
        let goal = "search listings for a product, return listing title and price";
        let widget = serde_json::json!({"results": (0..12).map(|i| card(&format!("Phone {i}"), "S$828")).collect::<Vec<_>>()});
        let mut widget = walked("POST", "https://www.market.example/api/certified-search/", &widget.to_string(), false);
        widget.request_body = Some(r#"{"query":"iphone 15"}"#.into());
        let page = walked("GET", "https://www.market.example/search/iphone%2015/", "<html><body><div id=app></div></body></html>", true);
        assert!(picked(url, goal, vec![page, widget.clone()]).is_err());
        assert!(never_says_a_word(&widget, &["iphone 15".to_string()]));
        assert!(!never_says_a_word(&widget, &["phone".to_string()]));
        assert!(!never_says_a_word(&widget, &["2026-12-10".to_string()]), "a date has no word to say");
    }

    /// A page's address asks for a locale and a tab as well as the search. A site's header call sends the locale, and its
    /// menus hold the word that was searched. Only the call that sends what the others don't, and says it back, is the
    /// search, however few records it finds.
    #[test]
    fn the_call_that_sends_what_only_this_page_asks_answers_it() {
        let url = "https://www.shop.example/global/search/phone?tab=product";
        let goal = "search shop products";
        let header = serde_json::json!({"menu": (0..10).map(|i| serde_json::json!({"title": format!("All product phone lines {i}"), "href": format!("/global/c/{i}")})).collect::<Vec<_>>()});
        let results = serde_json::json!({"data": {"keyword": "phone", "total": 1, "items": [{"sku": 1, "name": "A handset", "products": "x"}]}});
        let got = picked(url, goal, vec![
            walked("GET", url, "<html><body>global product<a href=/a>a</a></body></html>", true),
            walked("GET", "https://go.shop.example/global/cms/page/header-footer", &header.to_string(), false),
            walked("GET", "https://go.shop.example/global/search/result?word=phone&page=0", &results.to_string(), false),
        ]);
        assert_eq!(got.as_deref(), Ok("GET /global/search/result"));
    }

    /// Suggestions for the search box say the search back but carry no prices, so a goal asking for prices is never
    /// answered by them; the results page, which shows a price per item, is (the walk of a resale catalog).
    #[test]
    fn an_answer_without_the_goals_prices_is_never_kept_for_it() {
        let url = "https://www.resale.example/catalog?search_text=nike";
        let goal = "search items, return item title and price";
        let suggestions = serde_json::json!({"results": [{"title": "nike women"}, {"title": "nike men"}, {"title": "nike kids"}, {"title": "nike shoes"}]});
        let suggest = || walked("GET", "https://api.resale.example/search-bar/suggestions?search_text=nike", &suggestions.to_string(), false);
        let items: String = (0..20).map(|i| format!("<div><a href=\"/items/{i}\">Nike tee {i}</a><span>${i}.00</span></div>")).collect();
        let page = walked("GET", url, &format!("<html><body>{items}</body></html>"), true);
        assert_eq!(picked(url, goal, vec![page, suggest()]).as_deref(), Ok("GET /catalog"));
        assert!(picked(url, goal, vec![suggest()]).is_err(), "suggestions alone answer nothing that asks for prices");
    }

    /// A page is judged by the answer its route gives (`page::answer`): its JSON state when that holds what the page
    /// shows, else what it renders. A page whose state is a scrap of config (the walk of a big store's results page,
    /// kept and then answering with 369 bytes of handler settings) answers with the products it renders, and a state
    /// that holds the page answers with itself, prices or none.
    #[test]
    fn a_page_is_judged_by_the_answer_its_route_gives() {
        let url = "https://www.store.example/s?k=usb+c+cable";
        let goal = "search products, return product title and price";
        let items: String = (0..20).map(|i| format!("<div><a href=\"/dp/{i}\">USB C Cable {i}</a><span>S${i}.99</span></div>")).collect();
        let scrap = r#"<script type="application/json">{"handlerParams":{"pageType":"Search","k":"usb c cable"}}</script>"#;
        let page = walked("GET", url, &format!("<html><body>{items}{scrap}</body></html>"), true);
        let answer = unbrowse_learn::page::answer(page.response_body.as_deref().unwrap(), &page.url).0;
        assert!(answer["text"].as_str().is_some_and(|t| t.contains("USB C Cable 7")), "the route answers with what the page renders: {answer}");
        assert_eq!(picked(url, goal, vec![page]).as_deref(), Ok("GET /s"));
        let rendered = walked("GET", url, &format!("<html><body>{items}</body></html>"), true);
        assert_eq!(picked(url, goal, vec![rendered]).as_deref(), Ok("GET /s"));
        // A state that holds the page, without its prices, is the answer: it holds no price.
        let names: Vec<String> = (0..20).map(|i| format!("\"USB C Cable {i}\"")).collect();
        let state = format!(r#"<script type="application/json">{{"results":[{}]}}</script>"#, names.join(","));
        let titled: String = (0..20).map(|i| format!("<div><a href=\"/dp/{i}\">USB C Cable {i}</a></div>")).collect();
        let held = walked("GET", url, &format!("<html><body>{titled}{state}</body></html>"), true);
        assert!(picked(url, goal, vec![held]).is_err());
    }

    /// A page that ships no state and no data call is still the route when it renders what the goal asks for: thirty
    /// stories are thirty links (the walk of a plain-HTML news front page, kept as a route on 27 Oct and lost on 28
    /// Oct). A page that only mentions the goal's words still isn't.
    #[test]
    fn a_plain_html_page_that_renders_the_goal_is_kept() {
        let stories: String = (1..=30).map(|i| format!("<tr><td>{i}.</td><td><a href=\"https://site{i}.example/post\">Story number {i}</a></td></tr>")).collect();
        let front = walked("GET", "https://news.example/", &format!("<html><body><table>{stories}</table></body></html>"), true);
        assert_eq!(picked("https://news.example/", "list front page stories with title and link", vec![front]).as_deref(), Ok("GET /"));
        let signup = walked("GET", "https://shop.example/", "<html><body><p>Sign up for the newsletter: send us your email.</p></body></html>", true);
        assert!(picked("https://shop.example/", "sign up for the newsletter", vec![signup]).is_err());
    }

    #[test]
    fn empty_third_party_event_is_not_a_typed_route() {
        let mut e = Exchange {
            method: "POST".into(),
            url: "https://event.example.net/".parse().unwrap(),
            request_headers: vec![],
            request_body: Some("opaque event containing typed word".into()),
            status: 200,
            response_headers: vec![],
            response_body: Some(String::new()),
            response_mime: "text/plain".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(false),
        };
        assert!(empty_third_party_event(&e, "shop.example"));
        assert!(reports_an_event(&e, "shop.example"));
        assert!(!is_candidate(&e, "shop.example"));
        e.url = "https://api.example.net/collect".parse().unwrap();
        e.response_body = Some(r#"{"accepted":true,"detail":"a response that is long enough to pass the candidate size check"}"#.into());
        assert!(reports_an_event(&e, "shop.example"));
        assert!(!is_candidate(&e, "shop.example"));
        e.url = "https://api.example.net/search".parse().unwrap();
        assert!(!empty_third_party_event(&e, "shop.example"));
    }

    #[test]
    fn auto_learning_keeps_search_instead_of_later_empty_event() {
        let action = |t: f64, kind: &str, value: &str| serde_json::json!({
            "type": "action", "t": t, "action": kind, "selector": "@search",
            "field": "Search", "value": value, "secret": false
        }).to_string();
        let exchange = |t: f64, method: &str, url: &str, post: Option<&str>, mime: &str, body: &str| {
            let mut request = serde_json::json!({"method": method, "url": url, "headers": []});
            if let Some(text) = post {
                request["postData"] = serde_json::json!({"mimeType":"text/plain","text":text});
            }
            serde_json::json!({
                "type":"exchange", "t":t, "resourceType":"XHR",
                "entry":{"request":request, "response":{"status":200,"headers":[],"content":{"mimeType":mime,"text":body}}}
            }).to_string()
        };
        let log = [
            action(1.0, "navigate", "https://www.shop.example/"),
            action(2.0, "fill", "serendipity"),
            exchange(2.5, "GET", "https://www.shop.example/search?q=serendipity", None,
                     "application/json", r#"{"results":[{"title":"serendipity definition"}]}"#),
            exchange(3.0, "POST", "https://event.example.net/", Some("serendipity event data"),
                     "text/plain", ""),
        ].join("\n");
        let session = browsed_session(&log).unwrap();
        let Outcome::Route { route, by, .. } = learn_from_session(&session, "shop.example", Some("search dictionary"), 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("expected route") };
        assert_eq!(by, "what was typed");
        assert_eq!(route.method, "GET");
        assert_eq!(route.site, "www.shop.example");
        assert!(route.inputs.iter().any(|i| i.default.as_deref() == Some("serendipity")));
    }

    /// A page's biggest answer isn't an answer to every goal: the call answers one when it sends what the url asked
    /// for, or its path or keys say the goal's words, never because it is the most data the page loaded.
    #[test]
    fn the_biggest_call_on_the_page_answers_only_a_goal_it_carries() {
        let ex = |url: &str, body: &str, doc: bool| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let answers = |e: &Exchange, goal: &str, asked: &[&str]| {
            answers_goal(e, &candidate(0, e), goal, &asked.iter().map(|v| v.to_string()).collect::<Vec<_>>())
        };
        let search = ex("https://api.shop.example/1/query?term=desk", r#"{"hits":[{"title":"a desk"}]}"#, false);
        assert!(answers(&search, "search the shop", &["desk"]), "it sends what the url asked for");
        let listed = ex("https://shop.example/api/v1/listings", r#"{"items":[]}"#, false);
        assert!(answers(&listed, "list the listings", &[]), "its path says the goal's word");
        let keyed = ex("https://shop.example/api/v1/home", r#"{"stories":[],"next":1}"#, false);
        assert!(answers(&keyed, "top stories", &[]), "its answer's keys say the goal's word");
        // A page that only mentions the goal's words, or holds the most data, needs hands for a goal like this.
        let page = ex("https://shop.example/", "<p>Sign up for the newsletter: send us your email.</p>", true);
        assert!(!answers(&page, "sign up for the newsletter", &[]));
        let config = ex("https://shop.example/api/config", r#"{"theme":"dark","forms":true}"#, false);
        assert!(!answers(&config, "sign up for the newsletter", &[]), "short words in a path or key are no sign");
    }

    /// A value the page was asked for is the same value however a call writes it: `apollo+11`, `apollo%2011` and a
    /// form body's `q=apollo+11` all send "apollo 11", so the call that sends it is the one that answers the page.
    #[test]
    fn a_value_is_sent_however_the_call_encodes_it() {
        let ex = |url: &str, body: Option<&str>, answer: &str, doc: bool| Exchange {
            method: if body.is_some() { "POST" } else { "GET" }.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![("content-type".into(), if doc { "text/html" } else { "application/json" }.into())],
            response_body: Some(answer.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let v = "apollo 11";
        assert!(sends_value(&ex("https://lib.example/search?user_query=apollo+11", None, "{}", false), v));
        assert!(sends_value(&ex("https://lib.example/search?user_query=apollo%2011", None, "{}", false), v));
        assert!(sends_value(&ex("https://lib.example/find/apollo%2011", None, "{}", false), v));
        assert!(sends_value(&ex("https://lib.example/search", Some("q=apollo+11&page=1"), "{}", false), v));
        assert!(sends_value(&ex("https://lib.example/search", Some(r#"{"q":"Apollo 11"}"#), "{}", false), v));
        assert!(!sends_value(&ex("https://lib.example/search?user_query=gemini+7", None, "{}", false), v));
        // The walk: the page, a call whose name is the goal's, and the call that sends what the page was asked.
        let page = "https://lib.example/search?query=apollo+11";
        let hits: String = (0..8).map(|i| format!(r#"{{"title":"Apollo 11 reel {i}","identifier":"apollo-11-{i}","date":"1969-07-2{i}"}}"#)).collect::<Vec<_>>().join(",");
        let trace = Trace {
            exchanges: vec![
                ex(page, None, "<html><body><div id=app></div></body></html>", true),
                ex("https://lib.example/services/search/v1/collections?tab=all", None, &format!(r#"{{"collections":[{}]}}"#, (0..8).map(|i| format!(r#"{{"title":"Collection {i}","identifier":"c{i}","date":"2001-01-0{i}"}}"#)).collect::<Vec<_>>().join(",")), false),
                ex("https://lib.example/services/page_production/?user_query=apollo+11&page_type=collection", None, &format!(r#"{{"response":{{"hits":[{hits}]}}}}"#), false),
            ],
            inputs: Vec::new(),
        };
        let view = view_of("t", page, "lib.example", &trace, 0);
        let goal = "search items by title";
        let asked = vec![v.to_string()];
        let scores = rule_scores(&trace, &view, goal, &asked, &[]);
        assert_eq!(rule_pick(&trace, &view, goal, &asked, scores).map(|(i, _)| i), Ok(2));
    }

    /// A call that answers markup (the page's "more results", a fragment) is a piece of a page, not a data call: it
    /// earns nothing over the page it belongs to, and a page that renders its own results is its own answer.
    #[test]
    fn a_call_answering_markup_earns_nothing_over_its_page() {
        let ex = |method: &str, url: &str, body: Option<&str>, answer: &str, doc: bool| Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
            response_body: Some(answer.into()),
            response_mime: "text/html".into(),
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let rows: String = (0..10).map(|i| format!("<article><a href=\"/{i}/\">CRISPR study {i}</a><p>2026 Jan {i}</p></article>")).collect();
        let page = "https://papers.example/?term=crispr";
        let trace = Trace {
            exchanges: vec![
                ex("GET", page, None, &format!("<!doctype html><html><head><title>crispr - Search</title></head><body>{rows}</body></html>"), true),
                ex("POST", "https://papers.example/more/", Some("term=crispr&page=2&csrfmiddlewaretoken=x"), &rows, false),
            ],
            inputs: Vec::new(),
        };
        let view = view_of("t", page, "papers.example", &trace, 0);
        let asked = vec!["crispr".to_string()];
        let goal = "search papers";
        let scores = rule_scores(&trace, &view, goal, &asked, &[]);
        assert_eq!(rule_pick(&trace, &view, goal, &asked, scores).map(|(i, _)| i), Ok(0));
    }

    /// A page asked for a value is answered by a call that sends it, or one fed by a call that did and saying it back.
    /// Any other (a config, a set of flags, an ad slot) answers the same whatever the page asked, so it is never kept for
    /// it, even when its name is the goal's, it answers with a list, or the word happens to be among its settings. The
    /// page itself is held to what it shows.
    #[test]
    fn a_call_that_never_carries_the_asked_value_never_answers_the_page() {
        let ex = |url: &str, answer: &str, doc: bool| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), if doc { "text/html" } else { "application/json" }.into())],
            response_body: Some(answer.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        };
        let page = "https://news.example/search?q=climate";
        let goal = "search articles";
        let asked = vec!["climate".to_string()];
        let flags: String = (0..8).map(|i| format!(r#"{{"name":"SearchBeta{i}","article":"on","enabled":true}}"#)).collect::<Vec<_>>().join(",");
        let config = ex("https://news.example/api/search-articles/flags", &format!(r#"{{"articles":[{flags}]}}"#), false);
        assert!(fails_goal(&config, goal, page, &asked, "", &no_walk()).is_some_and(|why| why.contains("never sends")));
        // A fixed call whose address holds a word the page's does asks for nothing by it.
        let fixed = ex("https://news.example/api/article/search/v2/categories/511", r#"{"articles":[{"title":"search tips"},{"title":"more"}]}"#, false);
        let two = vec!["climate".to_string(), "search".to_string()];
        assert!(fails_goal(&fixed, goal, page, &two, "", &no_walk()).is_some_and(|why| why.contains("never sends")));
        // A config that happens to hold the word says it back, and still can't send another value.
        let coincidence = ex("https://news.example/experiment/config.json", r#"{"articles":[{"name":"climate-banner"},{"name":"other"}]}"#, false);
        assert!(fails_goal(&coincidence, goal, page, &asked, "", &no_walk()).is_some_and(|why| why.contains("never sends")));
        // The call that asks for it, and one that says it back, fetched by a token the page that was asked handed over.
        let asks = ex("https://news.example/api/search?q=climate", r#"{"articles":[{"title":"x"}]}"#, false);
        let says = ex("https://news.example/api/results/af93c1d2", r#"{"articles":[{"title":"Climate talks"}]}"#, false);
        assert_eq!(fails_goal(&asks, goal, page, &asked, "", &no_walk()), None);
        let handed = Trace { exchanges: vec![ex(page, r#"<html><body data-token="af93c1d2">Results</body></html>"#, true), says.clone()], inputs: Vec::new() };
        assert_eq!(fails_goal(&handed.exchanges[1], goal, page, &asked, "", &handed), None);
        // Nothing asked: the rule says nothing.
        assert_eq!(fails_goal(&config, goal, "https://news.example/search", &[], "", &no_walk()), None);
        // Of a walk holding only the config and the page, the config is never the pick.
        let trace = Trace { exchanges: vec![ex(page, "<html><body>results load here</body></html>", true), config.clone()], inputs: Vec::new() };
        let view = view_of("t", page, "news.example", &trace, 0);
        let scores = rule_scores(&trace, &view, goal, &asked, &[]);
        assert_ne!(rule_pick(&trace, &view, goal, &asked, scores).map(|(i, _)| i), Ok(1));
    }

    /// A call that hands on the page's whole path as one value (`path=/search`: an ad slot saying where it shows) and
    /// answers with the same word reports the page's address: the site's route word stays a route word, never an input
    /// the page was asked for.
    /// A test's decision model is only the one its environment names: the machine's Keychain item is the owner's, and a
    /// Mac runner that held it put a remote model behind the picks four learn tests check (staging, 23 November 2026).
    #[test]
    fn a_test_never_takes_the_decision_model_from_the_machines_keychain() {
        if std::env::var("TYPESAFE_API_KEY").is_ok() {
            return;
        }
        assert!(clef_from_keychain().is_none());
        assert!(clef().is_none(), "no TYPESAFE_API_KEY, so no decision model");
    }

    #[test]
    fn the_page_path_handed_on_whole_is_no_input() {
        if std::env::var("TYPESAFE_API_KEY").is_ok() {
            return;
        }
        let call = |url: &str, answer: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(answer.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let slot = call("https://ads.example/request/page/json/?path=%2Fsearch&site=films-web", r#"{"page":{"path":"/search","type":"search","slots":[{"kind":"search"},{"kind":"top"}]}}"#);
        let trace = Trace { exchanges: vec![slot.clone()], inputs: Vec::new() };
        assert!(path_inputs("https://films.example/search?search=alien", "search titles", &trace).0.is_empty());
    }

    /// A search is answered by its results: a list, or an answer that says back what was searched. A call that
    /// sends the searched word only inside the page's title (an ad request naming where it shows) and answers one
    /// record about the page is never kept for the search; a goal for one thing is not held to this.
    #[test]
    fn a_search_is_never_answered_by_one_record_that_never_says_it_back() {
        let ex = |url: &str, answer: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "application/json".into())],
            response_body: Some(answer.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let page = "https://films.example/search?search=alien";
        let asked = vec!["alien".to_string()];
        let slot = ex(
            "https://ads.example/request/page/json/?path=%2Fsearch&title=alien%20-%20Films&site=films-web",
            r#"{"page":{"id":"7093279","site":"films-web","path":"/search","adid":"/5727/films/search/results","generated":"2026-11-02 05:09:20"}}"#,
        );
        assert!(sends_value(&slot, "alien"), "it carries the word, in the page's title");
        assert!(fails_goal(&slot, "search titles", page, &asked, "", &no_walk()).is_some());
        let results = ex("https://films.example/api/search?q=alien", r#"{"items":[{"name":"Alien","year":"1979"},{"name":"Aliens","year":"1986"}]}"#);
        assert_eq!(fails_goal(&results, "search titles", page, &asked, "", &no_walk()), None);
        let one = ex("https://films.example/api/find?title=alien%20movies", r#"{"item":{"name":"Alien","year":"1979"}}"#);
        assert_eq!(fails_goal(&one, "search titles", page, &asked, "", &no_walk()), None, "one result that says it back");
        let asks = ex("https://films.example/api/search?q=alien", r#"{"item":{"name":"x"}}"#);
        assert_eq!(fails_goal(&asks, "search titles", page, &asked, "", &no_walk()), None, "a call that asks for it by itself");
        assert_eq!(fails_goal(&slot, "get the film's details", "https://films.example/film?id=alien", &asked, "", &no_walk()), None);
    }

    /// Without Clef the walk finds the caller's values in the path: a piece with a space, or one the page hands on to
    /// its own API as a value. The site's own route words stay put, whatever they are.
    #[test]
    fn a_path_piece_the_page_hands_on_is_an_input() {
        if std::env::var("TYPESAFE_API_KEY").is_ok() {
            return;
        }
        let api = |url: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(if url.contains("/exp/") { "{}".into() } else { format!(r#"{{"results":[{}]}}"#, r#"{"title":"an item","price":40}"#.repeat(4).replace("}{", "},{")) }),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let none = Trace { exchanges: Vec::new(), inputs: Vec::new() };
        let (got, _) = path_inputs("https://www.carousell.sg/search/iphone%2015/", "search Carousell listings", &none);
        assert_eq!(got, vec![("search".to_string(), "iphone 15".to_string())]);
        // One word, in any path word a site picks: the page's own call sends it on as a value.
        let walk = Trace { exchanges: vec![api("https://api.shop.example/v2/listings?keyword=ipad&page=1")], inputs: Vec::new() };
        let (got, _) = path_inputs("https://shop.example/buscar/ipad", "find ipads", &walk);
        assert_eq!(got, vec![("buscar".to_string(), "ipad".to_string())]);
        // A route word an experiment call takes as a value, and answers nothing to, is still the site's.
        let walk = Trace {
            exchanges: vec![api("https://api.shop.example/exp/apply?namespace=search"), api("https://api.shop.example/v2/listings?keyword=ipad")],
            inputs: Vec::new(),
        };
        let (got, _) = path_inputs("https://shop.example/search/ipad", "find ipads", &walk);
        assert_eq!(got, vec![("search".to_string(), "ipad".to_string())]);
        // A route word the page's calls use as a path, never as a value, is the site's.
        let walk = Trace { exchanges: vec![api("https://api.shop.example/categories/phones/items")], inputs: Vec::new() };
        let (got, _) = path_inputs("https://example.com/categories/phones", "list phones", &walk);
        assert!(got.is_empty(), "{got:?}");
    }

    /// The walk that exposed it: hours after a search was typed, an ad bid on the results page carried the page's
    /// address, and the search with it. It reports the page; the page itself is what sent the search.
    #[test]
    fn a_call_reporting_the_page_never_sent_what_was_typed() {
        let ex = |t: f64, kind: &str, method: &str, url: &str, post: &str, body: &str| {
            let post = if post.is_empty() { String::new() } else { format!(r#","postData":{{"mimeType":"application/json","text":{}}}"#, serde_json::to_string(post).unwrap()) };
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"{kind}","entry":{{"request":{{"method":"{method}","url":"{url}","headers":[]{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"text/html","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let log = [
            r#"{"type":"action","t":1.0,"action":"navigate","value":"https://www.shop.example/"}"#.to_string(),
            r#"{"type":"action","t":2.0,"action":"fill","selector":"@e1","field":"Search","value":"ddr4 sodimm 32gb","secret":false}"#.to_string(),
            r#"{"type":"action","t":2.2,"action":"press","value":"Enter"}"#.to_string(),
            ex(2.4, "XHR", "POST", "https://bid.ads.example/translator?source=prebid", r#"{"site":{"page":"https://www.shop.example/search/ddr4%20sodimm%2032gb/"},"imp":[{"id":"1"}]}"#, r#"{"seatbid":[]}"#),
            ex(2.5, "Document", "GET", "https://www.shop.example/search/ddr4%20sodimm%2032gb/", "", &format!("<html><body>{}</body></html>", "ddr4 sodimm 32gb listing ".repeat(10))),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        let Outcome::Route { route, by, .. } = learn_from_session(&session, "shop.example", None, 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("a route") };
        assert_eq!(by, "what was typed");
        assert_eq!(route.site, "www.shop.example", "the page sent the search, not the ad bid: {}", route.path);
    }

    /// The walk that exposed it (a video site's search box): typing asks the box's suggestions call with the word as it
    /// lands, and Enter then sends the search, whose body the page compresses (`content-encoding: gzip`). The search's
    /// long answer ends after a suggestion sent later, so it is logged after it. The route is the search: the value was
    /// handed over by Enter, the call made before it answered the box, and the compressed body reads as what it holds.
    #[test]
    fn a_value_handed_over_is_sent_by_the_call_after_the_hand_over() {
        use base64::Engine;
        let word = "folding desk lamp";
        let suggest = |t: f64| {
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"Fetch","entry":{{"_resourceType":"Fetch","request":{{"method":"GET","url":"https://www.video.example/complete/search?client=web&q={}","headers":[]}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"text/javascript","text":{}}}}}}}}}"#,
                word.replace(' ', "%20"),
                serde_json::to_string(&format!(r#"window.ac.h(["{word}",[],{{"j":"2"}}])"#)).unwrap()
            )
        };
        let found = format!(r#"{{"contents":{{"items":[{{"video":{{"id":"a1","title":"{word} review"}}}},{{"video":{{"id":"b2","title":"best {word}"}}}}]}},"estimatedResults":"812"}}"#);
        // As the site sends it: the client context carries the address of the results page the search opens, the word
        // in it, beside the word as the search's own `query`.
        let address = format!("https://www.video.example/results?search_query={}", word.replace(' ', "+"));
        let body = format!(r#"{{"context":{{"client":{{"hl":"en","clientName":"WEB","originalUrl":"{address}"}},"request":{{"graftUrl":"/results?search_query={}"}}}},"query":"{word}"}}"#, word.replace(' ', "+"));
        for compressed in [true, false] {
            let (headers, post) = if compressed {
                let bytes = unbrowse_learn::route::wire::as_sent(Some("gzip"), body.as_bytes());
                (
                    r#"[{"name":"Content-Type","value":"application/json"},{"name":"Content-Encoding","value":"gzip"}]"#,
                    format!(r#"{{"mimeType":"application/json","text":"{}","_encoding":"base64"}}"#, base64::engine::general_purpose::STANDARD.encode(bytes)),
                )
            } else {
                (r#"[{"name":"Content-Type","value":"application/json"}]"#, format!(r#"{{"mimeType":"application/json","text":{}}}"#, serde_json::to_string(&body).unwrap()))
            };
            let search = format!(
                r#"{{"type":"exchange","t":3.0,"resourceType":"Fetch","entry":{{"_resourceType":"Fetch","request":{{"method":"POST","url":"https://www.video.example/api/v1/search?prettyPrint=false","headers":{headers},"postData":{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":{}}}}}}}}}"#,
                serde_json::to_string(&found).unwrap()
            );
            let log = [
                r#"{"type":"action","t":1.0,"action":"navigate","value":"https://www.video.example/results?search_query=lamps"}"#.to_string(),
                format!(r#"{{"type":"action","t":2.0,"action":"fill","selector":"@e1","field":"search_query","value":"{word}","secret":false}}"#),
                suggest(2.1),
                r#"{"type":"action","t":2.8,"action":"press","value":"Enter"}"#.to_string(),
                suggest(3.1),
                search,
            ]
            .join("\n");
            let session = browsed_session(&log).unwrap();
            let Outcome::Route { route, by, .. } = learn_from_session(&session, "video.example", Some("search videos"), 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("a route") };
            assert_eq!(by, "what was typed");
            assert_eq!((route.method.as_str(), route.path.split('?').next().unwrap()), ("POST", "/api/v1/search"), "compressed: {compressed}: the search, not the box's suggestions");
        }
    }

    /// The walk that exposed it: a dictionary search typed a word; a third-party beacon POST to a root path carried
    /// the word in an opaque body and answered with nothing, before the site's own search call. Automatic learning
    /// must keep the site's search, not the beacon (#24).
    #[test]
    fn automatic_learning_keeps_the_search_over_a_beacon() {
        let xhr = |t: f64, method: &str, url: &str, rmime: &str, req_mime: &str, req: &str, body: &str| {
            let post = if req.is_empty() { String::new() } else { format!(r#","postData":{{"mimeType":"{req_mime}","text":{}}}"#, serde_json::to_string(req).unwrap()) };
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"XHR","entry":{{"request":{{"method":"{method}","url":"{url}","headers":[]{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{rmime}","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let data = format!(r#"{{"results":[{{"word":"ebullient","def":"{}"}}]}}"#, "cheerful and full of energy ".repeat(6));
        let log = [
            r#"{"type":"action","t":1.0,"action":"navigate","value":"https://www.merriam-webster.com/"}"#.to_string(),
            r#"{"type":"action","t":2.0,"action":"fill","selector":"@e1","field":"Search","value":"ebullient","secret":false}"#.to_string(),
            r#"{"type":"action","t":2.2,"action":"press","value":"Enter"}"#.to_string(),
            // The beacon fires first: a third-party root POST, the word in an opaque text/plain body, no answer.
            xhr(2.3, "POST", "https://event.ay.delivery/", "text/plain", "text/plain", "ebullient", ""),
            // The site's own search answers with data.
            xhr(2.6, "GET", "https://www.merriam-webster.com/lapi/v1/search?q=ebullient", "application/json", "", "", &data),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        let Outcome::Route { route, by, .. } = learn_from_session(&session, "merriam-webster.com", None, 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("a route") };
        assert_eq!(by, "what was typed");
        assert_eq!(route.site, "www.merriam-webster.com", "the site's search, not the beacon event.ay.delivery: {}", route.path);
        assert!(!route.write, "a search is a read");
    }

    /// A value the site checks is never said back; one it uses is. The field's label decides nothing.
    #[test]
    fn a_value_the_site_never_says_back_is_a_secret() {
        let ex = |t: f64, url: &str, post: &str, body: &str| {
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"XHR","entry":{{"request":{{"method":"POST","url":"{url}","headers":[{{"name":"Content-Type","value":"application/json"}}],"postData":{{"mimeType":"application/json","text":{}}}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":{}}}}}}}}}"#,
                serde_json::to_string(post).unwrap(),
                serde_json::to_string(body).unwrap()
            )
        };
        let fill = |t: f64, field: &str, value: &str| format!(r#"{{"type":"action","t":{t},"action":"fill","selector":"@e1","field":"{field}","value":"{value}","secret":false}}"#);
        let log = [
            fill(1.0, "Saisissez-le", "553201"),
            ex(1.5, "https://api.shop.example/account/confirm", r#"{"c":"553201"}"#, r#"{"ok":true,"expires":15532010}"#),
            fill(2.0, "Nouveau prix", "699"),
            ex(2.5, "https://api.shop.example/listings/9/price", r#"{"price":"699"}"#, r#"{"id":9,"price":"699"}"#),
        ]
        .join("\n");
        let session = unbrowse_learn::session::Session::from_log(&log).unwrap();
        assert!(kept_secret(&session, "553201", 1.0, f64::INFINITY), "a code the site only checked");
        assert!(!kept_secret(&session, "699", 2.0, f64::INFINITY), "a price the site set and said back");
    }

    /// A sign-in's answer says back neither the username nor the password, but the username went out with the vault's
    /// login: it is the account that signs in, and the sign-in read from the walk types it again.
    #[test]
    fn the_account_sent_with_a_vault_login_is_no_secret() {
        let ex = |t: f64, post: &str| {
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"XHR","entry":{{"request":{{"method":"POST","url":"https://id.shop.example/login","headers":[{{"name":"Content-Type","value":"application/json"}}],"postData":{{"mimeType":"application/json","text":{}}}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":"{{\"session\":{{\"active\":true}}}}"}}}}}}}}"#,
                serde_json::to_string(post).unwrap()
            )
        };
        let fill = |t: f64, field: &str, value: &str, secret: bool| format!(r#"{{"type":"action","t":{t},"action":"fill","selector":"@e1","field":"{field}","value":"{value}","secret":{secret}}}"#);
        let log = [
            fill(1.0, "identifier", "QuietOtter42", false),
            fill(1.1, "password", "vault:shop.example:me@mail.example", true),
            ex(1.5, r#"{"identifier":"QuietOtter42","password":"vault:shop.example:me@mail.example"}"#),
            fill(2.0, "code", "553201", false),
            ex(2.5, r#"{"code":"553201"}"#),
        ]
        .join("\n");
        let session = unbrowse_learn::session::Session::from_log(&log).unwrap();
        assert!(!kept_secret(&session, "QuietOtter42", 1.0, f64::INFINITY), "the account sent with the login");
        assert!(kept_secret(&session, "553201", 2.0, f64::INFINITY), "a code sent on its own is still one the site only checked");
    }

    /// SISTIC's walk: an ad conversion carried the page's address and title, and outscored the site's own search.
    #[test]
    fn a_call_reporting_the_page_never_wins() {
        let page = "https://www.sistic.com.sg/search-results?query=concert";
        let call = |url: &str, body: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = Trace {
            exchanges: vec![
                call(
                    "https://www.googleadservices.com/pagead/conversion/919897038/?url=https%3A%2F%2Fwww.sistic.com.sg%2Fsearch-results%3Fquery%3Dconcert&tiba=SISTIC%20Events%20and%20Tickets%20search",
                    &format!(r#"{{"events":"tickets","sistic":"search","pad":"{}"}}"#, "x".repeat(4096)),
                ),
                call(
                    "https://cms.sistic.com.sg/sistic/docroot/api/get-solr-search-results?client=1&search=concert",
                    r#"{"first":0,"limit":20,"total_records":161,"data":[{"type":"event","title":"VIVA Concerti"}]}"#,
                ),
            ],
            inputs: Vec::new(),
        };
        let view = view_of("w", page, "sistic.com.sg", &trace, 0);
        let scores = rule_scores(&trace, &view, "search SISTIC events and tickets", &["concert".to_string()], &[]);
        let (_, best, _, _) = scores.iter().find(|s| !s.2).unwrap();
        assert_eq!(*best, 1, "the site's own search answers the goal");
        assert!(scores.iter().any(|s| s.1 == 0 && s.2), "the conversion is noise");
    }

    /// A call that reports the page is not the page's data, however large its answer: a consent manager's policy
    /// document is 40KB of JSON and reads like the page's own backend. A call that gates access is the puzzle the
    /// site set, not an answer. The page's own data call is the only candidate left.
    #[test]
    fn a_call_reporting_the_page_is_not_the_pages_data() {
        let call = |url: &str, body: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let policy = format!(r#"{{"categories":{{"consent":"x"}},"pad":"{}"}}"#, "p".repeat(4096));
        let trace = Trace {
            exchanges: vec![
                // A consent manager's policy document: a beacon by its path and its name.
                call("https://cdn.consent.example/consent/abc/xyz/en-us.json", &policy),
                // A health ping: it reports the site is up, not what the reader asked for.
                call("https://www.shop.example/.well-known/health", r#"{"status":"ok","uptime":99.9}"#),
                // The page's own listings.
                call(
                    "https://www.shop.example/api/listings?page=1",
                    r#"{"items":[{"id":1,"title":"a thing","price":40},{"id":2,"title":"another","price":9}],"total":2}"#,
                ),
            ],
            inputs: Vec::new(),
        };
        let view = view_of("w", "https://www.shop.example/listings", "shop.example", &trace, 0);
        assert_eq!(view.candidates.len(), 1, "only the listings answer the page");
        assert_eq!(view.candidates[0].index, 2);
    }

    /// A search-as-you-type page (the walk of hn.algolia.com): it runs its search once as it opens, with nothing
    /// typed, then again with what was. The route is the call that sent the query, and the query is its input, not a
    /// paging cursor because it changed between the two.
    #[test]
    fn the_same_call_made_before_anything_was_typed_is_not_the_route() {
        let search = |query: &str| Exchange {
            method: "POST".into(),
            url: url::Url::parse("https://api.search.example/1/indexes/items/query?app=demo").unwrap(),
            request_headers: vec![("content-type".into(), "application/x-www-form-urlencoded".into())],
            request_body: Some(format!(r#"{{"query":"{query}","page":0,"hitsPerPage":30}}"#)),
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(format!(r#"{{"hits":[{{"title":"{query} story"}}],"nbHits":1,"query":"{query}"}}"#)),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        };
        let trace = Trace { exchanges: vec![search(""), search("duckdb full text search")], inputs: vec![Input::new("Search stories", "duckdb full text search")] };
        let route = route_of(&trace, 1, "search stories", "https://search.example/", false, &[], &[], None).unwrap();
        assert_eq!(route.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["Search stories"]);
        let body = serde_json::to_string(&route.graph.steps.last().unwrap().body).unwrap();
        assert!(!body.contains("duckdb"), "the query is filled in at call time, not kept: {body}");
    }

    /// The walk that exposed it: a company's search box hands its word to the results page's address, and that page's
    /// script posts the word as it loads, to a path no list of search names holds. The agent typed, the route was
    /// found by what was typed, and it was dropped in silence as a write under a goal that only reads. A call a page
    /// sends by itself after its document arrived is what any visit sends: a read. The same call sent with no page
    /// loaded between the typing and it is still held to the write rules.
    #[test]
    fn a_call_the_page_landed_on_sends_as_it_loads_is_a_read() {
        let ex = |t: f64, kind: &str, method: &str, url: &str, post: &str, body: &str| {
            let post = if post.is_empty() { String::new() } else { format!(r#","postData":{{"mimeType":"application/json","text":{}}}"#, serde_json::to_string(post).unwrap()) };
            let mime = if kind == "Document" { "text/html" } else { "application/json" };
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"{kind}","entry":{{"_resourceType":"{kind}","request":{{"method":"{method}","url":"{url}","headers":[{{"name":"Content-Type","value":"application/json"}}]{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{mime}","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let act = |t: f64, action: &str, field: &str, value: &str| format!(r#"{{"type":"action","t":{t},"action":"{action}","selector":"@e1","field":"{field}","value":"{value}","secret":false}}"#);
        let found = r#"{"data":[{"title":"Solar inverters for homes","url":"/en/a"},{"title":"Solar farms at scale","url":"/en/b"}]}"#;
        let sent = r#"{"searchTxt":"solar","pageNum":1}"#;
        let shell = "<html><body><h1>Search Results</h1><input name=\"q\"></body></html>";
        let landed = [
            act(1.0, "navigate", "", "https://www.corp.example/en/searchresult"),
            ex(1.2, "Document", "GET", "https://www.corp.example/en/searchresult", "", shell),
            act(2.0, "fill", "Input Keywords", "solar"),
            act(2.5, "press", "", "Enter"),
            ex(3.0, "Document", "GET", "https://www.corp.example/en/searchresult?keywords=solar", "", shell),
            ex(3.5, "XHR", "POST", "https://www.corp.example/svc/find_public?svc=www", sent, found),
        ]
        .join("\n");
        let read = |log: &str| {
            let session = browsed_session(log).unwrap();
            let index = session.trace.exchanges.iter().rposition(|e| e.method == "POST").expect("the search call");
            let target = &session.trace.exchanges[index];
            let (typed, addressed) = (typed_words(&session, |_| true), addressed_values(&session.trace));
            let on_load = (0..session.trace.exchanges.len()).any(|i| asked_again_with_what_was_typed(&session.trace.exchanges[i], target, &typed, &addressed) && sent_by_a_page_since_loaded(&session, i, f64::INFINITY));
            let root = "https://www.corp.example/en/searchresult?keywords=solar";
            let trace = Trace { exchanges: session.trace.exchanges.clone(), inputs: walk_inputs(root, &[], &session.trace.exchanges) };
            !route_of(&trace, index, "search corp.example for solar", root, on_load, &[], &[], None).unwrap().write
        };
        assert!(read(&landed), "the page it landed on sent it as it loaded");
        let in_place: String = landed.lines().filter(|l| !l.contains("keywords=solar")).collect::<Vec<_>>().join("\n");
        assert!(!read(&in_place), "sent by the step itself, no page loaded between");
        // The page that asks for an empty word as it loads, then asks again in place once one is typed.
        let asks_first: String = in_place.lines().flat_map(|l| if l.contains(r#""action":"fill""#) { vec![ex(1.5, "XHR", "POST", "https://www.corp.example/svc/find_public?svc=www", r#"{"searchTxt":"","pageNum":1}"#, r#"{"data":null}"#), l.to_string()] } else { vec![l.to_string()] }).collect::<Vec<_>>().join("\n");
        assert!(read(&asks_first), "the page sends the same call by itself as it loads");
        // One address answers many operations (a query language, an RPC): the page asks for one as it loads, and a
        // step then sends another to the same address with the same keys. Nobody typed the operation it names, so it
        // is not the page's read asked again, and it stays a write.
        let loads = ex(1.5, "XHR", "POST", "https://www.corp.example/svc/find_public?svc=www", r#"{"operation":"item","id":"41"}"#, found);
        let acts = ex(3.5, "XHR", "POST", "https://www.corp.example/svc/find_public?svc=www", r#"{"operation":"removeItem","id":"41"}"#, found);
        let another: String = in_place.lines().flat_map(|l| if l.contains(r#""action":"fill""#) { vec![loads.clone(), l.to_string()] } else if l.contains("searchTxt") { vec![acts.clone()] } else { vec![l.to_string()] }).collect::<Vec<_>>().join("\n");
        assert!(another.contains("removeItem") && !another.contains("searchTxt"), "{another}");
        assert!(!read(&another), "another operation on the address the page reads from is still a write");
        // The operation typed as a word, where the page had written its own: still another thing to do. And one chosen
        // from the page's options is the page's value, not a word of the caller's.
        let typed_op = another.replace(r#""value":"solar""#, r#""value":"removeItem""#);
        assert!(typed_op.contains(r#""action":"fill""#) && !read(&typed_op), "an operation typed over the page's own word is still a write");
        let chosen = asks_first.replace(r#""action":"fill""#, r#""action":"select""#);
        assert!(!read(&chosen), "a value chosen from the page's options is not a typed word");
        // And of the two, the route is the one that carries the word: the first already sent the address's language.
        let session = browsed_session(&asks_first.replace(r#"{"searchTxt":"","pageNum":1}"#, r#"{"searchTxt":"","site":"en","pageNum":1}"#).replace(sent, r#"{"searchTxt":"solar","site":"en","pageNum":1}"#)).unwrap();
        let trace = Trace { exchanges: session.trace.exchanges.clone(), inputs: vec![unbrowse_learn::Input::new("part0", "en"), unbrowse_learn::Input::new("q", "solar")] };
        let (first, _) = first_of_repeats(&trace, trace.exchanges.last().unwrap());
        assert!(first.request_body.as_deref().is_some_and(|b| b.contains("solar")), "{:?}", first.request_body);
    }

    /// The walk that exposed it: a news site whose search box hands the word to a chat page, in its address. That
    /// page as served says nothing of the word, and it was kept as the search: the same frame for every word. Under
    /// a goal that reads, a page the word lands on is the route only where it says something of it.
    #[test]
    fn a_page_a_typed_word_lands_on_is_the_route_only_where_it_answers() {
        let doc = |t: f64, url: &str, body: &str| format!(
            r#"{{"type":"exchange","t":{t},"resourceType":"Document","entry":{{"_resourceType":"Document","request":{{"method":"GET","url":"{url}","headers":[]}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"text/html","text":{}}}}}}}}}"#,
            serde_json::to_string(body).unwrap()
        );
        let act = |t: f64, action: &str, field: &str, value: &str| format!(r#"{{"type":"action","t":{t},"action":"{action}","selector":"@e1","field":"{field}","value":"{value}","secret":false}}"#);
        let log = |landing: &str| [
            act(1.0, "navigate", "", "https://www.news.example/search"),
            doc(1.2, "https://www.news.example/search", "<html><body><input name=\"q\"><a href=\"/\">Home</a></body></html>"),
            act(2.0, "fill", "q", "league"),
            act(2.5, "press", "", "Enter"),
            doc(3.0, "https://chat.news.example/ask?prompt=league", landing),
        ].join("\n");
        let learn = |landing: &str| learn_from_session(&browsed_session(&log(landing)).unwrap(), "news.example", Some("search the news for league"), 0.0, 0.0, f64::INFINITY, "w", &no_eye, None);
        let rows: String = (0..12).map(|n| format!("<li><a href=\"/a/{n}\">League round {n} report</a></li>")).collect();
        assert!(matches!(learn(&format!("<html><body><ul>{rows}</ul></body></html>")), Ok(Outcome::Route { by: "what was typed", .. })));
        let empty = "<html><head><script>boot()</script></head><body><p>Sign up for free to keep your chats.</p><a href=\"/terms\">Terms</a></body></html>";
        assert!(!matches!(learn(empty), Ok(Outcome::Route { .. })), "an empty frame is no search");
    }

    #[test]
    fn a_closed_browser_flow_with_no_answer_is_visible_to_xray() {
        store::scratch_home("no-answer-eye");
        let site = "flow-observation.example";
        let page = format!("https://{site}/find?q=lamps");
        let goal = "list lamps and prices";
        let path = log_of(site);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let navigate = serde_json::json!({"type":"action","t":1,"action":"navigate","value":page});
        let response = serde_json::json!({"type":"exchange","t":2,"resourceType":"Document","tab":"one","entry":{
            "_resourceType":"Document","request":{"method":"GET","url":page,"headers":[{"name":"Sec-Fetch-Dest","value":"document"}]},
            "response":{"status":404,"headers":[],"content":{"mimeType":"text/html","text":"<p>private page detail</p>"}}
        }});
        std::fs::write(&path, format!("{navigate}\n{response}\n")).unwrap();
        crate::browse::set_goal(site, "test-flow", goal);
        let events = std::sync::Mutex::new(Vec::new());
        assert!(learn_auto(site, "test-flow", Some(3.0), "test", &|event| events.lock().unwrap().push(event)).is_none());
        let events = events.into_inner().unwrap();
        let [Eye::Started { walk, url, .. }, Eye::Failed { walk: failed, error }] = events.as_slice() else {
            panic!("the x-ray receives a complete failed flow");
        };
        assert_eq!(walk, failed);
        assert_eq!(url.trim_end_matches('/'), format!("https://{site}"));
        assert_eq!(error, "the captured navigation did not reach the requested page (1 exchanges, main document statuses [404])");

        let candidate = serde_json::json!({"type":"exchange","t":2,"resourceType":"Fetch","tab":"one","entry":{
            "_resourceType":"Fetch","request":{"method":"GET","url":format!("https://{site}/search/private-candidate-path?q=lamps"),"headers":[]},
            "response":{"status":200,"headers":[],"content":{"mimeType":"application/json","text":
                serde_json::json!({"results":[{"name":"Reading lamp","category":"lights"},{"name":"Desk lamp","category":"lights"}]}).to_string()}}
        }});
        std::fs::write(&path, format!("{navigate}\n{candidate}\n")).unwrap();
        let events = std::sync::Mutex::new(Vec::new());
        assert!(learn_auto(site, "test-flow", Some(3.0), "test", &|event| events.lock().unwrap().push(event)).is_none());
        let events = events.into_inner().unwrap();
        let [Eye::Started { .. }, Eye::Failed { error, .. }] = events.as_slice() else {
            panic!("an unkept flow cannot share its scored candidate paths");
        };
        assert_eq!(error, "none of the scored browser calls answered the goal");
    }

    #[test]
    fn a_main_document_request_without_a_response_does_not_replace_the_results_page() {
        store::scratch_home("closed-flow-unanswered-navigation");
        let page = "https://catalog.example/search?q=lamps";
        let detour = "https://catalog.example/sign-in?return=%2Fsearch%3Fq%3Dlamps";
        let document = |t, url: &str, status, body: Option<&str>| serde_json::json!({
            "type":"exchange", "t":t, "tab":"one", "resourceType":"Document", "entry":{
                "_resourceType":"Document",
                "request":{"method":"GET", "url":url, "headers":[{"name":"Sec-Fetch-Dest","value":"document"}]},
                "response":{"status":status, "headers":[], "content":{"mimeType":"text/html", "text":body}}
            }
        });
        let rows: String = (0..6).map(|i| format!("<li><a href='/products/{i}'>Desk lamps {i}</a><span>$25.00</span></li>")).collect();
        let body = format!("<html><head><title>Desk lamps</title></head><body><h1>Desk lamps</h1><ul>{rows}</ul></body></html>");
        let opening = [
            serde_json::json!({"type":"action", "t":1, "action":"navigate", "value":page}),
            document(2, page, 202, Some("<html><body>Loading the page</body></html>")),
            document(3, page, 200, Some(&body)),
        ];
        let capture = |last| {
            let log = opening.iter().cloned().chain([last]).map(|line| line.to_string()).collect::<Vec<_>>().join("\n");
            browsed_session(&log).unwrap()
        };
        let held = capture(document(4, detour, 0, None));
        assert_eq!(held.trace.exchanges.iter().filter(|e| e.is_main_document()).map(|e| e.status).collect::<Vec<_>>(), [202, 200, 0]);
        assert!(unbrowse_learn::answer::detour(&page.parse().unwrap(), &detour.parse().unwrap()));
        assert_eq!(not_the_page(&held.trace, page), None);
        let learn = learn_from_session(&held, "catalog.example", Some("list the first five lamps with name, price and link"),
            0.0, 0.0, f64::INFINITY, "closed-flow", &no_eye, None);
        let Ok(Outcome::Route { route, .. }) = learn else { panic!("the loaded page supplied the five results") };
        assert_eq!(route.graph.steps.last().unwrap().url, "https://catalog.example/search?q={q}");

        let sign_in = capture(document(4, detour, 200, Some("<html><body><input type='password'></body></html>")));
        assert!(not_the_page(&sign_in.trace, page).is_some(), "a real HTTP detour still replaces the page");
    }

    /// A message sent by hand: the call that carries what the agent typed is the route, though it answers with
    /// little, and a bigger answer elsewhere doesn't outscore it. What was typed into a code field stays secret.
    #[test]
    fn the_call_that_carries_what_was_typed_is_the_route() {
        let ex = |t: f64, method: &str, url: &str, post: &str, body: &str| {
            let post = if post.is_empty() { String::new() } else { format!(r#","postData":{{"mimeType":"application/json","text":{}}}"#, serde_json::to_string(post).unwrap()) };
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"XHR","entry":{{"request":{{"method":"{method}","url":"{url}","headers":[{{"name":"Content-Type","value":"application/json"}}]{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let act = |t: f64, action: &str, field: &str, value: &str, secret: bool| {
            format!(r#"{{"type":"action","t":{t},"action":"{action}","selector":"@e1","field":"{field}","value":"{value}","secret":{secret}}}"#)
        };
        let log = [
            act(1.0, "navigate", "", "https://www.shop.example/inbox/77/", false),
            act(2.0, "fill", "Login code", "381191", true),
            ex(2.5, "POST", "https://api.shop.example/login/verify", r#"{"code":"381191"}"#, r#"{"ok":true,"user":{"id":5}}"#),
            ex(3.0, "GET", "https://api.shop.example/feed/recommended", "", &format!(r#"{{"items":[{}]}}"#, r#"{"title":"a lamp"},"#.repeat(200).trim_end_matches(','))),
            act(4.0, "fill", "Type a message", "can do 620, collect today?", false),
            act(4.5, "click", "Send", "", false),
            ex(5.0, "POST", "https://api.shop.example/chat/77/messages", r#"{"text":"can do 620, collect today?"}"#, r#"{"id":"m9","text":"can do 620, collect today?"}"#),
            "{\"type\":\"exchange\",\"t\":6.0,\"entry\":{\"request\":{\"method\":\"GET\",\"url\":\"https://api.shop.example/half".to_string(),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        assert!(session.trace.inputs.iter().any(|i| i.secret && i.value == "381191"), "the code is a secret input");
        let Outcome::Route { route, by, notes, secrets, .. } = learn_from_session(&session, "shop.example", Some("send a chat message"), 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("a route") };
        assert_eq!(by, "what was typed");
        assert_eq!(secrets, ["381191"], "the code the record still holds as typed is the one to forget, never the message");
        assert!(notes.is_empty());
        assert_eq!((route.method.as_str(), route.path.starts_with("/chat/")), ("POST", true), "{}", route.path);
        assert!(route.inputs.iter().any(|i| !i.secret && i.default.as_deref() == Some("can do 620, collect today?")), "what was typed is the input");
        assert!(!serde_json::to_string(&route).unwrap().contains("381191"), "a secret never lands in the route");

        // The next flow: a reply that leaves by nothing recorded. Reading it back answers with the text, but nothing
        // sent it, so there is no route, and the learner says so instead of keeping the last call that did.
        let more = [
            log.clone(),
            act(10.0, "fill", "Type a message", "yes still available", false),
            act(10.5, "click", "Send", "", false),
            ex(11.0, "GET", "https://api.shop.example/chat/77/messages?limit=20", "", r#"{"messages":[{"text":"yes still available"}]}"#),
        ]
        .join("\n");
        let session = browsed_session(&more).unwrap();
        let Outcome::Unsent(err) = learn_from_session(&session, "shop.example", Some("reply to a buyer"), 6.0, 6.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("unsent") };
        assert!(err.contains("Type a message") && err.contains("never sent"), "{err}");
    }

    /// Learning as it goes: a suggestion sent while typing is learned first, and doesn't hide the form sent later
    /// with what was typed before it; a page only read is learned with its own query as the input, once left.
    #[test]
    fn learning_as_it_goes_keeps_each_send_and_each_read() {
        let ex = |t: f64, method: &str, url: &str, post: &str, body: &str| {
            let post = if post.is_empty() { String::new() } else { format!(r#","postData":{{"mimeType":"application/json","text":{}}}"#, serde_json::to_string(post).unwrap()) };
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"XHR","entry":{{"request":{{"method":"{method}","url":"{url}","headers":[{{"name":"Content-Type","value":"application/json"}}]{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"application/json","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let act = |t: f64, action: &str, field: &str, value: &str| {
            format!(r#"{{"type":"action","t":{t},"action":"{action}","selector":"@e1","field":"{field}","value":"{value}","secret":false}}"#)
        };
        let items = format!(r#"{{"items":[{}]}}"#, r#"{"title":"a green lamp","price":40},"#.repeat(20).trim_end_matches(','));
        let log = [
            act(1.0, "navigate", "", "https://www.shop.example/sell"),
            act(2.0, "fill", "Title", "Green lamp, barely used"),
            act(3.0, "fill", "Brand", "Lumina"),
            ex(3.2, "GET", "https://api.shop.example/brands/suggest?q=Lumina", "", r#"{"brands":[{"id":7,"name":"Lumina"}]}"#),
            act(4.0, "click", "Post", ""),
            ex(4.5, "POST", "https://api.shop.example/listings", r#"{"title":"Green lamp, barely used","brand":7}"#, r#"{"id":"L1","title":"Green lamp, barely used"}"#),
            act(10.0, "navigate", "", "https://www.shop.example/search?q=green%20lamp"),
            ex(10.5, "GET", "https://api.shop.example/search?q=green%20lamp&page=1", "", &items),
            act(20.0, "navigate", "", "https://www.shop.example/"),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        // Mid-flow, before the form went: the suggestion carried what was typed.
        let Outcome::Route { route, by, at, .. } = learn_from_session(&session, "shop.example", None, 0.0, 0.0, 4.0, "w", &no_eye, None).unwrap() else { panic!() };
        assert_eq!((by, route.path.starts_with("/brands/suggest"), at), ("what was typed", true, 3.2));
        // After it, the form: the title typed before the suggestion is still its input.
        let Outcome::Route { route, .. } = learn_from_session(&session, "shop.example", None, 0.0, 3.2, 9.9, "w", &no_eye, None).unwrap() else { panic!() };
        assert_eq!((route.method.as_str(), route.path.as_str()), ("POST", "/listings"));
        assert!(route.inputs.iter().any(|i| i.default.as_deref() == Some("Green lamp, barely used")));
        assert_eq!(route.what, "Send listings on shop.example", "named from its own call when nobody named it");
        // The search page, read and left: its query is the input, and the call that sent it is the route.
        let Outcome::Route { route, by, carries_page, .. } = learn_from_session(&session, "shop.example", None, 9.9, 9.9, 19.9, "w", &no_eye, None).unwrap() else { panic!() };
        assert_eq!((by, carries_page, route.method.as_str()), ("the rule", true, "GET"));
        assert_eq!(route.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["q"]);
    }

    /// A call kept from a page that was only read is named for the agent's goal only when something tied it to that
    /// goal: the decision model said it answers it, or it sent what was typed. The rule's pick, by score and the goal's
    /// words, is the page's call and is named from its own request. A chart page polls a news feed by itself, carrying
    /// the page's symbol; the agent clicked about and nothing it did sent anything. Kept under "compile a strategy
    /// source and add it to the chart", every later ask for that goal was answered with the news.
    #[test]
    fn a_call_the_goal_never_picked_is_not_named_for_it() {
        let line = |t: f64, kind: &str, url: &str, mime: &str, body: &str| {
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"{kind}","entry":{{"_resourceType":"{kind}","request":{{"method":"GET","url":"{url}","headers":[]}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{mime}","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let page = "<html><title>BTCUSDT chart</title><body><div id=chart></div></body></html>";
        let feed = r#"{"items":[{"title":"Bitcoin slips below 60k","source":"Wire One","symbols":["BINANCE:BTCUSDT"],"place":"chart"},{"title":"ETF flows turn negative","source":"Wire Two","symbols":["BINANCE:BTCUSDT"],"place":"chart"},{"title":"Miners sell into weakness","source":"Wire One","symbols":["BINANCE:BTCUSDT"],"place":"chart"}]}"#;
        let news = "https://news.chart.example/public/news?symbol=BINANCE%3ABTCUSDT&client=chart";
        let log = [
            r#"{"type":"action","t":1.0,"action":"navigate","value":"https://www.chart.example/chart/?symbol=BINANCE%3ABTCUSDT&interval=240"}"#.to_string(),
            line(1.5, "Document", "https://www.chart.example/chart/?symbol=BINANCE%3ABTCUSDT&interval=240", "text/html", page),
            line(2.0, "Fetch", news, "application/json", feed),
            r#"{"type":"action","t":5.0,"action":"click","selector":"e93"}"#.to_string(),
            r#"{"type":"action","t":6.0,"action":"press","value":"Escape"}"#.to_string(),
            line(8.0, "Fetch", news, "application/json", feed),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        let goal = "compile a strategy source and add it to the chart";
        let Outcome::Route { route, by, .. } = learn_from_session(&session, "chart.example", Some(goal), 0.0, 0.0, 9.0, "w", &no_eye, None).unwrap() else { panic!("the page's call is still kept") };
        assert_eq!(by, "the rule");
        assert_eq!(route.path.split('?').next().unwrap(), "/public/news");
        assert_ne!(route.what, goal, "the rule's pick is named for a goal nothing tied it to");
        assert_eq!(route.what, name_of(&session.trace.exchanges[session.trace.exchanges.iter().position(|e| e.url.path() == "/public/news").unwrap()], route.write));
    }

    /// A page that was only read is answered by the call that holds what was read off it, not by the page's own
    /// shell: an app's inbox is hundreds of KB of HTML and state, and the chats come from a call of their own. A page
    /// the site went to by itself meanwhile (a chat it opened) answers nothing that was read.
    #[test]
    fn a_read_page_is_answered_by_the_call_holding_what_was_read() {
        let line = |t: f64, kind: &str, url: &str, mime: &str, body: &str| {
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"{kind}","entry":{{"_resourceType":"{kind}","request":{{"method":"GET","url":"{url}","headers":[]}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{mime}","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let state = format!(r#"{{"inbox":{{"layout":"{}","banner":"chat safely"}}}}"#, "two-pane ".repeat(4000));
        let shell = format!(r#"<html><title>inbox</title><script type="application/json">{state}</script></html>"#);
        let chats = r#"{"offers":[{"user":"lampseller","message":"blue lamp still available, collect Tampines"},{"user":"bookworm42","message":"paperback bundle sold"}]}"#;
        let read = |t: f64, text: &str| format!(r#"{{"type":"action","t":{t},"action":"read","value":{}}}"#, serde_json::to_string(text).unwrap());
        let log = [
            r#"{"type":"action","t":1.0,"action":"navigate","value":"https://www.shop.example/inbox/"}"#.to_string(),
            line(1.5, "Document", "https://www.shop.example/inbox/", "text/html", &shell),
            line(2.0, "Fetch", "https://www.shop.example/api/me/offers?count=20", "application/json", chats),
            line(2.2, "Fetch", "https://www.shop.example/api/me/unread", "application/json", r#"{"unread":0,"inbox":"messages"}"#),
            read(3.0, "lampseller Yesterday blue lamp still available, collect Tampines\nbookworm42 Yesterday paperback bundle sold"),
            line(4.0, "Document", "https://www.shop.example/inbox/5551234/", "text/html", &format!(r#"<html><script type="application/json">{{"inbox":"messages","chat":{chats},"pad":"{}"}}</script></html>"#, "x".repeat(300000))),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        let Outcome::Route { route, .. } = learn_from_session(&session, "shop.example", Some("read my inbox: each chat's latest message"), 0.0, 0.0, 9.0, "w", &no_eye, None).unwrap() else { panic!("a route") };
        assert_eq!(route.path.split('?').next().unwrap(), "/api/me/offers");
    }

    /// A message sent from an item's page names the item by the page's address: the address the flow opened is the
    /// route's first step (the site's redirect to the long address happens again), its id is an input, and the
    /// item's internal id the call sends is read from that page.
    #[test]
    fn what_was_sent_from_a_page_names_the_page_by_its_address() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let line = |t: f64, kind: &str, method: &str, url: &str, mime: &str, post: &str, body: &str| {
            let post = if post.is_empty() { String::new() } else { format!(r#","postData":{{"mimeType":"application/json","text":{}}}"#, serde_json::to_string(post).unwrap()) };
            format!(
                r#"{{"type":"exchange","t":{t},"resourceType":"{kind}","entry":{{"_resourceType":"{kind}","request":{{"method":"{method}","url":"{url}","headers":[{{"name":"Content-Type","value":"application/json"}}]{post}}},"response":{{"status":200,"headers":[],"content":{{"mimeType":"{mime}","text":{}}}}}}}}}"#,
                serde_json::to_string(body).unwrap()
            )
        };
        let page = r#"<html><script type="application/json">{"items":{"77001":{"uuid":"ab12cd34-0000-4b05-ae24-bb4d5b371117"}}}</script></html>"#;
        let log = [
            r#"{"type":"action","t":1.0,"action":"navigate","value":"https://www.shop.example/p/77001/"}"#.to_string(),
            line(1.5, "Document", "GET", "https://www.shop.example/p/blue-lamp-77001/", "text/html", "", page),
            line(2.0, "XHR", "GET", "https://www.shop.example/api/me/", "application/json", "", r#"{"user":"bob"}"#),
            r#"{"type":"action","t":3.0,"action":"fill","selector":"@e1","field":"Type here...","value":"still available?","secret":false}"#.to_string(),
            line(3.5, "XHR", "POST", "https://www.shop.example/api/product/ab12cd34-0000-4b05-ae24-bb4d5b371117/offer/", "application/json", r#"{"message":"still available?"}"#, r#"{"ok":true}"#),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        let Outcome::Route { route, .. } = learn_from_session(&session, "shop.example", Some("message a seller"), 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("a route") };
        assert_eq!(route.graph.steps.len(), 2, "{:?}", route.graph.steps.iter().map(|s| &s.url).collect::<Vec<_>>());
        assert_eq!(route.graph.steps[0].url, "https://www.shop.example/p/{path[1]}/");
        let mut names: Vec<&str> = route.inputs.iter().map(|i| i.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["Type here...", "id"]);
        assert_eq!(address_ids("https://a.example/inbox/2193857599/"), [("inbox".to_string(), "2193857599".to_string())]);
    }

    /// A chat message sent over the page's socket: the frame that carried what was typed is the route, with the
    /// message and the chat in the page's address as inputs; the protocol's opening frames are kept, and the frames
    /// the page sent along the way (reading, pinging) are not.
    #[test]
    fn a_frame_sent_over_a_socket_is_learned() {
        let sock = |t: f64, event: &str, extra: &str| format!(r#"{{"type":"socket","t":{t},"id":"9.1","event":"{event}"{extra}}}"#);
        let act = |t: f64, action: &str, field: &str, value: &str| {
            format!(r#"{{"type":"action","t":{t},"action":"{action}","selector":"@e1","field":"{field}","value":"{value}","secret":false}}"#)
        };
        let log = [
            act(1.0, "navigate", "", "https://www.shop.example/inbox/77412/"),
            sock(1.1, "open", r#","url":"wss://chat.vendor.test/?app=a1&user=5""#),
            sock(1.2, "handshake", r#","headers":{"Origin":"https://www.shop.example","Sec-WebSocket-Protocol":"tok123","Sec-WebSocket-Key":"abc","Cookie":"sid=1"}"#),
            sock(1.3, "accepted", r#","status":101"#),
            sock(1.4, "received", r#","opcode":1,"data":"LOGI{\"user_id\":\"5\"}""#),
            sock(1.5, "sent", r#","opcode":1,"data":"HELLO{\"v\":2}""#),
            sock(5.0, "sent", r#","opcode":1,"data":"READ{\"channel\":\"shop-77412\"}""#),
            act(6.0, "fill", "Type here...", "Is it still available?"),
            act(6.5, "click", "Send", ""),
            sock(6.6, "sent", r#","opcode":1,"data":"MESG{\"channel\":\"shop-77412\",\"message\":\"Is it still available?\"}""#),
            sock(6.8, "received", r#","opcode":1,"data":"MESG{\"msg_id\":42,\"message\":\"Is it still available?\"}""#),
        ]
        .join("\n");
        let session = browsed_session(&log).unwrap();
        let Outcome::Route { route, by, .. } = learn_from_session(&session, "shop.example", None, 0.0, 0.0, f64::INFINITY, "w", &no_eye, None).unwrap() else { panic!("a route") };
        assert_eq!((by, route.method.as_str(), route.write, route.yours), ("what was typed", "WS", true, true));
        assert_eq!(route.what, "Send MESG over the socket on shop.example");
        let s = route.socket.unwrap();
        assert_eq!(s.url, "wss://chat.vendor.test/?app=a1&user=5");
        assert!(s.server_first);
        assert_eq!(s.opening, ["HELLO{\"v\":2}"], "the protocol's opening, not the reading done later");
        let names: Vec<_> = s.headers.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["Origin", "Sec-WebSocket-Protocol"], "the browser's own headers and the cookies are made fresh");
        use crate::store::Piece;
        let input = |n: &str| Piece::Input { name: n.into() };
        let text = |t: &str| Piece::Text { text: t.into() };
        assert_eq!(frame_kind(&s.frame), "MESG");
        assert_eq!(frame_kind(&[input("x"), text(" there")]), "", "a frame that starts with the caller's value has no kind");
        assert_eq!(s.frame, [text("MESG{\"channel\":\"shop-"), input("inbox"), text("\",\"message\":\""), input("Type here..."), text("\"}")]);
        assert_eq!(route.inputs.iter().map(|i| (i.name.as_str(), i.default.as_deref())).collect::<Vec<_>>(), [("inbox", Some("77412")), ("Type here...", Some("Is it still available?"))]);
    }

    #[test]
    fn the_eye_sees_paths_and_statuses_never_headers_or_bodies() {
        let dir = std::env::temp_dir().join(format!("eye-test-{}", store::now()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("w.jsonl");
        std::fs::write(
            &log,
            concat!(
                r#"{"type":"request","requestId":"1","method":"POST","url":"https://a.example/api/search?q=secret","headers":{"Cookie":"sid=hunter2"},"postData":"{}"}"#, "\n",
                r#"{"type":"response","requestId":"1","url":"https://a.example/api/search?q=secret","status":200,"mimeType":"application/json","headers":{"Set-Cookie":"sid=hunter2"},"body":"{\"hits\":[]}"}"#, "\n",
                r#"{"type":"response","requestId":"2","url":"https://a.example/collect","status":204,"mimeType":"application/json","headers":{},"body":""}"#, "\n",
                r#"{"type":"request","requestId":"5","method":"GET","url":"https://ads.example/conversion?url=https%3A%2F%2Fa.example%2Fsearch%3Fq%3Dsecret","headers":{}}"#, "\n",
                r#"{"type":"response","requestId":"5","url":"https://ads.example/conversion?url=https%3A%2F%2Fa.example%2Fsearch%3Fq%3Dsecret","status":200,"mimeType":"application/json","headers":{},"body":"{\"ok\":1}"}"#, "\n",
                r#"{"type":"response","requestId":"4","url":"chrome://theme/colors.css","status":200,"mimeType":"text/css","headers":{},"body":""}"#, "\n",
                r#"{"type":"response","requestId":"3","url":"https://cdn.example/half"#,
            ),
        )
        .unwrap();
        let seen = Mutex::new(Vec::new());
        let eye = |e: Eye| seen.locked().push(e);
        follow(&log, "w", "a.example", page_address("https://a.example/search?q=secret").as_deref(), &AtomicBool::new(true), &eye);
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), 3, "the browser's internals are skipped and the half-written line waits");
        let sorts: Vec<&str> = seen.iter().filter_map(|e| if let Eye::Seen { sort, .. } = e { Some(*sort) } else { None }).collect();
        assert_eq!(sorts, ["data", "noise", "noise"], "a call reporting the page is noise, like one that answered nothing");
        let text = serde_json::to_string(&seen).unwrap();
        assert!(!text.contains("hunter2") && !text.contains("secret") && !text.contains("hits"));
        assert!(text.contains(r#""method":"POST""#) && text.contains(r#""sort":"data""#) && text.contains(r#""sort":"noise""#));
    }

    /// A walk past a bot wall, as the owner's window watches it (L12): the refused page and what the wall fetched while
    /// it decided are the door's, and from the page the site let the walk through to on, the site's calls are its data,
    /// not more of the door. A page refused later in the walk is the door again.
    #[test]
    fn the_window_reads_what_follows_a_door_as_the_sites_data() {
        let dir = std::env::temp_dir().join(format!("eye-door-{}-{}", std::process::id(), store::now()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("w.jsonl");
        let req = |id: &str, url: &str, kind: &str| {
            let frame = if kind == "Document" { "F1" } else { "" };
            format!("{}\n", serde_json::json!({ "type": "request", "requestId": id, "method": "GET", "url": url, "resourceType": kind, "frameId": frame, "headers": {} }))
        };
        let res = |id: &str, url: &str, mime: &str, status: u16| format!("{}\n", serde_json::json!({ "type": "response", "requestId": id, "url": url, "status": status, "mimeType": mime, "headers": {}, "body": "{}" }));
        let lines = [
            req("1", "https://shop.example/search?q=lamp", "Document"),
            res("1", "https://shop.example/search?q=lamp", "text/html", 403),
            req("2", "https://shop.example/door/probe", "XHR"),
            res("2", "https://shop.example/door/probe", "application/json", 200),
            req("3", "https://shop.example/search?q=lamp", "Document"),
            res("3", "https://shop.example/search?q=lamp", "text/html", 200),
            req("4", "https://shop.example/api/search?q=lamp", "XHR"),
            res("4", "https://shop.example/api/search?q=lamp", "application/json", 200),
            req("5", "https://shop.example/next", "Document"),
            res("5", "https://shop.example/next", "text/html", 429),
            req("6", "https://shop.example/door/again", "XHR"),
            res("6", "https://shop.example/door/again", "application/json", 200),
        ];
        std::fs::write(&log, lines.concat()).unwrap();
        let seen = Mutex::new(Vec::new());
        let eye = |e: Eye| {
            if let Eye::Seen { path, sort, .. } = e {
                seen.locked().push((path, sort));
            }
        };
        follow(&log, "w", "shop.example", None, &AtomicBool::new(true), &eye);
        let _ = std::fs::remove_dir_all(&dir);
        let seen = seen.into_inner().unwrap();
        let sorts: Vec<(&str, &str)> = seen.iter().map(|(p, s)| (p.as_str(), *s)).collect();
        assert_eq!(
            sorts,
            [("/search", "gate"), ("/door/probe", "gate"), ("/search", "page"), ("/api/search", "data"), ("/next", "gate"), ("/door/again", "gate")],
            "the door is what the wall fetched; what follows it is the site's"
        );
    }

    /// What a walk's door fetched while it decided is no candidate for the answer, however much it reads like data; the
    /// site's call after the door let the walk through is (L12).
    #[test]
    fn a_call_after_the_door_is_a_candidate_and_the_doors_own_is_not() {
        let url = "https://shop.example/search?q=lamp";
        let mut refused = walked("GET", url, "<html><body><h1>One moment</h1><p>Checking your browser before you reach shop.example</p></body></html>", true);
        refused.status = 403;
        // Fetched while the door decided, and as readable as the site's own answer: only where it sat says it is the door's.
        let probe = walked("GET", "https://shop.example/api/prefetch?q=lamp", r#"{"results":[{"id":"c-1001","name":"lamp one"},{"id":"c-1002","name":"lamp two"}],"total":2}"#, false);
        let page = walked("GET", url, "<html><body><h1>Lamps</h1><ul><li>Desk lamp</li></ul></body></html>", true);
        let api = walked("GET", "https://shop.example/api/search?q=lamp", r#"{"results":[{"id":"p-1","name":"Desk lamp"},{"id":"p-2","name":"Floor lamp"}]}"#, false);
        let trace = Trace { exchanges: vec![refused, probe, page, api], inputs: walk_inputs(url, &[], &[]) };
        let view = view_of("t", url, &site_of("shop.example"), &trace, 0);
        let offered: Vec<usize> = view.candidates.iter().map(|c| c.index).collect();
        assert!(offered.contains(&3), "the site's call after the door: {offered:?}");
        assert!(!offered.contains(&1) && !offered.contains(&0), "nothing the door fetched: {offered:?}");
        assert_eq!(view.gates, ["shop.example"]);
    }

    /// A walk the site sent to its sign-in, naming the page to come back to, takes in the owner's browser session and
    /// walks the page again (L21). A walk that reached its page opens no browser of the owner's.
    #[test]
    fn a_walk_sent_to_a_sign_in_is_walked_again_with_the_owners_session() {
        let url = "https://app.example/orders";
        let login = walked("GET", "https://app.example/login?next=%2Forders", r#"<html><body><form><input name="email"><input type="password" name="pw"></form></body></html>"#, true);
        let sent = page_detoured(&Trace { exchanges: vec![login], inputs: Vec::new() }, url);
        assert!(sent.is_some(), "the walk was sent to the sign-in");
        let mut walked_again = 0;
        let again = crate::import::again_signed_in("learn", sent.as_deref(), "app.example", |_| Some(Ok(crate::import::Kept { host: "app.example".into(), cookies: 2, profiles: 1, profile_error: None })), || {
            walked_again += 1;
            "the orders page"
        });
        assert_eq!((again, walked_again), (Some("the orders page"), 1));
        let orders = walked("GET", url, "<html><body><h1>Your orders</h1></body></html>", true);
        let reached = page_detoured(&Trace { exchanges: vec![orders], inputs: Vec::new() }, url);
        let not_again = crate::import::again_signed_in("learn", reached.as_deref(), "app.example", |_| -> Option<Result<crate::import::Kept, String>> { unreachable!("the page was reached") }, || "x");
        assert_eq!(not_again, None);
    }

    /// An account holder's walk, signed in (L24): the page and its call carry the owner's session cookie and token, and
    /// the call names their account. The route is mapped and kept here; what leaves the machine, the recipe, carries
    /// none of the session and names the account only as the caller's input, so another holder runs it under theirs.
    #[test]
    fn a_signed_in_route_is_mapped_and_only_its_scrubbed_recipe_leaves() {
        let (sid, token, account) = ("s3ss10n9f8e7d6c5b4a3", "tok_live_7Hq2Lr9Xw4Kp8Zm3", "48213977");
        let root = "https://app.shop.example/account/orders";
        let mut page = walked("GET", root, "<html><body><h1>Your orders</h1></body></html>", true);
        page.request_headers.push(("cookie".into(), format!("sid={sid}")));
        let mut api = walked("GET", &format!("https://app.shop.example/api/accounts/{account}/orders"), r#"{"orders":[{"id":"o-1001","item":"Desk lamp","total":"39.00"},{"id":"o-1002","item":"Shade","total":"12.00"}]}"#, false);
        api.request_headers.push(("cookie".into(), format!("sid={sid}")));
        api.request_headers.push(("authorization".into(), format!("Bearer {token}")));
        let trace = Trace { exchanges: vec![page, api], inputs: walk_inputs(root, &[], &[]) };
        let route = route_of(&trace, 1, "list my orders", root, true, &[], &[], Some(&[root.to_string()])).expect("the signed-in call is mapped");
        let recipe = crate::recipe::of_route(&route).expect("and shared");
        let out = String::from_utf8(crate::recipe::canonical(&recipe)).unwrap();
        for (what, value) in [("session cookie", sid), ("token", token), ("account", account)] {
            assert!(!out.contains(value), "the owner's {what} left the machine: {out}");
        }
        assert_ne!(recipe.session, crate::recipe::SessionType::None, "the call runs under the caller's own session: {out}");
    }

    /// A page the walk saw refused, an answer that says it failed, a HEAD with no body, and a sign-in page the site
    /// sent the walk to, naming the asked page to come back to, are never a route, and never offered as one.
    #[test]
    fn a_route_is_never_kept_from_a_refusal_an_error_or_a_detour() {
        let mut missing = walked("GET", "https://filfox.info/en/address/f0abc", "<html><head><title>404 Not Found</title></head><body>Page not found</body></html>", true);
        missing.status = 404;
        let mut keyless = walked("GET", "https://min-api.cryptocompare.com/data/v2/histoday?fsym=HNT", r#"{"Response":"Error","Message":"You need a valid auth key or api key to access this endpoint","HasWarning":false,"Type":1,"RateLimit":{},"Data":{}}"#, false);
        keyless.status = 200;
        let mut head = walked("HEAD", "https://www.browserbase.com/pricing", "", true);
        head.response_body = None;
        let login = walked(
            "GET",
            "https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2Fsearch%3Fq%3Dbrowserbase%26sort%3Dtop",
            &format!("<html><head><title>reddit.com: Log in</title></head><body><a href='/'>Skip to main content</a>{}</body></html>", "<a href='/r/a'>a</a>".repeat(10)),
            true,
        );
        for (n, (root, e)) in [
            ("https://filfox.info/en/address/f0abc", missing),
            ("https://min-api.cryptocompare.com/data/v2/histoday?fsym=HNT", keyless),
            ("https://www.browserbase.com/pricing", head),
            ("https://old.reddit.com/search?q=browserbase&sort=top", login),
        ]
        .into_iter()
        .enumerate()
        {
            let trace = Trace { exchanges: vec![e.clone()], inputs: Vec::new() };
            assert!(route_of(&trace, 0, "read it", root, true, &[], &[], None).is_err(), "{} {}", e.method, e.url);
            // The sign-in page is a page like any other until it is weighed against the page that was asked for.
            if n != 3 {
                let site = site_of(e.url.host_str().unwrap());
                assert!(view_of("t", root, &site, &trace, 0).candidates.is_empty(), "{} is offered", e.url);
            }
        }
        // The answer itself is kept.
        let ok = walked("GET", "https://api.example.com/items?q=lamps", r#"{"items":[{"id":1,"name":"desk lamp"}]}"#, false);
        assert!(route_of(&Trace { exchanges: vec![ok], inputs: Vec::new() }, 0, "search items", "https://api.example.com/items?q=lamps", true, &[], &[], None).is_ok());
    }

    /// The walk that exposed it: a documentation search posted by its page as it loads, twice; the site's edge handed
    /// a cookie back on the second answer only. A call that sets a cookie is held to the write rules, and the search
    /// was dropped under a goal that reads. A cookie on one sighting and not another is not the call's doing.
    #[test]
    fn a_cookie_on_one_sighting_of_a_call_and_not_another_is_not_the_calls_doing() {
        let root = "https://docs.example/search?q=index";
        let page = walked("GET", root, "<html><body>Search</body></html>", true);
        let call = |cookie: bool| {
            let mut e = walked("POST", "https://api.docs.example/api/latest/qfind", r#"{"hits":[{"title":"index types"},{"title":"index hints"}]}"#, false);
            e.request_body = Some(r#"{"q":"index","size":10}"#.into());
            if cookie {
                e.response_headers = vec![("set-cookie".into(), "edge=abc123; Path=/".into())];
            }
            e
        };
        let both = Trace { exchanges: vec![page.clone(), call(false), call(true)], inputs: walk_inputs(root, &[], &[]) };
        assert!(!route_of(&both, 2, "search the docs", root, true, &[], &[], None).unwrap().write);
        let every = Trace { exchanges: vec![page, call(true), call(true)], inputs: walk_inputs(root, &[], &[]) };
        // Set every time, and the answer lists records that say the asked word back: it asked, and is a read.
        assert!(!route_of(&every, 2, "search the docs", root, true, &[], &[], None).unwrap().write);
        // Set every time on an answer that says nothing of what was asked: the call's own doing.
        let mut opens = call(true);
        opens.response_body = Some(r#"{"session":"s_91","ok":true}"#.into());
        let session = Trace { exchanges: vec![walked("GET", root, "<html><body>Search</body></html>", true), opens.clone(), opens], inputs: walk_inputs(root, &[], &[]) };
        assert!(route_of(&session, 2, "search the docs", root, true, &[], &[], None).unwrap().write);
    }

    /// A search the page sends as a POST by itself while it loads, nothing done on it, answering with data, is kept
    /// as a read; the same call sent after the agent acted is held to the write rules.
    #[test]
    fn a_post_the_page_sent_as_it_loaded_is_kept_as_a_read() {
        let root = "https://adstransparency.google.com/?region=anywhere&domain=browserbase.com";
        let page = walked("GET", root, "<html><body>Ads Transparency Center</body></html>", true);
        let mut search = walked("POST", "https://adstransparency.google.com/anji/_/rpc/SearchService/SearchCreatives?authuser=0", r#"{"1":[{"1":"AR0123","2":"CR0456","3":{"4":"browserbase.com"}}]}"#, false);
        search.request_body = Some(r#"f.req={"2":40,"3":{"12":{"1":"browserbase.com"}}}"#.into());
        let trace = Trace { exchanges: vec![page, search], inputs: walk_inputs(root, &[], &[]) };
        let loaded = route_of(&trace, 1, "search Google Ads Transparency Center by advertiser domain", root, true, &[], &[], None).unwrap();
        assert!(!loaded.write, "sent by the page as it loaded, so a visit sends it again");
        let acted = route_of(&trace, 1, "search Google Ads Transparency Center by advertiser domain", root, false, &[], &[], None).unwrap();
        assert!(acted.write);
        // As it is read back from disk, too.
        store::scratch_home("on-load-read");
        store::save_route(&loaded).unwrap();
        assert!(!store::load_route(&loaded.id).unwrap().write);
    }

    /// A url that answers with data itself (JSON, a text file) is its own route with no browser, and is called as one;
    /// one the site refuses says what the site said: data the browser can't change ends there, a 403 goes on to the
    /// walk with the site's words; a page is the browser's.
    #[test]
    fn a_url_that_answers_with_data_is_its_own_route() {
        store::scratch_home("plain-data");
        let port = crate::run::test_site(vec![
            ("/llms.txt", 200, "text/plain; charset=utf-8", "# Example\n> The docs, for agents.\n- [Intro](https://example.com/intro)".into()),
            ("/api/v1/overview", 200, "application/json", r#"{"height":5123456,"miners":3801,"q":"x"}"#.into()),
            ("/repos/a/b", 403, "application/json", r#"{"message":"API rate limit exceeded for 127.0.0.1. (But here's the good news: Authenticated requests get a higher rate limit.)","documentation_url":"https://docs.example.com/rate-limit"}"#.into()),
            ("/gone", 404, "application/json", r#"{"message":"Not Found"}"#.into()),
            ("/history", 200, "application/json", r#"{"error":{"status":{"error_code":10012,"error_message":"limited to the past 365 days"}}}"#.into()),
            ("/", 200, "text/html", "<!doctype html><html><body>a page</body></html>".into()),
        ]);
        let at = |p: &str| format!("http://127.0.0.1:{port}{p}");
        let Plain::Route(text) = learn_plain(&at("/llms.txt"), "read the site's llms.txt", "You") else { panic!("a text file is its own route") };
        let r = crate::run::call(&text.id, &HashMap::new(), "You").unwrap();
        assert!(r.ok && r.data.as_ref().unwrap()["text"].as_str().unwrap().contains("for agents"), "{:?} {:?}", r.error, r.data);
        let Plain::Route(api) = learn_plain(&at("/api/v1/overview?q=network"), "get the network overview", "You") else { panic!("a JSON url is its own route") };
        assert!(api.inputs.iter().any(|i| i.name == "q"), "its query is its input");
        let r = crate::run::call(&api.id, &HashMap::from([("q".to_string(), "other".to_string())]), "You").unwrap();
        assert_eq!(r.data.as_ref().unwrap()["height"], 5123456, "{:?}", r.error);
        match learn_plain(&at("/repos/a/b"), "get a repository", "You") {
            Plain::Page(Some(said)) => assert!(said.contains("403") && said.contains("API rate limit exceeded"), "{said}"),
            other => panic!("a 403 goes on to the walk, with the site's words: {other:?}"),
        }
        match learn_plain(&at("/gone"), "get a thing", "You") {
            Plain::Refused(said) => assert!(said.contains("404") && said.contains("Not Found"), "{said}"),
            other => panic!("{other:?}"),
        }
        match learn_plain(&at("/history"), "get a price on a past date", "You") {
            Plain::Refused(said) => assert!(said.contains("365 days"), "{said}"),
            other => panic!("an error said with 200 is no route: {other:?}"),
        }
        assert!(matches!(learn_plain(&at("/"), "read the page", "You"), Plain::Page(None)));
    }
}

#[cfg(test)]
mod mint_trial_tests {
    use super::*;

    /// A route whose request sends `name`, for `moved_input` to find.
    fn route_sending(names: &[&str]) -> Route {
        let fields: Vec<serde_json::Value> = names
            .iter()
            .map(|n| serde_json::json!({ "loc": { "in": "json", "key": format!("/{n}") }, "class": "input", "name": n, "secret": false, "default": null }))
            .collect();
        serde_json::from_value(serde_json::json!({
            "id": "r", "site": "shop.example", "what": "w", "method": "POST", "path": "/api",
            "root": "https://shop.example/", "inputs": [], "steps": 1, "browser_assisted": false,
            "write": false, "provisional": false, "learned_at": 1,
            "graph": { "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": "https://shop.example/api", "needs_browser": false, "fields": fields }], "provisional": false }
        }))
        .unwrap()
    }

    /// The trial asks a different question than the walk: a date moves a day, a number moves one, a word gets a
    /// letter. The input it moves is one the request actually sends.
    #[test]
    fn a_trial_moves_a_value_the_request_sends() {
        let route = route_sending(&["ddate", "q"]);
        let defaults = HashMap::from([("ddate".to_string(), "2026-12-24".to_string()), ("q".to_string(), "rust".to_string())]);
        assert_eq!(moved_input(&route, &defaults), Some(("ddate".into(), "2026-12-25".into())));
        let numeric = route_sending(&["page"]);
        assert_eq!(moved_input(&numeric, &HashMap::from([("page".into(), "2".into())])), Some(("page".into(), "3".into())));
        let word = route_sending(&["q"]);
        assert_eq!(moved_input(&word, &HashMap::from([("q".into(), "rust".into())])), Some(("q".into(), "Rust".into())), "a word moves by its case");
        assert_eq!(moved_input(&word, &HashMap::from([("q".into(), "天気".into())])), Some(("q".into(), "天気x".into())), "one with no case gets a letter");
        // An input the request never sends is not moved.
        assert_eq!(moved_input(&word, &HashMap::from([("other".into(), "1".into())])), None);
    }

    /// The model may differ from the rule, but a pick far below the best passing call does not stand.
    #[test]
    fn a_model_pick_far_below_the_rule_does_not_stand() {
        let scores = |i: usize| match i { 1 => Some(10.0), 2 => Some(5.0), 3 => Some(9.5), _ => None };
        assert!(model_stands(Some(1), Some((10.0, 1)), scores), "the rule's own pick stands");
        assert!(model_stands(Some(3), Some((10.0, 1)), scores), "a pick within one point stands");
        assert!(!model_stands(Some(2), Some((10.0, 1)), scores), "a pick far below does not");
        assert!(model_stands(Some(2), None, scores), "with nothing passing, the model's pick stands");
        assert!(!model_stands(None, Some((10.0, 1)), scores));
    }

    /// A value the walk sent for a header is read from the call at the step's method and path, never from another
    /// call's.
    #[test]
    fn a_walked_header_value_is_that_steps_own() {
        let trace = Trace {
            exchanges: vec![
                Exchange {
                    method: "POST".into(), url: "https://shop.example/api/a".parse().unwrap(),
                    request_headers: vec![("w-payload-source".into(), "one".into())], request_body: None, status: 200,
                    response_headers: vec![], response_body: Some("{}".into()), response_mime: "application/json".into(),
                    resource_type: Some("XHR".into()), main_frame: Some(true),
                },
                Exchange {
                    method: "POST".into(), url: "https://shop.example/api/b".parse().unwrap(),
                    request_headers: vec![("w-payload-source".into(), "two".into())], request_body: None, status: 200,
                    response_headers: vec![], response_body: Some("{}".into()), response_mime: "application/json".into(),
                    resource_type: Some("XHR".into()), main_frame: Some(true),
                },
            ],
            inputs: vec![],
        };
        let step: unbrowse_learn::Step = serde_json::from_value(serde_json::json!({
            "exchange": 1, "method": "POST", "status": 200, "url": "https://shop.example/api/b", "needs_browser": false, "fields": []
        })).unwrap();
        assert_eq!(walked_value(&trace, &step, "w-payload-source"), Some("two".into()));
    }
}

#[cfg(test)]
mod own_ask_tests {
    use super::own_asks::{holding, Ask};
    use super::*;

    /// A plain GET route on `site` that takes one word, `q`, in its query.
    fn a_route_on(site: &str) -> Route {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("https://{site}/api/search?q={{q}}"), "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "rust" }] }]
        }))
        .unwrap();
        Route::from_graph("held".into(), "search".into(), format!("https://{site}/search?q=rust"), graph).unwrap()
    }

    /// A second look that is held walks nothing and asks nothing, says so once, and leaves no site waiting for its
    /// verdict.
    #[test]
    fn a_held_second_look_walks_nothing() {
        let url = "https://second-look-held.example/search?q=rust";
        let route = a_route_on("second-look-held.example");
        verification_begins(url);
        assert!(verifying(url));
        let ((), said) = holding(Ask::SecondLook, || verify_learned(&Walks::default(), url, "search", "You", "no-such-walk", &route, None));
        assert_eq!(said, vec!["   [own-ask] held: second-look at learn::verify_learned".to_string()]);
        assert!(!verifying(url), "no later ask waits for a verdict that never comes");
    }

    /// A held nonsense probe sends the site no made-up value, and each probe gives the answer it gives when it could
    /// not tell: the route as learned, an unasked hearing, no piece of the address taken from the caller.
    #[test]
    fn a_held_nonsense_probe_asks_nothing_and_concludes_nothing() {
        let route = a_route_on("nonsense-held.example");
        let mut asked = 0;
        let ((), said) = holding(Ask::Nonsense, || {
            let mut answers = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
                asked += 1;
                Some(serde_json::json!({ "items": ["one"] }))
            };
            assert!(matches!(hears_with(&route, &["rust".to_string()], &mut answers), Hears::Unasked(_)));
            assert_eq!(serde_json::to_value(spaced_with(route.clone(), "", &mut answers)).unwrap(), serde_json::to_value(&route).unwrap());
            assert_eq!(serde_json::to_value(held_where_with(route.clone(), &mut answers)).unwrap(), serde_json::to_value(&route).unwrap());
            let mut answered = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
                asked += 1;
                true
            };
            assert_eq!(serde_json::to_value(the_calls_address_with(route.clone(), &mut answered)).unwrap(), serde_json::to_value(&route).unwrap());
            let mut status_of = |_: &str| {
                asked += 1;
                Some(404)
            };
            let in_path = vec![("part1".to_string(), "search".to_string()), ("part2".to_string(), "rust".to_string())];
            assert!(trial::of_the_address("https://nonsense-held.example/search/rust", &in_path, &[], &mut status_of).is_empty());
        });
        assert_eq!(asked, 0, "no made-up value reached the site");
        let at: Vec<&str> = said.iter().filter_map(|l| l.strip_prefix("   [own-ask] held: nonsense at ")).collect();
        assert_eq!(at, ["learn::hears_with", "learn::spaced_with", "learn::held_where_with", "learn::the_calls_address_with", "learn::trial::of_the_address"]);
    }

    /// The site, failing any test that asks it anything.
    struct Unasked;
    impl unbrowse_learn::lab::site::Site for Unasked {
        fn ask(&mut self, _: &unbrowse_learn::route::Step, _: &unbrowse_learn::route::Built) -> unbrowse_learn::lab::site::Said {
            panic!("the site was asked")
        }
    }

    /// Shrinking held, a route the page signs is not tried plain or shorter, and a route learned by example is not
    /// put to the four tests and shrunk: it stands as walked, and the site is asked nothing.
    #[test]
    fn a_held_shrink_asks_the_site_nothing() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://shrink-held.example/search",
            "scripts": [{ "url": "https://shrink-held.example/app.js", "body": "headers['x-app']=1" }],
            "steps": [{
                "exchange": 0, "method": "POST", "status": 200, "url": "https://shrink-held.example/api/search", "needs_browser": true, "page_signed": true,
                "page_producers": [{ "loc": { "in": "header", "key": "x-app" }, "producer": { "script": "https://shrink-held.example/app.js", "at": 1 } }],
                "fields": [{ "loc": { "in": "header", "key": "content-type" }, "class": "constant", "value": "application/json" }]
            }]
        }))
        .unwrap();
        let mut route = Route::from_graph("r".into(), "search".into(), "https://shrink-held.example/".into(), graph).unwrap();
        route.browser_assisted = true;
        let plain = a_route_on("shrink-held.example");
        let mut asked = 0;
        let ((kept, checking), said) = holding(Ask::Shrink, || {
            let mut answers = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
                asked += 1;
                true
            };
            let kept = mint_trial_as_walked(route.clone(), &Trace { exchanges: vec![], inputs: vec![] }, &mut answers, &mut |_| true);
            (kept, checked::checked_with(&plain, &[], &HashMap::new(), 0, &mut Unasked))
        });
        assert_eq!(asked, 0);
        assert!(kept.graph.steps[0].is_page_signed() && kept.browser_assisted, "the step keeps what the page writes");
        assert!(checking.route.checked.is_none() && checking.said.contains("shrinking is held"));
        let at: Vec<&str> = said.iter().filter_map(|l| l.strip_prefix("   [own-ask] held: shrink at ")).collect();
        assert_eq!(at, ["learn::mint_trial_as_walked", "learn::checked::checked_with"]);
    }

    /// A held paging trial asks the site nothing: a route the page's own next link said reads on by `page` keeps
    /// that, unasked, where the trial would have asked the site for its first and next pages.
    #[test]
    fn a_held_paging_trial_asks_the_site_nothing() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://paging-held.example/api/search?q={q}&page={page}", "needs_browser": false,
                "fields": [
                    { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "rust" },
                    { "loc": { "in": "query", "key": "page" }, "class": "input", "name": "page", "secret": false, "default": "1", "optional": true }
                ] }]
        }))
        .unwrap();
        let mut linked = Route::from_graph("held".into(), "search".into(), "https://paging-held.example/search?q=rust".into(), graph).unwrap();
        linked.paging = Some(unbrowse_learn::paging::Paging::Count { input: "page".into(), step: 1 });
        let mut asked = 0;
        let mut answers = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
            asked += 1;
            Some(serde_json::json!({ "items": ["one", "two", "three"] }))
        };
        let _ = read_on_by_trial_with(linked.clone(), None, false, &mut answers);
        assert!(asked > 0, "unheld, the trial asks the site for the first and next pages");
        asked = 0;
        let (kept, said) = holding(Ask::Paging, || {
            let mut answers = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| {
                asked += 1;
                Some(serde_json::json!({ "items": ["one", "two", "three"] }))
            };
            read_on_by_trial_with(linked.clone(), Some("lamp"), false, &mut answers)
        });
        assert_eq!(asked, 0, "held, the site is asked nothing");
        assert_eq!(serde_json::to_value(&kept).unwrap(), serde_json::to_value(&linked).unwrap(), "the route reads on as the page's link said");
        assert_eq!(said, vec!["   [own-ask] held: paging at learn::read_on_by_trial_for".to_string()]);
    }

    /// A held try of the page starts no browser: a route whose try is due is not tried, and says so once; one whose
    /// try is not due says nothing.
    #[test]
    fn a_held_try_starts_no_browser() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let due = a_route_on("try-held.example");
        let now = PAGE_TRY_GAP + 1;
        assert!(page_try_starts(&due, now, "a test"), "unheld, the try is due and starts");
        let (started, said) = holding(Ask::Try, || page_try_starts(&due, now, "a test"));
        assert!(!started);
        assert_eq!(said, vec!["   [own-ask] held: try at a test".to_string()]);
        let mut tried = due.clone();
        tried.tried_page = true;
        let (started, said) = holding(Ask::Try, || page_try_starts(&tried, now, "a test"));
        assert!(!started && said.is_empty(), "a try that was not due is not counted as held");
    }
}

// UNB-208 step 6 (A2): a second climb over what no test reached.
#[cfg(test)]
#[path = "learn_a2_tests.rs"]
mod a2_tests;
