//! Bug reports: an agent says what went wrong (`unbrowse_report`), or the node notices it itself (a panic, an internal
//! error, a route that still failed after its page was walked again, a route made from another identity's body that
//! ran and failed), and the node sends a scrubbed report to the report relay (`unbrowse-telemetry/`,
//! `POST /v1/reports`). The relay files it as a public issue on unbrowse-ai/unbrowse, or counts it on the issue its
//! problem already has. A failed fetch is reported here and in telemetry, never on the chain
//! (`decide.failures-reported-off-chain`): see [`failed_use`].
//!
//! What a report holds is fixed ([`FIELDS`], the relay's `schema.json` `reports`), and every value is scrubbed here
//! before it leaves, then again by the relay: text is decoded first; a URL keeps its scheme, site and path (ids in the
//! path masked), never its query; emails, IP addresses, long numbers however spaced, hex, tokens, values of fields
//! named as secrets and vault references become `[email]`, `[token]`, `[secret]` and so on ([`scrub`]); the owner's
//! home folder, user name, machine name and vault account names become `[user]`, `[node]` and `[account]`. A route is
//! described by its shape only ([`shape`]): method, site ([`public_host`]), path template ([`template_path`]), input
//! names, the write flag and its step count, never an input's value, a cookie, a header or a body. Nothing a site said
//! goes in a report the node makes: a failure is its variant and status ([`crate::run::failure_variant`]).
//!
//! Reports are off until the owner turns them on (`unbrowse-node reports on`, or `UNBROWSE_REPORTS=1`): each becomes a
//! public issue. They also follow telemetry: off with telemetry, off in a dev build unless `UNBROWSE_REPORTS=1`, and off with
//! `unbrowse-node reports off` (kept in `reports.json`, and read before each send, so a running node stops at once) or
//! `UNBROWSE_REPORTS=0`. A report the relay can't take now is
//! kept in `reports-queue.json` and sent later. One problem (one [`fingerprint`]) is sent at most once a day.
//!
//! An agent's report carries the agent's own words, and an agent can be steered by a page it read: so what it writes
//! leaves only as the owner saw it. It waits in `reports-waiting.json` until the owner reads it, scrubbed, in their
//! window and sends it (`report_send`, asked in the node's own dialog with the report's text shown) or drops it
//! (`report_discard`). A report the node makes itself carries no words from a site, and goes as before.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::{store, telemetry, Node};
use crate::sync::Locked;

/// Where reports go, unless `UNBROWSE_REPORTS_URL` says otherwise.
pub const ENDPOINT: &str = "https://telemetry.unbrowse.ai/v1/reports";
/// Where they end up: the public repository whose issues the relay files.
pub const REPO: &str = "unbrowse-ai/unbrowse";

pub const FIELDS: &[&str] = &["kind", "summary", "expected", "got", "goal", "url", "tool", "error", "route", "last_error", "version", "os", "source", "install_id"];
const REQUIRED: &[&str] = &["kind", "summary", "version", "os", "source", "install_id"];
pub const KINDS: &[&str] = &["wrong_data", "false_success", "failed", "slow", "confusing", "other"];
const SOURCES: &[&str] = &["agent", "node"];
/// The agent tools a report may name: the primitives an agent calls about websites and its keys.
pub const TOOLS: &[&str] = &["unbrowse_search", "unbrowse_do", "unbrowse_browse", "unbrowse_logins", "unbrowse_call", "unbrowse_whoami"];
const METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "WS"];
const ROUTE_FIELDS: &[&str] = &["method", "host", "path", "inputs", "write", "steps"];
const LAST_ERROR_FIELDS: &[&str] = &["tool", "class", "error"];
const MAX_CHARS: &[(&str, usize)] = &[
    ("summary", 140),
    ("expected", 600),
    ("got", 1500),
    ("goal", 200),
    ("url", 300),
    ("error", 600),
    ("host", 253),
    ("path", 300),
    ("input", 64),
    ("last_error", 300),
];
const MAX_INPUTS: usize = 30;
const MAX_STEPS: usize = 100;
/// Reports this node sends a day: an agent's, and its own.
const AGENT_PER_DAY: u32 = 20;
const NODE_PER_DAY: u32 = 5;
/// Reports kept to send later, at most; and for how long.
const QUEUE_MAX: usize = 50;
const QUEUE_DAYS: u64 = 7;
/// How recent an agent's last call must be for its report to be read as about it.
const LAST_CALL_S: u64 = 600;

fn max(k: &str) -> usize {
    MAX_CHARS.iter().find(|(f, _)| *f == k).map_or(0, |(_, n)| *n)
}

/// What each scrub took out, by kind: `{"query": 1, "email": 2}`.
pub type Counts = BTreeMap<String, u32>;

fn count(c: &mut Counts, k: &str) {
    *c.entry(k.to_string()).or_default() += 1;
}

// ---- scrubbing: the same rules as the relay's (unbrowse-telemetry/src/report.js), step for step ----
//
// 1. Characters that hide or reorder text (zero-width, bidi controls, BOM) go.
// 2. What is encoded is decoded, so it is judged as it reads: `\/`, `\uXXXX`, `&#NN;`, and percent-encoding.
// 3. A run of 9 digits or more is a number (a card, a phone, an id), even split by spaces, `-`, `.` or brackets.
// 4. Each word (text between spaces, quotes, brackets and `,;|`) loses its query or fragment, then is judged: a vault
//    reference, an address, a URL (scheme, host and path), a host, or pieces split at `/ : & = ?`, each classified,
//    and the value after a key whose name says it's secret (`password=`, `"api_key": "…"`) masked.

fn is_separator(c: char) -> bool {
    c.is_whitespace() || "\"'<>()[]{},;`|".contains(c)
}

fn is_piece_delim(c: char) -> bool {
    "/:&=?|".contains(c)
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "_-+.~%".contains(c)
}

/// Zero-width characters, bidi controls and the byte-order mark: they hide or reorder text.
pub fn is_invisible(c: char) -> bool {
    matches!(c as u32, 0x200b..=0x200f | 0x202a..=0x202e | 0x2066..=0x2069 | 0xfeff)
}

fn valid_char(cp: u32) -> Option<char> {
    if cp == 0 {
        return None;
    }
    char::from_u32(cp)
}

/// One pass of decoding: `\/`, `\uXXXX`, `&#NN;` / `&#xHH;`, then runs of `%XX` that make UTF-8.
fn decode_once(t: &str) -> String {
    let t = t.replace("\\/", "/");
    // \uXXXX
    let c: Vec<char> = t.chars().collect();
    let mut a = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '\\' && c.get(i + 1) == Some(&'u') && i + 6 <= c.len() && c[i + 2..i + 6].iter().all(char::is_ascii_hexdigit) {
            let h: String = c[i + 2..i + 6].iter().collect();
            if let Some(ch) = u32::from_str_radix(&h, 16).ok().and_then(valid_char) {
                a.push(ch);
                i += 6;
                continue;
            }
        }
        a.push(c[i]);
        i += 1;
    }
    // &#NN; and &#xHH;
    let c: Vec<char> = a.chars().collect();
    let mut b = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '&' && c.get(i + 1) == Some(&'#') {
            let hex = matches!(c.get(i + 2), Some('x') | Some('X'));
            let from = if hex { i + 3 } else { i + 2 };
            let mut j = from;
            while j < c.len() && (if hex { c[j].is_ascii_hexdigit() } else { c[j].is_ascii_digit() }) {
                j += 1;
            }
            let n = j - from;
            if n >= 1 && n <= if hex { 6 } else { 7 } && c.get(j) == Some(&';') {
                let digits: String = c[from..j].iter().collect();
                if let Some(ch) = u32::from_str_radix(&digits, if hex { 16 } else { 10 }).ok().and_then(valid_char) {
                    b.push(ch);
                    i = j + 1;
                    continue;
                }
            }
        }
        b.push(c[i]);
        i += 1;
    }
    // runs of %XX
    let c: Vec<char> = b.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        let mut j = i;
        let mut bytes = Vec::new();
        while j + 2 < c.len() && c[j] == '%' && c[j + 1].is_ascii_hexdigit() && c[j + 2].is_ascii_hexdigit() {
            let h: String = c[j + 1..j + 3].iter().collect();
            bytes.push(u8::from_str_radix(&h, 16).unwrap_or(0));
            j += 3;
        }
        if bytes.is_empty() {
            out.push(c[i]);
            i += 1;
            continue;
        }
        match String::from_utf8(bytes) {
            Ok(s) => out.push_str(&s),
            Err(_) => out.extend(&c[i..j]),
        }
        i = j;
    }
    out
}

/// Text with nothing hidden and nothing encoded: invisible characters out, then decoded until it stops changing (at
/// most three times).
pub fn prepare(text: &str) -> String {
    let mut t: String = text.chars().filter(|c| !is_invisible(*c)).collect();
    for _ in 0..3 {
        let next = decode_once(&t);
        if next == t {
            break;
        }
        t = next;
    }
    t.chars().filter(|c| !is_invisible(*c)).collect()
}

fn is_ipv4(s: &str) -> bool {
    let bare = match s.rfind(':') {
        Some(i) if i + 1 < s.len() && s[i + 1..].bytes().all(|b| b.is_ascii_digit()) => &s[..i],
        _ => s,
    };
    let parts: Vec<&str> = bare.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// An IPv6 address: groups of 1 to 4 hex digits split by `:`, eight of them, or fewer with one `::`.
fn is_ipv6(s: &str) -> bool {
    let halves: Vec<&str> = s.split("::").collect();
    if halves.len() > 2 {
        return false;
    }
    let all: Vec<&str> = halves.iter().flat_map(|h| if h.is_empty() { Vec::new() } else { h.split(':').collect() }).collect();
    if !all.iter().all(|g| (1..=4).contains(&g.len()) && g.bytes().all(|b| b.is_ascii_hexdigit())) {
        return false;
    }
    if halves.len() == 2 { all.len() < 8 } else { all.len() == 8 }
}

/// A `.` followed by two letters or more, anywhere: what an email's domain ends with.
fn has_tld(s: &str) -> bool {
    let b = s.as_bytes();
    b.iter().enumerate().any(|(i, c)| *c == b'.' && b.len() > i + 2 && b[i + 1].is_ascii_alphabetic() && b[i + 2].is_ascii_alphabetic())
}

fn sep_in_number(c: char) -> bool {
    " -().".contains(c)
}

/// Step 3: every run of 9 digits or more (a card, phone or national id, written with spaces, dashes, dots or brackets
/// between its groups) as `[number]`. A run that starts or ends inside a word, or right after a `/`, is the word's,
/// and an IPv4 address is judged as one.
pub fn mask_digit_runs(text: &str, c: &mut Counts) -> String {
    let ch: Vec<char> = text.chars().collect();
    let word = |x: Option<&char>| x.is_some_and(|x| x.is_ascii_alphanumeric() || *x == '_');
    let mut out = String::new();
    let mut i = 0;
    while i < ch.len() {
        let prev = if i > 0 { ch.get(i - 1) } else { None };
        let prev2 = if i > 1 { ch.get(i - 2) } else { None };
        let starts = ch[i].is_ascii_digit()
            && !(word(prev) || prev == Some(&'/'))
            && !(prev.is_some_and(|p| sep_in_number(*p) && *p != ' ') && word(prev2));
        if !starts {
            out.push(ch[i]);
            i += 1;
            continue;
        }
        let (mut k, mut digits) = (i, 0);
        let end = loop {
            while k < ch.len() && ch[k].is_ascii_digit() {
                k += 1;
                digits += 1;
            }
            let end = k;
            let mut s = k;
            while s < ch.len() && s - k < 3 && sep_in_number(ch[s]) {
                s += 1;
            }
            if s > k && s < ch.len() && ch[s].is_ascii_digit() {
                k = s;
                continue;
            }
            break end;
        };
        let run: String = ch[i..end].iter().collect();
        if digits >= 9 && !word(ch.get(end)) && !is_ipv4(&run) {
            out.push_str("[number]");
            count(c, "number");
        } else {
            out.push_str(&run);
        }
        i = end;
    }
    out
}

/// What a piece of text is, when it is something a report must not carry: `vault` (a vault reference), `email`,
/// `ip`, `number` (9 digits or more in text, 4 or more in a path), `hex` (16 hex digits or more, or 0x and 8), `token`
/// (24 characters or more mixing letters and digits, or 12 or more mixing upper and lower case and digits).
pub fn classify(s: &str, in_path: bool) -> Option<&'static str> {
    if s.is_empty() {
        return None;
    }
    if s.to_lowercase().contains("vault:") {
        return Some("vault");
    }
    if s.rfind('@').is_some_and(|at| has_tld(&s[at + 1..])) {
        return Some("email");
    }
    if is_ipv4(s) {
        return Some("ip");
    }
    if s.bytes().all(|b| b.is_ascii_digit()) && s.len() >= if in_path { 4 } else { 9 } {
        return Some("number");
    }
    let prefixed = s.starts_with("0x") || s.starts_with("0X");
    let h = if prefixed { &s[2..] } else { s };
    if h.len() >= if prefixed { 8 } else { 16 } && h.bytes().all(|b| b.is_ascii_hexdigit()) && h.bytes().any(|b| b.is_ascii_digit()) {
        return Some("hex");
    }
    if s.chars().all(is_token_char) {
        let (letter, digit) = (s.bytes().any(|b| b.is_ascii_alphabetic()), s.bytes().any(|b| b.is_ascii_digit()));
        let (upper, lower) = (s.bytes().any(|b| b.is_ascii_uppercase()), s.bytes().any(|b| b.is_ascii_lowercase()));
        if (s.len() >= 24 && letter && digit) || (s.len() >= 12 && upper && lower && digit) {
            return Some("token");
        }
    }
    None
}

