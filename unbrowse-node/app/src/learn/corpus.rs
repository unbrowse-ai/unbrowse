//! Kept walks, read again with no site asked.
//!
//! A change to picking, to inputs or to default fields is judged on the site in front of it and can undo another. The
//! walk is the asset: its capture, kept with the page and the goal it was walked for, reads offline as it read live
//! (`walk_pick`, `route_of` and `fields::defaults_on` are the live learn's own), so the learner runs over every kept
//! walk in seconds and no site is asked.
//!
//! A corpus is a folder of cases. It lives outside the repository: a capture holds the session that walked.
//!
//! ```text
//! <corpus>/<case>/case.json           {"url": "...", "goal": "..."}
//! <corpus>/<case>/learn_<walk>.jsonl  the walk's capture, as the node wrote it
//! <corpus>/<case>/learned.json        what the learner read from it, once kept
//! ```
//!
//! `UNBROWSE_CORPUS=<folder> cargo test -p unbrowse-node-app the_corpus_reads_as_it_was_kept -- --nocapture` reads
//! every case and fails on each that reads otherwise than its `learned.json`. `UNBROWSE_CORPUS_KEEP=1` writes what is
//! read now as `learned.json` instead: for a case's first reading, or once a change is meant. With no corpus named
//! there is nothing to read and the test passes.

use super::*;

/// What the learner reads from one walk, in the words a person compares: the call, who picked it, the caller's
/// values and the fields a call of it hands back.
#[derive(Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct Learned {
    /// The call kept: its method, host and path, without its query.
    pub call: String,
    pub by: String,
    pub inputs: Vec<String>,
    /// The fields a call hands back by default, when the walk's answer is data.
    pub fields: Vec<String>,
    /// Why nothing was kept, when nothing was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none: Option<String>,
}

/// The learn of `pick_and_keep`, from the walk alone: no model, no agent's rejection, no trial against the site.
///
/// `visited` is what the kept capture records of where its browser was (`walk::addresses_from_walk`), read as a live
/// walk's is: a capture without a whole record is None, a walk that may have been at an address with a fragment.
pub(super) fn read(url: &str, goal: &str, mut trace: Trace, probes: &[unbrowse_learn::trace::Probe], visited: Option<&[String]>) -> Learned {
    let none = |why: String| Learned { none: Some(why), ..Learned::default() };
    let Some(host) = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)) else { return none("not a URL".into()) };
    if let Err(why) = by_loading(goal) {
        return none(why);
    }
    if let Some(why) = page_unreached(&trace, url) {
        return none(why.to_string());
    }
    let site = walked_site(&trace.exchanges, &host);
    let view = view_of("corpus", url, &site, &trace, 0);
    let (in_path, _) = path_inputs(url, goal, &trace);
    let query_values = asked_values(url, &in_path);
    let pick = {
        let scores = rule_scores(&trace, &view, goal, &query_values, &[]);
        let shown = page_shown(&trace.exchanges, url, &[]);
        let passes = |i: usize| may_answer(&trace, i, goal, url, &query_values, &shown, &view.site);
        walk_pick(&trace, &view, goal, &query_values, scores, &passes, None)
    };
    let Some((index, by, _)) = pick else { return none(NEEDS_HANDS.into()) };
    let picked = trace.exchanges[index].clone();
    trace.inputs = walk_inputs(url, &in_path, &trace.exchanges);
    let route = match route_of(&trace, index, goal, url, true, probes, &[], visited) {
        Ok(route) => route,
        Err(why) => return none(why),
    };
    if let Some(why) = the_walk_found_nothing(&trace, index, &route, url, &query_values) {
        return none(why);
    }
    // The fields, as a first call of the route chooses them (`run`): from the answer, by what the caller asked for.
    let asked: Vec<String> = route.inputs.iter().filter(|i| !i.secret && !i.file).filter_map(|i| i.default.clone()).filter(|v| !unbrowse_learn::slots::bound_by_key(v)).collect();
    let fields = picked.own_json().map(|v| unbrowse_learn::fields::defaults_on(&unbrowse_learn::fields::paths(&v), goal, &asked, &route.root)).unwrap_or_default();
    Learned {
        call: format!("{} {}{}", picked.method, picked.url.host_str().unwrap_or_default(), picked.url.path()),
        by: by.into(),
        inputs: route.inputs.iter().map(|i| i.name.clone()).collect(),
        fields,
        none: None,
    }
}

