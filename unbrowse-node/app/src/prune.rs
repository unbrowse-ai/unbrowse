//! Keeps what walks and browsing leave on disk under a stated size, oldest first.
//!
//! Two things grow and nothing else lets them go:
//!
//! - **The walks' captures** (`<temp>/unbrowse-node-walks/learn_<walk>.jsonl`, with its `.named` and `.secrets` beside
//!   it): several megabytes a walk. The node reads a capture once, as its walk ends (`learn::walk_as`), and keeps what it
//!   read in memory (`learn::Walks`); a stored route holds its graph, never a capture. What reads one later is a person
//!   or a tool (the x-ray, a bank), soon after. So a capture goes oldest first once the captures pass
//!   [`CAPTURES_CAP`], and never one the node still holds a walk of, one written to in the last [`FRESH`] (a walk in
//!   flight, or waiting on a door), or one of the newest [`KEPT_PER_SITE`] walks of its site.
//! - **The browser profiles' caches** (`<home>/profiles/<host>`): Chrome's own caches are most of a profile. A profile
//!   may hold a sign-in (the owner's import, an agent's login), so a profile is never removed whole (ENGINE-01.4): only
//!   the caches Chrome builds again ([`CACHES`]), of the profile used longest ago first, once the profiles pass
//!   [`PROFILES_CAP`]; never a profile in use, or used in the last [`FRESH`].
//!
//! Runs as the node starts and every [`EVERY`] after. Says what went by its name and its size, never what it held.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::sync::Locked;
use crate::{browse, learn, store};

/// The most the walks' captures take together before the oldest go: about thirty walks of eight megabytes.
pub const CAPTURES_CAP: u64 = 256 << 20;

/// The newest walks of each site whose captures stay whatever their size: a walk and its second look, for whoever reads
/// the site's last learn after it.
pub const KEPT_PER_SITE: usize = 2;

/// The most the profiles folder takes before the caches of the profiles used longest ago go: about forty sites.
pub const PROFILES_CAP: u64 = 512 << 20;

/// What was written to this recently may be in use: longer than a walk waits for its profile and for a door, and
/// walks.
pub const FRESH: Duration = Duration::from_secs(30 * 60);

/// How often the node looks.
pub const EVERY: Duration = Duration::from_secs(3_600);

/// What of a profile Chrome builds again when it is gone: its HTTP, script and GPU caches and its component
/// downloads. Never its cookies, storage, history or preferences.
const CACHES: &[&str] = &[
    "Default/Cache",
    "Default/Code Cache",
    "Default/GPUCache",
    "Default/DawnGraphiteCache",
    "Default/DawnWebGPUCache",
    "GPUPersistentCache",
    "GrShaderCache",
    "GraphiteDawnCache",
    "ShaderCache",
    "component_crx_cache",
];

/// Where the walks' captures are (`learn::walk_as` writes them there). A test's is in its own home, so a test never
/// prunes a capture of the owner's node.
fn walks_dir() -> PathBuf {
    #[cfg(test)]
    {
        store::home().join("unbrowse-node-walks")
    }
    #[cfg(not(test))]
    std::env::temp_dir().join("unbrowse-node-walks")
}

/// The captures of the walks the node holds now (`learn::Walks`), by name: an agent picks from one, or a second look
/// is held to it.
pub fn needed_walks(walks: &learn::Walks) -> HashSet<String> {
    let dir = walks_dir();
    walks.0.locked().keys().filter_map(|id| stem(&agent_browser_core::session::capture_path(&dir, &format!("learn_{id}")))).collect()
}

/// Prunes once: the captures over their cap, then the profiles' caches over theirs. `needed` are captures never pruned.
pub fn run(needed: &HashSet<String>) {
    let now = SystemTime::now();
    let gone = captures_to_go(walks_in(&walks_dir()), needed, now, CAPTURES_CAP);
    for w in &gone {
        for file in &w.files {
            let _ = std::fs::remove_file(file);
        }
        eprintln!("   [prune] walk {} ({}, {} KB) went: the captures were over {} MB", w.name, if w.site.is_empty() { "no site" } else { &w.site }, w.bytes >> 10, CAPTURES_CAP >> 20);
    }
    let launched = launched_profiles(&store::home().join("browsers-launched"));
    let (total, profiles) = profiles_in(&store::profiles_dir(), &launched);
    let mut left = total;
    for p in profiles_to_trim(profiles, total, now, PROFILES_CAP) {
        let freed = trim(&p.dir, &launched);
        left = left.saturating_sub(freed);
        if freed > 0 {
            eprintln!("   [prune] profile {}: its caches went ({} KB), unused since {} s ago", name_of(&p.dir), freed >> 10, now.duration_since(p.used).map(|d| d.as_secs()).unwrap_or(0));
        }
    }
    if left > PROFILES_CAP {
        eprintln!("   [prune] the profiles are {} MB, over {} MB with every unused cache gone: what is left may hold sign-ins, the owner's to remove", left >> 20, PROFILES_CAP >> 20);
    }
}

