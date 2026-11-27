//! The WebDriver client, Appium manager, backend, iOS and Safari helpers
//! against a local stub W3C server and fake `xcrun` / `which` executables:
//! the exact requests each call sends and what it hands back.

use crate::native::webdriver::appium::AppiumManager;
use crate::native::webdriver::backend::{BrowserBackend, WebDriverBackend};
use crate::native::webdriver::client::WebDriverClient;
use crate::native::webdriver::ios::{
    boot_simulator, list_all_devices, list_real_devices, list_simulators, select_device,
    shutdown_simulator, to_device_json, IosDevice,
};
use crate::native::webdriver::safari::{find_safaridriver, launch_safaridriver};
use crate::test_utils::EnvGuard;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const ELEMENT_KEY: &str = "element-6066-11e4-a52e-4f735466cecf";

#[derive(Debug, Clone, PartialEq)]
struct Seen {
    method: String,
    path: String,
    body: Value,
}

struct Route {
    method: &'static str,
    path: String,
    status: u16,
    body: String,
    chunked: bool,
}

fn route(method: &'static str, path: &str, value: Value) -> Route {
    Route {
        method,
        path: path.to_string(),
        status: 200,
        body: json!({ "value": value }).to_string(),
        chunked: false,
    }
}

fn raw_route(method: &'static str, path: &str, status: u16, body: &str) -> Route {
    Route {
        method,
        path: path.to_string(),
        status,
        body: body.to_string(),
        chunked: false,
    }
}

struct Stub {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

fn read_request(stream: &mut TcpStream) -> Option<Seen> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).ok()?;
        let h = h.trim().to_lowercase();
        if h.is_empty() {
            break;
        }
        if let Some(v) = h.strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).ok()?;
    let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
    Some(Seen { method, path, body })
}

impl Stub {
    fn start(routes: Vec<Route>) -> Stub {
        Stub::serve(TcpListener::bind("127.0.0.1:0").unwrap(), routes)
    }

    fn start_on(port: u16, routes: Vec<Route>) -> Option<Stub> {
        TcpListener::bind(("127.0.0.1", port))
            .ok()
            .map(|l| Stub::serve(l, routes))
    }

    fn serve(listener: TcpListener, routes: Vec<Route>) -> Stub {
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen2, stop2) = (seen.clone(), stop.clone());
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop2.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                let Some(req) = read_request(&mut stream) else {
                    continue;
                };
                let found = routes
                    .iter()
                    .find(|r| r.method == req.method && r.path == req.path);
                seen2.lock().unwrap().push(req);
                let (status, body, chunked) = match found {
                    Some(r) => (r.status, r.body.clone(), r.chunked),
                    None => (
                        404,
                        json!({"value": {"error": "unknown command", "message": "no route"}})
                            .to_string(),
                        false,
                    ),
                };
                let reply = if chunked {
                    format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                        body.len(),
                        body
                    )
                } else {
                    format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                };
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Stub {
            port,
            seen,
            stop,
            handle: Some(handle),
        }
    }

    fn seen(&self) -> Vec<(String, String, Value)> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|s| (s.method.clone(), s.path.clone(), s.body.clone()))
            .collect()
    }

    fn client(&self) -> WebDriverClient {
        WebDriverClient::new_with_session(self.port, "S1".to_string())
    }
}

