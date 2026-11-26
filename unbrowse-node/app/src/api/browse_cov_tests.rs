//! The node's browse handlers (`do_browse`, `do_observe`, `ask_owner`, `do_challenge`) driven the way the API drives them,
//! with a scripted stand-in for the node's browser program (`fake_program`): what the page printed comes back as the
//! step's answer, and what the handler does around it (the reply's fields, the log, the owner's ask) is what is judged.

use super::*;

/// Runs a test's body while no other test sweeps every browser: the sweep (`browse::sweep_idle`, which one test
/// calls) looks for every site's door in its own home, finds none of ours, and would forget the browsers this test
/// had open, mid-step.
fn stable(body: impl Fn()) {
    let _browsing = crate::browse::SWEEPING.read().unwrap_or_else(|e| e.into_inner());
    body()
}

thread_local! {
    /// The browsing session this test names: one per test, so no test's tabs, learned routes or last site are another's.
    static SESSION: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

fn this_session() -> String {
    SESSION.with(|s| s.borrow().clone())
}

/// A runtime, node and agent in a short scratch home (a browser door's path has a length limit the temp folder's own
/// would pass). Every thread the runtime starts has the home and names a browser, as a node that has one.
fn browsing_node(name: &str) -> (std::path::PathBuf, tokio::runtime::Runtime, Arc<Node>, Agent) {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let _ = store::scratch_home(name);
    SESSION.with(|s| *s.borrow_mut() = format!("b2-{name}-{n}"));
    let home = std::path::PathBuf::from(format!("/tmp/ubb2{}x{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    store::use_home(&home);
    crate::browsers::for_this_test(Some("/bin/true".into()));
    let h = home.clone();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .on_thread_start(move || {
            store::use_home(&h);
            crate::browsers::for_this_test(Some("/bin/true".into()));
        })
        .build()
        .unwrap();
    store::save_settings(&store::Settings { fetch_browser: false, ..store::Settings::default() }).unwrap();
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
    (home, rt, node, agent)
}

/// The node's browser program, a script in the add-on folder: it logs the words of each command to `fake/log`, and
/// answers a command by its verb with the text of `fake/<verb>` (`ok` when there is none), or fails with the text of
/// `fake/<verb>.fail`; the lines of `fake/<verb>.line` are added to the site's browsing log, as the browser writes what a
/// page loaded.
#[cfg(unix)]
fn fake_program(home: &std::path::Path) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let fake = home.join("fake");
    std::fs::create_dir_all(&fake).unwrap();
    let program = crate::browsers::addon_program();
    std::fs::create_dir_all(program.parent().unwrap()).unwrap();
    let script = format!(
        "#!/bin/sh\nR='{}'\necho \"$*\" >> \"$R/log\"\nverb=''\nfor w in \"$@\"; do case \"$w\" in open|goto|navigate|snapshot|click|dblclick|fill|type|press|select|check|uncheck|upload|close|get|eval|screenshot) verb=$w; break;; esac; done\nsess=''; prev=''; for w in \"$@\"; do [ \"$prev\" = --session ] && sess=$w; prev=$w; done
if [ -f \"$R/$verb.line\" ]; then cat \"$R/$verb.line\" >> \"$UNBROWSE_CAPTURE_DIR/$sess.jsonl\"; fi
if [ -f \"$R/$verb.fail\" ]; then cat \"$R/$verb.fail\" >&2; exit 1; fi\nif [ -f \"$R/$verb\" ]; then cat \"$R/$verb\"; else echo ok; fi\n",
        fake.display()
    );
    std::fs::write(&program, script).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    fake
}

fn said(fake: &std::path::Path, verb: &str, text: &str) {
    std::fs::write(fake.join(verb), text).unwrap();
}

fn log_of(fake: &std::path::Path) -> String {
    std::fs::read_to_string(fake.join("log")).unwrap_or_default()
}

fn step(rt: &tokio::runtime::Runtime, node: &Arc<Node>, a: &Agent, args: &[&str], site: &str) -> Result<Value, Fail> {
    let (n, a) = (node.clone(), a.clone());
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let site = site.to_string();
    let session = this_session();
    rt.block_on(async move { do_browse(&n, &a, args, site, String::new(), &session).await })
}

#[cfg(unix)]
#[test]
fn an_observed_page_comes_back_as_the_actions_the_browser_named() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("observe");
        let fake = fake_program(&home);
        said(&fake, "snapshot", "- textbox \"Search\" [ref=e1]\n- button \"Go\" [ref=e2]\n- heading \"Flights\"\n");
        let (n, a2, named) = (node.clone(), a.clone(), this_session());
        let seen = rt.block_on(async move { do_observe(&n, &a2, "shop.example".into(), named, String::new()).await });
        let seen = seen.unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(seen["elements"].as_array().unwrap().len(), 2, "{seen}");
        assert_eq!(seen["elements"][1]["name"], "Go", "{seen}");
        assert!(log_of(&fake).contains("snapshot -i"), "{}", log_of(&fake));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A browser answering at `site`'s door until dropped: every command it is sent is answered by `reply`.
#[cfg(unix)]
struct Door {
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
fn door_up(home: &std::path::Path, site: &str, reply: impl Fn(&Value) -> Value + Send + 'static) -> Door {
    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::Ordering;
    let dir = home.join("browser");
    std::fs::create_dir_all(&dir).unwrap();
    let listener = std::os::unix::net::UnixListener::bind(dir.join(format!("{}.sock", crate::browse::session_of(site)))).unwrap();
    listener.set_nonblocking(true).unwrap();
    let (stop, seen) = (Arc::new(std::sync::atomic::AtomicBool::new(false)), Arc::new(std::sync::Mutex::new(Vec::new())));
    let (s, k) = (stop.clone(), seen.clone());
    let thread = std::thread::spawn(move || {
        while !s.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(3));
                continue;
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            let mut line = String::new();
            if BufReader::new(&stream).read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            let Ok(cmd) = serde_json::from_str::<Value>(&line) else { continue };
            let answer = reply(&cmd);
            k.lock().unwrap().push(cmd);
            let _ = stream.write_all(format!("{answer}\n").as_bytes());
        }
    });
    Door { stop, thread: Some(thread) }
}

#[cfg(unix)]
impl Drop for Door {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// A door that has a page open and answers its address and anything else with an empty success.
#[cfg(unix)]
fn open_door(home: &std::path::Path, site: &str) -> Door {
    door_up(home, site, |c| match c["action"].as_str() {
        Some("cdp_url") => json!({ "success": true, "data": { "cdpUrl": "ws://127.0.0.1:1/devtools/browser/fake" } }),
        _ => json!({ "success": true, "data": {} }),
    })
}

/// The ask for the owner the node holds on `site`, answered `how` once it stands (a person in the window).
#[cfg(unix)]
fn owner_answers(site: &'static str, how: crate::hands::Answer) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !crate::hands::asks().iter().any(|x| x.site == site) {
            assert!(std::time::Instant::now() < until, "the owner was never asked");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(crate::hands::answer(site, how), 1);
    })
}

/// A door whose browser has `url` open in the tab `session` of `agent` acts in.
#[cfg(unix)]
fn door_on_page(home: &std::path::Path, site: &str, a: &Agent, url: &str) -> Door {
    let (tab, url) = (crate::browse::tab_of(&browse_session(a, &this_session())), url.to_string());
    door_up(home, site, move |c| match c["action"].as_str() {
        Some("cdp_url") => json!({ "success": true, "data": { "cdpUrl": "ws://127.0.0.1:1/devtools/browser/fake" } }),
        Some("tab_list") => json!({ "success": true, "data": { "tabs": [{ "label": tab, "url": url, "targetId": "T1", "title": "Page" }] } }),
        _ => json!({ "success": true, "data": {} }),
    })
}

fn asked(rt: &tokio::runtime::Runtime, node: &Arc<Node>, a: &Agent, words: &[&str], site: &str) -> Result<Value, Fail> {
    let (n, a) = (node.clone(), a.clone());
    let args: Vec<String> = words.iter().map(|s| s.to_string()).collect();
    let site = site.to_string();
    let session = browse_session(&a, &this_session());
    rt.block_on(async move { ask_owner(&n, &a, &args, &site, &session).await })
}

#[cfg(unix)]
#[test]
fn a_step_the_browser_refuses_is_unprocessable_and_says_the_browsers_words() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("refused");
        let fake = fake_program(&home);
        let _door = open_door(&home, "refuses.example");
        std::fs::write(fake.join("click.fail"), "element e9 is covered by a dialog").unwrap();
        let ok = step(&rt, &node, &a, &["open", "https://refuses.example/"], "").unwrap();
        assert_eq!((ok["site"].as_str(), ok["output"].as_str()), (Some("refuses.example"), Some("ok")), "{ok}");
        let (status, said) = step(&rt, &node, &a, &["click", "@e9"], "").expect_err("refused");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        assert!(said.contains("covered by a dialog"), "{said}");
        assert!(log_of(&fake).contains("click @e9"), "the step reached the browser: {}", log_of(&fake));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_script_run_in_a_tab_says_the_tab_takes_no_vault_fill_and_never_goes_to_the_owner() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("scripted");
        let fake = fake_program(&home);
        let _door = door_on_page(&home, "scripted.example", &a, "https://scripted.example/");
        step(&rt, &node, &a, &["open", "https://scripted.example/"], "").unwrap();
        let ran = step(&rt, &node, &a, &["eval", "document.title"], "").unwrap();
        assert!(ran["note"].as_str().unwrap().contains("takes no vault fill"), "{ran}");
        let plain = step(&rt, &node, &a, &["click", "@e1"], "").unwrap();
        assert!(plain.get("note").is_none_or(|n| !n.as_str().unwrap_or_default().contains("takes no vault fill")), "{plain}");
        // A page a script of the agent's ran in could hear what the owner types: no ask is made of them.
        let (status, said) = asked(&rt, &node, &a, &["ask_owner", "sign in"], "scripted.example").expect_err("scripted");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        assert_eq!(said, crate::browse::SCRIPTED_FOR_THE_OWNER);
        assert!(!crate::hands::asks().iter().any(|x| x.site == "scripted.example"));
        let _ = fake;
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_page_the_browser_has_open_goes_to_the_owner_and_what_they_answer_is_what_the_agent_hears() {
    stable(|| {
        use crate::hands::Answer;
        let (home, rt, node, a) = browsing_node("ask-answers");
        let _fake = fake_program(&home);
        let _window = node.events.subscribe_for_test();
        let (_a, _b, _c) = (
            door_on_page(&home, "answers-done.example", &a, "https://answers-done.example/login"),
            door_on_page(&home, "answers-declined.example", &a, "https://answers-declined.example/"),
            door_on_page(&home, "answers-lapsed.example", &a, "https://answers-lapsed.example/"),
        );
        let waiting = owner_answers("answers-done.example", Answer::Done);
        let done = asked(&rt, &node, &a, &["ask_owner", "sign in", "--timeout", "60"], "answers-done.example").unwrap();
        waiting.join().unwrap();
        assert_eq!((done["owner"].as_str(), done["output"].as_str()), (Some("done"), Some("The owner did it on the page and gave it back.")), "{done}");
        assert_eq!(done["url"], "https://answers-done.example/login", "the agent hears where the page is now: {done}");
        assert!(done["note"].as_str().unwrap().contains("Nothing the owner typed is shown to you"), "{done}");
        assert!(!crate::hands::asks().iter().any(|x| x.site == "answers-done.example"), "the ask is over");

        let waiting = owner_answers("answers-declined.example", Answer::Declined);
        let declined = asked(&rt, &node, &a, &["ask_owner", "sign in"], "answers-declined.example").unwrap();
        waiting.join().unwrap();
        assert_eq!((declined["owner"].as_str(), declined["output"].as_str()), (Some("declined"), Some("The owner gave the page back without doing it.")), "{declined}");
        assert!(declined["note"].as_str().unwrap().contains("Don't ask again"), "{declined}");

        let waiting = owner_answers("answers-lapsed.example", Answer::NoAnswer);
        let lapsed = asked(&rt, &node, &a, &["ask_owner", "sign in"], "answers-lapsed.example").unwrap();
        waiting.join().unwrap();
        assert_eq!((lapsed["owner"].as_str(), lapsed["output"].as_str()), (Some("no_answer"), Some("The owner didn't answer in time.")), "{lapsed}");
        // What the owner is shown and what was logged name the agent and the words it gave.
        let log = store::read_activity(200);
        assert!(log.iter().any(|l| l.site == "answers-done.example" && l.kind == "hands" && l.what == "Asked you to take over the page: sign in" && l.who == a.name), "{log:?}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_page_already_waiting_on_the_owner_is_not_asked_about_twice() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("ask-twice");
        let _fake = fake_program(&home);
        let _window = node.events.subscribe_for_test();
        let _door = door_on_page(&home, "twice.example", &a, "https://twice.example/");
        let first = {
            let (n, a) = (node.clone(), a.clone());
            let session = browse_session(&a, &this_session());
            rt.spawn(async move { ask_owner(&n, &a, &["ask_owner".to_string(), "check".to_string()], "twice.example", &session).await })
        };
        let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !crate::hands::asks().iter().any(|x| x.site == "twice.example") {
            assert!(std::time::Instant::now() < until, "the owner was never asked");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let (status, said) = asked(&rt, &node, &a, &["ask_owner", "again"], "twice.example").expect_err("already waiting");
        assert_eq!(status, StatusCode::CONFLICT, "{said}");
        assert!(said.contains("already waiting on the owner"), "{said}");
        crate::hands::answer("twice.example", crate::hands::Answer::Declined);
        assert_eq!(rt.block_on(first).unwrap().unwrap()["owner"], "declined");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn an_ask_with_no_window_to_show_it_in_is_refused_at_once() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("ask-nowindow");
        let _fake = fake_program(&home);
        let _door = door_on_page(&home, "nowindow.example", &a, "https://nowindow.example/");
        // No window watches the node, and none can be opened from a test: the agent is told now, not after a wait.
        let (status, said) = asked(&rt, &node, &a, &["ask_owner", "check"], "nowindow.example").expect_err("no window");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{said}");
        assert!(!crate::hands::asks().iter().any(|x| x.site == "nowindow.example"));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_login_the_vault_lacks_is_asked_of_the_owner_and_the_agent_hears_how_they_answered() {
    stable(|| {
        use crate::hands::Answer;
        let (home, rt, node, a) = browsing_node("ask-login");
        let fake = fake_program(&home);
        let _window = node.events.subscribe_for_test();
        let fill = |site: &str| step(&rt, &node, &a, &["fill", "@e1", &format!("vault:ask:{site}:me@x.example")], site);
        // No page open for the session: the owner isn't asked for a password the node has no page to type into.
        let _d0 = door_up(&home, "nopage.example", |_| json!({ "success": true, "data": { "tabs": [] } }));
        let (status, said) = fill("nopage.example").expect_err("no page");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        assert!(said.contains("open the login page first"), "{said}");
        // A page that isn't the login's own site may not take it.
        let _d1 = door_on_page(&home, "elsewhere.example", &a, "https://other.example/login");
        let (status, said) = fill("elsewhere.example").expect_err("wrong page");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        assert!(said.contains("The owner wasn't asked") && said.contains("vault:elsewhere.example:me@x.example"), "{said}");
        assert!(!crate::hands::asks().iter().any(|x| x.site == "elsewhere.example"));
        // The owner declines, lets it lapse, or says done though the vault holds nothing new.
        for (site, how, status, words) in [
            ("login-declined.example", Answer::Declined, StatusCode::FORBIDDEN, "the owner declined to add the login"),
            ("login-lapsed.example", Answer::NoAnswer, StatusCode::REQUEST_TIMEOUT, "didn't add the login"),
            ("login-empty.example", Answer::Done, StatusCode::CONFLICT, "the vault still has no login"),
        ] {
            let _door = door_on_page(&home, site, &a, &format!("https://{site}/login"));
            let waiting = owner_answers(Box::leak(site.to_string().into_boxed_str()), how);
            let (got, said) = fill(site).expect_err("not filled");
            waiting.join().unwrap();
            assert_eq!(got, status, "{site}: {said}");
            assert!(said.contains(words), "{site}: {said}");
        }
        assert!(!log_of(&fake).contains("vault:ask"), "the reference never reached the browser: {}", log_of(&fake));
        let log = store::read_activity(200);
        assert!(log.iter().any(|l| l.kind == "vault" && l.what == "Asked you to add the login for me@x.example on login-declined.example to the vault"), "{log:?}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_login_asked_while_the_node_is_paused_asks_nobody() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("ask-login-paused");
        let _fake = fake_program(&home);
        let _door = door_on_page(&home, "paused-login.example", &a, "https://paused-login.example/login");
        store::save_settings(&store::Settings { fetch_browser: false, paused: true, ..store::Settings::default() }).unwrap();
        let (status, said) = step(&rt, &node, &a, &["fill", "@e1", "vault:ask:paused-login.example:me@x.example"], "paused-login.example").expect_err("paused");
        assert_eq!((status, said.as_str()), (StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A route the browsing learned is named in the session's next reply, and a route already there for the page's goal in
/// the reply to opening it; one an agent judged wrong is neither.
#[cfg(unix)]
#[test]
fn a_route_the_browsing_learned_or_the_goal_names_is_handed_over_unless_judged_wrong() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("learned");
        let _fake = fake_program(&home);
        let _door = door_on_page(&home, "learned.example", &a, "https://learned.example/items");
        let route = |id: &str, what: &str| -> store::Route {
            serde_json::from_value(json!({
                "id": id, "site": "learned.example", "what": what, "method": "GET", "path": "/items", "root": "https://learned.example/items",
                "inputs": [{ "name": "q", "secret": false, "default": null }, { "name": "doc", "secret": false, "default": null, "file": true }],
                "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 0,
                "graph": { "steps": [], "provisional": false }
            }))
            .unwrap()
        };
        store::save_route(&route("r-good", "List the items")).unwrap();
        let mut wrong = route("r-wrong", "List the things");
        wrong.judged.wrong.push(serde_json::from_value(json!({ "page": "https://learned.example/items", "why": "not it", "by": "agent", "at": 1 })).unwrap());
        store::save_route(&wrong).unwrap();
        let session = browse_session(&a, &this_session());
        crate::browse::credit_learned("learned.example", &session, "r-good", 0.0);
        crate::browse::credit_learned("learned.example", &session, "r-wrong", 0.0);
        let (n, a2, named) = (node.clone(), a.clone(), this_session());
        let opened = rt
            .block_on(async move { do_browse(&n, &a2, vec!["open".into(), "https://learned.example/items".into()], String::new(), "list the items".into(), &named).await })
            .unwrap();
        assert_eq!(opened["learned"].as_array().unwrap().len(), 1, "{opened}");
        assert_eq!(opened["learned"][0]["route_id"], "r-good", "{opened}");
        assert_eq!(opened["learned"][0]["inputs"], json!(["q", "doc"]), "{opened}");
        assert_eq!(opened["learned"][0]["file_inputs"], json!(["doc"]), "{opened}");
        assert_eq!(opened["route_for_goal"]["route_id"], "r-good", "{opened}");
        assert!(opened["note"].as_str().unwrap().contains("A route does this now"), "{opened}");
        // The goal that names the judged-wrong route's words finds none.
        let (n, a2, named) = (node.clone(), a.clone(), this_session());
        let again = rt
            .block_on(async move { do_browse(&n, &a2, vec!["open".into(), "https://learned.example/items".into()], String::new(), "list the things".into(), &named).await })
            .unwrap();
        assert!(again.get("route_for_goal").is_none(), "{again}");
        // Closing the page forgets what it learned.
        step(&rt, &node, &a, &["close"], "learned.example").unwrap();
        assert!(crate::browse::learned("learned.example", &session).is_empty());
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_public_peer_opens_no_browser_for_anyone() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("public-peer");
        let _fake = fake_program(&home);
        std::fs::write(home.join("remote.json"), r#"{"public":true}"#).unwrap();
        if !crate::remote::public_home() {
            return;
        }
        let (status, said) = step(&rt, &node, &a, &["open", "https://shop.example/"], "").expect_err("public");
        assert_eq!((status, said.as_str()), (StatusCode::FORBIDDEN, crate::remote::NEEDS_OWN_NODE));
        assert_eq!(log_of(&home.join("fake")), "", "no browser program ran");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_hand_step_that_names_no_point_reaches_no_browser() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("challenge-args");
        let fake = fake_program(&home);
        let call = |action: &str, steps: Vec<Value>| {
            let (n, a, action, session) = (node.clone(), a.clone(), action.to_string(), this_session());
            rt.block_on(async move { do_challenge(&n, &a, action, "shop.example".into(), session, String::new(), None, None, None, None, None, None, None, false, steps).await })
        };
        let (status, said) = call("click", vec![]).expect_err("no point");
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        let (status, said) = call("no-such-action", vec![]).expect_err("unknown");
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        let (status, said) = call("click", vec![json!({ "action": "click", "x": 1.0, "y": 2.0 }), json!({ "action": "drag", "x": 1.0 })]).expect_err("half a drag");
        assert_eq!(status, StatusCode::BAD_REQUEST, "{said}");
        assert_eq!(log_of(&fake), "");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

#[cfg(unix)]
#[test]
fn a_look_or_a_batch_on_a_page_with_no_browser_open_says_so_and_logs_nothing_waiting() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("challenge-nobrowser");
        let _fake = fake_program(&home);
        let call = |action: &str, steps: Vec<Value>| {
            let (n, a, action, session) = (node.clone(), a.clone(), action.to_string(), this_session());
            rt.block_on(async move { do_challenge(&n, &a, action, "closed.example".into(), session, String::new(), None, None, None, None, None, None, None, false, steps).await })
        };
        let (status, said) = call("look", vec![]).expect_err("nothing open");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        let (status, said) = call("click", vec![json!({ "action": "click", "x": 3.0, "y": 4.0 })]).expect_err("nothing open");
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{said}");
        assert!(said.contains("closed.example"), "{said}");
        assert!(!store::read_activity(50).iter().any(|l| l.kind == "challenge"), "a step that never reached a page is not logged as one");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// The browsing-log line of a document the browser loaded: `status`, and `body` for its text.
fn document(url: &str, status: u16, body: &str) -> String {
    format!("{}\n", json!({ "type": "exchange", "t": 1.0, "resourceType": "Document", "entry": { "request": { "method": "GET", "url": url, "headers": [] }, "response": { "status": status, "headers": [], "content": { "mimeType": "text/html", "text": body } } } }))
}

const LAMP: &str = "<html><head><title>Lamp</title></head><body><h1>Lamp</h1><a href=\"/\">Home</a></body></html>";
const SIGN_IN: &str = "<html><head><title>Sign in</title></head><body><form><input type=\"password\" name=\"p\"><input name=\"u\"><button>Go</button></form></body></html>";
const REFUSED: &str = "<html><head><title>Forbidden</title></head><body><h1>No</h1><a href=\"/\">Home</a> <a href=\"/about\">About</a></body></html>";
const CHECKED_FORM: &str = "<html><head><title>Sign up</title></head><body><form><input name=\"email\"><div class=\"box\" data-sitekey=\"0x4AAAAAAAB\"></div><button>Go</button></form></body></html>";

/// What an open of a page comes to is read from the document the browser loaded, and the reply says it in words that
/// name the next call: a page that answered an error is gone, a site's sign-in or wall needs the owner, a form with a
/// check among its fields is the page asked for (said as carrying one), and an address the browser never reached is a
/// page that isn't there.
#[cfg(unix)]
#[test]
fn an_open_page_that_landed_elsewhere_than_asked_says_where_and_what_to_do_next() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("landing");
        let fake = fake_program(&home);
        let open = |site: &str, asked: &str, landed: &str, status: u16, body: &str| {
            let door = door_on_page(&home, site, &a, landed);
            std::fs::write(fake.join("open.line"), document(landed, status, body)).unwrap();
            let said = step(&rt, &node, &a, &["open", asked], "").unwrap_or_else(|e| panic!("{site}: {e:?}"));
            drop(door);
            said
        };
        let gone = open("missing.example", "https://missing.example/x", "https://missing.example/x", 404, LAMP);
        assert_eq!((gone["outcome"].as_str(), gone["outcome_from"].as_str()), (Some("gone"), Some("browse.landed.status")), "{gone}");
        assert!(gone["output"].as_str().unwrap().starts_with("The page answered 404"), "{gone}");
        assert!(gone.get("needs_owner").is_none(), "{gone}");

        let walled = open("walled.example", "https://walled.example/account", "https://walled.example/login?next=%2Faccount", 200, SIGN_IN);
        assert_eq!((walled["outcome"].as_str(), walled["needs_owner"].as_bool()), (Some("needs_person"), Some(true)), "{walled}");
        assert!(walled["output"].as_str().unwrap().contains("https://walled.example/login?next=%2Faccount instead of the one asked for"), "{walled}");
        assert_eq!(walled["next"]["args"]["do"][0], "ask_owner", "{walled}");
        assert!(walled["note"].as_str().unwrap().contains("try unbrowse_challenge"), "{walled}");

        let signin = open("signin.example", "https://signin.example/account", "https://signin.example/login", 200, SIGN_IN);
        assert_eq!((signin["outcome_from"].as_str(), signin["needs_owner"].as_bool()), (Some("browse.landed.sign_in"), Some(true)), "{signin}");
        assert!(signin["output"].as_str().unwrap().contains("unbrowse_logins lists a login for signin.example"), "{signin}");

        let carries = open("carries.example", "https://carries.example/signup", "https://carries.example/signup", 200, CHECKED_FORM);
        assert_eq!(carries["output"], "ok", "the page asked for is the page: {carries}");
        assert!(carries["note"].as_str().unwrap().starts_with("This page carries a check for a person"), "{carries}");
        assert!(carries.get("needs_owner").is_none() && carries.get("outcome").is_none(), "{carries}");

        // An address the browser never got a page for (no such host) is a page that isn't there, not a step that failed.
        std::fs::remove_file(fake.join("open.line")).unwrap();
        std::fs::write(fake.join("open.fail"), "page.goto: net::ERR_NAME_NOT_RESOLVED at https://nowhere.example/").unwrap();
        let _door = door_on_page(&home, "nowhere.example", &a, "about:blank");
        let nowhere = step(&rt, &node, &a, &["open", "https://nowhere.example/"], "").unwrap();
        assert_eq!((nowhere["outcome"].as_str(), nowhere["outcome_from"].as_str()), (Some("gone"), Some("browse.landed.status")), "{nowhere}");
        assert!(nowhere["output"].as_str().unwrap().starts_with("The page didn't load"), "{nowhere}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A page that asks for a person at the very address asked is looked at again as it renders; one whose own controls
/// never appear stays a check, said as one, with the agent's own try first.
#[cfg(unix)]
#[test]
fn a_check_standing_in_for_the_page_asked_stays_a_check_after_it_is_looked_at_again() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("check-stands");
        let fake = fake_program(&home);
        let _door = door_on_page(&home, "checks.example", &a, "https://checks.example/x");
        std::fs::write(fake.join("open.line"), document("https://checks.example/x", 429, REFUSED)).unwrap();
        let said = step(&rt, &node, &a, &["open", "https://checks.example/x"], "").unwrap();
        assert_eq!((said["outcome"].as_str(), said["outcome_from"].as_str()), (Some("challenge"), Some("browse.landed.check")), "{said}");
        assert_eq!(said["next"], json!({ "tool": "unbrowse_challenge", "args": { "action": "look", "site": "checks.example" } }), "{said}");
        let log = log_of(&fake);
        let trailing = log.lines().rev().take_while(|l| l.ends_with("snapshot -i")).count();
        assert!(trailing >= 6, "the page was looked at six times in a row while it rendered: {trailing}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A click after which the page shows the same as before changed nothing, and says so, naming the owner; one that set
/// off a download did what it was for.
#[cfg(unix)]
#[test]
fn a_click_that_changed_nothing_is_not_done_unless_it_downloaded_a_file() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("click-same");
        let fake = fake_program(&home);
        let _door = door_on_page(&home, "clicks.example", &a, "https://clicks.example/list");
        step(&rt, &node, &a, &["open", "https://clicks.example/list"], "").unwrap();
        said(&fake, "get", "the same text");
        let same = step(&rt, &node, &a, &["click", "@e1"], "").unwrap();
        assert_eq!((same["outcome"].as_str(), same["outcome_from"].as_str()), (Some("needs_hands"), Some("browse.came_to")), "{same}");
        assert!(same["output"].as_str().unwrap().starts_with("The click changed nothing"), "{same}");
        assert_eq!(same["needs_owner"], true, "{same}");
        std::fs::write(fake.join("click.line"), format!("{}\n", json!({ "type": "download", "name": "report.pdf", "url": "https://clicks.example/r" }))).unwrap();
        let saved = step(&rt, &node, &a, &["click", "@e2"], "").unwrap();
        assert_eq!(saved["output"], "✓ Downloaded report.pdf: the browser saved it to its downloads folder", "{saved}");
        assert!(saved.get("outcome").is_none() && saved.get("needs_owner").is_none(), "{saved}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A script the agent runs that sent a request of its own hears that it is never learned; one that sent none hears
/// nothing of it.
#[cfg(unix)]
#[test]
fn an_eval_that_sent_a_request_hears_that_its_own_calls_are_never_learned() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("eval-sent");
        let fake = fake_program(&home);
        let _door = door_on_page(&home, "evals.example", &a, "https://evals.example/");
        step(&rt, &node, &a, &["open", "https://evals.example/"], "").unwrap();
        let quiet = step(&rt, &node, &a, &["eval", "1+1"], "").unwrap();
        assert!(!quiet["note"].as_str().unwrap_or_default().contains("never learned"), "{quiet}");
        let xhr = json!({ "type": "exchange", "t": 1.0, "resourceType": "XHR", "entry": { "request": { "method": "GET", "url": "https://evals.example/api" } } });
        std::fs::write(fake.join("eval.line"), format!("{xhr}\n")).unwrap();
        let sent = step(&rt, &node, &a, &["eval", "fetch('/api')"], "").unwrap();
        assert!(sent["note"].as_str().unwrap().contains(EVAL_NOTE), "{sent}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A goal said with a step is the flow's: kept for the session on the site, whether the node learns as it browses or
/// not, and an open's goal is the page's own, kept as the page is opened.
#[cfg(unix)]
#[test]
fn a_goal_said_with_a_step_is_kept_for_the_session_on_the_site() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("goal-kept");
        let _fake = fake_program(&home);
        let _door = door_on_page(&home, "goals.example", &a, "https://goals.example/");
        let session = browse_session(&a, &this_session());
        let with_goal = |args: &[&str], goal: &str| {
            let (n, a2, named) = (node.clone(), a.clone(), this_session());
            let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            let goal = goal.to_string();
            rt.block_on(async move { do_browse(&n, &a2, args, "goals.example".into(), goal, &named).await }).unwrap()
        };
        with_goal(&["open", "https://goals.example/"], "read the prices");
        assert_eq!(crate::browse::goal_of("goals.example", &session).as_deref(), Some("read the prices"));
        with_goal(&["snapshot", "-i"], "compare the prices");
        assert_eq!(crate::browse::goal_of("goals.example", &session).as_deref(), Some("compare the prices"));
        // The owner has the node not learn as it browses: the page's own goal is still what the open names.
        store::save_settings(&store::Settings { fetch_browser: false, map_while_browsing: false, ..store::Settings::default() }).unwrap();
        with_goal(&["open", "https://goals.example/other"], "read the stock");
        assert_eq!(crate::browse::goal_of("goals.example", &session).as_deref(), Some("read the stock"));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// An owner's ask is also a command of the browse tool (`ask_owner` among its words): answered as the owner answers.
#[cfg(unix)]
#[test]
fn ask_owner_sent_as_a_browse_command_waits_for_the_owner_and_reports_their_answer() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("ask-as-command");
        let _fake = fake_program(&home);
        let _window = node.events.subscribe_for_test();
        let _door = door_on_page(&home, "ascommand.example", &a, "https://ascommand.example/gate");
        let waiting = owner_answers("ascommand.example", crate::hands::Answer::Done);
        let got = step(&rt, &node, &a, &["ask_owner", "pass the gate"], "ascommand.example").unwrap();
        waiting.join().unwrap();
        assert_eq!((got["owner"].as_str(), got["url"].as_str()), (Some("done"), Some("https://ascommand.example/gate")), "{got}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A login the vault holds is filled as the plain reference when the agent asked for it as `vault:ask:`: the owner is
/// never asked for what is already kept.
#[cfg(unix)]
#[test]
fn a_login_the_vault_already_holds_is_filled_without_asking_the_owner() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("ask-held");
        let fake = fake_program(&home);
        let _window = node.events.subscribe_for_test();
        let _door = door_on_page(&home, "held.example", &a, "https://held.example/login");
        let keep = crate::vault_keep(Ok(node.key().unwrap() as &dyn unbrowse_core::KeyStore)).unwrap();
        vault::add(&keep, "held.example", "me@x.example", "stored", Some("Pw-held-1"), "owner").unwrap();
        step(&rt, &node, &a, &["open", "https://held.example/login"], "").unwrap();
        let (n, a2, named) = (node.clone(), a.clone(), this_session());
        let filled = rt.block_on(async move {
            let args = vec!["fill".to_string(), "@e1".to_string(), "vault:ask:held.example:me@x.example".to_string()];
            tokio::time::timeout(std::time::Duration::from_secs(8), do_browse(&n, &a2, args, "held.example".into(), String::new(), &named)).await
        });
        let filled = filled.expect("the step waited on the owner for a login the vault holds");
        assert!(!crate::hands::asks().iter().any(|x| x.site == "held.example"), "the owner was not asked: {filled:?}");
        let log = log_of(&fake);
        assert!(!log.contains("Pw-held-1") && !log.contains("vault:ask:"), "neither the secret nor the ask went to the browser program: {log}");
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// The owner's yes to a payment, answered from their window: the agent's step goes on only with it, a no or no answer
/// fills nothing, and a site already waiting on the owner is asked about once.
#[cfg(unix)]
#[test]
fn a_payment_goes_ahead_only_on_the_owners_yes_and_a_second_ask_waits_for_the_first() {
    stable(|| {
        use crate::hands::Answer;
        let (home, rt, node, a) = browsing_node("pay-asks");
        let _window = node.events.subscribe_for_test();
        let pay = |merchant: &str| crate::hands::Pay { card: "Visa 4242".into(), merchant: merchant.into(), route: None, inputs: Vec::new(), over: None, amount: Some(12.5) };
        let ask = |site: &'static str, merchant: &'static str| {
            let (n, a2) = (node.clone(), a.clone());
            let p = pay(merchant);
            rt.spawn(async move { ask_to_pay(&n, &a2, site, Some("s"), p).await })
        };
        let wait_for = |site: &str| {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !crate::hands::asks().iter().any(|x| x.site == site) {
                assert!(std::time::Instant::now() < until, "the owner was never asked");
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        };
        // Yes: only the payment the owner approved goes ahead.
        let approving = ask("pay-yes.example", "pay-yes.example");
        wait_for("pay-yes.example");
        assert_eq!(crate::hands::payment_waiting("pay-yes.example").map(|p| p.card), Some("Visa 4242".to_string()));
        let (second, status) = {
            let (n, a2) = (node.clone(), a.clone());
            let p = pay("pay-yes.example");
            let r = rt.block_on(async move { ask_to_pay(&n, &a2, "pay-yes.example", None, p).await });
            (r.clone(), r.err().map(|e| e.0))
        };
        assert_eq!(status, Some(StatusCode::CONFLICT), "{second:?}");
        let owner_pay = crate::hands::payment_waiting("pay-yes.example").unwrap();
        let events = node.events.clone();
        rt.block_on(async { crate::hands::give_back_approving("pay-yes.example", Answer::Done, Some(&owner_pay), &events).await.unwrap() });
        assert!(rt.block_on(approving).unwrap().is_ok());
        // No, and no answer.
        let declining = ask("pay-no.example", "pay-no.example");
        wait_for("pay-no.example");
        crate::hands::answer("pay-no.example", Answer::Declined);
        let (status, said) = rt.block_on(declining).unwrap().expect_err("declined");
        assert_eq!(status, StatusCode::FORBIDDEN, "{said}");
        assert!(said.contains("declined paying with Visa 4242 on pay-no.example") && !said.contains("4242 4242"), "{said}");
        let lapsing = ask("pay-late.example", "pay-late.example");
        wait_for("pay-late.example");
        crate::hands::answer("pay-late.example", Answer::NoAnswer);
        let (status, said) = rt.block_on(lapsing).unwrap().expect_err("lapsed");
        assert_eq!(status, StatusCode::REQUEST_TIMEOUT, "{said}");
        assert!(said.contains("so nothing was filled"), "{said}");
        let log = store::read_activity(200);
        assert!(log.iter().any(|l| l.kind == "vault" && l.site == "pay-no.example" && l.what == "Asked you to approve paying with Visa 4242 on pay-no.example"), "{log:?}");
        // A node that is paused asks nobody.
        store::save_settings(&store::Settings { fetch_browser: false, paused: true, ..store::Settings::default() }).unwrap();
        let (n, a2) = (node.clone(), a.clone());
        let p = pay("pay-paused.example");
        let (status, said) = rt.block_on(async move { ask_to_pay(&n, &a2, "pay-paused.example", None, p).await }).expect_err("paused");
        assert_eq!((status, said.as_str()), (StatusCode::SERVICE_UNAVAILABLE, crate::outcome::PAUSED));
        assert!(!crate::hands::asks().iter().any(|x| x.site == "pay-paused.example"));
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// What a step on a site with a sign-up under way says of its logins.
#[test]
fn a_sign_up_says_which_logins_the_vault_keeps_now_and_which_wait_for_the_site() {
    assert_eq!(sign_up_note(&[], &[]), None);
    let kept = sign_up_note(&["vault:a.example:me".into()], &[]).unwrap();
    assert_eq!(kept, "The site accepted the sign-up: the vault keeps vault:a.example:me now.");
    let waiting = sign_up_note(&[], &["vault:b.example:me".into()]).unwrap();
    assert!(waiting.starts_with("vault:b.example:me is kept once the site accepts the sign-up"), "{waiting}");
    let both = sign_up_note(&["vault:a.example:me".into()], &["vault:b.example:me".into()]).unwrap();
    assert!(both.contains("keeps vault:a.example:me now. vault:b.example:me is kept once"), "{both}");
}

#[cfg(unix)]
#[test]
fn every_role_an_observed_page_names_says_what_it_takes() {
    stable(|| {
        let (home, rt, node, a) = browsing_node("observe-roles");
        let fake = fake_program(&home);
        said(
            &fake,
            "snapshot",
            "\n- searchbox \"Find\" [ref=e1, value=\"lamp\"]\n- select \"Size\" [ref=e2]\n- listbox \"Colour\" [ref=e3]\n- file \"CV\" [ref=e4]\n- switch \"On\" [checked=false, ref=e5]\n- tab \"Tab\" [ref=e6]\n- radio \"Only one\" [ref=e7, disabled=false]\n- paragraph \"Text only\"\n",
        );
        let (n, a2, named) = (node.clone(), a.clone(), this_session());
        let seen = rt.block_on(async move { do_observe(&n, &a2, "roles.example".into(), named, "look".into()).await }).unwrap();
        let els = seen["elements"].as_array().unwrap();
        let actions: Vec<(&str, Value)> = els.iter().map(|e| (e["role"].as_str().unwrap(), e["actions"].clone())).collect();
        assert_eq!(
            actions,
            vec![("searchbox", json!(["fill", "type"])), ("select", json!(["select"])), ("listbox", json!(["select"])), ("file", json!(["upload"])), ("switch", json!(["check", "uncheck"])), ("tab", json!(["click"])), ("radio", json!(["check", "uncheck"]))]
        );
        assert_eq!(els[0]["value"], "lamp");
        assert_eq!(els[4]["checked"], false);
        assert_eq!(els[6]["name"], "Only one");
        assert_eq!(els[6]["disabled"], false);
        drop(rt);
        let _ = std::fs::remove_dir_all(&home);
    });
}

/// A name the browser wrote with a quote inside it (`"A \"q\" one"`) is the whole name, its quotes unescaped: the
/// escaped quote does not end it.
#[test]
fn a_name_with_a_quote_inside_is_read_whole() {
    let els = parse_snapshot("- radio \"A \\\"q\\\" one\" [ref=e7]\n- button \"Go\" [ref=e8]");
    assert_eq!(els.iter().map(|e| e["name"].as_str().unwrap_or_default()).collect::<Vec<_>>(), ["A \"q\" one", "Go"]);
}
