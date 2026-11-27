//! The challenge tool against a fake DevTools line: the page it reads, the steps it takes, the picture it keeps and what
//! it tells the agent, with the browser's door and its DevTools both served from this machine.

use super::*;

/// What the fake page says of itself, and the pictures and frames it serves.
#[derive(Clone, Default)]
struct Scene {
    /// What `READ_JS` answers on the page itself.
    top: Value,
    /// What `READ_JS` answers in a frame, by the context its isolated world was given.
    frames: Vec<(String, String, Value)>,
}

type Heard = Arc<Mutex<Vec<(String, Value)>>>;

fn doc(url: &str, title: &str, text: &str, html: &str) -> Value {
    json!({ "url": url, "title": title, "text": text, "html": html, "body": "", "cut": false, "answered": false, "shown": true })
}

const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake-picture";

/// A DevTools endpoint whose one tab shows `scene`, keeping every command it was sent.
fn devtools(scene: Scene) -> (String, Heard) {
    let heard: Heard = Arc::default();
    let kept = heard.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (kept, scene) = (kept.clone(), scene.clone());
            std::thread::spawn(move || {
                let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else { return };
                while let Ok(msg) = socket.read() {
                    let Ok(cmd) = serde_json::from_str::<Value>(msg.to_text().unwrap_or_default()) else { continue };
                    let method = cmd["method"].as_str().unwrap_or_default().to_string();
                    kept.locked().push((method.clone(), cmd["params"].clone()));
                    let result = match method.as_str() {
                        "Target.attachToTarget" => json!({ "sessionId": "S1" }),
                        "Page.getLayoutMetrics" => json!({ "cssVisualViewport": { "pageX": 0.0, "pageY": 40.0, "clientWidth": 900.0, "clientHeight": 600.0 } }),
                        "Page.captureScreenshot" => json!({ "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, PNG) }),
                        "Page.getFrameTree" => {
                            let kids: Vec<Value> = scene.frames.iter().map(|(id, url, _)| json!({ "frame": { "id": id, "url": url }, "childFrames": [] })).collect();
                            json!({ "frameTree": { "frame": { "id": "top" }, "childFrames": kids } })
                        }
                        "Page.createIsolatedWorld" => {
                            let id = cmd["params"]["frameId"].as_str().unwrap_or_default();
                            json!({ "executionContextId": scene.frames.iter().position(|(f, ..)| f == id).map_or(-1, |i| i as i64 + 100) })
                        }
                        "Runtime.evaluate" => {
                            let expression = cmd["params"]["expression"].as_str().unwrap_or_default();
                            let value = if let Some(c) = cmd["params"]["contextId"].as_i64() {
                                scene.frames[(c - 100) as usize].2.to_string()
                            } else if expression == READ_JS {
                                scene.top.to_string()
                            } else if expression.contains("location.href,title:document.title") {
                                json!({ "url": scene.top["url"], "title": scene.top["title"] }).to_string()
                            } else {
                                json!({ "texts": [], "unread": false }).to_string()
                            };
                            json!({ "result": { "type": "string", "value": value } })
                        }
                        _ => json!({}),
                    };
                    let _ = socket.send(tokio_tungstenite::tungstenite::Message::text(json!({ "id": cmd["id"], "result": result }).to_string()));
                }
            });
        }
    });
    (format!("ws://127.0.0.1:{port}/devtools/browser/fake"), heard)
}

fn page_on(ws: &str) -> CdpPage {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let opened = rt.block_on(open(ws, "T1")).unwrap();
    CdpPage { rt, client: opened.client, session: opened.session, viewport: opened.viewport, url: opened.url, title: opened.title }
}

fn methods(heard: &Heard) -> Vec<String> {
    heard.locked().iter().map(|(m, _)| m.clone()).collect()
}

