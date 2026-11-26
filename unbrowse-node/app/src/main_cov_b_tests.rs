//! UNB-208 tranche 2B step 8: tests for main.rs (owner b).

use super::*;

use std::sync::Mutex as StdMutex;

fn words(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| x.to_string()).collect()
}

/// A node on a memory keystore with its key made, as the window's commands see it.
fn node() -> Arc<Node> {
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(Some(Ok(IdentityView { address: id.address.to_checksum(), created: true }))),
        info: NodeInfo { name: "test".into(), version: "test".into(), api_port: 7788, dev: true },
        walks: learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: api::Events::default(),
        net: std::sync::OnceLock::new(),
        share: share::Share::default(),
    })
}

/// What a fake node does with one command.
enum Reply {
    /// Answers as the node does: signed with the owner's token.
    Signed(u16, serde_json::Value),
    /// Signed, but the body isn't JSON.
    SignedText(u16, &'static str),
    /// Answers, but not as the node signs.
    Unsigned(u16, &'static str),
    /// Takes the connection, then hangs up with nothing said.
    Hangup,
}

type Sent = Arc<StdMutex<Vec<(String, serde_json::Value)>>>;

/// A node of the test's own on 127.0.0.1: this home's owner token and API port point at it, and `answer` says what
/// each owner command gets back. Every command it took, with its body, is in the list returned.
fn fake_node(home: &std::path::Path, answer: impl Fn(&str, &serde_json::Value) -> Reply + Send + 'static) -> Sent {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::fs::write(home.join("owner.token"), "fake-token").unwrap();
    let mut s = store::load_settings();
    s.api_port = port;
    store::save_settings(&s).unwrap();
    let sent: Sent = Arc::default();
    let log = sent.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let split = loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break None;
                }
                raw.extend_from_slice(&buf[..n]);
                if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(at + 4);
                }
            };
            let Some(split) = split else { continue };
            let head = String::from_utf8_lossy(&raw[..split]).to_string();
            let header = |name: &str| head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix(&format!("{name}:")).map(|v| v.trim().to_string())).unwrap_or_default();
            let want: usize = header("content-length").parse().unwrap_or(0);
            while raw.len() < split + want {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
            }
            let cmd = head.split_whitespace().nth(1).unwrap_or_default().trim_start_matches("/owner/").to_string();
            let body: serde_json::Value = serde_json::from_slice(&raw[split..]).unwrap_or(serde_json::Value::Null);
            log.lock().unwrap().push((cmd.clone(), body.clone()));
            let nonce = header(unbrowse_core::signed::NONCE);
            let (status, text, signed) = match answer(&cmd, &body) {
                Reply::Hangup => continue,
                Reply::Signed(status, v) => (status, v.to_string(), true),
                Reply::SignedText(status, t) => (status, t.to_string(), true),
                Reply::Unsigned(status, t) => (status, t.to_string(), false),
            };
            let mac = if signed {
                let m = unbrowse_core::signed::reply_mac("fake-token", status, &unbrowse_core::signed::body_hash(text.as_bytes()), &nonce);
                format!("{}: {}\r\n", unbrowse_core::signed::REPLY, hex::encode(m))
            } else {
                String::new()
            };
            let reply = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{mac}Connection: close\r\n\r\n{text}", text.len());
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    sent
}

fn ok(v: serde_json::Value) -> Reply {
    Reply::Signed(200, v)
}

fn sent_cmds(sent: &Sent) -> Vec<String> {
    sent.lock().unwrap().iter().map(|(c, _)| c.clone()).collect()
}

/// Whatever `ask_at` says to a node that answers in each way a node (or something holding its address) can.
#[test]
fn an_answer_the_node_did_not_sign_is_never_used_and_a_bad_one_says_how() {
    let home = store::scratch_home("mb-ask");
    let cases = [
        (Reply::Unsigned(200, "{}"), "didn't sign its answer"),
        (Reply::Unsigned(401, "{\"error\":\"theirs\"}"), "refused this request before it could tell whose it was"),
        (Reply::Hangup, "the node took the command but its answer never came"),
        (Reply::SignedText(200, "not json"), "expected"),
        (Reply::Signed(409, serde_json::json!({ "error": "no, thanks" })), "no, thanks"),
        (Reply::Signed(500, serde_json::json!({})), "the node refused it"),
    ];
    let (tx, rx) = std::sync::mpsc::channel::<Reply>();
    let rx = StdMutex::new(rx);
    let _sent = fake_node(&home, move |_, _| rx.lock().unwrap().recv().unwrap());
    for (reply, said) in cases {
        tx.send(reply).unwrap();
        let e = owner_call_within("anything", serde_json::json!({}), std::time::Duration::from_secs(5)).unwrap_err();
        assert!(e.contains(said), "wanted {said:?}, got {e:?}");
        assert!(!e.contains("theirs"), "what an unsigned answer says is never shown");
    }
}

/// `confirm` takes `--wait <seconds>` or nothing; any other words are a usage line, not a wait.
#[test]
fn confirm_with_words_it_does_not_know_prints_its_usage_and_asks_no_node() {
    let home = store::scratch_home("mb-confirm-usage");
    let sent = fake_node(&home, |_, _| ok(serde_json::json!([])));
    for bad in [&["--wait", "soon"][..], &["soon"], &["--wait"], &["--wait", "1", "2"]] {
        assert_eq!(confirm_cli(&words(bad)), 2, "{bad:?}");
    }
    assert!(sent_cmds(&sent).is_empty());
}

/// With nothing waiting, `confirm --wait 0` looks once and says so; a node that refuses the look is an error.
#[test]
fn confirm_with_nothing_waiting_looks_once_and_a_refusing_node_is_an_error() {
    let home = store::scratch_home("mb-confirm-none");
    let sent = fake_node(&home, |_, _| ok(serde_json::json!([])));
    assert_eq!(confirm_cli(&words(&["--wait", "0"])), 0);
    assert_eq!(sent_cmds(&sent), ["confirmations"]);
    let home = store::scratch_home("mb-confirm-refused");
    let _sent = fake_node(&home, |_, _| Reply::Signed(409, serde_json::json!({ "error": "no" })));
    assert_eq!(confirm_cli(&words(&["--wait", "0"])), 1);
    assert!(confirm_on_terminal(0, &|_, _| Ok(serde_json::json!({ "not": "a list" }))).is_err());
}

