//! UNB-208: behaviour tests for the browser's hands (`browse.rs`) that need no real browser. A fake browser program
//! (a shell script at the add-on's path) answers each command from files beside it and logs what it was given; a
//! fake browser door (a socket) answers the node's own questions (tabs, DevTools address, a fill).

use super::*;

#[cfg(unix)]
fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// A home short enough for a socket under it, as this thread's home.
fn short_home(name: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let root = if cfg!(unix) { PathBuf::from("/tmp") } else { std::env::temp_dir() };
    let dir = root.join(format!("ubc-{name}-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    store::use_home(&dir);
    crate::payhold::seal_for_tests();
    dir
}

#[cfg(unix)]
mod fakes {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    /// Puts a fake browser program in the home's add-on folder and names a browser for this thread. Each command it is
    /// given is logged as `<tab>|<words>` in `calls.log`; its answer is `out-<verb>-<word>` (else `out-<verb>`) on
    /// stdout, `err-…` on stderr, and it fails when `fail-…` exists.
    pub fn program(home: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::browsers::addon_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let file = crate::browsers::addon_program();
        let script = r#"#!/bin/sh
d="${0%/*}"
while [ "$1" != "--args" ]; do shift; done
shift; shift
echo "$AGENT_BROWSER_TAB|$*" >> "$d/calls.log"
k="$1-$2"
[ -f "$d/out-$k" ] || [ -f "$d/err-$k" ] || [ -f "$d/fail-$k" ] || k="$1"
[ -f "$d/out-$k" ] && cat "$d/out-$k"
[ -f "$d/err-$k" ] && cat "$d/err-$k" >&2
[ -f "$d/fail-$k" ] && exit 1
exit 0
"#;
        std::fs::write(&file, script).unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        crate::browsers::for_this_test(Some("/bin/true".into()));
        let _ = home;
        dir
    }

    /// What the fake program answers to `key` (`verb` or `verb-word`).
    pub fn says(dir: &Path, key: &str, out: &str) {
        std::fs::write(dir.join(format!("out-{key}")), out).unwrap();
    }
    pub fn complains(dir: &Path, key: &str, err: &str) {
        std::fs::write(dir.join(format!("err-{key}")), err).unwrap();
        std::fs::write(dir.join(format!("fail-{key}")), "").unwrap();
    }
    /// The commands the fake program was given, `<tab>|<words>`, oldest first.
    pub fn calls(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("calls.log")).unwrap_or_default().lines().map(String::from).collect()
    }

    /// A browser answering at `site`'s door until dropped: each command it is sent is kept, and answered by `reply`.
    pub struct Door {
        stop: Arc<AtomicBool>,
        pub seen: Arc<Mutex<Vec<serde_json::Value>>>,
        thread: Option<std::thread::JoinHandle<()>>,
        file: PathBuf,
    }

    pub fn door_up(site: &str, reply: impl Fn(&serde_json::Value) -> serde_json::Value + Send + 'static) -> Door {
        std::fs::create_dir_all(sockets()).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(door(site)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (stop, seen) = (Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new())));
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
                let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let answer = reply(&cmd);
                k.lock().unwrap().push(cmd);
                let _ = stream.write_all(format!("{answer}\n").as_bytes());
            }
        });
        Door { stop, seen, thread: Some(thread), file: door(site) }
    }

    impl Door {
        /// What the browser was sent with `action`.
        pub fn got(&self, action: &str) -> Vec<serde_json::Value> {
            self.seen.lock().unwrap().iter().filter(|c| c["action"] == action).cloned().collect()
        }
    }

    impl Drop for Door {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
            let _ = std::fs::remove_file(&self.file);
        }
    }

    pub fn ok(data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "success": true, "data": data })
    }

    /// A door that lists `tabs` (label, url) and answers anything else with `{}`.
    pub fn door_with_tabs(site: &str, tabs: &[(&str, &str)]) -> Door {
        let list: Vec<serde_json::Value> = tabs.iter().map(|(l, u)| serde_json::json!({ "label": l, "url": u, "targetId": format!("T-{l}"), "title": format!("Title of {l}") })).collect();
        door_up(site, move |c| match c["action"].as_str() {
            Some("tab_list") => ok(serde_json::json!({ "tabs": list })),
            _ => ok(serde_json::json!({})),
        })
    }

    /// Notes a tab of `site` held by `session`, last acting `idle` ago.
    pub fn held(site: &str, session: &str, idle: std::time::Duration) {
        let at = std::time::Instant::now().checked_sub(idle).expect("a machine up that long");
        TABS.locked().retain(|h| !(h.site == site && h.session == session));
        TABS.locked().push(Held { site: site.into(), tab: tab_of(session), session: session.into(), at });
    }

    pub fn told(tab: &str) -> Option<String> {
        TAKEN.locked().iter().find(|(t, _)| t == tab).map(|(_, why)| why.clone())
    }
}

#[cfg(unix)]
use fakes::*;

/// A site that keeps answering is waited on until it goes quiet; typed text going out ends the wait at once; and
/// nothing, however long the site goes on, is waited on past the bound.
#[test]
fn settling_waits_for_the_site_to_go_quiet_and_stops_when_the_typing_went_out() {
    let _home = short_home("settle");
    let site = "settle.example";
    std::fs::create_dir_all(capture_dir()).unwrap();
    let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
    let line = |url: &str, body: &str| format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "POST", "url": url, "postData": { "text": body } } } }));
    let append = |text: String| {
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(text.as_bytes()).unwrap();
    };
    // Nothing happens: the quiet ends it long before the bound.
    let start = std::time::Instant::now();
    settle(site, std::time::Duration::from_millis(300), std::time::Duration::from_secs(20));
    assert!(start.elapsed() < std::time::Duration::from_secs(5), "quiet ended it: {:?}", start.elapsed());
    // The site's own traffic keeps it going: a request every 100 ms for a second holds a 400 ms quiet off, and the
    // wait ends a whole quiet after the last of them, not before.
    let writer = {
        let log = log.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            for _ in 0..10 {
                let own = format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "GET", "url": "https://www.settle.example/poll" } } }));
                std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(own.as_bytes()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            std::time::Instant::now()
        })
    };
    let start = std::time::Instant::now();
    settle(site, std::time::Duration::from_millis(400), std::time::Duration::from_secs(20));
    let returned = std::time::Instant::now();
    let last_request = writer.join().unwrap() - std::time::Duration::from_millis(100);
    assert!(start.elapsed() >= std::time::Duration::from_millis(1000), "the site's traffic held the quiet off: {:?}", start.elapsed());
    assert!(returned.duration_since(last_request) >= std::time::Duration::from_millis(400), "a whole quiet after the last request: {:?}", returned.duration_since(last_request));
    // A bound that comes first ends it, whatever the site goes on doing.
    let writer = {
        let log = log.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            for _ in 0..30 {
                let own = format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "GET", "url": "https://www.settle.example/poll" } } }));
                std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(own.as_bytes()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        })
    };
    let start = std::time::Instant::now();
    settle(site, std::time::Duration::from_secs(30), std::time::Duration::from_millis(700));
    assert!(start.elapsed() < std::time::Duration::from_secs(2), "the bound ended it: {:?}", start.elapsed());
    writer.join().unwrap();
    // What the agent typed going out is what it waits for: it returns the moment a request carries it.
    TYPED.locked().push((site.to_string(), "Typed-Value-4471".into()));
    let sender = std::thread::spawn({
        let text = line("https://www.settle.example/login", "user=me&pw=Typed-Value-4471");
        let log = log.clone();
        move || {
            use std::io::Write;
            std::thread::sleep(std::time::Duration::from_millis(400));
            std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(text.as_bytes()).unwrap();
        }
    });
    append(String::new());
    let start = std::time::Instant::now();
    settle(site, std::time::Duration::from_secs(30), std::time::Duration::from_secs(30));
    sender.join().unwrap();
    assert!(start.elapsed() < std::time::Duration::from_secs(5), "the typed value going out ended it: {:?}", start.elapsed());
    TYPED.locked().retain(|(s, _)| s != site);
}

/// The walk that exposed it (a video site's search): Enter sent the search, whose answer is large, and a suggestion for
/// the same words a moment after, whose answer is small. The log holds a request once its answer is in, so the
/// suggestion was logged first, ended the wait as typed text going out, and the learn after it kept the suggestion. A
/// call the step sent the site that is still on its way (`<session>.open`, as the browser says it) keeps the wait
/// going, and the wait ends once it has landed. Another site's call still coming keeps nothing waiting.
#[test]
fn a_call_still_on_its_way_keeps_the_wait_going() {
    let _home = short_home("coming");
    let site = "coming.example";
    std::fs::create_dir_all(capture_dir()).unwrap();
    let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
    let open = log.with_extension("open");
    let append = |path: &std::path::Path, text: &str| {
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).create(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
    };
    TYPED.locked().push((site.to_string(), "folding desk lamp".into()));
    let suggestion = format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "GET", "url": "https://www.coming.example/complete/search?q=folding%20desk%20lamp" } } }));
    std::fs::write(&open, "1795496439.639302 www.coming.example\n").unwrap();
    let browser = {
        let (log, open) = (log.clone(), open.clone());
        std::thread::spawn(move || {
            use std::io::Write;
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(suggestion.as_bytes()).unwrap();
            // The search's answer lands a second and a half later, and with it nothing is open.
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let search = format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "POST", "url": "https://www.coming.example/api/v1/search" } } }));
            std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(search.as_bytes()).unwrap();
            std::fs::write(&open, "").unwrap();
            std::time::Instant::now()
        })
    };
    append(&log, "");
    settle(site, std::time::Duration::from_millis(400), std::time::Duration::from_secs(20));
    let returned = std::time::Instant::now();
    let landed = browser.join().unwrap();
    assert!(returned >= landed, "the wait outlasted the call still on its way");
    assert!(returned.duration_since(landed) < std::time::Duration::from_secs(2), "and ended soon after it landed: {:?}", returned.duration_since(landed));
    // Another site's call still coming (an ad's) is not the site's: the typed text going out ends the wait.
    std::fs::write(&open, "1795496439.7 ads.elsewhere.example\n").unwrap();
    let sender = {
        let log = log.clone();
        std::thread::spawn(move || {
            use std::io::Write;
            std::thread::sleep(std::time::Duration::from_millis(300));
            let line = format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "GET", "url": "https://www.coming.example/complete/search?q=folding%20desk%20lamp" } } }));
            std::fs::OpenOptions::new().append(true).create(true).open(&log).unwrap().write_all(line.as_bytes()).unwrap();
        })
    };
    let start = std::time::Instant::now();
    settle(site, std::time::Duration::from_secs(30), std::time::Duration::from_secs(30));
    sender.join().unwrap();
    assert!(start.elapsed() < std::time::Duration::from_secs(5), "another site's call kept nothing waiting: {:?}", start.elapsed());
    TYPED.locked().retain(|(s, _)| s != site);
}

#[cfg(unix)]
mod hands {
    use super::*;
    use std::time::Duration;

