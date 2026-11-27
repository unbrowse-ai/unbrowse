//! `agent-browser chat`, held through the built binary against a stub AI gateway.
//!
//! The stub is a local HTTP server that records every request the CLI makes (path, key, body) and answers each
//! with a scripted OpenAI-style `text/event-stream`. Tool calls the "model" asks for run agent-browser against the
//! stand-in daemon, so each test holds what the CLI asks the gateway, what it sends the daemon, and what it prints.
use super::*;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::process::Child;
use std::time::Instant;

/// One request the stub gateway got.
#[derive(Clone, Debug)]
struct Got {
    path: String,
    authorization: String,
    body: Value,
}

/// What the stub answers: status, content type, body, and whether to split the body mid-line across two writes.
struct Answer {
    status: u16,
    body: String,
    split: bool,
}

fn ok(body: String) -> Answer {
    Answer {
        status: 200,
        body,
        split: false,
    }
}

struct Gateway {
    url: String,
    got: Arc<Mutex<Vec<Got>>>,
}

impl Gateway {
    /// `answer(n, request)` is called for the n-th request (from 0), before the reply is written.
    fn start(answer: impl Fn(usize, &Got) -> Answer + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let got: Arc<Mutex<Vec<Got>>> = Arc::new(Mutex::new(Vec::new()));
        let got2 = Arc::clone(&got);
        std::thread::spawn(move || {
            for (n, stream) in listener.incoming().enumerate() {
                let Ok(mut stream) = stream else { continue };
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let reply = answer(n, &request);
                got2.lock().unwrap().push(request);
                let head = format!(
                    "HTTP/1.1 {} X\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    reply.status,
                    reply.body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                if reply.split {
                    let at = reply.body.len() / 2;
                    let _ = stream.write_all(&reply.body.as_bytes()[..at]);
                    let _ = stream.flush();
                    std::thread::sleep(Duration::from_millis(150));
                    let _ = stream.write_all(&reply.body.as_bytes()[at..]);
                } else {
                    let _ = stream.write_all(reply.body.as_bytes());
                }
                let _ = stream.flush();
            }
        });
        Self { url, got }
    }

    /// A gateway that answers the n-th request with the n-th body (the last one for any after).
    fn script(bodies: Vec<String>) -> Self {
        Self::start(move |n, _| ok(bodies[n.min(bodies.len() - 1)].clone()))
    }

    fn requests(&self) -> Vec<Got> {
        self.got.lock().unwrap().clone()
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Got> {
    let mut data = Vec::new();
    let mut buf = [0u8; 4096];
    let (head_end, content_length) = loop {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
        if let Some(pos) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&data[..pos]).to_lowercase();
            let len = head
                .lines()
                .find_map(|l| {
                    l.strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            break (pos + 4, len);
        }
    };
    while data.len() < head_end + content_length {
        let n = stream.read(&mut buf).ok()?;
        if n == 0 {
            return None;
        }
        data.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&data[..head_end]).to_string();
    let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
    let authorization = head
        .lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case("authorization")
                .then(|| v.trim().to_string())
        })
        .unwrap_or_default();
    let body =
        serde_json::from_slice(&data[head_end..head_end + content_length]).unwrap_or(Value::Null);
    Some(Got {
        path,
        authorization,
        body,
    })
}

/// A streamed reply: each chunk as a `data:` line, then `[DONE]`.
fn sse(chunks: &[Value]) -> String {
    let mut out = String::new();
    for chunk in chunks {
        out.push_str(&format!("data: {chunk}\n\n"));
    }
    out.push_str("data: [DONE]\n\n");
    out
}

fn say(text: &str) -> Value {
    json!({"choices": [{"delta": {"content": text}}]})
}

fn call_delta(index: u64, id: Option<&str>, name: Option<&str>, arguments: &str) -> Value {
    let mut call = json!({"index": index, "function": {"arguments": arguments}});
    if let Some(id) = id {
        call["id"] = json!(id);
    }
    if let Some(name) = name {
        call["function"]["name"] = json!(name);
    }
    json!({"choices": [{"delta": {"tool_calls": [call]}}]})
}

/// A whole tool call in one chunk.
fn call(index: u64, id: &str, command: &str) -> Value {
    call_delta(
        index,
        Some(id),
        Some("agent_browser"),
        &json!({"command": command}).to_string(),
    )
}

struct Ran {
    output: Output,
    timed_out: bool,
}

impl Ran {
    fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.output.stdout).to_string()
    }
    fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.output.stderr).to_string()
    }
    fn code(&self) -> Option<i32> {
        self.output.status.code()
    }
}

