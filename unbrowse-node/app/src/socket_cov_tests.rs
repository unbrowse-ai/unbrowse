//! UNB-208 tranche 2B step 9 (owner b): tests for socket.rs against a websocket the test starts on 127.0.0.1.

use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

/// What the local socket saw, and how it behaves.
#[derive(Default, Clone)]
struct Seen {
    headers: Arc<Mutex<Vec<(String, String)>>>,
    frames: Arc<Mutex<Vec<String>>>,
}

/// A websocket on 127.0.0.1 serving one connection: `greeting` first when set, then for each frame it reads the
/// frames `reply` returns for it; it hangs up after the `hang_up_after`th frame when set (else when the client does).
fn socket(greeting: Option<&str>, reply: impl Fn(&str) -> Vec<String> + Send + 'static, hang_up_after: Option<usize>) -> (u16, Seen) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Seen::default();
    let kept = seen.clone();
    let greeting = greeting.map(String::from);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            let Ok((tcp, _)) = listener.accept().await else { return };
            let headers = kept.headers.clone();
            let handshake = move |req: &Request, res: Response| {
                *headers.lock().unwrap() = req.headers().iter().map(|(k, v)| (k.to_string(), v.to_str().unwrap_or_default().to_string())).collect();
                Ok(res)
            };
            let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(tcp, handshake).await else { return };
            if let Some(g) = greeting {
                let _ = ws.send(Message::Text(g)).await;
            }
            let mut n = 0;
            while let Some(Ok(m)) = ws.next().await {
                if let Message::Text(t) = m {
                    n += 1;
                    kept.frames.lock().unwrap().push(t.to_string());
                    for r in reply(&t) {
                        let _ = ws.send(Message::Text(r)).await;
                    }
                    if hang_up_after == Some(n) {
                        let _ = ws.close(None).await;
                        return;
                    }
                }
            }
        });
    });
    (port, seen)
}

fn route_at(port: u16, frame: Vec<Piece>, opening: &[&str], server_first: bool) -> SocketRoute {
    SocketRoute { url: format!("ws://127.0.0.1:{port}/ws"), headers: vec![], opening: opening.iter().map(|s| s.to_string()).collect(), frame, server_first }
}

fn text(t: &str) -> Piece {
    Piece::Text { text: t.into() }
}

fn input(n: &str) -> Piece {
    Piece::Input { name: n.into() }
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
}

fn route(socket: Option<SocketRoute>, write: bool, root: &str) -> Route {
    serde_json::from_value(json!({
        "id": "r1", "site": "127.0.0.1", "what": "say", "method": "GET", "path": "/", "root": root,
        "inputs": [], "steps": 1, "browser_assisted": false, "write": write, "provisional": false, "learned_at": 0,
        "graph": { "steps": [], "provisional": false },
        "socket": socket.map(|s| serde_json::to_value(s).unwrap())
    }))
    .unwrap()
}

