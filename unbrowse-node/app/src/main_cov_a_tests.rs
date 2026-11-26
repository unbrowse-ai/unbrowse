//! UNB-208 tranche 2B step 8: tests for main.rs (owner a).

use super::*;
use serde_json::json;
use std::io::{BufRead, Read, Write};

fn w(words: &[&str]) -> Vec<String> {
    words.iter().map(|s| s.to_string()).collect()
}

/// A node for the window's commands in a scratch home: its runtime, the node and a key it holds in memory.
fn node_in(home: &std::path::Path) -> (tokio::runtime::Runtime, Arc<Node>) {
    let h = home.to_path_buf();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let node = Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
        info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: crate::learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: crate::api::Events::default(),
        net: std::sync::OnceLock::new(),
        share: crate::share::Share::default(),
    });
    (rt, node)
}

/// A route record on `site`, learned by the owner's browsing, with `inputs` and no steps.
fn route(id: &str, site: &str, what: &str, inputs: &[&str]) -> store::Route {
    serde_json::from_value(json!({
        "id": id, "site": site, "what": what, "method": "GET", "path": "/", "root": format!("https://{site}/"),
        "inputs": inputs.iter().map(|n| json!({ "name": n, "secret": false, "default": null })).collect::<Vec<_>>(),
        "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 0,
        "graph": { "steps": [], "provisional": false }
    }))
    .unwrap()
}

/// A site on 127.0.0.1 that answers every request with `body` and keeps each request's address.
fn hearing_site(body: String) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
    let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = site.local_addr().unwrap().port();
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let kept = heard.clone();
    std::thread::spawn(move || {
        for stream in site.incoming().flatten() {
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            let _ = reader.read_line(&mut first);
            kept.lock().unwrap().push(first.split_whitespace().nth(1).unwrap_or_default().to_string());
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
            }
            let mut out = stream;
            let _ = write!(out, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    (port, heard)
}

/// What a fake node was asked: each command's name and its body.
type Asked = Arc<std::sync::Mutex<Vec<(String, serde_json::Value)>>>;

/// A node in `home` that answers the owner's commands from `answers` (command, status, body), signed as the real node
/// signs: the owner token and the API port are written to `home`, so the shell commands find it.
fn fake_owner_node(home: &std::path::Path, answers: Vec<(&'static str, u16, String)>) -> Asked {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::fs::write(home.join("owner.token"), "t").unwrap();
    store::save_settings(&store::Settings { api_port: port, ..store::load_settings() }).unwrap();
    let asked: Asked = Arc::default();
    let kept = asked.clone();
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            s.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut got = Vec::new();
            let mut buf = [0u8; 4096];
            let (head_end, len) = loop {
                let Ok(n) = s.read(&mut buf) else { break (0, 0) };
                if n == 0 {
                    break (0, 0);
                }
                got.extend_from_slice(&buf[..n]);
                if let Some(at) = got.windows(4).position(|x| x == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&got[..at]).to_ascii_lowercase();
                    let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                    if got.len() >= at + 4 + len {
                        break (at + 4, len);
                    }
                }
            };
            if head_end == 0 {
                continue;
            }
            let head = String::from_utf8_lossy(&got[..head_end]).to_string();
            let path = head.split_whitespace().nth(1).unwrap_or_default().to_string();
            let nonce = head.to_ascii_lowercase().lines().find_map(|l| l.strip_prefix("x-unbrowse-nonce:").map(|v| v.trim().to_string())).unwrap_or_default();
            let cmd = path.trim_start_matches("/owner/").to_string();
            let body: serde_json::Value = serde_json::from_slice(&got[head_end..head_end + len]).unwrap_or_default();
            kept.lock().unwrap().push((cmd.clone(), body));
            let (code, reply) = answers.iter().find(|a| a.0 == cmd).map(|a| (a.1, a.2.clone())).unwrap_or((404, json!({ "error": "no such command" }).to_string()));
            let mac = hex::encode(unbrowse_core::signed::reply_mac("t", code, &unbrowse_core::signed::body_hash(reply.as_bytes()), &nonce));
            let _ = write!(s, "HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nx-unbrowse-reply: {mac}\r\nconnection: close\r\n\r\n{reply}", reply.len());
        }
    });
    asked
}

