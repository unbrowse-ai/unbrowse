//! One site of a kept corpus, learned by example from its two walks, and called once for a word of your own.
//!
//!     cargo run -p unbrowse-learn --example lab_probe -- <corpus> <site> [word [file]]
//!     cargo run -p unbrowse-learn --example lab_probe -- check <corpus> <site> <word> [budget]
//!
//! Without a word it prints the body the two walks bear out for the site's kept call: its steps, what a caller may
//! write, and the places nothing explains. With a word it then sends that one call to the site for the word, over
//! the Chrome-shaped transport under the walk's own user agent, with no session, and prints what came back for a
//! person to read: its first screen, and all of it in `file` when one is named. A step that may write is never
//! sent. One site, one word, one command: this is for driving a site by hand, and it judges nothing.
//!
//! `check` learns the same body and then puts it to the site's four tests (`lab::verify`) with `word` as the second
//! value, and finds the smallest request the site accepts (`lab::shrink`) within `budget` asks (300 by default). It
//! prints the verdicts, every part tried and its outcome, the asks spent, and the shrunk body's steps and headers. A
//! step that may write is never sent.

use std::collections::HashMap;

use unbrowse_learn::http::ChromeFetch;
use unbrowse_learn::lab::call::call;
use unbrowse_learn::lab::kept::{asked, by_site, kept_call};
use unbrowse_learn::lab::sighting::Walk;
use unbrowse_learn::lab::site::Live;
use unbrowse_learn::lab::synth::Lab;
use unbrowse_learn::lab::{compile, shrink, verify};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("check") {
        return check(&args[1..]);
    }
    let (Some(corpus), Some(site)) = (args.first(), args.get(1)) else {
        eprintln!("usage: lab_probe <corpus> <site> [word [file]]  |  lab_probe check <corpus> <site> <word> [budget]");
        std::process::exit(2);
    };
    let sites = by_site(std::path::Path::new(corpus));
    let Some([first, second, ..]) = sites.get(site).map(Vec::as_slice) else {
        eprintln!("{site}: the corpus holds no two walks of it");
        std::process::exit(1);
    };
    let Some(at) = kept_call(first) else {
        eprintln!("{site}: the first walk kept no call that is in it");
        std::process::exit(1);
    };
    let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
    let lab = Lab::new(&walks);
    let Some(body) = compile::route(&lab, at, site) else {
        eprintln!("{site}: no body could be written for the kept call");
        std::process::exit(1);
    };
    println!("{site}, learned from walks for {:?} and {:?}", first.value, second.value);
    for step in &body.steps {
        let open: Vec<String> = step.holes.iter().filter(|h| h.open).map(|h| h.at.to_string()).collect();
        println!("  {} {} {}  ({} holes{}{})", step.id, step.method, step.url, step.holes.len(), if step.writes { ", may write" } else { "" }, if open.is_empty() { String::new() } else { format!(", open: {open:?}") });
    }
    println!("  a caller may write: {:?}", body.slots.iter().map(|s| format!("{} (walked: {})", s.name, s.example.as_deref().unwrap_or(""))).collect::<Vec<_>>());
    let Some(word) = args.get(2) else { return };
    // The word goes in every slot the first walk filled with the case's own value.
    let slots: HashMap<String, String> = body.slots.iter().filter(|s| s.example.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(&first.value))).map(|s| (s.name.clone(), word.clone())).collect();
    if slots.is_empty() {
        eprintln!("no slot of the body holds the walk's own value {:?}: there is nowhere to write the word", first.value);
        std::process::exit(1);
    }
    let agent = first.trace.exchanges[at].request_header("user-agent").unwrap_or("Mozilla/5.0").to_string();
    let mut transport = ChromeFetch::new().expect("the transport").with_identity(&agent);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let began = std::time::Instant::now();
    match call(&body, &slots, &HashMap::new(), now, &mut Live { fetch: &mut transport, left: body.steps.len() }) {
        Err(stopped) => println!("\n{word:?}: stopped: {stopped:?}"),
        Ok(called) => {
            let reply = called.answer;
            let text = reply.response_body.as_deref().unwrap_or("");
            let says = text.to_lowercase().matches(&word.to_lowercase()).count();
            println!("\n{word:?}: {} in {} ms, {} bytes of {}, says the word {says} times", reply.status, began.elapsed().as_millis(), text.len(), reply.response_mime);
            let shown: String = match reply.own_json() {
                Some(json) => serde_json::to_string_pretty(&json).unwrap_or_default(),
                None => text.to_string(),
            };
            println!("{}", shown.chars().take(1800).collect::<String>());
            if let Some(file) = args.get(3) {
                match std::fs::write(file, &shown) {
                    Ok(()) => println!("\nthe whole reply is in {file}"),
                    Err(e) => eprintln!("{file}: {e}"),
                }
            }
        }
    }
}

