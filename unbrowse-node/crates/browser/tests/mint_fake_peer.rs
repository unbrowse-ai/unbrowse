//! A walk against a fake browser: a local websocket that answers the commands a walk sends, so the walk's own steps
//! (attaching to a page, arming it, reading it back, closing its tab) run with no Chrome.
use agent_browser_core::session::{mint, MintOptions, Waits};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// What the fake browser answers a command with.
type Reply = Result<Value, String>;

struct Peer {
    url: String,
    /// Every command the walk sent, in order, as `method` (with `@session` when it named one).
    seen: Arc<Mutex<Vec<String>>>,
}

impl Peer {
    fn count(&self, method: &str) -> usize {
        self.seen.lock().unwrap().iter().filter(|m| m.split('@').next() == Some(method)).count()
    }
    fn saw(&self, method: &str) -> bool {
        self.count(method) > 0
    }
}

/// A fake browser. `answer` is asked for each command (its method and the whole command, with its `params` and
/// `sessionId`); a command it does not care for gets an empty result.
async fn peer(answer: impl Fn(&str, &Value) -> Reply + Send + Sync + 'static) -> Peer {
    peer_saying(move |method, command| (answer(method, command), Vec::new())).await
}

/// A fake browser that also says things (events) after it answers a command.
async fn peer_saying(answer: impl Fn(&str, &Value) -> (Reply, Vec<Value>) + Send + Sync + 'static) -> Peer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let seen: Arc<Mutex<Vec<String>>> = Default::default();
    let log = seen.clone();
    let answer = Arc::new(answer);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (log, answer) = (log.clone(), answer.clone());
            tokio::spawn(async move {
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                while let Some(Ok(Message::Text(text))) = ws.next().await {
                    let Ok(command) = serde_json::from_str::<Value>(&text) else { continue };
                    let method = command["method"].as_str().unwrap_or_default().to_string();
                    let named = match command["sessionId"].as_str() {
                        Some(s) => format!("{method}@{s}"),
                        None => method.clone(),
                    };
                    log.lock().unwrap().push(named);
                    let (reply, events) = answer(&method, &command);
                    let reply = match reply {
                        Ok(result) => json!({ "id": command["id"], "result": result }),
                        Err(message) => json!({ "id": command["id"], "error": { "code": -32000, "message": message } }),
                    };
                    if ws.send(Message::Text(reply.to_string())).await.is_err() {
                        return;
                    }
                    for mut event in events {
                        if event.get("hang_up").is_some() {
                            return;
                        }
                        if event.get("sessionId").is_none() {
                            if let Some(s) = command["sessionId"].as_str() {
                                event["sessionId"] = json!(s);
                            }
                        }
                        if ws.send(Message::Text(event.to_string())).await.is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    Peer { url, seen }
}

fn quick(url: &str, endpoint: &str) -> MintOptions {
    MintOptions {
        url: url.into(),
        session: "fake".into(),
        cdp_endpoint: Some(endpoint.into()),
        settle_ms: 0,
        waits: Waits {
            least_settle: Duration::from_millis(50),
            door: Duration::from_millis(50),
            asking: Duration::ZERO,
            scripts: Duration::ZERO,
            in_flight: Duration::ZERO,
        },
        ..Default::default()
    }
}

/// A tiny HTTP server answering every request with `body`.
async fn http(body: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf).await;
                let _ = stream
                    .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
                    .await;
            });
        }
    });
    format!("http://{address}")
}