/// A key names a secret (or a person) when a word of its name says so: part of it (`access_token`, `x-api-key`,
/// `jsessionid`), or the whole of one of its words (`code`, `pin`, `sig`). Stated as a rule of names, never of sites.
const SECRET_IN_NAME: &[&str] = &["token", "secret", "passw", "session", "sessid", "apikey", "auth", "cookie", "signature", "credential", "csrf", "xsrf", "bearer", "private"];
const SECRET_NAME_WORDS: &[&str] = &["key", "code", "pwd", "pass", "sig", "sid", "otp", "jwt", "pin", "ssn", "email", "phone", "nonce", "ticket"];

/// Whether a key's name says its value is a secret or a person's.
pub fn is_secret_key(name: &str) -> bool {
    let k = name.trim_start_matches('-');
    if k.is_empty() || k.chars().count() > 40 || !k.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
        return false;
    }
    let lower = k.to_ascii_lowercase();
    if SECRET_IN_NAME.iter().any(|w| lower.contains(w)) {
        return true;
    }
    // Its words: split at `-`, `_` and `.`, and where a lower-case letter or digit meets an upper-case one.
    let mut words = Vec::new();
    for part in k.split(['-', '_', '.']) {
        let mut w = String::new();
        let mut prev: Option<char> = None;
        for ch in part.chars() {
            if ch.is_ascii_uppercase() && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit()) {
                words.push(std::mem::take(&mut w));
            }
            w.push(ch);
            prev = Some(ch);
        }
        words.push(w);
    }
    words.iter().any(|w| SECRET_NAME_WORDS.contains(&w.to_ascii_lowercase().as_str()))
}

/// A value no key makes secret: a number of three digits or fewer (a status, a count), true, false or null.
fn is_plain_value(v: &str) -> bool {
    ((1..=3).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit())) || ["true", "false", "null"].contains(&v.to_lowercase().as_str())
}

/// A host as a report keeps it, read from the name alone: an address is `[ip]`; a single name, or a host on a port
/// other than the web's (80, 443), is a machine's, `[internal]`; and the labels left of the site's own name (the
/// last two, or three under a short second level such as co.uk) are `*`, since a company's or a person's name is
/// what goes there. Masks are kept.
pub fn mask_host(host: &str, c: &mut Counts, with_port: bool) -> String {
    let lower = host.to_lowercase();
    let mut h = lower.strip_suffix('.').unwrap_or(&lower).to_string();
    if h.is_empty() {
        return h;
    }
    if h.len() > 2 && h.starts_with('[') && h.ends_with(']') && h[1..h.len() - 1].chars().all(|ch| ch.is_ascii_lowercase()) {
        return h;
    }
    if h.starts_with('[') {
        count(c, "ip");
        return "[ip]".into();
    }
    let mut port = String::new();
    if with_port {
        if let Some(i) = h.rfind(':') {
            if i + 1 < h.len() && h[i + 1..].bytes().all(|b| b.is_ascii_digit()) {
                port = h[i + 1..].to_string();
                h.truncate(i);
            }
        }
    }
    if is_ipv4(&h) || is_ipv6(&h) {
        count(c, "ip");
        return "[ip]".into();
    }
    let labels: Vec<&str> = h.split('.').collect();
    if labels.len() == 1 || labels.iter().any(|l| l.is_empty()) || (!port.is_empty() && port != "80" && port != "443") {
        count(c, "internal");
        return "[internal]".into();
    }
    let keep = if labels.len() >= 3 && labels[labels.len() - 2].chars().count() <= 3 { 3 } else { 2 };
    if labels.len() > keep {
        if labels[0] != "*" || labels.len() > keep + 1 {
            count(c, "subdomain");
        }
        return format!("*.{}", labels[labels.len() - keep..].join("."));
    }
    h
}

/// A word's query and fragment: cut from the first `?` or `#` that follows something path- or host-like, or that
/// starts something holding `=`.
pub fn drop_query(core: &str, c: &mut Counts) -> String {
    for (i, ch) in core.char_indices() {
        if ch != '?' && ch != '#' {
            continue;
        }
        let (before, after) = (&core[..i], &core[i + 1..]);
        if !before.is_empty() && !after.is_empty() && (before.contains(['/', '.']) || after.contains('=')) {
            count(c, "query");
            return before.to_string();
        }
    }
    core.to_string()
}

/// What a word ends on, for the word after it: a secret key's name, or a secret key and its `=` or `:`.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Ends {
    Key,
    Value,
}

/// Pieces of a word, split at `/ : & = ? |`, each classified, the value after a secret key masked.
fn scrub_pieces(core: &str, c: &mut Counts, in_path: bool) -> (String, Option<Ends>) {
    let (mut pieces, mut delims) = (vec![String::new()], Vec::new());
    for ch in core.chars() {
        if is_piece_delim(ch) {
            delims.push(ch);
            pieces.push(String::new());
        } else {
            pieces.last_mut().expect("one piece").push(ch);
        }
    }
    let mask = |k: &str| if in_path { format!("{{{k}}}") } else { format!("[{k}]") };
    let (mut out, mut ends, mut k) = (String::new(), None, 0);
    while k < pieces.len() {
        let p = &pieces[k];
        let kind = classify(p, in_path);
        if let Some(kind) = kind {
            count(c, kind);
            out.push_str(&mask(kind));
        } else {
            out.push_str(p);
        }
        if k == pieces.len() - 1 {
            if kind.is_none() && is_secret_key(p) {
                ends = Some(Ends::Key);
            }
            break;
        }
        let d = delims[k];
        out.push(d);
        if kind.is_none() && is_secret_key(p) && (d == '=' || d == ':') {
            let mut m = k + 1;
            let mut value = pieces[m].clone();
            while m < delims.len() && delims[m] != '&' {
                value.push(delims[m]);
                value.push_str(&pieces[m + 1]);
                m += 1;
            }
            if value.is_empty() && m == pieces.len() - 1 {
                ends = Some(Ends::Value);
                break;
            }
            if !value.is_empty() && !is_plain_value(&value) {
                count(c, "secret");
                out.push_str(&mask("secret"));
                if m >= delims.len() {
                    break;
                }
                out.push(delims[m]);
                k = m + 1;
                continue;
            }
        }
        k += 1;
    }
    (out, ends)
}

/// A URL as a report keeps it: scheme, host and path, with ids in the path masked; never a query, fragment or login.
pub fn reduce_url(u: &str, c: &mut Counts) -> String {
    let Some((scheme, rest)) = u.split_once("://") else {
        count(c, "url");
        return "[url]".into();
    };
    let mut sc = scheme.chars();
    if !sc.next().is_some_and(|f| f.is_ascii_alphabetic()) || !sc.all(|ch| ch.is_ascii_alphanumeric() || "+.-".contains(ch)) {
        count(c, "url");
        return "[url]".into();
    }
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (mut auth, after) = rest.split_at(auth_end);
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    let (path, tail) = after.split_at(path_end);
    if let Some(at) = auth.rfind('@') {
        auth = &auth[at + 1..];
        count(c, "login");
    }
    let host = mask_host(auth, c, true);
    let (path, _) = scrub_pieces(path, c, true);
    if !tail.is_empty() {
        count(c, "query");
    }
    format!("{}://{host}{path}", scheme.to_lowercase())
}

/// The core of a word and its trailing punctuation (`.,:!?`).
fn split_tail(w: &str) -> (&str, &str) {
    let core = w.trim_end_matches(['.', ',', ':', '!', '?']);
    (core, &w[core.len()..])
}

