//! The gate around the metapattern the Eden report is made of: the engine learns a site from the walk, so it must
//! hold no site's own shape. A route is data (a page, scripts, a jar, a graph of steps); the engine reads that data,
//! and nothing else names a site.
//!
//! Two checks run here, both cheap and both about *classes* rather than sites:
//!
//! 1. the engine's code names no public site — no string literal that is a public domain, outside the test modules
//!    (whose fixtures are `*.example`);
//! 2. the engine does not branch on a host — no comparison of a host to a literal, in the engine or in the app's
//!    learn module.
//!
//! Plus the ledger: every class of failure the report names has a gate, and this test fails if one is removed. The
//! mapping is in `docs/GENERALITY.md`; that file and this test are the promise.

use std::path::{Path, PathBuf};

/// Every `.rs` under `dir`.
fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `text` with every comment blanked out, and — when `keep_strings` is false — every string body blanked too. The
/// result has the same length and the same line breaks, so byte offsets and brace counts still line up: a brace inside
/// a string or a comment cannot move the end of a module or the start of a literal.
fn scan(text: &str, keep_strings: bool) -> String {
    let b = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0usize;
    let (mut line, mut block, mut string, mut escape) = (false, false, false, false);
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied().unwrap_or(0);
        let blank = |c: u8| if c == b'\n' { c } else { b' ' };
        if line {
            if c == b'\n' {
                line = false;
                out.push(c);
            } else {
                out.push(b' ');
            }
        } else if block {
            if c == b'*' && next == b'/' {
                block = false;
                out.push(b' ');
                out.push(b' ');
                i += 1;
            } else {
                out.push(blank(c));
            }
        } else if string {
            out.push(if keep_strings { c } else { blank(c) });
            if escape {
                escape = false;
            } else if c == b'\\' {
                escape = true;
            } else if c == b'"' {
                string = false;
            }
        } else if c == b'/' && next == b'/' {
            line = true;
            out.push(b' ');
            out.push(b' ');
            i += 1;
        } else if c == b'/' && next == b'*' {
            block = true;
            out.push(b' ');
            out.push(b' ');
            i += 1;
        } else if c == b'\'' && char_literal(&b[i..]).is_some() {
            // A character literal can hold a quote (`'"'`, `'\''`): it is copied whole, so it cannot open a string.
            let len = char_literal(&b[i..]).expect("a char literal");
            out.extend_from_slice(&b[i..i + len]);
            i += len - 1;
        } else {
            if c == b'"' {
                string = true;
            }
            out.push(c);
        }
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

/// How long the character literal at the front of `rest` is, when it is one: `'x'`, `'"'`, `'\''`, `'\n'`. A lifetime
/// (`'a` with no close) is not, and is left alone.
fn char_literal(rest: &[u8]) -> Option<usize> {
    if rest.first() != Some(&b'\'') {
        return None;
    }
    if rest.get(1) == Some(&b'\\') {
        return rest.iter().skip(2).take(6).position(|c| *c == b'\'').map(|p| p + 3);
    }
    (rest.get(2) == Some(&b'\'')).then_some(3)
}

/// The byte ranges of every `#[cfg(test)]` module, found on a scan with strings blanked so a brace in a fixture cannot
/// move the module's end.
fn test_regions(text: &str) -> Vec<(usize, usize)> {
    let masked = scan(text, false);
    let mut regions = Vec::new();
    let mut from = 0;
    while let Some(at) = masked[from..].find("#[cfg(test)]") {
        let start = from + at;
        // The attribute may sit on a test function, not a module: skip whitespace and any further attributes, and only
        // a `mod` there makes this a test region.
        let mut j = start + "#[cfg(test)]".len();
        loop {
            while j < masked.len() && masked.as_bytes()[j].is_ascii_whitespace() {
                j += 1;
            }
            if masked[j..].starts_with("#[") {
                match masked[j..].find(']') {
                    Some(close) => {
                        j += close + 1;
                        continue;
                    }
                    None => break,
                }
            }
            break;
        }
        // Visibility may sit between the attribute and `mod` (`pub(crate) mod tests`).
        if masked[j..].starts_with("pub") {
            j += 3;
            while j < masked.len() && masked.as_bytes()[j].is_ascii_whitespace() {
                j += 1;
            }
            if masked[j..].starts_with("(") {
                if let Some(close) = masked[j..].find(')') {
                    j += close + 1;
                    while j < masked.len() && masked.as_bytes()[j].is_ascii_whitespace() {
                        j += 1;
                    }
                }
            }
        }
        if !masked[j..].starts_with("mod ") {
            from = start + 1;
            continue;
        }
        let Some(brace) = masked[j..].find('{') else { break };
        let mut depth = 0usize;
        let mut k = j + brace;
        while k < masked.len() {
            match masked.as_bytes()[k] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        k += 1;
                        break;
                    }
                }
                _ => {}
            }
            k += 1;
        }
        regions.push((start, k));
        from = k;
    }
    regions
}

