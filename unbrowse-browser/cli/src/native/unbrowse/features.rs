//! The Suspense report that ships in the binary but that the node never calls.
//!
//! `format_suspense_report` turns the boundaries a React page reports into the markdown an agent reads to decide
//! what to fix first. These tests feed it boundaries as the page sends them (JSON) and hold the text it prints:
//! which boundaries are holes, how blockers are classified and ranked, and what it tells the agent to do.

use crate::native::react::{format_suspense_report, Boundary};
use serde_json::{json, Value};

fn boundaries(items: Vec<Value>) -> Vec<Boundary> {
    items
        .into_iter()
        .map(|v| serde_json::from_value(v).unwrap_or_else(|e| panic!("boundary: {e}")))
        .collect()
}

fn report(items: Vec<Value>, only_dynamic: bool) -> String {
    format_suspense_report(&boundaries(items), only_dynamic)
}

fn boundary(id: i64, name: Option<&str>, suspended: bool) -> Value {
    json!({
        "id": id, "parentID": 1, "name": name, "isSuspended": suspended,
        "environments": [], "suspendedBy": [], "unknownSuspenders": null,
        "owners": [], "jsxSource": null,
    })
}

fn suspender(name: &str) -> Value {
    json!({"name": name, "description": "", "duration": 5})
}

fn with(mut base: Value, key: &str, value: Value) -> Value {
    base[key] = value;
    base
}

fn root() -> Value {
    with(boundary(1, Some("root"), true), "parentID", json!(0))
}

/// One boundary suspended by `blocker`, run through the report; returns its Quick Reference row.
fn row_for(blocker: Value, extra: Vec<(&str, Value)>) -> String {
    let mut b = with(
        boundary(2, Some("Probe"), true),
        "suspendedBy",
        json!([blocker]),
    );
    for (k, v) in extra {
        b = with(b, k, v);
    }
    let text = report(vec![root(), b], false);
    text.lines()
        .find(|l| l.starts_with("| Probe |"))
        .unwrap_or_else(|| panic!("no row: {text}"))
        .to_string()
}

fn mixed() -> Vec<Value> {
    let route = with(
        with(
            with(
                boundary(2, Some("dashboard/"), true),
                "suspendedBy",
                json!([{
                    "name": "useSearchParams", "description": "", "duration": 10,
                    "ownerStack": [["Page", "/app/page.tsx", 12, 3]],
                }]),
            ),
            "owners",
            json!([{"name": "Layout", "env": null, "source": ["/app/layout.tsx", 1, 1]}]),
        ),
        "environments",
        json!(["Client"]),
    );
    let feed = with(
        boundary(3, Some("Feed"), true),
        "suspendedBy",
        json!([{
            "name": "fetch", "description": "GET /api", "duration": 40, "ownerName": "FeedList",
            "ownerStack": [
                ["x", "/node_modules/next/dist/a.js", 1, 1],
                ["FeedList", "/app/feed.tsx", 30, 5],
            ],
        }]),
    );
    let cart = with(
        boundary(4, Some("Cart"), true),
        "suspendedBy",
        json!([{
            "name": "fetch", "description": "", "duration": 9,
            "awaiterStack": [["Cart", "/app/feed.tsx", 30, 5]],
        }]),
    );
    let weird = with(
        with(
            boundary(5, Some("Weird|Name"), false),
            "unknownSuspenders",
            json!("hydration"),
        ),
        "jsxSource",
        json!(["/app/weird.tsx", 7, 2]),
    );
    let footer = with(
        boundary(6, Some("Footer"), false),
        "jsxSource",
        json!(["/app/footer.tsx", 3, 1]),
    );
    let anon = boundary(7, None, false);
    vec![root(), route, feed, cart, weird, footer, anon]
}