/// `lab_probe check <corpus> <site> <word> [budget]`: the body learned from the two walks, put to the site's four
/// tests with `word` as the second value, then shrunk to the smallest request the site accepts within the budget.
fn check(args: &[String]) {
    let (Some(corpus), Some(site), Some(word)) = (args.first(), args.get(1), args.get(2)) else {
        eprintln!("usage: lab_probe check <corpus> <site> <word> [budget]");
        std::process::exit(2);
    };
    let budget: usize = args.get(3).and_then(|b| b.parse().ok()).unwrap_or(300);
    let sites = by_site(std::path::Path::new(corpus));
    let Some([first, second, ..]) = sites.get(site).map(Vec::as_slice) else {
        eprintln!("{site}: the corpus holds no two walks of it");
        std::process::exit(1);
    };
    let Some(at) = kept_call(first) else {
        eprintln!("{site}: the first walk kept no call that is in it");
        std::process::exit(1);
    };
    let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
    let lab = Lab::new(&walks);
    let Some(body) = compile::route(&lab, at, site) else {
        eprintln!("{site}: no body could be written for the kept call");
        std::process::exit(1);
    };
    println!("{site}, learned from walks for {:?} and {:?}; checking against the live site with the second value {word:?}, budget {budget} asks\n", first.value, second.value);
    for step in &body.steps {
        println!("  {} {} {}{}", step.id, step.method, step.url, if step.writes { "  (may write)" } else { "" });
    }
    // The walk's own value in each slot it filled; the user's word as the second value in the same slots.
    let fill = |value: &str| -> HashMap<String, String> { body.slots.iter().filter(|s| s.example.as_deref().is_some_and(|e| e.eq_ignore_ascii_case(&first.value))).map(|s| (s.name.clone(), value.to_string())).collect() };
    let walked = fill(&first.value);
    let second_value = fill(word);
    if walked.is_empty() {
        eprintln!("\nno slot of the body holds the walk's own value {:?}: there is nothing to vary", first.value);
        std::process::exit(1);
    }
    let agent = first.trace.exchanges[at].request_header("user-agent").unwrap_or("Mozilla/5.0").to_string();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let jar = HashMap::new();

    println!("\nthe site's four tests:");
    let began = std::time::Instant::now();
    let verdict = {
        let mut transport = ChromeFetch::new().expect("the transport").with_identity(&agent);
        let mut live = Live { fetch: &mut transport, left: 10_000 };
        verify::verify(&body, &walked, Some(&second_value), &jar, now, &mut live)
    };
    for line in verdict.lines() {
        println!("  {line}");
    }

    println!("\nshrinking to the smallest request the site accepts:");
    let shrunk = {
        let mut transport = ChromeFetch::new().expect("the transport").with_identity(&agent);
        let mut live = Live { fetch: &mut transport, left: 10_000 };
        shrink::shrink(&body, &walked, Some(&second_value), &jar, now, budget, &mut live)
    };
    if let Some(why) = &shrunk.unchecked {
        println!("  not shrunk: {why}");
    }
    for (part, fate) in &shrunk.tried {
        let word = match fate {
            shrink::Fate::LeftOut => "left out",
            shrink::Fate::Kept => "kept",
            shrink::Fate::NotTried => "not tried (budget spent)",
        };
        println!("  {}: {word}", part.say());
    }
    println!("\n  {} asks spent (both the tests and the shrinking), {} ms", shrunk.asks, began.elapsed().as_millis());
    println!("\nthe shrunk body:");
    for step in &shrunk.body.steps {
        let headers: Vec<String> = step.holes.iter().filter_map(|h| if let unbrowse_route::Place::Header(name) = &h.at { Some(name.clone()) } else { None }).collect();
        let cookies: Vec<String> = step.holes.iter().filter_map(|h| if let unbrowse_route::Place::Cookie(name) = &h.at { Some(name.clone()) } else { None }).collect();
        println!("  {} {} {}", step.id, step.method, step.url);
        if !headers.is_empty() {
            println!("      headers: {headers:?}");
        }
        if !cookies.is_empty() {
            println!("      cookies: {cookies:?}");
        }
    }
}