/// Each waiting question is shown, the passphrase typed allows it, Enter refuses it, a wrong one is tried again, and
/// a node that says anything else ends that question with what it said.
#[test]
fn each_waiting_question_gets_the_owners_typed_answer() {
    let _home = store::scratch_home("mb-confirm-terminal");
    let asked = StdMutex::new(Vec::new());
    let tries = StdMutex::new(0);
    let call = |cmd: &str, body: serde_json::Value| -> Result<serde_json::Value, String> {
        match cmd {
            "confirmations" => Ok(serde_json::json!([
                { "id": "q1", "question": "first?", "seconds_left": 90 },
                { "id": "q2", "question": "second?", "seconds_left": 80 },
                { "id": "q3", "question": "third?", "seconds_left": 70 },
            ])),
            _ => {
                asked.lock().unwrap().push(body.clone());
                match body["id"].as_str().unwrap() {
                    "q1" => {
                        let mut t = tries.lock().unwrap();
                        *t += 1;
                        if *t == 1 { Err("wrong: 2 more tries".into()) } else { Ok(serde_json::json!("allowed it")) }
                    }
                    "q2" => Ok(serde_json::json!(7)),
                    _ => Err("it timed out".into()),
                }
            }
        }
    };
    tty::test::type_in(&["bad", "good", "", ""]);
    let said = confirm_on_terminal(5, &call).unwrap();
    assert_eq!(said, "allowed it\nanswered\nit timed out");
    let asked = asked.lock().unwrap();
    assert_eq!(asked.len(), 4);
    assert_eq!(asked[0]["passphrase"], "bad");
    assert_eq!(asked[1]["passphrase"], "good");
    assert!(asked[2]["passphrase"].is_null(), "Enter alone refuses");
    let shown = tty::test::said().join("");
    assert!(shown.contains("first?") && shown.contains("(80 seconds left)") && shown.contains("wrong: 2 more tries"), "{shown}");
}

/// Each `coin` word reaches the node as the owner command that does it, with its numbers read as numbers.
#[test]
fn each_coin_word_is_the_owner_command_that_does_it() {
    let home = store::scratch_home("mb-coin");
    let sent = fake_node(&home, |_, _| ok(serde_json::json!({ "done": true })));
    let table: [(&[&str], &str, serde_json::Value); 12] = [
        (&[], "coin_holdings", serde_json::json!({})),
        (&["launch", "e1", "5"], "coin_launch", serde_json::json!({ "entry": "e1", "unb": 5.0 })),
        (&["buy", "e1", "2.5"], "coin_buy", serde_json::json!({ "entry": "e1", "unb": 2.5 })),
        (&["sell", "e1", "3"], "coin_sell", serde_json::json!({ "entry": "e1", "coins": 3.0 })),
        (&["stake", "e1", "3"], "coin_stake", serde_json::json!({ "entry": "e1", "coins": 3.0, "delay": null })),
        (&["stake", "e1", "3", "60"], "coin_stake", serde_json::json!({ "entry": "e1", "coins": 3.0, "delay": 60 })),
        (&["unstake", "e1", "60", "1"], "coin_unstake", serde_json::json!({ "entry": "e1", "delay": 60, "coins": 1.0 })),
        (&["withdraw", "e1", "60"], "coin_withdraw", serde_json::json!({ "entry": "e1", "delay": 60 })),
        (&["claim", "e1"], "coin_claim", serde_json::json!({ "entry": "e1" })),
        (&["delay"], "coin_fetch_delay", serde_json::json!({ "delay": null })),
        (&["delay", "30"], "coin_fetch_delay", serde_json::json!({ "delay": 30 })),
        (&["dev-buy", "250"], "coin_dev_buy", serde_json::json!({ "bps": 250 })),
    ];
    for (argv, _, _) in &table {
        assert_eq!(coin_cli(&words(argv)), 0, "{argv:?}");
    }
    let got = sent.lock().unwrap().clone();
    for (i, (argv, cmd, body)) in table.iter().enumerate() {
        assert_eq!((&got[i].0, &got[i].1), (&cmd.to_string(), body), "{argv:?}");
    }
    assert_eq!(coin_cli(&words(&["dev-buy"])), 0);
    assert_eq!(sent.lock().unwrap().last().unwrap().1, serde_json::json!({ "bps": null }));
    assert_eq!(coin_cli(&words(&["list"])), 0);
    assert_eq!(coin_cli(&words(&["frobnicate"])), 2);
}

/// A node that refuses a coin command makes the command fail, with its words on stderr.
#[test]
fn a_coin_command_the_node_refuses_fails() {
    let home = store::scratch_home("mb-coin-refused");
    let _sent = fake_node(&home, |_, _| Reply::Signed(400, serde_json::json!({ "error": "no funds" })));
    assert_eq!(coin_cli(&words(&["buy", "e1", "5"])), 1);
}

fn a_route(id: &str) -> store::Route {
    serde_json::from_value(serde_json::json!({
        "id": id, "site": "shop.example", "what": "list items", "method": "GET", "path": "/items", "root": "https://shop.example/", "inputs": [],
        "steps": 0, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
    }))
    .unwrap()
}

/// The network words each set the one thing they say, and a word that is none of them changes nothing.
#[test]
fn each_network_word_sets_what_it_says() {
    let home = store::scratch_home("mb-network");
    assert_eq!(network_cli(&words(&["on"])), 0);
    assert!(store::load_settings().peer_network);
    assert_eq!(network_cli(&words(&["light"])), 0);
    assert!(store::load_settings().light);
    assert_eq!(network_cli(&words(&["kept", "on"])), 0);
    assert!(store::load_settings().serve_kept);
    assert_eq!(network_cli(&words(&["kept", "off"])), 0);
    assert!(!store::load_settings().serve_kept, "kept off stops serving what it keeps for others");
    assert_eq!(network_cli(&words(&["full"])), 0);
    assert!(!store::load_settings().light);
    assert_eq!(network_cli(&words(&["off"])), 0);
    assert!(!store::load_settings().peer_network);
    for bad in [&["kept"][..], &["kept", "maybe"], &["sideways"]] {
        assert_eq!(network_cli(&words(bad)), 2, "{bad:?}");
    }
    // What each standing says on its own, through every one of them.
    let mut s = store::load_settings();
    s.peer_network = true;
    s.terms_accepted = Some(terms::TERMS_VERSION.into());
    for (light, kept) in [(true, false), (false, true), (false, false)] {
        s.light = light;
        s.serve_kept = kept;
        store::save_settings(&s).unwrap();
        assert_eq!(network_cli(&[]), 0);
    }
    // `addrs` says where the node is once it has published, and that it hasn't before.
    assert_eq!(network_cli(&words(&["addrs"])), 0);
    store::write_json(&home.join("peer-published.json"), &unbrowse_files::PEER_PUBLISHED, &serde_json::json!({ "identity": "0x1", "peer_id": "12D3KooWabc", "addrs": ["/ip4/10.0.0.2/tcp/4001"] })).unwrap();
    assert_eq!(peers::dial_addresses(), (Some("12D3KooWabc".into()), vec!["/ip4/10.0.0.2/tcp/4001/p2p/12D3KooWabc".to_string()]));
    assert_eq!(network_cli(&words(&["addrs"])), 0);
}