impl Drop for Stub {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn req(method: &str, path: &str, body: Value) -> (String, String, Value) {
    (method.to_string(), path.to_string(), body)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

// ---------------------------------------------------------------- client

#[tokio::test]
async fn create_session_posts_always_match_caps_and_keeps_the_session_id() {
    let stub = Stub::start(vec![route(
        "POST",
        "/session",
        json!({"sessionId": "abc", "capabilities": {}}),
    )]);
    let mut c = WebDriverClient::new(stub.port);
    assert_eq!(c.session_id_pub(), None);
    let resp = c
        .create_session(json!({"browserName": "Safari"}))
        .await
        .unwrap();
    assert_eq!(resp["value"]["sessionId"], "abc");
    assert_eq!(c.session_id_pub(), Some("abc"));
    assert_eq!(
        stub.seen(),
        vec![req(
            "POST",
            "/session",
            json!({"capabilities": {"alwaysMatch": {"browserName": "Safari"}}})
        )]
    );
}

#[tokio::test]
async fn create_session_without_a_session_id_is_an_error_and_keeps_no_session() {
    let stub = Stub::start(vec![route("POST", "/session", json!({"capabilities": {}}))]);
    let mut c = WebDriverClient::new(stub.port);
    let err = c.create_session(json!({})).await.unwrap_err();
    assert_eq!(err, "No sessionId in response");
    assert_eq!(c.session_id_pub(), None);
}

#[tokio::test]
async fn delete_session_sends_delete_and_forgets_the_id_even_if_the_server_errors() {
    let stub = Stub::start(vec![]);
    let mut c = stub.client();
    c.delete_session().await.unwrap();
    assert_eq!(c.session_id_pub(), None);
    assert_eq!(stub.seen(), vec![req("DELETE", "/session/S1", Value::Null)]);
    // Nothing left to delete: no second request.
    c.delete_session().await.unwrap();
    assert_eq!(stub.seen().len(), 1);
}

#[tokio::test]
async fn navigate_posts_the_url_to_the_session_url_route() {
    let stub = Stub::start(vec![route("POST", "/session/S1/url", Value::Null)]);
    stub.client()
        .navigate("https://example.com/")
        .await
        .unwrap();
    assert_eq!(
        stub.seen(),
        vec![req(
            "POST",
            "/session/S1/url",
            json!({"url": "https://example.com/"})
        )]
    );
}

#[tokio::test]
async fn getters_read_their_route_and_return_the_string_value() {
    let stub = Stub::start(vec![
        route("GET", "/session/S1/url", json!("https://a.test/")),
        route("GET", "/session/S1/title", json!("Title A")),
        route("GET", "/session/S1/source", json!("<html></html>")),
        route("GET", "/session/S1/screenshot", json!("aGVsbG8=")),
        route(
            "GET",
            "/session/S1/cookie",
            json!([{"name": "k", "value": "v"}]),
        ),
        route("GET", "/session/S1/window/handles", json!(["h1", "h2"])),
    ]);
    let c = stub.client();
    assert_eq!(c.get_url().await.unwrap(), "https://a.test/");
    assert_eq!(c.get_title().await.unwrap(), "Title A");
    assert_eq!(c.get_page_source().await.unwrap(), "<html></html>");
    assert_eq!(c.screenshot().await.unwrap(), "aGVsbG8=");
    assert_eq!(
        c.get_cookies().await.unwrap(),
        json!([{"name": "k", "value": "v"}])
    );
    assert_eq!(c.get_window_handles().await.unwrap(), vec!["h1", "h2"]);
    let paths: Vec<String> = stub.seen().into_iter().map(|s| s.1).collect();
    assert_eq!(
        paths,
        vec![
            "/session/S1/url",
            "/session/S1/title",
            "/session/S1/source",
            "/session/S1/screenshot",
            "/session/S1/cookie",
            "/session/S1/window/handles"
        ]
    );
    assert!(stub.seen().iter().all(|s| s.0 == "GET"));
}

#[tokio::test]
async fn string_getters_fall_back_to_empty_and_cookies_to_null_when_value_is_not_usable() {
    let stub = Stub::start(vec![
        route("GET", "/session/S1/url", json!(7)),
        route("GET", "/session/S1/title", json!(null)),
        route("GET", "/session/S1/source", json!({"a": 1})),
        route("GET", "/session/S1/screenshot", json!(false)),
        raw_route("GET", "/session/S1/cookie", 200, "{}"),
    ]);
    let c = stub.client();
    assert_eq!(c.get_url().await.unwrap(), "");
    assert_eq!(c.get_title().await.unwrap(), "");
    assert_eq!(c.get_page_source().await.unwrap(), "");
    assert_eq!(c.screenshot().await.unwrap(), "");
    assert_eq!(c.get_cookies().await.unwrap(), Value::Null);
}

#[tokio::test]
async fn window_handles_that_are_not_a_string_list_are_an_error() {
    let stub = Stub::start(vec![route("GET", "/session/S1/window/handles", json!("x"))]);
    let err = stub.client().get_window_handles().await.unwrap_err();
    assert!(
        err.starts_with("Invalid window handles response: "),
        "{err}"
    );
}

#[tokio::test]
async fn find_element_posts_using_and_value_and_returns_the_w3c_id() {
    let stub = Stub::start(vec![route(
        "POST",
        "/session/S1/element",
        json!({ ELEMENT_KEY: "el-9" }),
    )]);
    let id = stub
        .client()
        .find_element("css selector", "#go")
        .await
        .unwrap();
    assert_eq!(id, "el-9");
    assert_eq!(
        stub.seen(),
        vec![req(
            "POST",
            "/session/S1/element",
            json!({"using": "css selector", "value": "#go"})
        )]
    );
}

#[tokio::test]
async fn find_element_accepts_the_legacy_element_key() {
    let stub = Stub::start(vec![route(
        "POST",
        "/session/S1/element",
        json!({ "ELEMENT": "old-1" }),
    )]);
    let id = stub.client().find_element("xpath", "//a").await.unwrap();
    assert_eq!(id, "old-1");
}

#[tokio::test]
async fn find_element_miss_over_http_names_the_locator() {
    let stub = Stub::start(vec![raw_route(
        "POST",
        "/session/S1/element",
        404,
        &json!({"value": {"error": "no such element", "message": "gone"}}).to_string(),
    )]);
    let err = stub
        .client()
        .find_element("css selector", ".missing")
        .await
        .unwrap_err();
    assert_eq!(err, "No element found by css selector '.missing'");
}

#[tokio::test]
async fn find_element_with_no_value_key_is_an_error() {
    let stub = Stub::start(vec![raw_route("POST", "/session/S1/element", 200, "{}")]);
    let err = stub
        .client()
        .find_element("css selector", "a")
        .await
        .unwrap_err();
    assert_eq!(err, "No element in response");
}

#[tokio::test]
async fn element_actions_put_the_element_id_in_the_path_and_the_text_in_the_body() {
    let stub = Stub::start(vec![
        route("POST", "/session/S1/element/E7/click", Value::Null),
        route("POST", "/session/S1/element/E7/value", Value::Null),
        route("POST", "/session/S1/element/E7/clear", Value::Null),
    ]);
    let c = stub.client();
    c.click_element("E7").await.unwrap();
    c.send_keys("E7", "héllo").await.unwrap();
    c.clear_element("E7").await.unwrap();
    assert_eq!(
        stub.seen(),
        vec![
            req("POST", "/session/S1/element/E7/click", json!({})),
            req(
                "POST",
                "/session/S1/element/E7/value",
                json!({"text": "héllo"})
            ),
            req("POST", "/session/S1/element/E7/clear", json!({})),
        ]
    );
}

#[tokio::test]
async fn execute_script_sends_script_and_args_and_returns_the_value() {
    let stub = Stub::start(vec![route(
        "POST",
        "/session/S1/execute/sync",
        json!({"n": 3}),
    )]);
    let c = stub.client();
    let out = c
        .execute_script("return arguments[0]", vec![json!(1), json!("x")])
        .await
        .unwrap();
    assert_eq!(out, json!({"n": 3}));
    assert_eq!(
        stub.seen(),
        vec![req(
            "POST",
            "/session/S1/execute/sync",
            json!({"script": "return arguments[0]", "args": [1, "x"]})
        )]
    );
}

#[tokio::test]
async fn execute_script_without_a_value_is_null() {
    let stub = Stub::start(vec![raw_route(
        "POST",
        "/session/S1/execute/sync",
        200,
        "{}",
    )]);
    assert_eq!(
        stub.client().execute_script("1", vec![]).await.unwrap(),
        Value::Null
    );
}

#[tokio::test]
async fn history_and_refresh_post_an_empty_object_to_their_own_routes() {
    let stub = Stub::start(vec![
        route("POST", "/session/S1/back", Value::Null),
        route("POST", "/session/S1/forward", Value::Null),
        route("POST", "/session/S1/refresh", Value::Null),
    ]);
    let c = stub.client();
    c.back().await.unwrap();
    c.forward().await.unwrap();
    c.refresh().await.unwrap();
    assert_eq!(
        stub.seen(),
        vec![
            req("POST", "/session/S1/back", json!({})),
            req("POST", "/session/S1/forward", json!({})),
            req("POST", "/session/S1/refresh", json!({})),
        ]
    );
}

#[tokio::test]
async fn execute_actions_posts_the_actions_to_the_given_session() {
    let stub = Stub::start(vec![route("POST", "/session/OTHER/actions", Value::Null)]);
    let actions = json!({"actions": [{"type": "key", "id": "k"}]});
    stub.client()
        .execute_actions("OTHER", &actions)
        .await
        .unwrap();
    assert_eq!(
        stub.seen(),
        vec![req("POST", "/session/OTHER/actions", actions)]
    );
}

#[tokio::test]
async fn every_session_call_without_a_session_fails_before_any_request() {
    let stub = Stub::start(vec![]);
    let c = WebDriverClient::new(stub.port);
    let none = "No active WebDriver session";
    assert_eq!(c.navigate("u").await.unwrap_err(), none);
    assert_eq!(c.get_window_handles().await.unwrap_err(), none);
    assert_eq!(c.get_url().await.unwrap_err(), none);
    assert_eq!(c.get_title().await.unwrap_err(), none);
    assert_eq!(c.find_element("a", "b").await.unwrap_err(), none);
    assert_eq!(c.click_element("e").await.unwrap_err(), none);
    assert_eq!(c.send_keys("e", "t").await.unwrap_err(), none);
    assert_eq!(c.clear_element("e").await.unwrap_err(), none);
    assert_eq!(c.execute_script("s", vec![]).await.unwrap_err(), none);
    assert_eq!(c.screenshot().await.unwrap_err(), none);
    assert_eq!(c.get_cookies().await.unwrap_err(), none);
    assert_eq!(c.get_page_source().await.unwrap_err(), none);
    assert_eq!(c.back().await.unwrap_err(), none);
    assert_eq!(c.forward().await.unwrap_err(), none);
    assert_eq!(c.refresh().await.unwrap_err(), none);
    assert!(stub.seen().is_empty());
}

#[tokio::test]
async fn an_unreachable_driver_is_a_connection_failure() {
    let c = WebDriverClient::new_with_session(free_port(), "S1".to_string());
    let err = c.get_url().await.unwrap_err();
    assert!(err.starts_with("Connection failed: "), "{err}");
}

#[tokio::test]
async fn a_body_that_is_not_json_reports_its_first_100_chars() {
    let long = format!("nope {}", "z".repeat(300));
    let stub = Stub::start(vec![raw_route("GET", "/session/S1/url", 200, &long)]);
    let err = stub.client().get_url().await.unwrap_err();
    let expected_body: String = long.chars().take(100).collect();
    assert!(err.starts_with("Invalid JSON response: "), "{err}");
    assert!(
        err.ends_with(&format!("(body: {})", expected_body)),
        "{err}"
    );
}

#[tokio::test]
async fn an_empty_body_reads_as_an_empty_object() {
    let stub = Stub::start(vec![raw_route("POST", "/session/S1/url", 200, "")]);
    stub.client().navigate("u").await.unwrap();
    let stub = Stub::start(vec![raw_route("GET", "/session/S1/cookie", 200, "")]);
    assert_eq!(stub.client().get_cookies().await.unwrap(), Value::Null);
}

#[tokio::test]
async fn a_chunked_response_is_decoded_before_parsing() {
    let mut r = route("GET", "/session/S1/title", json!("Chunky"));
    r.chunked = true;
    let stub = Stub::start(vec![r]);
    assert_eq!(stub.client().get_title().await.unwrap(), "Chunky");
}

// --------------------------------------------------------------- backend

fn backend(stub: &Stub) -> WebDriverBackend {
    WebDriverBackend::new(stub.client())
}

#[tokio::test]
async fn backend_passes_navigation_reads_and_history_through_to_the_driver() {
    let stub = Stub::start(vec![
        route("POST", "/session/S1/url", Value::Null),
        route("GET", "/session/S1/url", json!("https://b.test/")),
        route("GET", "/session/S1/title", json!("B")),
        route("GET", "/session/S1/source", json!("<b/>")),
        route("POST", "/session/S1/execute/sync", json!(42)),
        route("GET", "/session/S1/screenshot", json!("png")),
        route("POST", "/session/S1/back", Value::Null),
        route("POST", "/session/S1/forward", Value::Null),
        route("POST", "/session/S1/refresh", Value::Null),
        route("GET", "/session/S1/cookie", json!([])),
    ]);
    let b = backend(&stub);
    b.navigate("https://b.test/").await.unwrap();
    assert_eq!(b.get_url().await.unwrap(), "https://b.test/");
    assert_eq!(b.get_title().await.unwrap(), "B");
    assert_eq!(b.get_content().await.unwrap(), "<b/>");
    assert_eq!(b.evaluate("return 42").await.unwrap(), json!(42));
    assert_eq!(b.screenshot().await.unwrap(), "png");
    b.back().await.unwrap();
    b.forward().await.unwrap();
    b.reload().await.unwrap();
    assert_eq!(b.get_cookies().await.unwrap(), json!([]));
    let seen = stub.seen();
    assert_eq!(
        seen[0],
        req("POST", "/session/S1/url", json!({"url": "https://b.test/"}))
    );
    assert_eq!(
        seen[4],
        req(
            "POST",
            "/session/S1/execute/sync",
            json!({"script": "return 42", "args": []})
        )
    );
    assert_eq!(seen.len(), 10);
}

#[tokio::test]
async fn backend_click_finds_by_css_then_clicks_that_element() {
    let stub = Stub::start(vec![
        route("POST", "/session/S1/element", json!({ ELEMENT_KEY: "E1" })),
        route("POST", "/session/S1/element/E1/click", Value::Null),
    ]);
    backend(&stub).click("button.ok").await.unwrap();
    assert_eq!(
        stub.seen(),
        vec![
            req(
                "POST",
                "/session/S1/element",
                json!({"using": "css selector", "value": "button.ok"})
            ),
            req("POST", "/session/S1/element/E1/click", json!({})),
        ]
    );
}

#[tokio::test]
async fn backend_fill_finds_clears_then_types_in_that_order() {
    let stub = Stub::start(vec![
        route("POST", "/session/S1/element", json!({ ELEMENT_KEY: "E2" })),
        route("POST", "/session/S1/element/E2/clear", Value::Null),
        route("POST", "/session/S1/element/E2/value", Value::Null),
    ]);
    backend(&stub).fill("input#q", "rust").await.unwrap();
    let seen = stub.seen();
    assert_eq!(seen.len(), 3);
    assert_eq!(
        seen[1],
        req("POST", "/session/S1/element/E2/clear", json!({}))
    );
    assert_eq!(
        seen[2],
        req(
            "POST",
            "/session/S1/element/E2/value",
            json!({"text": "rust"})
        )
    );
}

#[tokio::test]
async fn backend_click_on_a_missing_element_stops_after_the_lookup() {
    let stub = Stub::start(vec![raw_route(
        "POST",
        "/session/S1/element",
        404,
        &json!({"value": {"error": "no such element", "message": "m"}}).to_string(),
    )]);
    let err = backend(&stub).click(".gone").await.unwrap_err();
    assert_eq!(err, "No element found by css selector '.gone'");
    assert_eq!(stub.seen().len(), 1);
}

#[tokio::test]
async fn backend_close_deletes_the_session() {
    let stub = Stub::start(vec![]);
    let mut b = backend(&stub);
    b.close().await.unwrap();
    assert_eq!(stub.seen(), vec![req("DELETE", "/session/S1", Value::Null)]);
}

#[tokio::test]
async fn backend_connection_is_alive_only_when_window_handles_answer_with_a_list() {
    let up = Stub::start(vec![route(
        "GET",
        "/session/S1/window/handles",
        json!(["w"]),
    )]);
    assert!(backend(&up).is_connection_alive().await);
    let broken = Stub::start(vec![route(
        "GET",
        "/session/S1/window/handles",
        json!({"error": "invalid session id"}),
    )]);
    assert!(!backend(&broken).is_connection_alive().await);
    let dead = WebDriverBackend::new(WebDriverClient::new_with_session(
        free_port(),
        "S1".to_string(),
    ));
    assert!(!dead.is_connection_alive().await);
}

#[test]
fn backend_reports_webdriver_type_supports_basics_only_and_names_unsupported_actions() {
    let b = WebDriverBackend::new(WebDriverClient::new(1));
    assert_eq!(b.backend_type(), "webdriver");
    for f in ["navigate", "evaluate", "screenshot", "click", "fill"] {
        assert!(b.supports(f), "{f}");
    }
    for f in ["screencast", "tracing", "network_intercept", "cdp", "other"] {
        assert!(!b.supports(f), "{f}");
    }
    assert_eq!(
        b.unsupported_error("route"),
        "Action 'route' is not supported on the webdriver backend"
    );
}

// ---------------------------------------------------------------- appium

#[test]
fn ios_capabilities_default_the_device_name_and_omit_missing_fields() {
    let caps = AppiumManager::build_ios_capabilities(None, None, None);
    assert_eq!(
        caps,
        json!({
            "platformName": "iOS",
            "appium:automationName": "XCUITest",
            "browserName": "Safari",
            "appium:noReset": true,
            "appium:deviceName": "iPhone",
        })
    );
    let caps = AppiumManager::build_ios_capabilities(Some("U-1"), Some("iPhone 16"), Some("18.5"));
    assert_eq!(caps["appium:deviceName"], "iPhone 16");
    assert_eq!(caps["appium:platformVersion"], "18.5");
    assert_eq!(caps["appium:udid"], "U-1");
}

fn script_dir(tag: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("wdstub-{tag}-"))
        .tempdir()
        .unwrap()
}

#[cfg(unix)]
fn write_exe(dir: &std::path::Path, name: &str, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join(name);
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

const APPIUM_PORT: u16 = 4723;

#[cfg(unix)]
#[tokio::test]
async fn appium_attaches_to_a_running_server_then_drives_session_tap_swipe_and_close() {
    let _env = EnvGuard::new(&["PATH"]);
    let Some(stub) = Stub::start_on(
        APPIUM_PORT,
        vec![
            route(
                "POST",
                "/session",
                json!({"sessionId": "AP1", "capabilities": {}}),
            ),
            route("POST", "/session/AP1/actions", Value::Null),
            route("DELETE", "/session/AP1", Value::Null),
        ],
    ) else {
        return; // port 4723 is taken by something else on this box
    };
    let mut m = AppiumManager::connect_or_launch(Some("UD-1"))
        .await
        .unwrap();
    assert_eq!(m.device_udid.as_deref(), Some("UD-1"));
    assert_eq!(m.tap(1.0, 2.0).await.unwrap_err(), "No active session");
    assert_eq!(
        m.swipe(1.0, 2.0, 3.0, 4.0, 5).await.unwrap_err(),
        "No active session"
    );
    m.create_ios_session(Some("iPhone 16"), Some("18.5"))
        .await
        .unwrap();
    m.tap(10.9, 20.2).await.unwrap();
    m.swipe(1.7, 2.0, 300.5, 400.0, 250).await.unwrap();
    m.close().await.unwrap();
    assert_eq!(m.client.session_id_pub(), None);
    let seen = stub.seen();
    assert_eq!(seen.len(), 4);
    assert_eq!(
        seen[0],
        req(
            "POST",
            "/session",
            json!({"capabilities": {"alwaysMatch": {
                "platformName": "iOS",
                "appium:automationName": "XCUITest",
                "browserName": "Safari",
                "appium:noReset": true,
                "appium:deviceName": "iPhone 16",
                "appium:platformVersion": "18.5",
                "appium:udid": "UD-1",
            }}})
        )
    );
    assert_eq!(
        seen[1],
        req(
            "POST",
            "/session/AP1/actions",
            json!({"actions": [{
                "type": "pointer", "id": "finger1",
                "parameters": {"pointerType": "touch"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": 10, "y": 20},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pause", "duration": 100},
                    {"type": "pointerUp", "button": 0},
                ]
            }]})
        )
    );
    assert_eq!(
        seen[2],
        req(
            "POST",
            "/session/AP1/actions",
            json!({"actions": [{
                "type": "pointer", "id": "finger1",
                "parameters": {"pointerType": "touch"},
                "actions": [
                    {"type": "pointerMove", "duration": 0, "x": 1, "y": 2},
                    {"type": "pointerDown", "button": 0},
                    {"type": "pointerMove", "duration": 250, "x": 300, "y": 400},
                    {"type": "pointerUp", "button": 0},
                ]
            }]})
        )
    );
    assert_eq!(seen[3], req("DELETE", "/session/AP1", Value::Null));
}

#[cfg(unix)]
#[tokio::test]
async fn appium_launches_npx_with_relaxed_security_then_waits_for_the_port() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("npx");
    let log = dir.path().join("args.log");
    write_exe(
        dir.path(),
        "npx",
        &format!("echo \"$@\" > {}", log.display()),
    );
    env.set("PATH", dir.path().to_str().unwrap());
    if TcpListener::bind(("127.0.0.1", APPIUM_PORT)).is_err() {
        return;
    }
    let late = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(700));
        Stub::start_on(APPIUM_PORT, vec![])
    });
    let m = AppiumManager::connect_or_launch(None).await.unwrap();
    assert_eq!(m.device_udid, None);
    drop(m);
    let _stub = late.join().unwrap();
    assert_eq!(
        std::fs::read_to_string(&log).unwrap().trim(),
        "appium --relaxed-security --port 4723"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn appium_falls_back_to_the_appium_binary_when_npx_is_missing() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("appium");
    let log = dir.path().join("args.log");
    write_exe(
        dir.path(),
        "appium",
        &format!("echo \"$@\" > {}", log.display()),
    );
    env.set("PATH", dir.path().to_str().unwrap());
    if TcpListener::bind(("127.0.0.1", APPIUM_PORT)).is_err() {
        return;
    }
    let late = std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(700));
        Stub::start_on(APPIUM_PORT, vec![])
    });
    let m = AppiumManager::connect_or_launch(Some("U")).await.unwrap();
    assert_eq!(m.device_udid.as_deref(), Some("U"));
    drop(m);
    let _stub = late.join().unwrap();
    assert_eq!(
        std::fs::read_to_string(&log).unwrap().trim(),
        "--relaxed-security --port 4723"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn appium_launch_fails_with_install_hint_when_no_launcher_exists() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("none");
    env.set("PATH", dir.path().to_str().unwrap());
    match TcpListener::bind(("127.0.0.1", APPIUM_PORT)) {
        Ok(l) => drop(l),
        Err(_) => return,
    }
    let err = match AppiumManager::connect_or_launch(None).await {
        Ok(_) => panic!("expected a launch failure"),
        Err(e) => e,
    };
    assert!(
        err.starts_with("Failed to launch Appium. Install it with: npm install -g appium. Error: "),
        "{err}"
    );
}

