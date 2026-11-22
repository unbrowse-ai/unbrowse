//! Tests of `learn` (UNB-208 coverage climb).

use super::*;

use crate::learn::own_asks::{self, Ask};

/// An exchange the page's own code made, or the page's own document (`doc`).
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

/// A walk of a shop's search page for `lamp` held for choosing from: the page, its suggestions call (the words
/// back) and its search call (the records). Returns the walks and the exchange index of each call.
fn a_shop_walk(id: &str) -> (Walks, String, usize, usize) {
    let url = "https://shop.example/search?q=lamp".to_string();
    let page = seen("GET", &url, r#"<html><body><input name="q" value="lamp"><ul><li>Lamp one</li></ul></body></html>"#, true);
    let suggest = seen("GET", "https://shop.example/api/suggest?q=lamp", r#"["lamp","lamps","lamp shade"]"#, false);
    let records: Vec<_> = (0..8).map(|i| serde_json::json!({ "id": 100 + i, "title": format!("Desk lamp model {i}"), "price": 10 + i, "sku": format!("L-{i}") })).collect();
    let search = seen("GET", "https://shop.example/api/search?q=lamp", &serde_json::json!({ "results": records }).to_string(), false);
    let trace = Trace { exchanges: vec![page, suggest, search], inputs: Vec::new() };
    let walks = Walks::default();
    walks.0.locked().insert(id.to_string(), Walk { url: url.clone(), trace, probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None });
    (walks, url, 1, 2)
}

/// A shop walk on its own host, so no other test's budget note or stored route touches it.
fn a_walk_of(host: &str, id: &str) -> (Walks, String, usize, usize) {
    let (walks, _, weak, strong) = a_shop_walk(id);
    let url = format!("https://{host}/search?q=lamp");
    {
        let mut guard = walks.0.locked();
        let w = guard.get_mut(id).unwrap();
        for e in &mut w.trace.exchanges {
            e.url = url::Url::parse(&e.url.as_str().replace("shop.example", host)).unwrap();
        }
        w.url = url.clone();
    }
    (walks, url, weak, strong)
}

/// A second look that names another call than the first learned puts it in the first's place: the first is retired,
/// and what asked for it is led to the one that stands.
#[test]
fn a_second_look_that_names_another_call_puts_it_in_the_first_ones_place() {
    store::scratch_home("pick-takes-place");
    let (walks, url, weak, _) = a_walk_of("lamps-a.example", "w1");
    let first = keep_candidate(&walks, "w1", weak, "search shop items", "You").unwrap();
    assert_eq!(first.path, "/api/suggest?q={q}");
    verification_begins(&url);
    own_asks::asking(&[Ask::SecondLook], || verify_learned(&walks, &url, "search shop items", "You", "w1", &first, None));
    assert!(store::load_route(&first.id).is_none(), "the first learned is retired");
    let standing = store::took_the_place_of(&first.id).expect("the first's id leads to the one that stands");
    assert_eq!(standing.path, "/api/search?q={q}");
    assert!(!verifying(&url), "the site's mark goes when the look ends");
}

/// A second look that names the same call leaves the route standing under its id.
#[test]
fn a_second_look_that_names_the_same_call_leaves_the_route_standing() {
    store::scratch_home("pick-stands");
    let (walks, url, _, strong) = a_walk_of("lamps-b.example", "w1");
    let first = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    own_asks::asking(&[Ask::SecondLook], || verify_learned(&walks, &url, "search shop items", "You", "w1", &first, None));
    assert_eq!(store::load_route(&first.id).map(|r| r.path), Some("/api/search?q={q}".to_string()));
    assert!(store::took_the_place_of(&first.id).is_none());
}

/// A site that says it has few asks left is not asked a second look: the route stands as first learned, whatever a
/// second look would have named.
#[test]
fn a_site_with_few_asks_left_is_not_given_a_second_look() {
    store::scratch_home("pick-few-asks");
    let (walks, url, weak, _) = a_walk_of("lamps-c.example", "w1");
    let mut said = seen("GET", "https://lamps-c.example/api/suggest?q=lamp", "[]", false);
    said.response_headers.push(("x-ratelimit-remaining".into(), "1".into()));
    unbrowse_learn::budget::note(&said);
    let first = keep_candidate(&walks, "w1", weak, "search shop items", "You").unwrap();
    own_asks::asking(&[Ask::SecondLook], || verify_learned(&walks, &url, "search shop items", "You", "w1", &first, None));
    assert!(store::load_route(&first.id).is_some(), "stands as first learned");
    assert!(store::took_the_place_of(&first.id).is_none());
}

/// A route an agent picked from a walk is held to the site's links, and the site's mark of being verified is cleared
/// when that ends, whether or not the walk is still held.
#[test]
fn a_picked_route_clears_its_sites_verification_mark() {
    store::scratch_home("pick-hold");
    let (walks, url, _, strong) = a_walk_of("lamps-d.example", "w1");
    let route = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    verification_begins(&url);
    assert!(verifying(&url));
    hold_picked(&walks, "w1", &route.id, &url, "search shop items");
    assert!(!verifying(&url));
    verification_begins(&url);
    hold_picked(&walks, "gone", &route.id, &url, "search shop items");
    assert!(!verifying(&url), "a walk let go is no reason to leave the mark");
}

/// What the walk's call answered the ask with, read as the route reads it; nothing where the walk is gone.
#[test]
fn a_walks_answer_is_its_own_call_read_as_the_route_reads_it() {
    store::scratch_home("pick-walks-answer");
    let (walks, _, _, strong) = a_walk_of("lamps-e.example", "w1");
    let route = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    let given = HashMap::from([("q".to_string(), "lamp".to_string())]);
    let answer = walks_answer(&walks, "w1", &route, &given).expect("the walk made the call");
    assert_eq!(things_in(&answer), 8, "{answer}");
    assert!(walks_answer(&walks, "w2", &route, &given).is_none());
}

/// The text a walk's site served, and the scripts the page ran wherever they came from: not what another site's
/// plain calls answered.
#[test]
fn a_walks_text_is_its_sites_answers_and_the_scripts_it_ran() {
    store::scratch_home("pick-walked-text");
    let (walks, _, _, _) = a_walk_of("lamps-f.example", "w1");
    let mut script = seen("GET", "https://cdn.other.example/app.js", "var a = '/api/lamps';", false);
    script.resource_type = Some("Script".into());
    let ads = seen("GET", "https://ads.other.example/bid", "tracking", false);
    {
        let mut guard = walks.0.locked();
        guard.get_mut("w1").unwrap().trace.exchanges.extend([script, ads]);
    }
    let text = walked_text(&walks, "w1", &site_of("lamps-f.example"));
    assert!(text.contains("Desk lamp model 3") && text.contains("var a = '/api/lamps';"), "{text}");
    assert!(!text.contains("tracking"));
    assert_eq!(walked_text(&walks, "gone", "lamps-f.example"), "");
}

/// A route runs only with the page where a step of it is the page's own to make.
#[test]
fn a_route_needs_the_page_when_a_step_of_it_is_the_pages_to_make() {
    store::scratch_home("pick-needs-page");
    let (walks, _, _, strong) = a_walk_of("lamps-g.example", "w1");
    let mut route = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    assert!(!needs_the_page(&route));
    route.browser_assisted = true;
    assert!(needs_the_page(&route));
    route.browser_assisted = false;
    route.graph.steps.last_mut().unwrap().needs_browser = true;
    assert!(needs_the_page(&route));
}

fn action_line(t: f64, kind: &str, locator: Option<&str>, value: Option<&str>) -> String {
    let secret = value.is_some_and(|v| v.starts_with("vault:"));
    serde_json::json!({ "type": "action", "t": t, "action": kind, "selector": "@e1", "locator": locator, "value": value, "secret": secret }).to_string()
}

fn page_line(t: f64, url: &str, title: &str, cookie: &str) -> String {
    let headers = if cookie.is_empty() { serde_json::json!([]) } else { serde_json::json!([{ "name": "cookie", "value": cookie }]) };
    serde_json::json!({ "type": "exchange", "t": t, "resourceType": "Document", "entry": {
        "_resourceType": "Document",
        "request": { "method": "GET", "url": url, "headers": headers },
        "response": { "status": 200, "headers": [], "content": { "mimeType": "text/html", "text": format!("<html><head><title>{title}</title></head><body>{title}</body></html>") } } } })
    .to_string()
}

/// The browsing a node recorded of a site where the owner chose a country: the choice page, the click, the page after.
fn choosing_log(site: &str) -> String {
    [
        action_line(1.0, "navigate", None, Some(&format!("https://{site}/"))),
        page_line(1.5, &format!("https://{site}/"), "Choose your country", "seen=1"),
        action_line(2.0, "click", Some("a[href=\"/?c=us\"]"), None),
        page_line(3.0, &format!("https://{site}/?c=us"), "Shop: home", "seen=1; region=us"),
    ]
    .join("\n")
        + "\n"
}

fn a_main_page(url: &str, title: &str) -> Exchange {
    seen("GET", url, &format!("<html><head><title>{title}</title></head><body>{title}</body></html>"), true)
}

/// What a site's browsing shows it needs done is kept from its log, apart from any learning, and a walk that ends on
/// the page that asked is told it is asked again: the choice is the owner's, answered the same way.
#[test]
fn browsing_that_made_a_choice_is_noted_and_the_page_that_asks_it_again_is_known() {
    store::scratch_home("pick-note-setups");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "choices.example";
    std::fs::write(log_of(site), choosing_log(site)).unwrap();
    assert!(crate::setups::load(site).is_empty());
    note_setups(site);
    let kept = crate::setups::load(site);
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(kept[0].asks.as_deref(), Some("Choose your country"));
    let asked = Trace { exchanges: vec![a_main_page(&format!("https://{site}/"), "Choose your country")], inputs: Vec::new() };
    assert_eq!(choice_asked(&asked, site).map(|s| s.asks), Some(Some("Choose your country".to_string())));
    let answered = Trace { exchanges: vec![a_main_page(&format!("https://{site}/"), "Shop: home")], inputs: Vec::new() };
    assert!(choice_asked(&answered, site).is_none());
    let refused = Trace { exchanges: vec![seen("GET", &format!("https://{site}/"), "{}", false)], inputs: Vec::new() };
    assert!(choice_asked(&refused, site).is_none(), "no page, no question");
}

/// A walk the site sent on to the page the owner signs in on is told so, but a walk of that page itself is not.
/// The login is in the vault before it is typed, as a sign-in's is: one typed before the vault holds it is a sign-up
/// (`setups::a_sign_up`), and no sign-in is kept from it.
#[test]
fn a_walk_sent_to_the_sign_in_the_node_knows_is_told_so() {
    let _one = crate::testchain::one_at_a_time_blocking();
    store::scratch_home("pick-sign-in");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "signin.example";
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), site, "me", "stored", Some("hunter2-pass"), "You").unwrap();
    let t = store::now() as f64 + 10.0;
    let log = [
        action_line(t + 1.0, "navigate", None, Some(&format!("https://{site}/login"))),
        action_line(t + 2.0, "fill", Some("#email"), Some("me@mail.example")),
        action_line(t + 3.0, "click", Some("button[type=\"submit\"]"), None),
        action_line(t + 4.0, "fill", Some("#password"), Some(&format!("vault:{site}:me"))),
        action_line(t + 5.0, "fill", Some("#code"), Some(&format!("vault:code:{site}:me"))),
        action_line(t + 6.0, "press", None, Some("Enter")),
        action_line(t + 7.0, "click", Some("a.orders"), None),
    ]
    .join("\n")
        + "\n";
    std::fs::write(log_of(site), log).unwrap();
    note_setups(site);
    assert_eq!(crate::setups::load(site).len(), 1);
    let landed = Trace { exchanges: vec![a_main_page(&format!("https://{site}/login/"), "Sign in")], inputs: Vec::new() };
    assert!(sign_in_asked(&landed, &format!("https://{site}/orders"), site).is_some());
    assert!(sign_in_asked(&landed, &format!("https://{site}/login"), site).is_none(), "asked for the sign-in page itself");
    let elsewhere = Trace { exchanges: vec![a_main_page(&format!("https://{site}/about"), "About")], inputs: Vec::new() };
    assert!(sign_in_asked(&elsewhere, &format!("https://{site}/orders"), site).is_none());
}