/// `checkout list` shows every hold with its other hosts and warnings, and `done` / `dismiss all` end them.
#[test]
fn checkout_holds_are_listed_and_ended_by_the_owner() {
    let _home = store::scratch_home("mb-checkout");
    let keys = root_store().unwrap();
    open_identity(keys.as_ref()).unwrap();
    payhold::seal_from(|| root_store().ok().and_then(|k| unbrowse_core::RootKey::load(k.as_ref()).ok()));
    payhold::begin("shop.example", &words(&["pay.example"])).unwrap();
    payhold::warn("shop.example", "the record was cut short");
    payhold::begin("other.example", &[]).unwrap();
    assert_eq!(checkout_cli(&[]), 0);
    assert_eq!(payhold::list().unwrap().len(), 2);
    assert_eq!(checkout_cli(&words(&["done", "shop.example"])), 0);
    assert!(payhold::of("shop.example").is_none(), "done ends that site's hold");
    assert!(payhold::of("other.example").is_some());
    assert_eq!(checkout_cli(&words(&["dismiss", "all"])), 0);
    assert!(payhold::list().unwrap().is_empty());
    assert_eq!(checkout_cli(&words(&["done", "shop.example"])), 0, "a site that wasn't held is said so");
    assert_eq!(checkout_cli(&words(&["bogus"])), 2);
}

/// Words that start no install or removal ask nothing of the system, and nothing the owner doesn't say yes to runs.
#[test]
fn the_agent_user_commands_refuse_what_they_cannot_read_and_run_nothing_without_a_yes() {
    let _home = store::scratch_home("mb-agent-user-cli");
    assert_eq!(agent_user_cli(&[]), 2);
    assert_eq!(agent_user_cli(&words(&["sideways"])), 2);
    for bad in [&["install", "--agent"][..], &["install", "--agent", "first"], &["run"], &["run", "--"]] {
        assert_eq!(agent_user_cli(&words(bad)), 1, "{bad:?}");
    }
    // `remove` shows its plan and waits for the owner's y: with none typed, nothing was removed.
    tty::test::type_in(&["n"]);
    assert_eq!(agent_user_cli(&words(&["remove"])), 1);
    assert!(tty::test::said().join("").contains("Go ahead? [y/N]"));
    if !agent_user_exists() {
        assert_eq!(agent_user_cli(&words(&["status"])), 1, "no agent user to check");
        let said = agent_user_status().unwrap_err();
        assert!(said.contains(&format!("there is no OS user {}", agent_user::NAME)) && said.contains("`unbrowse-node agent-user install` makes it"), "{said}");
    }
}

/// An install makes the node's key and one for the agent user, shows the plan, and does none of it on a no.
#[test]
fn an_install_the_owner_does_not_go_ahead_with_makes_a_key_and_runs_nothing() {
    let _home = store::scratch_home("mb-agent-user-install");
    owner_dialog::answer_in_test(Some(true));
    tty::test::type_in(&["n"]);
    assert_eq!(agent_user_install(None, false, false).unwrap_err(), "nothing was done");
    let shown = tty::test::said().join("");
    assert!(shown.contains("This will:") && shown.contains("Go ahead? [y/N]"), "{shown}");
    let made = agents::list();
    assert_eq!(made.len(), 1, "the agent user's own key is made before the plan is shown");
    assert!(made[0].name.starts_with(&agent_user::key_name()[..4.min(agent_user::key_name().len())]));
    // A second install would look through the real $HOME (`unbrowse_files::private::user_home`, no test hook) for kept tokens: not run here.
}

/// Steps run in order, a step's stdin is fed from the plan, and the first that fails stops the rest.
#[cfg(unix)]
#[test]
fn steps_run_in_order_feed_their_input_and_stop_at_the_first_failure() {
    let dir = store::scratch_home("mb-steps");
    let (kept, never) = (dir.join("kept"), dir.join("never"));
    let step = |what: &str, argv: &[&str], stdin: Option<&str>| agent_user::Step { what: what.into(), argv: words(argv), stdin: stdin.map(String::from), make: false };
    let (k, n) = (kept.to_string_lossy().to_string(), never.to_string_lossy().to_string());
    run_steps(&[step("keep the words", &["sh", "-c", "cat > \"$1\"", "sh", &k], Some("hello\n"))]).unwrap();
    assert_eq!(std::fs::read_to_string(&kept).unwrap(), "hello\n");
    let e = run_steps(&[step("break", &["sh", "-c", "exit 3"], None), step("go on", &["sh", "-c", "touch \"$1\"", "sh", &n], None)]).unwrap_err();
    assert!(e.contains("couldn't break") && e.contains("nothing after it was done"), "{e}");
    assert!(!never.exists(), "a step after a failed one never runs");
    let e = run_steps(&[step("run a thing that isn't there", &["/nonexistent/unb-208-program"], None)]).unwrap_err();
    assert!(e.contains("/nonexistent/unb-208-program"), "{e}");
}

/// The plan is shown and the owner goes ahead only with a y.
#[test]
fn the_owner_goes_ahead_with_a_y_and_with_nothing_else() {
    let _home = store::scratch_home("mb-go-ahead");
    let steps = [agent_user::Step { what: "make a user".into(), argv: words(&["true"]), stdin: None, make: true }];
    assert!(go_ahead(&steps, true).is_ok(), "--yes needs no typing");
    for yes in ["y", "Y", "yes", " y "] {
        tty::test::type_in(&[yes]);
        assert!(go_ahead(&steps, false).is_ok(), "{yes:?}");
    }
    for no in ["", "n", "yep", "no"] {
        tty::test::type_in(&[no]);
        assert_eq!(go_ahead(&steps, false).unwrap_err(), "nothing was done", "{no:?}");
    }
    tty::test::type_in(&[]);
    assert!(go_ahead(&steps, false).unwrap_err().contains("needs a terminal"));
    assert!(tty::test::said().join("").contains("make a user"));
}

/// The owner's user is the one the system names, and the agent user is there only when the system knows it.
#[cfg(unix)]
#[test]
fn the_owner_user_is_the_one_the_system_names() {
    let id = |args: &[&str]| std::process::Command::new("id").args(args).output().unwrap();
    assert_eq!(owner_user_name().unwrap(), String::from_utf8_lossy(&id(&["-un"]).stdout).trim());
    assert_eq!(agent_user_exists(), id(&[ "-u", agent_user::NAME]).status.success());
    if !agent_user_exists() {
        assert_ne!(agent_user_run(&words(&["true"])), 0, "no agent user to run it as");
    }
}

/// Words that name no chain change nothing, a chain's name is kept for the next start, and what a node holds back is asked of the node.
#[test]
fn the_chain_words_keep_a_choice_and_ask_the_node_for_held_writes() {
    let _one = testchain::one_at_a_time_blocking();
    let home = store::scratch_home("mb-chain");
    assert_eq!(chain_cli(&words(&["no-such-chain"])), 2);
    assert_eq!(chain_cli(&words(&["arc-testnet"])), 0);
    assert_eq!(store::load_settings().chain, "arc-testnet");
    assert_eq!(chain_cli(&[]), 0, "the chain says where it is without reading it");
    assert_eq!(chain_cli(&words(&["deploy", "--bogus"])), 1);
    let sent = fake_node(&home, |_, _| ok(serde_json::json!([])));
    assert_eq!(chain_cli(&words(&["kept"])), 0);
    assert_eq!(chain_cli(&words(&["kept", "release", "w1"])), 0);
    assert_eq!(chain_cli(&words(&["kept", "forget"])), 1);
    assert_eq!(sent.lock().unwrap().clone(), vec![("chain_kept".to_string(), serde_json::json!({})), ("chain_kept_release".to_string(), serde_json::json!({ "key": "w1" }))]);
}