fn values(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// A caller's value sits in the frame as it would inside a JSON string: quotes and newlines escaped, never loose.
#[test]
fn a_callers_value_rides_the_frame_escaped_for_a_json_string() {
    let s = route_at(1, vec![text("{\"q\":\""), input("q"), text("\"}")], &[], false);
    let out = frame_of(&s, &values(&[("q", "say \"hi\"\nnow")])).unwrap();
    assert_eq!(out, "{\"q\":\"say \\\"hi\\\"\\nnow\"}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["q"], "say \"hi\"\nnow");
}

/// A frame whose value the caller left out is not sent with a hole in it: the call says which value is missing.
#[test]
fn a_frame_missing_a_value_names_it() {
    let s = route_at(1, vec![text("MESG"), input("channel")], &[], false);
    assert_eq!(frame_of(&s, &HashMap::new()).unwrap_err(), "the route needs a value for channel");
}

/// A frame's answer is its JSON after the kind word; one that is no JSON comes back as its text.
#[test]
fn an_answer_is_the_json_after_the_kind_else_the_text() {
    assert_eq!(answer("MESG {\"a\":1}", "MESG"), json!({"a": 1}));
    assert_eq!(answer("{\"a\":2}", ""), json!({"a": 2}));
    assert_eq!(answer("pong", "MESG"), json!("pong"));
}

/// A socket answering with a frame of the sent frame's kind is answered with that frame's JSON, and the call
/// carried the opening frames first, then the frame.
#[test]
fn a_frame_is_answered_by_the_frame_of_its_kind() {
    store::scratch_home("socket-kind");
    let (port, seen) = socket(None, |f| if f.starts_with("MESG") { vec!["PONG {}".into(), "MESG {\"ok\":true}".into()] } else { vec![] }, None);
    let s = route_at(port, vec![text("MESG {\"to\":\""), input("to"), text("\"}")], &["LOGI {}"], false);
    let got = rt().block_on(speak(&s, "MESG {\"to\":\"bob\"}", &["bob".into()])).ok().unwrap();
    assert_eq!(got, json!({"ok": true}));
    assert_eq!(*seen.frames.lock().unwrap(), vec!["LOGI {}".to_string(), "MESG {\"to\":\"bob\"}".to_string()]);
}

/// The headers the page chose go out on the handshake, and the owner's jar rides it too (the socket is to this
/// machine, so it may carry the cookies).
#[test]
fn the_handshake_carries_the_pages_headers_and_the_jar() {
    store::scratch_home("socket-headers");
    let jar = std::collections::BTreeMap::from([("sid".to_string(), "abc".to_string())]);
    store::write_json(&store::jar_path("127.0.0.1"), &unbrowse_files::JAR, &jar).unwrap();
    let (port, seen) = socket(None, |_| vec!["{\"done\":1}".into()], None);
    let mut s = route_at(port, vec![text("go")], &[], false);
    s.headers = vec![("x-page-chose".into(), "yes".into()), ("bad header name".into(), "no".into())];
    let got = rt().block_on(speak(&s, "{\"nothing\":1}", &[])).ok().unwrap();
    assert_eq!(got, json!({"done": 1}));
    let headers = seen.headers.lock().unwrap().clone();
    assert!(headers.contains(&("x-page-chose".to_string(), "yes".to_string())), "{headers:?}");
    assert!(headers.contains(&("cookie".to_string(), "sid=abc".to_string())), "{headers:?}");
    assert!(!headers.iter().any(|(k, _)| k.contains("bad")), "{headers:?}");
}

/// A frame that names what the caller sent is the answer, even when the frame's kind isn't the sent frame's.
#[test]
fn a_frame_naming_what_was_sent_is_the_answer() {
    store::scratch_home("socket-names");
    let (port, _) = socket(None, |_| vec!["{\"noise\":1}".into(), "{\"echo\":\"zebra-quartz\"}".into()], None);
    let s = route_at(port, vec![text("{\"q\":\"zebra-quartz\"}")], &[], false);
    let got = rt().block_on(speak(&s, "{\"q\":\"zebra-quartz\"}", &["zebra-quartz".into()])).ok().unwrap();
    assert_eq!(got, json!({"echo": "zebra-quartz"}));
}

/// With nothing plainly the answer, the first frame back that isn't the echo of an opening frame is it.
#[test]
fn the_first_frame_that_is_no_echo_of_an_opening_frame_answers() {
    store::scratch_home("socket-first");
    let (port, _) = socket(None, |f| if f == "HELLO" { vec!["HELLO".into()] } else { vec!["{\"first\":1}".into(), "{\"second\":2}".into()] }, None);
    let s = route_at(port, vec![text("{}")], &["HELLO"], false);
    let got = rt().block_on(speak(&s, "{\"x\":1}", &[])).ok().unwrap();
    assert_eq!(got, json!({"first": 1}));
}

/// A socket that takes the frame and hangs up answers nothing; the error says the frame went out, so it is not
/// sent again.
#[test]
fn a_socket_that_takes_the_frame_and_says_nothing_has_sent_it() {
    store::scratch_home("socket-silent");
    let (port, _) = socket(None, |_| vec![], Some(1));
    let s = route_at(port, vec![text("{}")], &[], false);
    let err = rt().block_on(speak(&s, "{\"x\":1}", &[])).err().unwrap();
    assert!(err.sent);
    assert_eq!(err.why, "the socket took the frame but said nothing back");
}

/// A site that greets first and then hangs up before the frame leaves nothing sent; one that greets is waited for.
#[test]
fn a_socket_that_closes_as_it_opens_has_been_sent_nothing() {
    store::scratch_home("socket-closes");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async move {
            let (tcp, _) = listener.accept().unwrap();
            tcp.set_nonblocking(true).unwrap();
            let mut ws = tokio_tungstenite::accept_async(tokio::net::TcpStream::from_std(tcp).unwrap()).await.unwrap();
            let _ = ws.close(None).await;
            let _ = ws.next().await;
        });
    });
    let s = route_at(port, vec![text("{}")], &[], true);
    let err = rt().block_on(speak(&s, "{}", &[])).err().unwrap();
    assert!(!err.sent);
    assert!(err.why.contains("closed as it opened") || err.why.contains("failed as it opened"), "{}", err.why);
}