// ------------------------------------------------------------------- ios

const SIMCTL_JSON: &str = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-5":[
{"name":"iPad Air","udid":"IPAD-1","state":"Shutdown"},
{"name":"iPhone 15","udid":"PH-15","state":"Booted"},
{"name":"iPhone 15 Pro","udid":"PH-15P","state":"Shutdown"},
{"name":"iPhone SE","udid":"PH-SE","state":"Shutdown"}
]}}"#;

const XCTRACE_TXT: &str = "== Devices ==
My Mac (AAAAAAAA-1111-2222-3333-444444444444)
Lewis iPhone (17.5) (00008110-001234560E12345E)
Bad line (nope)

== Simulators ==
iPhone 15 Simulator (17.5) (11111111-2222-3333-4444-555555555555)
";

/// Fake `xcrun`: logs its args, prints `<arg1>-<arg2>.out` / `.err`, exits with `.code`.
#[cfg(unix)]
fn fake_xcrun(env: &EnvGuard, dir: &std::path::Path) {
    let log = dir.join("args.log");
    write_exe(
        dir,
        "xcrun",
        &format!(
            "D={d}\necho \"$*\" >> {l}\nF=\"$D/$1-$2\"\n[ -f \"$F.out\" ] && cat \"$F.out\"\n[ -f \"$F.err\" ] && cat \"$F.err\" >&2\n[ -f \"$F.code\" ] && exit $(cat \"$F.code\")\nexit 0",
            d = dir.display(),
            l = log.display()
        ),
    );
    let old = std::env::var("PATH").unwrap_or_default();
    env.set("PATH", &format!("{}:{}", dir.display(), old));
}