/// One case of a corpus read now, beside what was kept for it: `Err` says why the folder is no case.
fn read_case(dir: &std::path::Path) -> Result<(Learned, Option<Learned>), String> {
    let case: serde_json::Value = std::fs::read_to_string(dir.join("case.json")).map_err(|e| format!("no case.json: {e}")).and_then(|t| serde_json::from_str(&t).map_err(|e| format!("case.json: {e}")))?;
    let said = |key: &str| case.get(key).and_then(|v| v.as_str()).map(String::from).ok_or(format!("case.json names no {key}"));
    let (url, goal) = (said("url")?, said("goal")?);
    let capture = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl")).ok_or("no capture")?;
    let session = capture.file_stem().and_then(|s| s.to_str()).ok_or("the capture has no name")?;
    let trace = trace_from_walk(dir, session).ok_or("the capture holds no walk")?;
    let probes = unbrowse_learn::walk::probes_from_walk(dir, session);
    let kept = std::fs::read_to_string(dir.join("learned.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
    // Where the kept walk's browser was, as its capture records it: never assumed clean.
    let visited = unbrowse_learn::walk::addresses_from_walk(dir, session);
    Ok((read(&url, &goal, trace, &probes, visited.as_deref()), kept))
}

#[test]
fn the_corpus_reads_as_it_was_kept() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    let keep = std::env::var_os("UNBROWSE_CORPUS_KEEP").is_some();
    store::scratch_home("corpus");
    let mut cases: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    cases.sort();
    let (mut same, mut new, mut changed) = (0, 0, Vec::new());
    for dir in &cases {
        let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
        match read_case(dir) {
            Err(why) => changed.push(format!("{name}: {why}")),
            Ok((now, kept)) => {
                let said = |l: &Learned| l.none.clone().map(|why| format!("nothing ({why})")).unwrap_or_else(|| format!("{} by {}, inputs {:?}, fields {:?}", l.call, l.by, l.inputs, l.fields));
                match &kept {
                    Some(was) if *was == now => same += 1,
                    Some(was) if !keep => changed.push(format!("{name}:\n    was {}\n    now {}", said(was), said(&now))),
                    _ => {
                        new += 1;
                        println!("{name}: {}", said(&now));
                    }
                }
                if keep {
                    std::fs::write(dir.join("learned.json"), serde_json::to_string_pretty(&now).expect("a reading is JSON")).expect("the case folder takes its reading");
                }
            }
        }
    }
    println!("corpus: {} cases, {same} read as kept, {new} read for the first time{}, {} read otherwise", cases.len(), if keep { " or kept anew" } else { "" }, changed.len());
    assert!(changed.is_empty(), "walks that read otherwise than they were kept:\n{}", changed.join("\n"));
}

/// Each site's two walks held against each other: for the first walk's candidates, what the second walk says of
/// them, and what the first walk alone picked. Prints; it judges nothing. `UNBROWSE_CORPUS` as above.
#[test]
fn what_a_second_walk_says_of_each_sites_calls() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-pairs");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, Trace)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        by_site.entry(said("site")).or_default().push((said("url"), said("goal"), trace));
    }
    for (site, walks) in &by_site {
        let [(url, goal, first), (other_url, _, second)] = &walks[..] else { continue };
        let (a, b) = experiment::asked_apart(url, other_url);
        let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let view = view_of("pairs", url, &walked_site(&first.exchanges, &host), first, 0);
        // No record of where the kept walk's browser was is handed on: the route read here is guarded, as a walk
        // that can't say is, and is only compared, never kept or listed.
        let picked = read(url, goal, first.clone(), &[], None);
        let mut tally = [0usize; 3];
        let mut hears = Vec::new();
        for c in &view.candidates {
            let t = experiment::told(first, c.index, &a, second, &b);
            tally[t as usize] += 1;
            if t == experiment::Told::Hears {
                hears.push(format!("{} {}{}", c.method, c.host, bare(&c.path)));
            }
        }
        let its = view.candidates.iter().find(|c| picked.call == format!("{} {}{}", c.method, c.host, bare(&c.path))).map(|c| experiment::told(first, c.index, &a, second, &b));
        println!("{site}: asked {a:?} then {b:?}; picked {} ({its:?}); hears {} deaf {} unseen {}", if picked.call.is_empty() { "nothing" } else { &picked.call }, tally[0], tally[1], tally[2]);
        for h in hears.iter().take(4) {
            println!("    hears: {h}");
        }
    }
}

