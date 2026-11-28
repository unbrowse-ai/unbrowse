//! A call whose site drifted is mended by a fresh sighting of the route's page (UNB-208): the browser is a program
//! that answers what it is asked and records the walk it was sent to, the site a wire that answers by address.
use super::*;
use crate::replay::fake_wire::Answer;
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;

const WALK: &str = concat!(
    r#"{"type":"exchange","t":1.0,"resourceType":"Document","entry":{"request":{"method":"GET","url":"https://shop.example/","headers":[]},"response":{"status":200,"headers":[{"name":"set-cookie","value":"sid=walked; Path=/; HttpOnly"}],"content":{"mimeType":"text/html","text":"<html>hello</html>"}}}}"#, "\n",
    r#"{"type":"exchange","t":2.0,"resourceType":"XHR","entry":{"request":{"method":"GET","url":"https://shop.example/api/v2/list?q=lamps","headers":[]},"response":{"status":200,"headers":[],"content":{"mimeType":"application/json","text":"{\"items\":[1]}"}}}}"#, "\n",
);
const JAR: &str = r#"{"success":true,"data":{"cookies":[{"name":"sid","value":"fresh","domain":"shop.example","path":"/","httpOnly":true,"expires":-1}]}}"#;
const STORAGE: &str = "[agent-browser] evaluated\n{\"local\":{\"theme\":\"dark\"},\"session\":{\"tab\":\"3\"}}";

