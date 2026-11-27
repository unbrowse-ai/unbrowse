//! Coverage tests for `setups.rs`: what the sign-in walk sends the browser, what a shared sign-in refuses, and what is
//! let go when a taken sign-in fails.

use super::*;
use std::cell::RefCell;

fn choice(steps: Vec<Step>) -> Setup {
    Setup { kind: Kind::Choice, page: "https://shop.example/store".into(), asks: None, earns: Vec::new(), steps, native: None, sealed: None }
}

fn sign_in() -> Setup {
    Setup {
        kind: Kind::SignIn,
        page: "https://shop.example.com/login".into(),
        asks: None,
        earns: Vec::new(),
        native: None,
        sealed: None,
        steps: vec![
            Step::Fill { at: "#email".into(), value: "me@mail.example".into() },
            Step::Fill { at: "#password".into(), value: "vault:shop.example.com:me".into() },
            Step::Click { at: "#go".into() },
        ],
    }
}

fn native_on_public_site() -> serde_json::Value {
    serde_json::json!({ "provisional": false, "steps": [{
        "exchange": 0, "method": "POST", "status": 302, "url": "https://shop.example.com/session", "needs_browser": false,
        "fields": [
            { "loc": { "in": "form", "key": "email" }, "class": "input", "name": "email", "secret": false, "default": "me@mail.example" },
            { "loc": { "in": "form", "key": "password" }, "class": "input", "name": "password", "secret": true, "default": "vault:shop.example.com:me" },
        ] }] })
}

const PUBLIC: &str = "shop.example.com";

fn keys_with_login() -> unbrowse_core::MemoryStore {
    let keys = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys).unwrap();
    crate::vault::add(&crate::vault_keep(Ok(&keys)).unwrap(), PUBLIC, "me", "stored", Some("hunter2-pass"), "You").unwrap();
    keys
}

/// Keeps `native` as the public site's sign-in, sealed into the vault `keys` hold.
fn keep_native(keys: &unbrowse_core::MemoryStore, native: serde_json::Value) {
    let kept = seal(PUBLIC, Setup { native: Some(native), ..sign_in() }, Some(keys));
    assert!(kept.sealed.is_some(), "{kept:?}");
    store::write_json(&path(&unbrowse_learn::identity::site_of(PUBLIC)), &unbrowse_files::SETUPS, &vec![kept]).unwrap();
}

#[test]
fn every_kind_of_step_reaches_the_browser_as_its_own_command() {
    let log = RefCell::new(Vec::new());
    let mut act = |a: &[String]| {
        log.borrow_mut().push(a.join(" "));
        Ok(String::new())
    };
    let mut vault = |_: &[String]| Err("the vault is not for a plain fill".to_string());
    let s = choice(vec![
        Step::Fill { at: "#name".into(), value: "Ann".into() },
        Step::Select { at: "#size".into(), value: "L".into() },
        Step::Check { at: "#terms".into() },
        Step::Uncheck { at: "#news".into() },
        Step::Click { at: "#go".into() },
        Step::Press { key: "Enter".into() },
    ]);
    steps(&s, &mut act, &mut vault).unwrap();
    let said = log.into_inner();
    let commands: Vec<&str> = said.iter().filter(|c| !c.starts_with("wait #")).map(String::as_str).collect();
    assert_eq!(commands, ["open https://shop.example/store", "fill #name Ann", "select #size L", "check #terms", "uncheck #news", "click #go", "press Enter", "wait 2500"], "{said:?}");
    assert_eq!(said.iter().filter(|c| c.starts_with("wait #")).count(), 5, "each step with a place waits for it first, a key press needs none");
}

#[test]
fn a_page_that_lacks_the_place_a_step_aims_at_says_which() {
    let mut act = |a: &[String]| if a[0] == "wait" && a[1] == "#size" { Err("timed out".to_string()) } else { Ok(String::new()) };
    let mut vault = |_: &[String]| Ok(String::new());
    let s = choice(vec![Step::Select { at: "#size".into(), value: "L".into() }]);
    assert_eq!(steps(&s, &mut act, &mut vault), Err("the page has no #size: timed out".to_string()));
}

#[test]
fn a_login_the_vault_cannot_type_stops_the_walk_with_its_reason() {
    let log = RefCell::new(Vec::new());
    let mut act = |a: &[String]| {
        log.borrow_mut().push(a.join(" "));
        Ok(if a[0] == "get" { "1".to_string() } else { String::new() })
    };
    let mut vault = |_: &[String]| Err("the vault is shut".to_string());
    assert_eq!(steps(&sign_in(), &mut act, &mut vault), Err("the vault is shut".to_string()));
    assert!(!log.borrow().iter().any(|c| c.starts_with("click")), "nothing is clicked after the login failed to go in");
}