fn wait_with_deadline(mut child: Child, secs: u64) -> Ran {
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let out_thread = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = stdout.read_to_end(&mut v);
        v
    });
    let err_thread = std::thread::spawn(move || {
        let mut v = Vec::new();
        let _ = stderr.read_to_end(&mut v);
        v
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            break child.wait().unwrap();
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let output = Output {
        status,
        stdout: out_thread.join().unwrap(),
        stderr: err_thread.join().unwrap(),
    };
    Ran { output, timed_out }
}

/// Runs the CLI with `env` added, `stdin` piped in, and a deadline that kills it.
fn run_cli(d: &Daemon, env: &[(&str, &str)], args: &[&str], stdin: &str) -> Ran {
    let mut command = d.command();
    for (k, v) in env {
        command.env(k, v);
    }
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let ran = wait_with_deadline(child, 90);
    assert!(!ran.timed_out, "chat did not finish: {:?}", ran.output);
    ran
}

fn chat(d: &Daemon, g: &Gateway, args: &[&str]) -> Ran {
    run_cli(
        d,
        &[
            ("AI_GATEWAY_URL", &g.url),
            ("AI_GATEWAY_API_KEY", "test-key"),
        ],
        args,
        "",
    )
}

fn daemon_with_url() -> Daemon {
    let d = Daemon::start();
    d.answer_with(|req: &Value| match req["action"].as_str() {
        Some("url") => json!({"success": true, "data": {"url": "https://stub.test/page"}}),
        _ => json!({"success": true, "data": {}}),
    });
    d
}

fn roles(request: &Got) -> Vec<String> {
    request.body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["role"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn a_text_answer_streams_to_stdout_and_the_request_names_the_model_key_session_and_tool() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[say("Hel"), say(""), say("lo")])]);
    let ran = chat(&d, &g, &["chat", "say", "hello"]);
    assert_eq!(ran.code(), Some(0), "{:?}", ran.output);
    assert_eq!(ran.stdout(), "Hello");
    assert_eq!(ran.stderr(), "");
    let requests = g.requests();
    assert_eq!(requests.len(), 1);
    let r = &requests[0];
    assert_eq!(r.path, "/v1/chat/completions");
    assert_eq!(r.authorization, "Bearer test-key");
    assert_eq!(r.body["model"], "anthropic/claude-sonnet-4.6");
    assert_eq!(r.body["stream"], true);
    assert_eq!(roles(r), ["system", "user"]);
    let system = r.body["messages"][0]["content"].as_str().unwrap();
    assert!(
        system
            .starts_with("You are an AI assistant that controls a browser through agent-browser."),
        "{system}"
    );
    assert!(system.ends_with("Your session: `surface`"), "{system}");
    assert_eq!(
        r.body["messages"][1],
        json!({"role": "user", "content": "say hello"})
    );
    assert_eq!(r.body["tools"][0]["function"]["name"], "agent_browser");
    assert_eq!(
        r.body["tools"][0]["function"]["parameters"]["required"],
        json!(["command"])
    );
    assert!(
        d.seen.lock().unwrap().is_empty(),
        "a text answer must not touch the browser"
    );
}

#[test]
fn the_model_flag_picks_the_model_and_a_trailing_slash_on_the_gateway_url_is_dropped() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[say("ok")])]);
    let url = format!("{}/", g.url);
    let ran = run_cli(
        &d,
        &[("AI_GATEWAY_URL", &url), ("AI_GATEWAY_API_KEY", "k2")],
        &["--model", "acme/tiny-1", "chat", "hi"],
        "",
    );
    assert_eq!(ran.stdout(), "ok");
    let requests = g.requests();
    assert_eq!(requests[0].path, "/v1/chat/completions");
    assert_eq!(requests[0].authorization, "Bearer k2");
    assert_eq!(requests[0].body["model"], "acme/tiny-1");
}