/// A socket that greets first is let speak before the frame goes, and then answers as any.
#[test]
fn a_socket_that_greets_first_is_heard_before_the_frame_goes() {
    store::scratch_home("socket-greets");
    let (port, seen) = socket(Some("WELCOME"), |_| vec!["{\"ok\":1}".into()], None);
    let s = route_at(port, vec![text("{}")], &[], true);
    let got = rt().block_on(speak(&s, "{\"x\":1}", &[])).ok().unwrap();
    assert_eq!(got, json!({"ok": 1}));
    assert_eq!(*seen.frames.lock().unwrap(), vec!["{\"x\":1}".to_string()]);
}

/// An address that is no socket's is said so, and nothing was sent.
#[test]
fn an_address_that_is_no_socket_is_refused_unsent() {
    store::scratch_home("socket-bad-url");
    let mut s = route_at(1, vec![], &[], false);
    s.url = "not a url".into();
    let err = rt().block_on(speak(&s, "{}", &[])).err().unwrap();
    assert!(err.why.starts_with("the socket's address:"), "{}", err.why);
    assert!(!err.sent);
}

/// A site where a card sits in a checkout is sent no frame by a socket either.
#[test]
fn a_site_holding_a_card_is_sent_no_frame() {
    store::scratch_home("socket-held");
    crate::payhold::begin("127.0.0.1", &[]).unwrap();
    let (port, seen) = socket(None, |_| vec!["{}".into()], None);
    let s = route_at(port, vec![text("{}")], &[], false);
    let err = rt().block_on(speak(&s, "{}", &[])).err().unwrap();
    assert!(!err.sent);
    assert!(seen.frames.lock().unwrap().is_empty());
}

/// Calling a route with no socket says so, and sent nothing.
#[test]
fn a_route_with_no_socket_is_not_a_socket_route() {
    store::scratch_home("socket-none");
    let mut r = route(None, true, "https://example.com/");
    let c = call(&mut r, &HashMap::new(), "agent", true);
    assert_eq!(c.answer.unwrap_err(), "not a socket route");
    assert!(!c.possible_commit);
}

/// A caller who leaves out a value gets that said, and no socket is opened.
#[test]
fn a_call_missing_a_value_opens_no_socket() {
    store::scratch_home("socket-call-missing");
    let (port, seen) = socket(None, |_| vec![], None);
    let mut r = route(Some(route_at(port, vec![text("a"), input("who")], &[], false)), true, "https://example.com/");
    let c = call(&mut r, &HashMap::new(), "agent", true);
    assert_eq!(c.answer.unwrap_err(), "the route needs a value for who");
    assert!(!c.possible_commit);
    assert!(seen.frames.lock().unwrap().is_empty());
}