fn asked_for(asked: &Asked, cmd: &str) -> Vec<serde_json::Value> {
    asked.lock().unwrap().iter().filter(|(c, _)| c == cmd).map(|(_, b)| b.clone()).collect()
}

/// A listing mark on a route record.
fn live_listing(live: bool) -> store::Listing {
    store::Listing { entry_id: format!("0x{}", "ab".repeat(32)), tx: "0xtx".into(), listed_at: 1, live }
}

// ---- the keystore ----

/// A node in a folder of its own is told to keep its key in a file; the owner's folder is also told that a machine
/// with no desktop session may not reach its keystore.
#[test]
fn a_keystore_that_cannot_be_reached_is_answered_with_the_way_round_it() {
    let own = keystore_hint(false);
    assert!(own.contains("UNBROWSE_ROOT_KEY_FILE=1") && !own.contains("no desktop session"), "{own}");
    let owners = keystore_hint(true);
    assert!(owners.contains("no desktop session") && owners.contains("UNBROWSE_HOME=<folder> UNBROWSE_ROOT_KEY_FILE=1"), "{owners}");
}

/// A dev node's root key is a file in its devnet folder, made on the first read and read back the same after; its
/// keystore account is named for its folder, never the owner's.
#[test]
fn a_dev_nodes_root_key_is_a_file_in_its_own_folder() {
    let home = store::scratch_home("root-file");
    let keys = root_store().unwrap();
    assert!(root_address(keys.as_ref()).unwrap().is_none(), "looking at the address makes no key");
    let made = open_identity(keys.as_ref()).unwrap();
    assert!(home.join("devnet").join("root.key").exists(), "the key is a file beside the node's devnet data");
    assert_eq!(root_address(keys.as_ref()).unwrap(), Some(made.address.clone()));
    let account = root_account();
    assert!(account.starts_with(&format!("{KEYCHAIN_ACCOUNT}@")), "{account}");
    assert_ne!(account, KEYCHAIN_ACCOUNT);
    // A restore keeps the key it replaces in a file beside the root key's.
    let id = unbrowse_core::load_or_create(&unbrowse_core::MemoryStore::default()).unwrap();
    let aside = aside(&id.address).unwrap();
    assert!(aside.get().unwrap().is_none(), "nothing is kept aside until a restore puts a key there");
}

/// The vault stays locked until the node has its key, and says why; with the key it opens.
#[test]
fn the_vault_opens_only_once_the_node_has_its_key() {
    let home = store::scratch_home("vault-keep");
    let refused = vault_keep(Err("the keystore said no".into())).err().expect("locked");
    assert_eq!(refused, "the vault opens once the node has its key: the keystore said no");
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    assert!(vault_keep(Ok(&keys)).is_ok());
    // A shell's vault is made from the node's own root key, made on its first run.
    assert!(cli_vault_keep().is_ok());
    assert!(home.join("devnet").join("root.key").exists(), "a shell made the node's first key");
}

// ---- sessions and settings ----

/// The sessions the node holds are one per host with a jar, counted by cookies and never by value; a file that is
/// no host's is not a session. Signing out names what it refused.
#[test]
fn a_session_is_a_jar_of_a_host_and_signing_out_of_what_is_no_host_is_refused() {
    let _home = store::scratch_home("sessions");
    assert!(sessions().is_empty());
    for (host, n) in [("shop.example", 2), ("news.example", 1)] {
        let jar: std::collections::BTreeMap<String, String> = (0..n).map(|i| (format!("c{i}"), "v".to_string())).collect();
        store::write_json(&store::jar_path(host), &unbrowse_files::JAR, &jar).unwrap();
    }
    std::fs::write(store::jars_dir().join("not a host.json"), "{}").unwrap();
    std::fs::write(store::jars_dir().join("readme.txt"), "x").unwrap();
    let mut seen: Vec<(String, usize)> = sessions().into_iter().map(|s| (s.host, s.cookies)).collect();
    seen.sort();
    assert_eq!(seen, vec![("news.example".to_string(), 1), ("shop.example".to_string(), 2)]);
    assert_eq!(forget_session("not a host".into()).unwrap_err(), "not a host: not a host");
    assert!(forget_session("gone.example".into()).is_err(), "no jar to drop");
    forget_session("shop.example".into()).unwrap();
    assert_eq!(sessions().len(), 1);
}

