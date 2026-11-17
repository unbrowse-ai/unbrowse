//! `unb`: the node from a shell, for agents and scripts. It talks to the node app's local API with an agent's token
//! (`UNBROWSE_NODE`, `UNBROWSE_AGENT_TOKEN`, both from the setup the app shows when it makes the key).
//!
//!   unb do <goal words...> [--url <page>] [name=value ...] [--fields <path,path> | --fields '*']
//!                                           what you want: the route that does it, or one learned from the page
//!   unb search [words]                      routes this node knows
//!   unb call <route id> [name=value ...]
//!
//! Nothing waits for the owner: the node pays a route's fee itself, up to the owner's per-fetch maximum.
//!   unb browse <command...> [--site <site>] [--goal <words>] [--session <name>]
//!                                           the node's browser by hand, for a page that needs it; a vault login
//!                                           goes in with `unb browse fill @e3 vault:<site>:<account>`, and
//!                                           its one-time code with `vault:code:<site>:<account>`. Each session
//!                                           (`--session`, else `UNB_SESSION`) has its own tab of a site's browser;
//!                                           commands naming none share the key's own
//!   unb challenge look [--url <page>] [--site <site>] [--session <name>]
//!              [click x y | drag x y to_x to_y | type --text - | press --key Enter | wait --ms 2000 | done]
//!                                           a page that asks for a person, shown as a picture: read it, take one
//!                                           step, and the reply is the page again (image is a path; asks is the
//!                                           page's answer). What `type` types comes on stdin (`--text -`), never
//!                                           the command line, which other programs can read
//!   unb open <unbrowse://link>              what a link names, from the network and the chain: calls nothing, pays nothing
//!   unb logins                              the vault's logins, by reference (never a password)
//!   unb whoami
//!   unb report <kind> <summary...> --expected <what> --got <what> [--route <id>] [--goal <words>] [--url <page>]
//!              [--tool <tool>] [--error <text>]
//!                                           report a problem with Unbrowse: scrubbed by the node, filed as a
//!                                           public GitHub issue (kind: wrong_data, false_success, failed, slow,
//!                                           confusing, other)
//!   unb judge <route id> <right|wrong> [--url <page>] [--why <text>] [--what <words>] [--fields <path,path>] [--writes|--reads] [--bounty <id> --entry <entry>]
//!                                           say what a route's answer was: wrong for a page (the next `unb do` for it
//!                                           learns it afresh), what it really is, or which fields are the answer
//!   unb connect [agent index] [--dry-run] [--yes]
//!                                           register this node with Claude Code as agent `index` (default: the key the
//!                                           node made itself), starting the node first if it isn't running. An older
//!                                           Unbrowse's entries are shown first, backed up, and replaced once the new
//!                                           one answers (`migrate`); without a terminal it only shows them unless
//!                                           `--yes`
//!   unb connect --undo [<time>] [--purge]   put back what connect replaced; --purge then deletes the backup
//!   unb grant [<n> | first]                 let agent `n` (else the node's first key) be used by a client on this
//!                                           machine: the owner is asked once, and the yes is kept as its grant
//!   unb mcp [--agent <index|first>]         the node's MCP server over stdio, for an agent host to start: the agent's
//!                                           token is read from its grant (`unb grant`), never a command line or
//!                                           config, and each message goes to the node signed with it
//!
//! Every request is signed with the agent's token (`unbrowse_core::signed`): the token never goes over the wire, and an
//! answer is used only when the node signed it.

use std::process::ExitCode;

use serde_json::{json, Value};

#[path = "../signed_client.rs"]
mod signed_client;
#[path = "unb/legacy.rs"]
mod legacy;
#[path = "unb/migrate.rs"]
mod migrate;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let base = std::env::var("UNBROWSE_NODE").unwrap_or_else(|_| "http://127.0.0.1:7788".into());
    if args.first().map(String::as_str) == Some("connect") {
        return connect(&base, &args[1..]);
    }
    if args.first().map(String::as_str) == Some("grant") {
        return grant(args.get(1).map(String::as_str));
    }
    if args.first().map(String::as_str) == Some("mcp") {
        let token = match mcp_agent(&args[1..]) {
            // The owner's grant for that agent, and nothing else: `unb mcp` never asks the keystore itself.
            Ok(Some(index)) => granted_token(&unbrowse_files::private::home(), index),
            Ok(None) => match std::env::var("UNBROWSE_AGENT_TOKEN") {
                Ok(token) => Ok(token),
                // An entry an older Unbrowse wrote (`npx -y unbrowse mcp`, `… mcp --account x`): it names no agent and
                // has no token, so it speaks for the node's first agent, once the owner let it in. The hosted
                // sign-in it was made for is never read; without a grant it still answers, with the one step to take.
                Err(_) => {
                    return match granted_token(&unbrowse_files::private::home(), None) {
                        Ok(token) => mcp(&base, &token),
                        Err(why) => not_connected(&why),
                    };
                }
            },
            Err(usage) => Err(usage),
        };
        return match token {
            Ok(token) => mcp(&base, &token),
            Err(e) => {
                eprintln!("{e}");
                ExitCode::from(2)
            }
        };
    }
    let Ok(token) = std::env::var("UNBROWSE_AGENT_TOKEN") else {
        eprintln!("set UNBROWSE_AGENT_TOKEN, or run `unbrowse connect`: add an agent in the Unbrowse app (Money, Agents) to get its setup");
        return ExitCode::from(2);
    };
    if let Some(why) = text_on_command_line(&args) {
        eprintln!("{why}");
        return ExitCode::from(2);
    }
    // What the command asks for, worked out before anything is sent: a command unb doesn't know says its usage and
    // reaches no one, so the token never leaves for it.
    let Some(req) = request(&args) else {
        eprintln!("usage: unb do <goal> [--url <page>] [name=value ...] [--fields <path,...>] | unb browse <command...> [--site <site>] [--goal <words>] | unb challenge <look|click|drag|type --text -|press|wait|done> [--url <page>] [--site <site>] [--session <name>] | unb search [words] | unb open <unbrowse://link> | unb call <id> [name=value ...] [--fields <path,...>] | unb logins | unb whoami | unb judge <route id> <right|wrong> [--url <page>] [--why <text>] [--what <words>] [--fields <path,...>] [--writes|--reads] [--bounty <id> --entry <entry>] | unb report <kind> <summary> --expected <what> --got <what> [--route <id>] [--goal <words>] [--url <page>] [--tool <tool>] [--error <text>]");
        return ExitCode::from(2);
    };
    let http = client(WAIT);
    if let Err(e) = proven(&http, &base, &token) {
        eprintln!("{e}");
        return ExitCode::FAILURE;
    }
    match ask(&base, &token, req) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            if v.get("error").is_some() { ExitCode::FAILURE } else { ExitCode::SUCCESS }
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// One request to the node, signed with `token`, and the node's signed answer as JSON.
fn ask(base: &str, token: &str, req: Req) -> Result<Value, String> {
    let (method, url, body) = match req {
        Req::Get(path, None) => (reqwest::Method::GET, format!("{base}{path}"), None),
        Req::Get(path, Some(q)) => {
            let mut url = reqwest::Url::parse(&format!("{base}{path}")).map_err(|e| format!("UNBROWSE_NODE ({base}) isn't an address: {e}"))?;
            url.query_pairs_mut().append_pair("q", &q);
            (reqwest::Method::GET, url.to_string(), None)
        }
        Req::Post(path, body) => (reqwest::Method::POST, format!("{base}{path}"), Some(serde_json::to_vec(&body).map_err(|e| e.to_string())?)),
    };
    let answer = signed_client::send(method, &url, token, body.as_deref(), &[], Some(WAIT)).map_err(|e| match e {
        signed_client::Failed::Send(e) => unanswered(&e, base, WAIT),
        refused => refused.to_string(),
    })?;
    serde_json::from_slice(&answer.body).map_err(|_| not_json(base, answer.status, &String::from_utf8_lossy(&answer.body)))
}

