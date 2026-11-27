use super::*;

fn scratch_node(home: &std::path::Path) -> (tokio::runtime::Runtime, Arc<Node>) {
    let h = home.to_path_buf();
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
    let keys = unbrowse_core::MemoryStore::default();
    let id = unbrowse_core::load_or_create(&keys).unwrap();
    let node = Arc::new(Node {
        keys: Box::new(keys),
        identity: std::sync::RwLock::new(Some(Ok(IdentityView { address: id.address.to_checksum(), created: true }))),
        info: NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
        walks: learn::Walks::default(),
        chain: chain::Chain::default(),
        chain_error: std::sync::Mutex::new(None),
        events: api::Events::default(),
        net: std::sync::OnceLock::new(),
        share: share::Share::default(),
    });
    (rt, node)
}

fn run(rt: &tokio::runtime::Runtime, node: &Arc<Node>, cmd: &str, a: Value) -> Result<Value, String> {
    match rt.block_on(owner(node, cmd, a)) {
        Ok(v) => Ok(v),
        Err(OwnerError::Failed(m)) => Err(m),
        Err(OwnerError::Unknown) => panic!("{cmd} is unknown"),
    }
}

/// A node whose chain is not up says so for every command that reads or writes it, and does nothing: no wallet is
/// answered, no money moves.
#[test]
fn a_node_whose_chain_is_not_up_says_so_to_every_command_that_needs_it() {
    let home = store::scratch_home("cov-chain-down");
    let (rt, node) = scratch_node(&home);
    for cmd in ["wallet", "withdraw", "collect_earnings", "advance_day", "agents_spend", "claim_now", "board", "entries", "coin_fetch_delay"] {
        let said = run(&rt, &node, cmd, json!({})).expect_err(cmd);
        assert!(said.contains("chain is still starting"), "{cmd}: {said}");
    }
    let set = run(&rt, &node, "coin_fetch_delay", json!({ "delay": 60 })).expect_err("setting the delay needs the chain");
    assert!(set.contains("chain is still starting"), "{set}");
    let entries = run(&rt, &node, "entries", json!({ "site": "shop.example" })).expect_err("entries of a site need the chain");
    assert!(entries.contains("chain is still starting"), "{entries}");
}

/// What a node with no chain and no link answers, without failing: no routes on the chain, no listings to sign, no
/// wallet grant, no funds to add, and nothing to undo.
#[test]
fn a_node_with_no_chain_and_no_link_answers_the_chain_commands_with_nothing() {
    let home = store::scratch_home("cov-no-link");
    let (rt, node) = scratch_node(&home);
    assert_eq!(run(&rt, &node, "routes_on_chain", json!({})).unwrap(), json!([]));
    assert_eq!(run(&rt, &node, "listings_to_sign", json!({})).unwrap(), json!([]));
    let grant = run(&rt, &node, "wallet_grant", json!({})).expect_err("no linked wallet");
    assert!(grant.contains("no linked wallet"), "{grant}");
    let funds = run(&rt, &node, "add_funds", json!({})).expect_err("nothing to add funds to");
    assert!(funds.contains("payments aren't open"), "{funds}");
    let undo = run(&rt, &node, "agent_connect_undo", json!({})).expect_err("nothing to undo");
    assert!(undo.contains("hasn't changed anything to undo"), "{undo}");
}

/// Signing in starts at the website's link page naming this node, and a node with nothing listed has nothing for the
/// owner's wallet to sign; unlinking a node that was never linked answers without error.
#[test]
fn starting_a_link_names_this_node_and_signing_no_listings_asks_for_none() {
    let _sign_in = link::SIGN_IN_TESTS.blocking_lock();
    let home = store::scratch_home("cov-link-start");
    let (rt, node) = scratch_node(&home);
    let started = run(&rt, &node, "link_start", json!({})).unwrap();
    let url = started["url"].as_str().expect("a link page");
    let address = node.key().map(|k| unbrowse_core::load_or_create(k).unwrap().address.to_string().to_lowercase()).unwrap();
    assert!(url.contains("/link/#node=") && url.to_lowercase().contains(&address), "{url}");
    let signed = run(&rt, &node, "listings_sign", json!({})).unwrap();
    assert_eq!(signed["asked"], json!(0), "{signed}");
    assert_eq!(run(&rt, &node, "unlink", json!({})).unwrap(), json!({}));
}

/// A bounty stays open for some days above zero: none, a negative number or a number that isn't one is refused
/// before anything is sent.
#[test]
fn a_bounty_open_for_no_days_is_refused_before_anything_is_posted() {
    let home = store::scratch_home("cov-bounty-days");
    let (rt, node) = scratch_node(&home);
    for days in [json!(0), json!(-3.5)] {
        let said = run(&rt, &node, "bounty_post", json!({ "site": "shop.example", "amount": 1.0, "days": days })).expect_err("days");
        assert!(said.starts_with("days: "), "{said}");
    }
    let open = run(&rt, &node, "bounty_post", json!({ "site": "shop.example", "amount": 1.0 })).expect_err("the chain is not up");
    assert!(!open.starts_with("days: "), "{open}");
}

/// Settings that move the node toward canary releases, and no further than they were, are a loosening the owner is
/// asked about only when they raise it.
#[test]
fn moving_to_canary_releases_is_a_loosening_the_owner_is_asked_about() {
    let _home = store::scratch_home("cov-canary");
    let raised = raised_limits(&json!({ "update_channel": "canary" })).expect("canary is a loosening");
    assert!(raised.contains("canary"), "{raised}");
    assert_eq!(raised_limits(&json!({ "update_channel": "stable" })), None);
}