/// A step that left the page ends the session's flow, on the site's mark and the session's own; one that stayed on
/// the page, or was refused, leaves it as it was.
#[test]
fn a_step_that_left_the_page_ends_the_flow_and_one_that_stayed_does_not() {
    store::scratch_home("pick-leaving");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let (site, session) = ("leaves.example", "1:leaver");
    leaving(site, session, 40.0).over(false);
    assert_eq!((flow_of(site, session), Marks::read(site).flow), (0.0, 0.0));
    leaving(site, session, 42.5).over(true);
    assert_eq!((flow_of(site, session), Marks::read(site).flow), (42.5, 42.5));
    leaving(site, session, 50.0).over(false);
    assert_eq!(flow_of(site, session), 42.5);
    leaving(site, "1:other", 60.0).over(true);
    assert_eq!((flow_of(site, "1:other"), flow_of(site, session)), (60.0, 42.5), "each session's flow is its own");
}

/// The reasons a read of browsing gives are the words the owner is told.
#[test]
fn a_browsing_that_could_not_be_read_says_why() {
    assert_eq!(Unread::Earlier.to_string(), "the socket opened before the browsing read");
    assert_eq!(Unread::from("the log is gone").to_string(), "the log is gone");
    assert_eq!(Unread::from(String::from("no disk")).to_string(), "no disk");
    store::scratch_home("pick-unread");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let why = browsed_from("never-browsed.example", 0, 0).unwrap_err();
    assert!(why.contains("hasn't browsed never-browsed.example"), "{why}");
}