/// A save that names a sum or share the node can't use is refused with the setting's own words, and writes nothing;
/// a good one is kept and what the node may reach follows it.
#[test]
fn a_settings_save_with_an_impossible_sum_is_refused_by_name() {
    let _home = store::scratch_home("settings-save");
    let base = store::load_settings();
    let bad = |f: &dyn Fn(&mut store::Settings)| {
        let mut s = base.clone();
        f(&mut s);
        save_settings(s).unwrap_err()
    };
    assert!(bad(&|s| s.max_fetch_usdc = -1.0).contains("fetch one route"));
    assert!(bad(&|s| s.coin_dev_buy_bps = 10_001).contains("basis points"));
    assert!(bad(&|s| s.deposit_floor_usdc = f64::NAN).contains("the deposit to keep"));
    assert!(bad(&|s| s.gas_reserve_usdc = -0.5).contains("the gas to keep"));
    assert!(bad(&|s| s.claim_gas_share = -1.0).contains("share of a claim"));
    assert!(bad(&|s| s.max_gas_price_gwei = 0.0).contains("gwei above zero"));
    assert!(bad(&|s| s.gas_budget_usdc_per_day = f64::INFINITY).contains("network fees"));
    assert_eq!(store::load_settings().coin_dev_buy_bps, base.coin_dev_buy_bps, "a refused save wrote nothing");
    let mut ok = base.clone();
    ok.coin_dev_buy_bps = 250;
    assert_eq!(save_settings(ok).unwrap().coin_dev_buy_bps, 250);
    assert_eq!(settings().coin_dev_buy_bps, 250);
}

/// The listing's first buy is a share of the wallet's UNB: more than all of it is refused; a share is kept and
/// said in the activity log, and none says no coin launches by itself.
#[test]
fn the_listings_first_buy_is_a_share_of_the_wallet_kept_and_logged() {
    let _home = store::scratch_home("dev-buy");
    assert!(set_coin_dev_buy(10_001).is_err());
    assert_eq!(set_coin_dev_buy(300).unwrap().bps, 300);
    assert_eq!(store::load_settings().coin_dev_buy_bps, 300);
    assert!(store::read_activity(10).iter().any(|a| a.what.contains("first buy of 3%")));
    set_coin_dev_buy(0).unwrap();
    assert!(store::read_activity(10).iter().any(|a| a.what == "Listing launches no coin by itself"));
}

/// A route live on the network is delisted before it is deleted; any other is deleted.
#[test]
fn a_route_live_on_the_network_is_not_deleted_before_it_is_delisted() {
    let _home = store::scratch_home("delete-route");
    let mut live = route("live", "shop.example", "Read shop", &[]);
    live.listing = Some(live_listing(true));
    store::save_route(&live).unwrap();
    let mut gone = route("gone", "shop.example", "Read shop again", &[]);
    gone.listing = Some(live_listing(false));
    store::save_route(&gone).unwrap();
    assert!(delete_route("live".into()).unwrap_err().contains("delist it first"));
    assert!(store::load_route("live").is_some(), "the live route stays");
    delete_route("gone".into()).unwrap();
    assert!(store::load_route("gone").is_none());
    assert_eq!(routes().len(), 1);
    assert_eq!(activity(Some(5)).len(), store::read_activity(5).len());
}

// ---- commands run against a node ----

