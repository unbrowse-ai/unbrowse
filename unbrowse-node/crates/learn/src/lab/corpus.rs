//! The learner by example, read over kept walks. No site is asked.
//!
//! The corpus is read as `lab::kept` reads it.
//!
//! `UNBROWSE_CORPUS=<folder> cargo test -p unbrowse-learn what_two_walks_say -- --nocapture` prints, for each site,
//! what the two walks say of every place of the kept call. It judges nothing. With no corpus named there is nothing
//! to read.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::lab::kept::{asked, by_site, kept_call};
use crate::lab::sighting::Walk;
use crate::lab::synth::{Kind, Lab};
use crate::slots::Loc;
use unbrowse_route as route;

/// A transport that answers from a walk's recording, as the learner's own site does (`Recorded`): an ask it does not
/// hold is a failure that names the places it differs at. It keeps every request it is asked for, whole.
struct Answering<'a> {
    walk: &'a Walk<'a>,
    body: &'a unbrowse_route::Route,
    jar: &'a std::collections::HashMap<String, String>,
    heard: Vec<(String, Option<usize>)>,
    sent: Vec<String>,
}

impl crate::replay::Fetch for Answering<'_> {
    fn fetch(&mut self, req: &crate::replay::Request) -> Result<crate::trace::Exchange, crate::replay::ReplayError> {
        use crate::lab::site::{Recorded, Said, Site};
        use crate::replay::ReplayError;
        self.sent.push(format!("{} {} {:?} {:?}", req.method, req.url, req.headers, req.text()));
        let id = crate::body::step_id(req.exchange);
        let step = self.body.step(&id).ok_or_else(|| ReplayError::Transport(format!("no step {id} in the body")))?;
        let built = unbrowse_route::Built { method: req.method.clone(), url: req.url.clone(), headers: req.headers.clone(), body: req.text().map(String::from), made: Vec::new(), ways: Vec::new() };
        match (Recorded { walk: self.walk }).ask(step, &built) {
            Said::Reply { at, reply } => {
                self.heard.push((id, at));
                Ok(reply)
            }
            Said::Unheard { differs, .. } => Err(ReplayError::Transport(format!("the recording holds no such ask: it differs at {differs:?}"))),
            Said::Refused(why) => Err(ReplayError::Transport(why)),
        }
    }
    fn fetch_unredirected(&mut self, req: &crate::replay::Request) -> Result<crate::trace::Exchange, crate::replay::ReplayError> {
        self.fetch(req)
    }
    fn minted(&self, name: &str) -> Option<String> {
        self.jar.get(name).cloned()
    }
}