/// `chain deploy` is for a live chain and never beside a running node: the node writes with the key a deploy signs with.
#[test]
fn a_deploy_waits_for_the_node_to_stop_and_needs_a_live_chain() {
    let _one = testchain::one_at_a_time_blocking();
    let _home = store::scratch_home("mb-deploy");
    let open = chain::OpenValues {};
    assert!(chain_deploy(None, &open).unwrap_err().contains("is for a live chain"));
    let mut s = store::load_settings();
    s.chain = "arc-testnet".into();
    let busy = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    s.api_port = busy.local_addr().unwrap().port();
    store::save_settings(&s).unwrap();
    assert!(listening_here(s.api_port));
    assert!(chain_deploy(None, &open).unwrap_err().contains("the node is running here"));
    assert_eq!(chain_cli(&words(&["deploy"])), 1);
}

/// `chain deploy`'s flags: a pool needs both its amounts, above zero; any other flag is refused by name.
#[test]
fn deploy_flags_take_a_pool_with_both_amounts_and_nothing_else() {
    let (seed, _) = deploy_args(&words(&["--pool", "10", "2.5"])).unwrap();
    assert_eq!(seed, Some(chain::PoolSeed { usdc: 10.0, unb: 2.5 }));
    assert_eq!(deploy_args(&[]).unwrap().0, None);
    for bad in [&["--pool"][..], &["--pool", "1"], &["--pool", "0", "1"], &["--pool", "1", "-3"], &["--pool", "x", "1"]] {
        assert_eq!(deploy_args(&words(bad)).unwrap_err(), "--pool takes a number above zero", "{bad:?}");
    }
    assert!(deploy_args(&words(&["--yolo"])).unwrap_err().contains("doesn't take --yolo"));
}

/// What a node reports of sharing is read for every state a route can be in, and a node that isn't running is read from the files.
#[test]
fn share_status_reads_every_state_a_route_can_be_in() {
    let home = store::scratch_home("mb-share-status");
    assert_eq!(share_cli(&[]), 0, "no node running: the files answer");
    let route = |why: &str, extra: serde_json::Value| {
        let mut r = serde_json::json!({ "id": format!("r-{why}"), "what": "list items", "site": "shop.example", "why": why });
        r.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        r
    };
    let routes: Vec<_> = ["listed", "below_threshold", "cap_reached", "blocked", "queued", "opted_out", "off", "not_run_yet", "excluded", "not_shareable", "failed", "novel"]
        .iter()
        .map(|w| route(w, serde_json::json!({ "days": 1, "days_needed": 3, "runs": 2, "runs_needed": 5, "per_day": 10, "host": "x.example", "reason": "it pays", "error": "rpc down" })))
        .collect();
    let sent = fake_node(&home, move |_, _| ok(serde_json::json!({ "mode": "off", "listed_today": 0, "per_day": 10, "blocked": { "message": "no gas" }, "routes": routes })));
    assert_eq!(share_cli(&words(&["status"])), 0);
    assert_eq!(sent_cmds(&sent), ["share_status"]);
    assert_eq!(share_show(), Ok(()));
}

/// A route's sharing is its own record's while no node runs, and the node's when one does; one that doesn't exist is no route.
#[test]
fn a_routes_sharing_is_set_in_its_record_or_by_the_node() {
    let home = store::scratch_home("mb-share-route");
    store::save_route(&a_route("r1")).unwrap();
    assert_eq!(share_cli(&words(&["route", "r1", "on"])), 0);
    assert_eq!(store::load_route("r1").unwrap().share, Some(true));
    assert_eq!(share_cli(&words(&["route", "r1", "off"])), 0);
    assert_eq!(store::load_route("r1").unwrap().share, Some(false));
    assert_eq!(share_cli(&words(&["route", "nope", "on"])), 1);
    let mut live = a_route("r2");
    live.listing = Some(store::Listing { entry_id: "0x1".into(), tx: "0x2".into(), listed_at: 1, live: true });
    store::save_route(&live).unwrap();
    let sent = fake_node(&home, |_, _| ok(serde_json::json!({})));
    assert_eq!(share_cli(&words(&["route", "r2", "off"])), 0);
    assert_eq!(sent.lock().unwrap().clone(), vec![("share_route".to_string(), serde_json::json!({ "id": "r2", "on": false }))]);
    assert_eq!(store::load_route("r2").unwrap().share, None, "the node keeps it, not the file");
}

/// The mode, the daily count and the delisting each do what they say, and bad words are refused by name.
#[test]
fn share_modes_counts_and_delisting() {
    let home = store::scratch_home("mb-share-modes");
    assert_eq!(share_cli(&words(&["all"])), 0);
    let s = store::load_settings();
    assert!(matches!(s.share_routes, store::ShareMode::All) && s.share_notice_seen);
    assert_eq!(share_cli(&words(&["used"])), 0);
    assert_eq!(share_cli(&words(&["off"])), 0);
    assert!(matches!(store::load_settings().share_routes, store::ShareMode::Off));
    assert_eq!(share_cli(&words(&["per-day", "1"])), 0);
    assert_eq!(store::load_settings().list_per_day, Some(1));
    assert_eq!(share_cli(&words(&["per-day", "many"])), 1);
    assert_eq!(share_cli(&words(&["sideways"])), 2);
    assert_eq!(share_cli(&words(&["delist"])), 1, "no node running to delist");
    let sent = fake_node(&home, |_, _| ok(serde_json::json!(["a", "b"])));
    assert_eq!(share_cli(&words(&["delist"])), 0);
    assert_eq!(sent_cmds(&sent), ["delist_all"]);
}

/// A wallet that signs elsewhere is given the message to sign; what it signed is what links it.
#[test]
fn sign_in_with_a_wallet_gives_its_message_and_links_what_it_signed() {
    let home = store::scratch_home("mb-sign-in-wallet");
    let sent = fake_node(&home, |cmd, _| match cmd {
        "link_message" => ok(serde_json::json!({ "owner": "0xAbc", "message": "sign me", "nonce": "n1" })),
        "link_wallet" => ok(serde_json::json!({ "owner": "0xabc" })),
        _ => ok(serde_json::json!({ "mode": "used", "listed_today": 0, "per_day": 10, "routes": [] })),
    });
    assert_eq!(sign_in_cli(&words(&["--wallet", "0xAbc"])), 0);
    assert_eq!(sign_in_cli(&words(&["--wallet", "0xAbc", "--nonce", "n1", "--signature", "0xsig"])), 0);
    let got = sent.lock().unwrap().clone();
    assert_eq!(got[0], ("link_message".to_string(), serde_json::json!({ "owner": "0xAbc" })));
    assert_eq!(got[1], ("link_wallet".to_string(), serde_json::json!({ "owner": "0xAbc", "nonce": "n1", "signature": "0xsig" })));
    assert_eq!(sign_in_cli(&words(&["--wallet"])), 1, "words it can't read are its usage");
}