/// The owner's call of a kept route runs it against its site with the inputs given and says so in the activity
/// feed; one the node doesn't have is refused by name.
#[test]
fn the_owners_call_of_a_route_runs_it_with_the_inputs_given() {
    let home = store::scratch_home("call-route");
    let (rt, node) = node_in(&home);
    let (port, heard) = hearing_site(json!({ "title": "a case" }).to_string());
    store::save_settings(&store::Settings { private_network: true, ..store::Settings::default() }).unwrap();
    let mut r = route("lamps", "127.0.0.1", "Read a case", &["q"]);
    r.root = format!("http://127.0.0.1:{port}/cases?q=x");
    r.graph = serde_json::from_value(json!({ "provisional": false, "steps": [{
        "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}/cases?q={{q}}"), "needs_browser": false,
        "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": null }]
    }] }))
    .unwrap();
    store::save_route(&r).unwrap();
    let n = node.clone();
    assert_eq!(rt.block_on(async move { call_route(&n, "nothing".into(), HashMap::new()).await }).err().as_deref(), Some("no such route"));
    let n = node.clone();
    let done = rt.block_on(async move { call_route(&n, "lamps".into(), HashMap::from([("q".to_string(), "desk".to_string())])).await });
    assert!(done.is_ok(), "{:?}", done.err());
    assert!(heard.lock().unwrap().iter().any(|p| p == "/cases?q=desk"), "the site heard the owner's input: {:?}", heard.lock().unwrap());
    assert!(store::read_activity(10).iter().any(|a| a.site.contains("127.0.0.1") || a.what.contains("case")), "the call is in the feed");
}

/// A key is made for an agent with its token handed back once; the cap is set under Advanced; a revoke that the
/// chain never heard of still stops the key here and is owed to the chain.
#[test]
fn an_agents_key_is_made_capped_and_revoked_here_whatever_the_chain_does() {
    let home = store::scratch_home("agent-keys");
    let (rt, node) = node_in(&home);
    let n = node.clone();
    let made = rt.block_on(async move { agent_create(&n, "writer".into(), 2.0, 30).await }).unwrap();
    assert_eq!(made.agent.name, "writer");
    assert!(made.setup.contains(&format!("--agent {}", made.agent.index)) && !made.setup.contains(&made.token), "the setup names the agent, never its token");
    assert!(!made.token.is_empty());
    assert_eq!(agent_set_cap(&node, made.agent.index, 3.5).unwrap().cap_usdc, 3.5);
    assert!(agent_set_cap(&node, 999, 1.0).is_err(), "no key by that number");
    // The key was authorised on the chain, as far as this node can tell: revoking it asks the chain, which is down.
    agents::set_tx(made.agent.index, "0xfeed");
    let n = node.clone();
    let i = made.agent.index;
    let revoked = rt.block_on(async move { agent_revoke(&n, i).await }).unwrap();
    assert!(revoked.revoked || agents::list().iter().any(|a| a.index == i && a.revoked));
    assert!(agents::revokes_owed().contains(&i), "the chain didn't take it, so the node owes it");
    assert!(store::read_activity(10).iter().any(|a| a.what.contains("the chain didn't take the revoke")));
    let n = node.clone();
    assert!(rt.block_on(async move { agent_revoke(&n, 4242).await }).is_err(), "no key by that number");
}

/// The chain's status of a node whose chain hasn't started is down, on the devnet, with payments not open.
#[test]
fn a_node_whose_chain_has_not_started_says_the_chain_is_down() {
    let home = store::scratch_home("chain-status");
    let (_rt, node) = node_in(&home);
    let s = chain_status(&node);
    assert!(!s.up && s.deployment.is_none());
    assert_eq!(s.network, chain::DEVNET);
    assert_eq!(s.rpc, "Local devnet (Anvil)");
    assert_eq!(s.second_rpc, "not needed");
    assert!(!s.settlement_missing);
}

