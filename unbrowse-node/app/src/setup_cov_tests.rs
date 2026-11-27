//! Coverage tests for `setup.rs`: the owner's no to a step an agent asks for, in the node's own dialog.

use super::*;

/// A node with no setup done, in its own home, and a runtime that answers on this thread.
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

/// Turning on the node's address is asked in the dialog, naming the agent and what it means; a no leaves it off.
/// A step of the setup list by its id, wherever the list puts it.
fn by_id<'a>(list: &'a serde_json::Value, id: &str) -> &'a serde_json::Value {
    list["steps"].as_array().and_then(|s| s.iter().find(|s| s["id"] == id)).unwrap_or_else(|| panic!("no step {id} in {list}"))
}

#[test]
fn the_web_address_stays_off_when_the_owner_says_no() {
    let (home, rt, node) = fresh("setup-cov-web-no");
    crate::owner_dialog::answer_in_test(Some(false));
    let no = rt.block_on(act(&node, "Claude", "web", None)).unwrap();
    assert_eq!((no["ok"].clone(), no["did"].clone()), (json!(false), json!("web")), "{no}");
    let asked = crate::owner_dialog::asked_in_test();
    assert!(asked.last().is_some_and(|q| q.starts_with("Claude asks to turn on this node's address") && q.contains("no port opens")), "{asked:?}");
    assert_eq!(crate::remote::status()["on"], false);
    assert_eq!(by_id(&no, "web")["done"], false, "the list still says it is off");
    let _ = std::fs::remove_dir_all(&home);
}

/// A site named as a web address is cut down to its host before the owner is asked, and a no is an answer that leaves
/// the node with no session there.
#[test]
fn a_site_named_by_its_address_is_asked_about_by_its_host_and_a_no_keeps_nothing() {
    let (home, rt, node) = fresh("setup-cov-site-no");
    crate::owner_dialog::answer_in_test(Some(false));
    let no = rt.block_on(act(&node, "Claude", "connect_site", Some("  https://GitHub.com/login?x=1 "))).unwrap();
    assert_eq!((no["ok"].clone(), no["did"].clone()), (json!(false), json!("connect_site")), "{no}");
    let asked = crate::owner_dialog::asked_in_test();
    let q = asked.last().expect("the owner was asked");
    assert!(q.starts_with("Claude asks to use your own browser's sign-in for github.com,") && !q.contains("login?x=1"), "{q}");
    assert!(crate::sessions().is_empty(), "no session was taken");
    let _ = std::fs::remove_dir_all(&home);
}

/// The step an agent is told to do next for each thing not yet done is the call that does it.
#[test]
fn a_status_asked_by_name_is_the_list_and_a_step_not_done_says_what_does_it() {
    let (home, rt, node) = fresh("setup-cov-status-names");
    for what in ["", "status"] {
        let list = rt.block_on(act(&node, "Claude", what, None)).unwrap();
        assert_eq!((list["did"].clone(), list["ok"].clone()), (json!("status"), json!(true)), "{what:?}");
        assert_eq!(by_id(&list, "sign_in")["next"], json!({ "tool": "unbrowse_setup", "args": { "do": "sign_in" } }));
        assert_eq!(by_id(&list, "web")["next"], json!({ "tool": "unbrowse_setup", "args": { "do": "web" } }));
        assert_eq!(by_id(&list, "sites")["next"], json!({ "tool": "unbrowse_setup", "args": { "do": "connect_site" } }));
    }
    assert_eq!(names(&["Cursor"]), "Cursor");
    assert_eq!(names(&["Cursor", "Codex", "opencode"]), "Cursor, Codex and opencode");
    assert_eq!(quiet_said(&["a"], 1), "; none has reached it yet: open one to start it");
    assert_eq!(quiet_said(&["a", "b"], 3), "; not heard from yet: a and b");
    assert_eq!(quiet_said(&[], 3), "");
    let _ = std::fs::remove_dir_all(&home);
}
