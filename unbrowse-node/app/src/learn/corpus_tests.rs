//! The corpus reader run over a corpus of its own: two kept walks of one shop's search page, laid out as the node lays
//! a corpus out, read the way the reader's measuring tests read a real one (they pass on no corpus named).

use super::*;

/// A capture of one search walk: the page that renders it and the site's search call, as the node writes a capture.
fn capture(word: &str, kinds: [&str; 3], recorded: bool) -> String {
    let rows: Vec<serde_json::Value> = (0..12).map(|n| serde_json::json!({ "id": n, "title": format!("{word} {} {n}", kinds[n % 3]), "price": format!("EUR {}", 40 + n) })).collect();
    let page = format!("https://shop.example/search?q={word}");
    let call = format!("https://shop.example/api/search?q={word}");
    let answer = serde_json::json!({ "query": word, "results": rows }).to_string();
    let lines = [
        serde_json::json!({"type": "request", "t": 1.0, "requestId": "1", "method": "GET", "url": page, "headers": {}, "resourceType": "Document", "frameId": "MAIN"}),
        serde_json::json!({"type": "response", "t": 1.5, "requestId": "1", "url": page, "status": 200, "mimeType": "text/html", "headers": {}, "body": format!("<html><body><h1>Results for {word}</h1></body></html>")}),
        serde_json::json!({"type": "request", "t": 2.0, "requestId": "2", "method": "GET", "url": call, "headers": {}, "resourceType": "Fetch", "frameId": "MAIN"}),
        serde_json::json!({"type": "response", "t": 2.5, "requestId": "2", "url": call, "status": 200, "mimeType": "application/json", "headers": {}, "body": answer}),
    ];
    let mut lines: Vec<serde_json::Value> = lines.to_vec();
    if recorded {
        // The record of where the browser was, whole: it says it records, names the page's address, and closes with the count.
        lines.insert(0, serde_json::json!({"type": "addresses", "recorded": true, "t": 0.0}));
        lines.insert(2, serde_json::json!({"type": "address", "t": 1.2, "url": page, "session": null, "frame": "MAIN"}));
        lines.push(serde_json::json!({"type": "addresses_end", "t": 9.0, "written": 1, "failed": false, "missed": 0, "cut_off": false}));
    }
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// A case folder with its case file and, where `walk` is Some, its capture.
fn case_at(corpus: &std::path::Path, folder: &str, said: serde_json::Value, walk: Option<(&str, [&str; 3])>, recorded: bool) -> std::path::PathBuf {
    let dir = corpus.join(folder);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("case.json"), said.to_string()).unwrap();
    if let Some((word, kinds)) = walk {
        std::fs::write(agent_browser_core::session::capture_path(&dir, "learn_w"), capture(word, kinds, recorded)).unwrap();
    }
    dir
}

/// A corpus of two walks of one shop, a folder of its own in the temp folder, built once and never removed: the
/// reader's other tests read whatever `UNBROWSE_CORPUS` names for as long as the process runs.
pub(in crate::learn) fn a_shop_walked_twice() -> std::path::PathBuf {
    static CORPUS: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    CORPUS.get_or_init(|| a_shop_in("corpus-reader-shop", false)).clone()
}

/// The same shop, its walks' captures recording the addresses their browser was at, whole.
fn a_shop_walked_twice_and_recorded() -> std::path::PathBuf {
    static CORPUS: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    CORPUS.get_or_init(|| a_shop_in("corpus-reader-recorded-shop", true)).clone()
}

fn a_shop_in(name: &str, recorded: bool) -> std::path::PathBuf {
    let corpus = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&corpus);
    let said = |word: &str| serde_json::json!({"site": "shop.example", "url": format!("https://shop.example/search?q={word}"), "goal": "search items", "value": word});
    case_at(&corpus, "a-lamps", said("brass"), Some(("brass", ["lamp", "knocker", "frame"])), recorded);
    case_at(&corpus, "b-bowls", said("glass"), Some(("glass", ["bowl", "jar", "vase"])), recorded);
    corpus
}