/// One walk's capture: its files, the site it walked, their size and when it was last written to.
struct Walked {
    name: String,
    site: String,
    bytes: u64,
    at: SystemTime,
    files: Vec<PathBuf>,
}

/// The walks whose captures are in `dir`: each `learn_<walk>` with what is kept beside its log.
fn walks_in(dir: &Path) -> Vec<Walked> {
    let mut by: BTreeMap<String, Walked> = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    for e in entries.flatten() {
        let path = e.path();
        let Some(name) = stem(&path).filter(|s| s.starts_with("learn_")) else { continue };
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let w = by.entry(name.clone()).or_insert_with(|| Walked { name, site: String::new(), bytes: 0, at: SystemTime::UNIX_EPOCH, files: Vec::new() });
        w.bytes += meta.len();
        w.at = w.at.max(at);
        w.files.push(path);
    }
    let mut walks: Vec<Walked> = by.into_values().collect();
    for w in &mut walks {
        w.site = site_walked(&dir.join(format!("{}.jsonl", w.name)));
    }
    walks
}

/// The site a capture walked: the host of the first address its log names (the walk's own page, as it starts).
fn site_walked(log: &Path) -> String {
    use std::io::{BufRead, Read};
    let Ok(file) = std::fs::File::open(log) else { return String::new() };
    std::io::BufReader::new(file.take(256 << 10))
        .lines()
        .take(8)
        .map_while(Result::ok)
        .find_map(|line| {
            let v: serde_json::Value = serde_json::from_str(&line).ok()?;
            Some(unbrowse_learn::identity::site_of(v["url"].as_str()?)).filter(|s| !s.is_empty())
        })
        .unwrap_or_default()
}

/// The captures to remove so that what is left is at most `cap`, oldest first, keeping every walk in `needed`, every
/// one written to lately and the newest of each site. When what is kept is over the cap on its own, it stays over.
fn captures_to_go(mut walks: Vec<Walked>, needed: &HashSet<String>, now: SystemTime, cap: u64) -> Vec<Walked> {
    let mut total: u64 = walks.iter().map(|w| w.bytes).sum();
    walks.sort_by_key(|w| std::cmp::Reverse(w.at));
    let mut of_site: BTreeMap<String, usize> = BTreeMap::new();
    let mut open = Vec::new();
    for w in walks {
        let n = of_site.entry(w.site.clone()).or_default();
        *n += 1;
        if *n > KEPT_PER_SITE && !needed.contains(&w.name) && !fresh(w.at, now) {
            open.push(w);
        }
    }
    // `open` is newest first: the oldest is its last.
    let mut gone = Vec::new();
    while total > cap {
        let Some(w) = open.pop() else { break };
        total = total.saturating_sub(w.bytes);
        gone.push(w);
    }
    gone
}

/// Written to within [`FRESH`] of `now` (or, by a clock that moved back, after it).
fn fresh(at: SystemTime, now: SystemTime) -> bool {
    now.duration_since(at).ok().is_none_or(|age| age < FRESH)
}

/// A profile the pruner may trim: when it was last used, what its caches take, and whether something uses it now.
struct Profile {
    dir: PathBuf,
    used: SystemTime,
    caches: u64,
    in_use: bool,
}

/// What the profiles folder at `root` takes in all, and its profiles. A profile set aside under `refused/` is the
/// owner's (ENGINE-01.4) and never one of them.
fn profiles_in(root: &Path, launched: &[PathBuf]) -> (u64, Vec<Profile>) {
    let total = size(root);
    let Ok(entries) = std::fs::read_dir(root) else { return (total, Vec::new()) };
    let profiles = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name() != "refused")
        .map(|e| {
            let dir = e.path();
            let in_use = browse::profile_holder(&dir).is_some() || runs_in(&dir, launched);
            Profile { used: last_used(&dir), caches: CACHES.iter().map(|c| size(&dir.join(c))).sum(), in_use, dir }
        })
        .collect();
    (total, profiles)
}