#[test]
fn what_two_walks_say_of_each_place_of_each_kept_call() {
    let _offline = crate::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let mut totals: BTreeMap<Kind, usize> = BTreeMap::new();
    let (mut read, mut unseen, mut unkept, mut tied) = (0usize, 0usize, 0usize, 0usize);
    // Headers the session keeps as the classifier reads one (`graph::a_session_header`), which were fixed before the
    // lab asked that reader: by site.
    let mut kept_headers: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        let (Some(call), Some(at)) = (&first.call, kept_call(first)) else {
            unkept += 1;
            println!("{site}: the first walk kept no call that is in it");
            continue;
        };
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let lab = Lab::new(&walks);
        if lab.sightings(at)[1].is_none() {
            unseen += 1;
        }
        let holes = lab.holes(at);
        read += 1;
        let count = |kind: Kind| holes.iter().filter(|h| h.kind == kind).count();
        for hole in &holes {
            *totals.entry(hole.kind).or_default() += 1;
        }
        let ties = holes.iter().filter(|h| h.tied.is_some()).count();
        tied += ties;
        let cookies: Vec<String> = first.trace.exchanges[at].cookies().into_iter().map(|(k, _)| k).collect();
        let jars: Vec<String> = holes
            .iter()
            .filter(|h| h.kind == Kind::Session && matches!(h.at, Loc::Header(_)))
            .filter(|h| matches!(h.ways.first().map(|w| &w.expr), Some(route::Expr::Cookie { name, .. }) if !cookies.contains(name)))
            .map(|h| h.at.to_string())
            .collect();
        if !jars.is_empty() {
            kept_headers.insert(site.clone(), jars);
        }
        let slots: Vec<String> = {
            let mut names: Vec<String> = holes.iter().filter(|h| h.kind == Kind::Callers).flat_map(|h| h.ways.iter().flat_map(|w| w.expr.slots()).map(String::from).collect::<Vec<_>>()).collect();
            names.sort();
            names.dedup();
            names
        };
        let open: Vec<String> = holes.iter().filter(|h| h.kind == Kind::Open).map(|h| h.at.to_string()).collect();
        let digests: Vec<String> = holes.iter().filter(|h| h.kind == Kind::Digest).map(|h| format!("{} = {}", h.at, serde_json::to_string(&h.ways[0].expr).unwrap_or_default())).collect();
        let picks: Vec<String> = holes.iter().filter(|h| h.kind == Kind::Pick).map(|h| format!("{} = {}", h.at, serde_json::to_string(&h.ways[0].expr).unwrap_or_default())).collect();
        println!(
            "{site}: {call}{}\n    {} places: {} fixed ({ties} of them tied to a reply by one walk), {} the caller's {slots:?}, {} the session's, {} read, {} the clock, {} digests {digests:?}, {} picks {picks:?}, {} open {open:?}",
            if lab.sightings(at)[1].is_none() { " (the second walk never made it)" } else { "" },
            holes.len(),
            count(Kind::Fixed),
            count(Kind::Callers),
            count(Kind::Session),
            count(Kind::Read),
            count(Kind::Clock),
            count(Kind::Digest),
            count(Kind::Pick),
            count(Kind::Open),
        );
        let browsers = count(Kind::Browsers);
        if browsers > 0 {
            println!("    and {browsers} the browser wrote by itself");
        }
    }
    println!("\n{read} sites read, {unkept} with no kept call to read, {unseen} whose second walk never made the call; places by kind: {totals:?}; {tied} fixed places one walk would have tied to a reply");
    println!("{} headers the session keeps, as the classifier reads one, on {} sites, fixed before: {kept_headers:?}", kept_headers.values().map(Vec::len).sum::<usize>(), kept_headers.len());
}