#[tokio::test]
async fn an_endpoint_that_names_no_browser_websocket_ends_the_walk_there() {
    let endpoint = http(r#"{"Browser":"nothing to attach to"}"#).await;
    let error = mint(quick("http://127.0.0.1:1/", &endpoint)).await.unwrap_err();
    assert_eq!(error, "cdp endpoint has no webSocketDebuggerUrl");
}

#[tokio::test]
async fn an_endpoint_nobody_answers_at_ends_the_walk_with_the_connection_error() {
    let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let error = mint(quick("http://127.0.0.1:1/", &format!("http://{closed}/"))).await.unwrap_err();
    assert!(error.starts_with("cdp endpoint: "), "{error}");
}

#[tokio::test]
async fn an_http_endpoint_is_asked_for_its_browser_websocket_and_the_walk_goes_on_there() {
    let fake = peer(|method, _| match method {
        "Target.createTarget" => Err("no new tabs here".into()),
        "Target.getTargets" => Ok(json!({ "targetInfos": [{ "type": "page", "targetId": "T1" }] })),
        "Target.attachToTarget" => Ok(json!({ "sessionId": "S1" })),
        "Network.enable" => Err("the network is off".into()),
        _ => Ok(json!({})),
    })
    .await;
    let endpoint = http(Box::leak(format!(r#"{{"webSocketDebuggerUrl":"{}"}}"#, fake.url).into_boxed_str())).await;
    let error = mint(quick("http://127.0.0.1:1/", &endpoint)).await.unwrap_err();
    assert!(error.contains("the network is off"), "{error}");
    assert!(fake.seen.lock().unwrap().contains(&"Network.enable@S1".to_string()), "the walk armed the page it attached to: {:?}", fake.seen.lock().unwrap());
    assert!(!fake.saw("Target.closeTarget"), "no tab of its own was opened, so none is closed");
}

#[tokio::test]
async fn a_browser_with_no_page_to_attach_to_is_asked_again_and_then_given_up_on() {
    let fake = peer(|method, _| match method {
        "Target.createTarget" => Err("no new tabs here".into()),
        "Target.getTargets" => Ok(json!({ "targetInfos": [{ "type": "service_worker", "targetId": "W" }] })),
        _ => Ok(json!({})),
    })
    .await;
    let error = mint(quick("http://127.0.0.1:1/", &fake.url)).await.unwrap_err();
    assert_eq!(error, "no attachable page target");
    assert_eq!(fake.count("Target.getTargets"), 5, "five looks before it gives up");
}


/// The page's state as a walk's own script asks for it, and what else a walk reads back from a page.
fn page_reads(command: &Value, state: &str) -> Reply {
    let expression = command["params"]["expression"].as_str().unwrap_or_default();
    let said = |value: Value| Ok(json!({ "result": { "value": value.to_string() } }));
    if expression.contains("main-frame-error") {
        Ok(json!({ "result": { "value": state } }))
    } else if expression.contains("localStorage") {
        said(json!({ "local": { "k": "v" }, "session": { "s": "1" } }))
    } else if expression.contains("__unbrowse_fp") {
        said(json!({ "ua": "Mozilla/5.0", "canvas": [] }))
    } else if expression.contains("__ub_sign") {
        said(json!([["x-sign", "sig-1", "https://shop.example/api", "a;b", ""]]))
    } else {
        Ok(json!({}))
    }
}

fn loads_the_shop_page() -> Vec<Value> {
    vec![
        json!({ "method": "Network.requestWillBeSent", "params": { "requestId": "r1", "frameId": "F1", "type": "Document",
            "request": { "url": "https://shop.example/", "method": "GET", "headers": { "X-CSRF-Token": "tok-1", "X-Other": 1 } } } }),
        json!({ "method": "Network.responseReceived", "params": { "requestId": "r1", "type": "Document",
            "response": { "url": "https://shop.example/", "status": 200, "mimeType": "text/html", "headers": {} } } }),
        json!({ "method": "Network.loadingFinished", "params": { "requestId": "r1" } }),
    ]
}

/// A fake browser whose one page loads `https://shop.example/` and lets the walk read it. `state` is what the page
/// says of itself (`ready`, `challenge`, `refused`); `events` is what the browser says as the walk navigates.
async fn a_page_that(state: &'static str, events: Vec<Value>) -> Peer {
    peer_saying(move |method, command| browser_says(state, &events, method, command)).await
}

/// What a browser showing the shop page answers to a command, and says after it.
fn browser_says(state: &str, events: &[Value], method: &str, command: &Value) -> (Reply, Vec<Value>) {
    let nothing = Vec::new;
    match method {
        "Target.createTarget" => (Ok(json!({ "targetId": "T1" })), nothing()),
        "Target.attachToTarget" => (Ok(json!({ "sessionId": "S1" })), nothing()),
        "Target.getTargetInfo" => (Ok(json!({ "targetInfo": { "targetId": "T1" } })), nothing()),
        "Browser.getVersion" => (Ok(json!({ "userAgent": "Mozilla/5.0 Chrome/150.0.0.0" })), nothing()),
        "Network.getAllCookies" => (
            Ok(json!({ "cookies": [
                { "name": "sid", "value": "abc", "domain": ".shop.example" },
                { "name": "host", "value": "h", "domain": "shop.example" },
                { "name": "elsewhere", "value": "x", "domain": "tracker.example" },
            ] })),
            nothing(),
        ),
        "Page.navigate" => (Ok(json!({ "frameId": "F1" })), events.to_vec()),
        "Network.getResponseBody" => (Ok(json!({ "body": "<html><body>shop</body></html>", "base64Encoded": false })), nothing()),
        "Debugger.getScriptSource" => (Ok(json!({ "scriptSource": "var a = 1;" })), nothing()),
        "Page.getFrameTree" => (
            Ok(json!({ "frameTree": { "frame": { "id": "F1", "url": "https://shop.example/", "securityOrigin": "https://shop.example" },
                "childFrames": [{ "frame": { "id": "FF", "url": "https://shop.example/frame", "securityOrigin": "https://shop.example" } }] } })),
            nothing(),
        ),
        "Storage.getStorageKeyForFrame" => (Ok(json!({ "storageKey": "key" })), nothing()),
        "DOMStorage.getDOMStorageItems" => (Ok(json!({ "entries": [["a", "b"], ["n", 1]] })), nothing()),
        "Page.enable" if command["sessionId"] == "NOFR" => (Err("no such domain here".into()), nothing()),
        "Runtime.evaluate" => (page_reads(command, state), nothing()),
        _ => (Ok(json!({})), nothing()),
    }
}

/// The fake browser as a process: a walk that launches a browser launches this test binary again, which speaks the
/// debugger's pipe (fd 3 in, fd 4 out, one JSON message and a NUL at a time) as the shop page's browser would, and
/// goes when told to close. Run as an ordinary test it has nothing to serve and passes at once.
#[cfg(unix)]
#[test]
fn a_fake_browser_process_serves_its_pipe_only_when_it_was_launched_as_one() {
    use std::io::{BufRead, Write};
    use std::os::fd::FromRawFd;
    let Ok(state) = std::env::var("FAKE_CHROME_STATE") else { return };
    // SAFETY: the walk's launch hands this process its debugger's pipe as descriptors 3 and 4, and nothing else holds them.
    let (input, mut output) = unsafe { (std::fs::File::from_raw_fd(3), std::fs::File::from_raw_fd(4)) };
    let mut input = std::io::BufReader::new(input);
    let mut message = Vec::new();
    loop {
        message.clear();
        if input.read_until(0, &mut message).unwrap_or(0) == 0 {
            return;
        }
        message.pop();
        let Ok(command) = serde_json::from_slice::<Value>(&message) else { continue };
        let method = command["method"].as_str().unwrap_or_default().to_string();
        let (reply, events) = match method.as_str() {
            "Target.attachToBrowserTarget" => (Ok(json!({ "sessionId": "B-fake" })), Vec::new()),
            _ => browser_says(&state, &loads_the_shop_page(), &method, &command),
        };
        let mut reply = match reply {
            Ok(result) => json!({ "id": command["id"], "result": result }),
            Err(message) => json!({ "id": command["id"], "error": { "code": -32000, "message": message } }),
        };
        if let Some(session) = command.get("sessionId") {
            reply["sessionId"] = session.clone();
        }
        // The browser announces a page it attached a client to, before it answers.
        let mut said = Vec::new();
        if method == "Target.attachToTarget" {
            said.push(json!({ "method": "Target.attachedToTarget", "sessionId": command["sessionId"], "params": { "sessionId": "S1", "targetInfo": { "type": "page", "url": "about:blank" } } }));
        }
        said.push(reply);
        for mut event in events {
            if event.get("sessionId").is_none() {
                if let Some(session) = command["sessionId"].as_str() {
                    event["sessionId"] = json!(session);
                }
            }
            said.push(event);
        }
        for line in said {
            let _ = output.write_all(line.to_string().as_bytes());
            let _ = output.write_all(&[0]);
        }
        let _ = output.flush();
        if method == "Browser.close" {
            std::process::exit(0);
        }
    }
}

/// A browser to launch: a script that becomes this binary's fake browser showing the page in `state`.
#[cfg(unix)]
fn fake_browser(dir: &std::path::Path, state: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("fake-browser");
    let exe = std::env::current_exe().unwrap();
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nFAKE_CHROME_STATE={state} exec {} --exact a_fake_browser_process_serves_its_pipe_only_when_it_was_launched_as_one --nocapture --test-threads=1 >/dev/null 2>&1\n",
            exe.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}

fn with_capture(url: &str, endpoint: &str) -> (MintOptions, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut options = quick(url, endpoint);
    options.capture_dir = Some(dir.path().to_path_buf());
    (options, dir)
}

fn lines(dir: &tempfile::TempDir) -> Vec<Value> {
    agent_browser_core::session::read_capture(&agent_browser_core::session::capture_path(dir.path(), "fake"))
}

#[tokio::test]
async fn a_walk_hands_back_the_session_the_page_was_given_and_closes_its_own_tab() {
    let fake = a_page_that("ready", loads_the_shop_page()).await;
    let (options, dir) = with_capture("https://shop.example/", &fake.url);
    let session = mint(options).await.unwrap();

    // A domain cookie and a host-only one reach the walked host; another site's stays behind.
    assert_eq!(session.cookies.get("sid").map(String::as_str), Some("abc"));
    assert_eq!(session.cookies.get("host").map(String::as_str), Some("h"));
    assert_eq!(session.cookies.get("elsewhere"), None);
    assert_eq!(session.domains.get("sid").map(String::as_str), Some(".shop.example"));
    assert_eq!(session.domains.get("host"), None, "a host-only cookie has no domain to say");
    assert_eq!(session.tokens.get("x-csrf-token").map(String::as_str), Some("tok-1"));
    assert_eq!(session.local_storage.get("k").map(String::as_str), Some("v"));
    assert_eq!(session.session_storage.get("s").map(String::as_str), Some("1"));
    assert_eq!(session.fingerprint.as_ref().and_then(|f| f["ua"].as_str()), Some("Mozilla/5.0"));
    assert!(fake.saw("Target.closeTarget"), "a tab the walk opened in someone's browser closes with the walk");

    let log = lines(&dir);
    let kinds: Vec<&str> = log.iter().filter_map(|l| l["type"].as_str()).collect();
    assert_eq!(kinds.first(), Some(&"mint"));
    for kind in ["request", "response", "address", "addresses_end", "origin_storage"] {
        assert!(kinds.contains(&kind), "{kind} missing from {kinds:?}");
    }
    let response = log.iter().find(|l| l["type"] == "response").unwrap();
    assert_eq!(response["body"], "<html><body>shop</body></html>");
}

#[tokio::test]
async fn a_walk_records_what_a_busy_page_does_in_its_frames_workers_and_scripts() {
    let mut events = loads_the_shop_page();
    events.extend([
        // A target the walk's own code opened at the browser's root: never part of the page's record.
        json!({ "method": "Target.attachedToTarget", "sessionId": null, "params": { "sessionId": "OWN", "targetInfo": { "type": "page", "url": "about:blank" } } }),
        // An iframe whose moves can be recorded, one whose can't, and a worker.
        json!({ "method": "Target.attachedToTarget", "params": { "sessionId": "FR", "targetInfo": { "type": "iframe", "url": "https://shop.example/frame" } } }),
        json!({ "method": "Target.attachedToTarget", "params": { "sessionId": "NOFR", "targetInfo": { "type": "iframe", "url": "https://other.example/" } } }),
        json!({ "method": "Target.attachedToTarget", "params": { "sessionId": "WK", "targetInfo": { "type": "worker", "url": "https://shop.example/w.js" } } }),
        json!({ "method": "Debugger.scriptParsed", "params": { "scriptId": "1", "url": "https://shop.example/app.js" } }),
        json!({ "method": "Debugger.scriptParsed", "params": { "scriptId": "2", "url": "https://shop.example/again.js" } }),
        json!({ "method": "Page.frameNavigated", "params": { "frame": { "id": "F1", "url": "https://shop.example/next", "urlFragment": "#top" } } }),
        json!({ "method": "Page.navigatedWithinDocument", "params": { "frameId": "F1", "url": "https://shop.example/next#more" } }),
        json!({ "method": "Network.requestWillBeSentExtraInfo", "params": { "requestId": "r1", "headers": { "cookie": "sid=abc" } } }),
        json!({ "method": "Network.requestWillBeSent", "params": { "requestId": "r2", "frameId": "F1", "type": "Fetch",
            "request": { "url": "https://shop.example/api", "method": "POST", "headers": {}, "postData": "a=1" } } }),
        json!({ "method": "Network.responseReceived", "params": { "requestId": "r2", "type": "Fetch",
            "response": { "url": "https://shop.example/api", "status": 500, "mimeType": "application/json", "headers": {} } } }),
        json!({ "method": "Network.loadingFailed", "params": { "requestId": "r2" } }),
        json!({ "method": "Network.requestWillBeSent", "params": { "requestId": "r3", "frameId": "F1", "type": "Fetch",
            "request": { "url": "https://shop.example/slow", "method": "GET", "headers": {} } } }),
        json!({ "method": "Network.responseReceived", "params": { "requestId": "r3", "type": "Fetch",
            "response": { "url": "https://shop.example/slow", "status": 200, "mimeType": "application/json", "headers": {} } } }),
    ]);
    let fake = a_page_that("ready", events).await;
    let (options, dir) = with_capture("https://shop.example/", &fake.url);
    mint(options).await.unwrap();

    let log = lines(&dir);
    let of = |kind: &str| log.iter().filter(|l| l["type"] == kind).collect::<Vec<_>>();
    assert!(!log.iter().any(|l| l["session"] == "OWN"), "the walk's own target is no part of the page");
    let targets: Vec<(&str, &str)> = of("target").iter().map(|l| (l["session"].as_str().unwrap(), l["kind"].as_str().unwrap())).collect();
    assert_eq!(targets, [("FR", "iframe"), ("NOFR", "iframe"), ("WK", "worker")]);
    assert_eq!(of("address_off").len(), 1, "a frame that can't be asked is said to be so");
    assert_eq!(of("address_off")[0]["session"], "NOFR");
    assert!(of("address").iter().any(|l| l["session"] == "FR"), "the asked frame's own address is read");
    let addresses: Vec<&str> = of("address").iter().filter_map(|l| l["url"].as_str()).collect();
    assert!(addresses.contains(&"https://shop.example/next#top") && addresses.contains(&"https://shop.example/next#more"), "{addresses:?}");
    let scripts = of("script");
    assert_eq!(scripts.len(), 2);
    assert_eq!(scripts[0]["source"], "var a = 1;");
    assert_eq!(scripts[1].get("source"), None, "a body is kept once per hash");
    assert_eq!(scripts[0]["sha256"], scripts[1]["sha256"]);
    assert_eq!(of("request_extra")[0]["headers"]["cookie"], "sid=abc");
    let post = of("request").into_iter().find(|l| l["requestId"] == "r2").unwrap();
    assert_eq!(post["postData"], "a=1");
    // The call that failed is paired with no body; the one still loading when the walk ended is read at its end.
    let answers: Vec<(&str, &str)> = of("response").iter().map(|l| (l["requestId"].as_str().unwrap(), l["body"].as_str().unwrap_or("-"))).collect();
    assert!(answers.contains(&("r3", "<html><body>shop</body></html>")), "{answers:?}");
    assert!(of("addresses_end")[0]["written"].as_u64().unwrap() >= 5);
}

#[tokio::test]
async fn a_page_that_is_a_door_or_a_refusal_is_no_session_and_an_attached_browser_is_left_as_it_was() {
    for (state, why) in [
        ("challenge", "attached browser left open for verification"),
        ("refused", "the walk's tab is closed: it had nothing on it for a person to do"),
    ] {
        let fake = a_page_that(state, loads_the_shop_page()).await;
        let (options, _dir) = with_capture("https://shop.example/", &fake.url);
        let error = mint(options).await.unwrap_err();
        assert_eq!(error, format!("mint unresolved ({state}); {why}"));
        // A door left for a person keeps its tab; a refusal has nothing on it to show.
        assert_eq!(fake.saw("Target.closeTarget"), state == "refused", "{state}");
    }
}

#[tokio::test]
async fn a_walk_that_asked_for_interception_the_browser_refuses_opens_no_page() {
    let fake = peer(|method, _| match method {
        "Target.createTarget" => Ok(json!({ "targetId": "T1" })),
        "Target.attachToTarget" => Ok(json!({ "sessionId": "S1" })),
        "Fetch.enable" => Err("not allowed".into()),
        _ => Ok(json!({})),
    })
    .await;
    let mut options = quick("https://shop.example/", &fake.url);
    options.intercept = true;
    let error = mint(options).await.unwrap_err();
    assert_eq!(error, "interception was asked for and the browser refused it (Fetch.enable: CDP error (Fetch.enable): not allowed); the page wasn't opened");
    assert!(!fake.saw("Page.navigate"), "the page was never opened");
}

#[tokio::test]
async fn a_browser_that_refuses_the_walks_extras_still_walks_the_page() {
    let fake = peer(|method, command| match method {
        "Target.createTarget" => Ok(json!({ "targetId": "T1" })),
        "Target.attachToTarget" => Ok(json!({ "sessionId": "S1" })),
        "Target.setAutoAttach" | "Page.addScriptToEvaluateOnNewDocument" | "Network.setCookies" | "Emulation.setDeviceMetricsOverride" => Err("not here".into()),
        "Browser.getVersion" => Err("no version".into()),
        "Network.getAllCookies" => Ok(json!({ "cookies": [{ "name": "k", "value": "v", "domain": "shop.example" }] })),
        "Runtime.evaluate" => page_reads(command, "ready"),
        _ => Ok(json!({})),
    })
    .await;
    let mut options = quick("https://shop.example/", &fake.url);
    options.cookies = vec![agent_browser_core::session::SeedCookie { name: "seed".into(), value: "1".into(), domain: None, path: None, http_only: None }];
    let session = mint(options).await.unwrap();
    assert_eq!(session.cookies.get("k").map(String::as_str), Some("v"));
    assert!(fake.saw("Network.setCookies"), "the caller's session was offered to the page first");
    assert!(fake.saw("Page.navigate"));
}

#[tokio::test]
async fn a_walk_in_a_page_that_signs_keeps_what_its_code_built_and_the_cookies_its_log_saw_set() {
    // Alone in this binary to set it: every walk here reads it as it starts.
    std::env::set_var("UNBROWSE_SIGN_PROBE", "1");
    let fake = a_page_that("ready", loads_the_shop_page()).await;
    let (options, dir) = with_capture("https://shop.example/", &fake.url);
    // A reply the node's own capture kept: a cookie set for the whole site, one with no attributes at all, and a header
    // with no value that sets none.
    let earlier = [
        json!({ "type": "exchange", "entry": { "response": { "headers": [
            { "name": "set-cookie", "value": "late=1; Domain=.shop.example; Path=/" },
            { "name": "set-cookie", "value": "no-equals-sign; Path=/" },
            { "name": "set-cookie", "value": "bare=2" },
            { "name": "content-type", "value": "text/html" },
        ] } } }),
        json!({ "type": "exchange", "entry": { "response": {} } }),
    ];
    let text: String = earlier.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(agent_browser_core::session::capture_path(dir.path(), "fake"), text).unwrap();
    let session = mint(options).await.unwrap();
    std::env::remove_var("UNBROWSE_SIGN_PROBE");

    assert_eq!(session.cookies.get("late").map(String::as_str), Some("1"));
    assert_eq!(session.domains.get("late").map(String::as_str), Some(".shop.example"));
    assert_eq!(session.cookies.get("bare").map(String::as_str), Some("2"), "a cookie with no attributes is a cookie");
    assert!(!session.domains.contains_key("bare"), "and it names no domain");
    let log = lines(&dir);
    let probe = log.iter().find(|l| l["type"] == "sign_probe").expect("the page's signing is in the record");
    assert_eq!(probe["probes"][0][0], "x-sign");
    assert!(fake.seen.lock().unwrap().iter().filter(|m| m.starts_with("Page.addScriptToEvaluateOnNewDocument")).count() >= 2, "the signing probe is installed beside the fingerprint's");
}

#[tokio::test]
async fn a_browser_that_goes_away_mid_walk_leaves_a_record_that_says_it_was_cut_off() {
    let mut events = loads_the_shop_page();
    events.push(json!({ "hang_up": true }));
    let fake = a_page_that("ready", events).await;
    let (options, dir) = with_capture("https://shop.example/", &fake.url);
    let _ = mint(options).await;
    let log = lines(&dir);
    let end = log.iter().find(|l| l["type"] == "addresses_end").expect("the record still closes");
    assert_eq!(end["cut_off"], true);
}

#[tokio::test]
async fn a_walk_that_browses_nudges_a_quiet_page_and_stops_when_it_has_no_more_to_give() {
    let fake = a_page_that("ready", loads_the_shop_page()).await;
    let (mut options, dir) = with_capture("https://shop.example/", &fake.url);
    options.browse = true;
    options.settle_ms = 8_000;
    options.try_controls = true;
    mint(options).await.unwrap();
    let log = lines(&dir);
    let nudge = log.iter().find(|l| l["type"] == "nudge").expect("a quiet page was nudged");
    assert_eq!(nudge["did"], "nothing: the page did not answer");
    assert!(log.iter().any(|l| l["type"] == "walk_end"), "{:?}", log.iter().filter_map(|l| l["type"].as_str()).collect::<Vec<_>>());
}

#[tokio::test]
async fn a_walk_whose_caller_gave_up_ends_at_its_next_look() {
    let fake = a_page_that("ready", loads_the_shop_page()).await;
    let (mut options, _dir) = with_capture("https://shop.example/", &fake.url);
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    options.stop = Some(stop.clone());
    options.settle_ms = 60_000;
    options.waits.least_settle = Duration::from_secs(60);
    let walk = tokio::spawn(mint(options));
    tokio::time::sleep(Duration::from_millis(400)).await;
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let walked = tokio::time::timeout(Duration::from_secs(5), walk).await.expect("the walk went on after it was stopped").unwrap();
    assert_eq!(walked.err().as_deref(), Some(agent_browser_core::session::STOPPED));
}

#[cfg(unix)]
#[tokio::test]
async fn a_walk_that_launches_its_browser_closes_it_through_the_browser_and_moves_a_clean_profile_into_place() {
    let dir = tempfile::tempdir().unwrap();
    let remembered = dir.path().join("site.example");
    let clean = dir.path().join("clean");
    std::fs::create_dir_all(&remembered).unwrap();
    std::fs::write(remembered.join("marker"), "refused").unwrap();
    std::fs::create_dir_all(&clean).unwrap();
    std::fs::write(clean.join("marker"), "accepted").unwrap();
    let options = MintOptions {
        url: "https://shop.example/".into(),
        session: "launched".into(),
        executable_path: Some(fake_browser(dir.path(), "ready")),
        profile: Some(clean.to_string_lossy().into_owned()),
        adopt: Some(remembered.to_string_lossy().into_owned()),
        settle_ms: 0,
        waits: quick("", "").waits,
        ..Default::default()
    };
    let session = mint(options).await.unwrap();
    assert_eq!(session.cookies.get("sid").map(String::as_str), Some("abc"));
    // What the site accepted took the refused profile's place; the refused one was set aside, not deleted.
    assert_eq!(std::fs::read_to_string(remembered.join("marker")).unwrap(), "accepted");
    assert!(!clean.exists());
}

/// A walk of the shop in a launched browser that shows `state`, in `profile` (no window unless `headed`).
#[cfg(unix)]
fn launched(dir: &std::path::Path, state: &str, headed: bool) -> MintOptions {
    let profile = dir.join("site.example");
    std::fs::create_dir_all(&profile).unwrap();
    MintOptions {
        url: "https://shop.example/".into(),
        session: "launched".into(),
        executable_path: Some(fake_browser(dir, state)),
        profile: Some(profile.to_string_lossy().into_owned()),
        headed,
        windowless: true,
        settle_ms: 0,
        waits: quick("", "").waits,
        ..Default::default()
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_profile_the_site_refused_is_asked_again_in_a_clean_browser_that_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let error = mint(launched(dir.path(), "refused", false)).await.unwrap_err();
    assert_eq!(error, "mint unresolved (refused); the browser is closed: only a window could ask again, and the owner keeps windows off");
    let mut left: Vec<String> = std::fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    assert_eq!(left, ["fake-browser", "site.example"], "the clean browser's profile went with the question");
}

#[cfg(unix)]
#[tokio::test]
async fn a_door_in_a_window_is_left_open_for_a_person_until_the_browser_goes() {
    let dir = tempfile::tempdir().unwrap();
    let error = mint(launched(dir.path(), "challenge", true)).await.unwrap_err();
    let endpoint = error.strip_prefix("mint unresolved (challenge); browser left open for verification; reconnect at ").expect(&error);
    // The person's window is still there to be reached, and is theirs to close.
    let person = agent_browser_core::cdp::client::CdpClient::connect(endpoint).await.expect("the browser is left open");
    person.send_command_no_params("Browser.getVersion", None).await.unwrap();
    let _ = person.send_command_no_params("Browser.close", None).await;
    person.close().await;
    // Its watcher sees the browser gone and lets its place go: a window for the same site is admitted again.
    let other = tempfile::tempdir().unwrap();
    let until = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let again = mint(launched(other.path(), "challenge", true)).await.unwrap_err();
        if again.contains("browser left open for verification") {
            break;
        }
        assert!(again.contains("a window is already open for a person at this site"), "{again}");
        assert!(std::time::Instant::now() < until, "the closed window never gave up its place");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
