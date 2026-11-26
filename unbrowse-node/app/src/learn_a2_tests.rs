//! Tests of `learn`, a second climb over what no test reached (UNB-208 step 6, owner A2).

use super::*;

/// A call or a page the walk saw.
fn seen(method: &str, url: &str, body: &str, doc: bool) -> Exchange {
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

/// Only what a caller can say in words is a word: a bare number, a flag or a lone letter is not.
#[test]
fn the_words_among_what_a_page_was_asked_leave_out_numbers_and_single_letters() {
    let asked: Vec<String> = ["red lamp", "42", "x", "5G", "2024-05"].iter().map(|s| s.to_string()).collect();
    assert_eq!(words_of(&asked), vec!["red lamp".to_string(), "5G".to_string()]);
    assert!(words_of(&[]).is_empty());
}

/// A value a secret holds in an address is asked for by the secret's name instead, in the query, in the fragment, and in
/// a fragment's own query; a piece that is no pair, or holds another value, is left as it is.
#[test]
fn an_address_asks_for_a_secret_by_its_name_wherever_the_secret_sits_in_it() {
    let secrets = [("token", "s3cret value")];
    assert_eq!(asked_by_name("https://s.example/a?q=hats&k=s3cret+value&flag", &secrets), "https://s.example/a?q=hats&k={token}&flag");
    assert_eq!(asked_by_name("https://s.example/a#k=s3cret%20value&z=1", &secrets), "https://s.example/a#k={token}&z=1");
    assert_eq!(asked_by_name("https://s.example/a?x=1#/find?k=s3cret+value", &secrets), "https://s.example/a?x=1#/find?k={token}");
    assert_eq!(asked_by_name("https://s.example/a", &secrets), "https://s.example/a");
}

/// A walk that is gone can't have a call kept from it, and the caller is told to walk the page again.
#[test]
fn a_call_is_not_kept_from_a_walk_that_has_expired() {
    let walks = Walks::default();
    let said = keep(&walks, "no-such-walk", 0, "search", &[]).unwrap_err();
    assert!(said.contains("walk has expired"), "{said}");
}

/// A call that sends the page's word as one whole value of a form body is asking for it as a field; a word inside a
/// longer value is not that.
#[test]
fn a_form_body_that_sends_the_word_whole_sends_it_as_a_field() {
    let mut call = seen("POST", "https://shop.example/api/find", "{}", false);
    call.request_body = Some("page=1&q=Red+Lamp".into());
    assert!(sends_as_a_field(&call, "red lamp"));
    assert!(!sends_as_a_field(&call, "red"), "a piece of a value is not the value");
    call.request_body = Some("page=1&q=red+lamps+for+sale".into());
    assert!(!sends_as_a_field(&call, "red lamp"));
    let in_the_address = seen("GET", "https://shop.example/api/find?q=Red%20Lamp", "{}", false);
    assert!(sends_as_a_field(&in_the_address, "red lamp"), "a whole value of the query is a field too");
}

/// A call whose one record names the page's subject, as a value of its own, is the thing itself; a list of others that
/// mentions it, and a call too short a name, are not.
#[test]
fn a_call_whose_one_record_carries_the_subjects_name_says_its_name() {
    let subject = ["bitcoin".to_string()];
    let one = seen("GET", "https://x.example/details/BTCUSD", r#"{"toDisplayName":"Bitcoin","price":"1"}"#, false);
    assert!(says_its_name(&one, &subject));
    let other = seen("GET", "https://x.example/details/ETHUSD", r#"{"toDisplayName":"Ether","price":"1"}"#, false);
    assert!(!says_its_name(&other, &subject));
    assert!(!says_its_name(&one, &["bt".to_string()]), "a name of two letters says nothing");
    let deep = seen("GET", "https://x.example/details/deep", r#"{"a":{"b":{"c":{"d":{"e":{"name":"Bitcoin"}}}}}}"#, false);
    assert!(!says_its_name(&deep, &subject), "a name buried five levels down is not the thing's own");
}

/// A failure code and the address of another page of the site, no record: the call was sent to the site's check, and
/// the walk need not have gone there to say so.
#[test]
fn a_call_answered_with_a_failure_code_and_a_page_of_the_site_was_sent_elsewhere() {
    let answer = r#"{"ret":"FAIL_SYS_USER_VALIDATE","data":{"url":"https://shop.example/punish?x=1"}}"#;
    let call = seen("GET", "https://shop.example/api/search?q=hats", answer, false);
    let trace = Trace { exchanges: vec![call.clone()], inputs: Vec::new() };
    let said = sent_to_a_check(&call, &trace, "https://shop.example/search?q=hats", "shop.example").expect("sent elsewhere");
    assert!(said.contains("FAIL_SYS_USER_VALIDATE") && said.contains("another page of the site"), "{said}");
    // The address of another site is not the site's check.
    let away = answer.replace("shop.example/punish", "elsewhere.example/punish");
    let call = seen("GET", "https://shop.example/api/search?q=hats", &away, false);
    let trace = Trace { exchanges: vec![call.clone()], inputs: Vec::new() };
    assert_eq!(sent_to_a_check(&call, &trace, "https://shop.example/search?q=hats", "shop.example"), None);
}

/// A call whose answer lists only what it was sent reports records and answers nothing, wherever it is asked.
#[test]
fn a_call_whose_records_are_the_ones_it_sent_is_no_answer() {
    let mut call = seen("POST", "https://shop.example/api/find", r#"{"items":[{"id":"a1"},{"id":"b2"}]}"#, false);
    call.request_body = Some(r#"{"ids":["a1","b2"],"q":"a1"}"#.into());
    let trace = Trace { exchanges: vec![call.clone()], inputs: Vec::new() };
    let said = fails_goal(&call, "search items", "https://shop.example/search?q=a1", &["a1".to_string()], "", &trace);
    assert_eq!(said.as_deref(), Some("its records are the ones it sent: it reports them, and answers nothing"));
}

/// A page as served that says nothing of what was asked, whose script draws the rest, is a shell: it answers every
/// value the same.
#[test]
fn a_page_as_served_that_never_says_the_word_is_a_shell_that_answers_nothing() {
    let html = "<html><body><h1>Welcome to the shop</h1><p>Open daily. Free delivery over fifty dollars on every order placed with us this week.</p><a href=\"/about\">About</a></body></html>";
    let page = seen("GET", "https://shop.example/search?q=zebra", html, true);
    let trace = Trace { exchanges: vec![page.clone()], inputs: Vec::new() };
    let said = fails_goal(&page, "search items", "https://shop.example/search?q=zebra", &["zebra".to_string()], "", &trace).expect("a shell");
    assert!(said.contains("never says \"zebra\""), "{said}");
    let says = html.replace("Welcome to the shop", "No zebra here, but zebra stripes are in stock");
    let page = seen("GET", "https://shop.example/search?q=zebra", &says, true);
    let trace = Trace { exchanges: vec![page.clone()], inputs: Vec::new() };
    let said = fails_goal(&page, "search items", "https://shop.example/search?q=zebra", &["zebra".to_string()], "", &trace);
    assert!(!said.is_some_and(|w| w.contains("never says")), "a page that says it is not a shell");
}

/// A page whose search says it found things for what was asked is read from the site over plain HTTP, and a site that
/// does not answer, or a host the owner excluded, says nothing.
#[test]
fn a_page_the_site_serves_plainly_lists_the_ask_only_when_it_answers_and_is_not_excluded() {
    store::scratch_home("a2-page-lists");
    let card = |href: &str, title: &str, price: &str| format!("<div class=\"card\"><a href=\"{href}\"><img alt=\"{title}\"><p>{title}</p></a><p>{price}</p><p>Used</p></div>");
    let listed: String = [
        card("/p/apple-macbook-air-m1-13-1401/", "Apple MacBook Air M1 13.3-inch 8GB RAM", "S$650"),
        card("/p/macbook-air-m2-2022-1402/", "MacBook Air M2 2022 Midnight", "S$980"),
        card("/p/macbook-air-13-m3-1403/", "MacBook Air 13 M3 16GB", "S$1,250"),
        card("/p/macbook-air-2020-intel-1404/", "MacBook Air 2020 Intel i5", "S$320"),
        card("/p/macbook-air-15-m2-1405/", "MacBook Air 15 M2 512GB", "S$1,100"),
    ]
    .concat();
    let page = format!("<html><head><title>macbook air - View all macbook air ads in Market Singapore</title></head><body><h1>macbook air</h1>{listed}</body></html>");
    let port = crate::run::test_site(vec![("/search/macbook%20air/", 200, "text/html", page), ("/gone", 404, "text/html", "<html><body>no</body></html>".into())]);
    let goal = "search listings with titles and prices";
    let asked = ["macbook air".to_string()];
    let at = |p: &str| format!("http://127.0.0.1:{port}{p}");
    assert!(page_lists(&at("/search/macbook%20air/"), goal, &asked), "the page lists priced results that say it back");
    assert!(!page_lists(&at("/gone"), goal, &asked), "a page the site says is not there lists nothing");
    assert!(!page_lists(&at("/search/macbook%20air/"), goal, &["zebra".to_string()]), "results that never say the word are not its answer");
    let mut settings = store::load_settings();
    settings.excluded.push("127.0.0.1".into());
    store::save_settings(&settings).unwrap();
    assert!(!page_lists(&at("/search/macbook%20air/"), goal, &asked), "an excluded host is not asked");
}

/// An address that answers with a file is said as a file, not walked as a page, and no route is made of it.
#[test]
fn an_address_that_answers_with_a_file_is_said_as_one() {
    store::scratch_home("a2-plain-file");
    let port = crate::run::test_site(vec![("/report.pdf", 200, "application/pdf", "%PDF-1.4 not text".into())]);
    match learn_plain(&format!("http://127.0.0.1:{port}/report.pdf"), "read the report", "You") {
        Plain::Refused(said) => assert!(said.contains("file (application/pdf)") && said.contains("fetch it as a file"), "{said}"),
        other => panic!("a file is neither a page nor a route: {other:?}"),
    }
}

/// A site on this machine that answers each address by `answer` (its path and query); the addresses asked are kept.
fn a_site_here(answer: impl Fn(&url::Url) -> (u16, &'static str, String) + Send + 'static) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
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

/// A shop's list route over `base`, as its walk made it: the word `lamp` and a counting `offset`.
fn a_list_route_at(base: &str) -> Route {
    let url = format!("{base}/api/list?q=lamp&offset=0");
    let trace = Trace { exchanges: vec![seen("GET", &url, r#"{"items":["the only brass lamp there is"]}"#, false)], inputs: vec![unbrowse_learn::Input::new("q", "lamp")] };
    route_of(&trace, 0, "search the shop", &format!("{base}/search?q=lamp"), true, &[], &[], None).unwrap()
}

/// A walk that found one record leaves open whether the site has more: the route is asked for real, with a second word
/// lent, and reads on by the count the site answers to.
#[test]
fn a_route_that_found_one_record_reads_on_by_what_the_site_answers_for_a_second_word() {
    store::scratch_home("a2-read-on");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, asked) = a_site_here(|u| {
        let q = |k: &str| u.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.into_owned()).unwrap_or_default();
        let from: u64 = q("offset").parse().unwrap_or(0);
        let items: Vec<String> = if q("q") == "lamp" { vec!["the only brass lamp there is".into()] } else { (from..from + 10).map(|n| format!("brass chandelier number {n}")).collect() };
        (200, "application/json", serde_json::json!({ "items": items }).to_string())
    });
    let read = read_on_by_trial_for(a_list_route_at(&base), Some("chandelier"), false);
    assert_eq!(read.paging, Some(unbrowse_learn::paging::Paging::Count { input: "offset".into(), step: 10 }), "asked: {:?}", asked.locked());
    assert!(asked.locked().iter().any(|t| t.contains("q=chandelier")), "the second word was asked: {:?}", asked.locked());
    assert_eq!(read.heard.said_back, None, "the word was lent for the question only");
}

/// What a candidate shows of an answer's keys tells calls apart: an object's own first keys, the last record of a list
/// (the one that carries the answer), the count of a list of plain things, and nothing for a bare value.
#[test]
fn a_candidate_names_the_keys_of_the_record_that_carries_the_answer() {
    let at = |body: &str| candidate(0, &seen("GET", "https://shop.example/api/x", body, false)).keys;
    assert_eq!(at(r#"{"items":[],"total":3}"#), vec!["items".to_string(), "total".to_string()]);
    assert_eq!(at(r#"[{"head":1},{"id":1,"title":"a"}]"#), vec!["id".to_string(), "title".to_string()], "the last record's keys");
    assert_eq!(at(r#"["lamp","lamps","lamp shade"]"#), vec!["3 events".to_string()]);
    assert!(at("42").is_empty(), "a bare number has no keys");
}

/// A call whose answer is a challenge's own (a key that names one beside the records), or whose address names a captcha,
/// is the puzzle the site set, never a call that answers the page.
#[test]
fn a_call_that_answers_with_a_challenge_is_not_a_candidate_for_the_answer() {
    let body = r#"{"items":[{"id":1,"title":"Brass lamp"},{"id":2,"title":"Brass lamp two"}]}"#;
    assert!(is_candidate(&seen("GET", "https://shop.example/api/list?q=lamp", body, false), "shop.example"));
    assert!(!is_candidate(&seen("GET", "https://shop.example/captcha/verify?q=lamp", body, false), "shop.example"));
    let with_a_challenge = r#"{"challenge":"abc123","items":[{"id":1,"title":"Brass lamp"},{"id":2,"title":"Brass lamp two"}]}"#;
    assert!(!is_candidate(&seen("GET", "https://shop.example/api/list?q=lamp", with_a_challenge, false), "shop.example"), "a key that names a challenge");
}

/// Data is JSON that holds something, or text of more than a bare line; an empty answer, an acknowledgement and a
/// short line are not.
#[test]
fn a_plain_answer_is_data_only_when_it_holds_something() {
    use serde_json::json;
    assert!(plain_data(Some(&json!({ "a": 1 })), false, ""));
    assert!(plain_data(Some(&json!([1])), false, ""));
    assert!(!plain_data(Some(&json!([])), false, ""));
    assert!(!plain_data(Some(&json!({})), false, ""));
    assert!(!plain_data(Some(&json!("200-OK")), true, "200-OK"));
    assert!(!plain_data(None, true, "ok"));
    assert!(plain_data(None, true, "line one\nline two"));
}

/// A call sends a word as a value of its own wherever its JSON holds it, at any depth, in a list too; a word of one
/// character, or none, is never a value a call can be said to send.
#[test]
fn a_call_sends_a_word_of_its_own_inside_a_json_list_and_nothing_shorter_than_two_characters() {
    let mut call = seen("POST", "https://shop.example/api/find", "{}", false);
    call.request_body = Some(r#"{"filter":{"terms":["Cats","dogs"]}}"#.into());
    call.request_headers.push(("content-type".into(), "application/json".into()));
    assert!(sends_as_its_own(&call, "cats"));
    assert!(!sends_as_its_own(&call, "bird"));
    let mut short = seen("POST", "https://shop.example/api/find", "{}", false);
    short.request_body = Some(r#"{"filter":{"terms":["c"]}}"#.into());
    assert!(!sends_as_its_own(&short, "c"), "a one-character value is not told from any other");
    assert!(!sends_value(&call, "  "), "nothing is not sent");
    assert!(!asks_by_value(&call, " "), "nothing is not asked");
    assert!(sends_value(&call, "dogs") && asks_by_value(&call, "dogs"));
}

/// What a page offers in its own markup (its sort links) is what the route can take besides the walk's value: the choice
/// the walk saw is kept with the label the page gives it, the others the page offers are added, and the value the call
/// already sent stands as the input's default.
#[test]
fn a_page_that_links_its_sorts_offers_each_as_a_choice_with_the_walked_one_as_default() {
    use unbrowse_learn::{controls::Choice, paging::Reading, Class, Loc};
    let url = "https://shop.example/search?q=lamp&sort=new";
    let html = r#"<html><body><form action="/search"><input name="q" value="lamp"></form>
        <a href="/search?q=lamp&sort=price">Price</a> <a href="/search?q=lamp&sort=rating">Rating</a>
        <ul><li>Brass lamp</li><li>Glass lamp</li></ul></body></html>"#;
    let page = seen("GET", url, html, true);
    let trace = Trace { exchanges: vec![page.clone()], inputs: vec![unbrowse_learn::Input::new("q", "lamp")] };
    let mut route = route_of(&trace, 0, "search the shop", url, true, &[], &[], None).unwrap();
    let readings = [Reading::Choice { loc: Loc::Query("sort".into()), name: "sort".into(), values: vec!["price".into()], first: None }];
    let offered = offered_by(&page, &readings, &mut route.graph);
    let sorts: Vec<(String, Option<String>)> = offered.keys["sort"].iter().map(|c: &Choice| (c.value.clone(), c.label.clone())).collect();
    assert_eq!(sorts, vec![("price".to_string(), Some("Price".to_string())), ("rating".to_string(), Some("Rating".to_string()))]);
    let step = route.graph.steps.last().unwrap();
    let field = step.fields.iter().find(|f| f.loc == Loc::Query("sort".into())).expect("the sort is a field of the call");
    assert!(matches!(&field.class, Class::Input { name, default: Some(d), optional: true, .. } if name == "sort" && d == "new"), "{:?}", field.class);
}

/// The hand-off reconnects to a loopback browser socket by its IPv6 address too, and to no other IPv6 address.
#[test]
fn a_handoff_reconnects_to_an_ipv6_loopback_socket_and_to_no_other_ipv6_address() {
    let said = |at: &str| format!("mint unresolved (challenge); browser left open for verification; reconnect at {at}");
    assert_eq!(handoff_endpoint(&said("ws://[::1]:9222/devtools/browser/ab-12")).as_deref(), Some("ws://[::1]:9222/devtools/browser/ab-12"));
    assert_eq!(handoff_endpoint(&said("ws://[2001:db8::1]:9222/devtools/browser/ab-12")), None);
}

/// The records a shop at `base` answers a search for `word` with.
fn lamp_records(word: &str) -> String {
    let records: Vec<_> = (0..8).map(|i| serde_json::json!({ "id": 100 + i, "title": format!("Desk {word} model {i}"), "price": 10 + i, "sku": format!("L-{i}") })).collect();
    serde_json::json!({ "results": records }).to_string()
}

/// A walk of the shop at `base`, searched for `lamp`: its page and the call that answered it.
fn the_walk_of_a_local_shop(base: &str) -> (Walks, String) {
    let url = format!("{base}/search?q=lamp");
    let page = seen("GET", &url, r#"<html><body><input name="q" value="lamp"><ul><li>Desk lamp model 0</li></ul></body></html>"#, true);
    let search = seen("GET", &format!("{base}/api/search?q=lamp"), &lamp_records("lamp"), false);
    let walks = Walks::default();
    walks.0.locked().insert("w1".to_string(), Walk { url: url.clone(), trace: Trace { exchanges: vec![page, search], inputs: Vec::new() }.into(), probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None });
    (walks, url)
}

/// Other things for another word, not the same names with the word swapped: what a shop that hears its caller answers.
fn other_records(word: &str) -> String {
    let kinds = ["antique brass pendant fixture", "vintage glass ceiling globe", "modern steel track rail", "rustic wooden beam hanger", "ornate crystal drop cluster", "slim copper cord pendant", "frosted opal bowl shade", "matte black spot bracket"];
    let records: Vec<_> = kinds.iter().enumerate().map(|(i, k)| serde_json::json!({ "id": 200 + i, "title": format!("{word} {k}"), "price": 30 + i, "sku": format!("C-{i}") })).collect();
    serde_json::json!({ "results": records }).to_string()
}

/// A shop that answers a search for another word with other records of its own is heard by the route kept from its
/// walk: the site is asked a word nobody searches for, answers with something else, and the route stands as a call that
/// takes the caller's word.
#[test]
fn a_route_kept_from_a_shop_that_answers_each_word_with_records_of_its_own_hears_its_caller() {
    store::scratch_home("a2-hears");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, asked) = a_site_here(|u| {
        let word = u.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
        (200, "application/json", if word == "lamp" { lamp_records("lamp") } else { other_records(&word) })
    });
    let (walks, url) = the_walk_of_a_local_shop(&base);
    let (route, by) = pick_and_keep(&walks, &url, "search shop items", "You", "w1", &|_| {}, None, true).unwrap_or_else(|e| panic!("a pick: {e}"));
    assert_eq!((route.path.as_str(), by), ("/api/search?q={q}", "the rule"));
    assert_eq!(route.heard, store::Heard { probed: true, deaf: Vec::new(), ..Default::default() }, "the site answered another word with other records");
    assert!(asked.locked().iter().any(|t| t.starts_with("/api/search?q=") && !t.contains("q=lamp")), "the site was asked for another word: {:?}", asked.locked());
    assert_eq!(store::load_route(&route.id).expect("kept").heard, route.heard);
}

/// A shop whose answer to another word is the same names with the word swapped says nothing of its own for it: the
/// call that was picked gives way, nothing else answers, and it stands as the answer for this page alone, marked deaf
/// to its input.
#[test]
fn a_route_kept_from_a_shop_whose_records_only_swap_the_word_stands_marked_deaf() {
    store::scratch_home("a2-deaf");
    let _old = crate::learn::own_asks::as_the_old_node();
    let (base, _) = a_site_here(|u| {
        let word = u.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
        (200, "application/json", lamp_records(&word))
    });
    let (walks, url) = the_walk_of_a_local_shop(&base);
    let (route, _) = pick_and_keep(&walks, &url, "search shop items", "You", "w1", &|_| {}, None, true).unwrap_or_else(|e| panic!("a pick: {e}"));
    assert!(route.heard.probed && route.heard.deaf == vec!["q".to_string()], "{:?}", route.heard);
    let kept = store::load_route(&route.id).expect("the route stands for the page");
    assert_eq!(kept.heard, route.heard, "what the site showed is kept with it");
}

/// A key of an address takes its place as `{key}` only when exactly one pair of the query is it, and what follows the
/// query (a fragment) stays.
#[test]
fn a_query_key_takes_its_place_in_an_address_only_when_it_stands_once() {
    assert_eq!(with_its_place("https://shop.example/a?x=1&ref=abc#top", "ref").as_deref(), Some("https://shop.example/a?x=1&ref={ref}#top"));
    assert_eq!(with_its_place("https://shop.example/a?ref=abc&ref=def", "ref"), None, "twice is no place");
    assert_eq!(with_its_place("https://shop.example/a?x=1", "ref"), None, "not at all is none");
    assert_eq!(with_its_place("https://shop.example/a", "ref"), None);
}

/// What a walker's own session cookie is, as a call writes it, belongs to the caller's own session: a query value that
/// holds it whole becomes the cookie's, as it is written on every call. A value in a header or body, one the cookie
/// stands in only as the page wrote it, or one whose place in the address is not to be found, stays unconfirmed, never a
/// constant another caller's call would send.
#[test]
fn the_walkers_session_cookie_in_a_value_is_the_callers_own_only_where_it_can_be_told() {
    use unbrowse_learn::{Class, Field, Loc};
    let session = "ABCDEFGHIJKL12345";
    let mut call = seen("GET", &format!("https://shop.example/api/list?ref={session}&tok={session}&lost={session}"), "{}", false);
    call.request_headers.push(("cookie".into(), format!("sid={session}; spaced=hello world 1234")));
    let trace = Trace { exchanges: vec![call], inputs: Vec::new() };
    let constant = |value: &str| Class::Constant { value: value.into(), origin: None };
    let mut graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
        "provisional": false,
        "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/list?ref={ref}&tok={tok}", "needs_browser": false, "fields": [] }]
    }))
    .unwrap();
    graph.steps[0].fields = vec![
        Field { loc: Loc::Query("ref".into()), class: constant(session) },
        Field { loc: Loc::Query("lost".into()), class: constant(session) },
        Field { loc: Loc::Header("x-ref".into()), class: constant(session) },
        Field { loc: Loc::Header("x-written".into()), class: constant("hello%20world%201234") },
        Field { loc: Loc::Header("x-other".into()), class: constant("unrelated value") },
    ];
    the_walkers_cookies_in_values(&mut graph, &trace, &[]);
    let class = |loc: Loc| graph.steps[0].fields.iter().find(|f| f.loc == loc).unwrap().class.clone();
    assert_eq!(class(Loc::Query("ref".into())), Class::CookieIn { template: "{cookie}".into(), name: "sid".into() }, "a query value the cookie is whole in is the cookie's");
    assert_eq!(graph.steps[0].url, "https://shop.example/api/list?ref={ref}&tok={tok}");
    assert_eq!(class(Loc::Query("lost".into())), Class::Unconfirmed { value: session.into() }, "its place in the address is not found");
    assert_eq!(class(Loc::Header("x-ref".into())), Class::Unconfirmed { value: session.into() }, "a header's is not told apart");
    assert_eq!(class(Loc::Header("x-written".into())), Class::Unconfirmed { value: "hello%20world%201234".into() }, "the cookie stands in it only as written");
    assert_eq!(class(Loc::Header("x-other".into())), constant("unrelated value"), "a value with no cookie in it stays as it was");
}

/// A secret the owner typed never rides with the route: the address it was learned on asks for it by name, and any text
/// of the route that holds it, written plain or form-encoded, is cleared. A name the vault gives it is no value and a
/// secret too short to tell apart from other text is left out of the hunt.
#[test]
fn a_secret_typed_during_a_walk_is_cleared_from_every_text_of_the_route() {
    let base = "https://shop.example";
    let url = format!("{base}/api/list?q=lamp&offset=0");
    let trace = Trace { exchanges: vec![seen("GET", &url, r#"{"items":["a lamp"]}"#, false)], inputs: vec![unbrowse_learn::Input::new("q", "lamp")] };
    let mut route = route_of(&trace, 0, "search the shop", &format!("{base}/search?q=lamp"), true, &[], &[], None).unwrap();
    route.root = format!("{base}/login?pass=hunter2+is%20it#k=hunter2+is%20it");
    route.what = "sign in with hunter2 is it, or hunter2%20is%20it".into();
    let typed = [unbrowse_learn::Input::secret("password", "hunter2 is it"), unbrowse_learn::Input::secret("ref", "secret:vault-name"), unbrowse_learn::Input::new("q", "lamp")];
    withhold_secrets(&mut route, &typed).unwrap();
    assert_eq!(route.root, format!("{base}/login?pass={{password}}#k={{password}}"), "asked for by name, in the query and in the fragment");
    assert!(!route.what.contains("hunter2"), "the plain and the encoded writing are cleared: {:?}", route.what);
    // Nothing typed as a secret leaves the route as it was.
    let mut same = route.clone();
    withhold_secrets(&mut same, &[unbrowse_learn::Input::new("q", "lamp")]).unwrap();
    assert_eq!(serde_json::to_value(&same).unwrap(), serde_json::to_value(&route).unwrap());
}

/// What a refusal to learn comes to, and which reader said so: a page never seen is no route and not a page that needs
/// hands, and a refusal told more still is the same refusal.
#[test]
fn a_page_that_could_not_be_learned_comes_to_what_it_was_and_keeps_its_kind_when_told_more() {
    use crate::outcome::Outcome;
    assert_eq!(Unlearned::Unseen("nothing from the site".into()).outcome(), (Outcome::NoRoute, "learn.unseen"));
    assert_eq!(Unlearned::Gone("404".into()).outcome(), (Outcome::Gone, "learn.gone"));
    assert_eq!(Unlearned::Nothing("no record".into()).outcome(), (Outcome::AnsweredEmpty, "learn.nothing"));
    assert_eq!(Unlearned::Check("a check".into(), "answer.check_url").outcome(), (Outcome::Challenge, "answer.check_url"));
    assert_eq!(Unlearned::SignIn("sign in".into(), "learn.sign_in_asked").and("more"), Unlearned::SignIn("sign in; more".into(), "learn.sign_in_asked"));
    assert_eq!(Unlearned::Hands("hands".into()).and("more"), Unlearned::Hands("hands; more".into()));
    assert_eq!(Unlearned::Gone("404".into()).and("more"), Unlearned::Gone("404".into()), "a page that is not there is not told more");
}

/// What a page does when its controls are tried is what its route can then be asked for: the count a list climbs by
/// becomes how it reads on, a value the page offers a few of becomes an input with those choices, and a header that
/// changed between the tries (the session's) is no choice at all.
#[test]
fn the_controls_of_a_page_that_were_tried_become_paging_and_choices_of_its_route() {
    let base = "https://list.walk-tried.example";
    let mut route = a_list_route_at(base);
    let again = |query: &str, header: &str| {
        let mut e = seen("GET", &format!("{base}/api/list?{query}"), r#"{"items":["a brass lamp"]}"#, false);
        e.request_headers.push(("x-trace".into(), header.into()));
        e
    };
    let tried = Trace { exchanges: vec![again("q=lamp&offset=0", "t1"), again("q=lamp&offset=10&sort=price", "t2"), again("q=lamp&offset=20&sort=new", "t3")], inputs: Vec::new() };
    what_the_page_took(&mut route, &tried);
    assert_eq!(route.paging, Some(unbrowse_learn::paging::Paging::Count { input: "offset".into(), step: 10 }));
    let sort = route.inputs.iter().find(|i| i.name == "sort").expect("the page's sort is an input now");
    assert_eq!(sort.options.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), vec!["price", "new"]);
    assert!(sort.optional, "a caller need not choose");
    assert!(route.inputs.iter().all(|i| !i.name.contains("trace")), "a header that changed is the session's, not an input: {:?}", route.inputs.iter().map(|i| &i.name).collect::<Vec<_>>());
    // A call that is not the route's own, or answered with an error, teaches nothing.
    let mut failed = again("q=lamp&offset=10", "t1");
    failed.status = 500;
    let elsewhere = seen("GET", &format!("{base}/api/other?q=lamp&offset=10"), r#"{"items":["a brass lamp"]}"#, false);
    for repeat in [failed, elsewhere] {
        let mut untouched = a_list_route_at(base);
        what_the_page_took(&mut untouched, &Trace { exchanges: vec![again("q=lamp&offset=0", "t1"), repeat], inputs: Vec::new() });
        assert_eq!(untouched.paging, None);
    }
}
