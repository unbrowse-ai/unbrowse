//! Leaked credentials (protocol R6.36, spec §73.7): prevent and detect.
//!
//! - **Prevent.** `recipe::of_route` runs the pinned detector on the exact bytes a listing would publish and refuses a
//!   recipe it flags; `list_route` calls it before anything is written to the chain.
//! - **Detect.** Every body this node fetches is scanned before it is run or kept (`share::fetch`). A flagged body is
//!   set aside, never run, kept, served or paid for by this node, and recorded here as a finding the owner reads.
//!
//! There is no proof on chain any more (`fraud.none`: no fraud court, no forfeit): the zero-knowledge leak prover and
//! the takedowns it fed went with the court. A leak this node finds is this node's own refusal; whether a proof should
//! end a listing is open (`open.coin-fraud`).

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::listing::SignedListing;
use crate::store::{self, Activity};
use crate::{chain, Node};
use crate::sync::Locked;

/// A leak this node found, kept on disk (`leaks/leaks.json`), one record per body.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Finding {
    pub content_id: String,
    pub pattern: u32,
    /// The listing that names the body, with its contributor's signature.
    pub listing: Option<SignedListing>,
    pub found_at: u64,
}

/// What this node knows of leaks: its findings, and the bodies it refuses for them.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Leaks {
    pub findings: Vec<Finding>,
    pub taken_down: BTreeSet<String>,
}

fn dir() -> PathBuf {
    store::home().join("leaks")
}

fn path() -> PathBuf {
    dir().join("leaks.json")
}

pub fn load() -> Leaks {
    store::read_json(&path(), &unbrowse_files::LEAKS)
}

/// One change to the record at a time: a found body and a reader both touch it.
static RECORD: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Changes the record as the file holds it now, and keeps it.
fn edit<T>(change: impl FnOnce(&mut Leaks) -> T) -> T {
    let _one = RECORD.locked();
    let mut l = load();
    let out = change(&mut l);
    if let Err(e) = store::write_json(&path(), &unbrowse_files::LEAKS, &l) {
        eprintln!("leaks: couldn't keep the record: {e}");
    }
    out
}

/// Whether this node found the body `content_id` names leaking a credential: it is never fetched, run, served or paid
/// for again (R7.20).
pub fn taken_down(content_id: &str) -> bool {
    load().taken_down.contains(content_id)
}

fn note(what: String, result: &str, note: Option<String>, site: &str) {
    store::log_activity(&Activity {
        at: store::now(),
        who: "Node".into(),
        site: site.into(),
        what,
        kind: "leak".into(),
        result: result.into(),
        ms: None,
        unb: None,
        tx: None,
        note,
    });
}

/// A fetched body the detector flagged (R6.36, detect): it is set aside and never run, kept, served or paid for, the
/// owner is told, and the finding is recorded with the listing that names it. Nothing of the body is kept or sent
/// anywhere.
pub fn found(node: &Node, proven: &crate::listing::Proven, _body: &[u8], hit: unbrowse_detector::Hit) {
    let listing = &proven.listing;
    let content_id = listing.content_id.clone();
    let name = unbrowse_detector::pattern(hit.pattern).map(|p| p.name).unwrap_or("a credential");
    node.share.set_aside(&content_id, &format!("the credential detector found {name} in it: never run, kept or paid for"));
    let fresh = edit(|l| {
        if l.findings.iter().any(|f| f.content_id == content_id) {
            return false;
        }
        l.findings.push(Finding { content_id: content_id.clone(), pattern: hit.pattern, listing: Some(listing.clone()), found_at: store::now() });
        l.taken_down.insert(content_id.clone());
        true
    });
    if fresh {
        note(format!("Found a leaked credential ({name}) in a route body"), "declined", Some("This node won't run, keep, serve or pay for it".into()), &listing.site);
    }
}

/// Whether the devnet-only test flag lets this node list a recipe its own detector refuses, for a drive of the leak
/// path: `UNBROWSE_TEST_LIST_LEAKS=1`, and only on a devnet. A live network never honours it.
pub fn may_list_leaks() -> bool {
    chain::live().is_none() && std::env::var("UNBROWSE_TEST_LIST_LEAKS").is_ok_and(|v| v.trim() == "1")
}