/// The route the learner writes from each site's two walks by itself (`compile::learn`: its own answer, no
/// `learned.json`), called for each walk's own values against that walk's recording: does it send what the walk
/// sent, step by step, and come to the walk's own answer? The call a learner kept is printed beside it. Prints, and
/// judges nothing: both walks were what the body was learned from, so this is the learner checking its own work.
/// It does hold the learner to one thing: written again from the same walks, a body is the same bytes.
#[test]
fn a_route_the_learner_writes_from_two_walks_is_called_against_each_walks_recording() {
    let _offline = crate::http::offline();
    use crate::lab::call::{call, Stopped};
    use crate::lab::compile;
    use crate::lab::site::Recorded;
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let named = |e: &crate::trace::Exchange| format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path());
    let (mut both, mut only, mut part, mut neither) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut unlearned: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let (mut walked_twice, mut steps_total, mut kept_too) = (0usize, 0usize, 0usize);
    let mut unstable: Vec<String> = Vec::new();
    // The answers the learner wrote that are not plain reads, and of those the ones the ledger's rule says only ask.
    let (mut posts, mut asking): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        walked_twice += 1;
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let kept = match (kept_call(first), &first.call) {
            (Some(k), _) => named(&first.trace.exchanges[k]),
            (None, Some(call)) => format!("{call} (not in the walk as answered)"),
            (None, None) => "none".to_string(),
        };
        let body = match compile::learn(&walks, site) {
            Ok(body) => body,
            Err(why) => {
                let kind = match &why {
                    compile::Unlearned::Unsettled(u) => format!("{u:?}").split([' ', '{']).next().unwrap_or_default().to_string(),
                    compile::Unlearned::Unwritten(_) => "Unwritten".to_string(),
                };
                unlearned.entry(kind).or_default().push(site.clone());
                println!("{site}: no route: {why}\n    kept: {kept}");
                continue;
            }
        };
        if compile::learn(&walks, site).map(|again| serde_json::to_string(&again).ok()) != Ok(serde_json::to_string(&body).ok()) {
            unstable.push(site.clone());
        }
        let at = crate::body::exchange_of(&body.answer.step).expect("a learned answer names a call of the first walk");
        let ours = named(&first.trace.exchanges[at]);
        kept_too += usize::from(ours == kept);
        steps_total += body.steps.len();
        if let Some(answer) = body.step(&body.answer.step).filter(|s| !matches!(s.method.as_str(), "GET" | "HEAD")) {
            posts.push(format!("{site} {} {}", answer.method, answer.url));
            if !answer.writes {
                asking.push(site.clone());
            }
        }
        let lab = Lab::new(&walks);
        let found = lab.sightings(at);
        let mut said = Vec::new();
        let mut reached = 0;
        for (k, walk) in walks.iter().enumerate() {
            if found[k].is_none() {
                said.push(format!("walk {}: never made the call", k + 1));
                continue;
            }
            let slots: std::collections::HashMap<String, String> = walk.asked.iter().cloned().collect();
            // The session as the walk's own call carried it: a value a page copies from a cookie is made from the jar.
            let jar: std::collections::HashMap<String, String> = found[k].map(|i| crate::lab::sighting::jar_of(walk, i)).unwrap_or_default();
            match call(&body, &slots, &jar, 0, &mut Recorded { walk }) {
                // A reply to another sighting of the same call is a reply to the same ask: the walk made it twice.
                Ok(called) => {
                    reached += 1;
                    if called.heard.last().and_then(|(_, at)| *at) != found[k] {
                        said.push(format!("walk {}: answered by another sighting of the same call ({:?})", k + 1, called.heard.last().and_then(|(_, at)| *at)));
                    }
                }
                Err(Stopped::Unheard { step, differs, .. }) => said.push(format!("walk {}: {step} unheard, differing at {differs:?}", k + 1)),
                Err(Stopped::Stuck { step, why }) => said.push(format!("walk {}: {step} could not be built: {why}", k + 1)),
                Err(Stopped::Refused(why)) => said.push(format!("walk {}: {why}", k + 1)),
                Err(Stopped::NotAnAnswer(why)) => said.push(format!("walk {}: answered, and not with an answer: {why}", k + 1)),
            }
        }
        let made = found.iter().filter(|f| f.is_some()).count();
        println!(
            "{site}: {ours}{}, {} steps, {reached} of {made} walks' answers reached{}\n    kept: {kept}{}",
            if body.answer.page { " (the page, read)" } else { "" },
            body.steps.len(),
            if said.is_empty() { String::new() } else { format!("\n    {}", said.join("\n    ")) },
            if ours == kept { " (the same)" } else { "" }
        );
        match (reached, made) {
            (2, 2) => both.push(site.clone()),
            (1, 1) => only.push(site.clone()),
            (0, _) => neither.push(site.clone()),
            _ => part.push(site.clone()),
        }
    }
    let written = both.len() + only.len() + part.len() + neither.len();
    println!(
        "\n{walked_twice} sites walked twice; the learner wrote a route for {written}, and {kept_too} of those answer with the call a learner kept. {} reach both walks' answers; {} reach the one walk that made the call {only:?}; {} reach one walk of two {part:?}; {} reach none {neither:?}; {steps_total} steps in all",
        both.len(),
        only.len(),
        part.len(),
        neither.len()
    );
    let not: usize = unlearned.values().map(Vec::len).sum();
    println!("{not} sites have no route, by why: {}", unlearned.iter().map(|(why, sites)| format!("{why} {} {sites:?}", sites.len())).collect::<Vec<_>>().join("; "));
    println!("{} learned answers are not plain reads, and the ledger's rule says {} of them only ask {asking:?}:\n    {}", posts.len(), asking.len(), posts.join("\n    "));
    assert!(unstable.is_empty(), "written twice from the same walks, these bodies differ: {unstable:?}");
}

