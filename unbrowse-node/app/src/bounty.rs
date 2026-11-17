//! Bounties from the owner's side (spec ch. 8): the owner commands `bounty_*` and `unbrowse-node bounty …`, which sends
//! them to the running node. The writes are signed by the node's own key (`chain::bounty`); nothing here writes calldata
//! by hand.
//!
//!   unbrowse-node bounty post <site> <amount> [--limit <unb a coin>] [--days <n>]
//!                                                    post UNB for a site no route answers yet, as a limit order
//!   unbrowse-node bounty confirm <bounty id> <entry> confirm it for an entry, once your own paid call on it was claimed
//!   unbrowse-node bounty settle <bounty id>          after its deadline, fix what use releases (anyone may)
//!   unbrowse-node bounty release <bounty id> <entry> release an entry's share of a settled bounty by use (anyone may)
//!   unbrowse-node bounty refund <bounty id>          take back what is yours of it
//!   unbrowse-node bounty list [--mine] [--json]      every bounty, newest first
//!   unbrowse-node bounty show <bounty id> [--json]   one bounty
//!   unbrowse-node bounty auto [on|off]               whether the node takes these steps for you, off by default

use std::sync::Arc;

use alloy::primitives::FixedBytes;
use serde_json::{json, Value};

use crate::{chain, store, Node};

pub async fn post(node: &Arc<Node>, site: String, amount: f64, limit: Option<f64>, open_for: u64) -> Result<chain::BountyDone, String> {
    let r = chain::bounty_post(&node.chain, node.key()?, &site, amount, limit, open_for).await;
    node.events.emit("activity", ());
    r
}

pub async fn confirm(node: &Arc<Node>, id: u64, entry: FixedBytes<32>) -> Result<chain::BountyDone, String> {
    let cap = crate::autobounty::cap_of(chain::owner_address(node.key()?)?, id, &entry);
    let r = chain::bounty_confirm(&node.chain, node.key()?, id, entry, cap).await;
    node.events.emit("activity", ());
    r
}

pub async fn settle(node: &Arc<Node>, id: u64) -> Result<chain::BountyDone, String> {
    let r = chain::bounty_settle(&node.chain, node.key()?, id).await;
    node.events.emit("activity", ());
    r
}

pub async fn release(node: &Arc<Node>, id: u64, entry: FixedBytes<32>) -> Result<chain::BountyDone, String> {
    let r = chain::bounty_release_by_use(&node.chain, node.key()?, id, entry).await;
    node.events.emit("activity", ());
    r
}

pub async fn refund(node: &Arc<Node>, id: u64) -> Result<chain::BountyDone, String> {
    let r = chain::bounty_refund(&node.chain, node.key()?, id).await;
    node.events.emit("activity", ());
    r
}

/// Whether the node takes the bounty steps for its owner (`autobounty`): `on` sets it, none only reads it.
pub fn auto(on: Option<bool>) -> Result<Value, String> {
    let _held = store::settings_held();
    let mut s = store::load_settings();
    if let Some(on) = on {
        s.bounty_auto = on;
        store::save_settings(&s)?;
        if on {
            crate::autobounty::kick();
        }
    }
    Ok(json!({ "on": s.bounty_auto }))
}

/// What `bounty auto` and `bounty list` say of it.
pub fn auto_line(on: bool) -> &'static str {
    match on {
        true => "Bounty steps: on. When your agent's paid call reaches an entry of a site your bounty is for, it is asked whether the entry does the bounty, and on its yes and yours the node confirms it once the call is claimed; it also releases by use the shares your listed entries earned. `bounty auto off` stops it.",
        false => "Bounty steps: off. The node confirms nothing by itself (`bounty confirm` does it on your word). Either way it settles your bounties past their deadline and takes back what is yours. `bounty auto on` turns the steps on.",
    }
}

pub async fn list(node: &Arc<Node>, mine: bool) -> Result<Vec<chain::BountyView>, String> {
    chain::bounty_list(&node.chain, node.key()?, mine).await
}

pub async fn show(node: &Arc<Node>, id: u64) -> Result<chain::BountyView, String> {
    chain::bounty_show(&node.chain, node.key()?, id).await
}

const USAGE: &str = "usage: unbrowse-node bounty post <site> <amount> [--limit <unb>] [--days <n>] | bounty confirm <bounty id> <entry> | bounty settle <bounty id> | bounty release <bounty id> <entry> | bounty refund <bounty id> | bounty list [--mine] [--json] | bounty show <bounty id> [--json] | bounty auto [on|off]";