/// A node that links another wallet than the one asked for is not a link, and the website's sign-in waits for the page.
#[test]
fn sign_in_says_so_when_the_node_links_another_wallet_and_waits_on_the_website() {
    let home = store::scratch_home("mb-sign-in-site");
    let _sent = fake_node(&home, |cmd, _| match cmd {
        "link_wallet" => ok(serde_json::json!({ "owner": "0xother" })),
        "link_start" => ok(serde_json::json!({ "url": "https://unbrowse.ai/sign-in", "opened": true })),
        "link_status" => ok(serde_json::json!({ "waiting": false, "owner": "0xWallet" })),
        _ => ok(serde_json::json!({ "mode": "used", "listed_today": 0, "per_day": 10, "routes": [] })),
    });
    assert_eq!(sign_in_cli(&words(&["--wallet", "0xAbc", "--nonce", "n", "--signature", "s"])), 1);
    assert_eq!(sign_in_cli(&[]), 0);
}

/// A key file the whole machine can read signs nothing; one that is the owner's alone signs the node's sign-in here.
#[cfg(unix)]
#[test]
fn a_wallet_key_file_must_be_the_owners_alone_to_sign_the_sign_in() {
    use std::os::unix::fs::PermissionsExt;
    let home = store::scratch_home("mb-sign-in-key");
    let key = home.join("wallet.key");
    std::fs::write(&key, format!("0x{}\n", "11".repeat(32))).unwrap();
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    let path = key.to_string_lossy().to_string();
    let signer = login::key_from(&"11".repeat(32)).unwrap();
    let owner = signer.address().to_checksum(None);
    let msg = link::message("0xNode", &owner, "n9");
    let sent = fake_node(&home, move |cmd, _| match cmd {
        "identity" => ok(serde_json::json!({ "address": "0xNode" })),
        "link_message" => ok(serde_json::json!({ "owner": owner, "message": msg, "nonce": "n9" })),
        "link_wallet" => ok(serde_json::json!({ "owner": owner })),
        _ => ok(serde_json::json!({ "mode": "used", "listed_today": 0, "per_day": 10, "routes": [] })),
    });
    assert_eq!(sign_in_cli(&words(&["--key-file", &path])), 1, "readable by others");
    assert!(sent_cmds(&sent).is_empty());
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(sign_in_cli(&words(&["--key-file", &path])), 0);
    assert!(sent_cmds(&sent).contains(&"link_wallet".to_string()));
}

/// A passkey command that needs the running node sends it what it needs, and says so when it has no browser to use.
#[test]
fn passkey_use_and_enrol_go_to_the_node_with_their_browser() {
    let home = store::scratch_home("mb-passkey-node");
    assert_eq!(passkey_cli(&words(&["use", "shop.example"])), 1, "the node's own browser needs no `use`");
    let sent = fake_node(&home, |cmd, _| if cmd == "passkey_use" { ok(serde_json::json!({ "held": 2 })) } else { Reply::Signed(409, serde_json::json!({ "error": "no browser" })) });
    assert_eq!(passkey_cli(&words(&["use", "shop.example", "--cdp", "127.0.0.1:9222"])), 0);
    assert_eq!(passkey_cli(&words(&["enrol", "shop.example", "--cdp", "127.0.0.1:9222", "--wait", "1"])), 1);
    let got = sent.lock().unwrap().clone();
    assert_eq!(got[0], ("passkey_use".to_string(), serde_json::json!({ "site": "shop.example", "cdp": "127.0.0.1:9222" })));
    assert_eq!(got[1].0, "passkey_enrol");
    assert_eq!(got[1].1["site"], "shop.example");
    assert_eq!(got[1].1["minutes"], 1);
}

/// Sites the owner keeps passkeys off are listed beside the passkeys, and the browser a passkey acts in is the node's unless one is named.
#[test]
fn passkey_never_sites_are_listed_and_a_named_browser_is_used() {
    let _home = store::scratch_home("mb-passkey-never");
    assert_eq!(passkey_cli(&words(&["never", "shop.example"])), 0);
    assert_eq!(passkey::never(), ["shop.example"]);
    assert_eq!(passkey_cli(&words(&["list"])), 0);
    assert!(matches!(passkey_browser(None), passkey::Browser::Node));
    assert!(matches!(passkey_browser(Some("  ".into())), passkey::Browser::Node));
    assert!(matches!(passkey_browser(Some("127.0.0.1:9222".into())), passkey::Browser::At(a) if a == "127.0.0.1:9222"));
}

/// A card's limit is set, shown and taken away from a shell; one for a card that isn't there, or no amount, is refused.
#[test]
fn a_cards_limit_is_set_shown_and_taken_away_from_a_shell() {
    let _home = store::scratch_home("mb-card-limit");
    let keep = cli_vault_keep().unwrap();
    let card = unbrowse_core::Card::read("4242424242424242", "12/34", None, "A Person").unwrap();
    vault::add_card(&keep, "visa", &card, false, "You").unwrap();
    assert_eq!(vault_cli(&words(&["list"])), 0);
    assert_eq!(vault_cli(&words(&["card", "limit", "visa", "shop.example", "20", "50"])), 0);
    let limits = vault::card_limits(&keep);
    assert_eq!((limits.len(), limits[0].per_payment, limits[0].per_day), (1, 20.0, 50.0));
    assert_eq!(vault_cli(&words(&["card", "limits"])), 0);
    assert_eq!(vault_cli(&words(&["card", "limit", "visa", "shop.example", "30"])), 0);
    assert_eq!(vault::card_limits(&keep)[0].per_day, 30.0, "no daily amount is the payment's");
    assert_eq!(vault_cli(&words(&["card", "limit", "visa", "shop.example", "0"])), 0);
    assert!(vault::card_limits(&keep).is_empty(), "no amount takes the limit away");
    assert_eq!(vault_cli(&words(&["card", "limit", "visa", "shop.example", "lots"])), 1);
    assert_eq!(vault_cli(&words(&["card", "limit", "amex", "shop.example", "5"])), 1);
    assert_eq!(vault_cli(&words(&["card", "remove", "visa"])), 0);
    assert!(vault::cards().is_empty());
}

/// Keeping card security codes is turned on and off from a shell, and anything else is refused.
#[test]
fn card_security_codes_are_kept_or_forgotten_by_the_owners_word() {
    let _home = store::scratch_home("mb-card-codes");
    owner_dialog::answer_in_test(Some(true));
    assert_eq!(vault_cli(&words(&["card", "codes"])), 0);
    assert_eq!(vault_cli(&words(&["card", "codes", "on"])), 0);
    assert!(store::load_settings().keep_card_codes);
    let keep = cli_vault_keep().unwrap();
    let card = unbrowse_core::Card::read("4242424242424242", "12/34", Some("123"), "A Person").unwrap();
    vault::add_card(&keep, "visa", &card, true, "You").unwrap();
    assert_eq!(vault_cli(&words(&["card", "codes", "off"])), 0);
    assert!(!store::load_settings().keep_card_codes);
    assert_eq!(vault_cli(&words(&["card", "codes", "maybe"])), 1);
}