/// Which call two walks say is the answer (`lab::answer`), beside the call a learner kept from the first walk
/// (`learned.json`), for every site walked twice. Prints, with a count of agreements, and judges nothing: where the
/// two differ it says what the two walks' own evidence says of each (whether its reply changed with the value, how
/// many lines say the value back, whether it is the page) and so which of them it favours, and why.
#[test]
fn which_call_two_walks_say_is_the_answer_beside_the_kept_call() {
    let _offline = crate::http::offline();
    use crate::lab::answer::{answer, Told, Two};
    use crate::lab::sighting::place;
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let named = |e: &crate::trace::Exchange| format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path());
    let (mut agree, mut differ, mut unsettled, mut unkept, mut both_ways) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), 0usize);
    let mut read = 0usize;
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        read += 1;
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let two = Two::of(&walks[0], &walks[1]);
        let (a, b) = (&two.asked, &two.other);
        // What the two walks say of one call of the first: whether it heard, how many lines say its value back and
        // how many of those the other walk's reply does not hold, whether it is the page, and whether it reads.
        let evidence = |i: usize| {
            let e = &first.trace.exchanges[i];
            (two.told(i), two.says_back(i), two.own_lines_back(i), e.is_main_document(), e.method == "GET")
        };
        let said = |(t, back, own, page, _): (Told, usize, usize, bool, bool)| format!("{t:?}, {back} lines back, {own} of them its own{}", if page { ", the page" } else { "" });
        let pick = answer(&walks);
        // Read the other way, the second walk's pick: the same call when its place, the words struck out, is.
        let theirs = answer(&[Walk { trace: &second.trace, asked: asked(second), session: 1 }, Walk { trace: &first.trace, asked: asked(first), session: 1 }]);
        fn words(v: &[String]) -> Vec<&str> {
            v.iter().map(String::as_str).collect()
        }
        let same_both_ways = matches!((pick, theirs), (Some(x), Some(y)) if place(&first.trace.exchanges[x], &words(a)) == place(&second.trace.exchanges[y], &words(b)));
        both_ways += usize::from(same_both_ways);
        let kept = kept_call(first);
        let ours = pick.map(|i| format!("{} ({})", named(&first.trace.exchanges[i]), said(evidence(i)))).unwrap_or_else(|| "none".into());
        let theirs_said = kept.map(|i| format!("{} ({})", named(&first.trace.exchanges[i]), said(evidence(i)))).unwrap_or_else(|| first.call.clone().map(|c| format!("{c} (not in the walk as answered)")).unwrap_or_else(|| "none".into()));
        let verdict = match (pick, kept) {
            (Some(p), Some(k)) if named(&first.trace.exchanges[p]) == named(&first.trace.exchanges[k]) => {
                agree.push(site.clone());
                "AGREE".to_string()
            }
            (None, None) => {
                unsettled.push(site.clone());
                unkept.push(site.clone());
                "the walks settle nothing, and nothing was kept".to_string()
            }
            (Some(p), None) => {
                unkept.push(site.clone());
                let (_, _, own, _, _) = evidence(p);
                format!("nothing kept to set it beside; the walks say the lab's pick heard and says its value back on {own} lines of its own")
            }
            (None, Some(k)) => {
                unsettled.push(site.clone());
                let (t, back, own, _, _) = evidence(k);
                format!("the walks settle nothing: no call both heard and says its value back on two lines of its own; of the kept call they say {t:?} with {back} lines back, {own} of them its own")
            }
            (Some(p), Some(k)) => {
                differ.push(site.clone());
                // The pick reads whether a reply changed and how many lines of its own say the value.
                let (lt, _, lo, lp, lr) = evidence(p);
                let (kt, kb, ko, kp, kr) = evidence(k);
                debug_assert_eq!(lt, Told::Hears);
                match kt {
                    Told::Deaf => "DIFFER: the walks favour the lab's pick: the kept call answered the same for both values".to_string(),
                    Told::Unseen => format!("DIFFER: the walks say nothing of the kept call (the second walk made no such call, or its reply says too little to tell apart); of the lab's pick, that it heard and says its value back on {lo} lines of its own"),
                    Told::Hears if ko < 2 => format!("DIFFER: the walks favour the lab's pick: the kept call's reply changed but says its value back on {ko} line(s) of its own ({kb} in all), the lab's on {lo}"),
                    Told::Hears if kp && !lp => format!("DIFFER: both heard; the kept call is the page ({ko} lines of its own) and the lab's a call that says it back on {lo}, at least half as often: the same answer without the page around it"),
                    Told::Hears if lr && !kr && ko * 2 >= lo.max(ko) => format!("DIFFER: both heard and say their value back as often ({lo} and {ko} lines of their own); the lab's reads (GET) and the kept call sends a body"),
                    Told::Hears => format!("DIFFER: both heard; the lab's pick says its value back on {lo} lines of its own, the kept call on {ko}{}", if lp { " (the lab's is the page)" } else { "" }),
                }
            }
        };
        println!("{site}: {verdict}\n    lab:  {ours}{}\n    kept: {theirs_said}", if same_both_ways { " (the same read the other way)" } else { "" });
    }
    println!(
        "\n{read} sites walked twice; the lab's pick and the kept call agree on {} {agree:?}, differ on {} {differ:?}; the walks settle nothing on {} {unsettled:?}; {} have no kept call in the walk; on {both_ways} the pick read the other way is the same call",
        agree.len(),
        differ.len(),
        unsettled.len(),
        unkept.len()
    );
}