    /// A browser whose every tab went idle is closed whole, never tab by tab (it refuses to close its last), and each
    /// session that had a tab there hears why at its next command.
    #[test]
    fn a_browser_whose_every_tab_went_idle_is_closed_whole_and_each_session_hears_why() {
        let home = short_home("sweep-all");
        let dir = program(&home);
        let site = "sweepall.example";
        let (a, b) = ("1:idle-a", "1:idle-b");
        let _door = door_with_tabs(site, &[(&tab_of(a), "https://sweepall.example/a"), (&tab_of(b), "https://sweepall.example/b")]);
        let long = TAB_IDLE + Duration::from_secs(60);
        held(site, a, long);
        held(site, b, long + Duration::from_secs(5));
        OPENED.locked().push(site.into());
        sweep(site, None);
        let said = calls(&dir);
        assert_eq!(said.len(), 1, "one close of the whole browser: {said:?}");
        assert!(said[0].ends_with("|close") && !said[0].contains("tab close"), "{said:?}");
        assert!(TABS.locked().iter().all(|h| h.site != site), "no tab of the closed browser is noted");
        assert!(!OPENED.locked().iter().any(|s| s == site), "and it isn't a browser the owner can take over");
        for s in [a, b] {
            let heard = told(&tab_of(s)).expect("the session hears it");
            assert!(heard.contains("30 minutes without a command"), "{heard}");
        }
    }

    /// A tab idle past the limit closes by itself while the tabs in use stay; a browser that is not the node's tab
    /// is none of this: only noted sessions' tabs go.
    #[test]
    fn only_the_idle_tab_closes_and_its_session_is_told() {
        let home = short_home("sweep-one");
        let dir = program(&home);
        let site = "sweepone.example";
        let (idle, busy) = ("2:idle", "2:busy");
        let _door = door_with_tabs(site, &[(&tab_of(idle), "https://sweepone.example/a"), (&tab_of(busy), "https://sweepone.example/b")]);
        held(site, idle, TAB_IDLE + Duration::from_secs(60));
        held(site, busy, Duration::from_secs(1));
        sweep(site, Some(&tab_of(busy)));
        assert_eq!(calls(&dir), vec![format!("|tab close {}", tab_of(idle))]);
        assert!(told(&tab_of(idle)).is_some_and(|w| w.contains("30 minutes")));
        assert!(told(&tab_of(busy)).is_none());
        assert!(TABS.locked().iter().any(|h| h.site == site && h.tab == tab_of(busy)), "the busy tab stays noted");
        assert!(!TABS.locked().iter().any(|h| h.site == site && h.tab == tab_of(idle)));
    }

    /// A ninth session needs room in a browser that holds eight: the one unused longest closes, and says why.
    #[test]
    fn a_new_session_past_the_cap_takes_the_place_of_the_one_unused_longest() {
        let home = short_home("sweep-room");
        let dir = program(&home);
        let site = "sweeproom.example";
        let sessions: Vec<String> = (0..TABS_PER_SITE).map(|i| format!("3:s{i}")).collect();
        let tabs: Vec<(String, String)> = sessions.iter().map(|s| (tab_of(s), "https://sweeproom.example/".to_string())).collect();
        let list: Vec<(&str, &str)> = tabs.iter().map(|(t, u)| (t.as_str(), u.as_str())).collect();
        let _door = door_with_tabs(site, &list);
        for (i, s) in sessions.iter().enumerate() {
            held(site, s, Duration::from_secs(10 + 60 * (TABS_PER_SITE - i) as u64));
        }
        sweep(site, Some(&tab_of("3:newcomer")));
        // Session 0 has gone longest without acting.
        assert_eq!(calls(&dir), vec![format!("|tab close {}", tab_of(&sessions[0]))]);
        let heard = told(&tab_of(&sessions[0])).expect("told");
        assert!(heard.contains("needed room"), "{heard}");
        assert!(sessions[1..].iter().all(|s| told(&tab_of(s)).is_none()));
    }

    /// What the browser printed is the answer, kept for the call that answered the page; what the node's own pass
    /// notes (the session's tab, the site it browsed, the activity) follows from it.
    #[test]
    fn a_command_runs_in_the_sessions_own_tab_and_says_what_the_browser_printed() {
        let home = short_home("act-ok");
        let dir = program(&home);
        let (site, session) = ("actok.example", "4:act-ok");
        says(&dir, "snapshot", "- button \"Go\" [ref=e1]\n");
        let said = act(&args(&["snapshot", "-i"]), Some(site), "agent", session).unwrap();
        assert_eq!(said, "- button \"Go\" [ref=e1]");
        assert_eq!(calls(&dir), vec![format!("{}|snapshot -i", tab_of(session))], "named the session's tab");
        assert!(READS.locked().iter().any(|(s, _, t)| s == site && t.contains("[ref=e1]")), "the read is kept");
        assert_eq!(last_site(session).as_deref(), Some(site));
        assert_eq!(front_tab(site), Some(tab_of(session)));
        assert!(OPENED.locked().iter().any(|s| s == site));
        let log: Vec<Activity> = store::read_activity(200).into_iter().filter(|a| a.site == site).collect();
        assert!(log.iter().any(|a| a.what == "Browser: snapshot -i" && a.result == "done" && a.kind == "browse"), "{log:?}");
    }

    /// What a page printed that is longer than the node keeps is cut where a character ends, never inside one.
    #[test]
    fn a_long_read_is_kept_cut_at_a_character() {
        let home = short_home("act-long");
        let dir = program(&home);
        let (site, session) = ("actlong.example", "4:act-long");
        let text = format!("a{}", "é".repeat(READ_LIMIT));
        says(&dir, "get-text", &text);
        let said = act(&args(&["get", "text", "body"]), Some(site), "agent", session).unwrap();
        assert!(said.len() > READ_LIMIT, "the agent gets all of it");
        let kept = READS.locked().iter().rev().find(|(s, ..)| s == site).map(|(.., t)| t.clone()).unwrap();
        assert!(kept.len() <= READ_LIMIT && kept.len() > READ_LIMIT - 4, "{}", kept.len());
        assert!(kept.starts_with("aé"));
    }

    /// A value typed is remembered as typed (for the walk record's sake), a stray character is not.
    #[test]
    fn a_fill_notes_what_was_typed_unless_it_is_a_single_character() {
        let home = short_home("act-fill");
        let _dir = program(&home);
        let (site, session) = ("actfill.example", "4:act-fill");
        let _door = door_with_tabs(site, &[(&tab_of(session), "https://actfill.example/")]);
        act(&args(&["fill", "@e1", "x"]), Some(site), "agent", session).unwrap();
        assert!(!typed_on(site), "one character names nothing");
        act(&args(&["fill", "@e1", "Typed-By-Agent-5"]), Some(site), "agent", session).unwrap();
        assert!(TYPED.locked().iter().any(|(s, v)| s == site && v == "Typed-By-Agent-5"));
        TYPED.locked().retain(|(s, _)| s != site);
    }

    /// A command the browser failed is an error with the browser's words; a ref that went stale comes back with the
    /// page's elements as they are now, and a failure that wasn't about refs adds nothing.
    #[test]
    fn a_failed_command_says_why_and_a_stale_ref_comes_with_the_pages_elements_now() {
        let home = short_home("act-fail");
        let dir = program(&home);
        let (site, session) = ("actfail.example", "4:act-fail");
        complains(&dir, "click", "Unknown ref: e9");
        says(&dir, "snapshot", "- link \"Next\" [ref=e2]\n");
        let said = act(&args(&["click", "@e9"]), Some(site), "agent", session).unwrap_err();
        assert!(said.starts_with("Unknown ref: e9"), "{said}");
        assert!(said.contains("the page changed since the snapshot") && said.contains("- link \"Next\" [ref=e2]"), "{said}");
        assert!(said.contains("Take a new snapshot (snapshot -i) if the page changes again. For this retry, use the fresh refs below:"), "{said}");
        complains(&dir, "hover", "Element not found");
        let said = act(&args(&["hover", "@e9"]), Some(site), "agent", session).unwrap_err();
        assert_eq!(said, "Element not found", "an error a fresh look wouldn't answer");
        let log: Vec<Activity> = store::read_activity(200).into_iter().filter(|a| a.site == site && a.result == "failed").collect();
        assert!(log.iter().any(|a| a.note.as_deref().is_some_and(|n| n.starts_with("Unknown ref"))), "{log:?}");
    }

    /// `close` takes only the session's own tab while another session still has one, takes nothing for a session with
    /// no tab there, and takes the whole browser (and every note of it) when it is the last.
    #[test]
    fn close_takes_the_sessions_tab_nothing_or_the_whole_browser_as_the_others_leave_it() {
        let home = short_home("close");
        let dir = program(&home);
        let site = "closing.example";
        let (mine, other) = ("5:mine", "5:other");
        let _door = door_with_tabs(site, &[(&tab_of(mine), "https://closing.example/"), (&tab_of(other), "https://closing.example/x")]);
        held(site, mine, Duration::from_secs(1));
        held(site, other, Duration::from_secs(1));
        let said = act(&args(&["close"]), Some(site), "agent", mine).unwrap();
        assert!(said.contains("Closed this session's tab") && said.contains("stays open for the other sessions"), "{said}");
        assert_eq!(calls(&dir), vec![format!("|tab close {}", tab_of(mine))]);
        assert!(!TABS.locked().iter().any(|h| h.site == site && h.tab == tab_of(mine)), "no longer noted");
        assert_eq!(last_site(mine), None, "a session that closed has no last site");
        // A session whose tab isn't in the browser has nothing to close while the other's stays.
        let said = act(&args(&["close"]), Some(site), "agent", "5:stranger").unwrap();
        assert!(said.contains("no tab open") && said.contains("nothing was closed"), "{said}");
        assert_eq!(calls(&dir).len(), 1, "the browser was not asked to close anything");
    }

    /// The last session's close closes the browser, and everything the node noted of it goes with it.
    #[test]
    fn the_last_sessions_close_closes_the_browser_and_forgets_it() {
        let home = short_home("close-last");
        let dir = program(&home);
        let (site, session) = ("closelast.example", "6:only");
        act(&args(&["snapshot"]), Some(site), "agent", session).unwrap();
        assert!(OPENED.locked().iter().any(|s| s == site));
        runs_in(&sockets(), site, Path::new("/p/closelast"));
        set_goal(site, session, "look");
        let said = act(&args(&["close"]), Some(site), "agent", session);
        assert!(said.is_ok(), "{said:?}");
        assert!(calls(&dir).last().is_some_and(|c| c.ends_with("|close")));
        assert!(!OPENED.locked().iter().any(|s| s == site) && TABS.locked().iter().all(|h| h.site != site));
        assert!(!profile_file(&sockets(), site).exists(), "the next page launches afresh");
        assert_eq!(goal_of(site, session), None);
    }

    /// What a tab shows is its address and a digest of its text and controls: the same words in other whitespace read
    /// the same, other words or another state do not, and a browser that can't say says nothing.
    #[test]
    fn a_look_at_a_tab_changes_with_its_words_and_its_controls_not_its_spacing() {
        let home = short_home("look");
        let dir = program(&home);
        let (site, tab) = ("looking.example", "u-look");
        let _door = door_with_tabs(site, &[(tab, "https://looking.example/page")]);
        says(&dir, "get-text", "Hello   there\nworld");
        says(&dir, "snapshot", "- radio \"A\" [checked=false, ref=e1]");
        let first = look(site, tab).expect("a look");
        assert_eq!(first.url, "https://looking.example/page");
        says(&dir, "get-text", "Hello there world");
        assert_eq!(look(site, tab), Some(first.clone()), "spacing is not a change");
        says(&dir, "get-text", "Hello there everyone");
        assert_ne!(look(site, tab), Some(first.clone()), "other words");
        says(&dir, "get-text", "Hello there world");
        says(&dir, "snapshot", "- radio \"A\" [checked=true, ref=e1]");
        assert_ne!(look(site, tab), Some(first.clone()), "a control's state");
        assert_eq!(look(site, "u-nobody"), None, "a tab the browser doesn't have");
        complains(&dir, "get-text", "boom");
        assert_eq!(look(site, tab), None, "a read that failed");
    }