/// The profiles whose caches go, used longest ago first, until the folder is at most `cap`: never one in use or used
/// within [`FRESH`].
fn profiles_to_trim(mut profiles: Vec<Profile>, total: u64, now: SystemTime, cap: u64) -> Vec<Profile> {
    profiles.retain(|p| !p.in_use && !fresh(p.used, now) && p.caches > 0);
    profiles.sort_by_key(|p| p.used);
    let (mut total, mut out) = (total, Vec::new());
    for p in profiles {
        if total <= cap {
            break;
        }
        total = total.saturating_sub(p.caches);
        out.push(p);
    }
    out
}

/// Removes the caches of the profile at `dir`, holding it as a walk does so no browser launches in it meanwhile, and
/// looking again under the hold. Says how much went.
fn trim(dir: &Path, launched: &[PathBuf]) -> u64 {
    let Some(_held) = browse::try_hold_profile(dir, "the node's pruning of the profile's caches") else { return 0 };
    if runs_in(dir, launched) {
        return 0;
    }
    let mut freed = 0;
    for cache in CACHES.iter().map(|c| dir.join(c)) {
        let bytes = size(&cache);
        if bytes > 0 && std::fs::remove_dir_all(&cache).is_ok() {
            freed += bytes;
        }
    }
    freed
}

/// Whether a browser runs in the profile at `dir`, by anything that says so: the lock Chrome holds there while it runs
/// (`SingletonLock`, gone when it closes), a process using the browser there (the engine's shared lock on its
/// holders file), a launch record of this home naming it, the node's browser for the site, or a browser answering at
/// the address it wrote there.
fn runs_in(dir: &Path, launched: &[PathBuf]) -> bool {
    dir.join("SingletonLock").symlink_metadata().is_ok()
        || lock_held(&dir.join("agent-browser-chrome.holders"))
        || launched.iter().any(|p| p == dir)
        || browse::profile_in_use(&name_of(dir)).is_some_and(|p| p == dir)
        || browse::listening_in(dir).is_some()
}

/// Whether some process holds a lock on the file at `path`. A lock this takes to find out goes as the file closes.
fn lock_held(path: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else { return false };
    matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

/// The profiles the browsers this home launched and hasn't closed run in (`cdp::launched`: one record a browser, its
/// launcher alive, since the node reaped the rest as it started).
fn launched_profiles(records: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(records) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "launch"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|text| serde_json::from_str::<serde_json::Value>(&text).ok()?["profile"].as_str().map(PathBuf::from))
        .collect()
}

