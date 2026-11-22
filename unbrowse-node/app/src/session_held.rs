//! What the node holds as a site's session is never said to an agent (SECURITY.md, "The site's session never reaches
//! an agent"). An agent key lets an agent act on a site the owner is signed in to; it never lets it carry the session
//! away. Every answer an agent gets, over HTTP or MCP, crosses [`Held::value`] in `api::run_primitive`, so a page the
//! agent reads, a script it runs, a walk's list of calls, a route's answer and an error all say `{session}` where a
//! credential the node holds stood.
//!
//! A credential is what a site issued to this visitor and takes back as who they are. It is read from where a value
//! sits, not from what text it is, since what sits elsewhere is content that answers say too:
//! - **A credential's own place holds one whatever it looks like.** The browser attaches a cookie to every request of
//!   its site, and a client attaches HTTP's credential fields (`Authorization` and the like) and a token-shaped header
//!   to its calls, whatever they ask: a value there is the site's word for who is asking, however short or plain
//!   (a session id of digits alone, a 13-character CSRF token). Held: every cookie of every jar and every running
//!   site browser; the values the learner moved into a jar from a header or the page's storage
//!   (`graph::session_headers`, `graph::session_storage`), since a call sends them as it sends a cookie; a cookie or a
//!   credential field a route carries as a fixed value; and what each walk's capture held in those places.
//! - **Anywhere else, a value is held only when no one could have written it** ([`unguessable`]): long and random
//!   enough that only the site's own minting makes it. That covers the page's storage, kept beside a jar (a token a
//!   page keeps in `localStorage`, and a token inside a JSON value it keeps there), and what a walk was handed by an
//!   answer and sent back in an address or a body (`provenance::session_values`: a login answer's refresh token). A
//!   search the page saved, a path, an item's number, an image's address, a word: a person or the page wrote those,
//!   anyone may be shown them, and none signs anyone in.
//! - **What the caller asked with is never masked** ([`callers_words`], [`Held::sparing`]): a value the agent sent
//!   itself (its goal, the page's address, an input, a word it typed) is its own, and saying it back gives it nothing.
//!   Only a held value equal to one of those words is spared, so no part of a credential is ever told.
//!
//! A value is masked whole however it is written (`trace::written_forms`, the one list of it: as itself, percent- or
//! form-encoded, as JSON or markup escapes it, as base64). A flag or a value shorter than [`SHORTEST`] carries nothing that signs anyone in
//! and would turn up everywhere, so it is left alone, and so is a short value of plain words, a site's setting
//! ([`a_setting`]: `theme=dark`, `LANGUAGE=en-us`); any other shorter than [`ANYWHERE`] is matched only as a whole word,
//! so a short id doesn't take a piece out of a longer word.
//!
//! The mask is kept in layers ([`layered`]): a finder for every form of every value is its whole cost, so a value is
//! built when the node comes to hold it, beside what was built before, and an answer is read by each layer in turn.
//! What is masked is what is held when the answer is made, whichever layers hold it.

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
/// What the walks' captures held as credentials: what sat in a credential's own place (a cookie, a credential field, a
/// token-shaped header), and what a walk was handed and sent back that no one could have written ([`unguessable`]),
/// the newest last.
static NOTED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The fewest characters of a value no one could have written ([`unguessable`]).
const UNGUESSABLE_SHORTEST: usize = 12;
/// The fewest bits of a value no one could have written, read from its length and the characters it is written in:
/// enough that a page saying it by chance, or a person typing it, doesn't happen.
const UNGUESSABLE_BITS: f64 = 60.0;

/// Whether a short value is a site's setting rather than a credential: under [`ANYWHERE`] characters, and plain words
/// only, joined by `-` or `_` (`en-us`, `en_US`, `none`, `dark`), as `provenance::a_plain_word` reads a word: letters
/// written as a word is, no digits, no case at random. A jar holds a site's settings beside its session (a language
/// cookie, a consent state, a stored `none`), and masking those took the same words out of the site's own answers
/// (`/hc/en-us/articles`, an event's status `none`), while a word that short signs no one in. A token or an id, short
/// or not, has digits or random case and is still masked.
fn a_setting(v: &str) -> bool {
    v.chars().count() < ANYWHERE && v.split(['-', '_']).all(unbrowse_learn::provenance::a_plain_word)
}

/// Whether a value is a dotted name or number a site shows every visitor: two or more labels joined by `.`, each label
/// plain words (`provenance::a_plain_word`) or numbers of at most four digits, joined by `-` (`pypi.org`,
/// `registry.npmjs.org`, `1.54.0`, `19.0.0-rc.1`, `2026.11.18`). A host name or a version number is what a site
/// publishes, and a page sends it back (in an address, or a report of the page), so a walk's capture reads it as a value
/// handed back; masking it took the site's own name and every version number out of its answers (UNB-212). No such
/// value signs anyone in: a token has letters and digits mixed in one label, letters in random case (a JWT's parts,
/// `GA1.1.…`), or a long number (an id, a time), and is still masked.
fn a_dotted_name(v: &str) -> bool {
    let part = |p: &str| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()) || unbrowse_learn::provenance::a_plain_word(p);
    let labels: Vec<&str> = v.split('.').collect();
    labels.len() >= 2 && labels.iter().all(|l| !l.is_empty() && l.split('-').all(part))
}

/// The most layers the mask is kept in ([`layered`]): each is read once for every text of an answer.
const LAYERS_MOST: usize = 12;
/// A build of at least twice this many values is split, each part built on a thread of its own ([`Layer::several`]).
const LAYER_APART: usize = 256;
/// The most parts one build is split into.
const PARTS_MOST: usize = 4;

