//! End to end: an agent browses the test shop twice with the node's passive capture on; the
//! node learns the checkout route from the session logs, and every value in its dependency
//! graph must be classified and sourced correctly.
//!
//! Needs the Unbrowse fork of agent-browser (`UNBROWSE_BROWSER`, or the build in
//! `unbrowse-browser/cli`); fails when it isn't built, never skips.

mod common;

use common::flow::{browse, checkout_request, Run};
use common::shop;
use unbrowse_learn::provenance::At;
use unbrowse_learn::{build, Class, Graph, Loc, Step};

fn step<'a>(g: &'a Graph, method: &str, path_start: &str) -> &'a Step {

    g.steps
        .iter()
        .find(|s| s.method == method && s.url.split_once("//").unwrap().1.split_once('/').unwrap().1.starts_with(path_start))
        .unwrap_or_else(|| panic!("no step {method} /{path_start} in\n{}", g.describe()))
}

fn class(s: &Step, loc: Loc) -> &Class {
    &s.fields.iter().find(|f| f.loc == loc).unwrap_or_else(|| panic!("no {loc} in {}", s.url)).class
}

fn from_step(g: &Graph, c: &Class) -> (String, At, Option<(String, String)>) {
    let Class::Derived { origin } = c else { panic!("expected derived, got {c:?}") };
    let src = g.steps.iter().find(|s| s.exchange == origin.exchange).expect("source step is in the graph");
    (format!("{} {}", src.method, src.url), origin.at.clone(), origin.wrap.clone())
}

/// The browser these tests drive is found by its built name on every system: `agent-browser.exe` on Windows.
#[test]
fn the_built_browser_is_found_by_its_name_on_every_system() {
    let dir = std::path::Path::new("cli/target/debug");
    assert_eq!(common::agent::built_browser(dir, ".exe"), dir.join("agent-browser.exe"));
    assert_eq!(common::agent::built_browser(dir, ""), dir.join("agent-browser"));
    assert!(common::agent::built_browser(dir, std::env::consts::EXE_SUFFIX).to_string_lossy().ends_with(&format!("agent-browser{}", std::env::consts::EXE_SUFFIX)));
}