/// When the profile at `dir` was last used: the latest of what a browser writes there as it runs and as it closes.
fn last_used(dir: &Path) -> SystemTime {
    ["", "Local State", "Default/Cookies", "Default/Network/Cookies", "Default/Preferences", "DevToolsActivePort"]
        .iter()
        .filter_map(|f| dir.join(f).metadata().ok()?.modified().ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// What `path` takes on disk, all it holds counted, a link counted as itself.
fn size(path: &Path) -> u64 {
    let Ok(meta) = path.symlink_metadata() else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path).map(|entries| entries.flatten().map(|e| size(&e.path())).sum()).unwrap_or(0)
}

/// A file's name without its last extension: a walk's capture by its session's name.
fn stem(path: &Path) -> Option<String> {
    path.file_stem()?.to_str().map(String::from)
}

/// A profile's folder name: the host it is for.
fn name_of(dir: &Path) -> String {
    dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3_600);

    fn walk(name: &str, site: &str, bytes: u64, ago: Duration, now: SystemTime) -> Walked {
        Walked { name: name.into(), site: site.into(), bytes, at: now - ago, files: Vec::new() }
    }

    /// One site's walks, newest first, an hour apart.
    fn walks(n: u32, now: SystemTime) -> Vec<Walked> {
        (0..n).map(|h| walk(&format!("learn_w{h}"), "shop.example", 10, HOUR * (h + 1), now)).collect()
    }

    fn names(walks: &[Walked]) -> Vec<&str> {
        walks.iter().map(|w| w.name.as_str()).collect()
    }

    /// A profile at `root/<host>` with a cache of `bytes` and its cookies beside it.
    fn profile(root: &Path, host: &str, bytes: usize) -> PathBuf {
        let dir = root.join(host);
        std::fs::create_dir_all(dir.join("Default/Cache")).unwrap();
        std::fs::write(dir.join("Default/Cache/data_0"), vec![0u8; bytes]).unwrap();
        std::fs::write(dir.join("Default/Cookies"), b"a sign-in").unwrap();
        dir
    }

    #[test]
    fn the_oldest_go_first_until_under_the_cap() {
        let now = SystemTime::now();
        // One site's five walks, newest first; the newest two are the site's own and stay.
        let gone = captures_to_go(walks(5, now), &HashSet::new(), now, 35);
        assert_eq!(names(&gone), ["learn_w4", "learn_w3"], "the oldest go, and only until the rest fit");

        // Under the cap, nothing goes; over it with all kept, nothing that is kept goes.
        assert!(captures_to_go(walks(5, now), &HashSet::new(), now, 50).is_empty());
        assert!(captures_to_go(walks(2, now), &HashSet::new(), now, 0).is_empty());

        // Profiles: the one used longest ago loses its caches first.
        let profiles = (0..3u32)
            .map(|h| Profile { dir: PathBuf::from(format!("p{h}")), used: now - HOUR * (h + 1), caches: 10, in_use: false })
            .collect();
        let trimmed: Vec<PathBuf> = profiles_to_trim(profiles, 30, now, 15).into_iter().map(|p| p.dir).collect();
        assert_eq!(trimmed, [PathBuf::from("p2"), PathBuf::from("p1")]);
    }

    #[test]
    fn a_walk_the_node_holds_is_never_pruned() {
        let now = SystemTime::now();
        let needed: HashSet<String> = ["learn_w4".to_string()].into();
        let gone = captures_to_go(walks(5, now), &needed, now, 0);
        assert_eq!(names(&gone), ["learn_w3", "learn_w2"], "the oldest walk is held, so the next oldest go instead");

        // A walk written to lately may be in flight (a walk, its second look and a third on one site within minutes):
        // it stays, however many of its site are newer.
        let minute = Duration::from_secs(60);
        let lately = vec![walk("learn_a", "other.example", 10, minute, now), walk("learn_b", "other.example", 10, minute * 2, now), walk("learn_c", "other.example", 10, minute * 3, now), walk("learn_old", "other.example", 10, HOUR * 5, now)];
        assert_eq!(names(&captures_to_go(lately, &HashSet::new(), now, 0)), ["learn_old"]);

        // The files of one walk go together, named for its session, the site read from its log.
        let home = store::scratch_home("prune-walks");
        let dir = walks_dir();
        assert!(dir.starts_with(&home), "a test prunes only its own home");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("learn_abc.jsonl"), "{\"type\":\"mint\",\"url\":\"https://shop.example/search?q=lamp\",\"t\":1}\n").unwrap();
        std::fs::write(dir.join("learn_abc.named"), "0").unwrap();
        std::fs::write(dir.join("try_x.jsonl"), "{}").unwrap();
        let found = walks_in(&dir);
        assert_eq!(names(&found), ["learn_abc"]);
        assert_eq!((found[0].site.as_str(), found[0].files.len()), ("shop.example", 2));
    }

    #[test]
    fn a_profile_in_use_is_never_pruned() {
        let home = store::scratch_home("prune-profiles");
        let root = home.join("profiles");
        let held = profile(&root, "held.example", 1000);
        let locked = profile(&root, "locked.example", 1000);
        std::fs::write(locked.join("SingletonLock"), b"host-1").unwrap();
        let shared = profile(&root, "shared.example", 1000);
        let holders = std::fs::File::create(shared.join("agent-browser-chrome.holders")).unwrap();
        holders.lock_shared().unwrap();
        let recorded = profile(&root, "recorded.example", 1000);
        let free = profile(&root, "free.example", 1000);
        std::fs::create_dir_all(root.join("refused/old.example.1")).unwrap();
        let _walk = browse::hold_profile(&held, "a walk");

        let launched = vec![recorded.clone()];
        let (total, profiles) = profiles_in(&root, &launched);
        assert_eq!(profiles.len(), 5, "a profile set aside is never one to trim");
        let later = SystemTime::now() + FRESH * 2;
        let trimmed = profiles_to_trim(profiles, total, later, 0);
        assert_eq!(trimmed.iter().map(|p| p.dir.clone()).collect::<Vec<_>>(), std::slice::from_ref(&free));
        assert_eq!(trim(&free, &launched), 1000);
        assert!(!free.join("Default/Cache").exists() && free.join("Default/Cookies").exists(), "the caches go, never the sign-in");

        // Under the hold it takes, the pruner looks again: a browser that started meanwhile keeps its caches.
        std::fs::write(shared.join("SingletonLock"), b"host-2").unwrap();
        drop(holders);
        assert_eq!(trim(&shared, &launched), 0);
        assert_eq!(trim(&held, &launched), 0, "a profile a walk holds is not the pruner's to take");
        for p in [&held, &locked, &shared, &recorded] {
            assert!(p.join("Default/Cache/data_0").exists(), "{} is in use and keeps its caches", p.display());
        }
    }
}