#[cfg(test)]
mod measure {
    //! The false-positive rates the detector's README publishes, measured on this machine's real learned routes and the
    //! repository's test banks. Ignored by default: it reads `UNBROWSE_MEASURE_ROUTES` (a node's `routes` folder),
    //! `UNBROWSE_MEASURE_BODIES` (its `bodies` folder) and `UNBROWSE_MEASURE_BANKS` (the test banks), and prints counts,
    //! pattern names, field names and value shapes. It never prints a value.

    use std::collections::BTreeMap;
    use std::path::Path;

    use unbrowse_learn::{Class, Loc};

    use crate::{recipe, store};

    fn files(dir: &str) -> Vec<std::path::PathBuf> {
        let mut out: Vec<_> = std::fs::read_dir(dir).map(|d| d.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect()).unwrap_or_default();
        out.sort();
        out
    }

    /// A value's shape, never the value: its length, entropy and kinds of character.
    fn shape(v: &[u8]) -> String {
        let has = |f: fn(&u8) -> bool| v.iter().any(f);
        format!(
            "len {} entropy {:.2} upper {} lower {} digit {} other {}",
            v.len(),
            unbrowse_detector::random::entropy_millibits(v) as f64 / 1000.0,
            has(u8::is_ascii_uppercase),
            has(u8::is_ascii_lowercase),
            has(u8::is_ascii_digit),
            has(|b| !b.is_ascii_alphanumeric())
        )
    }

    /// The JSON key nearest before `at`: a field's name, never its value.
    fn key_before(text: &[u8], at: usize) -> String {
        let head = &text[..at.min(text.len())];
        let Some(end) = head.windows(3).rposition(|w| w == b"\":\"" || w == b"\":{") else { return "-".into() };
        let start = head[..end].iter().rposition(|&b| b == b'"').map(|i| i + 1).unwrap_or(end);
        String::from_utf8_lossy(&head[start..end]).chars().take(48).collect()
    }

    fn token_at(text: &[u8], at: usize) -> &[u8] {
        let end = text[at..].iter().position(|b| matches!(b, b'"' | b' ' | b'&' | b';' | b',' | b'}' | b'\\')).map(|n| at + n).unwrap_or(text.len());
        &text[at..end.max(at)]
    }

    fn report(what: &str, text: &[u8], hits: &[unbrowse_detector::Hit], per: &mut BTreeMap<u32, usize>) {
        for h in hits {
            *per.entry(h.pattern).or_default() += 1;
            let p = unbrowse_detector::pattern(h.pattern).unwrap();
            println!("  hit {what}: pattern {} {} at key {:?}: {}", p.id, p.name, key_before(text, h.offset), shape(token_at(text, h.offset)));
        }
    }