/// The forms of some values, ready to find in text, with the value each form is of.
struct Finder {
    ac: AhoCorasick,
    /// For each form, in the finder's order, which of the layer's values it is a form of.
    of: Vec<u32>,
}

impl Finder {
    /// A finder of `forms`, each with the value it is of; none for no forms. Every match is reported
    /// (`MatchKind::Standard`), so a form of a value no longer held is passed over and a shorter form of one still held,
    /// at the same place, is still found ([`Held::stands`]).
    fn of(forms: Vec<(String, u32)>) -> Result<Option<Finder>, String> {
        if forms.is_empty() {
            return Ok(None);
        }
        let ac = AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .build(forms.iter().map(|(f, _)| f.as_str()))
            .map_err(|e| format!("the node couldn't build the mask for the sessions it holds ({e}), so it can't keep them out of this answer"))?;
        Ok(Some(Finder { ac, of: forms.into_iter().map(|(_, of)| of).collect() }))
    }
}

/// One part of the mask: the finders of some of the values the node held when it was built. Building a finder for
/// every form of every value is the mask's whole cost (a value is read in up to `trace::WRITTEN_FORMS_MOST` forms), so
/// it is paid once per value: a layer is kept while most of what it was built for is still held, and what the node
/// comes to hold later is built beside it ([`layered`]).
struct Layer {
    /// The values it was built for, in order: those it leaves alone (a flag, a setting, a short one) too, so each
    /// value is read once.
    values: Vec<String>,
    /// The forms masked wherever they stand.
    anywhere: Option<Finder>,
    /// The forms masked only where they stand whole.
    whole: Option<Finder>,
}

impl Layer {
    /// The values, each in every form a page may say it, short ones and flags left out. An error when a finder can't
    /// be built: a mask that isn't there can't be used as one, so the answer isn't given.
    fn of(mut values: Vec<String>) -> Result<Layer, String> {
        values.sort_unstable();
        values.dedup();
        let (mut anywhere, mut whole): (Vec<(String, u32)>, Vec<(String, u32)>) = (Vec::new(), Vec::new());
        for (i, v) in values.iter().enumerate() {
            if v.trim().is_empty() || unbrowse_learn::slots::bound_by_key(v) || v.chars().count() < SHORTEST || a_setting(v) || a_dotted_name(v) {
                continue;
            }
            let long = v.chars().count() >= ANYWHERE;
            // The forms alone (`trace::written_forms`): a reader of one value (`trace::Written`) builds two finders of
            // its own for them, which nothing here reads.
            for (f, within) in unbrowse_learn::trace::written_forms(v) {
                if f.chars().count() >= SHORTEST {
                    let to = if long || within { &mut anywhere } else { &mut whole };
                    to.push((f, i as u32));
                }
            }
        }
        Ok(Layer { anywhere: Finder::of(anywhere)?, whole: Finder::of(whole)?, values })
    }

    /// Layers that hold `values` between them: one, or, for a build long enough to be worth it (a node's first
    /// answer, with everything it holds to read), up to [`PARTS_MOST`] of about the same size, built side by side.
    fn several(values: Vec<String>) -> Result<Vec<std::sync::Arc<Layer>>, String> {
        let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
        let parts = Layer::parts(values.len(), threads);
        Layer::apart(values, parts)
    }

    /// How many parts a build of `values` values is split into on a machine of `threads` threads: one under twice
    /// [`LAYER_APART`], then one per [`LAYER_APART`], never more than the threads or [`PARTS_MOST`].
    fn parts(values: usize, threads: usize) -> usize {
        (values / LAYER_APART).clamp(1, threads.clamp(1, PARTS_MOST))
    }

    /// `values` as `parts` layers, each built on a thread of its own.
    fn apart(values: Vec<String>, parts: usize) -> Result<Vec<std::sync::Arc<Layer>>, String> {
        if parts <= 1 {
            return Ok(vec![std::sync::Arc::new(Layer::of(values)?)]);
        }
        // Dealt out in turn: the values are in order, and a run of long ones (a page's stored state) would otherwise
        // fall to one part.
        let mut dealt: Vec<Vec<String>> = vec![Vec::new(); parts];
        for (i, v) in values.into_iter().enumerate() {
            dealt[i % parts].push(v);
        }
        std::thread::scope(|s| {
            let built: Vec<_> = dealt.into_iter().map(|part| s.spawn(move || Layer::of(part))).collect();
            built
                .into_iter()
                .map(|b| b.join().unwrap_or_else(|_| Err("the node couldn't build the mask for the sessions it holds, so it can't keep them out of this answer".to_string())).map(std::sync::Arc::new))
                .collect()
        })
    }

    /// Whether it was built for `value`.
    fn has(&self, value: &str) -> bool {
        self.values.binary_search_by(|v| v.as_str().cmp(value)).is_ok()
    }
}