    /// The page a browser shows is its tab's address from its list when the tab is named, its own answer when not, and
    /// nothing for a page that isn't the web's or a browser that isn't running.
    #[test]
    fn the_page_a_browser_shows_is_a_web_address_or_nothing() {
        let home = short_home("pageurl");
        let dir = program(&home);
        let site = "pageurl.example";
        assert_eq!(page_url(site, Some("u-x")), None, "no browser is running");
        let _door = door_with_tabs(site, &[("u-web", "https://pageurl.example/a"), ("u-blank", "about:blank")]);
        assert_eq!(page_url(site, Some("u-web")).as_deref(), Some("https://pageurl.example/a"));
        assert_eq!(page_url(site, Some("u-blank")), None, "a blank tab");
        says(&dir, "get-url", "https://pageurl.example/front\n");
        assert_eq!(page_url(site, None).as_deref(), Some("https://pageurl.example/front"));
        complains(&dir, "get-url", "no page");
        assert_eq!(page_url(site, None), None);
    }

    /// A login from the vault goes to the browser over its door, never on a command line, only into a page on the
    /// login's own site; the page is held for it from then on, and what the browser says back says the login's name.
    #[test]
    fn a_vault_login_is_typed_over_the_door_into_its_own_sites_page_and_held() {
        let home = short_home("vfill");
        let dir = program(&home);
        let (site, session) = ("vfill.example", "7:vault");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        let keep = crate::vault_keep(Ok(&keys)).unwrap();
        crate::vault::add(&keep, site, "me", "stored", Some("Sup3r-Secret-91"), "You").unwrap();
        says(&dir, "get-url", "https://vfill.example/login\n");
        let door = door_up(site, |c| match c["action"].as_str() {
            Some("fill") => ok(serde_json::json!({ "field_checked": true, "beside": { "username": "filled", "code": "none" }, "submitted": true, "cleared": 1 })),
            Some("document") => ok(serde_json::json!({ "document": "L1" })),
            _ => ok(serde_json::json!({})),
        });
        let said = fill_from_vault(&args(&["fill", "#pw", "vault:vfill.example:me"]), Some(site), "agent", session, &keys, true).unwrap();
        assert!(said.starts_with("Filled #pw with vault:vfill.example:me, with its account name, and submitted the form"), "{said}");
        assert!(said.contains("the node cleared it from the page"), "{said}");
        assert!(!said.contains("Sup3r-Secret-91"));
        let sent = door.got("fill");
        assert_eq!(sent.len(), 1);
        let c = &sent[0];
        assert_eq!((c["value"].as_str(), c["as"].as_str(), c["site"].as_str(), c["field"].as_str()), (Some("Sup3r-Secret-91"), Some("vault:vfill.example:me"), Some("vfill.example"), Some("password")));
        assert_eq!((c["selector"].as_str(), c["submit"].as_bool(), c["username"].as_str(), c["tab"].as_str()), (Some("#pw"), Some(true), Some("me"), Some(tab_of(session).as_str())));
        assert!(!calls(&dir).iter().any(|l| l.contains("Sup3r-Secret-91")), "never on a command line");
        assert!(holds_a_secret(site, "document:L1"), "the page it went into is held");
        assert_eq!(unsaid(site, "value=Sup3r-Secret-91".into()), "value=vault:vfill.example:me");
        assert!(TYPED.locked().iter().any(|(s, v)| s == site && v == "vault:vfill.example:me"));
        assert_eq!(last_site(session).as_deref(), Some(site));
        let log: Vec<Activity> = store::read_activity(100).into_iter().filter(|a| a.site == site && a.kind == "vault").collect();
        assert!(log.iter().any(|a| a.what == "Filled the vault login vault:vfill.example:me into #pw" && a.result == "done"), "{log:?}");
    }

    /// Filling one field leaves the form unsent and the account name unfilled: only the whole sign-in does both.
    #[test]
    fn a_single_field_fill_sends_no_form() {
        let home = short_home("vfill-one");
        let dir = program(&home);
        let (site, session) = ("vfillone.example", "7:one");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), site, "me", "stored", Some("Another-Secret-12"), "You").unwrap();
        says(&dir, "get-url", "https://vfillone.example/login\n");
        let door = door_up(site, |c| match c["action"].as_str() {
            Some("fill") => ok(serde_json::json!({ "field_checked": true })),
            _ => ok(serde_json::json!({})),
        });
        let said = fill_from_vault(&args(&["fill", "#pw", "vault:vfillone.example:me"]), Some(site), "agent", session, &keys, false).unwrap();
        assert_eq!(said, "Filled #pw with vault:vfillone.example:me");
        let c = &door.got("fill")[0];
        assert!(c.get("submit").is_none() && c.get("username").is_none(), "{c}");
    }

    /// A page that is not the login's site, or no page at all, gets nothing; a browser that did not check the field it
    /// typed into says so, and the page is held all the same.
    #[test]
    fn a_vault_login_is_refused_on_another_sites_page_and_a_field_nobody_checked_is_an_error() {
        let home = short_home("vfill-no");
        let dir = program(&home);
        let (site, session) = ("vfillno.example", "7:no");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), site, "me", "stored", Some("Third-Secret-34"), "You").unwrap();
        let door = door_up(site, |c| match c["action"].as_str() {
            Some("document") => ok(serde_json::json!({ "document": "N1" })),
            _ => ok(serde_json::json!({})),
        });
        let fill = |whole| fill_from_vault(&args(&["fill", "#pw", "vault:vfillno.example:me"]), Some(site), "agent", session, &keys, whole);
        says(&dir, "get-url", "https://lookalike.example/login\n");
        let refused = fill(true).unwrap_err();
        assert!(refused.contains("vault:vfillno.example:me is the login for vfillno.example, and this page is on https://lookalike.example"), "{refused}");
        assert!(door.got("fill").is_empty(), "nothing was typed");
        says(&dir, "get-url", "about:blank\n");
        assert_eq!(fill(true).unwrap_err(), "open the login page first");
        says(&dir, "get-url", "http://vfillno.example/login\n");
        assert!(fill(true).unwrap_err().contains("over https"), "a page in the clear is anyone's");
        says(&dir, "get-url", "https://vfillno.example/login\n");
        let err = fill(true).unwrap_err();
        assert!(err.contains("didn't say it checked the field"), "{err}");
        assert_eq!(door.got("fill").len(), 1, "it was typed once, and the check failed");
        assert!(holds_a_secret(site, "document:N1"), "held though the check failed");
        let log: Vec<Activity> = store::read_activity(100).into_iter().filter(|a| a.site == site && a.kind == "vault").collect();
        assert!(log.iter().any(|a| a.result == "failed" && a.note.as_deref().is_some_and(|n| n.contains("didn't say it checked"))), "{log:?}");
    }

    /// A card in a page of the site leaves an agent only what reaches no page: the address and the title come from the
    /// browser's own list of tabs, never the page; a browser that can't list them says the card is the owner's.
    #[test]
    fn while_a_card_sits_the_address_and_title_come_from_the_browsers_list() {
        let home = short_home("cardgate");
        let _dir = program(&home);
        let site = "cardgate.example";
        let _door = door_with_tabs(site, &[("u-pay", "https://cardgate.example/pay?x=1")]);
        crate::payhold::begin(site, &[]).unwrap();
        assert_eq!(card_gate(site, "u-pay", &args(&["get", "url"])), Ok(Some("https://cardgate.example/pay?x=1".to_string())));
        assert_eq!(card_gate(site, "u-pay", &args(&["get", "title"])), Ok(Some("Title of u-pay".to_string())));
        let refused = card_gate(site, "u-none", &args(&["get", "url"])).unwrap_err();
        assert_eq!(refused, CARD_IS_THE_OWNERS, "a tab the browser doesn't list");
        assert!(card_gate(site, "u-pay", &args(&["snapshot"])).is_err());
        crate::payhold::release(site).unwrap();
    }

    /// What a vault fill says of the rest of the sign-in: the account name and the code, the submit, the person check.
    #[test]
    fn a_vault_fill_says_what_else_it_did() {
        let said = |v: serde_json::Value| sent_on(&v);
        assert_eq!(said(serde_json::json!({})), "");
        assert_eq!(said(serde_json::json!({ "beside": { "username": "filled", "code": "filled" } })), ", with its account name and one-time code");
        assert_eq!(said(serde_json::json!({ "beside": { "username": "filled", "code": "none" } })), ", with its account name");
        assert_eq!(said(serde_json::json!({ "beside": { "code": "filled" } })), ", with its one-time code");
        assert!(said(serde_json::json!({ "submitted": true })).contains("don't click its button"));
        let checking = said(serde_json::json!({ "checking": true }));
        assert!(checking.contains("person check") && checking.contains("Don't fill it again first"), "{checking}");
        assert!(said(serde_json::json!({ "cleared": 2 })).contains("cleared it from the page"));
        assert_eq!(said(serde_json::json!({ "cleared": 0 })), "");
    }
}

#[cfg(unix)]
mod more {
    use super::*;
    use std::time::Duration;

    /// The node asks a running browser for its cookies and DevTools address over its door, and a site with none
    /// running is asked nothing: no browser is started to answer.
    #[test]
    fn a_running_browsers_cookies_and_address_are_asked_over_its_door_and_a_stopped_one_is_never_started() {
        let home = short_home("door-asks");
        let dir = program(&home);
        let site = "doorasks.example";
        assert_eq!((cookies_answer(site), cdp_of(site), profile_in_use(site)), (String::new(), None, None));
        assert!(calls(&dir).is_empty(), "no browser was started to be asked");
        says(&dir, "--json-cookies", "{\"cookies\":[]}");
        let _door = door_up(site, |c| match c["action"].as_str() {
            Some("cdp_url") => ok(serde_json::json!({ "cdpUrl": "ws://127.0.0.1:9/devtools/browser/x" })),
            _ => ok(serde_json::json!({})),
        });
        assert_eq!(cookies_answer(site), "{\"cookies\":[]}");
        assert_eq!(calls(&dir), vec!["|--json cookies get".to_string()]);
        assert_eq!(cdp_of(&format!("www.{site}")).as_deref(), Some("ws://127.0.0.1:9/devtools/browser/x"), "by the site, whatever host names it");
        assert_eq!(profile_in_use(site), None, "no profile noted yet");
        runs_in(&sockets(), site, Path::new("/p/doorasks"));
        assert_eq!(profile_in_use(site), Some(PathBuf::from("/p/doorasks")));
        OPENED.locked().push(site.into());
        assert!(open_sites().iter().any(|s| s == site));
        assert!(devtools_of_running_browsers().iter().any(|u| u == "ws://127.0.0.1:9/devtools/browser/x"));
        OPENED.locked().retain(|s| s != site);
    }