/// Whether `head` reads as a host of three labels or more: letters, digits and `-` (or a leading `*`), and a last
/// label of two letters or more.
fn host_like(head: &str) -> bool {
    let labels: Vec<&str> = head.split('.').collect();
    labels.len() >= 3
        && labels.iter().enumerate().all(|(i, l)| (i == 0 && *l == "*") || (!l.is_empty() && l.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-')))
        && labels.last().is_some_and(|l| l.len() >= 2 && l.chars().all(|ch| ch.is_ascii_alphabetic()))
}

/// One word, judged. Returns its text and what it ends on.
fn scrub_word(w: &str, c: &mut Counts) -> (String, Option<Ends>) {
    if w.is_empty() {
        return (String::new(), None);
    }
    let (raw, tail) = split_tail(w);
    let core = drop_query(raw, c);
    if core.is_empty() {
        return (tail.to_string(), None);
    }
    if core.to_lowercase().contains("vault:") {
        count(c, "vault");
        return (format!("[vault]{tail}"), None);
    }
    if is_ipv4(&core) || is_ipv6(&core) {
        count(c, "ip");
        return (format!("[ip]{tail}"), None);
    }
    let lower = core.to_ascii_lowercase();
    let at = (0..lower.len()).filter(|i| lower.is_char_boundary(*i)).find(|i| ["http://", "https://", "ws://", "wss://"].iter().any(|s| lower[*i..].starts_with(s)));
    if let Some(at) = at {
        let before = if at > 0 { scrub_word(&core[..at], c).0 } else { String::new() };
        return (format!("{before}{}{tail}", reduce_url(&core[at..], c)), None);
    }
    if let Some(k) = classify(&core, false) {
        count(c, k);
        return (format!("[{k}]{tail}"), None);
    }
    let head = core.split('/').next().unwrap_or_default();
    let (lead, rest) = if host_like(head) { (mask_host(head, c, false), &core[head.len()..]) } else { (String::new(), core.as_str()) };
    let (out, ends) = scrub_pieces(rest, c, false);
    let state = match ends {
        Some(Ends::Key) if tail.starts_with(':') => Some(Ends::Value),
        Some(Ends::Key) if !tail.is_empty() => None,
        e => e,
    };
    (format!("{lead}{out}{tail}"), state)
}

/// Whether a separator keeps a key's value coming: spaces, tabs and quotes only.
fn carries(sep: &str) -> bool {
    sep.chars().all(|ch| " \t\"'`".contains(ch))
}

/// Text as a report keeps it: steps 1 to 4 above.
pub fn scrub(text: &str, c: &mut Counts) -> String {
    let t = mask_digit_runs(&prepare(text), c);
    let mut parts: Vec<(String, bool)> = Vec::new();
    let (mut word, mut sep) = (String::new(), String::new());
    for ch in t.chars() {
        if is_separator(ch) {
            if !word.is_empty() {
                parts.push((std::mem::take(&mut word), false));
            }
            sep.push(ch);
        } else {
            if !sep.is_empty() {
                parts.push((std::mem::take(&mut sep), true));
            }
            word.push(ch);
        }
    }
    if !word.is_empty() {
        parts.push((word, false));
    }
    if !sep.is_empty() {
        parts.push((sep, true));
    }
    let (mut out, mut state) = (String::new(), None);
    for (p, is_sep) in parts {
        if is_sep {
            if !carries(&p) {
                state = None;
            }
            out.push_str(&p);
            continue;
        }
        if state == Some(Ends::Value) {
            let (core, tail) = split_tail(&p);
            state = None;
            if !core.is_empty() && !is_plain_value(core) {
                count(c, "secret");
                out.push_str("[secret]");
                out.push_str(tail);
                continue;
            }
        }
        if state == Some(Ends::Key) && (p.starts_with(':') || p.starts_with('=')) {
            state = None;
            let rest = &p[1..];
            if rest.is_empty() {
                out.push_str(&p);
                state = Some(Ends::Value);
                continue;
            }
            if !is_plain_value(rest) {
                count(c, "secret");
                out.push_str(&p[..1]);
                out.push_str("[secret]");
                continue;
            }
        }
        let (s, ends) = scrub_word(&p, c);
        out.push_str(&s);
        state = ends;
    }
    out
}

/// A path as a report keeps a route's or a page's: each segment kept only when it is a template (`{name}`), a mask,
/// a version (`v2`) or plain lowercase words of 32 characters or fewer; else `{number}` or `{id}`. A handle, a name
/// with digits, an id or a file named for someone never reads through.
pub fn template_path(path: &str, c: &mut Counts) -> String {
    let dictionary = |seg: &str| {
        seg.chars().count() <= 32
            && seg.split(['-', '_', '.']).all(|w| !w.is_empty() && w.chars().all(|ch| ch.is_ascii_lowercase()))
    };
    path.split('/')
        .map(|seg| {
            let template = seg.len() > 2 && seg.starts_with('{') && seg.ends_with('}') && seg[1..seg.len() - 1].chars().all(|ch| ch.is_ascii_alphanumeric() || "_.-[]".contains(ch));
            let masked = seg.len() > 2 && seg.starts_with('[') && seg.ends_with(']') && seg[1..seg.len() - 1].chars().all(|ch| ch.is_ascii_lowercase());
            let version = seg.len() >= 2 && seg.len() <= 4 && seg.starts_with('v') && seg[1..].bytes().all(|b| b.is_ascii_digit());
            if seg.is_empty() || template || masked || version || dictionary(seg) {
                return seg.to_string();
            }
            count(c, "path");
            if seg.bytes().all(|b| b.is_ascii_digit()) { "{number}".into() } else { "{id}".into() }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// At most `max` characters, cut with an ellipsis.
pub fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max - 1).collect::<String>() + "…"
}

/// No control characters but newlines and tabs, and nothing invisible; one line when `one_line`.
fn clean(s: &str, one_line: bool) -> String {
    let kept: String = s.chars().filter(|c| !matches!(*c as u32, 0..=8 | 0x0b..=0x1f | 0x7f) && !is_invisible(*c)).collect();
    if !one_line {
        return kept.trim().to_string();
    }
    let mut out = String::new();
    let mut gap = false;
    for ch in kept.chars() {
        if ch == '\n' || ch == '\t' {
            gap = true;
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(ch);
    }
    if gap {
        out.push(' ');
    }
    out.trim().to_string()
}

// ---- the fingerprint: which reports are the same problem ----

/// The host of a report's page, or "".
fn page_host(url: &str) -> &str {
    url.split_once("://").map_or("", |(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
}

/// Reports are one problem, one issue, when they share what the node, not the writer, says about them: the kind, the
/// tool, the route's shape, the page's host, and the class and error of the last failed call; and, for the node's own
/// report, its error, which the node makes from the error's variant and status alone. Never the free text an agent
/// wrote: it differs for one problem, and anyone can vary it. 16 hex digits of a SHA-256, as the relay makes it.
pub fn fingerprint(r: &Value) -> String {
    let s = |v: Option<&Value>| v.and_then(Value::as_str).unwrap_or_default().to_string();
    let route = r.get("route");
    let last = r.get("last_error");
    let text = [
        s(r.get("kind")),
        s(r.get("tool")),
        s(route.and_then(|t| t.get("method"))),
        s(route.and_then(|t| t.get("host"))),
        s(route.and_then(|t| t.get("path"))),
        page_host(&s(r.get("url"))).to_string(),
        s(last.and_then(|e| e.get("class"))),
        s(last.and_then(|e| e.get("error"))),
        if s(r.get("source")) == "node" { s(r.get("error")) } else { String::new() },
    ]
    .join("\n");
    hex::encode(&Sha256::digest(text.as_bytes())[..8])
}

// ---- what this machine knows that a report must not carry ----

/// The owner's own words a generic rule can't know: the home folder, the user and machine names, the vault's account
/// names. Each is replaced where it stands as a whole word.
pub struct Known(Vec<(String, &'static str)>);

impl Known {
    #[cfg(test)]
    pub fn none() -> Self {
        Known(Vec::new())
    }

    /// This machine's: `node_name` is the name the node goes by (the machine's).
    pub fn here(node_name: &str) -> Self {
        let home = unbrowse_files::private::user_home();
        let mut k = vec![(home.to_string_lossy().to_string(), "~")];
        if let Some(user) = home.file_name().map(|u| u.to_string_lossy().to_string()) {
            k.push((user, "[user]"));
        }
        k.push((node_name.to_string(), "[node]"));
        for l in crate::vault::list() {
            k.push((l.account, "[account]"));
        }
        Known(k)
    }

    #[cfg(test)]
    pub fn of(words: &[(&str, &'static str)]) -> Self {
        Known(words.iter().map(|(w, r)| (w.to_string(), *r)).collect())
    }

    /// `text` with every known word replaced; the longest first, so a home folder goes before the user name in it.
    pub fn apply(&self, text: &str, c: &mut Counts) -> String {
        let mut words: Vec<&(String, &'static str)> = self.0.iter().filter(|(w, _)| w.chars().count() >= 4 && w != "/").collect();
        words.sort_by_key(|(w, _)| std::cmp::Reverse(w.len()));
        let mut out = text.to_string();
        for (w, with) in words {
            out = replace_word(&out, w, with, c);
        }
        out
    }
}

/// `text` with `needle` replaced, in any case, where neither side of it continues a word (a path's own `/` is an
/// edge).
fn replace_word(text: &str, needle: &str, with: &str, c: &mut Counts) -> String {
    let is_word = |ch: Option<char>| ch.is_some_and(|ch| ch.is_alphanumeric() || ch == '_');
    // ASCII case folding keeps every byte where it was, so an offset found in `folded` is one in `text`.
    let (folded, needle_folded) = (text.to_ascii_lowercase(), needle.to_ascii_lowercase());
    let (mut out, mut i) = (String::new(), 0);
    while let Some(j) = folded[i..].find(&needle_folded) {
        let (at, end) = (i + j, i + j + needle.len());
        out.push_str(&text[i..at]);
        if (needle.starts_with('/') || !is_word(text[..at].chars().last())) && !is_word(text[end..].chars().next()) {
            out.push_str(with);
            count(c, "personal");
        } else {
            out.push_str(&text[at..end]);
        }
        i = end;
    }
    out + &text[i..]
}

// ---- building a report ----

/// What an agent says, as `unbrowse_report` takes it.
#[derive(Default, Clone, Debug)]
pub struct Asked {
    pub kind: String,
    pub summary: String,
    pub expected: String,
    pub got: String,
    pub route_id: String,
    pub goal: String,
    pub url: String,
    pub tool: String,
    pub error: String,
}

/// An agent's last call, as the node saw it: the report it files next is probably about it.
#[derive(Clone, Debug)]
pub struct Last {
    pub at: u64,
    pub tool: &'static str,
    pub route_id: Option<String>,
    /// The agent's last call that failed, this one or an earlier one.
    pub failure: Option<Failure>,
}

/// A call that failed: when, which tool, the coarse class telemetry uses, and the error as the node describes it:
/// the status it answered, or the failed call's variant and status ([`crate::run::failure_variant`]). Never the
/// error the agent was told, which can carry the site's own words.
#[derive(Clone, Debug)]
pub struct Failure {
    pub at: u64,
    pub tool: &'static str,
    pub class: &'static str,
    pub error: String,
}

/// A path as the relay takes it: only URL characters, percent-encoded otherwise, cut (never with an ellipsis, which
/// isn't one) to its length.
fn path_chars(p: &str) -> String {
    let mut out = String::new();
    for ch in p.chars() {
        if ch.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:%/{}[]".contains(ch) {
            out.push(ch);
        } else {
            let mut b = [0u8; 4];
            for byte in ch.encode_utf8(&mut b).bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    let out: String = out.chars().take(max("path")).collect();
    if out.starts_with('/') { out } else { format!("/{out}") }
}

fn host_ok(h: &str) -> bool {
    !h.is_empty() && h.len() <= max("host") && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-[]:*".contains(c))
}

/// A route's or a page's host as a report keeps it, read against the public suffix list: an address is `[ip]`; a
/// name the public DNS doesn't answer for (`intranet.corp`, `localhost`, a single label) is `[internal]`; every label
/// left of the registrable domain is `*`, and so is the registrable label itself under a suffix a company runs for its
/// customers (the list's private section: `*.atlassian.net`, `*.github.io`), since a tenant's or a person's name is
/// what goes there. Then the text rule ([`mask_host`]) as the relay applies it, so the relay changes nothing.
pub fn public_host(raw: &str, known: &Known, c: &mut Counts) -> String {
    let auth = raw.rsplit('@').next().unwrap_or_default().to_ascii_lowercase();
    let auth = auth.strip_suffix('.').unwrap_or(&auth);
    if auth.len() > 2 && auth.starts_with('[') && auth.ends_with(']') && auth[1..auth.len() - 1].chars().all(|ch| ch.is_ascii_lowercase()) {
        return auth.to_string();
    }
    if auth.starts_with('[') {
        count(c, "ip");
        return "[ip]".into();
    }
    let host = match auth.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => auth,
    };
    if is_ipv4(host) || is_ipv6(host) {
        count(c, "ip");
        return "[ip]".into();
    }
    let suffix = psl::suffix(host.as_bytes()).filter(|_| unbrowse_learn::egress::public_name(host));
    let Some(suffix) = suffix else {
        count(c, "internal");
        return "[internal]".into();
    };
    let kept = if suffix.typ() == Some(psl::Type::Private) {
        format!("*.{}", String::from_utf8_lossy(suffix.as_bytes()))
    } else {
        match psl::domain_str(host) {
            Some(d) if d != host => format!("*.{d}"),
            Some(d) => d.to_string(),
            None => {
                count(c, "internal");
                return "[internal]".into();
            }
        }
    };
    if kept != host {
        count(c, "subdomain");
    }
    // The owner's own name left in it (their own site) names them.
    if known.apply(&kept, &mut Counts::new()) != kept {
        count(c, "personal");
        return "[personal]".into();
    }
    mask_host(&kept, c, false)
}

/// A route's or a page's path as a report keeps it: the owner's own words out, then only its plain segments
/// ([`template_path`]), in URL characters.
fn public_path(path: &str, known: &Known, c: &mut Counts) -> String {
    let named = known.apply(&prepare(path), c);
    path_chars(&template_path(&named, c))
}

/// A URL an agent gave, as a report keeps it, or nothing when it isn't a web address: its scheme, its host
/// ([`public_host`]) and its path ([`public_path`]); never its login, query or fragment.
fn page(u: &str, known: &Known, c: &mut Counts) -> Option<String> {
    let u = prepare(u.trim());
    let (scheme, rest) = u.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !["http", "https", "ws", "wss"].contains(&scheme.as_str()) {
        return None;
    }
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, after) = rest.split_at(auth_end);
    if auth.contains('@') {
        count(c, "login");
    }
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    if path_end < after.len() {
        count(c, "query");
    }
    let host = public_host(auth, known, c);
    if !host_ok(&host) {
        return None;
    }
    let path = &after[..path_end];
    let path = if path.is_empty() { String::new() } else { public_path(path, known, c) };
    Some(format!("{scheme}://{host}{path}").chars().take(max("url")).collect())
}

/// A route's shape: its method, host ([`public_host`]), path template ([`public_path`]), input names, write flag and
/// step count. Never an input's value or default, a cookie, a header or a body.
pub fn shape(r: &store::Route, known: &Known, c: &mut Counts) -> Option<Value> {
    // As an agent is shown the route: nothing the owner's own session gave its page, in its address or elsewhere.
    let shown = r.shown_to_an_agent();
    let r = &shown;
    let method = if r.socket.is_some() { "WS".to_string() } else { r.method.to_uppercase() };
    if !METHODS.contains(&method.as_str()) {
        return None;
    }
    // The route's address is its target's URL with each value as {name}; braces aren't URL characters, so it is read
    // by hand rather than parsed.
    let rest = r.path.split_once("://").map_or(r.path.as_str(), |(_, rest)| rest);
    let auth_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, after) = rest.split_at(auth_end);
    let auth = if auth.is_empty() { r.site.as_str() } else { auth };
    let host = public_host(auth, known, c);
    if !host_ok(&host) {
        return None;
    }
    let path = after.split(['?', '#']).next().unwrap_or_default();
    if after.len() > path.len() {
        count(c, "query");
    }
    let path = public_path(if path.is_empty() { "/" } else { path }, known, c);
    let inputs: Vec<String> = r
        .inputs
        .iter()
        .take(MAX_INPUTS)
        .map(|i| i.name.chars().map(|c| if c.is_ascii_alphanumeric() || "_.-[]".contains(c) { c } else { '_' }).take(max("input")).collect())
        .filter(|n: &String| !n.is_empty())
        .collect();
    let steps = if r.socket.is_some() { 1 } else { r.graph.steps.len() }.min(MAX_STEPS);
    Some(json!({ "method": method, "host": host, "path": path, "inputs": inputs, "write": r.write, "steps": steps }))
}

/// A tool as a report names it: an MCP tool's name, with or without its `unbrowse_`.
fn tool_name(t: &str) -> Option<&'static str> {
    let t = t.trim();
    TOOLS.iter().find(|n| **n == t || n.strip_prefix("unbrowse_") == Some(t)).copied()
}

/// Free text as a report keeps it: decoded, the owner's own words out, scrubbed, cleaned and capped.
fn text(s: &str, field: &str, known: &Known, c: &mut Counts) -> String {
    let one_line = field == "summary" || field == "goal";
    cap(&clean(&scrub(&known.apply(&prepare(s), c), c), one_line), max(field))
}

/// Where a report comes from, and what the node adds to it.
pub struct Context<'a> {
    pub source: &'static str,
    pub version: &'a str,
    pub install_id: &'a str,
    pub known: &'a Known,
    pub last: Option<Last>,
    pub now: u64,
}

/// The report the relay will be sent, and what scrubbing took out of it. A route named by id (or the agent's last
/// call, when it was recent and the report names none) is described by its shape.
pub fn build(asked: &Asked, cx: &Context) -> (Value, Counts) {
    let mut c = Counts::new();
    let mut r = Map::new();
    r.insert("kind".into(), json!(asked.kind));
    for (k, v) in [("summary", &asked.summary), ("expected", &asked.expected), ("got", &asked.got), ("goal", &asked.goal), ("error", &asked.error)] {
        let t = text(v, k, cx.known, &mut c);
        if !t.is_empty() {
            r.insert(k.into(), json!(t));
        }
    }
    if let Some(u) = (!asked.url.trim().is_empty()).then(|| page(&asked.url, cx.known, &mut c)).flatten() {
        r.insert("url".into(), json!(u));
    }
    let last = cx.last.clone().filter(|l| cx.now.saturating_sub(l.at) <= LAST_CALL_S);
    if let Some(t) = tool_name(&asked.tool).or(last.as_ref().map(|l| l.tool).filter(|t| TOOLS.contains(t))) {
        r.insert("tool".into(), json!(t));
    }
    let route_id = Some(asked.route_id.trim().to_string()).filter(|s| !s.is_empty()).or_else(|| last.as_ref().and_then(|l| l.route_id.clone()));
    if let Some(shape) = route_id.and_then(|id| store::load_route(&id)).and_then(|route| shape(&route, cx.known, &mut c)) {
        r.insert("route".into(), shape);
    }
    let failure = cx.last.as_ref().and_then(|l| l.failure.clone()).filter(|f| cx.now.saturating_sub(f.at) <= LAST_CALL_S && TOOLS.contains(&f.tool));
    if let Some(f) = failure {
        let mut e = json!({ "tool": f.tool, "class": f.class });
        let t = cap(&clean(&scrub(&cx.known.apply(&prepare(&f.error), &mut c), &mut c), false), max("last_error"));
        if !t.is_empty() {
            e["error"] = json!(t);
        }
        r.insert("last_error".into(), e);
    }
    r.insert("version".into(), json!(cx.version));
    r.insert("os".into(), json!(telemetry::os()));
    r.insert("source".into(), json!(cx.source));
    r.insert("install_id".into(), json!(cx.install_id));
    (Value::Object(r), c)
}

/// Checks a report as it will be sent, against the relay's own rules: a report this refuses would be refused there.
pub fn check(r: &Value) -> Result<(), String> {
    let o = r.as_object().ok_or("a report is an object")?;
    if let Some(k) = o.keys().find(|k| !FIELDS.contains(&k.as_str())) {
        return Err(format!("field not allowed: {k}"));
    }
    if let Some(k) = REQUIRED.iter().find(|k| !o.contains_key(**k)) {
        return Err(format!("missing field: {k}"));
    }
    let s = |k: &str| o.get(k).and_then(Value::as_str);
    if !s("kind").is_some_and(|k| KINDS.contains(&k)) {
        return Err(format!("kind is one of {}", KINDS.join(", ")));
    }
    if !s("source").is_some_and(|k| SOURCES.contains(&k)) {
        return Err("source is agent or node".into());
    }
    if s("summary").is_none_or(|t| t.trim().is_empty()) {
        return Err("summary says what went wrong".into());
    }
    for k in ["summary", "expected", "got", "goal", "error"] {
        if let Some(v) = o.get(k) {
            if v.as_str().is_none_or(|t| t.chars().count() > max(k)) {
                return Err(format!("{k} is at most {} characters", max(k)));
            }
        }
    }
    if o.get("tool").is_some_and(|t| !t.as_str().is_some_and(|t| TOOLS.contains(&t))) {
        return Err("tool is not an allowed value".into());
    }
    if let Some(u) = o.get("url") {
        let u = u.as_str().unwrap_or_default();
        if u.contains(['?', '#', '@']) || u.chars().any(char::is_whitespace) || u.len() > max("url") {
            return Err("url is a scheme, host and path only".into());
        }
    }
    if let Some(t) = o.get("route") {
        let t = t.as_object().ok_or("route is an object")?;
        if let Some(k) = t.keys().find(|k| !ROUTE_FIELDS.contains(&k.as_str())) {
            return Err(format!("route field not allowed: {k}"));
        }
    }
    if let Some(e) = o.get("last_error") {
        let e = e.as_object().ok_or("last_error is an object")?;
        if let Some(k) = e.keys().find(|k| !LAST_ERROR_FIELDS.contains(&k.as_str())) {
            return Err(format!("last_error field not allowed: {k}"));
        }
    }
    Ok(())
}

// ---- the owner's choice ----

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Saved {
    pub on: bool,
}

fn saved_path() -> std::path::PathBuf {
    store::home().join("reports.json")
}

/// The owner's choice; off when there is none, since a report becomes a public issue: only the owner turns them on
/// (`unbrowse-node reports on`). One a newer node saved reads as off: this node can't tell what it says.
fn load_saved() -> Saved {
    match unbrowse_files::REPORTS.read_at(&saved_path()) {
        Ok(Some(s)) => s,
        _ => Saved { on: false },
    }
}

/// Whether to send: never while telemetry is off; else the environment's say, else the saved choice in a release
/// build. A dev build sends only when the environment asks.
pub fn decide(env: Option<bool>, saved_on: bool, telemetry_on: bool, dev: bool) -> bool {
    telemetry_on && env.unwrap_or(saved_on && !dev)
}

/// Whether a node that started with reports on still sends: `reports off` (or `telemetry off`) saved since then
/// stops it at once, unless the environment says on. Turning them on takes a start, which makes the sender.
fn still_on(cfg: &Config) -> bool {
    if !cfg.on {
        return false;
    }
    let env = |k: &str| telemetry::env_choice(std::env::var(k).ok().as_deref());
    let reports = env("UNBROWSE_REPORTS").unwrap_or_else(|| load_saved().on);
    let telemetry = env("UNBROWSE_TELEMETRY").unwrap_or_else(telemetry::saved_on);
    reports && telemetry
}

/// What a report holds, in one line, for `unbrowse-node reports` and the first-run notice.
pub const WHAT: &str = "what the agent says went wrong (scrubbed: no query strings, emails, numbers, tokens, secrets, vault references \
or your names), the route's shape (method, site, plain path words, input names: never input values, cookies, headers or bodies), \
the status or kind of the agent's last error (never what the site said), the node's version and OS; and, made by the node itself, \
a route call or paid fetch of another contributor's route that failed, by its kind of failure, step and status and the route's shape. \
It becomes a public GitHub issue on unbrowse-ai/unbrowse";
pub const HOW_TO_STOP: &str = "turn them off with `unbrowse-node reports off` or UNBROWSE_REPORTS=0 (telemetry off turns them off too)";

/// `unbrowse-node reports [on|off]`.
pub fn cli(args: &[String]) -> i32 {
    let mut saved = load_saved();
    match args.first().map(String::as_str) {
        None => {
            let env = telemetry::env_choice(std::env::var("UNBROWSE_REPORTS").ok().as_deref());
            let tel_env = telemetry::env_choice(std::env::var("UNBROWSE_TELEMETRY").ok().as_deref());
            let tel = telemetry::decide(tel_env, telemetry::saved_on(), cfg!(debug_assertions));
            let on = decide(env, saved.on, tel, cfg!(debug_assertions));
            println!("bug reports: {}{}", if on { "on" } else { "off" }, if !tel { " (telemetry is off)" } else if env.is_some() { " (set by UNBROWSE_REPORTS)" } else { "" });
            println!("a report holds: {WHAT}");
            println!("{}", if on { HOW_TO_STOP } else { "turn them on with `unbrowse-node reports on` (and telemetry on)" });
            0
        }
        Some(c @ ("on" | "off")) => {
            saved.on = c == "on";
            match store::write_json(&saved_path(), &unbrowse_files::REPORTS, &saved) {
                Ok(()) => {
                    println!("{}", if c == "off" { "bug reports off; a running node stops sending them at once" } else { "bug reports on; a running node takes it at its next start" });
                    0
                }
                Err(e) => {
                    eprintln!("saving the choice: {e}");
                    1
                }
            }
        }
        _ => {
            eprintln!("usage: unbrowse-node reports [on | off]");
            2
        }
    }
}

// ---- what was sent, and what waits ----

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct Sent {
    day: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    issue: Option<String>,
}

/// `reports-state.json`: today's counts, and each problem's last day sent and its issue.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct State {
    day: u64,
    agent: u32,
    node: u32,
    #[serde(default)]
    sent: BTreeMap<String, Sent>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Queued {
    at: u64,
    report: Value,
}

/// One lock over the state and the queue: agents report at once, and the sender reads the queue meanwhile.
static FILES: Mutex<()> = Mutex::new(());

fn state_path() -> std::path::PathBuf {
    store::home().join("reports-state.json")
}

fn queue_path() -> std::path::PathBuf {
    store::home().join("reports-queue.json")
}

fn day_of(now: u64) -> u64 {
    now / 86_400
}

fn load_state(now: u64) -> State {
    let mut s: State = store::read_json(&state_path(), &unbrowse_files::REPORTS_STATE);
    if s.day != day_of(now) {
        s.day = day_of(now);
        s.agent = 0;
        s.node = 0;
        // A problem's issue is kept a month, so a report of it after a quiet spell still says where it is.
        s.sent.retain(|_, v| day_of(now).saturating_sub(v.day) <= 30);
    }
    s
}

fn waiting_path() -> std::path::PathBuf {
    store::home().join("reports-waiting.json")
}

/// An agent's report, scrubbed and checked, waiting for the owner.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct Waiting {
    at: u64,
    report: Value,
    #[serde(default)]
    scrubbed: Counts,
}

/// The agents' reports that wait for the owner, fewer than a week old, the newest last.
fn load_waiting(now: u64) -> Vec<Waiting> {
    let mut w: Vec<Waiting> = store::read_json(&waiting_path(), &unbrowse_files::REPORTS_WAITING);
    w.retain(|e| now.saturating_sub(e.at) <= QUEUE_DAYS * 86_400);
    w
}

/// Keeps an agent's report for the owner: one per problem, at most `QUEUE_MAX`, the oldest let go first.
fn hold_for_owner(report: &Value, scrubbed: &Counts, now: u64) {
    let _g = FILES.locked();
    let mut w = load_waiting(now);
    w.retain(|e| fingerprint(&e.report) != fingerprint(report));
    w.push(Waiting { at: now, report: report.clone(), scrubbed: scrubbed.clone() });
    if w.len() > QUEUE_MAX {
        let drop = w.len() - QUEUE_MAX;
        w.drain(..drop);
    }
    let _ = store::write_json(&waiting_path(), &unbrowse_files::REPORTS_WAITING, &w);
}

/// Takes the report `fp` out of what waits, if it is there.
fn take_waiting(fp: &str, now: u64) -> Option<Waiting> {
    let _g = FILES.locked();
    let mut w = load_waiting(now);
    let at = w.iter().position(|e| fingerprint(&e.report) == fp)?;
    let taken = w.remove(at);
    let _ = store::write_json(&waiting_path(), &unbrowse_files::REPORTS_WAITING, &w);
    Some(taken)
}

/// A report as the owner is shown it: what it would be filed with, the install id left out.
fn as_shown(report: &Value) -> Value {
    let mut shown = report.clone();
    if let Some(o) = shown.as_object_mut() {
        o.remove("install_id");
    }
    shown
}

/// The agents' reports waiting for the owner (`reports_waiting`): each with its fingerprint, when it was written and
/// what it would be filed with.
pub fn waiting() -> Vec<Value> {
    load_waiting(store::now())
        .into_iter()
        .map(|e| json!({ "fingerprint": fingerprint(&e.report), "at": e.at, "contents": as_shown(&e.report), "scrubbed": e.scrubbed }))
        .collect()
}

/// The text of the waiting report `fp`, as the owner's dialog shows it before it is sent: every field it would be
/// filed with, on its own line.
pub fn waiting_text(fp: &str) -> Option<String> {
    let w = load_waiting(store::now()).into_iter().find(|e| fingerprint(&e.report) == fp)?;
    let shown = as_shown(&w.report);
    let lines: Vec<String> = shown
        .as_object()?
        .iter()
        .map(|(k, v)| format!("{k}: {}", v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
        .collect();
    Some(lines.join("\n"))
}

/// Sends the waiting report `fp`, as it waits, once the owner said to (`report_send`): from then it goes as any
/// report goes, within the day's limits.
pub async fn send_waiting(fp: &str) -> Result<Value, String> {
    let off = Config::off();
    let cfg = filed_under(GLOBAL.get().map(|g| &g.cfg), &off, crate::link::on_network_now().is_some());
    send_waiting_under(cfg, fp, store::now()).await
}

async fn send_waiting_under(cfg: &Config, fp: &str, now: u64) -> Result<Value, String> {
    let w = take_waiting(fp, now).ok_or("no report waits under that fingerprint: it was sent, dropped, or is over a week old")?;
    Ok(file(cfg, w.report, w.scrubbed, "agent", now).await)
}

/// Drops the waiting report `fp` unsent (`report_discard`).
pub fn discard_waiting(fp: &str) -> Result<(), String> {
    take_waiting(fp, store::now()).map(|_| ()).ok_or_else(|| "no report waits under that fingerprint".to_string())
}

fn enqueue(report: &Value, now: u64) {
    let mut q: Vec<Queued> = store::read_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE);
    q.retain(|e| fingerprint(&e.report) != fingerprint(report));
    q.push(Queued { at: now, report: report.clone() });
    if q.len() > QUEUE_MAX {
        let drop = q.len() - QUEUE_MAX;
        let lost: Vec<String> = q.drain(..drop).map(|e| fingerprint(&e.report)).collect();
        unsent(&lost, now);
    }
    let _ = store::write_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE, &q);
}

/// Takes `lost`, reports that never reached the relay, out of what was sent: the same problem later today goes, and
/// isn't answered "already sent". Called with `FILES` held.
fn unsent(lost: &[String], now: u64) {
    let mut s = load_state(now);
    s.sent.retain(|fp, _| !lost.contains(fp));
    let _ = store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s);
}

// ---- sending ----

#[derive(Clone)]
pub struct Config {
    pub on: bool,
    pub endpoint: String,
    pub timeout: Duration,
    pub version: String,
    pub install_id: String,
}

impl Config {
    pub fn off() -> Self {
        Config { on: false, endpoint: String::new(), timeout: Duration::from_secs(5), version: String::new(), install_id: String::new() }
    }
}

/// How a send went.
#[derive(Debug, PartialEq)]
pub enum Outcome {
    /// The relay took it: the issue it is on, when it has one yet, and whether this report opened it.
    Sent { issue: Option<String>, new: bool, reports: Option<u64> },
    /// The relay is down, unreachable, or at its limit for now: kept to send later.
    Later(String),
    /// The relay refused it; sending it again wouldn't help.
    Refused(String),
}

/// Whether the relay's `status` refuses a report for good: every 4xx but those that mean "not now" (the relay's own
/// limits answer 429). A report that waits is sent again for a week, so one the relay won't ever take must not.
fn refused_for_good(status: u16) -> bool {
    (400..500).contains(&status) && !matches!(status, 408 | 425 | 429)
}

/// The node's report key: Ed25519, made once, kept owner-only in the node's folder. The relay files only what a node
/// signed and limits each key's reports a day. It is its own key, never the wallet's, so a report names no one.
fn report_key(home: &std::path::Path) -> Option<ed25519_dalek::SigningKey> {
    let path = home.join("report.key");
    let read = || std::fs::read(&path).ok().and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok());
    if let Some(seed) = read() {
        return Some(ed25519_dalek::SigningKey::from_bytes(&seed));
    }
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).ok()?;
    let _ = unbrowse_files::private::dir_at(home);
    // Another process may have made it first: whichever file is there is the key.
    let _ = unbrowse_files::private::create_new(&path, &seed);
    read().map(|seed| ed25519_dalek::SigningKey::from_bytes(&seed))
}

/// The headers that sign `body` with `key`, as the relay checks them: the key, and the signature over
/// "unbrowse/report\n" and the body's exact bytes, both in hex.
pub fn signature_headers(key: &ed25519_dalek::SigningKey, body: &[u8]) -> [(&'static str, String); 2] {
    use ed25519_dalek::Signer;
    let mut message = b"unbrowse/report\n".to_vec();
    message.extend_from_slice(body);
    [
        ("x-unbrowse-key", hex::encode(key.verifying_key().to_bytes())),
        ("x-unbrowse-signature", hex::encode(key.sign(&message).to_bytes())),
    ]
}

/// Sends one report to the relay, signed with the node's report key.
pub async fn send(cfg: &Config, report: &Value) -> Outcome {
    let Ok(client) = reqwest::Client::builder().timeout(cfg.timeout).connect_timeout(cfg.timeout).build() else {
        return Outcome::Later("couldn't make an HTTP client".into());
    };
    let Some(key) = report_key(&store::home()) else {
        return Outcome::Later("the node's report key couldn't be made".into());
    };
    let Ok(body) = serde_json::to_vec(report) else {
        return Outcome::Refused("the report isn't JSON".into());
    };
    let mut req = client.post(&cfg.endpoint).header("content-type", "application/json");
    for (name, value) in signature_headers(&key, &body) {
        req = req.header(name, value);
    }
    let res = match req.body(body).send().await {
        Ok(r) => r,
        Err(_) => return Outcome::Later("the relay didn't answer (offline?)".into()),
    };
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let why = body.get("error").and_then(Value::as_str).unwrap_or_default().to_string();
    match status.as_u16() {
        200..=299 => Outcome::Sent {
            issue: body.get("issue").and_then(Value::as_str).map(String::from),
            new: body.get("new").and_then(Value::as_bool).unwrap_or(false),
            reports: body.get("reports").and_then(Value::as_u64),
        },
        s if refused_for_good(s) => Outcome::Refused(if why.is_empty() { format!("the relay answered {status}") } else { why }),
        _ => Outcome::Later(if why.is_empty() { format!("the relay answered {status}") } else { why }),
    }
}

/// Sends what waits in the queue: what goes, and what the relay refuses, leave it; what it can't take yet stays, for a
/// week. Returns how many went.
pub async fn flush(cfg: &Config, now: u64) -> usize {
    if !still_on(cfg) {
        return 0;
    }
    let queued: Vec<Queued> = {
        let _g = FILES.locked();
        store::read_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE)
    };
    let (mut done, mut sent) = (Vec::new(), 0);
    for q in &queued {
        let fp = fingerprint(&q.report);
        if day_of(now).saturating_sub(day_of(q.at)) > QUEUE_DAYS {
            done.push(fp);
            continue;
        }
        match send(cfg, &q.report).await {
            Outcome::Sent { issue, .. } => {
                sent += 1;
                let _g = FILES.locked();
                let mut s = load_state(now);
                s.sent.insert(fp.clone(), Sent { day: day_of(now), issue });
                let _ = store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s);
                done.push(fp);
            }
            Outcome::Refused(_) => {
                let _g = FILES.locked();
                unsent(std::slice::from_ref(&fp), now);
                done.push(fp);
            }
            Outcome::Later(_) => {}
        }
    }
    // Read again: what was queued while this ran stays.
    let _g = FILES.locked();
    let mut q: Vec<Queued> = store::read_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE);
    q.retain(|e| !done.contains(&fingerprint(&e.report)));
    let _ = store::write_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE, &q);
    sent
}

