//! What the CLI prints, without `--json`, for each shape of daemon reply.
//!
//! The daemon answers every command with JSON; the plain-text printers in `output.rs` turn it into the lines a
//! person (or an agent reading a terminal) sees. Each case here scripts one reply on the stand-in daemon, runs a
//! command line that produces the action the printer keys on, and holds the exact text that comes back. A line is
//! anchored to the start of a line when its expectation begins with `\n`; one beginning with `!` must not appear.

use super::*;

/// Run `args` against a daemon that answers `data`, and hold that every expectation is in what came back.
fn check(daemon: &Daemon, args: &[&str], data: Value, expect: &[&str]) {
    daemon.answer_with(move |_: &Value| json!({"success": true, "data": data.clone()}));
    let out = daemon.run(args, "");
    let shown = format!("\n{}", text(&out));
    assert!(out.status.success(), "{args:?}: {shown}");
    for want in expect {
        match want.strip_prefix('!') {
            Some(unwanted) => {
                assert!(
                    !shown.contains(unwanted),
                    "{args:?} printed {unwanted:?}: {shown}"
                )
            }
            None => assert!(
                shown.contains(want),
                "{args:?} did not print {want:?}: {shown}"
            ),
        }
    }
}

/// A command that has no printer branch of its own, so the reply's shape alone picks the printer.
const PLAIN: &[&str] = &["back"];

#[test]
fn tab_list_prints_each_tab_with_its_id_and_marks_the_active_one() {
    let d = Daemon::start();
    check(
        &d,
        &["tab", "list"],
        json!({"tabs": [
            {"tabId": "t1", "label": "main", "title": "Home", "url": "https://a.test/", "active": true},
            {"tabId": "t2", "title": "Docs", "url": "https://b.test/"},
            {}
        ]}),
        &[
            "\n→ [t1] main Home - https://a.test/",
            "\n  [t2] Docs - https://b.test/",
            "\n  [?] Untitled - ",
        ],
    );
}

#[test]
fn tab_commands_say_which_tab_they_switched_to_opened_and_closed() {
    let d = Daemon::start();
    let ok = "✓";
    let cases: Vec<(&[&str], Value, Vec<String>)> = vec![
        (&["tab", "t2"], json!({"tabId": "t2"}), vec![format!("\n{ok} Switched to tab [t2]\n")]),
        (&["tab", "t2"], json!({"tabId": "t2", "revived": true}), vec![format!("\n{ok} Switched to tab [t2] (revived, page may have reloaded)\n")]),
        (&["tab", "t2"], json!({"tabId": "t2", "dialogBlocked": true}), vec![format!("\n{ok} Switched to tab [t2] (dialog open, resolve it with `dialog accept`/`dialog dismiss`)\n")]),
        (&["tab", "new"], json!({"tabId": "t3", "total": 3}), vec![format!("\n{ok} Tab opened [t3] (3 total)\n")]),
        (&["tab", "new", "--label", "work"], json!({"tabId": "t3", "total": 3, "label": "work"}), vec![format!("\n{ok} Tab opened [t3] work (3 total)\n")]),
        (&["window", "new"], json!({"tabId": "w1", "total": 2}), vec![format!("\n{ok} Window opened [w1] (2 total)\n")]),
        (&["window", "new"], json!({"tabId": "w1", "total": 2, "label": "popup"}), vec![format!("\n{ok} Window opened [w1] popup (2 total)\n")]),
        (&["tab", "close", "t2"], json!({"closed": true, "tabId": "t2"}), vec![format!("\n{ok} Tab [t2] closed\n")]),
        (&["tab", "close", "t2"], json!({"closed": true, "tabId": "t2", "activeTabRevived": true}), vec![format!("\n{ok} Tab [t2] closed (active tab revived, page may have reloaded)\n")]),
        (&["tab", "close"], json!({"closed": true}), vec![format!("\n{ok} Tab closed\n")]),
        (&["close"], json!({"closed": true}), vec![format!("\n{ok} Browser closed\n"), "!recorded step".to_string()]),
        (&["close"], json!({"closed": true, "unsaved": {"steps": 3}}), vec!["  3 recorded step(s) were not saved to a flow\n".to_string()]),
    ];
    for (args, data, expect) in cases {
        let expect: Vec<&str> = expect.iter().map(String::as_str).collect();
        check(&d, args, data, &expect);
    }
}

#[test]
fn console_errors_cookies_and_requests_print_one_line_per_entry() {
    let d = Daemon::start();
    check(
        &d,
        &["console"],
        json!({"messages": [{"type": "error", "text": "boom"}, {"type": "log", "text": "hi"}, {}]}),
        &["\n[error] boom\n", "\n[log] hi\n", "\n[log] \n"],
    );
    check(
        &d,
        &["--content-boundaries", "console"],
        json!({"messages": [{"type": "warning", "text": "careful"}], "origin": "https://a.test"}),
        &[
            "--- AGENT_BROWSER_PAGE_CONTENT nonce=",
            " origin=https://a.test ---\n[warning] careful\n--- END_AGENT_BROWSER_PAGE_CONTENT nonce=",
        ],
    );
    check(
        &d,
        &["errors"],
        json!({"errors": [{"text": "TypeError: x is not a function"}, {"text": "second"}]}),
        &["\n✗ TypeError: x is not a function\n", "\n✗ second\n"],
    );
    check(&d, &["errors"], json!({"errors": []}), &["!✗"]);
    check(
        &d,
        &["--content-boundaries", "errors"],
        json!({"errors": [{"text": "one"}, {"text": "two"}]}),
        &[" origin=unknown ---\n✗ one\n✗ two\n--- END_AGENT_BROWSER_PAGE_CONTENT"],
    );
    check(
        &d,
        &["cookies", "get"],
        json!({"cookies": [{"name": "sid", "value": "abc"}, {"name": "theme", "value": "dark"}]}),
        &["\nsid=abc\n", "\ntheme=dark\n"],
    );
    check(
        &d,
        &["network", "requests"],
        json!({"requests": [
            {"requestId": "r1", "method": "POST", "url": "https://a.test/api", "resourceType": "XHR", "status": 201},
            {"requestId": "r2", "url": "https://a.test/", "resourceType": "Document"}
        ]}),
        &[
            "\n[r1] POST https://a.test/api (XHR) 201\n",
            "\n[r2] GET https://a.test/ (Document)\n",
        ],
    );
    check(
        &d,
        &["network", "requests"],
        json!({"requests": []}),
        &["No requests captured\n"],
    );
}

