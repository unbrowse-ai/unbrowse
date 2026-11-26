//! More of `unb`: the commands it builds, what an agent with no connection is told, the relay's refusals, and the
//! node it asks only when it isn't up.

use super::*;

fn words(w: &[&str]) -> Vec<String> {
    w.iter().map(|s| s.to_string()).collect()
}

fn body_of(args: &[&str], stdin: &str) -> Option<Value> {
    match request_with(&words(args), &mut || Some(stdin.to_string()))? {
        Req::Post(_, b) => Some(b),
        Req::Get(..) => None,
    }
}

#[test]
fn a_challenge_click_and_drag_carry_their_numbers_in_order_and_a_wait_its_time() {
    let click = body_of(&["challenge", "click", "10", "20.5", "--site", "shop.example", "--session", "s1"], "").unwrap();
    assert_eq!((click["action"].clone(), click["x"].clone(), click["y"].clone()), (json!("click"), json!(10.0), json!(20.5)));
    assert_eq!((click["site"].clone(), click["session"].clone()), (json!("shop.example"), json!("s1")));
    assert!(click["to_x"].is_null() && click["text"].is_null());
    let drag = body_of(&["challenge", "drag", "1", "2", "30", "40"], "").unwrap();
    assert_eq!([&drag["x"], &drag["y"], &drag["to_x"], &drag["to_y"]], [&json!(1.0), &json!(2.0), &json!(30.0), &json!(40.0)]);
    let wait = body_of(&["challenge", "wait", "--ms", "2500"], "").unwrap();
    assert_eq!((wait["action"].clone(), wait["ms"].clone()), (json!("wait"), json!(2500)));
    let press = body_of(&["challenge", "press", "--key", "Enter"], "").unwrap();
    assert_eq!(press["key"], "Enter");
    let look = body_of(&["challenge", "look", "--url", "https://shop.example/gate"], "").unwrap();
    assert_eq!((look["action"].clone(), look["url"].clone()), (json!("look"), json!("https://shop.example/gate")));
}

#[test]
fn a_challenge_flag_unb_does_not_have_or_a_text_not_from_stdin_makes_no_request() {
    assert!(request_with(&words(&["challenge", "look", "--wat"]), &mut || None).is_none());
    assert!(request_with(&words(&["challenge", "type", "--text", "hello"]), &mut || None).is_none());
    assert!(request_with(&words(&["challenge", "type", "--text"]), &mut || None).is_none());
    assert!(request_with(&words(&["challenge", "type", "--text", "-"]), &mut || None).is_none(), "stdin that gives nothing is no text");
    assert_eq!(body_of(&["challenge", "type", "--text", "-"], "abc 123").unwrap()["text"], "abc 123");
}

#[test]
fn a_judgment_with_a_bounty_a_writes_flag_and_fields_goes_with_all_of_them() {
    let b = body_of(&["judge", "r1", "wrong", "--writes", "--bounty", "7", "--entry", "e3", "--fields", "a.b, ,c", "--why", "stale", "--what", "a list"], "").unwrap();
    assert_eq!(b["verdict"], "wrong");
    assert_eq!((b["writes"].clone(), b["bounty"].clone(), b["entry"].clone()), (json!(true), json!(7), json!("e3")));
    assert_eq!(b["fields"], json!(["a.b", "c"]));
    assert_eq!((b["why"].clone(), b["what"].clone()), (json!("stale"), json!("a list")));
    let reads = body_of(&["judge", "r1", "right", "--reads"], "").unwrap();
    assert_eq!(reads["writes"], false);
    assert!(request_with(&words(&["judge", "r1", "right", "--bounty", "seven"]), &mut || None).is_none());
    assert!(request_with(&words(&["judge", "r1", "right", "--bounty"]), &mut || None).is_none());
    assert!(request_with(&words(&["judge", "r1", "right", "--wat"]), &mut || None).is_none());
}