/// Who approves a card payment is changed in a shell only after the owner's yes in the dialog, and a no keeps the dialog.
#[test]
fn the_card_approver_changes_only_on_the_owners_yes() {
    let _home = store::scratch_home("mb-card-approver");
    let keys = root_store().unwrap();
    open_identity(keys.as_ref()).unwrap();
    assert_eq!(vault_cli(&words(&["card", "approver"])), 0);
    owner_dialog::answer_in_test(Some(false));
    assert_eq!(vault_cli(&words(&["card", "approver", "sdk"])), 1);
    let keys = root_store().unwrap();
    assert_eq!(owner_dialog::payment_approver(Some(keys.as_ref())).approver, "dialog");
    owner_dialog::answer_in_test(Some(true));
    assert_eq!(vault_cli(&words(&["card", "approver", "sdk"])), 0);
    let keys = root_store().unwrap();
    assert_eq!(owner_dialog::payment_approver(Some(keys.as_ref())).approver, "sdk");
    assert_eq!(vault_cli(&words(&["card", "approver", "dialog"])), 0);
    assert_eq!(vault_cli(&words(&["card", "approver", "bogus"])), 1);
    owner_dialog::answer_in_test(None);
}

/// A shell lists the web logins in the machine's login keychain, and can keep none that isn't there.
#[test]
fn the_login_keychain_lists_and_keeps_nothing_that_is_not_there() {
    let _home = store::scratch_home("mb-keychain");
    assert_eq!(vault_cli(&words(&["keychain"])), 0);
    assert_eq!(vault_cli(&words(&["keychain", "take", "nowhere.example", "nobody"])), 1);
    assert_eq!(vault_cli(&words(&["sideways"])), 2);
}

/// A command that needs an argument it wasn't given is refused by name, before the owner is asked anything.
#[test]
fn an_owner_command_missing_its_argument_is_refused_before_the_dialog() {
    let _home = store::scratch_home("mb-owner-missing");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let n = node();
    owner_dialog::answer_in_test(Some(true));
    match rt.block_on(owner(&n, "wallet_send", serde_json::json!({}))) {
        Err(OwnerError::Failed(m)) => assert!(m.contains("wallet_send is missing an argument it needs"), "{m}"),
        _ => panic!("refused by name"),
    }
    assert!(owner_dialog::asked_in_test().is_empty(), "no dialog for a call that can't run");
    owner_dialog::answer_in_test(None);
}

/// A top-up on a node whose chain isn't up deposits nothing and says so by returning false.
#[test]
fn a_top_up_with_no_chain_deposits_nothing() {
    let _home = store::scratch_home("mb-top-up");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    assert!(!rt.block_on(top_up(&node())));
}

// ---- merged from owner MB's own pass: what the base above doesn't reach ----

fn rt_here() -> tokio::runtime::Runtime {
    let home = store::home();
    tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&home)).build().unwrap()
}

/// `restart` reports what the node restarts into; a refusal is a failure and no node is a failure.
#[test]
fn restart_says_what_the_node_restarts_into_and_no_node_or_a_refusal_fails() {
    let home = store::scratch_home("mb-restart");
    assert_eq!(restart_cli(&[]), 1, "no node");
    assert_eq!(restart_cli(&words(&["now"])), 2, "restart takes no words");
    let sent = fake_node(&home, |_, _| ok(serde_json::json!({ "into": "v9" })));
    assert_eq!(restart_cli(&[]), 0);
    assert_eq!(sent_cmds(&sent), ["restart"]);
    let home = store::scratch_home("mb-restart-refused");
    let _sent = fake_node(&home, |_, _| Reply::Signed(409, serde_json::json!({ "error": "busy" })));
    assert_eq!(restart_cli(&[]), 1);
}

/// The lab's learn-walk takes exactly a capture, a url and a goal, and a capture that isn't there fails it.
#[test]
fn learn_walk_wants_a_capture_a_url_and_a_goal() {
    let home = store::scratch_home("mb-learn-walk");
    assert_eq!(learn_walk_cli(&words(&["capture.jsonl", "https://x.example"])), 2);
    assert_eq!(learn_walk_cli(&[]), 2);
    let gone = home.join("none.jsonl").to_string_lossy().to_string();
    assert_eq!(learn_walk_cli(&words(&[&gone, "https://x.example/", "list things"])), 1, "no capture on disk, no route");
    if std::env::var("UNBROWSE_LAB").is_err() {
        assert_eq!(lab_cli(&words(&["unbrowse-node", "learn-walk"])), None, "off unless the lab is on");
    }
}

/// `max-fetch` shows the cap, sets it to dollars (zero means none), and refuses what isn't a sum.
#[test]
fn max_fetch_shows_and_sets_the_most_a_route_may_cost() {
    let _home = store::scratch_home("mb-max-fetch");
    assert_eq!(max_fetch_cli(&[]), 0);
    assert_eq!(max_fetch_cli(&words(&["0.05"])), 0);
    assert_eq!(store::load_settings().max_fetch_usdc, 0.05);
    assert_eq!(max_fetch_cli(&[]), 0);
    assert_eq!(max_fetch_cli(&words(&["0"])), 0);
    assert_eq!(store::load_settings().max_fetch(), 0.0);
    assert_eq!(max_fetch_cli(&[]), 0, "zero is said as no paying");
    assert_eq!(max_fetch_cli(&words(&["lots"])), 2);
    assert_eq!(max_fetch_cli(&words(&["-1"])), 2);
    assert_eq!(max_fetch_cli(&words(&["1", "2"])), 2);
    assert_eq!(store::load_settings().max_fetch(), 0.0, "a refusal changes nothing");
}

/// The vault from a shell: a derived login added, listed, rotated and removed; anything else is a usage line.
#[test]
fn the_vault_from_a_shell_keeps_lists_rotates_and_removes_logins() {
    let _home = store::scratch_home("mb-vault-cli");
    assert_eq!(vault_cli(&words(&["list"])), 0);
    assert_eq!(vault_cli(&words(&["add", "shop.example", "me"])), 0);
    assert!(vault::list().iter().any(|l| l.site == "shop.example" && l.account == "me"));
    assert_eq!(vault_cli(&words(&["list"])), 0);
    assert_eq!(vault_cli(&words(&["rotate", "shop.example", "me"])), 0);
    assert_eq!(vault_cli(&words(&["rotate", "shop.example", "nobody"])), 1);
    assert_eq!(vault_cli(&words(&["remove", "shop.example", "me"])), 0);
    assert!(vault::list().is_empty());
    assert_eq!(vault_cli(&words(&["remove", "shop.example", "me"])), 1, "a login that isn't there");
    assert_eq!(vault_cli(&words(&["card", "remove", "none"])), 1);
    assert_eq!(vault_cli(&words(&["frobnicate"])), 2);
    assert_eq!(vault_cli(&[]), 2);
}

/// What is kept is said where it is kept.
#[test]
fn a_stored_secret_is_told_where_it_went() {
    assert!(kept_where(true).contains("sealed in the vault"));
    assert!(kept_where(false).contains("system's keystore"));
}