/// A browsing read from a place in its log skips the requests before it, keeping what a page's socket did, and a
/// line cut in half is skipped.
#[test]
fn browsing_read_from_a_place_in_its_log_skips_what_is_before_it() {
    store::scratch_home("pick-browsed-from");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "readfrom.example";
    let call = |t: f64, path: &str| serde_json::json!({ "type": "exchange", "t": t, "resourceType": "XHR", "entry": { "request": { "method": "GET", "url": format!("https://{site}{path}"), "headers": [] }, "response": { "status": 200, "headers": [], "content": { "mimeType": "application/json", "text": "{}" } } } }).to_string();
    let open = serde_json::json!({ "type": "socket", "t": 1.0, "id": "s1", "event": "open", "url": format!("wss://{site}/ws") }).to_string();
    let lines = [open, call(2.0, "/old"), call(3.0, "/new")];
    std::fs::write(log_of(site), lines.join("\n") + "\n").unwrap();
    let start = (lines[0].len() + 1 + lines[1].len() + 1) as u64;
    let paths = |s: &unbrowse_learn::session::Session| s.trace.exchanges.iter().map(|e| e.url.path().to_string()).collect::<Vec<_>>();
    let from_there = browsed_from(site, start, start).unwrap();
    assert_eq!(paths(&from_there), ["/new"]);
    assert!(from_there.sockets.iter().all(|e| e.kind != "open"), "the socket's opening is before where the sockets are read from");
    let with_socket = browsed_from(site, start, 0).unwrap();
    assert_eq!(paths(&with_socket), ["/new"]);
    assert!(with_socket.sockets.iter().any(|e| e.kind == "open"), "the socket opened long before is read for");
    let mid_line = browsed_from(site, start - 10, start - 10).unwrap();
    assert_eq!(paths(&mid_line), ["/new"]);
}