#[test]
fn clearing_something_names_what_was_cleared() {
    let d = Daemon::start();
    let cleared = json!({"cleared": true});
    for (args, label) in [
        (&["cookies", "clear"][..], "Cookies cleared"),
        (&["console", "--clear"], "Console log cleared"),
        (&["errors", "--clear"], "Page errors cleared"),
        (&["storage", "local", "clear"], "Storage cleared"),
        (&["network", "requests", "--clear"], "Request log cleared"),
    ] {
        check(&d, args, cleared.clone(), &[&format!("\n✓ {label}\n")]);
    }
    check(
        &d,
        &["cookies", "clear"],
        json!({"cleared": false}),
        &["\n✓ Done\n"],
    );
}

#[test]
fn style_and_box_queries_print_labelled_values() {
    let d = Daemon::start();
    check(
        &d,
        &["get", "styles", "button"],
        json!({"elements": [
            {"tag": "button", "text": "Save",
             "box": {"width": 80, "height": 20, "x": 5, "y": 6},
             "styles": {"fontSize": "14px", "fontWeight": "700", "fontFamily": "Arial", "color": "red",
                        "backgroundColor": "blue", "borderRadius": "4px"}},
            {"tag": "a", "text": "",
             "styles": {"fontSize": "12px", "fontWeight": "400", "fontFamily": "Mono", "color": "black",
                        "backgroundColor": "white", "borderRadius": "0px"}},
            {}
        ]}),
        &[
            "\n[0] button \"Save\"\n",
            "\n    box: 80x20 at (5, 6)\n",
            "\n    font: 14px 700 Arial\n",
            "\n    color: red\n",
            "\n    background: blue\n",
            "\n    border-radius: 4px\n",
            "\n[1] a \"\"\n",
            "\n    font: 12px 400 Mono\n",
            "!border-radius: 0px",
            "\n[2] ? \"\"\n",
        ],
    );
    check(
        &d,
        &["get", "box", "#a"],
        json!({"x": 1.5, "y": 2, "width": 30, "height": 40.25}),
        &[
            "\nx:      1.5\n",
            "\ny:      2\n",
            "\nwidth:  30\n",
            "\nheight: 40.25\n",
        ],
    );
    check(
        &d,
        &["get", "styles", "#a"],
        json!({"styles": {"color": "red", "opacity": 0.5}}),
        &["\ncolor: red\n", "\nopacity: 0.5\n"],
    );
    check(
        &d,
        &["is", "visible", "#a"],
        json!({"visible": false}),
        &["\nfalse\n"],
    );
    check(
        &d,
        &["is", "enabled", "#a"],
        json!({"enabled": true}),
        &["\ntrue\n"],
    );
    check(
        &d,
        &["is", "checked", "#a"],
        json!({"checked": false}),
        &["\nfalse\n"],
    );
    check(
        &d,
        &["eval", "1"],
        json!({"result": {"a": [1, 2]}}),
        &["{\n  \"a\": [\n    1,\n    2\n  ]\n}"],
    );
    check(
        &d,
        &["eval", "NaN"],
        json!({"result": null, "unserializable": "NaN"}),
        &["\nNaN\n"],
    );
    check(&d, PLAIN, json!({"box": {"x": 1}}), &["{\n  \"x\": 1\n}"]);
}

#[test]
fn device_list_groups_real_devices_and_simulators_and_marks_booted_ones() {
    let d = Daemon::start();
    check(
        &d,
        &["device", "list"],
        json!({"devices": [
            {"name": "Lewis iPhone", "runtime": "iOS 17.0", "udid": "UDID-REAL", "isRealDevice": true},
            {"isRealDevice": true},
            {"name": "iPhone 15 Pro", "runtime": "iOS 17.2", "udid": "UDID-BOOTED", "state": "Booted"},
            {"name": "iPad", "runtime": "iOS 17.0", "udid": "UDID-OFF", "state": "Shutdown"},
            {}
        ]}),
        &[
            "Connected Devices:\n\n",
            "\n  ● Lewis iPhone (iOS 17.0)\n    UDID-REAL\n",
            "\n  ● Unknown ()\n",
            "Simulators:\n\n",
            "\n  ● iPhone 15 Pro (iOS 17.2)\n    UDID-BOOTED\n",
            "\n  ○ iPad (iOS 17.0)\n    UDID-OFF\n",
            "\n  ○ Unknown ()\n",
        ],
    );
    check(
        &d,
        &["device", "list"],
        json!({"devices": [{"name": "Sim", "runtime": "iOS 16", "udid": "U1", "state": "Booted"}]}),
        &[
            "Simulators:\n\n",
            "\n  ● Sim (iOS 16)\n",
            "!Connected Devices",
        ],
    );
    check(
        &d,
        &["device", "list"],
        json!({"devices": [{"name": "Phone", "runtime": "iOS 17", "udid": "U2", "isRealDevice": true}]}),
        &["Connected Devices:\n\n", "!Simulators:"],
    );
    check(
        &d,
        &["device", "list"],
        json!({"devices": []}),
        &["No iOS devices available. Open Xcode to download simulator runtimes.\n"],
    );
}

