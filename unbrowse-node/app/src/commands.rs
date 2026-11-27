//! The owner's commands: everything the window does, over `POST /owner/{command}` behind the owner's token. Each is
//! one entry here, with what it takes and what it answers (`apischema`), and the SDK methods that reach it. `owner()`
//! runs them from this list and `agent-api.json` is written from it, so a command added here is in the file the SDKs
//! are made from.

use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::apischema::{list, r};

/// A command's run, as `owner()` awaits it.
type Owning<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, OwnerError>> + Send + 'a>>;

/// One owner command. The node runs it by its name alone; the rest is for `api::manifest`, which a test writes out.
#[cfg_attr(not(test), allow(dead_code))]
pub struct OwnerCommand {
    pub name: &'static str,
    pub description: &'static str,
    /// Its arguments, as a JSON object: what `arg` reads.
    pub input: fn() -> Value,
    /// What it answers when it succeeds.
    pub returns: fn() -> Value,
    /// The TypeScript SDK's method for it (`UnbrowseOwner`), and the Python one's.
    pub sdk_ts: &'static str,
    pub sdk_py: &'static str,
    run: for<'a> fn(&'a Arc<Node>, &'a Value) -> Owning<'a>,
}

impl OwnerCommand {
    pub async fn run(&self, node: &Arc<Node>, a: &Value) -> Result<Value, OwnerError> {
        (self.run)(node, a).await
    }

    /// Whether `a` gives every argument this command's input requires: one that doesn't is refused by name before it
    /// does anything, with no dialog first.
    pub fn has_its_arguments(&self, a: &Value) -> bool {
        let input = (self.input)();
        let parts = input["allOf"].as_array().cloned().unwrap_or_else(|| vec![input.clone()]);
        parts.iter().filter_map(|p| p["required"].as_array()).flatten().filter_map(Value::as_str).all(|k| a.get(k).is_some_and(|v| !v.is_null()))
    }
}

/// The arguments object: these properties, `required` among them always given. Anything else is read past.
fn args(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required })
}

fn none() -> Value {
    args(json!({}), &[])
}

fn s() -> Value {
    json!({ "type": "string" })
}

fn num() -> Value {
    json!({ "type": "number" })
}

fn yes() -> Value {
    json!({ "type": "boolean" })
}

fn nothing() -> Value {
    json!({ "type": "null" })
}

fn empty() -> Value {
    json!({ "type": "object", "properties": {}, "additionalProperties": false })
}

/// A transaction's hash.
fn tx() -> Value {
    s()
}

/// One MCP client as `agent_clients` answers it (`connect::Status`).
fn client_status() -> Value {
    json!({ "type": "object", "properties": { "id": s(), "name": s(), "found": yes(), "connected": yes(), "path": s(), "note": s(), "manual": yes(), "heard": num() }, "required": ["id", "name", "found", "connected", "path"] })
}

/// The arguments of the commands that name a login.
fn login() -> Value {
    args(json!({ "site": s(), "account": s() }), &["site", "account"])
}

fn route_id() -> Value {
    args(json!({ "id": s() }), &["id"])
}

/// A bounty stake's id, as `bounty_list` answers it.
fn bounty_id() -> Value {
    json!({ "type": "integer", "minimum": 1 })
}

fn amount() -> Value {
    args(json!({ "amount": num() }), &["amount"])
}

fn passkey_browser_args() -> Value {
    args(json!({ "site": s(), "cdp": { "type": ["string", "null"] }, "minutes": { "type": ["integer", "null"] } }), &["site"])
}

/// The owner commands the node runs only on the owner's yes (`owner_dialog`), whoever sent them: the owner's token is
/// a file this user's other programs can read. They hand out a secret the node can never take back (the recovery
/// phrase, a vault password, a backup of the node's key), put a new key in the node's place, let an agent key spend
/// more (a new key, a higher cap, a higher spending limit), or name the wallet the node's withdrawals go to. Answers
/// the question for `cmd` with its arguments `a`, or `None` for a command that needs no such yes.
pub fn asks_the_owner(cmd: &str, a: &Value) -> Option<String> {
    let said = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("?").chars().take(120).collect::<String>();
    let number = |k: &str| a.get(k).map(Value::to_string).unwrap_or_else(|| "?".into()).chars().take(40).collect::<String>();
    let only = "Allow it only if you asked for this yourself just now.";
    match cmd {
        // Forgetting a kept write: one that may still land can then be signed again, and paid twice.
        "chain_kept_release" => {
            let key = said("key");
            let kept = crate::inflight::all().ok().and_then(|all| all.into_iter().find(|w| w.key == key));
            Some(match kept {
                Some(w) => format!(
                    "Something on this computer is asking Unbrowse to forget a write it signed and can't prove the fate of: {} ({:#x}, nonce {}, signed {} minutes ago). If that write may still land, the node can sign the same again and you pay twice. {only} Allow it only once you have checked on the chain that it never landed.",
                    crate::owner_dialog::plain(&w.what),
                    w.tx,
                    w.nonce,
                    crate::store::now().saturating_sub(w.at) / 60
                ),
                None => format!("Something on this computer is asking Unbrowse to forget a write it signed, \"{key}\", which it doesn't keep. {only}"),
            })
        }
        "wallet_phrase" => Some(format!("Something on this computer is asking Unbrowse for this node's recovery phrase, which opens its wallet. {only}")),
        "wallet_export" => Some(format!("Something on this computer is asking Unbrowse for a backup of this node's key, which opens its wallet. {only}")),
        // The end of a checkout hold gives agents the site back: the owner's own say, in the node's dialog.
        "checkout_release" => Some(format!(
            "Something on this computer is asking Unbrowse to end the card checkout hold on {}: agents could then act on the site again, and send it routes. Say yes only if you finished or abandoned that checkout yourself. {only}",
            said("site")
        )),
        "vault_reveal" => Some(format!("Something on this computer is asking Unbrowse to show the saved password for {} on {}. {only}", said("account"), said("site"))),
        "wallet_restore" => Some(format!("Something on this computer is asking Unbrowse to replace this node's key with the one some recovery words make: the node would then earn and pay as that key. {only}")),
        "wallet_import" => Some(format!("Something on this computer is asking Unbrowse to replace this node's key with the one in a backup: the node would then earn and pay as that key. {only}")),
        // Taking a limit away only makes the node ask more.
        "card_limit" if a.get("per_payment").and_then(Value::as_f64) == Some(0.0) => None,
        "card_limit" => Some(format!(
            "Something on this computer is asking Unbrowse to save per-payment {} and per-day {} limits for card {} on {}. These limits do not authorize a card action: each use still needs your approval because the node cannot bind the amount and currency to the outgoing charge. {only}",
            number("per_payment"), number("per_day"), said("card"),
            // The site as the limit is kept, its registrable domain, which covers every host under it: not the text sent.
            a.get("site").and_then(Value::as_str).and_then(|s| crate::vault::limit_site(s).ok()).unwrap_or_else(|| "?".into()).chars().take(120).collect::<String>())),
        "agent_set_cap" => Some(format!("Something on this computer is asking Unbrowse to let agent key {} spend up to {} USDC an epoch. {only}", number("index"), number("cap_usdc"))),
        // Connecting a client hands it the node's first agent: its token goes into the owner-only grant that
        // `unb mcp --agent first` reads. Asked only when that grant isn't there yet, and not while the root key sits in a
        // plain file this user can read anyway (as `hand_out_token` does).
        "agent_connect" => connect_needs_yes().map(|agent| {
            let names: Vec<String> = a.get("clients").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(|id| crate::connect::Client::from_id(id).map(|c| c.name().to_string()).unwrap_or_else(|| id.chars().take(40).collect())).collect();
            format!(
                "Something on this computer is asking Unbrowse to connect {} to this node as the agent \"{agent}\", so it can browse and spend within that agent's limit. {only}",
                if names.is_empty() { "an MCP client".to_string() } else { names.join(", ") }
            )
        }),
        "agent_create" => Some(format!(
            "Something on this computer is asking Unbrowse to make a new agent key, \"{}\", that may spend up to {} USDC an epoch for {} days, and to hand back its token. {only}",
            said("name").chars().take(60).collect::<String>(),
            number(if a.get("cap_usdc").is_some_and(|v| !v.is_null()) { "cap_usdc" } else { "cap_unb" }),
            number("days")
        )),
        "link_wallet" => Some(format!(
            "Something on this computer is asking Unbrowse to link this wallet to this node:\n\n{}\n\nThe node's withdrawals will go to it. Check it is your own wallet's address, as your wallet shows it. {only}",
            said("owner")
        )),
        "wallet_send" => Some(format!(
            "Something on this computer is asking Unbrowse to send {} USDC from this node's wallet to:\n\n{}\n\nCheck it is your own wallet's address, as your wallet shows it: USDC sent can't be taken back. {only}",
            number("amount"),
            said("to")
        )),
        // A coin bought, sold or launched spends or parts with the wallet's own value, as a send does (audit 1118 M11).
        "coin_buy" => Some(format!(
            "Something on this computer is asking Unbrowse to buy the route coin of entry {} with {} UNB from this node's wallet. A buy can't be undone. {only}",
            said("entry"),
            number("unb")
        )),
        "coin_sell" => Some(format!(
            "Something on this computer is asking Unbrowse to sell {} of this node's coins of entry {} for UNB, at the price the coin's curve gives now. {only}",
            number("coins"),
            said("entry")
        )),
        "coin_launch" => Some(format!(
            "Something on this computer is asking Unbrowse to launch the route coin of entry {} with a first buy of {} UNB from this node's wallet. It can't be undone. {only}",
            said("entry"),
            number("unb")
        )),
        // Confirming spends the bounty's UNB on a coin, half of it staked for the entry's contributor: the owner's word.
        "bounty_confirm" => Some(format!(
            "Something on this computer is asking Unbrowse to confirm your bounty {} for entry {}: it buys that entry's coin with the bounty's UNB now, half staked for its contributor and half for you, and can't be undone. {only}",
            number("id"),
            said("entry")
        )),
        // A passkey held in a browser the node doesn't run goes to it with its private key (the DevTools authenticator
        // takes the key itself), and whatever answers at that address can keep it: lasting access to the account, past
        // any Keychain. The owner token proves only that the caller runs as this user.
        "passkey_use" | "passkey_enrol" if a.get("cdp").is_some_and(|v| !v.is_null()) => Some(format!(
            "Something on this computer is asking Unbrowse to {} your passkeys for {} to a browser Unbrowse doesn't run, at {}. Whatever runs there could copy them and sign in as you for good. {only}",
            if cmd == "passkey_use" { "hand" } else { "keep a new passkey and hand it and" },
            said("site"),
            said("cdp")
        )),
        // Keeping card security codes lets agents pay without the owner at the page; it goes on only on their yes.
        "keep_card_codes" if a.get("on").and_then(Value::as_bool) == Some(true) && !store::load_settings().keep_card_codes => Some(format!(
            "Something on this computer is asking Unbrowse to keep your cards' security codes, so agents can pay where a checkout asks for one without you. {} {only}",
            crate::vault::KEEPING_CODES_COSTS
        )),
        // Letting the owner SDK approve card payments is a yes given once for many payments; going back asks nothing.
        "payment_approver" if a.get("approver").and_then(Value::as_str) == Some("sdk") => Some(format!(
            "Something on this computer is asking Unbrowse to let a program holding the owner token approve card payments without this dialog: one that asks you on another device, such as the daemon hub's Telegram bot. Each payment is still asked and logged, one at a time, but any program running as you on this computer could then approve one an agent waits on. `unbrowse-node vault card approver dialog` turns it off. {only}"
        )),
        // Letting a device away from the machine answer sign-in and code asks is asked once; turning it off asks nothing.
        // A remote key lets an agent anywhere use this node through the gateway, browser and logins included.
        "remote_key_create" => Some(format!(
            "Something on this computer is asking Unbrowse to make a remote key: whoever holds it can use this node from anywhere through its gateway, browser and logins included, spending up to {} USDC a day for {} days. {only}",
            crate::remote::KEY_CAP_USDC, crate::remote::KEY_DAYS
        )),
        "remote_answers" if a.get("on").and_then(Value::as_bool) == Some(true) => Some(format!(
            "Something on this computer is asking Unbrowse to let a program holding the owner token answer agents' sign-in and code asks from another device, such as the daemon hub's Telegram bot: a code you send there is typed into the page, never shown to the agent. Any program running as you on this computer could then answer an ask that waits. `remote_answers` off turns it back. {only}"
        )),
        // The two commands that set what `save_settings` asks about one at a time ask the same.
        "bounty_auto" if a.get("on").and_then(Value::as_bool) == Some(true) && !store::load_settings().bounty_auto => {
            Some(format!("Something on this computer is asking Unbrowse to take bounty steps for you. {only}"))
        }
        // The listing's first buy spends UNB by itself on every newly credited entry: past the default the owner decided
        // on (`decide.dev-buy-default-on`), raising it is the owner's word.
        "coin_dev_buy" if a.get("bps").is_some_and(|v| !v.is_null()) => {
            let was = store::load_settings().coin_dev_buy_bps;
            let to = a.get("bps").and_then(Value::as_u64);
            to.is_none_or(|b| b > u64::from(was.max(store::COIN_DEV_BUY_BPS))).then(|| {
                format!("Something on this computer is asking Unbrowse to launch the coin of each entry it lists with a first buy of {} basis points (hundredths of a percent) of your wallet's UNB, by itself (now {was}; {} by default). {only}", number("bps"), store::COIN_DEV_BUY_BPS)
            })
        }
        "save_settings" => raised_limits(a.get("settings")?).map(|raised| format!("Something on this computer is asking Unbrowse to change what it does without asking: {raised}. {only}")),
        // An agent's words leave as a public issue only as the owner read them, here.
        "report_send" => Some(format!(
            "An agent wrote this bug report. Sent, it becomes a public issue on github.com/{} that anyone can read:\n\n{}\n\nSend it only if nothing in it is yours to keep private.",
            crate::report::REPO,
            crate::report::waiting_text(&said("fingerprint")).unwrap_or_else(|| "(no report waits under that fingerprint)".into())
        )),
        // What can't be brought back, and a session someone else chose: each asked as the window's own command is.
        "vault_remove" => Some(format!("Something on this computer is asking Unbrowse to delete the saved login for {} on {}: it can't be brought back. {only}", said("account"), said("site"))),
        "vault_rotate" => Some(format!(
            "Something on this computer is asking Unbrowse to move the login for {} on {} on to a new password: the one the site has now is gone from the vault. {only}",
            said("account"),
            said("site")
        )),
        // What can't be brought back, asked as `vault_remove` is, from the window or a shell.
        "vault_card_remove" => Some(format!("Something on this computer is asking Unbrowse to delete the saved card {}: it can't be brought back. {only}", said("card"))),
        "passkey_remove" => Some(format!("Something on this computer is asking Unbrowse to delete the passkey {}: it can't be brought back, and the site may then not let you in without another. {only}", said("id"))),
        "import_session" => Some(match a.get("from").and_then(Value::as_str) {
            Some(file) => format!(
                "Something on this computer is asking Unbrowse to sign its browser in to {} with the cookies in {}: your agents would then act there as whoever those cookies sign in, which may not be you. {only}",
                said("host"),
                file.chars().take(120).collect::<String>()
            ),
            None => format!("Something on this computer is asking Unbrowse to take your session for {} from your browser: your agents would then act there as you. {only}", said("host")),
        }),
        _ => None,
    }
}

/// What `settings` loosens of what bounds the node's spending (`store::SPENDING`), said for the owner; `None` when it
/// loosens nothing.
fn raised_limits(settings: &Value) -> Option<String> {
    let kept = store::load_settings();
    let now = serde_json::to_value(&kept).ok()?;
    let mut raised = store::loosened(&now, settings);
    // Switches that tell the network more of what the owner does, or let the node sign in as them.
    for (k, what, was) in [
        ("serve_kept", "tell the peer network which sites' routes you have used, by serving the copies it keeps", kept.serve_kept),
        ("passkeys", "make passkeys on the sites it signs in to, and sign in with them as you", kept.passkeys),
        ("accept_bearer", "take agents' tokens sent as plain bearer tokens, which whatever answers at the node's address while it is away would keep", kept.accept_bearer),
    ] {
        if !was && settings.get(k).is_some_and(|v| v.as_bool() != Some(false) && !v.is_null()) {
            raised.push(what.to_string());
        }
    }
    // Sharing more of the owner's routes than now, and updating to releases before they are stable.
    let shares = |m: &store::ShareMode| match m {
        store::ShareMode::Off => 0,
        store::ShareMode::Used => 1,
        store::ShareMode::All => 2,
    };
    if let Some(mode) = settings.get("share_routes").and_then(Value::as_str).and_then(|m| crate::build_config::share_mode(Some(m.trim()))) {
        if shares(&mode) > shares(&kept.share_routes) {
            raised.push("list more of your routes on the network by itself".to_string());
        }
    }
    if settings.get("update_channel").and_then(Value::as_str) == Some("canary") && kept.update_channel.as_deref() != Some("canary") {
        raised.push("update to canary releases, before they are called stable".to_string());
    }
    (!raised.is_empty()).then(|| raised.join(", and "))
}

/// The arguments `a` with an older name a command still takes put under its name now, so the owner's question and the
/// command read the same value.
pub fn under_current_names(cmd: &str, mut a: Value) -> Value {
    if cmd == "agent_create" && a.get("cap_usdc").is_none_or(Value::is_null) {
        if let Some(cap) = a.get("cap_unb").cloned().filter(|v| !v.is_null()) {
            a["cap_usdc"] = cap;
        }
    }
    a
}