/// What the node's own caller (`replay`) makes of each body the learner writes, offline. Each body is said as a graph
/// (`body::to_graph`) or refused with the place and the reason. An accepted graph, said back as a body, fills as the
/// body does, step for step, with each walk's values and the replies its recording gave (gate A). And replayed over
/// a transport that answers from the walk's recording, where an ask the recording does not hold is a transport's
/// failure naming the places it differs at, it reaches the walks' answers the learner's own caller reaches for that
/// body (gate B). The filler is held to each replay's requests on the way (`body::shadow`), and a difference there
/// fails this test. Prints; the gates fail the test only where a request differs.
#[test]
fn a_learned_body_said_as_a_graph_is_run_by_the_nodes_caller_as_by_the_learners() {
    let _offline = crate::http::offline();
    use crate::body::tests::{differs, Hand};
    use crate::body::to_graph;
    use crate::lab::call::call;
    use crate::lab::compile;
    use crate::lab::site::Recorded;

    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let (mut learned, mut accepted) = (0usize, 0usize);
    let mut refused: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    let (mut walks_compared, mut same_outcome) = (0usize, 0usize);
    let (mut both_reach, mut neither, mut lab_only, mut replay_only) = (0usize, 0usize, Vec::new(), Vec::new());
    let mut unfilled: Vec<String> = Vec::new();
    let mut shadowed: Vec<String> = Vec::new();
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let Ok(body) = compile::learn(&walks, site) else { continue };
        learned += 1;
        let graph = match to_graph(&body) {
            Ok(graph) => graph,
            Err(unsaid) => {
                println!("{site}: refused: {unsaid}");
                refused.entry(unsaid.why).or_default().push(site.clone());
                continue;
            }
        };
        accepted += 1;
        let at = crate::body::exchange_of(&body.answer.step).expect("a learned answer names a call of the first walk");
        let found = Lab::new(&walks).sightings(at);
        let mut said = Vec::new();
        for (k, walk) in walks.iter().enumerate() {
            let Some(sighting) = found[k] else { continue };
            let slots: std::collections::HashMap<String, String> = walk.asked.iter().cloned().collect();
            let jar: std::collections::HashMap<String, String> = crate::lab::sighting::jar_of(walk, sighting);
            // The learner's own caller.
            let ours = call(&body, &slots, &jar, 0, &mut Recorded { walk });
            // Gate A: the body and the body its graph says fill alike, with the replies the recording gave.
            let heard: Vec<(String, Option<usize>)> = match &ours {
                Ok(called) => called.heard.clone(),
                Err(_) => Vec::new(),
            };
            let replies: std::collections::HashMap<String, &crate::trace::Exchange> = heard.iter().filter_map(|(id, at)| Some((id.clone(), walk.trace.exchanges.get((*at)?)?))).collect();
            let upto = if ours.is_ok() { body.steps.len() } else { body.steps.len().min(replies.len() + 1) };
            let mut world = Hand { slots: slots.clone(), jar: jar.clone(), replies, now: 1_794_398_400_000 };
            for d in differs(&body, &graph, &mut world, upto) {
                unfilled.push(format!("{site} walk {}: {d}", k + 1));
            }
            // Gate B: the node's own caller, over the recording.
            let mut transport = Answering { walk, body: &body, jar: &jar, heard: Vec::new(), sent: Vec::new() };
            let theirs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| crate::replay::replay(&graph, &slots, &mut transport).map(|_| ()).map_err(|e| e.to_string())));
            let theirs = match theirs {
                Ok(outcome) => outcome,
                Err(panic) => {
                    let said = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                    shadowed.push(format!("{site} walk {}: {said}", k + 1));
                    continue;
                }
            };
            walks_compared += 1;
            let ours_at = ours.as_ref().ok().and_then(|c| c.heard.last().and_then(|(_, at)| *at));
            let theirs_at = transport.heard.last().and_then(|(_, at)| *at).filter(|_| theirs.is_ok());
            let same = ours.is_ok() == theirs.is_ok() && ours_at == theirs_at;
            same_outcome += usize::from(same);
            match (ours.is_ok(), theirs.is_ok()) {
                (true, true) => both_reach += 1,
                (false, false) => neither += 1,
                (true, false) => lab_only.push(format!("{site} walk {}", k + 1)),
                (false, true) => replay_only.push(format!("{site} walk {}", k + 1)),
            }
            said.push(format!(
                "walk {}: the learner's caller {}, replay {}{}",
                k + 1,
                if ours.is_ok() { "reaches its answer".to_string() } else { "does not".to_string() },
                match &theirs {
                    Ok(()) => "reaches its answer".to_string(),
                    Err(why) => format!("does not: {}", why.chars().take(300).collect::<String>()),
                },
                if same {
                    String::new()
                } else {
                    let size = |at: Option<usize>| at.and_then(|i| walk.trace.exchanges.get(i)).map_or(0, |e| e.response_body.as_deref().map_or(0, str::len));
                    format!(" (they differ: the recording answered the learner's caller with its call {ours_at:?} of {} bytes, and replay's last ask with {:?}; the walk's own sighting is {sighting}, of {} bytes)", size(ours_at), transport.heard.last().and_then(|(_, at)| *at), size(Some(sighting)))
                }
            ));
        }
        println!("{site}: {} steps said as a graph\n    {}", graph.steps.len(), said.join("\n    "));
    }
    let not: usize = refused.values().map(Vec::len).sum();
    println!(
        "\n{learned} bodies learned; {accepted} said as a graph, {not} refused: {}",
        refused.iter().map(|(why, sites)| format!("\n    {} {why} {sites:?}", sites.len())).collect::<String>()
    );
    println!(
        "of the accepted, {walks_compared} walks replayed: on {same_outcome} replay comes to the same answer as the learner's caller ({both_reach} both reach it, {neither} neither); the learner's caller alone on {lab_only:?}, replay alone on {replay_only:?}"
    );
    println!("gate A: {} steps fill otherwise through the graph {unfilled:?}; the filler and replay differ on {} walks {shadowed:?}", unfilled.len(), shadowed.len());
    assert!(unfilled.is_empty() && shadowed.is_empty(), "the graph fills otherwise than the body: {unfilled:?}; replay and the filler differ: {shadowed:?}");
}