/// Where the trial finds no second word today (the page's own links and the answers' longer wordings offer none),
/// what the first answer's records share (`lab::answer::shared_words`, `trial::offered_words`' third source), over
/// each site's two walks. For each such site that now gets a word, whether the route says it back: offline, over the
/// second walk's recording where the second walk was asked one of those words, and otherwise it cannot tell. Prints.
#[test]
fn what_the_records_offer_where_the_trial_finds_no_word() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-shared-words");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, Trace)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        by_site.entry(said("site")).or_default().push((said("url"), said("goal"), trace));
    }
    let asked_of = |url: &str, goal: &str, trace: &Trace| -> Vec<String> { walk_inputs(url, &path_inputs(url, goal, trace).0, &trace.exchanges).into_iter().map(|i| i.value).collect() };
    let (mut sites, mut none_today, mut now_one, mut said_back, mut not_said_back, mut cannot_tell) = (0usize, 0usize, 0usize, Vec::new(), Vec::new(), 0usize);
    for (site, walks) in &by_site {
        let [(url, goal, first), (other_url, other_goal, second), ..] = &walks[..] else { continue };
        sites += 1;
        let asked = asked_of(url, goal, first);
        if !super::trial::offered_without_records(first, url, &asked).is_empty() {
            continue;
        }
        none_today += 1;
        let words = unbrowse_learn::lab::answer::shared_words(first, url, &asked);
        if words.is_empty() {
            println!("{site}: asked {asked:?}; the records share no word either");
            continue;
        }
        now_one += 1;
        let second_asked = asked_of(other_url, other_goal, second);
        let tellable = words.iter().find(|w| second_asked.iter().any(|a| a.eq_ignore_ascii_case(w)));
        let verdict = match tellable {
            Some(word) => {
                let lines = (0..second.exchanges.len()).map(|i| unbrowse_learn::lab::answer::says_back(second, i, std::slice::from_ref(word))).max().unwrap_or(0);
                if lines >= 2 {
                    said_back.push(site.clone());
                    format!("the second walk was asked {word:?}, and its answer says it back on {lines} lines")
                } else {
                    not_said_back.push(site.clone());
                    format!("the second walk was asked {word:?}, and its answer says it on {lines} line(s)")
                }
            }
            None => {
                cannot_tell += 1;
                format!("cannot tell: the second walk was asked {second_asked:?}")
            }
        };
        println!("{site}: asked {asked:?}; the records share {:?}; {verdict}", words.iter().take(8).collect::<Vec<_>>());
    }
    println!("\n{sites} sites walked twice; the trial finds no word today on {none_today}; the records now offer one on {now_one}: said back on {} {said_back:?}, not on {} {not_said_back:?}, cannot tell on {cannot_tell}", said_back.len(), not_said_back.len());
}