/// What a `bounty` command line asks the node: the owner command and its arguments, and whether to print JSON. A usage
/// error is said here, before anything reaches the node.
pub fn request(args: &[String]) -> Result<(&'static str, Value, bool), String> {
    let json_out = args.iter().any(|a| a == "--json");
    let words: Vec<&str> = args.iter().map(String::as_str).filter(|a| *a != "--json").collect();
    let id = |w: &str| w.parse::<u64>().map_err(|_| format!("{w} isn't a bounty id (a whole number, as `bounty list` shows)"));
    let entry = |w: &str| w.parse::<FixedBytes<32>>().map(|e| format!("{e:#x}")).map_err(|_| format!("{w} isn't an entry id (0x and 64 hex digits)"));
    let (cmd, body) = match words.as_slice() {
        ["post", site, amount, rest @ ..] => {
            let amount: f64 = amount.replace([',', '_'], "").parse().map_err(|_| format!("{amount} isn't an amount of UNB"))?;
            if !(amount > 0.0) || !amount.is_finite() {
                return Err("a bounty is some UNB above zero".into());
            }
            let (mut limit, mut days) = (None, None);
            let mut i = 0;
            while i < rest.len() {
                let v = rest.get(i + 1).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0);
                match rest[i] {
                    "--limit" => limit = Some(v.ok_or("--limit takes the most UNB a coin, above zero")?),
                    "--days" => days = Some(v.ok_or("--days takes a number of days above zero")?),
                    _ => return Err(USAGE.into()),
                }
                i += 2;
            }
            ("bounty_post", json!({ "site": site, "amount": amount, "limit": limit, "days": days }))
        }
        ["confirm", d, e] => ("bounty_confirm", json!({ "id": id(d)?, "entry": entry(e)? })),
        ["settle", d] => ("bounty_settle", json!({ "id": id(d)? })),
        ["release", d, e] => ("bounty_release", json!({ "id": id(d)?, "entry": entry(e)? })),
        ["refund", d] => ("bounty_refund", json!({ "id": id(d)? })),
        ["list"] => ("bounty_list", json!({ "mine": false })),
        ["list", "--mine"] => ("bounty_list", json!({ "mine": true })),
        ["show", d] => ("bounty_show", json!({ "id": id(d)? })),
        ["auto"] => ("bounty_auto", json!({ "on": null })),
        ["auto", "on"] => ("bounty_auto", json!({ "on": true })),
        ["auto", "off"] => ("bounty_auto", json!({ "on": false })),
        _ => return Err(USAGE.into()),
    };
    Ok((cmd, body, json_out))
}

/// One bounty as a few lines a person reads.
pub fn describe(v: &Value) -> String {
    let n = |k: &str| v[k].as_u64().unwrap_or(0);
    let site = v["site_name"].as_str().or(v["site"].as_str()).unwrap_or("");
    let limit = v["limit_price"].as_f64().map(|l| format!(", at most {l} UNB a coin")).unwrap_or_else(|| ", at market".into());
    let mut out = format!(
        "bounty {} — {} UNB for {site}{limit} ({})\n  poster {}{}; posted {}, open until {}\n",
        n("id"),
        v["amount"].as_f64().unwrap_or(0.0),
        v["state"].as_str().unwrap_or(""),
        v["poster"].as_str().unwrap_or(""),
        if v["mine"] == true { " (you)" } else { "" },
        n("posted_at"),
        n("deadline"),
    );
    if v["settled"] == true {
        out += &format!("  settled: {} UNB released by use over {} USDC of others' lines\n", v["reserved"].as_f64().unwrap_or(0.0), v["use_usdc"].as_f64().unwrap_or(0.0));
    }
    if v["refundable"].as_f64().unwrap_or(0.0) > 0.0 {
        out += &format!("  {} UNB its poster may take back (`bounty refund`)\n", v["refundable"].as_f64().unwrap_or(0.0));
    }
    out
}

