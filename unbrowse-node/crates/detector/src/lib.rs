//! The pinned credential detector, `unbrowse-detector/1` (protocol R6.36, spec §73.7 item 3).
//!
//! One open, versioned set of patterns, run in two places on the same bytes: by the publishing node before it lists a
//! recipe (it refuses one the detector flags), and by a verifier's node on every body it fetches. A match is a leak;
//! liveness is never tested, because testing a credential means using it.
//!
//! Patterns 1 to 11 are known key formats, matched anywhere in the bytes; 12 to 14 are session values known by where
//! they sit. Every pattern also needs its random part to pass the randomness threshold (`random`) and not be a
//! documented example or placeholder (`exclude`). The false-positive rate of each, measured on real learned routes
//! before this version was pinned, is in the README.
//!
//! A pattern's number never changes meaning within a version, and a new version is a new pinned program: it applies
//! only to listings made after it.

use std::sync::OnceLock;

use regex::bytes::Regex;

pub mod card;
mod cloud;
mod code;
pub mod exclude;
pub mod format;
mod keys;
mod named;
pub mod random;
pub mod synth;

pub use keys::b64url;
pub use named::random_value;

/// The detector's version string (`fraud.detector`).
pub const VERSION: &str = "unbrowse-detector/1";
/// The version as a leak proof names it: `v` in its public values.
pub const VERSION_NUMBER: u32 = 1;

/// What a pattern is, for people: its number, name and kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pattern {
    pub id: u32,
    pub name: &'static str,
    pub family: &'static str,
}

/// A leak the detector found: the pattern, and where in the bytes the token or value starts. Never the value itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub pattern: u32,
    pub offset: usize,
}

fn formats() -> impl Iterator<Item = &'static format::Format> {
    cloud::FORMATS.iter().chain(code::FORMATS).chain(keys::FORMATS).chain(std::iter::once(&named::BEARER))
}

/// Every pattern of this version, in number order.
pub fn patterns() -> Vec<Pattern> {
    let mut all: Vec<Pattern> = formats().map(|f| Pattern { id: f.id, name: f.name, family: f.family }).collect();
    all.push(Pattern { id: named::COOKIE, name: "cookie-value", family: "session" });
    all.push(Pattern { id: named::NAMED, name: "secret-named-value", family: "session" });
    all.sort_by_key(|p| p.id);
    all
}

/// The pattern numbered `k`, if this version has one.
pub fn pattern(k: u32) -> Option<Pattern> {
    patterns().into_iter().find(|p| p.id == k)
}

fn compiled() -> &'static Vec<(&'static format::Format, Regex)> {
    static RE: OnceLock<Vec<(&'static format::Format, Regex)>> = OnceLock::new();
    RE.get_or_init(|| formats().map(|f| (f, f.compile())).collect())
}

/// Every pattern `bytes` match, each once, by its first hit, in pattern order.
pub fn scan(bytes: &[u8]) -> Vec<Hit> {
    let mut hits: Vec<Hit> = compiled().iter().filter_map(|(f, re)| f.find(re, bytes).map(|(at, _)| Hit { pattern: f.id, offset: at })).collect();
    let pairs = named::pairs(bytes);
    for k in [named::COOKIE, named::NAMED] {
        if let Some(offset) = named::find_named(k, bytes, &pairs) {
            hits.push(Hit { pattern: k, offset });
        }
    }
    hits.sort_by_key(|h| h.pattern);
    hits
}

/// The first hit of pattern `k` alone, compiling only that pattern: for a caller that asks about one pattern once, where
/// compiling the others would cost time for nothing.
pub fn find_one(bytes: &[u8], k: u32) -> Option<Hit> {
    if k == named::COOKIE || k == named::NAMED {
        return named::find_named(k, bytes, &named::pairs(bytes)).map(|offset| Hit { pattern: k, offset });
    }
    let f = formats().find(|f| f.id == k)?;
    f.find(&f.compile(), bytes).map(|(offset, _)| Hit { pattern: k, offset })
}

/// The first hit of pattern `k`, with every pattern compiled once per process: what the node runs. The same answer
/// as `find_one`.
pub fn find(bytes: &[u8], k: u32) -> Option<Hit> {
    if k == named::COOKIE || k == named::NAMED {
        return find_one(bytes, k);
    }
    let (f, re) = compiled().iter().find(|(f, _)| f.id == k)?;
    f.find(re, bytes).map(|(offset, _)| Hit { pattern: k, offset })
}

/// Whether `bytes` match pattern `k` of this version.
pub fn matches(bytes: &[u8], k: u32) -> bool {
    find(bytes, k).is_some()
}

/// Whether one value, named `name` where it sits (a header's, a query's or a body field's name), is a credential under
/// any pattern: what a compiler checks of a fixed value before it keeps one in a recipe.
pub fn value_leaks(name: &str, value: &[u8]) -> Option<u32> {
    if let Some(h) = scan(value).first() {
        return Some(h.pattern);
    }
    let pair = [(name.to_string(), String::from_utf8_lossy(value).into_owned())];
    [named::COOKIE, named::NAMED].into_iter().find(|&k| named::find_named(k, value, &pair).is_some())
}

#[cfg(test)]
mod tests;
