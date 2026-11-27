//! Every file the node writes (`unbrowse_files::ALL`), read from the oldest form a node ever wrote it in, written back
//! carrying its version, and refused, untouched, when a newer node wrote it.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use unbrowse_files::Format;

use crate::store;

/// What a check reads a file as, and what it must find in it.
struct Check {
    format: &'static Format,
    /// Where the file is in a scratch home.
    at: &'static str,
    /// Reads the fixture as the node does, writes it back, and reads it again: what it read each time, as JSON.
    round: fn(&Path, &Format) -> Result<Value, String>,
    found: fn(&Value) -> bool,
}

/// Reads `path` as `T` in `format`, writes it back the way the node writes, and reads it again.
fn round<T: Serialize + DeserializeOwned>(path: &Path, format: &Format) -> Result<Value, String> {
    let first: T = format.read_at(path).map_err(|r| r.message(path))?.ok_or("no file")?;
    store::write_json(path, format, &first)?;
    let again: T = format.read_at(path).map_err(|r| r.message(path))?.ok_or("no file")?;
    let (a, b) = (serde_json::to_value(&first).unwrap(), serde_json::to_value(&again).unwrap());
    if a != b {
        return Err(format!("read back as {b}, not {a}"));
    }
    Ok(a)
}

fn checks() -> Vec<Check> {
    use std::collections::BTreeMap;
    use unbrowse_files as f;
    vec![
        // The old switch reads as a mode, and settings nothing reads any more are left out.
        Check { format: &f::SETTINGS, at: "settings.json", round: round::<store::Settings>, found: |v| v["paused"] == true && v["share_routes"] == "off" && v["api_port"] == 7790 && v.get("auto_buy").is_none() },
        Check { format: &f::ROUTE, at: "routes/route-items.json", round: round::<store::Route>, found: |v| v["id"] == "route-items" && v["stats"]["calls"] == 3 && v["graph"]["steps"][0]["status"] == 200 },
        Check { format: &f::MADE, at: "made-line.json", round: round::<crate::run::CallMade>, found: |v| v["rung"] == 3 && v["steps"][1] == 3 && v["browser"] == false },
        Check { format: &f::ACTIVITY, at: "activity-line.json", round: round::<store::Activity>, found: |v| v["what"] == "Called Search items" && v["ms"] == 120 },
        Check { format: &f::PRICING, at: "pricing.json", round: round::<store::Pricing>, found: |v| v["auto"] == false && v["lines"] == 7 },
        Check { format: &f::HELD, at: "held.json", round: round::<Vec<store::HeldRoute>>, found: |v| v[0]["site"] == "shop.example" && v[0]["fee"] == 0.02 },
        // A threshold keys no longer carry is read past.
        Check { format: &f::AGENTS, at: "agents.json", round: round::<Vec<crate::agents::Agent>>, found: |v| v[0]["index"] == 1 && v[0]["cap_usdc"] == 5.0 && v[0]["cap_unb"] == 5.0 && v[0].get("approval_usd").is_none() },
        Check { format: &f::VAULT, at: "vault.json", round: round::<Vec<crate::vault::Login>>, found: |v| v[0]["account"] == "me" && v[0]["code"] == false },
        Check { format: &f::VAULT_SEALED, at: "vault.sealed.json", round: round::<BTreeMap<String, String>>, found: |v| v["password|shop.example|me"] == "c2VhbGVk" && v.get("v").is_some() },
        Check { format: &f::CARDS, at: "cards.json", round: round::<Vec<crate::vault::CardInfo>>, found: |v| v[0]["last4"] == "4242" },
        Check { format: &f::PASSKEYS, at: "passkeys.json", round: round::<Vec<crate::passkey::Passkey>>, found: |v| v[0]["id"] == "0123456789ab" && v[0]["how"] == "manual" },
        Check { format: &f::TELEMETRY, at: "telemetry.json", round: round::<crate::telemetry::Saved>, found: |v| v["on"] == false },
        Check { format: &f::FROM, at: "from.json", round: round::<crate::telemetry::FromTag>, found: |v| v["from"] == "hn-c" },
        Check { format: &f::LINK, at: "owner.json", round: round::<crate::link::Link>, found: |v| v["nonce"] == "n-1" },
        Check { format: &f::JOINED, at: "joined.json", round: round::<crate::link::Joined>, found: |v| v["since"] == 1_700_000_000 },
        Check { format: &f::BROWSER, at: "browser.json", round: round::<crate::browsers::Choice>, found: |v| v["path"].as_str().is_some_and(|p| p.ends_with("Chromium")) },
        Check { format: &f::REPORTS, at: "reports.json", round: round::<crate::report::Saved>, found: |v| v["on"] == false },
        Check { format: &f::REPORTS_STATE, at: "reports-state.json", round: round::<crate::report::State>, found: |v| v["agent"] == 2 && v["sent"]["a-problem"]["day"] == 19699 },
        Check { format: &f::REPORTS_QUEUE, at: "reports-queue.json", round: round::<Vec<crate::report::Queued>>, found: |v| v[0]["report"]["what"] == "a call failed" },
        Check { format: &f::REPORTS_WAITING, at: "reports-waiting.json", round: round::<Vec<crate::report::Waiting>>, found: |v| v[0]["report"]["what"] == "a call failed" && v[0]["scrubbed"]["email"] == 1 },
        Check { format: &f::SHARED_SESSIONS, at: "shared-sessions.json", round: round::<BTreeMap<String, String>>, found: |v| v["9f2c"] == "shop.example" },
        Check { format: &f::AUTOLIST, at: "autolist.json", round: round::<crate::autolist::Today>, found: |v| v["listed"] == 3 },
        Check { format: &f::LISTINGS, at: "listings-31337-0x3333333333333333333333333333333333333333.json", round: round::<crate::listing::Book>, found: |v| v["listings"][0]["listing"]["route_id"] == "route-items" && v["roots"][0]["block"] == 12 },
        Check { format: &f::KNOWN_LISTINGS, at: "known-listings-31337-0x3333333333333333333333333333333333333333.json", round: round::<std::collections::BTreeMap<String, crate::listing::Proven>>, found: |v| v.as_object().is_some_and(|m| m.is_empty()) },
        Check { format: &f::RESERVE_ROOTS, at: "reserve-roots-31337-0x3333333333333333333333333333333333333333.json", round: round::<crate::reserve::Book>, found: |v| v["last"] == 12 },
        Check { format: &f::RENEW_TOLD, at: "renew-told.json", round: round::<u64>, found: |v| v == 20800 },
        Check { format: &f::TRUST, at: "trust.json", round: round::<crate::update::Kept>, found: |v| v["root"] == "7b7d" && v["targets"].is_null() },
        Check { format: &f::KEPT_MANIFEST, at: "kept-manifest.json", round: round::<crate::update::KeptManifest>, found: |v| v["manifest"] == "7b7d" },
        Check { format: &f::DEVNET_NETWORK, at: "devnet/network.json", round: round::<crate::chain::DevnetNetwork>, found: |v| v["fork"] == "arc-testnet" },
        // Fields a deployment gained later read as their defaults.
        Check { format: &f::DEPLOYMENT, at: "devnet/deployment.json", round: round::<crate::chain::Deployment>, found: |v| v["chain_id"] == 31337 && v["usdc_decimals"] == 18 },
        Check { format: &f::NETWORK, at: "networks/arc-testnet.json", round: round::<crate::chain::NetworkFile>, found: |v| v["registry_from"] == 7 && v["deployment"].is_null() },
        Check { format: &f::DEPLOYING, at: "networks/arc-testnet.deploying.json", round: round::<crate::chain::Progress>, found: |v| v["seeded"] == true && v["usdc"] == "0x00000000000000000000000000000000000000a1" && v["stakes"].is_null() },
        Check { format: &f::RECEIPTS, at: "devnet/receipts/1-3.json", round: round::<Vec<crate::chain::Receipt>>, found: |v| v[0]["amount"] == 0.4 && v[0]["entry"].is_null() },
        Check { format: &f::REFUSED_PAYERS, at: "devnet/refused-payers.json", round: round::<BTreeMap<String, crate::network::Refused>>, found: |v| v["0x00000000000000000000000000000000000000aa"]["until"] == 40 },
        Check { format: &f::SPENT_VOUCHERS, at: "devnet/spent-vouchers.json", round: round::<Vec<crate::network::Spent>>, found: |v| v[0]["epoch"] == 3 },
        Check { format: &f::SERVED, at: "devnet/served.json", round: round::<Vec<crate::network::Served>>, found: |v| v[0]["epoch"] == 3 },
        Check { format: &f::OWED, at: "devnet/owed.json", round: round::<Vec<crate::chain::PaidLine>>, found: |v| v[0]["epoch"] == 3 && v[0]["holders"].as_array().is_some_and(|h| h.len() == 1) },
        Check { format: &f::PAID_OUT, at: "devnet/paid-out.json", round: round::<crate::chain::PaidOut>, found: |v| v["usdc"] == "0x4c4b40" },
        Check { format: &f::HEADER_CHAIN, at: "devnet/headers.json", round: round::<crate::anchor::Anchored>, found: |v| v["chain_id"] == 1337 },
        Check { format: &f::EPOCH_FLOOR, at: "devnet/epoch-floor.json", round: round::<crate::chain::EpochFloor>, found: |v| v["epoch"] == 7 },
        Check { format: &f::UNWITNESSED, at: "devnet/unwitnessed.json", round: round::<Vec<crate::chain::PaidLine>>, found: |v| v[0]["epoch"] == 3 },
        Check { format: &f::TOWER_GAS, at: "devnet/tower-gas.json", round: round::<crate::watchtower::TowerGas>, found: |v| v["epoch"] == 5 },
        Check { format: &f::ALLOWANCE_RESETS, at: "devnet/allowance-resets.json", round: round::<Vec<crate::chain::PendingReset>>, found: |v| v[0]["at"] == 1 },
        Check { format: &f::COIN_FIRST_BUYS, at: "devnet/coin-first-buys.json", round: round::<Vec<crate::chain::coins::FirstBuy>>, found: |v| v[0]["bps"] == 100 && v[0]["stake_tx"].is_null() },
        Check { format: &f::GAS_SPENT, at: "devnet/gas-spent.json", round: round::<crate::rpc::GasSpent>, found: |v| v["day"] == 20402 && v["spent"] == "0x0" },
        Check { format: &f::SENDING, at: "devnet/sending.json", round: round::<Vec<crate::inflight::Sending>>, found: |v| v[0]["key"] == "deposit" && v[0]["nonce"] == 7 && v[0]["book"].is_null() },
        Check { format: &f::BOUNTY_AUTO, at: "devnet/bounty-auto-0x00000000000000000000000000000000000000cc.json", round: round::<crate::autobounty::Memory>, found: |v| v["said"].as_object().is_some_and(|m| m.is_empty()) && v["approved"].as_array().is_some_and(|a| a.is_empty()) },
        Check { format: &f::WATCHING, at: "devnet/watching.json", round: round::<Vec<crate::chain::PaidLine>>, found: |v| v[0]["passed"] == true },
        Check { format: &f::HANDED, at: "devnet/handed.json", round: round::<Vec<crate::watchtower::Mark>>, found: |v| v[0][0] == 1 && v[0][1] == 3 },
        Check { format: &f::ERC8004, at: "erc8004-0x2222222222222222222222222222222222222222.json", round: round::<crate::erc8004::Registration>, found: |v| v["agent_id"] == "7" },
        Check { format: &f::PEER_KEY, at: "peer-key.json", round: round::<crate::peers::PeerKey>, found: |v| v["bits"] == 8 },
        Check { format: &f::REMOTE, at: "remote.json", round: round::<crate::remote::Remote>, found: |v| v["gateway"] == "https://unbrowse.ai" && v["on"] == true },
        Check { format: &f::HEARD, at: "heard.json", round: round::<crate::heard::Heard>, found: |v| v["apps"][0]["name"] == "claude-code" && v["apps"][0]["web"] == false },
        Check { format: &f::PEER_PORT, at: "peer-port.json", round: round::<crate::peers::PeerPort>, found: |v| v["port"] == 47123 },
        Check { format: &f::PEER_PUBLISHED, at: "peer-published.json", round: round::<crate::peers::Published>, found: |v| v["addrs"][0] == "/ip4/127.0.0.1/tcp/47123" },
        // The peer table and the set-aside providers are the network crate's: their own tests read them there
        // (`crates/net`); here they read as the JSON they hold.
        Check { format: &f::PEER_TABLE, at: "peer-table.json", round: round::<Vec<Value>>, found: |v| v[0]["addrs"][0] == "/ip4/127.0.0.1/tcp/47123" },
        Check { format: &f::SET_ASIDE, at: "set-aside.json", round: round::<Vec<Value>>, found: |v| v[0]["until"] == 9 },
        Check { format: &f::LEAKS, at: "leaks/leaks.json", round: round::<crate::leak::Leaks>, found: |v| v["findings"][0]["pattern"] == 5 && v["taken_down"][0].as_str().is_some_and(|c| c.starts_with("sha256:cd")) },
        Check { format: &f::DARK_ENTRIES, at: "dark-entries.json", round: round::<Vec<crate::share::KeptDark>>, found: |v| v[0]["count"] == 2 },
        Check { format: &f::DEMOTED, at: "demoted.json", round: round::<Vec<crate::rank::reputation::KeptDemotion>>, found: |v| v[0]["at"] == 1762400000 },
        Check { format: &f::WITHDRAWN, at: "withdrawn.json", round: round::<Vec<crate::share::KeptWithdrawal>>, found: |v| v[0]["version"] == 2 },
        Check { format: &f::NODE_AD, at: "network/0x1111111111111111111111111111111111111111.json", round: round::<crate::network::NodeAd>, found: |v| v["name"] == "a-node" && v["peer_id"] == "" },
        // A cookie named `v` is a cookie, never the version.
        Check { format: &f::SETUPS, at: "setups/shop.example.json", round: round::<Vec<unbrowse_learn::setup::Setup>>, found: |v| v[0]["asks"] == "Choose your country" && v[0]["steps"][0]["at"] == "#us" },
        Check { format: &f::JAR, at: "jars/shop.example.json", round: round::<BTreeMap<String, String>>, found: |v| v["sid"] == "s-123" && v["v"] == "a cookie named v" },
        // The doors a node has met, by site: the wall's class, the statuses it answers, the credential it issues.
        Check { format: &f::DOORS, at: "doors.json", round: round::<BTreeMap<String, unbrowse_learn::graph::Door>>, found: |v| v["www.shop.example"]["credential"] == "cf_clearance" && v["www.shop.example"]["earn"] == "browser" },
    ]
}

