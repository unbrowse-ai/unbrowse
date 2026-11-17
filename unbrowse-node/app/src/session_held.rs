//! What the node holds as a site's session is never said to an agent (SECURITY.md, "The site's session never reaches
//! an agent"). An agent key lets an agent act on a site the owner is signed in to; it never lets it carry the session
//! away. Every answer an agent gets, over HTTP or MCP, crosses [`Held::value`] in `api::run_primitive`, so a page the
//! agent reads, a script it runs, a walk's list of calls, a route's answer and an error all say `{session}` where a
//! value the node holds as a session stood.
//!
//! What counts, read when the answer is made:
//! - every value in every jar the node keeps (`jars/`): the cookies, the header tokens, the storage values the
//!   learner marked as the session's (`graph::session_headers`, `graph::session_storage`), the cookies an import left in
//!   the jar alone, and every value of the page storage kept beside a jar (`.json.storage`), marked or not;
//! - every cookie the cookie store of each running site browser holds, HttpOnly or not, for any domain
//!   (`browse::session_cookies`): a superset of the site's own registrable domain;
//! - a cookie, or a value in HTTP's own credential fields, a route carries as a fixed value;
//! - what each walk's capture held as its session ([`note_trace`]), read by the learner's own rule
//!   (`provenance::session_values`): its cookies, every value an answer of the walk delivered that a later request sent
//!   back in any position (a login answer's token sent on in a header, an address or a body), its credential fields,
//!   and a token-shaped value in any other header; kept in memory, since a walk's browser may have closed before its
//!   answer goes out.
//!
//! A value is masked whole however it is written (`trace::written_forms`, the one list of it: as itself, percent- or
//! form-encoded, as JSON or markup escapes it, as base64). A flag or a value shorter than [`SHORTEST`] carries nothing that signs anyone in
//! and would turn up everywhere, so it is left alone; one shorter than [`ANYWHERE`] is matched only as a whole word, so
//! a short cookie (`theme=dark`) doesn't take a word out of every page.

use std::sync::Mutex;

use aho_corasick::{AhoCorasick, MatchKind};
use serde_json::Value;

use crate::sync::Locked;

/// A session value shorter than this is left alone: too common a string to hide everywhere a page says it, and too
/// short to sign anyone in. The same floor the vault's passwords have (`browse::KNOWN_SHORTEST`).
pub(crate) const SHORTEST: usize = 4;
/// A session value at least this long is masked wherever it stands, inside a longer word too; a shorter one only where
/// it stands whole.
pub(crate) const ANYWHERE: usize = unbrowse_learn::trace::WRITTEN_ANYWHERE;
/// What an agent reads where a session value stood.
pub(crate) const SAID: &str = "{session}";

/// The most values [`note_trace`] keeps; the oldest go first.
const NOTED_MOST: usize = 4096;
/// Session values the walks' captures held, the newest last.
static NOTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The session values the node holds now, ready to mask an answer with.
pub(crate) struct Held {
    anywhere: Option<AhoCorasick>,
    whole: Option<AhoCorasick>,
}

impl Held {
    /// The values, each in every form a page may say it, short ones and flags left out. An error when the finder can't
    /// be built: a mask that isn't there can't be used as one, so the answer isn't given.
    pub(crate) fn of(values: impl IntoIterator<Item = String>) -> Result<Held, String> {
        let (mut anywhere, mut whole): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
        for v in values {
            if unbrowse_learn::slots::bound_by_key(&v) || v.chars().count() < SHORTEST {
                continue;
            }
            let long = v.chars().count() >= ANYWHERE;
            for (f, within) in unbrowse_learn::trace::Written::of(&v).forms() {
                let to = if long || *within { &mut anywhere } else { &mut whole };
                if f.chars().count() >= SHORTEST {
                    to.push(f.clone());
                }
            }
        }
        for list in [&mut anywhere, &mut whole] {
            list.sort_unstable();
            list.dedup();
        }
        let build = |p: &[String], kind: MatchKind| -> Result<Option<AhoCorasick>, String> {
            if p.is_empty() {
                return Ok(None);
            }
            AhoCorasick::builder()
                .match_kind(kind)
                .build(p)
                .map(Some)
                .map_err(|e| format!("the node couldn't build the mask for the sessions it holds ({e}), so it can't keep them out of this answer"))
        };
        Ok(Held { anywhere: build(&anywhere, MatchKind::LeftmostLongest)?, whole: build(&whole, MatchKind::Standard)? })
    }

