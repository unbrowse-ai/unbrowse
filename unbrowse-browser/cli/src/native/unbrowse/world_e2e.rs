//! The agent's world in a real browser (`world.rs`, `world.js`, `activation.js`), as they stood in the fork's tests
//! before 21 November 2026 (`e2e_tests.rs`, the agent's world): a caller's script reads the session as a stand-in, no
//! way into the page's own world is left open from it, and the browser's own commands never activate a script
//! address. They need Chrome and are `#[ignore]`d like upstream's e2e tests:
//! `cargo test --manifest-path unbrowse-browser/cli/Cargo.toml unbrowse::world_e2e -- --ignored --test-threads=1`.

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::super::actions::{execute_command, DaemonState};

pub(super) fn assert_success(resp: &Value) {
    assert_eq!(resp.get("success").and_then(Value::as_bool), Some(true), "Expected success but got: {}", serde_json::to_string_pretty(resp).unwrap_or_default());
}

/// A command as the daemon runs it, but `page_evaluate`: a script of the test's own in the page's own world, for its
/// setup and its checks only (the page's code, its title, what it ran). No caller reaches the page's world.
pub(super) async fn run(cmd: &Value, state: &mut DaemonState) -> Value {
    if cmd["action"] != "page_evaluate" {
        return execute_command(cmd, state).await;
    }
    let script = cmd["script"].as_str().unwrap_or_default();
    let Some(mgr) = state.browser.as_ref() else { return json!({ "id": cmd["id"], "success": false, "error": "Browser not launched" }) };
    match mgr.evaluate(script, None).await {
        Ok(result) => json!({ "id": cmd["id"], "success": true, "data": { "result": result } }),
        Err(error) => json!({ "id": cmd["id"], "success": false, "error": error }),
    }
}

pub(super) async fn start_routed_server(route: fn(&str, &str) -> (u16, String, String)) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let handle = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut seen = Vec::new();
                let mut buf = vec![0u8; 65536];
                let head_end = loop {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    seen.extend_from_slice(&buf[..n]);
                    if let Some(i) = seen.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&seen[..head_end]).to_string();
                let length: usize = head
                    .lines()
                    .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                    .unwrap_or(0);
                while seen.len() < head_end + length {
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    seen.extend_from_slice(&buf[..n]);
                }
                let mut first = head.lines().next().unwrap_or("").split_whitespace();
                let (method, path) = (first.next().unwrap_or(""), first.next().unwrap_or("/"));
                let (status, headers, body) = route(method, path);
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.flush().await;
            });
        }
    });
    (base_url, handle)
}

fn session_route(_method: &str, path: &str) -> (u16, String, String) {
    let page = "<!doctype html><title>t</title><link rel=icon href='data:,'><script>\
        localStorage.setItem('authState', 'St0rageSessionToken55'); window.appState = 'the page';\
        document.title = document.cookie.indexOf('ScriptReadableSession77') >= 0 ? 'sees its cookie' : 'blind';\
        </script><p id=p>app</p><a id=js href=\"javascript:document.title='ran'\">run</a>\
        <a id=noop href=\"javascript:void(0)\" onclick=\"document.title='noop clicked'\">noop</a>\
        <form id=f action=\"javascript:document.title='submitted'\"><input id=q name=q><button id=go>go</button></form>\
        <form id=f2 action=\"/ok\"><input type=submit id=s formaction=\"javascript:document.title='label'\"></form><label id=l for=s>by label</label>\
        <label id=l2><span id=inl>inside a label</span><input type=image form=f2 formaction=\"javascript:document.title='nested'\"></label>\
        <form id=f3 action=\"javascript:document.title='form attribute'\"></form><button id=b3 form=f3>owned from outside</button>\
        <form id=f4 action=\"/ok\"><input id=q4 name=q4><button formaction=\"javascript:document.title='implicit'\">default</button></form>\
        <img id=m usemap=\"#mp\" width=10 height=10 src=\"data:image/gif;base64,R0lGODlhAQABAAAAACw=\"><map name=mp><area href=\"javascript:document.title='map'\" shape=rect coords=\"0,0,10,10\"></map>\
        <details><summary id=sm>more</summary>details</details>\
        <a id=ak accesskey=k href=\"javascript:document.title='access key'\">by access key</a><input id=plain>"
        .to_string();
    match path {
        "/" => (200, "Set-Cookie: sid=HttpOnlySession66; Path=/; HttpOnly\r\nSet-Cookie: pref=ScriptReadableSession77; Path=/\r\n".into(), page),
        _ => (200, String::new(), page),
    }
}


