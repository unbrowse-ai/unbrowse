//! Goal behaviour that the shared `api/tests.rs` leaves out: what a route's own second call says of it, and what the
//! walk's own first answer carries.

use super::*;

fn agent_node(home: &std::path::Path) -> (tokio::runtime::Runtime, Arc<Node>, Agent) {
    agent_node_with(home, None)
}

/// As `agent_node`, its runtime's threads (and the test's) naming `browser` as the node's browser.
fn agent_node_with(home: &std::path::Path, browser: Option<String>) -> (tokio::runtime::Runtime, Arc<Node>, Agent) {
    let (h, b) = (home.to_path_buf(), browser.clone());
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(32 << 20)
        .enable_all()
        .on_thread_start(move || {
            store::use_home(&h);
            crate::browsers::for_this_test(b.clone());
        })
        .build()
        .unwrap();
    store::use_home(home);
    crate::browsers::for_this_test(browser);
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (agent, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let node = Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    (rt, node, agent)
}

/// A site on 127.0.0.1 whose answer is `answer(path)`, as JSON.
fn site(answer: impl Fn(&str) -> String + Send + 'static) -> u16 {
    use std::io::{BufRead, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            let path = first.split_whitespace().nth(1).unwrap_or_default().to_string();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let body = answer(&path);
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", if body.starts_with('<') { "text/html" } else { "application/json" }, body.len());
        }
    });
    port
}

/// A read route on the site at `port` taking `q` in the query, learned on `was`, the page offering `offers` besides.
fn search_route(id: &str, port: u16, was: &str, offers: &[&str]) -> store::Route {
    let mut r: store::Route = serde_json::from_value(json!({
        "id": id, "site": "127.0.0.1", "what": "search the items", "method": "GET", "path": "/items", "root": format!("http://127.0.0.1:{port}/items?q={was}"),
        "inputs": [{ "name": "q", "secret": false, "default": was, "options": offers.iter().map(|o| json!({ "value": o })).collect::<Vec<_>>() }],
        "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 0,
        "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/items?q={{q}}"), "needs_browser": false,
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": was }] }] }
    }))
    .unwrap();
    r.given = vec![];
    store::save_route(&r).unwrap();
    r
}

/// The values a page asks for are tried against the route: a site that answers each alike (its own words, none of the
/// value) is one whose route does not hear its input, and the input is named; a site that answers each value with that
/// value says the route hears it.
#[test]
fn a_route_the_site_answers_alike_for_every_value_is_deaf_to_its_input() {
    let home = store::scratch_home("goal-cov-deaf");
    let (rt, node, agent) = agent_node(&home);
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    let deaf_port = site(|_| json!({ "results": ["Kettle shop front page", "Featured product listing", "Current opening hours"] }).to_string());
    let hearing_port = site(|path| json!({ "results": [format!("matches for {path}")] }).to_string());
    let deaf = search_route("goal-cov-deaf-route", deaf_port, "kettle", &["teapot"]);
    let hears = search_route("goal-cov-hearing-route", hearing_port, "kettle", &["teapot"]);
    let given = HashMap::from([("q".to_string(), "kettle".to_string())]);
    let ask = |route: store::Route, port: u16| {
        let (n, a, given) = (node.clone(), agent.clone(), given.clone());
        rt.block_on(async move { deaf_to(&n, &a, &route, &given, &format!("http://127.0.0.1:{port}/items?q=kettle")).await })
    };
    assert_eq!(ask(deaf.clone(), deaf_port), None, "a node that doesn't ask the site again for the page's values says nothing");
    let asking = |route: store::Route, port: u16| learn::own_asks::asking(&[learn::own_asks::Ask::PageValues], || ask(route, port));
    assert_eq!(asking(deaf, deaf_port).as_deref(), Some("q"), "every value answered alike: the input is not heard");
    assert_eq!(asking(hears, hearing_port), None, "each value answered with its own: the input is heard");
    let _ = std::fs::remove_dir_all(&home);
}

fn ask_of(goal: &str, url: &str, many: bool, browser: &str) -> DoBody {
    DoBody { goal: goal.into(), url: url.into(), inputs: HashMap::new(), session: String::new(), browser: browser.into(), fields: Vec::new(), many, budget_usdc: None }
}

/// `do_goal` on a runtime worker (its future is deep: the test thread's own stack is small).
fn goal_of(rt: &tokio::runtime::Runtime, node: &Arc<Node>, agent: &Agent, ask: DoBody) -> Result<Value, Fail> {
    let (n, a) = (node.clone(), agent.clone());
    rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(120), tokio::spawn(async move { do_goal(&n, &a, ask).await })).await.expect("answered").expect("ran") })
}

/// A JSON search on 127.0.0.1 that answers every word with the kettles' list: a site that doesn't hear the word.
fn kettle_body() -> String {
    json!({ "query": "kettle", "results": (0..6).map(|n| json!({ "id": n, "title": format!("kettle item number {n}") })).collect::<Vec<_>>() }).to_string()
}