/// `unb mcp`: the node's MCP server (`/mcp`) over stdio, one JSON-RPC message a line, for an agent that starts its MCP
/// servers as programs. Each message goes to the node signed with the token, after the node has proved itself to this
/// token, and an answer goes back to the agent only when the node signed it. A request runs beside the others (a tool
/// call can walk a page for minutes); `initialize` is waited for, since the session the node opens there goes with every
/// message after it.
fn mcp(base: &str, token: &str) -> ExitCode {
    use std::io::{BufRead, Write};
    use std::sync::{Arc, Mutex};
    let http = client(WAIT);
    let out = Arc::new(Mutex::new(std::io::stdout()));
    let session: Arc<Mutex<Option<String>>> = Arc::default();
    let mut running = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let (http, base, token, out, session) = (http.clone(), base.to_string(), token.to_string(), out.clone(), session.clone());
        let message: Value = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(_) => {
                say(&out, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } }));
                continue;
            }
        };
        let opens = message.get("method").and_then(Value::as_str) == Some("initialize");
        let relay = move || {
            if let Some(answer) = mcp_one(&http, &base, &token, &message, &session) {
                say(&out, &answer);
            }
        };
        if opens {
            relay();
        } else {
            running.push(std::thread::spawn(relay));
        }
    }
    for r in running {
        let _ = r.join();
    }
    let _ = std::io::stdout().flush();
    ExitCode::SUCCESS
}

fn say(out: &std::sync::Mutex<std::io::Stdout>, message: &Value) {
    use std::io::Write;
    let mut out = out.lock().unwrap_or_else(|e| e.into_inner());
    let _ = writeln!(out, "{message}");
    let _ = out.flush();
}

/// One MCP message relayed: the node's answer, the agent told why when there is none to give, or nothing for a
/// notification.
fn mcp_one(http: &reqwest::blocking::Client, base: &str, token: &str, message: &Value, session: &std::sync::Mutex<Option<String>>) -> Option<Value> {
    let id = message.get("id").cloned().filter(|i| !i.is_null());
    let refuse = |why: String| id.clone().map(|id| json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": why } }));
    if let Err(e) = proven(http, base, token) {
        return refuse(e);
    }
    let body = serde_json::to_vec(message).ok()?;
    let held = session.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let extra: Vec<(&str, &str)> = held.as_deref().map(|s| vec![("mcp-session-id", s)]).unwrap_or_default();
    let answer = match signed_client::send(reqwest::Method::POST, &format!("{base}/mcp"), token, Some(&body), &extra, Some(WAIT)) {
        Ok(a) => a,
        Err(signed_client::Failed::Send(e)) => return refuse(unanswered(&e, base, WAIT)),
        Err(other) => return refuse(other.to_string()),
    };
    if message.get("method").and_then(Value::as_str) == Some("initialize") {
        if let Some(s) = answer.headers.get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session.lock().unwrap_or_else(|e| e.into_inner()) = Some(s.to_string());
        }
    }
    id.as_ref()?;
    match serde_json::from_slice::<Value>(&answer.body) {
        Ok(v) if !v.is_null() => Some(v),
        _ => refuse(format!("the node answered {} with nothing to read", answer.status)),
    }
}

/// How long unb waits for the node's answer: the node's `CALL_WAIT_SECS` (`agent-api.json`'s `call_wait_secs`), as the
/// SDKs and the MCP configs do, since a `do` may walk a page and a call may heal by walking it again.
const WAIT: std::time::Duration = std::time::Duration::from_secs(330);

/// How long unb waits for the connection itself. The node is on this machine or a near one, so a connection not made in
/// this long is a node that isn't there, said as such, never a slow answer.
const CONNECT_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The client unb asks the node with for what isn't signed (the node's proof of itself, its health), waiting `wait` for
/// an answer. Like the signed client (`signed_client::plain`), it follows no redirect: a request to the node goes only
/// to the address it was made for.
fn client(wait: std::time::Duration) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_WAIT)
        .timeout(wait)
        .build()
        .expect("a client with only timeouts set builds")
}