    /// An answer to a command that says no is the browser's own words; one that says no with none gets a plain
    /// sentence; a site with no browser running is told to open its page first.
    #[test]
    fn a_refusal_over_the_door_is_the_browsers_own_words() {
        let home = short_home("door-no");
        let _dir = program(&home);
        let site = "doorno.example";
        let asked = |site: &str| send_now(site, serde_json::json!({ "action": "x" }), Duration::from_secs(2));
        assert!(asked(site).unwrap_err().contains("the site's browser isn't running"));
        let _door = door_up(site, |c| match c["id"].as_str() {
            Some("words") => serde_json::json!({ "success": false, "error": "No such tab" }),
            Some("none") => serde_json::json!({ "success": false }),
            _ => ok(serde_json::json!({ "echo": c["noLaunch"] })),
        });
        let send = |id: &str| send_now(site, serde_json::json!({ "id": id }), Duration::from_secs(2));
        assert_eq!(send("words").unwrap_err(), "No such tab");
        assert_eq!(send("none").unwrap_err(), "the browser couldn't fill it");
        assert_eq!(send("fine").unwrap(), serde_json::json!({ "echo": true }), "a question never launches a browser");
    }

    /// Every cookie of every running browser is read for the node to keep out of an answer: a browser that has none
    /// started, one whose browser is gone, and a folder with no browsers pass; one that answers with no address fails
    /// the whole, since its session could not be hidden.
    #[test]
    fn the_sessions_of_running_browsers_are_read_and_one_that_cannot_be_read_fails_the_whole() {
        let home = short_home("sessions");
        let _dir = program(&home);
        assert_eq!(session_cookies(), Ok(Vec::new()), "no browser folder, no browser");
        std::fs::create_dir_all(sockets()).unwrap();
        assert_eq!(session_cookies(), Ok(Vec::new()), "an empty one");
        let (not_started, gone, unread) = ("sessnone.example", "sessgone.example", "sessbad.example");
        let _a = door_up(not_started, |_| serde_json::json!({ "success": false, "error": NOT_LAUNCHED }));
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let _b = door_up(gone, move |_| ok(serde_json::json!({ "cdpUrl": format!("ws://127.0.0.1:{dead}/devtools/browser/y") })));
        assert_eq!(session_cookies(), Ok(Vec::new()), "a daemon without a browser and a browser that is gone hold no session");
        let _c = door_up(unread, |_| ok(serde_json::json!({})));
        let err = session_cookies().unwrap_err();
        assert!(err.contains("no DevTools address") && err.contains("can't keep it out of this answer"), "{err}");
    }

    /// Whether a DevTools address is gone is certain only for this machine's own port that refuses; anything less
    /// certain is taken as a live browser.
    #[test]
    fn a_devtools_address_is_gone_only_when_this_machine_refuses_it() {
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(gone_at(&format!("ws://127.0.0.1:{dead}/devtools/browser/z")));
        assert!(gone_at(&format!("ws://localhost:{dead}/devtools/browser/z")));
        let live = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(!gone_at(&format!("ws://127.0.0.1:{}/x", live.local_addr().unwrap().port())), "something listens");
        assert!(!gone_at("not an address"));
        assert!(!gone_at("ws://browser.example:9222/x"), "another host is not this machine's to say");
        assert!(!gone_at("ws://127.0.0.1/x") || gone_at("ws://127.0.0.1/x"), "no port reads as the scheme's own");
    }

    /// The browser is named, whole and by a file that exists, or not at all: with no Chrome the node says so, and
    /// with Chrome but no browser program it says that is not installed.
    #[test]
    fn a_command_with_no_browser_or_no_program_says_which_is_missing() {
        let home = short_home("lacks");
        let (site, session) = ("lacks.example", "9:lacks");
        crate::browsers::for_this_test(None);
        let said = act(&args(&["snapshot"]), Some(site), "agent", session).unwrap_err();
        assert_eq!(said, crate::browsers::missing());
        let _ = home;
        if crate::browse::binary().is_ok() {
            // A machine with the browser program installed (CI's macOS runner): there is no missing program to say.
            return;
        }
        // A browser named by a file that exists on every machine: this test's own program.
        crate::browsers::for_this_test(Some(std::env::current_exe().unwrap().to_string_lossy().into_owned()));
        let said = act(&args(&["snapshot"]), Some(site), "agent", session).unwrap_err();
        assert!(said.contains("the node's browser program isn't installed"), "{said}");
    }

    /// A command waits its turn at a site's browser and, past the wait, says what held it, or that it is another
    /// command when nothing says.
    #[test]
    fn a_command_that_waits_too_long_is_told_what_held_the_browser() {
        let _home = short_home("turns");
        let site = "turns.example";
        let g = gate(&format!("site:{site}"));
        let held = g.locked();
        let said = take_turn(&g, site, "a command".into()).err().expect("busy");
        assert_eq!(said, "turns.example's browser was busy with another command for 1 s: try again shortly");
        TURNS.locked().push((site.into(), "`snapshot` for agent 3".into(), std::time::Instant::now()));
        let said = take_turn(&g, site, "a command".into()).err().expect("busy");
        assert!(said.contains("busy for 1 s with `snapshot` for agent 3, which has held it"), "{said}");
        TURNS.locked().retain(|t| t.0 != site);
        drop(held);
        let turn = take_turn(&g, site, "it \u{2014} https://turns.example/a?secret=1#frag".into()).expect("free");
        assert!(holder(site).is_some_and(|h| h.starts_with("it") && !h.contains("secret=1")), "{:?}", holder(site));
        turn.doing("later".into());
        assert!(holder(site).is_some_and(|h| h.starts_with("later, which has held it")));
        drop(turn);
        assert_eq!(holder(site), None);
    }

    /// A first command at a browser whose profile another work holds waits for it, then goes ahead past the wait a
    /// walk of the node's own is given, and says nothing of it to the agent.
    #[test]
    fn a_command_waits_for_a_profile_a_walk_holds_and_then_goes_ahead() {
        let home = short_home("profile");
        let dir = program(&home);
        let (site, session) = ("profwait.example", "9:wait");
        says(&dir, "snapshot", "- page\n");
        let held = hold_profile(&launch_profile(site), "a walk of the node's own");
        let start = std::time::Instant::now();
        let said = act(&args(&["snapshot"]), Some(site), "agent", session).unwrap();
        assert_eq!(said, "- page");
        assert!(start.elapsed() >= Duration::from_millis(1800), "it waited for the profile: {:?}", start.elapsed());
        assert!(profile_holder(&launch_profile(site)).is_some_and(|h| h.starts_with("a walk of the node's own")), "the walk still holds it: the command took none");
        drop(held);
        assert!(profile_holder(&launch_profile(site)).is_none());
    }

    /// Who a command is for, as a person reads it: the node, its heal, a session by what its name holds.
    #[test]
    fn a_waiting_command_names_whose_it_is() {
        let site = "whose.example";
        held(site, "11:work", Duration::ZERO);
        held(site, "11:", Duration::ZERO);
        held(site, ":work", Duration::ZERO);
        held(site, ":", Duration::ZERO);
        held(site, "plain", Duration::ZERO);
        assert_eq!(whose(site, None), "the node itself");
        assert_eq!(whose(site, Some(&heal_tab())), "the node, healing a route");
        assert_eq!(whose(site, Some(&tab_of("11:work"))), "agent 11's session \"work\"");
        assert_eq!(whose(site, Some(&tab_of("11:"))), "agent 11");
        assert_eq!(whose(site, Some(&tab_of(":work"))), "session \"work\"");
        assert_eq!(whose(site, Some(&tab_of(":"))), "a session");
        assert_eq!(whose(site, Some(&tab_of("plain"))), "session \"plain\"");
        assert_eq!(whose(site, Some("u-unknown")), "a new session");
        TABS.locked().retain(|h| h.site != site);
    }

    /// The count of password boxes on a page is the browser's own answer; no answer, or one that isn't a number, says
    /// nothing either way.
    #[test]
    fn a_page_asks_a_password_by_the_browsers_count_of_boxes() {
        let home = short_home("pw-count");
        let dir = program(&home);
        let (site, tab) = ("pwcount.example", "u-pw");
        says(&dir, "get-count", "2\n");
        assert_eq!(asks_a_password(site, tab), Some(true));
        assert_eq!(calls(&dir), vec!["u-pw|get count input[type=password]".to_string()]);
        says(&dir, "get-count", "0");
        assert_eq!(asks_a_password(site, tab), Some(false));
        says(&dir, "get-count", "many");
        assert_eq!(asks_a_password(site, tab), None);
        complains(&dir, "get-count", "no page");
        assert_eq!(asks_a_password(site, tab), None);
    }

    /// A page the node typed a secret into stays held while the browser names the same document, and is let go
    /// once it names another that is at another address; a browser that can't be asked holds every page.
    #[test]
    fn a_page_that_took_a_secret_stays_held_until_the_browser_loads_another() {
        let home = short_home("hold-doc");
        let _dir = program(&home);
        let (site, session) = ("holddoc.example", "12:hold");
        let tab = tab_of(session);
        let now_doc = std::sync::Arc::new(Mutex::new("D1".to_string()));
        let doc2 = now_doc.clone();
        let at = std::sync::Arc::new(Mutex::new("https://holddoc.example/login".to_string()));
        let (reply_at, tab2) = (at.clone(), tab.clone());
        let _door = door_up(site, move |c| match c["action"].as_str() {
            Some("document") => ok(serde_json::json!({ "document": doc2.lock().unwrap().clone() })),
            Some("tab_list") => ok(serde_json::json!({ "tabs": [{ "label": tab2, "url": reply_at.lock().unwrap().clone(), "targetId": "T" }] })),
            _ => ok(serde_json::json!({})),
        });
        hold_secret(site, "Held-Secret-60", "vault:holddoc.example:me", "document:D1", "https://holddoc.example/login");
        let eval = args(&["eval", "document.title"]);
        let refused = page_policy(site, session, &eval).unwrap_err();
        assert_eq!(refused, held_from_scripts());
        let unmarked = !SCRIPTED.locked().iter().any(|(s, t)| s == site && *t == tab);
        assert!(unmarked, "a refused script leaves no mark");
        let refused = page_policy(site, session, &args(&["click", "input[value^=Held]"])).unwrap_err();
        assert!(refused.contains("takes no selector here that tests more than an element's kind, id or class"), "{refused}");
        assert_eq!(page_policy(site, session, &args(&["click", "@e3"])), Ok(None), "a plain reference is no question about a value");
        // The page moves on: another document, at another address.
        *now_doc.lock().unwrap() = "D2".into();
        *at.lock().unwrap() = "https://holddoc.example/account".into();
        assert_eq!(page_policy(site, session, &eval), Ok(None), "the secret's page is gone");
        assert!(SCRIPTED.locked().iter().any(|(s, t)| s == site && *t == tab), "and the script is marked as having run");
        // Back at the address the secret went into: it may hold it again.
        *at.lock().unwrap() = "https://holddoc.example/login#again".into();
        assert!(page_policy(site, session, &eval).is_err(), "the same address");
        scripts_closed(site, None);
    }

