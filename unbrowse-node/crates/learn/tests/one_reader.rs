//! One question, one reader (AGENTS.md): the source is read for a second copy of a reader the engine already has.
//!
//! What broke on a new site was, again and again, a primitive that existed and one path that did not use it: a body
//! parsed by hand that missed a wrapping the shared reader knew, a transport built without the walk's identity. Each
//! such copy failed into a fallback that still answered. These checks fail when a new copy appears, and say where the
//! reader is.

use std::path::{Path, PathBuf};

/// Every `.rs` file of the node's engine and app, with its text cut at its unit tests (`#[cfg(test)]`): a test may
/// build what it likes.
fn sources() -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    walk(&root.join("src"), &mut files);
    walk(&root.join("../../app/src"), &mut files);
    files
        .into_iter()
        .filter(|p| !p.file_name().is_some_and(|n| n == "tests.rs"))
        .filter_map(|p| {
            let text = std::fs::read_to_string(&p).ok()?;
            let live = text.split("#[cfg(test)]").next().unwrap_or_default().to_string();
            Some((p, live))
        })
        .collect()
}

/// The lines of the live source that hold `needle`, outside the files allowed to: `file:line: text`.
fn copies(needle: &[&str], allowed: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for (path, text) in sources() {
        let name = path.to_string_lossy().replace('\\', "/");
        if allowed.iter().any(|a| name.ends_with(a)) {
            continue;
        }
        for (n, line) in text.lines().enumerate() {
            let code = line.split("//").next().unwrap_or_default();
            if needle.iter().all(|w| code.contains(w)) {
                out.push(format!("{}:{}: {}", name.rsplit("unbrowse-node/").next().unwrap_or(&name), n + 1, line.trim()));
            }
        }
    }
    out
}

/// A call's answer is read as JSON by `Exchange::own_json` (or `json_body_like` for a page's state): it knows a
/// callback's wrapping, a guard and a stream's events. A response body parsed by hand knows only plain JSON.
#[test]
fn a_response_body_is_parsed_by_the_shared_reader() {
    // The check reads the source it means to: an empty reading would pass everything.
    let read = sources();
    assert!(read.len() > 40 && read.iter().any(|(p, _)| p.ends_with("client.rs")) && read.iter().any(|(p, _)| p.ends_with("goal.rs")), "{} files read", read.len());
    let found = copies(&["response_body", "serde_json::from_str"], &["crates/learn/src/trace.rs"]);
    assert!(found.is_empty(), "a response body parsed by hand; ask `Exchange::own_json` instead:\n{}", found.join("\n"));
}

/// The wrappings themselves are read in one place. A caller that reaches for one of them reads one wrapping and
/// misses the others.
#[test]
fn the_wrappings_of_an_answer_are_read_in_one_place() {
    for reader in ["padded_json()", "event_stream_json(", "guarded_json("] {
        let found = copies(&[reader], &["crates/learn/src/trace.rs"]);
        assert!(found.is_empty(), "`{reader}` called outside trace.rs; ask `Exchange::own_json` or `trace::body_json`:\n{}", found.join("\n"));
    }
}

/// A route's transport is built where the walk's sample is at hand, and takes all of it. A new place that builds a
/// Chrome-shaped transport must say why it has no sample to give it; this list is where it says so.
#[test]
fn a_chrome_shaped_transport_is_built_in_known_places() {
    let found = copies(
        &["ChromeFetch::"],
        &[
            // The transport itself.
            "crates/learn/src/http.rs",
            // The route client: `as_sampled` with the walk's sample.
            "crates/learn/src/client.rs",
            // A door's clearance, with the challenged page's own user agent and the walk's hints.
            "crates/learn/src/mint.rs",
            // The site probe's helpers, under the node's own name or the walk's user agent.
            "crates/learn/src/site.rs",
            // A plain request for a page nobody has walked yet: there is no sample, and the transport sends its own.
            "app/src/learn.rs",
            // The address probe: it asks a page for a made-up word in place of one piece of its path and reads only the
            // status, so there is no walked sample to give and the transport sends its own.
            "app/src/learn/trial.rs",
        ],
    );
    assert!(found.is_empty(), "a Chrome-shaped transport built in a new place; give it the walk's sample (`ChromeFetch::as_sampled`) or add the place here with why it has none:\n{}", found.join("\n"));
}

/// A learn lands on the record already under its call, so a route the learner is about to drop may be one that
/// stands: listed on the chain, the owner's own, or judged by an agent. The learner drops a route through the one
/// reader that asks (`store::drop_learned`, `store::retire_route`, `store::drop_learned`), never by deleting it outright.
#[test]
fn the_learner_never_deletes_a_route_outright() {
    let found: Vec<String> = copies(&["store::delete_route("], &[]).into_iter().filter(|l| l.starts_with("app/src/learn.rs") || l.starts_with("app/src/learn/")).collect();
    assert!(found.is_empty(), "the learner deletes a route without asking whether it stands; drop it with `store::drop_learned`:\n{}", found.join("\n"));
}