/// What the agent hears back, and the report as it was sent.
pub async fn file(cfg: &Config, report: Value, counts: Counts, source: &'static str, now: u64) -> Value {
    let fp = fingerprint(&report);
    let mut shown = report.clone();
    if let Some(o) = shown.as_object_mut() {
        o.remove("install_id");
    }
    let mut out = json!({
        "fingerprint": fp,
        "scrubbed": counts,
        "contents": shown,
        "public": format!("A report becomes a public issue on github.com/{REPO}: what it holds is above, as it would be filed."),
        "next": "Carry on with your task. Report each distinct problem once; the node and the relay count repeats.",
    });
    if let Err(e) = check(&report) {
        out["report"] = json!("refused");
        out["why"] = json!(e);
        return out;
    }
    if !still_on(cfg) {
        out["report"] = json!("off");
        out["why"] = json!(format!("the owner has bug reports off; nothing was sent. {HOW_TO_STOP}"));
        return out;
    }
    {
        let _g = FILES.locked();
        let mut s = load_state(now);
        if let Some(seen) = s.sent.get(&fp).filter(|v| v.day == day_of(now)) {
            out["report"] = json!("already_sent");
            out["why"] = json!("this problem was reported from this node today; it is counted once a day");
            if let Some(i) = &seen.issue {
                out["issue"] = json!(i);
            }
            return out;
        }
        let (used, limit) = if source == "node" { (&mut s.node, NODE_PER_DAY) } else { (&mut s.agent, AGENT_PER_DAY) };
        if *used >= limit {
            out["report"] = json!("limited");
            out["why"] = json!(format!("this node sends at most {limit} reports a day; nothing was sent"));
            return out;
        }
        *used += 1;
        s.sent.insert(fp.clone(), Sent { day: day_of(now), issue: None });
        let _ = store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s);
    }
    match send(cfg, &report).await {
        Outcome::Sent { issue, new, reports } => {
            let _g = FILES.locked();
            let mut s = load_state(now);
            s.sent.insert(fp, Sent { day: day_of(now), issue: issue.clone() });
            let _ = store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s);
            out["report"] = json!("sent");
            out["new_issue"] = json!(new);
            if let Some(i) = issue {
                out["issue"] = json!(i);
            }
            if let Some(n) = reports {
                out["reports"] = json!(n);
            }
        }
        Outcome::Later(why) => {
            let _g = FILES.locked();
            enqueue(&report, now);
            out["report"] = json!("queued");
            out["why"] = json!(format!("{why}; the node keeps it and sends it later"));
        }
        Outcome::Refused(why) => {
            let _g = FILES.locked();
            let mut s = load_state(now);
            s.sent.remove(&fp);
            let _ = store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s);
            out["report"] = json!("refused");
            out["why"] = json!(why);
        }
    }
    out
}