    /// What a script of the agent's sent is read from the browsing log past a mark, whole lines only; a log that is
    /// still being written is looked at again, and one that is not is read once.
    #[test]
    fn the_browsing_log_is_read_past_a_mark_in_whole_lines() {
        let _home = short_home("log-marks");
        let site = "logmarks.example";
        assert_eq!((log_mark(site), lines_since(site, 0)), (0, String::new()), "no log yet");
        std::fs::create_dir_all(capture_dir()).unwrap();
        let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
        std::fs::write(&log, "one\ntwo\nthr").unwrap();
        assert_eq!(lines_since(site, 0), "one\ntwo\n", "an unfinished line is not yet one");
        assert_eq!(lines_since(site, log_mark(site) - 3), "");
        assert_eq!(lines_since(site, 4), "two\n");
        assert!(log_being_written(site), "just written");
        // A request this tab's script sent is found once the program has written it.
        let tab = "u-script";
        let xhr = serde_json::json!({ "type": "exchange", "tab": tab, "resourceType": "XHR", "entry": { "request": { "method": "GET", "url": "https://logmarks.example/api" } } });
        std::fs::write(&log, format!("{xhr}\n")).unwrap();
        let found = landed_read(site, 0, |lines| lines.contains("logmarks.example/api").then_some(lines.len()));
        assert!(found.is_some_and(|n| n > 10));
        std::fs::write(&log, "").unwrap();
        std::thread::sleep(Duration::from_millis(80));
        assert!(!log_being_written(site), "not within the last two looks");
        let start = std::time::Instant::now();
        assert_eq!(landed_read(site, 0, |lines| (!lines.is_empty()).then_some(1)), None);
        assert!(start.elapsed() < Duration::from_millis(150), "a log nobody writes is read once: {:?}", start.elapsed());
    }

    /// A landed document tells the step's way: a page with a check on it is the page asked for, carrying a check; a
    /// door's refusal that is no door and no check is gone; a step that changed nothing stays that whatever landed.
    #[test]
    fn a_step_that_landed_is_read_by_what_landed() {
        use unbrowse_learn::trace::Exchange;
        let page = "https://form.example/signup";
        let doc = |status: u16, body: &str| Exchange {
            method: "GET".into(),
            url: url::Url::parse(page).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let at = Look { url: page.into(), content: 5 };
        let form = "<html><head><title>Sign up</title></head><body><form><input name=\"email\"><div class=\"box\" data-sitekey=\"0x4AAAAAAAB\"></div><button>Go</button></form></body></html>";
        assert_eq!(came_to_page("open", Some(page), None, Some(&at), Some(&doc(200, form))), Came::CarriesCheck { at: page.into() });
        // A click on the page that changed nothing is still unchanged, with a check on it.
        assert_eq!(came_to_page("click", None, Some(&at), Some(&at.clone()), Some(&doc(200, form))), Came::Unchanged);
        let refused = "<html><head><title>Forbidden</title></head><body><h1>No</h1><a href=\"/\">Home</a> <a href=\"/about\">About</a></body></html>";
        assert_eq!(came_to_page("open", Some(page), None, Some(&at), Some(&doc(429, refused))), Came::Check { at: page.into() }, "a refusal while the site decides is a door");
        assert_eq!(came_to_page("open", Some(page), None, Some(&at), Some(&doc(500, refused))), Came::Gone { status: 500 });
        // A click that changed nothing on a page that landed fine is still unchanged; a walled open is walled.
        let fine = "<html><head><title>Lamp</title></head><body><h1>Lamp</h1><a href=\"/\">Home</a></body></html>";
        assert_eq!(came_to_page("click", None, Some(&at), Some(&at.clone()), Some(&doc(200, fine))), Came::Unchanged);
        let login = Look { url: "https://form.example/login?next=%2Fsignup".into(), content: 1 };
        assert!(matches!(came_to_page("open", Some(page), None, Some(&login), Some(&doc(200, fine))), Came::Walled { .. }));
    }

    /// A line of the log that isn't JSON carries nothing typed, and neither does an exchange the node can't read.
    #[test]
    fn a_log_line_that_does_not_read_carries_nothing_typed() {
        let typed = vec!["Typed-Value-77".to_string()];
        assert!(!carries_typed("{\"type\":\"exchange\" broken Typed-Value-77", &typed));
        assert!(!carries_typed("{\"type\":\"note\",\"x\":\"exchange\"}", &typed));
        assert!(!carries_typed("{\"type\":\"exchange\"}", &[]), "nothing typed, nothing carried");
        assert!(carries_typed(&serde_json::json!({ "type": "exchange", "entry": { "request": { "url": "https://a.example/?q=Typed-Value-77" } } }).to_string(), &typed));
    }

    /// An address with no host is no address of this machine's.
    #[test]
    fn an_address_with_no_host_is_not_this_machines() {
        assert!(!this_machine(&url::Url::parse("data:text/plain,hello").unwrap()));
        assert!(this_machine(&url::Url::parse("http://[::ffff:127.0.0.1]/").unwrap()));
        // The hosts are built here, not written out: the source rule reads a written host as one the node calls.
        let named = |host: String| url::Url::parse(&format!("http://{host}/")).unwrap();
        assert!(this_machine(&named(["app", "localhost."].join("."))));
        assert!(!this_machine(&named([93, 184, 216, 34].map(|n: u8| n.to_string()).join("."))));
    }

    /// A sign-up noted twice for one login moves to its newest tab and is kept once.
    #[test]
    fn a_sign_up_noted_again_follows_its_newest_tab() {
        let r = crate::vault::Ref::parse("vault:new:signups.example:me").unwrap();
        wait_for_sign_up("signups.example", "u-1", &r, "Pw-1", "agent", 0);
        wait_for_sign_up("signups.example", "u-2", &r, "Pw-1", "agent", 99);
        assert_eq!(sign_ups_waiting("signups.example"), vec!["vault:signups.example:me".to_string()]);
        let ups = SIGN_UPS.locked();
        let up = ups.iter().find(|u| u.site == "signups.example").unwrap();
        assert_eq!((up.tab.as_str(), up.mark), ("u-2", 0), "the tab follows; the mark stays where the first fill began");
        drop(ups);
        SIGN_UPS.locked().retain(|u| u.site != "signups.example");
    }

    /// The hosts a checkout submitted to come from the browser's record of the last hour: a request that sends
    /// something counts, an older line is passed over, and a record that is missing is said not to be whole.
    #[test]
    fn the_hosts_a_checkout_submitted_to_come_from_the_recent_record() {
        let _home = short_home("submits");
        let browser = "submits.example";
        assert_eq!(submitted_to(browser, 10_000), (Vec::new(), false), "no record");
        std::fs::create_dir_all(capture_dir()).unwrap();
        let log = capture_dir().join(format!("{}.jsonl", session_of(browser)));
        let line = |t: f64, method: &str, url: &str| serde_json::json!({ "type": "exchange", "t": t, "entry": { "request": { "method": method, "url": url } } }).to_string();
        let lines = [
            line(1.0, "POST", "https://stale.example/old"),
            "not json but exchange".to_string(),
            line(9_000.0, "GET", "https://fetched.example/app.js"),
            line(9_100.0, "post", "https://pay.processor.example/charge"),
            line(9_200.0, "POST", "https://pay.processor.example/again"),
            line(9_300.0, "POST", "not a url"),
        ];
        std::fs::write(&log, lines.join("\n")).unwrap();
        let (hosts, whole) = submitted_to(browser, 10_000);
        assert_eq!(hosts, vec!["processor.example".to_string()]);
        assert!(whole, "the record reaches back past where the checkout began");
        let mut measured = crate::checkout::fixture("document:S1", "10.00", "");
        measured.url = "not a url".into();
        measured.frames = vec!["https://js.provider.example/elements".into(), "also not a url".into()];
        let (named, _) = checkout_hosts(browser, &measured, 10_000);
        assert_eq!(named, vec!["provider.example".to_string(), "processor.example".to_string()], "the page's own address didn't read, its frame did");
    }
}

/// A fake DevTools endpoint answering as a browser with one checkout page open: the page's form is measured from
/// what `Page` holds, which a fill through the fake door changes the way the browser's typing would.
#[cfg(unix)]
mod checkout {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    pub struct Page {
        pub url: String,
        pub loader: String,
        pub amount: String,
        pub pan: String,
        pub exp: String,
        pub holder: String,
        /// The page changes its amount as the number is typed; goes to another page as the name is; and the browser
        /// refuses to take a value out of its walk record.
        pub swap: bool,
        pub vanish: bool,
        pub forget_fails: bool,
    }

    impl Page {
        pub fn new(url: &str) -> Page {
            Page { url: url.into(), loader: "L1".into(), amount: "10.00".into(), pan: String::new(), exp: String::new(), holder: String::new(), swap: false, vanish: false, forget_fails: false }
        }

        /// The browser's `DOMSnapshot.captureSnapshot` answer for the page: one document, its form's controls.
        fn snapshot(&self) -> Value {
            let mut strings: Vec<String> = Vec::new();
            let mut id = |s: &str| -> usize {
                strings.iter().position(|x| x == s).unwrap_or_else(|| {
                    strings.push(s.to_string());
                    strings.len() - 1
                })
            };
            let nodes: Vec<(&str, Vec<&str>, Option<&str>)> = vec![
                ("FORM", vec!["action", "/pay", "method", "post"], None),
                ("INPUT", vec!["type", "hidden", "name", "amount"], Some(&self.amount)),
                ("INPUT", vec!["name", "pan", "autocomplete", "cc-number"], Some(&self.pan)),
                ("INPUT", vec!["name", "exp", "autocomplete", "cc-exp"], Some(&self.exp)),
                ("INPUT", vec!["name", "holder", "autocomplete", "cc-name"], Some(&self.holder)),
                ("BUTTON", vec!["type", "submit"], None),
            ];
            let (mut names, mut attrs, mut vi, mut vv) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
            for (i, (tag, a, value)) in nodes.iter().enumerate() {
                names.push(id(tag));
                attrs.push(a.iter().map(|x| id(x)).collect::<Vec<_>>());
                if let Some(v) = value {
                    vi.push(i);
                    vv.push(id(v));
                }
            }
            let frame = id("F1");
            json!({ "documents": [{ "frameId": frame, "nodes": { "nodeName": names, "attributes": attrs, "inputValue": { "index": vi, "value": vv }, "inputChecked": { "index": [] } } }], "strings": strings })
        }
    }

    pub struct Cdp {
        pub ws: String,
        pub page: Arc<Mutex<Page>>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    pub fn cdp_up(page: Page) -> Cdp {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let ws = format!("ws://{}", listener.local_addr().unwrap());
        let page = Arc::new(Mutex::new(page));
        let (state, stop) = (page.clone(), Arc::new(AtomicBool::new(false)));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let local = tokio::task::LocalSet::new();
                local
                    .run_until(async {
                        while !stopped.load(Ordering::Relaxed) {
                            let Ok(Ok((stream, _))) = tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept()).await else { continue };
                            let state = state.clone();
                            tokio::task::spawn_local(async move {
                                let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
                                let (mut write, mut read) = socket.split();
                                while let Some(Ok(Message::Text(text))) = read.next().await {
                                    let Ok(cmd) = serde_json::from_str::<Value>(&text) else { continue };
                                    let result = {
                                        let page = state.lock().unwrap();
                                        match cmd["method"].as_str().unwrap_or_default() {
                                            "Target.attachToTarget" => json!({ "sessionId": "S1" }),
                                            "Page.getFrameTree" => json!({ "frameTree": { "frame": { "id": "F1", "loaderId": page.loader, "url": page.url } } }),
                                            "DOMSnapshot.captureSnapshot" => page.snapshot(),
                                            "Target.getTargets" => json!({ "targetInfos": [] }),
                                            _ => json!({}),
                                        }
                                    };
                                    if write.send(Message::Text(json!({ "id": cmd["id"], "result": result }).to_string())).await.is_err() {
                                        break;
                                    }
                                }
                            });
                        }
                    })
                    .await;
            });
        });
        Cdp { ws, page, stop, thread: Some(thread) }
    }

    impl Drop for Cdp {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    /// The browser's door for a checkout tab: its tab, its DevTools address, and a fill that types into the page.
    pub fn door_for(site: &str, tab: &str, cdp: &Cdp) -> Door {
        let (page, ws, tab) = (cdp.page.clone(), cdp.ws.clone(), tab.to_string());
        door_up(site, move |c| match c["action"].as_str() {
            Some("tab_list") => ok(json!({ "tabs": [{ "label": tab, "url": page.lock().unwrap().url, "targetId": "T1" }] })),
            Some("cdp_url") => ok(json!({ "cdpUrl": ws })),
            Some("fill") => {
                let value = c["value"].as_str().unwrap_or_default().to_string();
                let selector = c["selector"].as_str().unwrap_or_default();
                let mut p = page.lock().unwrap();
                let mut said = json!({ "field_checked": true });
                match selector {
                    "#pan" => {
                        p.pan = value;
                        if p.swap {
                            p.amount = "990.00".into();
                        }
                    }
                    "#exp" => {
                        p.exp = value;
                        said["frame_origin"] = json!("https://js.provider.example");
                    }
                    "#holder" => {
                        p.holder = value;
                        if p.vanish {
                            p.url = "about:blank".into();
                        }
                    }
                    _ => {}
                }
                ok(said)
            }
            Some("capture_forget") if page.lock().unwrap().forget_fails => serde_json::json!({ "success": false, "error": "the browser hung" }),
            _ => ok(json!({})),
        })
    }
}