/// The file's shipped code: test modules blanked (a fixture may name a host) and comments removed (prose may name a
/// site). String literals are kept — they are what the rule is about.
fn code_only(text: &str) -> String {
    let mut shipped = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end) in test_regions(text) {
        if start > at {
            shipped.push_str(&text[at..start]);
        }
        shipped.push('\n');
        at = end;
    }
    shipped.push_str(&text[at..]);
    scan(&shipped, true)
}

/// Whether a string literal is a public site's name: two or more labels, the last one a real public suffix. File names
/// (`config.json`), languages (`en.sg` never), addresses and the reserved suffixes (`example`, `test`, `invalid`,
/// `local`) are not.
fn names_a_site(literal: &str) -> bool {
    /// The node's own services, which a default endpoint names: infrastructure, not a target site whose shape is known.
    const OWN_SERVICES: &[&str] = &["gateway.codegraff.com"];
    const SUFFIXES: &[&str] = &[
        "com", "net", "org", "io", "sg", "de", "uk", "jp", "cn", "fr", "au", "ca", "in", "ru", "br", "nl", "es", "it",
        "se", "no", "fi", "dk", "pl", "ch", "at", "be", "ie", "nz", "za", "mx", "kr", "tw", "hk", "my", "th", "vn",
        "id", "ph", "tr", "ae", "sa", "il", "us", "me", "tv", "cc", "app", "dev", "ai", "ly",
    ];
    // A site is named bare (`carousell.sg`) or as an address (`https://www.carousell.sg/search`, a host and port):
    // the host is what the rule is about, whichever way it is written.
    let host = literal.split("://").nth(1).unwrap_or(literal);
    let host = host.split(['/', '?', '#', ':']).next().unwrap_or(host);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    let good = |l: &str| !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !l.starts_with('-') && !l.ends_with('-');
    if !labels.iter().all(|l| good(l)) {
        return false;
    }
    if OWN_SERVICES.iter().any(|s| host.eq_ignore_ascii_case(s) || host.to_ascii_lowercase().ends_with(&format!(".{s}"))) {
        return false;
    }
    let last = labels[labels.len() - 1].to_ascii_lowercase();
    if matches!(last.as_str(), "example" | "test" | "invalid" | "local" | "localhost" | "internal" | "arpa" | "lan") {
        return false;
    }
    // `example.com`, `example.net`, `example.org` are reserved for documentation: they name no one.
    if labels.len() == 2 && labels[0].eq_ignore_ascii_case("example") {
        return false;
    }
    SUFFIXES.contains(&last.as_str())
}

/// The string literals in `code` (a plain scan: escaped quotes and raw strings are rare in code that names a host, and
/// a miss here is a miss in a fixture, which the test modules already hide).
fn literals(code: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = code.char_indices().peekable();
    while let Some((_, c)) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut s = String::new();
        while let Some(&(_, c)) = chars.peek() {
            chars.next();
            match c {
                '"' => break,
                '\\' => {
                    if let Some((_, e)) = chars.next() {
                        s.push(e);
                    }
                }
                _ => s.push(c),
            }
        }
        out.push(s);
    }
    out
}

#[test]
fn the_engine_names_no_site() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    sources(&root, &mut files);
    assert!(!files.is_empty(), "no engine sources under {}", root.display());
    let mut named: Vec<String> = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        for literal in literals(&code_only(&text)) {
            if names_a_site(&literal) {
                named.push(format!("{}: {literal}", file.strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR"))).unwrap_or(file).display()));
            }
        }
    }
    assert!(
        named.is_empty(),
        "the engine names a site. A route is learned data (a page, its scripts, a jar, a graph of steps); the engine \
         reads it and knows no site. Move the site's shape into the walk, or into a fixture under #[cfg(test)].\n  {}",
        named.join("\n  ")
    );
}

#[test]
fn the_engine_does_not_branch_on_a_host() {
    // The app's learn module builds routes; it may branch on what the walk *says*, never on which site it is.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    sources(&dir.join("src"), &mut files);
    files.push(dir.join("../app/src/learn.rs"));
    let mut branches: Vec<String> = Vec::new();
    for file in files.iter().filter(|p| p.exists()) {
        let code = code_only(&std::fs::read_to_string(file).unwrap_or_default());
        for (n, line) in code.lines().enumerate() {
            let t = line.replace(' ', "");
            let compared = ["host==\"", "host_str()==Some(\"", "hostname==\"", "site==\"", "domain==\""]
                .iter()
                .any(|p| t.contains(p));
            // `match host { "a.com" => ... }` arms. `match` on a site is the same mistake as an `if`.
            let match_arm = t.starts_with("\"") && t.contains("=>") && (t.contains(".com") || t.contains(".net") || t.contains(".org") || t.contains(".io"));
            if compared || match_arm {
                branches.push(format!("{}:{}: {}", file.display(), n + 1, line.trim()));
            }
        }
    }
    assert!(
        branches.is_empty(),
        "a branch on which site this is. The walk carries the site's shape; the code reads the walk. If a rule needs a \
         host, take it from the route's own page or jar, never from a literal.\n  {}",
        branches.join("\n  ")
    );
}