/// The node's caller runs each body the learner writes as a body (`replay_body`), and where a graph says the body, as
/// it runs that graph (`replay`), and as it runs that graph said back as a body with nothing laid over it
/// (`body::overlay`): over each walk's recording, with the walk's values and the jar its answer was asked with, the
/// clock held, the same requests go out and the call comes to the same end, on every walk. And the body laid over its
/// own graph lays nothing: a graph says every hole of it. Prints the counts; a difference fails the test.
#[test]
fn a_learned_body_runs_as_the_graph_it_says_runs() {
    let _offline = crate::http::offline();
    use crate::body::to_graph;
    use crate::lab::compile;
    use crate::replay::{replay, replay_body, HttpReplay, ReplayError};

    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let (mut learned, mut accepted, mut walks_run, mut requests, mut answered, mut refused, mut overlaid) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
    let mut ends: BTreeMap<String, usize> = BTreeMap::new();
    let mut differing: Vec<String> = Vec::new();
    crate::fresh::HELD.with(|held| held.set(Some(1_794_398_400_000)));
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let Ok(body) = compile::learn(&walks, site) else { continue };
        learned += 1;
        let Ok(graph) = to_graph(&body) else { continue };
        accepted += 1;
        let laid = crate::body::overlay(&graph, Some(&body));
        if !laid.laid.is_empty() || !laid.dropped.is_empty() {
            differing.push(format!("{site}: the body laid over its own graph lays {:?} and drops {:?}", laid.laid, laid.dropped));
        }
        let graphs_own = crate::body::overlay(&graph, None).body;
        let at = crate::body::exchange_of(&body.answer.step).expect("a learned answer names a call of the first walk");
        let found = Lab::new(&walks).sightings(at);
        for (k, walk) in walks.iter().enumerate() {
            let Some(sighting) = found[k] else { continue };
            let slots: std::collections::HashMap<String, String> = walk.asked.iter().cloned().collect();
            let jar: std::collections::HashMap<String, String> = crate::lab::sighting::jar_of(walk, sighting);
            let end = |r: Result<HttpReplay, ReplayError>| match r {
                Ok(called) => Ok(format!("{:?} {:?} {}", called.steps, called.rungs, called.target.status)),
                Err(e) => Err(e.to_string()),
            };
            let mut by_body = Answering { walk, body: &body, jar: &jar, heard: Vec::new(), sent: Vec::new() };
            let mut by_graph = Answering { walk, body: &body, jar: &jar, heard: Vec::new(), sent: Vec::new() };
            let ours = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| end(replay_body(&body, &slots, &mut by_body))));
            let theirs = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| end(replay(&graph, &slots, &mut by_graph))));
            // The recording is read as the learned body reads it (which places it sends as walked, open), on every run:
            // what is compared is what each run sends.
            let mut by_overlay = Answering { walk, body: &body, jar: &jar, heard: Vec::new(), sent: Vec::new() };
            let laid_over = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| end(replay_body(&graphs_own, &slots, &mut by_overlay))));
            match (&ours, &laid_over) {
                (Ok(ours), Ok(laid)) if ours == laid && by_body.sent == by_overlay.sent => overlaid += 1,
                _ => differing.push(format!("{site} walk {}: the graph said back as a body runs otherwise: {} against {} requests, {laid_over:?}", k + 1, by_overlay.sent.len(), by_body.sent.len())),
            }
            walks_run += 1;
            let (Ok(ours), Ok(theirs)) = (ours, theirs) else {
                differing.push(format!("{site} walk {}: a run panicked", k + 1));
                continue;
            };
            if by_body.sent != by_graph.sent {
                let n = by_body.sent.iter().zip(&by_graph.sent).position(|(a, b)| a != b).unwrap_or(by_body.sent.len().min(by_graph.sent.len()));
                differing.push(format!("{site} walk {}: request {} differs ({} against {} sent)", k + 1, n + 1, by_body.sent.len(), by_graph.sent.len()));
            } else if ours != theirs {
                differing.push(format!("{site} walk {}: the same {} requests, and the body ends {ours:?}, the graph {theirs:?}", k + 1, by_body.sent.len()));
            } else {
                requests += by_body.sent.len();
                answered += usize::from(ours.is_ok());
                refused += usize::from(ours.is_err());
                let kind = match &ours {
                    Ok(_) => "answered".to_string(),
                    Err(e) => e.split([':', '(']).next().unwrap_or_default().trim().chars().take(60).collect(),
                };
                *ends.entry(kind).or_default() += 1;
            }
        }
    }
    crate::fresh::HELD.with(|held| held.set(None));
    println!(
        "\n{learned} bodies learned, {accepted} said as a graph; {walks_run} walks run both ways: {requests} requests compared, {answered} answered alike, {refused} refused alike; {overlaid} walks run alike by the graph said back as a body; {} differ {differing:?}",
        differing.len()
    );
    println!("how the walks run alike end: {ends:?}");
    assert!(differing.is_empty(), "a body runs otherwise than the graph it says: {differing:?}");
}