pub fn cli(args: &[String]) -> i32 {
    let (cmd, body, json_out) = match request(args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    match crate::owner_call_within(cmd, body, std::time::Duration::from_secs(300)) {
        Ok(v) if json_out => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            0
        }
        Ok(v) => {
            if cmd == "bounty_list" {
                if let Ok(a) = crate::owner_call_within("bounty_auto", json!({ "on": null }), std::time::Duration::from_secs(30)) {
                    println!("{}\n", auto_line(a["on"] != false));
                }
            }
            match cmd {
                "bounty_auto" => println!("{}", auto_line(v["on"] != false)),
                "bounty_list" if v.as_array().is_some_and(Vec::is_empty) => println!("No bounties yet."),
                "bounty_list" => v.as_array().into_iter().flatten().for_each(|d| print!("{}", describe(d))),
                "bounty_show" => print!("{}", describe(&v)),
                _ => println!("bounty {}: tx {}", v["id"], v["tx"].as_str().unwrap_or("")),
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    /// Each command line becomes the owner command it names, with the arguments the registry says it takes.
    #[test]
    fn each_bounty_line_is_its_owner_command() {
        let e = format!("0x{}", "ab".repeat(32));
        let cases = [
            ("post shop.example 2000".to_string(), "bounty_post", json!({ "site": "shop.example", "amount": 2000.0, "limit": null, "days": null })),
            ("post shop.example 20,000 --limit 0.5 --days 7".to_string(), "bounty_post", json!({ "site": "shop.example", "amount": 20000.0, "limit": 0.5, "days": 7.0 })),
            (format!("confirm 3 {e}"), "bounty_confirm", json!({ "id": 3, "entry": e })),
            ("settle 3".to_string(), "bounty_settle", json!({ "id": 3 })),
            (format!("release 3 {e}"), "bounty_release", json!({ "id": 3, "entry": e })),
            ("refund 3".to_string(), "bounty_refund", json!({ "id": 3 })),
            ("list".to_string(), "bounty_list", json!({ "mine": false })),
            ("list --mine".to_string(), "bounty_list", json!({ "mine": true })),
            ("show 3 --json".to_string(), "bounty_show", json!({ "id": 3 })),
            ("auto".to_string(), "bounty_auto", json!({ "on": null })),
            ("auto on".to_string(), "bounty_auto", json!({ "on": true })),
            ("auto off".to_string(), "bounty_auto", json!({ "on": false })),
        ];
        for (line, cmd, body) in cases {
            let (c, b, _) = request(&words(&line)).unwrap_or_else(|err| panic!("{line}: {err}"));
            assert_eq!((c, &b), (cmd, &body), "{line}");
            let entry = crate::commands::OWNER_COMMANDS.iter().find(|o| o.name == c).unwrap_or_else(|| panic!("no owner command {c}"));
            crate::apischema::check(&(entry.input)(), &b, &crate::apischema::types()).unwrap_or_else(|err| panic!("{line}: {err}"));
        }
        assert!(request(&words("show 3 --json")).unwrap().2);
    }

    /// A line the node would refuse is refused on the command line, saying why, and reaches no node.
    #[test]
    fn a_bad_bounty_line_never_reaches_the_node() {
        assert!(request(&words("post shop.example 0")).unwrap_err().contains("above zero"));
        assert!(request(&words("post shop.example 100 --limit -1")).unwrap_err().contains("--limit"));
        assert!(request(&words("post 2000")).unwrap_err().starts_with("usage:"));
        assert!(request(&words("confirm three 0x1")).unwrap_err().contains("isn't a bounty id"));
        assert!(request(&words("confirm 3 0x1")).unwrap_err().contains("isn't an entry id"));
        assert!(request(&words("burn 3")).unwrap_err().starts_with("usage:"));
    }

    /// What `bounty show` prints says the amount, the site, the limit, the state and what may be taken back.
    #[test]
    fn a_bounty_reads_as_its_site_limit_and_state() {
        let v = json!({ "id": 4, "poster": "0xP", "mine": true, "site": "0xaa", "site_name": "shop.example", "amount": 2000.0, "limit_price": 0.5,
            "posted_at": 3, "deadline": 33, "confirmed": false, "settled": true, "reserved": 12.0, "use_usdc": 240.0, "refundable": 1988.0, "state": "settled" });
        let s = describe(&v);
        for want in ["2000 UNB for shop.example, at most 0.5 UNB a coin (settled)", "(you)", "open until 33", "12 UNB released by use over 240 USDC", "1988 UNB its poster may take back"] {
            assert!(s.contains(want), "{want} in {s}");
        }
    }
}