/// A site's browser: its door answers its DevTools address and its one tab for `session`, as the node's browser does.
#[cfg(unix)]
fn browser_for(site: &str, session: &str, ws: &str) {
    use std::io::{BufRead, Write};
    let path = crate::browse::door(site);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(path).unwrap();
    let (ws, tab) = (ws.to_string(), crate::browse::tab_of(session));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let ws = ws.clone();
            let tab = tab.clone();
            std::thread::spawn(move || {
                let mut line = String::new();
                let _ = std::io::BufReader::new(stream.try_clone().unwrap()).read_line(&mut line);
                let cmd: Value = serde_json::from_str(&line).unwrap_or_default();
                let data = match cmd["action"].as_str() {
                    Some("cdp_url") => json!({ "cdpUrl": ws }),
                    Some("tab_list") => json!({ "tabs": [{ "label": tab, "targetId": "T1", "url": "https://x.example/", "title": "x" }] }),
                    _ => json!({}),
                };
                let mut out = stream;
                let _ = writeln!(out, "{}", json!({ "success": true, "data": data }));
            });
        }
    });
}

const ASKING: &str = "<html><body><p>Please verify you are human</p></body></html>";

#[test]
fn a_page_that_asks_is_shown_as_a_picture_its_words_and_its_size() {
    let (ws, heard) = devtools(Scene { top: doc("https://shop.example/gate", "Gate", "Please verify you are human", ASKING), ..Default::default() });
    let mut page = page_on(&ws);
    let state = page.state().unwrap();
    assert!(state.asks_a_person);
    assert_eq!((state.url.as_str(), state.title.as_str()), ("https://shop.example/gate", "Gate"));
    assert!(state.text.contains("verify you are human"));
    let shot = page.shot().unwrap();
    assert_eq!(shot.png, PNG);
    assert_eq!((shot.w, shot.h), (900.0, 600.0), "the picture is of the tab's own size");
    let clip = heard.locked().iter().find(|(m, _)| m == "Page.captureScreenshot").unwrap().1["clip"].clone();
    assert_eq!(clip["y"], 40.0, "clipped where the tab is scrolled to");
}

#[test]
fn a_picture_the_browser_does_not_send_is_an_error_not_an_empty_picture() {
    // A DevTools line that answers a screenshot with no data.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let Ok(mut socket) = tokio_tungstenite::tungstenite::accept(stream) else { return };
                while let Ok(msg) = socket.read() {
                    let Ok(cmd) = serde_json::from_str::<Value>(msg.to_text().unwrap_or_default()) else { continue };
                    let result = if cmd["method"] == "Target.attachToTarget" { json!({ "sessionId": "S1" }) } else { json!({}) };
                    let _ = socket.send(tokio_tungstenite::tungstenite::Message::text(json!({ "id": cmd["id"], "result": result }).to_string()));
                }
            });
        }
    });
    let mut page = page_on(&format!("ws://127.0.0.1:{port}/x"));
    assert_eq!(page.shot().unwrap_err(), "the browser took no picture");
    assert_eq!(page.state().unwrap_err(), "the page said nothing");
}

#[test]
fn every_hand_step_reaches_the_browser_as_the_events_a_hand_makes() {
    let (ws, heard) = devtools(Scene::default());
    let mut page = page_on(&ws);
    take(&mut page, &Act::Click(10.0, 20.0)).unwrap();
    let kinds = |heard: &Heard| -> Vec<String> {
        heard.locked().iter().filter(|(m, _)| m == "Input.dispatchMouseEvent").map(|(_, p)| p["type"].as_str().unwrap().to_string()).collect()
    };
    assert_eq!(kinds(&heard), ["mouseMoved", "mousePressed", "mouseReleased"]);
    heard.locked().clear();
    take(&mut page, &Act::Drag((0.0, 5.0), (80.0, 5.0))).unwrap();
    let moves: Vec<Value> = heard.locked().iter().filter(|(_, p)| p["type"] == "mouseMoved").map(|(_, p)| p["x"].clone()).collect();
    assert_eq!(moves.len(), 9, "one move to the start and eight stepped ones");
    assert_eq!(moves.last().unwrap(), &json!(80.0), "the last step is where the drag ends");
    assert_eq!(kinds(&heard).last().unwrap(), "mouseReleased");
    heard.locked().clear();
    take(&mut page, &Act::Type("abc".into())).unwrap();
    assert_eq!(heard.locked()[0], ("Input.insertText".to_string(), json!({ "text": "abc" })));
    heard.locked().clear();
    take(&mut page, &Act::Press("Enter".into())).unwrap();
    {
        let h = heard.locked();
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].1["type"].as_str(), h[0].1["text"].as_str()), (Some("keyDown"), Some("\r")), "Enter types its return");
        assert_eq!(h[1].1["type"], "keyUp");
    }
    heard.locked().clear();
    take(&mut page, &Act::Press("Tab".into())).unwrap();
    assert_eq!(heard.locked()[0].1["type"], "rawKeyDown", "a key with no text is a raw key");
    assert_eq!(heard.locked()[0].1["windowsVirtualKeyCode"], 9);
    heard.locked().clear();
    take(&mut page, &Act::Wait(5)).unwrap();
    take(&mut page, &Act::Done).unwrap();
    assert!(heard.locked().is_empty(), "a wait and done send the page nothing");
}