// ---- the node's own reports ----

/// The node's reports go out in the background: queued, then sent by the sender.
static WAKE: OnceLock<Arc<tokio::sync::Notify>> = OnceLock::new();

/// A problem the node noticed itself, queued to send: at most once per problem a day, and a few a day in all.
pub fn by_node(kind: &str, summary: &str, tool: Option<&'static str>, route: Option<&store::Route>, error: &str) {
    let Some(g) = GLOBAL.get() else { return };
    if !still_on(&g.cfg) {
        return;
    }
    let mut c = Counts::new();
    let asked = Asked { kind: kind.into(), summary: summary.into(), error: error.into(), tool: tool.unwrap_or_default().into(), ..Asked::default() };
    // Read now, not at the start: a login added since is the owner's word as much as one that was there.
    let known = Known::here(&g.name);
    let cx = Context { source: "node", version: &g.cfg.version, install_id: &g.cfg.install_id, known: &known, last: None, now: store::now() };
    let (mut report, _) = build(&asked, &cx);
    if let Some(shape) = route.and_then(|r| shape(r, &known, &mut c)) {
        report["route"] = shape;
    }
    if check(&report).is_err() {
        return;
    }
    let now = store::now();
    let fp = fingerprint(&report);
    // A panic may come while this thread holds the lock: then the report is let go rather than waited for.
    let _g = match FILES.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return,
    };
    let mut s = load_state(now);
    if s.sent.get(&fp).is_some_and(|v| v.day == day_of(now)) || s.node >= NODE_PER_DAY {
        return;
    }
    s.node += 1;
    s.sent.insert(fp, Sent { day: day_of(now), issue: None });
    let _ = store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s);
    enqueue(&report, now);
    if let Some(w) = WAKE.get() {
        w.notify_one();
    }
}

/// Whether a route use that ran and failed becomes a report of the node's own: a route made from another identity's
/// body (`fetched`), which this node can't walk again as its own, so the rule for its own routes (still failing after
/// a walk) never reaches it; and failed as `api::call::use_failed` judges a use, the judgment that demotes the entry
/// (R5.4). Not when its variant is `Transport`: the node's own connection failed, which says nothing of the route.
pub fn reports_failed_use(fetched: bool, variant: Option<&str>) -> bool {
    fetched && variant.is_some_and(|v| telemetry::failure_class(Some(v)) != "transport")
}

#[cfg(test)]
mod failed_use_tests {
    use super::*;

    /// A failed use of a route made from another identity's body is reported by the node; one of its own route, or a
    /// connection of the node's own that failed, isn't (its own route is reported once a walk of its page still fails).
    #[test]
    fn a_failed_network_route_is_reported_and_a_connection_of_the_nodes_own_is_not() {
        assert!(reports_failed_use(true, Some("Failed: step 1 of 2 answered 500")));
        assert!(reports_failed_use(true, Some("NotAnAnswer: the target answered 200, not with an answer")));
        assert!(!reports_failed_use(false, Some("Failed: step 1 of 2 answered 500")), "a route of its own");
        assert!(!reports_failed_use(true, Some("Transport")), "the node's own connection");
        assert!(!reports_failed_use(true, None), "nothing to say of it");
    }
}

/// What a failed route use told each channel, for a test: the route's id, the telemetry event and class, and whether
/// a report was asked for.
#[cfg(test)]
pub static FAILED_USES: Mutex<Vec<(String, &'static str, &'static str, bool)>> = Mutex::new(Vec::new());

/// A route use an agent made that ran and failed (`api::call::use_failed`): counted in telemetry, by its event
/// (`fetch_failed` when `paid`, a fetch of another identity's entry; else `route_failed`) and its failure's class alone,
/// and, for a route made from another identity's body (`reports_failed_use`), reported as the node's own: its variant
/// and status and the route's shape, never what the site said. Each goes only as its own switch allows, and one
/// problem is reported at most once a day (`by_node`). Nothing is said of the entry, its contributor or the payment.
pub fn failed_use(route: &store::Route, paid: bool, ms: u64, variant: Option<&str>) {
    let class = telemetry::failure_class(variant);
    telemetry::failed_use(paid, Some(Duration::from_millis(ms)), class);
    let report = reports_failed_use(route.fetched.is_some(), variant);
    #[cfg(test)]
    FAILED_USES.locked().push((route.id.clone(), telemetry::failed_use_event(paid), class, report));
    if let (true, Some(v)) = (report, variant) {
        by_node("failed", "a route made from another contributor's body ran and failed", None, Some(route), v);
    }
}