/// An export is read from its file; a missing one is named.
#[test]
fn an_export_is_read_from_its_file_and_a_missing_one_is_named() {
    let dir = store::scratch_home("mb-read-input");
    let f = dir.join("export.csv");
    std::fs::write(&f, "a,b\n").unwrap();
    assert_eq!(read_input(f.to_str().unwrap()).unwrap().as_str(), "a,b\n");
    assert!(read_input(dir.join("gone.csv").to_str().unwrap()).unwrap_err().starts_with("couldn't read"));
}

/// A browser's CSV export is imported into the vault; again, nothing new; a file with no logins imports nothing.
#[test]
fn a_password_export_is_imported_once_and_an_empty_one_is_refused() {
    let dir = store::scratch_home("mb-vault-import");
    let f = dir.join("passwords.csv");
    std::fs::write(&f, "name,url,username,password\nshop,https://shop.example/login,me,hunter2\nshop2,https://other.example/,you,pw2\n").unwrap();
    assert_eq!(vault_cli(&words(&["import", f.to_str().unwrap()])), 0);
    assert_eq!(vault::list().len(), 2, "{:?}", vault::list().len());
    assert_eq!(vault_cli(&words(&["import", f.to_str().unwrap()])), 0);
    assert_eq!(vault::list().len(), 2, "the same file again adds nothing");
    assert!(vault_import_cli("{}", "empty.json").unwrap_err().contains("nothing to import"));
    assert_eq!(vault_cli(&words(&["import", dir.join("gone").to_str().unwrap()])), 1);
}

/// A cookie file is kept as a host's session, listed, and forgotten; other words are a usage line.
#[test]
fn a_session_from_a_cookie_file_is_kept_listed_and_forgotten() {
    let dir = store::scratch_home("mb-session-cli");
    assert_eq!(session_cli(&words(&["list"])), 0);
    let f = dir.join("cookies.txt");
    std::fs::write(&f, "sid=abc123; theme=dark").unwrap();
    assert_eq!(session_cli(&words(&["import", "shop.example", "--from", f.to_str().unwrap()])), 0);
    assert!(sessions().iter().any(|s| s.host == "shop.example" && s.cookies == 2));
    assert_eq!(session_cli(&words(&["list"])), 0);
    assert_eq!(session_cli(&words(&["forget", "shop.example"])), 0);
    assert!(sessions().iter().all(|s| s.host != "shop.example"));
    assert_eq!(session_cli(&words(&["import", "shop.example", "--from", dir.join("gone").to_str().unwrap()])), 1);
    assert_eq!(session_cli(&words(&["import", "shop.example"])), 1, "the owner's browser can't be read here");
    assert_eq!(session_cli(&words(&["sideways"])), 2);
}

/// Passkeys from a shell: switched on and off, a site kept out and let back in, and the words they need.
#[test]
fn passkey_words_switch_them_and_keep_a_site_out() {
    let dir = store::scratch_home("mb-passkey-words");
    assert_eq!(passkey_cli(&words(&["off"])), 0);
    assert!(!passkey::enabled());
    assert_eq!(passkey_cli(&words(&["list"])), 0);
    let f = dir.join("pk.json");
    std::fs::write(&f, "{}").unwrap();
    assert_eq!(passkey_cli(&words(&["import", f.to_str().unwrap()])), 1, "off: refused");
    assert_eq!(passkey_cli(&words(&["on"])), 0);
    assert!(passkey::enabled());
    assert_eq!(passkey_cli(&words(&["import", f.to_str().unwrap()])), 1, "no passkeys in the file");
    assert_eq!(passkey_cli(&words(&["never", "shop.example"])), 0);
    assert!(passkey::never().iter().any(|s| s.contains("shop.example")));
    assert_eq!(passkey_cli(&words(&["allow", "shop.example"])), 0);
    assert!(passkey::never().is_empty());
    assert_eq!(passkey_cli(&words(&["remove", "pk-none"])), 1);
    assert_eq!(passkey_cli(&words(&["use", "shop.example"])), 1, "use is for another browser");
    assert_eq!(passkey_cli(&words(&["never"])), 2);
    assert_eq!(passkey_cli(&words(&["sideways"])), 2);
    assert_eq!(passkey_cli(&words(&["import", "/no/such/file"])), 1);
}

/// A blank DevTools address is the node's own browser.
#[test]
fn a_blank_devtools_address_is_the_nodes_own_browser() {
    assert!(matches!(passkey_browser(None), passkey::Browser::Node));
    assert!(matches!(passkey_browser(Some("  ".into())), passkey::Browser::Node));
    assert!(matches!(passkey_browser(Some("127.0.0.1:9222".into())), passkey::Browser::At(a) if a == "127.0.0.1:9222"));
}

/// With no owner token the node was never started here, and the words say how to start it; a token with nothing on the port is no node either.
#[test]
fn no_owner_token_is_no_node_and_a_signed_refusal_with_no_reason_says_so() {
    let home = store::scratch_home("mb-owner-ask");
    match owner_ask("restart", serde_json::json!({}), std::time::Duration::from_secs(1)) {
        Err(Unanswered::NoNode(e)) => assert!(e.contains("start the node first"), "{e}"),
        other => panic!("{other:?}"),
    }
    assert!(owner_call("restart", serde_json::json!({})).unwrap_err().contains("start the node first"));
    let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(home.join("owner.token"), "t").unwrap();
    let mut s = store::load_settings();
    s.api_port = gone.local_addr().unwrap().port();
    store::save_settings(&s).unwrap();
    drop(gone);
    assert!(matches!(owner_ask("restart", serde_json::json!({}), std::time::Duration::from_secs(2)), Err(Unanswered::NoNode(_))));
    let _sent = fake_node(&home, |_, _| Reply::Signed(500, serde_json::json!({})));
    match owner_ask("anything", serde_json::json!({}), std::time::Duration::from_secs(5)) {
        Err(Unanswered::Node(e)) => assert_eq!(e, "the node refused it"),
        other => panic!("{other:?}"),
    }
}

/// Owner-door arguments are read by name, and a secret is never said back in the error.
#[test]
fn owner_arguments_are_read_by_name_and_a_secret_is_not_said_back() {
    let a = serde_json::json!({ "n": 5, "name": "x", "secret": "hunter2", "bad": 7, "nothing": null });
    assert_eq!(arg::<u32>(&a, "n").ok(), Some(5));
    assert_eq!(arg::<Option<String>>(&a, "missing").ok(), Some(None));
    match arg::<String>(&a, "n") {
        Err(OwnerError::Failed(m)) => assert!(m.starts_with("n: "), "{m}"),
        _ => panic!("a number is no string"),
    }
    assert_eq!(secret_arg(&a, "secret").ok().flatten().as_deref().map(String::as_str), Some("hunter2"));
    assert!(secret_arg(&a, "missing").ok().flatten().is_none());
    assert!(secret_arg(&a, "nothing").ok().flatten().is_none());
    match secret_arg(&a, "bad") {
        Err(OwnerError::Failed(m)) => assert_eq!(m, "bad: give it as text"),
        _ => panic!(),
    }
    assert_eq!(needed_secret(&a, "secret").ok().as_deref().map(String::as_str), Some("hunter2"));
    match needed_secret(&a, "missing") {
        Err(OwnerError::Failed(m)) => assert_eq!(m, "missing: it is needed"),
        _ => panic!(),
    }
    assert_eq!(out(vec![1, 2]).ok(), Some(serde_json::json!([1, 2])));
    assert!(matches!(OwnerError::from("why".to_string()), OwnerError::Failed(m) if m == "why"));
    assert_eq!(String::from(Unanswered::NoNode("a".into())), "a");
    assert_eq!(String::from(Unanswered::Node("b".into())), "b");
}