/// The site's four tests (`lab::verify`), asked of each learned body over the first walk's recording: the walk's own
/// value, the second walk's as the second value, and a nonsense value. A recording holds the walk's own ask and
/// almost no other, so most second and nonsense asks come back unheard, and the test counts how many bodies the
/// recording can judge at all beside the verdicts it reaches. It judges nothing: both walks are what the body was
/// learned from, so this is the recording answering what it holds. Prints.
///
/// `UNBROWSE_CORPUS=<folder> cargo test -p unbrowse-node-app ... ` is the node's; here it is the learn crate's own.
#[test]
fn the_sites_tests_over_each_walks_recording() {
    let _offline = crate::http::offline();
    use crate::lab::verify::{verify, Outcome, Test};

    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let (mut learned, mut judged) = (0usize, 0usize);
    let mut tally: BTreeMap<(Test, &'static str), usize> = BTreeMap::new();
    let mut exceptions: Vec<String> = Vec::new();
    let word = |o: &Outcome| match o {
        Outcome::Held(_) => "held",
        Outcome::FillsForAny(_) => "fills in for any word",
        Outcome::CouldNotAsk(_) => "could not ask",
        Outcome::Failed(_) => "failed",
    };
    crate::fresh::HELD.with(|held| held.set(Some(1_794_398_400_000)));
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let Ok(body) = crate::lab::compile::learn(&walks, site) else { continue };
        learned += 1;
        let at = crate::body::exchange_of(&body.answer.step).expect("a learned answer names a call of the first walk");
        let lab = Lab::new(&walks);
        let Some(sighting) = lab.sightings(at)[0] else { continue };
        let walked: std::collections::HashMap<String, String> = walks[0].asked.iter().cloned().collect();
        let second_value: std::collections::HashMap<String, String> = walks[1].asked.iter().cloned().collect();
        let jar = crate::lab::sighting::jar_of(&walks[0], sighting);
        let verdict = verify(&body, &walked, Some(&second_value), &jar, 1_794_398_400_000, &mut crate::lab::site::Recorded { walk: &walks[0] });
        if verdict.checks.iter().any(|(t, o)| *t == Test::WalksOwnValue && o.held()) {
            judged += 1;
        }
        for (test, outcome) in &verdict.checks {
            *tally.entry((*test, word(outcome))).or_default() += 1;
            if *test == Test::WalksOwnValue {
                if let Outcome::Failed(why) | Outcome::CouldNotAsk(why) = outcome {
                    exceptions.push(format!("{site}: {} ({why})", word(outcome)));
                }
            }
        }
    }
    crate::fresh::HELD.with(|held| held.set(None));
    println!("\n{learned} bodies learned; the recording answers the walk's own value for {judged} of them. The verdicts the recording can reach, by test:");
    for test in [Test::WalksOwnValue, Test::SecondValue, Test::NonsenseValue, Test::NoWriteTwice] {
        let by: Vec<String> = tally.iter().filter(|((t, _), _)| *t == test).map(|((_, w), n)| format!("{n} {w}")).collect();
        println!("    {}: {}", test.name(), by.join(", "));
    }
    println!("where the walk's own value did not simply hold: {exceptions:?}");
    // The recording can judge the walk's own value for most bodies learned from it; where it cannot, it is said, not
    // a silent pass. The second and nonsense values are another walk's or a made-up one, which the recording does not
    // hold: this test is read, not a live judgement.
    assert!(judged * 2 >= learned, "the recording judges the walk's own value for most bodies: {judged} of {learned}");
}