/// The layers that mask `values` (in order, each once), made from the layers `kept` from the last answer: what the
/// node holds changes a little at a time (a walk's new cookies, a jar written again), and a finder for all of it,
/// built again on every change, held each learn's reply for as long as the build took (UNB-263: 50 s of a 70 s first
/// answer, on a node holding 3,400 values). So only what changed is built:
/// - a layer most of whose values are still held is kept as it is (a value of it no longer held is passed over when
///   an answer is read, [`Held::stands`]);
/// - a layer under half held is given up, and what it still holds is built again with what is new;
/// - what no layer has is built as a new layer, which first takes in every layer no more than twice its size, and
///   the smallest while there are more than [`LAYERS_MOST`]: layers stay few and of sizes apart, so a value is built
///   again only a few times however long the node runs.
fn layered(kept: &[std::sync::Arc<Layer>], values: &[String]) -> Result<Vec<std::sync::Arc<Layer>>, String> {
    let held = |v: &&String| values.binary_search(v).is_ok();
    let mut again: Vec<String> = Vec::new();
    // Each layer with how many of its values are still held, the fullest first.
    let mut layers: Vec<(usize, std::sync::Arc<Layer>)> = Vec::new();
    for layer in kept {
        let still = layer.values.iter().filter(held).count();
        if still > 0 && still * 2 >= layer.values.len() {
            layers.push((still, layer.clone()));
        } else {
            again.extend(layer.values.iter().filter(held).cloned());
        }
    }
    again.extend(values.iter().filter(|v| !layers.iter().any(|(_, l)| l.has(v))).cloned());
    again.sort_unstable();
    again.dedup();
    if again.is_empty() {
        return Ok(layers.into_iter().map(|(_, l)| l).collect());
    }
    layers.sort_by_key(|(still, _)| std::cmp::Reverse(*still));
    while let Some((still, _)) = layers.last() {
        if *still > again.len() * 2 && layers.len() < LAYERS_MOST {
            break;
        }
        let (_, layer) = layers.pop().expect("there is a last one");
        again.extend(layer.values.iter().filter(held).cloned());
        again.sort_unstable();
        again.dedup();
    }
    let mut out: Vec<std::sync::Arc<Layer>> = layers.into_iter().map(|(_, l)| l).collect();
    out.extend(Layer::several(again)?);
    Ok(out)
}

/// The session values the node holds now, ready to mask an answer with: the layers that hold them between them, and
/// for each, which of its values are still held (none said: all of them).
pub(crate) struct Held {
    layers: Vec<(std::sync::Arc<Layer>, Option<Vec<bool>>)>,
    /// Held values this answer leaves as they are: the caller's own words ([`Held::sparing`]).
    spared: std::collections::BTreeSet<String>,
}

impl Held {
    /// The values, each in every form a page may say it, short ones and flags left out. An error when the finder can't
    /// be built: a mask that isn't there can't be used as one, so the answer isn't given. One finder of all of them:
    /// what a test holds a layered mask against.
    #[cfg(test)]
    pub(crate) fn of(values: impl IntoIterator<Item = String>) -> Result<Held, String> {
        Ok(Held { layers: vec![(std::sync::Arc::new(Layer::of(values.into_iter().collect())?), None)], spared: Default::default() })
    }

    /// `layers` as the mask of `values` (in order): a value a layer was built for and the node no longer holds is not
    /// masked by it.
    fn over(layers: Vec<std::sync::Arc<Layer>>, values: &[String]) -> Held {
        let layers = layers
            .into_iter()
            .map(|layer| {
                let still: Vec<bool> = layer.values.iter().map(|v| values.binary_search(v).is_ok()).collect();
                let all = still.iter().all(|s| *s);
                (layer, (!all).then_some(still))
            })
            .collect();
        Held { layers, spared: Default::default() }
    }

    /// This mask for an answer to a caller who sent `words` ([`callers_words`]): a held value equal to one of them is
    /// left as it is. The caller sent it, so saying it back tells the caller nothing it lacked; a value only partly
    /// equal to a word is masked as ever, so no piece of a credential is told.
    pub(crate) fn sparing(&self, words: &[String]) -> Held {
        Held { layers: self.layers.clone(), spared: words.iter().filter(|w| w.chars().count() >= SHORTEST).cloned().collect() }
    }

    /// Where a value still held stands in `text`, by one finder of each layer (`pick`), where `counts` lets it: the
    /// longest at each place, then left to right without overlap, as one finder of every form would read it.
    fn stands<'a>(&'a self, text: &str, pick: impl Fn(&'a Layer) -> Option<&'a Finder>, counts: impl Fn(usize, usize) -> bool) -> Vec<(usize, usize)> {
        let mut hits: Vec<(usize, usize)> = Vec::new();
        for (layer, still) in &self.layers {
            // Nothing is listed for a text that holds none: an answer of a page's state is tens of thousands of texts.
            let Some(finder) = pick(layer).filter(|f| f.ac.is_match(text)) else { continue };
            hits.extend(
                finder
                    .ac
                    .find_overlapping_iter(text)
                    .filter(|m| {
                        let of = finder.of[m.pattern().as_usize()] as usize;
                        still.as_ref().is_none_or(|still| still[of]) && !self.spared.contains(&layer.values[of])
                    })
                    .map(|m| (m.start(), m.end()))
                    .filter(|(s, e)| counts(*s, *e)),
            );
        }
        hits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
        let mut last = 0;
        hits.retain(|(s, e)| {
            let stands = *s >= last;
            if stands {
                last = *e;
            }
            stands
        });
        hits
    }

    /// `text` with each of `hits` (in order, apart) said as [`SAID`].
    fn said(text: &str, hits: &[(usize, usize)]) -> String {
        let mut out = String::with_capacity(text.len());
        let mut last = 0;
        for (s, e) in hits {
            out.push_str(&text[last..*s]);
            out.push_str(SAID);
            last = *e;
        }
        out.push_str(&text[last..]);
        out
    }