/// The plan a body keeps, over each site's two walks: the body the lab learns from them, and its plan written two
/// ways: from the first walk alone (one walk's reading of what its address was asked, as the node read it before),
/// and from what the two walks' first main-frame documents differ by (`compile::plan_of` with the other walk, as the
/// node now writes it). For each, the page the plan writes for the second walk's word, set beside the page the second
/// walk went to; the one-walk plan beside the trial's page too (`experiment::for_another_word`). The first walk's page
/// is its own address, the second's its first main-frame document, as the node holds them. Offline: the path's
/// values are read as the walk reads them, where the node first asks the site which pieces are the caller's
/// (`trial::callers_own`). Prints.
#[test]
fn the_page_a_bodys_plan_writes_for_the_second_word() {
    let _offline = unbrowse_learn::http::offline();
    use unbrowse_learn::lab::{compile, kept, sighting::Walk, synth::Lab};
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-plans");
    let (mut sites, mut bodies, mut as_the_trial) = (0usize, 0usize, 0usize);
    let (mut before, mut after, mut before_bytes, mut after_bytes, mut by_two) = (0usize, 0usize, 0usize, 0usize, 0usize);
    // The goal each walk was asked for, by its page: the node reads the path's values with it (`path_inputs`).
    let goals: std::collections::HashMap<String, String> = std::fs::read_dir(&corpus)
        .expect("the corpus folder")
        .flatten()
        .filter_map(|f| std::fs::read_to_string(f.path().join("case.json")).ok())
        .filter_map(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter_map(|c| Some((c.get("url")?.as_str()?.to_string(), c.get("goal")?.as_str()?.to_string())))
        .collect();
    // Two addresses are the same page where they read the same: host, path pieces, query and fragment pairs, each
    // decoded (`%20` and `+` are one space).
    let read = |at: &str| {
        url::Url::parse(at).ok().map(|u| {
            let pieces: Vec<String> = u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default();
            let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
            let fragment: Vec<(String, String)> = url::form_urlencoded::parse(u.fragment().unwrap_or_default().as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
            (u.host_str().map(String::from), pieces, pairs, fragment)
        })
    };
    for (site, cases) in kept::by_site(&corpus) {
        let [first, second, ..] = &cases[..] else { continue };
        sites += 1;
        let Some(at) = kept::kept_call(first) else { continue };
        // What the node asks the page, as `route_of_by` takes it: the address's own values and the path's.
        let asked_of = |case: &kept::Case| -> Vec<(String, String)> {
            let goal = goals.get(&case.url).cloned().unwrap_or_default();
            walk_inputs(&case.url, &path_inputs(&case.url, &goal, &case.trace).0, &case.trace.exchanges).into_iter().map(|i| (i.name, i.value)).collect()
        };
        let asked = asked_of(first);
        let goal = goals.get(&first.url).cloned().unwrap_or_default();
        let walks = [Walk { trace: &first.trace, asked: asked.clone(), session: 1 }, Walk { trace: &second.trace, asked: asked_of(second), session: 1 }];
        if compile::route(&Lab::new(&walks), at, &site).is_none() {
            continue;
        }
        bodies += 1;
        // The page each walk went to, as the node reads it: its first main-frame document on the page's own site.
        let went_to = |case: &kept::Case| -> String {
            let host = url::Url::parse(&case.url).ok().and_then(|u| u.host_str().map(String::from));
            case.trace.exchanges.iter().find(|e| e.is_main_document() && e.url.host_str().map(String::from) == host).map(|e| e.url.to_string()).unwrap_or_else(|| case.url.clone())
        };
        let (Some(one), Some(two)) = (compile::plan_of(&first.url, &[], &goal, &asked, &[], Vec::new()), compile::plan_of(&first.url, &[&went_to(second)], &goal, &asked, &[], Vec::new())) else { continue };
        let values: Vec<String> = asked.iter().map(|(_, v)| v.clone()).collect();
        let (ours_one, ours_two) = (compile::page_for_another_word(&one, &second.value), compile::page_for_another_word(&two, &second.value));
        as_the_trial += usize::from(ours_one == super::experiment::for_another_word(&first.url, &values, &second.value));
        let is_the_page = |ours: &Option<String>| ours.as_deref().and_then(read).is_some_and(|o| Some(o) == read(&second.url));
        let (was, is) = (is_the_page(&ours_one), is_the_page(&ours_two));
        before += usize::from(was);
        after += usize::from(is);
        before_bytes += usize::from(ours_one.as_deref() == Some(second.url.as_str()));
        after_bytes += usize::from(ours_two.as_deref() == Some(second.url.as_str()));
        by_two += usize::from(two.asked.iter().any(|a| a.by == unbrowse_learn::route::AskedBy::TwoWalks));
        let mark = |b: bool| if b { "the page" } else { "NOT the page" };
        println!(
            "{site}: one walk {} ({}), two walks {} ({}, asked {:?}); for {:?} the two-walk plan writes {:?}; the second walk went to {}",
            mark(was),
            one.page,
            mark(is),
            two.page,
            two.asked.iter().map(|a| format!("{} by {:?}", a.slot, a.by)).collect::<Vec<_>>(),
            second.value,
            ours_two,
            second.url
        );
    }
    println!("\n{sites} sites walked twice; {bodies} bodies learned; {by_two} plans from two walks; the one-walk plan as the trial builds it on {as_the_trial} of {bodies}");
    println!("the page the second walk went to, read decoded: one walk {before} of {bodies}, two walks {after} of {bodies}; byte for byte: one walk {before_bytes}, two walks {after_bytes}");
}

/// How long the routes of the kept walks are, and how many the least chain would shorten (`the_least_chain`): the
/// target and the reads on its own site that fill its address and body, nothing else. Offline: no site is asked, so
/// this counts what would be tried shorter, not what a site then bears out. Prints; it judges nothing.
#[test]
fn how_many_kept_routes_the_least_chain_would_shorten() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-chains");
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort();
    let (mut routes, mut long, mut shorter, mut steps_before, mut steps_after, mut signed) = (0, 0, 0, 0, 0, 0);
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let (url, goal) = (said("url"), said("goal"));
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        let learned = read(&url, &goal, trace.clone(), &[], None);
        let Some(index) = trace.exchanges.iter().rposition(|e| format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path()) == learned.call) else { continue };
        let mut walked = trace.clone();
        let (in_path, _) = path_inputs(&url, &goal, &walked);
        walked.inputs = walk_inputs(&url, &in_path, &[]);
        let Ok(route) = route_of(&walked, index, &goal, &url, true, &[], &[], None) else { continue };
        routes += 1;
        let n = route.graph.steps.len();
        signed += usize::from(route.graph.steps.iter().any(|s| s.is_page_signed()));
        if n < 2 {
            continue;
        }
        long += 1;
        steps_before += n;
        let least = the_least_chain(&route.graph, &walked).map_or(n, |g| g.steps.len());
        steps_after += least;
        if least < n {
            shorter += 1;
            println!("{}: {n} steps -> {least}", dir.file_name().and_then(|f| f.to_str()).unwrap_or_default());
        }
    }
    println!("routes built {routes}; with a step the page makes {signed}; of more than one step {long}; the least chain is shorter for {shorter}; their steps {steps_before} -> {steps_after}");
}