#[test]
fn json_mode_prints_one_object_with_the_text_and_no_tool_calls() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[say("Hel"), say("lo")])]);
    let ran = chat(&d, &g, &["--json", "chat", "hi"]);
    assert_eq!(ran.code(), Some(0));
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": true, "text": "Hello", "tool_calls": []})
    );
    assert_eq!(ran.stderr(), "");
}

#[test]
fn a_streamed_reply_split_mid_line_across_writes_is_reassembled() {
    let d = daemon_with_url();
    let g = Gateway::start(|_, _| Answer {
        status: 200,
        body: sse(&[say("alpha "), say("beta "), say("gamma")]),
        split: true,
    });
    let ran = chat(&d, &g, &["chat", "go"]);
    assert_eq!(ran.stdout(), "alpha beta gamma");
}

#[test]
fn a_tool_call_runs_the_command_on_the_daemon_and_its_result_goes_back_to_the_gateway() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![
        sse(&[
            call_delta(0, Some("call_1"), Some("agent_browser"), "{\"comm"),
            call_delta(0, None, None, "and\":\"get url\"}"),
        ]),
        sse(&[say("You are on "), say("stub.test")]),
    ]);
    let ran = chat(&d, &g, &["chat", "where am I"]);
    assert_eq!(ran.code(), Some(0), "{:?}", ran.output);
    // The "blank line before the answer" is printed after the streamed text, so it ends the line instead.
    assert_eq!(ran.stdout(), "You are on stub.test\n");
    assert_eq!(ran.stderr(), "> get url\n");
    let sent: Vec<Value> = d
        .seen
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .map(without_id)
        .collect();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["action"], "url");

    let requests = g.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(roles(&requests[0]), ["system", "user"]);
    assert_eq!(roles(&requests[1]), ["system", "user", "assistant", "tool"]);
    let messages = requests[1].body["messages"].as_array().unwrap();
    assert_eq!(
        messages[2],
        json!({"role": "assistant", "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": {"name": "agent_browser", "arguments": "{\"command\":\"get url\"}"}}]})
    );
    assert_eq!(messages[3]["tool_call_id"], "call_1");
    assert_eq!(messages[3]["content"], "https://stub.test/page");
}

#[test]
fn json_mode_lists_each_tool_call_with_its_output() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[call(0, "c1", "get url")]), sse(&[say("done")])]);
    let ran = chat(&d, &g, &["--json", "chat", "where"]);
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": true, "text": "done",
               "tool_calls": [{"command": "get url", "output": "https://stub.test/page"}]})
    );
    assert_eq!(ran.stderr(), "", "json mode must not print the tool call");
}

#[test]
fn quiet_hides_the_tool_call_and_the_text_and_verbose_shows_the_tool_output() {
    let d = daemon_with_url();
    let script = vec![sse(&[call(0, "c1", "get url")]), sse(&[say("seen")])];
    let g = Gateway::script(script.clone());
    let quiet = chat(&d, &g, &["--quiet", "chat", "where"]);
    assert_eq!(quiet.stdout(), "");
    assert_eq!(quiet.stderr(), "");
    assert_eq!(g.requests().len(), 2, "quiet still talks to the gateway");

    let g = Gateway::script(script);
    let verbose = chat(&d, &g, &["--verbose", "chat", "where"]);
    assert_eq!(verbose.stdout(), "seen\n");
    assert_eq!(verbose.stderr(), "> get url\n  https://stub.test/page\n");
}

#[test]
fn text_and_a_tool_call_in_one_reply_become_one_assistant_message() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![
        sse(&[say("Checking. "), call(0, "c9", "get url")]),
        sse(&[say("Done.")]),
    ]);
    let ran = chat(&d, &g, &["chat", "check"]);
    assert_eq!(ran.stdout(), "Checking. Done.");
    let requests = g.requests();
    assert_eq!(roles(&requests[1]), ["system", "user", "assistant", "tool"]);
    let assistant = &requests[1].body["messages"][2];
    assert_eq!(assistant["content"], "Checking. ");
    assert_eq!(assistant["tool_calls"][0]["id"], "c9");
    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"],
        "agent_browser"
    );
}

