//! Session values that have no vendor format, known by where they sit: patterns 12 to 14.
//!
//! - 12, a value sent as `Bearer` credentials;
//! - 13, a value in a `cookie` or `set-cookie` field;
//! - 14, a value in a field whose name says it is a secret (a password, a key, an access or refresh token, a session).
//!
//! 13 and 14 read the body as names and values. In JSON, each string is named by its key, and a recipe's field
//! (`{"from":{"value":..},"loc":{"in":..,"key":..}}`) is named by its `loc` key; a string that is itself JSON (a body
//! template) or holds a query string is read the same way inside. Text that isn't JSON is read as `name: value` and
//! `name=value` pairs.

use regex::bytes::Regex;

use crate::format::Format;
use crate::{exclude, random};

pub const BEARER: Format = Format {
    id: 12,
    name: "bearer-credential",
    family: "session",
    // The `Bearer` scheme, its space (or `%20`, `+`), and a token of 20 or more token68 characters.
    regex: r"(?-u)(?i:bearer)(?:[ +]|%20)+(?P<t>(?P<r>[A-Za-z0-9._~+/=\-]{20,4096}))",
    min_millibits: 3300,
    mixed: true,
    keep: None,
    min_kept: 20,
    check: None,
};

pub const COOKIE: u32 = 13;
pub const NAMED: u32 = 14;

/// Words in a field's name that make its value a secret, matched in the lower-cased name with `-` read as `_`.
const SECRET_WORDS: &[&str] =
    &["secret", "password", "passwd", "api_key", "apikey", "access_key", "accesskey", "access_token", "accesstoken", "refresh_token", "refreshtoken", "auth_token", "authtoken", "private_key", "privatekey", "session", "token"];

/// Words that make a field public even when its name has a secret word: a page token, a cursor, an anti-forgery token
/// the page hands every visitor, a one-time nonce. None acts as the owner.
const PUBLIC_WORDS: &[&str] = &["csrf", "xsrf", "nonce", "page", "cursor", "next", "continuation", "captcha", "recaptcha", "public", "publishable"];

/// The fewest bytes a value under 13 or 14 must have, and the randomness it must reach.
pub const MIN_VALUE: usize = 20;
pub const MIN_COOKIE_VALUE: usize = 16;
pub const VALUE_MILLIBITS: u32 = 3300;

/// Whether a value drawn from a field is a random secret: long enough, one token, letters and digits, random, not a
/// placeholder, not an address.
pub fn random_value(v: &[u8], min: usize) -> bool {
    v.len() >= min
        && v.len() <= 4096
        && !v.iter().any(|b| b.is_ascii_whitespace() || *b == b'"')
        && !v.windows(3).any(|w| w == b"://")
        && random::mixed(v)
        // Mostly digits is a number, a date or a time, however it is punctuated: a key drawn from letters and digits
        // is at least a fifth letters.
        && v.iter().filter(|b| b.is_ascii_alphabetic()).count() * 5 >= v.len()
        && random::entropy_millibits(v) >= VALUE_MILLIBITS
        && !exclude::excluded(v)
}

/// Whether a field's name says its value is a secret: a secret word in it ([`SECRET_WORDS`]) and no public one
/// ([`PUBLIC_WORDS`]), read lower-cased with `-` as `_`.
pub fn secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase().replace('-', "_");
    SECRET_WORDS.iter().any(|w| n.contains(w)) && !PUBLIC_WORDS.iter().any(|w| n.contains(w))
}

fn cookie_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("cookie") || name.eq_ignore_ascii_case("set-cookie")
}

/// The name a recipe field's `loc` gives its value: a header's, query's or form's key, a JSON pointer's last segment, a
/// part's name.
fn loc_name(loc: &serde_json::Value) -> Option<String> {
    match loc.get("key")? {
        serde_json::Value::String(k) => Some(k.rsplit('/').next().unwrap_or(k).to_string()),
        serde_json::Value::Array(xs) => xs.first().and_then(|x| x.as_str()).map(str::to_string),
        _ => None,
    }
}

fn query_pairs(s: &str, out: &mut Vec<(String, String)>) {
    let Some(q) = s.split_once('?').map(|(_, q)| q).or_else(|| s.contains('&').then_some(s)) else { return };
    for kv in q.split(['&', '#']) {
        if let Some((k, v)) = kv.split_once('=') {
            out.push((k.to_string(), v.to_string()));
        }
    }
}

fn walk(v: &serde_json::Value, depth: usize, out: &mut Vec<(String, String)>) {
    use serde_json::Value;
    if depth > 32 {
        return;
    }
    match v {
        Value::Object(m) => {
            if let (Some(loc), Some(Value::String(value))) = (m.get("loc"), m.get("from").and_then(|f| f.get("value"))) {
                if let Some(name) = loc_name(loc) {
                    out.push((name, value.clone()));
                }
            }
            for (k, x) in m {
                if let Value::String(s) = x {
                    out.push((k.clone(), s.clone()));
                }
                walk(x, depth + 1, out);
            }
        }
        Value::Array(xs) => xs.iter().for_each(|x| walk(x, depth + 1, out)),
        Value::String(s) => {
            let t = s.trim_start();
            if t.starts_with('{') || t.starts_with('[') {
                if let Ok(inner) = serde_json::from_str::<Value>(s) {
                    walk(&inner, depth + 1, out);
                    return;
                }
            }
            query_pairs(s, out);
        }
        _ => {}
    }
}

/// Every name and value the bytes hold, in the order they are read.
pub fn pairs(text: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    match serde_json::from_slice::<serde_json::Value>(text) {
        Ok(v) => walk(&v, 0, &mut out),
        Err(_) => {
            let re = Regex::new(r#"(?-u)["']?(?P<n>[A-Za-z0-9_.\-]{1,64})["']?[ \t]*[:=][ \t]*["']?(?P<v>[^ \t\r\n"'&,}]{1,4096})"#).expect("compiles");
            for c in re.captures_iter(text) {
                let n = String::from_utf8_lossy(&c["n"]).into_owned();
                let v = String::from_utf8_lossy(&c["v"]).into_owned();
                out.push((n, v));
            }
        }
    }
    out
}

fn offset(text: &[u8], v: &[u8]) -> usize {
    text.windows(v.len().max(1)).position(|w| w == v).unwrap_or(0)
}

/// The first value pattern `k` (13 or 14) finds among `pairs`, as its offset in `text`.
pub fn find_named(k: u32, text: &[u8], pairs: &[(String, String)]) -> Option<usize> {
    for (name, value) in pairs {
        let hit = match k {
            COOKIE if cookie_name(name) => value.split(';').filter_map(|kv| kv.split_once('=')).any(|(_, v)| random_value(v.trim().as_bytes(), MIN_COOKIE_VALUE)),
            NAMED => secret_name(name) && random_value(value.as_bytes(), MIN_VALUE),
            _ => false,
        };
        if hit {
            return Some(offset(text, value.as_bytes()));
        }
    }
    None
}