/// A caller's script runs in a world of its own, where the site's session reads as `{session}` before the script can
/// change it: `evaluate`, a wait on a function and a handle all read the stand-in, a frame the script makes does too,
/// writes and what can't be a stand-in are refused, and the page's own code still sees its cookie and its globals.
#[tokio::test]
#[ignore]
async fn e2e_a_callers_script_reads_the_session_as_a_stand_in() {
    let (base_url, server) = start_routed_server(session_route).await;
    let mut state = DaemonState::new();
    for command in [json!({ "id": "launch", "action": "launch", "headless": true }), json!({ "id": "open", "action": "navigate", "url": format!("{base_url}/") })] {
        assert_success(&run(&command, &mut state).await);
    }
    let said = |r: &Value| r["data"]["result"].clone();
    for (script, want) in [
        ("document.title", json!("sees its cookie")),
        // Another server on this machine may have left a cookie on 127.0.0.1 (a cookie isn't kept by port): the page's
        // own is read out of the rest.
        ("PREF(document.cookie)", json!("pref={session}")),
        ("btoa(PREF(document.cookie))", json!("cHJlZj17c2Vzc2lvbn0=")),
        ("[...PREF(document.cookie)].reverse().join('')", json!("}noisses{=ferp")),
        ("(() => { const f = document.createElement('iframe'); document.body.appendChild(f); return [PREF(f.contentWindow.document.cookie), PREF(window[window.length - 1].document.cookie)].join(' | '); })()", json!("pref={session} | pref={session}")),
        ("document.cookie.indexOf('Session') < 0 && document.cookie.indexOf('{session}') >= 0", json!(true)),
        ("localStorage.getItem('authState') + ' ' + JSON.stringify(localStorage)", json!("{session} {\"authState\":\"{session}\"}")),
        ("typeof window.appState", json!("undefined")),
    ] {
        let script = script.replace("PREF(", "((c) => c.split('; ').filter((p) => p.startsWith('pref=')).join())(");
        let resp = run(&json!({ "id": "e", "action": "evaluate", "script": script }), &mut state).await;
        assert_success(&resp);
        assert_eq!(said(&resp), want, "{script}");
    }
    for script in ["document.cookie = 'pref=x'", "localStorage.setItem('authState', 'x')", "indexedDB", "document.createElement('script')", "document.body.innerHTML = '<img src=x onerror=1>'", "typeof caches", "indexedDB.open('x')", "new Worker('data:,')", "new SharedWorker('data:,')", "navigator.serviceWorker.register('/sw.js')", "cookieStore.get('pref')", "navigator.storage.estimate()", "document.body.setAttribute('onclick', '1')"] {
        let resp = run(&json!({ "id": "r", "action": "evaluate", "script": script }), &mut state).await;
        assert!(resp.to_string().contains("isn't open to an agent's script"), "{script}: {resp}");
    }
    // No script address is written from this world, by any property or attribute, however it is spelled.
    for script in [
        "(() => { const a = document.createElementNS('http://www.w3.org/2000/svg', 'a'); a.href.baseVal = 'javascript:document.title=1'; return 1; })()",
        "(() => { const a = document.createElementNS('http://www.w3.org/2000/svg', 'a'); a.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', ' \\u0001JaVa\\tScRiPt:document.title=1'); return 1; })()",
        "(() => { const m = document.createElement('meta'); m.content = '0;url=javascript:document.title=1'; return 1; })()",
        "(() => { const v = document.createElementNS('http://www.w3.org/2000/svg', 'animate'); v.setAttribute('values', 'x;javascript:document.title=1'); return 1; })()",
        "(() => { document.getElementById('f').action = 'javascript:document.title=1'; return 1; })()",
        "(() => { const a = document.createElement('a'); a.setAttribute('href', { toString: (() => { let n = 0; return () => n++ ? 'https://ok.example/' : 'javascript:document.title=1'; })() }); return 1; })()",
        // What the page holds, activated by the script itself.
        "document.getElementById('js').click()",
        "document.getElementById('js').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
        "document.getElementById('f').requestSubmit()",
        "document.getElementById('f').submit()",
        // Activation the platform forwards: a label to its control, a span inside a label, a control to the form its
        // `form` attribute names from outside, an image to its map's areas, Enter in a field to its form's default button.
        "document.getElementById('l').click()",
        "document.getElementById('l').dispatchEvent(new MouseEvent('click', { bubbles: true }))",
        "document.getElementById('inl').click()",
        "document.getElementById('b3').click()",
        "document.getElementById('m').click()",
        "document.getElementById('q4').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))",
        "document.getElementById('f4').requestSubmit()",
        // A pattern's own replace, swapped by the script, reaches nothing the world reads an address with.
        "(() => { RegExp.prototype[Symbol.replace] = () => 'https://ok.example/'; String.prototype.replace = () => 'https://ok.example/'; document.createElement('a').href = 'javascript:document.title=1'; })()",
        "(() => { Array.prototype.shift = () => undefined; Array.prototype.indexOf = () => 0; document.getElementById('l').click(); })()",
        "typeof navigation",
        // Markup for a frame, and the page's own scripts: no code of the agent's is parsed into the page's world.
        "document.createElement('iframe').srcdoc = '<script>document.title = 1</script>'",
        "document.createElement('div').append(document.createElement('div'), document.querySelector('script'))",
    ] {
        let resp = run(&json!({ "id": "a", "action": "evaluate", "script": script }), &mut state).await;
        assert!(resp.to_string().contains("isn't open to an agent's script"), "{script}: {resp}");
    }
    // A text that changes between reads is read once, and that text is what is written.
    let resp = run(&json!({ "id": "b", "action": "evaluate", "script": "(() => { const b = document.createElement('base'); b.href = { toString: (() => { let n = 0; return () => n++ ? 'javascript:document.title=1' : 'https://ok.example/'; })() }; return b.getAttribute('href'); })()" }), &mut state).await;
    assert_eq!(said(&resp), json!("https://ok.example/"), "{resp}");
    // The page's own world is poisoned before the browser's commands: the guard reads in a world of its own, so what
    // the page replaced there changes nothing it sees.
    let poison = "(() => { Array.prototype.filter = () => []; Array.prototype.map = () => []; Array.prototype.includes = () => false; \
        Array.prototype.indexOf = () => -1; Array.prototype.push = () => 0; String.prototype.indexOf = () => -1; String.prototype.startsWith = () => false; \
        String.prototype.toLowerCase = () => 'https://ok.example/'; String.prototype.replace = () => ''; JSON.stringify = () => '[]'; \
        Element.prototype.getAttribute = () => null; Element.prototype.closest = () => null; \
        Object.defineProperty(Document.prototype, 'activeElement', { get() { return document.body; } }); return 1; })()";
    let resp = run(&json!({ "id": "poison", "action": "page_evaluate", "script": poison }), &mut state).await;
    assert_success(&resp);
    // The browser's own commands never activate a script address the page holds either; a literal no-op is clicked.
    for (command, refused) in [
        (json!({ "id": "c1", "action": "click", "selector": "#js" }), true),
        (json!({ "id": "c2", "action": "click", "selector": "#go" }), true),
        (json!({ "id": "c3", "action": "type", "selector": "#q", "text": "x\n" }), true),
        (json!({ "id": "c4", "action": "focus", "selector": "#js" }), false),
        (json!({ "id": "c5", "action": "press", "key": "Enter" }), true),
        (json!({ "id": "c6", "action": "click", "selector": "#noop" }), false),
        (json!({ "id": "c7", "action": "click", "selector": "#l" }), true),
        (json!({ "id": "c8", "action": "click", "selector": "#inl" }), true),
        (json!({ "id": "c9", "action": "click", "selector": "#b3" }), true),
        (json!({ "id": "c10", "action": "click", "selector": "#m" }), true),
        (json!({ "id": "c11", "action": "type", "selector": "#q4", "text": "x\n" }), true),
        (json!({ "id": "c12", "action": "focus", "selector": "#q4" }), false),
        (json!({ "id": "c13", "action": "press", "key": "Enter" }), true),
        (json!({ "id": "c14", "action": "click", "selector": "#sm" }), false),
        // A chord a platform reads as an access key may activate any element that has one, whatever has the focus.
        (json!({ "id": "c15", "action": "focus", "selector": "#plain" }), false),
        (json!({ "id": "c16", "action": "press", "key": "Alt+k" }), true),
        (json!({ "id": "c17", "action": "press", "key": "Control+Alt+k" }), true),
        (json!({ "id": "c18", "action": "press", "key": "k" }), false),
        // `find` clicks when it names no action: held to the same guard.
        (json!({ "id": "c19", "action": "getbytext", "text": "run", "subaction": "click", "exact": true }), true),
    ] {
        let resp = run(&command, &mut state).await;
        assert_eq!(resp.to_string().contains("script address"), refused, "{command}: {resp}");
    }
    let resp = run(&json!({ "id": "t", "action": "page_evaluate", "script": "document.title" }), &mut state).await;
    assert_eq!(said(&resp), json!("noop clicked"), "only the no-op ran, by the page's own handler");
    // A wait on a function, and a function waited for, read the same world.
    let resp = run(&json!({ "id": "w", "action": "wait", "function": "document.cookie.indexOf('pref={session}') >= 0", "timeout": 2000 }), &mut state).await;
    assert_success(&resp);
    let resp = run(&json!({ "id": "w2", "action": "waitforfunction", "expression": "document.cookie.indexOf('ScriptReadableSession77') < 0 && document.cookie.indexOf('pref={session}') >= 0", "timeout": 2000 }), &mut state).await;
    assert_success(&resp);
    assert_eq!(said(&resp), json!(true));
    // The page's own world keeps the real values.
    // (Read a character at a time: the page's own `String.prototype.indexOf` was poisoned above.)
    let resp = run(&json!({ "id": "p", "action": "page_evaluate", "script": "(() => { const c = document.cookie, w = 'pref=ScriptReadableSession77'; let has = false; for (let i = 0; i + w.length <= c.length; i++) { let ok = true; for (let j = 0; j < w.length; j++) if (c[i + j] !== w[j]) ok = false; if (ok) has = true; } return has && window.appState === 'the page'; })()" }), &mut state).await;
    assert_eq!(said(&resp), json!(true));
    let _ = run(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

fn guard_route(_method: &str, path: &str) -> (u16, String, String) {
    let head = "<!doctype html><link rel=icon href='data:,'>";
    let body = match path {
        // Access keys two frames deep, in this page's own process.
        "/frames" => "<title>top</title><input id=plain><iframe id=f1 src=/inner1></iframe>".to_string(),
        "/inner1" => "<title>inner1</title><iframe id=f2 src=/inner2></iframe>".to_string(),
        "/inner2" => "<title>inner2</title><a accesskey=k href=\"javascript:document.title='ran in a frame'\">deep</a>".to_string(),
        // An access key inside a closed shadow root.
        "/shadow" => "<title>shadow</title><input id=plain><div id=host></div><script>\
            const r = document.getElementById('host').attachShadow({ mode: 'closed' });\
            r.innerHTML = \"<a accesskey=k href=\\\"javascript:document.title='ran in a shadow'\\\">hidden</a>\";</script>"
            .to_string(),
        // An access key in a frame of another site (another process, under site isolation).
        "/cross" => "<title>cross</title><input id=plain><script>const f = document.createElement('iframe');\
            f.src = location.href.replace('127.0.0.1', 'localhost').replace('/cross', '/xframe'); document.body.append(f);</script>"
            .to_string(),
        "/xframe" => "<title>xframe</title><a accesskey=k href=\"javascript:document.title='ran cross-site'\">far</a>".to_string(),
        // A benign access key: the chord goes through.
        "/benign" => "<title>benign</title><input id=plain><a accesskey=k href=\"#reached\">ok</a>".to_string(),
        // The race: a button whose form owner the agent's own timer swaps.
        "/race" => "<title>race</title><form id=safe action=\"javascript:void(0)\"><button id=b3>in a form</button></form>\
            <form id=jsform action=\"javascript:document.title='race won'\"></form><button id=b form=safe>go</button>\
            <form id=safe2 action=\"javascript:void(0)\"><button id=b2>moved</button></form>\
            <input type=submit id=s form=jsform formaction=\"javascript:document.title='label race won'\"><label id=l2>label</label>\
            <a id=jl href=\"javascript:document.title='link race won'\">a script link</a><span id=b4>outside any link</span>"
            .to_string(),
        // The page's own handler rewrites the link it was clicked on.
        "/pagerace" => "<title>pagerace</title><a id=pl href=\"#benign\">x</a><script>\
            document.getElementById('pl').addEventListener('click', () => { document.getElementById('pl').href = \"javascript:document.title='page rewrote it'\"; });</script>"
            .to_string(),
        // A page that evaluates what it is sent: its own code.
        "/gadget" => "<title>gadget</title><script>window.addEventListener('message', (e) => {\
            if (typeof e.data === 'string' && e.data.startsWith('code:')) eval(e.data.slice(5)); });</script>"
            .to_string(),
        _ => "<title>t</title>".to_string(),
    };
    let cookie = if path == "/gadget" || path == "/race" { "Set-Cookie: pref=ScriptReadableSession77; Path=/\r\nSet-Cookie: sid=HttpOnlySession66; Path=/; HttpOnly\r\n" } else { "" };
    (200, cookie.into(), format!("{head}{body}"))
}

async fn open_page(state: &mut DaemonState, url: &str) {
    assert_success(&run(&json!({ "id": "open", "action": "navigate", "url": url }), state).await);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
}

async fn page_title(state: &mut DaemonState) -> Value {
    run(&json!({ "id": "t", "action": "page_evaluate", "script": "document.title" }), state).await["data"]["result"].clone()
}

/// An access-key chord never activates a script address, wherever the element with the key is: two frames deep in this
/// page's process, inside a closed shadow root, or in a frame of another site; a benign access key goes through. The
/// chords are Alt and Control+Alt (on macOS the platform's own is Control+Option; the guard reads any chord with Alt or
/// Control).
#[tokio::test]
#[ignore]
async fn e2e_an_access_key_reaches_no_script_address_in_any_frame() {
    let (base_url, server) = start_routed_server(guard_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    for page in ["/frames", "/shadow", "/cross"] {
        open_page(&mut state, &format!("{base_url}{page}")).await;
        let frames = run(&json!({ "id": "fr", "action": "page_evaluate", "script": "window.frames.length" }), &mut state).await;
        eprintln!("{page}: frames {}, iframe sessions {}", frames["data"]["result"], state.iframe_sessions.len());
        assert_success(&run(&json!({ "id": "f", "action": "focus", "selector": "#plain" }), &mut state).await);
        for chord in ["Alt+k", "Control+Alt+k"] {
            let resp = run(&json!({ "id": "p", "action": "press", "key": chord }), &mut state).await;
            assert!(resp.to_string().contains("script address") || resp.to_string().contains("couldn't be told"), "{page} {chord}: {resp}");
        }
        let title = page_title(&mut state).await;
        assert!(!title.to_string().contains("ran"), "{page}: {title}");
    }
    open_page(&mut state, &format!("{base_url}/benign")).await;
    assert_success(&run(&json!({ "id": "f", "action": "focus", "selector": "#plain" }), &mut state).await);
    for chord in ["Alt+k", "Control+Alt+k"] {
        let resp = run(&json!({ "id": "p", "action": "press", "key": chord }), &mut state).await;
        assert_success(&resp);
    }
    let _ = run(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// The race between the guard's read and the dispatch, and the dispatch itself. The agent's own script may not change
/// where an activation goes (a control's `form`, a label's `for`, `type`) nor stop an event; what it still may do is
/// move nodes. So its timer moves a button between a no-op form and a script-action one, and a script-`formaction`
/// submit into and out of a label, while the browser clicks again and again; and its listener on a button, running
/// during the click's dispatch, moves the button into the script-action form before the default action. None of it
/// may run a script address: the guard's check at the moment of activation reads the click and the submit as they
/// happen. And a page's own click handler that rewrites its link to a `javascript:` address during the click: the
/// record says what this browser then does (SECURITY.md, limit 1).
#[tokio::test]
#[ignore]
async fn e2e_the_race_between_the_guard_and_the_click() {
    let (base_url, server) = start_routed_server(guard_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/race")).await;
    // Where an activation goes is not the agent's to change, nor may it hide an event.
    for script in [
        "document.getElementById('b').setAttribute('form', 'jsform')",
        "document.getElementById('b').removeAttribute('form')",
        "document.getElementById('l2').htmlFor = 's'",
        "document.getElementById('b3').type = 'button'",
        "new Event('click').stopImmediatePropagation()",
        "new Event('click').stopPropagation()",
        "new Event('click').cancelBubble = true",
    ] {
        let resp = run(&json!({ "id": "w", "action": "evaluate", "script": script }), &mut state).await;
        assert!(resp.to_string().contains("isn't open to an agent's script"), "{script}: {resp}");
    }
    // Moves on a timer, while the browser clicks.
    let arm = "(() => { const b2 = document.getElementById('b2'), s = document.getElementById('s'), l2 = document.getElementById('l2'); \
        const safe2 = document.getElementById('safe2'), js = document.getElementById('jsform'); \
        setInterval(() => { (b2.parentNode === safe2 ? js : safe2).append(b2); if (s.parentNode === l2) document.body.append(s); else l2.append(s); }, 0); return 1; })()";
    assert_success(&run(&json!({ "id": "arm", "action": "evaluate", "script": arm }), &mut state).await);
    let (mut before, mut at_activation, mut clicked) = (0, 0, 0);
    for i in 0..200 {
        for selector in ["#b2", "#l2"] {
            let resp = run(&json!({ "id": format!("r{i}"), "action": "click", "selector": selector }), &mut state).await;
            let said = resp.to_string();
            if said.contains("at the moment of activation") { at_activation += 1 } else if said.contains("script address") { before += 1 } else if resp["success"] == json!(true) { clicked += 1 }
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("moves on a timer: {before} refused before the click, {at_activation} refused at the moment of activation, {clicked} clicked through, title {title}");
    assert_eq!(title, json!("race"), "a move by the agent's own timer slipped a script target past the guard");
    // A move during the click's own dispatch, by the agent's listener on the button.
    let during = "(() => { const b3 = document.getElementById('b3'); b3.addEventListener('click', () => document.getElementById('jsform').append(b3)); return 1; })()";
    assert_success(&run(&json!({ "id": "during", "action": "evaluate", "script": during }), &mut state).await);
    let resp = run(&json!({ "id": "d", "action": "click", "selector": "#b3" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("a move during the dispatch: command {}, title {title}", resp.get("error").cloned().unwrap_or(json!("clicked")));
    assert_eq!(title, json!("race"), "a move during the dispatch slipped a script target past the guard");
    // A move of the clicked element into a page's script link, during the dispatch.
    let into = "(() => { const b4 = document.getElementById('b4'); b4.addEventListener('click', () => document.getElementById('jl').append(b4)); return 1; })()";
    assert_success(&run(&json!({ "id": "into", "action": "evaluate", "script": into }), &mut state).await);
    let resp = run(&json!({ "id": "d2", "action": "click", "selector": "#b4" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("a move into a script link during the dispatch: command {}, title {title}", resp.get("error").cloned().unwrap_or(json!("clicked")));
    assert_eq!(title, json!("race"), "a move into a script link during the dispatch ran it");
    // The page's own handler rewrites the link during the click.
    open_page(&mut state, &format!("{base_url}/pagerace")).await;
    let resp = run(&json!({ "id": "pr", "action": "click", "selector": "#pl" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let title = page_title(&mut state).await;
    let shown = run(&json!({ "id": "sh", "action": "page_evaluate", "script": "location.href + ' | ' + (document.body ? document.body.innerText : '')" }), &mut state).await;
    eprintln!("the page's own rewrite during the click: command {}, title after {title}, page now {}", resp.get("error").cloned().unwrap_or(json!("clicked")), shown["data"]["result"]);
    let _ = run(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// What the agent's world reaches at runtime beyond its setters: a `data:` frame it makes runs in an opaque origin and
/// reads nothing of the page; a page that evaluates what it is sent runs it as its own code; and a `javascript:` address
/// the agent gives the page's `location` runs in the page's world, reading what the page's script can (the
/// script-readable cookie, not the HttpOnly one).
#[tokio::test]
#[ignore]
async fn e2e_what_the_agents_world_reaches_beyond_its_setters() {
    let (base_url, server) = start_routed_server(guard_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/gadget")).await;
    let data = "(() => { window.addEventListener('message', (e) => { window.__heard = String(e.data); }); \
        const f = document.createElement('iframe'); \
        f.src = 'data:text/html,<script>let r; try { r = String(document.cookie); } catch (e) { r = e.name; } let p; try { p = parent.document.title; } catch (e) { p = e.name; } parent.postMessage(r + \"|\" + p, \"*\");</script>'; \
        document.body.append(f); return new Promise((ok) => setTimeout(() => ok(String(window.__heard)), 800)); })()";
    let resp = run(&json!({ "id": "d", "action": "evaluate", "script": data }), &mut state).await;
    eprintln!("a data: frame the agent made says: {}", resp["data"]["result"]);
    assert_eq!(resp["data"]["result"], json!("SecurityError|SecurityError"), "{resp}");
    let resp = run(&json!({ "id": "g", "action": "evaluate", "script": "window.postMessage('code:document.title = \"gadget ran: \" + btoa(document.cookie)', '*'); 1" }), &mut state).await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let gadget = page_title(&mut state).await;
    eprintln!("the page's eval gadget, sent code by postMessage: title {gadget}");
    let resp = run(&json!({ "id": "l", "action": "evaluate", "script": "location.href = 'javascript:void(document.title = \"location ran: \" + document.cookie)'; 1" }), &mut state).await;
    assert_success(&resp);
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let located = page_title(&mut state).await;
    eprintln!("location = javascript: from the agent's world: title {located}");
    assert!(located.to_string().contains("pref=ScriptReadableSession77") && !located.to_string().contains("HttpOnlySession66"), "{located}");
    let _ = run(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

fn sinks_route(_method: &str, path: &str) -> (u16, String, String) {
    let page = "<!doctype html><title>sinks</title><link rel=icon href='data:,'>\
        <script type=text/plain id=inert></script><script id=empty></script>\
        <svg><script id=svgs type=text/plain></script></svg>\
        <template id=tpl><script>top.document.title = 'template ran: ' + document.cookie;</script></template><p id=p>sinks</p>"
        .to_string();
    let cookie = if path == "/" { "Set-Cookie: pref=ScriptReadableSession77; Path=/\r\n" } else { "" };
    (200, cookie.into(), page)
}

/// Every way the agent's world could hand markup or code to the page's own world, tried at runtime: each code writes
/// the real cookie into the page's title, which the agent's world can't do itself (it reads `{session}`), so a title
/// holding the real value is code that ran in the page's world. (The name of each, and what it did, is printed.)
#[tokio::test]
#[ignore]
async fn e2e_no_markup_or_code_sink_reaches_the_pages_world() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    // No quotes: it goes inside every kind of string the probes write.
    let code = "top.document.title = String.fromCharCode(114, 97, 110, 58, 32) + document.cookie";
    let sinks: Vec<(&str, String)> = vec![
        ("iframe.srcdoc", format!("(() => {{ const f = document.createElement('iframe'); f.srcdoc = '<script>{code}</script>'; document.body.append(f); return 1; }})()")),
        ("innerHTML", format!("document.body.innerHTML += '<img src=x onerror=\"{code}\">'")),
        ("outerHTML", format!("document.getElementById('p').outerHTML = '<img src=x onerror=\"{code}\">'")),
        ("ShadowRoot.innerHTML", format!("document.getElementById('p').attachShadow({{ mode: 'open' }}).innerHTML = '<img src=x onerror=\"{code}\">'")),
        ("template.innerHTML", format!("(() => {{ const t = document.createElement('template'); t.innerHTML = '<img src=x onerror=\"{code}\">'; document.body.append(t.content.cloneNode(true)); return 1; }})()")),
        ("insertAdjacentHTML", format!("document.body.insertAdjacentHTML('beforeend', '<img src=x onerror=\"{code}\">')")),
        ("setHTMLUnsafe", format!("document.body.setHTMLUnsafe('<img src=x onerror=\"{code}\">')")),
        ("setHTML", format!("(typeof document.body.setHTML === 'function') ? (document.body.setHTML('<img src=x onerror=\"{code}\"><script>{code}</script>'), 'called') : 'absent'")),
        ("Document.parseHTMLUnsafe", format!("document.body.append(...Document.parseHTMLUnsafe('<img src=x onerror=\"{code}\">').body.childNodes)")),
        ("Document.parseHTML", format!("(typeof Document.parseHTML === 'function') ? (document.body.append(...Document.parseHTML('<img src=x onerror=\"{code}\">').body.childNodes), 'called') : 'absent'")),
        ("document.write", format!("document.write('<img src=x onerror=\"{code}\">')")),
        ("document.writeln", format!("document.writeln('<img src=x onerror=\"{code}\">')")),
        ("document.open", format!("(() => {{ const w = document.open('javascript:{code}', '', ''); return String(w); }})()")),
        ("Range.createContextualFragment", format!("document.body.append(document.createRange().createContextualFragment('<img src=x onerror=\"{code}\">'))")),
        ("DOMParser + importNode", format!("document.body.append(document.importNode(new DOMParser().parseFromString('<img src=x onerror=\"{code}\">', 'text/html').body.firstChild, true))")),
        ("createHTMLDocument + adoptNode", format!("(() => {{ const d = document.implementation.createHTMLDocument(''); d.body.innerHTML = '<img src=x onerror=\"{code}\">'; document.body.append(document.adoptNode(d.body.firstChild)); return 1; }})()")),
        ("XSLTProcessor", "new XSLTProcessor()".to_string()),
        ("execCommand insertHTML", format!("(() => {{ document.body.contentEditable = 'true'; document.body.focus(); return document.execCommand('insertHTML', false, '<img src=x onerror=\"{code}\">'); }})()")),
        ("a page's inert script: type and text, re-inserted", format!("(() => {{ const s = document.getElementById('inert'); s.type = 'text/javascript'; s.text = \"{code}\"; s.remove(); document.body.append(s); return 1; }})()")),
        ("a page's empty script: text, re-inserted", format!("(() => {{ const s = document.getElementById('empty'); s.textContent = \"{code}\"; s.remove(); document.body.append(s); return 1; }})()")),
        ("a page's empty script: src to a data: address", format!("(() => {{ const s = document.getElementById('empty'); s.src = 'data:text/javascript,' + encodeURIComponent(\"{code}\"); s.remove(); document.body.append(s); return 1; }})()")),
        ("a page's inert script: cloned", format!("(() => {{ const s = document.getElementById('inert').cloneNode(true); s.type = 'text/javascript'; s.text = \"{code}\"; document.body.append(s); return 1; }})()")),
        ("an SVG script's href", format!("(() => {{ const s = document.getElementById('svgs'); s.setAttribute('type', 'text/javascript'); s.href.baseVal = 'data:text/javascript,' + encodeURIComponent(\"{code}\"); s.remove(); document.querySelector('svg').append(s); return 1; }})()")),
        ("a page's template script, imported", "document.body.append(document.importNode(document.getElementById('tpl').content, true))".to_string()),
        ("object.data data:", format!("(() => {{ const o = document.createElement('object'); o.data = 'data:text/html,' + encodeURIComponent('<script>try {{ {code} }} catch (e) {{ }}</script>'); document.body.append(o); return 1; }})()")),
        ("embed.src data:", format!("(() => {{ const o = document.createElement('embed'); o.src = 'data:text/html,' + encodeURIComponent('<script>try {{ {code} }} catch (e) {{ }}</script>'); document.body.append(o); return 1; }})()")),
        ("iframe.src data:", format!("(() => {{ const f = document.createElement('iframe'); f.src = 'data:text/html,' + encodeURIComponent('<script>try {{ {code} }} catch (e) {{ }}</script>'); document.body.append(f); return 1; }})()")),
        ("iframe about:blank + contentDocument.write", format!("(() => {{ const f = document.createElement('iframe'); document.body.append(f); f.contentDocument.write('<script>{code}</script>'); return 1; }})()")),
        ("iframe about:blank + contentDocument innerHTML", format!("(() => {{ const f = document.createElement('iframe'); document.body.append(f); f.contentDocument.body.innerHTML = '<img src=x onerror=\"{code}\">'; return 1; }})()")),
        ("iframe about:blank + contentWindow.eval", format!("(() => {{ const f = document.createElement('iframe'); document.body.append(f); f.contentWindow.eval(\"{code}\"); return document.title; }})()")),
        ("iframe.src about:srcdoc", "(() => { const f = document.createElement('iframe'); f.src = 'about:srcdoc'; document.body.append(f); return 1; })()".to_string()),
        ("blob: address", "URL.createObjectURL(new Blob(['x'], { type: 'text/html' }))".to_string()),
        ("Worklet.addModule", format!("(typeof CSS !== 'undefined' && CSS.paintWorklet) ? CSS.paintWorklet.addModule('data:text/javascript,' + encodeURIComponent(\"{code}\")).then(() => 'added', (e) => 'failed: ' + e) : 'absent'")),
        ("import() of a data: module", "import('data:text/javascript,export default document.cookie').then((m) => 'module read: ' + m.default, (e) => 'failed: ' + e)".to_string()),
        ("setTimeout(string)", format!("setTimeout(\"{code}\", 0); 1")),
        ("Function", format!("new Function(\"{code}\")(); document.title")),
    ];
    // Allowed, each for a reason measured here: what it parses or runs can't reach the page's world with the page's
    // cookie (a `data:` document has an origin of its own; an `about:srcdoc` frame is empty; a blank frame's `eval`, an
    // imported module, a timer's string and `Function` run in the agent's own world). Every other sink is refused
    // outright, the sanitizing `setHTML` and `Document.parseHTML` too: HTML from a string is refused by name, whatever
    // the browser does with it. Not in this browser: XSLTProcessor (refused too, were it there).
    let allowed = ["object.data data:", "embed.src data:", "iframe.src data:", "iframe.src about:srcdoc", "iframe about:blank + contentWindow.eval", "import() of a data: module", "setTimeout(string)", "Function"];
    for (name, script) in sinks {
        // Each from a fresh page, with the page's own inert scripts and template in it.
        open_page(&mut state, &format!("{base_url}/")).await;
        let resp = run(&json!({ "id": "s", "action": "evaluate", "script": script }), &mut state).await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let title = page_title(&mut state).await;
        let said = if resp["success"] == json!(true) { format!("ran, answered {}", resp["data"]["result"]) } else { format!("refused: {}", resp["error"]) };
        let leaked = title.to_string().contains("ScriptReadableSession77");
        eprintln!("SINK {name} | {said} | page title {title} | {}", if leaked { "LEAKED" } else { "held" });
        assert!(!leaked, "{name}: agent code ran in the page's world: {title}");
        if name == "XSLTProcessor" {
            assert!(resp.to_string().contains("not defined") || resp.to_string().contains("isn't open to an agent's script"), "{name}: {resp}");
        } else if !allowed.contains(&name) {
            assert!(resp.to_string().contains("isn't open to an agent's script"), "{name} is refused: {resp}");
        }
    }
    let _ = run(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// Every member of every interface whose name holds `HTML`, found in the agent's world at run time and not listed (Chrome
/// 157 added dozens at once, `appendHTMLUnsafe` to `streamReplaceWithHTMLUnsafe`, and a fixed list missed them), is
/// refused when the agent's script calls it or writes it with markup holding code: only those that read (`get…`, `is…`)
/// or make an empty document (`createHTMLDocument`) stay open. The ones an element, a shadow root and a text node have
/// are called on real ones in the page, and nothing written may run in the page's world.
#[tokio::test]
#[ignore]
async fn e2e_every_member_named_html_is_refused_to_an_agents_script() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    let probe = r#"(() => {
      const code = 'top.__ran=(top.__ran||[]),top.__ran.push(1)';
      const markup = '<img src=x onerror="' + code + '"><script>' + code + '</scr' + 'ipt>';
      const stays = (n) => n.startsWith('get') || n.startsWith('is') || n === 'createHTMLDocument';
      const host = document.createElement('div');
      document.body.append(host);
      const fresh = (name) => {
        const el = document.createElement('div');
        host.append(el);
        if (name === 'Element') { const inner = document.createElement('span'); el.append(inner); return inner; }
        if (name === 'ShadowRoot') return el.attachShadow({ mode: 'open' });
        if (name === 'CharacterData' || name === 'Text') { const t = document.createTextNode('x'); el.append(t); return t; }
        return null;
      };
      const found = [], open = [];
      for (const name of Object.getOwnPropertyNames(globalThis)) {
        let C;
        try { C = globalThis[name]; } catch (_) { continue; }
        if (typeof C !== 'function') continue;
        for (const [owner, label] of [[C, name + '.'], [C.prototype, name + '.prototype.']]) {
          if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) continue;
          for (const m of Object.getOwnPropertyNames(owner)) {
            if (m.indexOf('HTML') < 0 || stays(m)) continue;
            const d = Object.getOwnPropertyDescriptor(owner, m);
            if (!d || (typeof d.value !== 'function' && !d.set)) continue;
            found.push(label + m);
            const on = owner === C ? C : (fresh(name) || owner);
            let said;
            try {
              if (typeof d.value === 'function') d.value.apply(on, m === 'insertAdjacentHTML' ? ['beforeend', markup] : [markup]);
              else d.set.call(on, markup);
              said = 'answered';
            } catch (e) { said = String(e && e.message); }
            if (said.indexOf("isn't open to an agent's script") < 0) open.push(label + m + ': ' + said);
          }
        }
      }
      return JSON.stringify({ found, open });
    })()"#;
    let resp = run(&json!({ "id": "html", "action": "evaluate", "script": probe, "timeout": 120000 }), &mut state).await;
    assert_success(&resp);
    let said: Value = serde_json::from_str(resp["data"]["result"].as_str().expect("probe JSON")).unwrap();
    let found: Vec<&str> = said["found"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let open: Vec<&str> = said["open"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    eprintln!("members named HTML found: {} {found:?}", found.len());
    // The ones every browser this runs on has, so an empty or broken search can't pass for a refusal.
    for must in ["Element.prototype.innerHTML", "Element.prototype.insertAdjacentHTML", "Element.prototype.setHTMLUnsafe", "ShadowRoot.prototype.innerHTML"] {
        assert!(found.contains(&must), "the search found {must}: {found:?}");
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let ran = run(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
    let ran = ran["data"]["result"].as_str().unwrap_or("?").to_string();
    assert!(open.is_empty(), "members named HTML left open to an agent's script ({} of {}): {open:?}", open.len(), found.len());
    assert_eq!(ran, "[]", "an agent's markup ran as code in the page's world");
    let _ = run(&json!({ "id": "c", "action": "close" }), &mut state).await;
    server.abort();
}

/// Runtime inventory of interface setters and mutation entry points exposed to the isolated agent world.
/// Each probe attempts to create a page-world cookie leak; refusals and accepted inert operations are reported.
#[tokio::test]
#[ignore]
async fn e2e_agent_world_setter_and_mutation_fuzz() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({"id":"launch","action":"launch","headless":true}), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    let payload = "top.document.title='fuzz:'+document.cookie";
    let script = format!(r#"(() => {{
      const code = {payload:?}, attempts = [], accepted = [], interfaces = [];
      for (const n of Object.getOwnPropertyNames(window)) {{ try {{ if (typeof window[n] === 'function') interfaces.push(n); }} catch (_) {{}} }}
      const el = document.createElement('div');
      for (const name of interfaces) {{
        let ctor; try {{ ctor = window[name]; }} catch (_) {{ continue; }}
        let proto; try {{ proto = ctor.prototype; }} catch (_) {{ continue; }}
        if (!proto) continue;
        for (const key of Object.getOwnPropertyNames(proto)) {{
          const d = Object.getOwnPropertyDescriptor(proto, key);
          if (!d || !d.set) continue;
          attempts.push(name+'.'+key);
          try {{ el[key] = key.toLowerCase().includes('srcdoc') ? '<script>'+code+'</script>' :
            key.toLowerCase().includes('href') || key.toLowerCase().includes('src') || key.toLowerCase().includes('action') ? 'javascript:'+code :
            key.toLowerCase().includes('on') ? code : 'x'; accepted.push(name+'.'+key); }} catch (_) {{}}
        }}
      }}
      const methods = ['setAttribute','setAttributeNS','setAttributeNode','toggleAttribute','insertAdjacentElement','insertAdjacentHTML','insertAdjacentText','append','prepend','replaceWith','replaceChildren','after','before','insertBefore','appendChild','replaceChild','cloneNode','importNode','adoptNode','attachShadow','setHTMLUnsafe','setHTML','write'];
      for (const m of methods) {{ attempts.push(m); try {{
        if (m==='setAttribute') el[m]('onclick',code);
        else if (m==='setAttributeNS') el[m]('http://www.w3.org/1999/xlink','xlink:href','javascript:'+code);
        else if (m==='setAttributeNode') {{ const a=document.createAttribute('onclick'); a.value=code; el[m](a); }}
        else if (m==='insertAdjacentHTML') el[m]('beforeend','<img src=x onerror="'+code+'">');
        else if (m==='insertAdjacentText') el[m]('beforeend',code);
        else if (m==='setHTMLUnsafe') el[m]('<script>'+code+'</script>');
        else if (m==='setHTML') el[m]('<img src=x onerror="'+code+'">');
        else if (m==='write') document[m]('<script>'+code+'</script>');
        else if (m==='attachShadow') el[m]({{mode:'open'}});
        else if (m==='cloneNode') document.querySelector('#inert')[m](true);
        else if (m==='importNode') document[m](document.querySelector('#inert'),true);
        else if (m==='adoptNode') document[m](document.createElement('span'));
        else el[m](document.createElement('span'));
        accepted.push(m);
      }} catch (_) {{}} }}
      return JSON.stringify({{interfaces:interfaces.length,attempts:attempts.length,accepted}});
    }})()"#);
    let resp = run(&json!({"id":"fuzz","action":"evaluate","script":script}), &mut state).await;
    assert_success(&resp);
    let fuzz: Value = serde_json::from_str(resp["data"]["result"].as_str().expect("fuzz JSON result")).unwrap();
    let accepted = fuzz["accepted"].as_array().expect("accepted operation list");
    let inventory_dir = tempfile::tempdir().unwrap();
    let inventory_path = inventory_dir.path().join("accepted-operations.json");
    std::fs::write(&inventory_path, serde_json::to_vec_pretty(accepted).unwrap()).unwrap();
    eprintln!("fuzz interfaces={} attempts={} accepted={} list={}", fuzz["interfaces"], fuzz["attempts"], accepted.len(), inventory_path.display());
    for item in accepted { eprintln!("accepted operation: {}", item.as_str().unwrap_or("?")); }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let title = page_title(&mut state).await;
    eprintln!("page title after fuzz: {title}");
    assert!(!title.to_string().contains("ScriptReadableSession77"), "agent-supplied code reached page world: {title}");
    let _ = run(&json!({"id":"close","action":"close"}), &mut state).await;
    server.abort();
}

/// Every property an element of every kind takes, written from the agent's world on a real element of that kind with
/// each text that would be code in the page's world (a script address, markup holding a script, markup holding a
/// handler, handler text, and a value that reads differently each time it is turned to text), then put in the page and
/// clicked. Code that ran in the page's world leaves a mark there (`top.__ran`), which the agent's world can neither
/// make nor see: the test reads it through the page's own world. Nothing an agent's script writes may leave one.
#[tokio::test]
#[ignore]
async fn e2e_no_property_of_any_element_carries_an_agents_code_into_the_pages_world() {
    let (base_url, server) = start_routed_server(sinks_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({ "id": "launch", "action": "launch", "headless": true }), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    // Test fixture data: the kinds of element there are. The setters are found on each, not listed.
    let html = "a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form frame frameset h1 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee menu meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp search section select slot small source span strong style sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr applet font center dir";
    let svg = "a animate animateMotion animateTransform circle clipPath defs desc ellipse feImage filter foreignObject g image line linearGradient marker mask metadata mpath path pattern polygon polyline radialGradient rect set stop style svg switch symbol text textPath title tspan use view";
    let math = "math mi mo mn ms mtext annotation annotation-xml semantics maction";
    let kinds: Vec<(String, String)> = html
        .split(' ')
        .map(|t| (t.to_string(), format!("document.createElement('{t}')")))
        .chain(svg.split(' ').map(|t| (format!("svg:{t}"), format!("document.createElementNS('http://www.w3.org/2000/svg', '{t}')"))))
        .chain(math.split(' ').map(|t| (format!("math:{t}"), format!("document.createElementNS('http://www.w3.org/1998/Math/MathML', '{t}')"))))
        .collect();
    // One kind a script, so a kind that never returns is known by name. Each written text marks itself by number
    // (`base + n`), and the script says which number is which property.
    let probe = r#"(() => {
      const make = () => MAKE;
      const base = BASE, from = FROM, to = TO, mfrom = MFROM, mto = MTO;
      const names = [];
      const mark = (n) => 'top.__ran=(top.__ran||[]),top.__ran.push(' + (base + n) + ')';
      const texts = (n) => [
        'javascript:' + mark(n),
        ' \tJaVa\nScRiPt:' + mark(n),
        '<script>' + mark(n) + '</scr' + 'ipt>',
        '<img src=x onerror=' + mark(n) + '>',
        mark(n),
        'data:text/html,<script>' + mark(n) + '</scr' + 'ipt>',
      ];
      const tally = { setters: 0, tried: 0, accepted: 0, refused: 0 };
      let probe;
      try { probe = make(); } catch (e) { return JSON.stringify({ unmade: String(e), tally, names }); }
      const keys = [];
      for (let o = Object.getPrototypeOf(probe); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
        for (const k of Object.getOwnPropertyNames(o)) {
          const d = Object.getOwnPropertyDescriptor(o, k);
          if (d && d.set && keys.indexOf(k) < 0) keys.push(k);
        }
      }
      tally.setters = keys.length;
      const box = document.createElement('div');
      document.body.append(box);
      for (let at = from; at < keys.length && at < to; at++) {
        const k = keys[at];
        for (let which = 0; which < 7; which++) {
          let el;
          try { el = make(); } catch (_) { break; }
          const n = names.length;
          names.push(k + '#' + which);
          const all = texts(n);
          let value;
          if (which < 6) value = all[which];
          else { let turn = 0; value = { toString() { return turn++ ? all[0] : 'x'; } }; }
          tally.tried++;
          try {
            el[k] = value;
            const held = el[k];
            if (held && typeof held === 'object' && 'baseVal' in held) { try { held.baseVal = value; } catch (_) {} }
            tally.accepted++;
          } catch (_) { tally.refused++; continue; }
          try { box.append(el); } catch (_) { continue; }
          try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
          try { el.remove(); } catch (_) {}
        }
        // The same name as an attribute, each way an attribute is written: by name, by namespace, as a node, and
        // toggled on then written.
        const attr = k.toLowerCase();
        const ways = [
          (el, v) => el.setAttribute(attr, v),
          (el, v) => el.setAttributeNS(null, attr, v),
          (el, v) => el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:' + attr, v),
          (el, v) => { const a = document.createAttribute(attr); a.value = v; el.setAttributeNode(a); },
          (el, v) => { el.toggleAttribute(attr, true); el.attributes[attr].value = v; },
        ];
        for (let way = 0; way < ways.length; way++) {
          for (let which = 0; which < 6; which++) {
            let el;
            try { el = make(); } catch (_) { break; }
            const n = names.length;
            names.push('@' + attr + '/' + way + '#' + which);
            tally.tried++;
            try { ways[way](el, texts(n)[which]); tally.accepted++; } catch (_) { tally.refused++; continue; }
            try { box.append(el); } catch (_) { continue; }
            try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
            try { el.remove(); } catch (_) {}
          }
        }
      }
      // Every method an element of this kind has that takes text or nodes, called with each text, and with a node
      // holding it; once for the kind, when the first batch of its properties is written.
      if (mto > 0) {
        const methods = [];
        for (let o = Object.getPrototypeOf(probe); o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const m of Object.getOwnPropertyNames(o)) {
            const d = Object.getOwnPropertyDescriptor(o, m);
            if (d && typeof d.value === 'function' && m !== 'constructor' && methods.indexOf(m) < 0) methods.push(m);
          }
        }
        // Not called: they leave the page, wait on the user, or take the element out from under the probe.
        const skip = ['click', 'remove', 'requestFullscreen', 'requestPointerLock', 'showModal', 'showPicker', 'showPopover', 'requestSubmit', 'submit', 'reset', 'focus', 'blur', 'scrollIntoView', 'scrollIntoViewIfNeeded', 'animate', 'play', 'load', 'pause', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'reportValidity', 'checkValidity', 'select', 'stepUp', 'stepDown', 'close', 'show', 'hidePopover', 'togglePopover', 'requestPictureInPicture', 'captureStream', 'toBlob', 'transferControlToOffscreen', 'getContext', 'attachInternals', 'before', 'after', 'replaceWith'];
        tally.methods = methods.length;
        for (let mi = mfrom; mi < methods.length && mi < mto; mi++) {
          const m = methods[mi];
          if (skip.indexOf(m) >= 0) continue;
          for (let which = 0; which < 6; which++) {
            for (let shape = 0; shape < 3; shape++) {
              let el;
              try { el = make(); } catch (_) { break; }
              const n = names.length;
              names.push(m + '()/' + shape + '#' + which);
              const t = texts(n)[which];
              tally.tried++;
              try {
                box.append(el);
                if (shape === 0) el[m](t);
                else if (shape === 1) el[m](t, t);
                else el[m]('beforeend', t);
                tally.accepted++;
              } catch (_) { tally.refused++; }
              try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch (_) {}
              try { el.remove(); } catch (_) {}
            }
          }
        }
      }
      box.remove();
      return JSON.stringify({ tally, names });
    })()"#;
    let (mut setters, mut methods, mut tried, mut accepted, mut refused) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut names: Vec<String> = Vec::new();
    let mut unfinished: Vec<String> = Vec::new();
    let mut unmade: Vec<String> = Vec::new();
    // A few properties a script, so one that never returns is known by name and costs the rest nothing.
    const AT_ONCE: usize = 25;
    for (kind, make) in &kinds {
        let (mut from, mut of) = (0usize, usize::MAX);
        while from < of {
            let script = probe.replace("MAKE", make).replace("BASE", &names.len().to_string()).replace("MFROM", "0").replace("MTO", "0").replace("FROM", &from.to_string()).replace("TO", &(from + AT_ONCE).to_string());
            let resp = run(&json!({ "id": "write", "action": "evaluate", "script": script, "timeout": 120000 }), &mut state).await;
            let Some(text) = resp["data"]["result"].as_str() else {
                unfinished.push(format!("{kind} properties {from}..{}: {}", from + AT_ONCE, resp["error"].as_str().unwrap_or("no answer")));
                // Writes that didn't answer may have left the page somewhere else: start it again.
                open_page(&mut state, &format!("{base_url}/")).await;
                if of == usize::MAX {
                    break;
                }
                from += AT_ONCE;
                continue;
            };
            let said: Value = serde_json::from_str(text).unwrap();
            if said.get("unmade").is_some() {
                unmade.push(kind.clone());
                break;
            }
            let n = |k: &str| said["tally"][k].as_u64().unwrap_or(0);
            if of == usize::MAX {
                of = n("setters") as usize;
                setters += n("setters");
            }
            tried += n("tried");
            accepted += n("accepted");
            refused += n("refused");
            for name in said["names"].as_array().into_iter().flatten() {
                names.push(format!("{kind}.{}", name.as_str().unwrap_or("?")));
            }
            // What ran in the page's world so far, read there, while this page is still the one written to.
            let ran = run(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
            let marks: Vec<usize> = serde_json::from_str(ran["data"]["result"].as_str().unwrap_or("[]")).unwrap_or_default();
            let which: Vec<&str> = marks.iter().map(|m| names.get(*m).map(String::as_str).unwrap_or("?")).collect();
            assert!(which.is_empty(), "an agent's text ran as code in the page's world through: {which:?}");
            from += AT_ONCE;
        }
        // Then its methods, a few a script for the same reason.
        const METHODS_AT_ONCE: usize = 12;
        let (mut from, mut of) = (0usize, usize::MAX);
        // A batch whose page stopped answering (a kind's methods loading frames into it, under load) is run again one
        // method at a time, so what never returns is known by name; a page that took no code of the agent's is no
        // finding, and a method that still doesn't return is.
        let (mut step, mut alone_until) = (METHODS_AT_ONCE, 0usize);
        while from < of {
            let script = probe
                .replace("MAKE", make)
                .replace("BASE", &names.len().to_string())
                .replace("MFROM", &from.to_string())
                .replace("MTO", &(from + step).to_string())
                .replace("FROM", "0")
                .replace("TO", "0");
            let resp = run(&json!({ "id": "call", "action": "evaluate", "script": script, "timeout": 120000 }), &mut state).await;
            let Some(text) = resp["data"]["result"].as_str() else {
                let error = resp["error"].as_str().unwrap_or("no answer");
                open_page(&mut state, &format!("{base_url}/")).await;
                if step > 1 && error.starts_with("page_wedged:") {
                    eprintln!("{kind} methods {from}..{}: the page stopped answering; again one at a time", from + step);
                    (step, alone_until) = (1, from + METHODS_AT_ONCE);
                    continue;
                }
                unfinished.push(format!("{kind} methods {from}..{}: {error}", from + step));
                if of == usize::MAX {
                    break;
                }
                from += step;
                continue;
            };
            let said: Value = serde_json::from_str(text).unwrap();
            let n = |k: &str| said["tally"][k].as_u64().unwrap_or(0);
            if of == usize::MAX {
                of = n("methods") as usize;
                methods += n("methods");
            }
            tried += n("tried");
            accepted += n("accepted");
            refused += n("refused");
            for name in said["names"].as_array().into_iter().flatten() {
                names.push(format!("{kind}.{}", name.as_str().unwrap_or("?")));
            }
            let ran = run(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
            let marks: Vec<usize> = serde_json::from_str(ran["data"]["result"].as_str().unwrap_or("[]")).unwrap_or_default();
            let which: Vec<&str> = marks.iter().map(|m| names.get(*m).map(String::as_str).unwrap_or("?")).collect();
            assert!(which.is_empty(), "an agent's text ran as code in the page's world through: {which:?}");
            from += step;
            if step == 1 && from >= alone_until {
                step = METHODS_AT_ONCE;
            }
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
    let ran = run(&json!({ "id": "ran", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
    let marks: Vec<usize> = serde_json::from_str(ran["data"]["result"].as_str().unwrap_or("[]")).unwrap_or_default();
    let which: Vec<&str> = marks.iter().map(|m| names.get(*m).map(String::as_str).unwrap_or("?")).collect();
    let title = page_title(&mut state).await;
    eprintln!(
        "every element's setters, from the agent's world: {} kinds ({} not made: {unmade:?}), {setters} setters (each also as an attribute, five ways), {methods} methods, {tried} written or called, {accepted} accepted, {refused} refused; did not finish: {unfinished:?}",
        kinds.len(),
        unmade.len()
    );
    eprintln!("ran in the page's world: {which:?}; the page's title: {title}");
    assert!(tried > 10_000, "the probe wrote to every setter");
    assert!(which.is_empty(), "an agent's text ran as code in the page's world through: {which:?}");
    assert!(!title.to_string().contains("ScriptReadableSession77"), "{title}");
    assert!(unfinished.is_empty(), "a kind's writes never returned: {unfinished:?}");
    // The mark is one this test can see: code that does run in the page's world (the one way the agent's world has,
    // a script address given to the page's own location) leaves it, and it is read back.
    let _ = run(&json!({ "id": "known", "action": "evaluate", "script": "location.href = 'javascript:void(top.__ran=[424242])'; 1" }), &mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let seen = run(&json!({ "id": "seen", "action": "page_evaluate", "script": "JSON.stringify(window.__ran || [])" }), &mut state).await;
    assert_eq!(seen["data"]["result"].as_str(), Some("[424242]"), "code that runs in the page's world leaves a mark this test reads");
    let _ = run(&json!({ "id": "close", "action": "close" }), &mut state).await;
    server.abort();
}

/// A page-installed capture listener is present before guard arming; determine whether it suppresses command protection.
#[tokio::test]
#[ignore]
async fn e2e_hostile_page_capture_listener_and_builtin_poisoning() {
    let (base_url, server) = start_routed_server(session_route).await;
    let mut state = DaemonState::new();
    assert_success(&run(&json!({"id":"launch","action":"launch","headless":true}), &mut state).await);
    open_page(&mut state, &format!("{base_url}/")).await;
    let install = "window.addEventListener('click',e=>e.stopImmediatePropagation(),true); window.addEventListener('submit',e=>e.stopImmediatePropagation(),true); window.addEventListener('keydown',e=>e.stopImmediatePropagation(),true); Array.prototype.filter=()=>[]; Array.prototype.includes=()=>false; String.prototype.toLowerCase=()=>''; EventTarget.prototype.addEventListener=()=>{}; Event.prototype.preventDefault=()=>{}; Object.defineProperty=()=>{}; true";
    assert_success(&run(&json!({"id":"hostile","action":"page_evaluate","script":install}), &mut state).await);
    for (id, prepare, action) in [
      ("js", "", json!({"action":"click","selector":"#js"})),
      ("dblclick", "", json!({"action":"dblclick","selector":"#js"})),
      ("label", "", json!({"action":"click","selector":"#l"})),
      ("area", "", json!({"action":"click","selector":"area"})),
      ("access", "", json!({"action":"press","key":"Alt+k"})),
      ("enter", "document.getElementById('js').focus()", json!({"action":"press","key":"Enter"})),
      ("newline", "", json!({"action":"type","selector":"#q4","text":"x\n"})),
      ("find", "", json!({"action":"getbytext","text":"run"})),
      ("check", "(() => { const l=document.createElement('label'); l.textContent='box'; const c=document.createElement('input'); c.type='checkbox'; const s=document.createElement('input'); s.type='submit'; s.id='hostile-submit'; s.setAttribute('formaction',\"javascript:document.title='check ran'\"); const f=document.createElement('form'); f.id='hostile-form'; f.append(s); document.body.append(f); l.htmlFor=s.id; l.append(c); document.body.append(l); })()", json!({"action":"check","selector":"input[type=checkbox]"})),
    ] {
      if !prepare.is_empty() { assert_success(&run(&json!({"id":format!("prep-{id}"),"action":"page_evaluate","script":prepare}),&mut state).await); }
      let mut command=action; command["id"]=json!(id);
      let result=run(&command,&mut state).await;
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
      let title=page_title(&mut state).await;
      eprintln!("hostile {id}: response={result} title={title}");
      // Each is refused before anything is dispatched, and nothing of the page's ran: the title is as it was served.
      assert_eq!(result["success"], json!(false), "{id} was let through: {result}");
      assert!(result["error"].as_str().is_some_and(|e| e.contains("script address")), "{id}: {result}");
      assert!(title.to_string().contains("sees its cookie"), "{id} ran the page's script address: {title}");
      if id=="enter" || id=="newline" || id=="find" || id=="check" { open_page(&mut state,&format!("{base_url}/")).await; assert_success(&run(&json!({"id":format!("hostile-reset-{id}"),"action":"page_evaluate","script":install}),&mut state).await); }
    }
    open_page(&mut state,&format!("{base_url}/")).await;
    assert_success(&run(&json!({"id":"mousedown-rewrite","action":"page_evaluate","script":"document.getElementById('noop').addEventListener('mousedown',e=>{e.currentTarget.href=\"javascript:document.title='rewritten'\"})"}),&mut state).await);
    let rewrite=run(&json!({"id":"rewrite-click","action":"click","selector":"#noop"}),&mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let title=page_title(&mut state).await;
    eprintln!("page mousedown rewrite: command={rewrite} title={title}");
    // The read before the click saw a harmless link; only the check at the moment of activation can stop this one.
    assert_eq!(rewrite["success"], json!(false), "{rewrite}");
    assert!(rewrite["error"].as_str().is_some_and(|e| e.contains("at the moment of activation")), "{rewrite}");
    assert!(title.to_string().contains("sees its cookie"), "{title}");
    // The same, with the page's own capturing listeners (registered first, stopping every click) and its poisoned
    // built-ins in place: whether the page can keep the check from hearing the click.
    open_page(&mut state,&format!("{base_url}/")).await;
    assert_success(&run(&json!({"id":"hostile-again","action":"page_evaluate","script":install}),&mut state).await);
    assert_success(&run(&json!({"id":"mousedown-rewrite-2","action":"page_evaluate","script":"document.getElementById('noop').addEventListener('mousedown',e=>{e.currentTarget.href=\"javascript:document.title='rewritten'\"})"}),&mut state).await);
    let hostile_rewrite=run(&json!({"id":"rewrite-click-2","action":"click","selector":"#noop"}),&mut state).await;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let title=page_title(&mut state).await;
    eprintln!("page mousedown rewrite under the page's capturing listeners: command={hostile_rewrite} title={title}");
    assert!(title.to_string().contains("sees its cookie"), "the page's listeners kept the check from the click, and its rewritten address ran: {title}");
    let _ = run(&json!({"id":"close","action":"close"}), &mut state).await;
    server.abort();
}