#[cfg(unix)]
fn put(dir: &std::path::Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

#[cfg(unix)]
fn xcrun_args(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("args.log"))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

#[cfg(unix)]
#[test]
fn list_simulators_parses_simctl_json_into_not_real_devices() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("sim");
    put(dir.path(), "simctl-list.out", SIMCTL_JSON);
    fake_xcrun(&env, dir.path());
    let devs = list_simulators().unwrap();
    assert_eq!(xcrun_args(dir.path()), vec!["simctl list devices --json"]);
    assert_eq!(devs.len(), 4);
    let pro = devs.iter().find(|d| d.udid == "PH-15P").unwrap();
    assert_eq!(pro.name, "iPhone 15 Pro");
    assert_eq!(pro.state, "Shutdown");
    assert_eq!(pro.runtime, "com.apple.CoreSimulator.SimRuntime.iOS-17-5");
    assert!(devs.iter().all(|d| !d.is_real));
}

#[cfg(unix)]
#[test]
fn list_simulators_fills_missing_fields_with_empty_strings_and_ignores_non_lists() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("simempty");
    put(
        dir.path(),
        "simctl-list.out",
        r#"{"devices":{"rt":[{}],"other":"x"}}"#,
    );
    fake_xcrun(&env, dir.path());
    let devs = list_simulators().unwrap();
    assert_eq!(devs.len(), 1);
    assert_eq!(
        (
            devs[0].name.as_str(),
            devs[0].udid.as_str(),
            devs[0].state.as_str()
        ),
        ("", "", "")
    );
    put(dir.path(), "simctl-list.out", r#"{"nodevices":1}"#);
    assert!(list_simulators().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn list_simulators_reports_failure_bad_json_and_missing_xcrun() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("simfail");
    put(dir.path(), "simctl-list.code", "1");
    fake_xcrun(&env, dir.path());
    assert_eq!(
        list_simulators().unwrap_err(),
        "xcrun simctl failed. Xcode may not be installed."
    );
    put(dir.path(), "simctl-list.code", "0");
    put(dir.path(), "simctl-list.out", "not json");
    assert!(list_simulators()
        .unwrap_err()
        .starts_with("Failed to parse simctl: "));

    let empty = script_dir("noxcrun");
    env.set("PATH", empty.path().to_str().unwrap());
    assert!(list_simulators()
        .unwrap_err()
        .starts_with("Failed to run xcrun simctl: "));
    assert!(list_real_devices()
        .unwrap_err()
        .starts_with("Failed to run xcrun xctrace: "));
    assert!(boot_simulator("U")
        .unwrap_err()
        .starts_with("Failed to boot simulator: "));
    assert!(shutdown_simulator("U")
        .unwrap_err()
        .starts_with("Failed to shutdown simulator: "));
    assert!(list_all_devices().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn list_real_devices_reads_only_the_devices_section_and_keeps_udid_shaped_lines() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("real");
    put(dir.path(), "xctrace-list.out", XCTRACE_TXT);
    fake_xcrun(&env, dir.path());
    let devs = list_real_devices().unwrap();
    assert_eq!(xcrun_args(dir.path()), vec!["xctrace list devices"]);
    let got: Vec<(&str, &str)> = devs
        .iter()
        .map(|d| (d.name.as_str(), d.udid.as_str()))
        .collect();
    assert_eq!(
        got,
        vec![
            ("My Mac", "AAAAAAAA-1111-2222-3333-444444444444"),
            ("Lewis iPhone", "00008110-001234560E12345E"),
        ]
    );
    assert!(devs
        .iter()
        .all(|d| d.is_real && d.state == "Connected" && d.runtime.is_empty()));
}

#[cfg(unix)]
#[test]
fn list_real_devices_is_empty_when_xctrace_fails() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("realfail");
    put(dir.path(), "xctrace-list.out", XCTRACE_TXT);
    put(dir.path(), "xctrace-list.code", "2");
    fake_xcrun(&env, dir.path());
    assert!(list_real_devices().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn list_all_devices_puts_simulators_before_real_devices_and_survives_a_failing_half() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("all");
    put(dir.path(), "simctl-list.out", SIMCTL_JSON);
    put(dir.path(), "xctrace-list.out", XCTRACE_TXT);
    fake_xcrun(&env, dir.path());
    let all = list_all_devices().unwrap();
    assert_eq!(all.len(), 6);
    assert!(!all[0].is_real && all[5].is_real);
    put(dir.path(), "simctl-list.code", "1");
    let real_only = list_all_devices().unwrap();
    assert_eq!(real_only.len(), 2);
    assert!(real_only.iter().all(|d| d.is_real));
}

#[cfg(unix)]
#[test]
fn select_device_by_udid_or_case_insensitive_name_searches_simulators_and_real_devices() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("sel");
    put(dir.path(), "simctl-list.out", SIMCTL_JSON);
    put(dir.path(), "xctrace-list.out", XCTRACE_TXT);
    fake_xcrun(&env, dir.path());
    assert_eq!(
        select_device(None, Some("PH-SE")).unwrap().name,
        "iPhone SE"
    );
    let real = select_device(None, Some("00008110-001234560E12345E")).unwrap();
    assert!(real.is_real);
    assert_eq!(
        select_device(None, Some("NOPE")).unwrap_err(),
        "Device with UDID 'NOPE' not found"
    );
    assert_eq!(
        select_device(Some("ipad AIR"), None).unwrap().udid,
        "IPAD-1"
    );
    assert_eq!(
        select_device(Some("lewis"), None).unwrap().udid,
        "00008110-001234560E12345E"
    );
    assert_eq!(
        select_device(Some("Pixel"), None).unwrap_err(),
        "Device 'Pixel' not found"
    );
    // UDID wins over a name that would match something else.
    assert_eq!(
        select_device(Some("iPad"), Some("PH-15")).unwrap().name,
        "iPhone 15"
    );
}

#[cfg(unix)]
#[test]
fn select_device_default_prefers_pro_then_last_iphone_then_any_then_errors() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("def");
    put(dir.path(), "simctl-list.out", SIMCTL_JSON);
    fake_xcrun(&env, dir.path());
    assert_eq!(select_device(None, None).unwrap().udid, "PH-15P");

    put(
        dir.path(),
        "simctl-list.out",
        r#"{"devices":{"rt":[{"name":"iPad","udid":"A"},{"name":"iPhone 14","udid":"B"},{"name":"iPhone 15","udid":"C"}]}}"#,
    );
    assert_eq!(select_device(None, None).unwrap().udid, "C");

    put(
        dir.path(),
        "simctl-list.out",
        r#"{"devices":{"rt":[{"name":"iPad","udid":"A"},{"name":"Watch","udid":"W"}]}}"#,
    );
    assert_eq!(select_device(None, None).unwrap().udid, "A");

    put(dir.path(), "simctl-list.out", r#"{"devices":{}}"#);
    assert_eq!(
        select_device(None, None).unwrap_err(),
        "No iOS simulators found"
    );
}

#[cfg(unix)]
#[test]
fn boot_and_shutdown_pass_the_udid_and_treat_already_in_that_state_as_success() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("boot");
    fake_xcrun(&env, dir.path());
    boot_simulator("UD-9").unwrap();
    shutdown_simulator("UD-9").unwrap();
    assert_eq!(
        xcrun_args(dir.path()),
        vec!["simctl boot UD-9", "simctl shutdown UD-9"]
    );

    put(dir.path(), "simctl-boot.code", "149");
    put(
        dir.path(),
        "simctl-boot.err",
        "Unable to boot device in current state: Booted",
    );
    boot_simulator("UD-9").unwrap();
    put(dir.path(), "simctl-shutdown.code", "149");
    put(
        dir.path(),
        "simctl-shutdown.err",
        "Unable to shutdown device in current state: Shutdown",
    );
    shutdown_simulator("UD-9").unwrap();
}