/// The ledger: each class of failure the report names is held by a test, and the document says which. Removing a gate
/// fails here, so the class cannot quietly come back.
#[test]
fn every_class_the_report_names_has_its_gate() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ledger = dir.join("../../../docs/GENERALITY.md");
    assert!(ledger.exists(), "docs/GENERALITY.md is the ledger of gates: {}", ledger.display());

    let gates: &[(&str, &str)] = &[
        // A page with several JSON documents is read whole, and a template's null stands: a route survives the page it
        // was learned on.
        ("crates/learn/src/provenance.rs", "a_value_in_any_of_the_pages_json_documents_is_read"),
        ("crates/learn/src/replay.rs", "a_value_the_template_holds_as_null_is_not_needed"),
        ("crates/learn/src/replay.rs", "a_value_the_template_needs_is_not_papered_over"),
        // A data call the page makes is a candidate however it is sent (events of JSON included), and a call the page
        // does not make is skipped only when nothing later needs it.
        ("app/src/learn.rs", "a_search_streaming_its_results_is_a_candidate"),
        ("crates/learn/src/replay.rs", "an_unsignable_leaf_the_route_does_not_need_is_skipped"),
        // Every value the caller can change is an input, however short, and every placeholder is one.
        ("app/src/learn.rs", "a_one_character_value_the_page_was_asked_is_an_input"),
        ("app/src/learn.rs", "every_placeholder_a_route_sends_is_an_input"),
        // Nothing to choose from is no question, and a door is met with whatever satisfies it.
        ("crates/learn/src/judge.rs", "an_empty_question_is_never_sent"),
        // Signing is the page's own code run again, never a signature computed here.
        ("crates/learn/src/sandbox.rs", "a_bundles_own_signed_call_is_read_back"),
        // A header the page set is the header, and a door that refuses a headless browser is met with a window, or with
        // whatever else the site accepts.
        ("crates/learn/src/replay.rs", "a_script_signed_step_is_signed_once_the_request_stands"),
        // The session is recomputed, not re-walked: a stale value is re-minted from the page itself (cookies, header
        // and meta tokens), the page's own storages go in front of its scripts when they sign, and the cookies a call
        // sends go in the order a browser sends them.
        ("crates/learn/src/client.rs", "a_stale_session_is_refreshed_from_the_page_without_a_browser"),
        ("crates/learn/src/client.rs", "a_page_that_hands_back_nothing_new_leaves_the_jar_alone"),
        ("crates/learn/src/client.rs", "a_page_that_states_a_routes_token_hands_it_over"),
        ("crates/learn/src/client.rs", "cookies_go_out_in_the_order_a_browser_sends_them"),
        ("crates/learn/src/sandbox.rs", "the_pages_own_storage_and_cookies_are_in_front_of_it_when_it_signs"),
        ("crates/learn/src/sandbox.rs", "the_page_the_walk_saw_is_in_front_of_the_scripts_when_they_sign"),
        ("crates/learn/src/trace.rs", "a_routes_page_is_the_walks_own_document"),
        ("crates/learn/src/page.rs", "a_pages_meta_tag_is_read_by_its_name"),
        // A door a site puts up is told apart from drift: the wall's class and credential are read from what it
        // answered with, and a refusal it caused says so instead of sending every call to a browser.
        ("crates/learn/src/graph.rs", "a_wall_is_classed_from_what_it_answered"),
        // An answer the site streams: what it has said is the answer, and the call stops at the quiet mark.
        // One egress per site: the browser and the calls leave through the same address, so the client that earned a
        // credential and the calls that spend it are the same client.
        // A route that names its contributor goes out as the caller's to fill, and a shared route mints only on its
        // own site, only when the owner allows it.
        ("app/src/recipe.rs", "a_value_that_names_the_contributor_goes_out_as_the_callers"),
        ("app/src/recipe.rs", "a_route_shares_an_account_key_as_a_parameter"),
        ("crates/learn/src/client.rs", "a_shared_route_mints_only_on_its_own_site_and_only_when_allowed"),
        ("crates/learn/src/proxy.rs", "a_pinned_site_leaves_through_its_upstream"),
        ("crates/learn/src/proxy.rs", "a_pinned_calls_transport_leaves_through_the_same_upstream"),
        ("crates/learn/src/paging.rs", "a_token_an_earlier_answer_gave_is_not_paging"),
        ("crates/learn/src/http.rs", "an_event_streams_answer_is_what_it_said_so_far"),
        ("crates/learn/src/http.rs", "a_blocking_event_streams_answer_is_what_it_said_so_far"),
        ("crates/learn/src/replay.rs", "a_known_door_is_said_as_a_door"),
    ];
    let mut missing: Vec<String> = Vec::new();
    for (file, test) in gates {
        // The ledger names files from the repository's root; this crate sits at `unbrowse-node/crates/learn`.
        let path = match file.strip_prefix("crates/learn/") {
            Some(local) => dir.join(local),
            None => dir.join("../..").join(file),
        };
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        if !text.contains(&format!("fn {test}(")) {
            missing.push(format!("{file}: fn {test}"));
        }
    }
    assert!(missing.is_empty(), "a gate the ledger names is gone, so its class can come back unnoticed:\n  {}", missing.join("\n  "));
}