#[test]
fn dialog_status_says_whether_a_dialog_is_open_and_how_to_resolve_it() {
    let d = Daemon::start();
    check(
        &d,
        &["dialog", "status"],
        json!({"hasDialog": true, "type": "prompt", "message": "Your name?", "defaultPrompt": "Bob"}),
        &[
            "⚠ JavaScript prompt dialog is open: \"Your name?\"\n",
            "\n  Default prompt text: \"Bob\"\n",
            "\n  Use `dialog accept [text]` or `dialog dismiss` to resolve it\n",
        ],
    );
    check(
        &d,
        &["dialog", "status"],
        json!({"hasDialog": true}),
        &[
            "⚠ JavaScript unknown dialog is open: \"\"\n",
            "!Default prompt text",
        ],
    );
    check(
        &d,
        &["dialog", "status"],
        json!({"hasDialog": false}),
        &["\n✓ No dialog is currently open\n"],
    );
}

#[test]
fn recording_profiling_and_har_commands_report_what_started_and_where_it_went() {
    let d = Daemon::start();
    check(
        &d,
        &["profiler", "start"],
        json!({"started": true}),
        &["\n✓ Profiling started\n"],
    );
    check(
        &d,
        &["network", "har", "start"],
        json!({"started": true}),
        &["\n✓ HAR recording started\n"],
    );
    check(
        &d,
        &["record", "start", "out.webm"],
        json!({"started": true, "path": "out.webm", "fps": 30}),
        &["\n✓ Recording started: out.webm (30 fps)\n"],
    );
    check(
        &d,
        &["record", "start", "out.webm"],
        json!({"started": true}),
        &["\n✓ Recording started\n"],
    );
    check(
        &d,
        &["record", "restart", "b.webm"],
        json!({"restarted": true, "path": "b.webm", "previousPath": "a.webm", "fps": 24}),
        &["\n✓ Recording restarted: b.webm (24 fps) (previous saved to a.webm)\n"],
    );
    check(
        &d,
        &["record", "restart", "b.webm"],
        json!({"restarted": true}),
        &["\n✓ Recording started: unknown\n"],
    );
    check(
        &d,
        &["record", "stop"],
        json!({"frames": 10, "path": "x.webm", "fps": 30, "contactSheetPath": "sheet.png", "contactSheetFrames": 6}),
        &[
            "\n✓ Recording saved to x.webm (30 fps)\n",
            "\n✓ Contact sheet saved to sheet.png (6 frames)\n",
        ],
    );
    check(
        &d,
        &["record", "stop"],
        json!({"frames": 10, "path": "x.webm", "contactSheetPath": "sheet.png"}),
        &["\n✓ Recording saved to x.webm\n", "(0 frames)"],
    );
    check(
        &d,
        &["record", "stop"],
        json!({"frames": 10, "path": "x.webm", "error": "disk full"}),
        &[
            "\n⚠ Recording saved to x.webm - disk full\n",
            "!Contact sheet",
        ],
    );
    check(
        &d,
        &["record", "stop"],
        json!({"frames": 0}),
        &["\n✓ Recording stopped\n"],
    );
    check(
        &d,
        &["trace", "stop"],
        json!({"traceStopped": true}),
        &["\n✓ Trace stopped\n"],
    );
}

#[test]
fn commands_that_write_a_file_name_the_file_and_what_it_holds() {
    let d = Daemon::start();
    check(
        &d,
        &["download", "#dl", "out.bin"],
        json!({"path": "/tmp/o.bin", "suggestedFilename": "report.pdf"}),
        &["\n✓ Downloaded to /tmp/o.bin (report.pdf)\n"],
    );
    check(
        &d,
        &["download", "#dl", "out.bin"],
        json!({"path": "/tmp/o.bin", "filename": ""}),
        &["\n✓ Downloaded to /tmp/o.bin\n"],
    );
    check(
        &d,
        &["download", "#dl", "out.bin"],
        json!({"path": "/tmp/o.bin"}),
        &["\n✓ Download saved to /tmp/o.bin\n"],
    );
    check(
        &d,
        &["screenshot"],
        json!({"changed": false, "revision": 4, "pixelChangeRatio": 0.0123}),
        &["\n✓ Screenshot unchanged (revision 4, 1.2300% pixels changed)\n"],
    );
    check(
        &d,
        &["screenshot", "s.png"],
        json!({"path": "s.png", "annotations": [
            {"number": 1, "ref": "e1", "role": "button", "name": "Save"},
            {"number": 2, "ref": "e2", "role": "link", "name": ""}
        ]}),
        &[
            "\n✓ Screenshot saved to s.png\n",
            "\n   [1] @e1 button \"Save\"\n",
            "\n   [2] @e2 link\n",
        ],
    );
    check(
        &d,
        &["pdf", "p.pdf"],
        json!({"path": "p.pdf"}),
        &["\n✓ PDF saved to p.pdf\n"],
    );
    check(
        &d,
        &["trace", "stop", "t.zip"],
        json!({"path": "t.zip"}),
        &["\n✓ Trace saved to t.zip\n"],
    );
    check(
        &d,
        &["profiler", "stop", "p.json"],
        json!({"path": "p.json", "eventCount": 321}),
        &["\n✓ Profile saved to p.json (321 events)\n"],
    );
    check(
        &d,
        &["network", "har", "stop", "h.har"],
        json!({"path": "h.har", "requestCount": 17}),
        &["\n✓ HAR saved to h.har (17 requests)\n"],
    );
    check(
        &d,
        &["state", "save", "s.json"],
        json!({"path": "s.json"}),
        &["\n✓ State saved to s.json\n"],
    );
    check(
        &d,
        &["state", "load", "s.json"],
        json!({"path": "s.json", "note": "Loaded on next launch", "skippedOrigins": ["https://x.test", "https://y.test"]}),
        &[
            "\nLoaded on next launch\n",
            "\n✓ State path set to s.json\n",
            "\n⚠ Skipped storage for https://x.test (page did not stay on that origin)\n",
            "\n⚠ Skipped storage for https://y.test (page did not stay on that origin)\n",
        ],
    );
    check(
        &d,
        &["trace", "start"],
        json!({"path": "t.json"}),
        &["\n✓ Saved to t.json\n"],
    );
}