#[test]
fn report_with_no_boundaries_is_only_its_two_header_lines() {
    assert_eq!(
        report(vec![], false),
        "# Suspense Boundary Analysis\n# 0 boundaries: 0 dynamic holes, 0 static\n"
    );
    // The page's root (parentID 0) is never counted, even when it is suspended.
    assert_eq!(report(vec![root()], false), report(vec![], false));
}

#[test]
fn only_dynamic_header_counts_holes_and_hides_the_static_section() {
    let text = report(mixed(), true);
    assert!(
        text.starts_with(
            "# Suspense Boundary Analysis\n# 4 dynamic holes (static boundaries hidden; pass without --only-dynamic to see them)\n"
        ),
        "{text}"
    );
    assert!(!text.contains("## Static"), "{text}");
    assert!(!text.contains("Footer"), "{text}");
}

#[test]
fn full_report_counts_holes_and_static_boundaries_in_its_header() {
    let text = report(mixed(), false);
    assert!(
        text.starts_with(
            "# Suspense Boundary Analysis\n# 6 boundaries: 4 dynamic holes, 2 static\n"
        ),
        "{text}"
    );
}

#[test]
fn summary_names_the_top_hole_its_next_step_and_the_most_common_cause() {
    let text = report(mixed(), false);
    assert!(
        text.contains(
            "## Summary\n- Top actionable hole: dashboard/ - useSearchParams (client-hook)\n"
        ),
        "{text}"
    );
    assert!(
        text.contains(
            "- Suggested next step: This route segment is suspending on client hooks. Check loading.tsx first; if it is null or visually empty, fix the fallback before chasing deeper push-down work.\n"
        ),
        "{text}"
    );
    // Two boundaries share the /app/feed.tsx:30 fetch, which outweighs the single hook.
    assert!(
        text.contains("- Most common root cause: fetch (server-fetch) affecting 2 boundaries\n"),
        "{text}"
    );
}

#[test]
fn quick_reference_ranks_holes_by_actionability_and_escapes_pipes() {
    let text = report(mixed(), false);
    let rows: Vec<&str> = text
        .lines()
        .filter(|l| l.starts_with("| ") && !l.starts_with("| ---"))
        .collect();
    assert_eq!(
        rows[0],
        "| Boundary | Type | Primary blocker | Source | Suggested next step |"
    );
    assert!(
        rows[1].starts_with("| dashboard/ | route-segment | useSearchParams (client-hook) | /app/page.tsx:12 | This route segment"),
        "{}",
        rows[1]
    );
    assert!(
        rows[2].starts_with("| Feed | component | fetch (server-fetch) | /app/feed.tsx:30 | Push the request-bound async work"),
        "{}",
        rows[2]
    );
    assert!(
        rows[3].starts_with("| Cart | component | fetch (server-fetch) | /app/feed.tsx:30 |"),
        "{}",
        rows[3]
    );
    // Unknown suspender: no blocker, so the source falls back to the JSX position and the reason is quoted.
    assert_eq!(
        rows[4],
        "| Weird\\|Name | component | unknown | /app/weird.tsx:7 | React could not identify the suspender (hydration). Investigate the nearest user-owned owner or awaiter frame. |"
    );
    assert_eq!(rows.len(), 5);
}

#[test]
fn root_causes_group_boundaries_sharing_a_blocker_with_plural_counts() {
    let text = report(mixed(), false);
    assert!(
        text.contains(
            "## Root Causes\n- fetch (server-fetch) at /app/feed.tsx:30 - affects 2 boundaries\n  next step: Split static shell content from data widgets, then push the fetch into smaller Suspense leaves or cache it.\n  boundaries: Feed, Cart\n- useSearchParams (client-hook) at /app/page.tsx:12 - affects 1 boundary\n"
        ),
        "{text}"
    );
}

#[test]
fn files_to_read_are_ranked_by_how_often_the_holes_point_at_them() {
    let text = report(mixed(), false);
    assert!(
        text.contains("## Files to Read\n- /app/feed.tsx\n- /app/page.tsx\n- /app/layout.tsx\n- /app/weird.tsx\n\n"),
        "{text}"
    );
}

