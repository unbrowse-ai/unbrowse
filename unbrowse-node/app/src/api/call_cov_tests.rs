//! UNB-208: tests of what a call answers, and of the agent API's doors around it (`api.rs`, `api/pages.rs`,
//! `api/mcp.rs`, `api/signed.rs`, `api/asks.rs`), driven as an agent or a client drives them: a local site on
//! 127.0.0.1 that records what it heard, a node with no chain, and a scratch home for each test.

use super::super::*;
use serde_json::json;

/// A scratch home, a runtime that carries it to its threads, a node with no chain and one agent.
fn world(name: &str) -> (std::path::PathBuf, tokio::runtime::Runtime, Arc<Node>, Agent) {
    let home = store::scratch_home(name);
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    let node = crate::testchain::node(name);
    let (agent, _) = agents::create(node.keys.as_ref(), "agent", 100.0, 30, 0).unwrap();
    (home, rt, node, agent)
}

/// A site on 127.0.0.1: what each request's first line said, and the status and body it is answered with, by `reply`.
fn site(reply: impl Fn(&str) -> (&'static str, String) + Send + 'static) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    use std::io::{BufRead, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = heard.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let first = first.trim().to_string();
            kept.lock().unwrap().push(first.clone());
            let (status, body) = reply(&first);
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (port, heard)
}

/// A route of this node's own on the site at `port`, its `steps` as the graph says them, kept under `id`.
fn kept_route(id: &str, port: u16, steps: Value, inputs: Value) -> store::Route {
    let r: store::Route = serde_json::from_value(json!({
        "id": id, "site": "127.0.0.1", "what": "list the lamps", "method": "GET", "path": "/items",
        "root": format!("http://127.0.0.1:{port}/"), "inputs": inputs, "steps": 1, "browser_assisted": false, "walk_without_fragment": true,
        "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": steps }
    }))
    .unwrap();
    store::save_route(&r).unwrap();
    r
}