    /// `text` with every session value said as [`SAID`].
    pub(crate) fn text(&self, text: &str) -> String {
        // A long value, or a form that sits inside longer text by nature, wherever it stands; then, in what that
        // left, a short one where it stands whole. The text is copied only where something is found.
        let anywhere = self.stands(text, |l| l.anywhere.as_ref(), |_, _| true);
        let out = if anywhere.is_empty() { std::borrow::Cow::Borrowed(text) } else { std::borrow::Cow::Owned(Held::said(text, &anywhere)) };
        let alnum_at = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
        let whole = self.stands(&out, |l| l.whole.as_ref(), |s, e| !alnum_at(out[..s].chars().next_back()) && !alnum_at(out[e..].chars().next()));
        if whole.is_empty() {
            return out.into_owned();
        }
        Held::said(&out, &whole)
    }

    /// `v` with every string in it, keys too, said through [`Held::text`].
    pub(crate) fn value(&self, v: Value) -> Value {
        if self.layers.iter().all(|(l, _)| l.anywhere.is_none() && l.whole.is_none()) {
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
    values.sort_unstable();
    values.dedup();
    // The layers of the last answer mask what they were built for; only what the node has come to hold since is
    // built ([`layered`]). One answer builds at a time: the next finds the layers this one made.
    let mut kept = KEPT.locked();
    let layers = layered(&kept, &values)?;
    *kept = layers.clone();
    Ok(std::sync::Arc::new(Held::over(layers, &values)))
}

/// The layers [`read`] masked the last answer with.
static KEPT: Mutex<Vec<std::sync::Arc<Layer>>> = Mutex::new(Vec::new());

/// The credentials of every jar the node keeps: every value of `<name>.json` (name to value: the cookies, and what the
/// learner moved there from a header or the page's storage) and `<name>.json.only` (name to a value and how long it
/// lasts), each in a credential's own place; and of `<name>.json.storage` (the page's storage), what no one could have
/// written ([`stored_credentials`]). The jar's other files say where and how a cookie goes, never a value. No jar folder, or no such file, is nothing held. A folder or a file that is there and can't be
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
            // What the page kept in its storage when the session was minted: the browser sends none of it by itself, so
            // it is held where no one could have written it (a token a page keeps in `localStorage`), and a search it
            // saved, a setting or a count is left alone.
            _ => match (texts(v.get("local")), texts(v.get("session"))) {
                (Some(mut l), Some(s)) => {
                    l.extend(s);
                    Some(stored_credentials(l))
                }
                (Some(l), None) if v.get("session").is_none() => Some(stored_credentials(l)),
                (None, Some(s)) if v.get("local").is_none() => Some(stored_credentials(s)),
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

/// Notes what a walk's capture held as credentials, for [`read`]: what sat in a credential's own place (each cookie the
/// walk's browser sent or was set, what sat in HTTP's credential fields, the token alone too after its scheme, and a
/// token-shaped value of any other request header but HTTP's representation fields, `recipe::session_shaped`); and
/// what the walk was handed by an answer and sent back in a named place, a query's value, a body or a header
/// (`provenance::session_values`, the learner's own reading), where no one could have written it ([`unguessable`]): a
/// token the site minted, not a piece of the page's own paths, an item's number or a search word, which every answer
/// of the site may say.
pub(crate) fn note_trace(trace: &unbrowse_learn::Trace) {
    let mut own: Vec<String> = Vec::new();
    for ex in &trace.exchanges {
        own.extend(ex.cookies().into_iter().map(|(_, v)| v.trim().to_string()));
        for (k, v) in &ex.response_headers {
            if k.eq_ignore_ascii_case("set-cookie") {
                own.extend(v.lines().filter_map(|line| line.split(';').next()?.split_once('=').map(|(_, v)| v.trim().to_string())));
            }
        }
        // What sat in a header no answer explains: HTTP's credential fields, and a token-shaped value elsewhere.
        for (k, v) in &ex.request_headers {
            if crate::recipe::credential_field(&unbrowse_learn::slots::Loc::Header(k.to_ascii_lowercase())) {
                own.push(v.trim().to_string());
                own.extend(v.trim().split_once(' ').map(|(_, t)| t.trim().to_string()));
            } else if !k.eq_ignore_ascii_case("cookie") && crate::recipe::session_shaped(k, v) {
                own.push(v.trim().to_string());
            }
        }
    }
    // A piece of an address's path names a place on the site, the same for everyone the page sends there (a part's
    // folder, a file's hashed name): what the site issues to one visitor rides in a named place, a query's value, a
    // body or a header.
    let pathed: Vec<String> = trace
        .exchanges
        .iter()
        .flat_map(|ex| ex.url.path_segments().into_iter().flatten().map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect::<Vec<_>>())
        .collect();
    let in_a_path = |v: &str| pathed.iter().any(|p| p == v || p.contains(v));
    let back: Vec<String> = unbrowse_learn::provenance::session_values(trace).into_iter().filter(|v| !own.contains(v) && !in_a_path(v) && unguessable(v)).collect();
    note(own);
    note(back);
}

/// Whether the mask would leave `v` alone whoever held it: nothing to keep.
fn kept_by_none(v: &str) -> bool {
    unbrowse_learn::slots::bound_by_key(v) || v.chars().count() < SHORTEST
}

/// Keeps `values` for [`read`], the newest last, at most [`NOTED_MOST`].
pub(crate) fn note(values: impl IntoIterator<Item = String>) {
    let mut noted = NOTED.locked();
    for v in values {
        if kept_by_none(&v) {
            continue;
        }
        noted.retain(|n| *n != v);
        noted.push(v);
    }
    let over = noted.len().saturating_sub(NOTED_MOST);
    noted.drain(..over);
}

/// Whether `v` is a value no one could have written: at least [`UNGUESSABLE_SHORTEST`] characters, with letters, and
/// random enough for [`UNGUESSABLE_BITS`] by its length and the characters it is written in; not a path or an address
/// (it has no `/` and no space), not a dotted name or version ([`a_dotted_name`]), and not plain text (every run of
/// letters a plain word, every number short: `iphone 13`, `en-us-preferences`). A site mints such a value for one
/// visitor, and nothing else makes it: a page doesn't say it by chance and a person doesn't type it. What has no
/// letters is a number however it is grouped (an id, an order's number, a time) and is said by pages.
pub(crate) fn unguessable(v: &str) -> bool {
    let v = v.trim();
    let n = v.chars().count();
    if n < UNGUESSABLE_SHORTEST || v.chars().any(|c| c.is_whitespace() || c == '/') || !v.chars().any(|c| c.is_alphabetic()) || a_dotted_name(v) || plain_text(v) {
        return false;
    }
    let hex = v.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    let has = |f: fn(&char) -> bool| v.chars().any(|c| f(&c));
    let alphabet = if hex {
        16
    } else {
        [(has(char::is_ascii_digit), 10), (has(char::is_ascii_lowercase), 26), (has(char::is_ascii_uppercase), 26), (has(|c| !c.is_ascii_alphanumeric()), 4)]
            .into_iter()
            .filter(|(present, _)| *present)
            .map(|(_, size)| size)
            .sum()
    };
    n as f64 * f64::from(alphabet).log2() >= UNGUESSABLE_BITS
}

/// Whether `v` reads as text: every run of letters a plain word (`provenance::a_plain_word`) and every number at most
/// six digits.
fn plain_text(v: &str) -> bool {
    let mut runs = v.split(|c: char| !c.is_alphanumeric()).filter(|r| !r.is_empty()).peekable();
    runs.peek().is_some() && runs.all(|r| unbrowse_learn::provenance::a_plain_word(r) || (r.len() <= 6 && r.chars().all(|c| c.is_ascii_digit())))
}

/// What of the page's stored `values` no one could have written ([`unguessable`]): a value itself, or, for one the page
/// keeps as JSON, each text inside it (a token in a stored auth state); the JSON as a whole is the page's own record.
fn stored_credentials(values: Vec<String>) -> Vec<String> {
    fn texts(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(items) => items.iter().for_each(|i| texts(i, out)),
            Value::Object(m) => m.values().for_each(|i| texts(i, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for v in values {
        match serde_json::from_str::<Value>(&v) {
            Ok(parsed @ (Value::Object(_) | Value::Array(_))) => texts(&parsed, &mut out),
            _ => out.push(v),
        }
    }
    out.retain(|v| unguessable(v));
    out
}

/// The words an agent asked with in `args`, the call it made: its goal, the page's address, the inputs it gave, a
/// batch's pages, a search's query, the commands it sent the browser (a word it typed) and the text it typed into a
/// check. Each whole, each of its words, and an address's pieces as read (its path, its path with its query, as written
/// and as read, each piece of its path, each value of its query): a site keeps the page asked under any of them (a
/// cookie of the last page seen). What the call carries otherwise (an answer to say back, a route's id) is not the
/// caller's asking.
pub(crate) fn callers_words(args: &Value) -> Vec<String> {
    fn put(text: &str, out: &mut Vec<String>) {
        let decode = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned();
        let mut pieces = vec![text.to_string()];
        if let Ok(url) = url::Url::parse(text) {
            let with_query = url.query().map_or_else(|| url.path().to_string(), |q| format!("{}?{q}", url.path()));
            pieces.extend([url.path().to_string(), decode(url.path()), decode(&with_query), with_query]);
            pieces.extend(url.path_segments().into_iter().flatten().map(decode));
            pieces.extend(url.query_pairs().map(|(_, v)| v.into_owned()));
        }
        for piece in pieces {
            out.extend(piece.split_whitespace().map(String::from));
            out.push(piece);
        }
    }
    fn all(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => put(s, out),
            Value::Array(items) => items.iter().for_each(|i| all(i, out)),
            Value::Object(m) => m.values().for_each(|i| all(i, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    for field in ["goal", "url", "inputs", "pages", "query", "do", "text"] {
        if let Some(v) = args.get(field) {
            all(v, &mut out);
        }
    }
    out.retain(|w| w.chars().count() >= SHORTEST);
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A value no one could have written is long, has letters, and is random by its length and its characters: what a
    /// site mints for one visitor. A number however it is grouped, a path or an address, a version, a word or words,
    /// and anything short are what pages say and people type.
    #[test]
    fn only_what_no_one_could_have_written_is_unguessable() {
        for minted in ["eyJhbGciOiJIUzI1NiJ9.c2Vzc2lvbg.sig42", "r3freshTokenZ1x3c5v7b9Q", "h4ndle9921kq", "3f2a9c21-77e4-4b1a-9d0e-5a6b7c8d9e0f", "J9wTBX1FgwHOJcADoprD6Tk3Ea9Zcuf"] {
            assert!(unguessable(minted), "{minted}");
        }
        for written in [
            "b550m",
            "1795314547",
            "357-8168052-7913742",
            "/wp-catalog-parts-7q/list.js",
            "https://www.amazon.sg/s?k=b550m",
            "registry.npmjs.org",
            "19.0.0-rc.1",
            "authenticated-user-preferences",
            "iphone 13 pro max",
            "h4ndle992kq",
        ] {
            assert!(!unguessable(written), "{written}");
        }
    }

    /// What a page keeps in its storage is held where no one could have written it: a token kept whole, and a token
    /// inside a JSON value the page keeps; never the JSON as a whole, a saved search, a count or a setting.
    #[test]
    fn a_stored_token_is_held_and_the_rest_of_the_store_is_not() {
        let stored = stored_credentials(vec![
            "b550m".to_string(),
            r#"{"w4":{"date":1795315053212,"value":"10|b550m"}}"#.to_string(),
            "st0rageTok3n88291xQ".to_string(),
            r#"{"user":{"refreshToken":"rEfr3shInsideJson55kw","name":"lewis","visits":12}}"#.to_string(),
            "1795318141358".to_string(),
            "dark".to_string(),
        ]);
        assert_eq!(sorted(stored), sorted(vec!["st0rageTok3n88291xQ".to_string(), "rEfr3shInsideJson55kw".to_string()]));
    }

    /// The words a call asked with are its goal, its address and the pieces of it, its inputs, a batch's pages, a query,
    /// the commands it sent the browser and the text it typed; never what else the call carries.
    #[test]
    fn the_callers_words_are_what_it_asked_with() {
        let words = callers_words(&serde_json::json!({
            "goal": "cheapest b550m board",
            "url": "https://www.amazon.sg/s?k=b550m%20am4&page=2",
            "inputs": { "q": "x570 tomahawk" },
            "pages": [{ "url": "https://shop.example/item/1795314547" }, "https://other.example/?q=lamps"],
            "do": ["fill", "e3", "ryzen 5600g"],
            "answer": { "secret": "NotAskedWithThis99" },
            "route_id": "6e65b4ca4f4afd7a",
        }));
        for w in ["b550m", "b550m am4", "cheapest b550m board", "x570 tomahawk", "tomahawk", "1795314547", "lamps", "ryzen 5600g", "5600g", "fill", "/s?k=b550m%20am4&page=2", "/s?k=b550m am4&page=2", "/item/1795314547"] {
            assert!(words.iter().any(|x| x == w), "{w} in {words:?}");
        }
        assert!(!words.iter().any(|x| x.contains("NotAskedWithThis99") || x == "6e65b4ca4f4afd7a"), "{words:?}");
    }

    /// A jar holds a site's settings beside its session: a short value of plain words (a language, a state, a theme)
    /// signs no one in, and masking it took the same words out of the site's own answers. A short token, with digits or
    /// random case, is still masked; so is a word as long as a token could be.
    #[test]
    fn a_sites_setting_is_left_in_its_answers() {
        let held = Held::of(["en-us", "none", "en_US", "dark", "plno0t", "qZxWvK", "Authenticated"].map(String::from)).unwrap();
        assert_eq!(
            held.text("/hc/en-us/articles, status none, locale en_US, theme dark"),
            "/hc/en-us/articles, status none, locale en_US, theme dark"
        );
        assert_eq!(held.text("id plno0t, k qZxWvK"), "id {session}, k {session}", "a short token is still masked");
        assert_eq!(held.text("state Authenticated"), "state {session}", "a word as long as a token is still masked");
        assert!(a_setting("en-us") && a_setting("NONE") && !a_setting("v14iv") && !a_setting("en--") && !a_setting("aBcD"));
    }

    /// A long value goes wherever it stands and however it is written; a short one only as a whole word; a flag and
    /// a value under four characters stay, since they sign no one in and stand in every page.
    /// A site's own host name and its version numbers, which a walk's capture reads as handed back (a page sends them
    /// in an address or a report of itself), stay in its answers; a token written with dots is still the session's
    /// (UNB-212: crates.io's `"default_version": "{session}"`, a PyPI route's site said as `{session}`).
    #[test]
    fn a_host_name_or_a_version_is_left_in_its_answers() {
        let public = ["pypi.org", "registry.npmjs.org", "www.npmjs.com", "1.54.0", "19.2.1", "19.0.0-rc.1", "2026.11.18"];
        let tokens = [
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
            "GA1.1.1234567890.1795091264",
            "1234567890.1795091264",
            "s3cr3t.t0ken.v4lue",
            "aB9xQ.zZ7kP",
        ];
        let held = Held::of(public.iter().chain(&tokens).map(|v| v.to_string())).unwrap();
        for v in public {
            let said = format!(r#"{{"site":"{v}","default_version":"{v}"}}"#);
            assert_eq!(held.text(&said), said, "{v} is the site's, not the session's");
        }
        for t in tokens {
            assert_eq!(held.text(&format!("x {t} y")), "x {session} y", "{t} is still the session's");
        }
    }

    #[test]
    fn a_session_value_is_said_as_the_session_however_it_is_written() {
        let held = Held::of(["Zq9xSessionToken77".to_string(), "k9ZpQ".to_string(), "true".to_string(), "en".to_string()]).unwrap();
        assert_eq!(held.text("sid=Zq9xSessionToken77; x"), "sid={session}; x");
        assert_eq!(held.text("abcZq9xSessionToken77def"), "abc{session}def", "a long one inside a longer word too");
        assert_eq!(held.text("t=Zq9xSessionToken77%3D"), "t={session}%3D");
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode("Zq9xSessionToken77");
        assert_eq!(held.text(&format!("blob {b64} end")), "blob {session} end", "as base64");
        assert_eq!(held.text("sid k9ZpQ, k9ZpQx"), "sid {session}, k9ZpQx", "a short one only whole");
        assert_eq!(held.text("true en"), "true en", "a flag and a two-letter value stay");
        let v = held.value(serde_json::json!({ "Zq9xSessionToken77": ["k9ZpQ", 1, { "a": "x Zq9xSessionToken77" }] }));
        assert_eq!(v, serde_json::json!({ "{session}": ["{session}", 1, { "a": "x {session}" }] }));
    }

    /// Session values as a site hands them out: tokens no rule leaves alone, each its own.
    fn tokens(from: usize, to: usize) -> Vec<String> {
        let mut all: Vec<String> = (from..to).map(|i| format!("tk{i:04}Zq9x{:08x}Vw", (i as u32).wrapping_mul(2_654_435_761))).collect();
        all.sort_unstable();
        all
    }

    fn sorted(mut values: Vec<String>) -> Vec<String> {
        values.sort_unstable();
        values.dedup();
        values
    }

    /// UNB-263: a learn's reply was held for as long as a finder of everything the node holds took to build (50 s of
    /// a 70 s answer), since any change to what it holds (a walk's cookies) built all of it again. What the node
    /// comes to hold is built beside what it had: the layers of the last answer are the same ones, and the new layer
    /// was built for the new values alone.
    #[test]
    fn only_what_the_node_came_to_hold_is_built() {
        let before = tokens(0, 40);
        let kept = layered(&[], &before).unwrap();
        let after = sorted(before.iter().cloned().chain(tokens(40, 43)).collect());
        let layers = layered(&kept, &after).unwrap();
        for old in &kept {
            assert!(layers.iter().any(|l| std::sync::Arc::ptr_eq(l, old)), "a layer of what was held is kept, not built again");
        }
        let new: Vec<&std::sync::Arc<Layer>> = layers.iter().filter(|l| !kept.iter().any(|k| std::sync::Arc::ptr_eq(k, l))).collect();
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].values, tokens(40, 43), "built for the three new values alone");
        // Nothing new: nothing built.
        let again = layered(&layers, &after).unwrap();
        assert!(again.len() == layers.len() && again.iter().zip(&layers).all(|(a, b)| std::sync::Arc::ptr_eq(a, b)));
        // And the mask reads as one finder of all of it would.
        let (held, whole) = (Held::over(layers, &after), Held::of(after.clone()).unwrap());
        for v in [&after[0], &after[41], &after[42]] {
            let said = format!("a {v} b, c{v}d");
            assert_eq!(held.text(&said), "a {session} b, c{session}d");
            assert_eq!(held.text(&said), whole.text(&said));
        }
    }

    /// A layer is kept while most of what it was built for is still held, and a value of it the node no longer holds
    /// is no longer masked: the answer reads as a mask of what is held now would read it, a shorter value at the same
    /// place included.
    #[test]
    fn a_value_no_longer_held_is_passed_over_in_a_kept_layer() {
        let (long, inside, other) = ("Zq9xSessionToken77Extra".to_string(), "SessionToken77".to_string(), "k9ZpQ".to_string());
        let all = sorted(vec![long.clone(), inside.clone(), other.clone()]);
        let kept = layered(&[], &all).unwrap();
        let now = sorted(vec![inside.clone(), other.clone()]);
        let layers = layered(&kept, &now).unwrap();
        assert!(layers.len() == 1 && std::sync::Arc::ptr_eq(&layers[0], &kept[0]), "two of its three values are held: kept");
        let (held, fresh) = (Held::over(layers, &now), Held::of(now.clone()).unwrap());
        for said in [format!("x {long} y"), format!("sid {other}, {other}x"), format!("{inside}{long}")] {
            assert_eq!(held.text(&said), fresh.text(&said), "{said}");
        }
        assert_eq!(held.text(&format!("x {long} y")), "x Zq9x{session}Extra y", "the longer value is gone, the one inside it is still held");
        // Under half held: the layer is given up and what is still held built again; none held: nothing is masked.
        let one = vec![other.clone()];
        let layers = layered(&kept, &one).unwrap();
        assert!(layers.len() == 1 && layers[0].values == one, "built again from the one value still held");
        let none = Held::over(layered(&kept, &[]).unwrap(), &[]);
        assert_eq!(none.text(&format!("x {long} {other} y")), format!("x {long} {other} y"));
    }

    /// However what the node holds changes (values come, values go, a few at a time or most at once), the layered
    /// mask reads every text as one finder built for exactly what is held now reads it.
    #[test]
    fn the_layered_mask_reads_as_one_finder_of_what_is_held() {
        let pool = tokens(0, 24);
        let short = ["k9ZpQ", "x7Qa2", "plno0t", "en-us", "true"].map(String::from);
        let mut seed = 0x9e37_79b9_u32;
        let mut next = move |n: usize| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 8) as usize % n
        };
        let mut kept: Vec<std::sync::Arc<Layer>> = Vec::new();
        let mut held_now: Vec<String> = Vec::new();
        use base64::Engine;
        for round in 0..16 {
            // Most rounds a few values come and one goes; now and then most of them go at once.
            if round % 7 == 6 {
                held_now.truncate(held_now.len() / 4);
            } else if !held_now.is_empty() && round % 3 == 2 {
                held_now.remove(next(held_now.len()));
            }
            for _ in 0..1 + next(4) {
                held_now.push(pool[next(pool.len())].clone());
            }
            held_now.push(short[next(short.len())].clone());
            let values = sorted(held_now.clone());
            kept = layered(&kept, &values).unwrap();
            assert!(kept.len() <= LAYERS_MOST);
            let (layered, fresh) = (Held::over(kept.clone(), &values), Held::of(values.clone()).unwrap());
            for i in 0..12 {
                let (a, b, s) = (&pool[next(pool.len())], &pool[next(pool.len())], &short[next(short.len())]);
                let said = match i % 4 {
                    0 => format!("sid={a}; t={b}%3D {s}"),
                    1 => format!("{a}{b} {s}x {s}, {s}"),
                    2 => format!("blob {} end {s}", base64::engine::general_purpose::STANDARD.encode(a)),
                    _ => format!(r#"{{"k":"{a}","{s}":"{b}{s}"}}"#),
                };
                assert_eq!(layered.text(&said), fresh.text(&said), "round {round}: {said}");
            }
        }
    }

    /// A node that goes on learning builds each value a few times, not once per learn: the layers stay few and of
    /// sizes apart. Two hundred rounds of five new values build under fifteen times what is held; a finder of
    /// everything on every change built a hundred times it.
    #[test]
    fn a_node_that_goes_on_learning_builds_each_value_a_few_times() {
        // The layers' own bookkeeping, with no finders built: values of one character are left alone by every layer.
        let value = |i: usize| char::from_u32(0x4e00 + i as u32).unwrap().to_string();
        let mut values: Vec<String> = Vec::new();
        let mut kept: Vec<std::sync::Arc<Layer>> = Vec::new();
        let mut built = 0;
        for round in 0..200 {
            values.extend((round * 5..round * 5 + 5).map(value));
            values.sort_unstable();
            let layers = layered(&kept, &values).unwrap();
            built += layers.iter().filter(|l| !kept.iter().any(|k| std::sync::Arc::ptr_eq(k, l))).map(|l| l.values.len()).sum::<usize>();
            assert!(layers.len() <= LAYERS_MOST, "round {round}: {} layers", layers.len());
            let mut has: Vec<String> = layers.iter().flat_map(|l| l.values.iter().cloned()).collect();
            has.sort_unstable();
            assert_eq!(has, values, "every value in one layer, once");
            kept = layers;
        }
        assert_eq!(values.len(), 1000);
        assert!(built <= 15 * values.len(), "{built} values built for {} held", values.len());
    }

    /// A long build is split into parts built side by side, each value in one part; a short one is not split.
    #[test]
    fn a_long_build_is_split_and_built_side_by_side() {
        assert_eq!(Layer::parts(40, 12), 1);
        assert_eq!(Layer::parts(2 * LAYER_APART - 1, 12), 1);
        assert_eq!(Layer::parts(2 * LAYER_APART, 12), 2);
        assert_eq!(Layer::parts(100 * LAYER_APART, 12), PARTS_MOST);
        assert_eq!(Layer::parts(100 * LAYER_APART, 2), 2);
        assert_eq!(Layer::parts(100 * LAYER_APART, 0), 1);
        let values = tokens(0, 20);
        let layers = Layer::apart(values.clone(), 3).unwrap();
        assert_eq!(layers.iter().map(|l| l.values.len()).collect::<Vec<_>>(), [7, 7, 6]);
        let held = Held::over(layers, &values);
        for v in &values {
            assert_eq!(held.text(&format!("a {v} b")), "a {session} b");
        }
    }

    /// The cost UNB-263 is about, measured: a mask of everything a long-running node holds, then the same node after
    /// one more walk's values. Run in release: `cargo test --release -p unbrowse-node-app the_cost_of_a_walks_new_values -- --ignored --nocapture`.
    /// `one_finder_ms` is what every change to what the node holds cost before; `after_a_walk_of_40_ms` is what it costs now.
    #[test]
    #[ignore = "a measurement of minutes of CPU; run by hand in release"]
    fn the_cost_of_a_walks_new_values() {
        // UNBROWSE_MASK_VALUES_FILE names a JSON list of values to hold (a node's own, to measure what it pays); else
        // UNBROWSE_MASK_VALUES tokens.
        let from_file = std::env::var("UNBROWSE_MASK_VALUES_FILE").ok().map(|f| sorted(serde_json::from_slice::<Vec<String>>(&std::fs::read(f).unwrap()).unwrap()));
        let held = from_file.unwrap_or_else(|| tokens(0, std::env::var("UNBROWSE_MASK_VALUES").ok().and_then(|n| n.parse().ok()).unwrap_or(3400)));
        let n = held.len();
        let forms: usize = held.iter().map(|v| unbrowse_learn::trace::written_forms(v).len()).sum::<usize>() / n.max(1);
        let t = std::time::Instant::now();
        let one = Layer::of(held.clone()).unwrap();
        let whole = t.elapsed();
        drop(one);
        let t = std::time::Instant::now();
        let kept = layered(&[], &held).unwrap();
        let first = t.elapsed();
        let more = sorted(held.iter().cloned().chain(tokens(900_000, 900_040)).collect());
        let t = std::time::Instant::now();
        let layers = layered(&kept, &more).unwrap();
        let walk = t.elapsed();
        let mask = Held::over(layers.clone(), &more);
        let text: Vec<String> = (0..20_000).map(|i| format!("item {i} of the page's state, with nothing held in it")).collect();
        let t = std::time::Instant::now();
        let found = text.iter().filter(|s| mask.text(s) != **s).count();
        let read = t.elapsed();
        println!("MASK_COST values={n} forms_per_value={forms} one_finder_ms={} first_answer_ms={} layers={} after_a_walk_of_40_ms={} layers_after={} read_20000_texts_ms={} found={found}",
            whole.as_millis(), first.as_millis(), kept.len(), walk.as_millis(), layers.len(), read.as_millis());
    }
}
