use super::*;

/// A route learned by example whose body asks a word its graph takes no input for (the classifier read the word as
/// made by the page's code) offers it as an input of its own, optional, with the walk's word as its default: the
/// route answers the page for another word (`fits`), and an agent's word for it is handed on (`inputs_for`). A node
/// with the switch off runs the graph, and says the word is ignored (`ignored_inputs`, by `unreached`); one with it
/// on runs the body, which sends it.
#[test]
fn a_route_learned_by_example_offers_what_its_body_asks() {
    let graph: unbrowse_learn::Graph = serde_json::from_value(json!({ "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200,
        "url": "https://shop.example/api/search?q={q}", "needs_browser": true, "response_shape": { "items": "array" },
        "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "computed" }] }] }))
    .unwrap();
    let mut route = store::Route::from_graph("found".into(), "search the shop".into(), "https://shop.example/search?q=red+lamp".into(), graph.clone()).unwrap();
    assert!(route.inputs.is_empty(), "the graph takes no input");
    let mut body = unbrowse_learn::body::from_graph(&graph, "shop.example");
    let word = unbrowse_learn::route::Expr::Slot { name: "q".into(), or: Some("red lamp".into()), optional: false };
    let twice = unbrowse_learn::route::Expr::Written { of: Box::new(unbrowse_learn::route::Expr::Written { of: Box::new(word), how: unbrowse_learn::route::How::Plus }), how: unbrowse_learn::route::How::Percent };
    body.steps[0].holes[0].ways = vec![unbrowse_learn::route::Way { rung: 0, expr: twice }];
    let page = "https://shop.example/search?q=green+chair";
    assert!(!goal::fits(&route, page), "a route that takes no word does not answer another word's page");
    route.body = Some(body);
    route.offer_the_bodys_slots();
    assert_eq!(route.inputs.iter().map(|i| (i.name.as_str(), i.default.as_deref(), i.optional)).collect::<Vec<_>>(), [("q", Some("red lamp"), true)]);
    assert!(goal::fits(&route, page));
    assert_eq!(goal::inputs_for(&route, page, HashMap::new()).get("q").map(String::as_str), Some("green chair"));
    let given = HashMap::from([("q".to_string(), "green chair".to_string())]);
    assert_eq!(crate::run::calling_the_body(false, || goal::unreached(&route, &given)), ["q"], "a node running the graph says it ignores the word");
    assert!(crate::run::calling_the_body(true, || goal::unreached(&route, &given)).is_empty(), "a node running the body sends it");
}

/// What an agent is shown of a route (a search's, an open's, a `do`'s reply) says nothing of the body it was learned
/// as: the body holds the walk's own values.
#[test]
fn a_route_an_agent_is_shown_carries_no_body() {
    let route: store::Route = serde_json::from_value(json!({
        "id": "items", "site": "shop.example", "what": "search items", "method": "GET", "path": "/api/items", "root": "https://shop.example/?q=lamps",
        "inputs": [{ "name": "q", "secret": false, "default": "lamps" }], "steps": 1, "browser_assisted": false, "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/items?q={q}", "needs_browser": false,
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
    }))
    .unwrap();
    let shown = route_json(&store::with_a_body_saying(route.clone(), "only-the-body-says-this"));
    assert!(!shown.to_string().contains("only-the-body-says-this") && shown.get("body").is_none(), "{shown}");
    assert_eq!(shown, route_json(&route));
}

/// The owner's window is told what a picture is by what it is: a PNG (what a window off a Mac draws) as a PNG.
#[test]
fn a_picture_is_served_as_what_it_is() {
    assert_eq!(picture_type(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"), "image/png");
    assert_eq!(picture_type(&[0xFF, 0xD8, 0xFF, 0xE0]), "image/jpeg");
}

/// An entry whose fee couldn't be paid is said to the agent in plain words, apart from the entries that ran and
/// failed: the reply carries why, and what the owner can do.
#[test]
fn a_fee_that_couldnt_be_paid_is_said_to_the_agent() {
    let failures = vec![
        json!({ "entry_id": "0x01", "error": "the site answered 500" }),
        json!({ "entry_id": "0x02", "error": "the balance this agent pays from ($0.00) doesn't cover this call", "payment": true }),
    ];
    let u = payment_refused(&failures).expect("said");
    assert_eq!(u["entry_id"], "0x02");
    assert!(u["why"].as_str().unwrap().contains("add funds"), "{u}");
    assert!(payment_refused(&failures[..1]).is_none(), "a failure that isn't about money says nothing of money");
}

/// A node without its browser answers what needs it with `browser_missing`, over HTTP and MCP alike: 422, the
/// status a browser that couldn't do it always had, with the code, what it lacks and how to get it, and no wait.
/// whoami says the browser is missing, and a `do` naming a way of using the browser the node doesn't know is
/// refused before anything runs.
#[test]
fn a_node_without_its_browser_says_so() {
    let home = store::scratch_home("no-browser");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    if !crate::browsers::lacking(crate::browsers::Need::Hands).contains(&"program") {
        // A machine whose browser program is found anyway (UNBROWSE_BROWSER, a build beside the engine): nothing
        // here is missing to test.
        return;
    }
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
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
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    let prim = |tool: &str| PRIMITIVES.iter().find(|p| p.tool == tool).unwrap();
    let (n, h) = (node.clone(), headers.clone());
    let (status, Json(r)) = rt.block_on(async move {
        let body = json!({ "do": ["open", "https://example.com/"] }).to_string();
        tokio::time::timeout(std::time::Duration::from_secs(20), answer_http(prim("unbrowse_browse"), n, h, HashMap::new(), HashMap::new(), body.as_bytes())).await.expect("no wait")
    });
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{r}");
    assert_eq!(r["code"], "browser_missing", "{r}");
    assert_eq!(r["browser"], "missing", "{r}");
    assert!(r["missing"].as_array().unwrap().contains(&json!("program")), "{r}");
    assert_eq!((r["install"].clone(), r["fetch"].clone()), (json!("unbrowse browser install"), json!(false)), "{r}");
    // The words name the app's way to get it; `install` still names the command, for a script that runs it itself.
    assert!(r["error"].as_str().unwrap().contains("Download Chrome for Testing") && !r["error"].as_str().unwrap().contains("unbrowse browser install"), "{r}");

    let (n, h) = (node.clone(), headers.clone());
    let (_, Json(m)) = rt.block_on(async move {
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "unbrowse_browse", "arguments": { "do": ["snapshot", "-i"], "site": "example.com" } } });
        mcp_answer(n, &h, msg).await
    });
    assert_eq!(m["result"]["isError"], true, "{m}");
    let said: Value = serde_json::from_str(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(said["code"], "browser_missing", "{said}");

    let (n, h) = (node.clone(), headers.clone());
    let (status, Json(w)) = rt.block_on(async move { answer_http(prim("unbrowse_whoami"), n, h, HashMap::new(), HashMap::new(), b"").await });
    assert_eq!(status, StatusCode::OK);
    assert_eq!((w["browser"].clone(), w["browser_fetch"].clone()), (json!("missing"), json!(false)), "{w}");
    assert_eq!(w["call_browser"], true, "the node advertises replay-only calls separately from goal calls");
    crate::apischema::check(&(prim("unbrowse_whoami").returns)(), &w, &crate::apischema::types()).unwrap_or_else(|e| panic!("whoami answered {w}: {e}"));

    let (n, h) = (node.clone(), headers.clone());
    let (status, Json(d)) = rt.block_on(async move {
        let body = json!({ "goal": "list items", "url": "https://example.com/", "browser": "sometimes" }).to_string();
        answer_http(prim("unbrowse_do"), n, h, HashMap::new(), HashMap::new(), body.as_bytes()).await
    });
    assert_eq!(status, StatusCode::BAD_REQUEST, "{d}");
    assert!(d["error"].as_str().unwrap().contains("auto, if_present or never"), "{d}");
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// External security review round 2, 2026-11-04, item 4 (agents as another OS user). Each start makes every file
/// directly in the node's folder, and every folder in it, this user's alone, whatever an older node or a copy left
/// them as: an install from before this, whose vault or key file others may read, is closed at its next start.
#[test]
#[cfg(unix)]
fn a_start_makes_everything_in_the_nodes_folder_this_users_alone() {
    use std::os::unix::fs::PermissionsExt;
    let home = store::scratch_home("node-folder-private");
    std::fs::create_dir_all(home.join("profiles")).unwrap();
    for f in ["root.key", "vault.sealed.json", "passkeys.json"] {
        std::fs::write(home.join(f), "x").unwrap();
        std::fs::set_permissions(home.join(f), std::fs::Permissions::from_mode(0o644)).unwrap();
    }
    std::fs::set_permissions(home.join("profiles"), std::fs::Permissions::from_mode(0o755)).unwrap();
    write_owner_token("tok").unwrap();
    let mode = |f: &str| std::fs::metadata(home.join(f)).unwrap().permissions().mode() & 0o777;
    for f in ["root.key", "vault.sealed.json", "passkeys.json", "owner.token"] {
        assert_eq!(mode(f), 0o600, "{f}");
    }
    assert_eq!(mode("profiles"), 0o700);
    let _ = std::fs::remove_dir_all(&home);
}

/// The owner's token is readable by this user only, in a folder only this user can open.
#[test]
#[cfg(unix)]
fn the_owners_token_is_this_users_alone() {
    use std::os::unix::fs::PermissionsExt;
    let home = store::scratch_home("owner-token-private");
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
    write_owner_token("tok").unwrap();
    assert_eq!(std::fs::metadata(home.join("owner.token")).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&home).unwrap().permissions().mode() & 0o777, 0o700, "the node's folder is private");
    let _ = std::fs::remove_dir_all(&home);
}

/// A node that can't take the port -- a supervisor restarting it while another node still serves -- leaves the
/// running node's owner token alone, so the window keeps talking to the node that answers.
#[tokio::test]
async fn a_node_that_cannot_bind_leaves_the_owners_token() {
    let home = store::scratch_home("owner-token-bind");
    std::fs::write(home.join("owner.token"), "the-running-nodes-token").unwrap();
    let held = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = held.local_addr().unwrap().port();
    let node = Arc::new(Node {
        keys: Box::new(unbrowse_core::MemoryStore::default()),
        identity: std::sync::RwLock::new(None),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: port, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let token = || std::fs::read_to_string(home.join("owner.token")).unwrap();
    // Making a token writes nothing: only the node that holds the port does.
    let second = owner_token().unwrap();
    assert_eq!(token(), "the-running-nodes-token");
    assert!(serve(node.clone(), port, second).await.is_err(), "the port is held");
    assert_eq!(token(), "the-running-nodes-token");
    // Once the port is free, the node that takes it writes its own token.
    drop(held);
    let mine = owner_token().unwrap();
    let running = tokio::spawn(serve(node, port, mine.clone()));
    for _ in 0..500 {
        if token() == mine {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    running.abort();
    assert_eq!(token(), mine);
}

/// Only the owner's window drives a site's browser by hand: an agent's token, or none, gets nothing from the
/// hands commands or the page's pictures, and no agent tool reaches them.
#[tokio::test]
async fn only_the_owners_token_takes_over_a_page() {
    let keys = unbrowse_core::MemoryStore::default();
    let node = Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(None),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let door = Door { node, owner: Arc::new("the-owners-token".into()) };
    let as_agent = || {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer an-agents-token".parse().unwrap());
        h
    };
    for cmd in ["hands", "hands_watch", "hands_input", "hands_give_back", "hands_stop"] {
        let body = json!({ "site": "a.example", "kind": "text", "text": "x" });
        let (status, _) = owner_command(State(door.clone()), Path(cmd.into()), as_agent(), Some(Json(body.clone()))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{cmd} with an agent's token");
        let (status, _) = owner_command(State(door.clone()), Path(cmd.into()), HeaderMap::new(), Some(Json(body))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{cmd} with no token");
    }
    let picture = owner_frame(State(door.clone()), as_agent(), Query(FrameQuery { walk: "hands:a.example".into() })).await;
    assert_eq!(picture.status(), StatusCode::UNAUTHORIZED);
    let tools = tools().to_string();
    assert!(!tools.contains("hands_"), "no agent tool drives the owner's screen");
    assert!(tools.contains("ask_owner"), "an agent can only ask");
}

/// Keeping card security codes is the owner's alone to turn on (#185): an agent's token, or none, sends neither the
/// command nor a settings save, no agent tool reaches it, a settings save that names it turns it neither way, and the
/// owner's own token is asked about it in the node's dialog, which says what keeping codes costs.
#[tokio::test]
async fn an_agent_cannot_switch_keeping_card_codes_on() {
    let _home = store::scratch_home("codes-owner-only");
    let node = Arc::new(Node {
        keys: Box::new(unbrowse_core::MemoryStore::default()),
        identity: std::sync::RwLock::new(None),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let door = Door { node, owner: Arc::new("the-owners-token".into()) };
    let mut as_agent = HeaderMap::new();
    as_agent.insert("authorization", "Bearer an-agents-token".parse().unwrap());
    let on = serde_json::to_value(store::Settings { keep_card_codes: true, ..store::load_settings() }).unwrap();
    for (cmd, body) in [("keep_card_codes", json!({ "on": true })), ("save_settings", json!({ "settings": on }))] {
        for headers in [as_agent.clone(), HeaderMap::new()] {
            let (status, _) = owner_command(State(door.clone()), Path(cmd.into()), headers, Some(Json(body.clone()))).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{cmd}");
        }
    }
    assert!(!store::load_settings().keep_card_codes);
    assert!(!tools().to_string().contains("keep_card_codes"), "no agent tool reaches it");
    let asked = crate::commands::asks_the_owner("keep_card_codes", &json!({ "on": true })).expect("turning it on asks the owner");
    assert!(asked.contains("PCI DSS") && asked.contains("security codes"), "{asked}");
    assert!(crate::commands::asks_the_owner("keep_card_codes", &json!({ "on": false })).is_none(), "turning it off only asks less");
    // A save that names it, from a window's stale read or anything else holding the token, leaves it as it was.
    crate::save_settings(store::Settings { keep_card_codes: true, ..store::load_settings() }).unwrap();
    assert!(!store::load_settings().keep_card_codes);
}

fn route(id: &str, site: &str, what: &str, inputs: &[&str]) -> store::Route {
    serde_json::from_value(json!({
        "id": id, "site": site, "what": what, "method": "GET", "path": "/", "root": format!("https://{site}/"),
        "inputs": inputs.iter().map(|n| json!({ "name": n, "secret": false, "default": null })).collect::<Vec<_>>(),
        "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 0,
        "graph": { "steps": [], "provisional": false }
    }))
    .unwrap()
}

fn step_of(method: &str, url: &str, fields: Value) -> Value {
    json!({ "exchange": 0, "method": method, "status": 200, "url": url, "fields": fields, "needs_browser": false })
}

/// What the owner's own browsing session gave a route's page is never said back to an agent as a value: not as an
/// input's default (the input says the caller supplies it), not in the route's description or its path, not in a step's
/// address or an address an earlier answer was read at, not in `inspect`. And an agent's call doesn't use it in the
/// agent's place: left out, the input is refused for want of it. A value a caller named for a walk is their own word,
/// and still said.
#[test]
fn what_the_owners_session_gave_is_never_said_to_an_agent() {
    let _home = store::scratch_home("owners-own");
    let private = "case-4471-private";
    let mut r = route("owners", "shop.example", &format!("Read {private} on shop.example"), &["q"]);
    r.inputs[0].default = Some(private.into());
    r.given = vec!["q".into()];
    r.session_gave = true;
    let origin = json!({ "exchange": 0, "url": format!("https://www.shop.example/case/{private}?q={private}"), "at": { "from": "json", "pointer": "/id" } });
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        step_of("GET", &format!("https://www.shop.example/case/{private}"), json!([
            { "loc": { "in": "path", "key": 1 }, "class": "constant", "value": private, "origin": origin },
        ])),
        step_of("GET", &format!("https://www.shop.example/api/cases/{private}?q={{q}}"), json!([
            { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": private },
            { "loc": { "in": "path", "key": 2 }, "class": "constant", "value": private },
        ])),
    ] })).unwrap();
    r.path = format!("/api/cases/{private}?q={{q}}");
    let said = route_json(&r);
    assert!(!said.to_string().contains(private), "{said}");
    assert_eq!((said["inputs"][0]["default"].clone(), said["inputs"][0]["supply"].clone()), (Value::Null, json!(true)));
    crate::apischema::check(&crate::apischema::types()["Route"], &said, &crate::apischema::types()).unwrap_or_else(|e| panic!("{e}"));
    store::save_route(&r).unwrap();
    let inspected = super::call::do_inspect(r.id.clone()).unwrap();
    assert!(!inspected.to_string().contains(private), "{inspected}");
    // An agent's call: the owner's value is no default.
    let usable = r.usable_by_an_agent();
    assert!(usable.inputs[0].default.is_none());
    assert!(usable.graph.steps.iter().flat_map(|s| &s.fields).all(|f| !matches!(&f.class, unbrowse_learn::Class::Input { default: Some(_), .. })));
    let refused = match crate::run::call_watched(usable, &crate::vault::Filled::plain(HashMap::new()), "an agent", None, &[], None) {
        Ok(r) => serde_json::to_string(&r).unwrap_or_default(),
        Err(e) => e,
    };
    assert!(refused.contains("q") && !refused.contains(private), "{refused}");
    assert_eq!(store::load_route("owners").unwrap().inputs[0].default.as_deref(), Some(private), "the owner's own record keeps it");
    // A value a caller named for a walk is their own word.
    let mut named = route("named", "shop.example", "search shop", &["q"]);
    named.inputs[0].default = Some("lamps".into());
    named.given = vec!["q".into()];
    assert_eq!(route_json(&named)["inputs"][0]["default"], json!("lamps"));
}

/// A node for an agent's calls in a scratch home: its runtime, the node and the agent's key.
fn agent_node(home: &std::path::Path) -> (tokio::runtime::Runtime, Arc<Node>, Agent) {
    let h = home.to_path_buf();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
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

/// A site on 127.0.0.1 that answers every request with `body` and keeps each request's address. Its port and what it
/// heard.
fn hearing_site(body: String) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    use std::io::{BufRead, Write};
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = heard.clone();
    std::thread::spawn(move || {
        for stream in site.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            kept.lock().unwrap().push(first.split_whitespace().nth(1).unwrap_or_default().to_string());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (port, heard)
}

/// A route the owner's own browsing taught, its `q` the owner's `private`, on the site at `port`, with `steps`.
fn owners_route(id: &str, port: u16, private: &str, steps: Value) -> store::Route {
    let mut r = route(id, "127.0.0.1", "Read a case", &["q"]);
    r.inputs[0].default = Some(private.into());
    r.given = vec!["q".into()];
    r.session_gave = true;
    r.root = format!("http://127.0.0.1:{port}/cases?q={private}");
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": steps })).unwrap();
    store::save_route(&r).unwrap();
    r
}

/// A primitive that answers with what `args` says a page, a script or a walk gave back (`answer`), or fails with it
/// (`fail`): every primitive's answer crosses `run_primitive`, so this stands for any of them.
fn saying_primitive() -> &'static Primitive {
    Box::leak(Box::new(Primitive {
        tool: "unbrowse_test_says",
        method: "POST",
        path: "/v1/test/says",
        renamed: &[],
        description: "",
        schema: || json!({ "type": "object" }),
        returns: || json!({}),
        sdk: &[],
        cli: "",
        run: |_, _, args| {
            plainly(async move {
                match args.get("fail").and_then(Value::as_str) {
                    Some(e) => Err((StatusCode::UNPROCESSABLE_ENTITY, e.to_string())),
                    None => Ok(args["answer"].clone()),
                }
            })
        },
    }))
}

/// What an agent hears from `run_primitive` when a page, a script or a walk gave back `answer` (or failed with it).
fn heard_by_an_agent(rt: &tokio::runtime::Runtime, node: &Arc<Node>, agent: &Agent, answer: Value) -> String {
    let args = match &answer {
        Value::Object(m) if m.contains_key("fail") => answer.clone(),
        _ => json!({ "answer": answer }),
    };
    match rt.block_on(run_primitive(saying_primitive(), node, agent, args, "unbrowse_test_says")) {
        Ok(v) => v.to_string(),
        Err(f) => f.error,
    }
}

/// What the node holds as the site's session in its jar (a cookie, a header token) never reaches an agent: not as a
/// script's answer to `document.cookie`, not where a page prints it, not percent-encoded in an address or as base64,
/// not in an error. What the agent reads is `{session}` there; the rest of the answer stands.
#[test]
fn an_eval_of_document_cookie_never_hands_an_agent_the_session() {
    let home = store::scratch_home("session-eval");
    let (rt, node, agent) = agent_node(&home);
    let (sid, token) = ("Zq9xSessionCookie4471", "eyJhbGciOiJIUzI1NiJ9.c2Vzc2lvbg.sig42");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    store::write_json(&store::jar_path("shop.example"), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid".to_string(), sid.to_string()), ("authorization".to_string(), format!("Bearer {token}"))])).unwrap();
    store::write_json(&store::jar_path("api.shop.example"), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("tok".to_string(), token.to_string())])).unwrap();
    use base64::Engine;
    for (what, answer) in [
        ("eval document.cookie", json!(format!("sid={sid}; theme=dark"))),
        ("a page that prints it", json!({ "text": format!("Signed in. Debug: session {sid}, token {token}") })),
        ("an address", json!({ "url": format!("https://shop.example/r?s={}", percent_encoding::utf8_percent_encode(sid, percent_encoding::NON_ALPHANUMERIC)) })),
        ("base64", json!(base64::engine::general_purpose::STANDARD.encode(format!("sid={sid}")))),
        ("an error", json!({ "fail": format!("the page answered 401 for token {token}") })),
    ] {
        let heard = heard_by_an_agent(&rt, &node, &agent, answer);
        assert!(!heard.contains(sid) && !heard.contains(token) && !heard.contains("Zq9x"), "{what}: {heard}");
        assert!(heard.contains("{session}"), "{what}: {heard}");
    }
    assert!(heard_by_an_agent(&rt, &node, &agent, json!("theme=dark")).contains("theme=dark"), "what isn't the session stands");
    let _ = std::fs::remove_dir_all(&home);
}

/// What the node can't read of what it holds as the session can't be hidden, so the answer isn't given: a jar that is
/// there and won't parse, and a browser folder that is there and can't be listed. No jar folder and no browser folder
/// is nothing held, and the answer goes.
#[test]
fn a_session_the_node_cannot_read_refuses_the_answer() {
    let home = store::scratch_home("session-unread");
    let (rt, node, agent) = agent_node(&home);
    let _ = std::fs::remove_dir_all(store::jars_dir());
    assert_eq!(heard_by_an_agent(&rt, &node, &agent, json!("plain words")), "\"plain words\"", "nothing held, the answer goes");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    std::fs::write(store::jar_path("shop.example"), b"{ not a jar").unwrap();
    let heard = heard_by_an_agent(&rt, &node, &agent, json!("plain words"));
    assert!(heard.contains("can't keep the session it holds out of this answer"), "{heard}");
    std::fs::remove_file(store::jar_path("shop.example")).unwrap();
    // A file of a jar's name that holds JSON of another shape (a stale graph) is no jar, and holds nothing sent.
    std::fs::write(store::jar_path("shop.example.graph"), br#"{"steps":[{"url":"https://shop.example/"}]}"#).unwrap();
    assert_eq!(heard_by_an_agent(&rt, &node, &agent, json!("plain words")), "\"plain words\"");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let browsers = store::home().join("browser");
        std::fs::create_dir_all(&browsers).unwrap();
        std::fs::set_permissions(&browsers, std::fs::Permissions::from_mode(0o000)).unwrap();
        let heard = heard_by_an_agent(&rt, &node, &agent, json!("plain words"));
        std::fs::set_permissions(&browsers, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(heard.contains("couldn't list its running browsers"), "{heard}");
    }
    let _ = std::fs::remove_dir_all(&home);
}

/// A browser behind a door in `home`'s browser folder, its DevTools answering `Storage.getCookies` with `reply` (and
/// any other command with an empty result), as the node's own browsers answer. The door goes when its file is removed.
#[cfg(unix)]
fn fake_browser(home: &std::path::Path, name: &str, reply: Value) -> std::path::PathBuf {
    use std::io::{BufRead, Write};
    let ws = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = ws.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in ws.incoming().flatten() {
            let reply = reply.clone();
            std::thread::spawn(move || {
                let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else { return };
                while let Ok(msg) = socket.read() {
                    let Ok(text) = msg.to_text() else { continue };
                    let Ok(cmd) = serde_json::from_str::<Value>(text) else { continue };
                    let result = if cmd["method"] == "Storage.getCookies" { reply.clone() } else { json!({}) };
                    let _ = socket.send(tokio_tungstenite::tungstenite::Message::text(json!({ "id": cmd["id"], "result": result }).to_string()));
                }
            });
        }
    });
    let dir = home.join("browser");
    std::fs::create_dir_all(&dir).unwrap();
    let door = dir.join(format!("{name}.sock"));
    let listener = std::os::unix::net::UnixListener::bind(&door).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let mut out = stream;
            let _ = writeln!(out, "{}", json!({ "success": true, "data": { "cdpUrl": format!("ws://127.0.0.1:{port}/devtools/browser/fake") } }));
        }
    });
    door
}

#[cfg(unix)]
fn fake_browser_fault(home: &std::path::Path, name: &str, delay: bool) -> std::path::PathBuf {
    use std::io::{BufRead, Write};
    let ws = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = ws.local_addr().unwrap().port();
    std::thread::spawn(move || for stream in ws.incoming().flatten() {
        std::thread::spawn(move || {
            let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else { return };
            while let Ok(msg) = socket.read() {
                let Ok(text) = msg.to_text() else { continue };
                let Ok(cmd) = serde_json::from_str::<Value>(text) else { continue };
                if cmd["method"] == "Storage.getCookies" {
                    if delay { std::thread::sleep(std::time::Duration::from_secs(11)); }
                    else { return; }
                }
                let _ = socket.send(tokio_tungstenite::tungstenite::Message::text(json!({"id":cmd["id"],"result":{"cookies":[]}}).to_string()));
            }
        });
    });
    let dir=home.join("browser"); std::fs::create_dir_all(&dir).unwrap();
    let door=dir.join(format!("{name}.sock"));
    let listener=std::os::unix::net::UnixListener::bind(&door).unwrap();
    std::thread::spawn(move || for stream in listener.incoming().flatten() {
        let mut reader=std::io::BufReader::new(stream.try_clone().unwrap()); let mut line=String::new(); let _=reader.read_line(&mut line);
        let mut out=stream; let _=writeln!(out,"{}",json!({"success":true,"data":{"cdpUrl":format!("ws://127.0.0.1:{port}/devtools/browser/fault")}}));
    });
    door
}

/// Only a session read whole lets an agent's answer out. A browser's reply to which cookies it holds lets it out when
/// it is a list of cookies (an empty one included), and its values are masked; a reply of another shape (no list, a
/// cookie with no value) refuses the answer. A jar written as this build writes one lets it out, masked, and so does a
/// stale file of another shape; a jar that can't be read, is cut off mid-write or was written by a newer build refuses
/// it. All in a scratch home, checked to be the scratch one.
#[cfg(unix)]
#[test]
fn only_a_session_read_whole_lets_an_answer_out() {
    use std::os::unix::fs::PermissionsExt;
    let _ = store::scratch_home("inventory");
    // A short home: a browser door's path has a length limit the temp folder's own path would pass.
    let home = std::path::PathBuf::from(format!("/tmp/ubinv{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    store::use_home(&home);
    let owners = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".unbrowse");
    assert!(store::home() == home && !store::home().starts_with(&owners), "the home in use is the scratch one: {}", store::home().display());
    let (rt, node, agent) = agent_node(&home);
    let answer = |said: &str| rt.block_on(run_primitive(saying_primitive(), &node, &agent, json!({ "answer": said }), "unbrowse_test_says"));
    let refused = |r: Result<Value, Failed>, what: &str| match r {
        Err(f) => assert_eq!(f.status, StatusCode::SERVICE_UNAVAILABLE, "{what}: {}", f.error),
        Ok(v) => panic!("{what}: the answer went out: {v}"),
    };
    let held = "FakeBrowserSession42x";
    // The browser's replies.
    for (what, reply, lets_out) in [
        ("a list of cookies", json!({ "cookies": [{ "name": "sid", "value": held, "domain": "shop.example" }] }), true),
        ("an empty list", json!({ "cookies": [] }), true),
        ("no list", json!({}), false),
        ("a list of another shape", json!({ "cookies": "none" }), false),
        ("a cookie with no value", json!({ "cookies": [{ "name": "sid", "domain": "shop.example" }] }), false),
        ("a cookie whose value isn't text", json!({ "cookies": [{ "name": "sid", "value": 42, "domain": "shop.example" }] }), false),
    ] {
        let door = fake_browser(&home, "fake", reply);
        let r = answer(&format!("the page says {held}"));
        let _ = std::fs::remove_file(&door);
        if lets_out {
            let v = r.unwrap_or_else(|e| panic!("{what}: {e:?}"));
            // What the browser holds is masked; an empty list holds nothing to mask.
            assert_eq!(v.to_string().contains(held), what == "an empty list", "{what}: {v}");
        } else {
            refused(r, what);
        }
    }
    for (name, delay) in [("slow", true), ("dropped", false)] {
        let door=fake_browser_fault(&home,name,delay);
        refused(answer("a blocked browser inventory still refuses"),name);
        let _=std::fs::remove_file(door);
    }
    // The jars.
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let jar = store::jar_path("shop.example");
    let token = "JarSessionToken77x";
    store::write_json(&jar, &unbrowse_files::JAR, &std::collections::BTreeMap::from([("sid".to_string(), token.to_string())])).unwrap();
    let v = answer(&format!("the page says {token}")).expect("a jar written as this build writes one");
    assert!(!v.to_string().contains(token), "masked: {v}");
    std::fs::write(store::jar_path("shop.example.graph"), br#"{"steps":[{"url":"https://shop.example/"}]}"#).unwrap();
    answer("plain words").expect("a stale file of another shape is no jar");
    std::fs::remove_file(store::jar_path("shop.example.graph")).unwrap();
    std::fs::set_permissions(&jar, std::fs::Permissions::from_mode(0o000)).unwrap();
    let r = answer("plain words");
    std::fs::set_permissions(&jar, std::fs::Permissions::from_mode(0o600)).unwrap();
    refused(r, "a jar that can't be read");
    std::fs::write(&jar, br#"{"v":1,"items":{"sid":"JarSess"#).unwrap();
    refused(answer("plain words"), "a jar cut off mid-write");
    std::fs::write(&jar, br#"{"v":999,"items":{"sid":"JarSessionToken77x"}}"#).unwrap();
    refused(answer("plain words"), "a jar a newer build wrote");
    let _ = std::fs::remove_dir_all(&home);
}

/// A walk's capture holds the cookies the walk's browser sent: a page that reflects one into the address of a call it
/// makes puts it in the list of calls the walk answers with (`unbrowse_walk`'s candidates), and that list says
/// `{session}` there, even after the walk's browser has gone and its jar holds nothing.
#[test]
fn a_candidate_path_never_carries_the_session_to_an_agent() {
    let home = store::scratch_home("session-walk");
    let (rt, node, agent) = agent_node(&home);
    let sid = "HttpOnlyWalkSession9931";
    let ex = |url: &str, cookie: Option<&str>, set: Option<&str>| unbrowse_learn::trace::Exchange {
        method: "GET".into(),
        url: url.parse().unwrap(),
        request_headers: cookie.map(|c| vec![("Cookie".to_string(), c.to_string())]).unwrap_or_default(),
        request_body: None,
        status: 200,
        response_headers: set.map(|c| vec![("Set-Cookie".to_string(), c.to_string())]).unwrap_or_default(),
        response_body: Some("{}".into()),
        response_mime: "application/json".into(),
        resource_type: Some("XHR".into()),
        main_frame: Some(true),
    };
    let trace = unbrowse_learn::Trace {
        exchanges: vec![ex("https://shop.example/", None, Some(&format!("sid={sid}; Path=/; HttpOnly"))), ex(&format!("https://shop.example/api/echo?s={sid}"), Some(&format!("sid={sid}; lang=en")), None)],
        inputs: Vec::new(),
    };
    crate::session_held::note_trace(&trace);
    let candidates = json!({ "walk": "w1", "candidates": [{ "index": 1, "method": "GET", "host": "shop.example", "path": format!("/api/echo?s={sid}") }] });
    let heard = heard_by_an_agent(&rt, &node, &agent, candidates);
    assert!(!heard.contains(sid) && heard.contains("/api/echo?s={session}"), "{heard}");
    let _ = std::fs::remove_dir_all(&home);
}

/// The site's session never reaches an agent through the node's browser, at two layers. An agent's script runs in a
/// world of its own (`agent_world` in the browser): there `document.cookie` and the page's storage say every value as
/// `{session}` before the script can change it, so a script that base64s, reverses or reads it through a frame it made
/// gets the placeholder, and writes, IndexedDB, the caches, workers, a new window and every way to hand code to the
/// page's own world are refused; the page's own code still sees its real cookie. And every answer is masked on its
/// way out: a page the server reflects its cookies into, the HttpOnly one included, says `{session}` there. Driven
/// against the node's real browser program and a signed-in site served from another machine (the node's browser never
/// reaches this one): run `app/tests/fixtures/session_site.py <port>` there, then
/// `UNBROWSE_LIVE_SITE=http://<that machine>:<port> UNBROWSE_BROWSER=<agent-browser> cargo test -p unbrowse-node-app
/// a_signed_in_page_never_hands -- --ignored`.
#[test]
#[ignore = "drives the node's browser against a site on another machine: see the doc comment. Its first layer (the agent's own world) went with the browser rewrite of 21 Nov 2026 (SECURITY.md, What isn't defended), so the checks of a transformed read fail until it returns"]
fn a_signed_in_page_never_hands_its_cookies_to_an_agent_through_the_browser() {
    use base64::Engine;
    let site = std::env::var("UNBROWSE_LIVE_SITE").expect("UNBROWSE_LIVE_SITE: the session_site.py fixture's address");
    // A short home: a browser's socket path has a length limit the temp folder's own path would pass.
    let _ = store::scratch_home("session-browse-live");
    let home = std::path::PathBuf::from(format!("/tmp/ub{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    store::use_home(&home);
    let (rt, node, agent) = agent_node(&home);
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    // The browser's proxy reads the setting as the node tells it on start (process-wide: this test runs by hand).
    unbrowse_learn::egress::allow_private(true);
    let now = store::now();
    let (sid, pref, kept) = (format!("HttpOnlyLiveSession{now}x"), format!("ScriptReadableSession{now}y"), format!("St0rageSessionToken{now}z"));
    let browse = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_browse").unwrap();
    let say = |steps: &[&str]| {
        let args = json!({ "do": steps, "session": "live" });
        match rt.block_on(run_primitive(browse, &node, &agent, args, "unbrowse_browse")) {
            Ok(v) => v["output"].as_str().map(String::from).unwrap_or_else(|| v.to_string()),
            Err(f) => f.error,
        }
    };
    let opened = say(&["open", &format!("{site}/?sid={sid}&pref={pref}&kept={kept}")]);
    assert!(!opened.contains("rror"), "{opened}");
    let secret = |heard: &str| [&sid, &pref, &kept].iter().any(|v| heard.contains(v.as_str()));
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    // What the agent's own script reads: the placeholder, before it can change it.
    for (probe, want) in [
        ("document.title", "\"app sees its cookie\"".to_string()),
        ("document.cookie", "\"pref={session}\"".to_string()),
        ("btoa(document.cookie)", format!("{:?}", b64("pref={session}"))),
        ("document.cookie.split('').reverse().join('')", "\"}noisses{=ferp\"".to_string()),
        ("Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get.call(document)", "\"pref={session}\"".to_string()),
        ("new Function('return document.cookie')()", "\"pref={session}\"".to_string()),
        ("(() => { const f = document.createElement('iframe'); document.body.appendChild(f); return [String(f.contentWindow && f.contentWindow.document.cookie), String(window[window.length - 1].document.cookie), btoa(window[window.length - 1].document.cookie)].join(' | '); })()", format!("\"pref={{session}} | pref={{session}} | {}\"", b64("pref={session}"))),
        ("localStorage.getItem('authState')", "\"{session}\"".to_string()),
        ("localStorage.authState.split('').reverse().join('')", "\"}noisses{\"".to_string()),
        ("btoa(JSON.stringify(localStorage)) + ' ' + JSON.stringify(Object.entries(sessionStorage))", format!("\"{} [[\\\"tab\\\",\\\"{{session}}\\\"]]\"", b64("{\"authState\":\"{session}\"}"))),
        ("typeof window.appState", "\"undefined\"".to_string()),
        // Built-ins the agent's script replaces reach nothing of the world's own: it took them before any script ran.
        ("(() => { String.prototype.split = function () { window.__s = String(this); return []; }; void document.cookie; return String(window.__s); })()", "\"undefined\"".to_string()),
        ("(() => { Function.prototype.call = function () { window.__f = this; return ''; }; Reflect.apply = function (f) { window.__r = f; return ''; }; void document.cookie; return typeof window.__f + typeof window.__r; })()", "\"undefinedundefined\"".to_string()),
    ] {
        let heard = say(&["eval", probe]);
        assert_eq!(heard, want, "{probe}");
    }
    // What it may not do: write the session, reach what can't be shown as a stand-in, or hand code to the page's world.
    for probe in [
        "localStorage.setItem('authState', 'x')",
        "document.cookie = 'pref=x'",
        "typeof indexedDB",
        "typeof caches",
        "new Worker('data:,')",
        "window.open('about:blank')",
        "navigator.serviceWorker",
        "document.createElement('script')",
        "document.createElementNS('http://www.w3.org/2000/svg', 'script')",
        "document.body.setAttribute('onclick', 'document.title = btoa(document.cookie)')",
        "document.createElement('a').href = 'javascript:document.title = btoa(document.cookie)'",
        "document.body.innerHTML += '<img src=x onerror=\"document.title = btoa(document.cookie)\">'",
        "document.body.insertAdjacentHTML('beforeend', '<img src=x onerror=1>')",
        "document.write('<script>1</script>')",
        "new DOMParser().parseFromString('<p>', 'text/html')",
        "document.createRange().createContextualFragment('<img src=x onerror=1>')",
        "(() => { const a = document.createAttribute('onclick'); a.value = 'document.title = 1'; return 'set'; })()",
        "document.createElement('iframe').srcdoc = '<script>1</script>'",
        "URL.createObjectURL(new Blob(['<script>document.title = btoa(document.cookie)</script>'], { type: 'text/html' }))",
    ] {
        let heard = say(&["eval", probe]);
        // The caches and service workers are a secure context's only: on a plain address they aren't there at all.
        let absent = matches!(probe, "typeof caches" | "navigator.serviceWorker") && (heard == "\"undefined\"" || heard == "null" || heard.is_empty());
        assert!(heard.contains("isn't open to an agent's script") || absent, "{probe}: {heard}");
    }
    // A `javascript:` address given to the page's own location (unforgeable, so no world can wrap it) runs in the
    // page's own world, where the real cookie is: what it writes into the page reaches the agent only through the
    // answer's mask, which reads base64 among its forms (SECURITY.md, "What isn't defended").
    let _ = say(&["eval", "location.href = 'javascript:void(document.title = btoa(document.cookie))'"]);
    let after = say(&["eval", "new Promise(r => setTimeout(() => r(document.title), 500))"]);
    assert!(!secret(&after) && !after.contains(&b64(&format!("pref={pref}"))), "after a javascript: address: {after}");
    // Written as itself, it reads back masked; written in a form the mask doesn't know (reversed), it reads back as the
    // page's code wrote it: the documented limit of a mask, on the documented path into the page's world.
    let _ = say(&["eval", "location.href = 'javascript:void(document.title = document.cookie)'"]);
    let raw = say(&["eval", "new Promise(r => setTimeout(() => r(document.title), 500))"]);
    eprintln!("location = javascript:, the cookie written as itself, read back through the node: {raw}");
    assert!(!secret(&raw) && raw.contains("{session}"), "the raw cookie: {raw}");
    let _ = say(&["eval", "location.href = \"javascript:void(document.title = document.cookie.split('').reverse().join(''))\""]);
    let reversed = say(&["eval", "new Promise(r => setTimeout(() => r(document.title), 500))"]);
    eprintln!("location = javascript:, the cookie written reversed, read back through the node: {reversed}");
    assert!(reversed.contains(&pref.chars().rev().collect::<String>()), "recorded: a reversed cookie is a transform the mask doesn't know: {reversed}");
    let _ = say(&["eval", "(() => { const m = document.createElement('meta'); m.setAttribute('http-equiv', 'refresh'); m.setAttribute('content', '0;url=javascript:document.title=1'); document.head.appendChild(m); return 1; })()"]);
    eprintln!("after a refresh to a javascript: address: {}", say(&["eval", "new Promise(r => setTimeout(() => r(document.title), 800))"]));
    // Every answer is masked on its way out too: a page that says back the cookies it was sent, HttpOnly included.
    let _ = say(&["open", &format!("{site}/me")]);
    let page = say(&["get", "text", "#me"]);
    assert!(page.contains("You sent") && !secret(&page) && page.contains("{session}"), "the reflected page: {page}");
    let snapshot = say(&["snapshot"]);
    assert!(!secret(&snapshot), "the snapshot: {snapshot}");
    let _ = say(&["close"]);
    let _ = std::fs::remove_dir_all(&home);
}

/// The walk that exposed it (a video site's search): the search sends the typed word as its own `query`, and again
/// inside the address of the results page it opens (`context.client.originalUrl`, written with `+`), which the graph
/// holds the input inside (`held`). At call time the caller's word goes where the owner's stood, so the owner's word
/// is not what the call sends there: the agent's call is not refused for it, the owner's word is out of the route the
/// agent runs, and the caller's word lands where it stood. A value that carries the owner's word with no input held
/// inside it is still refused.
#[test]
fn a_value_the_graph_holds_the_input_inside_carries_the_callers_word_not_the_owners() {
    let _home = store::scratch_home("owners-own-held");
    let private = "folding desk lamp 4471";
    let plus = "folding+desk+lamp+4471";
    let address = format!("https://shop.example/results?search_query={plus}");
    let input = json!({ "loc": { "in": "json", "key": "/query" }, "class": "input", "name": "q", "secret": false, "default": private });
    let fixed = json!({ "loc": { "in": "json", "key": "/context/originalUrl" }, "class": "constant", "value": address });
    let mut step = step_of("POST", "https://shop.example/api/v1/search", json!([input, fixed]));
    step["held"] = json!([{ "loc": { "in": "json", "key": "/context/originalUrl" }, "input": "q", "sits": plus, "written": "plus" }]);
    step["body"] = json!({ "kind": "json", "template": { "context": { "originalUrl": address }, "query": null }, "types": { "/query": "string" } });
    let mut r = owners_route("held-address", 1, private, json!([step]));
    r.root = "https://shop.example/results".into();
    r.read_by = Some(store::ReadBy::current());
    r.walk_without_fragment = true;
    r.page_made = Some(Vec::new());
    let runs = r.callable_by_an_agent().expect("the caller's word goes where the owner's stood");
    let sent = serde_json::to_string(&runs.graph).unwrap();
    assert!(!sent.contains(plus) && !sent.contains(private), "the owner's word is out of what the agent runs: {sent}");
    let s = &runs.graph.steps[0];
    let at = s.fields.iter().find_map(|f| match &f.class { unbrowse_learn::graph::Class::Constant { value, .. } => Some(value.clone()), _ => None }).unwrap();
    let now = s.held[0].written.write("pallet racking");
    assert_eq!(unbrowse_learn::graph::swapped(&at, &s.held[0].sits, &now), "https://shop.example/results?search_query=pallet+racking", "the caller's word lands where the owner's stood");
    // The owner's word in a value nothing holds an input inside is still theirs, and still refused.
    let mut bare = r.clone();
    bare.graph.steps[0].held.clear();
    assert!(bare.callable_by_an_agent().expect_err("no input held there").contains("still carries what they typed"));
}

/// What the owner's session gave a page is found however the route keeps it, by the one reader of "carries"
/// (`trace::carries_written`): base64 in a fixed body value is refused to an agent's call and isn't listed for sharing;
/// and a value inside what the signing sandbox runs with (the route's kept page, its scripts, the answers it replays)
/// refuses an agent's call too, naming which.
#[test]
fn an_owners_value_however_written_is_never_sent_for_an_agent_nor_shared() {
    use base64::Engine;
    let _home = store::scratch_home("owners-own-written");
    let private = "case-4471-private";
    let b64 = base64::engine::general_purpose::STANDARD.encode(private);
    let input = json!({ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": private });
    let mut r = owners_route("in-body-b64", 1, private, json!([
        step_of("POST", "https://shop.example/api/cases?q={q}", json!([input, { "loc": { "in": "json", "key": "/t" }, "class": "constant", "value": b64 }])),
    ]));
    r.graph.steps[0].body = Some(unbrowse_learn::Body::Json { template: json!({ "t": b64 }), types: Default::default() });
    r.root = "https://shop.example/cases".into();
    r.read_by = Some(store::ReadBy::current());
    r.walk_without_fragment = true;
    r.page_made = Some(Vec::new());
    let refused = r.callable_by_an_agent().expect_err("base64 in a body constant");
    assert!(refused.contains("still carries what they typed at step 1") && !refused.contains(private), "{refused}");
    let shared = crate::recipe::compile_with(&r, false).expect_err("not listed");
    assert!(shared.contains("still appears"), "{shared}");
    // Twice: the reader applies its own forms to its own output.
    let twice = base64::engine::general_purpose::STANDARD.encode(&b64);
    let mut r2 = r.clone();
    r2.id = "in-body-b64-twice".into();
    r2.graph.steps[0].fields[1].class = unbrowse_learn::Class::Constant { value: twice.clone(), origin: None };
    r2.graph.steps[0].body = Some(unbrowse_learn::Body::Json { template: json!({ "t": twice }), types: Default::default() });
    let refused = r2.callable_by_an_agent().expect_err("twice-base64 in a body constant");
    assert!(refused.contains("still carries what they typed at step 1") && !refused.contains(private), "{refused}");
    let shared = crate::recipe::compile_with(&r2, false).expect_err("and it isn't listed");
    assert!(shared.contains("still appears"), "{shared}");
    // What the signing sandbox runs with.
    let plain = || {
        let mut r = owners_route("kept", 1, private, json!([step_of("GET", "https://shop.example/api/cases?q={q}", json!([input]))]));
        r.root = "https://shop.example/cases".into();
        r
    };
    assert!(plain().callable_by_an_agent().is_ok(), "nothing kept, nothing refused");
    let mut script = plain();
    script.graph.scripts = vec![unbrowse_learn::signing::Script { url: "https://shop.example/app.js".into(), body: format!("var last = \"{private}\";") }];
    let mut api = plain();
    api.graph.api = vec![unbrowse_learn::signing::Answer { url: "https://shop.example/api/me".into(), status: 200, mime: "application/json".into(), body: json!({ "recent": b64 }).to_string() }];
    let mut page = plain();
    page.graph.page_html = Some(format!("<p>Results for &quot;{private}&quot;</p>"));
    for (kept, key) in [(script, "scripts"), (api, "api"), (page, "page_html")] {
        let refused = kept.callable_by_an_agent().expect_err(key);
        assert!(refused.contains(&format!("the route's kept {key}")) && !refused.contains(private), "{refused}");
    }
}

/// A token the site handed the walk in an answer's body, and the walk sent back later in a body or an address's query,
/// is a credential (`provenance::session_values`, the learner's own reading, where no one could have written it): it
/// never reaches an agent, nor does a token the page kept in its storage beside a jar. What the site only showed, and
/// nothing sent back, is page content.
#[test]
fn a_token_the_site_handed_over_never_reaches_an_agent() {
    let home = store::scratch_home("session-handed");
    let (rt, node, agent) = agent_node(&home);
    let (refresh, handle, kept) = ("r3freshTokenZ1x3c5v7b9Q", "h4ndle9921kq", "st0rageTok3n88291x");
    let ex = |method: &str, url: &str, body: Option<String>, answer: String| unbrowse_learn::trace::Exchange {
        method: method.into(),
        url: url.parse().unwrap(),
        request_headers: vec![("Content-Type".into(), "application/json".into())],
        request_body: body,
        status: 200,
        response_headers: vec![("content-type".into(), "application/json".into())],
        response_body: Some(answer),
        response_mime: "application/json".into(),
        resource_type: Some("XHR".into()),
        main_frame: Some(true),
    };
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            ex("POST", "https://shop.example/login", None, json!({ "refresh_token": refresh, "handle": handle, "shown": "onlyShownNeverSent42" }).to_string()),
            ex("POST", &format!("https://shop.example/api/renew?h={handle}"), Some(json!({ "refresh": refresh }).to_string()), "{}".into()),
        ],
        inputs: Vec::new(),
    });
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let storage = unbrowse_learn::sandbox::Storage { local: HashMap::from([("authState".to_string(), kept.to_string())]), session: HashMap::new() };
    store::write_json(&unbrowse_learn::client::storage_path(&store::jars_dir(), "shop.example"), &unbrowse_files::JAR, &storage).unwrap();
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "data": { "refresh": refresh, "next": format!("/api/renew?h={handle}"), "state": kept, "shown": "onlyShownNeverSent42" } }));
    assert!(!heard.contains(refresh) && !heard.contains(handle) && !heard.contains(kept), "{heard}");
    assert!(heard.contains("onlyShownNeverSent42"), "what nothing sent back is page content: {heard}");
    let _ = std::fs::remove_dir_all(&home);
}

/// What a walk was handed and sent back that a person or the page could have written is content, not a credential, and
/// stands in every answer: a piece of the page's own paths, an item's number, a word. A token the site minted for the
/// walk and the walk sent back in a query is held, and a cookie is held by its place however plain it reads (a
/// session id of digits alone).
#[test]
fn what_a_walk_sent_back_is_a_credential_only_where_no_one_could_have_written_it() {
    let home = store::scratch_home("handed-written");
    let (rt, node, agent) = agent_node(&home);
    let (part, item, word, token, sid) = ("wp-catalog-parts-7q", "1795314547", "lamps", "tok3nMadeForThisWalk91x", "357-8168052-7913742");
    let ex = |url: &str, cookie: Option<&str>, set: Option<&str>, answer: String| unbrowse_learn::trace::Exchange {
        method: "GET".into(),
        url: url.parse().unwrap(),
        request_headers: cookie.map(|c| vec![("Cookie".to_string(), c.to_string())]).unwrap_or_default(),
        request_body: None,
        status: 200,
        response_headers: set.map(|c| vec![("Set-Cookie".to_string(), c.to_string())]).unwrap_or_default(),
        response_body: Some(answer),
        response_mime: "application/json".into(),
        resource_type: Some("XHR".into()),
        main_frame: Some(true),
    };
    let page = json!({ "parts": format!("/{part}/list.js"), "item": item, "shelf": word, "token": token }).to_string();
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            ex("https://shop.example/cases", None, Some(&format!("session-id={sid}; Path=/")), page),
            ex(&format!("https://shop.example/{part}/list?item={item}&shelf={word}&t={token}"), Some(&format!("session-id={sid}")), None, "{}".into()),
        ],
        inputs: Vec::new(),
    });
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "next": format!("https://shop.example/{part}/list?item={item}&shelf={word}&t={token}"), "you": sid }));
    assert!(heard.contains(&format!("https://shop.example/{part}/list?item={item}&shelf={word}&t={{session}}")), "{heard}");
    assert!(!heard.contains(token) && !heard.contains(sid) && heard.contains(r#""you":"{session}""#), "the minted token and the cookie are held: {heard}");
    let _ = std::fs::remove_dir_all(&home);
}

/// What one site's page saved in its storage that a person wrote (a search) is not a credential, and another site's
/// answer that says the same words keeps them; a token the page keeps, whole or inside a JSON value it stores, is held.
#[test]
fn a_search_a_page_saved_is_not_the_session_and_a_stored_token_is() {
    let home = store::scratch_home("stored-search");
    let (rt, node, agent) = agent_node(&home);
    let (token, inner) = ("st0rageTok3n88291xQ", "rEfr3shInsideJson55kw");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let storage = unbrowse_learn::sandbox::Storage {
        local: HashMap::from([
            ("s_header_search_keywords".to_string(), "b550m".to_string()),
            ("recent".to_string(), r#"{"w4":{"date":1795315053212,"value":"10|b550m"}}"#.to_string()),
            ("authState".to_string(), token.to_string()),
            ("auth".to_string(), json!({ "user": { "refreshToken": inner, "name": "lewis" } }).to_string()),
        ]),
        session: HashMap::new(),
    };
    store::write_json(&unbrowse_learn::client::storage_path(&store::jars_dir(), "shop.example"), &unbrowse_files::JAR, &storage).unwrap();
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "title": "Amazon.sg : b550m motherboard", "links": ["https://other.example/s?k=b550m"], "state": token, "inner": inner }));
    assert!(heard.contains("Amazon.sg : b550m motherboard") && heard.contains("https://other.example/s?k=b550m"), "{heard}");
    assert!(!heard.contains(token) && !heard.contains(inner), "{heard}");
    let _ = std::fs::remove_dir_all(&home);
}

/// What the agent asked with (its goal, the page's address and the words in it, an input, a word it typed) is its own:
/// an answer says it back as it was, even where the node holds the same value as a credential. A credential only
/// partly equal to a word it sent is still held, and so is everything else in the answer.
#[test]
fn what_the_caller_asked_with_is_never_masked() {
    let home = store::scratch_home("callers-words");
    let (rt, node, agent) = agent_node(&home);
    let (asked, typed, sid) = ("b550m", "Zq9xQuery77k", "Zq9xSessionCookie4471");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    store::write_json(&store::jar_path("shop.example"), &unbrowse_files::JAR, &std::collections::BTreeMap::from([("kw".to_string(), asked.to_string()), ("q".to_string(), typed.to_string()), ("sid".to_string(), sid.to_string())])).unwrap();
    let answer = json!({ "title": format!("{asked} results"), "typed": typed, "sid": sid });
    let say = |args: Value| match rt.block_on(run_primitive(saying_primitive(), &node, &agent, args, "unbrowse_test_says")) {
        Ok(v) => v.to_string(),
        Err(f) => f.error,
    };
    let unasked = say(json!({ "answer": answer }));
    assert!(!unasked.contains(asked) && !unasked.contains(typed) && !unasked.contains(sid), "nothing asked with: all held: {unasked}");
    let heard = say(json!({ "answer": answer, "url": format!("https://shop.example/s?k={asked}"), "do": ["fill", "e3", typed], "goal": "Zq9xSession lamps" }));
    assert!(heard.contains(&format!("{asked} results")) && heard.contains(typed), "{heard}");
    assert!(!heard.contains(sid), "a credential only partly a word asked with is held: {heard}");
    let _ = std::fs::remove_dir_all(&home);
}

/// What comes back from an agent's own call, answer or error, says nothing the owner's own session gave the route: a
/// site that remembers what the owner searched says it back, and the agent hears `{q}` there. What the agent sent
/// itself it hears back as it was.
#[test]
fn an_agents_call_never_hears_the_owners_value_back() {
    let home = store::scratch_home("owners-own-call");
    let (rt, node, agent) = agent_node(&home);
    let private = "case-4471-private";
    use base64::Engine;
    let (port, _) = hearing_site(json!({ "recent": private, "encoded": base64::engine::general_purpose::STANDARD.encode(private), "title": "a case" }).to_string());
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    owners_route("owners-call", port, private, json!([
        step_of("GET", &format!("http://127.0.0.1:{port}/cases?q={{q}}"), json!([
            { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": private },
        ])),
    ]));
    let call = |inputs: HashMap<String, String>| {
        let (at, agent) = (node.clone(), agent.clone());
        match rt.block_on(async move { do_call(&at, &agent, "owners-call".into(), inputs).await }) {
            Ok(v) => v.to_string(),
            Err((_, e)) => e,
        }
    };
    let heard = call(HashMap::from([("q".to_string(), "desk lamps".to_string())]));
    assert!(heard.contains("a case"), "the call was answered: {heard}");
    assert!(!heard.contains(private) && !heard.contains(&base64::engine::general_purpose::STANDARD.encode(private)) && heard.contains("{q}"), "{heard}");
    // An agent that sent the value itself hears it as the site said it.
    let mine = call(HashMap::from([("q".to_string(), private.to_string())]));
    assert!(mine.contains(private), "{mine}");
    let _ = std::fs::remove_dir_all(&home);
}

/// An agent's call never sends what the owner's own session gave, wherever the route keeps it: a fixed path piece,
/// a fixed header or a constant's own source address refuses the call by the place it sits, before anything is sent;
/// a fixed value at the very place another step takes the input becomes the agent's there; and the page a heal walks
/// keeps none of it.
#[test]
fn an_agents_call_never_sends_what_the_owners_session_gave() {
    let home = store::scratch_home("owners-own-sent");
    let (rt, node, agent) = agent_node(&home);
    let private = "case-4471-private";
    let (port, heard) = hearing_site(json!({ "title": "a case" }).to_string());
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    let call = |id: &str| {
        let (at, agent, id) = (node.clone(), agent.clone(), id.to_string());
        let inputs = HashMap::from([("q".to_string(), "desk lamps".to_string())]);
        match rt.block_on(async move { do_call(&at, &agent, id, inputs).await }) {
            Ok(v) => Ok(v.to_string()),
            Err((_, e)) => Err(e),
        }
    };
    let input = json!({ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": private });
    for (id, step, at) in [
        ("in-path", step_of("GET", &format!("http://127.0.0.1:{port}/cases/{private}?q={{q}}"), json!([input, { "loc": { "in": "path", "key": 1 }, "class": "constant", "value": private }])), "step 1"),
        ("in-header", step_of("GET", &format!("http://127.0.0.1:{port}/cases?q={{q}}"), json!([input, { "loc": { "in": "header", "key": "x-case" }, "class": "constant", "value": private }])), "step 1"),
        ("in-origin", step_of("GET", &format!("http://127.0.0.1:{port}/cases?q={{q}}"), json!([input, { "loc": { "in": "header", "key": "x-page" }, "class": "constant", "value": "7",
            "origin": { "exchange": 0, "url": format!("http://127.0.0.1:{port}/find?q={private}"), "at": { "from": "json", "pointer": "/page" } } }])), "step 1"),
    ] {
        owners_route(id, port, private, json!([step]));
        let refused = call(id).expect_err(id);
        assert!(refused.contains("still carries what they typed at") && refused.contains(at) && !refused.contains(private), "{id}: {refused}");
    }
    assert!(heard.lock().unwrap().is_empty(), "nothing was sent: {:?}", heard.lock().unwrap());
    // A fixed value where another step takes the input: the graph says which input it is, so it is the agent's there.
    let r = owners_route("same-place", port, private, json!([
        step_of("GET", &format!("http://127.0.0.1:{port}/suggest?q={private}"), json!([{ "loc": { "in": "query", "key": "q" }, "class": "constant", "value": private }])),
        step_of("GET", &format!("http://127.0.0.1:{port}/cases?q={{q}}"), json!([input])),
    ]));
    let usable = r.callable_by_an_agent().unwrap();
    assert!(matches!(&usable.graph.steps[0].fields[0].class, unbrowse_learn::Class::Input { name, default: None, .. } if name == "q"));
    assert!(!usable.root.contains(private), "the page a heal walks: {}", usable.root);
    let answered = call("same-place").unwrap();
    assert!(answered.contains("a case"), "{answered}");
    let sent = heard.lock().unwrap().clone();
    assert!(sent.iter().any(|p| p.starts_with("/suggest?q=desk")) && sent.iter().all(|p| !p.contains(private)), "{sent:?}");
    assert_eq!(store::load_route("same-place").unwrap().root, format!("http://127.0.0.1:{port}/cases?q={private}"), "the owner's own record keeps it");
    // The owner's own route as kept is untouched by any of it.
    assert!(store::load_route("in-path").unwrap().graph.steps[0].url.contains(private));
    let _ = std::fs::remove_dir_all(&home);
}

/// A route's `method` and `path` speak for its last call, and every step runs on every call. What isn't a plain read is
/// said, wherever a route is shown, so an agent can see it before a call: `write` stays what the rule says, so nothing
/// here lets a read goal run a write it wouldn't have.
#[test]
fn a_routes_steps_that_are_not_plain_reads_are_said() {
    let mut r = route("steps", "shop.example", "search shop", &["q"]);
    let steps = json!([
        step_of("GET", "https://www.shop.example/search?q={q}", json!([])),
        step_of("POST", "https://events.metrics.example/?id={id}", json!([])),
        step_of("POST", "https://www.shop.example/resource/Visit/create/", json!([])),
        step_of("OPTIONS", "https://api.shop.example/v1", json!([])),
        step_of("POST", "https://api.shop.example/v1", json!([])),
    ]);
    r.graph = serde_json::from_value(json!({ "steps": steps, "provisional": false })).unwrap();
    let said = route_json(&r);
    assert_eq!(said["also_sends"], json!([
        { "method": "POST", "host": "events.metrics.example", "path": "/" },
        { "method": "POST", "host": "www.shop.example", "path": "/resource/Visit/create/" },
    ]), "the target isn't its own step, and a preflight is the browser's: {said}");
    crate::apischema::check(&crate::apischema::types()["Route"], &said, &crate::apischema::types()).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(said["write"], false, "said, not relabelled");
    r.graph = serde_json::from_value(json!({ "steps": [step_of("GET", "https://www.shop.example/s", json!([]))], "provisional": false })).unwrap();
    assert!(route_json(&r).get("also_sends").is_none(), "a route of reads says nothing extra");
}

/// A value with a space in a piece of the address finds nothing on a site that writes such pieces another way: the
/// caller hears so, and how the site wrote the one the walk saw.
#[test]
fn a_space_in_a_piece_of_the_address_is_said() {
    let input = |default: &str| json!([{ "loc": { "in": "path", "key": 1 }, "class": "input", "name": "q", "secret": false, "default": default }]);
    let mut r = route("sp", "shop.example", "search shop", &["q"]);
    let given = HashMap::from([("q".to_string(), "gluten free".to_string())]);
    r.graph = serde_json::from_value(json!({ "steps": [step_of("GET", "https://shop.example/search/{path[1]}", input("sour-dough"))], "provisional": false })).unwrap();
    let notes = input_notes(&r, &given);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert!(notes[0].contains("`sour-dough`"), "{notes:?}");
    r.graph = serde_json::from_value(json!({ "steps": [step_of("GET", "https://shop.example/search/{path[1]}", input("bread"))], "provisional": false })).unwrap();
    assert!(!input_notes(&r, &given)[0].contains('`'), "one word says nothing of how the site writes two");
    assert!(input_notes(&r, &HashMap::from([("q".to_string(), "bread".to_string())])).is_empty());
    r.graph = serde_json::from_value(json!({ "steps": [step_of("GET", "https://shop.example/search?q={q}", json!([{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "bread" }]))], "provisional": false })).unwrap();
    assert!(input_notes(&r, &given).is_empty(), "a query carries a space");
}

#[test]
fn a_route_is_found_by_its_page_site_when_the_api_is_on_another(/* #21 */) {
    // Learned on hn.algolia.com, but the call it kept targets algolia.net. Both the page and the API host find it.
    let mut r = route("x", "uj5wyc0l7x-dsn.algolia.net", "search hacker news stories", &["q"]);
    r.root = "https://hn.algolia.com/?q=rust".into();
    let routes = vec![r];
    let by_page = routes_for(&routes, "search hacker news stories", "https://hn.algolia.com/?q=tauri");
    assert_eq!(by_page.len(), 1, "the page it was learned on finds it");
    let by_api = routes_for(&routes, "search hacker news stories", "https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query");
    assert_eq!(by_api.len(), 1, "a direct call on the API host finds it too");
    let other = routes_for(&routes, "search hacker news stories", "https://example.com/");
    assert!(other.is_empty(), "another site does not");
}

#[test]
#[ignore]
fn probe_page_routes() {
    let Ok(f) = std::env::var("UNBROWSE_ROUTE") else { return };
    let r: store::Route = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap();
    let url = std::env::var("UNBROWSE_URL").unwrap();
    let goal = std::env::var("UNBROWSE_GOAL").unwrap();
    let u = url::Url::parse(&url).unwrap();
    println!("fits {} path_inputs {:?} read_only {} routes_for {}", fits(&r, &url), path_inputs(&r, &u), unbrowse_learn::goal::only_reads(&goal), routes_for(std::slice::from_ref(&r), &goal, &url).len());
    println!("page_routes {}", page_routes(std::slice::from_ref(&r), &goal, &url).len());
    let all = store::load_routes();
    println!("loaded {} ; page_routes(all) {:?}", all.len(), page_routes(&all, &goal, &url).iter().map(|r| r.id.clone()).collect::<Vec<_>>());
}

/// A read of the page a route was learned on, worded another way, finds that route when the two goals ask for the
/// same thing; a goal for something else on the page, or a write, doesn't.
#[test]
fn a_page_finds_its_route_whatever_the_goal_is_called() {
    let mut price = route("p", "ex.example", "get live coin price in USD", &[]);
    price.root = "https://ex.example/prices/bitcoin".into();
    let mut news = route("n", "ex.example", "list coin news headlines", &[]);
    news.root = "https://ex.example/prices/bitcoin".into();
    let mut buy = route("b", "ex.example", "buy coin at market price", &[]);
    buy.root = "https://ex.example/prices/bitcoin".into();
    buy.write = true;
    let routes = vec![news, price, buy];
    let ids = |goal: &str| page_routes(&routes, goal, "https://ex.example/prices/bitcoin").iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids("get live bitcoin price"), ["p"]);
    // Once an agent names a route, only its words find it: the words it shares with another goal no longer do.
    let mut named = routes.clone();
    named[1].what = "get coin price candles for a chart".into();
    named[1].judged.named = true;
    assert!(page_routes(&named, "get live bitcoin price", "https://ex.example/prices/bitcoin").is_empty(), "an agent said it's something else");
    // The site's own name is shared by every goal on it, and finds nothing: a store-locator call learned on the search
    // page doesn't answer a product search because both goals say "target".
    let mut store = route("s", "www.target.com", "read redsky aggregations web on target.com", &[]);
    store.root = "https://www.target.com/s?searchTerm=headphones".into();
    assert!(page_routes(&[store], "search Target products", "https://www.target.com/s?searchTerm=headphones").is_empty());
    assert!(ids("read the order book depth").is_empty());
    assert!(page_routes(&routes, "get live bitcoin price", "https://other.example/prices/bitcoin").is_empty());
    // Its answer must hold what the new goal asks for.
    assert!(holds_goal(&json!({"symbol": "BTCUSD", "price": "77950.10"}), "get live bitcoin price"));
    assert!(!holds_goal(&json!({"headlines": [{"title": "a"}, {"title": "b"}, {"title": "c"}]}), "get live bitcoin price"));
}

#[test]
fn a_release_read_finds_the_saved_document_without_a_read_verb() {
    let page = "https://registry.example/images/widget";
    let mut document = route("document", "registry.example", "Read widget on registry.example", &[]);
    document.root = page.into();
    let mut step = step_of("GET", page, json!([]));
    step["reads_page"] = json!(true);
    document.graph.steps = vec![serde_json::from_value(step).unwrap()];

    let mut settings = route("settings", "registry.example", "latest image tag settings", &[]);
    settings.root = page.into();
    settings.graph.steps = vec![serde_json::from_value(step_of("GET", "https://registry.example/api/settings", json!([]))).unwrap()];
    let routes = [settings, document];
    let ask = "latest available tag of the official image";
    let found = page_routes(&routes, ask, page);
    assert_eq!(found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["document"]);
    assert!(page_routes(&routes, ask, "https://registry.example/images/other").is_empty());
    assert!(page_routes(&routes, "latest image tag settings", "https://other.example/images/widget").is_empty());
    assert!(page_routes(&routes, "Please update Widget to the latest version", page).is_empty());
}

#[test]
fn a_release_read_keeps_the_requested_channel() {
    let page = "https://registry.example/images/widget";
    let beta = format!("{page}?channel=beta");
    let mut document = route("document", "registry.example", "Read widget on registry.example", &[]);
    document.root = beta.clone();
    let mut step = step_of("GET", &beta, json!([]));
    step["reads_page"] = json!(true);
    document.graph.steps = vec![serde_json::from_value(step).unwrap()];
    let ask = "latest published version of Widget";
    assert!(page_routes(std::slice::from_ref(&document), ask, page).is_empty());
    assert_eq!(page_routes(std::slice::from_ref(&document), ask, &beta).len(), 1);
    assert!(route_can_reuse_for_url(&document, &beta));
    assert!(!route_can_reuse_for_url(&document, &format!("{page}?channel=stable")));

    let mut parameterized = route("with-input", "registry.example", "Read widget on registry.example", &["channel"]);
    parameterized.root = beta.clone();
    let mut step = step_of("GET", &format!("{page}?channel={{channel}}"), json!([
        {"loc":{"in":"query","key":"channel"},"class":"input","name":"channel","default":"beta","secret":false}
    ]));
    step["reads_page"] = json!(true);
    parameterized.graph.steps = vec![serde_json::from_value(step).unwrap()];
    assert_eq!(page_routes(std::slice::from_ref(&parameterized), ask, &beta).len(), 1);
    assert!(page_routes(&[parameterized], ask, page).is_empty());
}

#[test]
fn a_document_release_cannot_ignore_fragment_selected_input() {
    let page = "https://registry.example/images/widget";
    let selected = format!("{page}#channel=beta");
    let mut document = route("document", "registry.example", "Read widget on registry.example", &[]);
    document.root = selected.clone();
    let mut step = step_of("GET", page, json!([]));
    step["reads_page"] = json!(true);
    document.graph.steps = vec![serde_json::from_value(step).unwrap()];

    assert!(!route_can_reuse_for_url(&document, &selected));
    assert!(page_routes(&[document], "latest published version of Widget", &selected).is_empty());
}

#[test]
fn a_reworded_release_read_still_finds_its_api_route() {
    let page = "https://registry.example/releases/widget";
    let mut saved = route("release-api", "registry.example", "get the latest published version of widget", &[]);
    saved.root = page.into();
    saved.graph.steps = vec![serde_json::from_value(step_of("GET", "https://registry.example/api/releases/latest", json!([]))).unwrap()];
    let routes = [saved];
    let found = page_routes(&routes, "read the latest published version of widget", page);
    assert_eq!(found.iter().map(|route| route.id.as_str()).collect::<Vec<_>>(), ["release-api"]);
}

#[test]
fn a_release_read_does_not_answer_a_publish_request() {
    let page = "https://registry.example/images/widget";
    let mut document = route("document", "registry.example", "Read widget on registry.example", &[]);
    document.root = page.into();
    let mut step = step_of("GET", page, json!([]));
    step["reads_page"] = json!(true);
    document.graph.steps = vec![serde_json::from_value(step).unwrap()];
    let routes = [document];
    for goal in ["Publish the latest version of Widget", "Deploy the latest version of Widget", "Please publish the latest version of Widget and show me the result"] {
        assert!(page_routes(&routes, goal, page).is_empty(), "{goal}");
    }
    assert!(!unbrowse_learn::goal::asks_a_change("Show the publish settings"));
}

#[test]
fn a_fixed_route_is_not_reused_for_a_new_query_value() {
    // A search route learned from ?search=planet with no input for it can only fetch planet; a new value relearns (#23).
    let mut fixed = route("w", "en.wikipedia.org", "search wikipedia", &[]);
    fixed.root = "https://en.wikipedia.org/w/index.php?search=planet".into();
    assert!(fits(&fixed, "https://en.wikipedia.org/w/index.php?search=planet"), "its own query still fits");
    assert!(!fits(&fixed, "https://en.wikipedia.org/w/index.php?search=moon"), "a new query the zero-input route can't do");
    // A route that bound the query as an input fits any value.
    let mut bound = route("b", "en.wikipedia.org", "search wikipedia", &["search"]);
    bound.root = "https://en.wikipedia.org/w/index.php?search=planet".into();
    assert!(fits(&bound, "https://en.wikipedia.org/w/index.php?search=moon"));
}

#[test]
fn a_read_goal_never_picks_a_write_route() {
    // "list WordPress admin posts" is a read; a background admin POST labelled write must not answer it (#25).
    let read = route("r", "shop.example", "list the posts", &[]);
    let mut write = route("w", "shop.example", "list the posts", &[]);
    write.write = true;
    let found = vec![&read, &write];
    let kept = reads_only(found, "list the posts");
    assert_eq!(kept.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["r"], "the write route is dropped for a read goal");
    // A write goal keeps both.
    assert_eq!(reads_only(vec![&read, &write], "post the posts").len(), 2);
}

/// Audit 1118 M8 (16 Nov H9): a stranger's write route runs only for a goal that asks for a change, by the rule the
/// call path holds the same goal to (`asks_a_change`). A goal that names neither a read nor a change used to keep it
/// here while the call path treated the goal as a read. The node's own write still answers such a goal, as before.
#[test]
fn a_strangers_write_never_answers_a_goal_that_asks_no_change() {
    let read = route("r", "shop.example", "the posts", &[]);
    let mut own = route("w", "shop.example", "the posts", &[]);
    own.write = true;
    let mut theirs = route("t", "shop.example", "the posts", &[]);
    theirs.write = true;
    theirs.fetched = Some(store::Fetched { entry_id: "0x01".into(), route_id: "route-posts".into(), agent_id: "7".into(), content_id: format!("sha256:{}", "ab".repeat(32)), listed_as: "the posts".into(), fetched_at: 1 });
    for goal in ["the posts on my page", "list the posts"] {
        let kept: Vec<&str> = reads_only(vec![&read, &own, &theirs], goal).iter().map(|r| r.id.as_str()).collect();
        assert!(!kept.contains(&"t"), "{goal}: a stranger's write kept for a goal that asks no change: {kept:?}");
        assert!(!unbrowse_learn::goal::asks_a_change(goal), "{goal}: the call path holds it to reads only");
    }
    assert_eq!(reads_only(vec![&read, &own, &theirs], "the posts on my page").len(), 2, "the node's own write still answers a goal that names no read");
    assert_eq!(reads_only(vec![&read, &own, &theirs], "post to the posts").len(), 3, "a goal that asks for a change keeps them all");
}

#[test]
fn a_value_in_the_pages_path_is_the_input_its_route_reads_there() {
    let mut r = route("a", "shop.example", "list a category's newest items", &["c"]);
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/c/{path[1]}/new/", "fields": [
            { "loc": { "in": "path", "key": 0 }, "class": "constant", "value": "c", "origin": null },
            { "loc": { "in": "path", "key": 1 }, "class": "input", "name": "c", "secret": false, "default": "shoes" },
            { "loc": { "in": "path", "key": 2 }, "class": "constant", "value": "new", "origin": null }
        ], "needs_browser": false, "sets_cookie": false },
        { "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/more?name={name}", "fields": [
            { "loc": { "in": "query", "key": "name" }, "class": "input", "name": "c", "secret": false, "default": "shoes" }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    let got = |url: &str| inputs_for(&r, url, HashMap::new());
    assert_eq!(got("https://shop.example/c/hats/new/"), HashMap::from([("c".to_string(), "hats".to_string())]));
    assert_eq!(got("https://shop.example/c/red%20hats/new"), HashMap::from([("c".to_string(), "red hats".to_string())]));
    // A path of another shape, or another host, says nothing; the agent's own value wins.
    assert!(got("https://shop.example/c/hats/top/").is_empty());
    assert!(got("https://other.example/c/hats/new/").is_empty());
    let mine = inputs_for(&r, "https://shop.example/c/hats/new/", HashMap::from([("c".to_string(), "socks".to_string())]));
    assert_eq!(mine["c"], "socks");
}

#[test]
fn a_route_holding_another_pages_item_never_answers_for_this_one() {
    let mut held = route("a", "shop.example", "read an item's reviews", &[]);
    held.root = "https://shop.example/item/a1b2c3/red-runner/".into();
    held.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/item/a1b2c3/red-runner/", "fields": [],
          "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    assert!(fits(&held, "https://shop.example/item/a1b2c3/red-runner/"));
    assert!(fits(&held, "https://shop.example/item/a1b2c3/red-runner"));
    assert!(!fits(&held, "https://shop.example/item/z9y8x7/wool-cap/"));
    // Taking the item and its name as inputs, it does any item's page.
    let mut taken = held.clone();
    taken.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/item/{path[1]}/{path[2]}/", "fields": [
            { "loc": { "in": "path", "key": 0 }, "class": "constant", "value": "item", "origin": null },
            { "loc": { "in": "path", "key": 1 }, "class": "input", "name": "item", "secret": false, "default": "a1b2c3" },
            { "loc": { "in": "path", "key": 2 }, "class": "input", "name": "part2", "secret": false, "default": "red-runner" }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    assert!(fits(&taken, "https://shop.example/item/z9y8x7/wool-cap/"));
    assert!(fits(&taken, &held.root));
    // A piece filled from an earlier answer is the page's own: another value there is another page.
    let mut derived = taken.clone();
    derived.root = "https://shop.example/shoes/item/a1b2c3/red-runner/".into();
    derived.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/{path[0]}/item/{path[2]}/{path[3]}/", "fields": [
            { "loc": { "in": "path", "key": 0 }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/", "at": { "from": "json", "pointer": "/c" } } },
            { "loc": { "in": "path", "key": 2 }, "class": "input", "name": "item", "secret": false, "default": "a1b2c3" },
            { "loc": { "in": "path", "key": 3 }, "class": "input", "name": "part3", "secret": false, "default": "red-runner" }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    assert!(fits(&derived, "https://shop.example/shoes/item/z9y8x7/wool-cap/"));
    assert!(!fits(&derived, "https://shop.example/hats/item/z9y8x7/wool-cap/"));
    // A route on an API host, learned from a page, does that page's address with any query.
    let mut api = route("b", "api.search.example", "search stories", &["q"]);
    api.root = "https://news.example/?q=rust".into();
    assert!(fits(&api, "https://news.example/?q=zig"));
    assert!(!fits(&api, "https://news.example/item/42"));
}

#[test]
fn a_route_does_a_goal_that_says_its_words() {
    let routes = [route("a", "hn.algolia.com", "Search HN stories", &["q"]), route("b", "news.example", "search news stories", &[])];
    let ids = |goal: &str, url: &str| routes_for(&routes, goal, url).iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids("search hn stories", ""), ["a"]);
    assert_eq!(ids("stories, HN: search", ""), ["a"]);
    // Sharing words isn't doing it: no guess.
    assert!(ids("search stories", "").is_empty());
    assert!(ids("search HN stories and comments", "").is_empty());
    assert!(ids("", "").is_empty());
    // A url keeps it to that site.
    assert_eq!(ids("search hn stories", "https://hn.algolia.com/?q=rust"), ["a"]);
    assert!(ids("search hn stories", "https://news.example/").is_empty());
}

#[test]
fn a_route_is_found_again_from_the_page_it_was_learned_on() {
    // The page is on one site and answers from an API on another.
    let mut r = route("a", "search-dsn.api.example", "search stories", &["q"]);
    r.root = "https://news.example/?q=rust".into();
    let routes = [r];
    let ids = |url: &str| routes_for(&routes, "search stories", url).iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids("https://news.example/?q=zig"), ["a"]);
    assert_eq!(ids("https://api.example/"), ["a"]);
    assert!(ids("https://other.example/").is_empty());
}

fn listed(id: &str, domain: &str, description: &str) -> network::NetworkRoute {
    network::NetworkRoute { entry_id: id.into(), domain: domain.into(), description: description.into(), contributor: "0xc".into(), fee: 1.0 }
}

fn found(v: &Value) -> Vec<(String, bool)> {
    v["routes"].as_array().unwrap().iter().map(|r| (r["id"].as_str().unwrap().to_string(), r["remote"] == true)).collect()
}

#[test]
fn a_weak_local_match_never_hides_a_strong_network_route() {
    let local = vec![route("news", "news.example", "search news stories", &["q"])];
    let remote = vec![listed("0xf", "flights.example", "search flights by date"), listed("0xh", "hotels.example", "list hotels")];
    let got = merged("search flights", local.clone(), remote, &Ranking::default());
    let ids: Vec<_> = got.iter().map(|r| (r["id"].as_str().unwrap(), r["remote"] == true)).collect();
    // The network route holding the rarer word comes first, this node's own still answers after it, and one holding
    // none of the words is left out.
    assert_eq!(ids, [("0xf", true), ("news", false)]);
    // A network route that scores no better than this node's own goes behind it.
    let got = merged("news stories", local, vec![listed("0xn", "news.example", "search news stories")], &Ranking::default());
    assert_eq!(got.iter().map(|r| r["id"].as_str().unwrap()).collect::<Vec<_>>(), ["news", "0xn"]);
}

#[test]
fn a_route_is_found_by_the_fields_its_answer_holds() {
    let mut r = route("hn", "hn.algolia.com", "search HN stories", &["q"]);
    r.graph.steps.push(
        serde_json::from_value(json!({ "exchange": 0, "method": "GET", "status": 200, "url": "https://hn.algolia.com/api/v1/search?query={q}",
            "fields": [], "needs_browser": false, "response_shape": { "hits": [{ "title": "string", "points": "number" }] } }))
        .unwrap(),
    );
    let ids = |q: &str| merged(q, vec![r.clone(), route("other", "news.example", "list news", &[])], vec![], &Ranking::default()).iter().map(|v| v["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids("story points"), ["hn"]);
    assert!(ids("comments").is_empty());
}

#[test]
fn a_routes_entries_reach_an_agent_default_first_and_tagged() {
    use alloy::primitives::{Address, B256, U256};
    let id = |n: u64| B256::from(U256::from(n));
    let (cheap, best, fresh) = (id(1), id(2), id(3));
    let who = |n: u64| Address::from_word(id(n));
    let h = rank::reputation::history_with_default("shop.example", "search items", &[(cheap, who(1)), (best, who(2)), (fresh, who(3))], best);
    let ranking = Ranking { standings: rank::reputation::standings(&h, 12, &rank::reputation::NoProofYet), off: [fresh].into() };
    let entry = |e: B256, fee: f64| network::NetworkRoute { entry_id: format!("{e:#x}"), domain: "shop.example".into(), description: "search items".into(), contributor: "0xc".into(), fee };
    // The cheapest comes first by fee and words alike; the default takes the route's first place anyway.
    let got = merged("search items", vec![], vec![entry(cheap, 0.001), entry(fresh, 0.002), entry(best, 0.01)], &ranking);
    let ids: Vec<String> = got.iter().map(|v| v["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids, [format!("{best:#x}"), format!("{cheap:#x}"), format!("{fresh:#x}")], "every live entry, the default first");
    assert_eq!(got[0]["reputation"]["default"], true);
    assert_eq!(got[0]["reputation"]["unverified"], false);
    assert_eq!(got[0]["reputation"]["counted_uses"], 240);
    assert_eq!(got[1]["reputation"]["unverified"], true, "an entry under the floor is tagged unverified");
    assert_eq!(got[2]["reputation"]["unavailable"], true, "an entry off the ranking is shown as unavailable");
    assert_eq!(got[0]["reputation"]["version"], rank::reputation::VERSION);
    // The version of `rank.score`, which a pick follows, beside the pass rate's (R5.20).
    assert_eq!(got[0]["reputation"]["rank_version"], rank::coin::VERSION);
    assert!(got.iter().all(|r| r["reputation"]["rank_version"] == rank::coin::VERSION), "on every network route");
    // An entry the chain doesn't show yet is unverified, never the default.
    let unknown = network_route_json(&entry(id(9), 0.01), &ranking);
    assert_eq!((unknown["reputation"]["default"].as_bool(), unknown["reputation"]["unverified"].as_bool()), (Some(false), Some(true)));
}

#[tokio::test]
async fn a_slow_network_leaves_the_local_routes() {
    let local = vec![route("news", "news.example", "search news stories", &["q"])];
    let never = std::future::pending::<(Vec<network::NetworkRoute>, Option<bool>, Ranking)>();
    let got = with_network("search stories", local.clone(), never, std::time::Duration::from_millis(20)).await;
    assert_eq!(found(&got), [("news".to_string(), false)]);
    assert!(got.get("checked").is_none());
    // One that answers in time is ranked in, and says whether it was checked.
    let answered = async { (vec![listed("0xs", "stories.example", "search stories")], Some(true), Ranking::default()) };
    let got = with_network("search stories", local, answered, std::time::Duration::from_secs(1)).await;
    assert_eq!(found(&got), [("0xs".to_string(), true), ("news".to_string(), false)]);
    assert_eq!(got["checked"], true);
}

/// A route learned for a goal takes the place of older ones for it, but never one listed on the chain or one of
/// the owner's own.
#[test]
fn an_agents_learn_never_retires_a_listed_or_the_owners_own_route() {
    let mut listed = route("listed", "shop.example", "list items", &[]);
    listed.listing = Some(store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: false });
    let mut mine = route("mine", "shop.example", "list items", &[]);
    mine.yours = true;
    let plain = route("plain", "shop.example", "list items", &[]);
    // An agent's word on a route (its fields, its name) is never thrown away by a learn either.
    let mut judged = route("judged", "shop.example", "list items", &[]);
    judged.judged.fields = true;
    // Nor a page an agent said it doesn't do: retired, the verdict would go with it and the page learn it back.
    let mut wrong = route("wrong", "shop.example", "list items", &[]);
    wrong.judged.wrong.push(store::WrongPage { page: "https://shop.example".into(), why: "empty".into(), by: "agent".into(), at: 1 });
    let opening = route("opening", "shop.example", "list items", &[]);
    let routes = [listed, mine, plain, judged, wrong, opening];
    let new = route("new", "shop.example", "list items", &[]);
    let gone: Vec<_> = superseded(&routes, "list items", "https://shop.example/", &new, &["opening".into()]).iter().map(|r| r.id.clone()).collect();
    assert_eq!(gone, ["plain"]);
}

/// A route is kept under its call's name, and a learn working behind an answer may write another body under that
/// name. A goal that chose a route as a read never runs it once it changes the site: the record is read again when
/// the call runs, and one that became a write since is refused there, with nothing sent.
#[test]
fn a_route_chosen_as_a_read_is_not_run_once_it_writes() {
    let home = store::scratch_home("chosen-read-now-writes");
    let (rt, node, agent) = agent_node(&home);
    let (port, _) = hearing_site(json!({ "title": "a case" }).to_string());
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    let mut r = route("swapped", "127.0.0.1", "Read a case", &["q"]);
    r.root = format!("http://127.0.0.1:{port}/cases");
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [step_of("GET", &format!("http://127.0.0.1:{port}/cases?q={{q}}"), json!([
        { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" },
    ]))] }))
    .unwrap();
    store::save_route(&r).unwrap();
    let call = |seen: Option<bool>| {
        let (at, agent) = (node.clone(), agent.clone());
        rt.block_on(async move { super::call::do_call_as_seen(&at, &agent, "swapped".into(), HashMap::from([("q".to_string(), "lamps".to_string())]), Vec::new(), seen).await })
    };
    assert!(call(Some(false)).is_ok_and(|v| v.to_string().contains("a case")), "a read chosen as a read runs");
    // The record under the same name now changes the site: its call is one that writes.
    r.write = true;
    r.method = "POST".into();
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [step_of("POST", &format!("http://127.0.0.1:{port}/cases/remove?q={{q}}"), json!([
        { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" },
    ]))] }))
    .unwrap();
    store::save_route(&r).unwrap();
    assert!(store::load_route("swapped").is_some_and(|kept| kept.write), "the record is kept as a write");
    let refused = call(Some(false)).unwrap_err();
    assert_eq!(refused.0, StatusCode::CONFLICT, "{refused:?}");
    assert!(refused.1.contains("Nothing was sent"), "{refused:?}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A learn lands on the record already under its call, so the route its second look would drop for another call may
/// be one listed on the chain, the owner's own, or one an agent judged: the learner's drop (`store::drop_learned`)
/// leaves each of those where it is, and takes only a route nothing stands on.
#[test]
fn a_learners_second_look_never_drops_a_route_that_stands() {
    let home = store::scratch_home("second-look-gives-way");
    store::use_home(&home);
    let mut listed = route("listed-way", "shop.example", "list items", &[]);
    listed.listing = Some(store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: true });
    let mut mine = route("mine-way", "shop.example", "list items", &[]);
    mine.yours = true;
    let mut judged = route("judged-way", "shop.example", "list items", &[]);
    judged.judged.fields = true;
    let plain = route("plain-way", "shop.example", "list items", &[]);
    for r in [&listed, &mine, &judged, &plain] {
        store::save_route(r).unwrap();
    }
    for id in ["listed-way", "mine-way", "judged-way"] {
        assert_eq!(store::drop_learned(id), Ok(false), "{id} stands");
        assert!(store::load_route(id).is_some(), "{id} is still kept");
    }
    assert_eq!(store::drop_learned("plain-way"), Ok(true));
    assert!(store::load_route("plain-way").is_none());
    assert_eq!(store::drop_learned("never-kept"), Ok(false));
    let _ = std::fs::remove_dir_all(&home);
}

/// A learn lands on the record already under its call. When a read goal then turns out to have found a write, the
/// record goes only if nothing stands on it: a verdict that the call changes the site outlives the read that found it,
/// or the next learn of the call would read it as harmless and a read goal could run it.
#[test]
fn a_read_goal_that_finds_a_judged_write_leaves_the_verdict() {
    use std::io::{BufRead, Write};
    let home = store::scratch_home("read-found-a-write");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    store::use_home(&home);
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in site.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let body = r#"{"queued":true,"items":[{"id":1,"name":"desk lamp"}]}"#;
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    let url = format!("http://127.0.0.1:{port}/api/queue");
    let crate::learn::Plain::Route(learned) = crate::learn::learn_plain(&url, "get the queue", "You") else { panic!("a JSON url is its own route") };
    // An agent saw that calling it changes the site.
    store::update_route(&learned.id, |r| r.judged.writes = true).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
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
    let body = DoBody { goal: "read the waiting list".into(), url, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!(r["how"], "browse", "a read is never answered by a write: {r}");
    let kept = store::load_route(&learned.id).expect("the record stands");
    assert!(kept.judged.writes && kept.write, "and so does the verdict");
    let _ = std::fs::remove_dir_all(&home);
}

/// A learn's first reply is the walk's answer; the route's own first call runs behind it. A first call that didn't
/// answer on its own is written where the next ask of the page reads it: the route is judged wrong for that page and
/// is not served warm for it (the page is walked again); one that answered leaves the route as it stands. Another
/// page of the same route is not judged by it.
#[test]
fn a_first_call_behind_the_reply_that_didnt_answer_keeps_the_route_from_serving_the_page_warm() {
    let home = store::scratch_home("first-call-behind");
    store::use_home(&home);
    store::save_route(&route("learned", "shop.example", "list items", &[])).unwrap();
    let page = "https://shop.example/search?q=lamp";
    goal::first_call_judged("learned", page, None);
    assert!(store::load_route("learned").unwrap().wrong_for(page).is_none(), "answered on its own: stands");
    goal::first_call_judged("learned", page, Some("the site answered 403"));
    let judged = store::load_route("learned").unwrap();
    let wrong = judged.wrong_for(page).expect("judged wrong for the page");
    assert!(wrong.why.contains("first call didn't answer on its own") && wrong.why.contains("403"), "{}", wrong.why);
    assert!(judged.wrong_for("https://shop.example/").is_none(), "another page is not judged by it");
    assert_eq!(super::goal::BY_THE_WALK, "the browser, for this value", "said as a confirming browse's reply says it");
    // The walk's answer stands in for the call of a route that writes nothing, whatever the goal's words: the run that
    // exposed it asked for "stories on the front page", no read word in it, and its reply waited for the call.
    let mut front = route("front", "news.example", "stories on the front page", &[]);
    assert!(!unbrowse_learn::goal::only_reads(&front.what), "the goal names no read word");
    assert!(goal::takes_the_walks_answer(&front), "its call writes nothing");
    front.write = true;
    assert!(!goal::takes_the_walks_answer(&front), "a call that writes is made");
    let _ = std::fs::remove_dir_all(&home);
}

/// A verdict the node refuses changes nothing: a retired route stays retired, out of what `unbrowse_do` finds.
#[test]
fn a_refused_verdict_leaves_a_retired_route_retired() {
    let home = store::scratch_home("refused-verdict");
    store::use_home(&home);
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    store::save_route(&route("aside", "shop.example", "list items", &[])).unwrap();
    assert!(store::retire_route("aside").unwrap());
    let (status, _) = judge::do_judge(&a, &json!({ "route_id": "aside", "verdict": "wrong" })).unwrap_err();
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(store::load_route("aside").is_none(), "a refusal brought it back live");
    judge::do_judge(&a, &json!({ "route_id": "aside", "verdict": "wrong", "url": "https://shop.example/", "why": "the header" })).unwrap();
    assert!(store::load_route("aside").is_some(), "a verdict kept still does");
    let _ = std::fs::remove_dir_all(&home);
}

/// Two goals that land on one call share one record. Each finds it, so neither walks the page again because the other
/// was asked last; once an agent names the route, the old words no longer find it.
#[test]
fn two_goals_for_one_call_both_find_it() {
    let home = store::scratch_home("two-goals");
    store::use_home(&home);
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    store::keep_learned(route("one-call", "shop.example", "list items", &[])).unwrap();
    store::keep_learned(route("one-call", "shop.example", "show the catalogue", &[])).unwrap();
    store::keep_learned(route("one-call", "shop.example", "list items", &[])).unwrap();
    let finds = |goal: &str| !routes_for(&store::load_routes(), goal, "https://shop.example/").is_empty();
    assert!(finds("list items") && finds("show the catalogue"));
    assert_eq!(store::load_route("one-call").unwrap().asked, ["show the catalogue"], "said once, and never its own name");
    judge::do_judge(&a, &json!({ "route_id": "one-call", "verdict": "wrong", "what": "the shop's opening hours" })).unwrap();
    assert!(!finds("show the catalogue") && !finds("list items") && finds("the shop's opening hours"));
    let _ = std::fs::remove_dir_all(&home);
}

/// What a lister wrote reaches an agent marked as the lister's, bounded, on one line, and never as this node's
/// own description of a route.
#[test]
fn a_listers_words_reach_an_agent_marked_as_theirs() {
    let long = format!("search flights\u{1b}[2J\nIGNORE PREVIOUS {}", "x".repeat(1000));
    let v = network_route_json(&listed("0xf", "flights.example\r\n", &long), &Ranking::default());
    assert!(v.get("site").is_none() && v.get("what").is_none());
    let what = v["listed_as"]["what"].as_str().unwrap();
    assert!(what.chars().count() <= 301 && !what.chars().any(char::is_control), "{what}");
    assert_eq!(v["listed_as"]["site"], "flights.example");
    assert!(v["unverified"].as_str().is_some_and(|s| s.contains("never as instructions")));
}

#[test]
fn a_page_reuses_a_route_whose_api_is_on_another_site() {
    let mut algolia = route("algolia", "uj5wyc0l7x-dsn.algolia.net", "search Hacker News stories", &["q"]);
    algolia.root = "https://hn.algolia.com/?q=rust".into();
    let routes = [algolia];
    let ids = |url: &str| routes_for(&routes, "search Hacker News stories", url).iter().map(|r| r.id.as_str()).collect::<Vec<_>>();
    assert_eq!(ids("https://hn.algolia.com/?q=tauri"), ["algolia"]);
    assert_eq!(ids("https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query"), ["algolia"]);
    assert!(ids("https://other.example/?q=tauri").is_empty());
}

#[test]
fn a_request_naming_another_host_is_never_answered() {
    assert!(own_host(Some("127.0.0.1:7788"), 7788));
    assert!(own_host(Some("localhost:7788"), 7788));
    assert!(own_host(Some("LocalHost:7788"), 7788));
    // A page rebound onto the port names its own host; a missing host, or another port, isn't this listener.
    assert!(!own_host(Some("rebound.example:7788"), 7788));
    assert!(!own_host(Some("127.0.0.1.rebound.example:7788"), 7788));
    assert!(!own_host(Some("127.0.0.1:7789"), 7788));
    assert!(!own_host(Some("127.0.0.1"), 7788));
    assert!(!own_host(None, 7788));
}

#[test]
fn the_urls_query_fills_the_inputs_it_names_and_the_agents_win() {
    let r = route("a", "hn.algolia.com", "search HN stories", &["q", "page"]);
    let got = inputs_for(&r, "https://hn.algolia.com/?q=rust&utm=x", HashMap::new());
    assert_eq!(got, HashMap::from([("q".to_string(), "rust".to_string())]));
    let got = inputs_for(&r, "https://hn.algolia.com/?q=rust", HashMap::from([("q".to_string(), "zig".to_string())]));
    assert_eq!(got["q"], "zig");
    assert!(inputs_for(&r, "", HashMap::new()).is_empty());
}

/// One exchange of a walk, as the capture records it: the walked page itself when `page`, else a call it made.
fn walked(method: &str, url: &str, body: Option<&str>, answer: &str, page: bool) -> unbrowse_learn::Exchange {
    unbrowse_learn::Exchange {
        method: method.into(),
        url: url.parse().unwrap(),
        request_headers: body.map(|_| ("content-type".to_string(), "application/json".to_string())).into_iter().collect(),
        request_body: body.map(String::from),
        status: 200,
        response_headers: vec![],
        response_body: Some(answer.into()),
        response_mime: "application/json".into(),
        resource_type: Some(if page { "Document" } else { "Fetch" }.into()),
        main_frame: Some(true),
    }
}

/// The route the learner keeps from a walk of `page` whose call `target` answered: the page's query and the path
/// pieces the walk shows are the caller's become inputs, as `pick_and_keep` makes them.
fn learned_from(page: &str, exchanges: Vec<unbrowse_learn::Exchange>, target: &str) -> store::Route {
    let mut trace = unbrowse_learn::Trace { exchanges, inputs: Vec::new() };
    let (in_path, _) = learn::path_inputs(page, "the goal", &trace);
    trace.inputs = learn::walk_inputs(page, &in_path, &trace.exchanges);
    let graph = unbrowse_learn::build(&[trace], |e| e.url.as_str() == target).unwrap();
    store::Route::from_graph("r".into(), "the goal".into(), page.into(), graph).unwrap()
}

/// A site that writes its search into its address the way a form does (`/maps/search/coffee+shops/`), and asks its own
/// call for it with spaces (`q=coffee shops`): the route takes the search as an input, and another search's page
/// (`/maps/search/ramen+tokyo/`) is the same route asked for "ramen tokyo", never a page learned again.
#[test]
fn a_search_written_with_pluses_in_the_path_is_one_route_for_every_search() {
    let page = "https://www.maps.example/maps/search/coffee+shops/";
    let answer = json!({ "places": [{ "name": "Kopi Bar", "rating": 4.5 }, { "name": "Bean There", "rating": 4.2 }] }).to_string();
    let target = "https://www.maps.example/search?tbm=map&q=coffee+shops";
    let r = learned_from(page, vec![walked("GET", page, None, "<html><body>coffee shops</body></html>", true), walked("GET", target, None, &answer, false)], target);
    assert_eq!(r.inputs.iter().map(|i| (i.name.as_str(), i.default.as_deref())).collect::<Vec<_>>(), [("search", Some("coffee shops"))]);
    let other = "https://www.maps.example/maps/search/ramen+tokyo/";
    assert!(fits(&r, other));
    assert_eq!(inputs_for(&r, other, HashMap::new()).get("search").map(String::as_str), Some("ramen tokyo"));
}

/// A stored route answers a url only where the url's page is the route's own page, or its own call's address,
/// differing just where the route takes an input: whatever the hosts. From the walks that exposed it: a route
/// learned on api.github.com/repos/firecrawl/firecrawl with no inputs answered github.com/superdesigndev/treg
/// with firecrawl's repository, because the page's host differed from the route's.
#[test]
fn a_stored_route_never_answers_a_page_that_differs_where_it_takes_no_input() {
    let mut held = route("gh", "api.github.com", "get GitHub repository details", &[]);
    held.root = "https://api.github.com/repos/firecrawl/firecrawl".into();
    held.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://api.github.com/repos/firecrawl/firecrawl", "fields": [
            { "loc": { "in": "path", "key": 0 }, "class": "constant", "value": "repos", "origin": null },
            { "loc": { "in": "path", "key": 1 }, "class": "constant", "value": "firecrawl", "origin": null },
            { "loc": { "in": "path", "key": 2 }, "class": "constant", "value": "firecrawl", "origin": null }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    assert!(fits(&held, "https://api.github.com/repos/firecrawl/firecrawl"), "its own page");
    assert!(!fits(&held, "https://api.github.com/repos/superdesigndev/treg"), "another repo on the call's host");
    assert!(!fits(&held, "https://github.com/superdesigndev/treg"), "another repo's page on another host");
    assert!(!fits(&held, "https://github.com/firecrawl/firecrawl"), "another host's page is another page");
    // Learned on a page whose call goes to another host, with the item fixed in the call: the same.
    let mut paged = held.clone();
    paged.root = "https://github.com/firecrawl/firecrawl".into();
    assert!(fits(&paged, "https://github.com/firecrawl/firecrawl"));
    assert!(!fits(&paged, "https://github.com/browser-use/browser-use"), "another repo's page");
    assert!(fits(&paged, "https://api.github.com/repos/firecrawl/firecrawl"), "its own call's address");
    // A call's fixed query value is the call's: another one asks for what it never fetches.
    let mut fixed = route("ff", "filfox.info", "get network power over time", &[]);
    fixed.root = "https://filfox.info/en/stats/miner".into();
    fixed.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://filfox.info/api/v1/stats/power?duration=30d&samples=30", "fields": [
            { "loc": { "in": "query", "key": "duration" }, "class": "constant", "value": "30d", "origin": null },
            { "loc": { "in": "query", "key": "samples" }, "class": "constant", "value": "30", "origin": null }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    assert!(fits(&fixed, "https://filfox.info/api/v1/stats/power?duration=30d&samples=30"));
    assert!(!fits(&fixed, "https://filfox.info/api/v1/stats/power?duration=1y&samples=30"));
    // A query key the route never sends asks for what it can't say; one it takes is any value.
    let mut hn = route("hn", "hn.algolia.com", "search Hacker News stories", &["query", "tags"]);
    hn.root = "https://hn.algolia.com/api/v1/search?query=monid&tags=story".into();
    assert!(fits(&hn, "https://hn.algolia.com/api/v1/search?query=apify&tags=story"));
    assert!(!fits(&hn, "https://hn.algolia.com/api/v1/search?query=apify&tags=story&hitsPerPage=25"));
    assert!(!fits(&hn, "https://hn.algolia.com/?q=apify"), "the page is another page, with its own input");
}

/// The other side: a route whose call is on another host than its page still answers the call's own address,
/// reading the call's inputs from it, and a page whose item is an input answers any item.
#[test]
fn a_route_answers_its_own_calls_address_reading_the_inputs_it_takes() {
    let mut hn = route("hn", "uj5wyc0l7x-dsn.algolia.net", "search Hacker News stories", &["q"]);
    hn.root = "https://hn.algolia.com/?q=rust".into();
    hn.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query?query={query}&x-algolia-api-key={x-algolia-api-key}", "fields": [
            { "loc": { "in": "path", "key": 0 }, "class": "constant", "value": "1", "origin": null },
            { "loc": { "in": "path", "key": 1 }, "class": "constant", "value": "indexes", "origin": null },
            { "loc": { "in": "path", "key": 2 }, "class": "constant", "value": "Item_dev", "origin": null },
            { "loc": { "in": "path", "key": 3 }, "class": "constant", "value": "query", "origin": null },
            { "loc": { "in": "query", "key": "query" }, "class": "input", "name": "q", "secret": false, "default": "rust" },
            { "loc": { "in": "query", "key": "x-algolia-api-key" }, "class": "minted", "name": "x-algolia-api-key" }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    let call = "https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query?query=zig&x-algolia-api-key=k";
    assert!(fits(&hn, call));
    assert_eq!(inputs_for(&hn, call, HashMap::new()), HashMap::from([("q".to_string(), "zig".to_string())]));
    assert!(fits(&hn, "https://hn.algolia.com/?q=zig"));
    assert!(!fits(&hn, "https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Comment_dev/query?query=zig"), "another index is another call");
}

/// The page's own values that its call carries are the route's inputs, so one route serves every item: learned
/// from the walk of one repository (or package), it answers another's address with that one's call. From the
/// walks that left five near-duplicate routes, each fixed to one repository, and package routes fixed to one name.
#[test]
fn values_of_the_page_its_call_carries_are_learned_as_inputs() {
    if std::env::var("TYPESAFE_API_KEY").is_ok() {
        return;
    }
    let page = "https://api.github.com/repos/firecrawl/firecrawl";
    let answer = r#"{"id":787076358,"name":"firecrawl","full_name":"firecrawl/firecrawl","owner":{"login":"firecrawl","type":"Organization"},"stargazers_count":41000,"url":"https://api.github.com/repos/firecrawl/firecrawl"}"#;
    let gh = learned_from(page, vec![walked("GET", page, None, answer, true)], page);
    assert_eq!(gh.inputs.len(), 2, "owner and name, never the route word: {:?}", gh.inputs);
    let other = "https://api.github.com/repos/superdesigndev/treg";
    assert!(fits(&gh, other));
    let got = inputs_for(&gh, other, HashMap::new());
    let mut values: Vec<&str> = got.values().map(String::as_str).collect();
    values.sort();
    assert_eq!(values, ["superdesigndev", "treg"]);
    assert!(!fits(&gh, "https://api.github.com/orgs/superdesigndev/treg"), "a route word is still the route's");

    let page = "https://pypistats.org/api/packages/tools-registry/recent";
    let answer = r#"{"data":{"last_day":12,"last_month":3410,"last_week":702},"package":"tools-registry","type":"recent_downloads"}"#;
    let py = learned_from(page, vec![walked("GET", page, None, answer, true)], page);
    let other = "https://pypistats.org/api/packages/arcade-mcp/recent";
    assert!(fits(&py, other));
    assert_eq!(inputs_for(&py, other, HashMap::new()).values().cloned().collect::<Vec<_>>(), ["arcade-mcp"]);
    assert!(!fits(&py, "https://pypistats.org/api/packages/arcade-mcp/overall"), "a route word is still the route's");

    let page = "https://api.npmjs.org/downloads/range/2023-01-01:2024-06-30/@mendable/firecrawl-js";
    let answer = r#"{"start":"2023-01-01","end":"2024-06-30","package":"@mendable/firecrawl-js","downloads":[{"downloads":3,"day":"2023-01-01"}]}"#;
    let npm = learned_from(page, vec![walked("GET", page, None, answer, true)], page);
    let other = "https://api.npmjs.org/downloads/range/2025-01-01:2025-06-30/@arcadeai/arcadejs";
    assert!(fits(&npm, other), "{:?}", npm.inputs);
    let mut values: Vec<String> = inputs_for(&npm, other, HashMap::new()).into_values().collect();
    values.sort();
    assert_eq!(values, ["2025-01-01:2025-06-30", "@arcadeai", "arcadejs"]);
}

/// An input binds by its name to its own slot: learned from `?limit=25&offset=25`, the call's offset is the
/// `offset` input, so a page asking for offset 48 gets offset 48 and not the limit.
#[test]
fn inputs_bind_by_name_to_their_own_slot() {
    let page = "https://api.apify.com/v2/store?limit=25&offset=25&sortBy=popularity";
    let answer = r#"{"data":{"total":5000,"offset":25,"limit":25,"items":[{"name":"web-scraper","title":"Web Scraper"}]}}"#;
    let r = learned_from(page, vec![walked("GET", page, None, answer, true)], page);
    let offset = r.graph.steps[0].fields.iter().find(|f| f.loc == unbrowse_learn::Loc::Query("offset".into())).unwrap();
    assert!(matches!(&offset.class, unbrowse_learn::Class::Input { name, .. } if name == "offset"), "{:?}", offset.class);
    let got = inputs_for(&r, "https://api.apify.com/v2/store?limit=20&offset=48&sortBy=popularity", HashMap::new());
    assert_eq!((got["limit"].as_str(), got["offset"].as_str()), ("20", "48"));
}

/// An input the route doesn't take is never dropped without a word: one a call of the route sends under that name
/// is that input, and any other comes back as ignored.
#[test]
fn an_input_the_route_does_not_take_is_said_never_silently_dropped() {
    let mut hn = route("hn", "hn.algolia.com", "search Hacker News stories", &["q"]);
    hn.graph = serde_json::from_value(json!({ "provisional": false, "steps": [
        { "exchange": 0, "method": "GET", "status": 200, "url": "https://hn.algolia.com/api/v1/search?query={query}", "fields": [
            { "loc": { "in": "query", "key": "query" }, "class": "input", "name": "q", "secret": false, "default": "monid" }
        ], "needs_browser": false, "sets_cookie": false }
    ]}))
    .unwrap();
    let given = HashMap::from([("query".to_string(), "browser-use".to_string()), ("hitsPerPage".to_string(), "50".to_string())]);
    let (bound, ignored) = bind_inputs(&hn, given);
    assert_eq!(bound["q"], "browser-use", "sent as ?query=, so query is q");
    assert_eq!(ignored, ["hitsPerPage"]);
    // The route's own name wins over one its call sends.
    let (bound, ignored) = bind_inputs(&hn, HashMap::from([("q".to_string(), "zig".to_string()), ("query".to_string(), "rust".to_string())]));
    assert_eq!((bound["q"].as_str(), ignored), ("zig", vec!["query".to_string()]));
    // Without a url, the names the agent gives pick the routes that take them.
    let other = route("net", "algolia.net", "search Hacker News stories", &["filters"]);
    let found = takes_all(vec![&hn, &other], &HashMap::from([("query".to_string(), "rust".to_string())]));
    assert_eq!(found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["hn"]);
}

#[test]
fn concurrent_aliased_calls_keep_their_own_unprojected_answers() {
    let (_home, rt, node, headers) = node_with_a_token("answer-input-alias");
    let body = json!({ "items": [{"title": "desk lamp"}] });
    let empty = json!({ "items": [], "diagnostic": "d".repeat(10_000) });
    let page = |state: &Value| format!(r#"<html><body><main><a href="/desk">Desk</a></main><script type="application/json">{state}</script></body></html>"#);
    let port = crate::run::test_site(vec![
        ("/items", 200, "text/html", page(&body)),
        ("/empty", 200, "text/html", page(&empty)),
    ]);
    let route = |id: &str, path: &str| {
        let root = format!("http://127.0.0.1:{port}/{path}?query=table");
        let graph = serde_json::from_value(json!({ "provisional": true, "steps": [{
            "exchange": 0, "method": "GET", "status": 200,
            "url": format!("http://127.0.0.1:{port}/{path}?query={{query}}"),
            "fields": [{ "loc": { "in": "query", "key": "query" }, "class": "input", "name": "q", "secret": false, "default": "table" }],
            "response_shape": unbrowse_learn::graph::shape(&body),
            "needs_browser": false
        }] })).unwrap();
        let mut route = store::Route::from_graph(id.into(), "find items with links".into(), root, graph).unwrap();
        assert_eq!(route.inputs[0].name, "q");
        route.fields = vec!["items".into()];
        route.judged.fields = true;
        store::save_route(&route).unwrap();
        route
    };
    let given = HashMap::from([("query".to_string(), "lamp".to_string())]);
    let found = route("answer-input-alias", "items");
    let none = route("answer-empty-with-link", "empty");
    let call = |id, route: &store::Route| text_over_mcp(&rt, &node, &headers, id, "unbrowse_call",
        json!({ "route_id": route.id, "inputs": given, "fields": ["links"] })).1;
    let answer = call(1, &found);
    assert_eq!(answer["browser"], false, "{answer}");
    assert_eq!(answer["data"]["items"], body["items"]);
    assert_eq!(answer["data"]["links"][0]["url"], format!("http://127.0.0.1:{port}/desk"));
    let answer = call(2, &none);
    assert_eq!(answer["outcome"], "answered_empty", "{answer}");
    assert_eq!(answer["data"], json!({ "items": [] }));

    let caller = agent(&node, &headers).expect("the caller is authenticated");
    let (found, none) = rt.block_on(async {
        tokio::join!(
            call::do_call_with_whole(&node, &caller, found.id.clone(), given.clone()),
            call::do_call_with_whole(&node, &caller, none.id.clone(), given.clone())
        )
    });
    assert_eq!(found.unwrap().1.expect("the found call's whole answer").data, body);
    assert_eq!(none.unwrap().1.expect("the empty call's whole answer").data, empty);
}

#[test]
fn a_fixed_redirect_route_cannot_replay_a_new_search_value() {
    let fixed = route("old", "en.example", "search articles", &[]);
    let bound = route("new", "en.example", "search articles", &["search"]);
    let url = "https://en.example/w/index.php?search=moon";
    assert!(!route_can_reuse_for_url(&fixed, url));
    assert!(route_can_reuse_for_url(&bound, url));
}

/// An entry whose fee is over the owner's per-fetch maximum is never paid for, and the reason names both numbers;
/// one at or under it is paid. At 0 only a free entry is.
#[test]
fn an_entry_over_the_owners_maximum_is_never_paid() {
    let why = over_max(0.5, 0.05).expect("over the maximum");
    assert!(why.contains("costs $0.50") && why.contains("maximum of $0.05"), "{why}");
    assert_eq!(over_max(0.05, 0.05), None, "at the maximum it is paid");
    assert_eq!(over_max(0.01, 0.05), None, "under it too");
    assert_eq!(over_max(0.0, 0.0), None, "at 0 a free entry is still used");
    assert!(over_max(0.000001, 0.0).is_some(), "at 0 nothing that costs anything is");
    assert_eq!(Skipped::default().said(), None, "nothing passed over, nothing said");
    let skipped = Skipped { max: 0.05, entries: vec![("0xb".into(), 0.9), ("0xa".into(), 0.5)], ..Default::default() };
    let said = skipped.said().unwrap();
    let why = said["why"].as_str().unwrap();
    assert!(why.contains("2 routes") && why.contains("cheapest costs $0.50") && why.contains("maximum of $0.05"), "{why}");
    assert_eq!((said["max_fetch_usdc"].as_f64(), said["entries"][1]["entry_id"].as_str()), (Some(0.05), Some("0xa")));
}

/// A listing over the task's own budget for one fetch is passed over (R3.3), as one over the owner's per-fetch maximum
/// is. The budget only lowers the maximum, never raises it; below zero it is zero, and one that isn't a number is none.
/// The agent is told which limit the cheapest was over and who can raise it.
#[test]
fn a_listing_over_the_tasks_budget_is_skipped() {
    let why = over_budget(0.02, Some(0.01)).expect("over the budget");
    assert!(why.contains("costs $0.02") && why.contains("budget of $0.01"), "{why}");
    assert_eq!(over_budget(0.01, Some(0.01)), None, "at the budget it is paid");
    assert_eq!(over_budget(9.0, None), None, "no budget, no filter but the owner's maximum");
    assert!(over_budget(0.000001, Some(-1.0)).is_some() && over_budget(0.0, Some(-1.0)).is_none(), "below zero is zero: a free entry only");
    assert_eq!(over_budget(9.0, Some(f64::NAN)), None, "not a number is no budget");
    let s = Skipped { max: 0.05, budget: Some(0.01), ..Default::default() };
    assert!(s.over(0.02).is_some() && s.over(0.01).is_none(), "the lower of the two holds");
    let s = Skipped { max: 0.05, budget: Some(1.0), ..Default::default() };
    assert!(s.over(0.06).is_some_and(|w| w.contains("owner's maximum")), "a budget never raises the maximum");
    let s = Skipped { max: 0.05, budget: Some(0.01), entries: vec![("0xa".into(), 0.02)], ..Default::default() };
    let said = s.said().unwrap();
    let why = said["why"].as_str().unwrap();
    assert!(why.contains("over this task's budget of $0.01") && why.contains("larger budget"), "{why}");
    assert_eq!((said["budget_usdc"].as_f64(), said["max_fetch_usdc"].as_f64()), (Some(0.01), Some(0.05)));
    crate::apischema::check(&crate::apischema::r("NetworkSkipped"), &said, &crate::apischema::types()).unwrap();
    let without = Skipped { max: 0.05, entries: vec![("0xa".into(), 0.5)], ..Default::default() }.said().unwrap();
    assert!(without["why"].as_str().unwrap().contains("owner's maximum") && without["budget_usdc"].is_null());
    crate::apischema::check(&crate::apischema::r("NetworkSkipped"), &without, &crate::apischema::types()).unwrap();
    // The budget comes in the goal's body; an older body has none.
    let body: DoBody = serde_json::from_value(json!({ "goal": "search items", "budget_usdc": 0.01 })).unwrap();
    assert_eq!(body.budget_usdc, Some(0.01));
    let older: DoBody = serde_json::from_value(json!({ "goal": "search items" })).unwrap();
    assert_eq!(older.budget_usdc, None);
}

/// An older agent's word on what a call pays is read past: its request still parses, and no tool asks for it.
#[test]
fn an_older_agents_pay_fields_are_read_past() {
    let body: DoBody = serde_json::from_value(json!({ "goal": "search items", "url": "https://shop.example/?q=x", "pays_usd": 12.5, "pays": true })).unwrap();
    assert_eq!(body.goal, "search items");
    let tools = tools().to_string();
    assert!(!tools.contains("pays_usd") && !tools.contains("\"pays\""), "no tool takes what a call pays");
    assert!(!tools.contains("approval") && !tools.contains("threshold"), "no tool speaks of an approval");
}

/// A call never waits for the owner, whatever an older agent says it pays and however low the threshold its key
/// was made with: it runs at once. A network entry whose body the node fetched before runs from that copy and pays
/// nothing, even when the owner lets the node pay for no fetch.
#[test]
fn a_call_never_waits_for_the_owner_and_a_cached_body_pays_nothing() {
    use std::io::{BufRead, Write};
    let home = store::scratch_home("no-approval");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    // The site: one item for every search.
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in site.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let body = r#"{"items":[{"id":1,"name":"desk lamp"}]}"#;
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    let entry = format!("0x{}", "ab".repeat(32));
    let mut cached: store::Route = serde_json::from_value(json!({
        "id": "fetched-items", "site": "127.0.0.1", "what": "Search items", "method": "GET", "path": "/api/items",
        "root": format!("http://127.0.0.1:{port}/?q=lamps"), "inputs": [{ "name": "q", "secret": false, "default": "lamps" }],
        "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/api/items?q={{q}}"),
            "needs_browser": false, "response_shape": { "items": [{ "id": "number", "name": "string" }] },
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
    }))
    .unwrap();
    cached.fetched = Some(store::Fetched { entry_id: entry.clone(), route_id: "route-items".into(), agent_id: "7".into(), content_id: format!("sha256:{}", "cd".repeat(32)), listed_as: "search items".into(), fetched_at: 1 });
    // The site is plain HTTP on this machine, where no route of someone else's goes: the test runs it as its own.
    crate::share::run_as_own_in_tests(&format!("sha256:{}", "cd".repeat(32)));
    store::save_route(&cached).unwrap();
    store::save_settings(&store::Settings { max_fetch_usdc: 0.0, ..store::Settings::default() }).unwrap();

    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    // A key made when keys carried a threshold, at 0: every payment it named used to wait for the owner.
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let mut old = serde_json::to_value(vec![a.clone()]).unwrap();
    old[0]["approval_usd"] = json!(0.0);
    std::fs::write(home.join("agents.json"), old.to_string()).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
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
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    // An older agent's pays_usd and pays ride along and are read past.
    let said = json!({ "inputs": { "q": "desk lamps" }, "pays_usd": 50.0, "pays": true }).to_string();
    let call = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_call").unwrap();
    let path = HashMap::from([("id".to_string(), entry)]);
    let (status, Json(r)) = rt.block_on(async move {
        tokio::time::timeout(std::time::Duration::from_secs(30), answer_http(call, node, headers, path, HashMap::new(), said.as_bytes())).await.expect("the call never waits for the owner")
    });
    assert_eq!(status, StatusCode::OK, "{r}");
    crate::apischema::check(&(call.returns)(), &r, &crate::apischema::types()).unwrap_or_else(|e| panic!("the call answered {r}: {e}"));
    assert_eq!((r["ok"].clone(), r["data"]["items"][0]["name"].clone()), (json!(true), json!("desk lamp")), "{r}");
    assert_eq!((r["network"]["cached"].clone(), r["paid_unb"].clone()), (json!(true), Value::Null), "the copy pays nothing");
    assert!(!home.join("devnet").join("receipts").exists(), "no line was written");
}

/// The walk that exposed it: a shop that answers a search, from abroad, with a page to choose a country on. Read
/// back, the page says nothing of the search but its own address in its links, and it was handed over as the answer.
#[test]
fn a_pages_own_address_in_its_links_says_nothing_of_what_was_asked() {
    let url = "https://www.shop.example/site/searchpage.jsp?st=headphones";
    let given: HashMap<String, String> = [("st".to_string(), "headphones".to_string())].into();
    let chooser = json!({ "title": "Select your country", "text": "Choose a country.\nCanada\nUnited States", "links": [{ "text": "Canada", "url": "https://www.shop.example/site/searchpage.jsp?st=headphones#" }, { "text": "United States", "url": "https://www.shop.example/site/searchpage.jsp?st=headphones#" }] });
    assert!(goal::says_none_asked(&chooser, &given, url, "/site/searchpage.jsp?st={st}"));
    let results = json!({ "title": "headphones - Shop", "text": "Wireless Headphones\n$59", "links": [{ "text": "Wireless Headphones", "url": "https://www.shop.example/p/1" }] });
    assert!(!goal::says_none_asked(&results, &given, url, "/site/searchpage.jsp?st={st}"));
}

/// A route learned by typing takes its word from a box, not from the page's address, so an address says nothing of
/// what to put in it. The goal does: said again with another word where the learned goal spelled the route's own, it
/// names the input and its value. A goal that differs anywhere else, or says nothing in the word's place, names none.
#[test]
fn a_goal_said_with_another_value_fills_the_routes_slot() {
    let mut route = route("typed", "corp.example", "search corp.example for solar panels", &[]);
    route.root = "https://www.corp.example/en/searchresult?keyword=solar".into();
    route.inputs = vec![
        store::RouteInput { name: "part0".into(), secret: false, default: Some("en".into()), file: false, optional: false, options: Vec::new() },
        store::RouteInput { name: "b-search".into(), secret: false, default: Some("solar panels".into()), file: false, optional: false, options: Vec::new() },
    ];
    let routes = vec![route];
    let found = |goal: &str, url: &str| goal::said_with_another_value(&routes, goal, url).into_iter().next().map(|(r, n, v)| (r.id.clone(), n, v));
    let page = "https://www.corp.example/en/searchresult?keyword=watch&pageIndex=1";
    assert_eq!(found("Search corp.example for smart watch", page), Some((routes[0].id.clone(), "b-search".into(), "smart watch".into())));
    assert_eq!(found("search corp.example for watch", ""), Some((routes[0].id.clone(), "b-search".into(), "watch".into())));
    assert_eq!(found("search corp.example for", page), None, "nothing said in its place");
    assert_eq!(found("read corp.example news about watch", page), None, "another goal");
    assert_eq!(found("search corp.example for watch", "https://www.corp.example/en/newsroom"), None, "another page");
    assert_eq!(found("search corp.example for solar panels", page), None, "the same value is the same goal");
}

/// The ask that exposed it (Carousell, UNB-208 step 8): a route learned for a long goal, its typed word in the middle,
/// and a second ask on the same page in fewer words than the route's goal says around that word. The ask is not the
/// route's goal said with another value, and it is answered as any other ask: it never stops the node's work with a
/// panic ("slice index starts at 2 but ends at 0", "attempt to subtract with overflow").
#[test]
fn a_goal_shorter_than_the_words_around_a_routes_value_is_no_other_value() {
    let mut route = route("long", "shop.example", "List used iPhone 13 listings with title, price, URL, priced under S$400", &[]);
    route.root = "https://www.shop.example/search/iphone%2013?price_end=400".into();
    route.inputs = vec![store::RouteInput { name: "q".into(), secret: false, default: Some("iPhone 13".into()), file: false, optional: false, options: Vec::new() }];
    let routes = vec![route];
    let page = "https://www.shop.example/search/iphone%2013?price_end=400&sort_by=3";
    // Eight words follow the value: an ask of eight words, and one of six.
    for goal in ["one two three four five six seven eight", "first 5 listings: title and price"] {
        let found = std::panic::catch_unwind(|| goal::said_with_another_value(&routes, goal, page).len());
        assert_eq!(found.ok(), Some(0), "{goal:?}: no other value, and no panic");
    }
}

/// The walk that exposed it: a company's search page whose address named the word under a key the page never reads.
/// The page was kept, the site answered the same for a word nobody searches for, and the caller was told it was
/// learned. A route deaf to a word the goal spells does not do the goal; one deaf to a page number the goal never
/// says still may.
#[test]
fn a_route_deaf_to_the_word_the_goal_spells_is_not_learned() {
    let mut route = route("deafgoal", "corp.example", "search corp.example for solar", &[]);
    route.inputs = vec![
        store::RouteInput { name: "keyword".into(), secret: false, default: Some("solar".into()), file: false, optional: false, options: Vec::new() },
        store::RouteInput { name: "pageIndex".into(), secret: false, default: Some("1".into()), file: false, optional: false, options: Vec::new() },
    ];
    assert_eq!(goal::deaf_to_the_goal(&route, "search corp.example for solar"), None, "nothing was asked of the site yet");
    route.heard = store::Heard { probed: true, deaf: vec!["pageIndex".into()], ..Default::default() };
    assert_eq!(goal::deaf_to_the_goal(&route, "search corp.example for solar"), None);
    route.heard = store::Heard { probed: true, deaf: vec!["keyword".into(), "pageIndex".into()], ..Default::default() };
    assert_eq!(goal::deaf_to_the_goal(&route, "search corp.example for solar").as_deref(), Some("keyword"));
    assert_eq!(goal::deaf_to_the_goal(&route, "read the corp.example newsroom"), None, "a goal that never says the word");
}

/// A value that goes only to a page the answer takes nothing from can't change the answer. The caller hears so, as it
/// does for a name the route doesn't take; the route's own value, or one that reaches, says nothing.
#[test]
fn a_value_that_never_reaches_the_answer_is_said() {
    let mut route = route("deaf", "shop.example", "search shop", &[]);
    let input = |name: &str, default: &str| unbrowse_learn::Field { loc: unbrowse_learn::Loc::Query(name.into()), class: unbrowse_learn::Class::Input { name: name.into(), secret: false, default: Some(default.into()), optional: false } };
    let step = |exchange, fields: Vec<unbrowse_learn::Field>| unbrowse_learn::Step {
        page_signed: false,
        page_producers: Vec::new(),
        exchange, method: "GET".into(), status: 200, url: "https://shop.example/a".into(), fields, body: None, response_shape: None,
        needs_browser: false, sets_cookie: false, on_load: false, foreign: false, held: Vec::new(), fallbacks: Vec::new(), reads_page: false,
    };
    route.graph = unbrowse_learn::Graph { steps: vec![step(0, vec![input("q", "lamp")]), step(1, vec![input("page", "1")])], provisional: false, page_origin: None, ..unbrowse_learn::Graph::default() };
    route.inputs = vec![
        store::RouteInput { name: "q".into(), secret: false, default: Some("lamp".into()), file: false, optional: false, options: Vec::new() },
        store::RouteInput { name: "page".into(), secret: false, default: Some("1".into()), file: false, optional: false, options: Vec::new() },
    ];
    let given = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>();
    assert_eq!(unreached(&route, &given(&[("q", "chair"), ("page", "2")])), ["q"]);
    assert!(unreached(&route, &given(&[("q", "lamp")])).is_empty(), "the walk's own value asks nothing new");
    assert!(unreached(&route, &given(&[("page", "2")])).is_empty());
}

/// The agent that reads an answer judges it, and the node acts on what it says (`unbrowse_judge`): a route judged wrong
/// for a page is passed over there, and only there, until it is judged right again; its name and default fields become
/// the agent's. Nothing here reads the answer's words: the site answers an empty list as readily as a full one.
#[test]
fn a_route_an_agent_judged_wrong_for_a_page_is_passed_over_there() {
    let _old = crate::learn::own_asks::as_the_old_node();
    use std::io::{BufRead, Write};
    let home = store::scratch_home("judged");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    // The site: its search page is HTML its scripts fill in; its API answers a phone search with nothing, a lamp
    // search with a lamp.
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
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
            let (kind, body) = match first.split_whitespace().nth(1).unwrap_or("/") {
                p if p.starts_with("/api/items") && p.contains("lamp") => ("application/json", r#"{"items":[{"id":1,"name":"desk lamp"}],"total":1}"#.to_string()),
                p if p.starts_with("/api/items") => ("application/json", r#"{"items":[],"total":0}"#.to_string()),
                _ => ("text/html", "<html><body><div id=app></div><script src=/app.js></script></body></html>".to_string()),
            };
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    let route: store::Route = serde_json::from_value(json!({
        "id": "items", "site": "127.0.0.1", "what": "search items", "method": "GET", "path": "/api/items",
        "root": format!("http://127.0.0.1:{port}/search?q=lamps"), "inputs": [{ "name": "q", "secret": false, "default": "lamps" }],
        "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/api/items?q={{q}}"),
            "needs_browser": false, "response_shape": { "items": [{ "id": "number", "name": "string" }] },
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
    }))
    .unwrap();
    store::save_route(&route).unwrap();
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
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
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    let prim = |tool: &str| PRIMITIVES.iter().find(|p| p.tool == tool).unwrap();
    let run = |tool: &'static str, path: &[(&str, &str)], body: Value| {
        let (n, h) = (node.clone(), headers.clone());
        let path: HashMap<String, String> = path.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let body = body.to_string();
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), answer_http(prim(tool), n, h, path, HashMap::new(), body.as_bytes())).await.expect("answered") })
    };
    let phones = format!("http://127.0.0.1:{port}/search?q=phone");
    let lamps = format!("http://127.0.0.1:{port}/search?q=desk%20lamp");
    let ask = |url: &str| run("unbrowse_do", &[], json!({ "goal": "search items", "url": url, "browser": "never" }));

    // The phone page: the route answers it, with an empty list, and says nothing is wrong.
    let (status, Json(r)) = ask(&phones);
    assert_eq!((status, r["how"].clone(), r["result"]["data"]["items"].clone()), (StatusCode::OK, json!("called"), json!([])), "{r}");

    // The agent sees no items where its goal wants some, and says so for that page.
    let (status, Json(j)) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "wrong", "url": format!("{phones}#top"), "why": "no items: the page opened on another tab" }));
    assert_eq!(status, StatusCode::OK, "{j}");
    crate::apischema::check(&(prim("unbrowse_judge").returns)(), &j, &crate::apischema::types()).unwrap_or_else(|e| panic!("judge answered {j}: {e}"));
    assert_eq!(j["judged"]["wrong_pages"][0]["page"], json!(format!("http://127.0.0.1:{port}/search?q=phone")), "{j}");

    // That page is no longer answered by the route: it is learned afresh, which here needs the browser.
    let (status, Json(r)) = ask(&phones);
    assert_eq!((status, r["code"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("browser_missing")), "the route was passed over: {r}");
    // What was searched is the caller's, not the page: the same search for something else is the same page.
    let (status, Json(r)) = ask(&lamps);
    assert_eq!((status, r["code"].clone()), (StatusCode::UNPROCESSABLE_ENTITY, json!("browser_missing")), "one verdict covers every value: {r}");

    // Judged right for the page again, under any value, the route answers it again.
    let (status, Json(_)) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "right", "url": lamps }));
    assert_eq!(status, StatusCode::OK);
    let (_, Json(r)) = ask(&phones);
    assert_eq!(r["how"], "called", "{r}");
    let (_, Json(r)) = ask(&lamps);
    assert_eq!((r["how"].clone(), r["result"]["data"]["items"][0]["name"].clone()), (json!("called"), json!("desk lamp")), "{r}");

    // A wrong verdict says which page and why, or what the route really does.
    let (status, _) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "wrong" }));
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "wrong", "url": phones }));
    assert_eq!(status, StatusCode::BAD_REQUEST, "a wrong page needs why");
    let (status, _) = run("unbrowse_judge", &[("id", "nope")], json!({ "verdict": "right" }));
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A path the answer doesn't have is refused, naming the ones it has: kept, it would empty every later answer.
    let (status, Json(e)) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "right", "fields": ["data.items[].name"] }));
    assert_eq!(status, StatusCode::BAD_REQUEST, "{e}");
    assert!(e["error"].as_str().unwrap().contains("data.items[].name") && e["error"].as_str().unwrap().contains("items[].name"), "{e}");
    assert!(!store::load_route("items").unwrap().judged.fields, "nothing was kept");
    // The agent's words for what the answer is, and the fields that are the answer, are the route's from then on: a
    // goal in the old words no longer finds it, and the fields stay its defaults.
    let (status, Json(j)) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "right", "what": "search shop items by name", "fields": ["items[].name"] }));
    assert_eq!(status, StatusCode::OK, "{j}");
    assert_eq!((j["route"]["what"].clone(), j["judged"]["fields"].clone()), (json!("search shop items by name"), json!(["items[].name"])), "{j}");
    let kept = store::load_route("items").unwrap();
    assert!(kept.judged.named && kept.judged.fields && kept.fields == ["items[].name"]);
    assert!(routes_for(&store::load_routes(), "search items", &lamps).is_empty(), "the old words no longer find it");
    assert_eq!(routes_for(&store::load_routes(), "search shop items by name", &lamps).len(), 1);
    // With the agent's fields, a search with no results is that search's answer, for the agent to judge: the page
    // isn't learned again because the fields came back empty.
    let (status, Json(r)) = run("unbrowse_do", &[], json!({ "goal": "search shop items by name", "url": phones, "browser": "never" }));
    assert_eq!((status, r["how"].clone(), r["result"]["data"]["items"].clone()), (StatusCode::OK, json!("called"), json!([])), "{r}");
    // A GET the agent saw change the site is a write from then on, read back as one, and a goal that only reads stops
    // calling it (R1.25); false takes the mark back.
    let (status, Json(j)) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "right", "writes": true }));
    assert_eq!(status, StatusCode::OK, "{j}");
    assert_eq!((j["judged"]["writes"].clone(), j["route"]["write"].clone()), (json!(true), json!(true)), "{j}");
    let kept = store::load_route("items").unwrap();
    assert!(kept.write && kept.judged.writes, "kept as a write through a read of the record");
    assert!(crate::recipe::compile(&kept).is_ok_and(|r| r.write), "and listed as one");
    let (_, Json(j)) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "right", "writes": false }));
    assert_eq!(j["route"]["write"], json!(false), "{j}");
    assert!(!store::load_route("items").unwrap().write);

    // A route on the network keeps its listing's name.
    store::update_route("items", |r| r.listing = Some(store::Listing { entry_id: "0x01".into(), tx: "0x02".into(), listed_at: 1, live: true })).unwrap();
    let (status, _) = run("unbrowse_judge", &[("id", "items")], json!({ "verdict": "wrong", "what": "something else" }));
    assert_eq!(status, StatusCode::CONFLICT);
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// What a route takes as inputs isn't part of the page a verdict names: a query's value, or a piece of the path where the
/// page it was learned on has an input's value. Everything else still tells two pages apart.
#[test]
fn a_verdict_holds_whatever_value_the_route_is_asked() {
    let mut r = route("v", "shop.example", "search shop", &["q"]);
    r.root = "https://shop.example/search/lamp/videos?tab=all".into();
    r.inputs[0].default = Some("lamp".into());
    r.judged.wrong.push(store::WrongPage { page: store::page_key("https://shop.example/search/lamp/videos?tab=all&q=lamp").unwrap(), why: "no items".into(), by: "agent".into(), at: 1 });
    assert!(r.wrong_for("https://shop.example/search/tiny%20house/videos?tab=all&q=tiny%20house").is_some(), "another value, in the query and in the path");
    assert!(r.wrong_for("https://shop.example/search/chair/videos?tab=all").is_some(), "the value in the path alone");
    assert!(r.wrong_for("https://shop.example/search/chair/videos?tab=new").is_none(), "a value the route doesn't take is another page");
    assert!(r.wrong_for("https://shop.example/search/chair/photos?tab=all").is_none(), "another piece of the path is another page");
    assert!(r.wrong_for("https://other.example/search/chair/videos?tab=all").is_none());
}

/// The walk that exposed it: a newsletter site's `/search/climate?searching=all_posts`, whose call sends the word
/// and a page number. The page's tab reached the call only inside its referer, and the route asked its caller for
/// it. What rides only in the referer is where the page was, not what the call asks.
#[test]
fn a_value_that_rides_only_in_the_referer_is_no_input() {
    let graph: unbrowse_learn::Graph = serde_json::from_value(json!({
        "provisional": false,
        "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": "https://letters.example/api/search?query={query}", "needs_browser": false,
            "fields": [
                { "loc": { "in": "query", "key": "query" }, "class": "input", "name": "search", "secret": false, "default": "climate" },
                { "loc": { "in": "header", "key": "referer" }, "class": "constant", "value": "https://letters.example/search/climate?searching=all_posts" }
            ],
            "held": [
                { "loc": { "in": "header", "key": "referer" }, "input": "searching", "sits": "all_posts", "written": "percent" },
                { "loc": { "in": "header", "key": "referer" }, "input": "search", "sits": "climate", "written": "percent" }
            ]
        }]
    }))
    .unwrap();
    let route = store::Route::from_graph("r".into(), "search posts".into(), "https://letters.example/search/climate?searching=all_posts".into(), graph).unwrap();
    assert_eq!(route.inputs.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), vec!["search"]);
}

/// The walk that exposed it: a shop whose results page was learned as a plain route of one step, and whose
/// suggestions call was learned later, three steps and unsettled, while someone clicked about the page. The newer
/// one was tried first: twenty-five seconds through the browser for a list of suggestions. The route that asks
/// least of the site goes first.
#[test]
fn of_routes_that_read_the_same_thing_the_one_that_asks_least_goes_first() {
    let plain = route("page", "shop.example", "search shop", &["q"]);
    let mut later = route("suggest", "shop.example", "search shop", &["q"]);
    later.graph = serde_json::from_value(json!({ "steps": [step_of("GET", "https://shop.example/a", json!([])), step_of("GET", "https://shop.example/b", json!([])), step_of("GET", "https://shop.example/suggest", json!([]))], "provisional": true })).unwrap();
    let mut needs_page = route("signed", "shop.example", "search shop", &["q"]);
    needs_page.browser_assisted = true;
    let mut tries = [needs_page, later, plain];
    tries.sort_by_key(goal::asks_least);
    assert_eq!(tries.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["page", "suggest", "signed"]);
}

/// The walk that exposed it: a shop that shows "choose a country" from this address. The search page's route was
/// learned off that page, answered nothing of the search, and the node marked it wrong for the page. A country was
/// then chosen in the node's browser, the same route answered the search, and the old verdict still passed it over
/// for a suggestions call. What the node said before something was done on the site is dropped; an agent's word is not.
#[test]
fn what_the_node_said_of_a_route_before_the_site_was_acted_on_is_dropped() {
    let home = store::scratch_home("node-verdicts");
    store::use_home(&home);
    let wrong = |by: &str| store::WrongPage { page: "https://www.shop.example/search".into(), why: "its answer never says a word of what this page asks for".into(), by: by.into(), at: 1 };
    let mut by_node = route("page", "www.shop.example", "search shop", &["q"]);
    by_node.judged.wrong = vec![wrong("the node")];
    let mut by_agent = route("other", "www.shop.example", "search shop", &["q"]);
    by_agent.judged.wrong = vec![wrong("an agent"), wrong("the node")];
    let mut elsewhere = route("far", "www.else.example", "search", &["q"]);
    elsewhere.judged.wrong = vec![wrong("the node")];
    for r in [&by_node, &by_agent, &elsewhere] {
        store::save_route(r).unwrap();
    }
    assert_eq!(store::forget_node_verdicts("shop.example"), 2);
    assert!(store::load_route("page").unwrap().judged.wrong.is_empty());
    assert_eq!(store::load_route("other").unwrap().judged.wrong.iter().map(|w| w.by.as_str()).collect::<Vec<_>>(), vec!["an agent"]);
    assert_eq!(store::load_route("far").unwrap().judged.wrong.len(), 1, "another site's routes are left alone");
}

/// The walk that exposed it: a hotel site whose second look ran long behind a gate. A call made meanwhile waited
/// five minutes for it before it was even tried. A route that answers over plain calls needs nothing the second
/// look holds and is not kept waiting; one the page signs waits for the browser, and only up to a minute.
#[test]
fn only_a_route_that_needs_the_browser_waits_for_the_second_look() {
    let plain = route("plain", "shop.example", "search shop", &["q"]);
    assert!(!call::waits_for_the_browser(&plain));
    let mut signed = route("signed", "shop.example", "search shop", &["q"]);
    signed.browser_assisted = true;
    assert!(call::waits_for_the_browser(&signed));
    assert!(call::VERDICT_WAIT <= std::time::Duration::from_secs(60));
}

/// A second look behind the first answer can swap in a better call, and the agent still holds the id it was handed.
/// That id is answered by the route that took its place, where it only reads and takes what the caller sends; a route
/// that writes, or one with no place for the caller's value, is not called under another's id.
#[test]
fn an_id_handed_out_is_answered_by_the_route_that_took_its_place() {
    let home = store::scratch_home("took-the-place");
    store::use_home(&home);
    store::save_route(&route("first", "shop.example", "search shop", &["q", "offset"])).unwrap();
    store::save_route(&route("second", "shop.example", "search shop", &["q", "offset"])).unwrap();
    assert!(store::retire_route_for("first", "second").unwrap());
    assert!(store::load_route("first").is_none());
    let sent = |names: &[&str]| names.iter().map(|n| (n.to_string(), "x".to_string())).collect::<HashMap<String, String>>();
    assert_eq!(call::standing_for("first", &sent(&["q"])).map(|r| r.id), Some("second".to_string()));
    assert!(call::standing_for("first", &sent(&["q", "colour"])).is_none(), "a value the newer route has no place for");
    assert!(call::standing_for("never", &sent(&["q"])).is_none());
    // Replaced twice: the line is followed to the route that stands.
    store::save_route(&route("third", "shop.example", "search shop", &["q", "offset"])).unwrap();
    assert!(store::retire_route_for("second", "third").unwrap());
    assert_eq!(call::standing_for("first", &sent(&["q"])).map(|r| r.id), Some("third".to_string()));
    // A route that writes is never called under another's id.
    let mut writes = route("posts", "shop.example", "post a review", &["q"]);
    writes.graph = serde_json::from_value(json!({ "steps": [step_of("POST", "https://shop.example/review", json!([]))], "provisional": false })).unwrap();
    store::save_route(&writes).unwrap();
    assert!(store::retire_route_for("third", "posts").unwrap());
    assert!(call::standing_for("first", &sent(&["q"])).is_none());
}

/// A second learn can retire the route that answered the first ask before the agent has read that answer. Its verdict
/// still lands: the route comes back to carry it, so the next learn of the page passes the call over.
#[test]
fn a_route_a_newer_one_replaced_can_still_be_judged() {
    let home = store::scratch_home("judged-retired");
    store::use_home(&home);
    let keys = unbrowse_core::MemoryStore::default();
    let _ = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    store::save_route(&route("old", "shop.example", "search shop", &["q"])).unwrap();
    assert!(store::retire_route("old").unwrap());
    assert!(store::load_route("old").is_none(), "retired, it answers nothing");
    assert!(store::load_routes().iter().all(|r| r.id != "old"));
    let judged = judge::do_judge(&a, &json!({ "route_id": "old", "verdict": "wrong", "url": "https://shop.example/search?q=lamp", "why": "the site's header, not its search" })).unwrap();
    assert_eq!(judged["judged"]["wrong_pages"][0]["why"], "the site's header, not its search");
    assert!(store::load_route("old").unwrap().wrong_for("https://shop.example/search?q=chair").is_some());
    assert_eq!(judge::do_judge(&a, &json!({ "route_id": "never", "verdict": "right" })).unwrap_err().0, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&home);
}

/// Learning a call again keeps what agents judged of it: the pages it doesn't do, and an agent's name and fields
/// over the learn's goal and the node's own choice. Without an agent's word, a learn names the route as before.
#[test]
fn a_learn_of_the_same_call_keeps_what_agents_judged() {
    let home = store::scratch_home("judged-relearn");
    store::use_home(&home);
    let mut judged = route("same-call", "shop.example", "get shop search suggestions", &["q"]);
    judged.fields = vec!["items[].name".into()];
    judged.judged = store::Judged {
        wrong: vec![store::WrongPage { page: "https://shop.example/search?q=phone".into(), why: "no items".into(), by: "agent".into(), at: 1 }],
        named: true,
        fields: true,
        writes: true,
    };
    store::save_route(&judged).unwrap();
    let (kept, fresh) = store::keep_learned(route("same-call", "shop.example", "search shop items", &["q"])).unwrap();
    assert!(fresh);
    assert_eq!((kept.what.as_str(), kept.fields.clone()), ("get shop search suggestions", vec!["items[].name".to_string()]));
    assert!(kept.wrong_for("https://shop.example/search/?q=phone").is_some(), "the same page, with a trailing slash");
    assert!(store::load_route("same-call").unwrap().write, "and a write an agent saw stays one");
    assert!(kept.wrong_for("https://shop.example/search?q=lamp").is_some(), "the value is the caller's");
    assert!(kept.wrong_for("https://shop.example/deals?q=lamp").is_none(), "another page is another page");
    // An unjudged route takes the learn's goal, as before.
    store::save_route(&route("other-call", "shop.example", "old words", &[])).unwrap();
    let (kept, _) = store::keep_learned(route("other-call", "shop.example", "new words", &[])).unwrap();
    assert_eq!(kept.what, "new words");
    let _ = std::fs::remove_dir_all(&home);
}

/// A verdict names a page by its address, not its spelling: a trailing slash, a fragment, an empty value and the
/// order of the query don't make another page; a query value does.
#[test]
fn a_page_is_named_by_its_address_not_its_spelling() {
    let k = |u: &str| store::page_key(u).unwrap();
    assert_eq!(k("https://Shop.example/search/x%20y/?b=2&a=1#top"), k("https://shop.example/search/x y?a=1&b=2&c="));
    assert_ne!(k("https://shop.example/search/x"), k("https://shop.example/search/x?tab=marketplace"));
    assert_ne!(k("http://127.0.0.1:8080/search"), k("http://127.0.0.1:9090/search"), "another port is another site");
    assert_eq!(k("https://shop.example:443/search"), k("https://shop.example/search"), "the scheme's own port is no port");
    assert!(store::page_key("not a url").is_none());
}

/// A kept copy of another contributor's route whose steps go over plain HTTP, or to an address inside the owner's
/// network, is refused before anything is sent, even with Reach private networks on: the site on this machine
/// hears nothing, no line is written, the copy is let go and its body set aside, and the agent hears which rule.
#[test]
fn someone_elses_route_never_reaches_this_network() {
    let home = store::scratch_home("foreign-inside");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    site.set_nonblocking(true).unwrap();
    let port = site.local_addr().unwrap().port();
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
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
    for (n, (url, rule)) in [
        (format!("http://127.0.0.1:{port}/api/items?q={{q}}"), "HTTPS only"),
        (format!("https://127.0.0.1:{port}/api/items?q={{q}}"), "public"),
        ("https://169.254.169.254/latest/meta-data?q={q}".to_string(), "public"),
        (format!("https://[::ffff:127.0.0.1]:{port}/api/items?q={{q}}"), "public"),
    ]
    .into_iter()
    .enumerate()
    {
        let entry = format!("0x{}", format!("{:02x}", n + 1).repeat(32));
        let content_id = format!("sha256:{}", format!("{:02x}", n + 0x10).repeat(32));
        let mut kept: store::Route = serde_json::from_value(json!({
            "id": format!("fetched-{n}"), "site": "shop.example.com", "what": "Search items", "method": "GET", "path": "/api/items",
            "root": "https://shop.example.com/?q=lamps", "inputs": [{ "name": "q", "secret": false, "default": "lamps" }],
            "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": url,
                "needs_browser": false, "response_shape": { "items": [{ "id": "number", "name": "string" }] },
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
        }))
        .unwrap();
        kept.fetched = Some(store::Fetched { entry_id: entry.clone(), route_id: format!("route-{n}"), agent_id: "7".into(), content_id: content_id.clone(), listed_as: "search items".into(), fetched_at: 1 });
        store::save_route(&kept).unwrap();
        let (at, agent) = (node.clone(), agent.clone());
        let inputs = HashMap::from([("q".to_string(), "desk lamps".to_string())]);
        let (status, why) = rt.block_on(async move { do_call(&at, &agent, entry, inputs).await }).expect_err("refused");
        assert_eq!(status, StatusCode::FORBIDDEN, "{why}");
        assert!(why.contains(rule) && why.contains("wasn't made"), "{url}: {why}");
        assert!(store::load_route(&format!("fetched-{n}")).is_none(), "the copy is let go");
        assert!(node.share.refused(&content_id).is_some(), "and its body set aside");
    }
    assert!(site.accept().is_err(), "nothing reached this machine");
    assert!(!home.join("devnet").join("receipts").exists(), "no line was written");
}

/// An agent on MCP finds the vault's references the way one on HTTP does: one view, references only.
#[test]
fn an_mcp_agent_lists_the_vaults_references_as_http_does() {
    let home = store::scratch_home("mcp-logins");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    std::fs::write(home.join("vault.json"), r#"[{"site":"github.com","account":"me","kind":"stored","counter":0,"created":1,"code":true}]"#).unwrap();
    std::fs::write(home.join("cards.json"), r#"[{"label":"visa","last4":"4242","created":1,"code":true},{"label":"mc","last4":"4444","created":1}]"#).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
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
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    let call = |headers: HeaderMap, msg: Value| {
        let node = node.clone();
        rt.block_on(async move { mcp_answer(node, &headers, msg).await.1 .0 })
    };
    let listed = call(headers.clone(), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }));
    assert!(listed["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "unbrowse_logins"), "{listed}");
    let r = call(headers.clone(), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "unbrowse_logins", "arguments": {} } }));
    assert_eq!(r["result"]["isError"], json!(false), "{r}");
    let seen: Value = serde_json::from_str(r["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(seen, rt.block_on(async { logins_view() }), "the same view GET /v1/logins gives");
    // Written compact: the agent pays a token for every space of indentation, and that was 44% of a search's reply.
    assert_eq!(r["result"]["content"][0]["text"].as_str().unwrap(), serde_json::to_string(&seen).unwrap(), "the reply's text is compact JSON");
    assert_eq!(seen["logins"][0], json!({ "ref": "vault:github.com:me", "site": "github.com", "code": "vault:code:github.com:me" }));
    // A security code's reference only while the owner keeps them, and only for a card kept with one (#185).
    assert_eq!((seen["cards"][0]["last4"].clone(), seen["cards"][0]["number"].clone(), seen["cards"][0]["cvv"].clone()), (json!("4242"), json!("vault:card:visa:number"), json!(null)));
    store::save_settings(&store::Settings { keep_card_codes: true, ..store::load_settings() }).unwrap();
    let view = logins_view();
    assert_eq!((view["cards"][0]["cvv"].clone(), view["cards"][1]["cvv"].clone()), (json!("vault:card:visa:cvv"), json!(null)));
    for card in view["cards"].as_array().unwrap() {
        crate::apischema::check(&crate::apischema::r("Card"), card, &crate::apischema::types()).unwrap();
    }
    // An agent with no key gets nothing.
    let refused = call(HeaderMap::new(), json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "unbrowse_logins", "arguments": {} } }));
    assert!(refused.get("error").is_some() && !refused.to_string().contains("vault:"), "{refused}");
}

/// Every primitive is one entry, on both surfaces: MCP lists exactly the primitives, each answers over HTTP what it
/// answers over MCP (HTTP's own names for an argument included), and each refuses a missing argument alike.
#[test]
fn every_primitive_answers_alike_over_http_and_mcp() {
    let home = store::scratch_home("primitives");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    std::fs::write(home.join("cards.json"), r#"[{"label":"visa","last4":"4242","created":1}]"#).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
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
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    let over_mcp = |tool: &str, args: Value| {
        let (node, headers) = (node.clone(), headers.clone());
        let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        rt.block_on(async move { mcp_answer(node, &headers, msg).await.1 .0 })
    };
    let over_http = |p: &'static Primitive, path: &[(&str, &str)], query: &[(&str, &str)], body: Value| {
        let (node, headers) = (node.clone(), headers.clone());
        let own = |kv: &[(&str, &str)]| kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>();
        let (path, query, body) = (own(path), own(query), body.to_string());
        rt.block_on(async move { answer_http(p, node, headers, path, query, body.as_bytes()).await })
    };
    let names: Vec<Value> = tools().as_array().unwrap().iter().map(|t| t["name"].clone()).collect();
    assert_eq!(names, PRIMITIVES.iter().map(|p| json!(p.tool)).collect::<Vec<_>>(), "MCP lists exactly the primitives");
    for (n, p) in PRIMITIVES.iter().enumerate() {
        assert!(PRIMITIVES[..n].iter().all(|q| q.tool != p.tool && (q.path, q.method) != (p.path, p.method) && q.cli != p.cli), "{} is one entry", p.tool);
        assert!(p.path.starts_with("/v1/") && matches!(p.method, "GET" | "POST") && !p.sdk.is_empty(), "{}", p.tool);
        let schema = (p.schema)();
        for (http, tool) in p.renamed {
            assert!(schema["properties"].get(*tool).is_some() && (p.path.contains(&format!("{{{http}}}")) || p.method == "GET"), "{} renames {http} to an argument it takes", p.tool);
        }
        // A missing argument is refused alike, before anything runs.
        if let Some(k) = schema["required"].as_array().and_then(|r| r.first()).and_then(Value::as_str) {
            let m = over_mcp(p.tool, json!({}));
            assert_eq!(m["error"]["code"], json!(-32602), "{m}");
            let path: Vec<(&str, &str)> = p.renamed.iter().filter(|(http, tool)| p.path.contains(&format!("{{{http}}}")) && *tool != k).map(|(http, _)| (*http, "x")).collect();
            let (status, Json(r)) = over_http(p, &path, &[], json!({}));
            assert_eq!((status, r["error"].clone(), m["error"]["message"].clone()), (StatusCode::BAD_REQUEST, json!(format!("{} needs {k}", p.tool)), json!(format!("{} needs {k}", p.tool))));
        }
    }
    // What needs no network or browser answers the same over both, HTTP's own argument names included, and
    // answers what its `returns` says.
    let route: store::Route = serde_json::from_value(json!({
        "id": "lamps", "site": "a.example", "what": "Search lamps", "method": "GET", "path": "/api/items", "root": "https://a.example/?q=lamps",
        "inputs": [{ "name": "q", "secret": false, "default": "lamps" }], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false,
        "learned_at": 1, "graph": { "steps": [], "provisional": false }
    }))
    .unwrap();
    store::save_route(&route).unwrap();
    let types = crate::apischema::types();
    for (tool, args, query) in [("unbrowse_whoami", json!({}), vec![]), ("unbrowse_logins", json!({}), vec![]), ("unbrowse_search", json!({ "query": "lamps" }), vec![("q", "lamps")])] {
        let p = PRIMITIVES.iter().find(|p| p.tool == tool).unwrap();
        let m = over_mcp(tool, args);
        let seen: Value = serde_json::from_str(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        crate::apischema::check(&(p.returns)(), &seen, &types).unwrap_or_else(|e| panic!("{tool} answered {seen}: {e}"));
        let (status, Json(r)) = over_http(p, &[], &query, Value::Null);
        assert_eq!((status, r), (StatusCode::OK, seen), "{tool}");
    }
    let found = over_mcp("unbrowse_search", json!({ "query": "lamps" }));
    assert!(found["result"]["content"][0]["text"].as_str().unwrap().contains("\"id\":\"lamps\""), "the search found the route: {found}");
    // No key, no answer, on either.
    let (status, _) = rt.block_on(answer_http(&PRIMITIVES[0], node.clone(), HeaderMap::new(), HashMap::new(), HashMap::new(), b""));
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // A key the node doesn't know (made before its root key changed) hears how to get one that works.
    let mut stale = HeaderMap::new();
    stale.insert("authorization", "Bearer 0xstale".parse().unwrap());
    let (status, Json(said)) = rt.block_on(answer_http(&PRIMITIVES[0], node.clone(), stale, HashMap::new(), HashMap::new(), b""));
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let said = said["error"].as_str().unwrap();
    assert!(said.starts_with("unknown, revoked or expired agent key") && said.contains("Agents, Connect") && said.contains("Agents, Add agent"), "{said}");
}

/// Each MCP client gets its own session at initialize, and its tools run in it: two clients on one key browse in
/// two sessions (two tabs of a site's browser), and a session the agent names is kept apart within its client's.
#[test]
fn each_mcp_client_browses_in_its_own_session() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let node = Arc::new(Node {
        keys: Box::new(unbrowse_core::MemoryStore::default()),
        identity: std::sync::RwLock::new(None),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });
    let opened = |node: Arc<Node>| rt.block_on(mcp(State(node), HeaderMap::new(), Json(init.clone()))).headers().get("mcp-session-id").map(|v| v.to_str().unwrap().to_string());
    let (one, two) = (opened(node.clone()).expect("initialize names a session"), opened(node.clone()).unwrap());
    assert_ne!(one, two, "each client its own");
    // A request after initialize gets no new session.
    let later = rt.block_on(mcp(State(node), HeaderMap::new(), Json(json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }))));
    assert!(later.headers().get("mcp-session-id").is_none());

    let with = |sid: &str| {
        let mut h = HeaderMap::new();
        h.insert("mcp-session-id", sid.parse().unwrap());
        h
    };
    let a = Agent { auto: false, index: 3, name: "a".into(), address: String::new(), cap_usdc: 0.0, expires: 0, created: 0, revoked: false, tx: None, salt: None, cap_set: false, payers: vec![], gateway: None };
    let session = |h: &HeaderMap, args: Value| browse_session(&a, &text_arg(&in_mcp_session(h, args), "session"));
    let (s1, s2) = (session(&with(&one), json!({ "do": ["snapshot"] })), session(&with(&two), json!({ "do": ["snapshot"] })));
    assert_ne!(s1, s2, "two clients on one key are two sessions");
    assert_ne!(crate::browse::tab_of(&s1), crate::browse::tab_of(&s2), "and two tabs");
    assert_ne!(session(&with(&one), json!({ "session": "b" })), s1, "a session named inside a client's is its own");
    assert_eq!(session(&HeaderMap::new(), json!({ "session": "b" })), "3:b", "over HTTP, the session named");
    let other = Agent { index: 4, ..a.clone() };
    assert_ne!(browse_session(&other, "b"), browse_session(&a, "b"), "one name on two keys is two sessions");
}

/// `agent-api.json` is the primitives as the other surfaces' tests read them: it says what PRIMITIVES says.
/// `UNBROWSE_WRITE_AGENT_API=1` rewrites it.
#[test]
fn the_agent_api_manifest_is_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent-api.json");
    let want = serde_json::to_string_pretty(&manifest()).unwrap() + "\n";
    if std::env::var_os("UNBROWSE_WRITE_AGENT_API").is_some() {
        std::fs::write(&path, &want).unwrap();
    }
    let have = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(have == want, "agent-api.json is behind PRIMITIVES: run UNBROWSE_WRITE_AGENT_API=1 cargo test -p unbrowse-node-app the_agent_api_manifest_is_current, and give unb and both SDKs what it adds");
}

/// The walk that exposed it: an agent ran its own `fetch` inside the page, and nothing told it the node doesn't learn
/// that. An eval's reply says its script's own requests are never learned and that driving the page is what teaches a
/// route, and the browse tool says it before the agent tries.
#[test]
fn an_evals_reply_says_its_own_requests_are_never_learned() {
    assert!(browse::EVAL_NOTE.contains("never learned") && browse::EVAL_NOTE.contains("click"));
    let tool = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_browse").unwrap().description;
    assert!(tool.contains("An eval's own requests") && tool.contains("never learned") && tool.contains("needs_owner"), "{tool}");
}

/// The tools an agent is handed when it connects are read on every turn, so their list stays small: the whole
/// `tools/list` reply within `TOOLS_LIST_MAX` bytes (the goal is 12 000). Saying it in fewer words never takes an
/// argument away: each tool keeps every property it takes, each with its type, and the same required list.
/// 21 Nov 2026: the list was 20 932 bytes against 18 000, red on staging; cut to 20 209 (the checkout's hold is told in
/// the card fill's reply and each refusal, not here) and the ceiling set just above it, so it can only shrink again.
/// 22 Nov 2026: raised to 20 900 for one new tool, unbrowse_setup (an agent sets the node up without a terminal), in
/// the fewest words it takes; a loosened gate, so its PR asks the owner to countersign it.
#[test]
fn the_tool_list_stays_small_and_keeps_every_argument() {
    const TOOLS_LIST_MAX: usize = 20_900;
    let reply = json!({ "jsonrpc": "2.0", "id": 1, "result": { "tools": tools() } });
    let bytes = serde_json::to_string(&reply).unwrap().len();
    assert!(bytes <= TOOLS_LIST_MAX, "tools/list is {bytes} bytes, over {TOOLS_LIST_MAX}: say the same in fewer words");
    let takes: &[(&str, &[&str], &[&str])] = &[
        ("unbrowse_search", &["query"], &[]),
        ("unbrowse_do", &["ask", "browser", "budget_usdc", "fields", "goal", "inputs", "pages", "session", "url", "wait_ms"], &[]),
        ("unbrowse_walk", &["goal", "pick", "session", "url", "what"], &["url"]),
        ("unbrowse_browse", &["do", "goal", "session", "site", "wait_ms"], &["do"]),
        ("unbrowse_challenge", &["action", "key", "ms", "quick", "session", "site", "steps", "text", "to_x", "to_y", "url", "x", "y"], &["action"]),
        ("unbrowse_observe", &["goal", "session", "site"], &[]),
        ("unbrowse_logins", &[], &[]),
        ("unbrowse_open", &["link"], &["link"]),
        ("unbrowse_call", &["browser", "fields", "inputs", "route_id"], &["route_id"]),
        ("unbrowse_inspect", &["route_id"], &["route_id"]),
        ("unbrowse_judge", &["bounty", "entry", "fields", "links", "route_id", "url", "verdict", "what", "why", "word", "writes"], &["route_id", "verdict"]),
        ("unbrowse_whoami", &[], &[]),
        ("unbrowse_setup", &["do", "host"], &[]),
        ("unbrowse_report", &["error", "expected", "goal", "got", "kind", "route_id", "summary", "tool", "url"], &["kind", "summary", "expected", "got"]),
    ];
    let listed = tools();
    let listed = listed.as_array().unwrap();
    assert_eq!(listed.len(), takes.len(), "one entry per tool");
    for (t, (name, props, required)) in listed.iter().zip(takes) {
        assert_eq!(t["name"], *name);
        let schema = &t["inputSchema"];
        let mut have: Vec<&str> = schema["properties"].as_object().unwrap().keys().map(String::as_str).collect();
        have.sort_unstable();
        assert_eq!(have, *props, "{name} keeps every argument");
        let req: Vec<&str> = schema["required"].as_array().map(|r| r.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        assert_eq!(req, *required, "{name}'s required arguments");
        for (k, p) in schema["properties"].as_object().unwrap() {
            assert!(p["type"].is_string(), "{name}.{k} keeps its type");
        }
    }
}

/// The run that exposed it: an agent asked to make an account was shown an empty list of logins, guessed a reference
/// for one, and told its user only they could add to the vault. Every logins reply, a full one or an empty one, says
/// how a new login is made, and the two tools an agent signs up with say it before it tries.
#[test]
fn an_agent_shown_no_login_is_told_how_to_make_one() {
    let home = store::scratch_home("no-login-yet");
    store::use_home(&home);
    let view = logins_view();
    assert_eq!(view["logins"], json!([]), "{view}");
    let said = view["sign_up"].as_str().unwrap();
    assert!(said.contains("vault:new:<site>:<account>") && said.contains("fill"), "{said}");
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_logins").unwrap();
    crate::apischema::check(&(p.returns)(), &view, &crate::apischema::types()).unwrap();
    for tool in ["unbrowse_logins", "unbrowse_browse"] {
        let text = PRIMITIVES.iter().find(|p| p.tool == tool).unwrap().description;
        assert!(text.contains("vault:new:<site>:<account>"), "{tool}: {text}");
    }
}

/// A web login the owner saved in the login keychain is listed for an agent to fill, by name and never its password,
/// until the vault holds it: then it is the vault's, listed once.
#[test]
fn a_login_keychain_login_is_listed_until_the_vault_keeps_it() {
    let home = store::scratch_home("keychain-listed");
    store::use_home(&home);
    crate::keychain_logins::keep_in_test(&[("github.com", "me", Some("not-shown")), ("listed-twice.example", "me", Some("x"))]);
    store::write_json(&home.join("vault.json"), &unbrowse_files::VAULT, &json!([{ "site": "listed-twice.example", "account": "me", "kind": "stored", "created": 0 }])).unwrap();
    let view = logins_view();
    assert!(!view.to_string().contains("not-shown"), "{view}");
    assert_eq!(view["logins"], json!([{ "ref": "vault:listed-twice.example:me", "site": "listed-twice.example" }, { "ref": "vault:github.com:me", "site": "github.com", "from": "login keychain" }]));
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_logins").unwrap();
    crate::apischema::check(&(p.returns)(), &view, &crate::apischema::types()).unwrap();
    crate::keychain_logins::keep_in_test(&[]);
}

/// An agent is told before it asks whether the owner can be asked at all, and that a check asking for a person is one
/// to try itself first: the browse tool says both, and whoami's answer carries the first.
#[test]
fn the_browse_tool_says_who_can_pass_a_check_and_whether_the_owner_can_be_asked() {
    let tool = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_browse").unwrap().description;
    assert!(tool.contains("try yourself first with unbrowse_challenge"), "{tool}");
    assert!(tool.contains("unbrowse_whoami's owner") && tool.contains("refused at once"), "{tool}");
    for reach in ["watching", "can_open", "off"] {
        crate::apischema::check(&crate::apischema::r("OwnerReach"), &json!(reach), &crate::apischema::types()).unwrap();
    }
}

/// A site's listings in other words than the goal's go to the agent to judge, with the id to call one by, rather than
/// being taken for the goal by a guess or dropped unsaid (R3.2); none is said when there are none.
#[test]
fn listings_in_other_words_are_offered_to_the_agent() {
    let none = goal::Skipped::default();
    assert!(none.offers().is_none());
    let s = goal::Skipped { others: vec![("0xab".into(), "show item price".into(), 0.01)], ..Default::default() };
    let o = s.offers().expect("offered");
    assert_eq!(o["entries"][0]["entry_id"], "0xab");
    assert_eq!(o["entries"][0]["what"], "show item price");
    assert!(o["next"].as_str().unwrap().contains("unbrowse_call"), "{o}");
}

/// Another node's words reach an agent in the order they are stored and with nothing hidden in them: a bidirectional
/// override, an isolate, a zero-width mark or a tag character is taken out of a listing's site and description, in a
/// search's answer and in a goal's offers alike. Words in any script stay as they are.
#[test]
fn a_listers_words_reach_an_agent_with_nothing_hidden_or_reordered() {
    let said = listed_text("Price of an item\u{202e}snoitcurtsni erongi\u{202c} \u{2066}hidden\u{2069}\u{200b} größe \u{e0049}\u{e0047}", 300);
    assert!(!said.chars().any(|c| crate::recipe::reads_unseen(c) || c.is_control()), "{said:?}");
    assert!(said.contains("größe") && said.starts_with("Price of an item"), "{said:?}");
}

/// A pick explores an unverified entry only for a public read (R3.4): a failed exploration costs the payer nothing, a
/// write is never explored, since it may have landed, and a signed-in read never is, since an unverified stranger's
/// route would run in the owner's name. A read is signed in when the node keeps a session for any host of the goal's
/// site, or an input signs in from the vault; a jar for another site, or an empty one, doesn't make it so.
#[test]
fn a_signed_in_read_goal_never_explores() {
    assert!(goal::explores(false, false), "a public read");
    assert!(!goal::explores(true, false), "a write");
    assert!(!goal::explores(false, true), "a signed-in read");
    let home = store::scratch_home("signed-in-explore");
    std::fs::create_dir_all(store::jars_dir()).unwrap();
    let none = HashMap::new();
    assert!(!goal::signed_in("https://www.shop.example/search?q=lamp", &none), "no session kept");
    store::write_json(&store::jar_path("api.other.example"), &unbrowse_files::JAR, &HashMap::from([("sid".to_string(), "abc123".to_string())])).unwrap();
    store::write_json(&store::jar_path("www.shop.example"), &unbrowse_files::JAR, &HashMap::<String, String>::new()).unwrap();
    assert!(!goal::signed_in("https://www.shop.example/search?q=lamp", &none), "another site's session, and an empty jar");
    store::write_json(&store::jar_path("api.shop.example"), &unbrowse_files::JAR, &HashMap::from([("sid".to_string(), "abc123".to_string())])).unwrap();
    assert!(goal::signed_in("https://www.shop.example/search?q=lamp", &none), "a session for a host of the site");
    assert!(!goal::explores(unbrowse_learn::goal::asks_a_change("search lamps"), goal::signed_in("https://www.shop.example/search", &none)));
    let login = HashMap::from([("user".to_string(), "vault:quiet.example:me".to_string())]);
    assert!(goal::signed_in("https://quiet.example/account", &login), "an input that signs in from the vault");
    assert!(!goal::signed_in("not a page", &none));
    let _ = std::fs::remove_dir_all(&home);
}

/// An agent's call of a route that pays with a card from the vault always waits for the owner because the route graph
/// does not bind a charge amount and currency to the request sent: the
/// window is asked, showing the card, the site and what the route does, and a refusal comes back as the call's error with
/// nothing filled or sent. Any agent key can name a card; only the owner can let it go.
#[test]
fn a_route_call_that_pays_with_a_card_waits_for_the_owner() {
    let home = store::scratch_home("card-call-asks");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    store::use_home(&home);
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let keep = crate::vault_keep(Ok(&keys as &dyn unbrowse_core::KeyStore)).unwrap();
    assert!(keep.is_sealed(), "a test build seals the vault in its scratch home, never the system's keystore");
    let card = unbrowse_core::Card::read("4242 4242 4242 4242", "12/28", None, "Ada Lovelace").unwrap();
    vault::add_card(&keep, "visa", &card, false, "You").unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
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
    let graph: unbrowse_learn::Graph = serde_json::from_value(json!({ "steps": [{ "exchange": 0, "method": "POST", "status": 200,
        "url": "https://checkout.card-asks.example/charge", "needs_browser": false, "sets_cookie": false,
        "fields": [{ "loc": { "in": "header", "key": "x-card" }, "class": "input", "name": "card", "secret": true, "default": null }] }], "provisional": false })).unwrap();
    let route = store::Route::from_graph("buy".into(), "buy the ticket".into(), "https://checkout.card-asks.example/".into(), graph).unwrap();
    let site = route.site.clone();
    let inputs = HashMap::from([("card".to_string(), "vault:card:visa:number".to_string())]);
    let (n, ag, r) = (node.clone(), a.clone(), route.clone());
    let calling = rt.spawn(async move { call::run_route(&n, &ag, r, inputs, None, vec![]).await });
    let asked = rt.block_on(async {
        for _ in 0..1000 {
            if let Some(ask) = crate::hands::asks().into_iter().find(|x| x.site == site) {
                return Some(ask);
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        None
    });
    let asked = asked.expect("the owner is asked before a card is filled into a route call");
    let pay = asked.pay.expect("the ask is a payment");
    assert_eq!((pay.card.as_str(), pay.route.as_deref()), ("visa (card ending 4242)", Some("buy the ticket")));
    crate::hands::answer(&asked.site, crate::hands::Answer::Declined);
    let (status, why) = rt.block_on(calling).unwrap().expect_err("a declined payment never runs");
    assert_eq!(status, StatusCode::FORBIDDEN, "{why}");
    assert!(why.contains("declined") && !why.contains("4242424242424242"), "{why}");

    // Caller-supplied amount metadata never skips the owner or counts against a limit.
    let on = unbrowse_learn::identity::site_of(&route.site);
    vault::set_card_limit(&keep, "visa", &on, 20.0, 30.0, "You").unwrap();
    let asks = |amount: Option<&str>| -> Option<crate::hands::Pay> {
        let mut inputs = HashMap::from([("card".to_string(), "vault:card:visa:number".to_string())]);
        if let Some(x) = amount {
            inputs.insert("card_amount".to_string(), x.to_string());
        }
        let (n, ag, r, site) = (node.clone(), a.clone(), route.clone(), route.site.clone());
        let calling = rt.spawn(async move { call::run_route(&n, &ag, r, inputs, None, vec![]).await });
        rt.block_on(async {
            // A call that isn't asked about goes on to a host that doesn't exist, and a busy machine takes a while to say so.
            for _ in 0..6000 {
                if let Some(ask) = crate::hands::asks().into_iter().find(|x| x.site == site) {
                    crate::hands::answer(&ask.site, crate::hands::Answer::Declined);
                    let _ = calling.await;
                    return ask.pay;
                }
                if calling.is_finished() {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            panic!("the call neither asked nor ended");
        })
    };
    for amount in [Some("0.01"), Some("12.50"), Some("999999"), None] {
        let pay = asks(amount).expect("every card route asks the owner");
        assert!(pay.over.as_deref().is_some_and(|w| w.contains("does not bind a charge amount and currency")), "{pay:?}");
        assert!(pay.inputs.iter().all(|i| !i.starts_with("card_amount:")), "caller amount metadata is not a sent input: {pay:?}");
        assert_eq!(vault::card_limits(&keep)[0].spent, 0.0, "no caller-stated amount is counted");
    }
    assert!(!store::read_activity(50).iter().any(|x| x.what.contains("within your limit")));
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// A client that writes a list or an object as JSON text (an MCP client whose copy of the tool's schema predates
/// the argument sends it that way) is read as meaning the list or the object: its pages are pages, its fields are
/// paths, its inputs are inputs. Pages that read as none are refused, never answered with the goal's own route.
#[test]
fn an_argument_written_as_json_text_means_what_it_says() {
    let args = json!({
        "goal": "search repositories",
        "pages": "[{\"url\": \"https://code.example/search?q=tokio\"}, \"https://code.example/search?q=serde\"]",
        "fields": "[\"items[].name\", \"total\"]",
        "inputs": "{\"q\": \"tokio\"}",
    });
    let pages = pages_arg(&args);
    assert_eq!(pages.iter().map(|p| p.url.as_str()).collect::<Vec<_>>(), ["https://code.example/search?q=tokio", "https://code.example/search?q=serde"]);
    assert_eq!(list_arg(&args, "fields"), ["items[].name", "total"]);
    assert_eq!(strings(args.get("inputs")).get("q").map(String::as_str), Some("tokio"));
    // A lone url is one page; a plain path stays a path.
    assert_eq!(pages_arg(&json!({ "pages": "https://code.example/search?q=x" })).len(), 1);
    assert_eq!(list_arg(&json!({ "fields": "total" }), "fields"), ["total"]);
    assert_eq!(list_arg(&json!({ "fields": ["total"] }), "fields"), ["total"]);
    // Pages that aren't pages are refused before the goal's route is called; no pages is the goal alone.
    assert!(pages_unread(&json!({ "pages": "[1, 2]" })) && pages_unread(&json!({ "pages": 7 })));
    assert!(!pages_unread(&json!({ "goal": "x" })) && !pages_unread(&json!({ "pages": [] })) && !pages_unread(&args));
}
#[tokio::test]
async fn a_page_that_finishes_after_the_reply_answers_the_next_ask() {
    static WALKS: std::sync::LazyLock<std::sync::Mutex<Walks>> = std::sync::LazyLock::new(Default::default);
    let walked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let page = || DoBody {
        goal: "search books".into(),
        url: "https://books.example/search?q=dune".into(),
        inputs: HashMap::new(),
        session: String::new(),
        browser: String::new(),
        fields: Vec::new(),
        many: true,
        budget_usdc: None,
    };
    let run = {
        let walked = walked.clone();
        move |(i, _): (usize, DoBody)| {
            let walked = walked.clone();
            async move {
                walked.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                (i, std::time::Duration::from_millis(300), Ok(json!({ "how": "browse", "why": "the site asks for a check" })))
            }
        }
    };
    let within = std::time::Duration::from_millis(50);
    // The reply comes before the walk is over: the page is pending.
    assert!(pages_run(vec![vec![(0, page())]], within, &WALKS, run.clone()).await.is_empty());
    // Asked again while it is walked: still pending, and not walked twice.
    assert!(pages_run(vec![vec![(0, page())]], within, &WALKS, run.clone()).await.is_empty());
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    // Asked once it is over: its answer, at once, from the one walk.
    let done = pages_run(vec![vec![(0, page())]], within, &WALKS, run.clone()).await;
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].1 .1.as_ref().unwrap()["how"], "browse");
    assert_eq!(walked.load(std::sync::atomic::Ordering::SeqCst), 1);
    // A late answer is kept only so long.
    let mut w = Walks::default();
    let t = std::time::Instant::now();
    w.ask("k", t);
    w.over("k", Some((std::time::Duration::ZERO, Ok(json!({})))), t);
    assert!(matches!(w.ask("k", t + LATE_KEPT), Ask::Walk));
}

/// A panic while a page is walked ends its site's task. The pages of that task are walked again when next asked, not said
/// to be pending for good, and the reply still comes at its time.
#[tokio::test]
async fn a_panic_in_a_walk_leaves_no_page_pending_for_good() {
    let walks: &'static std::sync::Mutex<Walks> = Box::leak(Box::default());
    let page = |url: &str| DoBody { goal: "get it".into(), url: url.into(), inputs: HashMap::new(), session: String::new(), browser: String::new(), fields: Vec::new(), many: true, budget_usdc: None };
    let site = vec![(0, page("https://a.example/1")), (1, page("https://a.example/2"))];
    let done = pages_run(vec![site], std::time::Duration::from_millis(200), walks, |_| async move {
        if true {
            panic!("a page panics");
        }
        (0, std::time::Duration::ZERO, Ok(json!({})))
    })
    .await;
    assert!(done.is_empty());
    let now = std::time::Instant::now();
    for url in ["https://a.example/1", "https://a.example/2"] {
        assert!(matches!(walks.locked().ask(&in_flight(&page(url)), now), Ask::Walk), "{url} is walked again");
    }
}

/// A late answer is kept for the next ask of the same page with the same values: an ask for another item on the page
/// never gets the answer of the one before it.
#[test]
fn a_late_answer_goes_only_to_an_ask_with_the_same_values() {
    let ask = |inputs: &[(&str, &str)], session: &str| DoBody {
        goal: "get it".into(),
        url: "https://a.example/".into(),
        inputs: inputs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        session: session.into(),
        browser: String::new(),
        fields: Vec::new(),
        many: true,
        budget_usdc: None,
    };
    assert_eq!(in_flight(&ask(&[("a", "1"), ("b", "2")], "")), in_flight(&ask(&[("b", "2"), ("a", "1")], "")), "the order they came in is no difference");
    assert_ne!(in_flight(&ask(&[("q", "lamp")], "")), in_flight(&ask(&[("q", "chair")], "")));
    assert_ne!(in_flight(&ask(&[], "one")), in_flight(&ask(&[], "two")));
}

/// A goal a route was learned for may need values the ask doesn't give: a sign-in learned once takes a username and a
/// password, and "sign in" with a login page names neither. The agent gets the page, never "the route needs a value".
/// Nothing was sent. With the values, or with no page to go to, the route's own answer stands.
#[test]
fn a_route_that_needs_a_value_the_ask_lacks_gives_way_to_the_page() {
    let home = store::scratch_home("needs-values");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    store::use_home(&home);
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    let mut sign_in = route("sign", "127.0.0.1", "sign in", &["username", "password"]);
    sign_in.write = true;
    sign_in.root = "http://127.0.0.1:9/login".into();
    sign_in.graph = serde_json::from_value(json!({ "steps": [{ "exchange": 0, "method": "POST", "status": 200, "url": "http://127.0.0.1:9/authenticate", "fields": [], "needs_browser": false }], "provisional": false })).unwrap();
    store::save_route(&sign_in).unwrap();
    assert_eq!(lacks_value(&sign_in, &HashMap::new()).as_deref(), Some("username"));
    assert_eq!(lacks_value(&sign_in, &HashMap::from([("username".to_string(), "a".to_string())])).as_deref(), Some("password"));
    assert_eq!(lacks_value(&sign_in, &HashMap::from([("username".to_string(), "a".to_string()), ("password".to_string(), "b".to_string())])), None);
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
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
    let ask = |url: &str| {
        let (n, a) = (node.clone(), a.clone());
        let body = DoBody { goal: "sign in".into(), url: url.to_string(), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&n, &a, body)).await.expect("answered") })
    };
    // Past the route, on to the page: which here stops at the browser this call said it may not use.
    let (_, said) = ask("http://127.0.0.1:9/login").unwrap_err();
    assert!(said.contains("needs the node's browser") && !said.contains("username"), "{said}");
    assert_eq!(store::load_route("sign").unwrap().stats.calls, 0, "nothing ran");
    // With no page to go to, the agent hears what the route needs.
    let (_, said) = ask("").unwrap_err();
    assert!(said.contains("username"), "{said}");
    let _ = std::fs::remove_dir_all(&home);
}

/// Lewis, 22 Nov 2026: "another node should be able to login via the login route to get the same experience with their
/// own sessions", and "another agent from a different node's account cannot login as others". An agent asks this node
/// (B) for a route node A listed, whose body carries the site's sign-in, with no session on the site. With no login of
/// the site in B's vault the reply says how to add one and nothing is asked or kept. With B's own login the owner is
/// asked, and on yes B takes the sign-in as its own, filled from B's login (never A's), and sends it as B: here the site
/// isn't there, so the reply says the sign-in sent as B's account wasn't taken, and the sign-in is let go so the next
/// call asks again.
#[test]
fn a_route_another_node_listed_signs_in_only_as_this_nodes_own_owner() {
    let home = store::scratch_home("shared-sign-in-goal");
    let route = crate::setups::tests::a_fetched_route_with_its_sites_sign_in(&home);
    let site = crate::setups::tests::SHARED_SITE;
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    store::save_route(&route).unwrap();
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .on_thread_start(move || {
            store::use_home(&h);
            crate::owner_dialog::answer_in_test(Some(true));
        })
        .build()
        .unwrap();
    let node_with = |login: Option<&str>| {
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        if let Some(account) = login {
            crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), site, account, "stored", Some("bobs-own-pass"), "You").unwrap();
        }
        let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7790).unwrap();
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
        (node, a)
    };
    let ask = |node: &Arc<Node>, a: &agents::Agent| {
        let (n, a) = (node.clone(), a.clone());
        let body = DoBody { goal: "the orders on my account".into(), url: format!("https://{site}/orders"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&n, &a, body)).await.expect("answered") })
    };
    let kept = || crate::setups::load(&unbrowse_learn::identity::site_of(site));
    // No login of the site in this node's vault: told how to add one, nothing kept.
    let (node, a) = node_with(None);
    let (_, said) = ask(&node, &a).unwrap_err();
    assert!(said.contains("holds no login") && said.contains(&format!("vault:new:{}", unbrowse_learn::identity::site_of(site))), "{said}");
    assert!(kept().is_empty(), "nothing kept");
    // This node's own login: the owner says yes, and the sign-in is taken as this node's own, under its own login.
    let (node, a) = node_with(Some("bob@mail.example"));
    let (_, said) = ask(&node, &a).unwrap_err();
    assert!(said.contains("the sign-in was sent as bob@mail.example") && !said.contains("me@mail.example"), "{said}");
    // The site didn't take it (it isn't there): the sign-in taken for it is let go whole, so the next call asks again,
    // and nothing of it is left in the vault.
    assert!(kept().is_empty(), "{:?}", kept());
    let keep = crate::vault_keep(Ok(node.keys.as_ref())).unwrap();
    assert!(crate::vault::sign_in(&keep, &crate::vault::Ref::parse(&format!("vault:{site}:bob@mail.example")).unwrap()).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&home);
}

/// A node with an agent, for a goal run straight through `do_goal`, and a site on this machine that answers each
/// request with the next of `answers` (status and body), the last one from then on.
fn node_and_site(name: &str, answers: Vec<(u16, &'static str)>) -> (std::path::PathBuf, tokio::runtime::Runtime, Arc<Node>, agents::Agent, u16) {
    use std::io::{BufRead, Write};
    let home = store::scratch_home(name);
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    store::use_home(&home);
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for (n, stream) in site.incoming().flatten().enumerate() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let (status, body) = answers[n.min(answers.len() - 1)];
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
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
    (home, rt, node, a, port)
}

/// A route just learned that fails when it is called hasn't done the goal, whatever the walk saw: the agent hears what
/// failed and gets the page, as for a stored route that failed, not "learned" with an error inside.
#[test]
fn a_route_just_learned_answers_to_the_same_checks_as_a_stored_one() {
    let (home, rt, node, a, port) = node_and_site("learned-is-checked", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#), (500, r#"{"error":"the shelf is down"}"#)]);
    let body = DoBody { goal: "list the items".into(), url: format!("http://127.0.0.1:{port}/api/items"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!(r["how"], "browse", "{r}");
    assert!(r["why"].as_str().unwrap().contains("doesn't answer"), "{r}");
    assert!(r["route_failed"]["route_id"].is_string(), "the agent hears which route failed: {r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A read that came back an error changed nothing: the goal goes on, whether it was the first route tried or the second,
/// and says what failed. Here the call is refused for a value only the agent's ask holds.
#[test]
fn a_read_that_errors_goes_on_wherever_it_stood_in_the_order() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (home, rt, node, a, port) = node_and_site("first-read-errs", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#)]);
    let url = format!("http://127.0.0.1:{port}/api/items?q=lamp");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    assert!(!route.write && route.inputs.iter().any(|i| i.name == "q"), "{:?}", route.inputs);
    let inputs = HashMap::from([("q".to_string(), "vault:shop.example:me".to_string())]);
    let body = DoBody { goal: "search the items".into(), url, inputs, session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") });
    let r = r.expect("the goal went on past the route");
    assert_eq!(r["route_failed"]["route_id"], json!(route.id), "{r}");
    assert!(r["route_failed"]["error"].as_str().unwrap().contains("isn't a secret input"), "{r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// What ends a goal is what the route is, never its place in the order: a write may have landed, and with no page
/// there is nothing to go on to.
#[test]
fn only_a_write_or_a_goal_with_no_page_ends_on_an_error() {
    let mut route = store::Route::from_graph("r".into(), "list items".into(), "https://shop.example/".into(), serde_json::from_value(json!({ "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "fields": [], "needs_browser": false }], "provisional": false })).unwrap()).unwrap();
    assert!(!ends_the_goal(&route, "https://shop.example/"));
    assert!(ends_the_goal(&route, ""));
    route.write = true;
    assert!(ends_the_goal(&route, "https://shop.example/"));
}

/// The rule both a stored route and a learned one are read by. A write's answer stands however it went; a read's has to
/// be there, and be this page's.
#[test]
fn an_answer_is_read_the_same_way_whichever_route_gave_it() {
    let mut route = store::Route::from_graph("r".into(), "list items".into(), "https://shop.example/".into(), serde_json::from_value(json!({ "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "fields": [], "needs_browser": false }], "provisional": false })).unwrap()).unwrap();
    let subject = vec!["bitcoin".to_string()];
    let none = HashMap::new();
    let ask = |subject| Asked { url: "https://shop.example/coins/bitcoin", goal: "list items", subject, reworded: false, sibling: false, given: &none };
    let failed = json!({ "ok": false, "error": "the site answered 500" });
    let empty = json!({ "ok": true, "data": { "items": [] } });
    let others = json!({ "ok": true, "data": [{ "name": "ether" }, { "name": "dogecoin" }] });
    let own = json!({ "ok": true, "data": [{ "name": "bitcoin" }, { "name": "ether" }] });
    let page = json!({ "ok": true, "data": { "title": "Ether price", "text": "ether is up" } });
    assert_eq!(unanswered(&failed, &route, &ask(&[])), Some(json!("the site answered 500")));
    assert!(unanswered(&empty, &route, &ask(&[])).is_some());
    assert!(unanswered(&others, &route, &ask(&subject)).is_some());
    assert!(unanswered(&page, &route, &ask(&subject)).is_some());
    assert_eq!(unanswered(&own, &route, &ask(&subject)), None);
    assert_eq!(unanswered(&failed, &route, &Asked { url: "", ..ask(&[]) }), None, "no page: the answer is what there is");
    route.write = true;
    assert_eq!(unanswered(&failed, &route, &ask(&[])), None, "a write may have landed");
    assert_eq!(unanswered(&page, &route, &ask(&subject)), None, "and is never tried another way for what it answered");
}

#[test]
fn a_goal_can_validate_links_in_markup_before_projecting_the_reply() {
    let cards = (1..=8).map(|id| format!("<li><a href=\"/articles/{id}\">Article {id} {}</a></li>", "related reading ".repeat(20))).collect::<String>();
    let encoded: &'static str = Box::leak(json!({"searchResults":format!("<ul>{cards}</ul>")}).to_string().into_boxed_str());
    let (home, rt, node, agent, port) = node_and_site("drawn-links", vec![(200, encoded)]);
    let goal = "list the links";
    let url = format!("http://127.0.0.1:{port}/articles?q=lamps");
    let mut route = a_lamps_route_on("drawn-links", port);
    route.what = goal.into();
    route.root = url.clone();
    store::save_route(&route).unwrap();
    let ask = DoBody { goal: goal.into(), url, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let reply = rt.block_on(do_goal(&node, &agent, ask)).expect("the stored call returned links");
    assert_eq!(reply["how"], "called", "{reply}");
    assert_eq!(reply["result"]["browser"], false, "{reply}");
    assert_eq!(reply["result"]["data"]["searchResults"]["links"].as_array().map(Vec::len), Some(8), "{reply}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_reworded_goal_keeps_the_links_read_from_markup() {
    let mut saved = route("markup-links", "shop.example", "list article titles", &[]);
    saved.root = "https://shop.example/articles".into();
    let goal = "list article titles and links";
    let inputs = HashMap::new();
    let ask = Asked { url: &saved.root, goal, subject: &[], reworded: true, sibling: false, given: &inputs };
    let cards = (1..=5).map(|id| format!("<li><a href='/articles/{id}'>Article {id} {}</a></li>", "related reading ".repeat(55))).collect::<String>();
    let whole = crate::run::WholeAnswer::from(json!({"homeLink":"/home","searchResults":format!("<ul>{cards}</ul>")}));
    let reply = goal::records_for_ask(json!({"ok":true,"ms":22,"browser":false}), &saved, &ask, &[], Some(&whole));
    let links = reply["data"]["searchResults"]["links"].as_array().expect("the markup was read before projection");
    assert_eq!(links.len(), 5);
    assert_eq!(links[0]["url"], "https://shop.example/articles/1");
    assert_eq!(reply["ms"], 22);
    assert_eq!(reply["browser"], false);
}

#[test]
fn help_links_do_not_replace_the_structured_records_of_a_reworded_goal() {
    let mut saved = route("articles-with-help", "shop.example", "list article titles", &[]);
    saved.root = "https://shop.example/articles".into();
    let goal = "list articles with the title, price and link of each result";
    let inputs = HashMap::new();
    let ask = Asked { url: &saved.root, goal, subject: &[], reworded: true, sibling: false, given: &inputs };
    let results: Vec<_> = (1..=5).map(|id| json!({"title":format!("Article {id}"),"price":"$5.00","url":format!("https://shop.example/articles/{id}")})).collect();
    let help = (1..=5).map(|id| format!("<li><a href='/help/{id}'>Help topic {id} {}</a></li>", "help text ".repeat(65))).collect::<String>();
    let whole = crate::run::WholeAnswer::from(json!({"results":results,"support":format!("<ul>{help}</ul>")}));
    let reply = goal::records_for_ask(json!({"ok":true,"ms":22,"browser":false}), &saved, &ask, &[], Some(&whole));
    assert_eq!(reply["data"]["results"].as_array().map(Vec::len), Some(5));
    assert_eq!(reply["data"]["results"][0]["url"], "https://shop.example/articles/1");

    saved.what = "list articles with the title and price of each result".into();
    let no_links = crate::run::as_a_reply(&saved, &inputs, &[], whole, 22, false);
    assert_eq!(no_links["data"]["results"].as_array().map(Vec::len), Some(5));
    assert_eq!(no_links["data"]["results"][0]["price"], "$5.00");
}

/// A call whose answer says the walk's search and nothing of the one asked answered the walk, whatever its status: some
/// value of the walk's rode along where no input reaches it (a next-page cursor that carries the old search).
#[test]
fn an_answer_that_says_only_the_walks_search_answered_the_walk() {
    let mut r = route("stale", "shop.example", "search listings", &["q"]);
    r.inputs[0].default = Some("macbook air".into());
    let asked = HashMap::from([("q".to_string(), "ipad mini".to_string())]);
    let stale = json!({"results": [{"title": "MacBook Air M2 13"}, {"title": "macbook air 2020"}]});
    let fresh = json!({"results": [{"title": "iPad Mini 6"}, {"title": "MacBook Air sleeve for iPad"}]});
    assert!(goal::answers_the_walk(&r, &asked, &stale, None));
    assert!(!goal::answers_the_walk(&r, &asked, &fresh, None));
    let same = HashMap::from([("q".to_string(), "macbook air".to_string())]);
    assert!(!goal::answers_the_walk(&r, &same, &stale, None), "the walk's own value is no new ask");
}

/// A list that says no word of what the page asks for (a strip of featured cards, every one priced and none named)
/// answers any search alike; one that names the search once, or values with no word to say, are another matter.
#[test]
fn a_list_that_says_no_word_of_the_ask_is_not_its_answer() {
    let given: HashMap<String, String> = [("part0".to_string(), "search".to_string()), ("part1".to_string(), "iphone 15".to_string())].into();
    let strip = json!({"results": [{"price": "876.33", "id": "P126967", "from": "certified-search"}, {"price": "728.00", "id": "P203534"}]});
    assert!(goal::says_none_asked(&strip, &given, "https://www.market.example/search/iphone%2015/", "/api/certified-search"));
    let named = json!({"results": [{"price": "S$999", "title": "iPhone 15 Pro 256gb"}]});
    assert!(!goal::says_none_asked(&named, &given, "https://www.market.example/search/iphone%2015/", "/api/certified-search"));
    let fares = json!({"fares": [{"price": 176.6, "flightNo": "MU546"}]});
    let none = HashMap::new();
    assert!(goal::says_none_asked(&fares, &none, "https://air.example/flights?dcity=sin&acity=tyo&ddate=2026-12-10", "/api/certified-search"));
    assert!(!goal::says_none_asked(&fares, &none, "https://air.example/flights?ddate=2026-12-10&n=2", "/api/certified-search"), "a date has no word to say");
    assert!(!goal::says_none_asked(&json!({"items": [], "total": 0}), &given, "https://www.market.example/search/iphone%2015/", "/api/certified-search"), "an empty list says nothing");
    // A page that repeats what it was searched for, beside a list of everything else, still says nothing of it.
    let mac: HashMap<String, String> = [("part0".to_string(), "search".to_string()), ("part1".to_string(), "macbook air".to_string())].into();
    let echoed = json!({"listing": {"results": []}, "events": [{"props": {"query": "macbook air"}}], "layer": [{"term": "Macbook Air"}], "sections": {"3": {"name": "Skin & Hair Care"}, "4": {"name": "Air Purifiers"}, "5": {"name": "Apple MacBook Accessories"}}, "nav": [{"title": "Computers"}]});
    assert!(goal::says_none_asked(&echoed, &mac, "https://www.market.example/search/macbook%20air/", "/{path[0]}/{path[1]}/"), "an echo of the ask is not its answer");
    let laptops = json!({"results": [{"title": "MacBook Air M2 13in", "price": "S$1,100"}]});
    assert!(!goal::says_none_asked(&laptops, &mac, "https://www.market.example/search/macbook%20air/", "/{path[0]}/{path[1]}/"));
    // A sentence is said by a page that says most of it, the code a site spells out (`TYO` as Tokyo) left out.
    let sentence: HashMap<String, String> = [("q".to_string(), "Flights from SIN to TYO on 2026-12-10 one way".to_string())].into();
    let page = json!({"title": "Singapore to Tokyo", "rows": [{"text": "One way from SIN, 1 stop, S$412"}]});
    assert!(!goal::says_none_asked(&page, &sentence, "https://air.example/travel/flights?q=x", "/travel/flights?q={q}"));
    // One record that is the ask whole, beside its id, is the answer.
    let lamp: HashMap<String, String> = [("q".to_string(), "desk lamp".to_string())].into();
    assert!(!goal::says_none_asked(&json!({"items": [{"id": 1, "name": "desk lamp"}], "total": 1}), &lamp, "https://shop.example/search?q=desk%20lamp", "/api/items"));
    // The caller's one word is a piece of the page's address, and the page carries a setting of its own beside it: the
    // answer is held to the word, never to the setting, which no answer says.
    let climate: HashMap<String, String> = [("search".to_string(), "climate".to_string()), ("page".to_string(), "1".to_string())].into();
    let posts = json!({"results": [{"title": "What the climate models miss", "id": 7}, {"title": "A year of floods", "id": 8}], "more": true});
    let page = "https://letters.example/search/climate?searching=all_posts";
    assert!(!goal::says_none_asked(&posts, &climate, page, "/api/v1/post/search?query={query}&page={page}"), "an answer that says the caller's word answers it");
    let other = json!({"results": [{"title": "Ten sourdough mistakes", "id": 1}, {"title": "A year of floods", "id": 8}]});
    assert!(goal::says_none_asked(&other, &climate, page, "/api/v1/post/search?query={query}&page={page}"), "and one that never says it does not");
    // Records that each carry the ask whole (every restaurant's cuisine) say it.
    let cuisine: HashMap<String, String> = [("cuisine".to_string(), "italian".to_string())].into();
    let places = json!({"places": [{"name": "Da Paolo", "cuisine": "Italian"}, {"name": "Lino", "cuisine": "Italian"}, {"name": "Pasta Bar", "cuisine": "Italian"}]});
    assert!(!goal::says_none_asked(&places, &cuisine, "https://eat.example/find", "/api/find"));
}

/// Two answers that differ only in the words asked are the same answer: the route never heard the value.
#[test]
fn two_answers_differing_only_in_the_asked_words_are_one() {
    let a = json!({"title": "Results for kindle", "items": [{"name": "Lamp shade brass"}, {"name": "Garden chair"}]});
    let b = json!({"title": "Results for coffee", "items": [{"name": "Lamp shade brass"}, {"name": "Garden chair"}]});
    let c = json!({"title": "Results for coffee", "items": [{"name": "Coffee grinder burr"}, {"name": "Espresso cups"}]});
    assert!(goal::same_answer(&a, &b, &["kindle", "coffee"]));
    assert!(!goal::same_answer(&a, &c, &["kindle", "coffee"]));
}

/// The walk that exposed it: a shop whose search page writes the caller's word twice, as a piece of its path in the
/// site's own writing and as a value of its query, and whose call does the same. The route was learned for one word.
/// An address for another word differed in the piece, the piece was "the query's, never the path's", nothing was
/// read from it, and the node walked the page again for every word. A piece the step writes the caller's value into
/// whole is that input's: the address is the route's own page asked another value.
#[test]
fn an_address_whose_piece_and_query_both_hold_the_new_word_is_the_routes_own_page() {
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
        "exchange": 0, "method": "GET", "status": 200, "needs_browser": false,
        "url": "https://www.shop.example/tag/{path[1]}/?data=true&q={q}",
        "fields": [
            {"loc": {"in": "path", "key": 0}, "class": "constant", "value": "tag"},
            {"loc": {"in": "path", "key": 1}, "class": "constant", "value": "lamps"},
            {"loc": {"in": "query", "key": "data"}, "class": "constant", "value": "true"},
            {"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "default": "lamps", "secret": false}
        ],
        "held": [{"loc": {"in": "path", "key": 1}, "input": "q", "sits": "lamps", "written": "dashed"}]
    }], "provisional": false}))
    .unwrap();
    let route = crate::store::Route::from_graph("r".into(), "search the shop".into(), "https://www.shop.example/tag/lamps/?q=lamps".into(), graph).unwrap();
    let read = |address: &str| super::goal::path_inputs(&route, &url::Url::parse(address).unwrap());
    assert_eq!(read("https://www.shop.example/tag/chairs/?q=chairs").get("q").map(String::as_str), Some("chairs"));
    // Two words, written the site's way in the piece: the value is the words.
    assert_eq!(read("https://www.shop.example/tag/floor-lamps/?q=floor-lamps").get("q").map(String::as_str), Some("floor lamps"));
    // Another page of the site is not this one: a piece the step fills from nobody still has to be the page's own.
    assert!(read("https://www.shop.example/brand/chairs/?q=chairs").is_empty());
    assert!(read("https://www.shop.example/tag/chairs/more/?q=chairs").is_empty());

    // A site that writes the caller's word inside marks of its own (`/search/lamps-`): the piece moved between the
    // marks is the page asked another value, and a piece without them is another address.
    let marked: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
        "exchange": 0, "method": "GET", "status": 200, "needs_browser": false,
        "url": "https://www.cook.example/search/{path[1]}",
        "fields": [
            {"loc": {"in": "path", "key": 0}, "class": "constant", "value": "search"},
            {"loc": {"in": "path", "key": 1}, "class": "constant", "value": "chicken-"}
        ],
        "held": [{"loc": {"in": "path", "key": 1}, "input": "search", "sits": "chicken", "written": "plain"}]
    }], "provisional": false}))
    .unwrap();
    let route = crate::store::Route::from_graph("m".into(), "search recipes".into(), "https://www.cook.example/search/chicken-".into(), marked).unwrap();
    let read = |address: &str| super::goal::path_inputs(&route, &url::Url::parse(address).unwrap());
    assert_eq!(read("https://www.cook.example/search/pasta-").get("search").map(String::as_str), Some("pasta"));
    assert_eq!(read("https://www.cook.example/search/gluten-free-pancakes-").get("search").map(String::as_str), Some("gluten-free-pancakes"));
    assert!(read("https://www.cook.example/search/pasta").is_empty(), "without the site's mark it is another address");
    assert!(read("https://www.cook.example/recipes/pasta-").is_empty());
}

/// The walk that exposed it: a shop's search, learned and shown to hear its caller, asked for a name nobody sells.
/// The site answered 404, the call was told it had failed, and the page was walked again to learn the call the node
/// already had: no reply for a quarter of a minute, and on some sites a second route for the same call. Where the
/// route still answers the value it was learned on, the caller is told at once that the site has nothing for this
/// one, as a failure and never as an answer.
#[test]
fn no_answer_for_another_value_from_a_route_that_hears_is_told_at_once() {
    use std::collections::HashMap;
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
        "exchange": 0, "method": "GET", "status": 200, "needs_browser": false, "url": "https://www.shop.example/find?q={q}",
        "fields": [{"loc": {"in": "query", "key": "q"}, "class": "input", "name": "q", "default": "lamps", "secret": false}]
    }], "provisional": false}))
    .unwrap();
    let mut route = crate::store::Route::from_graph("r".into(), "search the shop".into(), "https://www.shop.example/find?q=lamps".into(), graph).unwrap();
    route.write = false;
    route.heard = crate::store::Heard { probed: true, ..Default::default() };
    let said = |q: &str| HashMap::from([("q".to_string(), q.to_string())]);
    let refused = serde_json::json!({"ok": false, "error": "step 1 answered 404"});
    let mut answers = |_: &unbrowse_learn::Graph, v: &HashMap<String, String>| (v["q"] == "lamps").then(|| serde_json::json!({"items": [{"name": "Lamp"}]}));
    let mut never_asked = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| -> Option<serde_json::Value> { panic!("the site is not asked again") };
    let told = super::goal::nothing_for_this_value(&route, &said("zqxv"), &refused, &mut answers).expect("told at once");
    assert_eq!(told["ok"], false);
    assert!(told["error"].as_str().unwrap().contains("404") && told["data"].is_null());
    // Any other failure may be the site walling new asks: it is healed and learned as before.
    for other in ["the target answered, but not in the recorded shape", "step 1 (https://www.shop.example/find?q=zqxv) answered 403: Forbidden", "step 1 met the site's door: answered 200"] {
        assert!(super::goal::nothing_for_this_value(&route, &said("zqxv"), &serde_json::json!({"ok": false, "error": other}), &mut never_asked).is_none(), "{other}");
    }
    // A reply that holds an answer is not this: whether it is the right one is another reader's to say.
    let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| -> Option<serde_json::Value> { panic!("the site is not asked again") };
    assert!(super::goal::nothing_for_this_value(&route, &said("zqxv"), &serde_json::json!({"ok": true, "data": {"items": [{"name": "x"}]}}), &mut never).is_none());
    // The route's own value: its failure is the route's, and the page is learned again.
    assert!(super::goal::nothing_for_this_value(&route, &said("lamps"), &refused, &mut never).is_none());
    // A route the site never showed hears its caller may answer its walked request alone: it is learned again.
    let mut unheard = route.clone();
    unheard.heard = Default::default();
    assert!(super::goal::nothing_for_this_value(&unheard, &said("zqxv"), &refused, &mut never).is_none());
    // The site no longer answers the route's own value either: the route is gone, and the page is learned again.
    let mut silent = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| None;
    assert!(super::goal::nothing_for_this_value(&route, &said("zqxv"), &refused, &mut silent).is_none());
    // A route that writes is never asked again to find out.
    route.write = true;
    assert!(super::goal::nothing_for_this_value(&route, &said("zqxv"), &refused, &mut never).is_none());
}

/// A search that found nothing has no price to show. An answer for another value that lacks what the goal asks of
/// each result is the site's answer to that value where the route, asked again for the value it was learned on,
/// still holds it: the answer is taken, and the page is not walked again to learn from a page with nothing on it
/// (a walk that once kept the site's sponsored strip as the route and retired the one that answered).
#[test]
fn an_answer_without_a_price_for_another_value_is_a_search_that_found_nothing() {
    use std::collections::HashMap;
    let goal = "search products with names and prices";
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
        "exchange": 0, "method": "GET", "status": 200, "needs_browser": false, "url": "https://www.shop.example/s?k={k}",
        "fields": [{"loc": {"in": "query", "key": "k"}, "class": "input", "name": "k", "default": "lamps", "secret": false}]
    }], "provisional": false}))
    .unwrap();
    let mut route = crate::store::Route::from_graph("r".into(), goal.into(), "https://www.shop.example/s?k=lamps".into(), graph).unwrap();
    route.write = false;
    route.heard = crate::store::Heard { probed: true, ..Default::default() };
    let said = |k: &str| HashMap::from([("k".to_string(), k.to_string())]);
    let results = serde_json::json!({"title": "Shop : lamps", "state": null, "text": "1-48 of 341 results for \"lamps\"\nBrass lamp\n$41.00\nDesk lamp\n$18.50\nFloor lamp\n$62.00\nReading lamp\n$12.99\nClip lamp\n$9.00\n", "links": []});
    let empty = serde_json::json!({"title": "Shop : zqxv", "state": null, "text": "No results for zqxv. Try checking your spelling or use more general terms", "links": []});
    assert!(super::goal::holds_goal(&results, goal) && !super::goal::holds_goal(&empty, goal), "the fixture: one page holds prices, the other none");
    // The reason the answer was set aside is the one this reads.
    let given = said("zqxv");
    let ask = super::goal::Asked { url: "https://www.shop.example/s?k=zqxv", goal, subject: &[], reworded: false, sibling: false, given: &given };
    assert_eq!(super::goal::unanswered(&serde_json::json!({"ok": true, "data": empty}), &route, &ask), Some(serde_json::json!(super::goal::LACKS_THE_GOAL)));
    // Asked again for its own value the site still shows prices, and the page asked for shows nothing either: nothing
    // was found for this one. The page is asked for the caller's value, not the route's.
    let mut lists = |_: &unbrowse_learn::Graph, v: &HashMap<String, String>| (v["k"] == "lamps").then(|| results.clone());
    let mut page_empty = |asked: &[String]| {
        assert_eq!(asked, ["zqxv".to_string()], "the page is read for what the caller asked");
        false
    };
    assert!(super::goal::found_nothing_of_the_goal(&route, &said("zqxv"), goal, &mut lists, &mut page_empty));
    // The route's own answer has lost its prices too: the route is at fault, and the page is learned again.
    let mut unread = |_: &[String]| -> bool { panic!("the page is read only when the route still answers its own value") };
    let mut bare = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(empty.clone());
    assert!(!super::goal::found_nothing_of_the_goal(&route, &said("zqxv"), goal, &mut bare, &mut unread));
    // The site does not answer the route's own value either.
    let mut silent = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| None;
    assert!(!super::goal::found_nothing_of_the_goal(&route, &said("zqxv"), goal, &mut silent, &mut unread));
    // The route's own value, a route the site never showed hears, a deaf one and a write: the site is not asked.
    let mut never = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| -> Option<serde_json::Value> { panic!("the site is not asked again") };
    assert!(!super::goal::found_nothing_of_the_goal(&route, &said("lamps"), goal, &mut never, &mut unread));
    let mut unheard = route.clone();
    unheard.heard = Default::default();
    assert!(!super::goal::found_nothing_of_the_goal(&unheard, &said("zqxv"), goal, &mut never, &mut unread));
    let mut deaf = route.clone();
    deaf.heard = crate::store::Heard { probed: true, deaf: vec!["k".into()], ..Default::default() };
    assert!(!super::goal::found_nothing_of_the_goal(&deaf, &said("zqxv"), goal, &mut never, &mut unread));
    route.write = true;
    assert!(!super::goal::found_nothing_of_the_goal(&route, &said("zqxv"), goal, &mut never, &mut unread));
}

#[test]
fn a_browserless_page_replay_preserves_its_explicit_empty_search_evidence() {
    let graph = serde_json::from_value(serde_json::json!({"provisional":false,"steps":[{"exchange":0,"method":"GET","status":200,
        "needs_browser":false,"url":"https://shop.example/s?k={k}",
        "fields":[{"loc":{"in":"query","key":"k"},"class":"input","name":"k","default":"lamps","secret":false}]}]})).unwrap();
    let goal = "search products with names and prices";
    let route = crate::store::Route::from_graph("r".into(), goal.into(), "https://shop.example/s?k=lamps".into(), graph).unwrap();
    let given = std::collections::HashMap::from([("k".into(), "zqxv".into())]);
    let ask = super::goal::Asked { url: "https://shop.example/s?k=zqxv", goal, subject: &[], reworded: false, sibling: false, given: &given };
    let search = serde_json::json!({"context":{"query":"zqxv"},"listingCards":[],"numberOfResults":0,"pending":false,"error":null});
    let data = serde_json::json!({"search":search,"chrome":{"theme":"light","script":"y".repeat(64_000)}});
    let reply = serde_json::json!({"ok":true,"browser":false,"ms":4250,"data":{"chrome":{"theme":"light"}}});
    let reason = Some(super::goal::LACKS_THE_GOAL);
    let fields = ["chrome.theme".into()];
    let answered = super::goal::empty_page_reply(&reply, &route, &ask, Some(&data.clone().into()), &fields, reason).expect("the page completed an empty search");
    assert_eq!(answered["outcome"], "answered_empty");
    assert_eq!(answered["how"], "called");
    assert_eq!(answered["result"]["browser"], false);
    assert_eq!(answered["result"]["records"], 0);
    assert_eq!(answered["result"]["ms"], 4250);
    assert_eq!(answered["result"]["data"]["search"], search);
    assert_eq!(answered["result"]["data"]["chrome"]["theme"], "light");

    let mut side_call = route.clone();
    side_call.graph.steps[0].url = "https://shop.example/api/featured?k={k}".into();
    assert!(super::goal::empty_page_reply(&reply, &side_call, &ask, Some(&data.clone().into()), &fields, reason).is_none());
    let mut browsed = reply.clone();
    browsed["browser"] = serde_json::json!(true);
    let completed = super::goal::empty_page_reply(&browsed, &route, &ask, Some(&data.clone().into()), &fields, reason).unwrap();
    assert_eq!(completed["result"]["browser"], true);
    assert_eq!(completed["result"]["records"], 0);
}

/// UNB-165. Carousell's search page lists dozens of MacBook Airs, and beside them calls its strip of certified
/// products, which a walk for `iphone 15` kept as the route. For `macbook air` the strip is empty: no price, so the
/// goal is lacked, and the strip still answers `iphone 15`. Before this the node took that as a search that found
/// nothing and answered `ok` with nothing for every such search; the page the caller named lists the value, so the
/// strip's empty answer is the strip's, and the page is learned again.
#[test]
fn an_empty_answer_from_a_call_beside_a_page_that_lists_the_value_is_not_a_search_that_found_nothing() {
    use std::collections::HashMap;
    let goal = "search listings with titles and prices";
    let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({"steps": [{
        "exchange": 0, "method": "POST", "status": 200, "needs_browser": false,
        "url": "https://www.market.example/aps/cf/1.0/certified-search/?l=en",
        "body": {"kind": "json", "template": {"query": {"queryString": null}}, "types": {"/query/queryString": "string"}},
        "fields": [{"loc": {"in": "json", "key": "/query/queryString"}, "class": "input", "name": "search", "default": "iphone 15", "secret": false}]
    }], "provisional": false}))
    .unwrap();
    let mut route = crate::store::Route::from_graph("strip".into(), goal.into(), "https://www.market.example/search/iphone%2015/".into(), graph).unwrap();
    route.write = false;
    route.heard = crate::store::Heard { probed: true, ..Default::default() };
    let said = |v: &str| HashMap::from([("search".to_string(), v.to_string())]);
    // The strip's answers, as the site sent them: priced cards for its own value, none for this one.
    let strip = serde_json::json!({"results": [
        {"productCard": {"title": "iPhone 15 128GB Certified", "price": "S$799"}},
        {"productCard": {"title": "iPhone 15 Pro 256GB Certified", "price": "S$1,099"}}
    ], "pagination": {}, "isSupported": true});
    let empty = serde_json::json!({"results": [], "pagination": {}, "isSupported": true});
    let given = said("macbook air");
    let ask = super::goal::Asked { url: "https://www.market.example/search/macbook%20air/", goal, subject: &[], reworded: false, sibling: false, given: &given };
    assert_eq!(super::goal::unanswered(&serde_json::json!({"ok": true, "data": empty}), &route, &ask), Some(serde_json::json!(super::goal::LACKS_THE_GOAL)), "the strip's empty answer lacks the goal");
    let mut own = |_: &unbrowse_learn::Graph, v: &HashMap<String, String>| (v["search"] == "iphone 15").then(|| strip.clone());
    // The page lists the value: the site found plenty, and the strip's nothing is not its answer.
    let mut page_lists = |asked: &[String]| asked == ["macbook air".to_string()];
    assert!(!super::goal::found_nothing_of_the_goal(&route, &given, goal, &mut own, &mut page_lists));
    // Where the page shows nothing for the value either, the site found nothing, and that is the answer.
    let mut page_empty = |_: &[String]| false;
    assert!(super::goal::found_nothing_of_the_goal(&route, &said("zqdqxmhdqsfv"), goal, &mut own, &mut page_empty));
}

/// A site on this machine for a pair of searches, as Carousell answered them on 17 November 2026: its strip of certified
/// products (POST /aps/cf/1.0/certified-search/) holds priced cards for `iphone 15` and none for anything else, and its
/// search page (/search/?q=<value>) lists priced results that say the value back. Returns the port.
fn a_market_with_a_strip_beside_its_results() -> u16 {
    use std::io::{BufRead, Read, Write};
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in site.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
            }
            let mut sent = vec![0u8; length];
            let _ = reader.read_exact(&mut sent);
            let sent = String::from_utf8_lossy(&sent).to_string();
            let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
            let body = if path.starts_with("/aps/cf/1.0/certified-search/") {
                match sent.contains("iphone 15") {
                    true => json!({"results": [
                        {"productCard": {"title": "iPhone 15 128GB Certified", "price": "S$799"}},
                        {"productCard": {"title": "iPhone 15 Pro 256GB Certified", "price": "S$1,099"}},
                        {"productCard": {"title": "iPhone 15 Plus 128GB Certified", "price": "S$899"}}
                    ], "pagination": {}, "isSupported": true}),
                    false => json!({"results": [], "pagination": {}, "isSupported": true}),
                }
            } else if let Some(value) = path.strip_prefix("/search/?q=").map(|v| v.replace("%20", " ").replace('+', " ")) {
                let named = |n: usize| match value.as_str() {
                    "macbook air" => format!("MacBook Air M{} 13-inch", n % 4 + 1),
                    "iphone 15" => format!("iPhone 15 {} GB", 128 * (n % 3 + 1)),
                    _ => format!("Listing {n}"),
                };
                let cards: Vec<Value> = (0..12).map(|n| json!({"id": format!("l{n}"), "title": named(n), "price": format!("S${}", 400 + 25 * n), "seller": format!("seller{n}")})).collect();
                json!({"query": value, "listings": cards})
            } else {
                json!({"error": "no such page"})
            };
            let body = body.to_string();
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    port
}

/// UNB-165, the whole way through `do_goal`: each search gets its own listings. A route kept from a walk for `iphone
/// 15` (the strip beside the results) answers `iphone 15` with its iPhones; asked for `macbook air`, the strip is empty
/// while the page lists MacBook Airs, so the answer is the page's MacBook Airs, never an `ok` with nothing in it and
/// never the iPhones. Red on staging before #591 (f5d63f00): the second search answered `ok` with an empty list.
#[test]
fn each_search_gets_its_own_listings_not_an_empty_strip_beside_them() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (home, rt, node, a, _) = node_and_site("each-search-its-own", vec![(200, "{}")]);
    let port = a_market_with_a_strip_beside_its_results();
    let goal = "search listings with titles and prices";
    let graph: unbrowse_learn::Graph = serde_json::from_value(json!({"steps": [{
        "exchange": 0, "method": "POST", "status": 200, "needs_browser": false, "on_load": true,
        "url": format!("http://127.0.0.1:{port}/aps/cf/1.0/certified-search/?l=en"),
        "body": {"kind": "json", "template": {"query": {"queryString": null}}, "types": {"/query/queryString": "string"}},
        "fields": [{"loc": {"in": "json", "key": "/query/queryString"}, "class": "input", "name": "q", "default": "iphone 15", "secret": false}]
    }], "provisional": false}))
    .unwrap();
    let mut route = crate::store::Route::from_graph("strip".into(), goal.into(), format!("http://127.0.0.1:{port}/search/?q=iphone%2015"), graph).unwrap();
    route.write = false;
    route.heard = crate::store::Heard { probed: true, ..Default::default() };
    store::save_route(&route).unwrap();
    // The kept route is the one this page's goal finds, and it does the page for another value: the page differs from
    // the one it was learned on only in the value the route takes.
    let page = format!("http://127.0.0.1:{port}/search/?q=macbook%20air");
    let routes = store::load_routes();
    let found = super::goal::reads_only(super::goal::routes_for(&routes, goal, &page), goal);
    assert!(found.len() == 1 && super::goal::fits(found[0], &page), "the kept strip is the page's read for another value");
    let ask = |value: &str| DoBody {
        goal: goal.into(),
        url: format!("http://127.0.0.1:{port}/search/?q={}", value.replace(' ', "%20")),
        inputs: HashMap::new(),
        session: String::new(),
        browser: "never".into(),
        fields: Vec::new(),
        many: true,
        budget_usdc: None,
    };
    let titles = |r: &Value| -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![r["result"].clone()];
        while let Some(v) = stack.pop() {
            match v {
                Value::Object(o) => {
                    if let Some(t) = o.get("title").and_then(|t| t.as_str()) {
                        out.push(t.to_string());
                    }
                    stack.extend(o.into_iter().map(|(_, v)| v));
                }
                Value::Array(items) => stack.extend(items),
                _ => {}
            }
        }
        out
    };
    let (n, b) = (node.clone(), a.clone());
    let first = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&n, &b, ask("iphone 15"))).await.expect("answered") }).expect("the first search is answered");
    let said = titles(&first);
    assert!(said.iter().any(|t| t.contains("iPhone 15")) && !said.iter().any(|t| t.contains("MacBook")), "the first search answers its iPhones: {first}");
    let second = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, ask("macbook air"))).await.expect("answered") }).expect("the second search is answered");
    let said = titles(&second);
    assert!(said.iter().filter(|t| t.contains("MacBook Air")).count() >= 10, "the second search answers its own MacBook Airs, not an empty strip: {second}");
    assert!(!said.iter().any(|t| t.contains("iPhone")), "and none of the first search's iPhones: {second}");
    let _ = std::fs::remove_dir_all(&home);
}


/// A node with an agent and its token, for a tool asked over MCP or HTTP.
fn node_with_a_token(name: &str) -> (std::path::PathBuf, tokio::runtime::Runtime, Arc<Node>, HeaderMap) {
    let home = store::scratch_home(name);
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    store::use_home(&home);
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let (a, _) = agents::create(&keys, "agent", 1.0, 30, 7788).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(&keys).unwrap(), &a);
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
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    (home, rt, node, headers)
}

/// Every reply of a tool that names its outcome names its ask too, answered or failed, over MCP and HTTP alike: an id
/// of its own each time (`ask_` and 16 hex digits), and the one its line in `asks.jsonl` says, with the reply's
/// outcome and nothing of what was asked.
#[test]
fn every_reply_carries_its_ask_id() {
    let (home, rt, node, headers) = node_with_a_token("every-reply-ask");
    let site = crate::run::test_site(vec![("/api/items", 200, "application/json", r#"{"items":[{"id":1,"name":"desk lamp"}]}"#.to_string())]);
    let url = format!("http://127.0.0.1:{site}/api/items?q=lamp");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    let over_mcp = |id: u64, tool: &str, args: Value| {
        let (n, h) = (node.clone(), headers.clone());
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
        serde_json::from_str::<Value>(m["result"]["content"][0]["text"].as_str().unwrap_or("null")).unwrap()
    };
    let over_http = |tool: &str, args: Value| {
        let p = PRIMITIVES.iter().find(|p| p.tool == tool).unwrap();
        let (n, h, body) = (node.clone(), headers.clone(), args.to_string());
        rt.block_on(async move { answer_http(p, n, h, HashMap::new(), HashMap::new(), body.as_bytes()).await }).1 .0
    };
    let replies = [
        over_mcp(1, "unbrowse_call", json!({ "route_id": route.id, "inputs": { "q": "lamp" } })),
        over_mcp(2, "unbrowse_call", json!({ "route_id": "nothing-by-this-id" })),
        over_mcp(3, "unbrowse_do", json!({ "goal": "search the items", "url": url, "browser": "never" })),
        over_mcp(4, "unbrowse_do", json!({ "goal": "book a table" })),
        over_http("unbrowse_do", json!({ "goal": "search the items", "url": url, "browser": "never" })),
        over_http("unbrowse_do", json!({ "goal": "book a table" })),
    ];
    let mut ids = std::collections::BTreeSet::new();
    for r in &replies {
        let id = r["ask"].as_str().unwrap_or_else(|| panic!("names its ask: {r}"));
        assert!(id.len() == 20 && id.starts_with("ask_") && id[4..].chars().all(|c| c.is_ascii_hexdigit()), "{id}");
        assert!(ids.insert(id.to_string()), "an id of its own: {id}");
        let lines = super::asks::tests::events(&home, id);
        let events: Vec<&str> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
        assert_eq!(&events[..2], ["started", "reply"], "{lines:?}");
        assert_eq!(lines[1]["outcome"], r["outcome"], "the log says the reply's outcome: {lines:?}");
        let said = serde_json::to_string(&lines).unwrap();
        assert!(!said.contains("lamp") && !said.contains("table") && !said.contains("127.0.0.1"), "names and shapes only: {said}");
    }
    assert_eq!(replies[0]["outcome"], "answered", "{}", replies[0]);
    assert_eq!(replies[3]["outcome"], "no_route", "{}", replies[3]);
    // A tool that names no outcome names no ask either.
    assert!(over_mcp(9, "unbrowse_whoami", json!({})).get("ask").is_none());
    let _ = std::fs::remove_dir_all(&home);
}

/// The outcome a reply names, held to the closed set: one word of it, the reader that decided it, and a next that is
/// a call (`{tool, args}`) or absent, never a sentence.
fn names_one_outcome(v: &Value) -> crate::outcome::Outcome {
    let words: Vec<&str> = crate::outcome::Outcome::ALL.iter().map(|o| o.word()).collect();
    assert!(v["outcome"].as_str().is_some_and(|w| words.contains(&w)), "an outcome of the set: {v}");
    assert!(v["outcome_from"].as_str().is_some_and(|f| !f.is_empty()), "and its reader: {v}");
    if let Some(next) = v.get("next") {
        assert!(next["tool"].as_str().is_some_and(|t| crate::outcome::NEXT_TOOLS.contains(&t)) && next["args"].is_object(), "next is a call: {v}");
    }
    crate::outcome::Outcome::of(v).unwrap()
}

/// Every reply unbrowse_do makes names one outcome of the closed set: each shape it builds (a route called, learned,
/// from the network, cut, failed; a page that needs hands; several pages; each failure it answers with), and what a
/// goal run through `do_goal` answers, answered or failed.
#[test]
fn every_do_reply_names_one_outcome() {
    use crate::outcome::{stamp, Failed, Outcome};
    let types = crate::apischema::types();
    let route = json!({ "id": "r", "site": "shop.example", "what": "search the shop", "method": "GET", "path": "/api/items", "write": false, "listed": false, "yours": true, "inputs": [] });
    let result = |ok: bool, truncated: Value| json!({ "ok": ok, "ms": 3, "data": if ok { json!([{ "name": "desk lamp" }]) } else { Value::Null },
        "error": if ok { Value::Null } else { json!("the site answered 500") }, "paid_usdc": 0.0, "paid_unb": 0.0, "possible_commit": false, "retry": "as_is", "truncated": truncated });
    let cut = json!({ "kept_bytes": 10, "total_bytes": 90, "cuts": [], "whole": null, "note": "cut" });
    let entry = json!({ "id": "0xe", "contributor": "0xc", "fee": 0.01, "listed_as": { "site": "shop.example", "what": "search" }, "reputation": { "default": true, "unverified": false, "counted_uses": 1, "pass_rate": 1.0, "unavailable": false, "version": 1, "rank_version": 1 } });
    let shapes = [
        (json!({ "how": "called", "route": route, "result": result(true, Value::Null) }), Outcome::Answered),
        (json!({ "how": "learned", "picked_by": "the walk", "route": route, "result": result(true, cut.clone()) }), Outcome::AnsweredCut),
        (json!({ "how": "called", "route": route, "result": result(false, Value::Null) }), Outcome::CallFailed),
        (json!({ "how": "called", "route": route, "result": { "ok": true, "ms": 3, "data": { "results": [], "total": 0 }, "error": null, "paid_usdc": 0.0, "paid_unb": 0.0, "possible_commit": false, "retry": "as_is", "truncated": null } }), Outcome::AnsweredEmpty),
        (json!({ "how": "network", "entry": entry, "result": result(true, Value::Null) }), Outcome::Answered),
        (json!({ "how": "pages", "ms": 5, "count": { "called": 1 }, "pages": [{ "url": "https://shop.example/?q=lamp", "how": "called", "ms": 4, "ok": true, "outcome": "answered", "outcome_from": "result.ok" }], "fields": {} }), Outcome::Answered),
    ];
    for (shape, want) in shapes {
        let mut r = Ok(shape);
        stamp("unbrowse_do", &mut r);
        let r = r.unwrap();
        assert_eq!(names_one_outcome(&r), want, "{r}");
        crate::apischema::check(&crate::apischema::r("DoResult"), &r, &types).unwrap_or_else(|e| panic!("{r}: {e}"));
    }
    // Each status a do fails with names one too, over either surface (`answer_of`).
    for status in [400, 402, 403, 404, 408, 409, 410, 422, 424, 500, 502, 503] {
        let mut r: Result<Value, Failed> = Err(Failed::from((StatusCode::from_u16(status).unwrap(), "words".to_string())));
        stamp("unbrowse_do", &mut r);
        let (_, body) = answer_of(&r.unwrap_err());
        names_one_outcome(&body);
        assert_eq!(body["error"], "words", "the words stay: {body}");
    }

    // What a goal run through do_goal answers: a route called; a learned call that fails, said among several pages
    // as one that needs hands, with the call that opens it; nothing to do it and no page; no goal; no such browser.
    let (home, rt, node, a, port) = node_and_site("every-do-reply", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#)]);
    let url = format!("http://127.0.0.1:{port}/api/items?q=lamp");
    let crate::learn::Plain::Route(_) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    let ask = |goal: &str, url: &str, browser: &str, many: bool| {
        let (n, a) = (node.clone(), a.clone());
        let body = DoBody { goal: goal.into(), url: url.into(), inputs: HashMap::new(), session: String::new(), browser: browser.into(), fields: Vec::new(), many, budget_usdc: None };
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal_said(&n, &a, body)).await.expect("answered") })
    };
    let called = ask("search the items", &url, "never", false).expect("the route answers");
    assert_eq!((called["how"].as_str(), names_one_outcome(&called)), (Some("called"), Outcome::Answered), "{called}");
    let failed = |r: Result<Value, Failed>| {
        let f = r.expect_err("a failure");
        let (_, body) = answer_of(&f);
        (names_one_outcome(&body), body)
    };
    let (none, body) = failed(ask("book a table", "", "never", false));
    assert_eq!(none, Outcome::NoRoute, "{body}");
    assert_eq!(body["next"], json!({ "tool": "unbrowse_search", "args": { "query": "book a table" } }), "{body}");
    assert_eq!(failed(ask("  ", &url, "never", false)).0, Outcome::BadRequest);
    assert_eq!(failed(ask("search the items", &url, "sometimes", false)).0, Outcome::BadRequest);
    let _ = std::fs::remove_dir_all(&home);

    let (home, rt, node, a, port) = node_and_site("every-do-reply-hands", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#), (500, r#"{"error":"the shelf is down"}"#)]);
    let page = format!("http://127.0.0.1:{port}/api/items");
    let body = DoBody { goal: "list the items".into(), url: page.clone(), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true , budget_usdc: None};
    let hands = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal_said(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!((hands["how"].as_str(), names_one_outcome(&hands)), (Some("browse"), Outcome::NeedsHands), "{hands}");
    assert_eq!(hands["next"], json!({ "tool": "unbrowse_do", "args": { "goal": "list the items", "url": page } }), "the call that opens it: {hands}");
    assert!(hands["why"].as_str().unwrap().contains("doesn't answer"), "the prose stays in why: {hands}");
    let one = page_answer(&page, std::time::Duration::from_millis(1), Ok(hands));
    assert_eq!(names_one_outcome(&one), Outcome::NeedsHands, "a page among several says it too: {one}");
    let _ = std::fs::remove_dir_all(&home);
}

/// Over MCP a failure is the text of an error, and keeps what it came to beside its words: the outcome, its reader and
/// the next call, as HTTP gives them with the status.
#[test]
fn an_error_over_mcp_keeps_its_outcome() {
    let (home, rt, node, headers) = node_with_a_token("error-keeps-outcome");
    let (n, h) = (node.clone(), headers.clone());
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "unbrowse_do", "arguments": { "goal": "book a table" } } });
    let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
    assert_eq!(m["result"]["isError"], true, "{m}");
    let said: Value = serde_json::from_str(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert!(said["error"].as_str().unwrap().starts_with("no route does that yet"), "the words stay: {said}");
    assert_eq!((said["outcome"].as_str(), said["outcome_from"].as_str()), (Some("no_route"), Some("routes")), "{said}");
    assert_eq!(said["next"], json!({ "tool": "unbrowse_search", "args": { "query": "book a table" } }), "{said}");
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_do").unwrap();
    let (n, h) = (node.clone(), headers.clone());
    let (status, Json(mut over_http)) = rt.block_on(async move { answer_http(p, n, h, HashMap::new(), HashMap::new(), br#"{"goal":"book a table"}"#).await });
    // Each is an ask of its own, and names its own (`asks`): the rest is the same.
    let mut said = said;
    assert!(said["ask"].as_str().is_some() && over_http["ask"].as_str().is_some() && said["ask"] != over_http["ask"], "{said} {over_http}");
    said.as_object_mut().unwrap().remove("ask");
    over_http.as_object_mut().unwrap().remove("ask");
    assert_eq!((status, over_http), (StatusCode::NOT_FOUND, said), "HTTP says the same, with its status");
    // A tool whose failure nothing read more of names it by its status.
    let (n, h) = (node.clone(), headers.clone());
    let msg = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": "unbrowse_call", "arguments": { "route_id": "nothing-by-this-id" } } });
    let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
    let said: Value = serde_json::from_str(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!((said["outcome"].as_str(), said["outcome_from"].as_str()), (Some("no_route"), Some("status")), "{said}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A warm call's outcome is its own answer's: `ok`, and whether it was cut. Nothing else is read, and nothing is
/// asked of the site to say it.
#[test]
fn a_warm_call_reads_its_outcome_from_its_own_answer() {
    use crate::outcome::{outcome_of, Outcome};
    let answered = json!({ "ok": true, "ms": 2, "data": [{ "name": "desk lamp" }], "error": null, "truncated": null });
    let said = outcome_of("unbrowse_call", &answered);
    assert_eq!((said.outcome, said.from, said.next), (Outcome::Answered, "call.ok", None));
    let cut = json!({ "ok": true, "data": [], "truncated": { "kept_bytes": 1, "total_bytes": 2 } });
    assert_eq!(outcome_of("unbrowse_call", &cut).outcome, Outcome::AnsweredCut);
    let failed = json!({ "ok": false, "data": null, "error": "the site answered 500", "retry": "as_is" });
    assert_eq!(outcome_of("unbrowse_call", &failed).outcome, Outcome::CallFailed);

    // And the call as an agent makes it: the route's answer, and its outcome beside it.
    let (home, rt, node, a, port) = node_and_site("warm-call-outcome", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#)]);
    let url = format!("http://127.0.0.1:{port}/api/items?q=lamp");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_call").unwrap();
    let args = json!({ "route_id": route.id, "inputs": { "q": "lamp" } });
    let r = rt.block_on(async move { run_primitive(p, &node, &a, args, "unbrowse_call").await }).expect("the call ran");
    assert_eq!(r["ok"], true, "{r}");
    assert_eq!((r["outcome"].as_str(), r["outcome_from"].as_str()), (Some("answered"), Some("call.ok")), "{r}");
    assert!(r.get("next").is_none(), "nothing to do next: {r}");
    crate::apischema::check(&crate::apischema::r("CallResult"), &r, &crate::apischema::types()).unwrap_or_else(|e| panic!("{r}: {e}"));
    let _ = std::fs::remove_dir_all(&home);
}

/// `paused` is the owner's pause and nothing else: every step it stops says it in the pause's words, and a failure of
/// the same status for another cause is not: the node waiting on the owner to let it read its key is theirs to give
/// (`needs_person`), and the vault unread, an entry off the ranking, a key moved to another payer are a step that
/// failed, said with its own words.
#[test]
fn paused_is_said_only_when_the_owner_paused_the_node() {
    use crate::outcome::{of_failure, stamp, Failed, Outcome, PAUSED};
    let unavailable = StatusCode::SERVICE_UNAVAILABLE;
    for tool in crate::outcome::TOOLS {
        let said = of_failure(tool, unavailable, PAUSED);
        assert_eq!((said.outcome, said.from), (Outcome::Paused, "settings.paused"), "{tool}");
        let said = of_failure(tool, unavailable, crate::WAITING_FOR_KEY);
        assert_eq!((said.outcome, said.from), (Outcome::NeedsPerson, "node.locked"), "{tool}: the owner lets the node read its key");
        for other in ["The root key couldn't be read (gone); the node tries again by itself.", "the vault's passwords for shop.example can't be read (denied), so the node can't hide them", "no node served this entry's body lately, so it is off the ranking until epoch 9", "this agent's key moved to another payer as the call began"] {
            let said = of_failure(tool, unavailable, other);
            assert_eq!((said.outcome, said.from), (Outcome::CallFailed, "status"), "{tool}: {other}");
            let mut r: Result<Value, Failed> = Err(Failed::from((unavailable, other.to_string())));
            stamp(tool, &mut r);
            let (status, body) = answer_of(&r.unwrap_err());
            assert_eq!((status, body["outcome"].as_str(), body["error"].as_str()), (unavailable, Some("call_failed"), Some(other)), "{body}");
        }
    }

    // And as each tool says it when the owner has paused the node: a do, a call, a step of the browser.
    let (home, rt, node, a, _) = node_and_site("paused-said", vec![(200, "{}")]);
    store::save_settings(&store::Settings { paused: true, ..store::load_settings() }).unwrap();
    for (tool, args) in [("unbrowse_do", json!({ "goal": "search the items", "url": "https://shop.example/search" })), ("unbrowse_call", json!({ "route_id": "r1" }))] {
        let p = PRIMITIVES.iter().find(|p| p.tool == tool).unwrap();
        let (n, a) = (node.clone(), a.clone());
        let f = rt.block_on(async move { run_primitive(p, &n, &a, args, tool).await }).expect_err("paused");
        let (status, body) = answer_of(&f);
        assert_eq!((status, body["outcome"].as_str(), body["outcome_from"].as_str()), (unavailable, Some("paused"), Some("settings.paused")), "{tool}: {body}");
    }
    let (n, a2) = (node.clone(), a.clone());
    let f = rt.block_on(async move { super::browse::ask_owner(&n, &a2, &["ask_owner".into(), "sign in".into()], "shop.example", "s").await }).expect_err("paused");
    let mut r: Result<Value, Failed> = Err(Failed::from(f));
    stamp("unbrowse_browse", &mut r);
    assert_eq!(answer_of(&r.unwrap_err()).1["outcome"], "paused");
    let _ = std::fs::remove_dir_all(&home);
}

/// A `next` is a call an agent can make as given: a tool the node has, arguments its schema names, the ones it
/// requires present, and no placeholder for the agent to fill (`<a page>`). Each place that builds one is asked.
#[test]
fn every_next_is_a_call_that_can_be_made_as_given() {
    use crate::learn::Unlearned;
    use crate::outcome::{outcome_of, Said};
    let callable = |said: &Said| {
        let Some(next) = &said.next else { return };
        let tool = next["tool"].as_str().filter(|t| crate::outcome::NEXT_TOOLS.contains(t)).unwrap_or_else(|| panic!("a tool a next may name: {next}"));
        let p = PRIMITIVES.iter().find(|p| p.tool == tool).unwrap_or_else(|| panic!("a tool the node has: {next}"));
        let schema = (p.schema)();
        let args = next["args"].as_object().unwrap_or_else(|| panic!("arguments: {next}"));
        for (k, v) in args {
            assert!(schema["properties"].get(k).is_some(), "{tool} takes {k}: {next}");
            assert!(!v.is_null(), "{k} is given: {next}");
            let text = v.to_string();
            assert!(!text.contains('<') && !text.contains('>'), "no placeholder in {k}: {next}");
        }
        assert!(missing_arg(p, &next["args"]).is_none(), "what {tool} requires is given: {next}");
    };
    let (goal, url) = ("list the items", "https://shop.example/items");
    let kinds = [
        Unlearned::Loading,
        Unlearned::Hands("the page needs a click".into()),
        Unlearned::Door("the door held".into(), "trace.door"),
        Unlearned::SignIn("it sent the page to its sign-in".into(), "answer.sent_to_sign_in"),
        Unlearned::Check("the page asks for a person".into(), "challenge.asks_a_person"),
    ];
    for why in &kinds {
        for (site, owner) in [(None, false), (Some("shop.example"), true), (Some("shop.example"), false)] {
            callable(&goal::hands_said(why, goal, url, site, owner));
        }
        callable(goal::stopped(why, url).said.as_ref().unwrap());
    }
    callable(&outcome_of("unbrowse_challenge", &json!({ "site": "shop.example", "asks": true })));
    use crate::browse::Came;
    for came in [Came::Unchanged, Came::Walled { at: "https://shop.example/login?next=%2Fa".into() }, Came::SignIn { at: "https://shop.example/login".into() }, Came::Check { at: "https://shop.example/a".into() }, Came::Gone { status: 404 }, Came::Gone { status: 0 }] {
        for can_ask in [true, false] {
            callable(&super::browse::came_said(&came, "shop.example", can_ask).expect("not done").outcome);
        }
    }

    // The goal with no page and no route: the call to make next is a search, never an address to fill in.
    let (home, rt, node, a, _) = node_and_site("every-next-callable", vec![(200, "{}")]);
    let body = DoBody { goal: "book a table".into(), url: String::new(), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: false , budget_usdc: None};
    let f = rt.block_on(async move { do_goal_said(&node, &a, body).await }).expect_err("no route");
    let said = f.said.expect("said");
    assert_eq!(said.next.as_ref().unwrap()["tool"], "unbrowse_search");
    callable(&said);
    let _ = std::fs::remove_dir_all(&home);
}

/// A line of a site's browsing log as the browser writes one: an exchange, with its resource type and its answer.
fn capture_line(kind: &str, url: &str, status: u16, body: Option<&str>) -> String {
    let mut content = json!({ "mimeType": if kind == "Document" { "text/html" } else { "application/json" } });
    if let Some(body) = body {
        content["text"] = json!(body);
    }
    json!({ "type": "exchange", "t": 1794700000.5, "resourceType": kind,
        "entry": { "request": { "method": "GET", "url": url, "headers": [] }, "response": { "status": status, "headers": [], "content": content }, "_resourceType": kind } })
    .to_string()
}

/// What a browse step that landed on `at` came to, and what its reply says, read from the step's lines.
fn landed_reply(verb: &str, asked: Option<&str>, at: Option<&str>, lines: &[String]) -> (crate::browse::Came, Option<super::browse::Landed>) {
    let lines = lines.join("\n") + "\n";
    let after = at.map(|u| crate::browse::Look { url: u.into(), content: 1 });
    let landed = at.or(asked).and_then(|u| crate::browse::landed_in(&lines, u));
    let came = crate::browse::came_to_page(verb, asked, None, after.as_ref(), landed.as_ref());
    let said = super::browse::came_said(&came, "shop.example", true);
    (came, said)
}

/// An open that lands on the site's error page, or on the browser's own page for a site it couldn't reach, is gone,
/// never ticked as done: the main document's status says it, read from the step's own lines of the browsing log.
/// A frame's document and the page's calls beside it say nothing of where the tab landed.
#[test]
fn an_open_that_lands_on_an_error_page_says_gone() {
    let page = "https://shop.example/item/7";
    let missing = "<html><head><title>Not found</title></head><body><h1>Page not found</h1><p>The item may have moved.</p><a href=\"/\">Home</a> <a href=\"/search\">Search</a></body></html>";
    let lines = [
        capture_line("Document", "https://ads.example/frame", 200, Some("<html><body>ad</body></html>")),
        capture_line("Document", page, 404, Some(missing)),
        capture_line("XHR", "https://shop.example/api/cart", 200, Some("{\"items\":[]}")),
    ];
    let (came, said) = landed_reply("open", Some(page), Some(&format!("{page}#top")), &lines);
    assert_eq!(came, crate::browse::Came::Gone { status: 404 });
    let said = said.expect("not done");
    assert_eq!((said.outcome.outcome, said.outcome.from, said.outcome.next.is_none(), said.needs_owner), (crate::outcome::Outcome::Gone, "browse.landed.status", true, false));
    assert!(said.said.contains("404") && !said.said.starts_with('✓'), "{}", said.said);
    // No answer at all: the browser shows its own page, so the tab names none of the site's, and the page asked for
    // has a document that never got a status.
    let (came, said) = landed_reply("open", Some(page), None, &[capture_line("Document", page, 0, None)]);
    assert_eq!(came, crate::browse::Came::Gone { status: 0 });
    assert!(said.unwrap().said.contains("didn't load"));
    // The page itself, as asked: done, as before.
    let found = "<html><head><title>Brass desk lamp</title></head><body><h1>Brass desk lamp</h1><a href=\"/\">Home</a></body></html>";
    assert_eq!(landed_reply("open", Some(page), Some(page), &[capture_line("Document", page, 200, Some(found))]).0, crate::browse::Came::Done);
    // And with nothing in the step's lines, the addresses say it, as they did.
    assert_eq!(landed_reply("open", Some(page), Some(page), &[]).0, crate::browse::Came::Done);
}

/// The walk that exposed it: an open of a page the site has not got landed first on a page that only loads its own
/// code (a notice for a browser without scripts, an error kept hidden, a loader), and a second later on the site's 404
/// at the same address. The reply had gone on the first, as answered. An open reads where it landed until it is a page:
/// past such a door, and bounded when the door never moves on.
#[test]
fn an_open_reads_past_a_page_that_only_waits_on_its_own_code() {
    use crate::browse::{landed_in, landed_settled, Came, DOOR_PASSES_WITHIN, LANDED_FIRST_WAIT};
    let page = "https://shop.example/item/none-such";
    let door = "<!DOCTYPE html><html><head><title>One moment</title><style>#e { display: none; }</style></head><body><noscript><span>JavaScript is disabled in your browser.</span><p>Please enable JavaScript to proceed.</p></noscript><div id=\"e\" role=\"alert\">A required part of this site couldn't load.</div><script>var s=document.createElement('script');s.src='/_x/script.js?reload=true';document.body.appendChild(s);</script></body></html>";
    let missing = "<html><head><title>Not found</title><script src=\"/app.js\"></script></head><body><h1>We looked everywhere</h1><a href=\"/\">Home</a> <a href=\"/search\">Search</a><iframe src=\"https://counter.example/frame\"></iframe></body></html>";
    let first = capture_line("Document", page, 200, Some(door)) + "\n";
    let then = first.clone() + &capture_line("Document", page, 404, Some(missing)) + "\n";
    let after = crate::browse::Look { url: page.into(), content: 1 };
    let paused = std::cell::Cell::new(std::time::Duration::ZERO);
    let pause = |d: std::time::Duration| paused.set(paused.get() + d);
    // The door's document alone for the first looks, then the page the site answered.
    let seen = std::cell::Cell::new(0);
    let (_, landed, looks) = landed_settled(
        || {
            seen.set(seen.get() + 1);
            ((), landed_in(if seen.get() > 3 { &then } else { &first }, page))
        },
        pause,
    );
    assert_eq!(looks, 3);
    assert_eq!(crate::browse::came_to_page("open", Some(page), None, Some(&after), landed.as_ref()), Came::Gone { status: 404 });
    // Past a door to the page itself, the reply names that page, not the door the program returned on.
    let lamp = capture_line("Document", page, 200, Some("<html><head><title>Brass desk lamp</title></head><body><h1>Brass desk lamp</h1><a href=\"/\">Home</a></body></html>"));
    let said = crate::browse::landed_said(&landed_in(&(first.clone() + &lamp + "\n"), page).unwrap());
    assert_eq!(said, format!("✓ Brass desk lamp\n  {page}"));
    // A door that never moves on is read as the check it is, after a bounded wait.
    paused.set(std::time::Duration::ZERO);
    let (_, landed, _) = landed_settled(|| ((), landed_in(&first, page)), pause);
    assert!(paused.get() <= DOOR_PASSES_WITHIN, "{:?}", paused.get());
    assert!(matches!(crate::browse::came_to_page("open", Some(page), None, Some(&after), landed.as_ref()), Came::Check { .. }));
    // A check that asks a person doesn't move on by itself: no wait for it.
    let check = "<html><head><title>One moment</title><script src=\"/check.js\"></script></head><body><div class=\"box\" data-sitekey=\"0x4AAAAAAAB\"></div></body></html>";
    let asks = capture_line("Document", page, 200, Some(check)) + "\n";
    assert_eq!(landed_settled(|| ((), landed_in(&asks, page)), pause).2, 0);
    // The page itself: read once. Nothing written yet: looked for a little, never long.
    let found = capture_line("Document", page, 200, Some(missing.replace("We looked everywhere", "Brass desk lamp").as_str())) + "\n";
    assert_eq!(landed_settled(|| ((), landed_in(&found, page)), pause).2, 0);
    paused.set(std::time::Duration::ZERO);
    assert!(landed_settled(|| ((), landed_in("", page)), pause).1.is_none());
    assert!(paused.get() <= LANDED_FIRST_WAIT, "{:?}", paused.get());
}

/// An agent that wrote a command as the tool's text does (`open <url>`, one item) is told the node takes each word as
/// its own item, and what to send: a request to resend, never a list of commands that names the one it sent.
#[test]
fn a_command_with_its_words_run_together_says_how_to_send_it() {
    let one = |s: &[&str]| s.iter().map(|w| w.to_string()).collect::<Vec<_>>();
    let said = crate::browse::words_run_together(&one(&["open https://shop.example/item/7"])).expect("said");
    assert!(said.contains(r#"["open","https://shop.example/item/7"]"#), "{said}");
    assert!(crate::browse::words_run_together(&one(&["snapshot -i"])).unwrap().contains(r#"["snapshot","-i"]"#));
    assert_eq!(crate::browse::words_run_together(&one(&["open", "https://shop.example/"])), None, "already in words");
    assert_eq!(crate::browse::words_run_together(&one(&["launch the page"])), None, "not a command it takes: said as before");
    assert_eq!(crate::outcome::of_failure("unbrowse_browse", StatusCode::BAD_REQUEST, &said).outcome, crate::outcome::Outcome::BadRequest);
}

/// An open the browser never got the page for (an address that doesn't resolve, nothing listening, the node's own
/// tunnel for it refused) is a page that isn't there: gone, status 0, not a step that failed. One the browser aborted
/// for a newer navigation is not.
#[test]
fn a_navigation_that_never_reached_the_site_is_gone() {
    assert!(crate::browse::never_reached("✗ Navigation failed: net::ERR_SOCKS_CONNECTION_FAILED"));
    assert!(crate::browse::never_reached("Navigation failed: net::ERR_NAME_NOT_RESOLVED"));
    assert!(crate::browse::never_reached("net::ERR_CONNECTION_REFUSED at https://shop.example/"));
    assert!(!crate::browse::never_reached("Navigation failed: net::ERR_ABORTED"));
    assert!(!crate::browse::never_reached("the command timed out after 30 s"));
    let said = super::browse::came_said(&crate::browse::Came::Gone { status: 0 }, "shop.example", true).expect("not done");
    assert_eq!((said.outcome.outcome, said.outcome.from), (crate::outcome::Outcome::Gone, "browse.landed.status"));
}

/// An open that lands on a check for a person (a page that is only a script and a check's widget) is a challenge, the
/// agent's to try with unbrowse_challenge before it asks the owner.
#[test]
fn an_open_that_lands_on_a_check_says_challenge() {
    let page = "https://shop.example/search?q=lamp";
    let check = "<html><head><title>One moment</title><script src=\"/check.js\"></script></head><body><div class=\"box\" data-sitekey=\"0x4AAAAAAAB\"></div></body></html>";
    let (came, said) = landed_reply("open", Some(page), Some(page), &[capture_line("Document", page, 200, Some(check))]);
    assert_eq!(came, crate::browse::Came::Check { at: page.into() });
    let said = said.expect("not done");
    assert_eq!((said.outcome.outcome, said.outcome.from), (crate::outcome::Outcome::Challenge, "browse.landed.check"));
    assert_eq!(said.outcome.next, Some(json!({ "tool": "unbrowse_challenge", "args": { "action": "look", "site": "shop.example" } })));
    // The door's refusal while it decides is the same check.
    let (came, _) = landed_reply("open", Some(page), Some(page), &[capture_line("Document", page, 429, Some("<html><body><script>setTimeout(()=>location.reload(),900)</script></body></html>"))]);
    assert!(matches!(came, crate::browse::Came::Check { .. }), "{came:?}");
}

/// The walk that exposed it: an open of a sign-up form whose check's widget sits among its fields was told "a check
/// that asks for a person, not the page asked for". A page of the site that asks for what a person types, or links
/// around its site, and carries a widget is the page asked for, said as carrying a check; a page that is only the
/// check is still a check.
#[test]
fn an_open_of_a_form_with_a_check_on_it_is_the_page() {
    let page = "https://shop.example/account/register/";
    let form = "<html><head><title>Create an account</title><script src=\"/app.js\"></script></head><body><h1>Create an account</h1><form><input name=\"email\"><input name=\"username\"><input type=\"password\" name=\"pw\"><div class=\"widget\" data-sitekey=\"0x4AAAAAAAB\"></div><button disabled>Create account</button></form><a href=\"/\">Home</a></body></html>";
    let (came, said) = landed_reply("open", Some(page), Some(page), &[capture_line("Document", page, 200, Some(form))]);
    assert_eq!(came, crate::browse::Came::CarriesCheck { at: page.into() });
    assert!(said.is_none(), "the page, not a landing elsewhere");
    assert!(super::browse::CARRIES_A_CHECK.contains("unbrowse_challenge"));
    let check = "<html><head><title>One moment</title><script src=\"/check.js\"></script></head><body><div class=\"box\" data-sitekey=\"0x4AAAAAAAB\"></div></body></html>";
    assert_eq!(landed_reply("open", Some(page), Some(page), &[capture_line("Document", page, 200, Some(check))]).0, crate::browse::Came::Check { at: page.into() });
}

/// An open that lands on another page of the site, which asks for a password, is a sign-in the owner gives: it needs
/// a person, with ask_owner next and the page marked as needing the owner.
#[test]
fn an_open_that_lands_on_a_sign_in_says_needs_person() {
    let (asked, login) = ("https://shop.example/orders", "https://shop.example/account/login");
    let form = "<html><head><title>Sign in</title></head><body><form><input name=\"email\"><input type=\"password\" name=\"pw\"><button>Sign in</button></form><a href=\"/\">Home</a></body></html>";
    let (came, said) = landed_reply("open", Some(asked), Some(login), &[capture_line("Document", asked, 302, Some("")), capture_line("Document", login, 200, Some(form))]);
    assert_eq!(came, crate::browse::Came::SignIn { at: login.into() });
    let said = said.expect("not done");
    assert_eq!((said.outcome.outcome, said.outcome.from, said.needs_owner), (crate::outcome::Outcome::NeedsPerson, "browse.landed.sign_in", true));
    assert_eq!(said.outcome.next.as_ref().unwrap()["args"]["do"][0], "ask_owner");
    // The sign-in page opened as itself is the page asked for.
    assert_eq!(landed_reply("open", Some(login), Some(login), &[capture_line("Document", login, 200, Some(form))]).0, crate::browse::Came::Done);
}

/// An eval's reply says that the requests its script sends are never learned only when the step's lines hold one; a
/// script that sent nothing (it read the title) carries no such note.
#[test]
fn an_eval_that_sent_nothing_carries_no_request_note() {
    let eval = ["eval".to_string(), "document.title".to_string()];
    let quiet = [capture_line("Image", "https://shop.example/logo.png", 200, None), capture_line("Document", "https://shop.example/", 200, Some("<html></html>"))].join("\n");
    assert!(!crate::browse::sent_a_request(&quiet));
    assert_eq!(super::browse::eval_note(&eval, crate::browse::sent_a_request(&quiet)), None);
    let fetched = capture_line("Fetch", "https://shop.example/api/items?q=lamp", 200, Some("{\"items\":[]}"));
    assert!(crate::browse::sent_a_request(&fetched));
    assert_eq!(super::browse::eval_note(&eval, true), Some(super::browse::EVAL_NOTE));
    assert_eq!(super::browse::eval_note(&["click".to_string(), "@e2".to_string()], true), None, "only a script's step says it");
}

/// The run that exposed it: an agent ticked a box by script in the tab it then passed a check in, and found out only
/// when the password fill was refused. The first script in a tab says, in its own reply, that the tab takes no fill now.
#[test]
fn the_first_script_in_a_tab_says_the_tab_takes_no_fill_now() {
    let eval = vec!["eval".to_string(), "document.querySelector('#terms').click()".to_string()];
    let note = super::browse::no_fill_note(&eval, false, true).expect("said on the first script");
    assert!(note.contains("no vault fill") && note.contains("unbrowse_challenge"), "{note}");
    assert_eq!(super::browse::no_fill_note(&eval, true, true), None, "a tab already scripted lost its fills before");
    assert_eq!(super::browse::no_fill_note(&eval, false, false), None, "a script refused never ran");
    assert_eq!(super::browse::no_fill_note(&["click".to_string(), "#terms".to_string()], false, true), None, "hands keep the tab fillable");
}

/// A step's read of its capture waits for nothing that isn't there: a capture already complete when the command
/// returns is read once with no pause, whether it holds the landed document or nothing at all; one still being written
/// is looked at again only while it is, never past `LANDED_WAIT`. The pauses are counted, not timed.
#[test]
fn a_step_that_sent_nothing_does_not_wait_for_its_capture() {
    use crate::browse::{read_while_written, LANDED_WAIT};
    let page = "https://shop.example/";
    let complete = [capture_line("Image", "https://shop.example/logo.png", 200, None), capture_line("Document", page, 200, Some("<html></html>"))].join("\n") + "\n";
    let quiet = capture_line("Image", "https://shop.example/logo.png", 200, None) + "\n";
    let paused = std::cell::Cell::new(std::time::Duration::ZERO);
    let pause = |d: std::time::Duration| paused.set(paused.get() + d);
    // Complete, with the document: found at once.
    let (found, looks) = read_while_written(|| crate::browse::landed_in(&complete, page), || true, pause);
    assert!(found.is_some() && looks == 0 && paused.get().is_zero());
    // Complete, with nothing to find: no pause either.
    let (found, looks) = read_while_written(|| crate::browse::landed_in(&quiet, page), || false, pause);
    assert!(found.is_none() && looks == 0 && paused.get().is_zero(), "{looks} looks");
    // An eval that sent nothing reads the lines once: no request, no note.
    assert!(!crate::browse::sent_a_request(&quiet));
    // Still being written, the document lands on the second look: two pauses.
    let seen = std::cell::Cell::new(0);
    let (found, looks) = read_while_written(
        || {
            seen.set(seen.get() + 1);
            (seen.get() > 2).then(|| crate::browse::landed_in(&complete, page)).flatten()
        },
        || true,
        pause,
    );
    assert!(found.is_some() && looks == 2, "{looks}");
    // Written for ever and never holding it: bounded.
    paused.set(std::time::Duration::ZERO);
    let (found, _) = read_while_written(|| crate::browse::landed_in(&quiet, page), || true, pause);
    assert!(found.is_none() && paused.get() <= LANDED_WAIT, "{:?}", paused.get());
    assert!(LANDED_WAIT <= std::time::Duration::from_millis(200));
}

/// The run that exposed it: an eval's fetch had its answer before the eval returned, and its line was written by the
/// browser program only once it settled, after the reply had gone without the note. The reply looks for the line as
/// long as the program takes to write one, no longer, and not at all once it is there.
#[test]
fn an_evals_request_is_looked_for_as_long_as_the_program_takes_to_write_it() {
    use crate::browse::{holds_within, SCRIPT_SENT_WAIT};
    let paused = std::cell::Cell::new(std::time::Duration::ZERO);
    let pause = |d: std::time::Duration| paused.set(paused.get() + d);
    let page = "https://shop.example/";
    let fetched = capture_line("Fetch", "https://shop.example/x", 404, Some("{}")) + "\n";
    // Written 800 ms after the eval returned: found, inside the wait.
    let found = holds_within(|| paused.get() >= std::time::Duration::from_millis(800) && crate::browse::sent_a_request(&fetched), SCRIPT_SENT_WAIT, pause);
    assert!(found && paused.get() < SCRIPT_SENT_WAIT, "{:?}", paused.get());
    // There at once: no pause.
    paused.set(std::time::Duration::ZERO);
    assert!(holds_within(|| crate::browse::sent_a_request(&fetched), SCRIPT_SENT_WAIT, pause) && paused.get().is_zero());
    // A script that sent nothing: bounded.
    paused.set(std::time::Duration::ZERO);
    let quiet = capture_line("Document", page, 200, Some("<html></html>")) + "\n";
    assert!(!holds_within(|| crate::browse::sent_a_request(&quiet), SCRIPT_SENT_WAIT, pause));
    assert!(paused.get() <= SCRIPT_SENT_WAIT && SCRIPT_SENT_WAIT >= std::time::Duration::from_millis(850), "{:?}", paused.get());
}

/// Two tabs on one site share its browsing log: a script in one tab hears of the requests its own tab sent, never of
/// another tab's, nor of a frame's (a line that names no tab). From a program that names no tab at all, as before.
#[test]
fn a_script_hears_only_of_its_own_tabs_requests() {
    let line = |tab: Option<&str>| {
        let mut v: serde_json::Value = serde_json::from_str(&capture_line("Fetch", "https://shop.example/x", 404, Some("{}"))).unwrap();
        if let Some(tab) = tab {
            v["tab"] = json!(tab);
        }
        v.to_string() + "\n"
    };
    let doc = |tab: &str| {
        let mut v: serde_json::Value = serde_json::from_str(&capture_line("Document", "https://shop.example/", 200, Some("<html></html>"))).unwrap();
        v["tab"] = json!(tab);
        v.to_string() + "\n"
    };
    assert!(crate::browse::sent_a_request_in(&line(Some("ua")), "ua"));
    assert!(!crate::browse::sent_a_request_in(&line(Some("ua")), "ub"), "another tab's");
    assert!(!crate::browse::sent_a_request_in(&(doc("ub") + &line(None)), "ub"), "a frame's");
    assert!(crate::browse::sent_a_request_in(&line(None), "ub"), "a program that names no tab: as before");
}

/// The run that exposed it: on a machine whose runtime can't hold page code, a page-signed route's new value was
/// served by the browser, and the reply said nothing of why (a call of the same route says `held_back`). A reply the
/// browser served for a route that needs the page's code says the sandbox's reader beside it; one whose route needs
/// none, or a machine whose runtime holds it, says nothing.
#[test]
fn a_browser_served_answer_says_the_sandbox_held_back() {
    use unbrowse_learn::sandbox::Unheld;
    let lacks = || Unheld::Lacks("has no permission model (process.permission)".into());
    let held = super::goal::held_back_beside(true, Some(lacks())).expect("said");
    assert_eq!(held["outcome_from"], "sandbox.lacks");
    assert!(held["owner_can"].as_str().unwrap().contains("first on the node's PATH"), "{held}");
    assert!(super::goal::held_back_beside(false, Some(lacks())).is_none());
    assert!(super::goal::held_back_beside(true, None).is_none());
}

/// cf0983df made `goal` optional so an `ask` alone collects, and the plugins' check of a call missing its argument went
/// with it. The schema says "goal or ask" (`anyOf`), which the SDKs and plugins read; the MCP server lists no
/// combinator at a tool schema's top level, which a model's API refuses.
#[test]
fn do_needs_a_goal_or_an_ask_and_the_listed_schema_takes_no_combinator() {
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_do").unwrap();
    assert_eq!((p.schema)()["anyOf"], json!([{ "required": ["goal"] }, { "required": ["ask"] }]));
    for t in super::mcp::tools().as_array().unwrap() {
        let schema = t["inputSchema"].as_object().unwrap();
        assert!(["anyOf", "oneOf", "allOf"].iter().all(|k| !schema.contains_key(*k)), "{}", t["name"]);
    }
}

/// A call that said `browser: never` for a page only the browser can answer is told it declined the browser: outcome
/// `browser_declined`, what it declined and what would answer it, nothing to install and no route search, and next the
/// same call letting the browser. Its code is the one an SDK raises for it, as before.
#[test]
fn a_call_that_forbade_the_browser_says_it_was_declined_not_missing() {
    let (home, rt, node, a, _) = node_and_site("declined-not-missing", vec![(200, "{}")]);
    // A page a plain request can't read: only a walk in the browser could learn it.
    let page = "http://127.0.0.1:9/items?q=lamp";
    let args = json!({ "goal": "list the items", "url": page, "browser": "never" });
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_do").unwrap();
    let (n, a2, asked) = (node.clone(), a.clone(), args.clone());
    let f = rt.block_on(async move { run_primitive(p, &n, &a2, asked, "unbrowse_do").await }).expect_err("declined");
    let (status, body) = answer_of(&f);
    assert_eq!((status, body["code"].as_str(), body["declined"].as_bool()), (StatusCode::UNPROCESSABLE_ENTITY, Some("browser_missing"), Some(true)), "{body}");
    assert_eq!((body["outcome"].as_str(), body["outcome_from"].as_str()), (Some("browser_declined"), Some("browser.declined")), "{body}");
    let mut again = args.clone();
    again["browser"] = json!("auto");
    assert_eq!(body["next"], json!({ "tool": "unbrowse_do", "args": again }), "the same call, letting the browser: {body}");
    let error = body["error"].as_str().unwrap();
    assert!(error.contains("browser: never") && error.contains("walked"), "what was declined, and what would answer: {error}");
    assert!(!error.contains("install") && !error.contains("unbrowse_search") && !error.contains("isn't installed"), "{error}");
    assert!(body.get("install").is_none() && body.get("missing").is_none() && body.get("fetch").is_none(), "nothing to install: {body}");
    // Over MCP the same.
    let mcp = crate::outcome::failure_body(json!({}), &f);
    assert_eq!(mcp["outcome"], "browser_declined");
    // A browser really missing stays missing, with what to install.
    let missing = crate::browsers::Missing { message: "this needs the node's browser".into(), lacking: vec!["chromium"], state: "missing", declined: false }.body();
    assert_eq!((missing["install"].as_str(), missing.get("declined")), (Some("unbrowse browser install"), None));
    let mut r: Result<Value, crate::outcome::Failed> = Err(crate::outcome::Failed::from((BROWSER_MISSING, "this needs the node's browser".to_string())));
    crate::outcome::stamp("unbrowse_do", &mut r);
    assert_eq!(answer_of(&r.unwrap_err()).1["outcome"], "browser_missing");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_rejected_plain_learn_does_not_rewalk_when_the_browser_is_forbidden() {
    let listings = |link: &str| Box::leak(json!({"results": (0..5).map(|n| json!({
        "title": format!("Desk lamp {n}"), "price": "$30", "url": format!("{link}{n}")
    })).collect::<Vec<_>>()}).to_string().into_boxed_str());
    let (home, rt, node, agent, port) = node_and_site("plain-replay-only", vec![(200, listings("/item/")), (200, listings("unavailable "))]);
    let ask = DoBody { goal: "list the results with title, price and link of each".into(), url: format!("http://127.0.0.1:{port}/search"),
        browser: "never".into(), inputs: HashMap::new(), session: String::new(), fields: Vec::new(), many: false, budget_usdc: None };
    let failure = rt.block_on(goal::do_goal_said(&node, &agent, ask)).expect_err("the replay lacked the requested links");
    let (_, body) = answer_of(&failure);
    assert_eq!(body["outcome_from"], "goal.replay_only", "{body}");
    assert!(body["error"].as_str().unwrap().contains(goal::LACKS_THE_GOAL), "{body}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_direct_call_rejects_a_malformed_browser_policy() {
    let (home, rt, node, agent, _) = node_and_site("invalid-browser-policy", vec![(200, "{}")]);
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_call").unwrap();
    for value in [json!(null), json!(false), json!(""), json!("other")] {
        let args = json!({ "route_id": "not-present", "browser": value });
        let failure = rt.block_on(run_primitive(p, &node, &agent, args, "unbrowse_call")).unwrap_err();
        assert_eq!(answer_of(&failure).0, StatusCode::BAD_REQUEST);
        assert_eq!(answer_of(&failure).1["error"], "browser must be auto or never");
    }
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_direct_route_call_can_decline_browser_fallback() {
    let (home, rt, node, agent, port) = node_and_site("direct-never", vec![(403, r#"{"error":"access refused"}"#)]);
    let mut route = a_lamps_route_on("direct-never", port);
    route.graph.steps[0].fields.push(unbrowse_learn::graph::Field {
        loc: unbrowse_learn::Loc::Cookie("branch".into()),
        class: unbrowse_learn::graph::Class::Minted { name: "branch".into() },
    });
    store::save_route(&route).unwrap();
    let choice: unbrowse_learn::setup::Setup = serde_json::from_value(json!({
        "kind":"choice","page":"not a URL","earns":["branch"],"steps":[]
    })).unwrap();
    let setups = home.join("setups");
    std::fs::create_dir_all(&setups).unwrap();
    std::fs::write(setups.join("127.0.0.1.json"), unbrowse_files::SETUPS.to_vec_pretty(&vec![choice]).unwrap()).unwrap();
    assert_eq!(crate::setups::load("127.0.0.1").len(), 1);
    let primitive = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_call").unwrap();
    let args = json!({"route_id":route.id,"browser":"never"});
    let reply = rt.block_on(run_primitive(primitive, &node, &agent, args, "unbrowse_call")).unwrap();
    assert_eq!(reply["browser"], false, "{reply}");
    assert_eq!(reply["ok"], false, "{reply}");
    assert!(reply["error"].as_str().is_some_and(|error| error.contains("403")), "{reply}");
    assert!(!home.join("setup-rests.json").exists(), "the call never attempted to make the site's choice in a browser");
    let invalid = json!({"route_id":route.id,"browser":"always"});
    let failure = rt.block_on(run_primitive(primitive, &node, &agent, invalid, "unbrowse_call")).unwrap_err();
    assert_eq!(failure.plain().0, StatusCode::BAD_REQUEST);
    let _ = std::fs::remove_dir_all(&home);
}

/// Whether ask_owner can run is known before it is called: whoami says it (`owner`), and a step that needs the owner
/// where none can be asked names no ask_owner to make. It says `owner_unavailable` and to tell the user, and an
/// ask_owner no window can show says the same.
#[test]
fn whoami_says_whether_ask_owner_can_run() {
    let (home, rt, node, headers) = node_with_a_token("whoami-ask-owner");
    let prim = |tool: &str| PRIMITIVES.iter().find(|p| p.tool == tool).unwrap();
    let whoami = || {
        let (n, h) = (node.clone(), headers.clone());
        rt.block_on(async move { answer_http(prim("unbrowse_whoami"), n, h, HashMap::new(), HashMap::new(), b"").await }).1 .0
    };
    let w = whoami();
    assert_eq!(w["owner"].as_str(), Some(crate::hands::owner_reach(node.events.watchers(), crate::browsers::headless_only())), "{w}");
    store::save_settings(&store::Settings { headless_only: true, ..store::load_settings() }).unwrap();
    assert_eq!(whoami()["owner"], "off", "the owner keeps windows off this node");

    use crate::browse::Came;
    use crate::outcome::Outcome;
    let sign_in = Came::SignIn { at: "https://shop.example/account/login".into() };
    let asked = super::browse::came_said(&sign_in, "shop.example", true).unwrap();
    assert_eq!((asked.outcome.outcome, asked.outcome.next.as_ref().map(|n| n["args"]["do"][0].clone())), (Outcome::NeedsPerson, Some(json!("ask_owner"))));
    let none = super::browse::came_said(&sign_in, "shop.example", false).unwrap();
    assert_eq!((none.outcome.outcome, none.outcome.from, none.outcome.next.is_none()), (Outcome::OwnerUnavailable, "owner.reach", true));
    assert!(none.said.contains("tell the user"), "{}", none.said);
    for came in [Came::Walled { at: "https://shop.example/login?next=%2Fa".into() }, Came::Unchanged] {
        assert!(super::browse::came_said(&came, "shop.example", false).unwrap().outcome.next.is_none(), "{came:?}");
    }
    let open = goal::hands_said(&crate::learn::Unlearned::SignIn("it sent the page to its sign-in".into(), "answer.sent_to_sign_in"), "see my orders", "https://shop.example/orders", Some("shop.example"), false);
    assert_eq!((open.outcome, open.next), (Outcome::OwnerUnavailable, None));
    let unreached = owner_unreached(true, (StatusCode::SERVICE_UNAVAILABLE, "the owner can't see this: no Unbrowse window is open".into()));
    assert_eq!(unreached.said.map(|s| s.outcome), Some(Outcome::OwnerUnavailable));
    assert!(owner_unreached(true, (StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED.into())).said.is_none(), "the pause is the pause");
    assert!(owner_unreached(false, (StatusCode::SERVICE_UNAVAILABLE, "no node served this entry's body lately".into())).said.is_none());
    let _ = std::fs::remove_dir_all(&home);
}

/// An ask stopped while its walk stood at a check is said as the check: the walk's capture shows the page it was on,
/// and the reply names a challenge with the call that meets it, the check in `why`, never only "stopped".
#[test]
fn a_walk_stopped_on_a_challenge_is_said_as_the_check_not_a_timeout() {
    let url = "https://shop.example/items?q=lamp";
    let page = |body: &str| unbrowse_learn::trace::Exchange {
        method: "GET".into(), url: url::Url::parse(url).unwrap(), request_headers: Vec::new(), request_body: None, status: 200, response_headers: Vec::new(),
        response_body: Some(body.into()), response_mime: "text/html".into(), resource_type: Some("Document".into()), main_frame: Some(true),
    };
    let check = unbrowse_learn::trace::Trace { exchanges: vec![page("<html><head><script src=\"/check.js\"></script></head><body><p>One moment.</p></body></html>")], inputs: Vec::new() };
    let stop = agent_browser_core::session::STOPPED;
    let met = crate::learn::walk_failed(stop, format!("the walk failed: {stop}"), Some(&check), url);
    let (_, body) = answer_of(&goal::stopped(&met, url));
    assert_eq!((body["outcome"].as_str(), body["outcome_from"].as_str()), (Some("challenge"), Some("challenge.asks_a_person")), "{body}");
    assert_eq!(body["next"], json!({ "tool": "unbrowse_challenge", "args": { "action": "look", "url": url } }), "{body}");
    assert!(body["why"].as_str().unwrap().contains("asks for a person"), "the check stays in why: {body}");
    // A walk stopped with nothing read is stopped, and says no more.
    let plain = unbrowse_learn::trace::Trace { exchanges: vec![page("<html><body><h1>Lamps</h1><a href=\"/a\">a</a><p>Four lamps</p></body></html>")], inputs: Vec::new() };
    let cut = crate::learn::walk_failed(stop, format!("the walk failed: {stop}"), Some(&plain), url);
    let (status, body) = answer_of(&goal::stopped(&cut, url));
    assert_eq!((status, body["outcome"].as_str(), body.get("why")), (StatusCode::REQUEST_TIMEOUT, Some("stopped"), None), "{body}");
}

/// An `unbrowse_do` over MCP, its reply's JSON and how long it took.
fn do_over_mcp(rt: &tokio::runtime::Runtime, node: &Arc<Node>, headers: &HeaderMap, id: u64, args: Value) -> (Value, std::time::Duration) {
    let (n, h) = (node.clone(), headers.clone());
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "unbrowse_do", "arguments": args } });
    let t = std::time::Instant::now();
    let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
    (serde_json::from_str(m["result"]["content"][0]["text"].as_str().unwrap_or("null")).unwrap(), t.elapsed())
}

/// The events of `asks.jsonl` for one ask, in order.
fn ask_events(home: &std::path::Path, id: &str) -> Vec<String> {
    super::asks::tests::events(home, id).iter().map(|e| e["event"].as_str().unwrap_or_default().to_string()).collect()
}

/// A do whose work outlasts the wait its caller gave answers when that wait ends, still working, with its ask and the
/// call that collects the answer; the work goes on for that same ask, its stop flag not set, and ends behind the
/// reply, said in `asks.jsonl`. Work that goes on past the wall behind its reply (`asks::WALL`) is ended there, and its
/// answer says so. The work here is a learn made slow by a test (`goal::slow`): nothing is walked.
#[test]
fn an_ask_answers_before_its_callers_wait_ends_and_finishes_in_its_scope() {
    let (home, rt, node, headers) = node_with_a_token("ask-answers-before");
    let page = "https://slow.example/items?case=before";
    let slow = goal::slow::make(page, Some(std::time::Duration::from_millis(700)));
    let (r, took) = do_over_mcp(&rt, &node, &headers, 1, json!({ "goal": "list the items", "url": page, "wait_ms": 150 }));
    assert!(took >= std::time::Duration::from_millis(150) && took < std::time::Duration::from_millis(600), "answered when its wait ended: {took:?}");
    let id = r["ask"].as_str().expect("its ask").to_string();
    assert_eq!((r["how"].as_str(), r["outcome"].as_str(), r["outcome_from"].as_str(), r["phase"].as_str()), (Some("working"), Some("still_working"), Some("ask.wait"), Some("walk")), "{r}");
    assert_eq!(r["next"], json!({ "tool": "unbrowse_do", "args": { "ask": id } }), "{r}");
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_do").unwrap();
    assert!(missing_arg(p, &r["next"]["args"]).is_none(), "the next can be made as given");
    crate::apischema::check(&(p.returns)(), &r, &crate::apischema::types()).unwrap_or_else(|e| panic!("{r}: {e}"));
    assert_eq!(ask_events(&home, &id), ["started", "reply", "behind"]);
    assert_eq!(super::asks::tests::events(&home, &id)[2]["work"], json!(["do"]));
    std::thread::sleep(std::time::Duration::from_millis(900));
    assert_eq!(ask_events(&home, &id), ["started", "reply", "behind", "ended"], "the work ended behind the reply");
    assert_eq!(super::asks::tests::events(&home, &id)[3]["stopped"], false, "the reply was given: nothing stopped the work");
    assert_eq!(*slow.asks.lock().unwrap(), std::slice::from_ref(&id), "it worked for the ask that replied");
    assert!(!slow.stopped.load(std::sync::atomic::Ordering::SeqCst));
    let (got, _) = do_over_mcp(&rt, &node, &headers, 2, json!({ "ask": id }));
    assert_eq!((got["how"].as_str(), got["outcome"].as_str(), got["ask"].as_str()), (Some("learned"), Some("answered"), Some(id.as_str())), "{got}");

    // Work that never ends on its own is ended at the wall behind its reply.
    let forever = "https://slow.example/items?case=wall";
    let endless = goal::slow::make(forever, None);
    let (r, _) = do_over_mcp(&rt, &node, &headers, 3, json!({ "goal": "list the items", "url": forever, "wait_ms": 100 }));
    let id = r["ask"].as_str().expect("its ask").to_string();
    assert_eq!(r["outcome"], "still_working", "{r}");
    std::thread::sleep(super::asks::WALL + std::time::Duration::from_millis(600));
    assert!(endless.stopped.load(std::sync::atomic::Ordering::SeqCst), "its stop flag was set at the wall");
    let (got, _) = do_over_mcp(&rt, &node, &headers, 4, json!({ "ask": id }));
    assert_eq!((got["outcome"].as_str(), got["outcome_from"].as_str()), (Some("budget_spent"), Some("param.ask.wall")), "{got}");
    let ended = super::asks::tests::events(&home, &id);
    assert_eq!((ended.last().unwrap()["event"].as_str(), ended.last().unwrap()["walled"].as_bool()), (Some("ended"), Some(true)), "{ended:?}");
    assert_eq!(super::asks::LIVE_WALL, std::time::Duration::from_secs(120));
    assert_eq!((super::asks::DEFAULT_WAIT, super::asks::MOST_WAIT), (std::time::Duration::from_secs(45), std::time::Duration::from_secs(300)));
    assert_eq!(super::asks::wait_of(&json!({ "wait_ms": 900_000 })), super::asks::MOST_WAIT);
    assert_eq!(super::asks::wait_of(&json!({ "wait_ms": "1500" })), std::time::Duration::from_millis(1500));
    let _ = std::fs::remove_dir_all(&home);
}

/// A second do of the same goal on the same page, while the first is still working, joins it: one walk, one answer,
/// both replies naming the ask whose work it is. Once that answer has been had, the next ask works afresh; another
/// goal on the page is work of its own.
#[test]
fn a_second_ask_of_the_same_page_joins_the_walk_in_flight() {
    let (home, rt, node, headers) = node_with_a_token("ask-joins");
    let page = "https://slow.example/items?case=join";
    let slow = goal::slow::make(page, Some(std::time::Duration::from_millis(400)));
    let args = json!({ "goal": "list the items", "url": page, "wait_ms": 3000 });
    let call = |id: u64, args: Value| {
        let (n, h) = (node.clone(), headers.clone());
        async move {
            let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "unbrowse_do", "arguments": args } });
            let (_, Json(m)) = mcp_answer(n, &h, msg).await;
            serde_json::from_str::<Value>(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
        }
    };
    let (first, second) = rt.block_on(async {
        let first = tokio::spawn(call(1, args.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let second = call(2, args.clone()).await;
        (first.await.unwrap(), second)
    });
    assert_eq!((first["outcome"].as_str(), second["outcome"].as_str()), (Some("answered"), Some("answered")), "{first} {second}");
    assert_eq!(slow.started.load(std::sync::atomic::Ordering::SeqCst), 1, "one walk for both");
    assert_eq!(first["ask"], second["ask"], "both name the work's ask");
    let (again, _) = do_over_mcp(&rt, &node, &headers, 3, args.clone());
    assert_eq!((again["outcome"].as_str(), slow.started.load(std::sync::atomic::Ordering::SeqCst)), (Some("answered"), 2), "an answer had is not handed out again by its arguments");
    assert_ne!(again["ask"], first["ask"]);
    let (other, _) = do_over_mcp(&rt, &node, &headers, 4, json!({ "goal": "count the items", "url": page, "wait_ms": 3000 }));
    assert_eq!((other["outcome"].as_str(), slow.started.load(std::sync::atomic::Ordering::SeqCst)), (Some("answered"), 3), "another goal is work of its own");
    let (auto, never) = rt.block_on(async {
        let auto = tokio::spawn(call(5, args.clone()));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let mut strict = args.clone();
        strict["browser"] = json!("never");
        let never = call(6, strict).await;
        (auto.await.unwrap(), never)
    });
    assert_ne!(auto["ask"], never["ask"], "a replay-only request cannot collect an auto request's work");
    assert_eq!(slow.started.load(std::sync::atomic::Ordering::SeqCst), 5);
    let _ = std::fs::remove_dir_all(&home);
}

/// An ask's id collects its answer: still working while the work goes on, the answer once it is there, as often as it
/// is asked for, for `asks::KEPT` after the work ends and then no more. Only the agent that asked collects it, and an
/// id the node keeps nothing for is a bad request that says how long answers are kept.
#[test]
fn an_ask_id_collects_its_kept_answer() {
    let (home, rt, node, headers) = node_with_a_token("ask-collects");
    let page = "https://slow.example/items?case=collect";
    goal::slow::make(page, Some(std::time::Duration::from_millis(500)));
    let (r, _) = do_over_mcp(&rt, &node, &headers, 1, json!({ "goal": "list the items", "url": page, "wait_ms": 50 }));
    let id = r["ask"].as_str().expect("its ask").to_string();
    let (still, took) = do_over_mcp(&rt, &node, &headers, 2, json!({ "ask": id, "wait_ms": 50 }));
    assert_eq!((still["outcome"].as_str(), still["ask"].as_str()), (Some("still_working"), Some(id.as_str())), "{still}");
    assert!(took < std::time::Duration::from_millis(400), "{took:?}");
    let (got, _) = do_over_mcp(&rt, &node, &headers, 3, json!({ "ask": id, "wait_ms": 3000 }));
    assert_eq!((got["outcome"].as_str(), got["result"]["data"]["items"][0]["name"].as_str()), (Some("answered"), Some("desk lamp")), "{got}");
    let (twice, _) = do_over_mcp(&rt, &node, &headers, 4, json!({ "ask": id }));
    assert_eq!(twice["result"], got["result"], "kept: the same answer again");
    let (id2, a2) = (id.clone(), "another agent");
    let theirs = rt.block_on(async move { super::asks::collect(a2, &id2, std::time::Duration::from_millis(10)).await });
    assert_eq!(theirs.expect_err("not theirs").status, StatusCode::NOT_FOUND);
    let (unknown, _) = do_over_mcp(&rt, &node, &headers, 5, json!({ "ask": "ask_0000000000000000" }));
    assert_eq!((unknown["outcome"].as_str(), unknown["outcome_from"].as_str()), (Some("bad_request"), Some("ask")), "{unknown}");
    assert!(unknown["error"].as_str().unwrap().contains("5 minutes"), "{unknown}");
    super::asks::forget_kept(std::time::Instant::now() + super::asks::KEPT);
    let (gone, _) = do_over_mcp(&rt, &node, &headers, 6, json!({ "ask": id }));
    assert_eq!(gone["outcome"], "bad_request", "let go after KEPT: {gone}");
    assert_eq!(super::asks::KEPT, std::time::Duration::from_secs(300));
    let _ = std::fs::remove_dir_all(&home);
}

/// A wait for a site's profile that another walk holds ends inside the caller's wait: the ask is answered still
/// working once the wait has run `PROFILE_WAIT` (30 s, under the 45 s a caller waits by default, with room to answer),
/// and the wait goes on behind the reply, never into the profile while a browser holds it, until the ask's wall sets
/// its stop flag.
#[test]
fn a_profile_wait_never_outlasts_the_reply() {
    assert!(crate::browse::LIVE_PROFILE_WAIT + std::time::Duration::from_secs(10) <= super::asks::DEFAULT_WAIT);
    assert_eq!(crate::browse::LIVE_PROFILE_WAIT, std::time::Duration::from_secs(30));
    let home = store::scratch_home("profile-wait-reply");
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    store::use_home(&home);
    let profile = std::env::temp_dir().join(format!("unbrowse-profile-reply-{}", std::process::id()));
    let other = crate::browse::hold_profile(&profile, "another walk of the site");
    let ask = super::asks::Ask::begin("unbrowse_do");
    let p2 = profile.clone();
    let t = std::time::Instant::now();
    let r = rt
        .block_on(super::asks::within(
            ask.clone(),
            super::asks::answer_within("agent", "profile-case".into(), std::time::Duration::from_secs(20), move || async move {
                let stop = super::mcp::ask_stop();
                tokio::task::spawn_blocking(move || {
                    let _held = unbrowse_learn::mint::stops_with(stop, || crate::browse::hold_profile(&p2, "a walk"));
                })
                .await
                .unwrap();
                Ok(json!({ "how": "called", "result": { "ok": true, "data": {} } }))
            }),
        ))
        .unwrap();
    assert!(t.elapsed() < std::time::Duration::from_secs(3), "answered once the profile wait ran, not at the caller's wait: {:?}", t.elapsed());
    assert_eq!((r["outcome"].as_str(), r["outcome_from"].as_str()), (Some("still_working"), Some("ask.profile")), "{r}");
    assert!(r["phase"].as_str().unwrap().contains("profile"), "{r}");
    ask.replied(Some("still_working"));
    // Past the wait a walk of no ask would give up after, it still waits: it never goes into the held profile.
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(!ask.has_ended(), "it waits on behind the reply");
    // The ask's wall sets its stop flag, and the wait ends without the profile (another walk holds it still).
    std::thread::sleep(super::asks::WALL + std::time::Duration::from_millis(700));
    assert!(ask.has_ended() && ask.walled(), "ended at its wall");
    drop(other);
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// A tool call over MCP: the length of the text the agent is handed, and the reply it says.
fn text_over_mcp(rt: &tokio::runtime::Runtime, node: &Arc<Node>, headers: &HeaderMap, id: u64, tool: &str, args: Value) -> (usize, Value) {
    let (n, h) = (node.clone(), headers.clone());
    let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } });
    let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
    let text = m["result"]["content"][0]["text"].as_str().unwrap_or("null").to_string();
    (text.len(), serde_json::from_str(&text).unwrap())
}

/// 3000 records whose ids alone, the field a call hands back by default, are 42 KB: over the 32 KB ceiling before
/// anything else the reply says. The records are cut too, whole ones kept from the front, and the reply, as the agent
/// is handed it, fits: it answers `answered_cut`, says it kept N of the 3000 records, and how to have the rest (here the
/// whole answer's file: the route doesn't page, and one field is no fewer to name).
#[test]
fn the_ceiling_holds_when_the_ids_alone_exceed_it() {
    let (home, rt, node, headers) = node_with_a_token("ceiling-ids");
    let items: Vec<Value> = (0..3000).map(|i| json!({ "id": 100_000 + i, "title": "x".repeat(900) })).collect();
    let site = crate::run::test_site(vec![("/api/items", 200, "application/json", json!({ "count": 3000, "items": items }).to_string())]);
    let url = format!("http://127.0.0.1:{site}/api/items");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "list the items", "You") else { panic!("a JSON url is its own route") };
    let (bytes, r) = text_over_mcp(&rt, &node, &headers, 1, "unbrowse_call", json!({ "route_id": route.id }));
    assert!(bytes <= crate::run::REPLY_BUDGET, "the reply is {bytes} bytes, over the {} ceiling", crate::run::REPLY_BUDGET);
    assert_eq!((r["outcome"].as_str(), r["outcome_from"].as_str()), (Some("answered_cut"), Some("call.truncated")), "{}", r["truncated"]);
    let kept = r["data"]["items"].as_array().expect("the records, cut");
    assert!(kept.len() > 1000 && kept.len() < 3000, "{}", kept.len());
    assert!(kept.iter().enumerate().all(|(i, it)| it["id"] == json!(100_000 + i) && it.get("title").is_none()), "whole records, from the front, as shown by default");
    let t = &r["truncated"];
    assert_eq!(t["cuts"][0], json!({ "at": "/items", "kept": kept.len(), "total": 3000, "unit": "items" }), "{t}");
    let note = t["note"].as_str().unwrap();
    assert!(note.contains(&format!("kept {} of 3000 records (items)", kept.len())), "{note}");
    let whole = t["whole"].as_str().expect("the whole answer is kept");
    assert!(note.contains(whole) && !note.contains("left_out"), "{note}");
    let all: Value = serde_json::from_slice(&std::fs::read(whole).unwrap()).unwrap();
    assert_eq!(all["items"].as_array().unwrap().len(), 3000);
    assert_eq!(super::asks::tests::events(&home, r["ask"].as_str().unwrap())[1]["outcome"], "answered_cut", "the ask's log says what the agent was handed");
    let _ = std::fs::remove_dir_all(&home);
}

/// No reply of an answer is over the ceiling as the agent is handed it, whatever shape the answer or the reply around
/// it: a call asked for the whole answer, a do that learned the page, several pages at once (each cut to the ceiling
/// alone, over it together), a text whose characters are more than a byte each as JSON, and the same over HTTP. Each
/// that was cut says so.
#[test]
fn a_reply_is_never_over_the_ceiling() {
    let (home, rt, node, headers) = node_with_a_token("ceiling-never");
    let items: Vec<Value> = (0..1500).map(|i| json!({ "id": i, "name": format!("item number {i}"), "about": "y".repeat(300) })).collect();
    let post = json!({ "title": "a post", "body": "\"é\\".repeat(40_000) });
    let site = crate::run::test_site(vec![
        ("/api/items", 200, "application/json", json!({ "items": items }).to_string()),
        ("/api/post", 200, "application/json", post.to_string()),
    ]);
    let url = |path: &str| format!("http://127.0.0.1:{site}{path}");
    let ceiling = crate::run::REPLY_BUDGET;
    let crate::learn::Plain::Route(listed) = crate::learn::learn_plain(&url("/api/items"), "list the items", "You") else { panic!("a JSON url is its own route") };
    let crate::learn::Plain::Route(posted) = crate::learn::learn_plain(&url("/api/post"), "read the post", "You") else { panic!("a JSON url is its own route") };
    let shapes = [
        ("unbrowse_call", json!({ "route_id": listed.id, "fields": ["*"] })),
        ("unbrowse_call", json!({ "route_id": posted.id, "fields": ["*"] })),
        ("unbrowse_do", json!({ "goal": "list the items", "url": url("/api/items"), "fields": ["*"], "browser": "never" })),
        ("unbrowse_do", json!({ "goal": "list the items", "pages": [url("/api/items?page=1"), url("/api/items?page=2"), url("/api/post")], "fields": ["*"], "browser": "never" })),
    ];
    for (n, (tool, args)) in shapes.iter().enumerate() {
        let (bytes, r) = text_over_mcp(&rt, &node, &headers, n as u64 + 1, tool, args.clone());
        assert!(bytes <= ceiling, "{tool} {args}: {bytes} bytes");
        let answers: Vec<&Value> = match r["how"].as_str() {
            Some("pages") => r["pages"].as_array().unwrap().iter().collect(),
            Some(_) => vec![&r["result"]],
            None => vec![&r],
        };
        assert!(!answers.is_empty() && answers.iter().all(|a| a["ok"] == true && !a["truncated"].is_null()), "{tool} {args}: each answer was cut and says so: {r}");
        let cut = if r["how"] == "pages" { answers.iter().map(|a| a["outcome"].clone()).collect::<Vec<_>>() } else { vec![r["outcome"].clone()] };
        assert!(cut.iter().all(|o| o == "answered_cut"), "{tool} {args}: {cut:?}");
    }
    // The quoted text is cut by what it takes as JSON, not by its characters: about a third of them fit.
    let (_, r) = text_over_mcp(&rt, &node, &headers, 9, "unbrowse_call", json!({ "route_id": posted.id, "fields": ["*"] }));
    let body = r["data"]["body"].as_str().unwrap().chars().count();
    assert!(body > 5_000 && body < ceiling / 2, "{body}");
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_call").unwrap();
    let (n, h, args) = (node.clone(), headers.clone(), json!({ "route_id": listed.id, "fields": ["*"] }).to_string());
    let (_, Json(v)) = rt.block_on(async move { answer_http(p, n, h, HashMap::new(), HashMap::new(), args.as_bytes()).await });
    assert!(serde_json::to_vec(&v).unwrap().len() <= ceiling && v["outcome"] == "answered_cut", "{}", v["truncated"]);
    let _ = std::fs::remove_dir_all(&home);
}

/// A reply whose bulk is no answer's data is held to the ceiling too, through the agent's own door: here the goal the
/// route carries back is the long text and the answer is small, as a browse reply's page snapshot is (PR 926's slice,
/// 25 Nov 2026: Carousell's page after a Turnstile came back as 61 KB the client refused). The longest text keeps its
/// start, and `texts_cut` says so.
#[test]
fn a_reply_with_no_answer_to_cut_is_held_to_the_ceiling_too() {
    let (home, rt, node, headers) = node_with_a_token("ceiling-no-answer");
    let site = crate::run::test_site(vec![("/api/one", 200, "application/json", json!({ "name": "one item" }).to_string())]);
    let url = format!("http://127.0.0.1:{site}/api/one");
    let goal = format!("read the item {}", "and say its name ".repeat(3_000));
    let (bytes, r) = text_over_mcp(&rt, &node, &headers, 1, "unbrowse_do", json!({ "goal": goal, "url": url, "browser": "never" }));
    assert!(bytes <= crate::run::REPLY_BUDGET, "{bytes} bytes");
    let cut = &r["texts_cut"]["cuts"][0];
    assert!(cut["total"].as_u64().is_some_and(|n| n > crate::run::REPLY_BUDGET as u64) && cut["unit"] == "chars", "{r}");
    assert_eq!(r["result"]["ok"], true, "the answer itself is whole: {r}");
    assert!(r.to_string().contains("one item"), "{r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A batch (`unbrowse_do` with `pages`) is one ask, and each of its pages an ask of its own. Answered within its
/// caller's wait while a page is still being learned, the batch says `still_working` with the pages answered so far,
/// in the order given, each naming its ask, the pending one `how: working` with the call that collects it alone; the
/// batch's ask collects the whole batch, each page walked once. The pages are learns made slow by a test
/// (`goal::slow`): nothing is walked.
#[test]
fn a_batch_names_its_ask_and_each_page_its_own() {
    let (home, rt, node, headers) = node_with_a_token("batch-asks");
    let (quick, slow) = ("https://slow.example/items?case=batch-quick", "https://slow.example/items?case=batch-slow");
    let q = goal::slow::make(quick, Some(std::time::Duration::from_millis(20)));
    let s = goal::slow::make(slow, Some(std::time::Duration::from_millis(700)));
    let (r, took) = do_over_mcp(&rt, &node, &headers, 1, json!({ "goal": "list the items", "pages": [quick, slow], "wait_ms": 250 }));
    assert!(took < std::time::Duration::from_millis(650), "answered within its wait: {took:?}");
    let batch = r["ask"].as_str().expect("the batch names its ask").to_string();
    assert_eq!((r["how"].as_str(), r["outcome"].as_str(), r["outcome_from"].as_str()), (Some("pages"), Some("still_working"), Some("pages.pending")), "{r}");
    assert_eq!(r["next"], json!({ "tool": "unbrowse_do", "args": { "ask": batch } }), "the batch's ask collects the whole batch: {r}");
    let p = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_do").unwrap();
    crate::apischema::check(&(p.returns)(), &r, &crate::apischema::types()).unwrap_or_else(|e| panic!("{r}: {e}"));
    let pages = r["pages"].as_array().unwrap();
    assert_eq!(pages.iter().map(|p| p["url"].as_str().unwrap()).collect::<Vec<_>>(), [quick, slow], "every page, in the order given");
    assert_eq!((pages[0]["how"].as_str(), pages[0]["outcome"].as_str()), (Some("learned"), Some("answered")), "{r}");
    assert_eq!((pages[1]["how"].as_str(), pages[1]["outcome"].as_str()), (Some("working"), Some("still_working")), "{r}");
    assert_eq!(r["pending"], json!([slow]));
    let own: Vec<String> = pages.iter().map(|p| p["ask"].as_str().expect("each page names its ask").to_string()).collect();
    assert!(own[0] != own[1] && !own.contains(&batch), "an ask of its own each: {batch} {own:?}");
    assert_eq!(pages[1]["next"], json!({ "tool": "unbrowse_do", "args": { "ask": own[1] } }), "{r}");
    assert_eq!(*q.asks.lock().unwrap(), std::slice::from_ref(&own[0]), "each page's work is its own ask's");
    assert_eq!(*s.asks.lock().unwrap(), std::slice::from_ref(&own[1]));
    // The quick page's ask replied as the batch heard it; the slow one's when the batch replied, still working.
    assert_eq!(ask_events(&home, &own[0]), ["started", "reply", "ended"]);
    assert_eq!(super::asks::tests::events(&home, &own[1])[1]["outcome"], "still_working");
    let (whole, _) = do_over_mcp(&rt, &node, &headers, 2, json!({ "ask": batch, "wait_ms": 3000 }));
    assert_eq!((whole["how"].as_str(), whole["outcome"].as_str(), whole["ask"].as_str()), (Some("pages"), Some("answered"), Some(batch.as_str())), "{whole}");
    let pages = whole["pages"].as_array().unwrap();
    assert!(pages.iter().all(|p| p["outcome"] == "answered" && p["data"]["items"][0]["name"] == "desk lamp"), "{whole}");
    assert_eq!(pages.iter().map(|p| p["ask"].as_str().unwrap().to_string()).collect::<Vec<_>>(), own, "the same asks");
    assert!(whole.get("pending").is_none(), "{whole}");
    crate::apischema::check(&(p.returns)(), &whole, &crate::apischema::types()).unwrap_or_else(|e| panic!("{whole}: {e}"));
    assert_eq!((q.started.load(std::sync::atomic::Ordering::SeqCst), s.started.load(std::sync::atomic::Ordering::SeqCst)), (1, 1), "each page walked once");
    assert_eq!(ask_events(&home, &own[1]), ["started", "reply", "behind", "ended"], "its work ended behind the batch's reply");
    let _ = std::fs::remove_dir_all(&home);
}

/// A page still pending when its batch replied is collected alone by its own ask, with the answer one `unbrowse_do`
/// of it gives; and a later `unbrowse_do` of a pending page alone joins its walk in flight, naming the page's ask.
#[test]
fn a_pending_page_of_a_batch_can_be_collected_by_its_ask() {
    let (home, rt, node, headers) = node_with_a_token("batch-page-collects");
    let (one, two) = ("https://slow.example/items?case=pending-one", "https://slow.example/items?case=pending-two");
    let first = goal::slow::make(one, Some(std::time::Duration::from_millis(400)));
    let second = goal::slow::make(two, Some(std::time::Duration::from_millis(400)));
    let (r, _) = do_over_mcp(&rt, &node, &headers, 1, json!({ "goal": "list the items", "pages": [one, two], "wait_ms": 100 }));
    assert_eq!(r["outcome"], "still_working", "{r}");
    let asks: Vec<String> = r["pages"].as_array().unwrap().iter().map(|p| p["ask"].as_str().unwrap().to_string()).collect();
    assert_eq!(r["pending"], json!([one, two]), "{r}");
    let (got, _) = do_over_mcp(&rt, &node, &headers, 2, json!({ "ask": asks[0], "wait_ms": 3000 }));
    assert_eq!((got["how"].as_str(), got["outcome"].as_str(), got["ask"].as_str()), (Some("learned"), Some("answered"), Some(asks[0].as_str())), "{got}");
    assert_eq!(got["result"]["data"]["items"][0]["name"], "desk lamp", "{got}");
    // The second page asked alone, while its walk goes on: joined, not walked again.
    let (alone, _) = do_over_mcp(&rt, &node, &headers, 3, json!({ "goal": "list the items", "url": two, "wait_ms": 3000 }));
    assert_eq!((alone["outcome"].as_str(), alone["ask"].as_str()), (Some("answered"), Some(asks[1].as_str())), "{alone}");
    assert_eq!((first.started.load(std::sync::atomic::Ordering::SeqCst), second.started.load(std::sync::atomic::Ordering::SeqCst)), (1, 1), "each page walked once");
    let _ = std::fs::remove_dir_all(&home);
}

/// A step on a site with a sign-up under way says which made logins the vault keeps now and which wait for the site.
#[test]
fn a_reply_says_a_made_login_waits_for_the_site_to_accept_it() {
    assert_eq!(super::browse::sign_up_note(&[], &[]), None);
    let waits = super::browse::sign_up_note(&[], &["vault:s.example:me".to_string()]).unwrap();
    assert!(waits.contains("vault:s.example:me") && waits.contains("once the site accepts"), "{waits}");
    let kept = super::browse::sign_up_note(&["vault:s.example:me".to_string()], &[]).unwrap();
    assert!(kept.contains("keeps vault:s.example:me now"), "{kept}");
}

/// A value the site turned away to another page is said apart from an answer that lists nothing: `answered_empty`,
/// but from `learn.elsewhere`, with `how: elsewhere` and a `why` that says the site sent the browser to another page.
#[test]
fn a_value_the_site_sent_elsewhere_is_told_apart_from_an_empty_list() {
    let v = super::goal::elsewhere("the site sent the browser to another page (/) instead of the page for zqxv, and that page carries none of it: the site has nothing for that value");
    assert_eq!((v["outcome"].as_str(), v["outcome_from"].as_str(), v["how"].as_str()), (Some("answered_empty"), Some("learn.elsewhere"), Some("elsewhere")), "{v}");
    let mut empty = json!({ "ok": true, "data": { "q": "zqxv", "results": [] } });
    crate::outcome::answered_with(&mut empty, &["zqxv".to_string()]);
    assert_eq!((empty["outcome"].as_str(), empty["outcome_from"].as_str()), (Some("answered_empty"), Some("call.data")), "an empty list is read by its own reader: {empty}");
}

/// A first walk of a value the site has nothing for keeps no route (`Unlearned::Nothing`): the reply says the site's
/// answer, nothing for it, as `answered_empty` from `learn.nothing`, with its ask, and carries no records.
#[test]
fn a_learn_that_found_nothing_replies_answered_empty_with_its_ask_and_no_records() {
    let (home, rt, node, headers) = node_with_a_token("learn-found-nothing");
    let page = "https://slow.example/search?q=zqxvkjwpf";
    goal::slow::finds_nothing(page, "the walk's answer lists nothing for zqxvkjwpf: the site has nothing for that value");
    let (v, _) = do_over_mcp(&rt, &node, &headers, 1, json!({ "goal": "items matching this search", "url": page, "wait_ms": 3000 }));
    assert_eq!((v["outcome"].as_str(), v["outcome_from"].as_str(), v["how"].as_str()), (Some("answered_empty"), Some("learn.nothing"), Some("nothing")), "{v}");
    assert!(v["ask"].as_str().is_some_and(|a| a.starts_with("ask_")), "{v}");
    assert!(v.get("result").is_none() && v.get("route").is_none(), "no records, no route: {v}");
    assert!(!crate::learn::Unlearned::Nothing(String::new()).for_hands(), "nothing for the value is no page for hands");
    let _ = std::fs::remove_dir_all(&home);
}

/// A learn whose only reader of the answer is the page's own code, on a machine with no runtime: no route, said as the
/// sandbox's reader (`sandbox.no_runtime`), with the owner's step and the page in the browser as what answers meanwhile.
#[test]
fn a_learn_left_to_page_code_with_no_runtime_says_the_sandboxs_reader() {
    use unbrowse_learn::sandbox::Unheld;
    let url = "https://shop.example/search?q=lamp";
    let v = super::goal::unheld_with(&format!("the page's answer is read only by the page's own code: {}", Unheld::NoRuntime.said()), url, Some(Unheld::NoRuntime));
    assert_eq!((v["outcome"].as_str(), v["outcome_from"].as_str(), v["how"].as_str()), (Some("no_route"), Some("sandbox.no_runtime"), Some("unheld")), "{v}");
    assert_eq!(v["held_back"]["outcome_from"], "sandbox.no_runtime");
    assert!(v["held_back"]["owner_can"].as_str().unwrap().contains("SIGNING_PROGRAM"), "{v}");
    assert!(v["held_back"]["meanwhile"].as_str().unwrap().contains("unbrowse_browse"), "{v}");
    assert_eq!(v["next"], json!({ "tool": "unbrowse_browse", "args": { "do": ["open", url] } }));
}

/// The same with a runtime the sandbox can't hold (it lacks what its own layer needs): `sandbox.lacks`, never said as
/// no runtime.
#[test]
fn a_learn_left_to_page_code_on_a_runtime_that_cant_be_held_says_so() {
    use unbrowse_learn::sandbox::Unheld;
    let lacks = Unheld::Lacks("has no permission model (process.permission)".into());
    let v = super::goal::unheld_with(&format!("the page's answer is read only by the page's own code: {}", lacks.said()), "https://shop.example/", Some(lacks));
    assert_eq!((v["outcome"].as_str(), v["outcome_from"].as_str()), (Some("no_route"), Some("sandbox.lacks")), "{v}");
    assert!(v["held_back"]["owner_can"].as_str().unwrap().contains("first on the node's PATH"));
    assert!(!v["why"].as_str().unwrap().contains("no JavaScript runtime"), "{v}");
}

/// Whether a called route's answer holds its records is read on the answer whole, where a confirming browse saw them
/// (`Heard::records_at`), never on the reply's view of it: the fields a reply shows (here the ones an agent named, as a
/// feed's view keeps only its text) leave the place out of a right answer, and read there a confirmed route was served
/// by the browser for every value (a news feed's confirmed route, live). The reply says how many records it holds there.
#[test]
fn a_routes_records_are_read_on_its_answer_whole_not_on_the_replys_view() {
    let rows: Vec<String> = (0..60).map(|n| format!(r#"{{"id":{n},"title":"teapot number {n}, glazed stoneware from the shop's own kilns","price":{n}}}"#)).collect();
    let body: &'static str = Box::leak(format!(r#"{{"query":"teapot","results":[{}]}}"#, rows.join(",")).into_boxed_str());
    let (home, rt, node, a, port) = node_and_site("records-on-the-whole", vec![(200, body)]);
    let url = format!("http://127.0.0.1:{port}/api/items?q=teapot");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    store::update_route(&route.id, |r| {
        r.provisional = false;
        r.heard.said_back = Some("teapot".into());
        r.heard.records_at = Some("results".into());
        r.fields = vec!["query".into()];
        r.judged.fields = true;
    })
    .unwrap();
    let body = DoBody { goal: "search the items".into(), url, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!(r["how"], "called", "{r}");
    assert!(r["result"]["data"].get("results").is_none(), "the reply's view holds only the named field: {r}");
    assert_eq!(r["result"]["records"], json!(60), "{r}");
    // An answer without the place holds no records there, whatever its view shows.
    let stored = store::load_route(&route.id).unwrap();
    assert_eq!(crate::run::records_where_seen(&stored, &json!({ "query": "teapot", "earlier": [{ "title": "teapot" }] })), Some(None));
    assert_eq!(crate::run::records_where_seen(&stored, &json!({ "query": "qzxv", "results": [] })), Some(Some(0)), "an empty list there is the site finding nothing");
    let _ = std::fs::remove_dir_all(&home);
}

/// A page that is its own data (its address answers with JSON, and the route's call is that address) answers with
/// itself, whatever its address's words name: a dashboard's data lists leases and transactions and never says
/// "dashboard". Held to a subject read from its own address, the right answer read as "other things" and the page was
/// walked, learning nothing (a live data address, and its relearn). A page about one thing answered by another call's
/// list of other things is still not its answer.
#[test]
fn a_page_that_is_its_own_data_answers_with_itself() {
    let graph = |url: &str| serde_json::from_value(json!({ "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false }], "provisional": false })).unwrap();
    let page = "https://console.example/v1/dashboard-data";
    let route = store::Route::from_graph("r".into(), "get dashboard stats".into(), page.into(), graph(page)).unwrap();
    let subject = crate::learn::subject_of(page, "get dashboard stats");
    let none = HashMap::new();
    let data = json!({ "ok": true, "data": { "latestTransactions": [{ "hash": "A1F0", "fee": 12 }, { "hash": "B7C2", "fee": 9 }, { "hash": "C3D9", "fee": 4 }], "now": { "activeLeaseCount": 811 } } });
    let ask = Asked { url: page, goal: "get dashboard stats", subject: &subject, reworded: false, sibling: false, given: &none };
    assert!(!subject.is_empty(), "the address names something: {subject:?}");
    assert_eq!(unanswered(&data, &route, &ask), None, "the page's own data");
    let templated = store::Route::from_graph("t".into(), "downloads".into(), page.into(), graph("https://api.example/downloads/range/{path[2]}/{path[3]}")).unwrap();
    assert!(calls_the_page_itself(&templated, "https://api.example/downloads/range/2026-09-01:2026-09-30/mongodb"));
    assert!(!calls_the_page_itself(&templated, "https://api.example/downloads/point/last-week/mongodb"));
    let coin = "https://coins.example/coins/bitcoin";
    let other = store::Route::from_graph("o".into(), "price".into(), coin.into(), graph("https://coins.example/api/rankings")).unwrap();
    let subject = crate::learn::subject_of(coin, "get the price");
    let ranking = json!({ "ok": true, "data": [{ "name": "ether" }, { "name": "dogecoin" }, { "name": "solana" }] });
    assert!(unanswered(&ranking, &other, &Asked { url: coin, goal: "get the price", subject: &subject, reworded: false, sibling: false, given: &none }).is_some(), "another call's list of other things");
}

/// A learn whose first reply came from the walk writes the route's first answer as its first sighting, as a call's
/// does: the next value is then served warm by the route's own call, its answer held against that first one, with no
/// browser (`browser: "never"`). Without the sighting, the next value's call had nothing to be held against and went
/// to the browser on doubt.
#[test]
fn after_a_first_reply_from_the_walk_the_next_value_is_served_by_the_routes_own_call() {
    // An item looked up by its number: the answer says the number once, so only the first sighting's answer tells a
    // right answer for the next number from a call deaf to it (`confirm::by_its_call`, a value that names a thing).
    let item = |id: &str, name: &str, price: u32| -> &'static str {
        Box::leak(serde_json::json!({ "item": { "sku": id, "name": name, "price": price, "maker": format!("{name} works of the old town"), "about": format!("A {name}, made by hand and finished in the workshop"),
            "material": format!("{name} timber and metal"), "care": format!("Wipe the {name} with a dry cloth"), "shipping": format!("The {name} ships in five days"), "stock": price % 7 } }).to_string().into_boxed_str())
    };
    let (home, rt, node, a, port) = node_and_site("first-from-the-walk", vec![(200, item("7731", "brass desk lamp", 40)), (200, item("8842", "oak writing desk", 310)), (200, item("8842", "oak writing desk", 310))]);
    let url = format!("http://127.0.0.1:{port}/api/item?id=7731");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "details of this item", "You") else { panic!("a JSON url is its own route") };
    // The first reply, as the walk path makes it: the walk's own answer for 7731.
    let inputs = goal::inputs_for(&route, &url, HashMap::new());
    let subject = crate::learn::subject_of(&url, "details of this item");
    let ask = Asked { url: &url, goal: "details of this item", subject: &subject, reworded: false, sibling: false, given: &inputs };
    let whole = serde_json::from_str::<Value>(item("7731", "brass desk lamp", 40)).unwrap().into();
    let first = goal::take_the_walks_answer(&route, &inputs, &[], &whole, &ask, 1234).expect("the walk's answer answers");
    assert!(first["data"].to_string().contains("brass desk lamp"), "{first}");
    // The walk's reply is a whole CallResult, as agent-api.json publishes it: every learned unbrowse_do broke its schema
    // when it said `answered_by` and left out ms, paid_usdc, paid_unb, possible_commit and retry (QA run 44691479204).
    crate::apischema::check(&crate::apischema::r("CallResult"), &first, &crate::apischema::types()).unwrap_or_else(|e| panic!("the walk's reply {first}: {e}"));
    assert_eq!((first["ms"].clone(), first["browser"].clone()), (json!(1234), json!(true)), "{first}");
    let next = format!("http://127.0.0.1:{port}/api/item?id=8842");
    let again = DoBody { goal: "details of this item".into(), url: next, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true , budget_usdc: None};
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, again)).await.expect("answered") });
    let r = r.unwrap_or_else(|f| panic!("served warm, no browser: {f:?}"));
    assert_eq!((r["how"].as_str(), r["route"]["verdict"].as_str()), (Some("called"), Some("agreed")), "{r}");
    assert!(r["result"]["data"].to_string().contains("oak writing desk") && !r["result"]["data"].to_string().contains("brass"), "{r}");
    crate::apischema::check(&(PRIMITIVES.iter().find(|p| p.tool == "unbrowse_do").unwrap().returns)(), &r, &crate::apischema::types()).unwrap_or_else(|e| panic!("the warm call's reply {r}: {e}"));
    assert_eq!(r["result"]["browser"], json!(false), "the route's own call answered, no browser: {r}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_warm_reply_is_judged_before_its_fields_are_projected() {
    let goal_text = "list the products with price";
    let data = json!({ "items": (0..8).map(|i| json!({
        "title": format!("Desk lamp {i}"),
        "price": 25 + i,
        "about": "A desk lamp with an adjustable shade. ".repeat(20)
    })).collect::<Vec<_>>() });
    let body: &'static str = Box::leak(data.to_string().into_boxed_str());
    let (home, rt, node, a, port) = node_and_site("warm-whole-answer", vec![(200, body), (200, body)]);
    let url = format!("http://127.0.0.1:{port}/api/products");
    let crate::learn::Plain::Route(mut route) = crate::learn::learn_plain(&url, goal_text, "You") else { panic!("the JSON page teaches a route") };
    route.fields = vec!["items[].title".into()];
    route.stats.fields_rule = unbrowse_learn::fields::DEFAULTS_RULE;
    store::save_route(&route).unwrap();
    let ask = DoBody { goal: goal_text.into(), url, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let reply = rt.block_on(async move { do_goal(&node, &a, ask).await }).expect("the whole reply has prices");
    assert_eq!(reply["how"], "called");
    assert_eq!(reply["result"]["browser"], false);
    let item = &reply["result"]["data"]["items"][0];
    assert_eq!(item["title"], "Desk lamp 0");
    assert!(item.get("price").is_none(), "{item}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_walk_and_its_replay_return_the_same_saved_records() {
    let first = r#"{"items":[{"title":"Lamp","url":"/item/1"},{"title":"Desk","url":"/item/2"},{"title":"Chair","url":"/item/3"}]}"#;
    let second = r#"{"items":[{"title":"Clock","url":"/item/4"},{"title":"Shelf","url":"/item/5"},{"title":"Rug","url":"/item/6"}]}"#;
    let goal_text = "list saved items: each item's title and link";
    let (home, rt, node, agent, port) = node_and_site("walked-saved-records", vec![(200, first)]);
    let root = format!("http://127.0.0.1:{port}/saved");
    let initial = format!("{root}?params=%7B%22count%22%3A3%7D");
    let later = format!("{root}?params=%7B%22count%22%3A3%2C%22cursor%22%3A%22more%22%7D");
    let graph = serde_json::from_value(json!({ "provisional": false, "steps": [{
        "exchange": 0, "method": "GET", "status": 200, "url": initial, "fields": [], "needs_browser": false
    }] })).unwrap();
    let route = store::Route::from_graph("once".into(), goal_text.into(), root.clone(), graph).unwrap();
    store::save_route(&route).unwrap();
    let exchange = |url: &str, body: &str| unbrowse_learn::Exchange {
        method: "GET".into(), url: url.parse().unwrap(), request_headers: Vec::new(), request_body: None,
        status: 200, response_headers: Vec::new(), response_body: Some(body.into()), response_mime: "application/json".into(),
        resource_type: Some("Fetch".into()), main_frame: Some(true),
    };
    let trace = unbrowse_learn::Trace { exchanges: vec![exchange(&initial, first), exchange(&later, second)], inputs: Vec::new() };
    let given = HashMap::new();
    let walked = crate::learn::confirm::walks_answer(&route, &trace, &given).unwrap();
    let ask = Asked { url: &root, goal: goal_text, subject: &[], reworded: false, sibling: false, given: &given };
    let cold = goal::take_the_walks_answer(&route, &given, &[], &walked, &ask, 42).unwrap();
    assert_eq!(cold["browser"], true);
    let next = DoBody { goal: goal_text.into(), url: root, inputs: given, session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let warm = rt.block_on(do_goal(&node, &agent, next)).unwrap();
    assert_eq!(warm["result"]["browser"], false);
    assert_eq!(cold["data"], warm["result"]["data"]);
    assert_eq!(cold["data"]["items"][0]["title"], "Lamp");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_document_walk_and_its_replay_keep_the_links_to_their_structured_records() {
    let goal_text = "List the first five results: each title, price and link";
    let items: Vec<_> = (0..5).map(|i| json!({
        "title": format!("Brass Desk Lamp {i}"), "price": "$25", "photo": format!("/photos/{i}.jpg")
    })).collect();
    let page = |related| {
        let anchors = (0..5).map(|i| {
            let label = if related { format!("Brass Desk Lamp {i}<span>$25</span>") } else { format!("Shop information {i}") };
            format!("<a href='/item/{i}'>{label}</a><a href='/item/{i}?map=1'>Show on map</a>")
        }).collect::<String>();
        let titles = (0..5).map(|i| format!("<p>Brass Desk Lamp {i}</p>")).collect::<String>();
        let promotions: Vec<_> = (0..5).map(|i| {
            let mut row = json!({"title": format!("Shop information {i}"), "price": "$25"});
            if !related {
                row["url"] = format!("/promotion/{i}").into();
            }
            row
        }).collect();
        format!("<html><head><title>Desk lamps</title><script type='application/json'>{}</script></head><body><main>{titles}{anchors}</main></body></html>",
            json!({"searchResults": {"listings": items}, "promotions": promotions, "labels": {"map": "Show on map"}}))
    };
    let body = page(true);
    let (home, rt, node, agent, port) = node_and_site("walked-rendered-links", vec![(200, Box::leak(body.clone().into_boxed_str()))]);
    let url = format!("http://127.0.0.1:{port}/search");
    let graph = serde_json::from_value(json!({ "provisional": false, "steps": [{
        "exchange": 0, "method": "GET", "status": 200, "url": url, "fields": [], "needs_browser": false
    }] })).unwrap();
    let mut route = store::Route::from_graph("once".into(), goal_text.into(), url.clone(), graph).unwrap();
    route.heard.records_at = Some("searchResults/listings".into());
    route.heard.document_records = true;
    store::save_route(&route).unwrap();
    let trace = |body: String| unbrowse_learn::Trace { inputs: Vec::new(), exchanges: vec![unbrowse_learn::Exchange {
        method: "GET".into(), url: url.parse().unwrap(), request_headers: Vec::new(), request_body: None,
        status: 200, response_headers: Vec::new(), response_body: Some(body), response_mime: "text/html".into(),
        resource_type: Some("Document".into()), main_frame: Some(true),
    }] };
    let given = HashMap::new();
    let ask = Asked { url: &url, goal: goal_text, subject: &[], reworded: false, sibling: false, given: &given };
    let walked = crate::learn::confirm::walks_answer(&route, &trace(body), &given).unwrap();
    assert_eq!(walked.data["searchResults"]["listings"].as_array().unwrap().len(), 5);
    let cold = goal::take_the_walks_answer(&route, &given, &[], &walked, &ask, 42).expect("the document names and links its five rows");
    assert_eq!(cold["browser"], true);
    assert!(cold["data"].get("promotions").is_none());
    let first_links = cold["data"]["links"].as_array().unwrap();
    assert_eq!(first_links[..5].iter().map(|link| link["url"].as_str().unwrap()).collect::<Vec<_>>(),
        (0..5).map(|i| format!("http://127.0.0.1:{port}/item/{i}")).collect::<Vec<_>>());
    assert_eq!(first_links[5]["text"], "Show on map");
    let mut title_route = route.clone();
    title_route.what = "list the results with the title and price".into();
    let priced = crate::run::as_a_reply(&title_route, &given, &[], walked.clone(), 42, false);
    let linked = goal::records_for_ask(priced, &title_route, &ask, &[], Some(&walked));
    assert_eq!(linked["data"]["links"], cold["data"]["links"]);

    let unrelated = crate::learn::confirm::walks_answer(&route, &trace(page(false)), &given).unwrap();
    assert_eq!(unrelated.data["promotions"].as_array().unwrap().len(), 5);
    assert!(goal::take_the_walks_answer(&route, &given, &[], &unrelated, &ask, 42).is_none());
    let next = DoBody { goal: goal_text.into(), url, inputs: given, session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let warm = rt.block_on(do_goal(&node, &agent, next)).unwrap();
    assert_eq!(warm["result"]["browser"], false);
    assert_eq!(warm["result"]["data"]["links"], cold["data"]["links"]);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_ask_for_each_record_uses_the_list_over_fields_in_the_response_wrapper() {
    let goal = "search results for lamps: each product's name, price and link";
    let data = json!({
        "productInfo": {"name": "Catalog", "price": "$0.00", "url": "/catalog"},
        "mods": {"listItems": (0..8).map(|i| json!({
            "name": format!("Lamp {i}"), "priceShow": "$23.00", "itemUrl": format!("https://shop.example/product/{i}")
        })).collect::<Vec<_>>()}
    });
    assert!(goal::holds_goal(&data, goal));
}


/// Calls first: a route learned on one value is called for the next, the agent's own ask, and its answer stands by the
/// readers a confirming browse holds it to (the new value's own records, said back by them, not the first value's
/// again): it is served warm, the call is the route's second sighting and the route stands confirmed, and no browser
/// is opened (`browser: "never"` would fail a browse). Before, the browser served the first new value of every route
/// of one sighting (3 to 45 s on the owner's real routes, where PR 542 called them warm).
#[test]
fn a_new_value_is_served_by_the_routes_own_call_when_its_answer_stands() {
    let body = |w: &str| -> &'static str { Box::leak(serde_json::json!({ "query": w, "results": (0..6).map(|n| json!({ "id": n, "title": format!("{w} item number {n}") })).collect::<Vec<_>>() }).to_string().into_boxed_str()) };
    let (home, rt, node, a, port) = node_and_site("calls-first", vec![(200, body("kettle")), (200, body("teapot"))]);
    let url = format!("http://127.0.0.1:{port}/api/items?q=kettle");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    crate::learn::sighted::called(&route, &HashMap::new(), Some(&serde_json::from_str(body("kettle")).unwrap()), true, 40, 0);
    let next = format!("http://127.0.0.1:{port}/api/items?q=teapot");
    let ask = DoBody { goal: "search the items".into(), url: next, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, ask)).await.expect("answered") }).unwrap();
    assert_eq!(r["how"], "called", "{r}");
    assert_eq!(r["route"]["verdict"], "agreed", "{r}");
    assert!(r["result"]["data"].to_string().contains("teapot item number 2"), "{r}");
    let stood = store::load_route(&route.id).expect("the route stands");
    assert!(!stood.provisional && stood.heard.said_back.as_deref() == Some("teapot") && stood.heard.records_at.as_deref() == Some("results"), "{:?}", stood.heard);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_completed_search_serves_its_changed_results_without_browser_confirmation() {
    let (home, rt, node, agent, _) = node_and_site("completed-search-records", vec![(200, "{}")]);
    let body = |query: &str, title: &str| {
        let args = json!({"keyword": query, "page": 0});
        let key = format!("search({args})");
        let events: Vec<_> = (1..=5).map(|i| json!({
            "name": format!("{title} {i}"), "date": "2026-12-03",
            "url": format!("https://shop.example/events/{}-{i}", title.replace(' ', "-"))
        })).collect();
        json!({
            "queries": {(key): {"status": "fulfilled", "originalArgs": args, "data": {"events": events}}},
            "navigation": (0..800).map(|i| json!({"title": format!("Navigation label {i}")})).collect::<Vec<_>>()
        })
    };
    let port = a_site_answering_by_its_request(move |target| {
        let (query, title) = if target.contains("q=chairs") { ("chairs", "New show") } else { ("mirrors", "Lamp concert") };
        (200, body(query, title).to_string())
    });
    let mut page = a_lamps_route_on("bound-search", port);
    page.what = "search events and list their name, date and link".into();
    page.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    store::save_route(&page).unwrap();
    crate::learn::sighted::called(&page, &HashMap::new(), Some(&body("lamps", "Lamp concert")), true, 1, 0);
    let ask = |query| DoBody {
        goal: page.what.clone(), url: format!("http://127.0.0.1:{port}/find?q={query}"), browser: "never".into(),
        inputs: HashMap::new(), session: String::new(), fields: Vec::new(), many: true, budget_usdc: None,
    };
    let stale = rt.block_on(do_goal(&node, &agent, ask("mirrors"))).expect_err("the cache key changed but the records stayed the same");
    assert_eq!(stale.0, StatusCode::PRECONDITION_FAILED);
    let reply = rt.block_on(do_goal(&node, &agent, ask("chairs"))).expect("the completed result list changed");
    assert_eq!(reply["route"]["id"], "bound-search", "{reply}");
    assert_eq!(reply["route"]["verdict"], "agreed", "{reply}");
    assert_eq!(reply["result"]["browser"], false, "{reply}");
    assert!(reply["result"]["data"].to_string().contains("New show 2"), "{reply}");
    assert_eq!(store::load_route(&page.id).unwrap().heard.records_at.as_deref(), Some("queries/search/data/events"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn another_stored_read_is_called_before_browser_confirmation() {
    let (home, rt, node, agent, _) = node_and_site("other-stored-read", vec![(200, "{}")]);
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let heard = calls.clone();
    let port = a_site_answering_by_its_request(move |target| {
        heard.lock().unwrap().push(target.to_string());
        let word = if target.starts_with("/find?") { "chairs" } else { "lamps" };
        let items: Vec<_> = (0..6).map(|n| json!({"title": format!("{word} model {n}")})).collect();
        (200, json!({"results": items}).to_string())
    });
    let root = format!("http://127.0.0.1:{port}/find?q=lamps");
    let goal = "search the listings";
    let mut stale = a_lamps_route_on("stale-call", port);
    stale.what = goal.into();
    stale.root = root.clone();
    store::save_route(&stale).unwrap();
    let mut page = a_lamps_route_on("opening-page", port);
    page.what = goal.into();
    page.root = root;
    page.path = "/find?q={q}".into();
    page.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    page.graph.provisional = true;
    store::save_route(&page).unwrap();
    let ask = DoBody {
        goal: goal.into(), url: format!("http://127.0.0.1:{port}/find?q=chairs"), browser: "never".into(),
        inputs: HashMap::new(), session: String::new(), fields: Vec::new(), many: true, budget_usdc: None,
    };
    let reply = rt.block_on(do_goal(&node, &agent, ask)).expect("the next stored route can answer");
    assert_eq!(reply["route"]["id"], "opening-page", "{reply}");
    assert_eq!(reply["result"]["browser"], false, "{reply}");
    assert!(reply["result"]["data"].to_string().contains("chairs model 2"), "{reply}");
    assert_eq!(*calls.lock().unwrap(), ["/api/items?q=chairs", "/find?q=chairs"]);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_skipped_alternative_leaves_the_first_routes_browser_confirmation_queued() {
    let (home, rt, node, agent, _) = node_and_site("deferred-confirmation", vec![(200, "{}")]);
    let port = a_site_answering_by_its_request(|target| {
        let word = if target.starts_with("/find?") { "chairs" } else { "lamps" };
        let results: Vec<_> = (0..5).map(|id| json!({"title":format!("{word} {id}")})).collect();
        (200, json!({"query":word,"results":results}).to_string())
    });
    let goal = "show my order history";
    assert!(!unbrowse_learn::goal::only_reads(goal));
    for (i, id) in ["old-orders", "new-orders"].into_iter().enumerate() {
        let mut route = a_lamps_route_on(id, port);
        route.what = goal.into();
        route.root = format!("http://127.0.0.1:{port}/find?q=lamps");
        route.learned_at = i as u64 + 1;
        store::save_route(&route).unwrap();
    }
    let ask = DoBody { goal: goal.into(), url: format!("http://127.0.0.1:{port}/find?q=chairs"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let (status, why) = rt.block_on(do_goal(&node, &agent, ask)).expect_err("the first route still needs browser confirmation");
    assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{why}");
    assert!(why.contains("served by the node's browser"), "{why}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_browserless_search_serves_the_opening_pages_completed_empty_results() {
    let (home, rt, node, agent, _) = node_and_site("completed-empty-search", vec![(200, "{}")]);
    let state = json!({"context":{"query":"zqxv"},"listingCards":[],"numberOfResults":0,"pending":false,"error":null});
    let (port, heard) = hearing_site(json!({"search":state,"chrome":{"theme":"light","script":"y".repeat(64_000)}}).to_string());
    let goal = "search product listings with names and prices";
    let mut page = a_lamps_route_on("opening-page", port);
    page.what = goal.into();
    page.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    page.path = "/find?q={q}".into();
    page.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");

    for confirmed in [false, true] {
        if confirmed {
            page.heard.said_back = Some("chairs".into());
            page.heard.records_at = Some("search/listingCards".into());
            page.heard.document_records = true;
        }
        store::save_route(&page).unwrap();
        let ask = DoBody {
            goal: goal.into(), url: format!("http://127.0.0.1:{port}/find?q=zqxv"), browser: "never".into(),
            inputs: HashMap::new(), session: String::new(), fields: vec!["chrome.theme".into()], many: true, budget_usdc: None,
        };
        let reply = rt.block_on(do_goal(&node, &agent, ask)).expect("the completed empty result answers the ask");
        assert_eq!(reply["outcome"], "answered_empty", "{reply}");
        assert_eq!(reply["outcome_from"], "goal.empty_page_search", "{reply}");
        assert_eq!(reply["result"]["browser"], false, "{reply}");
        assert_eq!(reply["result"]["records"], 0, "{reply}");
        assert_eq!(reply["result"]["data"]["search"], state, "{reply}");
        assert_eq!(reply["result"]["data"]["chrome"]["theme"], "light", "{reply}");
    }
    assert_eq!(*heard.lock().unwrap(), ["/find?q=zqxv", "/find?q=zqxv"]);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_empty_document_reply_uses_the_exact_page_and_keeps_owner_values_private() {
    let private = "owner's private lookup";
    let (port, _) = hearing_site("{}".into());
    let root = format!("http://127.0.0.1:{port}/find?q=desk");
    let mut route = a_lamps_route_on("private-empty", port);
    route.root = root.clone();
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    route.inputs[0].default = Some(private.into());
    route.session_gave = true;
    route.given = vec!["q".into()];
    route.heard.records_at = Some("search/listingCards".into());
    route.heard.document_records = true;
    let given = HashMap::from([("q".into(), "desk".into())]);
    let ask = Asked { url: &root, goal: "search listings", subject: &[], reworded: false, sibling: false, given: &given };
    let r = json!({"ok":true,"browser":false,"records":0,"data":{"recent":"{q}"}});
    let data = json!({"search":{"query":"desk","listingCards":[],"resultCount":0,"pending":false},"recent":private});
    let fields = vec!["recent".into()];
    let reply = goal::empty_page_reply(&r, &route, &ask, Some(&data.clone().into()), &fields, Some(goal::MISSING_RECORDS)).unwrap();
    assert_eq!(reply["result"]["data"]["recent"], "{q}");
    route.heard.document_records = false;
    let partial = json!({"search":{"query":"desk","pending":true},
        "catalog":{"query":"desk","listingCards":[],"resultCount":0,"pending":false}});
    assert!(goal::empty_page_reply(&r, &route, &ask, Some(&partial.into()), &fields, Some(goal::MISSING_RECORDS)).is_none(),
        "a legacy recorded list still has to supply its own evidence");
    route.heard.document_records = true;
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/Find?q={{q}}");
    assert!(goal::empty_page_reply(&r, &route, &ask, Some(&data.clone().into()), &fields, Some(goal::MISSING_RECORDS)).is_none());
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/%66ind?q={{q}}");
    assert!(goal::calls_the_page_itself(&route, &root));
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find//items?q={{q}}");
    assert!(!goal::calls_the_page_itself(&route, &format!("http://127.0.0.1:{port}/find/items?q=desk")));
    route.root = format!("http://127.0.0.1:{port}/find/lamps");
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find/{{q}}/");
    assert!(goal::calls_the_page_itself(&route, &format!("http://127.0.0.1:{port}/find/desk")));
    assert!(!goal::calls_the_page_itself(&route, &format!("http://127.0.0.1:{port}/find//desk")));
    route.heard.document_records = false;
    assert!(goal::calls_the_page_itself(&route, &format!("http://127.0.0.1:{port}/find/desk")));
    route.root.push('/');
    assert!(!goal::calls_the_page_itself(&route, &format!("http://127.0.0.1:{port}/find/desk")));
}

#[test]
fn a_direct_document_call_preserves_the_learned_querys_completed_empty_result() {
    let (home, rt, node, agent, _) = node_and_site("direct-empty-learned-query", vec![(200, "{}")]);
    let state = json!({"query":"lamps","listingCards":[],"resultCount":0,"loading":false});
    let (port, _) = hearing_site(json!({"search":state}).to_string());
    let mut route = a_lamps_route_on("same-query-empty", port);
    route.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    route.heard.records_at = Some("search/listingCards".into());
    route.heard.document_records = true;
    store::save_route(&route).unwrap();
    let reply = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, route.id, Default::default(), vec![]))).unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["browser"], false);
    assert_eq!(reply["records"], 0);
    assert_eq!(reply["outcome"], "answered_empty");
    assert_eq!(reply["data"]["search"], state);

    let (port, _) = hearing_site(json!({"results":[]}).to_string());
    let mut saved = a_lamps_route_on("saved-items-empty", port);
    saved.what = "read my saved items".into();
    saved.root = format!("http://127.0.0.1:{port}/list");
    saved.path = "/list".into();
    saved.graph.steps[0].url = saved.root.clone();
    saved.graph.steps[0].fields.clear();
    saved.inputs.clear();
    saved.heard.records_at = Some("results".into());
    store::save_route(&saved).unwrap();
    let empty = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, saved.id.clone(), Default::default(), vec![]))).unwrap();
    assert_eq!(empty["ok"], true, "{empty}");
    assert_eq!(empty["browser"], false);
    assert_eq!(empty["records"], 0);
    assert_eq!(empty["outcome"], "answered_empty");
    assert_eq!(empty["data"]["results"], json!([]));
    let ask = DoBody { goal: saved.what, url: saved.root, browser: "never".into(), inputs: HashMap::new(),
        session: String::new(), fields: Vec::new(), many: false, budget_usdc: None };
    let empty = rt.block_on(goal::do_goal_said(&node, &agent, ask)).unwrap();
    assert_eq!(empty["outcome"], "answered_empty", "{empty}");
    assert_eq!(empty["result"]["browser"], false);

    let mut search = a_lamps_route_on("empty-search-shell", port);
    search.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    search.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    search.heard.records_at = Some("results".into());
    store::save_route(&search).unwrap();
    let empty_api = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, search.id.clone(), HashMap::from([("q".into(), "chairs".into())]), vec![]))).unwrap();
    assert_eq!(empty_api["ok"], true, "an API can return an empty list: {empty_api}");
    assert_eq!(empty_api["records"], 0);
    assert_eq!(empty_api["data"]["results"], json!([]));
    let empty_api_goal = rt.block_on(goal::do_goal_said(&node, &agent, DoBody {
        goal: search.what.clone(), url: format!("http://127.0.0.1:{port}/find?q=chairs"), browser: "never".into(),
        inputs: HashMap::new(), session: String::new(), fields: Vec::new(), many: false, budget_usdc: None,
    })).unwrap();
    assert_eq!(empty_api_goal["outcome"], "answered_empty", "{empty_api_goal}");
    assert_eq!(empty_api_goal["result"]["browser"], false);
    assert_eq!(empty_api_goal["result"]["data"]["results"], json!([]));

    let (missing_port, _) = hearing_site(json!({"metadata":"request received"}).to_string());
    let mut missing = search.clone();
    missing.root = format!("http://127.0.0.1:{missing_port}/find?q=lamps");
    missing.graph.steps[0].url = format!("http://127.0.0.1:{missing_port}/find?q={{q}}");
    store::save_route(&missing).unwrap();
    let missing_api = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, missing.id, HashMap::from([("q".into(), "chairs".into())]), vec![]))).unwrap();
    assert_eq!(missing_api["ok"], false, "the witnessed API result list is missing: {missing_api}");
    assert_eq!(missing_api["error"], goal::MISSING_RECORDS);

    search.heard.document_records = true;
    store::save_route(&search).unwrap();
    let shell = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, search.id, Default::default(), vec![]))).unwrap();
    assert_eq!(shell["ok"], false, "a bound search must show that the query completed: {shell}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn recent_searches_do_not_make_the_observed_result_list_stale() {
    let (home, rt, node, agent, _) = node_and_site("previous-search-in-chrome", vec![(200, "{}")]);
    let data = json!({
        "results": [{"name":"Chaise Longue", "price":"$20.00", "link":"https://shop.example/chaise"}],
        "recent_searches":[{"value":"lamps"}]
    });
    let (port, _) = hearing_site(data.to_string());
    let what = "search items and list the name, price and link of each result";
    let mut route = a_lamps_route_on("previous-search", port);
    route.what = what.into();
    route.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    route.heard.records_at = Some("results".into());
    route.heard.document_records = true;
    route.judged.fields = true;
    store::save_route(&route).unwrap();
    let given = HashMap::from([("q".into(), "chairs".into())]);
    let fields = vec!["results[].name".into()];
    let (reply, url) = (json!({"ok":true,"browser":false,"records":1,"data":data}), route.root.clone());
    let ask = Asked { url: &url, goal: what, subject: &[], reworded: false, sibling: false, given: &given };
    assert_eq!(goal::unanswered(&reply, &route, &ask), None);
    let direct = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, route.id.clone(), given.clone(), fields.clone()))).unwrap();
    assert_eq!(direct["ok"], true, "{direct}");
    assert_eq!(direct["data"]["results"][0]["name"], "Chaise Longue");

    let mut stale = reply;
    stale["data"]["results"][0]["name"] = json!("Reading light");
    stale["data"]["query"] = json!("lamps");
    assert_eq!(goal::unanswered(&stale, &route, &ask), Some(json!("it answered what the walk asked, not what this page asks")));
    let relabelled = json!({"query":"chairs", "results":[{"name":"Reading lamps"}]});
    assert!(goal::replay_answers_the_walk(&route, &given, &relabelled, &relabelled), "the label changed but the records still name the old query");
    let current = json!({"query":"chairs", "results":[{"name":"Chaise Longue"}],"recent_searches":[{"value":"lamps"}]});
    assert!(!goal::replay_answers_the_walk(&route, &given, &current, &current));
    let mut nested = route.clone();
    nested.heard.records_at = Some("search/payload/results".into());
    let stale_nested = json!({"search":{"query":"lamps","payload":{"results":stale["data"]["results"]}}});
    assert!(goal::replay_answers_the_walk(&nested, &given, &stale_nested, &stale_nested));
    let (port, _) = hearing_site(stale["data"].to_string());
    route.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    store::save_route(&route).unwrap();
    let direct = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
        &node, &agent, route.id, given, fields))).unwrap();
    assert_eq!(direct["outcome_from"], "call.answers_the_walk", "{direct}");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn an_unchanged_query_label_cannot_name_a_different_filter_with_the_same_default() {
    let mut route = a_lamps_route_on("same-defaults", 1);
    route.heard.records_at = Some("results".into());
    let mut filter = route.inputs[0].clone();
    filter.name = "brand".into();
    route.inputs[0].default = Some("apple".into());
    filter.default = Some("apple".into());
    route.inputs.push(filter);
    let reply = json!({"query":"apple", "results":[{"name":"Samsung charger","brand":"Samsung"}]});
    let filtered = HashMap::from([("brand".into(), "samsung".into())]);
    assert!(!goal::replay_answers_the_walk(&route, &filtered, &reply, &reply));

    let prior_rows = json!({"query":"apple", "results":[{"name":"Apple charger","brand":"Apple"}]});
    assert!(goal::replay_answers_the_walk(&route, &filtered, &prior_rows, &prior_rows));
    route.inputs.pop();
    let query_changed = HashMap::from([("q".into(), "samsung".into())]);
    assert!(goal::replay_answers_the_walk(&route, &query_changed, &reply, &reply), "an unambiguous old label is evidence");
}

#[test]
fn unready_documents_and_pending_apis_cannot_certify_an_empty_replay() {
    let (home, rt, node, agent, _) = node_and_site("unready-empty-replay", vec![(200, "{}")]);
    let shell = r#"<html><head><title>Search</title><script type="application/json">{"results":[]}</script></head><body>Finding matches</body></html>"#;
    let fragment = r#"<script type="application/json">{"results":[]}</script>"#;
    let pending = r#"{"results":[],"pending":true}"#;
    let nested_pending = r#"{"loading":true,"search":{"results":[]}}"#;
    for (id, body, place) in [
        ("legacy-document", shell, "results"),
        ("legacy-document-no-input", shell, "results"),
        ("legacy-script-fragment", fragment, "results"),
        ("pending-api", pending, "results"),
        ("pending-side-api", pending, "results"),
        ("pending-ancestor", nested_pending, "search/results"),
    ] {
        let (port, _) = hearing_site(body.to_string());
        let mut route = a_lamps_route_on(id, port);
        route.root = format!("http://127.0.0.1:{port}/find?q=lamps");
        route.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
        route.heard.records_at = Some(place.into());
        if id.starts_with("legacy-") {
            route.graph.visited.push(0);
            route.graph.steps[0].response_shape = Some(json!({"results":[]}));
        }
        if id == "pending-side-api" {
            route.graph.steps[0].url = format!("http://127.0.0.1:{port}/api/results?q={{q}}");
        }
        let (url, inputs) = if id == "legacy-document-no-input" {
            route.root = format!("http://127.0.0.1:{port}/find");
            route.graph.steps[0].url = route.root.clone();
            route.graph.steps[0].fields.clear();
            route.inputs.clear();
            (route.root.clone(), HashMap::new())
        } else {
            (format!("http://127.0.0.1:{port}/find?q=chairs"), HashMap::from([("q".into(), "chairs".into())]))
        };
        store::save_route(&route).unwrap();
        let direct = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(
            &node, &agent, route.id.clone(), inputs, vec![],
        ))).unwrap();
        assert_eq!(direct["ok"], false, "{id}: {direct}");
        assert_eq!(direct["error"], goal::MISSING_RECORDS, "{id}: {direct}");
        if id == "pending-side-api" {
            continue;
        }
        let ask = DoBody { goal: route.what.clone(), url, browser: "never".into(),
            inputs: HashMap::new(), session: String::new(), fields: Vec::new(), many: false, budget_usdc: None };
        let failure = rt.block_on(goal::do_goal_said(&node, &agent, ask)).expect_err(id);
        assert!(failure.error.contains(goal::MISSING_RECORDS), "{failure:?}");
    }
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn a_pending_search_list_cannot_be_confirmed_by_other_records_on_its_page() {
    let (home, rt, node, agent, _) = node_and_site("pending-recorded-list", vec![(200, "{}")]);
    let catalog: Vec<_> = (1..=5).map(|n| json!({"name":format!("Desk catalog model {n}"),"price":"$30.00","url":format!("/catalog/{n}")})).collect();
    let state = json!({"search":{"query":"desk","listingCards":[],"numberOfResults":0,"pending":true},"catalog":{"results":catalog}});
    let (port, _) = hearing_site(state.to_string());
    let what = "search listings and list the name, price and link of each";
    let mut page = a_lamps_route_on("recorded-page", port);
    page.what = what.into();
    page.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    page.path = "/find?q={q}".into();
    page.graph.steps[0].url = format!("http://127.0.0.1:{port}/find?q={{q}}");
    page.heard.records_at = Some("search/listingCards".into());
    page.heard.document_records = true;
    page.heard.said_back = Some("chairs".into());
    store::save_route(&page).unwrap();

    let ask = DoBody { goal: what.into(), url: format!("http://127.0.0.1:{port}/find?q=desk"), browser: "never".into(),
        inputs: HashMap::new(), session: String::new(), fields: Vec::new(), many: true, budget_usdc: None };
    let failure = rt.block_on(do_goal(&node, &agent, ask)).expect_err("the pending list has no answer yet");
    assert!(failure.1.contains(goal::MISSING_RECORDS), "{failure:?}");
    let direct = rt.block_on(call::with_the_browser_shut(true, call::do_call_when_settled(&node, &agent, page.id,
        HashMap::from([("q".into(), "desk".into())]), vec![]))).expect("the reply says the call failed");
    assert_eq!((direct["ok"].clone(), direct["browser"].clone(), direct["data"].clone()), (json!(false), json!(false), Value::Null), "{direct}");
    assert_eq!(direct["error"], goal::MISSING_RECORDS);
    let _ = std::fs::remove_dir_all(&home);
}

/// A second value on a learned search route is answered by that route's own call, the same route, and no page is
/// walked, where the answer is a page read whole: its results sit among the links of the site's frame, a hundred
/// links both values' pages hold. Before, fewer than half the links naming the new value put the call in doubt, the
/// browser walked the page again and a new route took the old one's place (UNB-244: four sites of the nightly bank
/// re-learned on every second value; `browser: "never"` here fails any walk).
#[test]
fn a_second_value_on_a_page_route_is_called_not_walked_again() {
    let page = |w: &str| -> &'static str {
        let mut links: Vec<Value> = (0..100).map(|n| json!({ "text": format!("Site section {n}"), "url": format!("https://shop.example/section/{n}") })).collect();
        links.extend((0..8).map(|n| json!({ "text": format!("{w} place {n}, region {n}"), "url": format!("https://shop.example/place?key={w}-{n}") })));
        Box::leak(json!({ "title": "Find your place | Shop", "text": format!("Results for {w}\n{w} place 0, region 0\nSite section 1"), "links": links }).to_string().into_boxed_str())
    };
    let (home, rt, node, a, port) = node_and_site("second-value-page-route", vec![(200, page("london")), (200, page("tokyo"))]);
    let url = format!("http://127.0.0.1:{port}/en/search-locations?query=london");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the places", "You") else { panic!("a JSON url is its own route") };
    crate::learn::sighted::called(&route, &HashMap::new(), Some(&serde_json::from_str(page("london")).unwrap()), true, 40, 0);
    let next = format!("http://127.0.0.1:{port}/en/search-locations?query=tokyo");
    let ask = DoBody { goal: "search the places".into(), url: next, inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, ask)).await.expect("answered") }).unwrap_or_else(|f| panic!("called, never walked: {f:?}"));
    assert_eq!((r["how"].as_str(), r["route"]["id"].as_str(), r["route"]["verdict"].as_str()), (Some("called"), Some(route.id.as_str()), Some("agreed")), "{r}");
    assert!(r["result"]["data"].to_string().contains("tokyo place 3"), "{r}");
    assert_eq!(store::load_route(&route.id).and_then(|s| s.heard.said_back), Some("tokyo".to_string()), "the call is the route's second sighting");
    let _ = std::fs::remove_dir_all(&home);
}

/// A first ask that runs past the wait its caller gave is answered when that wait ends, `how: working`, with none of
/// the answer, the ask that names its work, and a `next` that is the call which collects it. That call, made as given
/// with a longer wait, waits for the work that goes on and returns the very answer the work made; asked again, the ask
/// gives that same answer. (The work is a learn made slow by a test, `goal::slow`: nothing is walked.)
#[test]
fn a_first_ask_past_its_wait_says_working_and_waiting_longer_collects_the_answer() {
    let (home, rt, node, headers) = node_with_a_token("ask-working-then-collected");
    let page = "https://slow.example/items?case=working-then-collected";
    let slow = goal::slow::make(page, Some(std::time::Duration::from_millis(600)));
    let (first, _) = do_over_mcp(&rt, &node, &headers, 1, json!({ "goal": "list the items", "url": page, "wait_ms": 100 }));
    assert_eq!((first["how"].as_str(), first["outcome"].as_str()), (Some("working"), Some("still_working")), "{first}");
    assert!(first.get("result").is_none() && first.get("route").is_none(), "none of the answer yet: {first}");
    let id = first["ask"].as_str().expect("its ask").to_string();
    assert!(id.starts_with("ask_"), "{id}");
    assert_eq!(first["next"], json!({ "tool": "unbrowse_do", "args": { "ask": id } }), "{first}");
    // Collected as the reply says, with a longer wait: it waits for the work, and the answer is the work's own.
    let mut collect = first["next"]["args"].clone();
    collect["wait_ms"] = json!(15_000);
    let (got, _) = do_over_mcp(&rt, &node, &headers, 2, collect);
    assert_eq!((got["how"].as_str(), got["outcome"].as_str(), got["ask"].as_str()), (Some("learned"), Some("answered"), Some(id.as_str())), "{got}");
    assert_eq!(got["result"]["data"]["items"][0]["name"], "desk lamp", "{got}");
    assert_eq!(slow.started.load(std::sync::atomic::Ordering::SeqCst), 1, "one walk, whoever asked after it");
    let (again, _) = do_over_mcp(&rt, &node, &headers, 3, json!({ "ask": id }));
    assert_eq!(again["result"], got["result"], "the same answer again");
    let _ = std::fs::remove_dir_all(&home);
}

/// What an agent reads of a route before it calls it (`unbrowse_inspect`): each value's class and where it comes
/// from, whichever kind of value it is; a route nobody holds is not found.
#[test]
fn an_inspect_names_every_kind_of_value_a_route_holds() {
    let home = store::scratch_home("inspect-every-class");
    store::use_home(&home);
    let fields = json!([
        { "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" },
        { "loc": { "in": "query", "key": "lang" }, "class": "constant", "value": "en" },
        { "loc": { "in": "header", "key": "x-token" }, "class": "derived", "origin": { "exchange": 0, "url": "https://shop.example/", "at": { "from": "json", "pointer": "/token" } } },
        { "loc": { "in": "query", "key": "day" }, "class": "piece", "input": "q", "from": 0, "len": 3 },
        { "loc": { "in": "query", "key": "sig" }, "class": "computed" },
        { "loc": { "in": "header", "key": "x-sig" }, "class": "script", "producer": { "script": "https://shop.example/app.js", "at": 10 } },
        { "loc": { "in": "header", "key": "x-hash" }, "class": "recipe", "recipe": { "algo": "sha256", "separator": "", "parts": [{ "part": "path" }, { "part": "method" }] } },
        { "loc": { "in": "header", "key": "x-made" }, "class": "generated", "program": "1+1", "evidence": { "header": "x-made", "sightings": 3, "proposed_by": "an agent", "evidence_hash": "ab" } },
        { "loc": { "in": "cookie", "key": "sid" }, "class": "minted", "name": "sid" },
        { "loc": { "in": "query", "key": "guess" }, "class": "unconfirmed", "value": "x" },
        { "loc": { "in": "query", "key": "rid" }, "class": "fresh", "value": "1700000000000", "id": "rid", "clock": "millis" },
        { "loc": { "in": "query", "key": "size" }, "class": "file", "name": "doc", "of": "size" },
    ]);
    let mut r = route("inspected", "shop.example", "search the shop", &["q"]);
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [step_of("GET", "https://shop.example/api?q={q}", fields)] })).unwrap();
    store::save_route(&r).unwrap();
    let said = super::call::do_inspect("inspected".into()).unwrap();
    let fields = said["steps"][0]["fields"].as_array().expect("the step's values");
    let of = |class: &str| fields.iter().find(|f| f["class"] == class).unwrap_or_else(|| panic!("a {class} value in {said}")).clone();
    assert_eq!(of("input")["input"], json!({ "name": "q", "secret": false, "optional": false }));
    assert_eq!(of("derived")["from_exchange"], 0);
    assert_eq!(of("script")["producer"], json!({ "script": "https://shop.example/app.js", "at": 10 }));
    assert_eq!(of("recipe")["recipe"], json!({ "algo": "sha256", "parts": 2 }));
    assert_eq!((of("generated")["program_bytes"].clone(), of("generated")["evidence"]["sightings"].clone()), (json!(3), json!(3)));
    assert_eq!(of("unconfirmed")["provisional"], true);
    for plain in ["constant", "piece", "computed", "fresh", "file"] {
        assert!(of(plain).get("at").is_some(), "{plain} says where it sits");
    }
    assert_eq!(said["route"]["id"], "inspected");
    assert_eq!(said["browser"], true, "a value the page's own code makes needs the browser");
    assert_eq!(super::call::do_inspect("nobody-holds-this".into()).unwrap_err().0, StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&home);
}

/// A kept copy of another contributor's route that did not run says why by its status: a delisted one is gone (the
/// goal goes on to other routes and the page), one whose check couldn't be made is for later.
#[test]
fn a_kept_copy_that_did_not_run_is_gone_or_for_later() {
    let (status, why) = super::call::not_run(share::NotRun::Delisted);
    assert_eq!(status, StatusCode::GONE);
    assert!(why.contains("delisted"), "{why}");
    let (status, why) = super::call::not_run(share::NotRun::Unchecked("the chain is away".into()));
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(why.contains("the chain is away") && why.contains("try again"), "{why}");
}

/// A route of a site on this machine that lists lamps, taking `q` (walked as `lamps`), saved under `id`.
fn a_lamps_route_on(id: &str, port: u16) -> store::Route {
    let r: store::Route = serde_json::from_value(json!({
        "id": id, "site": "127.0.0.1", "what": "list the lamps", "method": "GET", "path": "/api/items", "root": format!("http://127.0.0.1:{port}/"),
        "inputs": [{ "name": "q", "secret": false, "default": "lamps" }], "steps": 1, "browser_assisted": false, "walk_without_fragment": true,
        "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/api/items?q={{q}}"), "needs_browser": false,
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
    }))
    .unwrap();
    store::save_route(&r).unwrap();
    r
}

/// A call of route `id` for `q`, settled as an agent's is (`do_call_when_settled`).
fn settled_call(rt: &tokio::runtime::Runtime, node: &Arc<Node>, a: &Agent, id: &str, q: &str) -> Value {
    let (n, a, id, q) = (node.clone(), a.clone(), id.to_string(), q.to_string());
    rt.block_on(async move { super::call::do_call_when_settled(&n, &a, id, HashMap::from([("q".to_string(), q)]), Vec::new()).await }).expect("the call ran")
}

/// A page that asks for a person, read back as a call's answer, is the site's check and not what was called for: the
/// reply says so (`challenge`, with the call that looks at it), and is not ok.
#[test]
fn a_call_that_came_back_as_a_check_says_so() {
    let (home, rt, node, a, _) = node_and_site("call-settled-check", vec![(200, "{}")]);
    let (port, _) = hearing_site(json!({ "title": "Just a moment", "text": "Please verify you are human by solving the captcha to continue." }).to_string());
    a_lamps_route_on("check-route", port);
    let r = settled_call(&rt, &node, &a, "check-route", "lamps");
    assert_eq!((r["ok"].clone(), r["outcome"].as_str(), r["outcome_from"].as_str()), (json!(false), Some("challenge"), Some("call.asks_a_person")), "{r}");
    assert!(r["error"].as_str().unwrap().contains("asks for a person"), "{r}");
    assert_eq!(r["next"]["tool"], "unbrowse_challenge", "{r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// An answer that says the value the route was learned on and no word of the one this call gave is the walk's answer,
/// not this call's, whatever the site's status says: the reply is not ok. The same answer for the walk's own value stands.
#[test]
fn a_call_that_came_back_as_the_walks_answer_says_so() {
    let (home, rt, node, a, _) = node_and_site("call-settled-walk", vec![(200, "{}")]);
    let (port, _) = hearing_site(json!({ "items": [{ "name": "lamps" }, { "name": "lamps again" }] }).to_string());
    a_lamps_route_on("walk-route", port);
    let r = settled_call(&rt, &node, &a, "walk-route", "chairs");
    assert_eq!((r["ok"].clone(), r["outcome"].as_str(), r["outcome_from"].as_str()), (json!(false), Some("call_failed"), Some("call.answers_the_walk")), "{r}");
    assert!(r["error"].as_str().unwrap().contains("not what this call asked"), "{r}");
    let r = settled_call(&rt, &node, &a, "walk-route", "lamps");
    assert_eq!(r["ok"], true, "{r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// An owner who turned learning off hears so when no route does the goal and the page would have been walked: nothing
/// is opened, and the answer is a refusal that names the setting.
#[test]
fn an_owner_who_turned_learning_off_is_told_so_when_no_route_does_the_goal() {
    let (home, rt, node, a, _) = node_and_site("learning-off", vec![(200, "{}")]);
    store::save_settings(&store::Settings { fetch_browser: false, map_while_browsing: false, ..store::Settings::default() }).unwrap();
    let body = DoBody { goal: "list the items".into(), url: "https://nowhere.example/items".into(), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let (status, said) = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap_err();
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(said.contains("no route does that, and the owner has turned learning off"), "{said}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A site on this machine that answers each request by its request line (`GET /path?query HTTP/1.1`): the status and
/// body `answer` gives for it.
fn a_site_answering_by_its_request(answer: impl Fn(&str) -> (u16, String) + Send + 'static) -> u16 {
    use std::io::{BufRead, Write};
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
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
            let (status, body) = answer(&target);
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    port
}

/// A search route that hears its caller, asked a value the site has nothing for (it answers 404), where the site still
/// answers the value the route was learned on: the caller is told at once that nothing is there for this value, as an
/// empty answer from the goal and never an answer, and the page is not walked again to learn the call it already has.
#[test]
fn a_value_the_site_has_nothing_for_is_told_at_once_through_the_goal() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (home, rt, node, a, _) = node_and_site("nothing-for-value", vec![(200, "{}")]);
    let port = a_site_answering_by_its_request(|target| match target {
        t if t.starts_with("/find?q=lamps") => (200, json!({ "items": [{ "name": "Lamp" }] }).to_string()),
        _ => (404, "nothing here".into()),
    });
    let graph: unbrowse_learn::Graph = serde_json::from_value(json!({ "provisional": false, "steps": [{
        "exchange": 0, "method": "GET", "status": 200, "needs_browser": false, "url": format!("http://127.0.0.1:{port}/find?q={{q}}"),
        "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "default": "lamps", "secret": false }]
    }] }))
    .unwrap();
    let mut route = store::Route::from_graph("finds".into(), "search the shop".into(), format!("http://127.0.0.1:{port}/find?q=lamps"), graph).unwrap();
    route.write = false;
    route.heard = store::Heard { probed: true, ..Default::default() };
    store::save_route(&route).unwrap();
    let body = DoBody { goal: "search the shop".into(), url: format!("http://127.0.0.1:{port}/find?q=zqxv"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!((r["how"].as_str(), r["outcome"].as_str(), r["outcome_from"].as_str()), (Some("called"), Some("answered_empty"), Some("goal.nothing_for_this_value")), "{r}");
    assert_eq!(r["result"]["ok"], false, "{r}");
    assert!(r["result"]["error"].as_str().unwrap().contains("nothing is there for this value"), "{r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A goal said with another value finds the route learned for its own, and of several routes that may, the ones whose
/// walked answer listed records come first, whether the records sit in a list or a list of lists.
#[test]
fn of_routes_a_goal_finds_by_another_value_those_that_listed_records_come_first() {
    let with_shape = |id: &str, shape: Value| {
        let mut r = route(id, "shop.example", "search the shop for lamps", &["q"]);
        r.inputs[0].default = Some("lamps".into());
        let mut step = step_of("GET", "https://shop.example/api?q={q}", json!([]));
        step["response_shape"] = shape;
        r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [step] })).unwrap();
        r
    };
    let routes = vec![with_shape("counts", json!({ "count": "number" })), with_shape("nested", json!({ "groups": [[{ "name": "string" }]] })), with_shape("flat", json!({ "items": [{ "name": "string" }] }))];
    let found = goal::said_with_another_value(&routes, "search the shop for chairs", "");
    assert_eq!(found.iter().map(|(r, name, value)| (r.id.as_str(), name.as_str(), value.as_str())).collect::<Vec<_>>(), [("nested", "q", "chairs"), ("flat", "q", "chairs"), ("counts", "q", "chairs")]);
    // The value the route was learned on is not another value.
    assert!(goal::said_with_another_value(&routes, "search the shop for lamps", "").is_empty());
}

/// A page in a collection (`/prices/ethereum`) is answered by a route learned on another page of it (`/prices/bitcoin`)
/// that takes no input for the page, when what its goal reads is what this one asks for; not by a route of another
/// collection, one that takes an input, one an agent named, or for a goal that asks for something else.
#[test]
fn a_page_of_a_collection_finds_the_routes_of_its_sibling_pages() {
    let sibling = |id: &str, what: &str, root: &str| {
        let mut r = route(id, "coins.example", what, &[]);
        r.root = root.into();
        r
    };
    let mut named = sibling("named", "get the price of bitcoin", "https://coins.example/prices/bitcoin");
    named.judged.named = true;
    let mut takes_one = sibling("takes-one", "get the price of bitcoin", "https://coins.example/prices/bitcoin");
    takes_one.inputs = route("x", "coins.example", "x", &["q"]).inputs;
    let routes = vec![
        sibling("btc", "get the price of bitcoin", "https://coins.example/prices/bitcoin"),
        sibling("news", "get the price of bitcoin", "https://coins.example/news/bitcoin"),
        named,
        takes_one,
    ];
    let ids = |url: &str, goal: &str| goal::sibling_routes(&routes, goal, url).iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids("https://coins.example/prices/ethereum", "get the price of ethereum"), ["btc"]);
    assert_eq!(ids("https://coins.example/news/ethereum", "get the price of ethereum"), ["news"]);
    assert!(ids("https://coins.example/prices/ethereum", "get the history of ethereum").is_empty(), "a goal that asks for something else");
    assert!(ids("https://coins.example/ethereum", "get the price of ethereum").is_empty(), "a page with no collection");
    assert!(ids("not an address", "get the price of ethereum").is_empty());
}

/// A learn whose only reader of the answer is the page's own code, on a machine that runs none, is said as no route
/// with the browser's page as the way on; its reply says why.
#[test]
fn an_answer_only_the_pages_code_can_read_is_said_as_no_route_with_the_page_to_open() {
    let said = goal::unheld("only the page's own code reads it", "https://shop.example/items");
    assert_eq!(said["how"], "unheld", "{said}");
    assert_eq!(said["why"], "only the page's own code reads it");
    assert_eq!(said["outcome"], "no_route", "{said}");
    assert_eq!(said["next"]["tool"], "unbrowse_browse", "{said}");
    assert_eq!(said["next"]["args"]["do"], json!(["open", "https://shop.example/items"]), "{said}");
}

/// A primitive that needs a browser refuses what it can before one starts: a walk of a page that is no address, a command
/// whose words came as one item, a step that names no kind of action. Each answers an error over MCP, and the node's
/// own health says it is alive.
#[test]
fn a_walk_a_browse_and_a_challenge_with_nothing_to_go_on_are_refused() {
    let (home, rt, node, headers) = node_with_a_token("browser-primitives-refused");
    let refused = |id: u64, tool: &str, args: Value| {
        let (n, h) = (node.clone(), headers.clone());
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } });
        let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
        assert_eq!(m["result"]["isError"], true, "{tool}: {m}");
        m["result"]["content"][0]["text"].as_str().unwrap_or_default().to_string()
    };
    assert!(refused(1, "unbrowse_walk", json!({ "url": "   " })).contains("url is the page to walk"));
    assert!(refused(2, "unbrowse_browse", json!({ "do": ["click e1"] })).contains("each word of a command is its own item"));
    let said = refused(3, "unbrowse_challenge", json!({ "action": "no-such-action" }));
    assert!(!said.is_empty(), "the challenge step is refused in words");
    let alive = rt.block_on(health(State(node.clone())));
    assert!(alive.0.alive);
    let _ = std::fs::remove_dir_all(&home);
}

/// A wiring an agent proposes that can't be made is refused and nothing is changed: a route nobody holds, one that is
/// another node's, values given in no list of {step, at, is}, more values than a route takes, and values the route's
/// walk doesn't have.
#[test]
fn a_wiring_that_cannot_be_made_is_refused_and_changes_nothing() {
    let home = store::scratch_home("wire-refused");
    store::use_home(&home);
    let (rt, node, a) = agent_node(&home);
    let wire = |args: Value| rt.block_on(judge::do_wire(&node, &a, &args));
    let link = json!({ "step": 1, "at": "query:q", "is": "the search word" });
    assert_eq!(wire(json!({ "route_id": "nobody", "links": [link] })).unwrap_err().0, StatusCode::NOT_FOUND);
    let mut theirs = route("theirs", "shop.example", "search the shop", &["q"]);
    theirs.fetched = Some(store::Fetched { entry_id: "0xe".into(), route_id: "theirs".into(), agent_id: "7".into(), content_id: "sha256:cd".into(), listed_as: "search".into(), fetched_at: 1 });
    store::save_route(&theirs).unwrap();
    let (status, said) = wire(json!({ "route_id": "theirs", "links": [link] })).unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(said.contains("another node's"), "{said}");
    store::save_route(&route("mine", "shop.example", "search the shop", &["q"])).unwrap();
    for bad in [json!([]), json!([{ "step": 1, "at": "query:q" }]), json!([link, "not a link"])] {
        let (status, said) = wire(json!({ "route_id": "mine", "links": bad })).unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert!(said.contains("links is a list of {step, at, is}"), "{said}");
    }
    let (status, said) = wire(json!({ "route_id": "mine", "links": vec![link.clone(); 201] })).unwrap_err();
    assert_eq!((status, said.as_str()), (StatusCode::BAD_REQUEST, "links takes at most 200 values"));
    let (status, said) = wire(json!({ "route_id": "mine", "links": [link] })).unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(said.ends_with("Nothing was changed."), "{said}");
    assert_eq!(store::load_route("mine").unwrap().what, "search the shop");
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// What the owner's windows read of the chain's routes, and a pick's standings, are said as nothing at all, not as a
/// guess, when the node's chain can't be read: an error for the window, no standings for a pick.
#[test]
fn a_node_whose_chain_cannot_be_read_lists_no_entries_and_no_standings() {
    let home = store::scratch_home("no-chain-entries");
    store::use_home(&home);
    let (rt, node, _) = agent_node(&home);
    assert!(rt.block_on(search::entries(&node, None)).is_err());
    assert!(rt.block_on(search::entries(&node, Some("shop.example"))).is_err());
    let st = rt.block_on(search::standings(&node.chain, std::time::Duration::from_millis(200)));
    assert!(st.of(alloy::primitives::B256::ZERO).is_none(), "no standing for an entry nothing says");
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// A page the node can pass by itself never goes to the owner: a step that came to a page (done, or done with a check
/// among its own content) has nothing to say, and a page the node's own browser can go on with (its page still loading,
/// something no reader named, a door that held) names a call the agent makes itself, never `ask_owner`, whether an owner
/// can be asked or not.
#[test]
fn a_page_the_node_can_pass_by_itself_never_goes_to_the_owner() {
    use crate::browse::Came;
    use crate::learn::Unlearned;
    let asks_owner = |next: &Option<Value>| next.as_ref().is_some_and(|n| n["args"]["do"][0] == "ask_owner");
    for can_ask in [true, false] {
        for came in [Came::Done, Came::CarriesCheck { at: "https://shop.example/items".into() }] {
            assert!(super::browse::came_said(&came, "shop.example", can_ask).is_none(), "{came:?} has no hand-off to say");
        }
        for came in [Came::Gone { status: 404 }, Came::Gone { status: 0 }, Came::Check { at: "https://shop.example/check".into() }] {
            let said = super::browse::came_said(&came, "shop.example", can_ask).expect("not done");
            assert!(!asks_owner(&said.outcome.next) && !said.needs_owner, "{came:?} is the agent's to meet: {:?}", said.outcome.next);
        }
        for why in [Unlearned::Loading, Unlearned::Hands("the page needs a click".into()), Unlearned::Door("the door held".into(), "trace.door"), Unlearned::Check("the page asks for a person".into(), "challenge.asks_a_person")] {
            let said = goal::hands_said(&why, "list the items", "https://shop.example/items", Some("shop.example"), can_ask);
            assert!(!asks_owner(&said.next), "{why:?} with an owner {can_ask}: {:?}", said.next);
        }
    }
    let loading = goal::hands_said(&Unlearned::Loading, "list the items", "https://shop.example/items", Some("shop.example"), true);
    assert_eq!(loading.next, Some(json!({ "tool": "unbrowse_browse", "args": { "do": ["snapshot", "-i", "--urls"], "site": "shop.example" } })), "the node's own browser goes on with the page it has open");
}

/// A check for a person goes to `unbrowse_challenge` first, for the agent's own eyes, with or without an owner to ask:
/// what the picture can't settle is the owner's, said in the words, not made the next call.
#[test]
fn a_check_goes_to_the_challenge_tool_before_the_owner() {
    use crate::browse::Came;
    use crate::learn::Unlearned;
    use crate::outcome::Outcome;
    for can_ask in [true, false] {
        let said = super::browse::came_said(&Came::Check { at: "https://shop.example/check".into() }, "shop.example", can_ask).expect("a check is said");
        assert_eq!((said.outcome.outcome, said.outcome.from, said.needs_owner), (Outcome::Challenge, "browse.landed.check", false));
        assert_eq!(said.outcome.next, Some(json!({ "tool": "unbrowse_challenge", "args": { "action": "look", "site": "shop.example" } })), "can_ask {can_ask}");
        assert!(said.said.contains("unbrowse_challenge") && said.said.contains("ask_owner"), "{}", said.said);
        assert!(said.said.find("unbrowse_challenge") < said.said.find("ask_owner"), "the agent's own try comes first: {}", said.said);
        for site in [None, Some("shop.example")] {
            let walk = goal::hands_said(&Unlearned::Check("the page asks for a person".into(), "challenge.asks_a_person"), "list the items", "https://shop.example/items", site, can_ask);
            assert_eq!(walk.outcome, Outcome::Challenge, "{site:?}");
            let next = walk.next.expect("a next");
            assert_eq!((next["tool"].as_str(), next["args"]["action"].as_str(), next["args"]["url"].as_str()), (Some("unbrowse_challenge"), Some("look"), Some("https://shop.example/items")), "{next}");
        }
    }
}

/// Only a step that needs a person asks the owner, and for that one step: a sign-in the vault has no login for, or a
/// page that sent the agent to one, names `ask_owner` with what to do on that site (the vault's login is the node's own
/// first try, said before the ask). With no owner to ask the reply says so (`owner_unavailable`), names no ask, and
/// says to tell the user what the page needs.
#[test]
fn only_a_step_that_needs_a_person_asks_the_owner_and_names_it() {
    use crate::browse::Came;
    use crate::learn::Unlearned;
    use crate::outcome::Outcome;
    let site = "shop.example";
    let sign_in = Came::SignIn { at: "https://shop.example/account/login".into() };
    let walled = Came::Walled { at: "https://shop.example/login?next=%2Faccount".into() };
    for came in [&sign_in, &walled] {
        let said = super::browse::came_said(came, site, true).expect("a hand-off");
        assert_eq!((said.outcome.outcome, said.needs_owner), (Outcome::NeedsPerson, true), "{came:?}");
        let next = said.outcome.next.clone().expect("a next");
        assert_eq!((next["tool"].as_str(), next["args"]["do"][0].as_str(), next["args"]["site"].as_str()), (Some("unbrowse_browse"), Some("ask_owner"), Some(site)), "{next}");
        assert!(next["args"]["do"][1].as_str().is_some_and(|ask| ask.contains(&format!("sign in to {site}"))), "it names the one step: {next}");
        let none = super::browse::came_said(came, site, false).expect("a hand-off");
        assert_eq!((none.outcome.outcome, none.outcome.from, none.outcome.next.is_none(), none.needs_owner), (Outcome::OwnerUnavailable, "owner.reach", true, true), "{came:?}");
        assert!(none.said.contains("tell the user what the page needs"), "{}", none.said);
    }
    let said = super::browse::came_said(&sign_in, site, true).unwrap().said;
    assert!(said.find("vault").is_some_and(|v| v < said.find("ask_owner").unwrap()) && said.contains("unbrowse_logins"), "the vault's login is tried before the owner is asked: {said}");
    // A click that did nothing is the one step the node's hands can't do: asked as that step, and with no owner, no ask.
    let nothing = super::browse::came_said(&Came::Unchanged, site, true).unwrap();
    assert_eq!(nothing.outcome.outcome, Outcome::NeedsHands);
    assert_eq!(nothing.outcome.next.as_ref().map(|n| n["args"]["do"][0].clone()), Some(json!("ask_owner")));
    assert_eq!(super::browse::came_said(&Came::Unchanged, site, false).unwrap().outcome.outcome, Outcome::NeedsHands);
    // The goal's own hand-off says the same: a sign-in names ask_owner on the open page, and without an owner, none.
    let why = Unlearned::SignIn("it sent the page to its sign-in".into(), "answer.sent_to_sign_in");
    let asked = goal::hands_said(&why, "see my orders", "https://shop.example/orders", Some(site), true);
    let next = asked.next.expect("a next");
    assert_eq!((asked.outcome, next["args"]["do"][0].as_str(), next["args"]["site"].as_str()), (Outcome::NeedsPerson, Some("ask_owner"), Some(site)), "{next}");
    let alone = goal::hands_said(&why, "see my orders", "https://shop.example/orders", Some(site), false);
    assert_eq!((alone.outcome, alone.next), (Outcome::OwnerUnavailable, None));
    let unopened = goal::hands_said(&why, "see my orders", "https://shop.example/orders", None, true);
    assert_eq!((unopened.outcome, unopened.next), (Outcome::NeedsPerson, None), "no open page to ask on");
}

/// A card payment waits on the owner and the agent hears their answer: yes goes on, no is said as a refusal that tells
/// it not to try the card again, and a call its agent gave up on lapses as a timeout and tells the window. The owner
/// is shown the card and the site; a second ask for the same site is refused while the first waits, and a paused node
/// asks nobody.
#[test]
fn a_payment_ask_waits_for_the_owner_and_the_agent_hears_the_answer() {
    let (home, rt, node, a, _) = node_and_site("pay-ask-answer", vec![(200, "{}")]);
    let pay = |site: &str| crate::hands::Pay { card: "visa (card ending 4242)".into(), merchant: site.into(), route: None, inputs: Vec::new(), over: None, amount: None };
    let waits = |site: &'static str| {
        let (n, a) = (node.clone(), a.clone());
        rt.spawn(async move { super::browse::ask_to_pay(&n, &a, site, None, pay(site)).await })
    };
    let until_asked = |site: &str| {
        let started = std::time::Instant::now();
        while !crate::hands::asks().iter().any(|x| x.site == site) {
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "{site} was never asked");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    };
    // Yes: the agent goes on, and the owner was shown the card and the site.
    let yes = waits("pay-yes.example");
    until_asked("pay-yes.example");
    let shown = crate::hands::asks().into_iter().find(|x| x.site == "pay-yes.example").unwrap();
    assert!(shown.why.contains("visa (card ending 4242)") && shown.why.contains("pay-yes.example"), "{}", shown.why);
    assert!(shown.pay.is_some_and(|p| p.card.contains("4242")));
    // A second ask for the page while the first waits is refused, not queued behind it.
    let second = rt.block_on(super::browse::ask_to_pay(&node, &a, "pay-yes.example", None, pay("pay-yes.example"))).unwrap_err();
    assert_eq!(second.0, StatusCode::CONFLICT, "{second:?}");
    assert_eq!(crate::hands::answer("pay-yes.example", crate::hands::Answer::Done), 1);
    assert!(rt.block_on(yes).unwrap().is_ok());
    // No: a refusal that says not to try the card again, and says nothing the card shows beyond its label.
    let no = waits("pay-no.example");
    until_asked("pay-no.example");
    crate::hands::answer("pay-no.example", crate::hands::Answer::Declined);
    let (status, said) = rt.block_on(no).unwrap().unwrap_err();
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(said.contains("declined") && said.contains("don't try the card again"), "{said}");
    // Its agent gives the call up: the wait ends as no answer, said as a timeout, and the window hears it lapsed.
    let mut heard = node.events.subscribe_for_test();
    let call = asks::Ask::begin("unbrowse_call");
    let stop = call.stop.clone();
    let (n, a2) = (node.clone(), a.clone());
    let lapsing = rt.spawn(asks::within(call, async move { super::browse::ask_to_pay(&n, &a2, "pay-lapse.example", None, pay("pay-lapse.example")).await }));
    until_asked("pay-lapse.example");
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let (status, said) = rt.block_on(async { tokio::time::timeout(std::time::Duration::from_secs(10), lapsing).await }).expect("ended").unwrap().unwrap_err();
    assert_eq!(status, StatusCode::REQUEST_TIMEOUT);
    assert!(said.contains("didn't answer") && said.contains("nothing was filled"), "{said}");
    let lapsed = std::iter::from_fn(|| heard.try_recv().ok()).any(|(event, payload)| event == "hands" && payload["kind"] == "lapsed" && payload["site"] == "pay-lapse.example");
    assert!(lapsed, "the window hears the ask lapsed");
    assert!(!crate::hands::asks().iter().any(|x| x.site.starts_with("pay-")), "no ask is left waiting");
    // A paused node asks nobody.
    store::save_settings(&store::Settings { paused: true, ..store::load_settings() }).unwrap();
    let paused = rt.block_on(super::browse::ask_to_pay(&node, &a, "pay-paused.example", None, pay("pay-paused.example"))).unwrap_err();
    assert_eq!((paused.0, paused.1.as_str()), (StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED));
    assert!(!crate::hands::asks().iter().any(|x| x.site == "pay-paused.example"));
    let _ = std::fs::remove_dir_all(&home);
}

/// The owner's window commands answer as they should: an unknown command is not found, one that fails says why as a bad
/// request, a node still waiting on its key says so as unavailable, and a command that works answers. A walk's picture
/// is served as what it is (a PNG as a PNG, anything else as a JPEG), never cached, and a walk with none is not found.
#[test]
fn the_owner_window_gets_each_answer_and_its_pictures_as_what_they_are() {
    let node = Arc::new(Node {
        keys: Box::new(unbrowse_core::MemoryStore::default()),
        identity: std::sync::RwLock::new(None),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    let door = Door { node: node.clone(), owner: Arc::new("the-owners-token".into()) };
    let as_owner = || {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer the-owners-token".parse().unwrap());
        h
    };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let run = |cmd: &str, body: Option<Value>| rt.block_on(owner_command(State(door.clone()), Path(cmd.into()), as_owner(), body.map(Json)));
    let (status, body) = run("no_such_command", None);
    assert_eq!(status, StatusCode::NOT_FOUND, "{:?}", body.0);
    let (status, body) = run("hands_input", Some(json!({})));
    assert_eq!(status, StatusCode::BAD_REQUEST, "{:?}", body.0);
    let (status, body) = run("identity", None);
    assert_eq!((status, body.0["error"].as_str()), (StatusCode::SERVICE_UNAVAILABLE, Some(crate::WAITING_FOR_KEY)), "{:?}", body.0);
    let (status, _) = run("hands_stop", Some(json!({})));
    assert_eq!(status, StatusCode::OK);

    let picture = |walk: &str| rt.block_on(owner_frame(State(door.clone()), as_owner(), Query(FrameQuery { walk: walk.into() })));
    assert_eq!(picture("walk-without-a-picture").status(), StatusCode::NOT_FOUND);
    let frame = |jpeg: &[u8]| unbrowse_learn::screencast::Frame { jpeg: jpeg.to_vec(), width: 1, height: 1, settled: false };
    node.walks.1.put("walk-png", frame(b"\x89PNG\r\n\x1a\nrest"));
    node.walks.1.put("walk-jpeg", frame(b"\xff\xd8\xffrest"));
    for (walk, kind) in [("walk-png", "image/png"), ("walk-jpeg", "image/jpeg")] {
        let r = picture(walk);
        assert_eq!(r.status(), StatusCode::OK, "{walk}");
        assert_eq!((r.headers()["content-type"].to_str().unwrap(), r.headers()["cache-control"].to_str().unwrap()), (kind, "no-store"), "{walk}");
    }
    assert_eq!(super::window::picture_type(b"\x89PNG\r\n\x1a\n"), "image/png");
    assert_eq!(super::window::picture_type(b"GIF89a"), "image/jpeg");
}

/// An answer cut to the one record that names the page's subject: a list of every coin, on bitcoin's page, is bitcoin's
/// record; asked for whole (`*`), or with no subject, it stays as the site sent it.
#[test]
fn an_answer_is_cut_to_the_records_naming_the_pages_subject_unless_asked_whole() {
    let reply = json!({ "ok": true, "data": { "coins": [{ "name": "Bitcoin", "price": 1 }, { "name": "Ether", "price": 2 }, { "name": "Solana", "price": 3 }] } });
    let subject = vec!["bitcoin".to_string()];
    let cut = goal::own_records(reply.clone(), &subject, &[]);
    assert_eq!(cut["data"]["coins"], json!([{ "name": "Bitcoin", "price": 1 }]), "{cut}");
    assert_eq!(goal::own_records(reply.clone(), &subject, &["*".to_string()]), reply, "asked whole");
    assert_eq!(goal::own_records(reply.clone(), &[], &[]), reply, "a page about nothing in particular");
}

/// An answer in a reply of several pages shows no empty value, and a chain of objects with one key each is its inside.
#[test]
fn a_page_in_a_reply_of_several_shows_no_empty_value_and_no_wrapper_of_one_key() {
    assert_eq!(pages::compact(&json!({ "a": { "b": { "c": 1, "d": 2 } }, "e": null, "f": [] })), json!({ "b": { "c": 1, "d": 2 } }));
}

/// A page the node holds a walk of is read as its candidates (the calls it made) without walking it again, and the
/// call an agent picks is kept as a route under its own words. A walk that isn't held, of a page the owner excluded or
/// of a call it has no candidate for, is refused in words.
#[test]
fn a_walk_the_node_holds_is_read_and_the_call_an_agent_picks_is_kept() {
    let (home, rt, node, a, port) = node_and_site("walk-pick", vec![(200, "{}")]);
    let page = format!("http://127.0.0.1:{port}/shop?q=lamps");
    let call = format!("http://127.0.0.1:{port}/api/items?q=lamps");
    let answer = json!({ "items": [{ "id": 1, "name": "desk lamp" }, { "id": 2, "name": "floor lamp" }] }).to_string();
    let trace = unbrowse_learn::Trace { exchanges: vec![walked("GET", &page, None, "<html><body>lamps</body></html>", true), walked("GET", &call, None, &answer, false)], inputs: Vec::new() };
    node.walks.0.locked().insert("held-walk".into(), learn::Walk { url: page.clone(), trace: trace.into(), probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None });
    let walk = |pick: Option<u64>, what: &str| rt.block_on(do_walk(&node, &a, page.clone(), "search the shop".into(), pick, what.into(), "held-walk".into()));
    let seen = walk(None, "").unwrap();
    assert_eq!((seen["walk"].as_str(), seen["site"].as_str()), (Some("held-walk"), Some("127.0.0.1")), "{seen}");
    let candidate = seen["candidates"].as_array().unwrap().iter().find(|c| c["path"].as_str().is_some_and(|p| p.starts_with("/api/items"))).unwrap_or_else(|| panic!("the call the page made, in {seen}")).clone();
    let kept = walk(candidate["index"].as_u64(), "list the lamps").unwrap();
    assert_eq!(kept["route"]["what"], "list the lamps", "{kept}");
    let id = kept["route"]["id"].as_str().unwrap();
    assert_eq!(store::load_route(id).unwrap().what, "list the lamps", "kept");
    let (status, said) = walk(Some(99), "nothing").unwrap_err();
    assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
    store::save_settings(&store::Settings { fetch_browser: false, excluded: vec!["blocked.example".into()], ..store::Settings::default() }).unwrap();
    let (status, said) = rt.block_on(do_walk(&node, &a, "https://blocked.example/".into(), String::new(), None, String::new(), String::new())).unwrap_err();
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(said.contains("excluded from mapping"), "{said}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A page is answered by a route learned on another page of its collection (`/prices/bitcoin` for `/prices/ethereum`)
/// when that route takes no input and its answer names this page's thing: the list of every coin, cut to ethereum's
/// record. A page learned in other words is answered by the route of that page whose goal shares what this one asks.
#[test]
fn a_page_is_answered_by_the_route_of_its_sibling_or_of_its_own_in_other_words() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let every_coin: &'static str = Box::leak(
        json!({ "coins": [{ "name": "Bitcoin", "symbol": "BTC", "price": 64000.5 }, { "name": "Ethereum", "symbol": "ETH", "price": 3100.25 }, { "name": "Solana", "symbol": "SOL", "price": 150.75 }] }).to_string().into_boxed_str(),
    );
    let (home, rt, node, a, port) = node_and_site("sibling-flow", vec![(200, every_coin)]);
    let route: store::Route = serde_json::from_value(json!({
        "id": "coin-price", "site": "127.0.0.1", "what": "get the price of bitcoin", "method": "GET", "path": "/api/coins", "root": format!("http://127.0.0.1:{port}/prices/bitcoin"),
        "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/api/coins"), "needs_browser": false, "fields": [] }] }
    }))
    .unwrap();
    store::save_route(&route).unwrap();
    let ask = |goal: &str, page: &str| {
        let body = DoBody { goal: goal.into(), url: format!("http://127.0.0.1:{port}{page}"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
        let (node, a) = (node.clone(), a.clone());
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") })
    };
    let names = |r: &Value| r["result"]["data"]["coins"].as_array().map(|c| c.iter().map(|c| c["name"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>()).unwrap_or_default();
    let sibling = ask("get the price of ethereum", "/prices/ethereum").unwrap();
    assert_eq!((sibling["how"].as_str(), sibling["route"]["id"].as_str()), (Some("called"), Some("coin-price")), "{sibling}");
    assert_eq!(names(&sibling), ["Ethereum"], "cut to this page's thing: {sibling}");
    let reworded = ask("read the live price of bitcoin", "/prices/bitcoin").unwrap();
    assert_eq!((reworded["how"].as_str(), reworded["route"]["id"].as_str()), (Some("called"), Some("coin-price")), "{reworded}");
    assert_eq!(names(&reworded), ["Bitcoin"], "{reworded}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A goal that names no page, done by routes of two sites, asks the agent which site it means (a 409 that names both);
/// the names of the inputs it gives say which route it means when only one site's takes every one of them.
#[test]
fn a_goal_with_no_page_is_told_which_sites_do_it_and_its_inputs_pick_the_one() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let body: &'static str = r#"{"items":[{"id":1,"name":"desk lamp"}]}"#;
    let (home, rt, node, a, port) = node_and_site("two-sites", vec![(200, body)]);
    let mut here = a_lamps_route_on("lamps-here", port);
    here.what = "list the lamps".into();
    store::save_route(&here).unwrap();
    let mut elsewhere = route("lamps-there", "other.example", "list the lamps", &[]);
    elsewhere.root = "https://other.example/lamps".into();
    store::save_route(&elsewhere).unwrap();
    let ask = |inputs: HashMap<String, String>| {
        let body = DoBody { goal: "list the lamps".into(), url: String::new(), inputs, session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
        let (node, a) = (node.clone(), a.clone());
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") })
    };
    let (status, said) = ask(HashMap::new()).unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(said.contains("127.0.0.1") && said.contains("other.example") && said.contains("give url"), "{said}");
    let r = ask(HashMap::from([("q".to_string(), "desk".to_string())])).unwrap();
    assert_eq!((r["how"].as_str(), r["route"]["id"].as_str()), (Some("called"), Some("lamps-here")), "the route that takes q: {r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A route whose answer never hears the value a page asks for (it goes to a step the answer takes nothing from) is not
/// called for that page: the reply says why it was passed over, and the page is learned afresh.
#[test]
fn a_route_whose_answer_takes_nothing_from_the_pages_value_is_passed_over_and_said() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (home, rt, node, a, port) = node_and_site("unreached", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#)]);
    let route: store::Route = serde_json::from_value(json!({
        "id": "two-step", "site": "127.0.0.1", "what": "search the shop", "method": "GET", "path": "/answer", "root": format!("http://127.0.0.1:{port}/search?q=lamp"),
        "inputs": [{ "name": "q", "secret": false, "default": "lamp" }, { "name": "page", "secret": false, "default": "1" }],
        "steps": 2, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
        "graph": { "provisional": false, "steps": [
            { "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/suggest?q={{q}}"), "needs_browser": false,
              "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp" }] },
            { "exchange": 1, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/answer?page={{page}}"), "needs_browser": false,
              "fields": [{ "loc": { "in": "query", "key": "page" }, "class": "input", "name": "page", "secret": false, "default": "1" }] }] }
    }))
    .unwrap();
    store::save_route(&route).unwrap();
    let body = DoBody { goal: "search the shop".into(), url: format!("http://127.0.0.1:{port}/search?q=chair"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!(r["route_failed"]["route_id"], "two-step", "{r}");
    assert!(r["route_failed"]["error"].as_str().unwrap().contains("its answer takes nothing from q, so the page is learned"), "{r}");
    assert_ne!(r["route"]["id"], "two-step", "the page was learned afresh, not answered by it: {r}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A call an agent judged wrong for a page, or said does something else, is not the answer when loading the page finds
/// that very call again: the reply says so and hands the page over, rather than answering with the call once more.
#[test]
fn loading_a_page_that_finds_a_call_an_agent_rejected_hands_the_page_over() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let (home, rt, node, a, port) = node_and_site("rejected-found-again", vec![(200, r#"{"items":[{"id":1,"name":"desk lamp"},{"id":2,"name":"floor lamp"}]}"#)]);
    let judge = |args: Value| judge::do_judge(&a, &args).unwrap();
    let ask = |goal: &str, url: &str| {
        let body = DoBody { goal: goal.into(), url: url.into(), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
        let (node, a) = (node.clone(), a.clone());
        rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap()
    };
    let wrong_page = format!("http://127.0.0.1:{port}/api/items?tab=a");
    let first = ask("list the items", &wrong_page);
    let id = first["route"]["id"].as_str().expect("the page's own data is its route").to_string();
    judge(json!({ "route_id": id, "verdict": "wrong", "url": wrong_page, "why": "the other tab's list" }));
    let again = ask("list the items", &wrong_page);
    assert_eq!(again["how"], "browse", "{again}");
    assert!(again["why"].as_str().unwrap().contains("the call an agent judged wrong for it (the other tab's list)"), "{again}");
    let named_page = format!("http://127.0.0.1:{port}/api/things?tab=b");
    let first = ask("list the things", &named_page);
    let id = first["route"]["id"].as_str().expect("the page's own data is its route").to_string();
    judge(json!({ "route_id": id, "verdict": "right", "what": "the shop's opening hours" }));
    let again = ask("list the things", &named_page);
    assert_eq!(again["how"], "browse", "{again}");
    assert!(again["why"].as_str().unwrap().contains("a call an agent said does something else (\"the shop's opening hours\")"), "{again}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A step of the node's browser on a node with no browser does nothing and says what it lacks (the same 422 every
/// browser tool gives), and a command whose words came as one item is sent back before any browser is looked for. An
/// ask for the owner with no words says what to write, and with words, on a page whose browser isn't open, says to open
/// the page first: nothing is asked of the owner, so nothing waits.
#[test]
fn a_browser_step_on_a_node_with_no_browser_says_what_it_lacks_and_asks_nobody() {
    let (home, rt, node, a, _) = node_and_site("browse-no-browser", vec![(200, "{}")]);
    let step = |args: &[&str]| {
        let (n, a) = (node.clone(), a.clone());
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        rt.block_on(async move { super::browse::do_browse(&n, &a, args, "shop.example".into(), String::new(), "s").await })
    };
    let (status, said) = step(&["click @e1"]).expect_err("run together");
    assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
    for args in [&["open", "https://shop.example/"][..], &["snapshot", "-i"][..]] {
        let (status, body) = answer_of(&Failed::from(step(args).expect_err("no browser")));
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{args:?}: {body}");
        assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()), "{body}");
    }
    let (n, a2) = (node.clone(), a.clone());
    let seen = rt.block_on(async move { super::browse::do_observe(&n, &a2, "shop.example".into(), "s".into(), String::new()).await }).expect_err("no browser");
    assert_eq!(answer_of(&Failed::from(seen)).0, StatusCode::UNPROCESSABLE_ENTITY);
    let (n, a2) = (node.clone(), a.clone());
    let looked = rt
        .block_on(async move { super::browse::do_challenge(&n, &a2, "look".into(), "shop.example".into(), "s".into(), String::new(), None, None, None, None, None, None, None, false, Vec::new()).await })
        .expect_err("no browser");
    assert_eq!(answer_of(&Failed::from(looked)).0, StatusCode::UNPROCESSABLE_ENTITY);
    let asked = |args: &[&str]| {
        let (n, a) = (node.clone(), a.clone());
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        rt.block_on(async move { super::browse::ask_owner(&n, &a, &args, "shop.example", "s").await })
    };
    let (status, said) = asked(&["ask_owner"]).expect_err("no words");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(said.contains("say what you need"), "{said}");
    let (status, said) = asked(&["ask_owner", "sign", "in"]).expect_err("no page");
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!said.is_empty());
    assert!(!crate::hands::asks().iter().any(|x| x.site.contains("shop.example")), "nothing waits on the owner");
    let _ = std::fs::remove_dir_all(&home);
}

/// An agent's ask of the owner, which may wait minutes on a person, is answered within the caller's wait (`wait_ms`):
/// still working, with the ask `unbrowse_do` collects, since an MCP client hangs up after about a minute. The owner's
/// wait goes on behind that reply for as long as the agent asked, past the wall other work meets; the owner answering
/// then is still heard, collected as the browse tool's answer (the owner did it), and `waited_s` is the time the owner
/// took, not the wait allowed.
#[cfg(unix)]
#[test]
fn an_ask_of_the_owner_answers_within_the_callers_wait_and_is_collected() {
    let _ = store::scratch_home("ask-owner-within");
    // A short home: a browser door's path has a length limit the temp folder's own path would pass.
    let home = std::path::PathBuf::from(format!("/tmp/ubaow{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    store::use_home(&home);
    let (rt, node, agent) = agent_node(&home);
    // The browser is the one there is: none is fetched while the caller waits.
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
    let site = "owner-waits.example";
    let _door = fake_browser(&home, &crate::browse::session_of(site), json!({ "cookies": [] }));
    let _window = node.events.subscribe_for_test();
    let owner_answers = |after: std::time::Duration| {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !crate::hands::asks().iter().any(|x| x.site == site) {
            assert!(std::time::Instant::now() < until, "the owner was never asked");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        std::thread::sleep(after);
        assert_eq!(crate::hands::answer(site, crate::hands::Answer::Done), 1);
    };
    // The ask itself, as an ask's work runs it: the owner's wait is the ask's to go on for, and waited_s is what it took.
    let ask = asks::Ask::begin("unbrowse_browse");
    let (n, a, at) = (node.clone(), agent.clone(), ask.clone());
    let asking = rt.spawn(asks::within(at, async move {
        let args: Vec<String> = ["ask_owner", "press and hold the check", "--timeout", "600"].iter().map(|s| s.to_string()).collect();
        super::browse::ask_owner(&n, &a, &args, site, "s").await
    }));
    owner_answers(std::time::Duration::from_millis(1100));
    let got = rt.block_on(asking).unwrap().unwrap();
    assert_eq!(got["owner"], "done", "{got}");
    assert!((1..60).contains(&got["waited_s"].as_u64().unwrap()), "the time the owner took, not the 600 s allowed: {got}");
    // Through the tool: the caller is answered within its wait. Where the node has its browser program, still working
    // with the ask, which collects the owner's answer as the browse tool's; where it hasn't, the missing browser.
    let browse = PRIMITIVES.iter().find(|p| p.tool == "unbrowse_browse").unwrap();
    let args = json!({ "do": ["ask_owner", "press and hold the check"], "site": site, "wait_ms": 300 });
    let started = std::time::Instant::now();
    let r = rt.block_on(run_as_ask(browse, &node, &agent, args, "unbrowse_browse", asks::Ask::begin(browse.tool)));
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "{:?}", started.elapsed());
    match r {
        Ok(r) => {
            assert_eq!((r["outcome"].as_str(), r["next"]["tool"].as_str()), (Some("still_working"), Some("unbrowse_do")), "{r}");
            owner_answers(std::time::Duration::from_millis(500));
            let got = rt.block_on(asks::collect(&agent.name, r["ask"].as_str().unwrap(), std::time::Duration::from_secs(10))).unwrap();
            assert_eq!((got["owner"].as_str(), got["outcome"].as_str(), got["outcome_from"].as_str()), (Some("done"), Some("answered"), Some("owner")), "{got}");
        }
        Err(f) => assert_eq!(f.said.as_ref().map(|s| s.outcome), Some(crate::outcome::Outcome::BrowserMissing), "{}", f.error),
    }
    drop(rt);
    let _ = std::fs::remove_dir_all(&home);
}

/// A goal worded for another value than the one its route was learned for (`search the shop for lamps` learned, `for
/// chairs` asked) is done by that route with the value the goal says; a read whose answer came back empty is asked
/// once more before it is taken.
#[test]
fn a_goal_said_with_another_value_runs_its_route_and_an_empty_answer_is_asked_again() {
    let _old = crate::learn::own_asks::as_the_old_node();
    let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let heard = asked.clone();
    let port = a_site_answering_by_its_request(move |target| {
        let n = heard.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match (n, target.contains("q=chairs")) {
            (0, _) => (200, r#"{"items":[]}"#.to_string()),
            (_, true) => (200, r#"{"items":[{"id":3,"name":"red chairs"}]}"#.to_string()),
            (_, false) => (200, r#"{"items":[{"id":1,"name":"desk lamp"}]}"#.to_string()),
        }
    });
    let (home, rt, node, a, _) = node_and_site("said-value-empty-again", vec![(200, "{}")]);
    let mut route = a_lamps_route_on("shop-search", port);
    route.what = "search the shop for lamps".into();
    route.root = format!("http://127.0.0.1:{port}/find?q=lamps");
    store::save_route(&route).unwrap();
    let body = DoBody { goal: "search the shop for chairs".into(), url: format!("http://127.0.0.1:{port}/find"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let r = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap();
    assert_eq!((r["how"].as_str(), r["route"]["id"].as_str()), (Some("called"), Some("shop-search")), "{r}");
    assert_eq!(r["result"]["data"]["items"][0]["name"], "red chairs", "the second asking's answer, for the goal's value: {r}");
    assert!(asked.load(std::sync::atomic::Ordering::SeqCst) >= 2, "the empty answer was asked for again");
    let _ = std::fs::remove_dir_all(&home);
}

/// A route of one sighting, called for a value it was not learned on, whose call the site refuses, is not served: the
/// doubt is that the route's answer for this value can't stand, so the browser must serve the ask; where the caller said
/// `browser: never` the reply says so (412) and names why, and the route stays as it was.
#[test]
fn a_route_called_for_a_new_value_whose_call_the_site_refuses_is_not_served() {
    let kettle: &'static str = Box::leak(json!({ "query": "kettle", "results": (0..6).map(|n| json!({ "id": n, "title": format!("kettle item number {n}") })).collect::<Vec<_>>() }).to_string().into_boxed_str());
    let (home, rt, node, a, port) = node_and_site("calls-first-doubt", vec![(200, kettle), (500, r#"{"error":"the shelf is down"}"#)]);
    let url = format!("http://127.0.0.1:{port}/api/items?q=kettle");
    let crate::learn::Plain::Route(mut route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    route.root = format!("http://127.0.0.1:{port}/find?q=kettle");
    store::save_route(&route).unwrap();
    let body = DoBody { goal: "search the items".into(), url: format!("http://127.0.0.1:{port}/find?q=teapot"), inputs: HashMap::new(), session: String::new(), browser: "never".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let (status, said) = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), do_goal(&node, &a, body)).await.expect("answered") }).unwrap_err();
    assert_eq!(status, StatusCode::PRECONDITION_FAILED, "{said}");
    assert!(said.contains("the call said browser: never") && said.contains("served by the node's browser"), "{said}");
    assert!(said.contains("the site answered 500: the shelf is down"), "{said}");
    let stood = store::load_route(&route.id).expect("the route stands as it was");
    assert!(!stood.provisional || stood.heard.said_back.is_none(), "a refused call confirmed nothing: {:?}", stood.heard);
    let _ = std::fs::remove_dir_all(&home);
}

/// An agent that read a route's values (`unbrowse_inspect`) says one is not needed (a header the page sent that the site
/// never checks): the node tries it, asking the site as walked and for the agent's second word, and keeps the wiring only
/// because both answered with answers of their own. The route then goes without that header, and its reply says what the
/// agent changed.
#[test]
fn a_wiring_the_site_bears_out_is_kept_and_the_route_goes_without_the_value() {
    let (home, rt, node, a, _) = node_and_site("wire-kept", vec![(200, "{}")]);
    let port = a_site_answering_by_its_request(|target| {
        let word = target.split("q=").nth(1).unwrap_or("none").split(['&', ' ']).next().unwrap_or("none").to_string();
        let make = if word == "lamps" { "brass desk" } else { "oak dining" };
        (200, json!({ "word": word, "items": (0..6).map(|n| json!({ "id": n, "name": format!("{make} {word} model number {n}") })).collect::<Vec<_>>() }).to_string())
    });
    let page = format!("http://127.0.0.1:{port}/shop?q=lamps");
    let call = format!("http://127.0.0.1:{port}/api/items?q=lamps");
    let answer = json!({ "word": "lamps", "items": (0..6).map(|n| json!({ "id": n, "name": format!("brass desk lamps model number {n}") })).collect::<Vec<_>>() }).to_string();
    let mut api = walked("GET", &call, None, &answer, false);
    api.request_headers.push(("x-trace".into(), "9f8e7d6c5b4a".into()));
    let trace = unbrowse_learn::Trace { exchanges: vec![walked("GET", &page, None, "<html><body>lamps</body></html>", true), api], inputs: Vec::new() };
    node.walks.0.locked().insert("wire-walk".into(), learn::Walk { url: page.clone(), trace: trace.into(), probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None });
    let seen = rt.block_on(do_walk(&node, &a, page.clone(), "search the shop".into(), None, String::new(), "wire-walk".into())).unwrap();
    let index = seen["candidates"].as_array().unwrap().iter().find(|c| c["path"].as_str().is_some_and(|p| p.starts_with("/api/items"))).expect("the call")["index"].as_u64();
    let kept = rt.block_on(do_walk(&node, &a, page.clone(), "search the shop".into(), index, "search the shop".into(), "wire-walk".into())).unwrap();
    let id = kept["route"]["id"].as_str().unwrap().to_string();
    let inspected = super::call::do_inspect(id.clone()).unwrap();
    let header = inspected["steps"].as_array().unwrap().iter().flat_map(|s| s["fields"].as_array().unwrap().clone()).find(|f| f["at"].as_str().is_some_and(|at| at.contains("x-trace"))).unwrap_or_else(|| panic!("the header in {inspected}"));
    let wire = |links: Value, word: Option<&str>| {
        let mut args = json!({ "route_id": id, "links": links });
        if let Some(w) = word {
            args["word"] = json!(w);
        }
        rt.block_on(judge::do_wire(&node, &a, &args))
    };
    let at = header["at"].as_str().unwrap().to_string();
    // No word to try the site with, and a wiring that changes nothing, are each refused.
    let (status, said) = wire(json!([{ "step": 1, "at": at, "is": "drop" }]), None).unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT, "{said}");
    assert!(said.contains("give a second value"), "{said}");
    let (status, said) = wire(json!([{ "step": 1, "at": "query:q", "is": "keep" }]), Some("chairs")).unwrap_err();
    assert_eq!(status, StatusCode::CONFLICT, "{said}");
    assert!(said.contains("nothing changed"), "{said}");
    let before = store::load_route(&id).unwrap();
    assert!(before.graph.steps[0].fields.iter().any(|f| matches!(&f.loc, unbrowse_learn::Loc::Header(h) if h == "x-trace")), "the walk sent it");
    let r = wire(json!([{ "step": 1, "at": at, "is": "drop" }]), Some("chairs")).unwrap_or_else(|e| panic!("{e:?}"));
    assert!(r["next"].as_str().unwrap().contains("wired 1 value(s)"), "{r}");
    assert_eq!(r["route"]["id"], json!(id), "{r}");
    let after = store::load_route(&id).unwrap();
    assert!(!after.graph.steps[0].fields.iter().any(|f| matches!(&f.loc, unbrowse_learn::Loc::Header(h) if h == "x-trace")), "the header is gone from the route");
    let _ = std::fs::remove_dir_all(&home);
}

/// A page whose plain request the site answers with an error is said as the site said it: its status and words, as a bad
/// gateway, from the reader of the plain request, and nothing is walked.
#[test]
fn a_page_whose_plain_request_the_site_fails_is_said_as_the_site_said_it() {
    let (home, rt, node, a, port) = node_and_site("plain-refused", vec![(500, r#"{"error":"the shop is down"}"#)]);
    let body = DoBody { goal: "list the items".into(), url: format!("http://127.0.0.1:{port}/api/items"), inputs: HashMap::new(), session: String::new(), browser: "auto".into(), fields: Vec::new(), many: true, budget_usdc: None };
    let failed = rt.block_on(async move { tokio::time::timeout(std::time::Duration::from_secs(60), goal::do_goal_said(&node, &a, body)).await.expect("answered") }).unwrap_err();
    assert_eq!(failed.status, StatusCode::BAD_GATEWAY, "{}", failed.error);
    assert!(failed.error.contains("500") && failed.error.contains("the shop is down"), "{}", failed.error);
    let _ = std::fs::remove_dir_all(&home);
}

/// What a route's result is told when it doesn't answer the page it was called for, said by its reason: a write's
/// answer stands however it went; a route found by its page that lacks what the goal asks for; a route the browser saw
/// answer with records at a place and now has none there; an answer that says the value the walk was asked and nothing of
/// this call's; a page that asks for a person; a page that says no word of what was asked. An answer that holds is none.
#[test]
fn a_result_that_does_not_answer_its_page_is_told_why() {
    let mut learned = route("r", "shop.example", "search the shop for lamps", &["q"]);
    learned.inputs[0].default = Some("lamps".into());
    let given = HashMap::from([("q".to_string(), "chairs".to_string())]);
    let url = "https://shop.example/search?q=chairs";
    let why = |route: &store::Route, result: Value, goal: &str, reworded: bool| {
        let ask = goal::Asked { url, goal, subject: &[], reworded, sibling: false, given: &given };
        goal::unanswered(&result, route, &ask).map(|w| w.as_str().unwrap_or_default().to_string())
    };
    let chairs = json!({ "ok": true, "data": { "items": [{ "name": "red chairs", "price": 9 }, { "name": "oak chairs", "price": 12 }] } });
    assert_eq!(why(&learned, chairs.clone(), "search the shop for chairs", false), None, "an answer that holds stands");
    let mut writes = learned.clone();
    writes.write = true;
    assert_eq!(why(&writes, json!({ "ok": false, "error": "refused" }), "search the shop for chairs", false), None, "a write's answer stands however it went");
    assert_eq!(why(&learned, json!({ "ok": false, "error": "the site answered 500" }), "search the shop for chairs", false).as_deref(), Some("the site answered 500"));
    let no_price = json!({ "ok": true, "data": { "items": [{ "name": "red chairs" }, { "name": "oak chairs" }] } });
    assert_eq!(why(&learned, no_price, "get the price of chairs", true).as_deref(), Some(goal::LACKS_THE_GOAL), "found by its page, it must hold what the goal asks");
    let mut no_records = chairs.clone();
    no_records["records"] = Value::Null;
    assert!(why(&learned, no_records, "search the shop for chairs", false).unwrap().contains("holds no records where the browser saw this route's records"));
    let walks = json!({ "ok": true, "data": { "items": [{ "name": "red lamps", "price": 9 }, { "name": "oak lamps", "price": 12 }] } });
    assert!(why(&learned, walks, "search the shop for chairs", false).unwrap().contains("it answered what the walk asked, not what this page asks"));
    let check = json!({ "ok": true, "data": { "title": "Just a moment", "text": "Please verify you are human to continue." } });
    assert!(why(&learned, check, "search the shop for chairs", false).unwrap().contains("asks for a person"));
    let notice = json!({ "ok": true, "data": { "title": "Choose your country", "text": "Pick the shop for your country", "links": ["a", "b", "c"] } });
    assert!(why(&learned, notice, "search the shop for chairs", false).unwrap().contains("never says a word of what this page asks for"));
}

/// Two agents asking for the same page in batches at once each get an answer of their own: the page another agent's batch
/// is walking is not waited for, nor is its answer handed over (it is that agent's); each batch walks the page for its
/// own agent, and both answer.
#[test]
fn two_agents_asking_for_one_page_in_batches_at_once_each_get_their_own_walk() {
    let (home, rt, node, headers_a) = node_with_a_token("batch-two-agents");
    let (second, _) = agents::create(node.keys.as_ref(), "second", 1.0, 30, 7788).unwrap();
    let token = agents::token_of(&unbrowse_core::RootKey::load(node.keys.as_ref()).unwrap(), &second);
    let mut headers_b = HeaderMap::new();
    headers_b.insert("authorization", format!("Bearer {token}").parse().unwrap());
    let page = "https://slow.example/items?case=two-agents";
    let slow = goal::slow::make(page, Some(std::time::Duration::from_millis(500)));
    let batch = |headers: HeaderMap, id: u64| {
        let n = node.clone();
        async move {
            let msg = json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "unbrowse_do", "arguments": { "goal": "list the items", "pages": [page], "wait_ms": 8000 } } });
            let (_, Json(m)) = mcp_answer(n, &headers, msg).await;
            serde_json::from_str::<Value>(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
        }
    };
    let (first, other) = rt.block_on(async {
        let first = tokio::spawn(batch(headers_a.clone(), 1));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let other = batch(headers_b.clone(), 2).await;
        (first.await.unwrap(), other)
    });
    for (who, r) in [("first", &first), ("second", &other)] {
        assert_eq!((r["how"].as_str(), r["outcome"].as_str()), (Some("pages"), Some("answered")), "{who}: {r}");
        assert_eq!(r["pages"][0]["data"]["items"][0]["name"], "desk lamp", "{who}: {r}");
    }
    assert_eq!(slow.started.load(std::sync::atomic::Ordering::SeqCst), 2, "each agent's batch walked the page for itself");
    let _ = std::fs::remove_dir_all(&home);
}

/// The agent's names for a route's values are read as the route's own: a name the call sends an input under (a query key,
/// a form field, the last key of a JSON body's pointer, a part of a multipart form) is that input; a name nothing sends is
/// ignored and said, never taken for a value the call used. Routes that take every name the agent gave are the ones its
/// inputs mean, and where none does, all of them stand.
#[test]
fn an_agents_names_for_values_are_read_as_the_names_the_call_sends_them_under() {
    let input = |name: &str, loc: Value| json!({ "loc": loc, "class": "input", "name": name, "secret": false, "default": "was" });
    let mut r = route("sends", "shop.example", "search the shop", &["q", "word", "pic", "kind_in"]);
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [step_of("POST", "https://shop.example/api", json!([
        input("q", json!({ "in": "query", "key": "query" })),
        input("word", json!({ "in": "json", "key": "/search/term" })),
        input("pic", json!({ "in": "part", "key": ["photo", ""] })),
        input("kind_in", json!({ "in": "form", "key": "kind" })),
    ]))] })).unwrap();
    let given = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>();
    let (bound, ignored) = goal::bind_inputs(&r, given(&[("query", "a"), ("term", "b"), ("photo", "c"), ("kind", "d")]));
    let mut names: Vec<(&str, &str)> = bound.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    names.sort();
    assert_eq!(names, [("kind_in", "d"), ("pic", "c"), ("q", "a"), ("word", "b")]);
    assert!(ignored.is_empty());
    // The route's own name wins over the name the call sends it under; the other is ignored.
    let (bound, ignored) = goal::bind_inputs(&r, given(&[("q", "1"), ("query", "2"), ("stray", "3")]));
    assert_eq!((bound["q"].as_str(), ignored), ("1", vec!["query".to_string(), "stray".to_string()]));
    let other = route("other", "other.example", "search other", &[]);
    let taking = goal::takes_all(vec![&r, &other], &given(&[("query", "a")]));
    assert_eq!(taking.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["sends"]);
    let all = goal::takes_all(vec![&r, &other], &given(&[("nothing", "a")]));
    assert_eq!(all.len(), 2, "where none takes every name, all stand");
}

/// A node without its browser answers `unbrowse_observe`, which reads a page's actions off the browser's own snapshot,
/// with `browser_missing` and what to do about it, as every other tool that needs the browser does.
#[test]
fn an_observe_on_a_node_without_its_browser_says_so() {
    let (home, rt, node, headers) = node_with_a_token("observe-no-browser");
    if !crate::browsers::lacking(crate::browsers::Need::Hands).contains(&"program") {
        // A machine whose browser program is found anyway: nothing here is missing to test.
        return;
    }
    let (n, h) = (node.clone(), headers.clone());
    let msg = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "unbrowse_observe", "arguments": { "site": "shop.example" } } });
    let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
    assert_eq!(m["result"]["isError"], true, "{m}");
    let said: Value = serde_json::from_str(m["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(said["code"], "browser_missing", "{said}");
    let _ = std::fs::remove_dir_all(&home);
}

/// A node's own route, once it has answered, is a tool to a session of a client that asked for route tools once that
/// session reached it, and to no other session or client; the call that reached it says so, and calling the tool
/// answers what `unbrowse_call` with that route answers (`tools.route-opt-in`, `tools.surfaced-by-session`,
/// `tools.route-is-a-call`).
#[test]
fn a_route_tool_answers_as_unbrowse_call_and_is_listed_only_to_the_session_that_reached_it() {
    let (home, rt, node, headers) = node_with_a_token("route-tools");
    let site = crate::run::test_site(vec![("/api/items", 200, "application/json", r#"{"items":[{"id":1,"name":"desk lamp"}]}"#.to_string())]);
    let url = format!("http://127.0.0.1:{site}/api/items?q=lamp");
    let crate::learn::Plain::Route(route) = crate::learn::learn_plain(&url, "search the items", "You") else { panic!("a JSON url is its own route") };
    let ask = |h: &HeaderMap, msg: Value| {
        let (n, h) = (node.clone(), h.clone());
        let (_, Json(m)) = rt.block_on(async move { mcp_answer(n, &h, msg).await });
        m
    };
    let call = |h: &HeaderMap, id: u64, tool: &str, args: Value| {
        let m = ask(h, json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": tool, "arguments": args } }));
        let reply = serde_json::from_str::<Value>(m["result"]["content"][0]["text"].as_str().unwrap_or("null")).unwrap_or_else(|_| m.clone());
        (reply, m)
    };
    let names = |h: &HeaderMap| -> Vec<String> {
        ask(h, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    };
    let session = |id: &str| {
        let mut h = headers.clone();
        h.insert(super::route_tools::ASKED_IN_HEADER, "tools".parse().unwrap());
        h.insert("mcp-session-id", id.parse().unwrap());
        h
    };
    let (one, two) = (session("route-tools-one"), session("route-tools-two"));
    let primitives = PRIMITIVES.len();
    let (by_id, _) = call(&headers, 2, "unbrowse_call", json!({ "route_id": route.id, "inputs": { "q": "lamp" } }));
    assert_eq!(by_id["ok"], json!(true), "{by_id}");
    assert!(by_id.get("tools_added").is_none(), "a client that didn't ask hears of no tools: {by_id}");
    assert_eq!(names(&headers).len(), primitives, "and sees the primitives alone");
    assert_eq!(names(&one).len(), primitives, "a session that reached nothing sees the primitives alone");
    let (reached, raw) = call(&one, 3, "unbrowse_call", json!({ "route_id": route.id, "inputs": { "q": "desk" } }));
    let tool = reached["tools_added"][0].as_str().unwrap_or_else(|| panic!("the call names the tool it brought: {reached}")).to_string();
    assert!(super::route_tools::added_by(&raw), "and its result says so for the stream: {raw}");
    assert_eq!(names(&one), PRIMITIVES.iter().map(|p| p.tool.to_string()).chain([tool.clone()]).collect::<Vec<_>>());
    assert_eq!(names(&two).len(), primitives, "another session's set is its own");
    let (again, _) = call(&one, 4, "unbrowse_call", json!({ "route_id": route.id, "inputs": { "q": "lamp" } }));
    assert!(again.get("tools_added").is_none(), "a tool is new to a session once: {again}");
    let (by_tool, _) = call(&one, 5, &tool, json!({ "q": "lamp" }));
    // The same reply but for what differs between any two calls: the ask's own id and how long the site took.
    let same = |mut v: Value| {
        if let Some(o) = v.as_object_mut() {
            o.remove("ask");
            o.remove("ms");
        }
        v
    };
    assert_eq!(same(by_tool.clone()), same(by_id.clone()), "the tool's reply is unbrowse_call's");
    assert!(serde_json::to_string(&by_tool["data"]).unwrap().contains("desk lamp"), "{by_tool}");
    let gone = ask(&one, json!({ "jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": { "name": "shop_example__nothing_000000", "arguments": {} } }));
    assert_eq!(gone["error"]["code"], json!(-32602), "{gone}");
    let init = ask(&one, json!({ "jsonrpc": "2.0", "id": 7, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "clientInfo": { "name": "t", "version": "1" } } }));
    assert_eq!(init["result"]["capabilities"]["tools"]["listChanged"], json!(true), "{init}");
    assert!(super::route_tools::asked_in(Some("routes=tools")) && !super::route_tools::asked_in(Some("routes=none")) && !super::route_tools::asked_in(None));
    let _ = std::fs::remove_dir_all(&home);
}

// Steve QA 2026-11-24 (UNB-300): `{session}` in answers and route details where nothing of the session stood. Each test
// below fails on staging 6443f61 and is held expected-to-fail (`should_panic` on "UNB-300") until the mask is fixed: a
// fix makes it stop panicking, and the test then fails until its `should_panic` is removed.

fn walk_exchange(url: &str, headers: Vec<(&str, &str)>, answer: Value) -> unbrowse_learn::trace::Exchange {
    unbrowse_learn::trace::Exchange {
        method: "GET".into(),
        url: url.parse().unwrap(),
        request_headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        request_body: None,
        status: 200,
        response_headers: vec![("content-type".into(), "application/json".into())],
        response_body: Some(answer.to_string()),
        response_mime: "application/json".into(),
        resource_type: Some("XHR".into()),
        main_frame: Some(true),
    }
}

/// The host a walk's request went to, and the address it asked for, are the request's own address, not a credential,
/// however token-shaped they read (`Host: uj5wyc0l7x-dsn.algolia.net`, `:path: /?operationName=…`). Steve saw a Hacker
/// News search route whose site read `{session}`, and an IMDb route whose path did; release v13.18.1 said both.
#[test]
fn steve_qa_a_routes_site_and_path_are_never_said_as_the_session() {
    let home = store::scratch_home("steve-qa-host");
    let (rt, node, agent) = agent_node(&home);
    let (host, path, referer) = ("uj5wyc0l7x-dsn.algolia.net", "/1/indexes/Item_dev/query?x-algolia-agent=Algolia%20for%20JavaScript%20(4.13.1)", "https://hn.algolia.com/?q=rust&page=0&dateRange=all");
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![walk_exchange(&format!("https://{host}{path}"), vec![("Host", host), (":path", path), ("Referer", referer)], json!({ "hits": [] }))],
        inputs: Vec::new(),
    });
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "route": { "site": host, "path": path, "from": referer } }));
    let _ = std::fs::remove_dir_all(&home);
    assert!(heard.contains(host) && heard.contains(path) && heard.contains(referer), "UNB-300: the request's own address was said as the session: {heard}");
}

/// A name written as words in camel case (a GraphQL operation `TitleContentRating`) that the site listed among others
/// and the page then sent back is the site's word, not minted for a visitor. Steve saw an IMDb route whose operation
/// names all read `{session}`.
#[test]
fn steve_qa_a_camel_case_name_the_page_sent_back_is_never_said_as_the_session() {
    let home = store::scratch_home("steve-qa-camel");
    let (rt, node, agent) = agent_node(&home);
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            walk_exchange("https://www.example.com/title/tt0111161/", vec![], json!({ "queries": ["TitleContentRating", "TitleMainSidebarQuery"] })),
            walk_exchange("https://graphql.example.com/?operationName=TitleContentRating&op2=TitleMainSidebarQuery", vec![], json!({ "data": {} })),
        ],
        inputs: Vec::new(),
    });
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "operationName": { "options": ["TitleContentRating", "TitleMainSidebarQuery"] } }));
    let _ = std::fs::remove_dir_all(&home);
    assert!(heard.contains("TitleContentRating") && heard.contains("TitleMainSidebarQuery"), "UNB-300: a camel-case name was said as the session: {heard}");
}

/// A name the site's own script carries (`getElementById`, an operation's name in the bundle) is its code, fetched by
/// every visitor, and the page sending it back hands no one a credential. Steve saw an npm README read
/// `document.{session}('root')`.
#[test]
fn steve_qa_a_name_the_sites_script_carries_is_never_said_as_the_session() {
    let home = store::scratch_home("steve-qa-script");
    let (rt, node, agent) = agent_node(&home);
    let mut script = walk_exchange("https://static.example.com/app.js", vec![], json!(null));
    script.resource_type = Some("Script".into());
    script.response_mime = "application/javascript".into();
    script.response_body = Some("document.getElementById('root');fetch('/q?fn='+'getElementById')".into());
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            script,
            walk_exchange("https://www.example.com/config", vec![], json!({ "call": "getElementById" })),
            walk_exchange("https://www.example.com/q?fn=getElementById", vec![], json!({ "data": {} })),
        ],
        inputs: Vec::new(),
    });
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "readme": "document.getElementById('root')" }));
    let _ = std::fs::remove_dir_all(&home);
    assert!(heard.contains("getElementById"), "UNB-300: a name the site's script carries was said as the session: {heard}");
}

/// What the mask spares as the site's own (a name its scripts carry, a pick from a list) never spares a credential
/// written the same way: a token in a script served to one visitor (`Cache-Control: private`, a `Set-Cookie`), and a
/// token picked from a list of the visitor's own keys, are still said as the session.
#[test]
fn a_token_a_visitors_own_script_or_a_list_of_keys_carries_is_still_the_session() {
    let home = store::scratch_home("unb300-guard");
    let (rt, node, agent) = agent_node(&home);
    let (in_script, in_list, other) = ("Zq9xS3ss1onT0k3nPr1v", "Kp7wAp1K3yS3cr3tN0w8", "Mv2qAp1K3yS3cr3tN0w3");
    let mut private = walk_exchange("https://www.example.com/session.js", vec![], json!(null));
    private.resource_type = Some("Script".into());
    private.response_headers = vec![("cache-control".into(), "private, max-age=0".into())];
    private.response_body = Some(format!("window.__t='{in_script}'"));
    let mut cookie = private.clone();
    cookie.url = "https://www.example.com/boot.js".parse().unwrap();
    cookie.response_headers = vec![("set-cookie".into(), "sid=1; Path=/".into())];
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            private,
            cookie,
            walk_exchange("https://www.example.com/me", vec![], json!({ "t": in_script, "api_keys": [{ "token": in_list }, { "token": other }] })),
            walk_exchange(&format!("https://www.example.com/q?t={in_script}&k={in_list}"), vec![], json!({ "data": {} })),
        ],
        inputs: Vec::new(),
    });
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "a": in_script, "b": in_list }));
    let _ = std::fs::remove_dir_all(&home);
    assert!(!heard.contains(in_script) && !heard.contains(in_list), "a visitor's own token reached an agent: {heard}");
}

/// Still open (UNB-300): a camel-case name one answer handed the page alone and the page sent back, with no script of
/// the walk carrying it, is held as a token. Its shape can't tell it from one: letters only in camel case passed as
/// "words" for 1.3% of random letter tokens and 0.07% of random base62 ones of 16 characters (measured on 400,000
/// each), too many for the mask. Held expected-to-fail until a reading of where the name came from tells it apart.
#[test]
#[should_panic(expected = "UNB-300")]
fn steve_qa_a_camel_case_name_one_answer_handed_back_alone_is_never_said_as_the_session() {
    let home = store::scratch_home("steve-qa-camel-alone");
    let (rt, node, agent) = agent_node(&home);
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            walk_exchange("https://www.example.com/title/tt0111161/", vec![], json!({ "call": "PricedOfferSummary" })),
            walk_exchange("https://graphql.example.com/?fn=PricedOfferSummary", vec![], json!({ "data": {} })),
        ],
        inputs: Vec::new(),
    });
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "readme": "document.PricedOfferSummary('root')" }));
    let _ = std::fs::remove_dir_all(&home);
    assert!(heard.contains("PricedOfferSummary"), "UNB-300: a camel-case name was said as the session: {heard}");
}

/// A place the site listed among others, each with its own id, and the page then sent back for the one picked, is the
/// pick, not a credential: every visitor who searches the same place gets the same id. Steve saw Airbnb answers whose
/// links read `place_id={session}` on staging (the Google place id of Osaka, from the site's own suggestions).
#[test]
fn steve_qa_a_place_id_the_site_listed_is_never_said_as_the_session() {
    let home = store::scratch_home("steve-qa-place");
    let (rt, node, agent) = agent_node(&home);
    let (osaka, station) = ("ChIJ4eIGNFXmAGAR5y9q5G7BW8U", "ChIJ0Qgx67KMGGARd2ZbObLZHPE");
    crate::session_held::note_trace(&unbrowse_learn::Trace {
        exchanges: vec![
            walk_exchange("https://www.stays.example/api/autocomplete?q=Osaka", vec![], json!({ "suggestions": [{ "name": "Osaka", "placeId": osaka }, { "name": "Osaka Station", "placeId": station }] })),
            walk_exchange(&format!("https://www.stays.example/s/Osaka/homes?place_id={osaka}"), vec![], json!({ "results": [] })),
        ],
        inputs: Vec::new(),
    });
    let link = format!("https://www.stays.example/s/Osaka/homes?place_id={osaka}&refinement_paths%5B%5D=%2Fhomes");
    let heard = heard_by_an_agent(&rt, &node, &agent, json!({ "listings": [{ "title": "Flat in Sumida-ku", "link": link }] }));
    let _ = std::fs::remove_dir_all(&home);
    assert!(heard.contains(&link), "UNB-300: a listed place's id was said as the session: {heard}");
}