#[test]
fn a_key_the_node_does_not_press_is_refused_before_the_page_hears_it() {
    let (ws, heard) = devtools(Scene::default());
    let mut page = page_on(&ws);
    let why = take(&mut page, &Act::Press("F5".into())).unwrap_err();
    assert!(why.contains("Enter, Tab, Escape or Backspace") && why.contains("F5"), "{why}");
    assert!(!methods(&heard).iter().any(|m| m == "Input.dispatchKeyEvent"));
}

#[test]
fn a_check_drawn_in_a_frame_of_the_site_is_read_with_the_page_and_a_hidden_frame_is_not() {
    let top = doc("https://www.shop.example/s", "Search", "Search results", "<html><body><h1>Search results</h1></body></html>");
    let shown = doc("https://guard.shop.example/hold", "", "We need to check if you are a robot.", ASKING);
    let hidden = json!({ "url": "https://ads.shop.example/slot", "title": "", "text": "i am not a robot", "html": ASKING, "body": "", "cut": false, "answered": false, "shown": false });
    let (ws, heard) = devtools(Scene {
        top,
        frames: vec![
            ("F1".into(), "https://guard.shop.example/hold".into(), shown),
            ("F2".into(), "https://ads.shop.example/slot".into(), hidden),
            ("F3".into(), "https://other.example/widget".into(), doc("https://other.example/widget", "", "other site", "")),
        ],
    });
    let mut page = page_on(&ws);
    let state = page.state().unwrap();
    assert!(state.asks_a_person, "the shown frame of the site holds the check");
    assert!(state.text.contains("Search results") && state.text.contains("We need to check if you are a robot."));
    assert!(!state.text.contains("other site"), "another site's frame is not read here");
    let worlds = heard.locked().iter().filter(|(m, _)| m == "Page.createIsolatedWorld").count();
    assert_eq!(worlds, 2, "a world per frame of the site, none for another site's");
}

#[test]
fn a_page_with_no_address_has_no_frames_to_read() {
    let (ws, heard) = devtools(Scene { top: doc("not a url", "", "hello", ""), ..Default::default() });
    let mut page = page_on(&ws);
    let state = page.state().unwrap();
    assert!(!state.asks_a_person);
    assert!(!methods(&heard).iter().any(|m| m == "Page.getFrameTree"));
}

#[test]
fn what_a_page_paints_is_read_for_the_secret_guard() {
    let (ws, _) = devtools(Scene::default());
    let page = page_on(&ws);
    let shown = page.shown("shop.example").expect("the page said what it paints");
    assert!(shown.texts.is_empty() && !shown.unread);
}

#[test]
fn the_steps_taken_are_kept_per_page_and_bounded() {
    let (site, session) = ("said-bound.example", "1:said");
    assert!(said(site, session).is_empty());
    for i in 0..(SAID_MOST + 5) {
        note(site, session, format!("step {i}"));
    }
    let all = said(site, session);
    assert_eq!(all.len(), SAID_MOST, "the oldest steps are let go");
    assert_eq!(all.first().unwrap(), "step 5");
    assert_eq!(all.last().unwrap(), &format!("step {}", SAID_MOST + 4));
    assert!(said(site, "1:another").is_empty(), "another session's page has its own steps");
    forget(site, session);
    assert!(said(site, session).is_empty());
}