#[cfg(unix)]
#[test]
fn boot_and_shutdown_failures_carry_the_udid_and_stderr() {
    let env = EnvGuard::new(&["PATH"]);
    let dir = script_dir("bootfail");
    fake_xcrun(&env, dir.path());
    put(dir.path(), "simctl-boot.code", "1");
    put(dir.path(), "simctl-boot.err", "Invalid device: UD-2");
    assert_eq!(
        boot_simulator("UD-2").unwrap_err(),
        "Failed to boot simulator UD-2: Invalid device: UD-2"
    );
    put(dir.path(), "simctl-shutdown.code", "1");
    put(dir.path(), "simctl-shutdown.err", "Invalid device: UD-2");
    assert_eq!(
        shutdown_simulator("UD-2").unwrap_err(),
        "Failed to shutdown simulator UD-2: Invalid device: UD-2"
    );
}

#[test]
fn to_device_json_lists_every_field_with_camel_case_is_real() {
    let devs = vec![
        IosDevice {
            name: "A".into(),
            udid: "U1".into(),
            state: "Booted".into(),
            runtime: "R".into(),
            is_real: false,
        },
        IosDevice {
            name: "B".into(),
            udid: "U2".into(),
            state: "Connected".into(),
            runtime: String::new(),
            is_real: true,
        },
    ];
    assert_eq!(
        to_device_json(&devs),
        json!({"devices": [
            {"name": "A", "udid": "U1", "state": "Booted", "runtime": "R", "isReal": false},
            {"name": "B", "udid": "U2", "state": "Connected", "runtime": "", "isReal": true},
        ]})
    );
    assert_eq!(to_device_json(&[]), json!({"devices": []}));
}