/// A primitive the node answered with its own error (500), other than a panic, which the panic hook reports. The
/// report says the status, never the message, which can carry what a site said.
pub fn internal_error(tool: &'static str, route_id: Option<&str>, error: &str) {
    if error.contains("panicked") {
        return;
    }
    let route = route_id.and_then(store::load_route);
    by_node("failed", &format!("the node answered {tool} with an internal error"), Some(tool), route.as_ref(), "the node answered 500");
}

// ---- agents' last calls ----

static LAST: Mutex<Option<HashMap<String, Last>>> = Mutex::new(None);

/// Each route's last failed call, as [`crate::run::failure_variant`] says it, and when: what a report says of the
/// failure in place of the error the agent was told.
static FAILED: Mutex<Option<HashMap<String, (u64, String)>>> = Mutex::new(None);

/// Notes a route's failed call by its variant and status alone.
pub fn note_failure(route_id: &str, variant: &str) {
    let now = store::now();
    let mut failed = FAILED.locked();
    let map = failed.get_or_insert_with(HashMap::new);
    map.retain(|_, (at, _)| now.saturating_sub(*at) <= LAST_CALL_S);
    map.insert(route_id.to_string(), (now, variant.to_string()));
}

fn failure_of(route_id: Option<&str>) -> String {
    let now = store::now();
    let failed = FAILED.locked();
    route_id
        .and_then(|id| failed.as_ref()?.get(id).filter(|(at, _)| now.saturating_sub(*at) <= LAST_CALL_S).map(|(_, v)| v.clone()))
        .unwrap_or_default()
}

/// Notes an agent's call as it ends: which tool, which route, and how it failed if it did: the status the node
/// answered, or the failed call's variant and status. Never the words the agent was told, which can be the site's.
/// A report the agent files soon after is read as about it.
pub fn observe(agent: &str, tool: &'static str, args: &Value, r: &Result<Value, (StatusCode, String)>) {
    let route_id = args
        .get("route_id")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| r.as_ref().ok().and_then(|v| v.pointer("/route/id").or_else(|| v.pointer("/route_failed/route_id"))).and_then(Value::as_str).map(String::from));
    let now = store::now();
    let failed = match r {
        Err((status, _)) => Some((telemetry::error_class(*status), format!("the node answered {}", status.as_u16()))),
        Ok(v) if v.get("ok").or_else(|| v.pointer("/result/ok")).and_then(Value::as_bool) == Some(false) => Some(("site", failure_of(route_id.as_deref()))),
        Ok(_) => None,
    };
    let mut last = LAST.locked();
    let map = last.get_or_insert_with(HashMap::new);
    let failure = failed.map(|(class, error)| Failure { at: now, tool, class, error }).or_else(|| map.get(agent).and_then(|l| l.failure.clone()));
    map.insert(agent.to_string(), Last { at: now, tool, route_id, failure });
}

fn last_of(agent: &str) -> Option<Last> {
    LAST.locked().as_ref().and_then(|m| m.get(agent).cloned())
}

// ---- the primitive ----

/// `unbrowse_report`: an agent's report, scrubbed, enriched and filed.
/// What an agent's report is filed under: the owner's own choice while the node is on the network, and otherwise a choice
/// that sends nothing. A report is a public issue, and off the network nothing leaves the machine (R1.35), so the agent
/// is shown it as it would go, as it is with reports off.
fn filed_under<'a>(global: Option<&'a Config>, off: &'a Config, on_network: bool) -> &'a Config {
    global.filter(|_| on_network).unwrap_or(off)
}

/// An agent's report that would go, kept for the owner to read, scrubbed, and send or not; what the agent hears is that
/// it waits. `None` for one that would not go (refused, or reports off): that is answered as before, and nothing waits.
fn for_the_owner(cfg: &Config, report: &Value, counts: &Counts, now: u64) -> Option<Value> {
    if check(report).is_err() || !still_on(cfg) {
        return None;
    }
    hold_for_owner(report, counts, now);
    Some(json!({
        "fingerprint": fingerprint(report),
        "scrubbed": counts,
        "contents": as_shown(report),
        "report": "waiting_for_owner",
        "why": "an agent's report is sent only once the owner has read it in their window and sent it",
        "public": format!("A report the owner sends becomes a public issue on github.com/{REPO}: what it holds is above, as it would be filed."),
        "next": "Carry on with your task. Report each distinct problem once.",
    }))
}

pub async fn from_agent(node: &Arc<Node>, agent: &str, args: &Value) -> Result<Value, (StatusCode, String)> {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let asked = Asked {
        kind: s("kind"),
        summary: s("summary"),
        expected: s("expected"),
        got: s("got"),
        route_id: s("route_id"),
        goal: s("goal"),
        url: s("url"),
        tool: s("tool"),
        error: s("error"),
    };
    if !KINDS.contains(&asked.kind.as_str()) {
        return Err((StatusCode::BAD_REQUEST, format!("kind is one of {}", KINDS.join(", "))));
    }
    let off = Config::off();
    let on_network = crate::link::on_network_now().is_some();
    let cfg = filed_under(GLOBAL.get().map(|g| &g.cfg), &off, on_network);
    let known = Known::here(&node.info.name);
    let now = store::now();
    // A node with reports off has no install id to hand: the report is shown as it would go, and nothing goes.
    let install_id = if cfg.install_id.is_empty() { "0".repeat(32) } else { cfg.install_id.clone() };
    // The relay takes X.Y.Z; a build that says something else (a test's node) reports as 0.0.0.
    let version = if telemetry::is_version(&node.info.version) { node.info.version.as_str() } else { "0.0.0" };
    let cx = Context { source: "agent", version, install_id: &install_id, known: &known, last: last_of(agent), now };
    let (report, counts) = build(&asked, &cx);
    if let Some(waits) = for_the_owner(cfg, &report, &counts, now) {
        return Ok(waits);
    }
    let mut out = file(cfg, report, counts, "agent", now).await;
    if !on_network && out["report"] == "off" {
        out["why"] = json!("this node is off the network, so nothing leaves it: nothing was sent");
    }
    Ok(out)
}

// ---- starting ----

struct Global {
    cfg: Config,
    /// The name the node goes by, which a report masks (`Known::here`).
    name: String,
}

static GLOBAL: OnceLock<Global> = OnceLock::new();