#[test]
fn learns_the_checkout_route_from_two_browsing_sessions() {
    let base = shop::start();
    let a = browse(&base, "learn-a", &Run { user: "alice", query: "red shoes", note: "leave at door" });
    let b = browse(&base, "learn-b", &Run { user: "bob", query: "blue hat", note: "ring the bell" });

    let target = checkout_request(&a);
    let g = build(&[a.trace, b.trace], |e| e.url.as_str() == target).unwrap();
    assert!(!g.provisional);
    println!("{}", g.describe());
    std::fs::write(std::env::temp_dir().join("shop-checkout.graph.json"), serde_json::to_string_pretty(&g).unwrap()).unwrap();

    // The graph holds exactly the requests checkout depends on, in order.
    let order: Vec<String> = g.steps.iter().map(|s| format!("{} {}", s.method, s.url.splitn(4, '/').nth(3).unwrap_or(""))).collect();
    assert_eq!(order, [
        "GET ",
        "POST api/guest",
        "POST api/login",
        "GET api/search?q={q}",
        "POST api/cart",
        "POST api/cart/{path[2]}/checkout",
    ]);

    let home = step(&g, "GET", "");
    let login = step(&g, "POST", "api/login");
    let guest = step(&g, "POST", "api/guest");
    let search = step(&g, "GET", "api/search");
    let cart = step(&g, "POST", "api/cart");
    let checkout = g.steps.last().unwrap();
    // The first page needs nothing of the session or the caller: what it carries is the browser's own shape.
    let browser_shape = |name: &str| {
        matches!(name, "accept" | "accept-language" | "priority" | "dnt" | "upgrade-insecure-requests" | "cache-control" | "pragma")
            || name.starts_with("sec-ch-")
            || name.starts_with("sec-fetch-")
    };
    assert!(
        home.fields.iter().all(|f| matches!(&f.loc, Loc::Header(name) if browser_shape(&name.to_ascii_lowercase()))
            && matches!(f.class, Class::Constant { .. })),
        "the first page carries only the browser's own shape: {:?}",
        home.fields
    );

    // Content type is a plain constant, not a link to an earlier response.
    for s in [login, search, cart, checkout] {
        let c = class(s, Loc::Header("content-type".into()));
        assert!(matches!(c, Class::Constant { value, .. } if value == "application/json"), "{c:?}");
    }

    // Each step depends only on the steps that really feed it.
    let sources = |s: &Step| -> std::collections::BTreeSet<usize> {
        s.fields.iter().filter_map(|f| match &f.class { Class::Derived { origin } => Some(origin.exchange), _ => None }).collect()
    };
    let idx = |s: &Step| s.exchange;
    assert_eq!(sources(guest), [idx(home)].into());
    assert_eq!(sources(login), [idx(home)].into());
    assert_eq!(sources(search), [idx(home), idx(guest), idx(login)].into());
    assert_eq!(sources(cart), [idx(home), idx(login), idx(search)].into());
    assert_eq!(sources(checkout), [idx(home), idx(login), idx(cart)].into());

    // Typed input; the password is a secret.
    // Inputs are named by the field the agent typed into; the password field was recognised
    // as secret from the page itself.
    assert_eq!(class(login, Loc::Json("/user".into())), &Class::Input { name: "user".into(), secret: false, default: Some("alice".into()), optional: false });
    // The browser writes a typed secret as its name, never as typed.
    assert_eq!(class(login, Loc::Json("/password".into())), &Class::Input { name: "pass".into(), secret: true, default: Some("secret:1".into()), optional: false });
    assert_eq!(class(search, Loc::Query("q".into())), &Class::Input { name: "q".into(), secret: false, default: Some("red shoes".into()), optional: false });
    assert_eq!(class(checkout, Loc::Json("/note".into())), &Class::Input { name: "note".into(), secret: false, default: Some("leave at door".into()), optional: false });

    // A constant from the page's JS, with where it was seen.
    let Class::Constant { value, origin: Some(o) } = class(guest, Loc::Header("x-api-key".into())) else {
        panic!("x-api-key should be a constant with an origin")
    };
    assert_eq!(value, shop::API_KEY);
    assert!(matches!(&o.at, At::Text { before, .. } if before.contains("API_KEY")));

    // Cookies from Set-Cookie: the visitor from the first page, the session from login.
    let (src, at, _) = from_step(&g, class(checkout, Loc::Cookie("visitor".into())));
    assert!(src.starts_with("GET ") && at == At::SetCookie { name: "visitor".into() });
    let (src, at, _) = from_step(&g, class(checkout, Loc::Cookie("sid".into())));
    assert!(src.ends_with("/api/login") && at == At::SetCookie { name: "sid".into() });

    // The CSRF token from the first page's HTML.
    let (_, at, _) = from_step(&g, class(checkout, Loc::Header("x-csrf".into())));
    assert!(matches!(at, At::Text { before, .. } if before.contains(r#"name="csrf" content=""#)));

    // State across steps: guest token wrapped as a bearer, product ID from search, cart ID from the cart.
    let (src, at, wrap) = from_step(&g, class(search, Loc::Header("authorization".into())));
    assert!(src.ends_with("/api/guest") && at == At::Json { pointer: "/guestToken".into() });
    assert_eq!(wrap, Some(("Bearer ".into(), String::new())));
    let (src, at, _) = from_step(&g, class(cart, Loc::Json("/productId".into())));
    assert!(src.contains("/api/search") && at == At::Json { pointer: "/results/0/id".into() });
    let (src, at, _) = from_step(&g, class(checkout, Loc::Path(2)));
    assert!(src.ends_with("/api/cart") && at == At::Json { pointer: "/cartId".into() });

    // The signature and timestamp are made by page code. Sent once per walk with no source, they look like a token
    // the session carries (a csrf header sent once looks the same), so they are the session's or the page's: never a
    // constant to send again, never a value to re-fetch.
    for h in ["x-sig", "x-ts"] {
        let c = class(checkout, Loc::Header(h.into()));
        assert!(matches!(c, Class::Computed | Class::Minted { .. }), "{h}: {c:?}");
    }
    assert!(g.steps[..g.steps.len() - 1].iter().all(|s| !s.needs_browser));
}

#[test]
fn each_action_maps_to_the_requests_it_set_off() {
    let base = shop::start();
    let s = browse(&base, "segments", &Run { user: "carol", query: "green scarf", note: "thanks" });
    let paths = |kind: &str, sel: &str| -> Vec<String> {
        s.triggered_by(kind, sel).into_iter().map(|i| {
            let e = &s.trace.exchanges[i];
            format!("{} {}", e.method, e.url.path())
        }).collect()
    };
    assert_eq!(paths("click", "#login"), ["POST /api/login"]);
    assert_eq!(paths("click", "#search"), ["GET /api/search"]);
    assert_eq!(paths("click", ".add"), ["POST /api/cart"]);
    assert_eq!(paths("click", "#checkout").len(), 1);
    assert!(paths("click", "#checkout")[0].ends_with("/checkout"));
    // Typing sets nothing off in this shop.
    assert!(paths("fill", "#q").is_empty());
}

#[test]
fn one_sighting_gives_a_provisional_graph() {
    let base = shop::start();
    let a = browse(&base, "single", &Run { user: "dave", query: "grey coat", note: "none" });
    let target = checkout_request(&a);
    let g = build(&[a.trace], |e| e.url.as_str() == target).unwrap();
    println!("{}", g.describe());
    assert!(g.provisional, "a value with no source can't be settled from one sighting");
    let checkout = g.steps.last().unwrap();
    let sig = class(checkout, Loc::Header("x-sig".into()));
    assert!(matches!(sig, Class::Unconfirmed { .. }), "x-sig unconfirmed: {sig:?}");
    let ts = class(checkout, Loc::Header("x-ts".into()));
    assert!(matches!(ts, Class::Unconfirmed { .. }), "x-ts unconfirmed: {ts:?}");
    // Sourced values don't need a second sighting.
    let guest = step(&g, "POST", "api/guest");
    assert!(matches!(class(guest, Loc::Header("x-api-key".into())), Class::Constant { .. }), "a key in static JS is constant");
    assert!(matches!(class(checkout, Loc::Header("x-csrf".into())), Class::Derived { .. }), "a token in the HTML is re-fetched");
    assert!(matches!(class(checkout, Loc::Path(2)), Class::Derived { .. }));
    assert!(matches!(class(checkout, Loc::Cookie("sid".into())), Class::Derived { .. }));
    assert_eq!(g.steps.len(), 6);
}