// ----------------------------------------------------------------- safari

#[cfg(unix)]
#[test]
fn safaridriver_is_found_through_which_and_launched_with_its_port() {
    let env = EnvGuard::new(&["PATH"]);
    if std::path::Path::new("/usr/bin/safaridriver").exists() {
        return;
    }
    let dir = script_dir("safari");
    let log = dir.path().join("args.log");
    write_exe(
        dir.path(),
        "safaridriver",
        &format!("echo \"$@\" > {}", log.display()),
    );
    write_exe(
        dir.path(),
        "which",
        &format!("echo {}/safaridriver", dir.path().display()),
    );
    let old = std::env::var("PATH").unwrap_or_default();
    env.set("PATH", &format!("{}:{}", dir.path().display(), old));
    assert_eq!(find_safaridriver(), Some(dir.path().join("safaridriver")));
    let proc = launch_safaridriver(4567).unwrap();
    assert_eq!(proc.port, 4567);
    // launch waits 500ms, long enough for the script to have written its args.
    assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "--port 4567");
    drop(proc);
}

#[cfg(unix)]
#[test]
fn safaridriver_is_absent_when_which_fails_or_prints_nothing() {
    let env = EnvGuard::new(&["PATH"]);
    if std::path::Path::new("/usr/bin/safaridriver").exists() {
        return;
    }
    let dir = script_dir("nosafari");
    write_exe(dir.path(), "which", "exit 1");
    let old = std::env::var("PATH").unwrap_or_default();
    env.set("PATH", &format!("{}:{}", dir.path().display(), old));
    assert_eq!(find_safaridriver(), None);
    let err = launch_safaridriver(1).err().unwrap();
    assert_eq!(
        err,
        "safaridriver not found. Safari WebDriver requires macOS with Safari."
    );
    write_exe(dir.path(), "which", "exit 0");
    assert_eq!(find_safaridriver(), None);
}

#[cfg(unix)]
#[test]
fn launch_safaridriver_reports_a_driver_that_cannot_be_spawned() {
    let env = EnvGuard::new(&["PATH"]);
    if std::path::Path::new("/usr/bin/safaridriver").exists() {
        return;
    }
    let dir = script_dir("badsafari");
    write_exe(
        dir.path(),
        "which",
        &format!("echo {}/missing-driver", dir.path().display()),
    );
    let old = std::env::var("PATH").unwrap_or_default();
    env.set("PATH", &format!("{}:{}", dir.path().display(), old));
    let err = launch_safaridriver(1).err().unwrap();
    assert!(err.starts_with("Failed to launch safaridriver: "), "{err}");
}