/// A browser program that, sent to open a page, records `walk` as the capture of the session it was asked under.
fn a_walker(dir: &std::path::Path, walk: &str) -> String {
    std::fs::create_dir_all(dir).unwrap();
    for (name, text) in [("page.json", r#""<html><body>results</body></html>""#), ("cookies.json", JAR), ("storage.json", STORAGE), ("capture.jsonl", walk)] {
        std::fs::write(dir.join(name), text).unwrap();
    }
    let (program, d) = (dir.join("walker"), dir.display());
    std::fs::write(
        &program,
        format!("#!/bin/sh\ncase \"$*\" in\n  *\"cookies get\"*) cat '{d}/cookies.json' ;;\n  *outerHTML*) cat '{d}/page.json' ;;\n  *localStorage*) cat '{d}/storage.json' ;;\n  *\"get title\"*) echo 'A page' ;;\n  *\"get url\"*) echo 'https://shop.example/' ;;\n  *\" open \"*) mkdir -p \"$UNBROWSE_CAPTURE_DIR\"; cp '{d}/capture.jsonl' \"$UNBROWSE_CAPTURE_DIR/$2.jsonl\" ;;\nesac\n"),
    )
    .unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    program.to_string_lossy().into_owned()
}

/// A site that has moved its list: the old address is gone, the new one answers.
struct Moved {
    seen: &'static Mutex<Vec<String>>,
}

impl Answer for Moved {
    fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        let path = req.url.path().to_string();
        self.seen.lock().unwrap().push(path.clone());
        let (status, body) = if path == "/api/v2/list" { (200, r#"{"items":[1]}"#) } else { (404, r#"{"error":"gone"}"#) };
        Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status, response_headers: vec![], response_body: Some(body.into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
    }
}

fn a_client(wire: fn() -> Box<dyn Fetch>, walker: &str, tag: &str) -> RouteClient {
    let step = crate::graph::Step { lifetime: None,
        page_signed: false,
        page_producers: Vec::new(),
        exchange: 1,
        method: "GET".into(),
        status: 200,
        url: "https://shop.example/api/old/list".into(),
        fields: vec![],
        body: None,
        response_shape: None,
        needs_browser: false,
        reads_page: false,
        sets_cookie: false,
        on_load: false,
        foreign: false,
        held: vec![],
        fallbacks: Vec::new(),
    };
    let mut c = RouteClient::new(Graph { steps: vec![step], provisional: false, page_origin: None, ..Graph::default() }).with_browser(walker).with_cdp(Some({
        // An address nothing listens on, so the walk runs through the browser program.
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://127.0.0.1:{}", held.local_addr().unwrap().port())
    }));
    c.root = Some(format!("https://shop.example/?walk={tag}"));
    c.target = Some(("GET".into(), "list".into()));
    c.wire = Some(wire);
    c
}

/// A route whose list moved is walked again from its page: the call fails where it was, the page is seen in the
/// browser, the chain is rebuilt on the address the walk shows, and the call is made there. What the walk earned (the
/// session the browser holds) is the client's from then on, and the mended chain
/// is the one the caller keeps.
#[test]
fn a_route_whose_list_moved_is_walked_again_and_called_where_the_walk_found_it() {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let dir = std::env::temp_dir().join(format!("unbrowse-heal-cov-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let mut c = a_client(|| Box::new(Moved { seen: &SEEN }), &a_walker(&dir, WALK), "cov-heal");
    c.jar.insert("sid".into(), "old".into());
    let answer = c.call(&HashMap::new()).expect("the call is answered where the walk found the list");
    assert_eq!(answer["items"][0], 1);
    assert_eq!(*SEEN.lock().unwrap(), ["/api/old/list", "/api/old/list", "/api/v2/list"], "the old chain once, again on what the walk earned, then the rebuilt one");
    let mended = c.healed().expect("the mended chain is kept");
    assert!(mended.steps.last().unwrap().url.contains("/api/v2/list"), "{:?}", mended.steps.last().map(|s| &s.url));
    assert!(c.used_browser());
    assert_eq!(c.jar.get("sid").map(String::as_str), Some("fresh"), "the browser's session is the client's");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A walk that shows no call at the route's target mends nothing: the call fails as it failed, and the chain is kept.
#[test]
fn a_walk_that_shows_no_call_at_the_target_mends_nothing() {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let dir = std::env::temp_dir().join(format!("unbrowse-heal-cov-none-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let only_the_page = WALK.lines().next().unwrap().to_string() + "\n";
    let mut c = a_client(|| Box::new(Moved { seen: &SEEN }), &a_walker(&dir, &only_the_page), "cov-heal-none");
    let e = c.call(&HashMap::new()).unwrap_err();
    assert!(matches!(e, ReplayError::Failed { status: 404, .. }), "{e:?}");
    assert!(c.healed().is_none());
    assert!(!SEEN.lock().unwrap().iter().any(|p| p == "/api/v2/list"), "{:?}", SEEN.lock().unwrap());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A site whose wall refuses the plain transport, and a browser program that holds the page and runs fetches in it.
struct Walled {
    seen: &'static Mutex<Vec<String>>,
}

impl Answer for Walled {
    fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.seen.lock().unwrap().push(req.url.path().to_string());
        Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 403, response_headers: vec![("server".into(), "wall".into())], response_body: Some("<html>blocked</html>".into()), response_mime: "text/html".into(), resource_type: None, main_frame: None })
    }
}

/// A step the site's wall refuses to the plain transport is made by the node's browser, in the page the browser holds
/// open on the site: what the browser's fetch answered is the call's answer, and the call says a browser was used.
#[test]
fn a_step_the_wall_refuses_to_the_plain_transport_is_made_in_the_browser_and_answered_from_there() {
    static SEEN: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let dir = std::env::temp_dir().join(format!("unbrowse-wall-cov-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let page = serde_json::to_string(&format!("<html><body>{}</body></html>", "a lamp for the desk ".repeat(200))).unwrap();
    let fetched = serde_json::to_string(r#"[200,"application/json",[],"{\"items\":[7]}","https://shop.example/api/old/list"]"#).unwrap();
    let log = dir.join("said.log");
    let mut sh = format!("#!/bin/sh\necho \"$*\" >> '{}'\ncase \"$*\" in\n", log.display());
    for (i, (pattern, answer)) in [("fetch(", fetched.as_str()), ("outerHTML", page.as_str()), ("get url", "https://shop.example/home")].iter().enumerate() {
        let file = dir.join(format!("answer{i}"));
        std::fs::write(&file, answer).unwrap();
        sh.push_str(&format!("  *'{pattern}'*) cat '{}' ;;\n", file.display()));
    }
    sh.push_str("esac\n");
    let program = dir.join("program");
    std::fs::write(&program, sh).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut c = a_client(|| Box::new(Walled { seen: &SEEN }), &program.to_string_lossy(), "cov-wall");
    c.root = None;
    let answer = c.call(&HashMap::new()).expect("the browser's answer is the call's");
    assert_eq!(answer["items"][0], 7);
    assert!(c.used_browser());
    assert_eq!(*SEEN.lock().unwrap(), ["/api/old/list"], "the plain transport was asked once");
    assert!(std::fs::read_to_string(&log).unwrap().contains("fetch("), "the step was fetched in the page");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A site that answers `/api/list` with `401` to a call that carries no fresh session.
struct Expiring {
    seen: &'static Mutex<Vec<(String, String)>>,
}

impl Answer for Expiring {
    fn answer(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        let cookie = req.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.clone()).unwrap_or_default();
        self.seen.lock().unwrap().push((req.url.path().to_string(), cookie.clone()));
        let (status, body) = if req.url.path() == "/api/list" && !cookie.contains("sid=fresh") { (401, r#"{"error":"signed out"}"#) } else { (200, r#"{"items":[1]}"#) };
        Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status, response_headers: vec![], response_body: Some(body.into()), response_mime: "application/json".into(), resource_type: None, main_frame: None })
    }
}

fn a_route_behind_a_sign_in(wire: fn() -> Box<dyn Fetch>) -> RouteClient {
    let step = |exchange: usize, path: &str| crate::graph::Step { lifetime: None,
        page_signed: false,
        page_producers: Vec::new(),
        exchange,
        method: "GET".into(),
        status: 200,
        url: format!("https://shop.example{path}"),
        fields: vec![],
        body: None,
        response_shape: None,
        needs_browser: false,
        reads_page: false,
        sets_cookie: false,
        on_load: false,
        foreign: false,
        held: vec![],
        fallbacks: Vec::new(),
    };
    let mut c = RouteClient::new(Graph { steps: vec![step(0, "/api/me"), step(1, "/api/list")], provisional: false, page_origin: None, ..Graph::default() });
    c.jar.insert("sid".into(), "old".into());
    c.wire = Some(wire);
    c
}

/// A call answered 401 on a site whose sign-in the node holds as a request of its own makes that request, once, and
/// calls again on the session it earned, with the jar kept beside the client's store; where the sign-in earns nothing,
/// the call fails as it failed.
#[test]
fn a_signed_out_call_is_made_again_on_the_session_the_nodes_own_sign_in_earns() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEEN: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    static NONE: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    let dir = std::env::temp_dir().join(format!("unbrowse-signin-cov-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let signed_in = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = signed_in.clone();
    let mut c = a_route_behind_a_sign_in(|| Box::new(Expiring { seen: &SEEN })).with_session_store(&dir).with_plain_sign_in(Some(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        Some(HashMap::from([("sid".to_string(), "fresh".to_string())]))
    })));
    let answer = c.call(&HashMap::new()).expect("the call is made again on the new session");
    assert_eq!(answer["items"][0], 1);
    assert_eq!(signed_in.load(Ordering::SeqCst), 1, "the sign-in is sent once");
    let seen = SEEN.lock().unwrap().clone();
    assert!(seen.iter().filter(|(p, _)| p == "/api/list").count() >= 2, "{seen:?}");
    assert!(seen.last().is_some_and(|(_, cookie)| cookie.contains("sid=fresh")), "the last call carried the new session: {seen:?}");
    assert_eq!(c.jar.get("sid").map(String::as_str), Some("fresh"));

    let nothing = std::sync::Arc::new(AtomicUsize::new(0));
    let counted = nothing.clone();
    let mut c = a_route_behind_a_sign_in(|| Box::new(Expiring { seen: &NONE })).with_plain_sign_in(Some(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
        None
    })));
    let e = c.call(&HashMap::new()).unwrap_err();
    assert!(matches!(e, ReplayError::Failed { status: 401, .. }), "{e:?}");
    assert_eq!(nothing.load(Ordering::SeqCst), 1);
    let _ = std::fs::remove_dir_all(&dir);
}