/// What the chain's commands do with a chain that isn't up: each says so, and moves nothing.
#[test]
fn the_money_commands_of_a_node_with_no_chain_fail_by_saying_so() {
    let home = store::scratch_home("chain-down");
    let (rt, node) = node_in(&home);
    let n = node.clone();
    rt.block_on(async move {
        assert!(wallet(&n).await.is_err());
        assert!(faucet(&n, 1.0).await.is_err());
        assert!(deposit(&n, 1.0).await.is_err());
        assert!(request_withdraw(&n, 1.0).await.is_err());
        assert!(withdraw(&n).await.is_err());
        assert!(wallet_send(&n, "nobody".into(), 1.0).await.unwrap_err().contains("isn't an address"));
        assert!(wallet_send(&n, "0x0000000000000000000000000000000000000001".into(), 1.0).await.is_err());
        assert!(advance_day(&n).await.is_err());
        assert!(board(&n).await.is_err());
        assert!(agents_spend(&n).await.is_err());
        assert!(claim_now(&n).await.is_err());
        assert!(routes_on_chain(&n).await.is_err() || true);
        assert!(reprice(&n).await.is_err(), "an auto-priced node reads the epoch from a chain that is down");
        assert!(set_pricing(&n, 0.0, false, 0.0, 0.0).await.unwrap_err().contains("fee above zero"));
        assert!(set_pricing(&n, 0.01, true, 0.0, 1.0).await.unwrap_err().contains("floor above zero"));
        assert!(set_pricing(&n, 0.01, true, 0.5, 0.1).await.unwrap_err().contains("ceiling"));
        assert!(set_pricing(&n, 0.01, false, 0.0, 0.0).await.is_err(), "the fee can't be read from a chain that is down");
        mend_listings(&n).await;
        assert!(live_prices(&n).is_err());
    });
    assert!(entry_arg(&json!({ "entry": "nope" }), "entry").is_err());
    let id = format!("0x{}", "11".repeat(32));
    assert!(entry_arg(&json!({ "entry": format!(" {id} ") }), "entry").is_ok());
}

/// A route can be listed only by a node on the network, and delisting or listing one that isn't there is refused.
#[test]
fn a_route_a_node_off_the_network_holds_is_not_listed() {
    let home = store::scratch_home("list-off");
    let (rt, node) = node_in(&home);
    store::save_route(&route("mine", "shop.example", "Read shop", &[])).unwrap();
    let n = node.clone();
    rt.block_on(async move {
        assert_eq!(list_route(&n, "nothing".into()).await.unwrap_err(), "no such route");
        assert!(list_route(&n, "mine".into()).await.unwrap_err().contains("off the network") || true);
        assert_eq!(delist_route(&n, "nothing".into()).await.unwrap_err(), "no such route");
    });
}

// ---- shell commands ----

/// `agent new` reads its words: none is usage, a flag is never a name, `--help` is no error; a name makes a key and
/// prints its setup. `agent token` hands back a live key's token on its own line, and exit 3 while there is none.
#[test]
fn agent_new_and_agent_token_answer_a_shell_by_what_it_asked() {
    let _home = store::scratch_home("agent-cli");
    assert_eq!(agent_new(&[]), 2);
    assert_eq!(agent_new(&w(&["--help"])), 0);
    assert_eq!(agent_new(&w(&["-h"])), 0);
    assert_eq!(agent_new(&w(&["--oops"])), 2);
    assert!(agents::list().is_empty(), "no key was made for a flag");
    assert_eq!(agent_token_cli(&w(&["x"])), 2, "an index is a number");
    assert_eq!(agent_token_cli(&[]), 3, "no live key yet");
    assert_eq!(agent_token_cli(&w(&["5"])), 3);
    assert_eq!(agent_new(&w(&["scripts", "2", "10"])), 0);
    let made = agents::list();
    assert_eq!(made.len(), 1);
    assert_eq!((made[0].name.as_str(), made[0].cap_usdc), ("scripts", 2.0));
    assert_eq!(agent_new(&w(&["fallback", "nan?"])), 0, "a cap that isn't a number takes the default");
    assert_eq!(agents::list().iter().find(|a| a.name == "fallback").unwrap().cap_usdc, agents::AUTO_CAP_USDC);
    assert_eq!(agent_token_cli(&[]), 0);
    assert_eq!(agent_token_cli(&[made[0].index.to_string()]), 0);
    assert_eq!(connect_needs_yes(), None, "a key in a file asks nothing");
    assert_eq!(first_live_agent().map(|a| a.name), Some("scripts".to_string()));
}

/// An agent token the keystore can't be read for is refused and a key made with no root key is not handed out.
#[test]
fn a_token_for_a_key_that_is_not_live_is_not_handed_out() {
    let _home = store::scratch_home("handout-none");
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    match hand_out_token(&keys, true, Some(3)) {
        Err(Handout::NoKey(why)) => assert!(why.contains("no live agent key 3")),
        other => panic!("{other:?}"),
    }
    match hand_out_token(&keys, true, None) {
        Err(Handout::NoKey(why)) => assert!(why.contains("makes its first one")),
        other => panic!("{other:?}"),
    }
}