fn walks_of(id: &str, url: &str, exchanges: Vec<Exchange>) -> Walks {
    let walks = Walks::default();
    walks.0.locked().insert(id.to_string(), Walk { url: url.to_string(), trace: Trace { exchanges, inputs: Vec::new() }, probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None });
    walks
}

fn a_search_answer(host: &str) -> Exchange {
    let records: Vec<_> = (0..8).map(|i| serde_json::json!({ "id": 100 + i, "title": format!("Desk lamp model {i}"), "price": 10 + i, "sku": format!("L-{i}") })).collect();
    seen("GET", &format!("https://{host}/api/search?q=lamp"), &serde_json::json!({ "results": records }).to_string(), false)
}

/// A walk read again for its pick (the second look's own reading) says what it scored, which call it picked and by
/// what, and what it saved: the same three words the owner's window shows.
#[test]
fn a_walk_read_again_says_what_it_scored_picked_and_saved() {
    store::scratch_home("pick-eye");
    let (walks, url, _, strong) = a_walk_of("lamps-h.example", "w1");
    let said = Mutex::new(Vec::new());
    let eye = |e: Eye| {
        said.locked().push(match e {
            Eye::Scored { candidates, .. } => format!("scored {}", candidates.iter().map(|c| c.path.as_str()).collect::<Vec<_>>().join(" > ")),
            Eye::Picked { index, path, by, .. } => format!("picked {index} {path} by {by}"),
            Eye::Saved { what, inputs, .. } => format!("saved {what} taking {}", inputs.join(",")),
            _ => "other".to_string(),
        })
    };
    let (route, by) = pick_and_keep(&walks, &url, "search shop items", "You", "w1", &eye, None, true).unwrap_or_else(|_| panic!("a pick"));
    assert_eq!((route.path.as_str(), by), ("/api/search?q={q}", "the rule"));
    let said = said.into_inner().unwrap();
    assert_eq!(said.len(), 3, "{said:?}");
    assert!(said[0].starts_with("scored /api/search"), "the call that answers is scored first: {said:?}");
    assert_eq!(said[1], format!("picked {strong} /api/search by the rule"));
    assert_eq!(said[2], "saved search shop items taking q");
}