#[test]
fn a_challenge_with_no_page_open_says_so() {
    let _home = crate::store::scratch_home("challenge-nopage");
    let why = look("agent", "", "never-browsed", "").unwrap_err();
    assert!(why.contains("no page is open"), "{why}");
    let why = batch("agent", "", "never-browsed", vec![Act::Click(1.0, 1.0)]).unwrap_err();
    assert!(why.contains("no page is open"), "{why}");
}

#[test]
fn a_site_whose_browser_is_not_open_is_told_it_opens_when_an_agent_browses() {
    let _home = crate::store::scratch_home("challenge-nobrowser");
    for said in [look("agent", "closed.example", "1:c", ""), act("agent", "closed.example", "1:c", Act::Click(1.0, 1.0)), act_quick("agent", "closed.example", "1:c", Act::Click(1.0, 1.0)), batch("agent", "closed.example", "1:c", vec![Act::Done])] {
        let why = said.unwrap_err();
        assert!(why.contains("closed.example's browser isn't open"), "{why}");
    }
}

#[cfg(unix)]
#[test]
fn a_look_at_a_page_that_asks_keeps_its_picture_and_tells_what_it_said() {
    let _home = crate::store::scratch_home("c-asks");
    let (ws, heard) = devtools(Scene { top: doc("https://ask-look.example/gate", "Gate", "Please verify you are human", ASKING), ..Default::default() });
    browser_for("ask-look.example", "1:look", &ws);
    let reply = look("agent", "ask-look.example", "1:look", "").unwrap();
    assert_eq!(reply["asks"], true);
    assert_eq!(reply["site"], "ask-look.example");
    assert_eq!((reply["w"].as_f64(), reply["h"].as_f64(), reply["mime"].as_str()), (Some(900.0), Some(600.0), Some("image/png")));
    assert!(reply["note"].is_null());
    let path = reply["image"].as_str().unwrap();
    assert_eq!(picture(path).as_deref(), Some(PNG), "the picture on disk is the browser's");
    assert!(methods(&heard).iter().any(|m| m == "Page.captureScreenshot"));
    assert_eq!(reply["said"], json!([]));
}

#[cfg(unix)]
#[test]
fn a_look_at_a_page_that_asks_nobody_takes_no_picture() {
    let _home = crate::store::scratch_home("c-plain");
    let (ws, heard) = devtools(Scene { top: doc("https://plain-look.example/", "Home", "Welcome home", "<html><body>Welcome home</body></html>"), ..Default::default() });
    browser_for("plain-look.example", "1:plain", &ws);
    let reply = look("agent", "plain-look.example", "1:plain", "").unwrap();
    assert_eq!(reply["asks"], false);
    assert!(reply["image"].is_null());
    assert!(reply["note"].as_str().unwrap().contains("doesn't ask for a person"));
    assert_eq!(reply["text"], "Welcome home");
    assert!(!methods(&heard).iter().any(|m| m == "Page.captureScreenshot"), "no camera on a page that asks nobody");
}

#[cfg(unix)]
#[test]
fn a_step_is_remembered_and_shown_back_and_done_on_a_passed_page_forgets_them() {
    let _home = crate::store::scratch_home("c-steps");
    let (ws, heard) = devtools(Scene { top: doc("https://steps.example/", "Home", "All clear", "<html><body>All clear</body></html>"), ..Default::default() });
    browser_for("steps.example", "1:steps", &ws);
    let reply = act("agent", "steps.example", "1:steps", Act::Click(30.0, 40.0)).unwrap();
    assert_eq!(reply["said"], json!(["clicked (30,40)"]));
    assert!(heard.locked().iter().any(|(m, p)| m == "Input.dispatchMouseEvent" && p["type"] == "mousePressed" && p["x"] == 30.0 && p["y"] == 40.0));
    let reply = act("agent", "steps.example", "1:steps", Act::Press("F9".into())).unwrap();
    let said = reply["said"].as_array().unwrap();
    assert_eq!(said.len(), 2);
    assert!(said[1].as_str().unwrap().starts_with("pressed F9 failed: "), "a step that failed is told as failed: {said:?}");
    let reply = act("agent", "steps.example", "1:steps", Act::Done).unwrap();
    assert_eq!(reply["asks"], false);
    assert!(said_after_done("steps.example", "1:steps"), "the page passed, so what was tried on it is forgotten");
    assert_eq!(reply["said"].as_array().unwrap().len(), 3, "done itself is in the reply that closes the page");
}