#[test]
fn files_to_read_stop_at_twelve_and_skip_empty_paths() {
    let mut items = vec![root()];
    for i in 0..14 {
        items.push(with(
            boundary(10 + i, Some(&format!("B{i:02}")), true),
            "jsxSource",
            json!([format!("/f{i:02}.tsx"), 1, 1]),
        ));
    }
    items.push(with(
        boundary(40, Some("Empty"), true),
        "jsxSource",
        json!(["", 1, 1]),
    ));
    let text = report(items, true);
    assert!(text.contains("- /f00.tsx\n"), "{text}");
    assert!(text.contains("- /f11.tsx\n"), "{text}");
    assert!(!text.contains("- /f12.tsx"), "{text}");
    assert!(!text.contains("- \n") && !text.ends_with("- "), "{text}");
}

#[test]
fn static_section_lists_boundaries_with_and_without_a_name_or_source() {
    let text = report(mixed(), false);
    assert!(
        text.ends_with("## Static (not suspended)\n  Footer at /app/footer.tsx:3:1\n  (unnamed)"),
        "{text}"
    );
}

#[test]
fn a_report_without_holes_has_no_summary_or_table() {
    let text = report(
        vec![
            root(),
            with(
                boundary(2, Some("Calm"), false),
                "jsxSource",
                json!(["/a.tsx", 4, 2]),
            ),
        ],
        false,
    );
    assert_eq!(
        text,
        "# Suspense Boundary Analysis\n# 1 boundaries: 0 dynamic holes, 1 static\n\n## Static (not suspended)\n  Calm at /a.tsx:4:2"
    );
}

#[test]
fn a_single_unnamed_hole_reads_as_boundary_id_and_a_singular_count() {
    let b = with(
        boundary(9, None, true),
        "suspendedBy",
        json!([suspender("cookies")]),
    );
    let text = report(vec![root(), b], false);
    assert!(
        text.contains("- Top actionable hole: (unnamed) - cookies (request-api)\n"),
        "{text}"
    );
    assert!(
        text.contains("- Most common root cause: cookies (request-api) affecting 1 boundary\n"),
        "{text}"
    );
    assert!(
        text.contains("- cookies (request-api) at unknown - affects 1 boundary\n"),
        "{text}"
    );
    assert!(text.contains("  boundaries: boundary-9\n"), "{text}");
    assert!(
        text.contains("| (unnamed) | component | cookies (request-api) | unknown |"),
        "{text}"
    );
}

#[test]
fn blocker_names_classify_into_the_kinds_the_agent_is_told_about() {
    let framework = json!({"name": "thing", "description": "", "duration": 1,
        "ownerStack": [["a", "/node_modules/react/x.js", 1, 1]]});
    let cases = [
        (suspender("usePathname"), "usePathname (client-hook)"),
        (suspender("useRouter"), "useRouter (client-hook)"),
        (suspender("useAnything"), "useAnything (client-hook)"),
        (suspender("Cookies"), "Cookies (request-api)"),
        (suspender("searchParams"), "searchParams (request-api)"),
        (suspender("draftMode"), "draftMode (request-api)"),
        (suspender("RSC stream"), "RSC stream (stream)"),
        (suspender("fetch"), "fetch (server-fetch)"),
        (
            suspender("getFetchedThing"),
            "getFetchedThing (server-fetch)",
        ),
        (suspender("unstable_cache"), "unstable_cache (cache)"),
        (
            json!({"name": "loader", "description": "reads the Cache", "duration": 1}),
            "loader (cache)",
        ),
        (framework, "thing (framework)"),
        (suspender("mystery"), "mystery (unknown)"),
    ];
    for (blocker, expected) in cases {
        let row = row_for(blocker, vec![]);
        assert!(
            row.contains(&format!("| {expected} |")),
            "{expected}: {row}"
        );
    }
}