/// What shrinking would try of each body the learner writes from a site's two walks (`lab::shrink::candidates`), with
/// no site asked: the candidate list alone, by kind, and beside it the parts a door reads that are never tried. Prints.
#[test]
fn what_shrinking_would_try_of_each_learned_body() {
    let _offline = crate::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(PathBuf::from) else { return };
    let sites = by_site(&corpus);
    let mut by_kind: BTreeMap<&'static str, usize> = BTreeMap::new();
    let (mut learned, mut headers, mut cookies) = (0usize, 0usize, 0usize);
    for (site, cases) in &sites {
        let [first, second, ..] = cases.as_slice() else { continue };
        let walks = [Walk { trace: &first.trace, asked: asked(first), session: 1 }, Walk { trace: &second.trace, asked: asked(second), session: 1 }];
        let Ok(body) = crate::lab::compile::learn(&walks, site) else { continue };
        learned += 1;
        let parts = crate::lab::shrink::candidates(&body);
        for part in &parts {
            *by_kind.entry(part.kind()).or_default() += 1;
        }
        let holes = body.steps.iter().flat_map(|s| &s.holes);
        headers += holes.clone().filter(|h| matches!(h.at, route::Place::Header(_))).count();
        cookies += holes.filter(|h| matches!(h.at, route::Place::Cookie(_))).count();
        println!("{site}: {} to try: {}", parts.len(), parts.iter().map(|p| p.say()).collect::<Vec<_>>().join("; "));
    }
    let tried: usize = by_kind.values().sum();
    println!("\n{learned} bodies learned; {tried} parts shrinking would try, by kind: {by_kind:?}; of their {headers} headers and {cookies} cookies, the browser's own, the body's framing and every cookie are never tried");
}

#[cfg(test)]
#[path = "corpus_tests.rs"]
mod corpus_tests;