#[test]
fn several_tool_calls_run_in_index_order_and_each_result_answers_its_own_call_id() {
    let d = daemon_with_url();
    // Arrive out of order: index 1 first.
    let g = Gateway::script(vec![
        sse(&[call(1, "second", "get title"), call(0, "first", "get url")]),
        sse(&[say("both")]),
    ]);
    let ran = chat(&d, &g, &["--json", "chat", "two things"]);
    let out = stdout_json(&ran.output);
    let commands: Vec<&str> = out["tool_calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["command"].as_str().unwrap())
        .collect();
    assert_eq!(commands, ["get url", "get title"]);
    let actions: Vec<String> = d
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|c| c["action"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(actions, ["url", "title"]);
    let messages = g.requests()[1].body["messages"].clone();
    let messages = messages.as_array().unwrap();
    assert_eq!(
        roles(&g.requests()[1]),
        ["system", "user", "assistant", "tool", "tool"]
    );
    assert_eq!(messages[2]["tool_calls"][0]["id"], "first");
    assert_eq!(messages[2]["tool_calls"][1]["id"], "second");
    assert_eq!(messages[3]["tool_call_id"], "first");
    assert_eq!(messages[3]["content"], "https://stub.test/page");
    assert_eq!(messages[4]["tool_call_id"], "second");
}

#[test]
fn a_command_chain_runs_only_its_first_command() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![
        sse(&[call(
            0,
            "c1",
            "agent-browser get url && open https://evil.test",
        )]),
        sse(&[say("x")]),
    ]);
    chat(&d, &g, &["chat", "chain"]);
    let sent: Vec<Value> = d
        .seen
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .map(without_id)
        .collect();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["action"], "url");
}

#[test]
fn commands_outside_the_allowlist_or_with_a_session_override_are_refused_and_never_reach_the_daemon(
) {
    let d = daemon_with_url();
    let g = Gateway::script(vec![
        sse(&[
            call(0, "a", "rm -rf /"),
            call(1, "b", "get url --session other"),
            call(2, "c", ""),
        ]),
        sse(&[say("refused")]),
    ]);
    let ran = chat(&d, &g, &["--json", "chat", "be bad"]);
    let out = stdout_json(&ran.output);
    let outputs: Vec<&str> = out["tool_calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["output"].as_str().unwrap())
        .collect();
    assert_eq!(
        outputs,
        [
            "Blocked: 'rm' is not a valid agent-browser command.",
            "Blocked: this chat is bound to session 'surface'. Global flags such as --session are not available; only --json and --annotate are allowed.",
            "Blocked: '' is not a valid agent-browser command.",
        ]
    );
    assert!(d.seen.lock().unwrap().is_empty());
    let sent_back = g.requests()[1].body["messages"].clone();
    assert_eq!(sent_back[3]["content"], outputs[0]);
}

#[test]
fn a_tool_call_with_unparsable_arguments_runs_as_an_empty_command() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![
        sse(&[call_delta(
            0,
            Some("c1"),
            Some("agent_browser"),
            "{not json",
        )]),
        sse(&[say("hm")]),
    ]);
    let ran = chat(&d, &g, &["--json", "chat", "x"]);
    let out = stdout_json(&ran.output);
    assert_eq!(
        out["tool_calls"],
        json!([{"command": "", "output": "Blocked: '' is not a valid agent-browser command."}])
    );
}