/// A route that stood on one sighting, called for a value the site then answers with the first value's list, is not
/// served. The direct page call's doubt reaches the caller, and learning the same response again cannot erase it.
#[test]
fn a_new_value_the_site_answers_with_the_old_values_list_puts_the_routes_call_in_doubt() {
    let home = store::scratch_home("goal-cov-doubt");
    let (rt, node, agent) = agent_node(&home);
    store::save_settings(&store::Settings { private_network: true, fetch_browser: false, ..store::Settings::default() }).unwrap();
    let port = site(|_| kettle_body());
    let url = format!("http://127.0.0.1:{port}/api/items?q=kettle");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    crate::learn::sighted::called(&route, &HashMap::new(), Some(&serde_json::from_str(&kettle_body()).unwrap()), true, 40, 0);
    let next = format!("http://127.0.0.1:{port}/api/items?q=teapot");
    let r = goal_of(&rt, &node, &agent, ask_of("search the items", &next, true, "never"));
    let (status, said) = r.expect_err("the doubtful call is not handed over");
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
    assert!(said.contains("it answered what the walk asked"), "the caller hears why the response was refused: {said}");
    assert_eq!(store::load_routes().len(), 1, "the same response did not become a newly learned route");
    let stood = store::load_route(&route.id).expect("the route stands");
    assert!(stood.heard.said_back.is_none(), "an answer that doesn't say teapot is no second sighting: {:?}", stood.heard);
    let _ = std::fs::remove_dir_all(&home);
}

/// A learn's first reply from the walk's own answer is a call's reply, with the records counted where the route's
/// records were seen, and the answer is written down whole as the route's first sighting; an answer that is another
/// page's is no reply, and nothing is written.
#[test]
fn the_walks_own_answer_is_a_replys_records_counted_where_they_were_seen() {
    let home = store::scratch_home("goal-cov-walks-answer");
    store::use_home(&home);
    let mut route = search_route("goal-cov-walks-answer", 1, "kettle", &[]);
    route.heard.records_at = Some("results".into());
    let whole = serde_json::from_str::<Value>(&kettle_body()).unwrap().into();
    let inputs = HashMap::from([("q".to_string(), "kettle".to_string())]);
    let reply = walk_served(&route, &inputs, &[], &whole, 12);
    assert_eq!(reply["records"], json!(6), "counted at the place the records were seen: {reply}");
    assert_eq!(reply["ok"], json!(true));
    let subject: Vec<String> = Vec::new();
    let ask = Asked { url: "http://127.0.0.1:1/items?q=kettle", goal: "search the items", subject: &subject, reworded: false, sibling: false, given: &inputs };
    let taken = take_the_walks_answer(&route, &inputs, &[], &whole, &ask, 12).expect("an answer that holds the goal is the reply");
    assert_eq!(taken["records"], json!(6));
    assert!(learn::sighted::first_answer(&route).is_some(), "the answer is written as the route's first sighting");
    // A page that is another's: no reply.
    let other = Asked { url: "http://127.0.0.1:1/catalog/teapot", subject: &["teapot".to_string()], ..ask };
    let mut second = route.clone();
    second.id = "goal-cov-walks-answer-other".into();
    assert!(take_the_walks_answer(&second, &inputs, &[], &whole, &other, 12).is_none(), "its answer lists other things, never this page's");
    assert!(learn::sighted::first_answer(&second).is_none(), "and nothing is written for it");
    let _ = std::fs::remove_dir_all(&home);
}

/// With learning turned off by the owner, a page no route does is not learned or walked: the ask is refused and says so.
#[test]
fn a_node_whose_owner_turned_learning_off_refuses_a_page_no_route_does() {
    let home = store::scratch_home("goal-cov-learning-off");
    let (rt, node, agent) = agent_node(&home);
    store::save_settings(&store::Settings { private_network: true, map_while_browsing: false, ..store::Settings::default() }).unwrap();
    let port = site(|_| kettle_body());
    let url = format!("http://127.0.0.1:{port}/api/items?q=kettle");
    let (status, said) = goal_of(&rt, &node, &agent, ask_of("search the items", &url, false, "auto")).expect_err("nothing is learned");
    assert_eq!(status, StatusCode::FORBIDDEN, "{said}");
    assert!(said.contains("no route does that, and the owner has turned learning off"), "{said}");
    assert!(store::load_routes().is_empty(), "no route was kept: {:?}", store::load_routes().len());
    let _ = std::fs::remove_dir_all(&home);
}

/// A route an agent judged wrong for a page is passed over, and a page whose plain request finds only that call again
/// is handed to the agent to drive, among many, with the judgement said beside it as the route that failed.
#[test]
fn a_page_whose_only_call_an_agent_judged_wrong_is_handed_over_with_the_judgement_said() {
    let home = store::scratch_home("goal-cov-judged-wrong");
    let (rt, node, agent) = agent_node(&home);
    store::save_settings(&store::Settings { private_network: true, fetch_browser: false, ..store::Settings::default() }).unwrap();
    let port = site(|_| kettle_body());
    let url = format!("http://127.0.0.1:{port}/api/items?q=kettle");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    let page = store::page_key(&url).expect("a page");
    store::update_route(&route.id, |r| r.judged.wrong.push(store::WrongPage { page: page.clone(), why: "it lists the wrong shop".into(), by: "an agent".into(), at: store::now() })).unwrap();
    let r = goal_of(&rt, &node, &agent, ask_of("search the items", &url, true, "never")).unwrap_or_else(|f| panic!("{f:?}"));
    assert_eq!(r["how"], "browse", "{r}");
    assert!(r["why"].as_str().is_some_and(|w| w.contains("it lists the wrong shop")), "{r}");
    assert_eq!(r["route_failed"]["route_id"], json!(route.id), "{r}");
    assert!(r["route_failed"]["error"].as_str().is_some_and(|e| e.contains("an agent judged its answer wrong for this page")), "{r}");
    let _ = std::fs::remove_dir_all(&home);
}