fn put(home: &Path, at: &str, bytes: &[u8]) -> PathBuf {
    let path = home.join(at);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, bytes).unwrap();
    path
}

/// The same file as a newer node would have written it: one version past this build's.
fn newer(format: &Format, bytes: &[u8]) -> Vec<u8> {
    let contents = format.decode(bytes).unwrap();
    let mut file = format.encode(&contents).unwrap();
    file["v"] = Value::from(format.version() + 1);
    serde_json::to_vec(&file).unwrap()
}

/// Every file the node writes has a check here, and each reads from its oldest form, is written back carrying its
/// version, and reads the same again.
#[test]
fn every_file_reads_from_its_oldest_form_and_is_written_back_with_its_version() {
    let home = store::scratch_home("formats");
    let checks = checks();
    for format in unbrowse_files::ALL {
        assert!(checks.iter().any(|c| c.format.name == format.name), "{} has no check", format.name);
    }
    for c in &checks {
        let old = std::fs::read(unbrowse_files::fixture(c.format)).unwrap();
        let path = put(&home, c.at, &old);
        let read = (c.round)(&path, c.format).unwrap_or_else(|e| panic!("{}: {e}", c.format.name));
        assert!((c.found)(&read), "{} read as {read}", c.format.name);
        let file: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file["v"], c.format.version(), "{} is written with its version", c.format.name);
        // What it was before is kept beside it, for the owner to put back under a build from before.
        let (was, _) = c.format.split(serde_json::from_slice(&old).unwrap()).unwrap();
        let copy = unbrowse_files::kept_original(&path, was);
        if was < c.format.version() {
            assert_eq!(std::fs::read(&copy).unwrap(), old, "{} keeps its old bytes", c.format.name);
        } else {
            assert!(!copy.exists(), "{} was at this version: nothing to keep", c.format.name);
        }
    }
}