/// What a call must change to ask for another value, measured: the parts of the picked request that differ between a
/// site's two walks, beside what the learner made of each from the first walk alone. Prints; it judges nothing.
#[test]
fn what_the_picked_call_changes_between_two_values() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-params");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, Trace)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        by_site.entry(said("site")).or_default().push((said("url"), said("goal"), trace));
    }
    // A request's parts, each with where it sits: query, path piece, body leaf.
    let parts = |e: &Exchange| -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = e.url.query_pairs().map(|(k, v)| (format!("query {k}"), v.into_owned())).collect();
        out.extend(e.url.path_segments().into_iter().flatten().enumerate().map(|(n, p)| (format!("path {n}"), percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned())));
        if let Some(body) = e.request_body.as_deref() {
            match serde_json::from_str::<serde_json::Value>(body) {
                Ok(v) => out.extend(unbrowse_learn::slots::json_leaves(&v).into_iter().map(|(k, v)| (format!("body {k}"), v))),
                Err(_) => out.extend(url::form_urlencoded::parse(body.as_bytes()).map(|(k, v)| (format!("form {k}"), v.into_owned()))),
            }
        }
        out
    };
    let fold = |v: &str| v.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    for (site, walks) in &by_site {
        let [(url, goal, first), (other_url, _, second)] = &walks[..] else { continue };
        let (a, b) = experiment::asked_apart(url, other_url);
        // No record of where either kept walk's browser was is handed on: the routes read here are guarded, and only
        // compared.
        let (one, two) = (read(url, goal, first.clone(), &[], None), read(other_url, goal, second.clone(), &[], None));
        if one.none.is_some() || two.none.is_some() {
            println!("{site}: NOPICK");
            continue;
        }
        let strike = |call: &str, asked: &[String]| asked.iter().fold(percent_encoding::percent_decode_str(call).decode_utf8_lossy().to_lowercase(), |c, v| c.replace(&v.to_lowercase(), "\u{a7}"));
        if strike(&one.call, &a) != strike(&two.call, &b) {
            println!("{site}: OTHERCALL {} || {}", one.call, two.call);
            continue;
        }
        let find = |t: &Trace, l: &Learned| t.exchanges.iter().rposition(|e| format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path()) == l.call);
        let (Some(i), Some(j)) = (find(first, &one), find(second, &two)) else { continue };
        let mut trace = first.clone();
        let (in_path, _) = path_inputs(url, goal, &trace);
        trace.inputs = walk_inputs(url, &in_path, &trace.exchanges);
        let Ok(route) = route_of(&trace, i, goal, url, true, &[], &[], None) else { continue };
        let fields: Vec<serde_json::Value> = route.graph.steps.last().and_then(|s| serde_json::to_value(s).ok()).and_then(|s| s.get("fields").and_then(|f| f.as_array()).cloned()).unwrap_or_default();
        let (pa, pb) = (parts(&first.exchanges[i]), parts(&second.exchanges[j]));
        let mut lines = Vec::new();
        for (k, va) in &pa {
            let Some((_, vb)) = pb.iter().find(|(key, _)| key == k) else { continue };
            if va == vb || va.is_empty() {
                continue;
            }
            // How the part relates to what the page was asked: the value itself, the value written another way, the
            // value inside something longer, or nothing of it.
            let relation = if a.iter().any(|v| v == va) {
                "the value"
            } else if a.iter().any(|v| fold(v) == fold(va)) {
                "the value, written otherwise"
            } else if a.iter().any(|v| fold(v).len() >= 2 && fold(va).contains(&fold(v))) {
                "holds the value"
            } else {
                "unrelated"
            };
            // What the learner made of it: the class of each field of the kept step that carries the walked value.
            let escaped = serde_json::to_string(va).unwrap_or_default();
            let needle = escaped.trim_matches('"');
            let mut classes: Vec<String> = fields.iter().filter(|f| f.to_string().contains(needle)).map(|f| f.get("class").and_then(|c| c.as_str()).unwrap_or("?").to_string()).collect();
            // The caller's word written again inside a longer value (`Step::held`) varies too, whatever the field's class.
            if route.graph.steps.last().is_some_and(|st| st.held.iter().any(|h| va.contains(&h.sits) && format!("{}", h.loc).split(' ').next_back().is_some_and(|key| k.ends_with(key)))) {
                classes.push("held".into());
            }
            classes.sort();
            classes.dedup();
            lines.push(format!("    {} | {relation} | {} | {:.40} -> {:.40}", k, if classes.is_empty() { "no field".to_string() } else { classes.join("+") }, va, vb));
        }
        println!("{site}: SAME {} asked {a:?}->{b:?} inputs {:?} differing {}", one.call, route.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), lines.len());
        lines.iter().take(14).for_each(|l| println!("{l}"));
    }
}