#[test]
fn observe_walk_open_inspect_and_search_each_ask_their_own_route() {
    let observe = body_of(&["observe", "--site", "a.example", "--session", "s", "--goal", "find it"], "").unwrap();
    assert_eq!((observe["site"].clone(), observe["goal"].clone()), (json!("a.example"), json!("find it")));
    let walk = body_of(&["walk", "https://a.example/x", "--pick", "3", "--what", "prices", "--session", "w", "lamps", "red"], "").unwrap();
    assert_eq!((walk["url"].clone(), walk["pick"].clone(), walk["what"].clone(), walk["session"].clone()), (json!("https://a.example/x"), json!(3), json!("prices"), json!("w")));
    assert_eq!(walk["goal"], "lamps red", "words that are no flag are the goal");
    assert!(matches!(request_with(&words(&["open", "unbrowse://x"]), &mut || None), Some(Req::Get(p, Some(q))) if p == "/v1/open" && q == "unbrowse://x"));
    assert!(matches!(request_with(&words(&["inspect", "r9"]), &mut || None), Some(Req::Get(p, None)) if p == "/v1/routes/r9/inspect"));
    assert!(matches!(request_with(&words(&["search", "red", "lamps"]), &mut || None), Some(Req::Get(p, Some(q))) if p == "/v1/routes" && q == "red lamps"));
}