/// Each way a kept sign-in is not shared with the routes it serves: a request that asks for more than an account and a
/// password, one that still says the account in its address.
#[test]
fn a_sign_in_that_asks_for_more_than_an_account_or_names_it_in_its_address_is_not_shared() {
    let _one = crate::testchain::one_at_a_time_blocking();
    store::scratch_home("setups-cov-not-shared");
    let keys = keys_with_login();
    keep_native(&keys, native_on_public_site());
    assert!(shared_with(PUBLIC, &keys).is_some(), "the plain sign-in is shared");
    let mut two_accounts = native_on_public_site();
    two_accounts["steps"][0]["fields"].as_array_mut().unwrap().push(serde_json::json!(
        { "loc": { "in": "form", "key": "phone" }, "class": "input", "name": "phone", "secret": false, "default": "5551234" }
    ));
    keep_native(&keys, two_accounts);
    assert!(shared_with(PUBLIC, &keys).is_none(), "two things typed besides the password");
    let mut says_it = native_on_public_site();
    says_it["steps"][0]["url"] = "https://shop.example.com/session/me@mail.example".into();
    keep_native(&keys, says_it);
    assert!(shared_with(PUBLIC, &keys).is_none(), "the account is in the address");
}

#[test]
fn a_taken_sign_in_needs_a_login_the_vault_holds_and_goes_whole_when_it_fails() {
    let _one = crate::testchain::one_at_a_time_blocking();
    store::scratch_home("setups-cov-adopt");
    let keys_a = keys_with_login();
    keep_native(&keys_a, native_on_public_site());
    let shared = shared_with(PUBLIC, &keys_a).unwrap();
    store::scratch_home("setups-cov-adopt-b");
    let keys_b = unbrowse_core::MemoryStore::default();
    unbrowse_core::load_or_create(&keys_b).unwrap();
    let bob = crate::vault::Ref::parse("vault:shop.example.com:bob@mail.example").unwrap();
    // The vault holds no such login: it can't seal the request under it.
    let e = adopt(PUBLIC, &shared, &bob, &keys_b).unwrap_err();
    assert!(e.contains("couldn't be kept under"), "{e}");
    assert!(load("example.com").is_empty());
    crate::vault::add(&crate::vault_keep(Ok(&keys_b)).unwrap(), PUBLIC, "bob@mail.example", "stored", Some("bobs-own-pass"), "You").unwrap();
    adopt(PUBLIC, &shared, &bob, &keys_b).unwrap();
    eprintln!("DBG {:?} {:?}", load("example.com"), load(PUBLIC));
    assert_eq!(load("example.com").len(), 1);
    // The same sign-in taken twice is one sign-in.
    adopt(PUBLIC, &shared, &bob, &keys_b).unwrap();
    assert_eq!(load("example.com").len(), 1);
    // It didn't sign in: it goes whole, request and name, so the next call asks the owner again.
    drop_adopted(PUBLIC, &keys_b);
    assert!(load("example.com").is_empty(), "{:?}", load("example.com"));
    assert!(crate::vault::sign_in(&crate::vault_keep(Ok(&keys_b)).unwrap(), &bob).unwrap().is_none(), "the vault let the request go");
    // A login that is for another site, a new one, or a code is not taken at all.
    let elsewhere = crate::vault::Ref::parse("vault:other.example:bob@mail.example").unwrap();
    assert!(adopt(PUBLIC, &shared, &elsewhere, &keys_b).unwrap_err().contains("isn't a login for"));
}

#[test]
fn a_site_with_no_kept_sign_in_is_not_signed_in_now() {
    let _one = crate::testchain::one_at_a_time_blocking();
    store::scratch_home("setups-cov-sign-in-now");
    let keys = keys_with_login();
    assert!(!sign_in_now("nothing.example", "nothing.example", "agent", &keys));
    // A sign-in with steps alone has no request of its own to send with no browser.
    store::write_json(&path("steps.example"), &unbrowse_files::SETUPS, &vec![sign_in()]).unwrap();
    assert!(!sign_in_now("steps.example", "steps.example", "agent", &keys));
}

/// A call that went through a sign-in and didn't bring the session back leaves the rest running and says so in the
/// owner's activity; one that did lifts it.
#[test]
fn a_call_that_the_sign_in_did_not_save_is_told_to_the_owner_and_leaves_the_rest() {
    store::scratch_home("setups-cov-judged");
    rest("judged.example", Kind::SignIn);
    judged_by_the_call("judged.example", "agent", false);
    assert!(resting("judged.example", Kind::SignIn));
    let told = store::read_activity(20).into_iter().find(|a| a.site == "judged.example" && a.kind == "setup").expect("the owner is told");
    assert_eq!((told.result.as_str(), told.who.as_str()), ("failed", "agent"));
    assert!(told.note.as_deref().is_some_and(|n| n.contains("isn't tried again for an hour")));
    judged_by_the_call("judged.example", "agent", true);
    assert!(!resting("judged.example", Kind::SignIn));
}