    /// `text` with every session value said as [`SAID`].
    pub(crate) fn text(&self, text: &str) -> String {
        let mut out = match &self.anywhere {
            Some(ac) => ac.replace_all(text, &vec![SAID; ac.patterns_len()]),
            None => text.to_string(),
        };
        if let Some(ac) = &self.whole {
            let t = out.clone();
            let alnum_at = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
            let mut hits: Vec<(usize, usize)> = ac
                .find_overlapping_iter(&t)
                .map(|m| (m.start(), m.end()))
                .filter(|(s, e)| !alnum_at(t[..*s].chars().next_back()) && !alnum_at(t[*e..].chars().next()))
                .collect();
            // The longest at each place, then left to right without overlap.
            hits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
            out = String::with_capacity(t.len());
            let mut last = 0;
            for (s, e) in hits {
                if s < last {
                    continue;
                }
                out.push_str(&t[last..s]);
                out.push_str(SAID);
                last = e;
            }
            out.push_str(&t[last..]);
        }
        out
    }

    /// `v` with every string in it, keys too, said through [`Held::text`].
    pub(crate) fn value(&self, v: Value) -> Value {
        if self.anywhere.is_none() && self.whole.is_none() {
            return v;
        }
        match v {
            Value::String(s) => Value::String(self.text(&s)),
            Value::Array(items) => Value::Array(items.into_iter().map(|i| self.value(i)).collect()),
            Value::Object(m) => Value::Object(m.into_iter().map(|(k, i)| (self.text(&k), self.value(i))).collect()),
            other => other,
        }
    }
}

/// The session values the node holds now ([`Held`]). Fails closed: a running browser whose cookies can't be read
/// can't be hidden, so the answer isn't given.
pub(crate) fn read() -> Result<std::sync::Arc<Held>, String> {
    let mut values = jar_values()?;
    values.extend(route_values());
    values.extend(NOTED.locked().iter().cloned());
    values.extend(crate::browse::session_cookies()?);
    // The same values as last time are masked by the same finder: building one for every form of every value, to the
    // reader's depth, is the cost, and it is paid when what the node holds changes.
    values.sort_unstable();
    values.dedup();
    let key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        values.hash(&mut h);
        h.finish()
    };
    let mut last = LAST.locked();
    if let Some((k, held)) = last.as_ref() {
        if *k == key {
            return Ok(held.clone());
        }
    }
    let held = std::sync::Arc::new(Held::of(values)?);
    *last = Some((key, held.clone()));
    Ok(held)
}

/// The finder [`read`] built last, by the values it was built for.
static LAST: Mutex<Option<(u64, std::sync::Arc<Held>)>> = Mutex::new(None);

/// Every value of every jar the node keeps: `<name>.json` (name to value), `<name>.json.only` (name to a value and
/// how long it lasts) and `<name>.json.storage` (the page's storage). The jar's other files say where and how a cookie
/// goes, never a value. No jar folder, or no such file, is nothing held. A folder or a file that is there and can't be
/// read, isn't JSON, or was written by a newer build is an error: what it holds can't be hidden, so the answer isn't
/// given. A file of the right name whose JSON isn't a jar's shape (a stale file of another kind left in the folder) is
/// no jar: nothing this build sends as a session comes from it, and it is passed over.
fn jar_values() -> Result<Vec<String>, String> {
    use serde_json::Value;
    let unread = |what: &str, e: String| format!("the node couldn't read {what} ({e}), so it can't keep the session it holds out of this answer");
    let dir = match std::fs::read_dir(crate::store::jars_dir()) {
        Ok(dir) => dir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(unread("its session jars", e.to_string())),
    };
    let texts = |v: Option<&Value>| -> Option<Vec<String>> { v?.as_object()?.values().map(|x| x.as_str().map(String::from)).collect() };
    let mut out = Vec::new();
    for e in dir {
        let path = e.map_err(|e| unread("its session jars", e.to_string()))?.path();
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let kind = [".json", ".json.only", ".json.storage"].into_iter().find(|k| name.ends_with(k));
        let Some(kind) = kind else { continue };
        let v: Option<Value> = unbrowse_files::JAR.read_at(&path).map_err(|e| unread(&format!("the jar {name}"), e.message(&path)))?;
        let Some(v) = v else { continue };
        let found = match kind {
            ".json" => texts(Some(&v)),
            ".json.only" => v.as_object().and_then(|m| m.values().map(|o| o.get("value").and_then(Value::as_str).map(String::from)).collect()),
            // What the page kept in its storage when the session was minted, marked as the session's or not: a token a
            // page keeps in `localStorage` is held there, whatever the learner made of it.
            _ => match (texts(v.get("local")), texts(v.get("session"))) {
                (Some(mut l), Some(s)) => {
                    l.extend(s);
                    Some(l)
                }
                (Some(l), None) if v.get("session").is_none() => Some(l),
                (None, Some(s)) if v.get("local").is_none() => Some(s),
                _ => None,
            },
        };
        out.extend(found.unwrap_or_default());
    }
    Ok(out)
}

