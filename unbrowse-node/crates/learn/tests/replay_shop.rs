//! End to end: the clean re-run. A route learned from the agent's browsing is run again over
//! plain HTTP in a fresh session with new inputs. The test shop checks every value it receives,
//! so a replay only succeeds when the graph's sources are right.

mod common;

use std::collections::HashMap;

use common::flow::{browse, checkout_request, Run};
use common::shop;
use unbrowse_learn::provenance::At;
use unbrowse_learn::replay::{replay, HttpFetch};
use unbrowse_learn::{build, Class, Loc, ReplayError};

fn inputs(user: &str, query: &str, note: &str) -> HashMap<String, String> {
    HashMap::from([
        ("user".into(), user.into()),
        // A secret: in the node this comes from the user's vault, never from the graph.
        ("pass".into(), format!("pw-{user}")),
        ("q".into(), query.into()),
        ("note".into(), note.into()),
    ])
}

#[test]
fn http_replay_adds_to_cart_for_a_new_user_and_query() {
    let base = shop::start();
    let a = browse(&base, "replay-cart", &Run { user: "alice", query: "red shoes", note: "-" });
    let target = a.trace.exchanges[a.triggered_by("click", ".add")[0]].url.to_string();
    let g = build(&[a.trace], |e| e.url.as_str() == target).unwrap();
    assert!(!g.provisional, "every value in add-to-cart is sourced, so one sighting is enough");

    // A different user, a different search: every token, cookie and ID must come from the new
    // responses, or the shop refuses the request.
    let run = replay(&g, &inputs("erin", "purple socks", "-"), &mut HttpFetch::new().unwrap()).unwrap();
    let paths: Vec<String> = run.steps.iter().map(|(u, _)| u.split_once("//").unwrap().1.split_once('/').unwrap().1.to_string()).collect();
    assert_eq!(paths, ["", "api/guest", "api/login", "api/search?q=purple+socks", "api/cart"]);
    let body: serde_json::Value = serde_json::from_str(run.target.response_body.as_deref().unwrap()).unwrap();
    assert!(body["cartId"].as_str().unwrap().starts_with("c_"));
}

#[test]
fn http_replay_fails_when_a_source_is_wrong() {
    let base = shop::start();
    let a = browse(&base, "replay-wrong", &Run { user: "alice", query: "red shoes", note: "-" });
    let target = a.trace.exchanges[a.triggered_by("click", ".add")[0]].url.to_string();
    let mut g = build(&[a.trace], |e| e.url.as_str() == target).unwrap();

    // Point the cart's CSRF token at the wrong text on the first page.
    let cart = g.steps.last_mut().unwrap();
    let csrf = cart.fields.iter_mut().find(|f| f.loc == Loc::Header("x-csrf".into())).unwrap();
    let Class::Derived { origin } = &mut csrf.class else { panic!() };
    origin.at = At::Text { before: "<title>".into(), after: "<".into(), nth: 0 };

    match replay(&g, &inputs("erin", "purple socks", "-"), &mut HttpFetch::new().unwrap()) {
        Err(ReplayError::Failed { status: 403, body, .. }) => assert!(body.contains("bad csrf"), "{body}"),
        other => panic!("expected the shop to refuse, got {other:?}"),
    }
}

#[test]
fn http_replay_never_passes_off_a_value_the_page_computes() {
    let base = shop::start();
    let a = browse(&base, "replay-refuse", &Run { user: "alice", query: "red shoes", note: "door" });
    let target = checkout_request(&a);
    let g = build(&[a.trace], |e| e.url.as_str() == target).unwrap();
    // From one sighting the signature is unconfirmed: the graph says so, and a replay sends it as seen, so the
    // checkout fails at that step rather than passing.
    assert!(g.provisional);
    let checkout = g.steps.last().unwrap();
    assert!(checkout.fields.iter().any(|f| f.loc == Loc::Header("x-sig".into()) && matches!(f.class, Class::Unconfirmed { .. })));
    match replay(&g, &inputs("erin", "purple socks", "door"), &mut HttpFetch::new().unwrap()) {
        Err(ReplayError::Failed { step: 6, status: 403, body, .. }) => assert!(body.contains("bad signature"), "{body}"),
        other => panic!("expected the checkout to fail on its signature, got {other:?}"),
    }
}

#[test]
fn the_graph_never_holds_a_typed_secret() {
    let base = shop::start();
    let a = browse(&base, "replay-secret", &Run { user: "alice", query: "red shoes", note: "leave at door" });
    let target = checkout_request(&a);
    let g = build(&[a.trace], |e| e.url.as_str() == target).unwrap();
    let graph = serde_json::to_string(&g).unwrap();
    assert!(!graph.contains("pw-alice"), "the graph holds the typed password");
}