#[test]
fn an_agent_with_no_connection_is_told_the_one_step_to_take_to_each_message() {
    let why = "no grant";
    let ask = |m: Value| not_connected_answer(&m, why);
    let init = ask(json!({ "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } })).unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-03-26", "the client's own version is answered");
    assert_eq!(init["result"]["serverInfo"]["name"], "unbrowse");
    assert!(init["result"]["instructions"].as_str().unwrap().contains("click Connect on Agents") && init["result"]["instructions"].as_str().unwrap().contains("(no grant)"));
    let bare = ask(json!({ "id": 2, "method": "initialize" })).unwrap();
    assert_eq!(bare["result"]["protocolVersion"], "2025-06-18");
    let tools = ask(json!({ "id": 3, "method": "tools/list" })).unwrap();
    assert_eq!(tools["result"]["tools"][0]["name"], "unbrowse_connect");
    let call = ask(json!({ "id": 4, "method": "tools/call" })).unwrap();
    assert_eq!(call["result"]["isError"], true);
    assert!(call["result"]["content"][0]["text"].as_str().unwrap().contains("isn't connected"));
    assert_eq!(ask(json!({ "id": 5, "method": "ping" })).unwrap()["result"], json!({}));
    let other = ask(json!({ "id": 6, "method": "resources/list" })).unwrap();
    assert_eq!(other["error"]["code"], -32001);
    assert_eq!(other["id"], 6);
    assert!(ask(json!({ "method": "notifications/initialized" })).is_none(), "a notification gets no answer");
    assert!(ask(json!({ "id": null, "method": "ping" })).is_none());
}

#[test]
fn what_the_node_waits_on_its_owner_for_is_read_from_its_network_check_only() {
    assert_eq!(waiting_on_owner(&json!({ "checks": { "network": { "detail": "waiting: open the app" } } })), Some("open the app"));
    assert_eq!(waiting_on_owner(&json!({ "checks": { "network": { "detail": "ok" } } })), None);
    assert_eq!(waiting_on_owner(&json!({})), None);
}

#[test]
fn clients_named_for_connect_are_taken_out_of_its_arguments_once_each() {
    let (rest, clients) = client_args(&words(&["2", "--client", "cursor,codex", "--client=cursor", "--dry-run", "--client", "claude-code"])).unwrap();
    assert_eq!(rest, ["2", "--dry-run"]);
    assert_eq!(clients, [connect::Client::Cursor, connect::Client::Codex, connect::Client::ClaudeCode], "named twice, listed once, in the order named");
    let (rest, none) = client_args(&words(&["--yes"])).unwrap();
    assert_eq!((rest, none.len()), (vec!["--yes".to_string()], 0));
    let usage = client_args(&words(&["--client"])).unwrap_err();
    assert!(usage.starts_with("--client takes ") && usage.contains("cursor") && usage.contains("claude-desktop"), "{usage}");
    assert!(client_args(&words(&["--client", "nonesuch"])).unwrap_err().starts_with("--client takes "));
    assert!(client_args(&words(&["--client", " , "])).unwrap_err().contains("none of the MCP clients"), "a list of blanks names none");
}

#[test]
fn connect_with_a_client_it_does_not_know_says_the_usage_and_touches_nothing() {
    let two = format!("{:?}", ExitCode::from(2));
    assert_eq!(format!("{:?}", connect("http://127.0.0.1:1", &words(&["--client", "nonesuch"]))), two);
    assert_eq!(format!("{:?}", connect("http://127.0.0.1:1", &words(&["--client"]))), two);
}

// ---- a node on loopback for the relay ----

struct Taken {
    target: String,
    headers: std::collections::HashMap<String, String>,
}

enum Reply {
    Proof,
    Signed(u16, String, Vec<(&'static str, String)>),
    Plain(u16, String),
}

const KEY: &str = "unb_000000000000000000000000000000000000000000000002";

fn node(n: usize, say: impl Fn(&Taken) -> Reply + Send + 'static) -> (String, std::thread::JoinHandle<Vec<Taken>>) {
    use std::io::{BufRead, BufReader, Read, Write};
    use unbrowse_core::signed;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let mut seen = Vec::new();
        for _ in 0..n {
            let (conn, _) = listener.accept().unwrap();
            let mut r = BufReader::new(conn.try_clone().unwrap());
            let mut line = String::new();
            r.read_line(&mut line).unwrap();
            let target = line.split(' ').nth(1).unwrap().to_string();
            let (mut headers, mut length) = (std::collections::HashMap::new(), 0usize);
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                let Some((k, v)) = h.trim_end().split_once(':') else { break };
                let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
                if k == "content-length" {
                    length = v.parse().unwrap();
                }
                headers.insert(k, v);
            }
            let mut body = vec![0u8; length];
            r.read_exact(&mut body).unwrap();
            let taken = Taken { target, headers };
            let (status, reply, mut extra) = match say(&taken) {
                Reply::Proof => {
                    let q = url::Url::parse(&format!("http://x{}", taken.target)).unwrap();
                    let challenge = hex::decode(q.query_pairs().find(|(k, _)| k == "challenge").unwrap().1.as_ref()).unwrap();
                    (200, json!({ "agents": [hex::encode(unbrowse_core::node_proof(KEY, port, &challenge))] }).to_string(), Vec::new())
                }
                Reply::Signed(status, body, extra) => (status, body, extra),
                Reply::Plain(status, body) => (status, body, Vec::new()),
            };
            if let Some(nonce) = taken.headers.get(signed::NONCE) {
                if !matches!(taken.target.as_str(), t if t.starts_with("/v1/node/proof")) && status < 500 && !extra.iter().any(|(k, _)| *k == "unsigned") {
                    let mac = hex::encode(signed::reply_mac(KEY, status, &signed::body_hash(reply.as_bytes()), nonce));
                    extra.push((signed::REPLY, mac));
                }
            }
            extra.retain(|(k, _)| *k != "unsigned");
            let extra: String = extra.iter().map(|(k, v)| format!("{k}: {v}\r\n")).collect();
            let mut conn = conn;
            write!(conn, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{reply}", reply.len()).unwrap();
            seen.push(taken);
        }
        seen
    });
    (format!("http://127.0.0.1:{port}"), handle)
}

#[test]
fn the_relay_keeps_the_session_the_node_opens_and_sends_it_with_every_message_after() {
    let (base, node) = node(4, |t| {
        if t.target.starts_with("/v1/node/proof") {
            return Reply::Proof;
        }
        Reply::Signed(200, r#"{"jsonrpc":"2.0","id":1,"result":{}}"#.into(), vec![("mcp-session-id", "SESSION-9".into())])
    });
    let http = client(WAIT);
    let session = std::sync::Mutex::new(None);
    let first = mcp_one(&http, &base, KEY, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" }), &session).unwrap();
    assert_eq!(first["result"], json!({}));
    assert_eq!(session.lock().unwrap().as_deref(), Some("SESSION-9"));
    mcp_one(&http, &base, KEY, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), &session).unwrap();
    let seen = node.join().unwrap();
    assert_eq!(seen[1].target, "/mcp");
    assert!(!seen[1].headers.contains_key("mcp-session-id"), "none yet at initialize");
    assert_eq!(seen[3].headers.get("mcp-session-id").map(String::as_str), Some("SESSION-9"));
    assert_eq!(seen[3].headers.get("accept").map(String::as_str), Some("application/json"));
}

#[test]
fn a_notification_is_sent_and_never_answered_and_an_empty_answer_to_a_call_is_said() {
    let (base, node) = node(4, |t| {
        if t.target.starts_with("/v1/node/proof") {
            return Reply::Proof;
        }
        Reply::Signed(202, "null".into(), vec![])
    });
    let http = client(WAIT);
    let session = std::sync::Mutex::new(None);
    assert!(mcp_one(&http, &base, KEY, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), &session).is_none());
    let said = mcp_one(&http, &base, KEY, &json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/list" }), &session).unwrap();
    assert_eq!(said["id"], 5);
    assert_eq!(said["error"]["message"], "the node answered 202 with nothing to read");
    node.join().unwrap();
}

#[test]
fn a_node_that_is_not_the_tokens_gets_no_message_and_the_agent_is_told_why() {
    let (base, node) = node(1, |_| Reply::Plain(200, r#"{"agents":["not-the-proof"]}"#.into()));
    let http = client(WAIT);
    let session = std::sync::Mutex::new(None);
    let said = mcp_one(&http, &base, KEY, &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }), &session).unwrap();
    assert!(said["error"]["message"].as_str().unwrap().contains("isn't the node this agent's token is for"), "{said}");
    assert_eq!(node.join().unwrap().len(), 1, "only the proof was asked: the message never left");
}

#[test]
fn a_node_that_goes_quiet_after_proving_itself_is_told_to_the_agent_as_unreachable() {
    let (base, node) = node(2, |t| {
        if t.target.starts_with("/v1/node/proof") {
            Reply::Proof
        } else {
            Reply::Plain(502, "<html>bad gateway</html>".into())
        }
    });
    let http = client(WAIT);
    let session = std::sync::Mutex::new(None);
    let said = mcp_one(&http, &base, KEY, &json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list" }), &session).unwrap();
    assert_eq!(said["error"]["code"], -32001);
    assert!(!said["error"]["message"].as_str().unwrap().is_empty());
    node.join().unwrap();
}

#[test]
fn a_node_already_answering_is_not_started_and_one_at_a_far_address_never_is() {
    let (base, node) = node(1, |_| Reply::Plain(200, "{}".into()));
    node_on_demand(&base);
    assert_eq!(node.join().unwrap().len(), 1, "one probe, nothing started");
    // Not this machine's: nothing is probed, nothing is started.
    node_on_demand("https://node.example.com");
    node_on_demand("not an address");
}

#[test]
fn the_node_program_is_the_one_beside_unb_or_its_bare_name() {
    let p = node_program();
    let name = if cfg!(windows) { "unbrowse-node.exe" } else { "unbrowse-node" };
    assert_eq!(p.file_name().unwrap(), name);
}

#[test]
fn an_agent_index_is_a_number_first_or_nothing_and_a_missing_one_is_the_usage() {
    assert_eq!(mcp_agent(&words(&["--agent", "first"])), Ok(Some(None)));
    assert_eq!(mcp_agent(&words(&["--agent=4"])), Ok(Some(Some(4))));
    assert_eq!(mcp_agent(&words(&["--account", "x"])), Ok(None));
    assert!(mcp_agent(&words(&["--agent"])).unwrap_err().starts_with("usage: unb mcp"));
    assert!(mcp_agent(&words(&["--agent", "two"])).is_err());
}

#[test]
fn a_grant_is_the_token_the_owner_let_in_and_nothing_else() {
    let dir = std::env::temp_dir().join(format!("unb-grant-cov-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let why = granted_token(&dir, None).unwrap_err();
    assert!(why.contains("the node's first agent key"), "{why}");
    std::fs::create_dir_all(dir.join("bridges")).unwrap();
    std::fs::write(dir.join("bridges/first"), "3\n").unwrap();
    assert!(granted_token(&dir, None).unwrap_err().contains("agent 3"), "the first agent's own grant is missing");
    std::fs::write(dir.join("bridges/agent-3.token"), "  tok-3\n").unwrap();
    assert_eq!(granted_token(&dir, None).as_deref(), Ok("tok-3"));
    assert_eq!(granted_token(&dir, Some(3)).as_deref(), Ok("tok-3"));
    std::fs::write(dir.join("bridges/agent-4.token"), "\n").unwrap();
    assert!(granted_token(&dir, Some(4)).is_err(), "a blank grant is none");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_node_address_that_is_not_one_is_said_before_anything_is_sent() {
    let why = ask("not an address", KEY, Req::Get("/v1/routes".into(), Some("x".into()))).unwrap_err();
    assert!(why.contains("isn't an address"), "{why}");
    let why = proven(&client(WAIT), "nonsense", KEY).unwrap_err();
    assert!(why.contains("isn't an address"), "{why}");
}

#[test]
fn a_node_that_answers_with_an_error_instead_of_a_proof_says_it_could_not_prove_itself() {
    let (base, node) = node(1, |_| Reply::Plain(200, r#"{"error":"key revoked"}"#.into()));
    let why = proven(&client(WAIT), &base, KEY).unwrap_err();
    assert!(why.contains("couldn't prove who it is: key revoked"), "{why}");
    node.join().unwrap();
}

/// The words a person types at `unbrowse` are answered by the same binary: its own (the app, the node, where the
/// programs are, the install, the skill) here, and every other word — a node command like `vault`, `update` — by the
/// node. Run as `unb`, none of that happens: an agent's client keeps its own words and its own usage.
#[test]
fn unbrowse_answers_its_own_words_and_hands_the_nodes_commands_to_the_node() {
    let browse = "/Applications/Unbrowse.app/Contents/MacOS/unbrowse";
    let plain = "/Applications/Unbrowse.app/Contents/MacOS/unb";
    assert_eq!(own_named(browse, &words(&["do", "prices"])), None, "an agent's own word stays this program's");
    assert_eq!(own_named(plain, &words(&["do", "prices"])), None);
    assert_eq!(own_named(browse, &words(&["vault"])), Some(ExitCode::FAILURE), "a node command goes to the node, which isn't beside this test's program");
    assert_eq!(own_named(plain, &words(&["where"])), Some(ExitCode::SUCCESS), "unb answers these too");
    assert_eq!(own_named(plain, &words(&["vault"])), None, "run as unb, a node command is not forwarded");
    // Nothing at all, and help, is the list of words — only when it is `unbrowse` that was run.
    for said in [words(&["help"]), words(&["--help"]), words(&["-h"])] {
        assert_eq!(own_named(browse, &said), Some(ExitCode::SUCCESS), "{said:?}");
        assert_eq!(own_named(plain, &said), None, "{said:?}");
    }
    assert_eq!(own_named(browse, &words(&[])), Some(ExitCode::SUCCESS));
    assert_eq!(own_named(plain, &words(&[])), None);
}

/// The install's own words, from the command line: `where` names the folder the program runs from, `install --dry-run`
/// writes nothing and says what it would do, a word it doesn't know is the usage, and `skill <dir>` puts the skill
/// there, whole.
#[test]
fn where_the_install_and_the_skill_are_asked_for_from_the_command_line() {
    assert_eq!(own_named("/x/unb", &words(&["where"])), Some(ExitCode::SUCCESS));
    assert_eq!(own_named("/x/unb", &words(&["install", "--dry-run"])), Some(ExitCode::SUCCESS));
    assert_eq!(own_named("/x/unb", &words(&["install", "--bogus"])), Some(ExitCode::from(2)));
    assert_eq!(own_named("/x/unb", &words(&["skill", "--dry-run"])), Some(ExitCode::SUCCESS));
    let dir = std::env::temp_dir().join(format!("unb-skill-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let at = dir.to_string_lossy().to_string();
    assert_eq!(own_named("/x/unb", &words(&["skill", &at])), Some(ExitCode::SUCCESS));
    assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), install::SKILL);
    let again = own_named("/x/unb", &words(&["skill", &at]));
    assert_eq!(again, Some(ExitCode::SUCCESS), "a copy of ours is replaced, not kept");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The window and the node are the programs beside this one: asked for where there are none, each says what it could not
/// run rather than failing silently.
#[test]
fn the_window_and_the_node_are_run_beside_this_program_or_said_to_be_missing() {
    let empty = std::env::temp_dir().join(format!("unb-nowindow-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&empty);
    std::fs::create_dir_all(&empty).unwrap();
    assert_eq!(open_app_at(&empty), ExitCode::FAILURE, "no window beside the programs");
    let none = empty.join("no-node-here");
    assert_eq!(run_node_at(&none, &words(&["--help"])), ExitCode::FAILURE, "no node beside the programs");
    #[cfg(unix)]
    assert_eq!(run_node_at(std::path::Path::new("/usr/bin/true"), &words(&[])), ExitCode::SUCCESS);
    let _ = std::fs::remove_dir_all(&empty);
}

/// The window beside the programs is run, and its exit is `unbrowse app`'s: a window that opens is success, one that
/// fails passes its code on.
#[cfg(unix)]
#[test]
fn the_window_beside_the_programs_is_run_and_its_exit_is_the_apps() {
    let dir = std::env::temp_dir().join(format!("unb-window-{}", std::process::id()));
    for (program, code) in [("/usr/bin/true", ExitCode::SUCCESS), ("/usr/bin/false", ExitCode::from(1))] {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(program, dir.join("unbrowse-window")).unwrap();
        assert_eq!(open_app_at(&dir), code, "{program}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// `skill <dir>` keeps what the owner had at that name beside the skills folder, as it was, and says where; a folder
/// that can't be made is said, and the command fails.
#[test]
fn skill_into_a_folder_keeps_the_owners_copy_and_says_a_folder_it_cant_make() {
    let base = std::env::temp_dir().join(format!("unb-skill-kept-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let to = base.join("skills").join("unbrowse");
    std::fs::create_dir_all(&to).unwrap();
    std::fs::write(to.join("SKILL.md"), "the owner's own skill").unwrap();
    assert_eq!(own_named("/x/unb", &words(&["skill", &to.to_string_lossy()])), Some(ExitCode::SUCCESS));
    assert_eq!(std::fs::read_to_string(to.join("SKILL.md")).unwrap(), install::SKILL);
    let kept: Vec<_> = std::fs::read_dir(base.join("unbrowse-kept")).unwrap().flatten().map(|e| e.path()).collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(std::fs::read_to_string(kept[0].join("SKILL.md")).unwrap(), "the owner's own skill");
    let file = base.join("a-file");
    std::fs::write(&file, "not a folder").unwrap();
    let under = file.join("unbrowse");
    assert_eq!(own_named("/x/unb", &words(&["skill", &under.to_string_lossy()])), Some(ExitCode::FAILURE));
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a folder");
    let _ = std::fs::remove_dir_all(&base);
}