#[test]
fn each_kind_of_blocker_gets_its_own_recommendation() {
    let cases = [
        ("useX", "Push the hook-using client UI behind a smaller local Suspense boundary so the parent shell can prerender."),
        ("cookies", "Push the request-bound async work into a smaller leaf or split static siblings out of this boundary."),
        ("fetch", "Push the request-bound async work into a smaller leaf or split static siblings out of this boundary."),
        ("unstable_cache", "Check whether caching or runtime prefetch can move this personalized content into the shell."),
        ("rsc stream", "Keep the stream behind Suspense, but extract any static shell content outside the boundary."),
        ("mystery", "No primary blocker was identified. Inspect the boundary source and owner chain directly."),
    ];
    for (name, advice) in cases {
        let row = row_for(suspender(name), vec![]);
        assert!(row.ends_with(&format!("| {advice} |")), "{name}: {row}");
    }
    let framework = json!({"name": "thing", "description": "", "duration": 1,
        "awaiterStack": [["a", "/node_modules/react/x.js", 1, 1]]});
    let row = row_for(framework, vec![]);
    assert!(
        row.ends_with("| The top blocker still looks framework-heavy. Find the nearest user-owned caller before changing boundary placement. |"),
        "{row}"
    );
}

#[test]
fn an_unidentified_suspender_reason_is_quoted_when_the_blocker_has_no_advice_of_its_own() {
    let row = row_for(
        suspender("mystery"),
        vec![("unknownSuspenders", json!("a promise from userland"))],
    );
    assert!(
        row.ends_with("| React could not identify the suspender (a promise from userland). Investigate the nearest user-owned owner or awaiter frame. |"),
        "{row}"
    );
}

#[test]
fn a_hole_with_no_blocker_and_no_reason_says_so() {
    let text = report(vec![root(), boundary(2, Some("Bare"), true)], false);
    assert!(text.contains("| Bare | component | unknown | unknown | No primary blocker was identified. Inspect the boundary source and owner chain directly. |"), "{text}");
    // No blocker: no top-hole line, and no root cause either.
    assert!(!text.contains("Top actionable hole"), "{text}");
    assert!(!text.contains("## Root Causes"), "{text}");
}

#[test]
fn boundary_type_comes_from_its_name_and_owners() {
    let loading = json!([{"name": "LoadingBoundary", "env": null, "source": null}]);
    let router = json!([{"name": "OuterLayoutRouter", "env": null, "source": null}]);
    let suspense_owner = json!([{"name": "MySuspenseWrapper", "env": null, "source": null}]);
    let cases = [
        (Some("blog/"), json!([]), "route-segment"),
        (Some("Anything"), loading, "route-segment"),
        (Some("Anything"), router, "route-segment"),
        (Some("Suspense"), json!([]), "explicit-suspense"),
        (Some("Anything"), suspense_owner, "explicit-suspense"),
        (Some("Anything"), json!([]), "component"),
        (None, json!([]), "component"),
    ];
    for (name, owners, kind) in cases {
        let text = report(
            vec![root(), with(boundary(2, name, true), "owners", owners)],
            false,
        );
        let expected = format!("| {} | {kind} |", name.unwrap_or("(unnamed)"));
        assert!(text.contains(&expected), "{expected}: {text}");
    }
}

fn order(items: Vec<Value>) -> Vec<String> {
    let mut all = vec![root()];
    all.extend(items);
    report(all, true)
        .lines()
        .filter(|l| l.starts_with("| ") && !l.starts_with("| ---") && !l.starts_with("| Boundary"))
        .map(|l| {
            l.split(" | ")
                .next()
                .unwrap()
                .trim_start_matches("| ")
                .to_string()
        })
        .collect()
}