#[test]
fn a_command_that_prints_nothing_reports_that_and_one_that_fails_reports_its_error() {
    let d = Daemon::start();
    d.answer_with(|req: &Value| match req["action"].as_str() {
        Some("title") => json!({"success": false, "error": "no page is open"}),
        _ => json!({"success": true, "data": {}}),
    });
    let g = Gateway::script(vec![
        sse(&[call(0, "a", "get title"), call(1, "b", "back")]),
        sse(&[say("ok")]),
    ]);
    let ran = chat(&d, &g, &["--json", "chat", "x"]);
    let out = stdout_json(&ran.output);
    let outputs: Vec<String> = out["tool_calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["output"].as_str().unwrap().to_string())
        .collect();
    assert!(outputs[0].contains("no page is open"), "{outputs:?}");
    assert_eq!(d.seen.lock().unwrap().len(), 2);
}

#[test]
fn a_session_that_closes_during_the_turn_is_not_reopened_and_the_model_is_told_so() {
    let d = daemon_with_url();
    let socket = d.home().join("s").join(format!("{SESSION}.sock"));
    let g = Gateway::start(move |n, _| {
        if n == 0 {
            let _ = std::fs::remove_file(&socket);
            ok(sse(&[call(0, "c1", "get url")]))
        } else {
            ok(sse(&[say("stopped")]))
        }
    });
    let ran = chat(&d, &g, &["--json", "chat", "x"]);
    let out = stdout_json(&ran.output);
    assert_eq!(
        out["tool_calls"][0]["output"],
        "Session 'surface' was closed. Stop and tell the user; do not retry."
    );
    assert!(d.seen.lock().unwrap().is_empty());
}

#[test]
fn a_model_that_keeps_calling_tools_is_stopped_after_fifty_rounds() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[call(0, "loop", "get url")])]);
    let ran = chat(&d, &g, &["--json", "chat", "forever"]);
    assert_eq!(ran.code(), Some(0));
    let out = stdout_json(&ran.output);
    assert_eq!(out["success"], true);
    assert_eq!(out["text"], "");
    assert_eq!(out["tool_calls"].as_array().unwrap().len(), 50);
    assert_eq!(g.requests().len(), 50);
}

#[test]
fn a_reply_with_only_tool_calls_and_no_text_ends_with_a_newline() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[call(0, "c1", "get url")]), sse(&[])]);
    let ran = chat(&d, &g, &["chat", "x"]);
    assert_eq!(ran.code(), Some(0));
    assert_eq!(ran.stdout(), "\n");
    assert_eq!(ran.stderr(), "> get url\n");
}

#[test]
fn a_gateway_error_status_prints_its_body_and_exits_1() {
    let d = daemon_with_url();
    let g = Gateway::start(|_, _| Answer {
        status: 401,
        body: "invalid api key".into(),
        split: false,
    });
    let ran = chat(&d, &g, &["chat", "hi"]);
    assert_eq!(ran.code(), Some(1));
    assert_eq!(ran.stdout(), "");
    assert_eq!(ran.stderr(), "\n\u{2717} invalid api key\n");

    let ran = chat(&d, &g, &["--json", "chat", "hi"]);
    assert_eq!(ran.code(), Some(1));
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": false, "error": "invalid api key"})
    );
}

#[test]
fn an_unreachable_gateway_is_reported_as_a_failed_request() {
    let d = daemon_with_url();
    // A port nothing listens on: bind, note it, drop.
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let url = format!("http://127.0.0.1:{port}");
    let env = [
        ("AI_GATEWAY_URL", url.as_str()),
        ("AI_GATEWAY_API_KEY", "k"),
    ];
    let ran = run_cli(&d, &env, &["chat", "hi"], "");
    assert_eq!(ran.code(), Some(1));
    assert!(
        ran.stderr()
            .starts_with("\n\u{2717} Gateway request failed: "),
        "{}",
        ran.stderr()
    );

    let ran = run_cli(&d, &env, &["--json", "chat", "hi"], "");
    assert_eq!(ran.code(), Some(1));
    let out = stdout_json(&ran.output);
    assert_eq!(out["success"], false);
    assert!(
        out["error"]
            .as_str()
            .unwrap()
            .starts_with("Gateway request failed: "),
        "{out}"
    );
}