    #[test]
    #[ignore = "reads a node's real routes from UNBROWSE_MEASURE_ROUTES; run by hand to measure the README's rates"]
    fn measure_false_positives() {
        let mut out = String::new();
        // ---- learned routes, compiled as they would be listed ----
        if let Ok(dir) = std::env::var("UNBROWSE_MEASURE_ROUTES") {
            let (mut total, mut unreadable, mut compiled, mut flagged) = (0, 0, 0, 0);
            let mut refused: BTreeMap<String, usize> = BTreeMap::new();
            let mut per: BTreeMap<u32, usize> = BTreeMap::new();
            let mut raw_flagged = 0;
            let mut raw_per: BTreeMap<u32, usize> = BTreeMap::new();
            let (mut header_token, mut header_token_random, mut gap, mut gap_routes) = (0, 0, 0, 0);
            for path in files(&dir) {
                total += 1;
                let text = std::fs::read(&path).unwrap_or_default();
                let raw = unbrowse_detector::scan(&text);
                if !raw.is_empty() {
                    raw_flagged += 1;
                    report(&format!("raw {}", short(&path)), &text, &raw, &mut raw_per);
                }
                let Ok(route) = unbrowse_files::ROUTE.read::<store::Route>(&text) else {
                    unreadable += 1;
                    continue;
                };
                // The fixed values with no public source a compiler keeps, by where they sit.
                let mut gap_here = false;
                for f in route.graph.steps.iter().flat_map(|s| &s.fields) {
                    if let Class::Constant { value, origin: None } = &f.class {
                        match &f.loc {
                            Loc::Header(h) => {
                                if value.len() >= 16 && value.chars().any(|c| c.is_ascii_digit()) && value.chars().any(|c| c.is_ascii_alphabetic()) && !value.contains(char::is_whitespace) {
                                    header_token += 1;
                                    println!("  old header rule {}: header {h}: {}", short(&path), shape(value.as_bytes()));
                                    if unbrowse_detector::random_value(value.as_bytes(), 20) {
                                        header_token_random += 1;
                                    }
                                }
                            }
                            Loc::Cookie(_) => {}
                            loc if unbrowse_detector::random_value(value.as_bytes(), 20) => {
                                gap += 1;
                                gap_here = true;
                                println!("  gap {}: {loc}: {}", short(&path), shape(value.as_bytes()));
                            }
                            _ => {}
                        }
                    }
                }
                gap_routes += gap_here as usize;
                match recipe::compile(&route) {
                    Err(e) => {
                        let kind = e.trim_start_matches("this route can't be shared: ").split([':', ',']).next().unwrap_or("").replace(|c: char| c.is_ascii_digit(), "#");
                        *refused.entry(kind.chars().take(70).collect()).or_default() += 1;
                    }
                    Ok(r) => {
                        compiled += 1;
                        let bytes = recipe::canonical(&r);
                        let hits = unbrowse_detector::scan(&bytes);
                        if !hits.is_empty() {
                            flagged += 1;
                            report(&short(&path), &bytes, &hits, &mut per);
                        }
                    }
                }
            }
            out += &format!("routes: {total} files, {unreadable} unreadable, {compiled} compile to a recipe, {flagged} recipes flagged\n");
            out += &format!("  recipes flagged by pattern: {per:?}\n");
            out += &format!("  raw route records flagged: {raw_flagged} of {total}, by pattern {raw_per:?}\n");
            out += &format!("  compiler refusals: {refused:#?}\n");
            out += &format!("  header constants with no source that are token-shaped (old rule): {header_token}; of them random by the detector: {header_token_random}\n");
            out += &format!("  query/path/body constants with no source that are random (R2.2 gap): {gap} in {gap_routes} routes\n");
        }
        if let Ok(dir) = std::env::var("UNBROWSE_MEASURE_BODIES") {
            let (mut n, mut flagged) = (0, 0);
            let mut per = BTreeMap::new();
            for path in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()) {
                n += 1;
                let text = std::fs::read(&path).unwrap_or_default();
                let hits = unbrowse_detector::scan(&text);
                if !hits.is_empty() {
                    flagged += 1;
                    report(&short(&path), &text, &hits, &mut per);
                }
            }
            out += &format!("bodies: {n}, {flagged} flagged, by pattern {per:?}\n");
        }
        if let Ok(dir) = std::env::var("UNBROWSE_MEASURE_BANKS") {
            let (mut docs, mut flagged) = (0, 0);
            let mut per = BTreeMap::new();
            let mut stack = vec![std::path::PathBuf::from(dir)];
            while let Some(d) = stack.pop() {
                for p in std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path()) {
                    if p.is_dir() {
                        stack.push(p);
                        continue;
                    }
                    let Ok(text) = std::fs::read(&p) else { continue };
                    // A JSON bank is read entry by entry; any other file whole.
                    let entries: Vec<Vec<u8>> = match serde_json::from_slice::<serde_json::Value>(&text) {
                        Ok(serde_json::Value::Array(xs)) => xs.iter().map(|x| serde_json::to_vec(x).unwrap()).collect(),
                        Ok(serde_json::Value::Object(m)) => m.values().map(|x| serde_json::to_vec(x).unwrap()).collect(),
                        _ => vec![text],
                    };
                    for e in entries {
                        docs += 1;
                        let hits = unbrowse_detector::scan(&e);
                        if !hits.is_empty() {
                            flagged += 1;
                            report(&short(&p), &e, &hits, &mut per);
                        }
                    }
                }
            }
            out += &format!("test banks: {docs} entries, {flagged} flagged, by pattern {per:?}\n");
        }
        // ---- how often each pattern misses a made-up credential of its own format ----
        let mut misses = BTreeMap::new();
        for k in (1..=14u32).filter(|_| std::env::var_os("UNBROWSE_MEASURE_SKIP_SYNTH").is_none()) {
            let m = (0..10_000u64).filter(|&s| !unbrowse_detector::matches(unbrowse_detector::synth::body(k, s).as_bytes(), k)).count();
            misses.insert(k, m);
        }
        out += &format!("synthetic misses per 10,000 made-up credentials, by pattern: {misses:?}\n");
        println!("{out}");
    }

    /// A file named by the first characters of its name's hash, so the report names no site.
    fn short(p: &Path) -> String {
        let h = sha2::Sha256::digest(p.file_name().unwrap_or_default().as_encoded_bytes());
        hex::encode(&h[..4])
    }

    use sha2::Digest;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipe;
    use alloy::primitives::FixedBytes;
    use serde_json::{json, Value};
    use unbrowse_detector::synth;

    /// Findings made at once all reach the record: none is written over by what another read before it.
    #[test]
    fn changes_made_at_once_all_reach_the_record() {
        let home = store::scratch_home("leak-record");
        let ids: Vec<String> = (0..8).map(|i| format!("{}{i:064x}", recipe::HASH_PREFIX)).collect();
        edit(|l| l.findings.extend(ids.iter().map(|id| Finding { content_id: id.clone(), ..Default::default() })));
        let threads: Vec<_> = ids
            .iter()
            .cloned()
            .map(|id| {
                let home = home.clone();
                std::thread::spawn(move || {
                    store::use_home(&home);
                    for _ in 0..10 {
                        edit(|l| {
                            if let Some(f) = l.findings.iter_mut().find(|f| f.content_id == id) {
                                f.pattern += 1;
                            }
                        });
                    }
                })
            })
            .collect();
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(load().findings.iter().map(|f| f.pattern).collect::<Vec<_>>(), vec![10; 8]);
    }

    /// A route with one step that sends `value` under `loc`, kept as a fixed value of the route.
    fn route_with(loc: Value, value: &str, origin: Value) -> store::Route {
        // A value at a path segment is spelled in the address, as the learner writes it.
        let url = if loc["in"] == "path" { format!("https://api.shop.example/v1/{}", percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC)) } else { "https://api.shop.example/v1/items".to_string() };
        let field = json!({ "loc": loc, "class": "constant", "value": value, "origin": origin });
        let step = json!({ "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [field],
                           "needs_browser": false, "response_shape": { "items": [{ "id": "number" }] } });
        let graph: unbrowse_learn::Graph = serde_json::from_value(json!({ "steps": [step], "provisional": false })).unwrap();
        store::Route { walk_without_fragment: true, read_by: Some(crate::store::ReadBy::current()), ..store::Route::from_graph("r1".into(), "search items".into(), "https://shop.example/".into(), graph).unwrap() }
    }

    fn public_origin() -> Value {
        json!({ "exchange": 0, "url": "https://shop.example/app.js", "at": { "from": "text", "before": "k=\"", "after": "\"" } })
    }

    /// Prevent (R2.2, R6.36): a credential in a fixed value is refused wherever it sits, with no public source (the
    /// compiler names the field) or with one (the detector reads the bytes that would be published). The reason never
    /// repeats the value.
    #[test]
    fn a_leaking_recipe_is_refused_before_listing() {
        for k in [1, 3, 5, 10, 11] {
            let t = synth::token(k, 3).unwrap();
            for loc in [json!({ "in": "query", "key": "q" }), json!({ "in": "path", "key": 1 }), json!({ "in": "json", "key": "/filter/term" })] {
                let e = recipe::of_route(&route_with(loc.clone(), &t, Value::Null)).unwrap_err();
                assert!(e.contains("carries a credential"), "pattern {k} at {loc}: {e}");
                assert!(!e.contains(&t[4..20]), "the reason never repeats the value");
                let e = recipe::of_route(&route_with(loc.clone(), &t, public_origin())).unwrap_err();
                assert!(e.starts_with(recipe::LEAK_REFUSAL), "pattern {k} at {loc}, served publicly: {e}");
            }
        }
        let v = synth::value(14, 3).unwrap();
        let e = recipe::of_route(&route_with(json!({ "in": "query", "key": "client_secret" }), &v, Value::Null)).unwrap_err();
        assert!(e.contains("secret-named-value"), "{e}");
    }

    /// The R2.2 rule reads what a value is, not that it is random: a random id under a plain name is kept, and a
    /// multipart boundary in `content-type` (every header the old token rule refused on 192 learned routes) is no
    /// session's token.
    #[test]
    fn ids_and_media_types_are_not_credentials() {
        let id = synth::value(14, 4).unwrap();
        assert!(recipe::of_route(&route_with(json!({ "in": "path", "key": 2 }), &id, Value::Null)).is_ok());
        assert!(recipe::of_route(&route_with(json!({ "in": "query", "key": "item" }), &id, Value::Null)).is_ok());
        let boundary = format!("multipart/form-data; boundary=----FormBoundary{}", &id[..16]);
        assert!(recipe::of_route(&route_with(json!({ "in": "header", "key": "content-type" }), &boundary, Value::Null)).is_ok());
        // Any other header holding a token with no public source still came from the session.
        assert!(recipe::of_route(&route_with(json!({ "in": "header", "key": "x-client" }), &id, Value::Null)).is_err());
    }

    /// The devnet drive's flag is the only way past the refusal, and it never holds on a live network or unset.
    #[test]
    fn only_the_devnet_flag_lists_a_leak() {
        let t = synth::token(5, 9).unwrap();
        let r = route_with(json!({ "in": "query", "key": "q" }), &t, Value::Null);
        assert!(recipe::of_route(&r).is_err());
        let forced = recipe::compile_with(&r, false).unwrap();
        assert!(recipe::leaks(&recipe::canonical(&forced)).is_err(), "the bytes still leak");
        if std::env::var_os("UNBROWSE_TEST_LIST_LEAKS").is_none() {
            assert!(!may_list_leaks());
        }
    }

    fn listing_of(content_id: &str) -> SignedListing {
        serde_json::from_value(json!({
            "route_id": "r1", "site": "api.shop.example", "content_id": content_id, "agent_id": "7", "version": 1, "supersedes": null,
            "terms": { "description": "search", "response": null, "price": crate::listing::Price::default() }, "sig": "0x00"
        }))
        .unwrap()
    }

    /// Detect (R6.36): a fetched body the detector flags is set aside, recorded once with its listing, and refused from
    /// then on; nothing of the body is kept.
    #[test]
    fn a_found_leak_is_set_aside_and_refused_from_then_on() {
        let _home = store::scratch_home("leak-found");
        let node = crate::testchain::node("b");
        let body = synth::body(5, 1);
        let content_id = crate::recipe::content_id(body.as_bytes());
        let hit = unbrowse_detector::scan(body.as_bytes())[0];
        let proven = crate::listing::Proven { listing: listing_of(&content_id), leaf: FixedBytes::ZERO, root: FixedBytes::ZERO, index: 0, proof: vec![] };
        found(&node, &proven, body.as_bytes(), hit);
        found(&node, &proven, body.as_bytes(), hit);
        assert!(node.share.refused(&content_id).is_some(), "never run or kept");
        let l = load();
        assert_eq!(l.findings.len(), 1, "one finding a body");
        assert_eq!(l.findings[0].pattern, 5);
        assert!(taken_down(&content_id), "refused from then on");
        assert!(!dir().join(format!("{}.body", content_id.trim_start_matches(crate::recipe::HASH_PREFIX))).exists(), "nothing of the body is kept");
    }

    /// For a devnet drive of the leak path: writes, to `UNBROWSE_DRIVE_ROUTE`, a route record whose query holds a
    /// made-up credential of pattern `UNBROWSE_DRIVE_PATTERN` (default 5) with no public source, as a careless
    /// recording would. Its own detector refuses to list it; the drive lists it with `UNBROWSE_TEST_LIST_LEAKS`.
    #[test]
    #[ignore = "writes a drive's route record; run by the drive"]
    fn drive_route_with_a_synthetic_credential() {
        let path = std::env::var("UNBROWSE_DRIVE_ROUTE").expect("UNBROWSE_DRIVE_ROUTE");
        let k: u32 = std::env::var("UNBROWSE_DRIVE_PATTERN").ok().and_then(|k| k.parse().ok()).unwrap_or(5);
        let t = synth::token(k, 2026).unwrap();
        let mut r = route_with(json!({ "in": "query", "key": "q" }), &t, Value::Null);
        r.id = "leakydrive01".into();
        r.what = "search items (drive)".into();
        std::fs::write(&path, unbrowse_files::ROUTE.to_vec(&r).unwrap()).unwrap();
        assert!(recipe::of_route(&r).is_err(), "the detector refuses it");
    }
}