fn said_after_done(site: &str, session: &str) -> bool {
    said(site, session).is_empty()
}

#[cfg(unix)]
#[test]
fn done_on_a_page_that_still_asks_keeps_the_steps() {
    let _home = crate::store::scratch_home("c-done");
    let (ws, _) = devtools(Scene { top: doc("https://still.example/gate", "Gate", "Please verify you are human", ASKING), ..Default::default() });
    browser_for("still.example", "1:still", &ws);
    act("agent", "still.example", "1:still", Act::Click(1.0, 2.0)).unwrap();
    let reply = act("agent", "still.example", "1:still", Act::Done).unwrap();
    assert_eq!(reply["asks"], true);
    assert_eq!(said("still.example", "1:still").len(), 2, "a page that still asks keeps its history");
    forget("still.example", "1:still");
}

#[cfg(unix)]
#[test]
fn a_quick_step_takes_no_picture_and_reads_no_page() {
    let _home = crate::store::scratch_home("c-quick");
    let (ws, heard) = devtools(Scene { top: doc("https://quick.example/gate", "Gate", "Please verify you are human", ASKING), ..Default::default() });
    browser_for("quick.example", "1:quick", &ws);
    let reply = act_quick("agent", "quick.example", "1:quick", Act::Click(7.0, 8.0)).unwrap();
    assert_eq!(reply["quick"], true);
    assert!(reply["asks"].is_null(), "a quick reply says what was done, not what the page shows");
    assert_eq!(reply["said"], json!(["clicked (7,8)"]));
    let sent = methods(&heard);
    assert!(sent.iter().any(|m| m == "Input.dispatchMouseEvent"));
    assert!(!sent.iter().any(|m| m == "Page.captureScreenshot" || m == "Page.getFrameTree"), "{sent:?}");
    forget("quick.example", "1:quick");
}

#[cfg(unix)]
#[test]
fn a_batch_lands_every_step_on_one_attachment_and_tells_each_one_that_failed() {
    let _home = crate::store::scratch_home("c-batch");
    let (ws, heard) = devtools(Scene { top: doc("https://batch.example/gate", "Gate", "grid", ASKING), ..Default::default() });
    browser_for("batch.example", "1:batch", &ws);
    let steps = vec![Act::Click(10.0, 10.0), Act::Press("Home".into()), Act::Click(20.0, 20.0)];
    let reply = batch("agent", "batch.example", "1:batch", steps).unwrap();
    assert_eq!(reply["batched"], 3);
    assert_eq!(reply["quick"], true);
    assert!(reply["asks"].is_null());
    let done = reply["said"].as_array().unwrap();
    assert_eq!(done[0], "clicked (10,10)");
    assert!(done[1].as_str().unwrap().starts_with("pressed Home failed: "), "{done:?}");
    assert_eq!(done[2], "clicked (20,20)", "a step that failed doesn't stop the ones after it");
    let attaches = methods(&heard).iter().filter(|m| *m == "Target.attachToTarget").count();
    assert_eq!(attaches, 1, "one browser attachment for the whole batch");
    assert_eq!(said("batch.example", "1:batch").len(), 3);
    forget("batch.example", "1:batch");
}

#[cfg(unix)]
#[test]
fn a_challenge_on_a_site_with_no_open_tab_for_the_session_says_so() {
    let _home = crate::store::scratch_home("c-notab");
    let (ws, _) = devtools(Scene::default());
    browser_for("notab.example", "1:has-tab", &ws);
    let why = look("agent", "notab.example", "1:other-session", "").unwrap_err();
    assert!(why.contains("the session's tab isn't open"), "{why}");
}