/// Starts reports from the owner's choice, once telemetry has started: the sender for what waits, and the panic hook
/// that queues a report of a panic. Says on stderr whether they're on.
pub fn start(version: &str, dev: bool, node_name: &str) {
    let env = telemetry::env_choice(std::env::var("UNBROWSE_REPORTS").ok().as_deref());
    let on = decide(env, load_saved().on, telemetry::on(), dev);
    let cfg = Config {
        on,
        endpoint: std::env::var("UNBROWSE_REPORTS_URL").ok().filter(|u| !u.trim().is_empty()).unwrap_or_else(|| ENDPOINT.into()),
        timeout: Duration::from_secs(5),
        version: version.into(),
        install_id: if on { telemetry::install_id() } else { String::new() },
    };
    let _ = GLOBAL.set(Global { cfg: cfg.clone(), name: node_name.into() });
    if !on {
        eprintln!("bug reports: off");
        return;
    }
    eprintln!("bug reports: on: an agent can file a scrubbed report of what went wrong, as a public GitHub issue on {REPO} ({HOW_TO_STOP})");
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        // Where it panicked, never the message: a panic's message can hold whatever the code was handling.
        by_node("failed", &format!("the node panicked at {at}"), None, None, &format!("panicked at {at}"));
        prev(info);
    }));
    let wake = Arc::new(tokio::sync::Notify::new());
    let _ = WAKE.set(wake.clone());
    tokio::spawn(async move {
        // Once the node is up, then on every report the node queues itself, and every quarter hour. Nothing is sent
        // while the node is local: a node off the network sends nothing (R1.35), and what it queued waits.
        tokio::time::sleep(Duration::from_secs(30)).await;
        loop {
            if crate::link::on_network_now().is_some() {
                flush(&cfg, store::now()).await;
            }
            let _ = tokio::time::timeout(Duration::from_secs(900), wake.notified()).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The relay files only what a node signed: the headers verify over exactly the body sent, with the key they name,
    /// and the key is the same one each time, kept for the owner alone.
    #[test]
    fn a_report_is_signed_by_the_nodes_own_report_key() {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let dir = std::env::temp_dir().join(format!("report-key-{}-{}", std::process::id(), store::now()));
        let key = report_key(&dir).unwrap();
        assert_eq!(report_key(&dir).unwrap().to_bytes(), key.to_bytes(), "made once, then kept");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dir.join("report.key")).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
        let body = br#"{"kind":"failed","summary":"x"}"#;
        let [(kname, k), (sname, sig)] = signature_headers(&key, body);
        assert_eq!((kname, sname), ("x-unbrowse-key", "x-unbrowse-signature"));
        let k = VerifyingKey::from_bytes(&hex::decode(k).unwrap().try_into().unwrap()).unwrap();
        let sig = Signature::from_slice(&hex::decode(sig).unwrap()).unwrap();
        let mut signed = b"unbrowse/report\n".to_vec();
        signed.extend_from_slice(body);
        assert!(k.verify(&signed, &sig).is_ok());
        let mut changed = b"unbrowse/report\n".to_vec();
        changed.extend_from_slice(br#"{"kind":"failed","summary":"y"}"#);
        assert!(k.verify(&changed, &sig).is_err(), "a changed body fails");
    }

    /// An agent's report is a public issue, so a node off the network files none, whatever its owner chose for reports.
    #[test]
    fn a_node_off_the_network_files_no_agents_report() {
        let (on, off) = (Config { on: true, ..Config::off() }, Config::off());
        assert!(std::ptr::eq(filed_under(Some(&on), &off, true), &on), "on the network, the owner's choice");
        assert!(std::ptr::eq(filed_under(Some(&on), &off, false), &off), "off it, nothing goes");
        assert!(std::ptr::eq(filed_under(None, &off, true), &off), "reports never started");
    }
    /// B8 (UNB-158): reports are filed on unbrowse-ai/unbrowse, the public repository core becomes at the cutover, and
    /// every place that names it says the same: the node, the relay that files them, and what agents are told.
    #[test]
    fn reports_go_to_the_repository_core_becomes() {
        assert_eq!(REPO, "unbrowse-ai/unbrowse");
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for (file, says) in [
            ("unbrowse-telemetry/wrangler.jsonc", r#""REPORTS_REPO": "unbrowse-ai/unbrowse""#),
            ("unbrowse-telemetry/wrangler.staging.jsonc", r#""REPORTS_REPO": "unbrowse-ai/unbrowse""#),
            ("unbrowse-telemetry/src/index.js", r#"const REPO = "unbrowse-ai/unbrowse";"#),
            ("unbrowse-sdk/typescript/src/adapters/tools.ts", "a public GitHub issue on unbrowse-ai/unbrowse;"),
        ] {
            let text = std::fs::read_to_string(root.join(file)).unwrap();
            assert!(text.contains(says), "{file} names the repository reports go to as {REPO}");
        }
    }

    use std::io::{Read, Write};
    use std::net::TcpListener;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn shared() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../unbrowse-telemetry/schema.json");
        serde_json::from_str::<Value>(&std::fs::read_to_string(path).unwrap()).unwrap()["reports"].clone()
    }

    #[test]
    fn the_scrub_and_fingerprint_are_the_relays() {
        let s = shared();
        for e in s["scrub_examples"].as_array().unwrap() {
            let mut c = Counts::new();
            let got = scrub(e["in"].as_str().unwrap(), &mut c);
            assert_eq!(got, e["out"].as_str().unwrap());
            for hidden in e["private"].as_array().into_iter().flatten() {
                assert!(!got.contains(hidden.as_str().unwrap()), "{hidden} left in {got}");
            }
            // Scrubbing twice is scrubbing once: the relay's second pass changes nothing the node scrubbed.
            assert_eq!(scrub(e["out"].as_str().unwrap(), &mut Counts::new()), e["out"].as_str().unwrap());
        }
        for e in s["fingerprint_examples"].as_array().unwrap() {
            assert_eq!(fingerprint(&e["report"]), e["fingerprint"].as_str().unwrap(), "{}", e["report"]);
        }
    }

    #[test]
    fn the_lists_are_the_relays_lists() {
        let s = shared();
        let list = |k: &str| s[k].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let ours = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(list("fields"), ours(FIELDS));
        assert_eq!(list("required"), ours(REQUIRED));
        assert_eq!(list("kinds"), ours(KINDS));
        assert_eq!(list("sources"), ours(SOURCES));
        assert_eq!(list("tools"), ours(TOOLS));
        assert_eq!(list("methods"), ours(METHODS));
        assert_eq!(list("route_fields"), ours(ROUTE_FIELDS));
        assert_eq!(list("last_error_fields"), ours(LAST_ERROR_FIELDS));
        for (k, n) in MAX_CHARS {
            assert_eq!(s["max_chars"][k].as_u64(), Some(*n as u64), "{k}");
        }
        assert_eq!(s["max_chars"].as_object().unwrap().len(), MAX_CHARS.len());
        assert_eq!((s["max_inputs"].as_u64(), s["max_steps"].as_u64()), (Some(MAX_INPUTS as u64), Some(MAX_STEPS as u64)));
        assert_eq!(s["per_install_per_day"].as_u64(), Some(AGENT_PER_DAY as u64));
    }

    /// A route learned with live values in it: an input whose default is a search, a secret input, a query.
    fn route() -> store::Route {
        let mut r: store::Route = serde_json::from_value(json!({
            "id": "r1", "site": "api.github.com", "what": "repo stars", "method": "get",
            "path": "https://api.github.com/repos/firecrawl/firecrawl/issues/123456?per_page={limit}&q={q}&token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "root": "https://github.com/firecrawl/firecrawl", "inputs": [], "steps": 1, "browser_assisted": false, "walk_without_fragment": true, "read_by": crate::store::ReadBy::current(), "write": false,
            "provisional": false, "learned_at": 1, "graph": { "steps": [], "provisional": false }
        }))
        .unwrap();
        r.inputs = vec![
            store::RouteInput { name: "q".into(), secret: false, default: Some("alice@example.com".into()), file: false, optional: false, options: Vec::new() },
            store::RouteInput { name: "password".into(), secret: true, default: Some("vault:github.com:alice".into()), file: false, optional: false, options: Vec::new() },
        ];
        r
    }

    #[test]
    fn a_route_is_sent_as_its_shape_never_its_values() {
        let mut c = Counts::new();
        let shape = shape(&route(), &Known::none(), &mut c).unwrap();
        assert_eq!(shape, json!({ "method": "GET", "host": "*.github.com", "path": "/repos/firecrawl/firecrawl/issues/{number}", "inputs": ["q", "password"], "write": false, "steps": 0 }));
        let text = shape.to_string();
        for leak in ["alice", "ghp_", "per_page", "vault:"] {
            assert!(!text.contains(leak), "{leak} in {text}");
        }
        assert_eq!((c.get("query"), c.get("path"), c.get("subdomain")), (Some(&1), Some(&1), Some(&1)));
    }

    /// A bug report says a route's shape, and nothing of the body it was learned as.
    #[test]
    fn a_bug_report_carries_no_body() {
        let mut c = Counts::new();
        let with = shape(&store::with_a_body_saying(route(), "only-the-body-says-this"), &Known::none(), &mut c).unwrap();
        assert!(!with.to_string().contains("only-the-body-says-this"), "{with}");
        assert_eq!(with, shape(&route(), &Known::none(), &mut Counts::new()).unwrap());
    }

    fn route_at(path: &str) -> store::Route {
        let mut r = route();
        r.path = path.into();
        r.inputs.clear();
        r
    }

    #[test]
    fn a_route_or_page_names_no_tenant_machine_address_or_handle() {
        let known = Known::of(&[("alicesmith", "[user]")]);
        let host_path = |p: &str| {
            let s = shape(&route_at(p), &known, &mut Counts::new()).unwrap();
            format!("{}{}", s["host"].as_str().unwrap(), s["path"].as_str().unwrap())
        };
        assert_eq!(host_path("https://acme-corp.atlassian.net/in/john-smith-1a2b3c/{id}"), "*.atlassian.net/in/{id}/{id}", "a tenant under a company's suffix");
        assert_eq!(host_path("https://alicesmith.github.io/blog"), "*.github.io/blog");
        assert_eq!(host_path("https://shop.acme-corp.co.uk/basket"), "*.acme-corp.co.uk/basket");
        assert_eq!(host_path("http://intranet.corp:8080/admin"), "[internal]/admin", "a name the public DNS doesn't answer");
        assert_eq!(host_path("http://localhost:3000/a"), "[internal]/a");
        assert_eq!(host_path("http://[2001:db8::1]:8080/a"), "[ip]/a");
        assert_eq!(host_path("http://192.168.1.20/a"), "[ip]/a");
        assert_eq!(host_path("https://github.com/alicesmith/settings"), "github.com/[user]/settings", "the owner's own name");
        assert_eq!(host_path("https://AliceSmith.com/a"), "[personal]/a");
        assert_eq!(host_path("https://github.com/repos/firecrawl/firecrawl"), "github.com/repos/firecrawl/firecrawl");
        assert_eq!(host_path("https://api.example.com/api/v2/users/u8f3/Report.pdf"), "*.example.com/api/v2/users/{id}/{id}");
        let mut c = Counts::new();
        assert_eq!(page("https://www.linkedin.com/in/john-smith-1a2b3c?trk=x", &known, &mut c).as_deref(), Some("https://*.linkedin.com/in/{id}"));
        assert_eq!(page("https://me:pw@intranet.corp:8080/x", &known, &mut c).as_deref(), Some("https://[internal]/x"));
        // What the node sends is what the relay keeps: its text rule changes none of it.
        for h in ["*.atlassian.net", "*.github.io", "*.acme-corp.co.uk", "[internal]", "[ip]", "[personal]", "github.com"] {
            assert_eq!(mask_host(h, &mut Counts::new(), true), h);
        }
    }

    fn cx<'a>(known: &'a Known, last: Option<Last>) -> Context<'a> {
        Context { source: "agent", version: "1.4.2", install_id: ID, known, last, now: 1_000_000 }
    }

    /// B7: a report built on a machine holding `unbrowse connect`'s backup (`<home>/migration/`, which keeps the old
    /// hosted entries' keys) carries none of it: a report is made of what the agent said and a route's shape, never a
    /// file, and a key an agent pastes into it is scrubbed. Neither the report's nor telemetry's fields can carry a
    /// path or a file.
    #[test]
    fn a_report_built_beside_a_connect_backup_holds_no_ub_live_key() {
        let home = store::scratch_home("report-migration");
        let key = "ub_live_0123456789abcdef0123456789abcdefa1f3";
        let backup = home.join("migration").join("2026-11-16T09-12-03Z");
        std::fs::create_dir_all(&backup).unwrap();
        let entries = json!({ "replaced": [{ "name": "unbrowse", "raw": { "type": "http", "url": "https://unbrowse.ai/mcp", "headers": { "Authorization": format!("Bearer {key}") } } }] });
        std::fs::write(backup.join("entries.json"), entries.to_string()).unwrap();
        store::save_route(&route()).unwrap();
        let known = Known::of(&[]);
        let asked = Asked {
            kind: "failed".into(),
            summary: format!("connect stopped; its backup is {}", backup.join("entries.json").display()),
            expected: "the old entry put back".into(),
            got: format!("Authorization: Bearer {key}"),
            error: format!("401 for {key}"),
            route_id: "r1".into(),
            tool: "do".into(),
            ..Asked::default()
        };
        let (r, _) = build(&asked, &cx(&known, None));
        assert_eq!(check(&r), Ok(()));
        let sent = r.to_string();
        assert!(!sent.contains("ub_live") && !sent.contains("0123456789abcdefa1f3"), "{sent}");
        for field in FIELDS.iter().chain(crate::telemetry::FIELDS) {
            assert!(!["file", "path", "attachment", "log", "migration"].iter().any(|w| field.contains(w)), "{field}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_agents_report_is_scrubbed_before_it_leaves() {
        let home = store::scratch_home("report-scrub");
        store::save_route(&route()).unwrap();
        let known = Known::of(&[("/Users/alicesmith", "~"), ("alicesmith", "[user]"), ("host-a", "[node]"), ("alice_gh", "[account]")]);
        let asked = Asked {
            kind: "wrong_data".into(),
            summary: "unbrowse_do for superdesigndev/treg\nreturned firecrawl/firecrawl".into(),
            expected: "treg's stars for alicesmith".into(),
            got: "firecrawl's, from https://api.github.com/repos/firecrawl/firecrawl?access_token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 on host-a, file /Users/alicesmith/out.json, login alice_gh, mail alice@example.com".into(),
            url: "https://github.com/superdesigndev/treg?tab=readme&utm=x#top".into(),
            route_id: "r1".into(),
            tool: "do".into(),
            goal: "x".repeat(300),
            ..Asked::default()
        };
        let (r, c) = build(&asked, &cx(&known, None));
        assert_eq!(check(&r), Ok(()));
        assert_eq!(r["summary"], "unbrowse_do for superdesigndev/treg returned firecrawl/firecrawl", "one line");
        assert_eq!(r["url"], "https://github.com/superdesigndev/treg");
        assert_eq!(r["tool"], "unbrowse_do");
        assert_eq!(r["route"]["path"], "/repos/firecrawl/firecrawl/issues/{number}");
        assert_eq!(r["got"], "firecrawl's, from https://*.github.com/repos/firecrawl/firecrawl on [node], file ~/out.json, login [account], mail [email]");
        assert_eq!(r["expected"], "treg's stars for [user]");
        assert_eq!(r["goal"].as_str().unwrap().chars().count(), 200, "capped");
        let all = r.to_string();
        for leak in ["alicesmith", "host-a", "alice_gh", "alice@", "ghp_", "access_token", "utm", "#top"] {
            assert!(!all.contains(leak), "{leak} in {all}");
        }
        assert!(c["query"] >= 2 && c["personal"] >= 4 && c["email"] == 1, "{c:?}");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_report_names_the_agents_last_call_when_it_names_none() {
        let home = store::scratch_home("report-last");
        store::save_route(&route()).unwrap();
        let known = Known::none();
        let failure = Failure { at: 1_000_000 - 30, tool: "unbrowse_call", class: "site", error: "the site answered 403: blocked for 203.0.113.9".into() };
        let last = Last { at: 1_000_000 - 30, tool: "unbrowse_call", route_id: Some("r1".into()), failure: Some(failure.clone()) };
        let asked = Asked { kind: "failed".into(), summary: "blocked".into(), ..Asked::default() };
        let (r, _) = build(&asked, &cx(&known, Some(last.clone())));
        assert_eq!((r["tool"].clone(), r["route"]["host"].clone()), (json!("unbrowse_call"), json!("*.github.com")));
        assert_eq!(r["last_error"], json!({ "tool": "unbrowse_call", "class": "site", "error": "the site answered 403: blocked for [ip]" }));
        let mut shown = r.clone();
        shown.as_object_mut().unwrap().remove("install_id");
        crate::apischema::check(&crate::apischema::r("ReportContents"), &shown, &crate::apischema::types()).unwrap_or_else(|e| panic!("{shown}: {e}"));
        // An hour later, the last call is someone else's story.
        let stale = Last { at: 1_000_000 - 3600, failure: Some(Failure { at: 1_000_000 - 3600, ..failure }), ..last };
        let (r, _) = build(&asked, &cx(&known, Some(stale)));
        assert!(r.get("route").is_none() && r.get("last_error").is_none() && r.get("tool").is_none(), "{r}");
        let _ = std::fs::remove_dir_all(home);
    }

    /// What the node notes of an agent's failed call, for its next report, is the node's own description: the status
    /// it answered, or the call's variant and status. Never the error the agent was told, which says the site's words.
    #[test]
    fn a_last_error_carries_the_status_and_variant_never_the_sites_words() {
        let site = "the site answered 403: Dear John Smith, your balance is 4,210";
        note_failure("r-last", "Failed: step 1 of 1 answered 403");
        observe("agent-a", "unbrowse_call", &json!({ "route_id": "r-last" }), &Ok(json!({ "ok": false, "error": site })));
        let f = last_of("agent-a").unwrap().failure.unwrap();
        assert_eq!((f.class, f.error.as_str()), ("site", "Failed: step 1 of 1 answered 403"));
        observe("agent-b", "unbrowse_do", &json!({}), &Err((StatusCode::BAD_GATEWAY, format!("upstream: {site}"))));
        let f = last_of("agent-b").unwrap().failure.unwrap();
        assert_eq!((f.class, f.error.as_str()), ("internal", "the node answered 502"));
        // A failure the node noted nothing of says its class alone.
        observe("agent-c", "unbrowse_call", &json!({ "route_id": "r-unknown" }), &Ok(json!({ "ok": false, "error": site })));
        assert_eq!(last_of("agent-c").unwrap().failure.unwrap().error, "");
        let last = last_of("agent-a").unwrap();
        let (r, _) = build(&Asked { kind: "failed".into(), summary: "blocked".into(), ..Asked::default() }, &Context { now: last.at, ..cx(&Known::none(), Some(last)) });
        assert_eq!(r["last_error"], json!({ "tool": "unbrowse_call", "class": "site", "error": "Failed: step 1 of 1 answered 403" }));
        assert!(!r.to_string().contains("John"));
    }

    #[test]
    fn reports_off_stops_a_running_node_at_once() {
        let home = store::scratch_home("report-off-live");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (url, got) = relay(201, json!({ "issue": "https://github.com/unbrowse-ai/unbrowse/issues/9", "new": true }));
        let on = cfg(&url);
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: false }).unwrap();
        let (r, c) = wrong_data();
        let reply = rt.block_on(file(&on, r.clone(), c.clone(), "agent", 1_000_000));
        assert_eq!(reply["report"], "off", "{reply}");
        enqueue(&r, 1_000_000);
        assert_eq!(rt.block_on(flush(&on, 1_000_060)), 0, "nothing queued goes either");
        assert!(got.locked().is_empty());
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        assert_eq!(rt.block_on(file(&on, r, c, "agent", 1_000_100))["report"], "sent");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn reports_follow_telemetry_and_the_owners_choice() {
        assert!(!decide(Some(true), true, false, false), "telemetry off turns reports off");
        assert!(!decide(Some(false), true, true, false), "the environment's off wins over the file");
        assert!(!decide(None, false, true, false), "the file's off");
        assert!(!decide(None, true, true, true), "a dev build sends only when asked");
        assert!(decide(Some(true), false, true, true), "the environment's on, in a dev build with telemetry on");
        assert!(decide(None, true, true, false), "on in a release with telemetry on, once the owner turned them on");
    }

    /// A report becomes a public issue, so a node sends none until its owner turns them on: with no saved choice the
    /// choice is off, and a release with telemetry on still sends nothing.
    #[test]
    fn reports_are_off_until_the_owner_turns_them_on() {
        let home = store::scratch_home("reports-default");
        store::use_home(&home);
        assert!(!load_saved().on, "no choice saved: off");
        assert!(!decide(None, load_saved().on, true, false), "a release with telemetry on sends nothing by default");
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        assert!(load_saved().on, "the owner turned them on");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A relay standing in for the worker: answers each report with `status` and `body`, and keeps what it was sent.
    fn relay(status: u16, body: Value) -> (String, Arc<Mutex<Vec<Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/reports", listener.local_addr().unwrap());
        let got = Arc::new(Mutex::new(Vec::new()));
        let kept = got.clone();
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                while let Ok(n) = stream.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    let Some(end) = text.find("\r\n\r\n") else { continue };
                    let len: usize = text[..end].lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0))).unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        if let Ok(v) = serde_json::from_slice(&buf[end + 4..end + 4 + len]) {
                            kept.locked().push(v);
                        }
                        let b = body.to_string();
                        let _ = stream.write_all(format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{b}", b.len()).as_bytes());
                        break;
                    }
                }
            }
        });
        (url, got)
    }

    fn cfg(endpoint: &str) -> Config {
        Config { on: true, endpoint: endpoint.into(), timeout: Duration::from_millis(800), version: "1.4.2".into(), install_id: ID.into() }
    }

    /// A reply as `agent-api.json` describes it (`ReportResult`), so the SDKs' types hold for it.
    fn typed(reply: &Value) {
        crate::apischema::check(&crate::apischema::r("ReportResult"), reply, &crate::apischema::types()).unwrap_or_else(|e| panic!("{reply}: {e}"));
    }

    fn wrong_data() -> (Value, Counts) {
        let asked = Asked { kind: "wrong_data".into(), summary: "returned another repo".into(), expected: "treg".into(), got: "firecrawl from https://x.com/a?q=secret".into(), ..Asked::default() };
        build(&asked, &cx(&Known::none(), None))
    }

    /// An agent's report leaves only as the owner saw it: it waits, scrubbed, and the relay hears nothing until the
    /// owner sends it; then exactly what waited is sent. One the owner drops is never sent.
    #[test]
    fn an_agent_report_waits_for_the_owner_before_it_is_sent() {
        let _home = store::scratch_home("report-waits");
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (url, got) = relay(201, json!({ "issue": "https://github.com/unbrowse-ai/unbrowse/issues/8", "number": 8, "new": true, "reports": 1 }));
        let (report, counts) = wrong_data();
        let now = store::now();
        let reply = for_the_owner(&cfg(&url), &report, &counts, now).expect("a report that would go waits");
        typed(&reply);
        assert_eq!(reply["report"], "waiting_for_owner");
        std::thread::sleep(Duration::from_millis(200));
        assert!(got.locked().is_empty(), "nothing reached the relay");
        let fp = reply["fingerprint"].as_str().unwrap().to_string();
        let shown = waiting_text(&fp).expect("the owner's dialog shows it");
        assert!(shown.contains("returned another repo") && !shown.contains("secret") && !shown.contains(ID), "{shown}");
        let question = crate::commands::asks_the_owner("report_send", &json!({ "fingerprint": fp })).expect("sending is asked");
        assert!(question.contains("returned another repo") && question.contains("public issue"), "{question}");
        let sent = rt.block_on(send_waiting_under(&cfg(&url), &fp, now)).unwrap();
        assert_eq!(sent["report"], "sent", "{sent}");
        assert_eq!(got.locked().as_slice(), std::slice::from_ref(&report), "exactly what waited");
        assert!(waiting_text(&fp).is_none(), "and it no longer waits");
        // One the owner drops never goes.
        let other = build(&Asked { kind: "slow".into(), summary: "took a minute".into(), ..Asked::default() }, &cx(&Known::none(), None)).0;
        let reply = for_the_owner(&cfg(&url), &other, &Counts::new(), now).unwrap();
        discard_waiting(reply["fingerprint"].as_str().unwrap()).unwrap();
        assert!(rt.block_on(send_waiting_under(&cfg(&url), reply["fingerprint"].as_str().unwrap(), now)).is_err());
        assert_eq!(got.locked().len(), 1);
    }

    #[test]
    fn a_report_is_sent_once_a_day_and_the_reply_names_its_issue() {
        let home = store::scratch_home("report-send");
        // Reports are off until the owner turns them on: this owner has.
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (url, got) = relay(201, json!({ "issue": "https://github.com/unbrowse-ai/unbrowse/issues/7", "number": 7, "new": true, "reports": 1 }));
        let (r, c) = wrong_data();
        let reply = rt.block_on(file(&cfg(&url), r.clone(), c.clone(), "agent", 1_000_000));
        assert_eq!((reply["report"].clone(), reply["issue"].clone(), reply["new_issue"].clone()), (json!("sent"), json!("https://github.com/unbrowse-ai/unbrowse/issues/7"), json!(true)), "{reply}");
        assert_eq!(reply["scrubbed"]["query"], 1);
        assert!(reply["contents"].get("install_id").is_none(), "the agent is shown what goes public");
        typed(&reply);
        assert_eq!(got.locked()[0], r, "the relay is sent the report as built, install id and all");
        // The same problem again today: not sent, and the issue is named.
        let again = rt.block_on(file(&cfg(&url), r.clone(), c.clone(), "agent", 1_000_100));
        assert_eq!((again["report"].clone(), again["issue"].clone()), (json!("already_sent"), json!("https://github.com/unbrowse-ai/unbrowse/issues/7")));
        assert_eq!(got.locked().len(), 1);
        typed(&again);
        // Tomorrow it counts again.
        let tomorrow = rt.block_on(file(&cfg(&url), r, c, "agent", 1_000_000 + 86_400));
        assert_eq!(tomorrow["report"], "sent");
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_report_waits_while_the_relay_is_away_and_goes_when_it_is_back() {
        let home = store::scratch_home("report-queue");
        // Reports are off until the owner turns them on: this owner has.
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let closed = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/v1/reports", l.local_addr().unwrap())
        };
        let (r, c) = wrong_data();
        let reply = rt.block_on(file(&cfg(&closed), r.clone(), c, "agent", 1_000_000));
        assert_eq!(reply["report"], "queued", "{reply}");
        assert!(reply["why"].as_str().unwrap().contains("sends it later"));
        assert_eq!(reply["scrubbed"]["query"], 1, "the reply shows what was scrubbed");
        typed(&reply);
        let queued: Vec<Queued> = store::read_json(&queue_path(), &unbrowse_files::REPORTS_QUEUE);
        assert_eq!(queued.len(), 1);
        // A relay that is down (503) keeps it queued; one that's back takes it and empties the queue.
        let (down, _) = relay(503, json!({ "error": "reports aren't taken yet" }));
        assert_eq!(rt.block_on(flush(&cfg(&down), 1_000_060)), 0);
        assert_eq!(store::read_json::<Vec<Queued>>(&queue_path(), &unbrowse_files::REPORTS_QUEUE).len(), 1);
        let (up, got) = relay(201, json!({ "issue": "https://github.com/unbrowse-ai/unbrowse/issues/8", "new": true }));
        assert_eq!(rt.block_on(flush(&cfg(&up), 1_000_120)), 1);
        assert_eq!(got.locked()[0], r);
        assert!(store::read_json::<Vec<Queued>>(&queue_path(), &unbrowse_files::REPORTS_QUEUE).is_empty());
        // Off sends nothing, queued or not.
        let mut off = cfg(&up);
        off.on = false;
        let (r2, c2) = build(&Asked { kind: "slow".into(), summary: "took a minute".into(), ..Asked::default() }, &cx(&Known::none(), None));
        let reply = rt.block_on(file(&off, r2, c2, "agent", 1_000_200));
        assert_eq!(reply["report"], "off");
        typed(&reply);
        assert_eq!(got.locked().len(), 1);
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_report_the_relay_refuses_is_dropped_not_queued() {
        let home = store::scratch_home("report-refused");
        // Reports are off until the owner turns them on: this owner has.
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (url, _) = relay(400, json!({ "error": "tool is not an allowed value" }));
        let (r, c) = wrong_data();
        let reply = rt.block_on(file(&cfg(&url), r, c, "agent", 1_000_000));
        assert_eq!((reply["report"].clone(), reply["why"].clone()), (json!("refused"), json!("tool is not an allowed value")));
        typed(&reply);
        assert!(store::read_json::<Vec<Queued>>(&queue_path(), &unbrowse_files::REPORTS_QUEUE).is_empty());
        let _ = std::fs::remove_dir_all(home);
    }

    /// A relay that answers it has no such place, or won't take this, will say the same for a week: the report goes, as
    /// a 400 does, and only what means "not now" waits.
    #[test]
    fn only_an_answer_that_means_not_now_keeps_a_report_waiting() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (r, _) = wrong_data();
        for status in [401, 403, 404, 405, 410, 422] {
            let (url, _) = relay(status, json!({}));
            assert!(matches!(rt.block_on(send(&cfg(&url), &r)), Outcome::Refused(_)), "{status}");
        }
        for status in [408, 425, 429, 500, 503] {
            let (url, _) = relay(status, json!({}));
            assert!(matches!(rt.block_on(send(&cfg(&url), &r)), Outcome::Later(_)), "{status}");
        }
    }

    /// A problem the relay refused was never reported, so nothing may say it was: the same problem later today is sent,
    /// not answered "already sent".
    #[test]
    fn a_queued_report_the_relay_refuses_isnt_left_as_sent() {
        let home = store::scratch_home("report-refused-queued");
        store::write_json(&saved_path(), &unbrowse_files::REPORTS, &Saved { on: true }).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (r, c) = wrong_data();
        let fp = fingerprint(&r);
        let mut s = load_state(1_000_000);
        s.sent.insert(fp.clone(), Sent { day: day_of(1_000_000), issue: None });
        store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s).unwrap();
        enqueue(&r, 1_000_000);
        let (no, _) = relay(400, json!({ "error": "tool is not an allowed value" }));
        rt.block_on(flush(&cfg(&no), 1_000_060));
        assert!(!load_state(1_000_060).sent.contains_key(&fp));
        let (yes, _) = relay(201, json!({ "issue": "https://github.com/unbrowse-ai/unbrowse/issues/8", "new": true }));
        assert_eq!(rt.block_on(file(&cfg(&yes), r, c, "agent", 1_000_120))["report"], "sent");
        let _ = std::fs::remove_dir_all(home);
    }

    /// A report the queue had no room for was never sent either.
    #[test]
    fn a_report_pushed_out_of_the_queue_isnt_left_as_sent() {
        let home = store::scratch_home("report-overflow");
        let report = |n: usize| json!({ "kind": "failed", "tool": format!("tool-{n}") });
        let mut s = load_state(1_000_000);
        for n in 0..=QUEUE_MAX {
            s.sent.insert(fingerprint(&report(n)), Sent { day: day_of(1_000_000), issue: None });
        }
        store::write_json(&state_path(), &unbrowse_files::REPORTS_STATE, &s).unwrap();
        for n in 0..=QUEUE_MAX {
            enqueue(&report(n), 1_000_000);
        }
        let s = load_state(1_000_000);
        assert!(!s.sent.contains_key(&fingerprint(&report(0))), "the first went unsent");
        assert!(s.sent.contains_key(&fingerprint(&report(QUEUE_MAX))));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn a_report_with_a_field_off_the_list_never_leaves() {
        let (mut r, c) = wrong_data();
        r["cookie"] = json!("a=b");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let reply = rt.block_on(file(&cfg("http://127.0.0.1:9/v1/reports"), r, c, "agent", 1_000_000));
        assert_eq!((reply["report"].clone(), reply["why"].clone()), (json!("refused"), json!("field not allowed: cookie")));
    }
}