/// What the routes this node keeps carry as a fixed session value: a cookie, or a value in HTTP's own credential
/// fields (`recipe::credential_field`).
fn route_values() -> Vec<String> {
    use unbrowse_learn::slots::Loc;
    use unbrowse_learn::Class;
    crate::store::load_routes()
        .into_iter()
        .flat_map(|r| r.graph.steps.into_iter().flat_map(|s| s.fields))
        .filter_map(|f| match (&f.loc, f.class) {
            (loc, Class::Constant { value, .. } | Class::Unconfirmed { value }) if matches!(loc, Loc::Cookie(_)) || crate::recipe::credential_field(loc) => Some(value),
            _ => None,
        })
        .collect()
}

/// Notes what a walk's capture held as the session, for [`read`]: the learner's own reading of it
/// (`provenance::session_values`: each cookie sent or set, and each value an answer delivered that a later request
/// sent back), what sat in HTTP's credential fields (the token alone too, after its scheme), and a token-shaped value of
/// any other request header but HTTP's representation fields (`recipe::session_shaped`).
pub(crate) fn note_trace(trace: &unbrowse_learn::Trace) {
    // The learner's own reading of what the walk held as its session (`provenance::session_values`): its cookies, and
    // every value an answer of the walk delivered that a later request sent back, in any position.
    let mut found = unbrowse_learn::provenance::session_values(trace);
    // And what sat in a header no answer explains: HTTP's credential fields, and a token-shaped value elsewhere.
    for ex in &trace.exchanges {
        for (k, v) in &ex.request_headers {
            if crate::recipe::credential_field(&unbrowse_learn::slots::Loc::Header(k.to_ascii_lowercase())) {
                found.push(v.trim().to_string());
                found.extend(v.trim().split_once(' ').map(|(_, t)| t.trim().to_string()));
            } else if !k.eq_ignore_ascii_case("cookie") && crate::recipe::session_shaped(k, v) {
                found.push(v.trim().to_string());
            }
        }
    }
    note(found);
}

/// Keeps `values` for [`read`], the newest last, at most [`NOTED_MOST`].
pub(crate) fn note(values: impl IntoIterator<Item = String>) {
    let mut noted = NOTED.locked();
    for v in values {
        if unbrowse_learn::slots::bound_by_key(&v) || v.chars().count() < SHORTEST {
            continue;
        }
        noted.retain(|n| *n != v);
        noted.push(v);
    }
    let over = noted.len().saturating_sub(NOTED_MOST);
    noted.drain(..over);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A long value goes wherever it stands and however it is written; a short one only as a whole word; a flag and
    /// a value under four characters stay, since they sign no one in and stand in every page.
    #[test]
    fn a_session_value_is_said_as_the_session_however_it_is_written() {
        let held = Held::of(["Zq9xSessionToken77".to_string(), "dark".to_string(), "true".to_string(), "en".to_string()]).unwrap();
        assert_eq!(held.text("sid=Zq9xSessionToken77; x"), "sid={session}; x");
        assert_eq!(held.text("abcZq9xSessionToken77def"), "abc{session}def", "a long one inside a longer word too");
        assert_eq!(held.text("t=Zq9xSessionToken77%3D"), "t={session}%3D");
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode("Zq9xSessionToken77");
        assert_eq!(held.text(&format!("blob {b64} end")), "blob {session} end", "as base64");
        assert_eq!(held.text("theme dark, darkness"), "theme {session}, darkness", "a short one only whole");
        assert_eq!(held.text("true en"), "true en", "a flag and a two-letter value stay");
        let v = held.value(serde_json::json!({ "Zq9xSessionToken77": ["dark", 1, { "a": "x Zq9xSessionToken77" }] }));
        assert_eq!(v, serde_json::json!({ "{session}": ["{session}", 1, { "a": "x {session}" }] }));
    }
}