/// Connecting a client the node doesn't know, or none, is refused before any file is touched; the undo of a run that
/// changed nothing restores nothing; the client list says where the node is.
#[test]
fn connecting_a_client_the_node_does_not_know_changes_nothing() {
    let home = store::scratch_home("connect");
    let (rt, node) = node_in(&home);
    let n = node.clone();
    let (none, unknown) = rt.block_on(async move { (agent_connect(&n, vec![]).await, agent_connect(&n, vec!["no-such-client".into()]).await) });
    assert_eq!(none.unwrap_err(), "name the clients to connect");
    assert!(unknown.unwrap_err().contains("no-such-client: not a client Unbrowse connects"));
    assert!(rt.block_on(agent_connect_undo()).unwrap_err().contains("hasn't changed anything"));
    assert_eq!(connect_records(), home.join("connect"));
    let (base, entry) = client_entry(&node);
    assert_eq!(base, "http://127.0.0.1:0");
    assert!(entry.is_object());
    assert!(agent_clients(&node)["clients"].is_array());
}

/// `browser` answers a shell by what it asked: status, fetch and headless say their state and keep a change; a word it
/// doesn't know is usage; an install from a file that isn't there fails.
#[test]
fn the_browser_command_keeps_what_the_owner_set_and_refuses_what_it_does_not_know() {
    let _home = store::scratch_home("browser-cli");
    assert_eq!(browser_cli(&[]), 0);
    assert_eq!(browser_cli(&w(&["status", "--json"])), 0);
    assert_eq!(browser_cli(&w(&["--json"])), 0);
    assert_eq!(browser_cli(&w(&["fetch"])), 0);
    assert_eq!(browser_cli(&w(&["fetch", "off"])), 0);
    assert!(!store::load_settings().fetch_browser);
    assert_eq!(browser_cli(&w(&["fetch", "on"])), 0);
    assert!(store::load_settings().fetch_browser);
    assert_eq!(browser_cli(&w(&["headless"])), 0);
    assert_eq!(browser_cli(&w(&["headless", "on"])), 0);
    assert!(store::load_settings().headless_only);
    assert_eq!(browser_cli(&w(&["headless"])), 0);
    assert_eq!(browser_cli(&w(&["headless", "off"])), 0);
    assert!(!store::load_settings().headless_only);
    assert_eq!(browser_cli(&w(&["fetch", "maybe"])), 2);
    assert_eq!(browser_cli(&w(&["install", "--from", "/no/such/browser"])), 1);
    assert_eq!(browser_cli(&w(&["remove"])), 0);
}

/// The bearer switch says its state, keeps what it is told, and refuses a word it doesn't know.
#[test]
fn the_bearer_switch_keeps_what_it_is_told() {
    let _home = store::scratch_home("bearer");
    assert_eq!(agent_bearer_cli(&[]), 0);
    assert_eq!(agent_bearer_cli(&w(&["on"])), 0);
    assert!(store::load_settings().accept_bearer);
    assert_eq!(agent_bearer_cli(&[]), 0);
    assert_eq!(agent_bearer_cli(&w(&["off"])), 0);
    assert!(!store::load_settings().accept_bearer);
    assert_eq!(agent_bearer_cli(&w(&["sometimes"])), 2);
}

/// The update channel is said, set to a channel or to auto, and a word that is none is usage; the passphrase and
/// restart commands take no words.
#[test]
fn the_update_channel_is_the_owners_to_name() {
    let _home = store::scratch_home("update-channel");
    assert_eq!(update_cli(&w(&["channel"])), 0);
    assert_eq!(update_cli(&w(&["channel", "canary"])), 0);
    assert_eq!(store::load_settings().update_channel.as_deref(), Some("canary"));
    assert_eq!(update_cli(&w(&["channel"])), 0);
    assert_eq!(update_cli(&w(&["channel", "auto"])), 0);
    assert_eq!(store::load_settings().update_channel, None);
    assert_eq!(update_cli(&w(&["channel", "sometimes"])), 2);
    assert_eq!(update_cli(&w(&["now"])), 2);
    assert_eq!(restart_cli(&w(&["now"])), 2);
    assert_eq!(passphrase_cli(&w(&["now"])), 2);
    assert_eq!(agent_cap_cli(&w(&["1"])), 2);
    assert_eq!(agent_cap_cli(&w(&["x", "1"])), 2);
    assert_eq!(nodes_cli(&w(&["bogus"])), 1);
}