/// A case folder that holds no case reads as the reason it is none: no file, no url, no capture, a capture that holds
/// no walk.
#[test]
fn a_folder_that_is_no_case_says_why() {
    let _offline = unbrowse_learn::http::offline();
    store::scratch_home("corpus-no-case");
    let root = std::env::temp_dir().join(format!("corpus-no-case-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("empty")).unwrap();
    let why = |dir: &std::path::Path| read_case(dir).expect_err("no case");
    assert!(why(&root.join("empty")).starts_with("no case.json"), "no case file");
    let bad = case_at(&root, "bad", serde_json::json!({}), None, false);
    std::fs::write(bad.join("case.json"), "{not json").unwrap();
    assert!(why(&bad).starts_with("case.json:"), "a case file that is no JSON");
    let no_url = case_at(&root, "no-url", serde_json::json!({"goal": "g"}), None, false);
    assert_eq!(why(&no_url), "case.json names no url");
    let no_goal = case_at(&root, "no-goal", serde_json::json!({"url": "https://shop.example/"}), None, false);
    assert_eq!(why(&no_goal), "case.json names no goal");
    let no_capture = case_at(&root, "no-capture", serde_json::json!({"url": "https://shop.example/", "goal": "g"}), None, false);
    assert_eq!(why(&no_capture), "no capture");
    std::fs::write(no_capture.join("learn_w.jsonl"), "").unwrap();
    let (now, kept) = read_case(&no_capture).expect("a capture that holds no calls is a case that reads as nothing");
    assert!(now.none.is_some() && now.call.is_empty() && kept.is_none(), "{now:?}");
    let _ = std::fs::remove_dir_all(&root);
}

/// What the reader says of a walk that cannot be read as a call: an address that is no URL, a goal that asks for a
/// change, a page the site said is gone and a page that made no call each read as nothing kept, with the reason.
#[test]
fn a_walk_that_cannot_be_read_as_a_call_reads_as_nothing_with_its_reason() {
    let _offline = unbrowse_learn::http::offline();
    store::scratch_home("corpus-nothing");
    let root = std::env::temp_dir().join(format!("corpus-nothing-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let dir = case_at(&root, "a", serde_json::json!({"url": "https://shop.example/search?q=brass", "goal": "search items"}), Some(("brass", ["lamp", "knocker", "frame"])), false);
    let trace = trace_from_walk(&dir, "learn_w").expect("a walk");
    let url = "https://shop.example/search?q=brass";
    let not_a_url = read("shop", "search items", trace.clone(), &[], None, None);
    assert_eq!(not_a_url.none.as_deref(), Some("not a URL"));
    assert_eq!(not_a_url.call, "", "nothing is kept");
    let a_change = read(url, "submit the order", trace.clone(), &[], None, None);
    assert_eq!(a_change.none.as_deref(), Some(NEEDS_HANDS), "a goal that asks for a change is not answered by loading a page");
    let mut gone = trace.clone();
    gone.exchanges[0].status = 404;
    let gone = read(url, "search items", gone, &[], None, None);
    assert!(gone.none.as_deref().is_some_and(|why| why.contains("404")), "the page is gone: {gone:?}");
    let mut page_only = trace.clone();
    page_only.exchanges.truncate(1);
    let page_only = read(url, "search items", page_only, &[], None, None);
    assert!(page_only.none.as_deref().is_some_and(|why| why.contains("lists nothing")) && page_only.call.is_empty(), "a page that made no call keeps none: {page_only:?}");
    let read_whole = read(url, "search items", trace, &[], None, None);
    assert_eq!((read_whole.none, read_whole.call.as_str()), (None, "GET shop.example/api/search"));
    let _ = std::fs::remove_dir_all(&root);
}

/// The reader's measuring tests, run over a shop walked twice: each case is read and kept (`UNBROWSE_CORPUS_KEEP`), the
/// reading kept is what is read again, and the diagnostics that pair two walks of a site run to their end. The
/// variables they read are set for the process, as they are named on a command line; the folder stays.
#[test]
fn a_corpus_of_one_shop_walked_twice_is_read_kept_and_read_again() {
    let _offline = unbrowse_learn::http::offline();
    store::scratch_home("corpus-shop");
    let corpus = a_shop_walked_twice();
    std::env::set_var("UNBROWSE_CORPUS", &corpus);
    // Kept anew: what is read now is written beside each case.
    std::env::set_var("UNBROWSE_CORPUS_KEEP", "1");
    the_corpus_reads_as_it_was_kept();
    std::env::remove_var("UNBROWSE_CORPUS_KEEP");
    for (folder, word) in [("a-lamps", "brass"), ("b-bowls", "glass")] {
        let kept: Learned = serde_json::from_str(&std::fs::read_to_string(corpus.join(folder).join("learned.json")).expect("a reading is kept")).expect("a reading is JSON");
        assert_eq!(kept.none, None, "{folder} reads as a call");
        assert_eq!((kept.call.as_str(), kept.by.as_str()), ("GET shop.example/api/search", "the rule"), "{folder}");
        assert_eq!(kept.inputs, vec!["q".to_string()], "{folder}: the address's value is the caller's");
        assert!(kept.fields.iter().any(|f| f == "results[].title"), "{folder}: {:?}", kept.fields);
        let (now, was) = read_case(&corpus.join(folder)).expect("a case");
        assert_eq!(Some(now), was, "{folder} reads again as it was kept ({word})");
    }
    the_corpus_reads_as_it_was_kept();
    what_a_second_walk_says_of_each_sites_calls();
    what_the_records_offer_where_the_trial_finds_no_word();
    the_page_a_bodys_plan_writes_for_the_second_word();
    how_many_kept_routes_the_least_chain_would_shorten();
    what_the_picked_call_changes_between_two_values();
    what_two_walks_agree_the_answer_is();
    the_recipes_a_second_walk_fits();
    what_a_confirming_browse_says_of_each_route_learned_from_one_walk();
}

/// The diagnostic that shows a kept walk as it would be shared runs to its end over a case: where the walk's record of
/// its browser's addresses is whole it writes the route another node fetches, and where there is none it refuses, and
/// writes nothing.
#[test]
fn a_kept_walk_shown_as_it_would_be_shared_writes_the_route_another_node_fetches_only_on_a_whole_record() {
    let _offline = unbrowse_learn::http::offline();
    store::scratch_home("corpus-shared");
    let (plain, recorded) = (a_shop_walked_twice(), a_shop_walked_twice_and_recorded());
    for (corpus, shared) in [(&plain, false), (&recorded, true)] {
        let out = corpus.join("fetched-route.json");
        std::env::set_var("UNBROWSE_WALK_CASE", corpus.join("a-lamps"));
        std::env::set_var("UNBROWSE_WALK_CASE2", corpus.join("b-bowls"));
        std::env::set_var("UNBROWSE_SHARED_OUT", &out);
        a_kept_walk_as_it_would_be_shared();
        std::env::remove_var("UNBROWSE_WALK_CASE");
        std::env::remove_var("UNBROWSE_WALK_CASE2");
        std::env::remove_var("UNBROWSE_SHARED_OUT");
        assert_eq!(out.exists(), shared, "{}", corpus.display());
        if shared {
            let fetched: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&out).expect("the route is written")).unwrap();
            assert!(fetched.to_string().contains("api/search"), "the route calls the shop's search: {fetched}");
        }
    }
}

/// A kept walk reads as the node's own learn reads it (`learn.rs`, `Recording::read`): a script whose fetched body the
/// capture cut short reads whole, from the source the browser parsed, so the page booted offline is the page the node
/// boots. The corpus once read the bare capture, and a page's function that ran on the node's learn did not run on the
/// corpus's (a bundle past the capture's cut, 28 November 2026).
#[test]
fn a_kept_walk_reads_a_script_cut_short_whole_as_the_nodes_learn_reads_it() {
    use sha2::Digest;
    let root = std::env::temp_dir().join(format!("corpus-cut-script-{}", std::process::id()));
    let dir = case_at(&root, "cut", serde_json::json!({"url": "https://shop.example/search?q=lamp", "goal": "lamps"}), Some(("lamp", ["red", "tall", "small"])), false);
    let whole = "function sign(t){return 'v1.'+t.length}window.signer=sign;";
    let cut = &whole[..18];
    let url = "https://shop.example/app.js";
    let sha: String = sha2::Sha256::digest(whole.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    let capture = agent_browser_core::session::capture_path(&dir, "learn_w");
    let mut text = std::fs::read_to_string(&capture).unwrap();
    for line in [
        serde_json::json!({"type": "request", "t": 1.6, "requestId": "app", "method": "GET", "url": url, "headers": {}, "resourceType": "Script", "frameId": "MAIN"}),
        serde_json::json!({"type": "response", "t": 1.7, "requestId": "app", "url": url, "status": 200, "mimeType": "application/javascript", "headers": {}, "body": cut}),
        serde_json::json!({"type": "script", "t": 1.8, "scriptId": "7", "url": url, "language": "js", "sha256": sha, "length": whole.len(), "source": whole}),
    ] {
        text.push_str(&format!("{line}\n"));
    }
    std::fs::write(&capture, text).unwrap();
    let walk = case_walk(&dir).expect("the case reads");
    let body = walk.trace.exchanges.iter().find(|e| e.url.as_str() == url).and_then(|e| e.response_body.clone());
    assert_eq!(body.as_deref(), Some(whole), "the script reads whole, as the node's learn reads it, not cut where the capture cut it");
}