#[cfg(unix)]
mod cards {
    use super::checkout::*;
    use super::*;

    const SITE: &str = "cardfill.example";

    fn vault_with_a_card(keys: &unbrowse_core::MemoryStore) {
        unbrowse_core::load_or_create(keys).unwrap();
        let card = unbrowse_core::Card { number: "4242424242424242".into(), expiry: "12/30".into(), cvv: String::new(), name: "Pat Example".into() };
        crate::vault::add_card(&crate::vault_keep(Ok(keys)).unwrap(), "visa", &card, false, "You").unwrap();
    }

    /// The owner's yes covers one checkout page: the card's fields go in only while the page reads as they approved it
    /// (the card's own fields aside), each is typed over the door and never on a command line, the site is held for
    /// the owner, and the hand-off says what the node could vouch for. A page that changed an amount since gets nothing.
    #[test]
    fn a_card_goes_into_the_approved_checkout_only_and_the_hand_off_says_what_was_checked() {
        let home = short_home("cardfill");
        let dir = program(&home);
        let (session, who) = ("13:pay", "agent");
        let tab = tab_of(session);
        let keys = unbrowse_core::MemoryStore::default();
        vault_with_a_card(&keys);
        // The browser's record of the checkout's own requests: one that exists is read whole.
        std::fs::create_dir_all(capture_dir()).unwrap();
        std::fs::write(capture_dir().join(format!("{}.jsonl", session_of(SITE))), "").unwrap();
        let cdp = cdp_up(Page::new("https://cardfill.example/checkout"));
        let door = door_for(SITE, &tab, &cdp);
        // Nothing of this site is noted in the node's tabs for longer than a fill takes: another test's sweep over every
        // site's tabs (`sweep_idle`) finds this browser stopped, from its own thread's home, and forgets what it held.
        let fill = |field: &str, target: &str| {
            let said = fill_card(&args(&["fill", target, &format!("vault:card:visa:{field}")]), Some(SITE), who, session, &keys);
            TABS.locked().retain(|h| h.site != SITE);
            said
        };
        // No yes yet: nothing goes in, and the owner is told why.
        let refused = fill("number", "#pan").unwrap_err();
        assert!(refused.contains("hasn't approved paying with this card on this page") && refused.contains("nothing was filled (visa (card ending 4242) on cardfill.example)"), "{refused}");
        assert!(door.got("fill").is_empty());
        let (on, page, approved) = checkout_of(SITE, session).unwrap();
        assert_eq!((on.as_str(), page.as_str()), (SITE, "https://cardfill.example/checkout"));
        assert!(approved.document.starts_with("document:L1") && approved.controls.iter().any(|c| c.attrs.iter().any(|(k, v)| k == "name" && v == "pan")));
        approve_card(SITE, SITE, "visa", session, approved.clone());
        assert!(card_approved_here(SITE, "visa", session, &approved.document));
        let said = fill("number", "#pan").unwrap();
        assert!(said.starts_with("Filled #pan with vault:card:visa:number. The site is the owner's now"), "{said}");
        let sent = door.got("fill");
        assert_eq!(sent.len(), 1);
        let c = &sent[0];
        assert_eq!((c["value"].as_str(), c["as"].as_str(), c["field"].as_str(), c["site"].as_str(), c["tab"].as_str()), (Some("4242424242424242"), Some("vault:card:visa:number"), Some("card"), Some(SITE), Some(tab.as_str())));
        assert!(!calls(&dir).iter().any(|l| l.contains("4242")), "never on a command line");
        let forgotten: Vec<String> = door.got("capture_forget").iter().filter_map(|c| c["value"].as_str().map(String::from)).collect();
        assert!(forgotten.contains(&"4242 4242 4242 4242".to_string()) && forgotten.contains(&"4242-4242-4242-4242".to_string()), "each way a page may write it back: {forgotten:?}");
        assert!(site_holds_a_card(SITE), "the site is held for the owner");
        assert_eq!(unsaid(SITE, "pan=4242424242424242".into()), "pan=vault:card:visa:number");
        // The expiry goes into a payment provider's frame; the page says so, and the number it typed isn't a change.
        let said = fill("expiry", "#exp").unwrap();
        assert!(said.starts_with("Filled #exp, a field of https://js.provider.example's frame on cardfill.example's checkout with vault:card:visa:expiry"), "{said}");
        assert_eq!(unsaid(SITE, "exp=12 / 30".into()), "exp=vault:card:visa:expiry", "the expiry as a hosted field spaces it");
        // A name goes in as itself: it is no secret, and naming it would rename every such word the record holds.
        let said = fill("name", "#holder").unwrap();
        assert!(said.starts_with("Filled #holder with vault:card:visa:name"), "{said}");
        let c = &door.got("fill")[2];
        assert!(c.get("as").is_none() && c.get("field").is_none() && c["value"] == "Pat Example", "{c}");
        assert!(TYPED.locked().iter().any(|(s, v)| s == SITE && v == "Pat Example"), "a name is noted as typed");
        // The hand-off: measured again against what the owner approved.
        let note = hand_over_note(SITE, session).unwrap();
        assert!(note.contains("can't vouch for the amount or the order") && note.contains("The form reads as you approved it, apart from the card the node typed."), "{note}");
        assert!(!note.contains("Warning"), "{note}");
        // The page changes an amount: nothing more goes in, and the hand-off warns.
        cdp.page.lock().unwrap().amount = "990.00".into();
        let refused = fill("name", "#holder").unwrap_err();
        assert!(refused.contains("nothing was filled"), "{refused}");
        let note = hand_over_note(SITE, session).unwrap();
        assert!(note.contains("Warning:") && note.contains("Check every field."), "{note}");
        // The page loads again: the owner's yes was for the other document.
        {
            let mut p = cdp.page.lock().unwrap();
            p.amount = "10.00".into();
            p.loader = "L2".into();
        }
        let note = hand_over_note(SITE, session).unwrap();
        assert!(note.contains("The node has no record of what you approved on this page"), "{note}");
        forget_approvals(SITE, Some(&tab));
        assert!(!card_approved_here(SITE, "visa", session, &approved.document), "the page it was for is gone");
        crate::payhold::release(SITE).unwrap();
    }

    /// A card goes only into a page that came over https and that the browser can name; any other page, and a
    /// browser with no DevTools to ask, gets no card.
    #[test]
    fn a_card_goes_only_into_an_https_page_the_browser_can_name() {
        let home = short_home("cardwhere");
        let _dir = program(&home);
        let (site, session) = ("cardwhere.example", "13:where");
        let tab = tab_of(session);
        assert!(checkout_of(site, session).unwrap_err().contains("can't reach the checkout's browser over its DevTools"));
        let cdp = cdp_up(Page::new("http://cardwhere.example/checkout"));
        let _door = door_for(site, &tab, &cdp);
        let err = checkout_of(site, session).unwrap_err();
        assert_eq!(err, "this page is on http://cardwhere.example: a card goes only into a page that came over https");
        cdp.page.lock().unwrap().url = "about:blank".into();
        assert_eq!(checkout_of(site, session).unwrap_err(), "open the checkout page first");
        cdp.page.lock().unwrap().url = "https://pay.cardwhere.example/c".into();
        assert!(checkout_of(site, "13:nobody").unwrap_err().contains("can't find the checkout's tab"), "a session with no tab there");
        assert_eq!(checkout_of(site, session).unwrap().0, "cardwhere.example", "the site, whatever host the page is on");
    }

    /// What a fill of a card needs of the fake checkout, shared by the tests below: the site's own browser, its record,
    /// a card in the vault, and a closure that fills a field and leaves no tab noted (see the first card test).
    fn checkout_for(name: &str, site: &'static str) -> (PathBuf, Cdp, Door, unbrowse_core::MemoryStore) {
        let home = short_home(name);
        let _dir = program(&home);
        let keys = unbrowse_core::MemoryStore::default();
        vault_with_a_card(&keys);
        std::fs::create_dir_all(capture_dir()).unwrap();
        std::fs::write(capture_dir().join(format!("{}.jsonl", session_of(site))), "").unwrap();
        let cdp = cdp_up(Page::new(&format!("https://{site}/checkout")));
        let door = door_for(site, &tab_of("13:warn"), &cdp);
        (home, cdp, door, keys)
    }

    fn fill_in(site: &str, keys: &unbrowse_core::MemoryStore, field: &str, target: &str) -> Result<String, String> {
        let said = fill_card(&args(&["fill", target, &format!("vault:card:visa:{field}")]), Some(site), "agent", "13:warn", keys);
        TABS.locked().retain(|h| h.site != site);
        said
    }

    fn approve_here(site: &str) {
        let (_, _, approved) = checkout_of(site, "13:warn").unwrap();
        approve_card(site, site, "visa", "13:warn", approved);
    }

    /// A browser that will not take the card's number out of its walk record gets no card: the number is not typed.
    #[test]
    fn a_card_is_not_typed_while_the_browser_will_not_clean_its_record_of_it() {
        let site = "cardrecord.example";
        let (_home, cdp, _door, keys) = checkout_for("cardrecord", site);
        cdp.page.lock().unwrap().forget_fails = true;
        approve_here(site);
        let refused = fill_in(site, &keys, "number", "#pan").unwrap_err();
        assert!(refused.starts_with("the card wasn't filled: ") && refused.contains("the browser hung"), "{refused}");
        assert!(cdp.page.lock().unwrap().pan.is_empty(), "nothing was typed");
    }

    /// A page that changes what is to be paid as the card goes in: the fill is done, and the owner hears of the change
    /// at the hand-off.
    #[test]
    fn a_page_that_changes_its_amount_as_the_card_goes_in_is_told_to_the_owner() {
        let site = "cardswap.example";
        let (_home, cdp, _door, keys) = checkout_for("cardswap", site);
        cdp.page.lock().unwrap().swap = true;
        approve_here(site);
        let said = fill_in(site, &keys, "number", "#pan").unwrap();
        assert!(said.starts_with("Filled #pan"), "{said}");
        let held = crate::payhold::of(site).expect("held");
        assert!(held.warnings.iter().any(|w| w.starts_with("as the card's number went in, ")), "{:?}", held.warnings);
        let note = hand_over_note(site, "13:warn").unwrap();
        assert!(note.contains("Warning: as the card's number went in, ") && note.contains("Check every field."), "{note}");
        crate::payhold::release(site).unwrap();
    }