#[test]
fn saved_state_replies_list_rename_clear_summarise_and_clean() {
    let d = Daemon::start();
    check(
        &d,
        PLAIN,
        json!({"directory": "/home/u/states", "files": [
            {"filename": "big.json", "size": 2048, "modified": "2026-01-02T03:04:05Z", "encrypted": true},
            {"filename": "small.json", "size": 10, "modified": "2026-02-03"}
        ]}),
        &[
            "Saved states in /home/u/states\n",
            "\n  big.json (2.0KB, 2026-01-02) [encrypted]\n",
            "\n  small.json (10B, 2026-02-03)\n",
        ],
    );
    check(
        &d,
        PLAIN,
        json!({"files": []}),
        &["\n  No state files found\n", "!Saved states in"],
    );
    check(
        &d,
        PLAIN,
        json!({"renamed": true, "oldName": "a", "newName": "b"}),
        &["\n✓ Renamed a -> b\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"cleared": 3}),
        &["\n✓ Cleared 3 state file(s)\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"summary": {"cookies": 4, "origins": 2}, "encrypted": true}),
        &[
            "State file summary (encrypted):\n",
            "\n  Cookies: 4\n",
            "\n  Origins with localStorage: 2\n",
        ],
    );
    check(
        &d,
        PLAIN,
        json!({"summary": {}}),
        &["State file summary:\n", "\n  Cookies: 0\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"cleaned": 5}),
        &["\n✓ Cleaned 5 old state file(s)\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"note": "Nothing to do here"}),
        &["\nNothing to do here\n"],
    );
}

#[test]
fn auth_replies_list_show_and_confirm_each_profile_change() {
    let d = Daemon::start();
    check(
        &d,
        &["auth", "list"],
        json!({"profiles": [{"name": "gh", "url": "https://github.com", "username": "me"}]}),
        &["Auth profiles:\n", "\n  gh me https://github.com\n"],
    );
    check(
        &d,
        &["auth", "list"],
        json!({"profiles": []}),
        &["No auth profiles saved\n"],
    );
    check(
        &d,
        &["auth", "show", "gh"],
        json!({"profile": {"name": "gh", "url": "https://github.com", "username": "me",
                           "createdAt": "2026-01-01", "lastLoginAt": "2026-02-02"}}),
        &[
            "\nName: gh\n",
            "\nURL: https://github.com\n",
            "\nUsername: me\n",
            "\nCreated: 2026-01-01\n",
            "\nLast login: 2026-02-02\n",
        ],
    );
    check(
        &d,
        &["auth", "show", "gh"],
        json!({"profile": {"name": "gh"}}),
        &["\nName: gh\n", "\nUsername: \n", "!Last login"],
    );
    check(
        &d,
        PLAIN,
        json!({"saved": true, "name": "gh"}),
        &["\n✓ Auth profile 'gh' saved\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"updated": true, "name": "gh"}),
        &["\n✓ Auth profile 'gh' updated\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"saved": true, "updated": true, "name": "gh"}),
        &["saved\n", "!updated"],
    );
    check(
        &d,
        PLAIN,
        json!({"loggedIn": true, "name": "gh"}),
        &["\n✓ Logged in as 'gh'\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"deleted": true, "name": "gh"}),
        &["\n✓ Auth profile 'gh' deleted\n"],
    );
    check(&d, PLAIN, json!({"deleted": true}), &["\n✓ Done\n"]);
}

#[test]
fn a_reply_asking_for_confirmation_prints_the_confirm_and_deny_commands() {
    let d = Daemon::start();
    let pending = json!({
        "confirmation_required": true, "action": "click", "category": "navigation",
        "description": "Click Buy now", "confirmation_id": "c1"
    });
    check(
        &d,
        &["click", "@e1"],
        pending.clone(),
        &[
            "Confirmation required:\n",
            "\n  navigation: Click Buy now\n",
            "\n  Run: agent-browser confirm c1\n",
            "\n  Or:  agent-browser deny c1\n",
        ],
    );
    check(
        &d,
        &["click", "@e1"],
        json!({"confirmation_required": true, "action": "eval"}),
        &[
            "\n  eval\n",
            "\n  Run: agent-browser confirm eval\n",
            "\n  Or:  agent-browser deny eval\n",
            "!eval:",
        ],
    );
    check(
        &d,
        PLAIN,
        json!({"confirmed": true}),
        &["\n✓ Action confirmed\n"],
    );
    check(&d, PLAIN, json!({"denied": true}), &["\n✓ Action denied\n"]);
    check(&d, PLAIN, json!({}), &["\n✓ Done\n"]);
}

#[test]
fn flow_replies_print_steps_saves_runs_and_lists() {
    let d = Daemon::start();
    check(
        &d,
        &["flow", "steps"],
        json!({"steps": [
            {"seq": 1, "ok": true, "command": "open", "url": "https://a.test/", "requests": 3, "saved": true},
            {"seq": 2, "ok": false, "command": "click", "requests": 0}
        ], "lastSave": 1, "unsaved": 1}),
        &[
            "\n  1 ok     open  https://a.test/  requests: 3  (saved)\n",
            "\n  2 FAILED click  -  requests: 0\n",
            "Last save covered step 1; 1 step(s) not saved.",
        ],
    );
    check(
        &d,
        &["flow", "steps"],
        json!({"steps": []}),
        &["No steps recorded yet.\n"],
    );
    check(
        &d,
        &["flow", "save", "search"],
        json!({"name": "search", "origin": "https://a.test", "path": "/f/search.json", "output": "r2",
               "requests": [{"id": "r1", "method": "GET", "url": "https://a.test/a", "bytes": 10},
                            {"id": "r2", "method": "POST", "url": "https://a.test/b", "bytes": 20}],
               "params": ["q", "page"],
               "gaps": [{"step": 3, "command": "upload", "reason": "file input"}],
               "writes": [{"id": "r2", "method": "POST", "url": "https://a.test/b", "kind": "form"}],
               "droppedHeaders": ["cookie", "authorization"],
               "reachNote": "needs login"}),
        &[
            "Saved flow 'search' for https://a.test to /f/search.json\n",
            "\n    r1 GET https://a.test/a (10 bytes)\n",
            "\n  * r2 POST https://a.test/b (20 bytes)\n",
            "\nParams: q, page\n",
            "Not captured:\n  step 3 `upload`: file input\n",
            "Writes (a run needs `--allow-write all` or the ids, or asks to confirm each):\n  r2 POST https://a.test/b form\n",
            "Not saved (taken from the live session at run time): cookie, authorization\n",
            "Not marked local: needs login\n",
            "Unverified until the first successful `flow run`.",
        ],
    );
    check(
        &d,
        &["flow", "save", "bare"],
        json!({"name": "bare", "origin": "https://a.test", "path": "/f/bare.json", "requests": []}),
        &[
            "\nParams: none\n",
            "!Not captured",
            "!Writes",
            "!Not saved",
            "!Not marked local",
        ],
    );
    check(
        &d,
        &["flow", "run", "search"],
        json!({"name": "search", "ms": 40, "data": {"a": 1},
               "steps": [{"id": "s1", "tier": "http", "ms": 12, "fellBack": [{"tier": "page", "error": "blocked"}, {"error": "x"}]},
                         {"id": "s2", "ms": 5}]}),
        &[
            "Flow 'search' ran in 40ms (s1 via http in 12ms after page: blocked; -: x, s2 via - in 5ms), verified\n",
            "\"a\": 1",
        ],
    );
    check(
        &d,
        &["flow", "run", "search"],
        json!({"name": "search", "ms": 7, "steps": [], "drift": {"reason": "fields missing", "tier": "http"}, "saveError": "read-only"}),
        &[
            "Flow 'search' ran in 7ms (), unverified: fields missing on the http tier\n",
            "The flow file was not updated: read-only\n",
        ],
    );
    check(
        &d,
        &["flow", "run", "search"],
        json!({"name": "search", "ms": 7, "steps": [], "drift": {}}),
        &["unverified: response changed on the - tier\n"],
    );
    check(
        &d,
        &["flow", "run", "search"],
        json!({"name": "search", "ms": 7, "steps": [], "empty": true}),
        &["no results, so the flow's verified state is unchanged\n"],
    );
    check(
        &d,
        &["flow", "list"],
        json!({"flows": [
            {"name": "search", "origin": "a.test", "params": ["q"], "verifiedAt": "2026-01-01"},
            {"name": "other", "origin": "b.test", "verifiedAt": null}
        ]}),
        &[
            "\nsearch (a.test) params: q verified\n",
            "\nother (b.test) params: none unverified\n",
            "!recorded on",
        ],
    );
    check(
        &d,
        &["flow", "list"],
        json!({"flows": []}),
        &["No saved flows. Open a session with `--capture flow`, do the task, then run `flow save <name>`.\n"],
    );
}

#[test]
fn a_reply_that_carries_saved_flows_lists_them_after_the_result() {
    let d = Daemon::start();
    check(
        &d,
        PLAIN,
        json!({"flows": [
            {"name": "search", "examples": {"q": "red shoes"}, "verifiedAt": null, "recordedOn": "https://a.test/s",
             "paramSources": {"q": "from tags", "nospace": "tags"}, "itemFields": ["title", "price"]},
            {"name": "other", "verifiedAt": "2026-01-01"}
        ]}),
        &[
            "Saved flows for this site (2). Calling one is faster than driving the page:\n",
            "\n  agent-browser flow run search --param 'q=red shoes'  (unverified)\n",
            "\n    recorded on https://a.test/s\n",
            "\n    q: one of the site's tags values\n",
            "!nospace",
            "\n    item fields: title, price\n",
            "\n  agent-browser flow run other \n",
            "Param values above are the recorded ones;",
        ],
    );
    check(
        &d,
        PLAIN,
        json!({"flows": [{"name": "search"}], "webmcp": {"toolCount": 1, "tools": [{"name": "t"}]}}),
        &["Saved flows for this site (1), observed by agent-browser. Prefer a WebMCP tool above"],
    );
    check(&d, PLAIN, json!({"flows": []}), &["!Saved flows"]);
}

#[test]
fn webmcp_replies_print_tools_observed_flows_and_invocation_status() {
    let d = Daemon::start();
    check(
        &d,
        &["webmcp", "list"],
        json!({"tools": [
            {"name": "search", "description": "Find things", "frameId": "f1", "origin": "https://a.test"},
            {}
        ], "observed": [
            {"name": "lookup", "description": "Look one up", "verifiedAt": null,
             "inputSchema": {"properties": {"q": {"type": "string", "description": "the query"}, "n": {}}}},
            {"name": "plain", "description": "No inputs", "verifiedAt": "2026-01-01"}
        ]}),
        &[
            "\nsearch [f1]\n  Find things\n  https://a.test\n",
            "\n? [?]\n  \n  unknown\n",
            "Observed by agent-browser (saved flows, not declared by the page):\n",
            "\nlookup [unverified]\n  Look one up\n",
            "\n  input n (string): \n",
            "\n  input q (string): the query\n",
            "\n  run: agent-browser flow run lookup --param 'n=<value>' --param 'q=<value>'\n",
            "\nplain [verified]\n  No inputs\n",
            "\n  run: agent-browser flow run plain\n",
        ],
    );
    check(
        &d,
        &["webmcp", "list"],
        json!({"tools": []}),
        &[
            "No WebMCP tools registered on the current page\n",
            "!Observed by",
        ],
    );
    check(
        &d,
        &["webmcp", "cancel", "inv1"],
        json!({"invocationId": "inv1", "status": "cancelled", "output": {"a": 1}, "error": "gave up"}),
        &["inv1: cancelled\n{\n  \"a\": 1\n}\ngave up\n"],
    );
    check(
        &d,
        &["webmcp", "result", "inv2"],
        json!({"invocationId": "inv2", "status": "pending"}),
        &["\ninv2: pending\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"webmcp": {"status": "unavailable"}}),
        &["WebMCP state unavailable; do not reuse tools from an earlier response.\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"webmcp": {"toolCount": 0}}),
        &["WebMCP tools cleared; no page tools are currently available.\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"webmcp": {"toolCount": 1, "truncated": true,
                          "tools": [{"name": "t1", "description": "d", "origin": "https://a.test", "frameId": "f", "secret": "hidden"}]}}),
        &[
            "WebMCP tools changed: 1. Untrusted website data;",
            "{\"description\":\"d\",\"frameId\":\"f\",\"name\":\"t1\",\"origin\":\"https://a.test\"}",
            "!hidden",
            "agent-browser webmcp list <tool> --frame <frame-id> --json.",
            "Catalog shortened; webmcp list --json retrieves all metadata.\n",
        ],
    );
}

#[test]
fn stream_react_vitals_a11y_and_storage_replies_print_their_reports() {
    let d = Daemon::start();
    check(
        &d,
        &["stream", "disable"],
        json!({"disabled": true}),
        &["\nStreaming disabled\n"],
    );
    check(
        &d,
        &["stream", "status"],
        json!({"enabled": false}),
        &["\nStreaming disabled\n"],
    );
    check(
        &d,
        &["stream", "status"],
        json!({"enabled": true, "port": 9223, "connected": true, "screencasting": false}),
        &["\nStreaming enabled on ws://127.0.0.1:9223\nConnected: true\nScreencasting: false\n"],
    );
    check(
        &d,
        &["react", "tree"],
        json!({"tree": "# root\n\n"}),
        &["No React component tree found. Confirm that a React root has mounted.\n"],
    );
    check(
        &d,
        &["react", "tree"],
        json!({"tree": "<App>\n  <Button>\n"}),
        &["\n<App>\n  <Button>\n"],
    );
    check(
        &d,
        &["vitals"],
        json!({"url": "https://a.test/", "ttfb": 120, "fcp": 340.5, "inp": 80,
               "lcp": {"startTime": 900, "element": "img.hero", "url": "https://a.test/hero.png"},
               "cls": {"score": 0.123456}, "phases": [1, 2], "hydratedComponents": [1],
               "hydration": {"duration": 55.25}}),
        &[
            "\nurl: https://a.test/\n",
            "\nttfb: 120ms  fcp: 340.5ms  lcp: 900ms  cls: 0.12  inp: 80ms\n",
            "\nlcp: element: img.hero  asset: https://a.test/hero.png\n",
            "\nhydration: 55.25ms  phases: 2  hydratedComponents: 1\n",
        ],
    );
    check(
        &d,
        &["vitals"],
        json!({}),
        &[
            "\nurl: -\n",
            "\nttfb: -  fcp: -  lcp: -  cls: -  inp: -\n",
            "\nhydration: -  phases: 0  hydratedComponents: 0\n",
            "!asset",
        ],
    );
    check(
        &d,
        &["a11y"],
        json!({"url": "https://a.test/", "axeVersion": "4.9", "counts": {"violations": 2, "incomplete": 1, "passes": 30},
               "violations": [
                 {"id": "color-contrast", "impact": "serious", "help": "Needs contrast", "helpUrl": "https://dequeuniversity.com/c",
                  "nodeCount": 3, "nodes": [{"target": ["#a"]}, {"target": [["#host", ["#inner"]], ".b"]}, {"target": "p"}, {"target": 5}]},
                 {"id": "label", "help": "Needs label", "nodeCount": 1}
               ],
               "incomplete": [{"id": "aria", "impact": "minor", "help": "Check aria", "nodeCount": 4, "nodes": [{"target": ["#z"]}]}]}),
        &[
            "\naxe-core: 4.9  violations: 2  incomplete: 1  passes: 30\n",
            "\n[serious] color-contrast: Needs contrast (3 nodes)\n",
            "\n  https://dequeuniversity.com/c\n",
            "\n  - #a\n",
            "\n  - #host >>> #inner -> .b\n",
            "\n  - p\n",
            "\n[unknown] label: Needs label (1 node)\n",
            "\nincomplete (needs manual review):\n",
            "\n[minor] aria: Check aria (4 nodes)\n",
            "\n  … and 3 more nodes\n",
        ],
    );
    check(
        &d,
        &["storage", "local"],
        json!({"data": {"theme": "dark", "n": 5}}),
        &["\ntheme: dark\n", "\nn: 5\n"],
    );
    check(
        &d,
        &["storage", "local"],
        json!({"data": {}}),
        &["No storage entries\n"],
    );
    check(
        &d,
        &["storage", "local", "theme"],
        json!({"key": "theme", "value": {"x": 1}}),
        &["\ntheme: {\"x\":1}\n"],
    );
}

#[test]
fn page_replies_print_the_snapshot_text_title_and_value_the_command_asked_for() {
    let d = Daemon::start();
    check(
        &d,
        &["inspect"],
        json!({"opened": true, "url": "http://localhost:9222/x"}),
        &["\n✓ Opened DevTools: http://localhost:9222/x\n"],
    );
    check(
        &d,
        &["inspect"],
        json!({"opened": true}),
        &["\n✓ Opened DevTools\n"],
    );
    check(
        &d,
        &["inspect"],
        json!({"opened": false, "error": "no display"}),
        &["Could not open DevTools: no display\n"],
    );
    check(
        &d,
        &["read", "https://a.test/"],
        json!({"content": "# Heading\nbody", "finalUrl": "https://a.test/final"}),
        &["\n# Heading\nbody\n"],
    );
    check(
        &d,
        &["--content-boundaries", "read", "https://a.test/"],
        json!({"content": "body", "url": "https://a.test/u"}),
        &[" origin=https://a.test/u ---\nbody\n--- END_AGENT_BROWSER_PAGE_CONTENT"],
    );
    check(
        &d,
        &["get", "cdp-url"],
        json!({"cdpUrl": "ws://127.0.0.1:9222/x"}),
        &["\nws://127.0.0.1:9222/x\n"],
    );
    check(
        &d,
        PLAIN,
        json!({"report": "Renders: 3"}),
        &["\nRenders: 3\n"],
    );
    check(
        &d,
        &["get", "url"],
        json!({"url": "https://a.test/"}),
        &["\nhttps://a.test/\n"],
    );
    check(
        &d,
        &["open", "https://a.test/"],
        json!({"url": "https://a.test/", "title": "Home"}),
        &["\n✓ Home\n", "\n  https://a.test/\n"],
    );
    check(
        &d,
        &["snapshot"],
        json!({"snapshot": {"kind": "unchanged", "revision": 7}}),
        &["unchanged (revision 7)\n"],
    );
    check(
        &d,
        &["snapshot"],
        json!({"snapshot": {"kind": "full", "tree": "- button \"Go\" [ref=e1]"}}),
        &["\n- button \"Go\" [ref=e1]\n"],
    );
    check(
        &d,
        &["snapshot"],
        json!({"snapshot": {"kind": "delta", "revision": 8, "changes": []}}),
        &["\"kind\": \"delta\"", "\"revision\": 8"],
    );
    check(
        &d,
        &["snapshot"],
        json!({"snapshot": {"kind": "other"}}),
        &["\n{\"kind\":\"other\"}\n"],
    );
    check(
        &d,
        &["get", "text", "body"],
        json!({"text": "Hello"}),
        &["\nHello\n"],
    );
    check(
        &d,
        &["get", "html", "body"],
        json!({"html": "<b>x</b>"}),
        &["\n<b>x</b>\n"],
    );
    check(
        &d,
        &["get", "value", "#a"],
        json!({"value": "typed"}),
        &["\ntyped\n"],
    );
    check(&d, &["get", "count", "li"], json!({"count": 4}), &["\n4\n"]);
    check(
        &d,
        &["get", "title"],
        json!({"title": "Home"}),
        &["\nHome\n"],
    );
}

#[test]
fn output_is_cut_to_max_output_and_wrapped_in_boundaries_on_request() {
    let d = Daemon::start();
    check(
        &d,
        &["--max-output", "10", "get", "text", "body"],
        json!({"text": "short"}),
        &["\nshort\n", "!truncated"],
    );
    check(
        &d,
        &["--max-output", "4", "get", "text", "body"],
        json!({"text": "abcdefghij"}),
        &["\nabcd\n[truncated: showing 4 of 10 chars. Use --max-output to adjust]\n"],
    );
    // Ten bytes but five characters: under the limit, so nothing is cut.
    check(
        &d,
        &["--max-output", "8", "get", "text", "body"],
        json!({"text": "ééééé"}),
        &["\nééééé\n", "!truncated"],
    );
    check(
        &d,
        &["--content-boundaries", "get", "text", "body"],
        json!({"text": "x"}),
        &[" origin=unknown ---\nx\n--- END_AGENT_BROWSER_PAGE_CONTENT"],
    );
    let out = d.run(&["--json", "--content-boundaries", "get", "url"], "");
    let printed = stdout_json(&out);
    d.answer_with(|_| json!({"success": true, "data": {"url": "https://a.test/"}}));
    let printed2 = stdout_json(&d.run(&["--json", "--content-boundaries", "get", "url"], ""));
    assert_eq!(
        printed2["_boundary"]["origin"], "https://a.test/",
        "{printed} {printed2}"
    );
    assert!(
        printed2["_boundary"]["nonce"]
            .as_str()
            .is_some_and(|n| !n.is_empty()),
        "{printed2}"
    );
    d.answer_with(|_| json!({"success": true, "data": {"count": 1}}));
    let unknown = stdout_json(&d.run(
        &["--json", "--content-boundaries", "get", "count", "li"],
        "",
    ));
    assert_eq!(unknown["_boundary"]["origin"], "unknown", "{unknown}");
}

#[test]
fn diff_replies_print_added_and_removed_lines_and_how_many_pixels_differ() {
    let d = Daemon::start();
    check(
        &d,
        &["diff", "snapshot"],
        json!({"changed": false}),
        &["\n✓ No changes detected\n"],
    );
    check(
        &d,
        &["diff", "snapshot"],
        json!({"changed": true, "diff": "+ new line\n- old line\n same line", "additions": 1, "removals": 1, "unchanged": 5}),
        &[
            "\n+ new line\n",
            "\n- old line\n",
            "\n same line\n",
            "\n1 additions, 1 removals, 5 unchanged\n",
        ],
    );
    check(
        &d,
        &["diff", "screenshot", "--baseline", "b.png"],
        json!({"match": true, "totalPixels": 100, "differentPixels": 0}),
        &[
            "\n✓ Images match (0% difference)\n",
            "\n  0 different / 100 total pixels\n",
            "!Diff image",
        ],
    );
    check(
        &d,
        &["diff", "screenshot", "--baseline", "b.png"],
        json!({"match": false, "mismatchPercentage": 12.345, "diffPath": "d.png", "totalPixels": 200, "differentPixels": 25}),
        &[
            "\n✗ 12.35% pixels differ\n",
            "\n  Diff image: d.png\n",
            "\n  25 different / 200 total pixels\n",
        ],
    );
    check(
        &d,
        &["diff", "screenshot", "--baseline", "b.png"],
        json!({"dimensionMismatch": true}),
        &["\n✗ Images have different dimensions\n"],
    );
    check(
        &d,
        &[
            "diff",
            "url",
            "https://a.test",
            "https://b.test",
            "--screenshot",
        ],
        json!({"snapshot": {"changed": true, "diff": "+ x", "additions": 1, "removals": 0, "unchanged": 2},
               "screenshot": {"match": true, "totalPixels": 4, "differentPixels": 0}}),
        &[
            "Snapshot diff:\n",
            "\n+ x\n",
            "\n1 additions, 0 removals, 2 unchanged\n",
            "\nScreenshot diff:\n",
            "\n✓ Images match (0% difference)\n",
        ],
    );
}

#[test]
fn lifecycle_notes_and_failures_go_to_stderr_with_their_marks() {
    let d = Daemon::start();
    let err = |args: &[&str], data: Value| {
        d.answer_with(move |_: &Value| json!({"success": true, "data": data.clone()}));
        let out = d.run(args, "");
        String::from_utf8_lossy(&out.stderr).into_owned()
    };
    assert!(
        err(PLAIN, json!({"lifecycle": {"relaunchedBrowser": true}}))
            .contains("[agent-browser] relaunched browser\n")
    );
    assert!(err(PLAIN, json!({"lifecycle": {"launched": true}}))
        .contains("[agent-browser] launched browser\n"));
    assert!(!err(
        PLAIN,
        json!({"lifecycle": {"launched": true, "reused": true}})
    )
    .contains("launched browser"));
    let forced = err(
        PLAIN,
        json!({"lifecycle": {"relaunchedBrowser": true, "settings": {"forcedRelaunch": true}}}),
    );
    assert!(
        forced.contains("browser: relaunched (--relaunch)"),
        "{forced}"
    );
    assert!(
        !forced.contains("[agent-browser] relaunched browser"),
        "{forced}"
    );
    let status = err(
        PLAIN,
        json!({"lifecycle": {"restoreStatus": "restored", "saveStatus": "saved"}}),
    );
    assert!(
        status.contains("[agent-browser] restore: restored; save: saved\n"),
        "{status}"
    );
    let quiet = err(
        PLAIN,
        json!({"lifecycle": {"restoreStatus": "pending", "saveStatus": "not_attempted"}}),
    );
    assert!(!quiet.contains("[agent-browser]"), "{quiet}");

    d.answer_with(
        |_| json!({"success": false, "error": "Element not found", "warning": "A dialog is open"}),
    );
    let out = d.run(&["click", "#gone"], "");
    let shown = text(&out);
    assert_eq!(out.status.code(), Some(1), "{shown}");
    assert!(shown.contains("✗ Element not found\n"), "{shown}");
    assert!(shown.contains("⚠ A dialog is open\n"), "{shown}");
    d.answer_with(|_| json!({"success": false}));
    let shown = text(&d.run(&["click", "#gone"], ""));
    assert!(shown.contains("✗ Unknown error\n"), "{shown}");
    d.answer_with(|_| json!({"success": true, "data": {}, "warning": "Slow page"}));
    let shown = text(&d.run(PLAIN, ""));
    assert!(
        shown.contains("⚠ Slow page\n") && shown.contains("✓ Done\n"),
        "{shown}"
    );
}
