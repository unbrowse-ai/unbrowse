use super::*;

const ALL: std::ops::RangeInclusive<u32> = 1..=14;

#[test]
fn every_pattern_is_numbered_once_and_in_order() {
    let ids: Vec<u32> = patterns().iter().map(|p| p.id).collect();
    assert_eq!(ids, ALL.collect::<Vec<_>>());
    assert_eq!(VERSION, "unbrowse-detector/1");
    assert_eq!(VERSION_NUMBER, 1);
}

/// Each pattern finds its own made-up credential in a recipe-shaped body, for many seeds, and `find` agrees with `scan`.
#[test]
fn each_pattern_finds_its_own_credential() {
    for k in ALL {
        for seed in 1..200u64 {
            let body = synth::body(k, seed);
            let hits = scan(body.as_bytes());
            assert!(hits.iter().any(|h| h.pattern == k), "pattern {k} seed {seed} missed");
            assert!(matches(body.as_bytes(), k), "find {k} disagrees with scan");
            assert_eq!(find(body.as_bytes(), k), find_one(body.as_bytes(), k), "the one-pattern find agrees");
        }
    }
}

/// The same credential is found in bare text too, outside JSON.
#[test]
fn a_credential_in_plain_text_is_found() {
    for k in 1..=12 {
        let t = synth::token(k, 7).unwrap();
        let text = format!("config line\nvalue = {t}\nend");
        assert!(matches(text.as_bytes(), k), "pattern {k} in text");
    }
    let text = format!("api_key = {}\n", synth::value(14, 3).unwrap());
    assert!(matches(text.as_bytes(), 14));
}

/// A token inside a longer run of letters and digits is a different string, not that format.
#[test]
fn a_token_inside_a_longer_word_is_not_matched() {
    for k in [1, 3, 5, 8] {
        let t = synth::token(k, 11).unwrap();
        assert!(!matches(format!("Z{t}").as_bytes(), k), "pattern {k} prefixed");
    }
    // A fixed-length format ends where its length does: one character more is another string.
    for k in [1, 5, 8] {
        let t = synth::token(k, 11).unwrap();
        assert!(!matches(format!("{t}9").as_bytes(), k), "pattern {k} suffixed");
    }
}

/// The randomness threshold: the right shape with a random part no draw would give is not a leak.
#[test]
fn low_randomness_is_not_a_leak() {
    let flat = |prefix: &[&str], c: char, n: usize| prefix.concat() + &c.to_string().repeat(n);
    assert!(!matches(flat(&["AK", "IA"], 'A', 16).as_bytes(), 1));
    assert!(!matches(flat(&["gh", "p_"], 'a', 36).as_bytes(), 5));
    let ab = ["sk", "_li", "ve_"].concat() + &"ab12".repeat(8);
    assert!(!matches(ab.as_bytes(), 3), "four symbols repeated");
}

/// Documented example and placeholder tokens are excluded by shape.
#[test]
fn examples_and_placeholders_are_excluded() {
    let marked = synth::token(1, 3).unwrap()[..13].to_string() + &["EXA", "MPLE"].concat();
    assert!(!matches(marked.as_bytes(), 1));
    let templated = ["gh", "p_"].concat() + "{token}" + &"x9".repeat(15);
    assert!(!matches(templated.as_bytes(), 5));
}

/// Publishable and test-mode payment keys move no money and are public by design.
#[test]
fn only_live_secret_payment_keys_match() {
    let rand = synth::token(3, 5).unwrap();
    let tail = &rand[["sk", "_li", "ve_"].concat().len()..];
    for prefix in [["pk", "_li", "ve_"].concat(), ["sk", "_te", "st_"].concat()] {
        assert!(!matches(format!("{prefix}{tail}").as_bytes(), 3), "{prefix}");
    }
}

/// A signed token with no subject names no one; an unsigned one proves nothing.
#[test]
fn a_session_token_must_be_signed_and_name_a_subject() {
    let t = synth::token(11, 9).unwrap();
    let mut parts = t.split('.');
    let (h, _, s) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap());
    let anon = format!("{h}.{}.{s}", "eyJyb2xlIjoiYW5vbiIsImlhdCI6MTc5MDAwMDAwMH0");
    assert!(!matches(anon.as_bytes(), 11), "no sub");
    let none = format!("{}.{}.{s}", "eyJhbGciOiJub25lIn0", t.split('.').nth(1).unwrap());
    assert!(!matches(none.as_bytes(), 11), "alg none");
}