/// The node's answer to a request sent, as JSON, or what went wrong, said so the caller knows what to do next: a node
/// that took the request and is still working on it (issue #544: a slow `do` was told as a dead node, and a healthy
/// node was restarted) is not a node that isn't running, and neither is a node that answered with something unb can't
/// read.
fn answer(sent: reqwest::Result<reqwest::blocking::Response>, base: &str, wait: std::time::Duration) -> Result<Value, String> {
    let res = sent.map_err(|e| unanswered(&e, base, wait))?;
    let status = res.status();
    let text = res.text().map_err(|e| unanswered(&e, base, wait))?;
    serde_json::from_str(&text).map_err(|_| not_json(base, status, &text))
}

/// What unb says of an answer it can't read as JSON, with the start of what it sent.
fn not_json(base: &str, status: impl std::fmt::Display, text: &str) -> String {
    let shown: String = text.trim().chars().take(200).collect();
    format!("the node at {base} answered ({status}), but not with JSON, so unb can't read it: {shown:?}. Is UNBROWSE_NODE the node's address?")
}

/// What a request that got no answer means. A failed connection is a node that isn't there; a timeout after it is a
/// node that took the request and was still working when unb stopped waiting; anything else broke the answer on the way.
fn unanswered(e: &reqwest::Error, base: &str, wait: std::time::Duration) -> String {
    if e.is_connect() {
        format!("couldn't reach the node at {base}: {e}. Is the Unbrowse app running?")
    } else if e.is_timeout() {
        format!(
            "the node at {base} took the request but hadn't answered after {} s, when unb stops waiting. The node is up, and the work may still be running on it",
            wait.as_secs()
        )
    } else {
        format!("the node at {base} took the request, but its answer broke off: {e}")
    }
}

/// One request to the node: a GET (with a search query, for `search`) or a POST with its body.
enum Req {
    Get(String, Option<String>),
    Post(String, Value),
}

/// Why a command is refused before anything is read or sent: `unb challenge --text <words>` puts what is typed (a
/// code, a password) on the command line, where other programs read it while unb runs. The words come on stdin.
fn text_on_command_line(args: &[String]) -> Option<String> {
    if args.first().map(String::as_str) != Some("challenge") {
        return None;
    }
    let at = args.iter().position(|a| a == "--text")?;
    (args.get(at + 1).map(String::as_str) != Some("-")).then(|| {
        "unb challenge: what is typed is read from stdin, never the command line, where other programs can read it: \
         printf '%s' \"$WORDS\" | unb challenge type --text -"
            .to_string()
    })
}

/// All of stdin, without the one line end a shell's `echo` leaves.
fn stdin_text() -> Option<String> {
    use std::io::Read;
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).ok()?;
    Some(s.strip_suffix('\n').map(|t| t.strip_suffix('\r').unwrap_or(t)).unwrap_or(&s).to_string())
}

/// The request a command makes, or none for a command unb doesn't know. Each of the node's primitives
/// (`agent-api.json`) has its command here: `every_primitive_has_its_command`.
fn request(args: &[String]) -> Option<Req> {
    request_with(args, &mut stdin_text)
}