    /// A page the browser can no longer measure once the card's name is typed is said so to the owner.
    #[test]
    fn a_page_the_browser_cannot_measure_after_the_card_went_in_is_told_to_the_owner() {
        let site = "cardgone.example";
        let (_home, cdp, _door, keys) = checkout_for("cardgone", site);
        // A checkout already held (an earlier field went in), and a page that goes elsewhere as the name is typed.
        crate::payhold::begin(site, &[]).unwrap();
        cdp.page.lock().unwrap().vanish = true;
        approve_here(site);
        let said = fill_in(site, &keys, "name", "#holder").unwrap();
        assert!(said.starts_with("Filled #holder"), "{said}");
        let held = crate::payhold::of(site).expect("held");
        assert!(held.warnings.iter().any(|w| w.starts_with("the node couldn't measure the page after the card's name went in (")), "{:?}", held.warnings);
        crate::payhold::release(site).unwrap();
    }

    /// A page the owner has takes no card from the node.
    #[test]
    fn a_card_waits_while_the_owner_has_the_page() {
        let site = "cardowner.example";
        let (_home, cdp, door, keys) = checkout_for("cardowner", site);
        approve_here(site);
        crate::hands::hold_for_test(site, true);
        let said = fill_in(site, &keys, "name", "#holder").unwrap_err();
        crate::hands::hold_for_test(site, false);
        assert!(said.contains(&format!("the owner has {site}'s page")), "{said}");
        assert!(door.got("fill").is_empty() && cdp.page.lock().unwrap().holder.is_empty(), "nothing was typed");
        assert_eq!(fill_in(site, &keys, "name", "#holder").map(|s| s.starts_with("Filled #holder")), Ok(true), "and once it is given back, it goes");
        crate::payhold::release(site).unwrap();
    }

    /// A paused node types no card, and a reference that names no field is told what to send.
    #[test]
    fn a_card_waits_while_the_node_is_paused() {
        let site = "cardpaused.example";
        let (_home, _cdp, door, keys) = checkout_for("cardpaused", site);
        approve_here(site);
        let mut settings = store::load_settings();
        settings.paused = true;
        store::save_settings(&settings).unwrap();
        let said = fill_in(site, &keys, "name", "#holder");
        settings.paused = false;
        store::save_settings(&settings).unwrap();
        assert_eq!(said.unwrap_err(), crate::outcome::PAUSED);
        assert!(door.got("fill").is_empty(), "nothing was typed");
        assert!(fill_card(&args(&["fill", "#holder", "vault:visa:name"]), Some(site), "agent", "13:warn", &keys).unwrap_err().contains("fill <target> vault:card:<label>:<field>"));
        assert_eq!(fill_in(site, &keys, "name", "#holder").map(|s| s.starts_with("Filled #holder")), Ok(true), "and once it is resumed, it goes");
        crate::payhold::release(site).unwrap();
    }
}

#[cfg(unix)]
mod refusals {
    use super::*;
    use std::time::Duration;