/// A call that is answered carries the answer, and for a write route says the frame may have landed.
#[test]
fn a_call_answered_says_a_write_may_have_landed() {
    store::scratch_home("socket-call-ok");
    let (port, seen) = socket(None, |_| vec!["{\"ok\":1}".into()], None);
    let mut r = route(Some(route_at(port, vec![text("{\"to\":\""), input("to"), text("\"}")], &[], false)), true, "https://example.com/");
    let c = call(&mut r, &values(&[("to", "ann")]), "agent", true);
    assert_eq!(c.answer.unwrap(), json!({"ok": 1}));
    assert!(c.possible_commit);
    assert_eq!(*seen.frames.lock().unwrap(), vec!["{\"to\":\"ann\"}".to_string()]);
    let (port, _) = socket(None, |_| vec!["{\"ok\":1}".into()], None);
    let mut r = route(Some(route_at(port, vec![text("{}")], &[], false)), false, "https://example.com/");
    assert!(!call(&mut r, &HashMap::new(), "agent", true).possible_commit, "a read changes nothing");
}

/// A frame the socket took and got no answer for is never sent twice: the call fails there, without opening the
/// page again, and a write says the site may hold it.
#[test]
fn a_frame_taken_without_answer_is_not_healed_but_may_have_landed() {
    store::scratch_home("socket-call-taken");
    let (port, _) = socket(None, |_| vec![], Some(1));
    let mut r = route(Some(route_at(port, vec![text("{}")], &[], false)), true, "https://example.com/");
    let c = call(&mut r, &HashMap::new(), "agent", true);
    assert_eq!(c.answer.unwrap_err(), "the socket took the frame but said nothing back");
    assert!(c.possible_commit);
}

/// A socket that refuses is healed by opening the route's page; a page that can't be opened says so after the first
/// failure, and nothing may have landed.
#[test]
fn a_refused_socket_whose_page_cannot_open_says_both() {
    store::scratch_home("socket-call-refused");
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    // The page is this machine's own: the node's browser never browses it.
    let mut r = route(Some(route_at(free, vec![text("{}")], &[], false)), true, "http://127.0.0.1/");
    let c = call(&mut r, &HashMap::new(), "agent", true);
    let err = c.answer.unwrap_err();
    assert!(err.starts_with("the socket refused:"), "{err}");
    assert!(err.contains("; and "), "{err}");
    assert!(!c.possible_commit);
}

/// A route whose socket address does not parse as a URL is not healed (there is no origin to heal on).
#[test]
fn a_socket_with_no_origin_is_not_healed() {
    store::scratch_home("socket-call-no-origin");
    let mut s = route_at(1, vec![text("{}")], &[], false);
    s.url = "no origin".into();
    let mut r = route(Some(s), false, "https://example.com/");
    let c = call(&mut r, &HashMap::new(), "agent", true);
    assert!(c.answer.unwrap_err().starts_with("the socket's address:"));
}

/// The freshest socket the node's browser opened on the route's origin is read off the browsing log, with the
/// headers the page chose for it and none of the browser's own.
#[test]
fn the_freshest_socket_on_the_origin_is_read_off_the_browsing_log() {
    store::scratch_home("socket-freshest");
    let site = "chat.example";
    std::fs::create_dir_all(crate::browse::capture_dir()).unwrap();
    let path = crate::browse::capture_dir().join(format!("{}.jsonl", crate::browse::session_of(site)));
    let lines = [
        json!({"type": "socket", "event": "open", "id": "1", "url": "wss://chat.example/old"}),
        json!({"type": "socket", "event": "open", "id": "2", "url": "wss://chat.example/new"}),
        json!({"type": "socket", "event": "open", "id": "3", "url": "wss://other.example/x"}),
        json!({"type": "socket", "event": "handshake", "id": "2", "headers": {"x-chosen": "yes", "sec-websocket-key": "k"}}),
        json!({"type": "request", "event": "open", "id": "4", "url": "wss://chat.example/not-a-socket"}),
    ];
    std::fs::write(&path, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n") + "\nnot json\n").unwrap();
    let origin = url::Url::parse("wss://chat.example/anything").unwrap().origin();
    let (url, headers) = freshest(site, &origin).unwrap();
    assert_eq!(url, "wss://chat.example/new");
    assert_eq!(headers, vec![("x-chosen".to_string(), "yes".to_string())]);
    let elsewhere = url::Url::parse("ws://chat.example/anything").unwrap().origin();
    assert!(freshest(site, &elsewhere).is_none(), "a heal never moves from wss to the clear");
    assert!(freshest("nolog.example", &origin).is_none());
}