fn get_step(port: u16, path: &str) -> Value {
    json!({ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}{path}"), "needs_browser": false, "fields": [] })
}

/// `r` as a body fetched from another node's entry `name`, run as if this node had learned it (the test's site is plain
/// HTTP on this machine, which no route of someone else's may reach), and kept.
fn fetched_route(mut r: store::Route, name: &str) -> store::Route {
    let content = chain::test_content(name);
    crate::share::run_as_own_in_tests(&content);
    r.fetched = Some(store::Fetched { entry_id: format!("{:#x}", chain::test_entry(name)), route_id: r.id.clone(), agent_id: "0x0c".into(), content_id: content, listed_as: "list the lamps".into(), fetched_at: 1 });
    store::save_route(&r).unwrap();
    r
}

fn bearer(token: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("authorization", format!("Bearer {token}").parse().unwrap());
    h
}

// ---- call.rs ----

/// A body kept from another contributor that was set aside since is never run, and its copy goes: nothing is sent to
/// the site, the caller hears why, and the next call finds no copy to run.
#[test]
fn a_kept_copy_set_aside_since_is_not_run_and_is_let_go() {
    let (home, rt, node, agent) = world("cov-kept-aside");
    let (port, heard) = site(|_| ("200 OK", r#"{"items":[1]}"#.into()));
    let route = fetched_route(kept_route("cov-kept-aside", port, json!([get_step(port, "/items")]), json!([])), "cov-kept-aside");
    node.share.set_aside(&route.fetched.as_ref().unwrap().content_id, "its contributor's body was found to reach elsewhere");
    let (status, why) = rt.block_on(run_route(&node, &agent, route, HashMap::new(), None, Vec::new())).expect_err("not run");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(why.contains("no longer passes the checks a fetched body passes") && why.contains("reach elsewhere"), "{why}");
    assert!(heard.lock().unwrap().is_empty(), "nothing reached the site: {:?}", heard.lock().unwrap());
    assert!(store::load_route("cov-kept-aside").is_none(), "the copy is let go");
    let _ = std::fs::remove_dir_all(&home);
}

/// A body fetched and paid for, whose site's robots.txt opts out of Unbrowse, is not called; it rests, so a goal doesn't
/// fetch it again at once, and the refusal is a line in the owner's activity. Nothing but the robots file is read.
#[test]
fn a_fetched_body_whose_site_opted_out_rests_and_is_not_called() {
    let (home, rt, node, agent) = world("cov-fetched-optout");
    let (port, heard) = site(|first| if first.contains("/robots.txt") { ("200 OK", "User-agent: Unbrowse\nDisallow: /".into()) } else { ("200 OK", r#"{"items":[1]}"#.into()) });
    crate::optout::READ_IN_TESTS.locked().push(format!("http://127.0.0.1:{port}"));
    let route = fetched_route(kept_route("cov-fetched-optout", port, json!([get_step(port, "/items")]), json!([])), "cov-fetched-optout");
    let content = route.fetched.as_ref().unwrap().content_id.clone();
    const OWN_EPOCH: u64 = 913_901;
    let held = chain::reserve(agent.index, OWN_EPOCH, 0.5, 0.0, 0.5, 100.0).unwrap();
    let paying = Use { entry: chain::test_entry("cov-fetched-optout"), contributor: Default::default(), server: None, server_peer: None, epoch: OWN_EPOCH, held: Some(held), body: Vec::new() };
    let (status, why) = rt.block_on(run_route(&node, &agent, route, HashMap::new(), Some(paying), Vec::new())).expect_err("refused");
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(why.contains("robots"), "{why}");
    assert_eq!(node.share.resting(&content).as_deref(), Some(why.as_str()), "the body rests with the site's word");
    assert_eq!(heard.lock().unwrap().as_slice(), ["GET /robots.txt HTTP/1.1"], "only the robots file was read");
    assert!(chain::receipts(agent.index, OWN_EPOCH).unwrap().is_empty(), "no line for a call never made");
    let _ = std::fs::remove_dir_all(&home);
}

/// A kept copy of another contributor's body that fails when run is let go, so the next call fetches the entry afresh,
/// and the call says it failed, with what the site answered.
#[test]
fn a_kept_copy_that_failed_when_run_is_let_go() {
    let (home, rt, node, agent) = world("cov-kept-failed");
    let (port, heard) = site(|_| ("500 Internal Server Error", r#"{"error":"COV-SITE-WORDS"}"#.into()));
    let route = fetched_route(kept_route("cov-kept-failed", port, json!([get_step(port, "/items")]), json!([])), "cov-kept-failed");
    let r = rt.block_on(run_route(&node, &agent, route, HashMap::new(), None, Vec::new())).expect("the call ran");
    assert_eq!(r["ok"], false, "{r}");
    assert_eq!(r["network"]["cached"], true, "{r}");
    assert_eq!(heard.lock().unwrap().len(), 1);
    assert!(store::load_route("cov-kept-failed").is_none(), "a copy that failed is let go");
    let _ = std::fs::remove_dir_all(&home);
}

/// A call of a route on the site at `port` with these `steps`, `inputs` and values `given`: its answer.
fn called(name: &str, steps: impl Fn(u16) -> Value, inputs: Value, given: &[(&str, &str)]) -> (Value, Arc<std::sync::Mutex<Vec<String>>>) {
    let (home, rt, node, agent) = world(name);
    let (port, heard) = site(|_| ("200 OK", r#"{"items":[1]}"#.into()));
    let route = kept_route(name, port, steps(port), inputs);
    let given = given.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    let r = rt.block_on(run_route(&node, &agent, route, given, None, Vec::new())).expect("the call ran");
    assert_eq!(r["ok"], true, "{r}");
    let _ = std::fs::remove_dir_all(&home);
    (r, heard)
}

/// A caller's value the route has no place for is said, beside the inputs the route does take; the answer still comes.
#[test]
fn a_call_says_the_values_it_ignored_and_the_inputs_the_route_takes() {
    let (r, _) = called("cov-said-ignored", |port| json!([get_step(port, "/items")]), json!([{ "name": "q", "secret": false, "default": "bread" }]), &[("zzz", "1")]);
    assert_eq!(r["ignored_inputs"], json!(["zzz"]), "{r}");
    assert_eq!(r["inputs"], json!(["q"]), "{r}");
}

/// A route whose earlier steps are not plain reads says what else a call sends, so an agent sees it in the answer.
#[test]
fn a_call_says_what_else_its_route_sends() {
    let steps = |port: u16| json!([{ "exchange": 0, "method": "POST", "status": 200, "url": format!("http://127.0.0.1:{port}/visit"), "needs_browser": false, "fields": [] }, get_step(port, "/items")]);
    let (r, heard) = called("cov-said-also", steps, json!([]), &[]);
    assert_eq!(r["also_sends"], json!([{ "method": "POST", "host": "127.0.0.1", "path": "/visit" }]), "{r}");
    assert!(heard.lock().unwrap().iter().any(|l| l.starts_with("POST /visit")), "the step ran: {:?}", heard.lock().unwrap());
}

/// A value with a space in a piece of the address goes out as `%20`, and the answer says a site may find nothing for it.
#[test]
fn a_call_says_how_a_space_in_a_piece_of_the_address_went() {
    let input = json!([{ "loc": { "in": "path", "key": 1 }, "class": "input", "name": "q", "secret": false, "default": "bread" }]);
    let steps = move |port: u16| json!([{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/search/{{path[1]}}"), "needs_browser": false, "fields": input }]);
    let (r, heard) = called("cov-said-space", steps, json!([{ "name": "q", "secret": false, "default": "bread" }]), &[("q", "gluten free")]);
    assert!(r["notes"].as_array().is_some_and(|n| n.iter().any(|n| n.as_str().is_some_and(|n| n.contains("a space")))), "{r}");
    assert!(heard.lock().unwrap().iter().any(|l| l.starts_with("GET /search/gluten%20free")), "{:?}", heard.lock().unwrap());
}

/// An agent that calls another contributor's entry by its id, on a node that can't read the chain, is told the chain is
/// the trouble before anything is fetched, paid or run: no line is written and nothing is demoted.
#[test]
fn a_call_by_entry_id_on_a_node_that_cannot_read_the_chain_pays_nothing_and_is_said() {
    let (home, rt, node, agent) = world("cov-entry-call");
    let entry = chain::test_entry("cov-entry-call");
    let (status, why) = rt.block_on(do_call(&node, &agent, format!("{entry:#x}"), HashMap::new())).expect_err("no chain");
    assert_eq!(status, StatusCode::BAD_GATEWAY, "{why}");
    assert!(!node.share.demoted(entry), "an unread chain says nothing against the entry");
    let (status, why) = rt.block_on(call_entry(&node, &agent, "0xnot-an-entry", HashMap::new(), "", ForGoal::default(), Vec::new())).expect_err("not an entry");
    assert_eq!((status, why.as_str()), (StatusCode::BAD_REQUEST, "bad entry id"));
    let _ = std::fs::remove_dir_all(&home);
}

/// A call of a kept copy that ran and failed sets the entry aside in this node only: the next goal that meets the
/// entry doesn't pick it, and a copy that passed doesn't.
#[test]
fn a_kept_copy_whose_call_failed_demotes_its_entry_here_and_a_passed_one_does_not() {
    let (home, rt, node, agent) = world("cov-demote");
    let (port, _) = site(|first| if first.contains("/fine") { ("200 OK", r#"{"items":[1]}"#.into()) } else { ("500 Internal Server Error", r#"{"error":"COV-SITE-WORDS"}"#.into()) });
    let broken = fetched_route(kept_route("cov-demote-broken", port, json!([get_step(port, "/broken")]), json!([])), "cov-demote-broken");
    let fine = fetched_route(kept_route("cov-demote-fine", port, json!([get_step(port, "/fine")]), json!([])), "cov-demote-fine");
    let entry = |r: &store::Route| -> alloy::primitives::FixedBytes<32> { r.fetched.as_ref().unwrap().entry_id.parse().unwrap() };
    let r = rt.block_on(do_call(&node, &agent, "cov-demote-fine".into(), HashMap::new())).expect("the call ran");
    assert_eq!(r["ok"], true, "{r}");
    assert!(!node.share.demoted(entry(&fine)));
    let r = rt.block_on(do_call(&node, &agent, "cov-demote-broken".into(), HashMap::new())).expect("the call ran");
    assert_eq!(r["ok"], false, "{r}");
    assert!(node.share.demoted(entry(&broken)), "a failed use sets the entry aside here");
    let _ = std::fs::remove_dir_all(&home);
}

/// A body fetched and paid for that the site answers is billed once, as a passed line naming the entry, and said in the
/// owner's activity as another contributor's route; the answer names the entry, says it ran here, and says the receipt
/// didn't reach a node when none serves it. A body with nothing in it to keep is said not kept, and the next call fetches
/// it again.
#[test]
fn a_fetched_body_the_site_answers_is_billed_once_and_said_in_the_activity() {
    let (home, rt, node, agent) = world("cov-paid-pass");
    let (port, heard) = site(|_| ("200 OK", r#"{"items":[1,2]}"#.into()));
    let route = fetched_route(kept_route("cov-paid-pass", port, json!([get_step(port, "/items")]), json!([])), "cov-paid-pass");
    let entry = chain::test_entry("cov-paid-pass");
    const OWN_EPOCH: u64 = 913_902;
    let held = chain::reserve(agent.index, OWN_EPOCH, 0.25, 0.0, 0.25, 100.0).unwrap();
    let paying = Use { entry, contributor: alloy::primitives::Address::repeat_byte(0xc0), server: None, server_peer: None, epoch: OWN_EPOCH, held: Some(held), body: Vec::new() };
    let r = rt.block_on(run_route(&node, &agent, route, HashMap::new(), Some(paying), Vec::new())).expect("the call ran");
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!(r["paid_usdc"], 0.25, "{r}");
    assert_eq!(r["network"]["cached"], false, "{r}");
    assert_eq!(r["network"]["contributor"], format!("{:#x}", alloy::primitives::Address::repeat_byte(0xc0)), "{r}");
    assert_eq!(heard.lock().unwrap().len(), 1);
    let lines = chain::receipts(agent.index, OWN_EPOCH).unwrap();
    assert!(lines.len() == 1 && lines[0].passed && lines[0].entry == Some(entry), "{lines:?}");
    let said = store::read_activity(50);
    assert!(said.iter().any(|a| a.what.starts_with("Used another contributor's route") && a.result == "passed"), "{said:?}");
    let _ = std::fs::remove_dir_all(&home);
}

// ---- api.rs ----

/// A node whose root key hasn't been read opens for no agent: the call is refused, with why the node is locked.
#[test]
fn a_locked_node_refuses_an_agent_and_says_why() {
    let (home, _rt, node, agent) = world("cov-locked");
    let token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &agent);
    *node.identity.write().unwrap() = None;
    let (status, why) = super::super::agent(&node, &bearer(&token)).expect_err("locked");
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(why, node.locked_because());
    assert!(why.contains("Keychain"), "{why}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A message over the peer network opens the node only with a key made for it: the key of an agent on this machine is
/// refused there, with what to do.
#[test]
fn an_agents_key_for_this_machine_is_refused_over_the_peer_network() {
    let (home, rt, node, agent) = world("cov-peer-key");
    let token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &agent);
    super::super::agent(&node, &bearer(&token)).expect("at the node's own door the key opens it");
    let refused = rt.block_on(crate::remote::over_peer_network(async { super::super::agent(&node, &bearer(&token)) }));
    let (status, why) = refused.expect_err("refused over the peer network");
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(why, crate::remote::NOT_A_PEER_KEY);
    let _ = std::fs::remove_dir_all(&home);
}

/// An input that a call may leave out, and one the page offers values for, say so in a route's listing.
#[test]
fn an_input_that_may_be_left_out_or_offers_values_says_so() {
    let r = kept_route("cov-input-view", 1, json!([]), json!([]));
    let input: store::RouteInput = serde_json::from_value(json!({ "name": "sort", "secret": false, "default": null, "optional": true, "options": [{ "value": "new", "label": "Newest" }] })).unwrap();
    let said = super::super::input_view(&input, &r);
    assert_eq!(said["optional"], true, "{said}");
    assert_eq!(said["options"][0]["value"], "new", "{said}");
    let plain: store::RouteInput = serde_json::from_value(json!({ "name": "q", "secret": false, "default": "x" })).unwrap();
    let said = super::super::input_view(&plain, &r);
    assert!(said.get("optional").is_none() && said.get("options").is_none(), "{said}");
}

/// Over HTTP an agent's body is a JSON object or nothing: a list, a string or half an object is refused as a 400 with
/// nothing run, and a tool that needs a goal says so.
#[test]
fn a_body_that_is_not_an_object_is_refused_and_a_do_without_a_goal_says_so() {
    let (home, rt, node, agent) = world("cov-http-body");
    let token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &agent);
    let tool = |name: &str| PRIMITIVES.iter().find(|p| p.tool == name).unwrap();
    for body in [&b"[1,2]"[..], b"\"goal\"", b"{\"goal\":"] {
        let (status, Json(said)) = rt.block_on(answer_http(tool("unbrowse_do"), node.clone(), bearer(&token), HashMap::new(), HashMap::new(), body));
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body:?}");
        assert!(said["error"].as_str().is_some_and(|e| e.contains("JSON object")), "{said}");
    }
    let (status, Json(said)) = rt.block_on(answer_http(tool("unbrowse_do"), node.clone(), bearer(&token), HashMap::new(), HashMap::new(), b"{}"));
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(said["error"].as_str().is_some_and(|e| e.contains("needs goal")), "{said}");
    let (status, Json(said)) = rt.block_on(answer_http(tool("unbrowse_inspect"), node.clone(), bearer(&token), HashMap::new(), HashMap::from([("route_id".to_string(), "no-such-route".to_string())]), b""));
    assert_eq!(status, StatusCode::NOT_FOUND, "{said}");
    let (status, Json(said)) = rt.block_on(answer_http(tool("unbrowse_observe"), node.clone(), bearer(&token), HashMap::new(), HashMap::new(), b"{}"));
    assert!(status.is_client_error(), "{status}: {said}");
    let judged = json!({ "route_id": "no-such-route", "verdict": "wrong", "bounty": 1, "entry": format!("{:#x}", chain::test_entry("cov-judge")) });
    let (status, Json(said)) = rt.block_on(answer_http(tool("unbrowse_judge"), node.clone(), bearer(&token), HashMap::new(), HashMap::new(), judged.to_string().as_bytes()));
    assert_eq!(status, StatusCode::CONFLICT, "{said}");
    assert!(said["error"].as_str().is_some_and(|e| e.contains("bounty steps off")), "an answer to a bounty ask is the bounty's, not a verdict on a route: {said}");
    let (status, Json(said)) = rt.block_on(answer_http(tool("unbrowse_setup"), node.clone(), bearer(&token), HashMap::new(), HashMap::new(), b"{}"));
    assert_eq!(status, StatusCode::OK, "{said}");
    assert_eq!(said["did"], "status", "{said}");
    let _ = std::fs::remove_dir_all(&home);
}

// ---- api/pages.rs ----

/// More pages than one call takes are refused whole, before any is walked, as an ask and as the batch's own work.
#[test]
fn a_batch_of_more_pages_than_one_call_takes_is_refused_before_any_is_walked() {
    let (home, rt, node, agent) = world("cov-too-many-pages");
    let many = || (0..=pages::MOST_PAGES).map(|i| json!(format!("http://127.0.0.1:1/p{i}"))).collect::<Vec<_>>();
    let args = json!({ "pages": many() });
    let batch = pages::pages_arg(&args);
    assert_eq!(batch.len(), pages::MOST_PAGES + 1);
    let body = || DoBody { goal: "list them".into(), url: String::new(), inputs: HashMap::new(), session: String::new(), browser: String::new(), fields: Vec::new(), many: true, budget_usdc: None };
    let asked = rt.block_on(pages::do_pages_asked(&node, &agent, body(), pages::pages_arg(&args), &args)).expect_err("refused");
    assert_eq!(asked.status, StatusCode::BAD_REQUEST);
    assert!(asked.error.contains("101 pages: one call takes at most 100"), "{}", asked.error);
    let (status, why) = rt.block_on(pages::do_pages(&node, &agent, body(), pages::pages_arg(&args))).expect_err("refused");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(why.contains("at most 100"), "{why}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A page's answer among several says how it went: an error says its words, a page that needed the browser says why it
/// has no data, and a route that could add fields lists the first few of them. A value is found anywhere inside a
/// list or object, never in a null.
#[test]
fn a_pages_answer_says_how_it_went_and_what_fields_its_route_could_add() {
    let took = std::time::Duration::from_millis(7);
    let failed = pages::page_answer("https://a.example/", took, Err(Failed::from((StatusCode::BAD_GATEWAY, "the site is down".to_string()))));
    assert_eq!((failed["how"].as_str(), failed["ok"].clone(), failed["error"].as_str()), (Some("error"), json!(false), Some("the site is down")), "{failed}");
    let browse = pages::page_answer("https://b.example/", took, Ok(json!({ "how": "browse", "why": "the page needs a click" })));
    assert_eq!((browse["how"].as_str(), browse["ok"].clone(), browse["why"].as_str()), (Some("browse"), json!(false), Some("the page needs a click")), "{browse}");
    let more: Vec<Value> = (0..9).map(|i| json!(format!("field{i}"))).collect();
    let called = pages::page_answer(
        "https://c.example/",
        took,
        Ok(json!({ "how": "called", "route": { "id": "r1" }, "result": { "ok": false, "error": "no such item", "data": { "n": 1 }, "fields": { "more": more } } })),
    );
    assert_eq!(called["route_id"], "r1", "{called}");
    assert_eq!(called["error"], "no such item", "{called}");
    assert_eq!(called["fields"].as_array().map(Vec::len), Some(pages::FIELDS_PER_ROUTE), "only the first few are listed: {called}");
    assert!(!pages::has_value(&Value::Null) && !pages::has_value(&json!({ "a": [null, { "b": null }] })));
    assert!(pages::has_value(&json!({ "a": [null, { "b": 0 }] })));
}

// ---- api/mcp.rs ----

fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

/// A client reads the one screen MCP Apps hosts draw by its address, and is told when the address names none; a method
/// the node doesn't have is answered as one, not dropped.
#[test]
fn an_mcp_client_reads_the_answer_screen_and_hears_of_a_method_it_has_not() {
    let (home, rt, node, _agent) = world("cov-mcp-resources");
    let ask = |msg: Value| rt.block_on(mcp::mcp_answer(node.clone(), &HeaderMap::new(), msg)).1 .0;
    let screen = ask(rpc(1, "resources/read", json!({ "uri": mcp_app::URI })));
    assert!(screen["result"]["contents"][0]["text"].as_str().is_some_and(|t| t.contains("html")), "{screen}");
    let none = ask(rpc(2, "resources/read", json!({ "uri": "ui://unbrowse/nothing.html" })));
    assert_eq!((none["error"]["code"].as_i64(), none["error"]["message"].as_str()), (Some(-32002), Some("no such resource")), "{none}");
    let unknown = ask(rpc(3, "prompts/list", json!({})));
    assert_eq!(unknown["error"]["code"], -32601, "{unknown}");
    assert!(unknown["error"]["message"].as_str().is_some_and(|m| m.contains("prompts/list")), "{unknown}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A client that says at `initialize` it draws screens gets a call's answer a second time as `structuredContent`, for
/// its screen; one that didn't, only the text.
#[test]
fn a_client_that_draws_screens_gets_the_answer_as_structured_content_too() {
    let (home, rt, node, agent) = world("cov-mcp-draws");
    let token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &agent);
    let mut headers = bearer(&token);
    let init = rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18", "clientInfo": { "name": "claude-ai" } }));
    let reply = rt.block_on(mcp::mcp(State(node.clone()), headers.clone(), Json(init)));
    let sid = reply.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).expect("a session is issued").to_string();
    let search = rpc(2, "tools/call", json!({ "name": "unbrowse_search", "arguments": { "query": "lamps" } }));
    let plain = rt.block_on(mcp::mcp_answer(node.clone(), &headers, search.clone())).1 .0;
    assert!(plain["result"].get("structuredContent").is_none(), "a client that didn't say it draws gets none: {plain}");
    headers.insert("mcp-session-id", sid.parse().unwrap());
    let drawn = rt.block_on(mcp::mcp_answer(node.clone(), &headers, search)).1 .0;
    assert!(drawn["result"]["structuredContent"].is_object(), "{drawn}");
    assert_eq!(drawn["result"]["isError"], false, "{drawn}");
    let _ = std::fs::remove_dir_all(&home);
}

// ---- api.rs: the door ----

/// A node that serves on a port of its own, as `serve` does for the owner: its port.
async fn serving(node: Arc<Node>, owner: &str) -> u16 {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    tokio::spawn(serve(node, port, owner.to_string()));
    for _ in 0..200 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    port
}

/// A request to this node's `target`, signed for `token` as a client of this release signs it, at `time` with `nonce`.
fn signed_headers(token: &str, port: u16, target: &str, time: u64, nonce: &str) -> Vec<(&'static str, String)> {
    use unbrowse_core::signed;
    let sig = hex::encode(signed::request_mac(token, "GET", &format!("127.0.0.1:{port}"), target, b"", time, nonce));
    vec![(signed::KEY, hex::encode(unbrowse_core::token_key(token))), (signed::TIME, time.to_string()), (signed::NONCE, nonce.to_string()), (signed::SIGNATURE, sig)]
}

async fn get(port: u16, target: &str, headers: &[(&'static str, String)]) -> (u16, Value) {
    let mut req = reqwest::Client::new().get(format!("http://127.0.0.1:{port}{target}"));
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let res = req.send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.json().await.unwrap_or(Value::Null))
}

/// A node answers to its own loopback address and name only: a request that names another host (a page whose name was
/// made to resolve here) is turned away before any route sees it.
#[tokio::test]
async fn a_request_that_names_another_host_is_turned_away_at_the_door() {
    let home = store::scratch_home("cov-own-host");
    let node = crate::testchain::node("cov-own-host");
    let port = serving(node, "the-owners-token-0123456789abcdef").await;
    let res = reqwest::Client::new().get(format!("http://127.0.0.1:{port}/v1/health")).header("host", "rebound.example").send().await.unwrap();
    assert_eq!(res.status().as_u16(), 421);
    let said: Value = res.json().await.unwrap();
    assert!(said["error"].as_str().is_some_and(|e| e.contains("127.0.0.1 and localhost only")), "{said}");
    let own = reqwest::Client::new().get(format!("http://127.0.0.1:{port}/v1/health")).send().await.unwrap();
    assert_eq!(own.status().as_u16(), 200, "the node's own address still answers");
    let _ = std::fs::remove_dir_all(&home);
}

// ---- api/signed.rs ----

const OWNER: &str = "the-owners-token-0123456789abcdef";
const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn now_nonce() -> String {
    let mut n = [0u8; 16];
    getrandom::fill(&mut n).unwrap();
    hex::encode(n)
}

/// A signed request that leaves out a part, or whose nonce isn't 16 to 64 bytes of hex, is refused as unauthorized with
/// what a request must carry: none of it reaches a route.
#[tokio::test]
async fn a_signed_request_missing_a_part_or_with_a_bad_nonce_is_refused_with_what_it_needs() {
    let home = store::scratch_home("cov-signed-shape");
    let node = crate::testchain::node("cov-signed-shape");
    let port = serving(node, OWNER).await;
    let full = signed_headers(OWNER, port, "/v1/health", store::now(), NONCE);
    let (status, said) = get(port, "/v1/health", &full[..1]).await;
    assert_eq!(status, 401);
    assert!(said["error"].as_str().is_some_and(|e| e.contains("names its key, its time, its nonce and its signature")), "{said}");
    let (status, said) = get(port, "/v1/health", &signed_headers(OWNER, port, "/v1/health", store::now(), "not-hex")).await;
    assert_eq!(status, 401);
    assert!(said["error"].as_str().is_some_and(|e| e.contains("16 to 64 random bytes")), "{said}");
    let (status, said) = get(port, "/v1/health", &full).await;
    assert_eq!(status, 200, "the same request, whole, is taken: {said}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A key that isn't the owner's, asked of a node whose root key can't be read yet, hears why it must wait: the node is
/// locked behind its keychain, or has no key made. The owner's own key is known without it.
#[tokio::test]
async fn a_signed_request_for_a_node_that_cannot_yet_tell_its_keys_is_told_to_wait() {
    let home = store::scratch_home("cov-signed-locked");
    let node = crate::testchain::node("cov-signed-locked");
    let (agent, _) = agents::create(node.keys.as_ref(), "agent", 1.0, 30, 0).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &agent);
    let port = serving(node.clone(), OWNER).await;
    let (status, _) = get(port, "/v1/whoami", &signed_headers(&token, port, "/v1/whoami", store::now(), &now_nonce())).await;
    assert_eq!(status, 200, "the control: unlocked, the agent's key opens it");
    let (status, _) = get(port, "/v1/health", &signed_headers(&token, port, "/v1/health", store::now(), &now_nonce())).await;
    assert_eq!(status, 200, "a route that needs no agent answers a key it knows");
    *node.identity.write().unwrap() = None;
    let (status, said) = get(port, "/v1/health", &signed_headers(&token, port, "/v1/health", store::now(), &now_nonce())).await;
    assert_eq!(status, 503);
    assert_eq!(said["error"], json!(node.locked_because()));
    // Unlocked, but no root key made: the agent's key can't be told from any other's.
    let bare = Arc::new(Node {
        keys: Box::new(unbrowse_core::MemoryStore::default()),
        identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: "0x0".into(), created: false }))),
        info: crate::NodeInfo { name: "bare".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let port = serving(bare, OWNER).await;
    let (status, said) = get(port, "/v1/health", &signed_headers(&token, port, "/v1/health", store::now(), &now_nonce())).await;
    assert_eq!(status, 503);
    assert_eq!(said["error"], json!(crate::WAITING_FOR_KEY));
    let _ = std::fs::remove_dir_all(&home);
}

/// The node takes a request once, and writes the nonce down first: when it can't (the journal won't take a line), the
/// request doesn't run, and the caller is told to try again. Once it can, the same caller is taken.
#[tokio::test]
async fn a_request_the_node_cannot_write_down_does_not_run() {
    let home = store::scratch_home("cov-signed-journal");
    let node = crate::testchain::node("cov-signed-journal");
    let port = serving(node, OWNER).await;
    let journal = home.join("nonces-taken");
    std::fs::remove_file(&journal).unwrap();
    std::fs::create_dir(&journal).unwrap();
    let (status, said) = get(port, "/v1/health", &signed_headers(OWNER, port, "/v1/health", store::now(), &now_nonce())).await;
    assert_eq!(status, 503);
    assert!(said["error"].as_str().is_some_and(|e| e.contains("can't write this request down") && e.contains("didn't run")), "{said}");
    std::fs::remove_dir(&journal).unwrap();
    let (status, _) = get(port, "/v1/health", &signed_headers(OWNER, port, "/v1/health", store::now(), &now_nonce())).await;
    assert_eq!(status, 200);
    let _ = std::fs::remove_dir_all(&home);
}

/// A node whose journal of taken nonces reads back with a line it can't understand, or can't be read at all, can't tell
/// a replay from a fresh request signed before it started: it refuses every one signed up to a window from now, keeps the
/// file aside for the owner and says so in the activity. A request signed a window later is taken.
#[tokio::test]
async fn a_journal_the_node_cannot_read_back_refuses_what_was_signed_before_it_started() {
    for (name, bad) in [("a-horizon-that-is-no-number", "horizon soon\n"), ("a-time-that-is-no-number", "later 0123456789abcdef/0123456789abcdef\n"), ("a-line-that-is-nothing", "what is this\n")] {
        let home = store::scratch_home(&format!("cov-journal-{name}"));
        let node = crate::testchain::node("cov-journal");
        std::fs::write(home.join("nonces-taken"), format!("horizon 1\n{bad}")).unwrap();
        // Signed before the journal is read: "before it started" holds even when the clock ticks over meanwhile.
        let before = store::now();
        signed::restore_nonces();
        let port = serving(node, OWNER).await;
        let (status, said) = get(port, "/v1/health", &signed_headers(OWNER, port, "/v1/health", before, &now_nonce())).await;
        assert_eq!(status, 401, "{name}: {said}");
        assert!(said["error"].as_str().is_some_and(|e| e.contains("clock has already been")), "{name}: {said}");
        let aside = std::fs::read_dir(&home).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("nonces-taken.unreadable-"));
        assert!(aside, "{name}: the unreadable file is kept");
        assert!(store::read_activity(50).iter().any(|a| a.what.contains("Couldn't read back the signed requests")), "{name}: the owner is told");
        let _ = std::fs::remove_dir_all(&home);
    }
    // A journal that is a folder can't be read at all.
    let home = store::scratch_home("cov-journal-folder");
    let node = crate::testchain::node("cov-journal-folder");
    std::fs::create_dir(home.join("nonces-taken")).unwrap();
    let before = store::now();
    signed::restore_nonces();
    let port = serving(node, OWNER).await;
    let (status, _) = get(port, "/v1/health", &signed_headers(OWNER, port, "/v1/health", before, &now_nonce())).await;
    assert_eq!(status, 401);
    let _ = std::fs::remove_dir_all(&home);
}

// ---- api/asks.rs ----

/// An ask whose log can't be written still runs and replies: a line that isn't written is said on the node's own
/// stream, and nothing the agent sees changes.
#[test]
fn an_ask_whose_log_cannot_be_written_still_runs_and_ends() {
    let home = store::scratch_home("cov-asks-log");
    std::fs::create_dir(home.join("asks.jsonl")).unwrap();
    let ask = asks::Ask::begin("unbrowse_do");
    assert!(asks::by_stop(&ask.stop).is_some(), "it is live");
    ask.replied(Some("called"));
    assert!(ask.has_ended() && asks::by_stop(&ask.stop).is_none());
    let _ = std::fs::remove_dir_all(&home);
}

/// Work that starts for an ask after it replied is said behind the reply; the ask ends once, when that work does, and
/// the work's end is not an end again.
#[test]
fn work_that_starts_after_the_reply_is_said_and_ends_the_ask_once() {
    let home = store::scratch_home("cov-asks-late");
    let ask = asks::Ask::begin("unbrowse_do");
    ask.replied(Some("called"));
    assert!(ask.has_ended());
    let late = ask.behind("a late fetch");
    let lines = asks::tests::events(&home, &ask.id);
    let behind = lines.iter().find(|l| l["event"] == "behind").expect("said as behind");
    assert_eq!(behind["work"], json!(["a late fetch"]));
    drop(late);
    let ended = asks::tests::events(&home, &ask.id).iter().filter(|l| l["event"] == "ended").count();
    assert_eq!(ended, 1, "an ask ends once");
    let _ = std::fs::remove_dir_all(&home);
}