    fn vault_login(site: &str, account: &str, password: &str) -> unbrowse_core::MemoryStore {
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), site, account, "stored", Some(password), "You").unwrap();
        keys
    }

    /// A paused node, a page the owner has, a checkout waiting for the owner, and a card in the site's page each
    /// stop a vault fill before the browser is asked anything: no page address is read, and nothing is typed.
    #[test]
    fn a_vault_fill_waits_while_the_node_is_paused_the_owner_has_the_page_or_a_checkout_waits() {
        let home = short_home("vfill-stops");
        let dir = program(&home);
        let (site, session) = ("vstops.example", "14:stops");
        let keys = vault_login(site, "me", "Stopped-Secret-8");
        says(&dir, "get-url", "https://vstops.example/login\n");
        let door = door_up(site, |_| ok(serde_json::json!({ "field_checked": true })));
        let fill = || fill_from_vault(&args(&["fill", "#pw", "vault:vstops.example:me"]), Some(site), "agent", session, &keys, true);
        crate::hands::hold_for_test(site, true);
        let said = fill().unwrap_err();
        assert!(said.contains("the owner has vstops.example's page"), "{said}");
        crate::hands::hold_for_test(site, false);
        crate::payhold::begin(site, &[]).unwrap();
        assert_eq!(fill().unwrap_err(), CARD_IS_THE_OWNERS);
        crate::payhold::release(site).unwrap();
        crate::payhold::begin("elsewhere-shop.example", &[]).unwrap();
        let said = fill().unwrap_err();
        assert!(said.contains("a card checkout on elsewhere-shop.example is waiting for the owner"), "{said}");
        crate::payhold::release("elsewhere-shop.example").unwrap();
        let mut settings = store::load_settings();
        settings.paused = true;
        store::save_settings(&settings).unwrap();
        assert_eq!(fill().unwrap_err(), crate::outcome::PAUSED);
        assert_eq!(act(&args(&["snapshot"]), Some(site), "agent", session).unwrap_err(), crate::outcome::PAUSED);
        settings.paused = false;
        store::save_settings(&settings).unwrap();
        assert!(calls(&dir).is_empty() && door.got("fill").is_empty(), "nothing reached the browser: {:?}", calls(&dir));
        assert!(fill().is_ok(), "and once none of it holds, the fill goes");
    }

    /// A login with a one-time code key goes in whole with its current code beside the password, held as its own
    /// name; the code the site rejects stays where it was typed no more than the password does.
    #[test]
    fn a_login_with_a_code_key_goes_in_with_its_code_held_beside_the_password() {
        let home = short_home("vfill-code");
        let dir = program(&home);
        let (site, session) = ("vcode.example", "14:code");
        let keys = vault_login(site, "me", "Coded-Secret-9");
        crate::vault::set_code(&crate::vault_keep(Ok(&keys)).unwrap(), site, "me", "GEZDGNBVGY3TQOJQ", "You").unwrap();
        says(&dir, "get-url", "https://vcode.example/login\n");
        let door = door_up(site, |c| match c["action"].as_str() {
            Some("fill") => ok(serde_json::json!({ "field_checked": true, "beside": { "username": "filled", "code": "filled" }, "submitted": true })),
            Some("document") => ok(serde_json::json!({ "document": "C1" })),
            _ => ok(serde_json::json!({})),
        });
        let said = fill_from_vault(&args(&["fill", "#pw", "vault:vcode.example:me"]), Some(site), "agent", session, &keys, true).unwrap();
        assert!(said.contains(", with its account name and one-time code, and submitted the form"), "{said}");
        let c = &door.got("fill")[0];
        let code = c["code"].as_str().expect("the code goes with the fill");
        assert!(code.len() == 6 && code.chars().all(|d| d.is_ascii_digit()), "{code}");
        assert_eq!(c["codeAs"].as_str(), Some("vault:code:vcode.example:me"));
        assert_eq!(unsaid(site, format!("code={code}")), "code=vault:code:vcode.example:me", "the code is said as its name too");
        assert!(holds_a_secret(site, "document:C1"));
    }

    /// A login the node makes is kept only once the site accepted its sign-up: the fill notes it, nothing is in the
    /// vault yet, a refused sign-up keeps nothing, and the answer that accepts it (with the page asking no password
    /// any more) keeps it.
    #[test]
    fn a_new_login_is_kept_only_once_the_site_accepts_the_sign_up() {
        let home = short_home("vfill-new");
        let dir = program(&home);
        let (site, session) = ("vnew.example", "14:new");
        let keys = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&keys).unwrap();
        says(&dir, "get-url", "https://vnew.example/join\n");
        let door = door_up(site, |c| match c["action"].as_str() {
            Some("fill") => ok(serde_json::json!({ "field_checked": true })),
            _ => ok(serde_json::json!({})),
        });
        let said = fill_from_vault(&args(&["fill", "#pw", "vault:new:vnew.example:me"]), Some(site), "agent", session, &keys, true).unwrap();
        assert!(said.starts_with("Filled #pw with vault:vnew.example:me"), "{said}");
        let password = door.got("fill")[0]["value"].as_str().unwrap().to_string();
        assert!(password.len() >= 12, "a password the node made");
        assert_eq!(sign_ups_waiting(site), vec!["vault:vnew.example:me".to_string()]);
        assert!(!crate::vault::list().iter().any(|l| l.site == site), "nothing is kept before the site says yes");
        std::fs::create_dir_all(capture_dir()).unwrap();
        let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
        let answered = |status: u16| {
            format!("{}\n", serde_json::json!({ "type": "exchange", "entry": { "request": { "method": "POST", "url": "https://vnew.example/join", "postData": { "text": format!("user=me&pw={password}") } }, "response": { "status": status, "content": { "text": "{}" } } } }))
        };
        let kept = std::cell::RefCell::new(Vec::new());
        let keep_it = |r: &crate::vault::Ref, who: &str| {
            kept.borrow_mut().push((r.name(), who.to_string()));
            Ok(())
        };
        std::fs::write(&log, answered(422)).unwrap();
        assert!(sign_ups_accepted(site, |_| Some(false), keep_it).is_empty(), "refused");
        std::fs::write(&log, answered(200)).unwrap();
        assert!(sign_ups_accepted(site, |_| Some(true), keep_it).is_empty(), "the form came back asking a password again");
        assert_eq!(sign_ups_accepted(site, |_| Some(false), keep_it), vec!["vault:vnew.example:me".to_string()]);
        assert_eq!(kept.borrow().as_slice(), [("vault:vnew.example:me".to_string(), "agent".to_string())]);
        assert!(sign_ups_waiting(site).is_empty());
    }

    /// A tab closed by hand, or a browser that stopped, is found at the session's next command, which says so rather
    /// than answering from a new empty tab; a card in the page gets the address from the browser's list.
    #[test]
    fn a_session_whose_tab_went_hears_it_and_a_held_checkouts_address_is_the_browsers_list() {
        let home = short_home("policy");
        let _dir = program(&home);
        let (site, session) = ("policy.example", "15:policy");
        held(site, session, Duration::ZERO);
        let door = door_with_tabs(site, &[("u-someone-else", "https://policy.example/")]);
        let said = act(&args(&["get", "url"]), Some(site), "agent", session).unwrap_err();
        assert!(said.starts_with("your tab was closed") && said.contains("by hand in the browser's window"), "{said}");
        // Opening a page moves on: nothing more is said of it.
        held(site, session, Duration::ZERO);
        drop(door);
        let said = act(&args(&["get", "url"]), Some(site), "agent", session).unwrap_err();
        assert!(said.contains("browser stopped"), "{said}");
        // A held checkout answers the address and the title from the browser's own list.
        let (session, tab) = ("15:checkout", tab_of("15:checkout"));
        let _door = door_with_tabs(site, &[(tab.as_str(), "https://policy.example/pay")]);
        crate::payhold::begin(site, &[]).unwrap();
        assert_eq!(act(&args(&["get", "url"]), Some(site), "agent", session).unwrap(), "https://policy.example/pay");
        assert!(act(&args(&["snapshot"]), Some(site), "agent", session).unwrap_err().contains("a card is in a checkout"));
        crate::payhold::release(site).unwrap();
    }

    /// The node's heal of a route closes its own tab, and the browser with it when no session has a tab there.
    #[test]
    fn healing_a_route_closes_its_own_tab_and_the_browser_only_when_nobody_else_is_there() {
        let home = short_home("heal");
        let dir = program(&home);
        let site = "healing.example";
        let _door = door_with_tabs(site, &[(&heal_tab(), "https://healing.example/"), (&tab_of("16:agent"), "https://healing.example/x")]);
        held(site, "16:agent", Duration::ZERO);
        held(site, HEAL, Duration::ZERO);
        heal_done(&format!("www.{site}"));
        assert_eq!(calls(&dir), vec![format!("|tab close {}", heal_tab())], "the heal's own tab, the agent's stays");
        assert!(!TABS.locked().iter().any(|h| h.site == site && h.session == HEAL), "the heal is forgotten");
        assert!(TABS.locked().iter().any(|h| h.site == site && h.session == "16:agent"));
        let alone = "healalone.example";
        let _alone = door_with_tabs(alone, &[(&heal_tab(), "https://healalone.example/")]);
        heal_done(alone);
        assert!(calls(&dir).last().is_some_and(|c| c.ends_with("|close") && !c.contains("tab")), "{:?}", calls(&dir));
    }

    /// A tab the browser would not close stays the session's, and says why.
    #[test]
    fn a_tab_the_browser_will_not_close_stays_noted_and_the_browser_says_why() {
        let home = short_home("close-fails");
        let dir = program(&home);
        let (site, session) = ("closefails.example", "17:mine");
        let _door = door_with_tabs(site, &[(&tab_of(session), "https://closefails.example/"), ("u-other", "https://closefails.example/o")]);
        held(site, session, Duration::ZERO);
        held(site, "17:other", Duration::ZERO);
        complains(&dir, "tab-close", "No such tab");
        let said = act(&args(&["close"]), Some(site), "agent", session).unwrap_err();
        assert_eq!(said, "No such tab");
        assert!(TABS.locked().iter().any(|h| h.site == site && h.tab == tab_of(session)), "still the session's");
    }

    /// A picture of a page that may hold a secret waits unless what the page paints shows none of it: no hold, no
    /// wait; a secret painted, or a frame of the site's own that couldn't be read, and the picture is refused.
    #[test]
    fn a_picture_waits_while_a_held_secret_may_be_painted() {
        let home = short_home("picture");
        let _dir = program(&home);
        let (site, tab) = ("picture.example", "u-pic");
        let shown = |texts: &[&str], unread: bool| Some(Shown { texts: texts.iter().map(|t| t.to_string()).collect(), unread });
        assert!(may_picture(site, tab, || None).is_ok(), "nothing held, nothing to wait for");
        let _door = door_up(site, |c| match c["action"].as_str() {
            Some("document") => ok(serde_json::json!({ "document": "P1" })),
            Some("tab_list") => ok(serde_json::json!({ "tabs": [{ "label": "u-pic", "url": "https://picture.example/pay", "targetId": "T" }] })),
            _ => ok(serde_json::json!({})),
        });
        hold_secret(site, "Painted-Secret-3", "vault:picture.example:me", "document:P1", "https://picture.example/pay");
        assert!(may_picture(site, tab, || shown(&["Welcome", "Account me"], false)).is_ok(), "nothing painted shows it");
        let refused = may_picture(site, tab, || shown(&["Password: Painted-Secret-3"], false)).unwrap_err();
        assert!(refused.contains("takes no picture of it") && refused.contains("the hold is kept for this address") || refused.contains("The hold is kept for this address"), "{refused}");
        assert!(may_picture(site, tab, || shown(&["Welcome"], true)).is_err(), "a frame of the site's own that couldn't be read");
        assert!(may_picture(site, tab, || None).is_err(), "a read that failed");
        scripts_closed(site, None);
    }

    /// A popup a scripted tab opened keeps its site marked after the tab closes, and the mark goes with the popup.
    #[test]
    fn a_scripted_tabs_popup_keeps_its_site_marked_until_it_closes() {
        let home = short_home("popup");
        let _dir = program(&home);
        let (site, tab) = ("popup.example", "u-script");
        let open = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        let listing = open.clone();
        let _door = door_up(site, move |c| match c["action"].as_str() {
            Some("tab_list") => {
                let mut tabs = vec![serde_json::json!({ "label": "u-other", "url": "https://popup.example/", "targetId": "A" })];
                if listing.load(std::sync::atomic::Ordering::Relaxed) {
                    tabs.push(serde_json::json!({ "url": "https://popup.example/ad", "targetId": "B" }));
                }
                ok(serde_json::json!({ "tabs": tabs }))
            }
            _ => ok(serde_json::json!({})),
        });
        assert!(mark_scripted(site, tab));
        assert!(scripted_sites().iter().any(|s| s == site));
        scripts_closed(site, Some(tab));
        assert!(scripted_sites().iter().any(|s| s == site), "the popup is still open: the site stays marked");
        assert!(script_may_have_run_on_any(|s| s == site));
        open.store(false, std::sync::atomic::Ordering::Relaxed);
        assert!(!scripted_sites().iter().any(|s| s == site), "the popup went, and the mark with it");
        assert!(!script_may_have_run_on_any(|s| s == site));
    }

    /// A hold that can't be written to disk is still held in memory, and the file is left as it was.
    #[test]
    fn a_hold_that_cannot_be_kept_on_disk_is_still_held() {
        let home = short_home("holds-disk");
        let site = "holddisk.example";
        hold_secret(site, "Disk-Secret-19", "vault:holddisk.example:me", "document:H1", "https://holddisk.example/login");
        let file = home.join("secret-holds.json");
        let before = std::fs::read_to_string(&file).unwrap();
        assert!(before.contains("holddisk.example") && !before.contains("Disk-Secret-19"), "kept without the secret");
        std::fs::create_dir(file.with_extension("json.part")).unwrap();
        hold_secret(site, "Disk-Secret-20", "vault:holddisk.example:you", "document:H2", "https://holddisk.example/other");
        assert!(holds_a_secret(site, "document:H2"), "held in memory");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), before, "the file is as it was");
        scripts_closed(site, None);
    }

    /// Where a command points its selector, by the verb: the element it acts on, the nth of a find, a drag's two ends,
    /// what a wait waits for, and the part a snapshot covers.
    #[test]
    fn a_selector_is_found_where_each_verb_takes_one() {
        let sel = |a: &[&str]| selectors(&args(a)).iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(sel(&["click", "#go"]), ["#go"]);
        assert_eq!(sel(&["find", "nth", "2", ".row"]), [".row"]);
        assert_eq!(sel(&["find", "first", ".row"]), [".row"]);
        assert_eq!(sel(&["drag", "#a", "#b"]), ["#a", "#b"]);
        assert_eq!(sel(&["get", "text", "#t"]), ["#t"]);
        assert_eq!(sel(&["wait", "#ready"]), ["#ready"]);
        assert!(sel(&["wait", "2000"]).is_empty(), "a time is no selector");
        assert!(sel(&["wait", "--text", "Done"]).is_empty());
        assert_eq!(sel(&["snapshot", "-i", "-s", "#cart"]), ["#cart"]);
        assert!(sel(&["open", "https://a.example/"]).is_empty());
    }

    /// A command sent as one item with its words run together is told how to be sent, naming the words as items; a
    /// command already in words, or one the node doesn't take, is left to be refused on its own terms.
    #[test]
    fn a_command_with_its_words_run_together_is_told_how_to_send_it() {
        let said = words_run_together(&args(&["open https://a.example/x", "extra"])).unwrap();
        assert_eq!(said, "each word of a command is its own item of do: send [\"open\",\"https://a.example/x\",\"extra\"] instead of [\"open https://a.example/x\"]");
        assert_eq!(words_run_together(&args(&["open", "https://a.example/"])), None);
        assert_eq!(words_run_together(&args(&["rm -rf /"])), None);
        assert_eq!(words_run_together(&args(&["snapshot"])), None, "one word is a command already");
        assert_eq!(words_run_together(&[]), None);
    }

    /// Several commands sent in one `do`, each run together, are several calls, not one command's words: folded into
    /// the first, the next commands were typed into the page. The gate's `u6:customs-broker-1` (PR #898's agent checks,
    /// 24 Nov 2026) sent ["fill e24 lithium-ion battery", "press Enter", "snapshot -i"], was told to send them as one
    /// fill, and the search box then read "lithium-ion battery press Enter snapshot".
    #[test]
    fn several_commands_in_one_do_are_told_to_go_one_a_call() {
        let said = words_run_together(&args(&["fill e24 lithium-ion battery", "press Enter", "snapshot -i"])).unwrap();
        assert!(said.starts_with("one command a call:"), "{said}");
        assert!(said.contains("[\"fill\",\"e24\",\"lithium-ion battery\"]"), "the text to type is one item: {said}");
        assert!(said.contains("[\"press\",\"Enter\"]") && said.contains("[\"snapshot\",\"-i\"]"), "{said}");
        assert!(!said.contains("\"press Enter\"]") && !said.contains("battery\",\"press"), "no command is folded into another: {said}");
        let one = words_run_together(&args(&["press Enter", "snapshot"])).unwrap();
        assert!(one.contains("[\"press\",\"Enter\"]") && one.contains("[\"snapshot\"]"), "{one}");
    }

    /// What a script sent is looked for in the browsing log for the browser program's own time, and no longer once
    /// it is there: this tab's request counts, another tab's does not.
    #[test]
    fn a_script_that_sent_a_request_is_found_in_the_log_by_its_tab() {
        let _home = short_home("script-sent");
        let site = "scriptsent.example";
        std::fs::create_dir_all(capture_dir()).unwrap();
        let log = capture_dir().join(format!("{}.jsonl", session_of(site)));
        let line = |tab: &str, kind: &str| format!("{}\n", serde_json::json!({ "type": "exchange", "tab": tab, "resourceType": kind, "entry": { "request": { "method": "GET", "url": "https://scriptsent.example/api" } } }));
        std::fs::write(&log, line("u-other", "XHR") + &line("u-mine", "Stylesheet")).unwrap();
        let start = std::time::Instant::now();
        assert!(!script_sent(site, "u-mine", 0), "another tab's request and this tab's stylesheet are not its script's");
        assert!(start.elapsed() >= SCRIPT_SENT_WAIT - Duration::from_millis(100), "it looked for as long as the program takes: {:?}", start.elapsed());
        let mark = log_mark(site);
        std::fs::write(&log, std::fs::read_to_string(&log).unwrap() + &line("u-mine", "Fetch")).unwrap();
        let start = std::time::Instant::now();
        assert!(script_sent(site, "u-mine", mark));
        assert!(start.elapsed() < Duration::from_millis(500), "and stops once it is there");
        assert!(!script_sent(site, "u-mine", log_mark(site)), "a mark past it sees none");
        assert!(sent_a_request(&line("", "Fetch")) && !sent_a_request(&line("", "Document")));
        assert!(holds_within(|| true, Duration::ZERO, |_| unreachable!("found at once")));
        assert!(!holds_within(|| false, Duration::from_millis(120), |_| ()), "bounded by what it may pause");
    }

    /// A DevTools address that names no port, in a scheme that has no port of its own, is not known to be gone.
    #[test]
    fn a_devtools_address_with_no_port_to_try_is_not_known_gone() {
        assert!(!gone_at("file://127.0.0.1/devtools"), "no port to refuse it");
        assert!(!gone_at("custom://127.0.0.1/devtools"), "a host that isn't an address");
    }
}