/// The answer two walks agree on (`experiment::answer_of_two`), read from each walk in turn beside what one walk
/// alone picked. Prints; it judges nothing. `UNBROWSE_CORPUS` as above.
#[test]
fn what_two_walks_agree_the_answer_is() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-agree");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, Trace)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        by_site.entry(said("site")).or_default().push((said("url"), said("goal"), trace));
    }
    let strike = |call: &str, asked: &[String]| asked.iter().fold(percent_encoding::percent_decode_str(call).decode_utf8_lossy().to_lowercase(), |c, v| c.replace(&v.to_lowercase(), "\u{a7}"));
    for (site, walks) in &by_site {
        let [(url, goal, first), (other_url, _, second)] = &walks[..] else { continue };
        let (a, b) = experiment::asked_apart(url, other_url);
        let agreed = |url: &str, t: &Trace, asked: &[String], other: &Trace, other_asked: &[String]| -> Option<String> {
            let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
            let view = view_of("agree", url, &walked_site(&t.exchanges, &host), t, 0);
            let shown = page_shown(&t.exchanges, url, &[]);
            let candidates: Vec<(usize, bool)> = view.candidates.iter().filter(|c| may_answer(t, c.index, goal, url, asked, &shown, &view.site)).map(|c| (c.index, c.page)).collect();
            experiment::answer_of_two(t, &candidates, asked, other, other_asked).map(|i| format!("{} {}{}", t.exchanges[i].method, t.exchanges[i].url.host_str().unwrap_or_default(), t.exchanges[i].url.path()))
        };
        let (from_a, from_b) = (agreed(url, first, &a, second, &b), agreed(other_url, second, &b, first, &a));
        let (one_a, one_b) = (read(url, goal, first.clone(), &[], None).call, read(other_url, goal, second.clone(), &[], None).call);
        let same = |x: &Option<String>, y: &Option<String>| matches!((x, y), (Some(x), Some(y)) if strike(x, &a) == strike(y, &b));
        let verdict = match (&from_a, &from_b) {
            (None, None) => "NOTHING",
            _ if same(&from_a, &from_b) => "AGREE",
            _ => "DIFFER",
        };
        let one = if strike(&one_a, &a) == strike(&one_b, &b) && !one_a.is_empty() { "one-walk picks agree" } else { "one-walk picks differ" };
        println!("{site}: {verdict} | two walks: {} || {} | {one}: {} || {}", from_a.as_deref().unwrap_or("-"), from_b.as_deref().unwrap_or("-"), if one_a.is_empty() { "-" } else { &one_a }, if one_b.is_empty() { "-" } else { &one_b });
    }
}

