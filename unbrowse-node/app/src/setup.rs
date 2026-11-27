//! The node's setup as one list, owned here and read by every surface: the window draws it, `unbrowse-node onboard`
//! walks it and `onboard status` prints it (`setup_status`), and an agent reads it and acts on it with `unbrowse_setup`.
//! One list means a step added here shows up on every surface at once, rather than being written three times and
//! drifting apart.
//!
//! An agent never needs a terminal for any of it, and never hands its person a command: each step that needs the person
//! is a yes in the node's own dialog (`owner_dialog::ask`), asked when the agent acts on it, or a link to open
//! (`person`). The agent sees the answer, never what the person typed.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::{connect, import, legacy, store, terms, Node};

/// Where the terms are read, named in the dialog that asks the owner to accept them.
pub const TERMS_PAGE: &str = "https://unbrowse.ai/terms";

/// What `unbrowse_setup` takes as `do`.
/// With none, the list itself.
pub const DOES: &[&str] = &["accept_terms", "sign_in", "connect_apps", "tools", "web", "connect_site"];

/// One step of the list: its id, whether it is done, whether setup is complete without it, a line saying where it
/// stands, and, while it isn't done, the call that does it (`next`, type `Next`).
fn step(id: &str, done: bool, optional: bool, said: String, does: Option<&str>) -> Value {
    let next = (!done).then_some(does).flatten().map(|d| json!({ "tool": "unbrowse_setup", "args": { "do": d } }));
    json!({ "id": id, "done": done, "optional": optional, "said": said, "next": next })
}

/// The agent apps found on this machine (by their programs, `connect::Client::found`), each with whether it is
/// connected to this node. Apps set up by hand in their own projects (`manual`) aren't the node's to connect.
fn apps(node: &Arc<Node>) -> Vec<connect::Status> {
    let base = format!("http://127.0.0.1:{}", node.info.api_port);
    let entry = connect::entry(std::path::Path::new(&crate::agents::unb_program()), &base);
    let mut found: Vec<connect::Status> =
        connect::clients(&legacy::Machine::here(&base), &entry).into_iter().filter(|c| c.found && !c.manual).collect();
    crate::heard::stamp(&mut found);
    found
}

