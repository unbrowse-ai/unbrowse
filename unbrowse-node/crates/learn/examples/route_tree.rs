//! A kept route said as the body's tree, and a kept site's call as the learner by example reads it.
//!
//!     cargo run -p unbrowse-learn --example route_tree -- body <route.json>...
//!     cargo run -p unbrowse-learn --example route_tree -- walks <corpus> [site]...
//!
//! `body` prints one line of JSON for each file: the route's graph said as a body (`body::from_graph`), so every
//! value of every step is a hole with its ways, each way an expression; why that body cannot be run as it stands
//! (`Route::refused`); and where it says what a graph cannot when it is said back (`body::to_graph`). A file that
//! holds no graph this crate reads says so in `unread`.
//!
//! `walks` prints one line for each site of a corpus (`lab::kept`): every place of the call a learner kept, as the
//! two walks say it (`Lab::holes`): what kind it turned out to be, the ways that rebuild it on both sightings, the
//! reply one walk alone would have tied it to, and what differed between the sightings. Beside it, the route the
//! learner writes from the two walks by itself (`compile::learn`), or why it writes none.
//!
//! Nothing is asked of any site and nothing is judged. The lines hold what the route and the walks hold, values and
//! all: they are for a reader on this machine, and never for a repository.

use std::path::Path;

use serde_json::{json, Value};

use unbrowse_learn::body::{from_graph, place_of, to_graph};
use unbrowse_learn::lab::compile;
use unbrowse_learn::lab::kept::{asked, by_site, kept_call};
use unbrowse_learn::lab::sighting::Walk;
use unbrowse_learn::lab::synth::Lab;
use unbrowse_learn::Graph;

/// One kept route, as a line.
fn body_line(file: &str) -> Value {
    let unread = |why: String| json!({ "file": file, "unread": why });
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) => return unread(e.to_string()),
    };
    let kept: Value = match serde_json::from_str(&text) {
        Ok(kept) => kept,
        Err(e) => return unread(e.to_string()),
    };
    // A kept route holds its graph under `graph`; a file that is a graph by itself is read as one.
    let graph = kept.get("graph").cloned().unwrap_or_else(|| kept.clone());
    let graph: Graph = match serde_json::from_value(graph) {
        Ok(graph) => graph,
        Err(e) => return unread(format!("its graph does not read: {e}")),
    };
    let site = kept.get("site").and_then(Value::as_str).unwrap_or_default();
    let body = from_graph(&graph, site);
    json!({
        "file": file,
        "id": kept.get("id"),
        "site": site,
        "refused": body.refused(),
        "unsaid": to_graph(&body).err().map(|why| why.to_string()),
        "body": body,
    })
}

/// One site of a corpus, as a line. None for a site with fewer than two walks.
fn walks_line(site: &str, cases: &[unbrowse_learn::lab::kept::Case]) -> Option<Value> {
    let [first, second, ..] = cases else { return None };
    let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
    let lab = Lab::new(&walks);
    let learned = match compile::learn(&walks, site) {
        Ok(body) => json!({ "body": body }),
        Err(why) => json!({ "unlearned": why.to_string() }),
    };
    let names: Vec<&str> = walks[0].asked.iter().map(|(name, _)| name.as_str()).collect();
    let Some(at) = kept_call(first) else {
        return Some(json!({ "site": site, "asked": names, "kept": Value::Null, "learned": learned }));
    };
    let holes: Vec<Value> = lab
        .holes(at)
        .iter()
        .map(|hole| {
            json!({
                "at": place_of(&hole.at),
                "kind": format!("{:?}", hole.kind),
                "ways": hole.ways,
                "tied": hole.tied,
                "moved_with": { "word": hole.axes.word, "session": hole.axes.session },
                "sent": hole.sent,
            })
        })
        .collect();
    Some(json!({
        "site": site,
        "asked": names,
        "kept": { "call": first.call, "at": at, "second_walk_made_it": lab.sightings(at)[1].is_some(), "holes": holes, "body": compile::route(&lab, at, site) },
        "learned": learned,
    }))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.split_first() {
        Some((mode, files)) if mode == "body" && !files.is_empty() => {
            for file in files {
                println!("{}", body_line(file));
            }
        }
        Some((mode, rest)) if mode == "walks" && !rest.is_empty() => {
            let sites = by_site(Path::new(&rest[0]));
            for (site, cases) in &sites {
                if rest.len() > 1 && !rest[1..].contains(site) {
                    continue;
                }
                if let Some(line) = walks_line(site, cases) {
                    println!("{line}");
                }
            }
        }
        _ => {
            eprintln!("usage: route_tree body <route.json>...\n       route_tree walks <corpus> [site]...");
            std::process::exit(2);
        }
    }
}