/// A pick is read again only from a walk that is held, and never for a goal that changes something: those need hands.
#[test]
fn a_walk_that_is_gone_or_a_goal_that_changes_something_is_no_pick() {
    store::scratch_home("pick-no-pick");
    let (walks, url, _, _) = a_walk_of("lamps-i.example", "w1");
    assert!(matches!(pick_and_keep(&walks, &url, "search shop items", "You", "gone", &no_eye, None, true), Err(Unlearned::Loading)));
    assert!(matches!(pick_and_keep(&walks, &url, "buy a lamp", "You", "w1", &no_eye, None, true), Err(Unlearned::Loading)));
    assert!(matches!(pick_and_keep(&walks, "ftp://lamps-i.example/x", "search shop items", "You", "w1", &no_eye, None, true), Err(Unlearned::Unwalkable(_))));
}

/// A walk whose last page asks for a person keeps no route: that is what stood between the walk and an answer.
#[test]
fn a_walk_that_ended_on_the_sites_check_is_told_so() {
    store::scratch_home("pick-check");
    let url = "https://lamps-j.example/search?q=lamp";
    let page = seen("GET", url, "<html><head><title>Just a moment</title></head><body>Please verify you are human to continue.</body></html>", true);
    let walks = walks_of("w1", url, vec![page, a_search_answer("lamps-j.example")]);
    let got = pick_and_keep(&walks, url, "search shop items", "You", "w1", &no_eye, None, true);
    assert!(matches!(&got, Err(Unlearned::Check(why, "learn.fails_goal")) if why.contains("check for a person")), "{:?}", got.err().map(|e| e.to_string()));
}