pub static OWNER_COMMANDS: &[OwnerCommand] = &[
    // ---- the node ----
    OwnerCommand {
        name: "identity",
        description: "This node's own address, the key that signs its writes and pays their gas, and whether this run made it.",
        input: none,
        returns: || r("Identity"),
        sdk_ts: "identity",
        sdk_py: "identity",
        run: |node, _| Box::pin(async move { out(identity(node)?) }),
    },
    OwnerCommand {
        name: "link_status",
        description: "The owner's wallet this node is linked to, if any, and whether a sign-in is being waited on.",
        input: none,
        returns: || r("OwnerLink"),
        sdk_ts: "linkStatus",
        sdk_py: "link_status",
        run: |node, _| Box::pin(async move { out(link::status(node)?) }),
    },
    OwnerCommand {
        name: "link_start",
        description: "Opens the website's sign-in in the owner's browser and waits for the wallet the owner signs with there.",
        input: none,
        returns: || r("LinkStart"),
        sdk_ts: "linkStart",
        sdk_py: "link_start",
        run: |node, _| Box::pin(async move { out(link::start(node).await?) }),
    },
    OwnerCommand {
        name: "link_message",
        description: "Starts a sign-in with the owner's own wallet: the message that wallet signs (EIP-191) naming this node, and the nonce the node drew for it.",
        input: || args(json!({ "owner": s() }), &["owner"]),
        returns: || r("LinkMessage"),
        sdk_ts: "linkMessage",
        sdk_py: "link_message",
        run: |node, a| Box::pin(async move { out(link::link_message(node, &arg::<String>(a, "owner")?)?) }),
    },
    OwnerCommand {
        name: "link_wallet",
        description: "Signs the owner in with what their own wallet signed of link_message's message: from then on the node is on the network, registers its identity, grants its agents' keys and lists what it learns.",
        input: || args(json!({ "owner": s(), "nonce": s(), "signature": s() }), &["owner", "nonce", "signature"]),
        returns: || r("OwnerLink"),
        sdk_ts: "linkWallet",
        sdk_py: "link_wallet",
        run: |node, a| Box::pin(async move { out(link::link_wallet(node, &arg::<String>(a, "owner")?, &arg::<String>(a, "nonce")?, &arg::<String>(a, "signature")?)?) }),
    },
    OwnerCommand {
        name: "remote_status",
        description: "This node's own remote MCP address at a gateway: on or off, the URL, and the live remote keys for it.",
        input: none,
        returns: || r("Remote"),
        sdk_ts: "remoteStatus",
        sdk_py: "remote_status",
        run: |_, _| Box::pin(async move { out(crate::remote::status()) }),
    },
    OwnerCommand {
        name: "remote_set",
        description: "Turns this node's own remote MCP address on or off, at the gateway named or the one it had (https://unbrowse.ai by default). The running node attaches or leaves within a few seconds.",
        input: || args(json!({ "on": yes(), "gateway": s() }), &["on"]),
        returns: || r("Remote"),
        sdk_ts: "setRemote",
        sdk_py: "remote_set",
        run: |_, a| Box::pin(async move { out(crate::remote::set(arg::<bool>(a, "on")?, arg::<Option<String>>(a, "gateway")?.as_deref())?) }),
    },
    OwnerCommand {
        name: "remote_key_create",
        description: "Makes a remote key for the gateway, which opens this node only through it, and answers its token once with how an MCP client uses it.",
        input: || args(json!({ "name": s() }), &[]),
        returns: || r("NewRemoteKey"),
        sdk_ts: "createRemoteKey",
        sdk_py: "remote_key_create",
        run: |node, a| Box::pin(async move { out(crate::remote::new_key(node.keys.as_ref(), &arg::<Option<String>>(a, "name")?.unwrap_or_default())?) }),
    },
    OwnerCommand {
        name: "remote_revoke",
        description: "Revokes every remote key for the gateway.",
        input: none,
        returns: || r("Remote"),
        sdk_ts: "revokeRemoteKeys",
        sdk_py: "remote_revoke",
        run: |_, _| Box::pin(async move { out(crate::remote::revoke_all()?) }),
    },
    OwnerCommand {
        name: "unlink",
        description: "Forgets the owner's signature, leaving the wallet itself untouched.",
        input: none,
        returns: empty,
        sdk_ts: "unlink",
        sdk_py: "unlink",
        run: |node, _| Box::pin(async move { out(link::unlink(node)?) }),
    },
    OwnerCommand {
        name: "funding",
        description: "What the node's own key needs in USDC on Arc, which is also its gas: what it lacks for a write, what its identity registration needs once, and its deposit against the floor it keeps.",
        input: none,
        returns: || r("Funding"),
        sdk_ts: "funding",
        sdk_py: "funding",
        run: |node, _| Box::pin(async move { out(link::funding(node).await?) }),
    },
    OwnerCommand {
        name: "money",
        description: "Everything the Money screen shows, in dollars: one balance (USDC at the node's address, its deposit, and the owner's account deposit while it pays for this node's agents), what agents can spend now, the smallest top-up that starts the node, each agent's daily limit and what it spent today, earnings (the route shares ready to take, in USDC), the first buys the node made for its listings, and the page that adds funds. Sums are decimal strings.",
        input: none,
        returns: || r("Money"),
        sdk_ts: "money",
        sdk_py: "money",
        run: |node, _| Box::pin(async move { out(money::of(node).await?) }),
    },
    OwnerCommand {
        name: "add_funds",
        description: "Opens the page that adds funds to this node in the owner's browser (card, Apple Pay or bank through Circle's Arc Onramp Kit, or USDC sent by hand), at the smallest top-up that starts it. The USDC lands at the node's address and the node deposits it itself. Answers the page and whether it opened.",
        input: none,
        returns: || r("AddFunds"),
        sdk_ts: "addFunds",
        sdk_py: "add_funds",
        run: |node, _| Box::pin(async move { out(link::add_funds(node).await?) }),
    },
    OwnerCommand {
        name: "share_status",
        description: "Which routes the node lists by itself, today's listings against the day's cap, and where each route stands.",
        input: none,
        returns: || r("ShareStatus"),
        sdk_ts: "shareStatus",
        sdk_py: "share_status",
        // Reading it says nothing of what the owner wants: a window reads it on opening My routes, whoever is looking.
        run: |node, _| Box::pin(async move { out(autolist::view_on(&node.chain)) }),
    },
    OwnerCommand {
        name: "share_approve",
        description: "The owner has looked at the routes waiting to be shared and lets the first listing go now, rather than a day after the node told them (R2.8).",
        input: none,
        returns: nothing,
        sdk_ts: "shareApprove",
        sdk_py: "share_approve",
        run: |_, _| Box::pin(async move {
            autolist::previewed();
            out(())
        }),
    },
    OwnerCommand {
        name: "share_route",
        description: "Shares one route, even one delisted before, or keeps it off the network from now on. Turning it off delists nothing: what is listed stays listed until delist_route.",
        input: || args(json!({ "id": s(), "on": yes() }), &["id", "on"]),
        returns: || r("KeptRoute"),
        sdk_ts: "shareRoute",
        sdk_py: "share_route",
        run: |node, a| Box::pin(async move { out(autolist::share_route(node, arg(a, "id")?, arg(a, "on")?).await?.shown()) }),
    },
    OwnerCommand {
        name: "delist_all",
        description: "Delists every route this node lists and keeps each off the network until it is shared again, answering the ids delisted.",
        input: none,
        returns: || list(s()),
        sdk_ts: "delistAll",
        sdk_py: "delist_all",
        run: |node, _| Box::pin(async move { out(autolist::delist_all(node).await?) }),
    },
    OwnerCommand {
        name: "node_info",
        description: "The node's name, its version, the port it answers on and whether it is a dev build.",
        input: none,
        returns: || r("NodeInfo"),
        sdk_ts: "nodeInfo",
        sdk_py: "node_info",
        run: |node, _| Box::pin(async move { out(node_info(node)) }),
    },
    OwnerCommand {
        name: "sites",
        description: "The sites the node's browser has walked, the latest first.",
        input: none,
        returns: || list(r("Site")),
        sdk_ts: "sites",
        sdk_py: "sites",
        run: |_, _| Box::pin(async move { out(sites()) }),
    },
    OwnerCommand {
        name: "sessions",
        description: "The sessions the node keeps for sites: how many cookies each holds and when it was last refreshed, never a value.",
        input: none,
        returns: || list(r("Session")),
        sdk_ts: "sessions",
        sdk_py: "sessions",
        run: |_, _| Box::pin(async move { out(sessions()) }),
    },
    OwnerCommand {
        name: "forget_session",
        description: "Drops a site's kept session, so its next call walks the site again.",
        input: || args(json!({ "host": s() }), &["host"]),
        returns: nothing,
        sdk_ts: "forgetSession",
        sdk_py: "forget_session",
        run: |_, a| Box::pin(async move { out(forget_session(arg(a, "host")?)?) }),
    },
    OwnerCommand {
        name: "settings",
        description: "The owner's settings.",
        input: none,
        returns: || r("Settings"),
        sdk_ts: "settings",
        sdk_py: "settings",
        run: |_, _| Box::pin(async move { out(settings()) }),
    },
    OwnerCommand {
        name: "terms_text",
        description: "The terms of service and privacy policy this node asks its owner to acknowledge, as they are written.",
        input: none,
        returns: || r("TermsText"),
        sdk_ts: "termsText",
        sdk_py: "terms_text",
        run: |_, _| Box::pin(async move { out(terms::text()) }),
    },
    OwnerCommand {
        name: "accept_terms",
        description: "Records that the owner was shown the current terms, and their answer on the network: `keep_off` keeps the node off it, else it joins. Answers the settings as kept.",
        input: || args(json!({ "keep_off": yes() }), &["keep_off"]),
        returns: || r("Settings"),
        sdk_ts: "acceptTerms",
        sdk_py: "accept_terms",
        run: |_, a| Box::pin(async move { out(accept_terms(arg(a, "keep_off")?)?) }),
    },
    OwnerCommand {
        name: "save_settings",
        description: "Checks and keeps the owner's settings, answering them as kept.",
        input: || args(json!({ "settings": apischema::settings(true) }), &["settings"]),
        returns: || r("Settings"),
        sdk_ts: "saveSettings",
        sdk_py: "save_settings",
        run: |_, a| Box::pin(async move { out(save_settings(arg(a, "settings")?)?) }),
    },
    // ---- routes ----
    OwnerCommand {
        name: "routes",
        description: "Every route the node keeps, with its steps, its record of calls and its listing.",
        input: none,
        returns: || list(r("KeptRoute")),
        sdk_ts: "routes",
        sdk_py: "routes",
        run: |_, _| Box::pin(async move { out(routes().into_iter().map(store::Route::shown).collect::<Vec<_>>()) }),
    },
    OwnerCommand {
        name: "delete_route",
        description: "Deletes a kept route.",
        input: route_id,
        returns: nothing,
        sdk_ts: "deleteRoute",
        sdk_py: "delete_route",
        run: |_, a| Box::pin(async move { out(delete_route(arg(a, "id")?)?) }),
    },
    OwnerCommand {
        name: "call_route",
        description: "Runs a kept route as the owner, with no fee. A route whose site opted out of Unbrowse in its robots rules isn't called.",
        input: || args(json!({ "id": s(), "inputs": { "type": ["object", "null"], "additionalProperties": s() } }), &["id"]),
        returns: || r("OwnerCallResult"),
        sdk_ts: "callRoute",
        sdk_py: "call_route",
        run: |node, a| Box::pin(async move { out(call_route(node, arg(a, "id")?, arg::<Option<_>>(a, "inputs")?.unwrap_or_default()).await?) }),
    },
    OwnerCommand {
        name: "activity",
        description: "What happened on the node, the latest first: the last 200 lines unless limit says how many.",
        input: || args(json!({ "limit": { "type": ["integer", "null"] } }), &[]),
        returns: || list(r("Activity")),
        sdk_ts: "activity",
        sdk_py: "activity",
        run: |_, a| Box::pin(async move { out(activity(arg(a, "limit")?)) }),
    },
    // ---- agents ----
    OwnerCommand {
        name: "agents_list",
        description: "The agent keys made on this node.",
        input: none,
        returns: || list(r("Agent")),
        sdk_ts: "agents",
        sdk_py: "agents_list",
        run: |_, _| Box::pin(async move { out(agents_list()) }),
    },
    OwnerCommand {
        name: "agent_create",
        description: "Makes an agent key with its cap an epoch in USDC and its lifetime in days, authorises it on the chain, and answers its setup once.",
        input: || {
            args(
                json!({ "name": s(), "cap_usdc": num(), "days": { "type": "integer" },
                    "cap_unb": { "type": "number", "description": "@deprecated The same cap as cap_usdc, under its name from before fees were USDC: send cap_usdc." } }),
                &["name", "cap_usdc", "days"],
            )
        },
        returns: || r("NewAgent"),
        sdk_ts: "createAgent",
        sdk_py: "agent_create",
        // A client from before the rename sends only `cap_unb`: the same amount, taken the same way.
        run: |node, a| {
            Box::pin(async move {
                let cap = arg::<Option<f64>>(a, "cap_usdc")?.or(arg::<Option<f64>>(a, "cap_unb")?).ok_or_else(|| OwnerError::Failed("cap_usdc: the key's cap a day, in USDC".into()))?;
                out(agent_create(node, arg(a, "name")?, cap, arg(a, "days")?).await?)
            })
        },
    },
    OwnerCommand {
        name: "remote_link",
        description: "Links this node to the owner's Unbrowse account, so ChatGPT and Claude signed in to Unbrowse reach it with no address to paste: turns the address on if it is off, lets a sign-in ask, and opens the gateway's link page in the owner's browser (url, opened). The node asks the owner before it is linked.",
        input: none,
        returns: || json!({ "type": "object", "properties": { "url": s(), "opened": yes() }, "required": ["url", "opened"] }),
        sdk_ts: "linkAccount",
        sdk_py: "remote_link",
        run: |_, _| Box::pin(async move { out(tokio::task::spawn_blocking(crate::remote::link_account).await.map_err(|e| e.to_string())??) }),
    },
    OwnerCommand {
        name: "setup_status",
        description: "This node's setup as one list, the same an agent reads with unbrowse_setup: the terms, signing in, the agent apps on this machine, the address for ChatGPT and Claude on the web, the sites it holds a sign-in for, and whether an agent has called it. Each step: done, optional, a line saying where it stands, and the unbrowse_setup call that does it; left names the steps setup still needs.",
        input: none,
        returns: || r("SetupStatus"),
        sdk_ts: "setupStatus",
        sdk_py: "setup_status",
        run: |node, _| Box::pin(async move { out(crate::setup::status(node)) }),
    },
    OwnerCommand {
        name: "agent_clients",
        description: "The MCP clients this machine has (Claude Code, Claude Desktop, Cursor, Codex, VS Code, Gemini CLI, opencode and the others Unbrowse connects): whether each is found and connected to this node, its config file, and when it last reached this node (`heard`, unix seconds, by the name it gives at MCP initialize).",
        input: none,
        returns: || json!({ "type": "object", "properties": { "clients": { "type": "array", "items": client_status() } }, "required": ["clients"] }),
        sdk_ts: "agentClients",
        sdk_py: "agent_clients",
        run: |node, _| Box::pin(async move { out(agent_clients(node)) }),
    },
    OwnerCommand {
        name: "agent_connect",
        description: "Connects the named MCP clients to this node as its first agent: each gets `unb mcp --agent first` in its own config, checked to answer first, its file kept as it was beside it, and no token in it.",
        input: || args(json!({ "clients": { "type": "array", "items": { "type": "string", "enum": crate::connect::ALL.map(|c| c.id()) } } }), &["clients"]),
        returns: || {
            json!({ "type": "object", "properties": { "results": { "type": "array", "items": { "type": "object",
                "properties": { "id": s(), "name": s(), "ok": yes(), "restart_needed": yes(), "error": { "type": ["string", "null"] } },
                "required": ["id", "name", "ok", "restart_needed", "error"] } } }, "required": ["results"] })
        },
        sdk_ts: "connectAgents",
        sdk_py: "agent_connect",
        run: |node, a| Box::pin(async move { out(agent_connect(node, arg(a, "clients")?).await?) }),
    },
    OwnerCommand {
        name: "agent_connect_undo",
        description: "Puts back every MCP client config the last agent_connect changed, and answers the files it restored.",
        input: none,
        returns: || {
            json!({ "type": "object", "properties": { "restored": { "type": "array", "items": { "type": "object",
                "properties": { "id": s(), "name": s(), "path": s() }, "required": ["id", "name", "path"] } } }, "required": ["restored"] })
        },
        sdk_ts: "undoConnectAgents",
        sdk_py: "agent_connect_undo",
        run: |_, _| Box::pin(async move { out(agent_connect_undo().await?) }),
    },
    OwnerCommand {
        name: "agent_revoke",
        description: "Revokes an agent key here at once, then on the chain.",
        input: || args(json!({ "index": { "type": "integer" } }), &["index"]),
        returns: || r("Agent"),
        sdk_ts: "revokeAgent",
        sdk_py: "agent_revoke",
        run: |node, a| Box::pin(async move { out(agent_revoke(node, arg(a, "index")?).await?) }),
    },
    OwnerCommand {
        name: "card_limit",
        description: "Stores per-payment and per-day limits for a card on one site. Card fills and route calls currently always ask because the node cannot bind a checkout amount and currency to the outgoing charge. A per_payment of 0 removes the stored limit.",
        input: || args(json!({ "card": s(), "site": s(), "per_payment": num(), "per_day": num() }), &["card", "site", "per_payment", "per_day"]),
        returns: || apischema::or_null(r("CardLimit")),
        sdk_ts: "setCardLimit",
        sdk_py: "card_limit",
        run: |node, a| Box::pin(async move {
            let keep = crate::vault_keep(node.key().map(|k| k as &dyn unbrowse_core::KeyStore))?;
            out(crate::vault::set_card_limit(&keep, &arg::<String>(a, "card")?, &arg::<String>(a, "site")?, arg(a, "per_payment")?, arg(a, "per_day")?, "You")?)
        }),
    },
    OwnerCommand {
        name: "card_limits",
        description: "Stored per-payment and per-day limits for each card and site, and what was counted today. Unknown or unbound charge amounts are never counted as within a limit.",
        input: none,
        returns: || list(r("CardLimit")),
        sdk_ts: "cardLimits",
        sdk_py: "card_limits",
        run: |node, _| Box::pin(async move {
            let keep = crate::vault_keep(node.key().map(|k| k as &dyn unbrowse_core::KeyStore))?;
            out(crate::vault::card_limits(&keep))
        }),
    },
    OwnerCommand {
        name: "keep_card_codes",
        description: "Whether the vault keeps card security codes (#185), off until the owner turns it on. Card rules (PCI DSS) forbid keeping a code after a payment is authorised, even encrypted. Off, a card is kept with no code and a checkout asks the owner to type it; on, a card added from then on keeps its code, and an agent pays with it where a checkout asks, a route call too. Turning it on asks the owner first; turning it off forgets every kept code at once. `on` sets it; null only reads it. Answers whether it is on and the cards whose code it just forgot.",
        input: || args(json!({ "on": { "type": ["boolean", "null"] } }), &[]),
        returns: || r("CardCodes"),
        sdk_ts: "keepCardCodes",
        sdk_py: "keep_card_codes",
        run: |node, a| Box::pin(async move {
            let keep = crate::vault_keep(node.key().map(|k| k as &dyn unbrowse_core::KeyStore))?;
            out(crate::vault::set_keep_codes(&keep, arg::<Option<bool>>(a, "on")?, "You")?)
        }),
    },
    OwnerCommand {
        name: "agent_set_cap",
        description: "Sets what an agent key may spend an epoch, in USDC, under Advanced: the node keeps it at every renewal and grants it on the chain at once. The node's own key starts at 5 USDC an epoch (agent.key_cap).",
        input: || args(json!({ "index": { "type": "integer" }, "cap_usdc": num() }), &["index", "cap_usdc"]),
        returns: || r("Agent"),
        sdk_ts: "setAgentCap",
        sdk_py: "agent_set_cap",
        run: |node, a| Box::pin(async move { out(agent_set_cap(node, arg(a, "index")?, arg(a, "cap_usdc")?)?) }),
    },
    OwnerCommand {
        name: "wallet_grant",
        description: "One wallet owning several nodes (spec §76.1): the calls the owner's wallet sends so this node's agent keys pay from the wallet's deposit, one authorizeAgent each at the key's cap and expiry, and the wallet's deposit. The node can't send them, since a grant is the wallet's own; once the chain has them, the node's vouchers name the wallet as payer.",
        input: none,
        returns: || r("WalletGrant"),
        sdk_ts: "walletGrant",
        sdk_py: "wallet_grant",
        run: |node, _| Box::pin(async move { out(owner_nodes::grant(node).await?) }),
    },
    OwnerCommand {
        name: "wallet_renew",
        description: "Renews the owner's wallet's grants to this node's agent keys in one step before they run out (spec §76.2 item 3): opens the sign-in page in its renewal mode, which sends them all from the wallet, and answers its url and the same calls for a wallet of the owner's own. Each grant runs to its key's expiry, 30 days on; none is made without one.",
        input: none,
        returns: || r("WalletRenew"),
        sdk_ts: "walletRenew",
        sdk_py: "wallet_renew",
        run: |node, _| Box::pin(async move { out(link::renew(node).await?) }),
    },
    OwnerCommand {
        name: "listings_to_sign",
        description: "The listings this node keeps for the owner's wallet to sign. A node linked to the owner's wallet lists under the wallet's one identity, and only the wallet's own key signs a listing, never an agent key (issue #184), so a node that doesn't hold that key asks the owner to sign each one. Each is said in plain words and given as the EIP-712 typed data the wallet signs (eth_signTypedData_v4). Empty when the node lists under its own wallet.",
        input: none,
        returns: || list(r("ListingToSign")),
        sdk_ts: "listingsToSign",
        sdk_py: "listings_to_sign",
        run: |node, _| Box::pin(async move { out(owner_nodes::to_sign(node).await?) }),
    },
    OwnerCommand {
        name: "listings_sign",
        description: "Has the owner's wallet sign the listings listings_to_sign names, as it sends its grants: opens the sign-in page in the owner's browser in its signing mode, where the wallet's provider signs each one, and takes each signature back through the site's relay. The node keeps only the wallet's own signature. Up to 8 a page; answers the page's url and how many it asks.",
        input: none,
        returns: || r("ListingsSign"),
        sdk_ts: "listingsSign",
        sdk_py: "listings_sign",
        run: |node, _| Box::pin(async move { out(link::sign_listings(node).await?) }),
    },
    OwnerCommand {
        name: "listing_sign",
        description: "Hands the node the owner's wallet's signature of a listing listings_to_sign names, by its id. The node takes only the wallet's own signature, never an agent key's or anyone else's, then puts the listing under a root and spreads it under the wallet's identity. Signing sends no transaction.",
        input: || args(json!({ "id": s(), "signature": s() }), &["id", "signature"]),
        returns: || r("ListingSigned"),
        sdk_ts: "signListing",
        sdk_py: "listing_sign",
        run: |node, a| Box::pin(async move { out(owner_nodes::sign_listing(node, &arg::<String>(a, "id")?, &arg::<String>(a, "signature")?).await?) }),
    },
    OwnerCommand {
        name: "owner_nodes",
        description: "The owner's wallet, its deposit, and every agent key it granted, on this node and its others: each spends from the one deposit up to its own cap, and this node's are marked.",
        input: none,
        returns: || r("OwnerNodes"),
        sdk_ts: "ownerNodes",
        sdk_py: "owner_nodes",
        run: |node, _| Box::pin(async move { out(owner_nodes::list(node).await?) }),
    },
    // ---- the vault ----
    OwnerCommand {
        name: "vault_list",
        description: "The logins in the vault, never a password.",
        input: none,
        returns: || list(r("VaultLogin")),
        sdk_ts: "vaultList",
        sdk_py: "vault_list",
        run: |_, _| Box::pin(async move { out(vault_list()) }),
    },
    OwnerCommand {
        name: "vault_add",
        description: "Saves a login: a derived one's password is made from the root key, a stored one keeps the password given.",
        input: || {
            args(json!({ "site": s(), "account": s(), "kind": { "type": "string", "enum": ["derived", "stored"] }, "password": { "type": ["string", "null"] } }), &[
                "site", "account", "kind",
            ])
        },
        returns: || r("VaultLogin"),
        sdk_ts: "vaultAdd",
        sdk_py: "vault_add",
        run: |node, a| Box::pin(async move { out(vault_add(node, arg(a, "site")?, arg(a, "account")?, arg(a, "kind")?, arg(a, "password")?)?) }),
    },
    OwnerCommand {
        name: "vault_remove",
        description: "Removes a login from the vault.",
        input: login,
        returns: nothing,
        sdk_ts: "vaultRemove",
        sdk_py: "vault_remove",
        run: |node, a| Box::pin(async move { out(vault_remove(node, arg(a, "site")?, arg(a, "account")?)?) }),
    },
    OwnerCommand {
        name: "vault_reveal",
        description: "A login's password, in the clear.",
        input: login,
        returns: s,
        sdk_ts: "vaultReveal",
        sdk_py: "vault_reveal",
        run: |node, a| Box::pin(async move { out(vault_reveal(node, arg(a, "site")?, arg(a, "account")?)?) }),
    },
    OwnerCommand {
        name: "vault_rotate",
        description: "Moves a derived login on to its next password; the old one is gone.",
        input: login,
        returns: || r("VaultLogin"),
        sdk_ts: "vaultRotate",
        sdk_py: "vault_rotate",
        run: |_, a| Box::pin(async move { out(vault_rotate(arg(a, "site")?, arg(a, "account")?)?) }),
    },
    OwnerCommand {
        name: "vault_code",
        description: "Keeps a login's one-time code key, so agents fill its codes and no one reads them.",
        input: || args(json!({ "site": s(), "account": s(), "key": s() }), &["site", "account", "key"]),
        returns: || r("VaultLogin"),
        sdk_ts: "vaultCode",
        sdk_py: "vault_code",
        run: |node, a| {
            Box::pin(async move {
                out(vault::set_code(&node_vault(node)?, &arg::<String>(a, "site")?, &arg::<String>(a, "account")?, &arg::<String>(a, "key")?, "You")?)
            })
        },
    },
    OwnerCommand {
        name: "vault_import",
        description: "Imports the logins of a browser's or a password manager's export, counting the rows it left out by why.",
        input: || args(json!({ "csv": s() }), &["csv"]),
        returns: || r("VaultImport"),
        sdk_ts: "vaultImport",
        sdk_py: "vault_import",
        run: |node, a| Box::pin(async move { out(vault_import(node, arg(a, "csv")?).await?) }),
    },
    OwnerCommand {
        name: "vault_cards",
        description: "The payment cards in the vault: each one's label, its last four digits, when it was added and whether it is kept with its security code. Never its number, expiry, name or code.",
        input: none,
        returns: || list(r("VaultCard")),
        sdk_ts: "vaultCards",
        sdk_py: "vault_cards",
        run: |_, _| Box::pin(async move { out(vault::cards()) }),
    },
    OwnerCommand {
        name: "vault_card_add",
        description: "Keeps a payment card the owner entered under a label (letters, digits and dashes) that agents' references name it by, vault:card:<label>:<field>. The expiry is MM/YY. Its security code is kept only while the vault keeps card security codes (keep_card_codes); otherwise none is, whatever is sent. Answers the card as vault_cards lists it, never its number, expiry, name or code.",
        input: || args(json!({ "label": s(), "number": s(), "expiry": s(), "name": s(), "cvv": { "type": ["string", "null"] } }), &["label", "number", "expiry", "name"]),
        returns: || r("VaultCard"),
        sdk_ts: "vaultCardAdd",
        sdk_py: "vault_card_add",
        run: |node, a| {
            Box::pin(async move {
                let label = arg::<String>(a, "label")?;
                let (number, expiry, name) = (needed_secret(a, "number")?, needed_secret(a, "expiry")?, needed_secret(a, "name")?);
                let cvv = secret_arg(a, "cvv")?;
                out(vault_card_add(node, &label, &number, &expiry, cvv.as_ref().map(|c| c.as_str()), &name)?)
            })
        },
    },
    OwnerCommand {
        name: "vault_card_remove",
        description: "Removes a payment card from the vault, with its limits; it can't be brought back.",
        input: || args(json!({ "card": s() }), &["card"]),
        returns: nothing,
        sdk_ts: "vaultCardRemove",
        sdk_py: "vault_card_remove",
        run: |node, a| {
            Box::pin(async move {
                let card = arg::<String>(a, "card")?;
                out(vault::remove_card(&node_vault(node)?, &card, "You")?)
            })
        },
    },
    // ---- passkeys ----
    OwnerCommand {
        name: "passkeys",
        description: "The passkeys the node keeps, whether it makes them, and the sites it never does.",
        input: none,
        returns: || r("Passkeys"),
        sdk_ts: "passkeys",
        sdk_py: "passkeys",
        run: |_, _| Box::pin(async move { out(serde_json::json!({ "on": passkey::enabled(), "never": passkey::never(), "passkeys": passkey::list() })) }),
    },
    OwnerCommand {
        name: "passkey_never",
        description: "Keeps passkeys off one site, or allows them there again, answering the site as the node keeps it.",
        input: || args(json!({ "site": s(), "never": { "type": ["boolean", "null"] } }), &["site"]),
        returns: s,
        sdk_ts: "passkeyNever",
        sdk_py: "passkey_never",
        run: |_, a| Box::pin(async move { out(passkey::set_never(&arg::<String>(a, "site")?, arg::<Option<bool>>(a, "never")?.unwrap_or(true))?) }),
    },
    OwnerCommand {
        name: "passkey_remove",
        description: "Deletes a kept passkey by its id.",
        input: || args(json!({ "id": s() }), &["id"]),
        returns: s,
        sdk_ts: "passkeyRemove",
        sdk_py: "passkey_remove",
        run: |_, a| Box::pin(async move { out(passkey::remove(&arg::<String>(a, "id")?, "You")?) }),
    },
    OwnerCommand {
        name: "passkey_enrol",
        description: "Keeps the next passkey a site makes for some minutes, in the node's browser for it or in another one at a DevTools address.",
        input: passkey_browser_args,
        returns: || r("PasskeyArmed"),
        sdk_ts: "passkeyEnrol",
        sdk_py: "passkey_enrol",
        run: |node, a| {
            Box::pin(async move {
                let (site, cdp, minutes) = (arg::<String>(a, "site")?, arg::<Option<String>>(a, "cdp")?, arg::<Option<u64>>(a, "minutes")?.unwrap_or(10));
                in_passkey_browser(node, site, cdp, minutes, true).await
            })
        },
    },
    OwnerCommand {
        name: "passkey_use",
        description: "Holds a site's passkeys in a browser the node doesn't run, at a DevTools address, answering how many it holds.",
        input: passkey_browser_args,
        returns: || json!({ "type": "object", "properties": { "held": { "type": "integer" } }, "required": ["held"], "additionalProperties": false }),
        sdk_ts: "passkeyUse",
        sdk_py: "passkey_use",
        run: |node, a| {
            Box::pin(async move {
                let (site, cdp, minutes) = (arg::<String>(a, "site")?, arg::<Option<String>>(a, "cdp")?, arg::<Option<u64>>(a, "minutes")?.unwrap_or(10));
                in_passkey_browser(node, site, cdp, minutes, false).await
            })
        },
    },
    // ---- the recovery phrase ----
    OwnerCommand {
        name: "wallet_phrase",
        description: "The node's recovery phrase, for the owner to write down and keep off this machine. 12 words are seed words: they open this node's wallet, the same address, in any wallet app, and bring the node back. 24 words are an older node's key: they bring back this node only, and its wallet goes into a wallet app through wallet_export.",
        input: none,
        returns: s,
        sdk_ts: "walletPhrase",
        sdk_py: "wallet_phrase",
        run: |node, _| Box::pin(async move { out(wallet_phrase(node)?) }),
    },
    OwnerCommand {
        name: "wallet_restore",
        description: "Brings back the root key its words make, keeping the key it replaces: 12 seed words, or an older node's 24 words.",
        input: || args(json!({ "words": s() }), &["words"]),
        returns: || r("Restored"),
        sdk_ts: "walletRestore",
        sdk_py: "wallet_restore",
        run: |node, a| Box::pin(async move { out(wallet_restore(node, arg(a, "words")?)?) }),
    },
    OwnerCommand {
        name: "wallet_export",
        description: "An encrypted backup of this node's key, its wallet with the identity, deposit, route coins and earnings on it, under the owner's passphrase (10 characters or more): an Ethereum keystore file, which any wallet that imports one also opens.",
        input: || args(json!({ "passphrase": s() }), &["passphrase"]),
        returns: || r("KeyBackup"),
        sdk_ts: "walletExport",
        sdk_py: "wallet_export",
        run: |node, a| Box::pin(async move { out(wallet_export(node, arg(a, "passphrase")?)?) }),
    },
    OwnerCommand {
        name: "wallet_import",
        description: "Brings back the key an encrypted backup holds, opened with its passphrase, on this machine or a new one, keeping the key it replaces. Sign in again after: a sign-in names the key it was made for.",
        input: || args(json!({ "backup": s(), "passphrase": s() }), &["backup", "passphrase"]),
        returns: || r("Restored"),
        sdk_ts: "walletImport",
        sdk_py: "wallet_import",
        run: |node, a| Box::pin(async move { out(wallet_import(node, arg(a, "backup")?, arg(a, "passphrase")?)?) }),
    },
    // ---- the owner's yes on a node with no screen ----
    OwnerCommand {
        name: "confirmations",
        description: "The questions a node with no screen to show a dialog on waits on the owner's yes for, each with its id and the seconds it has left: what `unbrowse-node confirm` shows on the owner's terminal.",
        input: none,
        returns: || list(json!({ "type": "object", "properties": { "id": s(), "question": s(), "seconds_left": { "type": "integer" } }, "required": ["id", "question", "seconds_left"], "additionalProperties": false })),
        sdk_ts: "confirmations",
        sdk_py: "confirmations",
        run: |_, _| Box::pin(async move { out(crate::owner_dialog::confirmations()) }),
    },
    OwnerCommand {
        name: "confirm",
        description: "Answers one of the questions confirmations lists: with the owner passphrase (set with `unbrowse-node passphrase`) it is allowed, with none it is refused. A wrong passphrase leaves it waiting, three times at most, and five wrong in a row lock every question for 15 minutes. `unbrowse-node confirm` sends it from the owner's terminal: never put the passphrase where an agent reads it.",
        input: || args(json!({ "id": s(), "passphrase": { "type": ["string", "null"] } }), &["id"]),
        returns: s,
        sdk_ts: "confirm",
        sdk_py: "confirm",
        run: |_, a| Box::pin(async move { out(crate::owner_dialog::confirm(arg(a, "id")?, arg(a, "passphrase")?).await?) }),
    },
    // ---- the chain and the wallet ----
    OwnerCommand {
        name: "chain_status",
        description: "Whether the chain is up, the network the node runs on, and the contracts it uses there.",
        input: none,
        returns: || r("ChainStatus"),
        sdk_ts: "chainStatus",
        sdk_py: "chain_status",
        run: |node, _| Box::pin(async move { out(chain_status(node)) }),
    },
    OwnerCommand {
        name: "wallet",
        description: "The owner's wallet on the chain: what it holds, the deposit, earnings and what is ready to take, and the node's fee and how it is split.",
        input: none,
        returns: || r("Wallet"),
        sdk_ts: "wallet",
        sdk_py: "wallet",
        run: |node, _| Box::pin(async move { out(wallet(node).await?) }),
    },
    OwnerCommand {
        name: "faucet",
        description: "Mints test USDC and test UNB to the owner, answering the transaction.",
        input: amount,
        returns: tx,
        sdk_ts: "faucet",
        sdk_py: "faucet",
        run: |node, a| Box::pin(async move { out(faucet(node, arg(a, "amount")?).await?) }),
    },
    OwnerCommand {
        name: "deposit",
        description: "Moves USDC from the wallet into the agents' deposit in Settlement, answering the transaction.",
        input: amount,
        returns: tx,
        sdk_ts: "deposit",
        sdk_py: "deposit",
        run: |node, a| Box::pin(async move { out(deposit(node, arg(a, "amount")?).await?) }),
    },
    OwnerCommand {
        name: "request_withdraw",
        description: "Asks to take USDC out of the deposit, which withdraw completes two epochs later.",
        input: amount,
        returns: tx,
        sdk_ts: "requestWithdraw",
        sdk_py: "request_withdraw",
        run: |node, a| Box::pin(async move { out(request_withdraw(node, arg(a, "amount")?).await?) }),
    },
    OwnerCommand {
        name: "withdraw",
        description: "Completes a withdrawal whose two epochs have passed, answering the transaction.",
        input: none,
        returns: tx,
        sdk_ts: "withdraw",
        sdk_py: "withdraw",
        run: |node, _| Box::pin(async move { out(withdraw(node).await?) }),
    },
    OwnerCommand {
        name: "chain_kept",
        description: "The writes the node signed that must not go twice (a deposit, a stake, a bounty post, a registration, a USDC send) whose fate it can't prove yet, each with whether what it would change reads otherwise than before, as the node's RPC reads it (a hint, never a proof). Each stays until its block proves it landed or didn't, or you let it go with chain_kept_release.",
        input: none,
        returns: || json!({ "type": "array", "items": { "type": "object" } }),
        sdk_ts: "chainKept",
        sdk_py: "chain_kept",
        run: |_, _| Box::pin(async move {
            let p = crate::rpc::ProviderBuilder::new().connect_http(crate::chain::url());
            out(crate::inflight::kept_views(&p).await?)
        }),
    },
    OwnerCommand {
        name: "chain_kept_release",
        description: "Forgets one kept write (by its key, from chain_kept) after you have checked on the chain that it never landed, so the node may send it again. Always asked in your own dialog: a write let go that may still land can be paid twice.",
        input: || args(json!({ "key": s() }), &["key"]),
        returns: || json!({ "type": "object" }),
        sdk_ts: "chainKeptRelease",
        sdk_py: "chain_kept_release",
        run: |_, a| Box::pin(async move { out(crate::inflight::let_go_by_owner(&arg::<String>(a, "key")?)?) }),
    },
    OwnerCommand {
        name: "wallet_send",
        description: "Sends USDC from the node's own address to an address the owner names, answering the transaction: the way on for a withdrawal or earnings paid to the node with no linked wallet, which the node otherwise keeps out of the deposit. Where USDC is the chain's gas it keeps what a full claim batch needs.",
        input: || args(json!({ "to": s(), "amount": num() }), &["to", "amount"]),
        returns: tx,
        sdk_ts: "walletSend",
        sdk_py: "wallet_send",
        run: |node, a| Box::pin(async move { out(wallet_send(node, arg(a, "to")?, arg(a, "amount")?).await?) }),
    },
    OwnerCommand {
        name: "earnings",
        description: "What the wallet earned, by where it came from, in USDC: from staking route coins (its staked, checked coins' part of each fetch on their entries), as a contributor (route shares the fetch owed it for lines on its entries with no coin), each claimed and still to take; the route share its entries' lines sent to their coins (the coins' money, paid to whoever stakes them); and the USDC waiting in all. Claims are paid whole: nothing vests.",
        input: none,
        returns: || r("Earnings"),
        sdk_ts: "earnings",
        sdk_py: "earnings",
        run: |node, _| Box::pin(async move { out(earnings::of(&node.chain, chain::owner_address(node.key()?)?).await?) }),
    },
    OwnerCommand {
        name: "collect_earnings",
        description: "Takes everything waiting for the wallet: each route coin's stake earnings in USDC and the route shares the fetch owes it as a contributor. Answers the transactions.",
        input: none,
        returns: || list(s()),
        sdk_ts: "collectEarnings",
        sdk_py: "collect_earnings",
        run: |node, _| {
            Box::pin(async move {
                let txs = earnings::collect_all(&node.chain, node.key()?).await?;
                node.events.emit("activity", ());
                out(txs)
            })
        },
    },
    // ---- route coins (spec ch. 6): a paid fetch buys and stakes its entry's coin for the payer by itself; these are
    // the owner's own word ----
    OwnerCommand {
        name: "coin_holdings",
        description: "What the wallet holds in route coins, per coin: its entry, the coin's state, unstaked coins, each staked lot (exit delay, earning, pending, asked back and when ready), what its stake earned to claim, USDC a fetch paid whose buy is parked, whether the wallet checked the entry and its latest paid call passed (both needed for its stake to earn and count), and the coin's price; the route shares the fetch owes it as a contributor, and the exit delay its fetches stake with.",
        input: none,
        returns: || r("Holdings"),
        sdk_ts: "coinHoldings",
        sdk_py: "coin_holdings",
        run: |node, _| Box::pin(async move { out(chain::coins::holdings(&node.chain, node.key()?).await?) }),
    },
    OwnerCommand {
        name: "coin_launch",
        description: "Launches the route coin of an entry this wallet is credited with (its id, `entry`), with its first buy of `unb` UNB from the wallet, untaxed, for the wallet: only the entry's credited contributor may. Never sent twice while one may still land.",
        input: || args(json!({ "entry": s(), "unb": num() }), &["entry", "unb"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinLaunch",
        sdk_py: "coin_launch",
        run: |node, a| Box::pin(async move { out(coin_done(node, chain::coins::launch(&node.chain, node.key()?, entry_arg(a, "entry")?, arg(a, "unb")?).await).await?) }),
    },
    OwnerCommand {
        name: "coin_buy",
        description: "Buys an entry's coin with `unb` of the wallet's UNB, on its curve, for at least its quote now less 1%. The coins arrive unstaked: coin_stake stakes them. Only the owner's word buys a coin (`coin.stake`).",
        input: || args(json!({ "entry": s(), "unb": num() }), &["entry", "unb"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinBuy",
        sdk_py: "coin_buy",
        run: |node, a| Box::pin(async move { out(coin_done(node, chain::coins::buy(&node.chain, node.key()?, entry_arg(a, "entry")?, arg(a, "unb")?).await).await?) }),
    },
    OwnerCommand {
        name: "coin_sell",
        description: "Sells `coins` of the wallet's unstaked coins of an entry, for at least the quote now less 1% (staked coins are asked back first, coin_unstake). Only the owner's word sells a coin.",
        input: || args(json!({ "entry": s(), "coins": num() }), &["entry", "coins"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinSell",
        sdk_py: "coin_sell",
        run: |node, a| Box::pin(async move { out(coin_done(node, chain::coins::sell(&node.chain, node.key()?, entry_arg(a, "entry")?, arg(a, "coins")?).await).await?) }),
    },
    OwnerCommand {
        name: "coin_stake",
        description: "Stakes `coins` of the wallet's unstaked coins of an entry in its lot of exit `delay` seconds (null: 24 hours, `route_coin.unstake_delay`). They earn from the next epoch close once the wallet has checked the entry, and count in the entry's rank by their delay while the wallet's own latest paid call on it passed.",
        input: || args(json!({ "entry": s(), "coins": num(), "delay": { "type": ["integer", "null"], "minimum": 1 } }), &["entry", "coins"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinStake",
        sdk_py: "coin_stake",
        run: |node, a| {
            Box::pin(async move {
                let delay = arg::<Option<u64>>(a, "delay")?.unwrap_or(crate::rank::coin::DEFAULT_EXIT_DELAY);
                out(coin_done(node, chain::coins::stake(&node.chain, node.key()?, entry_arg(a, "entry")?, arg(a, "coins")?, delay).await).await?)
            })
        },
    },
    OwnerCommand {
        name: "coin_unstake",
        description: "Asks `coins` back from the wallet's lot of exit `delay` seconds in an entry's coin: they stop earning and counting at once, and coin_withdraw takes them back after that lot's delay.",
        input: || args(json!({ "entry": s(), "delay": { "type": "integer", "minimum": 1 }, "coins": num() }), &["entry", "delay", "coins"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinUnstake",
        sdk_py: "coin_unstake",
        run: |node, a| Box::pin(async move { out(coin_done(node, chain::coins::request_unstake(&node.chain, node.key()?, entry_arg(a, "entry")?, arg(a, "delay")?, arg(a, "coins")?).await).await?) }),
    },
    OwnerCommand {
        name: "coin_withdraw",
        description: "Takes back the coins asked back from the wallet's lot of exit `delay` seconds in an entry's coin, once ready.",
        input: || args(json!({ "entry": s(), "delay": { "type": "integer", "minimum": 1 } }), &["entry", "delay"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinWithdraw",
        sdk_py: "coin_withdraw",
        run: |node, a| Box::pin(async move { out(coin_done(node, chain::coins::withdraw_coins(&node.chain, node.key()?, entry_arg(a, "entry")?, arg(a, "delay")?).await).await?) }),
    },
    OwnerCommand {
        name: "coin_claim",
        description: "Claims what the wallet's stake in an entry's coin earned from fetches, in USDC.",
        input: || args(json!({ "entry": s() }), &["entry"]),
        returns: || r("CoinDone"),
        sdk_ts: "coinClaim",
        sdk_py: "coin_claim",
        run: |node, a| Box::pin(async move { out(coin_done(node, chain::coins::claim_earned(&node.chain, node.key()?, entry_arg(a, "entry")?).await).await?) }),
    },
    OwnerCommand {
        name: "coin_fetch_delay",
        description: "The exit delay, in seconds, the coins a paid fetch (or a bounty) buys for this wallet are staked with (`coin.fetch-stakes`); with `delay` it sets it on the chain, null only reads it. 24 hours until set.",
        input: || args(json!({ "delay": { "type": ["integer", "null"], "minimum": 1 } }), &[]),
        returns: || json!({ "type": "object", "properties": { "delay": { "type": "integer" }, "tx": { "type": ["string", "null"] } } }),
        sdk_ts: "coinFetchDelay",
        sdk_py: "coin_fetch_delay",
        run: |node, a| {
            Box::pin(async move {
                let tx = match arg::<Option<u64>>(a, "delay")? {
                    Some(d) => Some(done(node, chain::coins::set_fetch_delay(&node.chain, node.key()?, d).await).await?),
                    None => None,
                };
                out(json!({ "delay": chain::coins::fetch_delay(&node.chain, node.key()?).await?, "tx": tx }))
            })
        },
    },
    OwnerCommand {
        name: "coin_dev_buy",
        description: "The listing's first buy: once an entry of this wallet's is credited, the node launches its coin with this share of the wallet's UNB at that moment, in basis points, and stakes the coins for the owner (`decide.dev-buy-default-on`). 100 (1%) by default; 0 turns it off. A wallet with no UNB, or too little for the curve to sell anything, launches nothing, and the route still lists. With `bps` it sets it (raising it past the default is asked in the owner's dialog: it spends UNB by itself); null only reads it.",
        input: || args(json!({ "bps": { "type": ["integer", "null"], "minimum": 0, "maximum": 10_000 } }), &[]),
        returns: || json!({ "type": "object", "properties": { "bps": { "type": "integer" } } }),
        sdk_ts: "coinDevBuy",
        sdk_py: "coin_dev_buy",
        run: |node, a| {
            Box::pin(async move {
                let set = match arg::<Option<u32>>(a, "bps")? {
                    Some(bps) => set_coin_dev_buy(bps)?,
                    None => DevBuy { bps: store::load_settings().coin_dev_buy_bps },
                };
                node.events.emit("activity", ());
                out(set)
            })
        },
    },
    OwnerCommand {
        name: "coin_rank",
        description: "Entries' ranks as this node computes them from the chain (`rank.score`: the square root of their counted stake's collateral value times their coin's time-weighted market cap, in UNB; 0 is no rank), with the counted stake, collateral, market cap and price each was valued at. A pick goes to entries in proportion to their rank, keeping 5% of reads for entries with none.",
        input: || args(json!({ "entries": { "type": "array", "items": s() } }), &["entries"]),
        returns: || json!({ "type": "object", "additionalProperties": { "type": "object" } }),
        sdk_ts: "coinRank",
        sdk_py: "coin_rank",
        run: |node, a| {
            Box::pin(async move {
                let ids: Vec<String> = arg(a, "entries")?;
                let ids: Vec<alloy::primitives::FixedBytes<32>> = ids.iter().filter_map(|e| e.trim().parse().ok()).collect();
                let got = chain::coins::ranks(&node.chain, &ids, chain::coins::RANK_WAIT).await;
                out(got.into_iter().map(|(e, r)| (format!("{e:#x}"), r)).collect::<std::collections::BTreeMap<_, _>>())
            })
        },
    },
    // ---- domains (R4.14) ----
    OwnerCommand {
        name: "domain_status",
        description: "The wallet a domain's DNSSEC proof names, when its escrow is released, and the escrow. A domain is proven by DNSSEC only; one without DNSSEC can't be proven, its site share waits in escrow, and the answer's note says so.",
        input: || args(json!({ "domain": s() }), &["domain"]),
        returns: || r("DomainStatus"),
        sdk_ts: "domainStatus",
        sdk_py: "domain_status",
        run: |node, a| Box::pin(async move { out(domains::status(node, arg(a, "domain")?).await?) }),
    },
    OwnerCommand {
        name: "advance_day",
        description: "Moves the devnet's clock one epoch forward.",
        input: none,
        returns: nothing,
        sdk_ts: "advanceDay",
        sdk_py: "advance_day",
        run: |node, _| Box::pin(async move { out(advance_day(node).await?) }),
    },
    OwnerCommand {
        name: "list_route",
        description: "Lists a route on the network at the node's fee, so other nodes' agents can fetch it. A route whose site opted out of Unbrowse in its robots rules (a User-agent: Unbrowse group disallowing its path) isn't listed.",
        input: route_id,
        returns: || r("KeptRoute"),
        sdk_ts: "listRoute",
        sdk_py: "list_route",
        run: |node, a| Box::pin(async move { out(list_route(node, arg(a, "id")?).await?.shown()) }),
    },
    OwnerCommand {
        name: "set_pricing",
        description: "Sets the node's one fee for all its routes, in USDC, and whether demand may move it between a floor and a ceiling.",
        input: || args(json!({ "fee": num(), "auto": yes(), "floor": num(), "ceiling": num() }), &["fee", "auto", "floor", "ceiling"]),
        returns: || r("Pricing"),
        sdk_ts: "setPricing",
        sdk_py: "set_pricing",
        run: |node, a| Box::pin(async move { out(set_pricing(node, arg(a, "fee")?, arg(a, "auto")?, arg(a, "floor")?, arg(a, "ceiling")?).await?) }),
    },
    OwnerCommand {
        name: "delist_route",
        description: "Delists a route and keeps it off the network until it is shared again.",
        input: route_id,
        returns: || r("KeptRoute"),
        sdk_ts: "delistRoute",
        sdk_py: "delist_route",
        run: |node, a| Box::pin(async move { out(delist_route(node, arg(a, "id")?).await?.shown()) }),
    },
    OwnerCommand {
        name: "routes_on_chain",
        description: "What the chain says of each kept route: whether it is listed and live, its fee, whether this node holds it to serve, its entry's route coin, the owner's coins of it (staked and unstaked), and the entry's rank.",
        input: none,
        returns: || list(r("RouteChain")),
        sdk_ts: "routesOnChain",
        sdk_py: "routes_on_chain",
        run: |node, _| Box::pin(async move { out(routes_on_chain(node).await?) }),
    },
    OwnerCommand {
        name: "agents_spend",
        description: "What each agent key has spent this epoch, against its cap.",
        input: none,
        returns: || list(r("AgentSpend")),
        sdk_ts: "agentsSpend",
        sdk_py: "agents_spend",
        run: |node, _| Box::pin(async move { out(agents_spend(node).await?) }),
    },
    OwnerCommand {
        name: "claim_now",
        description: "Claims what the node's routes earned this epoch and the last, worth its gas or not, answering how many claims went through.",
        input: none,
        returns: || json!({ "type": "integer" }),
        sdk_ts: "claimNow",
        sdk_py: "claim_now",
        run: |node, _| Box::pin(async move { out(claim_now(node).await?) }),
    },
    OwnerCommand {
        name: "board",
        description: "The contributors' leaderboard, from the chain's own logs.",
        input: none,
        returns: || list(r("BoardRow")),
        sdk_ts: "board",
        sdk_py: "board",
        run: |node, _| Box::pin(async move { out(board(node).await?) }),
    },
    OwnerCommand {
        name: "entries",
        description: "Every route listed on the chain with its live entries, the default first and unverified ones tagged, ranked by this node from the chain's own record. `site` keeps one site's.",
        input: || args(json!({ "site": s() }), &[]),
        returns: || list(r("RouteEntries")),
        sdk_ts: "entries",
        sdk_py: "entries",
        run: |node, a| Box::pin(async move { out(crate::api::entries(node, arg::<Option<String>>(a, "site")?.as_deref()).await?) }),
    },
    OwnerCommand {
        name: "open_link",
        description: "What an unbrowse:// link names: a site's routes, or one route. Calls nothing and pays nothing. A link can come from any page, so by default only this node's own routes are shown and the peer network is asked nothing; `ask_network`, sent when the owner clicks for more, also shows the routes the network lists and the chain proves.",
        input: || args(json!({ "link": s(), "ask_network": { "type": ["boolean", "null"] } }), &["link"]),
        returns: || r("LinkPreview"),
        sdk_ts: "openLink",
        sdk_py: "open_link",
        run: |node, a| Box::pin(async move {
            let network = arg::<Option<bool>>(a, "ask_network")?.unwrap_or(false);
            out(crate::api::do_open(node, &arg::<String>(a, "link")?, network).await.map_err(|(_, why)| why)?)
        }),
    },
    // ---- agents' bug reports, which wait for the owner ----
    OwnerCommand {
        name: "reports_waiting",
        description: "The bug reports agents wrote that wait for the owner: each with its fingerprint, when it was written, and what it would be filed with as a public issue. Nothing an agent writes is sent until the owner sends it.",
        input: none,
        returns: || list(json!({ "type": "object", "properties": { "fingerprint": s(), "at": { "type": "integer" }, "contents": r("ReportContents"),
            "scrubbed": { "type": "object", "additionalProperties": { "type": "integer" } } }, "required": ["fingerprint", "at", "contents", "scrubbed"], "additionalProperties": false })),
        sdk_ts: "reportsWaiting",
        sdk_py: "reports_waiting",
        run: |_, _| Box::pin(async move { out(crate::report::waiting()) }),
    },
    OwnerCommand {
        name: "report_send",
        description: "Sends an agent's waiting bug report, as it waits, to be filed as a public issue: asked in the node's own dialog, which shows the report's text.",
        input: || args(json!({ "fingerprint": s() }), &["fingerprint"]),
        returns: || r("ReportResult"),
        sdk_ts: "reportSend",
        sdk_py: "report_send",
        run: |_, a| Box::pin(async move { out(crate::report::send_waiting(&arg::<String>(a, "fingerprint")?).await?) }),
    },
    OwnerCommand {
        name: "report_discard",
        description: "Drops an agent's waiting bug report unsent.",
        input: || args(json!({ "fingerprint": s() }), &["fingerprint"]),
        returns: nothing,
        sdk_ts: "reportDiscard",
        sdk_py: "report_discard",
        run: |_, a| Box::pin(async move { out(crate::report::discard_waiting(&arg::<String>(a, "fingerprint")?)?) }),
    },
    // ---- checkouts the owner is paying in: held until they say finished or dismissed ----
    OwnerCommand {
        name: "checkout_holds",
        description: "The sites held for a card checkout: from the moment the owner is asked about a card for a site until they say the checkout is finished or dismissed, no agent command reaches the site, nor any host the checkout names (its frames, its forms' actions, what its pages submitted to), and no route, heal or shared route of the node is sent there. While any checkout is held, the node also calls no route of any method on any site, runs no agent command in any page of any site but close and the tab's address and title, pauses the agent's other open pages, and its browsers reach only the held hosts (the checkout's own browser reaches any). Each with the hosts held (at most 8 besides the site; `more` counts those it named past them), since when, when the owner is next reminded (once a day: time never ends a hold), and what the owner should be told.",
        input: none,
        returns: || list(json!({ "type": "object", "properties": { "site": s(), "hosts": list(s()), "since": { "type": "integer" }, "remind_at": { "type": "integer" }, "warnings": list(s()), "more": { "type": "integer" } }, "required": ["site", "hosts", "since", "remind_at", "warnings", "more"], "additionalProperties": false })),
        sdk_ts: "checkoutHolds",
        sdk_py: "checkout_holds",
        run: |_, _| Box::pin(async move { out(crate::payhold::list()?) }),
    },
    OwnerCommand {
        name: "checkout_release",
        description: "The owner says a held checkout is finished or dismissed (site `*`: every one), and agents may act on the site again. Only the owner ends a hold: asked in the node's own dialog, never by an agent.",
        input: || args(json!({ "site": s(), "how": { "type": "string", "enum": ["finished", "dismissed"] } }), &["site", "how"]),
        returns: || json!({ "type": "integer" }),
        sdk_ts: "checkoutRelease",
        sdk_py: "checkout_release",
        run: |_, a| Box::pin(async move { out(crate::payhold::release_by(&arg::<String>(a, "site")?, &arg::<String>(a, "how")?)?) }),
    },
    // ---- bounties (spec ch. 8): UNB posted for a site no route answers yet, as a limit order ----
    OwnerCommand {
        name: "bounty_post",
        description: "Posts `amount` of the wallet's UNB for `site` (example.com), with the most it pays a coin, fees and tax included (`limit`, UNB; null buys at market), open for `days` (null: 30). The owner releases it by confirming an entry of the site once its own paid call on that entry passed and was claimed (bounty_confirm), which buys that entry's coin once it trades, half staked for its contributor and half for the owner; after the deadline the site's use by others releases at most 5% of the USDC their lines paid, and the rest is the owner's to take back (bounty_refund). Never sent twice while one may still land.",
        input: || args(json!({ "site": s(), "amount": num(), "limit": { "type": ["number", "null"] }, "days": { "type": ["number", "null"] } }), &["site", "amount"]),
        returns: || r("BountyDone"),
        sdk_ts: "bountyPost",
        sdk_py: "bounty_post",
        run: |node, a| {
            Box::pin(async move {
                let days = arg::<Option<f64>>(a, "days")?.unwrap_or((chain::BOUNTY_OPEN / 86_400) as f64);
                if !(days > 0.0) || !days.is_finite() {
                    return Err(OwnerError::Failed("days: a bounty stays open for some days above zero".into()));
                }
                out(bounty::post(node, arg(a, "site")?, arg(a, "amount")?, arg(a, "limit")?, (days * 86_400.0) as u64).await?)
            })
        },
    },
    OwnerCommand {
        name: "bounty_confirm",
        description: "Confirms one of the owner's bounties for an entry of its site (`entry`), once the owner's own paid call on that entry passed and was claimed as a counting line since posting: it buys the entry's coin at once within the bounty's limit, paying at most the curve's quote with 1% slippage, read when the confirmation was allowed and never raised for a retry, or, with no cap kept (the bounty steps off, or allowed before the coin traded), the quote when it is sent, with the same slippage (`maxCost`: a price pushed since makes it fail, and nothing is spent: price moved: wait, or post the bounty again with a limit), half staked for the contributor and half for the owner. Refused before then, for an entry whose coin isn't launched yet (a bounty never launches one), and while the coin is in its snipe window, with nothing spent. A lister has to launch by the bounty's deadline (and its snipe window pass before it) for a confirmation, and by the deadline to get a share by use. The node confirms on its own only with a cap kept from the owner's yes: one allowed before the entry's coin traded needs a hand confirm (`bounty confirm`), or posting the bounty again with a limit. Never sent twice.",
        input: || args(json!({ "id": bounty_id(), "entry": s() }), &["id", "entry"]),
        returns: || r("BountyDone"),
        sdk_ts: "bountyConfirm",
        sdk_py: "bounty_confirm",
        run: |node, a| Box::pin(async move { out(bounty::confirm(node, arg(a, "id")?, entry_arg(a, "entry")?).await?) }),
    },
    OwnerCommand {
        name: "bounty_settle",
        description: "After a bounty's deadline, fixes what its site's use by others releases (at most 5% of the USDC their counting lines paid while it was open, never more than the bounty); the rest becomes the poster's. Anyone may.",
        input: || args(json!({ "id": bounty_id() }), &["id"]),
        returns: || r("BountyDone"),
        sdk_ts: "bountySettle",
        sdk_py: "bounty_settle",
        run: |node, a| Box::pin(async move { out(bounty::settle(node, arg(a, "id")?).await?) }),
    },
    OwnerCommand {
        name: "bounty_release",
        description: "Releases an entry's share of a settled bounty by use (`entry`), in proportion to the USDC its lines paid while it was open: it buys the entry's coin within the bounty's limit, and only while the coin's price is steady (within 1% of its 15-minute mean and of its settled price), else it is refused and can be sent again later. What the limit doesn't fill stays the entry's, for a later release. The share of an entry that had no coin when the bounty was settled goes to the poster to take back (bounty_refund), even if its coin launched since: a bounty never launches a coin. A lister has to launch by the bounty's deadline to get the share. Anyone may.",
        input: || args(json!({ "id": bounty_id(), "entry": s() }), &["id", "entry"]),
        returns: || r("BountyDone"),
        sdk_ts: "bountyRelease",
        sdk_py: "bounty_release",
        run: |node, a| Box::pin(async move { out(bounty::release(node, arg(a, "id")?, entry_arg(a, "entry")?).await?) }),
    },
    OwnerCommand {
        name: "bounty_refund",
        description: "Takes back what is the owner's of one of its bounties: what a confirmation didn't fill, and after its deadline (settling it first) what nobody's use reserved.",
        input: || args(json!({ "id": bounty_id() }), &["id"]),
        returns: || r("BountyDone"),
        sdk_ts: "bountyRefund",
        sdk_py: "bounty_refund",
        run: |node, a| Box::pin(async move { out(bounty::refund(node, arg(a, "id")?).await?) }),
    },
    OwnerCommand {
        name: "bounty_list",
        description: "Every bounty on the network, newest first, each with its site, amount, limit, deadline, state (open, to settle, confirmed, settled), what use reserved and what its poster may take back; `mine` keeps the owner's own.",
        input: || args(json!({ "mine": { "type": ["boolean", "null"] } }), &[]),
        returns: || list(r("BountyView")),
        sdk_ts: "bountyList",
        sdk_py: "bounty_list",
        run: |node, a| Box::pin(async move { out(bounty::list(node, arg::<Option<bool>>(a, "mine")?.unwrap_or(false)).await?) }),
    },
    OwnerCommand {
        name: "bounty_show",
        description: "One bounty: its site, amount, limit, deadline, state, what use reserved and what its poster may take back.",
        input: || args(json!({ "id": bounty_id() }), &["id"]),
        returns: || r("BountyView"),
        sdk_ts: "bountyShow",
        sdk_py: "bounty_show",
        run: |node, a| Box::pin(async move { out(bounty::show(node, arg(a, "id")?).await?) }),
    },
    OwnerCommand {
        name: "bounty_auto",
        description: "Whether the node takes the bounty steps for the owner, off until the owner turns them on: it asks the owner's agent, in the reply of its passed call on an entry of an open bounty's site, whether the entry answers the bounty; on the agent's yes and then the owner's own, it confirms the bounty once that call's line is claimed. Either way it settles the owner's bounties past their deadline, takes back what is the owner's, and releases by use the shares of entries the owner lists. `on` sets it; null only reads it. The other bounty commands work either way.",
        input: || args(json!({ "on": { "type": ["boolean", "null"] } }), &[]),
        returns: || r("BountyAuto"),
        sdk_ts: "bountyAuto",
        sdk_py: "bounty_auto",
        run: |_, a| Box::pin(async move { out(bounty::auto(arg::<Option<bool>>(a, "on")?)?) }),
    },
    // ---- the owner's hands on a site's browser: its live picture, clicks and keys passed on, and giving it back ----
    OwnerCommand {
        name: "hands",
        description: "The sites' browsers the owner can take over, the agents' asks waiting on them, and the site being watched.",
        input: none,
        returns: || r("Hands"),
        sdk_ts: "hands",
        sdk_py: "hands",
        run: |_, _| Box::pin(async move { out(hands::list().await) }),
    },
    OwnerCommand {
        name: "hands_watch",
        description: "Shows a site's page: its pictures come as hands_frame events.",
        input: || args(json!({ "site": s() }), &["site"]),
        returns: || r("HandsPage"),
        sdk_ts: "handsWatch",
        sdk_py: "hands_watch",
        run: |node, a| Box::pin(async move { out(hands::watch(&arg::<String>(a, "site")?, &node.events).await?) }),
    },
    OwnerCommand {
        name: "hands_stop",
        description: "Stops the pictures; a page the owner has stays theirs.",
        input: none,
        returns: empty,
        sdk_ts: "handsStop",
        sdk_py: "hands_stop",
        run: |_, _| {
            Box::pin(async move {
                hands::stop();
                out(serde_json::json!({}))
            })
        },
    },
    OwnerCommand {
        name: "hands_input",
        description: "A click, scroll, text or key on the watched page; the first click or key takes the page from the agents until it is given back.",
        // The input's own fields sit beside the site, as `hands::input` reads them.
        input: || json!({ "allOf": [args(json!({ "site": s() }), &["site"]), r("HandsInput")] }),
        returns: || r("HandsPage"),
        sdk_ts: "handsInput",
        sdk_py: "hands_input",
        run: |node, a| Box::pin(async move { out(hands::input(&arg::<String>(a, "site")?, a, &node.events).await?) }),
    },
    OwnerCommand {
        name: "payment_approver",
        description: "Who approves a card payment an agent waits on: `dialog` (the default: the owner's yes in the node's dialog, or by passphrase) or `sdk` (`hands_give_back` naming the ask approves it with no dialog, for an owner who answers on another device, such as the daemon hub's Telegram bot). Card payments only: the recovery phrase, vault passwords, spend caps and wallets still wait on the dialog. Turning `sdk` on asks the owner first, in the dialog; `dialog` asks nothing. `approver` sets it; null only reads it.",
        input: || args(json!({ "approver": { "type": ["string", "null"], "enum": ["dialog", "sdk", null] } }), &[]),
        returns: || r("PaymentApprover"),
        sdk_ts: "paymentApprover",
        sdk_py: "payment_approver",
        run: |node, a| Box::pin(async move {
            let keys = node.key()?;
            match arg::<Option<String>>(a, "approver")? {
                Some(to) => out(crate::owner_dialog::set_payment_approver(keys, &to, "You")?),
                None => out(crate::owner_dialog::payment_approver(Some(keys as &dyn unbrowse_core::KeyStore))),
            }
        }),
    },
    OwnerCommand {
        name: "remote_answers",
        description: "Whether an agent's ask for the owner (a sign-in, a two-step code) may be answered from another device through the owner SDK, such as the daemon hub's Telegram bot: off by default. With it on, an ask reaches the owner while such a device keeps calling this command with `via` (within 30 s), though no window is open on the machine, and `hands_answer` types the code they send into the page. Turning it on asks the owner first, in the node's dialog; off asks nothing. `on` sets it; null only reads it. `via` names the device that is there (\"Telegram\").",
        input: || args(json!({ "on": { "type": ["boolean", "null"] }, "via": { "type": ["string", "null"] } }), &[]),
        returns: || json!({ "type": "object", "properties": { "on": { "type": "boolean" }, "since": { "type": "integer" } }, "required": ["on"], "additionalProperties": false }),
        sdk_ts: "remoteAnswers",
        sdk_py: "remote_answers",
        run: |node, a| Box::pin(async move {
            let keys = node.key()?;
            let now = match arg::<Option<bool>>(a, "on")? {
                Some(on) => crate::owner_dialog::set_remote_answers(keys, on, "You")?,
                None => crate::owner_dialog::remote_answers(Some(keys as &dyn unbrowse_core::KeyStore)),
            };
            if now.on && arg::<Option<String>>(a, "via")?.is_some_and(|v| !v.trim().is_empty()) {
                hands::away_seen();
            }
            out(now)
        }),
    },
    OwnerCommand {
        name: "hands_answer",
        description: "Answers an agent's ask with what the owner sent from another device (`remote_answers` on): `text`, a two-step code, is typed into the page's code field as the owner's own typing, said as [typed by the owner] in anything the browser returns to an agent and kept out of the walk record, then Enter is pressed (`submit` false skips it) and the page is given back with done. `ask` names the ask (`hands` lists them); one that no longer waits, or is a card payment, is refused and nothing is typed. The code is never logged or answered.",
        input: || args(json!({ "site": s(), "ask": s(), "text": s(), "submit": { "type": ["boolean", "null"] }, "via": { "type": ["string", "null"] } }), &["site", "ask", "text"]),
        returns: || json!({ "type": "object", "properties": { "site": s(), "answered": { "type": "integer" }, "field": s() }, "required": ["site", "answered", "field"], "additionalProperties": false }),
        sdk_ts: "handsAnswer",
        sdk_py: "hands_answer",
        run: |node, a| Box::pin(async move {
            let (site, ask, text) = (arg::<String>(a, "site")?, arg::<String>(a, "ask")?, arg::<String>(a, "text")?);
            let via = arg::<Option<String>>(a, "via")?.map(|v| crate::owner_dialog::plain(&v).replace('\n', " ").trim().chars().take(40).collect::<String>()).filter(|v| !v.is_empty());
            let submit = arg::<Option<bool>>(a, "submit")?.unwrap_or(true);
            if !crate::owner_dialog::remote_answers(node.key().ok().map(|k| k as &dyn unbrowse_core::KeyStore)).on {
                return Err(OwnerError::Failed("answering asks from another device is off: the owner turns it on at the machine (`remote_answers` on, which asks in the dialog). Nothing was typed".into()));
            }
            out(hands::answer_code(&site, &ask, &text, submit, via.as_deref().unwrap_or("another device"), &node.events).await?)
        }),
    },
    OwnerCommand {
        name: "hands_give_back",
        description: "Gives a page back to the agents, telling the one that asked whether the owner did what it needed. `ask` names the ask answered (`hands` lists them): refused when that ask no longer waits, and, with `payment_approver` set to sdk, what lets done approve that ask's card payment without the node's dialog. `via` says where the owner answered (\"Telegram\"), for the activity they read.",
        input: || args(json!({ "site": s(), "done": { "type": ["boolean", "null"] }, "ask": { "type": ["string", "null"] }, "via": { "type": ["string", "null"] } }), &["site"]),
        returns: || {
            json!({ "type": "object", "properties": { "site": s(), "answered": { "type": "integer" } }, "required": ["site", "answered"], "additionalProperties": false })
        },
        sdk_ts: "handsGiveBack",
        sdk_py: "hands_give_back",
        run: |node, a| {
            Box::pin(async move {
                let how = if arg::<Option<bool>>(a, "done")?.unwrap_or(true) { hands::Answer::Done } else { hands::Answer::Declined };
                let site = arg::<String>(a, "site")?;
                // An answer naming its ask answers that one: given after it lapsed, it would answer whatever asks
                // there now, which the owner never saw.
                let ask = arg::<Option<String>>(a, "ask")?;
                if let Some(id) = &ask {
                    if !hands::asks().iter().any(|x| x.site == site && &x.id == id) {
                        return Err(OwnerError::Failed(format!("the ask {} on {site} isn't waiting any more (it was answered or it lapsed): nothing was done", crate::owner_dialog::plain(id).chars().take(60).collect::<String>())));
                    }
                }
                // With the owner SDK set to approve card payments (`payment_approver`, turned on with the owner's yes
                // in the dialog), done naming a waiting payment's ask approves that payment, and only it, with no
                // dialog: the owner answered on another device. Logged where the owner reads it.
                if how == hands::Answer::Done {
                    if let Some(pay) = ask.as_deref().and_then(|id| hands::payment_asked(&site, id)) {
                        if crate::owner_dialog::sdk_approves_payments(node.key().ok().map(|k| k as &dyn unbrowse_core::KeyStore)) {
                            let via = arg::<Option<String>>(a, "via")?.map(|v| crate::owner_dialog::plain(&v).replace('\n', " ").trim().chars().take(40).collect::<String>()).filter(|v| !v.is_empty());
                            store::log_activity(&store::Activity {
                                at: store::now(),
                                who: "You".into(),
                                site: site.clone(),
                                what: format!("Approved paying with {} on {} from {}, without the dialog (payment approver: sdk)", pay.card, pay.merchant, via.as_deref().unwrap_or("the owner SDK")),
                                kind: "vault".into(),
                                result: "done".into(),
                                ms: None,
                                unb: None,
                                tx: None,
                                note: None,
                            });
                            return out(hands::give_back_approving(&site, how, Some(&pay), &node.events).await?);
                        }
                    }
                }
                // Done, while a card payment waits there, approves that payment: the window's button and anything
                // else holding the owner token send this same command, so the yes is the owner's own, in the node's
                // dialog, and it approves the payment it named and no other (external security review round 4, H5).
                if how == hands::Answer::Done {
                    if let Some(pay) = hands::payment_waiting(&site) {
                        crate::owner_dialog::ask(node.key().ok(), hands::payment_question(&pay)).await.map_err(OwnerError::Failed)?;
                        return out(hands::give_back_approving(&site, how, Some(&pay), &node.events).await?);
                    }
                }
                out(hands::give_back(&site, how, &node.events).await?)
            })
        },
    },
    // ---- the browser and updates ----
    OwnerCommand {
        name: "browsers",
        description: "The browser the node walks and browses in, the Chromium browsers on this machine it could use instead, its browser program, and whether it has its browser (state) and fetches it when needed (fetch).",
        input: none,
        returns: || r("Browsers"),
        sdk_ts: "browsers",
        sdk_py: "browsers",
        run: |_, _| Box::pin(async move { out(browsers::view()) }),
    },
    OwnerCommand {
        name: "import_session",
        description: "Takes a site's cookies from the owner's browsers on this machine (the Chromium browsers first, then Firefox and Safari, the first that holds the site's session kept whole) into the node's session for it, answering how many it kept.",
        input: || args(json!({ "host": s() }), &["host"]),
        returns: || json!({ "type": "object", "properties": { "cookies": { "type": "integer" } }, "required": ["cookies"], "additionalProperties": false }),
        sdk_ts: "importSession",
        sdk_py: "import_session",
        // Off the node's runtime: an import drives a browser, and starts a runtime of its own to do it.
        run: |_, a| Box::pin(async move {
            let host = arg::<String>(a, "host")?;
            let kept = tokio::task::spawn_blocking(move || import::session(&host)).await.map_err(|e| e.to_string())??;
            out(serde_json::json!({ "cookies": kept.cookies }))
        }),
    },
    OwnerCommand {
        name: "update_status",
        description: "The node's own updates: the version running, the newest out, and one waiting to restart into.",
        input: none,
        returns: || r("UpdateStatus"),
        sdk_ts: "updateStatus",
        sdk_py: "update_status",
        run: |_, _| Box::pin(async move { out(update::status()) }),
    },
    OwnerCommand {
        name: "update_now",
        description: "Checks for a newer release on the node's channel now, whether or not updates are on, and restarts into it once no call is under way.",
        input: none,
        returns: || r("UpdateStatus"),
        sdk_ts: "updateNow",
        sdk_py: "update_now",
        run: |node, _| {
            Box::pin(async move {
                let n = node.clone();
                out(tokio::task::spawn_blocking(move || update::update_now(&n)).await.map_err(|e| e.to_string())??)
            })
        },
    },
    OwnerCommand {
        name: "restart",
        description: "Restarts the node once no call is under way: into the newest release unpacked here, else the same one.",
        input: none,
        returns: || json!({ "type": "object", "properties": { "into": { "type": "string" } }, "required": ["into"], "additionalProperties": false }),
        sdk_ts: "restart",
        sdk_py: "restart",
        run: |node, _| Box::pin(async move { out(serde_json::json!({ "into": update::restart(node)? })) }),
    },
    OwnerCommand {
        name: "choose_browser",
        description: "Uses one of the browsers found, by its path, or with null lets the node pick again.",
        input: || args(json!({ "path": { "type": ["string", "null"] } }), &[]),
        returns: || r("Browsers"),
        sdk_ts: "chooseBrowser",
        sdk_py: "choose_browser",
        run: |_, a| Box::pin(async move { out(browsers::choose(arg(a, "path")?)?) }),
    },
    OwnerCommand {
        name: "download_browser",
        description: "Starts fetching what the node's browser lacks: its browser program, from the release the node is, and Chrome for Testing when there's no Chromium; a browser event says when it ends.",
        input: none,
        returns: || r("Browsers"),
        sdk_ts: "downloadBrowser",
        sdk_py: "download_browser",
        run: |node, _| {
            Box::pin(async move {
                browsers::download(node.clone());
                out(browsers::view())
            })
        },
    },
];

/// `passkey_enrol` and `passkey_use`: the browser the owner named, or the node's own for the site, made to keep the
/// next passkey the site makes (`enrol`), or to hold the site's passkeys.
async fn in_passkey_browser(node: &Arc<Node>, site: String, cdp: Option<String>, minutes: u64, enrol: bool) -> Result<Value, OwnerError> {
    node.key()?;
    let n = node.clone();
    let done = tokio::task::spawn_blocking(move || {
        let keys = n.key()?;
        let browser = passkey_browser(cdp);
        if enrol {
            passkey::enrol(&site, &browser, minutes, keys).and_then(|armed| serde_json::to_value(armed).map_err(|e| e.to_string()))
        } else {
            passkey::use_in(&site, &browser, keys).map(|held| serde_json::json!({ "held": held }))
        }
    })
    .await
    .map_err(|e| OwnerError::Failed(e.to_string()))?;
    out(done?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::apischema::{check, types};

    /// Every command is one entry, named as the window and the SDKs send it.
    #[test]
    fn every_command_is_one_entry() {
        let mut names: Vec<&str> = OWNER_COMMANDS.iter().map(|c| c.name).collect();
        let n = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), n, "a command is listed twice");
        let ts: std::collections::BTreeSet<&str> = OWNER_COMMANDS.iter().map(|c| c.sdk_ts).collect();
        assert_eq!(ts.len(), n, "two commands share a TypeScript method");
        for c in OWNER_COMMANDS {
            assert!(c.name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{}", c.name);
            assert!(!c.description.is_empty() && c.description.ends_with('.'), "{}", c.name);
            assert!(c.sdk_ts.bytes().all(|b| b.is_ascii_alphabetic()) && c.sdk_ts.as_bytes()[0].is_ascii_lowercase(), "{}", c.name);
            assert!(c.sdk_py.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'), "{}", c.name);
        }
    }

    /// External security review round 2, 2026-11-04, item 4 (Lewis: the node's dialog is enough). The owner answers in
    /// the node's own dialog, whoever sends the command: exactly these commands wait on it, so none of them runs on the
    /// owner's token alone, and no other command is held up by a question.
    /// The owner is asked about a card limit on the site it is kept under, its registrable domain covering every host
    /// below it, not on the host as it was sent.
    #[test]
    fn the_card_limit_question_names_the_site_the_limit_is_kept_under() {
        let q = asks_the_owner("card_limit", &serde_json::json!({ "card": "visa", "site": "https://checkout.pay.shop.co.uk/basket", "per_payment": 50.0, "per_day": 80.0 })).unwrap();
        assert!(q.contains(" on shop.co.uk."), "{q}");
        assert!(!q.contains("checkout.pay"), "{q}");
        assert_eq!(crate::vault::limit_site("checkout.pay.shop.co.uk").unwrap(), "shop.co.uk");
    }

    /// Audit 1118 M11: a coin bought, sold or launched spends or parts with the wallet's own value, as `wallet_send`
    /// does, so it goes only on the owner's yes, and the question says what and how much.
    #[test]
    fn a_coin_buy_sell_or_launch_goes_only_on_the_owners_yes() {
        let entry = format!("{:#x}", alloy::primitives::FixedBytes::<32>::repeat_byte(7));
        let buy = asks_the_owner("coin_buy", &json!({ "entry": entry, "unb": 12.5 })).expect("a buy is asked");
        assert!(buy.contains(&entry) && buy.contains("12.5"), "{buy}");
        let launch = asks_the_owner("coin_launch", &json!({ "entry": entry, "unb": 4 })).expect("a launch is asked");
        assert!(launch.contains(&entry) && launch.contains('4'), "{launch}");
        let sell = asks_the_owner("coin_sell", &json!({ "entry": entry, "coins": 9 })).expect("a sale is asked");
        assert!(sell.contains(&entry) && sell.contains('9'), "{sell}");
    }

    #[test]
    fn the_node_asks_the_owner_for_exactly_the_commands_that_hand_out_a_secret_a_key_or_more_to_spend() {
        let _home = store::scratch_home("asked-invariant");
        let mut raised = serde_json::to_value(store::load_settings()).unwrap();
        raised["max_fetch_usdc"] = json!(store::load_settings().max_fetch_usdc + 1.0);
        let every = json!({ "index": 1, "cap_usdc": 20.0, "site": "a.example", "account": "me", "words": "w", "backup": "b", "passphrase": "p",
            "name": "n", "days": 7, "owner": "0x0000000000000000000000000000000000000001", "nonce": "00", "signature": "00", "settings": raised, "id": 1, "report": 1,
            "entry": format!("{:#x}", alloy::primitives::FixedBytes::<32>::repeat_byte(1)), "unb": 50.0, "coins": 3.0, "bps": store::COIN_DEV_BUY_BPS + 50 });
        let mut asked: Vec<&str> = OWNER_COMMANDS.iter().filter(|c| asks_the_owner(c.name, &every).is_some()).map(|c| c.name).collect();
        asked.sort_unstable();
        let want = [
            "agent_create", "agent_set_cap", "bounty_confirm", "card_limit", "chain_kept_release", "checkout_release", "coin_buy", "coin_dev_buy", "coin_launch", "coin_sell", "import_session", "link_wallet", "passkey_remove", "remote_key_create",
            "report_send",
            "save_settings", "vault_card_remove", "vault_remove", "vault_reveal", "vault_rotate", "wallet_export", "wallet_import", "wallet_phrase", "wallet_restore", "wallet_send",
        ];
        assert_eq!(asked, want, "the commands the node asks the owner about");
        // Turning bounty steps on, or raising the listing's first buy past its default, is asked about; turning either
        // down, or the first buy back up to its default, isn't (`decide.dev-buy-default-on`).
        assert!(asks_the_owner("bounty_auto", &json!({ "on": true })).is_some_and(|q| q.contains("bounty")));
        assert!(asks_the_owner("bounty_auto", &json!({ "on": false })).is_none() && asks_the_owner("bounty_auto", &json!({ "on": null })).is_none());
        assert!(asks_the_owner("coin_dev_buy", &json!({ "bps": store::COIN_DEV_BUY_BPS + 1 })).is_some_and(|q| q.contains("first buy")));
        assert!(asks_the_owner("coin_dev_buy", &json!({ "bps": "lots" })).is_some(), "a share that isn't a number is asked about");
        for quiet in [json!({ "bps": 0 }), json!({ "bps": null }), json!({ "bps": store::COIN_DEV_BUY_BPS })] {
            assert!(asks_the_owner("coin_dev_buy", &quiet).is_none(), "{quiet}");
        }
        let mut off = store::load_settings();
        off.coin_dev_buy_bps = 0;
        store::save_settings(&off).unwrap();
        assert!(asks_the_owner("coin_dev_buy", &json!({ "bps": store::COIN_DEV_BUY_BPS })).is_none(), "turned off, back on at the default: not asked");
        assert!(store::loosened(&serde_json::to_value(&off).unwrap(), &json!({ "coin_dev_buy_bps": store::COIN_DEV_BUY_BPS })).is_empty(), "nor through the settings");
        assert_eq!(store::loosened(&serde_json::to_value(&off).unwrap(), &json!({ "coin_dev_buy_bps": store::COIN_DEV_BUY_BPS + 1 })).len(), 1, "past it, asked");
        // A passkey bound for a browser at a DevTools address is asked about whatever sends it; in the node's own
        // browser it isn't.
        for name in ["passkey_use", "passkey_enrol"] {
            assert!(asks_the_owner(name, &json!({ "site": "a.example", "cdp": "9222" })).is_some_and(|q| q.contains("9222") && q.contains("a.example")), "{name} with an address");
            assert!(asks_the_owner(name, &json!({ "site": "a.example", "cdp": null })).is_none(), "{name} in the node's browser");
        }
    }

    /// Each command's input names the arguments its run reads (`arg(a, "…")` in this file), and only those: the
    /// entry's source is read, so an argument added to a run without its schema fails here. `hands_input` also takes
    /// the input's own fields, which `hands::input` reads from the whole object.
    #[test]
    fn each_input_names_the_arguments_its_run_reads() {
        let source = include_str!("commands.rs");
        let list = &source[source.find("pub static OWNER_COMMANDS").unwrap()..];
        let list = &list[..list.find("\n];").unwrap()];
        let mut seen = 0;
        for entry in list.split("OwnerCommand {").skip(1) {
            let name = entry.split("name: \"").nth(1).and_then(|s| s.split('"').next()).unwrap();
            let c = OWNER_COMMANDS.iter().find(|c| c.name == name).unwrap();
            let reads: std::collections::BTreeSet<String> = entry.split("(a, \"").skip(1).filter_map(|s| s.split('"').next()).map(String::from).collect();
            let input = (c.input)();
            let mut named: std::collections::BTreeSet<String> = input["properties"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            if let Some(parts) = input["allOf"].as_array() {
                named.extend(parts.iter().filter_map(|p| p["properties"].as_object()).flat_map(|o| o.keys().cloned()));
            }
            assert_eq!(reads, named, "{name}'s input against what its run reads");
            seen += 1;
        }
        assert_eq!(seen, OWNER_COMMANDS.len(), "every entry was read");
    }

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

    /// A command missing an argument its input requires is refused, naming one its input requires, before it does
    /// anything.
    #[test]
    fn a_missing_required_argument_is_refused_by_its_name() {
        let home = store::scratch_home("owner-required");
        let (rt, node) = scratch_node(&home);
        for c in OWNER_COMMANDS {
            let input = (c.input)();
            let parts = input["allOf"].as_array().cloned().unwrap_or_else(|| vec![input.clone()]);
            let required: Vec<String> = parts.iter().filter_map(|p| p["required"].as_array()).flatten().filter_map(|k| k.as_str().map(String::from)).collect();
            if required.is_empty() {
                continue;
            }
            match rt.block_on(c.run(&node, &json!({}))) {
                Err(OwnerError::Failed(m)) => assert!(required.iter().any(|k| m.starts_with(&format!("{k}: "))), "{}: {m} names none of {required:?}", c.name),
                Err(OwnerError::Unknown) => panic!("{} is unknown", c.name),
                Ok(v) => panic!("{} answered {v} with none of {required:?}", c.name),
            }
        }
    }

    #[test]
    fn reading_what_the_node_would_share_is_not_consent_to_share_it() {
        // A node on the network is a process-wide address (`link::set_node`): no other test may see it.
        let _one = crate::testchain::one_at_a_time_blocking();
        let home = store::scratch_home("share-consent");
        let (rt, node) = scratch_node(&home);
        crate::testchain::sign_in(&node);
        let route = json!({
            "id": "r", "site": "shop.example", "what": "search items", "method": "GET", "path": "/api/items", "root": "https://shop.example/",
            "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false, "provisional": false, "learned_at": 1,
            "local": false, "share": true, "stats": { "calls": 3, "passed": 3 },
            "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/items", "needs_browser": false, "fields": [] }] }
        });
        store::save_route(&serde_json::from_value(route).unwrap()).unwrap();
        let waiting = |v: &Value| v["routes"].as_array().unwrap().iter().any(|r| r["why"] == "preview");
        let read = || rt.block_on(owner(&node, "share_status", json!({}))).unwrap_or_else(|_| panic!("share_status answers"));
        assert!(waiting(&read()), "a route waits on the owner");
        assert!(!store::load_settings().share_previewed, "opening My routes is no answer");
        assert!(waiting(&read()), "and it still waits");
        assert!(rt.block_on(owner(&node, "share_approve", json!({}))).is_ok());
        assert!(store::load_settings().share_previewed, "pressing the button is");
        assert!(!waiting(&read()));
        *link::NODE.writing() = None;
    }

    /// The commands that needn't reach a chain, a browser or the network, run on a scratch node, answer what their
    /// `returns` says. The rest are named in `UNEXERCISED`, with why, so a new command is put in one list or the other.
    #[test]
    fn what_each_command_answers_is_what_its_schema_says() {
        // `hands_stop` below would stop the picture `hands::tests` keeps running.
        let _one = crate::hands::WATCH_FOR_TEST.locked();
        const UNEXERCISED: &[(&str, &str)] = &[
            ("remote_link", "turns the remote on and opens the owner's browser at the gateway's link page: remote.rs tests it with no browser (link_account_opens_the_page_that_names_the_node)"),
            ("agent_clients", "reads the owner's real MCP client configs: connect.rs tests it on a made-up home, scripts/install-e2e.sh against a running node"),
            ("agent_connect", "starts `unb mcp` and writes client configs: connect.rs tests (connect_writes_each_client_and_keeps_everything_else) and scripts/install-e2e.sh"),
            ("agent_connect_undo", "puts back what agent_connect wrote: connect.rs tests (undo_puts_every_file_back) and scripts/install-e2e.sh"),
            ("hands_answer", "types into a live page: needs a waiting ask and a browser; a_code_from_another_device_answers_only_a_waiting_sign_in_ask covers its refusals"),
            ("card_limit", "needs a card in the vault; vault.rs tests it"),
            ("report_send", "needs a report waiting and a relay: report.rs tests it (an_agent_report_waits_for_the_owner_before_it_is_sent)"),
            ("report_discard", "needs a report waiting: report.rs tests it (an_agent_report_waits_for_the_owner_before_it_is_sent)"),
            ("link_start", "opens the owner's browser and waits on the website"),
            ("confirm", "answers a question the node waits on: a_node_with_no_screen_takes_the_owner_passphrase_typed_on_a_terminal"),
            ("add_funds", "opens the owner's browser; its answer on a chain is checked in chain.rs (an_empty_node_is_told_what_starts_it)"),
            ("unlink", "tells the website, when telemetry is on"),
            ("call_route", "calls the route's site"),
            ("passkey_remove", "needs a passkey, which only a browser makes"),
            ("passkey_enrol", "drives a browser"),
            ("passkey_use", "drives a browser"),
            ("wallet", "reads the chain"),
            ("faucet", "writes to the chain"),
            ("deposit", "writes to the chain"),
            ("request_withdraw", "writes to the chain"),
            ("withdraw", "writes to the chain"),
            ("chain_kept", "reads the chain for each kept write: a_kept_write_is_let_go_only_on_the_owners_yes keeps one"),
            ("chain_kept_release", "asks the owner: a_kept_write_is_let_go_only_on_the_owners_yes"),
            ("wallet_send", "asks the owner, then writes to the chain"),
            ("coin_holdings", "reads the chain"),
            ("coin_launch", "writes to the chain"),
            ("coin_buy", "writes to the chain"),
            ("coin_sell", "writes to the chain"),
            ("coin_stake", "writes to the chain"),
            ("coin_unstake", "writes to the chain"),
            ("coin_withdraw", "writes to the chain"),
            ("coin_claim", "writes to the chain"),
            ("coin_fetch_delay", "reads and writes the chain"),
            ("coin_rank", "reads the chain"),
            ("wallet_grant", "reads the chain"),
            ("earnings", "reads the chain"),
            ("collect_earnings", "writes to the chain"),
            ("wallet_renew", "opens the owner's browser"),
            ("listings_to_sign", "reads the chain (checked in owner_nodes' Anvil test)"),
            ("listings_sign", "opens the owner's browser"),
            ("listing_sign", "reads and writes the chain (checked in owner_nodes' Anvil test)"),
            ("owner_nodes", "reads the chain"),
            ("domain_status", "reads the chain (its answer is checked against its schema in `domains::tests`)"),
            ("advance_day", "writes to the chain"),
            ("list_route", "writes to the chain"),
            ("set_pricing", "reads and writes the chain"),
            ("delist_route", "writes to the chain"),
            ("routes_on_chain", "reads the chain"),
            ("agents_spend", "reads the chain"),
            ("claim_now", "reads and writes the chain"),
            ("board", "reads the chain"),
            ("entries", "reads the chain"),
            ("bounty_post", "writes to the chain"),
            ("bounty_confirm", "asks the owner, then writes to the chain"),
            ("bounty_settle", "writes to the chain"),
            ("bounty_release", "writes to the chain"),
            ("bounty_refund", "writes to the chain"),
            ("bounty_list", "reads the chain"),
            ("bounty_show", "reads the chain"),
            ("hands_watch", "drives a browser"),
            ("update_now", "reads the package registry"),
            ("restart", "replaces the process it runs in"),
            ("hands_input", "drives a browser"),
            ("import_session", "reads the cookies of the browser on this machine"),
            ("choose_browser", "changes the browser every test on this machine launches"),
            ("download_browser", "downloads Chrome for Testing"),
        ];
        let home = store::scratch_home("owner-answers");
        let (rt, node) = scratch_node(&home);
        // What the commands read: a walked site, a kept session, two routes, a line of activity and an agent key.
        std::fs::create_dir_all(home.join("profiles").join("a.example")).unwrap();
        std::fs::create_dir_all(home.join("jars")).unwrap();
        std::fs::write(home.join("jars").join("a.example.json"), r#"{"sid":"x"}"#).unwrap();
        std::fs::write(home.join("jars").join("b.example.json"), r#"{"sid":"y"}"#).unwrap();
        for id in ["kept", "dropped"] {
            let route: store::Route = serde_json::from_value(json!({
                "id": id, "site": "a.example", "what": "Search items", "method": "GET", "path": "/api/items", "root": "https://a.example/?q=lamps",
                "inputs": [{ "name": "q", "secret": false, "default": "lamps" }], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
                "provisional": false, "learned_at": 1,
                "graph": { "provisional": false, "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://a.example/api/items?q={q}",
                    "needs_browser": false, "response_shape": { "items": [] },
                    "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamps" }] }] }
            }))
            .unwrap();
            // Each keeps a body beside its graph: what the owner is shown of a route carries none of it.
            store::save_route(&store::with_a_body_saying(route, "only-the-body-says-this")).unwrap();
        }
        store::log_activity(&store::Activity {
            at: 1,
            who: "You".into(),
            site: "a.example".into(),
            what: "Learned a route".into(),
            kind: "learn".into(),
            result: "done".into(),
            ms: Some(3),
            unb: None,
            tx: None,
            note: None,
        });
        agents::create(node.key().unwrap(), "first", 1.0, 30, 7788).unwrap();
        // The owner says yes to every dialog the node opens for a secret (`asks_the_owner`).
        crate::owner_dialog::answer_in_test(Some(true));
        let phrase = rt.block_on(owner(&node, "wallet_phrase", json!({}))).ok().unwrap();
        let passphrase = ["a long ", "pass", "phrase"].concat();
        let backup = rt.block_on(owner(&node, "wallet_export", json!({ "passphrase": passphrase }))).ok().unwrap()["backup"].clone();
        let exercised: Vec<(&str, Value)> = vec![
            ("setup_status", json!({})),
            ("open_link", json!({ "link": "unbrowse://example.com" })),
            ("reports_waiting", json!({})),
            ("checkout_holds", json!({})),
            ("checkout_release", json!({ "site": "nothing-held.example", "how": "dismissed" })),
            ("identity", json!({})),
            ("link_status", json!({})),
            ("funding", json!({})),
            ("money", json!({})),
            ("share_status", json!({})),
            ("share_route", json!({ "id": "kept", "on": true })),
            ("delist_all", json!({})),
            ("node_info", json!({})),
            ("sites", json!({})),
            ("sessions", json!({})),
            ("forget_session", json!({ "host": "b.example" })),
            ("settings", json!({})),
            ("share_approve", json!({})),
            ("bounty_auto", json!({ "on": false })),
            ("bounty_auto", json!({ "on": null })),
            ("save_settings", json!({ "settings": serde_json::to_value(store::load_settings()).unwrap() })),
            ("terms_text", json!({})),
            ("accept_terms", json!({ "keep_off": true })),
            ("routes", json!({})),
            ("delete_route", json!({ "id": "dropped" })),
            ("activity", json!({ "limit": 5 })),
            ("agents_list", json!({})),
            ("agent_create", json!({ "name": "second", "cap_usdc": 2.5, "days": 7 })),
            ("agent_revoke", json!({ "index": 0 })),
            ("agent_set_cap", json!({ "index": 1, "cap_usdc": 20.0 })),
            ("coin_dev_buy", json!({ "bps": 0 })),
            ("coin_dev_buy", json!({ "bps": null })),
            ("wallet_export", json!({ "passphrase": passphrase })),
            ("wallet_import", json!({ "backup": backup, "passphrase": passphrase })),
            ("vault_add", json!({ "site": "a.example", "account": "me", "kind": "stored", "password": "hunter2" })),
            ("vault_add", json!({ "site": "b.example", "account": "me", "kind": "derived", "password": null })),
            ("vault_list", json!({})),
            ("card_limits", json!({})),
            ("keep_card_codes", json!({ "on": false })),
            ("keep_card_codes", json!({ "on": null })),
            ("payment_approver", json!({ "approver": null })),
            ("payment_approver", json!({ "approver": "dialog" })),
            ("remote_answers", json!({ "on": null })),
            ("remote_answers", json!({ "on": false })),
            ("remote_status", json!({})),
            ("remote_set", json!({ "on": true, "gateway": "https://gateway.example" })),
            ("remote_key_create", json!({ "name": "laptop" })),
            ("remote_revoke", json!({})),
            ("remote_set", json!({ "on": false })),
            ("vault_reveal", json!({ "site": "a.example", "account": "me" })),
            ("vault_rotate", json!({ "site": "b.example", "account": "me" })),
            ("vault_code", json!({ "site": "a.example", "account": "me", "key": "JBSWY3DPEHPK3PXP" })),
            ("vault_import", json!({ "csv": "url,username,password\nhttps://c.example/login,you,pw\nnot a row\n" })),
            ("vault_remove", json!({ "site": "b.example", "account": "me" })),
            ("vault_card_add", json!({ "label": "visa", "number": "4242 4242 4242 4242", "expiry": "01/30", "name": "Ada Lovelace", "cvv": null })),
            ("vault_card_add", json!({ "label": "mc", "number": "5555555555554444", "expiry": "02/31", "name": "Ada Lovelace", "cvv": "123" })),
            ("vault_cards", json!({})),
            ("vault_card_remove", json!({ "card": "mc" })),
            ("passkeys", json!({})),
            ("passkey_never", json!({ "site": "a.example" })),
            ("wallet_phrase", json!({})),
            ("wallet_restore", json!({ "words": phrase })),
            ("chain_status", json!({})),
            ("hands", json!({})),
            ("hands_stop", json!({})),
            ("hands_give_back", json!({ "site": "a.example", "done": false })),
            ("browsers", json!({})),
            ("update_status", json!({})),
            ("confirmations", json!({})),
        ];
        let t = types();
        for (name, a) in &exercised {
            let c = OWNER_COMMANDS.iter().find(|c| c.name == *name).unwrap_or_else(|| panic!("no command {name}"));
            check(&(c.input)(), a, &t).unwrap_or_else(|e| panic!("{name}'s arguments against its input: {e}"));
            let answer = match rt.block_on(owner(&node, name, a.clone())) {
                Ok(v) => v,
                Err(OwnerError::Failed(m)) => panic!("{name}: {m}"),
                Err(OwnerError::Unknown) => panic!("{name} is unknown"),
            };
            check(&(c.returns)(), &answer, &t).unwrap_or_else(|e| panic!("{name} answered {answer}: {e}"));
            // A route the owner is shown carries none of the body it keeps beside its graph.
            assert!(!answer.to_string().contains("only-the-body-says-this"), "{name} carries a route's body: {answer}");
        }
        // Signing in with the owner's own wallet: the message, then what the wallet signed of it.
        {
            let _sign_in = link::SIGN_IN_TESTS.blocking_lock();
            use alloy::signers::SignerSync;
            let wallet = alloy::signers::local::PrivateKeySigner::random();
            let a = json!({ "owner": wallet.address().to_string() });
            let m = rt.block_on(owner(&node, "link_message", a.clone())).ok().unwrap();
            let c = OWNER_COMMANDS.iter().find(|c| c.name == "link_message").unwrap();
            check(&(c.input)(), &a, &t).unwrap();
            check(&(c.returns)(), &m, &t).unwrap_or_else(|e| panic!("link_message answered {m}: {e}"));
            let sig = wallet.sign_message_sync(m["message"].as_str().unwrap().as_bytes()).unwrap();
            let a = json!({ "owner": wallet.address().to_string(), "nonce": m["nonce"], "signature": format!("0x{}", hex::encode(sig.as_bytes())) });
            let linked = rt.block_on(owner(&node, "link_wallet", a.clone())).ok().unwrap();
            let c = OWNER_COMMANDS.iter().find(|c| c.name == "link_wallet").unwrap();
            check(&(c.input)(), &a, &t).unwrap();
            check(&(c.returns)(), &linked, &t).unwrap_or_else(|e| panic!("link_wallet answered {linked}: {e}"));
            assert_eq!(linked["owner"], json!(wallet.address().to_checksum(None)));
        }
        // What was read is what was set up: the answers weren't empty by accident.
        let routes = rt.block_on(owner(&node, "routes", json!({}))).ok().unwrap();
        assert_eq!(routes.as_array().map(Vec::len), Some(1), "{routes}");
        assert!(store::load_routes().iter().all(|r| r.body.is_some()), "the routes keep their bodies on the node");
        assert_eq!(routes[0]["share"], json!(true));
        let agents = rt.block_on(owner(&node, "agents_list", json!({}))).ok().unwrap();
        // The two made above and the remote key, which remote_revoke revoked.
        assert_eq!(agents.as_array().map(Vec::len), Some(3), "{agents}");
        assert_eq!(agents[2]["revoked"], json!(true), "{agents}");
        let vault = rt.block_on(owner(&node, "vault_list", json!({}))).ok().unwrap();
        assert!(vault.as_array().is_some_and(|v| v.iter().any(|l| l["code"] == true)), "{vault}");

        let mut covered: Vec<&str> = exercised.iter().map(|(n, _)| *n).chain(UNEXERCISED.iter().map(|(n, _)| *n)).chain(["link_message", "link_wallet"]).collect();
        covered.sort();
        covered.dedup();
        let mut all: Vec<&str> = OWNER_COMMANDS.iter().map(|c| c.name).collect();
        all.sort();
        assert_eq!(covered, all, "every command is exercised here or named in UNEXERCISED");
        assert!(UNEXERCISED.iter().all(|(n, _)| !exercised.iter().any(|(e, _)| e == n)), "a command is in both lists");
    }

    /// External security review round 2, 2026-11-04, item 4. Another program running as the owner's user can read
    /// `owner.token`; holding it never hands out the recovery phrase, a vault password or a backup of the node's key.
    /// Each waits on the owner's yes in a dialog the node opens itself, which nothing sent with the token answers: no
    /// dialog, or a no, and nothing comes back.
    #[test]
    fn the_owners_token_alone_never_hands_out_a_secret() {
        let home = store::scratch_home("owner-token-alone");
        let (rt, node) = scratch_node(&home);
        rt.block_on(owner(&node, "vault_add", json!({ "site": "a.example", "account": "me", "kind": "stored", "password": "hunter2-secret" }))).ok().unwrap();
        let secrets = [
            ("wallet_phrase", json!({})),
            ("vault_reveal", json!({ "site": "a.example", "account": "me" })),
            ("wallet_export", json!({ "passphrase": "a long passphrase" })),
        ];
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            for (name, a) in &secrets {
                match rt.block_on(owner(&node, name, a.clone())) {
                    Err(OwnerError::Failed(m)) => assert!(m.contains("dialog"), "{name}: {m}"),
                    Ok(v) => panic!("{name} handed out {v} with no yes from the owner"),
                    Err(OwnerError::Unknown) => panic!("{name} is unknown"),
                }
            }
        }
        let asked = crate::owner_dialog::asked_in_test();
        assert_eq!(asked.len(), 6, "every try asked the owner: {asked:?}");
        assert!(asked.iter().any(|q| q.contains("me on a.example")), "the dialog names the login: {asked:?}");
        // The owner's yes, and only it, hands each out.
        crate::owner_dialog::answer_in_test(Some(true));
        for (name, a) in &secrets {
            assert!(rt.block_on(owner(&node, name, a.clone())).is_ok(), "{name} with the owner's yes");
        }
        // Commands that hand out nothing the node can't take back ask nothing.
        assert!(asks_the_owner("vault_list", &json!({})).is_none());
    }

    /// The window adds a card with `vault_card_add`. Its answer, the card list and the activity log carry the label and
    /// the last four digits, never the number, expiry, name or code, and a card that doesn't read is refused without what
    /// was sent said back. The code is kept only while the vault keeps codes, whatever was sent. Removing one waits on
    /// the owner's yes.
    #[test]
    fn a_card_the_window_adds_is_kept_and_none_of_it_is_said_back() {
        let home = store::scratch_home("owner-card-add");
        let (rt, node) = scratch_node(&home);
        let run = |cmd: &str, a: Value| match rt.block_on(owner(&node, cmd, a)) {
            Ok(v) => Ok(v),
            Err(OwnerError::Failed(m)) => Err(m),
            Err(OwnerError::Unknown) => panic!("{cmd} is unknown"),
        };
        let secrets = ["4242", "01/30", "Ada Lovelace", "987"];
        let said_none = |v: &str| {
            // When the card was added is a number of its own, and its digits are no secret said back: left out, or a
            // run in the minutes whose time holds the code's digits fails.
            let when = v.split("\"created\":").nth(1).map(|rest| rest.chars().take_while(char::is_ascii_digit).collect::<String>()).unwrap_or_default();
            let v = &if when.is_empty() { v.to_string() } else { v.replace(&format!("\"created\":{when}"), "\"created\":0") };
            for s in &secrets[1..] {
                assert!(!v.contains(s), "{v} says {s}");
            }
            assert!(!v.contains("4242 4242") && !v.contains("42424242"), "{v} says the number");
        };
        let visa = json!({ "label": "Visa", "number": "4242 4242 4242 4242", "expiry": "01/30", "name": "Ada Lovelace", "cvv": "987" });
        let info = run("vault_card_add", visa.clone()).unwrap();
        assert_eq!((info["label"].as_str(), info["last4"].as_str(), info["code"].as_bool()), (Some("visa"), Some("4242"), Some(false)), "{info}");
        said_none(&info.to_string().replace("\"last4\":\"4242\"", ""));
        let field = |card: &str, f: &str| vault::card_value(&node_vault(&node).unwrap(), &vault::CardRef::parse(&format!("vault:card:{card}:{f}")).unwrap(), true);
        assert_eq!(field("visa", "number").unwrap().as_str(), "4242424242424242");
        assert!(field("visa", "cvv").is_err(), "the vault keeps no code while it keeps none, whatever was sent");
        let listed = run("vault_cards", json!({})).unwrap();
        assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed}");
        assert!(run("vault_card_add", visa).unwrap_err().contains("already"), "one label, one card");
        // Kept codes on, a card added keeps the code it was given.
        vault::set_keep_codes(&node_vault(&node).unwrap(), Some(true), "You").unwrap();
        let mc = run("vault_card_add", json!({ "label": "mc", "number": "5555555555554444", "expiry": "02/31", "name": "Ada Lovelace", "cvv": "987" })).unwrap();
        assert_eq!(mc["code"], json!(true), "{mc}");
        assert_eq!(field("mc", "cvv").unwrap().as_str(), "987");
        // Refused, and nothing sent is said back: a number that isn't one, one sent as a number, a missing name.
        for bad in [
            json!({ "label": "amex", "number": "4242 4242 4242 4241", "expiry": "01/30", "name": "Ada Lovelace" }),
            json!({ "label": "amex", "number": 4242424242424242u64, "expiry": "01/30", "name": "Ada Lovelace" }),
            json!({ "label": "amex", "number": "4242424242424242", "expiry": "13/30", "name": "Ada Lovelace" }),
            json!({ "label": "amex", "number": "4242424242424242", "expiry": "01/30", "name": "Ada Lovelace", "cvv": 987 }),
        ] {
            let m = run("vault_card_add", bad.clone()).unwrap_err();
            said_none(&m);
            assert!(!m.contains("4241") && !m.contains("13/30"), "{bad}: {m}");
        }
        assert_eq!(vault::cards().len(), 2, "nothing refused was kept");
        let log: String = store::read_activity(50).iter().map(|a| format!("{} {}\n", a.what, a.note.clone().unwrap_or_default())).collect();
        assert!(log.contains("Added the card visa, ending 4242"), "{log}");
        said_none(&log.replace("ending 4242", ""));
        // Removing a card is asked: no yes, and it stays.
        crate::owner_dialog::answer_in_test(Some(false));
        assert!(run("vault_card_remove", json!({ "card": "visa" })).is_err());
        assert_eq!(vault::cards().len(), 2);
        crate::owner_dialog::answer_in_test(Some(true));
        run("vault_card_remove", json!({ "card": "visa" })).unwrap();
        assert_eq!(vault::cards().iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["mc"]);
        assert!(crate::owner_dialog::asked_in_test().iter().any(|q| q.contains("saved card visa")));
    }

    /// External security review round 2, 2026-11-04, item 4. Replacing the node's key, from words or a backup, and
    /// raising what an agent key may spend wait on the owner's yes in the node's own dialog too, whoever sends them. No
    /// dialog, or a no, and the node's key and the agent's cap stay as they were.
    #[test]
    fn the_owners_token_alone_never_replaces_the_key_or_raises_a_cap() {
        let home = store::scratch_home("owner-token-no-replace");
        let (rt, node) = scratch_node(&home);
        agents::create(node.key().unwrap(), "first", 1.0, 30, 7788).unwrap();
        let before = rt.block_on(owner(&node, "identity", json!({}))).ok().unwrap()["address"].clone();
        let other = ["legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"].concat();
        let tries = [("wallet_restore", json!({ "words": other })), ("agent_set_cap", json!({ "index": 0, "cap_usdc": 900.0 }))];
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            for (name, a) in &tries {
                match rt.block_on(owner(&node, name, a.clone())) {
                    Err(OwnerError::Failed(m)) => assert!(m.contains("dialog"), "{name}: {m}"),
                    Ok(v) => panic!("{name} ran with no yes from the owner: {v}"),
                    Err(OwnerError::Unknown) => panic!("{name} is unknown"),
                }
            }
        }
        let asked = crate::owner_dialog::asked_in_test();
        assert_eq!(asked.len(), 4, "every try asked the owner: {asked:?}");
        assert!(asked.iter().any(|q| q.contains("agent key 0") && q.contains("900")), "the question says which key and how much: {asked:?}");
        assert_eq!(rt.block_on(owner(&node, "identity", json!({}))).ok().unwrap()["address"], before, "the key is the one it was");
        let agents = rt.block_on(owner(&node, "agents_list", json!({}))).ok().unwrap();
        assert_ne!(agents[0]["cap_usdc"], json!(900.0), "the cap is the one it was: {agents}");
        // The owner's yes, and only it, lets each through.
        crate::owner_dialog::answer_in_test(Some(true));
        for (name, a) in &tries {
            assert!(rt.block_on(owner(&node, name, a.clone())).is_ok(), "{name} with the owner's yes");
        }
        assert_ne!(rt.block_on(owner(&node, "identity", json!({}))).ok().unwrap()["address"], before, "the owner's yes restored the words' key");
    }

    /// External security review round 3, 2026-11-04, item 4 re-check. Holding the owner's token never makes an agent key
    /// (with any cap, under either of the cap's names), raises the most a paid call or the checks may spend, or links a
    /// wallet for withdrawals: each waits on the owner's yes in the node's own dialog. No dialog, or a no, and nothing
    /// changed. Settings that raise no limit are kept with no question.
    #[test]
    fn the_owners_token_alone_never_makes_an_agent_key_raises_a_limit_or_links_a_wallet() {
        let _one = crate::testchain::one_at_a_time_blocking();
        use alloy::signers::SignerSync;
        let home = store::scratch_home("owner-token-no-spend");
        let (rt, node) = scratch_node(&home);
        let kept = store::load_settings();
        let mut raised = serde_json::to_value(&kept).unwrap();
        raised["max_fetch_usdc"] = json!(kept.max_fetch_usdc + 50.0);
        let mut budget = serde_json::to_value(&kept).unwrap();
        budget["coin_dev_buy_bps"] = json!(kept.coin_dev_buy_bps + 50);
        let thief = alloy::signers::local::PrivateKeySigner::random();
        let me = crate::identity(&node).unwrap().address;
        let _sign_in = link::SIGN_IN_TESTS.blocking_lock();
        let started = rt.block_on(owner(&node, "link_message", json!({ "owner": thief.address().to_checksum(None) }))).ok().unwrap();
        let nonce = started["nonce"].as_str().unwrap().to_string();
        let signature = hex::encode(thief.sign_message_sync(link::message(&me, &thief.address().to_checksum(None), &nonce).as_bytes()).unwrap().as_bytes());
        let tries = [
            ("agent_create", json!({ "name": "sly", "cap_usdc": 900.0, "days": 30 })),
            ("agent_create", json!({ "name": "older", "cap_unb": 900.0, "days": 30 })),
            ("save_settings", json!({ "settings": raised })),
            ("save_settings", json!({ "settings": budget })),
            ("link_wallet", json!({ "owner": thief.address().to_checksum(None), "nonce": nonce, "signature": signature })),
        ];
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            for (name, a) in &tries {
                match rt.block_on(owner(&node, name, a.clone())) {
                    Err(OwnerError::Failed(m)) => assert!(m.contains("dialog") || m.contains("said no"), "{name}: {m}"),
                    Ok(v) => panic!("{name} ran with no yes from the owner: {v}"),
                    Err(OwnerError::Unknown) => panic!("{name} is unknown"),
                }
            }
        }
        let asked = crate::owner_dialog::asked_in_test();
        assert_eq!(asked.len(), 10, "every try asked the owner: {asked:?}");
        assert!(asked.iter().any(|q| q.contains("\"sly\"") && q.contains("900")), "the question names the key and its cap: {asked:?}");
        assert!(asked.iter().any(|q| q.contains("most one paid call costs")), "{asked:?}");
        assert!(asked.iter().any(|q| q.contains(&thief.address().to_checksum(None))), "the question shows the wallet: {asked:?}");
        assert!(agents::list().is_empty(), "no agent key was made");
        assert_eq!(store::load_settings().max_fetch_usdc, kept.max_fetch_usdc, "the limit is the one it was");
        assert_eq!(store::load_settings().coin_dev_buy_bps, kept.coin_dev_buy_bps);
        assert!(link::signed_in(&node).is_none(), "no wallet was linked");
        // Settings that raise nothing are kept with no question.
        let mut lower = serde_json::to_value(&kept).unwrap();
        lower["max_fetch_usdc"] = json!(kept.max_fetch_usdc / 2.0);
        assert!(rt.block_on(owner(&node, "save_settings", json!({ "settings": lower }))).is_ok());
        assert_eq!(crate::owner_dialog::asked_in_test().len(), 10, "nothing was asked for a lower limit");
        // Nor does a switch that lets routes reach this computer's network or puts the stake behind the node's own acts
        // go on, or the coin listing default go up, without the owner's yes (external security review round 4).
        // Nor anything else that lets the node spend more, sooner, or on another chain (security re-audit CHAIN-6).
        for (k, v, says) in [
            ("private_network", json!(true), "own network"),
            ("bounty_auto", json!(true), "bounty"),
            ("coin_dev_buy_bps", json!(kept.coin_dev_buy_bps + 100), "larger first buy of your UNB"),
            ("coin_complete_others", json!(true), "parked coin buys"),
            ("deposit_floor_usdc", json!(kept.deposit_floor_usdc + 100.0), "into the deposit"),
            ("gas_reserve_usdc", json!(0.0), "keep less USDC back"),
            ("claim_gas_share", json!(kept.claim_gas_share + 10.0), "network fee take more"),
            ("max_gas_price_gwei", json!(kept.max_gas_price_gwei * 10.0), "unit of gas"),
            ("gas_budget_usdc_per_day", json!(kept.gas_budget_usdc_per_day + 100.0), "network fees a day"),
            ("list_per_day", json!(1_000), "more routes a day"),
            ("chain", json!("arc-mainnet"), "another chain"),
        ] {
            let mut on = serde_json::to_value(&kept).unwrap();
            on[k] = v;
            assert!(rt.block_on(owner(&node, "save_settings", json!({ "settings": on }))).is_err(), "{k} went on with a no");
            assert!(crate::owner_dialog::asked_in_test().last().is_some_and(|q| q.contains(says)), "{k}");
        }
        let still = store::load_settings();
        assert!(!still.private_network && !still.bounty_auto && still.coin_dev_buy_bps == kept.coin_dev_buy_bps && !still.coin_complete_others);
        assert!(still.deposit_floor_usdc == kept.deposit_floor_usdc && still.gas_reserve_usdc == kept.gas_reserve_usdc && still.chain == kept.chain);
        // The owner's yes lets each through.
        crate::owner_dialog::answer_in_test(Some(true));
        assert!(rt.block_on(owner(&node, "agent_create", tries[0].1.clone())).is_ok());
        assert!(rt.block_on(owner(&node, "link_wallet", tries[4].1.clone())).is_ok());
        assert!(link::signed_in(&node).is_some_and(|l| link::is_sealed(node.key().unwrap(), &l)), "a link the owner allowed is sealed by the node");
    }

    /// A kept write the node can't prove the fate of goes only on the owner's own yes in their dialog: the token alone,
    /// no dialog, or a no leaves it kept; a yes lets it go. Nothing else lets it go but a proof (`inflight::settle`).
    #[test]
    fn a_kept_write_is_let_go_only_on_the_owners_yes() {
        let home = store::scratch_home("owner-kept");
        let (rt, node) = scratch_node(&home);
        let kept = crate::inflight::Sending {
            key: "deposit".into(),
            what: "the deposit".into(),
            signer: alloy::primitives::Address::ZERO,
            nonce: 7,
            tx: alloy::primitives::B256::repeat_byte(1),
            raw: alloy::primitives::Bytes::new(),
            at: crate::store::now(),
            amount: 5.0,
            book: None,
            others: Vec::new(),
            told: false,
            watch: None,
        };
        crate::inflight::keep_for_test(kept);
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            assert!(rt.block_on(owner(&node, "chain_kept_release", json!({ "key": "deposit" }))).is_err(), "{answer:?}");
            assert_eq!(crate::inflight::all().unwrap().len(), 1, "still kept after {answer:?}");
        }
        assert!(crate::owner_dialog::asked_in_test().iter().any(|q| q.contains("pay twice") && q.contains("nonce 7")), "the dialog names the write and the risk");
        crate::owner_dialog::answer_in_test(Some(true));
        assert!(rt.block_on(owner(&node, "chain_kept_release", json!({ "key": "deposit" }))).is_ok());
        assert!(crate::inflight::all().unwrap().is_empty(), "let go on the owner's yes");
    }

    /// Confirming one of the owner's bounties spends its UNB on a coin: it waits on the owner's yes, whoever sends it
    /// with the owner's token. No dialog, or a no, and nothing is sent to the chain.
    #[test]
    fn the_owners_token_alone_never_confirms_a_bounty() {
        let home = store::scratch_home("owner-token-bounty");
        let (rt, node) = scratch_node(&home);
        let entry = format!("{:#x}", alloy::primitives::FixedBytes::<32>::repeat_byte(7));
        for answer in [None, Some(false)] {
            crate::owner_dialog::answer_in_test(answer);
            match rt.block_on(owner(&node, "bounty_confirm", json!({ "id": 3, "entry": entry }))) {
                Err(OwnerError::Failed(m)) => assert!(m.contains("dialog") || m.contains("said no"), "{m}"),
                Ok(v) => panic!("bounty_confirm ran with no yes from the owner: {v}"),
                Err(OwnerError::Unknown) => panic!("bounty_confirm is unknown"),
            }
        }
        let asked = crate::owner_dialog::asked_in_test();
        assert_eq!(asked.len(), 2, "{asked:?}");
        assert!(asked.iter().all(|q| q.contains("confirm your bounty 3") && q.contains(&entry)), "{asked:?}");
    }

    /// External security review round 2, 2026-11-04, item 4 (Lewis: no screen must not simply mean refused). A node
    /// with no screen waits on the owner passphrase instead of a dialog: typed on the owner's terminal (`confirm`), the
    /// one the node sealed with its own key allows the command; a wrong one, or none, doesn't. A program that holds the
    /// token but not the passphrase can't answer, and one that writes a passphrase of its own in the node's place,
    /// without the node's key to seal it, gets a refusal, never a question it can answer.
    #[test]
    fn a_node_with_no_screen_takes_the_owner_passphrase_typed_on_a_terminal() {
        let home = store::scratch_home("owner-no-screen");
        let (rt, node) = scratch_node(&home);
        crate::owner_dialog::answer_in_test(None);
        // No passphrase set: refused at once, saying how to set one.
        match rt.block_on(owner(&node, "wallet_phrase", json!({}))) {
            Err(OwnerError::Failed(m)) => assert!(m.contains("unbrowse-node passphrase"), "{m}"),
            _ => panic!("no screen and no passphrase: refused"),
        }
        let owners = "the owner's own words";
        let root = unbrowse_core::RootKey::load(node.key().unwrap()).unwrap();
        crate::owner_dialog::keep_passphrase(&unbrowse_core::owner_pass::Record::new_with(&root, owners, 10).unwrap()).unwrap();
        // Asked with no screen, the command waits until the owner answers on a terminal.
        let ask = |rt: &tokio::runtime::Runtime| {
            let n = node.clone();
            let task = rt.spawn(async move { owner(&n, "wallet_phrase", json!({})).await.map_err(|e| match e { OwnerError::Failed(m) => m, OwnerError::Unknown => "unknown".into() }) });
            let since = std::time::Instant::now();
            let id = loop {
                if let Some(c) = crate::owner_dialog::confirmations().into_iter().find(|c| c.question.contains("recovery phrase")) {
                    break c.id;
                }
                assert!(since.elapsed().as_secs() < 10, "the node with no screen never waited on the owner's passphrase");
                std::thread::sleep(std::time::Duration::from_millis(20));
            };
            (task, id)
        };
        let confirm = |id: &str, p: Option<&str>| rt.block_on(owner(&node, "confirm", json!({ "id": id, "passphrase": p })));
        let (task, id) = ask(&rt);
        match confirm(&id, Some("an agent's guess here")) {
            Err(OwnerError::Failed(m)) => assert!(m.contains("isn't the owner passphrase"), "{m}"),
            _ => panic!("a wrong passphrase allows nothing"),
        }
        assert!(confirm(&id, Some(owners)).is_ok(), "the owner's passphrase allows it");
        let phrase = rt.block_on(task).unwrap().expect("the phrase, on the owner's yes");
        assert!(phrase.as_str().is_some_and(|p| p.split_whitespace().count() >= 12), "{phrase}");
        // None refuses it, and three wrong ones do.
        let (task, id) = ask(&rt);
        assert!(confirm(&id, None).is_ok());
        assert!(rt.block_on(task).unwrap().unwrap_err().contains("said no"));
        let (task, id) = ask(&rt);
        for _ in 0..crate::owner_dialog::TRIES_PER_QUESTION {
            assert!(confirm(&id, Some("still not the words")).is_err());
        }
        assert!(rt.block_on(task).unwrap().is_err(), "three wrong passphrases refuse it");
        assert!(confirm(&id, Some(owners)).is_err(), "and nothing waits under its id any more");
        // A passphrase another key sealed (an agent's own, written in the node's place) is refused, never asked.
        let theirs = unbrowse_core::MemoryStore::default();
        unbrowse_core::load_or_create(&theirs).unwrap();
        let forged = unbrowse_core::owner_pass::Record::new_with(&unbrowse_core::RootKey::load(&theirs).unwrap(), "the agent's own words", 10).unwrap();
        crate::owner_dialog::keep_passphrase(&forged).unwrap();
        match rt.block_on(owner(&node, "wallet_phrase", json!({}))) {
            Err(OwnerError::Failed(m)) => assert!(m.contains("isn't one this node wrote"), "{m}"),
            _ => panic!("a passphrase the node didn't seal answers nothing"),
        }
        assert!(crate::owner_dialog::confirmations().iter().all(|c| !c.question.contains("recovery phrase")), "and nothing was left waiting");
    }

    /// Wrong owner passphrases in a row lock every question for a while, the right one included, and the count
    /// outlives the node: a program guessing can't reset it by restarting the node.
    #[test]
    fn wrong_owner_passphrases_in_a_row_lock_the_door() {
        let home = store::scratch_home("owner-lock");
        let (_rt, node) = scratch_node(&home);
        let root = unbrowse_core::RootKey::load(node.key().unwrap()).unwrap();
        let record = unbrowse_core::owner_pass::Record::new_with(&root, "the owner's own words", 10).unwrap();
        crate::owner_dialog::keep_passphrase(&record).unwrap();
        for _ in 1..crate::owner_dialog::TRIES_BEFORE_LOCK {
            assert_eq!(crate::owner_dialog::check(&record, "a guess at them"), Ok(false));
        }
        assert_eq!(crate::owner_dialog::check(&record, "the owner's own words"), Ok(true), "the right one before the lock resets the count");
        for _ in 0..crate::owner_dialog::TRIES_BEFORE_LOCK {
            assert_eq!(crate::owner_dialog::check(&record, "a guess at them"), Ok(false));
        }
        let locked = crate::owner_dialog::check(&record, "the owner's own words").unwrap_err();
        assert!(locked.contains("too many wrong"), "{locked}");
        assert!(home.join("owner.passphrase.tries").exists(), "the count is on disk");
    }

    /// A name the registry doesn't list is unknown, as it always was.
    #[test]
    fn an_unknown_command_is_unknown() {
        let home = store::scratch_home("owner-unknown");
        let (rt, node) = scratch_node(&home);
        assert!(matches!(rt.block_on(owner(&node, "pledge", json!({}))), Err(OwnerError::Unknown)));
        assert!(matches!(rt.block_on(owner(&node, "", json!({}))), Err(OwnerError::Unknown)));
    }


    // ---- UNB-117: a card payment answered away from the machine ----

    /// A card payment waiting on the owner at `site`, as a checkout's fill makes one: the ask and its id.
    async fn payment_waits(site: &'static str) -> (tokio::task::JoinHandle<hands::Answer>, String) {
        let pay = hands::Pay { card: "kast (card ending 4242)".into(), merchant: site.into(), route: None, inputs: Vec::new(), over: None, amount: Some(42.5) };
        let waiting = tokio::spawn(hands::ask(site, None, "approve paying", "claude-code", std::time::Duration::from_secs(30), Some(pay), |_| {}));
        loop {
            if let Some(a) = hands::asks().into_iter().find(|a| a.site == site) {
                return (waiting, a.id);
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// With the approver left at the dialog (the default), a give-back naming the payment's ask still waits on the
    /// owner's yes in the node's dialog, exactly as one that names none: no dialog or a no approves nothing.
    #[test]
    fn with_the_dialog_as_approver_a_payment_still_waits_on_the_dialog() {
        let home = store::scratch_home("approver-dialog");
        let (rt, node) = scratch_node(&home);
        rt.block_on(async {
            assert_eq!(owner(&node, "payment_approver", json!({ "approver": null })).await.ok().unwrap()["approver"], "dialog");
            let site = "approver-dialog.example";
            let (waiting, id) = payment_waits(site).await;
            for answer in [None, Some(false)] {
                crate::owner_dialog::answer_in_test(answer);
                match owner(&node, "hands_give_back", json!({ "site": site, "done": true, "ask": id, "via": "Telegram" })).await {
                    Err(OwnerError::Failed(m)) => assert!(m.contains("dialog") || m.contains("said no"), "{m}"),
                    other => panic!("approved with no yes in the dialog: {:?}", other.ok()),
                }
                assert!(hands::payment_waiting(site).is_some(), "the payment waits on");
            }
            crate::owner_dialog::answer_in_test(Some(true));
            owner(&node, "hands_give_back", json!({ "site": site, "done": true, "ask": id })).await.ok().unwrap();
            assert_eq!(waiting.await.unwrap(), hands::Answer::Done);
            assert_eq!(crate::owner_dialog::asked_in_test().len(), 3, "each try asked the dialog");
        });
    }

    /// With the approver set to sdk, done naming the payment's own ask approves it with no dialog, and the owner's
    /// activity says so and where it came from. A give-back naming no ask still asks the dialog, and an ask that no
    /// longer waits is refused, so a late tap never approves a payment that came after it.
    #[test]
    fn with_the_sdk_as_approver_a_give_back_naming_the_ask_approves_that_payment() {
        let home = store::scratch_home("approver-sdk");
        let (rt, node) = scratch_node(&home);
        rt.block_on(async {
            crate::owner_dialog::answer_in_test(Some(true));
            assert_eq!(owner(&node, "payment_approver", json!({ "approver": "sdk" })).await.ok().unwrap()["approver"], "sdk");
            let asked = crate::owner_dialog::asked_in_test().len();
            crate::owner_dialog::answer_in_test(None);
            let site = "approver-sdk.example";
            let (waiting, id) = payment_waits(site).await;
            // What the owner's other device reads: the waiting asks, each with its card, site and stated amount.
            let listed = owner(&node, "hands", json!({})).await.ok().unwrap();
            let ask = listed["asks"].as_array().unwrap().iter().find(|a| a["id"] == id.as_str()).cloned().unwrap();
            assert_eq!((ask["pay"]["card"].as_str(), ask["pay"]["merchant"].as_str(), ask["pay"]["amount"].as_f64()), (Some("kast (card ending 4242)"), Some(site), Some(42.5)));
            // No ask named: the dialog, as before.
            assert!(owner(&node, "hands_give_back", json!({ "site": site, "done": true })).await.is_err());
            assert!(hands::payment_waiting(site).is_some());
            // Another ask's id: refused, nothing answered.
            assert!(matches!(owner(&node, "hands_give_back", json!({ "site": site, "done": true, "ask": "ask-0-0" })).await, Err(OwnerError::Failed(m)) if m.contains("isn't waiting")));
            assert!(hands::payment_waiting(site).is_some());
            // Its own id: approved, no dialog.
            let answered = owner(&node, "hands_give_back", json!({ "site": site, "done": true, "ask": id, "via": "Telegram" })).await.ok().unwrap();
            assert_eq!(answered["answered"], 1);
            assert_eq!(waiting.await.unwrap(), hands::Answer::Done);
            assert_eq!(crate::owner_dialog::asked_in_test().len(), asked + 1, "only the give-back naming no ask asked the dialog");
            let said = store::read_activity(20).into_iter().map(|a| a.what).collect::<Vec<_>>();
            assert!(said.iter().any(|w| w.contains("Approved paying with kast (card ending 4242) on approver-sdk.example from Telegram")), "{said:?}");
            // The same id again, once answered: refused.
            assert!(owner(&node, "hands_give_back", json!({ "site": site, "done": true, "ask": id })).await.is_err());
            // A decline from the other device answers it too, with no dialog, as a decline always did.
            let (waiting, id) = payment_waits(site).await;
            owner(&node, "hands_give_back", json!({ "site": site, "done": false, "ask": id, "via": "Telegram" })).await.ok().unwrap();
            assert_eq!(waiting.await.unwrap(), hands::Answer::Declined);
        });
    }

    /// The sdk approver covers card payments only: with it on, the recovery phrase, a vault password, a backup of
    /// the key and a higher spending cap still wait on the owner's yes in the dialog.
    #[test]
    fn with_the_sdk_as_approver_everything_but_a_payment_still_asks_the_dialog() {
        let home = store::scratch_home("approver-sdk-rest");
        let (rt, node) = scratch_node(&home);
        rt.block_on(async {
            crate::owner_dialog::answer_in_test(Some(true));
            owner(&node, "payment_approver", json!({ "approver": "sdk" })).await.ok().unwrap();
            owner(&node, "vault_add", json!({ "site": "a.example", "account": "me", "kind": "stored", "password": "hunter2-secret" })).await.ok().unwrap();
            crate::owner_dialog::answer_in_test(None);
            for (name, a) in [
                ("wallet_phrase", json!({})),
                ("vault_reveal", json!({ "site": "a.example", "account": "me" })),
                ("wallet_export", json!({ "passphrase": "a long passphrase" })),
                ("keep_card_codes", json!({ "on": true })),
                ("card_limit", json!({ "card": "kast", "site": "a.example", "per_payment": 50.0, "per_day": 100.0 })),
            ] {
                match owner(&node, name, a).await {
                    Err(OwnerError::Failed(m)) => assert!(m.contains("dialog"), "{name}: {m}"),
                    Ok(v) => panic!("{name} ran with no yes in the dialog: {v}"),
                    Err(OwnerError::Unknown) => panic!("{name} is unknown"),
                }
            }
        });
    }

    /// Letting the sdk approve payments is itself the owner's yes in the dialog: the owner token alone, no dialog or a
    /// no leaves it at the dialog, and so does a record of it the node's key didn't seal (a hand-written file). Going
    /// back to the dialog asks nothing.
    #[test]
    fn letting_the_sdk_approve_payments_needs_the_dialog() {
        let home = store::scratch_home("approver-switch");
        let (rt, node) = scratch_node(&home);
        rt.block_on(async {
            for answer in [None, Some(false)] {
                crate::owner_dialog::answer_in_test(answer);
                assert!(owner(&node, "payment_approver", json!({ "approver": "sdk" })).await.is_err());
                assert_eq!(owner(&node, "payment_approver", json!({})).await.ok().unwrap()["approver"], "dialog");
            }
            assert_eq!(crate::owner_dialog::asked_in_test().len(), 2);
            std::fs::write(crate::owner_dialog::approver_file(), r#"{"approver":"sdk","since":1,"mac":"00"}"#).unwrap();
            assert_eq!(owner(&node, "payment_approver", json!({})).await.ok().unwrap()["approver"], "dialog", "a record the node didn't seal");
            crate::owner_dialog::answer_in_test(Some(true));
            assert_eq!(owner(&node, "payment_approver", json!({ "approver": "sdk" })).await.ok().unwrap()["approver"], "sdk");
            crate::owner_dialog::answer_in_test(None);
            assert_eq!(owner(&node, "payment_approver", json!({ "approver": "dialog" })).await.ok().unwrap()["approver"], "dialog");
            assert_eq!(crate::owner_dialog::asked_in_test().len(), 3, "going back asked nothing");
            assert!(!crate::owner_dialog::approver_file().exists());
            assert!(owner(&node, "payment_approver", json!({ "approver": "anyone" })).await.is_err());
        });
    }

    // ---- UNB-147: sign-in and code asks answered away from the machine ----

    /// A sign-in ask waiting on the owner at `site`, as `ask_owner` makes one: the ask and its id.
    async fn sign_in_waits(site: &'static str) -> (tokio::task::JoinHandle<hands::Answer>, String) {
        let waiting = tokio::spawn(hands::ask(site, None, "type the two-step code the site sent", "claude-code", std::time::Duration::from_secs(30), None, |_| {}));
        loop {
            if let Some(a) = hands::asks().into_iter().find(|a| a.site == site) {
                return (waiting, a.id);
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }

    /// Answering from another device is off until the owner says yes in the dialog: the token alone, no dialog or a
    /// no leaves it off, and so does a record the node's key didn't seal. Off asks nothing. A device saying it is there
    /// counts only while it is on.
    #[test]
    fn answering_asks_from_another_device_is_off_until_the_owner_says_yes() {
        let home = store::scratch_home("remote-answers-switch");
        let (rt, node) = scratch_node(&home);
        rt.block_on(async {
            assert_eq!(owner(&node, "remote_answers", json!({})).await.ok().unwrap()["on"], false, "off by default");
            for answer in [None, Some(false)] {
                crate::owner_dialog::answer_in_test(answer);
                assert!(owner(&node, "remote_answers", json!({ "on": true })).await.is_err());
                assert_eq!(owner(&node, "remote_answers", json!({ "via": "Telegram" })).await.ok().unwrap()["on"], false);
            }
            std::fs::write(crate::owner_dialog::remote_answers_file(), r#"{"approver":"on","since":1,"mac":"00"}"#).unwrap();
            assert_eq!(owner(&node, "remote_answers", json!({})).await.ok().unwrap()["on"], false, "a record the node didn't seal");
            let asked = crate::owner_dialog::asked_in_test().len();
            crate::owner_dialog::answer_in_test(Some(true));
            assert_eq!(owner(&node, "remote_answers", json!({ "on": true })).await.ok().unwrap()["on"], true);
            assert_eq!(crate::owner_dialog::asked_in_test().len(), asked + 1, "turning it on asked the dialog");
            owner(&node, "remote_answers", json!({ "via": "Telegram" })).await.ok().unwrap();
            assert!(hands::away_there(), "the device that said so is there");
            crate::owner_dialog::answer_in_test(None);
            assert_eq!(owner(&node, "remote_answers", json!({ "on": false })).await.ok().unwrap()["on"], false);
            assert_eq!(crate::owner_dialog::asked_in_test().len(), asked + 1, "turning it off asked nothing");
            assert!(!crate::owner_dialog::remote_answers_file().exists());
        });
    }

    /// A code from another device is typed only for a sign-in ask that still waits, with remote answers on: off, an
    /// ask that isn't waiting, a card payment's ask, or a code that isn't one types nothing and leaves the ask waiting.
    /// Nothing the node answers holds the code.
    #[test]
    fn a_code_from_another_device_answers_only_a_waiting_sign_in_ask() {
        let home = store::scratch_home("remote-answers-code");
        let (rt, node) = scratch_node(&home);
        rt.block_on(async {
            let site = "code-ask.example";
            let (waiting, id) = sign_in_waits(site).await;
            let code = "482913";
            match owner(&node, "hands_answer", json!({ "site": site, "ask": id, "text": code, "via": "Telegram" })).await {
                Err(OwnerError::Failed(m)) => assert!(m.contains("is off") && !m.contains(code), "{m}"),
                other => panic!("typed with remote answers off: {:?}", other.ok()),
            }
            crate::owner_dialog::answer_in_test(Some(true));
            owner(&node, "remote_answers", json!({ "on": true })).await.ok().unwrap();
            let long = "9".repeat(65);
            for (ask, text, said) in [("ask-0-0", code, "isn't waiting"), (id.as_str(), "", "printable"), (id.as_str(), "48\n29", "printable"), (id.as_str(), long.as_str(), "printable")] {
                match owner(&node, "hands_answer", json!({ "site": site, "ask": ask, "text": text })).await {
                    Err(OwnerError::Failed(m)) => assert!(m.contains(said) && m.contains("nothing was typed") && !m.contains(code), "{m}"),
                    other => panic!("{ask}: {:?}", other.ok()),
                }
            }
            // A waiting ask whose site has no browser open: refused, nothing typed, the ask still waits.
            match owner(&node, "hands_answer", json!({ "site": site, "ask": id, "text": code })).await {
                Err(OwnerError::Failed(m)) => assert!(!m.contains(code), "{m}"),
                other => panic!("answered with no page: {:?}", other.ok()),
            }
            assert!(hands::asks().iter().any(|a| a.id == id), "the ask waits on");
            let said = store::read_activity(20).into_iter().map(|a| a.what).collect::<Vec<_>>().join("\n");
            assert!(!said.contains(code), "the code is never logged: {said}");
            // A card payment's ask is answered by the payment approver, never by a code.
            owner(&node, "hands_give_back", json!({ "site": site, "done": false, "ask": id })).await.ok().unwrap();
            assert_eq!(waiting.await.unwrap(), hands::Answer::Declined);
            let (waiting, id) = payment_waits("code-pay.example").await;
            match owner(&node, "hands_answer", json!({ "site": "code-pay.example", "ask": id, "text": code })).await {
                Err(OwnerError::Failed(m)) => assert!(m.contains("card payment"), "{m}"),
                other => panic!("a code answered a payment: {:?}", other.ok()),
            }
            owner(&node, "hands_give_back", json!({ "site": "code-pay.example", "done": false, "ask": id })).await.ok().unwrap();
            assert_eq!(waiting.await.unwrap(), hands::Answer::Declined);
        });
    }

    /// The owner is shown the writes the node keeps (each by what it is and what it moved, and a hint only where the chain
    /// was read), none when none is kept; and a rank asked of entries that aren't entries is answered with none, with
    /// nothing read.
    #[test]
    fn the_owner_is_shown_the_writes_the_node_keeps_and_ranks_for_no_entries_come_back_empty() {
        let home = store::scratch_home("owner-kept-shown");
        let (rt, node) = scratch_node(&home);
        let run = |cmd: &str, a: Value| match rt.block_on(owner(&node, cmd, a)) {
            Ok(v) => v,
            Err(OwnerError::Failed(m)) => panic!("{cmd}: {m}"),
            Err(OwnerError::Unknown) => panic!("{cmd} is unknown"),
        };
        assert_eq!(run("chain_kept", json!({})), json!([]), "nothing is kept");
        crate::inflight::keep_for_test(crate::inflight::Sending {
            key: "deposit".into(),
            what: "the deposit".into(),
            signer: alloy::primitives::Address::ZERO,
            nonce: 7,
            tx: alloy::primitives::B256::repeat_byte(4),
            raw: alloy::primitives::Bytes::new(),
            at: 11,
            amount: 5.0,
            book: None,
            others: Vec::new(),
            told: false,
            watch: None,
        });
        let kept = run("chain_kept", json!({}));
        let t = types();
        let c = OWNER_COMMANDS.iter().find(|c| c.name == "chain_kept").unwrap();
        check(&(c.returns)(), &kept, &t).unwrap_or_else(|e| panic!("chain_kept answered {kept}: {e}"));
        assert_eq!((kept[0]["key"].as_str(), kept[0]["nonce"].as_u64(), kept[0]["amount"].as_f64(), kept[0]["changed"].clone()), (Some("deposit"), Some(7), Some(5.0), Value::Null), "{kept}");
        assert_eq!(kept.as_array().map(Vec::len), Some(1));
        assert_eq!(run("coin_rank", json!({ "entries": ["not an entry", " "] })), json!({}), "an id that isn't one names no rank");
    }
}

#[cfg(test)]
#[path = "commands_cov_tests.rs"]
mod commands_cov_tests;