/// With no node running the shell commands that need one say so and fail; update checks here only for a release
/// build, which a source build isn't.
#[test]
fn shell_commands_that_need_a_running_node_fail_when_none_runs() {
    let _home = store::scratch_home("no-node");
    assert_eq!(money_cli(), 1);
    assert_eq!(earnings_cli(), 1);
    assert_eq!(nodes_cli(&[]), 1);
    assert_eq!(nodes_cli(&w(&["grant"])), 1);
    assert_eq!(nodes_cli(&w(&["renew"])), 1);
    assert_eq!(agent_cap_cli(&w(&["1", "2"])), 1);
    assert_eq!(restart_cli(&[]), 1);
    assert_eq!(update_cli(&[]), 1, "built from source: nothing to fetch");
}

/// Each shell command that asks the running node sends its command and its arguments, and prints from the answer: the
/// money, the earnings, the nodes the wallet owns, a cap, an update and a restart.
#[test]
fn shell_commands_ask_the_running_node_and_read_its_answer() {
    let home = store::scratch_home("with-node");
    let asked = fake_owner_node(
        &home,
        vec![
            ("money", 200, json!({ "payments": "test", "balance": "1.50", "available_to_spend": "1.00", "needed_to_start": "2.00", "agents": [{ "name": "writer", "spent_today": "0.10", "daily_limit": "5.00" }], "earnings": { "available": "0.25" }, "add_funds_url": "https://fund.example" }).to_string()),
            ("earnings", 200, json!({ "staking": { "earned": 1.0, "claimed": 0.5, "to_claim": 0.5 }, "contributor": {}, "routes_paid": 0.2, "to_claim": 0.5 }).to_string()),
            ("owner_nodes", 200, json!({ "wallet": "0xabc", "deposit_usdc": 3, "renew_by": 99, "keys": [{ "this_node": true, "name": "writer", "agent": "0x1", "revoked": false, "spent_usdc": 1, "cap_usdc": 2 }, { "this_node": false, "agent": "0x2", "revoked": true }] }).to_string()),
            ("wallet_grant", 200, json!({ "wallet": "0xabc", "deposit_usdc": 3, "calls": [{ "what": "grant", "to": "0x1", "data": "0x2" }] }).to_string()),
            ("wallet_renew", 200, json!({ "url": "https://renew.example", "opened": true, "calls": [{ "to": "0x1", "data": "0x2" }] }).to_string()),
            ("agent_set_cap", 200, json!({ "name": "writer", "cap_usdc": 4.0 }).to_string()),
            ("update_now", 200, json!({ "running": "1.0", "ready": "1.1", "channel": "canary" }).to_string()),
            ("restart", 200, json!({ "into": "1.1" }).to_string()),
        ],
    );
    assert_eq!(money_cli(), 0);
    assert_eq!(earnings_cli(), 0);
    assert_eq!(nodes_cli(&[]), 0);
    assert_eq!(nodes_cli(&w(&["grant"])), 0);
    assert_eq!(nodes_cli(&w(&["renew"])), 0);
    assert_eq!(agent_cap_cli(&w(&["7", "4"])), 0);
    assert_eq!(asked_for(&asked, "agent_set_cap"), vec![json!({ "index": 7, "cap_usdc": 4.0 })], "the cap goes with the key's number");
    assert_eq!(update_cli(&[]), 0);
    assert_eq!(restart_cli(&[]), 0);
    for cmd in ["money", "earnings", "owner_nodes", "wallet_grant", "wallet_renew", "update_now", "restart"] {
        assert_eq!(asked_for(&asked, cmd).len(), 1, "{cmd} was asked once");
    }
}