#[test]
fn a_gateway_that_fails_after_a_tool_round_still_exits_1() {
    let d = daemon_with_url();
    let g = Gateway::start(|n, _| {
        if n == 0 {
            ok(sse(&[call(0, "c1", "get url")]))
        } else {
            Answer {
                status: 500,
                body: "boom".into(),
                split: false,
            }
        }
    });
    let ran = chat(&d, &g, &["--json", "chat", "x"]);
    assert_eq!(ran.code(), Some(1));
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": false, "error": "boom"})
    );
    assert_eq!(d.seen.lock().unwrap().len(), 1);
}

#[test]
fn noise_in_the_stream_is_skipped_and_a_stream_cut_without_done_keeps_what_arrived() {
    let d = daemon_with_url();
    let body = [
        ": keep-alive comment",
        "event: message",
        "data: {not json",
        "data: {\"choices\": []}",
        "data: {\"nothing\": true}",
        "data: {\"choices\": [{\"delta\": {\"role\": \"assistant\"}}]}",
        &format!("data: {}\r", say("kept ")),
        "",
        &format!("data: {}", say("text")),
        "",
    ]
    .join("\n");
    let g = Gateway::script(vec![body]);
    let ran = chat(&d, &g, &["--json", "chat", "x"]);
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": true, "text": "kept text", "tool_calls": []})
    );
}

#[test]
fn a_stream_with_nothing_usable_ends_cleanly_with_empty_text() {
    let d = daemon_with_url();
    let g = Gateway::script(vec!["garbage\ndata: nope\n".to_string()]);
    let ran = chat(&d, &g, &["--json", "chat", "x"]);
    assert_eq!(ran.code(), Some(0));
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": true, "text": "", "tool_calls": []})
    );
    let g = Gateway::script(vec![String::new()]);
    let ran = chat(&d, &g, &["chat", "x"]);
    assert_eq!(ran.code(), Some(0));
    assert_eq!(ran.stdout(), "\n");
}

#[test]
fn text_after_done_is_ignored() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![format!(
        "{}data: {}\n\n",
        sse(&[say("first")]),
        say("late")
    )]);
    let ran = chat(&d, &g, &["chat", "x"]);
    assert_eq!(ran.stdout(), "first");
}

#[test]
fn a_missing_api_key_stops_before_any_request_in_text_and_json() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[say("never")])]);
    let env = [("AI_GATEWAY_URL", g.url.as_str())];
    let msg = "AI_GATEWAY_API_KEY not set. Set the AI_GATEWAY_API_KEY environment variable to enable chat.";
    let ran = run_cli(&d, &env, &["chat", "hi"], "");
    assert_eq!(ran.code(), Some(1));
    assert_eq!(ran.stdout(), "");
    assert_eq!(ran.stderr(), format!("\u{2717} {msg}\n"));

    let ran = run_cli(&d, &env, &["--json", "chat", "hi"], "");
    assert_eq!(ran.code(), Some(1));
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": false, "error": msg})
    );
    assert!(g.requests().is_empty());
}

#[test]
fn with_no_message_the_first_line_of_stdin_is_the_message() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[say("piped")])]);
    let ran = run_cli(
        &d,
        &[("AI_GATEWAY_URL", &g.url), ("AI_GATEWAY_API_KEY", "k")],
        &["chat"],
        "  what is up  \nsecond line ignored\n",
    );
    assert_eq!(ran.code(), Some(0));
    assert_eq!(ran.stdout(), "piped");
    let requests = g.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].body["messages"][1],
        json!({"role": "user", "content": "what is up"})
    );
}

#[test]
fn empty_stdin_is_refused_as_no_input_in_text_and_json() {
    let d = daemon_with_url();
    let g = Gateway::script(vec![sse(&[say("never")])]);
    let env = [
        ("AI_GATEWAY_URL", g.url.as_str()),
        ("AI_GATEWAY_API_KEY", "k"),
    ];
    let ran = run_cli(&d, &env, &["chat"], "  \n");
    assert_eq!(ran.code(), Some(1));
    assert_eq!(ran.stderr(), "\u{2717} No input provided\n");
    let ran = run_cli(&d, &env, &["--json", "chat"], "");
    assert_eq!(ran.code(), Some(1));
    assert_eq!(
        stdout_json(&ran.output),
        json!({"success": false, "error": "No input provided"})
    );
    assert!(g.requests().is_empty());
}