/// A file a newer node wrote is refused, saying so, and the node never writes over it.
#[test]
fn a_file_a_newer_node_wrote_is_refused_and_never_written_over() {
    let home = store::scratch_home("formats-newer");
    for c in checks() {
        let bytes = newer(c.format, &std::fs::read(unbrowse_files::fixture(c.format)).unwrap());
        let path = put(&home, c.at, &bytes);
        let e = (c.round)(&path, c.format).unwrap_err();
        assert!(e.contains("newer Unbrowse node") && e.contains(&format!("version {}", c.format.version() + 1)), "{}: {e}", c.format.name);
        assert!(store::write_json(&path, c.format, &serde_json::json!({})).unwrap_err().contains("never written over"), "{}", c.format.name);
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{} is left as it was", c.format.name);
        let kept = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".json.v")).count();
        assert_eq!(kept, 0, "{}: a newer file is only left alone, never copied", c.format.name);
    }
}

/// The node's own readers, on old files and newer ones: settings, agents, routes, the activity log and receipts.
#[test]
fn the_nodes_readers_take_old_files_and_refuse_newer_ones() {
    use unbrowse_files as f;
    let home = store::scratch_home("formats-readers");
    let fixture = |format: &Format| std::fs::read(unbrowse_files::fixture(format)).unwrap();

    put(&home, "settings.json", &fixture(&f::SETTINGS));
    assert!(store::settings_readable().is_ok());
    let s = store::load_settings();
    assert!(s.paused && s.share_routes == store::ShareMode::Off && s.excluded == ["bank.example"]);
    store::save_settings(&s).unwrap();
    put(&home, "settings.json", &newer(&f::SETTINGS, &fixture(&f::SETTINGS)));
    assert!(store::settings_readable().unwrap_err().contains("newer Unbrowse node"), "the node won't start on it");
    assert!(store::save_settings(&store::Settings::default()).is_err());

    put(&home, "agents.json", &fixture(&f::AGENTS));
    assert_eq!(crate::agents::list().len(), 1);
    assert_eq!(std::fs::read(home.join("agents.json.v0")).unwrap(), fixture(&f::AGENTS), "the agents as they were are kept");

    // The vault's index read by the node keeps its old bytes, 0600 like the index; a build from before that writes
    // an empty list over the index leaves the copy as it was.
    put(&home, "vault.json", &fixture(&f::VAULT));
    #[cfg(unix)]
    std::fs::set_permissions(home.join("vault.json"), std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    assert_eq!(crate::vault::list().len(), 1);
    std::fs::write(home.join("vault.json"), b"[]").unwrap();
    assert!(crate::vault::list().is_empty());
    assert_eq!(std::fs::read(home.join("vault.json.v0")).unwrap(), fixture(&f::VAULT));
    #[cfg(unix)]
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(home.join("vault.json.v0")).unwrap().permissions()) & 0o777, 0o600);
    put(&home, "agents.json", &newer(&f::AGENTS, &fixture(&f::AGENTS)));
    assert!(crate::agents::list().is_empty(), "lets no one in");

    put(&home, "routes/route-items.json", &fixture(&f::ROUTE));
    assert_eq!(store::load_route("route-items").map(|r| r.stats.calls), Some(3));
    let newer_route = newer(&f::ROUTE, &fixture(&f::ROUTE));
    put(&home, "routes/route-items.json", &newer_route);
    assert!(store::load_route("route-items").is_none() && store::load_routes().is_empty());
    assert!(store::update_route("route-items", |r| r.stats.calls = 0).unwrap().is_none());
    assert_eq!(std::fs::read(home.join("routes/route-items.json")).unwrap(), newer_route);

    let old = String::from_utf8(fixture(&f::ACTIVITY)).unwrap();
    let ahead = String::from_utf8(newer(&f::ACTIVITY, old.as_bytes())).unwrap();
    std::fs::write(home.join("activity.jsonl"), format!("{}\n{ahead}\n", old.trim())).unwrap();
    store::log_activity(&store::Activity { at: 2, who: "me".into(), what: "now".into(), ..serde_json::from_str(&old).unwrap() });
    let read: Vec<String> = store::read_activity(10).into_iter().map(|a| a.what).collect();
    assert_eq!(read, ["now", "Called Search items"], "the line a newer node appended is left out");
    let last = std::fs::read_to_string(home.join("activity.jsonl")).unwrap();
    assert!(last.lines().last().unwrap().starts_with(r#"{"v":1,"#), "each line carries its version");

    put(&home, "devnet/receipts/1-3.json", &fixture(&f::RECEIPTS));
    assert_eq!(crate::chain::receipts(1, 3).unwrap().len(), 1);
    put(&home, "devnet/receipts/1-3.json", &newer(&f::RECEIPTS, &fixture(&f::RECEIPTS)));
    assert!(crate::chain::receipts(1, 3).unwrap_err().contains("newer Unbrowse node"));
}