/// A page whose own ask the site refused keeps nothing else the page fetched as its answer.
#[test]
fn a_page_whose_own_ask_the_site_refused_keeps_no_other_call() {
    store::scratch_home("pick-refused");
    let url = "https://lamps-k.example/search?q=lamp";
    let page = seen("GET", url, "<html><body><h1>Lamps</h1></body></html>", true);
    let mut refused = seen("GET", "https://lamps-k.example/api/search?q=lamp", "{}", false);
    refused.status = 429;
    let featured = seen("GET", "https://lamps-k.example/api/featured", r#"{"items":[{"title":"A","price":1},{"title":"B","price":2},{"title":"C","price":3}]}"#, false);
    let walks = walks_of("w1", url, vec![page, refused, featured]);
    let got = pick_and_keep(&walks, url, "search shop items", "You", "w1", &no_eye, None, true);
    assert!(matches!(&got, Err(Unlearned::Door(why, "learn.the_pages_ask_was_refused")) if why.contains("\"lamp\"") && why.contains("asked too often")), "{:?}", got.err().map(|e| e.to_string()));
}

/// A page the site says is not there is gone, not a page to learn from what it loaded.
#[test]
fn a_page_the_site_does_not_have_is_gone() {
    store::scratch_home("pick-gone");
    let url = "https://lamps-l.example/search?q=lamp";
    let mut page = seen("GET", url, "<html><head><title>Page not found</title></head><body>Sorry</body></html>", true);
    page.status = 404;
    let walks = walks_of("w1", url, vec![page, a_search_answer("lamps-l.example")]);
    assert!(matches!(pick_and_keep(&walks, url, "search shop items", "You", "w1", &no_eye, None, true), Err(Unlearned::Gone(_))));
}

/// A walk whose answer lists nothing for the value asked teaches no route, and what was kept for it is let go.
#[test]
fn a_walk_that_found_nothing_for_the_value_keeps_no_route() {
    store::scratch_home("pick-nothing");
    let url = "https://lamps-m.example/search?q=lamp";
    let page = seen("GET", url, "<html><body><h1>Search</h1><p>No results for lamp</p></body></html>", true);
    let empty = seen("GET", "https://lamps-m.example/api/search?q=lamp", r#"{"query":"lamp","results":[],"total":0}"#, false);
    let walks = walks_of("w1", url, vec![page, empty]);
    let got = pick_and_keep(&walks, url, "search shop items", "You", "w1", &no_eye, None, true);
    assert!(matches!(got, Err(Unlearned::Nothing(_))), "{:?}", got.err().map(|e| e.to_string()));
    assert!(store::load_routes().iter().all(|r| r.site != "lamps-m.example"), "no route is left for it");
}

fn exchange_line(t: f64, kind: &str, method: &str, url: &str, mime: &str, text: &str) -> String {
    serde_json::json!({"type":"exchange","t":t,"resourceType":kind,"entry":{"request":{"method":method,"url":url,"headers":[]},"response":{"status":200,"headers":[],"content":{"mimeType":mime,"text":text}}}}).to_string()
}

/// A transfer the owner made on `site`: the form, the accounts it lists, an amount typed and an account chosen (and a
/// note typed that no call carried when `note`), and the call that sent it at 3.0.
fn a_transfer_log(site: &str, note: bool) -> String {
    let form = r#"<html><body><form><input id=amount><input id=memo><select id=fromAccountId></select><select id=toAccountId></select></form></body></html>"#;
    let call = format!("https://{site}/services/transfer?fromAccountId=28329&toAccountId=28440&amount=1");
    let act = |t: f64, kind: &str, selector: &str, value: &str| serde_json::json!({"type":"action","t":t,"action":kind,"selector":selector,"value":value,"secret":false}).to_string();
    let mut lines = vec![
        serde_json::json!({"type":"action","t":1.0,"action":"navigate","value":format!("https://{site}/transfer"),"secret":false}).to_string(),
        exchange_line(1.5, "Document", "GET", &format!("https://{site}/transfer"), "text/html", form),
        exchange_line(1.6, "XHR", "GET", &format!("https://{site}/services/accounts"), "application/json", r#"[{"id":28329,"balance":100},{"id":28440,"balance":50}]"#),
        act(2.0, "fill", "@e5", "1"),
        act(2.5, "select", "@e7", "28440"),
    ];
    lines.push(exchange_line(3.0, "XHR", "POST", &call, "application/json", r#"{"message":"Successfully transferred $1 from account #28329 to account #28440"}"#));
    if note {
        lines.push(act(3.5, "fill", "@e6", "rent for may"));
    }
    lines.join("\n") + "\n"
}

/// `learn_auto` until it ran: a learn already running (another test's) leaves this one to the next command.
fn learn_auto_when_free(site: &str, until: f64, ran: impl Fn() -> bool) -> Option<(Route, f64)> {
    for _ in 0..100 {
        let got = learn_auto(site, "1:a", Some(until), "agent", &no_eye);
        if got.is_some() || ran() {
            return got;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    None
}

fn the_activity(what: &str) -> Vec<store::Activity> {
    store::read_activity(50).into_iter().filter(|a| a.what.starts_with(what)).collect()
}

/// What the owner typed and a call sent is learned as they browse, kept as theirs, and the log's mark moves past that
/// call: a flow with nothing new to send says so and learns nothing; the same call found again is known, not kept twice.
#[test]
fn browsing_that_sent_what_was_typed_is_kept_as_the_owners_route_once() {
    store::scratch_home("pick-learn-auto");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "bank-a.example";
    std::fs::write(log_of(site), a_transfer_log(site, false)).unwrap();
    Marks { flow: 0.5, sent: 0.5, at: 0 }.write(site);
    let (route, at) = learn_auto_when_free(site, 4.0, || false).expect("the transfer is learned");
    assert_eq!((route.site.as_str(), route.method.as_str(), route.yours), (site, "POST", true));
    assert!(route.path.starts_with("/services/transfer"), "{}", route.path);
    assert_eq!(at, 3.0);
    assert_eq!(store::load_route(&route.id).map(|r| r.yours), Some(true), "kept on disk");
    assert_eq!(Marks::read(site).sent, 3.0, "what was sent is not learned again");
    assert!(the_activity("Nothing to learn").is_empty());
    // The same flow again: nothing was typed after that call.
    assert!(learn_auto_when_free(site, 4.0, || !the_activity("Nothing to learn from that page").is_empty()).is_none());
    let skipped = the_activity("Nothing to learn from that page");
    assert_eq!((skipped.len(), skipped[0].result.as_str(), skipped[0].kind.as_str(), skipped[0].site.as_str()), (1, "skipped", "learn", site));
    assert!(skipped[0].note.as_deref().is_some_and(|n| !n.is_empty()), "it says why");
    // The mark lost (a node restarted): the call is found again, and the node knows it.
    std::fs::remove_file(Marks::path(site)).unwrap();
    let (again, _) = learn_auto_when_free(site, 4.0, || false).expect("known");
    assert_eq!(again.id, route.id);
    assert_eq!(the_activity("Already knows").len(), 1);
    assert_eq!(store::load_routes().iter().filter(|r| r.site == site).count(), 1);
}

/// A flow still open (no `until`) that typed something no call carried learns nothing, and says nothing in the owner's
/// activity: only a page the owner left is reported.
#[test]
fn a_flow_still_open_that_has_nothing_to_send_leaves_no_note_in_the_activity() {
    store::scratch_home("pick-open-flow");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "bank-b.example";
    let never_sent: String = a_transfer_log(site, false).lines().filter(|l| !l.contains("/services/transfer?")).collect::<Vec<_>>().join("\n") + "\n";
    std::fs::write(log_of(site), never_sent).unwrap();
    Marks { flow: 0.5, sent: 0.5, at: 0 }.write(site);
    assert!(learn_now(site, "1:a", "agent", &no_eye).is_none());
    assert!(the_activity("Nothing to learn").is_empty());
    assert!(store::load_routes().iter().all(|r| r.site != site));
}

/// What was typed and left by no call is the owner's to know: the route is kept and says it may not carry all of it.
#[test]
fn a_route_learned_with_something_it_cannot_send_says_so() {
    store::scratch_home("pick-cant-send");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "bank-c.example";
    std::fs::write(log_of(site), a_transfer_log(site, true)).unwrap();
    Marks { flow: 0.5, sent: 0.5, at: 0 }.write(site);
    let (route, _) = learn_auto_when_free(site, 4.0, || false).expect("learned");
    let said: Vec<_> = the_activity("Learned").into_iter().filter(|a| a.what.contains("can't send")).collect();
    assert_eq!(said.len(), 1, "{said:?}");
    assert!(said[0].what.contains(&route.what), "{}", said[0].what);
    assert_eq!((said[0].result.as_str(), said[0].site.as_str()), ("done", site));
    assert!(said[0].note.as_deref().is_some_and(|n| n.contains("@e6") && n.contains("isn't part of the route")), "{:?}", said[0].note);
}

/// A flow whose goal only reads never keeps a call that may change something, even one that carried what was typed.
#[test]
fn a_goal_that_only_reads_never_keeps_a_call_that_changes_something() {
    store::scratch_home("pick-read-goal");
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let site = "bank-d.example";
    std::fs::write(log_of(site), a_transfer_log(site, false)).unwrap();
    Marks { flow: 0.5, sent: 0.5, at: 0 }.write(site);
    crate::browse::set_goal(site, "1:a", "list the accounts");
    assert!(learn_now(site, "1:a", "agent", &no_eye).is_none());
    assert!(store::load_routes().iter().all(|r| r.site != site), "nothing kept");
    // The same flow for a goal that is not only a read is kept.
    crate::browse::set_goal(site, "1:a", "transfer money");
    assert!(learn_now(site, "1:a", "agent", &no_eye).is_some_and(|(r, _)| r.write));
}

/// A try of a page takes the one place there is for it: tests of it take turns, or one finds the place taken.
static TRIES: Mutex<()> = Mutex::new(());

/// A route's page that no browser could be walked is a failed try: counted on the route, the time kept, so the node
/// stops after `PAGE_TRIES` and does not try again within the gap.
#[test]
fn a_try_of_a_page_that_could_not_be_walked_is_counted_against_the_route() {
    let _turn = TRIES.locked();
    store::scratch_home("pick-try-page");
    let (walks, _, _, strong) = a_walk_of("lamps-t.example", "w1");
    let mut route = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    route.root = "http://127.0.0.1:1/search?q=lamp".into();
    store::save_route(&route).unwrap();
    assert_eq!(route.page_tries.failed, 0);
    try_the_page(&route.id);
    let after = store::load_route(&route.id).unwrap();
    assert_eq!(after.page_tries.failed, 1, "one try failed");
    assert!(after.page_tries.at > 0 && !after.tried_page);
    assert!(!page_try_due(&after, after.page_tries.at + 60), "not again within the gap");
    assert!(page_try_due(&after, after.page_tries.at + PAGE_TRY_GAP));
}

/// A route of a paused node, or of a site the owner excluded, is never tried: no browser opens for it.
#[test]
fn a_paused_node_tries_no_pages() {
    let _turn = TRIES.locked();
    store::scratch_home("pick-try-paused");
    let (walks, _, _, strong) = a_walk_of("lamps-u.example", "w1");
    let mut route = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    route.root = "http://127.0.0.1:1/search?q=lamp".into();
    store::save_route(&route).unwrap();
    let mut settings = store::load_settings();
    settings.paused = true;
    store::save_settings(&settings).unwrap();
    try_the_page(&route.id);
    assert_eq!(store::load_route(&route.id).unwrap().page_tries.failed, 0);
    settings.paused = false;
    settings.excluded = vec!["lamps-u.example".to_string()];
    store::save_settings(&settings).unwrap();
    try_the_page(&route.id);
    assert_eq!(store::load_route(&route.id).unwrap().page_tries.failed, 0);
}

/// A route the node already has is the same call on the same site taking the same inputs, whatever value a piece of
/// its address holds; another set of inputs, another site or another method is another route.
#[test]
fn a_route_the_node_already_has_is_the_same_call_with_the_same_inputs() {
    store::scratch_home("pick-known");
    let (walks, _, _, strong) = a_walk_of("lamps-v.example", "w1");
    let route = keep_candidate(&walks, "w1", strong, "search shop items", "You").unwrap();
    assert_eq!(known(&route).map(|r| r.id), Some(route.id.clone()));
    let mut shaped = route.clone();
    shaped.id = "other".into();
    shaped.path = "/api/search/{part3}".into();
    assert!(known(&shaped).is_none(), "another address is another call");
    let mut like = route.clone();
    like.id = "like".into();
    assert_eq!(known(&like).map(|r| r.id), Some(route.id.clone()));
    let mut more = route.clone();
    more.id = "more".into();
    more.inputs.push(more.inputs[0].clone());
    more.inputs.last_mut().unwrap().name = "sort".into();
    assert!(known(&more).is_none(), "another set of inputs is another route");
    let mut post = route.clone();
    post.method = "POST".into();
    assert!(known(&post).is_none());
    let mut elsewhere = route;
    elsewhere.site = "lamps-w.example".into();
    assert!(known(&elsewhere).is_none());
}

/// A host's jar is the browser's word for the session a route runs with: no browser running changes nothing, and a
/// host the owner excluded is never touched.
#[test]
fn a_jar_is_left_as_it_was_when_no_browser_says_otherwise() {
    store::scratch_home("pick-jar");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let host = "jar.example";
    refresh_jar(host, host);
    assert!(!store::jar_path(host).exists(), "nothing held, nothing written");
    let jar = std::collections::BTreeMap::from([("sid".to_string(), "a1".to_string())]);
    store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &jar).unwrap();
    refresh_jar(host, host);
    let now: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path(host), &unbrowse_files::JAR);
    assert_eq!(now, jar);
    let mut settings = store::load_settings();
    settings.excluded = vec![host.to_string()];
    store::save_settings(&settings).unwrap();
    store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid".to_string(), "b2".to_string())])).unwrap();
    refresh_jar(host, host);
    let now: std::collections::BTreeMap<String, String> = store::read_json(&store::jar_path(host), &unbrowse_files::JAR);
    assert_eq!(now.get("sid").map(String::as_str), Some("b2"));
}

/// A walk's capture on disk reads back as the calls the site answered; a session nobody recorded is no walk.
#[test]
fn a_walks_capture_reads_back_as_the_calls_it_made() {
    let dir = std::env::temp_dir().join(format!("pick-capture-{}-{}", std::process::id(), store::now()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("w9.jsonl"),
        concat!(
            r#"{"type":"request","requestId":"1","method":"GET","url":"https://cap.example/api/search?q=lamp","resourceType":"XHR","headers":{}}"#, "\n",
            r#"{"type":"response","requestId":"1","url":"https://cap.example/api/search?q=lamp","status":200,"mimeType":"application/json","headers":{},"body":"{\"hits\":[1,2]}"}"#, "\n",
        ),
    )
    .unwrap();
    let trace = trace_from_walk(&dir, "w9").expect("a walk");
    assert_eq!(trace.exchanges.len(), 1);
    assert_eq!((trace.exchanges[0].method.as_str(), trace.exchanges[0].url.path(), trace.exchanges[0].status), ("GET", "/api/search", 200));
    assert_eq!(trace.exchanges[0].response_body.as_deref(), Some(r#"{"hits":[1,2]}"#));
    assert!(trace_from_walk(&dir, "never-walked").is_none_or(|t| t.exchanges.is_empty()));
    let _ = std::fs::remove_dir_all(&dir);
}