/// A key block whose body is too short to be a key is not one.
#[test]
fn a_key_block_needs_a_body() {
    let label = ["PRIV", "ATE ", "KEY"].concat();
    let short = format!("-----BEGIN {label}-----\\nMIIBOgIBAAJBAKj34GkxFhD9\\n-----END {label}-----");
    assert!(!matches(short.as_bytes(), 10));
    let escaped = synth::token(10, 4).unwrap().replace('\n', "\\n");
    assert!(matches(format!(r#"{{"k":"{escaped}"}}"#).as_bytes(), 10), "escaped line breaks inside JSON");
}

/// Names that say a value is public, or values that aren't random, never make pattern 14 fire.
#[test]
fn public_or_plain_values_under_secret_names_are_not_leaks() {
    let v = synth::value(14, 2).unwrap();
    for name in ["csrf_token", "nextPageToken", "cursor_token", "recaptcha_token", "publishable_key"] {
        let body = format!(r#"{{"{name}":"{v}"}}"#);
        assert!(!matches(body.as_bytes(), 14), "{name}");
    }
    for plain in ["password_reset_confirmation", "2026-10-31T12:00:00.000Z+0800", "12345678901234567890123"] {
        assert!(!matches(format!(r#"{{"session":"{plain}"}}"#).as_bytes(), 14), "{plain}");
    }
}

/// A recipe field is named by its `loc`, whatever the JSON key holding its value is called, and a body template held
/// as a JSON string is read inside.
#[test]
fn a_recipe_field_and_a_body_template_are_read_by_name() {
    let v = synth::value(14, 8).unwrap();
    let field = format!(r#"{{"from":{{"source":"constant","value":"{v}"}},"loc":{{"in":"header","key":"x-api-key"}}}}"#);
    assert!(matches(field.as_bytes(), 14));
    let template = serde_json::to_string(&serde_json::json!({ "body": format!(r#"{{"client_secret":"{v}"}}"#) })).unwrap();
    assert!(matches(template.as_bytes(), 14));
    let url = format!(r#"{{"url":"https://api.shop.example/v1?access_token={v}&q=x"}}"#);
    assert!(matches(url.as_bytes(), 14));
}

/// What the detector reports never holds the value: only the pattern and an offset.
#[test]
fn a_hit_carries_no_value() {
    let body = synth::body(5, 1);
    let h = scan(body.as_bytes())[0];
    let t = synth::token(5, 1).unwrap();
    assert_eq!(&body[h.offset..h.offset + t.len()], t);
}

/// Clean recipe-shaped bodies, of the kinds a learned route holds, flag nothing.
#[test]
fn ordinary_bodies_flag_nothing() {
    let clean = [
        r#"{"format":"unbrowse.recipe/1","site":"shop.example","steps":[{"url":"https://shop.example/api/search?q={q}&page={page}","fields":[{"from":{"source":"param","name":"q"},"loc":{"in":"query","key":"q"}}]}]}"#,
        r#"{"build":"9f8e7d6c5b4a39281706f5e4d3c2b1a0","session":"cookie","uuid":"3f2a8c1e-4b7d-4e9a-8f3c-2d1b0a9e8f7c"}"#,
        r#"{"image":"https://cdn.shop.example/img/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6.jpg","etag":"W/\"5f3a-1b2c\""}"#,
    ];
    for b in clean {
        assert!(scan(b.as_bytes()).is_empty(), "{b}: {:?}", scan(b.as_bytes()));
    }
}

/// One fixed value is checked as the compiler sees it: by its format, or by the name of the field it sits in.
#[test]
fn a_single_value_is_checked_by_format_and_by_name() {
    let t = synth::token(5, 2).unwrap();
    assert_eq!(value_leaks("q", t.as_bytes()), Some(5));
    let v = synth::value(14, 2).unwrap();
    assert_eq!(value_leaks("client_secret", v.as_bytes()), Some(14));
    assert_eq!(value_leaks("item", v.as_bytes()), None, "a random id under a plain name is an id");
    assert_eq!(value_leaks("cookie", synth::value(13, 2).unwrap().as_bytes()), Some(13));
}