/// [`request`], with what `--text -` reads from stdin given by `stdin`.
fn request_with(args: &[String], stdin: &mut dyn FnMut() -> Option<String>) -> Option<Req> {
    Some(match args.first().map(String::as_str) {
        Some("whoami") => Req::Get("/v1/whoami".into(), None),
        Some("logins") => Req::Get("/v1/logins".into(), None),
        Some("browse") if args.len() >= 2 => {
            let (mut steps, mut site, mut goal, mut session) = (Vec::new(), String::new(), String::new(), env_session());
            let mut rest = args[1..].iter();
            while let Some(a) = rest.next() {
                match a.as_str() {
                    "--site" => site = rest.next().cloned().unwrap_or_default(),
                    "--goal" => goal = rest.next().cloned().unwrap_or_default(),
                    "--session" => session = rest.next().cloned().unwrap_or_default(),
                    _ => steps.push(a.clone()),
                }
            }
            Req::Post("/v1/browse".into(), json!({ "do": steps, "site": site, "goal": goal, "session": session }))
        }
        Some("challenge") if args.len() >= 2 => {
            let (mut url, mut site, mut session) = (String::new(), String::new(), env_session());
            let (mut x, mut y, mut to_x, mut to_y, mut text, mut key, mut ms): (Option<f64>, Option<f64>, Option<f64>, Option<f64>, Option<String>, Option<String>, Option<u64>) =
                (None, None, None, None, None, None, None);
            let mut action = args[1].clone();
            let mut rest = args[2..].iter();
            while let Some(a) = rest.next() {
                match a.as_str() {
                    "--url" => url = rest.next().cloned().unwrap_or_default(),
                    "--site" => site = rest.next().cloned().unwrap_or_default(),
                    "--session" => session = rest.next().cloned().unwrap_or_default(),
                    // Only from stdin (`text_on_command_line`): words on the command line are refused.
                    "--text" => match rest.next().map(String::as_str) {
                        Some("-") => text = Some(stdin()?),
                        _ => return None,
                    },
                    "--key" => key = rest.next().cloned(),
                    "--ms" => ms = rest.next().and_then(|v| v.parse().ok()),
                    other if other.starts_with("--") => return None,
                    other if action == "look" => action = other.to_string(),
                    other => {
                        // The four numbers a click or a drag takes, in order: x y [to_x to_y].
                        let v: Option<f64> = other.parse().ok();
                        match (x, y, to_x) {
                            (None, _, _) => x = v,
                            (Some(_), None, _) => y = v,
                            (_, Some(_), None) => to_x = v,
                            _ => to_y = v,
                        }
                    }
                }
            }
            let body = json!({ "action": action, "url": url, "site": site, "session": session, "x": x, "y": y, "to_x": to_x, "to_y": to_y, "text": text, "key": key, "ms": ms });
            Req::Post("/v1/challenge".into(), body)
        }
        Some("search") => Req::Get("/v1/routes".into(), Some(args[1..].join(" "))),
        Some("inspect") if args.len() >= 2 => Req::Get(format!("/v1/routes/{}/inspect", args[1]), None),
        Some("observe") => {
            let mut site = String::new();
            let mut session = String::new();
            let mut goal = String::new();
            let mut rest = args[1..].iter();
            while let Some(a) = rest.next() {
                match a.as_str() {
                    "--site" => site = rest.next().cloned().unwrap_or_default(),
                    "--session" => session = rest.next().cloned().unwrap_or_default(),
                    "--goal" => goal = rest.next().cloned().unwrap_or_default(),
                    _ => {}
                }
            }
            Req::Post("/v1/observe".into(), json!({ "site": site, "session": session, "goal": goal }))
        }
        Some("walk") if args.len() >= 2 => {
            let mut goal = String::new();
            let mut pick = None;
            let mut what = String::new();
            let mut session = String::new();
            let mut rest = args[2..].iter();
            while let Some(a) = rest.next() {
                match a.as_str() {
                    "--goal" => goal = rest.next().cloned().unwrap_or_default(),
                    "--pick" => pick = rest.next().and_then(|v| v.parse::<u64>().ok()),
                    "--what" => what = rest.next().cloned().unwrap_or_default(),
                    "--session" => session = rest.next().cloned().unwrap_or_default(),
                    other => goal = format!("{goal} {other}").trim().to_string(),
                }
            }
            Req::Post("/v1/walk".into(), json!({ "url": args[1], "goal": goal, "pick": pick, "what": what, "session": session }))
        }
        Some("open") if args.len() >= 2 => Req::Get("/v1/open".into(), Some(args[1].clone())),
        Some("do") if args.len() >= 2 => {
            let (goal, url, inputs, fields) = parts(&args[1..]);
            Req::Post("/v1/do".into(), json!({ "goal": goal.join(" "), "url": url.unwrap_or_default(), "inputs": inputs, "session": env_session(), "fields": fields }))
        }
        Some("report") if args.len() >= 2 => {
            let mut body = serde_json::Map::new();
            let mut summary = Vec::new();
            let mut rest = args[2..].iter();
            while let Some(a) = rest.next() {
                let field = match a.as_str() {
                    "--expected" => "expected",
                    "--got" => "got",
                    "--route" => "route_id",
                    "--goal" => "goal",
                    "--url" => "url",
                    "--tool" => "tool",
                    "--error" => "error",
                    _ => {
                        summary.push(a.clone());
                        continue;
                    }
                };
                body.insert(field.into(), json!(rest.next().cloned().unwrap_or_default()));
            }
            body.insert("kind".into(), json!(args[1]));
            body.insert("summary".into(), json!(summary.join(" ")));
            Req::Post("/v1/report".into(), Value::Object(body))
        }
        Some("judge") if args.len() >= 3 => {
            let mut body = serde_json::Map::new();
            let mut rest = args[3..].iter();
            while let Some(a) = rest.next() {
                let field = match a.as_str() {
                    "--url" => "url",
                    "--why" => "why",
                    "--what" => "what",
                    // The entry a bounty answer is about (spec ch. 8, `result.bounties.confirm`).
                    "--entry" => "entry",
                    "--writes" | "--reads" => {
                        body.insert("writes".into(), json!(a == "--writes"));
                        continue;
                    }
                    // A bounty the node asked about (spec ch. 8, `result.bounties.confirm`).
                    "--bounty" => {
                        body.insert("bounty".into(), json!(rest.next()?.parse::<u64>().ok()?));
                        continue;
                    }
                    "--fields" => {
                        let paths: Vec<String> = rest.next().map(|f| f.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect()).unwrap_or_default();
                        body.insert("fields".into(), json!(paths));
                        continue;
                    }
                    _ => return None,
                };
                body.insert(field.into(), json!(rest.next().cloned().unwrap_or_default()));
            }
            body.insert("verdict".into(), json!(args[2]));
            Req::Post(format!("/v1/routes/{}/judge", args[1]), Value::Object(body))
        }
        Some("call") if args.len() >= 2 => {
            let (_, _, inputs, fields) = parts(&args[2..]);
            Req::Post(format!("/v1/routes/{}/call", args[1]), json!({ "inputs": inputs, "fields": fields }))
        }
        _ => return None,
    })
}

/// Asks what listens at `base` to answer a fresh challenge with `token` (`unbrowse_core::node_proof`) before the token
/// is sent there: only the node the token is for can, so a process that took the node's port while it was away never
/// sees the token.
fn proven(http: &reqwest::blocking::Client, base: &str, token: &str) -> Result<(), String> {
    let port = url::Url::parse(base).ok().and_then(|u| u.port_or_known_default()).ok_or_else(|| format!("UNBROWSE_NODE ({base}) isn't an address"))?;
    let mut challenge = [0u8; 32];
    getrandom::fill(&mut challenge).map_err(|e| e.to_string())?;
    let answer = answer(http.get(format!("{base}/v1/node/proof")).query(&[("challenge", hex::encode(challenge)), ("key", hex::encode(unbrowse_core::token_key(token)))]).send(), base, WAIT)?;
    if let Some(e) = answer.get("error").and_then(Value::as_str) {
        return Err(format!("the node at {base} couldn't prove who it is: {e}"));
    }
    let want = hex::encode(unbrowse_core::node_proof(token, port, &challenge));
    match answer.get("agents").and_then(Value::as_array) {
        Some(proofs) if proofs.iter().any(|p| p.as_str() == Some(want.as_str())) => Ok(()),
        _ => Err(format!("what answers at {base} isn't the node this agent's token is for (or the key is revoked); the token wasn't sent")),
    }
}

/// A command's words: the plain ones (a goal), `--url <page>`, `name=value` inputs and `--fields <path,path>` (the
/// answer's fields to get besides the defaults, or `*` for all of it). An older script's
/// `--pays-usd <dollars>` is read past, never taken for goal words: the node no longer asks what a call pays.
/// The browsing session `UNB_SESSION` names: each has its own tab of a site's browser on the node, so scripts browsing
/// the same site at once each keep their own page. None names the key's own.
fn env_session() -> String {
    std::env::var("UNB_SESSION").unwrap_or_default()
}