/// The names in `list`, said as a list: "Cursor, Codex and opencode".
fn names(list: &[&str]) -> String {
    match list {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// What the apps step adds about the connected apps that haven't reached the node yet (`quiet`, of `connected` in all):
/// an app connected but never opened since doesn't use Unbrowse until it starts again.
fn quiet_said(quiet: &[&str], connected: usize) -> String {
    match quiet.len() {
        0 => String::new(),
        n if n == connected => "; none has reached it yet: open one to start it".into(),
        _ => format!("; not heard from yet: {}", names(quiet)),
    }
}

/// The list, read from the node as it is now: the terms, signing in, the agent apps on this machine, the address for
/// ChatGPT and Claude on the web, the sites the node holds a sign-in for, and whether an agent has called it yet.
pub fn status(node: &Arc<Node>) -> Value {
    let s = store::load_settings();
    let mut steps = Vec::new();

    let terms_done = s.terms_accepted.as_deref() == Some(terms::TERMS_VERSION);
    let network = if s.peer_network { "it joins the peer network" } else { "it stays off the peer network" };
    steps.push(step(
        "terms",
        terms_done,
        false,
        if terms_done { format!("terms {} acknowledged; {network}", terms::TERMS_VERSION) } else { terms::due() },
        Some("accept_terms"),
    ));

    let owner = crate::link::status(node).ok().and_then(|l| l["owner"].as_str().map(str::to_string));
    steps.push(step(
        "sign_in",
        owner.is_some(),
        true,
        match &owner {
            Some(o) => format!("signed in as {o}"),
            None => "not signed in: the node works without it, and signing in lets it list and earn under your account".into(),
        },
        Some("sign_in"),
    ));

    let found = apps(node);
    let connected: Vec<&str> = found.iter().filter(|c| c.connected).map(|c| c.name).collect();
    let waiting: Vec<&str> = found.iter().filter(|c| !c.connected).map(|c| c.name).collect();
    let quiet: Vec<&str> = found.iter().filter(|c| c.connected && c.heard.is_none()).map(|c| c.name).collect();
    let said: String = match (connected.is_empty(), waiting.is_empty()) {
        (true, true) => "no agent app found on this computer".into(),
        (false, true) => format!("connected: {}", names(&connected)),
        (true, false) => format!("found, not connected yet: {}", names(&waiting)),
        (false, false) => format!("connected: {}; not yet: {}", names(&connected), names(&waiting)),
    };
    steps.push(step(
        "apps",
        waiting.is_empty(),
        true,
        said + &quiet_said(&quiet, connected.len()),
        Some("connect_apps"),
    ));

    // The skill an agent reads, and the commands, put in place by the app itself: a disk image runs no code when it is
    // dragged in, so this is where that half of an install happens (`install.rs`).
    let machine = legacy::Machine::here(&format!("http://127.0.0.1:{}", node.info.api_port));
    let (holds, missing) = crate::install::found(&machine);
    steps.push(step(
        "tools",
        missing.is_empty(),
        true,
        match (holds.is_empty(), missing.is_empty()) {
            (true, _) => "no agent on this computer reads skills".into(),
            (false, true) => format!("the Unbrowse skill is where {} read skills", names(&holds.iter().map(String::as_str).collect::<Vec<_>>())),
            (false, false) => format!("the Unbrowse skill isn't where {} read skills yet", names(&missing.iter().map(String::as_str).collect::<Vec<_>>())),
        },
        Some("tools"),
    ));

    let remote = crate::remote::status();
    let web = remote["on"].as_bool() == Some(true);
    steps.push(step(
        "web",
        web,
        true,
        if web { format!("ChatGPT and Claude on the web reach this node at {}", remote["url"].as_str().unwrap_or("its address")) } else { "off: ChatGPT and Claude on the web can't reach this node".into() },
        Some("web"),
    ));

    let sites: Vec<String> = crate::sessions().into_iter().map(|v| v.host).collect();
    steps.push(step(
        "sites",
        !sites.is_empty(),
        true,
        if sites.is_empty() { "no site connected yet".into() } else { format!("signed in on {}", names(&sites.iter().map(String::as_str).collect::<Vec<_>>())) },
        Some("connect_site"),
    ));

    let first = store::read_activity(500).into_iter().find(|a| a.kind == "call" && a.who != "You" && a.who != "Node");
    steps.push(step(
        "first_call",
        first.is_some(),
        true,
        match &first {
            Some(a) => format!("{} has called it ({} on {})", a.who, a.what, a.site),
            None => "no agent has called it yet".into(),
        },
        None,
    ));

    let left: Vec<Value> = steps.iter().filter(|s| s["done"] == false && s["optional"] == false).map(|s| s["id"].clone()).collect();
    json!({ "steps": steps, "left": left })
}

/// What `unbrowse_setup` answers: the list, what it did (`did`, `ok`, `said`), and what the agent hands its person
/// (`person`, type `ForPerson`) when there is something only they can do.
fn answered(node: &Arc<Node>, did: &str, ok: bool, said: String, person: Option<Value>) -> Value {
    let mut out = status(node);
    out["did"] = json!(did);
    out["ok"] = json!(ok);
    out["said"] = json!(said);
    out["person"] = person.unwrap_or(Value::Null);
    out
}

/// Who is asking, as the dialog names them: the agent's own name, or, for the key every agent app on this machine
/// shares (`agents::FIRST`, "Your agents"), "One of your agents".
fn asker(agent: &str) -> String {
    if agent == crate::agents::FIRST || agent.trim().is_empty() { "One of your agents".into() } else { agent.to_string() }
}

/// Asks the owner `question` in the node's own dialog: Ok on their yes. Their no, or no answer, is the error.
async fn owner_says_yes(node: &Arc<Node>, question: String) -> Result<(), String> {
    crate::owner_dialog::ask(node.key().ok(), question).await
}

/// `unbrowse_setup`: the list (`status`), or one step done for agent `agent`, each change asked of the owner first in
/// the node's own dialog. A no is an answer, not a failure: `ok` false and what was said.
pub async fn act(node: &Arc<Node>, agent: &str, what: &str, host: Option<&str>) -> Result<Value, String> {
    let agent = asker(agent);
    match what {
        "" | "status" => Ok(answered(node, "status", true, "the node's setup as it stands".into(), None)),
        "accept_terms" => {
            let s = store::load_settings();
            if s.terms_accepted.as_deref() == Some(terms::TERMS_VERSION) {
                return Ok(answered(node, what, true, "the terms are acknowledged already".into(), None));
            }
            let q = format!(
                "{agent} asks you to accept the Unbrowse terms (version {}), so this node can {}.\n\nRead them at {TERMS_PAGE}.\n\nAccept them?",
                terms::TERMS_VERSION,
                if s.peer_network { "join the peer network" } else { "go on, off the peer network as you chose" }
            );
            match owner_says_yes(node, q).await {
                Ok(()) => {
                    let s = tokio::task::spawn_blocking(move || crate::accept_terms(!s.peer_network)).await.map_err(|e| e.to_string())??;
                    let network = if s.peer_network { "the node joins the peer network" } else { "the node stays off the peer network" };
                    Ok(answered(node, what, true, format!("accepted terms {}: {network}", terms::TERMS_VERSION), None))
                }
                Err(why) => Ok(answered(node, what, false, why, None)),
            }
        }
        "sign_in" => {
            if crate::link::status(node).ok().and_then(|l| l["owner"].as_str().map(str::to_string)).is_some() {
                return Ok(answered(node, what, true, "signed in already".into(), None));
            }
            let started = crate::link::start(node).await?;
            let url = started["url"].as_str().unwrap_or_default().to_string();
            let opened = started["opened"].as_bool() == Some(true);
            let person = json!({
                "kind": "link",
                "url": url,
                "say": "Sign in to Unbrowse on this page. Unbrowse then asks you on your computer's screen to link it.",
            });
            Ok(answered(node, what, true, if opened { "the sign-in page is open in the person's browser".into() } else { "give the person the sign-in page".into() }, Some(person)))
        }
        "connect_apps" => {
            let waiting: Vec<connect::Status> = apps(node).into_iter().filter(|c| !c.connected).collect();
            if waiting.is_empty() {
                return Ok(answered(node, what, true, "no app on this computer is waiting to be connected".into(), None));
            }
            let shown: Vec<&str> = waiting.iter().map(|c| c.name).collect();
            let q = format!(
                "{agent} asks to connect Unbrowse to {} on this computer.\n\nEach app's settings file is kept as it was beside it, and Undo on the Unbrowse app's Agents screen puts them back.\n\nConnect them?",
                names(&shown)
            );
            if let Err(why) = owner_says_yes(node, q).await {
                return Ok(answered(node, what, false, why, None));
            }
            let ids = waiting.iter().map(|c| c.id.to_string()).collect();
            let done = crate::agent_connect(node, ids).await?;
            let results = done["results"].as_array().cloned().unwrap_or_default();
            let ok: Vec<&str> = results.iter().filter(|r| r["ok"] == true).filter_map(|r| r["name"].as_str()).collect();
            let restart: Vec<&str> = results.iter().filter(|r| r["ok"] == true && r["restart_needed"] == true).filter_map(|r| r["name"].as_str()).collect();
            let failed: Vec<String> = results.iter().filter(|r| r["ok"] != true).map(|r| format!("{} ({})", r["name"].as_str().unwrap_or("?"), r["error"].as_str().unwrap_or("it didn't work"))).collect();
            let mut said = if ok.is_empty() { "nothing was connected".to_string() } else { format!("connected {}", names(&ok)) };
            if !failed.is_empty() {
                said.push_str(&format!("; not {}", failed.join(", ")));
            }
            let person = (!restart.is_empty()).then(|| json!({ "kind": "app", "say": format!("Quit and reopen {} to use Unbrowse there.", names(&restart)) }));
            Ok(answered(node, what, failed.is_empty(), said, person))
        }
        "tools" => {
            let m = legacy::Machine::here(&format!("http://127.0.0.1:{}", node.info.api_port));
            let (_, missing) = crate::install::found(&m);
            if missing.is_empty() {
                return Ok(answered(node, what, true, "the Unbrowse skill is where this computer's agents read skills".into(), None));
            }
            let q = format!(
                "{agent} asks to put the Unbrowse skill where {} read skills on this computer, and the Unbrowse commands on your PATH.\n\nWhat is there already that Unbrowse didn't write is kept beside it, never deleted.\n\nDo it?",
                names(&missing.iter().map(String::as_str).collect::<Vec<_>>())
            );
            if let Err(why) = owner_says_yes(node, q).await {
                return Ok(answered(node, what, false, why, None));
            }
            let programs = std::path::PathBuf::from(crate::agents::unb_program()).parent().map(|d| d.to_path_buf()).unwrap_or_default();
            let done = tokio::task::spawn_blocking(move || crate::install::run(&m, &programs, crate::install::Parts::ALL, false)).await.map_err(|e| e.to_string())?;
            if done.skipped.is_none() {
                if let Ok(_held) = store::settings_held() {
                    let mut s = store::load_settings();
                    s.tools_skill = Some(crate::install::skill_hash());
                    s.tools_at = Some(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
                    let _ = store::save_settings(&s);
                }
            }
            Ok(answered(node, what, done.skipped.is_none(), done.said(), None))
        }
        "web" => {
            if crate::remote::status()["on"] == true {
                return Ok(answered(node, what, true, "the address is on already".into(), None));
            }
            let q = format!(
                "{agent} asks to turn on this node's address at unbrowse.ai, so ChatGPT and Claude on the web can reach it.\n\nThe node dials out: no port opens on this computer, and an app gets in only when you allow its sign-in here.\n\nTurn it on?"
            );
            if let Err(why) = owner_says_yes(node, q).await {
                return Ok(answered(node, what, false, why, None));
            }
            tokio::task::spawn_blocking(|| crate::remote::set(true, None)).await.map_err(|e| e.to_string())??;
            // The account link: one sign-in with the account the person uses Unbrowse with in ChatGPT or Claude, and the
            // Unbrowse connector there reaches this node, with no address to paste. The node asks before it is linked.
            let link = crate::remote::Remote::load().account_link().unwrap_or_default();
            let person = json!({
                "kind": "link",
                "url": link,
                "say": "Open this page and sign in with the Unbrowse account you use in ChatGPT or Claude, then say yes when Unbrowse asks on your computer. The Unbrowse connector there then reaches this computer.",
            });
            Ok(answered(node, what, true, "the address is on; the person links it to their account on the page in person".into(), Some(person)))
        }
        "connect_site" => {
            let host = host.map(str::trim).filter(|h| !h.is_empty()).ok_or("connect_site needs host: the site to connect, such as github.com")?;
            let host = host.trim_start_matches("https://").trim_start_matches("http://").split('/').next().unwrap_or_default().to_ascii_lowercase();
            if !crate::is_host(&host) {
                return Err(format!("{host:?} isn't a site's host: name it as github.com"));
            }
            let q = format!(
                "{agent} asks to use your own browser's sign-in for {host}, so it can act there as you.\n\nThe node reads only {host}'s cookies from your browser, and keeps them as its session for {host}.\n\nUse it?"
            );
            if let Err(why) = owner_says_yes(node, q).await {
                return Ok(answered(node, what, false, why, None));
            }
            let h = host.clone();
            match tokio::task::spawn_blocking(move || import::session(&h)).await.map_err(|e| e.to_string())? {
                Ok(kept) => Ok(answered(node, what, true, format!("connected {}: {} cookies kept as its session", kept.host, kept.cookies), None)),
                Err(why) => {
                    // No sign-in to copy: the person signs in once on the node's own page instead, which the agent opens.
                    let person = json!({
                        "kind": "dialog",
                        "say": format!("Sign in to {host} on the page Unbrowse shows on your computer's screen."),
                    });
                    Ok(answered(
                        node,
                        what,
                        false,
                        format!("{why}. Open {host}'s sign-in page with unbrowse_browse and use ask_owner: the person signs in on their own screen, and the node keeps that sign-in"),
                        Some(person),
                    ))
                }
            }
        }
        other => Err(format!("do is one of {}, not {other:?}", DOES.join(", "))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A node with no setup done, in its own home, and a runtime that answers on this thread: the dialog's answer in a
    /// test is this thread's (`owner_dialog::answer_in_test`).
    fn fresh(name: &str) -> (std::path::PathBuf, tokio::runtime::Runtime, Arc<Node>) {
        let home = store::scratch_home(name);
        let h = home.clone();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().on_thread_start(move || store::use_home(&h)).build().unwrap();
        store::use_home(&home);
        let keys = unbrowse_core::MemoryStore::default();
        let id = unbrowse_core::load_or_create(&keys).unwrap();
        let node = Arc::new(Node {
            keys: Box::new(keys),
            identity: std::sync::RwLock::new(Some(Ok(crate::IdentityView { address: id.address.to_checksum(), created: true }))),
            info: crate::NodeInfo { name: "test".into(), version: "test".into(), api_port: 0, dev: true },
            walks: crate::learn::Walks::default(),
            chain: crate::chain::Chain::default(),
            chain_error: std::sync::Mutex::new(None),
            events: crate::api::Events::default(),
            net: std::sync::OnceLock::new(),
            share: crate::share::Share::default(),
        });
        (home, rt, node)
    }

    fn ids(list: &Value) -> Vec<&str> {
        list["steps"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect()
    }

    /// Every word of the list and of what a step answers is for an agent that may have no terminal: none names a
    /// command (`said_to_agents`).
    fn names_no_command(v: &Value) {
        let text = v.to_string();
        assert!(crate::said_to_agents::commands_in(&text).is_empty() && !text.contains("unbrowse-node "), "{text}");
    }

    /// A new node's list: the terms first and the only step setup needs; signing in, the apps, the skill and the commands
    /// where this computer's agents read them, the web address, a site and a first call are each the owner's to do or not.
    /// Each step not done names the unbrowse_setup call that does it.
    #[test]
    fn a_new_nodes_list_names_every_step_and_needs_only_the_terms() {
        let (home, _rt, node) = fresh("setup-list");
        let list = status(&node);
        assert_eq!(ids(&list), ["terms", "sign_in", "apps", "tools", "web", "sites", "first_call"]);
        assert_eq!(list["left"], json!(["terms"]));
        let terms = &list["steps"][0];
        assert_eq!((terms["done"].clone(), terms["next"].clone()), (json!(false), json!({ "tool": "unbrowse_setup", "args": { "do": "accept_terms" } })));
        assert_eq!(list["steps"][6]["next"], Value::Null, "a first call is the agent's own to make");
        crate::apischema::check(&crate::apischema::r("SetupStatus"), &json!({ "steps": list["steps"], "left": list["left"] }), &crate::apischema::types()).unwrap();
        names_no_command(&list);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The terms are accepted only on the owner's yes in the node's own dialog, which names the agent asking and where
    /// the terms are read; a no leaves them as they were and is an answer, not a failure.
    #[test]
    fn the_terms_are_accepted_only_on_the_owners_yes() {
        let (home, rt, node) = fresh("setup-terms");
        crate::owner_dialog::answer_in_test(Some(false));
        let no = rt.block_on(act(&node, "Claude", "accept_terms", None)).unwrap();
        assert_eq!((no["ok"].clone(), no["did"].clone()), (json!(false), json!("accept_terms")), "{no}");
        assert_eq!(store::load_settings().terms_accepted, None);
        let asked = crate::owner_dialog::asked_in_test();
        assert!(asked.last().is_some_and(|q| q.contains("Claude asks you to accept the Unbrowse terms") && q.contains(TERMS_PAGE)), "{asked:?}");
        let shared = rt.block_on(act(&node, crate::agents::FIRST, "accept_terms", None)).unwrap();
        assert_eq!(shared["ok"], false);
        assert!(crate::owner_dialog::asked_in_test().last().is_some_and(|q| q.starts_with("One of your agents asks")), "the shared key is named as what it is");
        crate::owner_dialog::answer_in_test(Some(true));
        let yes = rt.block_on(act(&node, "Claude", "accept_terms", None)).unwrap();
        assert_eq!(yes["ok"], true, "{yes}");
        assert_eq!(store::load_settings().terms_accepted.as_deref(), Some(terms::TERMS_VERSION));
        assert_eq!(yes["left"], json!([]), "nothing setup needs is left");
        crate::apischema::check(&crate::apischema::r("Setup"), &yes, &crate::apischema::types()).unwrap();
        names_no_command(&yes);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A site to connect is named as a host; anything else is refused before the owner is asked, and so is a step
    /// unbrowse_setup doesn't know.
    #[test]
    fn a_site_is_a_host_and_a_step_is_one_of_the_list() {
        let (home, rt, node) = fresh("setup-site");
        crate::owner_dialog::answer_in_test(Some(true));
        let before = crate::owner_dialog::asked_in_test().len();
        assert!(rt.block_on(act(&node, "Claude", "connect_site", None)).unwrap_err().contains("needs host"));
        assert!(rt.block_on(act(&node, "Claude", "connect_site", Some("not a host"))).unwrap_err().contains("isn't a site's host"));
        assert!(rt.block_on(act(&node, "Claude", "make_coffee", None)).unwrap_err().contains("do is one of"));
        assert_eq!(crate::owner_dialog::asked_in_test().len(), before, "nothing was asked of the owner");
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
#[path = "setup_cov_tests.rs"]
mod setup_cov_tests;