#[test]
fn a_route_segment_outranks_a_weakly_blocked_component() {
    let weak = with(
        boundary(2, Some("Zed"), true),
        "suspendedBy",
        json!([suspender("mystery")]),
    );
    let route = boundary(3, Some("Route/"), true);
    assert_eq!(order(vec![weak, route]), vec!["Route/", "Zed"]);
}

#[test]
fn equally_actionable_holes_tie_break_on_type_then_blocker_count_then_name() {
    let hook = |id, name: &str| {
        with(
            boundary(id, Some(name), true),
            "suspendedBy",
            json!([suspender("useQ")]),
        )
    };
    // Same blocker: alphabetical.
    assert_eq!(
        order(vec![hook(2, "Beta"), hook(3, "Alpha")]),
        vec!["Alpha", "Beta"]
    );
    // A route segment (type weight 3) before a component with the same actionability.
    let seg = with(hook(4, "Zeta/"), "environments", json!([]));
    assert_eq!(order(vec![hook(2, "Alpha"), seg]), vec!["Zeta/", "Alpha"]);
    // More blockers first when type and actionability tie.
    let two = with(
        hook(5, "Many"),
        "suspendedBy",
        json!([suspender("useQ"), suspender("useR")]),
    );
    assert_eq!(order(vec![hook(2, "Alpha"), two]), vec!["Many", "Alpha"]);
}

#[test]
fn a_boundarys_primary_blocker_is_its_most_actionable_suspender() {
    // Owner or awaiter name adds weight: cookies (88 + 4) beats useRouter (90).
    let named = json!({"name": "cookies", "description": "", "duration": 1, "ownerName": "Auth"});
    let row = row_for(
        suspender("useRouter"),
        vec![("suspendedBy", json!([suspender("useRouter"), named]))],
    );
    assert!(row.contains("| cookies (request-api) |"), "{row}");
    // A frame in user code adds weight: headers with one (88 + 8) beats useRouter inside node_modules (90).
    let mine = json!({"name": "headers", "description": "", "duration": 1, "ownerStack": [["Me", "/app/me.tsx", 2, 2]]});
    let theirs = json!({"name": "useRouter", "description": "", "duration": 1,
        "ownerStack": [["R", "/node_modules/next/r.js", 2, 2]]});
    let row = row_for(suspender("x"), vec![("suspendedBy", json!([theirs, mine]))]);
    assert!(
        row.contains("| headers (request-api) | /app/me.tsx:2 |"),
        "{row}"
    );
}

#[test]
fn the_source_column_prefers_the_user_code_frame_then_the_awaiter_then_the_jsx_position() {
    // The first frame outside node_modules wins over earlier library frames.
    let stack = json!({"name": "fetch", "description": "", "duration": 1, "ownerStack": [
        ["a", "/node_modules/x/a.js", 1, 1], ["b", "/src/b.tsx", 8, 4], ["c", "/src/c.tsx", 9, 1]]});
    assert!(row_for(stack, vec![]).contains("| /src/b.tsx:8 |"));
    // All frames in node_modules: the first one.
    let lib = json!({"name": "fetch", "description": "", "duration": 1, "ownerStack": [
        ["a", "/node_modules/x/a.js", 3, 1], ["b", "/node_modules/y/b.js", 4, 1]]});
    assert!(row_for(lib, vec![]).contains("| /node_modules/x/a.js:3 |"));
    // No owner frames: the awaiter's.
    let awaiter = json!({"name": "fetch", "description": "", "duration": 1, "ownerStack": [],
        "awaiterStack": [["w", "/src/w.tsx", 5, 1]]});
    assert!(row_for(awaiter, vec![]).contains("| /src/w.tsx:5 |"));
    // No frames at all: where the boundary sits in JSX.
    let none = suspender("fetch");
    assert!(
        row_for(none, vec![("jsxSource", json!(["/src/page.tsx", 21, 6]))])
            .contains("| /src/page.tsx:21 |")
    );
}