fn parts(args: &[String]) -> (Vec<String>, Option<String>, serde_json::Map<String, Value>, Vec<String>) {
    let (mut words, mut url, mut inputs, mut fields) = (Vec::new(), None, serde_json::Map::new(), Vec::new());
    let mut rest = args.iter();
    while let Some(a) = rest.next() {
        if a == "--pays-usd" {
            rest.next();
            eprintln!("--pays-usd is no longer used: the node pays a route's fee itself, up to its owner's per-fetch maximum");
        } else if a == "--url" {
            url = rest.next().cloned();
        } else if a == "--fields" {
            fields.extend(rest.next().map(|f| f.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect::<Vec<_>>()).unwrap_or_default());
        } else if let Some((k, v)) = a.split_once('=') {
            inputs.insert(k.to_string(), json!(v));
        } else {
            words.push(a.clone());
        }
    }
    (words, url, inputs, fields)
}

/// Register agent `index` (else the key the node made itself) with Claude Code. The entry names the agent (`unb mcp
/// --agent <index|first>`), so no command line, config or printed text holds its token. A machine where the node has
/// never run gets it started here, and connect waits for it to make its first key, so `npm i -g unbrowse && unbrowse
/// connect` works on a fresh machine. What an older Unbrowse left is found first and shown, and replaced only once the
/// new entry answers (`migrate`).
fn connect(base: &str, args: &[String]) -> ExitCode {
    use std::io::IsTerminal;
    let opts = match migrate::parse(args) {
        Ok(o) => o,
        Err(usage) => {
            eprintln!("{usage}");
            return ExitCode::from(2);
        }
    };
    let machine = legacy::Machine::here(base);
    let root = unbrowse_files::private::home().join("migration");
    let mut hosts = migrate::Real::here();
    let mut out = std::io::stdout();
    if let Some(at) = &opts.undo {
        return match migrate::undo(&machine, &root, at.as_deref(), opts.purge, &mut hosts, &mut out) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }
    let unb = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("unb"));
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let plan = migrate::Plan::new(machine, migrate::entry(base, opts.index, &unb), root.join(migrate::stamp(now)));
    print!("{}", plan.text());
    match migrate::next(&opts, plan.changes(), std::io::stdin().is_terminal()) {
        migrate::Next::OnlyShow if opts.dry_run => {
            println!("\nDry run: nothing was changed.");
            return ExitCode::SUCCESS;
        }
        migrate::Next::OnlyShow => {
            println!("\nNothing was changed. Run `unbrowse connect` in a terminal to answer, or `unbrowse connect --yes` to go ahead.");
            return ExitCode::SUCCESS;
        }
        migrate::Next::Go => {}
        migrate::Next::Ask => {
            print!("Continue? [Y/n] ");
            let _ = std::io::Write::flush(&mut out);
            let mut answer = String::new();
            let _ = std::io::stdin().read_line(&mut answer);
            if matches!(answer.trim().to_ascii_lowercase().as_str(), "n" | "no") {
                println!("Nothing was changed.");
                return ExitCode::SUCCESS;
            }
        }
    }
    let program = node_program();
    let probe = signed_client::plain(std::time::Duration::from_secs(2));
    let started = !answers(&probe, base);
    if started {
        eprintln!("starting the Unbrowse node ({})...", program.display());
        if let Err(e) = start_node(&program, base) {
            eprintln!("couldn't start the node: {e}");
            return ExitCode::FAILURE;
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    while !answers(&probe, base) {
        if std::time::Instant::now() > deadline {
            eprintln!("the node didn't come up at {base}; its log is {}", node_log().display());
            return ExitCode::FAILURE;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let token = match agent_token(&program, opts.index, started.then_some(deadline)) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let http = client(WAIT);
    if let Err(e) = proven(&http, base, &token) {
        eprintln!("{e}");
        return ExitCode::FAILURE;
    }
    let which = opts.index.map(|i| format!("agent {i}")).unwrap_or_else(|| "your first agent".into());
    match ask(base, &token, Req::Get("/v1/whoami".into(), None)) {
        Ok(v) if v.get("error").is_none() => eprintln!("{which} is live on the node: {}", v.get("agent").and_then(Value::as_str).unwrap_or("unnamed")),
        Ok(_) => {
            eprintln!("{which} isn't live on the node. The node makes your first agent itself; for another one, or one you removed, add an agent in the Unbrowse app (Money, Agents), then run this again.");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    }
    if let Some(said) = http.get(format!("{base}/v1/health")).send().and_then(|r| r.json::<Value>()).ok().as_ref().and_then(waiting_on_owner) {
        eprintln!("{said}");
    }
    // Claude Code starts `unb mcp --agent <index>`, which reads the agent's token from the grant the owner's yes left
    // (`agent_token` above) and signs each message with it: the token is in no command line and no config, and Claude
    // never sends it. An earlier Unbrowse's entries (a bearer header, or the token in their environment) are replaced.
    drop(token);
    match migrate::apply(&plan, &mut hosts, &mut out) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// The token the owner granted agent `which` (`Some(n)`, or `None` for the node's first key): the grant file the node
/// writes on the owner's yes (`unbrowse-node agent token`, `agents::write_grant`), owner-only. With none, nothing: the
/// owner hasn't let that agent's client in, and `unb mcp` won't ask the keystore itself.
fn granted_token(home: &std::path::Path, which: Option<u32>) -> Result<String, String> {
    let dir = home.join("bridges");
    let not_yet = |what: String| format!("the owner hasn't let {what} in on this machine yet: run `unbrowse grant {}` once (the owner is asked), or `unbrowse connect`", which.map(|i| i.to_string()).unwrap_or_else(|| "first".into()));
    let index = match which {
        Some(i) => i,
        None => std::fs::read_to_string(dir.join("first")).ok().and_then(|f| f.trim().parse().ok()).ok_or_else(|| not_yet("the node's first agent key".into()))?,
    };
    std::fs::read_to_string(dir.join(format!("agent-{index}.token")))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .ok_or_else(|| not_yet(format!("agent {index}")))
}

/// `unb grant [<n> | first]`: asks the owner to let agent `n` (else the node's first key) be used by a client on this
/// machine, and keeps the yes as its grant for `unb mcp --agent`. The token is never printed.
fn grant(which: Option<&str>) -> ExitCode {
    let index = match which {
        None | Some("first") => None,
        Some(n) => match n.parse() {
            Ok(i) => Some(i),
            Err(_) => {
                eprintln!("usage: unb grant [<agent number> | first]");
                return ExitCode::from(2);
            }
        },
    };
    match agent_token(&node_program(), index, None) {
        Ok(_) => {
            eprintln!("granted: `unb mcp --agent {}` can act as that agent now", which.unwrap_or("first"));
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// The agent `unb mcp` speaks for: `--agent <index>` or `--agent first` names it, and its token is read from the
/// owner's grant for it; nothing named means UNBROWSE_AGENT_TOKEN, else the node's first agent. Every other argument
/// is an older Unbrowse's (`--account x`, `--base-url …`) and is ignored, never read as a token or an address.
/// `Ok(Some(None))` is the node's first key.
#[allow(clippy::type_complexity)]
fn mcp_agent(args: &[String]) -> Result<Option<Option<u32>>, String> {
    let usage = || "usage: unb mcp [--agent <index> | --agent first]".to_string();
    let named = args.iter().enumerate().find_map(|(i, a)| match a.as_str() {
        "--agent" => Some(args.get(i + 1).map(String::as_str)),
        a => a.strip_prefix("--agent=").map(Some),
    });
    match named {
        None => Ok(None),
        Some(Some("first")) => Ok(Some(None)),
        Some(Some(which)) => which.parse().map(|i| Some(Some(i))).map_err(|_| usage()),
        Some(None) => Err(usage()),
    }
}

/// What an agent is told when `unb mcp` has no agent to speak for (an older Unbrowse's entry on a machine whose owner
/// hasn't let one in): an MCP server over stdio all the same, so the agent connects, sees the one step that sets it up
/// and can tell its person, rather than a server that failed to start.
fn not_connected(why: &str) -> ExitCode {
    use std::io::BufRead;
    let out = std::sync::Mutex::new(std::io::stdout());
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            say(&out, &json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "not JSON" } }));
            continue;
        };
        if let Some(answer) = not_connected_answer(&message, why) {
            say(&out, &answer);
        }
    }
    ExitCode::SUCCESS
}

/// The answer to one MCP message while no agent is connected, or nothing for a notification.
fn not_connected_answer(message: &Value, why: &str) -> Option<Value> {
    let id = message.get("id").cloned().filter(|i| !i.is_null())?;
    let say = format!(
        "Unbrowse now runs on this machine, and this agent isn't connected to it yet: run `unbrowse connect` in a terminal once, then restart the agent. ({why})"
    );
    let result = match message.get("method").and_then(Value::as_str) {
        Some("initialize") => json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "unbrowse", "version": env!("CARGO_PKG_VERSION") },
            "instructions": say,
        }),
        Some("tools/list") => json!({ "tools": [{
            "name": "unbrowse_connect",
            "description": say,
            "inputSchema": { "type": "object", "properties": {} },
        }] }),
        Some("tools/call") => json!({ "content": [{ "type": "text", "text": say }], "isError": true }),
        Some("ping") => json!({}),
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32001, "message": say } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// What a node's health says it waits on its owner for, if it does: a machine set up with `unbrowse connect` alone may
/// never open the window that would ask them.
fn waiting_on_owner(health: &Value) -> Option<&str> {
    health["checks"]["network"]["detail"].as_str()?.strip_prefix("waiting: ")
}

/// `unbrowse-node`: beside this program (the app bundle and the npm platform package keep them together), else on PATH.
fn node_program() -> std::path::PathBuf {
    let name = if cfg!(windows) { "unbrowse-node.exe" } else { "unbrowse-node" };
    std::env::current_exe()
        .ok()
        .and_then(|me| me.parent().map(|d| d.join(name)))
        .filter(|p| p.exists())
        .unwrap_or_else(|| std::path::PathBuf::from(name))
}

/// Where a node started from here writes its output: the same file the window's node writes.
fn node_log() -> std::path::PathBuf {
    unbrowse_files::private::home().join("node.log")
}

/// Whether anything answers the node's proof route at `base`.
fn answers(http: &reqwest::blocking::Client, base: &str) -> bool {
    http.get(format!("{base}/v1/node/proof")).query(&[("challenge", "00".repeat(32))]).send().is_ok()
}

/// Starts the node with no window, the way the window starts it: detached, so it outlives this command and the
/// terminal it ran in, its output appended to `node.log`. A `UNBROWSE_NODE` naming another port is the port it takes.
fn start_node(program: &std::path::Path, base: &str) -> Result<(), String> {
    let home = unbrowse_files::private::home();
    std::fs::create_dir_all(&home).map_err(|e| format!("{}: {e}", home.display()))?;
    let log = node_log();
    let mut cmd;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "nohup \"$0\" >>\"$1\" 2>&1 </dev/null &"]).arg(program).arg(&log).process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let f = std::fs::OpenOptions::new().create(true).append(true).open(&log).map_err(|e| format!("{}: {e}", log.display()))?;
        cmd = std::process::Command::new(program);
        cmd.stdout(f.try_clone().map_err(|e| e.to_string())?).stderr(f).creation_flags(0x0800_0000);
    }
    cmd.stdin(std::process::Stdio::null());
    if std::env::var_os("UNBROWSE_PORT").is_none() {
        if let Some(port) = url::Url::parse(base).ok().and_then(|u| u.port_or_known_default()) {
            cmd.env("UNBROWSE_PORT", port.to_string());
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("{}: {e}", program.display()))?;
    if cfg!(unix) {
        // The shell exits once the node is running in the background.
        child.wait().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A live agent key's token, from `unbrowse-node agent token`. A node that has only just started makes its first key
/// once its root key is open: until `deadline`, a "no key yet" answer (exit 3) is asked again.
fn agent_token(program: &std::path::Path, index: Option<u32>, deadline: Option<std::time::Instant>) -> Result<String, String> {
    loop {
        let mut cmd = std::process::Command::new(program);
        cmd.args(["agent", "token"]);
        if let Some(i) = index {
            cmd.arg(i.to_string());
        }
        let out = cmd.stdin(std::process::Stdio::null()).output().map_err(|e| format!("couldn't run {}: {e}", program.display()))?;
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !token.is_empty() {
            return Ok(token);
        }
        let waiting = out.status.code() == Some(3) && deadline.is_some_and(|d| std::time::Instant::now() < d);
        if !waiting {
            let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if said.is_empty() { format!("{} agent token exited {}", program.display(), out.status) } else { said });
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every primitive the node has (`agent-api.json`, written from its PRIMITIVES) has a command here that sends the
    /// primitive's method to its route: a primitive added to the node fails this until unb has it.
    #[test]
    fn every_primitive_has_its_command() {
        let manifest: Value = serde_json::from_str(include_str!("../../../agent-api.json")).unwrap();
        for p in manifest["primitives"].as_array().unwrap() {
            let (cli, method, path) = (p["cli"].as_str().unwrap(), p["method"].as_str().unwrap(), p["path"].as_str().unwrap());
            let args: Vec<String> = [cli, "x", "y=1"].iter().map(|s| s.to_string()).collect();
            let want = path.replace("{id}", "x");
            match request(&args) {
                Some(Req::Get(got, _)) => assert_eq!(("GET", got.as_str()), (method, want.as_str()), "unb {cli}"),
                Some(Req::Post(got, _)) => assert_eq!(("POST", got.as_str()), (method, want.as_str()), "unb {cli}"),
                None => panic!("unb has no command {cli} for {}", p["tool"]),
            }
        }
    }

    /// What a challenge types comes from stdin: `--text -` sends what stdin held, and words given on the command line
    /// are refused before anything is read or sent.
    #[test]
    fn challenge_text_comes_from_stdin_never_the_command_line() {
        let args: Vec<String> = ["challenge", "type", "--text", "-"].iter().map(|s| s.to_string()).collect();
        assert!(text_on_command_line(&args).is_none());
        let Some(Req::Post(path, body)) = request_with(&args, &mut || Some("4417 code".into())) else { panic!("a step is a POST") };
        assert_eq!((path.as_str(), body["action"].as_str(), body["text"].as_str()), ("/v1/challenge", Some("type"), Some("4417 code")));
        for words in [&["challenge", "type", "--text", "hunter2"][..], &["challenge", "type", "--text"][..]] {
            let args: Vec<String> = words.iter().map(|s| s.to_string()).collect();
            assert!(text_on_command_line(&args).is_some_and(|why| why.contains("stdin")), "{words:?}");
            assert!(request_with(&args, &mut || panic!("stdin is never read for words on the command line")).is_none());
        }
        assert!(text_on_command_line(&["browse".into(), "--text".into(), "x".into()]).is_none(), "only the challenge's text");
    }

    /// A browse names the session it runs in, so two scripts on one key each keep their own page.
    #[test]
    fn a_browse_names_its_session() {
        let args: Vec<String> = ["browse", "get", "url", "--session", "checkout", "--site", "shop.example"].iter().map(|s| s.to_string()).collect();
        let Some(Req::Post(_, body)) = request(&args) else { panic!("browse posts") };
        assert_eq!(body, json!({ "do": ["get", "url"], "site": "shop.example", "goal": "", "session": "checkout" }));
    }

    #[test]
    fn a_report_says_its_kind_summary_and_what_was_expected_and_got() {
        let args: Vec<String> = ["report", "wrong_data", "returned", "another", "repo", "--expected", "treg", "--got", "firecrawl", "--route", "r1"].iter().map(|s| s.to_string()).collect();
        let Some(Req::Post(path, body)) = request(&args) else { panic!("a report is a POST") };
        assert_eq!(path, "/v1/report");
        assert_eq!(body, json!({ "kind": "wrong_data", "summary": "returned another repo", "expected": "treg", "got": "firecrawl", "route_id": "r1" }));
    }

    #[test]
    fn a_judgment_names_its_route_verdict_page_and_fields() {
        let args: Vec<String> = ["judge", "r1", "wrong", "--url", "https://shop.example/search/x", "--why", "no listings", "--fields", "items[].title, items[].price"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let Some(Req::Post(path, body)) = request(&args) else { panic!("a judgment is a POST") };
        assert_eq!(path, "/v1/routes/r1/judge");
        assert_eq!(body, json!({ "verdict": "wrong", "url": "https://shop.example/search/x", "why": "no listings", "fields": ["items[].title", "items[].price"] }));
        // A flag unb doesn't know sends nothing, so a typo never becomes a verdict.
        assert!(request(&["judge", "r1", "wrong", "--wat", "x"].map(String::from)).is_none());
        // An answer to a bounty the node asked about (spec ch. 8): the bounty and the entry it names.
        let Some(Req::Post(_, body)) = request(&["judge", "0xe", "right", "--bounty", "4", "--entry", "0xe"].map(String::from)) else { panic!("a judgment is a POST") };
        assert_eq!(body, json!({ "verdict": "right", "bounty": 4, "entry": "0xe" }));
        assert!(request(&["judge", "r1", "right", "--bounty", "four"].map(String::from)).is_none());
        // The old bounty flags and the verify commands are gone: unb sends nothing for them.
        assert!(request(&["judge", "r1", "wrong", "--intent", "0xab"].map(String::from)).is_none());
        assert!(request(&["judge", "r1", "right", "--bounty", "4", "--report", "2"].map(String::from)).is_none());
        assert!(request(&["verify-candidates".to_string()]).is_none());
    }

    #[test]
    fn connect_says_what_the_node_waits_on_its_owner_for() {
        let health = |detail: &str| json!({ "checks": { "network": { "ok": true, "detail": detail } } });
        assert_eq!(waiting_on_owner(&health("waiting: this node stays off the peer network")), Some("this node stays off the peer network"));
        assert_eq!(waiting_on_owner(&health("joined")), None);
        assert_eq!(waiting_on_owner(&json!({})), None);
    }

    /// `unb mcp --agent` acts only as an agent the owner let in (its grant): any other, the node's first key included,
    /// gets the way to ask the owner, and nothing reads the keystore for it.
    #[test]
    fn unb_mcp_cannot_select_undelegated_key() {
        let home = std::env::temp_dir().join(format!("unb-grants-{}", std::process::id()));
        let dir = home.join("bridges");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("agent-2.token"), "unb_granted\n").unwrap();
        assert_eq!(granted_token(&home, Some(2)).as_deref(), Ok("unb_granted"), "the agent the owner let in");
        let refused = granted_token(&home, Some(3)).unwrap_err();
        assert!(refused.contains("unbrowse grant 3"), "another agent isn't, and nothing asks the keystore for it: {refused}");
        assert!(granted_token(&home, None).is_err(), "nor the node's first key, with no grant of its own");
        std::fs::write(dir.join("first"), "2").unwrap();
        assert_eq!(granted_token(&home, None).as_deref(), Ok("unb_granted"), "the first key, once the owner let it in");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// `connect` gives Claude Code `unb mcp` to start, naming the agent: no token is on its command line or in the config
    /// it writes, and no HTTP server or bearer header is handed one.
    #[test]
    fn connect_puts_no_token_on_a_command_line_or_in_a_config() {
        for (index, named) in [(None, "first"), (Some(3), "3")] {
            let args = migrate::add_args("unbrowse", &migrate::entry("http://127.0.0.1:7788", index, std::path::Path::new("/opt/unb")));
            let line = args.join(" ");
            assert!(line.ends_with(&format!("-- /opt/unb mcp --agent {named}")), "{line}");
            assert!(!line.contains("UNBROWSE_AGENT_TOKEN") && !line.contains("unb_") && !line.contains("Bearer") && !line.contains("--transport"), "{line}");
        }
        assert_eq!(mcp_agent(&[]), Ok(None));
        assert_eq!(mcp_agent(&["--agent".into(), "first".into()]), Ok(Some(None)));
        assert_eq!(mcp_agent(&["--agent".into(), "2".into()]), Ok(Some(Some(2))));
        assert_eq!(mcp_agent(&["--token".into(), "unb_x".into()]), Ok(None), "a token is never taken on the command line");
    }

    /// An entry an older Unbrowse wrote starts `unb mcp` with that version's flags: they are ignored (B3), an agent
    /// named beside them still counts, and a bad `--agent` still says the usage.
    #[test]
    fn unb_mcp_ignores_an_older_unbrowses_flags() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(mcp_agent(&v(&["--account", "x"])), Ok(None));
        assert_eq!(mcp_agent(&v(&["--base-url", "https://unbrowse.ai", "--account", "x", "--api-key", "ub_live_x"])), Ok(None));
        assert_eq!(mcp_agent(&v(&["--account", "x", "--agent", "2"])), Ok(Some(Some(2))));
        assert_eq!(mcp_agent(&v(&["--agent=first", "--account", "x"])), Ok(Some(None)));
        assert!(mcp_agent(&v(&["--agent", "nope"])).is_err());
        assert!(mcp_agent(&v(&["--account", "x", "--agent"])).is_err());
    }

    /// With no agent let in, an older entry still gets an MCP server: it starts, lists one tool and says the step.
    #[test]
    fn an_entry_with_no_agent_let_in_is_told_to_connect() {
        let init = not_connected_answer(&json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }), "no grant").unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["instructions"].as_str().unwrap().contains("unbrowse connect"));
        let list = not_connected_answer(&json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), "no grant").unwrap();
        assert_eq!(list["result"]["tools"][0]["name"], "unbrowse_connect");
        let call = not_connected_answer(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "unbrowse_do" } }), "no grant").unwrap();
        assert_eq!(call["result"]["isError"], true);
        assert!(not_connected_answer(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), "no grant").is_none());
    }

    /// What unb says when a GET to a listener at `base` goes unanswered or answers badly, waiting `wait`.
    fn said_for(base: &str, wait: std::time::Duration) -> String {
        answer(client(wait).get(format!("{base}/v1/whoami")).send(), base, wait).expect_err("nothing here answers with JSON")
    }

    /// A node that took the request and is still working on it is a slow answer, never a dead node (issue #544): unb
    /// says it waited, how long, and that the work may still be running, and doesn't ask whether the app is running.
    #[test]
    fn a_slow_answer_is_never_told_as_a_node_that_isnt_running() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        // Takes the connection and never answers, as a node busy with a long `do` does.
        let held = std::thread::spawn(move || {
            let (conn, _) = listener.accept().unwrap();
            std::thread::sleep(std::time::Duration::from_secs(5));
            drop(conn);
        });
        let said = said_for(&base, std::time::Duration::from_secs(1));
        assert!(said.contains("hadn't answered after 1 s"), "{said}");
        assert!(said.contains("may still be running"), "{said}");
        assert!(!said.contains("Is the Unbrowse app running?"), "{said}");
        held.join().unwrap();
    }

    /// Nothing listening is the one case that asks whether the app is running.
    #[test]
    fn a_failed_connection_asks_whether_the_app_is_running() {
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let base = format!("http://127.0.0.1:{port}");
        let said = said_for(&base, std::time::Duration::from_secs(5));
        assert!(said.starts_with(&format!("couldn't reach the node at {base}")), "{said}");
        assert!(said.ends_with("Is the Unbrowse app running?"), "{said}");
    }

    /// Something that answered, but not with JSON, is said as that, with what it sent.
    #[test]
    fn an_answer_that_isnt_json_is_said_as_such() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let other = std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut asked = [0u8; 1024];
            let _ = conn.read(&mut asked);
            conn.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 15\r\nconnection: close\r\n\r\n<html>hi</html>").unwrap();
        });
        let said = said_for(&base, std::time::Duration::from_secs(5));
        assert!(said.contains("answered (200 OK), but not with JSON"), "{said}");
        assert!(said.contains("<html>hi</html>"), "{said}");
        assert!(!said.contains("Is the Unbrowse app running?"), "{said}");
        other.join().unwrap();
    }

    /// unb waits as long as the node says a client should (`call_wait_secs`), like the SDKs.
    #[test]
    fn unb_waits_as_long_as_the_node_says_a_call_may_take() {
        let manifest: Value = serde_json::from_str(include_str!("../../../agent-api.json")).unwrap();
        assert_eq!(Some(WAIT.as_secs()), manifest["local"]["call_wait_secs"].as_u64());
    }

    #[test]
    fn a_command_unb_doesnt_know_makes_no_request() {
        assert!(request(&["fetch".to_string()]).is_none());
        assert!(request(&[]).is_none());
    }
}