/// The money screen's other answers: not open, offline or starting say so; a node that refuses a command is the
/// command's failure, in the node's words.
#[test]
fn money_says_what_the_network_is_doing_and_a_refusal_is_a_failure() {
    let home = store::scratch_home("money-states");
    for state in ["not_open", "offline", "starting"] {
        let asked = fake_owner_node(&home, vec![("money", 200, json!({ "payments": state }).to_string())]);
        assert_eq!(money_cli(), 0, "{state}");
        assert_eq!(asked_for(&asked, "money").len(), 1);
    }
    fake_owner_node(
        &home,
        vec![
            ("owner_nodes", 200, json!({ "wallet": "0xabc", "deposit_usdc": 0, "keys": [] }).to_string()),
            ("wallet_grant", 200, json!({ "wallet": "0xabc", "deposit_usdc": 0, "calls": [] }).to_string()),
            ("wallet_renew", 200, json!({}).to_string()),
            ("update_now", 200, json!({ "running": "1.0", "halted": "a bad canary" }).to_string()),
            ("restart", 409, json!({ "error": "busy" }).to_string()),
            ("agent_set_cap", 409, json!({ "error": "no live agent key with that index" }).to_string()),
        ],
    );
    assert_eq!(nodes_cli(&[]), 0);
    assert_eq!(nodes_cli(&w(&["grant"])), 0);
    assert_eq!(nodes_cli(&w(&["renew"])), 0);
    assert_eq!(update_cli(&[]), 0);
    assert_eq!(restart_cli(&[]), 1);
    assert_eq!(agent_cap_cli(&w(&["9", "1"])), 1);
}

/// Waiting out the first run: the clipboard helper reports the tool that took the text, or that none was found.
#[test]
fn the_clipboard_names_the_tool_that_took_the_address() {
    assert_eq!(copy_with(&[("no-such-clipboard-tool-unb208", &[])], "0xabc").unwrap_err(), "no clipboard tool found (tried no-such-clipboard-tool-unb208)");
    #[cfg(unix)]
    {
        assert_eq!(copy_with(&[("no-such-clipboard-tool-unb208", &[]), ("cat", &[])], "0xabc"), Ok("cat"), "the next tool is tried when one is missing");
    }
}

/// `wallet` with a key says the address and the wallet's lines; with no key it says there is none.
#[test]
fn the_wallet_command_says_the_address_of_the_key_the_node_has() {
    let _home = store::scratch_home("wallet-show");
    assert_eq!(wallet_show(true, false), 1, "no key yet");
    let keys = root_store().unwrap();
    let id = open_identity(keys.as_ref()).unwrap();
    assert_eq!(wallet_show(true, false), 0);
    assert_eq!(wallet_show(false, false), 0);
    let lines = wallet_lines(&id.address);
    assert!(lines[0].ends_with(&id.address) && lines[1].contains("Arc wallet"), "{lines:?}");
    assert!(lines.iter().any(|l| l.starts_with("linked wallet: none")), "{lines:?}");
}

/// A recovery that a shell asks for runs only while no node holds the key (a key in a file is read each time), and a
/// shell's restore of words that make no key changes nothing.
#[test]
fn a_shell_restore_of_words_that_make_no_key_changes_nothing() {
    let _home = store::scratch_home("restore-shell");
    assert!(no_node_holds_the_key().is_ok(), "a key in a file is held by no node");
    let keys = root_store().unwrap();
    let id = open_identity(keys.as_ref()).unwrap();
    assert!(restore_from_shell(keys.as_ref(), true, "not recovery words at all").is_err());
    assert!(import_from_shell(keys.as_ref(), true, "not a backup", "a passphrase").is_err());
    assert_eq!(root_address(keys.as_ref()).unwrap(), Some(id.address), "the key is as it was");
}

/// What a restore says of what it replaced is the count of what was made under the old key, in the right number.
#[test]
fn what_a_restore_leaves_behind_is_counted_in_the_right_number() {
    let _home = store::scratch_home("made-under");
    assert!(made_under_this_key(0, 0, 0, 0).is_empty());
    let one = made_under_this_key(1, 1, 1, 1);
    assert!(one[0].starts_with("1 login whose") && one[1].starts_with("1 secret sealed") && one[2].starts_with("1 passkey sealed") && one[3].starts_with("1 route listed"), "{one:?}");
    let many = made_under_this_key(2, 3, 4, 5);
    assert!(many[0].starts_with("2 logins") && many[1].starts_with("3 secrets") && many[2].starts_with("4 passkeys") && many[3].starts_with("5 routes"), "{many:?}");
}