/// A boot step that fails waits twice as long each time, up to two minutes.
#[test]
fn a_boot_retry_doubles_up_to_two_minutes() {
    let mut wait = BOOT_RETRY;
    let waits: Vec<u64> = (0..9).map(|_| backoff(&mut wait).as_secs()).collect();
    assert_eq!(waits, [2, 4, 8, 16, 32, 64, 120, 120, 120]);
}

/// A restart is called for by a changed key, by the owner taking the node off the network, or by light mode changing.
#[test]
fn a_node_restarts_only_for_what_it_took_at_its_start() {
    let took = |address: &str, joined: Option<bool>| Took { address: address.into(), joined };
    assert_eq!(restart_for(&took("0xAbC", None), "0xabc", false, false), None);
    assert!(restart_for(&took("0xabc", None), "0xdef", false, false).unwrap().contains("key changed"));
    assert!(restart_for(&took("0xabc", Some(false)), "0xabc", true, false).unwrap().contains("took the node off"));
    assert!(restart_for(&took("0xabc", Some(false)), "0xabc", false, true).unwrap().contains("how the node takes part"));
    assert_eq!(restart_for(&took("0xabc", Some(true)), "0xabc", false, true), None);
    assert_eq!(restart_for(&took("0xabc", None), "0xabc", true, true), None, "not joined: nothing to leave");
}

/// The chain pass runs with the key open whatever the network standing, and not without it.
#[test]
fn the_chain_pass_runs_with_the_key_open_whatever_the_network_says() {
    for standing in [terms::Standing::Joins, terms::Standing::KeptOff, terms::Standing::TermsDue] {
        assert!(chain_pass_runs(true, standing));
        assert!(!chain_pass_runs(false, standing));
    }
}

/// Every command word is listed once for help, and a port is heard only while something listens on it.
#[test]
fn the_command_words_are_listed_once_and_a_listening_port_is_heard() {
    let mut seen = std::collections::BTreeSet::new();
    assert!(NODE_COMMAND_WORDS.iter().all(|w| seen.insert(*w)));
    assert!(NODE_COMMAND_WORDS.contains(&"agent-user") && NODE_COMMAND_WORDS.contains(&"--help"));
    few_heaps();
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    assert!(listening_here(port));
}

/// The owner door says it doesn't know a command it doesn't have, and a command the owner says no to is not run.
#[test]
fn the_owner_door_does_not_know_what_it_does_not_have_and_a_no_runs_nothing() {
    let _home = store::scratch_home("mb-owner-door");
    let rt = rt_here();
    let node = node();
    assert!(matches!(rt.block_on(owner(&node, "no_such_command", serde_json::json!({}))), Err(OwnerError::Unknown)));
    owner_dialog::answer_in_test(Some(false));
    let r = rt.block_on(owner(&node, "vault_reveal", serde_json::json!({ "site": "a.example", "account": "me" })));
    owner_dialog::answer_in_test(None);
    assert!(r.is_err(), "the owner said no");
    assert!(owner_dialog::asked_in_test().last().unwrap().contains("a.example"));
    owner_dialog::answer_in_test(Some(true));
    let r = rt.block_on(owner(&node, "coin_launch", serde_json::json!({ "entry": "zz", "unb": 1.0 })));
    owner_dialog::answer_in_test(None);
    assert!(r.is_err(), "a malformed entry id is refused");
}

/// A node on the devnet holds no gateway pass, and a top-up with the key not open does nothing.
#[test]
fn the_gateway_pass_and_the_top_up_do_nothing_without_a_chain_or_a_key() {
    let _home = store::scratch_home("mb-gateway");
    let rt = rt_here();
    let node = node();
    let mut s = store::load_settings();
    s.chain = "devnet".into();
    store::save_settings(&s).unwrap();
    if std::env::var("UNBROWSE_CHAIN").is_err() {
        rt.block_on(hold_gateway_pass(&node));
    }
    *node.identity.write().unwrap() = None;
    assert!(!rt.block_on(top_up(&node)));
}

/// A hangup stops the wait and says why.
#[cfg(unix)]
#[test]
fn a_hangup_stops_the_wait_and_says_why() {
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
    let why = rt.block_on(async {
        let waiting = tokio::spawn(stop_asked());
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        // SAFETY: raises a signal this process handles once `stop_asked` has been polled.
        unsafe { libc::raise(libc::SIGHUP) };
        tokio::time::timeout(std::time::Duration::from_secs(10), waiting).await.expect("it stopped").unwrap()
    });
    assert_eq!(why, "its terminal closed (SIGHUP)");
}

/// The install a start does once the terms are accepted is recorded only when nothing was left undone: run from a disk
/// image the commands wait, nothing is kept, and the next start tries again; run from where the app stays, the skill it
/// put in place is kept in the settings and the next start has nothing to do.
#[test]
fn a_start_records_the_install_only_when_nothing_was_left_undone() {
    let home = store::scratch_home("install-on");
    store::save_settings(&store::Settings { terms_accepted: Some(terms::TERMS_VERSION.into()), ..store::Settings::default() }).unwrap();
    assert!(install_due(), "the terms are accepted and no install is recorded");
    let programs = home.join("programs");
    std::fs::create_dir_all(&programs).unwrap();
    std::fs::write(programs.join("claude"), "#!/bin/sh\n").unwrap();
    let m = legacy::Machine {
        home: home.join("owner"),
        claude_config_dir: None,
        codex_home: None,
        unbrowse_config_dir: None,
        xdg_config_home: None,
        node: String::new(),
        programs: vec![programs.clone()],
    };
    std::fs::create_dir_all(&m.home).unwrap();
    install_on(&m, std::path::Path::new("/Volumes/Unbrowse/Unbrowse.app/Contents/MacOS"));
    assert_eq!(store::load_settings().tools_skill, None, "the commands waited, so nothing is recorded");
    assert!(install_due(), "the next start tries again");
    install_on(&m, &programs);
    assert_eq!(store::load_settings().tools_skill, Some(install::skill_hash()));
    assert!(store::load_settings().tools_at.is_some());
    assert!(!install_due(), "the skill this build carries is the one recorded");
    assert_eq!(std::fs::read_to_string(m.home.join(".claude/skills/unbrowse/SKILL.md")).unwrap(), install::SKILL);
    let _ = std::fs::remove_dir_all(&home);
}