/// The recipes a second walk lets the learner fit: for each site walked twice, the picked call's route built with the
/// other walk as an earlier sighting, and each field it made a recipe. Prints; it judges nothing.
#[test]
fn the_recipes_a_second_walk_fits() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    let only = std::env::var("UNBROWSE_GRAPH_SITES").unwrap_or_default();
    store::scratch_home("corpus-recipes");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, Trace)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if !only.is_empty() && !only.split(',').any(|s| s.trim() == said("site")) {
            continue;
        }
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        by_site.entry(said("site")).or_default().push((said("url"), said("goal"), trace));
    }
    for (site, walks) in &by_site {
        let [(url, goal, first), (_, _, second)] = &walks[..] else { continue };
        let one = read(url, goal, first.clone(), &[], None);
        let Some(i) = first.exchanges.iter().rposition(|e| format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), e.url.path()) == one.call) else { continue };
        let mut trace = first.clone();
        trace.inputs = walk_inputs(url, &path_inputs(url, goal, &trace).0, &trace.exchanges);
        let Ok(route) = route_of(&trace, i, goal, url, true, &[], &[(second.clone(), Vec::new())], None) else { continue };
        let recipes: Vec<String> = route.graph.steps.iter().flat_map(|s| s.fields.iter().map(move |f| (s, f))).filter_map(|(s, f)| match &f.class {
            unbrowse_learn::Class::Recipe { recipe } => Some(format!("{} at {} of {}: {:?} joined by {:?} over {:?}", if f.loc.to_string().starts_with("query") { "QUERY" } else { "header" }, f.loc, s.url.split('?').next().unwrap_or_default(), recipe.algo, recipe.separator, recipe.parts)),
            _ => None,
        }).collect();
        println!("{site}: {} | browser {} | {} recipe(s)", one.call, route.browser_assisted, recipes.len());
        recipes.iter().for_each(|r| println!("    {r}"));
    }
}

/// The reader itself, on a walk small enough to read by eye: the site's search call is kept over the page that
/// renders it, the address's value is the caller's, and the records' names are what a call hands back.
#[test]
fn a_kept_walk_reads_its_call_its_inputs_and_its_fields() {
    let _offline = unbrowse_learn::http::offline();
    store::scratch_home("corpus-reader");
    let walked = |method: &str, url: &str, body: &str, doc: bool| Exchange {
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
    };
    let url = "https://shop.example/search?q=lamps";
    let lamps: Vec<String> = (0..12).map(|n| format!(r#"{{"id":{n},"title":"Brass lamp {n}","price":"EUR {}"}}"#, 40 + n)).collect();
    let trace = Trace {
        exchanges: vec![
            walked("GET", url, "<html><body><div id='app'></div></body></html>", true),
            walked("GET", "https://shop.example/api/search?q=lamps", &format!(r#"{{"query":"lamps","results":[{}]}}"#, lamps.join(",")), false),
        ],
        inputs: Vec::new(),
    };
    let learned = read(url, "search the shop for lamps", trace, &[], None);
    assert_eq!(learned.none, None);
    assert_eq!((learned.call.as_str(), learned.by.as_str()), ("GET shop.example/api/search", "the rule"));
    assert_eq!(learned.inputs, vec!["q".to_string()]);
    assert!(learned.fields.iter().any(|f| f == "results[].title"), "the records' names are handed back: {:?}", learned.fields);
}

/// Arm B over the corpus: for every site walked twice, the route the learner keeps from the first walk alone, and what
/// a confirming browse would say of it where the second walk is the browser's walk for the agent's next value
/// (`confirm::as_a_kept_walk_says`: the route's answer is the second walk's recording of the same call). Beside it the
/// call each walk alone picks. Prints one line a site and the counts; it judges nothing: a person reads whether an
/// agreed route answers what was asked. `UNBROWSE_CORPUS` as above.
#[test]
fn what_a_confirming_browse_says_of_each_route_learned_from_one_walk() {
    let _offline = unbrowse_learn::http::offline();
    let Some(corpus) = std::env::var_os("UNBROWSE_CORPUS").map(std::path::PathBuf::from) else { return };
    store::scratch_home("corpus-confirm");
    let mut by_site: std::collections::BTreeMap<String, Vec<(String, String, String, Trace)>> = Default::default();
    let mut dirs: Vec<std::path::PathBuf> = std::fs::read_dir(&corpus).expect("the corpus folder").flatten().map(|f| f.path()).filter(|p| p.join("case.json").exists()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("case.json")).and_then(|m| m.modified()).ok());
    for dir in dirs {
        let Ok(case) = std::fs::read_to_string(dir.join("case.json")).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) else { continue };
        let said = |key: &str| case.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let Some(capture) = std::fs::read_dir(&dir).ok().and_then(|d| d.flatten().map(|f| f.path()).find(|p| p.extension().is_some_and(|x| x == "jsonl"))) else { continue };
        let Some(trace) = capture.file_stem().and_then(|s| s.to_str()).and_then(|s| trace_from_walk(&dir, s)) else { continue };
        let name = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
        by_site.entry(said("site")).or_default().push((name, said("url"), said("goal"), trace));
    }
    let mut counts: std::collections::BTreeMap<String, usize> = Default::default();
    for (site, walks) in &by_site {
        let [(case, url, goal, first), (_, other_url, _, second), ..] = &walks[..] else { continue };
        let mut trace = first.clone();
        let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
        let view = view_of("corpus", url, &walked_site(&trace.exchanges, &host), &trace, 0);
        let (in_path, _) = path_inputs(url, goal, &trace);
        let query_values = asked_values(url, &in_path);
        let scores = rule_scores(&trace, &view, goal, &query_values, &[]);
        let shown = page_shown(&trace.exchanges, url, &[]);
        let passes = |i: usize| may_answer(&trace, i, goal, url, &query_values, &shown, &view.site);
        let Some((index, _, _)) = walk_pick(&trace, &view, goal, &query_values, scores, &passes, None) else {
            *counts.entry("no pick".into()).or_default() += 1;
            println!("{site} ({case}): no pick");
            continue;
        };
        trace.inputs = walk_inputs(url, &in_path, &trace.exchanges);
        let Ok(route) = route_of(&trace, index, goal, url, true, &[], &[], None) else { continue };
        // The agent's next value: the second walk's, by the route's input names.
        let (other_path, _) = path_inputs(other_url, goal, second);
        let given: HashMap<String, String> = walk_inputs(other_url, &other_path, &second.exchanges).into_iter().filter(|i| route.inputs.iter().any(|r| r.name == i.name)).map(|i| (i.name, i.value)).collect();
        let verdict = confirm::as_a_kept_walk_says(&trace, &route, second, &given);
        let picked = &trace.exchanges[index];
        *counts.entry(verdict.word().into()).or_default() += 1;
        let keys: Vec<String> = picked.url.query_pairs().map(|(k, _)| k.into_owned()).collect();
        println!("{site} ({case}): {} {}{} [{}] -> {}{}", picked.method, picked.url.host_str().unwrap_or_default(), picked.url.path(), keys.join(","), verdict.word(), verdict.why().map(|w| format!(": {w}")).unwrap_or_default());
    }
    println!("confirm over the corpus: {counts:?}");
}

/// A read of kept walks reaches no site whatever the learn's settings ask of one: two walks of a search page on a
/// listener that counts every connection made to it, learned by example (whose tests would ask the site), under the
/// guard every offline read takes (`http::offline`), opens no connection on any thread.
#[test]
fn a_read_of_kept_walks_opens_no_connection() {
    let _offline = unbrowse_learn::http::offline();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let walk = |w: &str, kinds: [&str; 3]| {
        let rows: Vec<serde_json::Value> = (0..6).map(|n| serde_json::json!({ "id": n, "title": format!("{w} {} {n}", kinds[n % 3]) })).collect();
        let call = |url: String, body: String, mime: &str| Exchange { method: "GET".into(), url: url::Url::parse(&url).unwrap(), request_headers: Vec::new(), request_body: None, status: 200, response_headers: Vec::new(), response_body: Some(body), response_mime: mime.into(), resource_type: Some("XHR".into()), main_frame: Some(true) };
        let page = format!("http://127.0.0.1:{port}/search?q={w}");
        let mut t = Trace { exchanges: vec![call(page.clone(), format!("<html><body><h1>Results for {w}</h1></body></html>"), "text/html"), call(format!("http://127.0.0.1:{port}/api/search?q={w}"), serde_json::json!({ "query": w, "results": rows }).to_string(), "application/json")], inputs: Vec::new() };
        t.inputs = walk_inputs(&page, &[], &[]);
        (page, t)
    };
    let (page, first) = walk("brass", ["lamp", "knocker", "frame"]);
    let (_, second) = walk("glass", ["bowl", "jar", "vase"]);
    let sent = unbrowse_learn::http::sent_here();
    let route = route_of_by(&first, 1, "search items", &page, true, &[], &[(second, Vec::new())], None, true).expect("a route");
    // The site's own asks a learn makes (its tests, its trials) go through the route's client: asked here, offline.
    assert!(!call_answers(&route.graph, &HashMap::from([("q".to_string(), "jar".to_string())])), "refused, not answered");
    assert_eq!(unbrowse_learn::http::sent_here(), sent, "nothing went to the wire from this thread");
    assert!(listener.accept().is_err(), "no connection was opened to the walked site, from any thread");
    // Without the guard the same call reaches the listener: the test sees a connection when one is made.
    drop(_offline);
    let graph = route.graph.clone();
    let unguarded = std::thread::spawn(move || call_answers(&graph, &HashMap::from([("q".to_string(), "jar".to_string())])));
    listener.set_nonblocking(false).unwrap();
    let (conn, _) = listener.accept().expect("the unguarded call connected");
    drop(conn);
    let _ = unguarded.join();
}

