//! The dependency graph of a route: which earlier requests it needs, and which value flows
//! from each response into which part of the next request.
//!
//! Values are classified by comparing two traces of the same flow from separate sessions
//! (two sightings while the agent browsed, or a sighting and the node's own clean re-run):
//!
//! | Class    | Same in both runs? | Found in an earlier response? |
//! |----------|--------------------|-------------------------------|
//! | Input    | (typed by the agent)                                |
//! | Constant | yes                | no, or only in static text such as JS |
//! | Derived  | either             | yes                           |
//! | Computed | no                 | no: made by page code, so the step needs a browser |
//!
//! From a single trace, a value with no source can't yet be told apart as constant or
//! computed: it is `Unconfirmed`, and the graph is provisional: built from two traces, it settles. The node walks a
//! page once, so its routes settle the mark another way: the site taking the value on a second day
//! (`store::RouteStats::sighted`), which says the route works and leaves the value's class as it is.
//!
//! Two kinds of value are read from the walk as a whole rather than one slot at a time. An id the
//! page's own code made up for the call (an upload's id read off the clock) is `Fresh`: made anew on
//! every call, the same in every step. And an upload (a file's bytes, sent in chunks the recording
//! holds none of) is one step whose body is the file the caller passes, with what the walk said
//! about that file (its size, its name) read from the new file as `File`.

use std::collections::{BTreeSet, HashMap};

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provenance::{find_in_static, find_origin_on, At, Origin, MIN_TRACEABLE};
use crate::slots::{slots, Loc, Slot};
use crate::trace::{Exchange, Trace};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "class", rename_all = "snake_case")]
pub enum Class {
    /// Typed by the agent. A secret becomes a vault parameter and is never published.
    /// The sighting's own value rides along as the default, so a retry runs
    /// unchanged and a caller can always override. An `optional` one the caller didn't give isn't sent at all: a filter
    /// or a next page the first call never asked for.
    Input {
        name: String,
        secret: bool,
        default: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        optional: bool,
    },
    /// The same for everyone. `origin` says where it was seen, so it can be refreshed.
    Constant { value: String, origin: Option<Origin> },
    /// Taken from an earlier response at call time.
    Derived { origin: Origin },
    /// A piece of a caller's value: `date: 2026-11-12` and `time: 19:00` from `?dateTime=2026-11-12T19:00:00`. The
    /// piece is written again from what the caller sends now, at the same offset and length, so a call for another day
    /// asks for that day. Only a piece that occurs once in the caller's value, and is long enough to mean something.
    Piece { input: String, from: usize, len: usize },
    /// Made by the page's own code; only a browser can produce it.
    Computed,
    /// Made by the page's own code from a producer the walk recorded ([`crate::signing::Producer`]): replay asks the
    /// transport to run it, and only a transport with no signing bridge falls back to the browser.
    Script { producer: crate::signing::Producer },
    /// Made by the page's own code, and expressed as what that code is: a hash over ordered parts of the call and the
    /// session ([`crate::signing::Recipe`]), fitted from the string the page built at the walk and verified against the
    /// value it wrote. Replay computes it from the request as it stands — no page, no scripts, no bridge.
    Recipe { recipe: crate::signing::Recipe },
    /// Made by the page's own code, and carried as a program written for the value: proposed by an agent from the
    /// walk's own sightings and shipped only after it reproduced every one of them (and an input it never saw). Replay
    /// runs the program in a sandbox, from the request as it stands — no page, no scripts, no bridge. A program that
    /// fails at call time falls back to the browser, never to a guess. The evidence names how it was made.
    Generated { program: String, evidence: crate::generated::Evidence },
    /// A session value the node's own browsing minted before the capture started, such as
    /// a cookie the site set on an earlier visit. The caller can't re-derive it from
    /// responses; the node supplies it from its live session or vault.
    Minted { name: String },
    /// Seen once with no source: the seen value rides along as a provisional
    /// constant, and a second sighting settles what it really is. A replay may
    /// use the provisional value (the graph is marked provisional); a published
    /// route is not allowed to stay in this state.
    Unconfirmed { value: String },
    /// An id the page's code made up for the call from the clock (see [`crate::fresh`]): the recorded value with
    /// `id` in it, which every call replaces with a new reading of the same clock, the same one in every step.
    Fresh { value: String, id: String, clock: crate::fresh::Clock },
    /// A fact about the file the caller passes as input `name` (its size, its file name), read from that file.
    File { name: String, of: crate::upload::FileFact },
    /// A longer value the page's code wrote a session cookie into (a visitor id inside a JSON parameter): `template` is
    /// the value with [`COOKIE_IN`] where the cookie's value stood. Every call writes the caller's own cookie `name`
    /// there, and nothing where its jar holds none, as a page's code with no id yet does. The walker's own id never
    /// rides in the route.
    CookieIn { template: String, name: String },
}

/// Where a session cookie's value stands in a [`Class::CookieIn`] template.
pub const COOKIE_IN: &str = "{cookie}";

impl Class {
    /// A `CookieIn` template written for a call: the cookie's value where it stood, nothing where none is held.
    pub fn cookie_in(template: &str, value: Option<&str>) -> String {
        template.replace(COOKIE_IN, value.unwrap_or_default())
    }
}

impl Step {
    /// Whether the page's own code makes this step's request. Routes learned before the step-level marker carry
    /// `Class::Script`/`Class::Computed` fields instead; they mean the same thing.
    pub fn is_page_signed(&self) -> bool {
        self.page_signed
            || self.needs_browser
            || self.fields.iter().any(|f| matches!(f.class, Class::Script { .. } | Class::Computed))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Field {
    pub loc: Loc,
    #[serde(flatten)]
    pub class: Class,
}

/// Where the page's own code writes a value its request carries, kept as evidence: the route sends the page's
/// request, not this field, so the value is never a value of the step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageProducer {
    /// The value's place in the request (a header, a body pointer), for the refusal's message; the request carries it.
    pub loc: Loc,
    /// The page's code that writes it.
    pub producer: crate::signing::Producer,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Step {
    /// Index of the exchange in the first trace.
    pub exchange: usize,
    pub method: String,
    /// The status the site answered with when the route was learned. A step
    /// whose recorded answer was a refusal (a guest probe that 401s before
    /// login) expects that refusal again; only an unexpected status fails.
    pub status: u16,
    /// The URL with every non-constant path segment and query value as `{loc}`.
    pub url: String,
    pub fields: Vec<Field>,
    /// The request body with every non-constant value blanked, so it holds no input or secret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<Body>,
    /// The shape of the JSON response (keys and value types, no values), which a replay must
    /// reproduce.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_shape: Option<Value>,
    /// Some value is computed by page code, so no plain call can make it: the step fails with
    /// `ReplayError::NeedsBrowser`, and a heal's fresh walk is what supplies a value that works for that call.
    pub needs_browser: bool,
    /// The page's own request **is** this step's request: replay runs the page's producer and sends what it made. The
    /// values the page writes are evidence (`page_producers`), not fields of the route — a header the page's call
    /// omits is simply not sent, with nothing to prune.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub page_signed: bool,
    /// Where the page's code writes the values its request carries, when the walk found it. Evidence only.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub page_producers: Vec<PageProducer>,
    /// The step's recorded answer set a cookie: the site's session bookkeeping, or its state kept in a cookie (a cart
    /// line). A write that did is ordered as a sign-in, and is still a commit (`ledger::Ledger::of`).
    #[serde(default)]
    pub sets_cookie: bool,
    /// The page sent this call by itself as it loaded, before anything was done on it, and it answered with data:
    /// every visit to the page sends it again. Set by the learner from the walk; never on a step another node sent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub on_load: bool,
    /// The step is someone else's: made from a body another node served (`recipe::into_route` in the node). Its
    /// request is the body's word, so none of the ledger's read exceptions apply to it (`ledger::writes`): anything
    /// but GET and HEAD writes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub foreign: bool,
    /// The caller's values this step sends inside a longer value of its own (a search's word in a JSON a query carries).
    /// Each is swapped for what the caller sends now, so a call never asks for the search the walk made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub held: Vec<Held>,
    /// The page was the answer, read as `page::answer` reads it, and `response_shape` is only a JSON script it carries (a
    /// site's menu, its settings). That shape still says a later page is this page, but the script is never the answer.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reads_page: bool,
    /// What the walk read for a value this step takes from an earlier reply, by the place the value fills: the value
    /// a call sends where a fresh answer does not hold the place (`Step::fallback`). A page's own load is what a
    /// browser would have had too, so a value of that load the site leaves out of a later answer (an experiment's
    /// code, a visitor's id, a piece of the state a page renders) is not the call failing. Only a value the walk
    /// really read, never one made up, and only one that holds no word the page was asked: a caller's word is never
    /// sent as the walk's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fallbacks: Vec<(Loc, String)>,
}

impl Step {
    /// What the walk read for the value this step sends at `loc`, where a fresh answer does not hold its place.
    pub fn fallback(&self, loc: &Loc) -> Option<&str> {
        self.fallbacks.iter().find(|(at, _)| at == loc).map(|(_, value)| value.as_str())
    }
}

/// A caller's value sitting inside a longer value of a request: where, whose, and as what text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub loc: Loc,
    /// The route input it is.
    pub input: String,
    /// Its text in the recorded value.
    pub sits: String,
    pub written: Written,
    /// The longer value is that text encoded again (`learn.derivation`): the caller's value sits in what it decodes
    /// to, and a call encodes it back the same way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inside: Option<Wrap>,
}

/// How a page encoded a text before sending it: base64 in either alphabet, padded or not. A page packs a search into
/// JSON and sends that encoded, so the caller's word is in no value the request shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Wrap {
    Base64,
    Base64NoPad,
    Base64Url,
    Base64UrlNoPad,
}

impl Wrap {
    /// In the order a value is tried. One value cannot always say which it is (a text whose length needs no padding
    /// reads the same padded or not), so the commoner way of each alphabet comes first: the browser's own encoder
    /// pads, and the address-safe alphabet is mostly sent bare.
    const ALL: [Wrap; 4] = [Wrap::Base64, Wrap::Base64UrlNoPad, Wrap::Base64NoPad, Wrap::Base64Url];

    fn engine(self) -> base64::engine::GeneralPurpose {
        use base64::engine::general_purpose as b64;
        match self {
            Wrap::Base64 => b64::STANDARD,
            Wrap::Base64NoPad => b64::STANDARD_NO_PAD,
            Wrap::Base64Url => b64::URL_SAFE,
            Wrap::Base64UrlNoPad => b64::URL_SAFE_NO_PAD,
        }
    }

    /// The text `value` holds, when it is that text encoded this way.
    pub fn open(self, value: &str) -> Option<String> {
        use base64::Engine;
        String::from_utf8(self.engine().decode(value).ok()?).ok()
    }

    /// `text` encoded this way.
    pub fn close(self, text: &str) -> String {
        use base64::Engine;
        self.engine().encode(text)
    }

    /// The encoding a value is in, and the text it holds: read from the value alone. It is long enough to hold
    /// something, decodes to text a person could read (no control characters), and encodes back to itself exactly, so
    /// a word or an id that merely fits the alphabet is not taken for one.
    pub fn of(value: &str) -> Option<(Wrap, String)> {
        if value.len() < 16 {
            return None;
        }
        Wrap::ALL.into_iter().find_map(|w| {
            let text = w.open(value)?;
            let readable = !text.is_empty() && text.chars().all(|c| !c.is_control() || c.is_whitespace());
            (readable && w.close(&text) == value).then_some((w, text))
        })
    }
}

/// How a value is written where it sits, so a new one goes in the same way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Written {
    /// As it is.
    Plain,
    /// Inside a JSON string.
    Json,
    /// In an address, percent-encoded.
    Percent,
    /// In an address, with a plus for each space.
    Plus,
    /// In capitals: a code the page's address writes small (`dcity=sin`) and the call sends the site's way (`SIN`).
    Upper,
    /// In small letters, where the page writes it in capitals.
    Lower,
    /// Its words joined by dashes, as an address that names a thing by its words writes them (`apple-pie`).
    Dashed,
}

impl Written {
    pub fn write(self, value: &str) -> String {
        const ADDRESS: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');
        match self {
            Written::Plain => value.to_string(),
            Written::Json => serde_json::to_string(value).ok().and_then(|s| Some(s.strip_prefix('"')?.strip_suffix('"')?.to_string())).unwrap_or_default(),
            Written::Percent => percent_encoding::utf8_percent_encode(value, ADDRESS).to_string(),
            Written::Plus => percent_encoding::utf8_percent_encode(value, ADDRESS).to_string().replace("%20", "+"),
            Written::Upper => value.to_uppercase(),
            Written::Lower => value.to_lowercase(),
            // As it is but for the joins: where it sits (a piece of an address, a query value) is escaped as any value there is.
            Written::Dashed => value.split_whitespace().collect::<Vec<_>>().join("-"),
        }
    }
}

/// Where `part` stands whole in `value`: with no letter or digit against either end, so `dress` never matches in
/// `address`.
fn stands_in(value: &str, part: &str) -> Vec<usize> {
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    value.match_indices(part).map(|(at, _)| at).filter(|&at| !word(value[..at].chars().next_back()) && !word(value[at + part.len()..].chars().next())).collect()
}

/// `value` with each whole `part` as `now`.
pub fn swapped(value: &str, part: &str, now: &str) -> String {
    // A part that stands whole nowhere but occurs once is one a learner proposed and the site verified (a word after
    // a type mark in a packed value): that one occurrence is it.
    if stands_in(value, part).is_empty() && value.matches(part).count() == 1 {
        return value.replacen(part, now, 1);
    }
    let mut out = String::with_capacity(value.len());
    let mut from = 0;
    for at in stands_in(value, part) {
        out.push_str(&value[from..at]);
        out.push_str(now);
        from = at + part.len();
    }
    out.push_str(&value[from..]);
    out
}

/// Whether a step sends a value the caller gave: an input, a fact about their file, or their words inside a longer value.
pub fn carries_the_caller(step: &Step) -> bool {
    !step.held.is_empty()
        || matches!(step.body, Some(Body::Upload { .. }))
        || step.fields.iter().any(|f| matches!(f.class, Class::Input { .. } | Class::File { .. }))
}

/// Whether what the caller sends as `input` can change what the route answers: the target sends it, or a step the
/// target takes a value from does, or a step that may change what the site holds does (a search kept in the session
/// and read back by the next call). A value sent only to a read the answer takes nothing from changes nothing.
pub fn reaches_the_answer(graph: &Graph, input: &str) -> bool {
    let Some(target) = graph.steps.last() else { return false };
    let carries = |s: &Step| {
        s.held.iter().any(|h| h.input == input)
            || s.fields.iter().any(|f| matches!(&f.class, Class::Input { name, .. } | Class::File { name, .. } if name == input))
            || matches!(&s.body, Some(Body::Upload { input: i, .. }) if i == input)
    };
    if graph.steps.iter().any(|s| !matches!(s.method.as_str(), "GET" | "HEAD") && carries(s)) {
        return true;
    }
    let mut asks: Vec<&Step> = vec![target];
    let mut seen: BTreeSet<usize> = BTreeSet::from([target.exchange]);
    while let Some(s) = asks.pop() {
        if carries(s) {
            return true;
        }
        for f in &s.fields {
            if let Class::Derived { origin } = &f.class {
                if seen.insert(origin.exchange) {
                    asks.extend(graph.steps.iter().find(|p| p.exchange == origin.exchange));
                }
            }
        }
    }
    false
}

/// The caller's values `slot` holds inside a longer value. Too short a value, a number or a flag could be anything, and
/// a secret never stays in a route, so none of those is read as one. A cookie is the session's, and an address piece
/// stands alone or not at all.
fn held_in(slot: &Slot, inputs: &[crate::trace::Input]) -> Vec<Held> {
    // An address piece stands alone, but for one case: the caller's word in marks the site puts around it
    // (`/search/chicken-`). The piece is then the word and the marks, nothing else, and the word is swapped inside it.
    if let Loc::Path(_) = slot.loc {
        let core = slot.value.trim_matches(|c: char| !c.is_alphanumeric());
        return inputs
            .iter()
            .filter(|i| !i.secret && i.value != slot.value && i.value.chars().count() >= 2 && i.value.eq_ignore_ascii_case(core))
            .take(1)
            // As it is: a piece of an address is escaped when the address is written.
            .map(|i| Held { loc: slot.loc.clone(), input: i.name.clone(), sits: core.to_string(), written: Written::Plain, inside: None })
            .collect();
    }
    if !matches!(slot.loc, Loc::Query(_) | Loc::Form(_) | Loc::Json(_) | Loc::Header(_)) {
        return Vec::new();
    }
    let held = held_in_text(&slot.loc, &slot.value, inputs, None);
    if !held.is_empty() {
        return held;
    }
    // Nothing of the caller's shows in the value as sent: it may be a text encoded again, with their word inside it.
    match Wrap::of(&slot.value) {
        Some((wrap, text)) => held_in_text(&slot.loc, &text, inputs, Some(wrap)),
        None => Vec::new(),
    }
}

/// The caller's values in `value`, the text of the slot at `loc` (as sent, or as what it decodes to: `inside`).
fn held_in_text(loc: &Loc, value: &str, inputs: &[crate::trace::Input], inside: Option<Wrap>) -> Vec<Held> {
    let slot = Slot { loc: loc.clone(), value: value.to_string() };
    let slot = &slot;
    let json = serde_json::from_str::<Value>(&slot.value).is_ok_and(|v| v.is_object() || v.is_array());
    let address = slot.value.starts_with('/') || slot.value.contains("://") || slot.value.contains('=');
    let mut out = Vec::new();
    for i in inputs.iter().filter(|i| !i.secret && i.value != slot.value && i.value.chars().count() >= 3 && i.value.chars().any(char::is_alphabetic) && !crate::slots::is_flag(&i.value)) {
        let plain = match (json, address) {
            (true, _) => Written::Json,
            (false, true) => Written::Percent,
            (false, false) => Written::Plain,
        };
        let mut forms = vec![(plain.write(&i.value), plain), (Written::Percent.write(&i.value), Written::Percent), (Written::Plus.write(&i.value), Written::Plus)];
        if address {
            forms.push((i.value.clone(), Written::Percent));
        }
        // A site may write a caller's code its own way (case aside, as a path piece is read): the call then sends it so.
        if !json && !address {
            forms.push((Written::Upper.write(&i.value), Written::Upper));
            forms.push((Written::Lower.write(&i.value), Written::Lower));
        }
        forms.retain(|(sits, w)| !matches!(w, Written::Upper | Written::Lower) || *sits != i.value);
        forms.dedup_by(|a, b| a.0 == b.0);
        for (sits, written) in forms {
            if !stands_in(&slot.value, &sits).is_empty() && !out.iter().any(|h: &Held| h.sits == sits) {
                out.push(Held { loc: slot.loc.clone(), input: i.name.clone(), sits, written, inside });
            }
        }
    }
    out
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Body {
    /// Non-constant leaves are `null`; `types` keeps each one's JSON type by pointer.
    Json { template: Value, types: BTreeMap<String, String> },
    /// Field names in order, with the value only where it is constant.
    Form { fields: Vec<(String, Option<String>)> },
    /// A multipart form, sent again on its recorded boundary: each part keeps its headers, and its value where it
    /// is constant. A part holding JSON keeps a template, as a JSON body does.
    Multipart { boundary: String, parts: Vec<PartTemplate> },
    /// A body that is neither JSON nor a form; not replayable yet.
    Other,
    /// A file's bytes, sent by `protocol`: the file is the one the caller passes, by path, as input `input`. The
    /// recording holds none of the bytes; a replay reads them from the new file.
    Upload {
        input: String,
        protocol: crate::upload::Protocol,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PartTemplate {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// The part's text, where it is constant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// For a part holding JSON: its template, non-constant leaves `null`, and their types by pointer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub types: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Graph {
    /// Steps in the order they must run; the target is last.
    pub steps: Vec<Step>,
    /// Some value is unconfirmed: the route can't be published until a second sighting.
    pub provisional: bool,
    /// The origin (scheme and host) of the page the route was learned on. A call the page's script made goes out from
    /// that page, as its Origin and Referer say: an API another host serves for the page checks them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_origin: Option<String>,
    /// The page the route was learned on, with the caller's values as `{name}`: the URL a signing bridge boots the
    /// page's scripts against, so the page reads what this call was asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    /// The scripts that produce a step's computed values (`Class::Script`), and the ones the page's own document
    /// names: the page's code, kept so a signing bridge can run it. In load order, only when a step needs one, and
    /// only up to a size a route can carry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scripts: Vec<crate::signing::Script>,
    /// The data the page read while the walk ran it — its own calls' answers — kept so a signing bridge boots the
    /// page's scripts on what they read: the data layer, not the markup. Only a route with scripts carries them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub api: Vec<crate::signing::Answer>,
    /// The page as the walk saw it, its head whole: what the page's scripts read when the bridge runs them again (a
    /// `<meta>` token, a `<script type="application/json">` config). Bounded, and only on a route with scripts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_html: Option<String>,
    /// The wall the walk met, when it met one: what a later call that meets it again is told instead of treating the
    /// refusal as the site drifting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub door: Option<Door>,
    /// The steps, by their exchange, that are pages the browser went to, answered by the state they embed: each is
    /// asked for as a page, though its reply holds JSON. The classifier marks none; a body said as a graph does
    /// (`body::to_graph`), for a step the body asks for as a page.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub visited: Vec<usize>,
    /// Where `scripts`, `api` and `page_html` were left when this graph was read without them (`set_apart`): the
    /// route file they are still in. Never written: a graph that runs or is saved takes them back first (`rejoined`).
    #[serde(skip)]
    pub apart: Option<std::sync::Arc<std::path::PathBuf>>,
}

/// What a graph read without its page's code is given back from: the route file at the path, read whole. The node
/// sets it once (`set_rejoin`); with none set a graph read apart stays without them.
pub type Rejoin = fn(&std::path::Path) -> Option<Graph>;
static REJOIN: std::sync::OnceLock<Rejoin> = std::sync::OnceLock::new();

/// Sets how a graph read apart is given its page's code back (`Graph::rejoined`). The first setting holds.
pub fn set_rejoin(f: Rejoin) {
    let _ = REJOIN.set(f);
}

impl Graph {
    /// Leaves out the page's code a route carries for its signing bridge (`scripts`, the answers the page read and the
    /// page itself), noting that they are still in the route file at `at`. They are most of a route's bytes (megabytes
    /// on a site that signs its calls), and nothing that lists, ranks or shows routes reads them: only running the
    /// graph does. Whether anything was left out.
    pub fn set_apart(&mut self, at: &std::path::Path) -> bool {
        if self.scripts.is_empty() && self.api.is_empty() && self.page_html.is_none() {
            return false;
        }
        self.scripts = Vec::new();
        self.api = Vec::new();
        self.page_html = None;
        self.apart = Some(std::sync::Arc::new(at.to_path_buf()));
        true
    }

    /// The page's code back on a graph read without it (`set_apart`), from its route file: what running the graph, or
    /// keeping it again, needs. A graph read whole is left as it is. Whether the graph is whole after.
    pub fn rejoined(&mut self) -> bool {
        let Some(at) = self.apart.take() else { return true };
        let Some(whole) = REJOIN.get().and_then(|f| f(&at)) else {
            self.apart = Some(at);
            return false;
        };
        self.scripts = whole.scripts;
        self.api = whole.api;
        self.page_html = whole.page_html;
        true
    }
}

/// The origin (scheme and host, and a port that isn't the scheme's) of `page`, if it is a web address.
pub fn origin_of(page: &str) -> Option<String> {
    let u = url::Url::parse(page).ok()?;
    matches!(u.scheme(), "http" | "https").then(|| u.origin().ascii_serialization())
}

/// The class of wall a site's door belongs to, read from what it answered with — its headers, the cookies it issues,
/// the page it served — never from a host: the same vendor's wall answers the same shape wherever it is deployed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoorKind {
    Cloudflare,
    Akamai,
    Radware,
    DataDome,
    PerimeterX,
    /// Vercel's Security Checkpoint: a 429 with a JS challenge that issues `_vcrcs` once a browser runs it.
    Vercel,
    /// The site's own scripts check the caller, with a value this engine produces (`Class::Script`): no vendor's
    /// wall. A 403 from one of these is diagnosed by the replay's value provenance, not by a door's cookie.
    OwnSigning,
    Unknown,
}

impl DoorKind {
    /// The cookie this vendor's door issues when it lets a browser through, by its published name.
    pub fn credential(self) -> Option<&'static str> {
        match self {
            DoorKind::Cloudflare => Some("cf_clearance"),
            DoorKind::Akamai => Some("_abck"),
            DoorKind::Radware => Some("reese84"),
            DoorKind::DataDome => Some("datadome"),
            DoorKind::PerimeterX => Some("_px3"),
            DoorKind::Vercel => Some("_vcrcs"),
            DoorKind::OwnSigning | DoorKind::Unknown => None,
        }
    }

    /// Whether the credential is bound to the browser that earned it (a device and behaviour sample, scored at the
    /// edge): the site's own answers never re-issue a working one, so only a browser earns a fresh one.
    pub fn device_bound(self) -> bool {
        !matches!(self, DoorKind::OwnSigning | DoorKind::Unknown)
    }
}

/// What earns a door's credential.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Earn {
    /// The site's own answers re-issue it: the route fetches its page again and takes the cookie from that answer. No
    /// browser is needed, only the recompute.
    Recompute,
    /// A browser in the site's profile earns it, headless first.
    Browser,
    /// A browser, and a person in the node's window if the site says so.
    BrowserOrOwner,
}

/// The wall a site put in front of its calls, as the walk met it, kept on the route so a call that meets it again
/// knows what it is instead of treating it as drift: the class, the statuses, the credential, its life, and what earns
/// it. The class, never the site.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Door {
    pub kind: DoorKind,
    /// The statuses the wall answers with.
    #[serde(default = "refused")]
    pub statuses: Vec<u16>,
    /// The cookie it issues when it lets a browser through.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
    /// How long that credential lives, in seconds, from the `Max-Age` its line gave.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u64>,
    /// What earns a fresh one.
    pub earn: Earn,
    /// Where the wall stood in the walk: the address whose answer was the door. The route never asks it over its own
    /// wire (a door is passed by a page's code, not by a request), and it is kept as the step the node's engine runs
    /// again when the pass must be earned again: the page at this address, let run, earns it as the walk's did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

fn refused() -> Vec<u16> {
    crate::trace::REFUSED.to_vec()
}

impl Door {
    /// The wall a walk met on `site`: a refusal or a door page that carries a vendor's mark, classified, with the
    /// credential the walk saw issued and its life. None when the walk met no vendor's wall — a refusal with no mark
    /// is the site's own rule, and the values are what diagnose it.
    pub fn met(trace: &Trace, site: &str) -> Option<Door> {
        let gated = trace.exchanges.iter().find(|e| {
            let refused = e.is_refused() && e.url.host_str().is_some_and(|h| crate::identity::on_site(h, site));
            let challenge = crate::page::a_door(e.status, e.response_body.as_deref().unwrap_or_default(), &e.url);
            (refused || challenge) && Door::kind_of(e).is_some()
        })?;
        let kind = Door::kind_of(gated).or_else(|| trace.exchanges.iter().find_map(Door::kind_of))?;
        Some(Door { at: Some(gated.url.to_string()), ..Door::classified(trace, kind) })
    }

    /// The wall one answer a call just got belongs to: the same classification, over the response alone. None when
    /// the answer shows no vendor's mark.
    pub fn answered(ex: &Exchange) -> Option<Door> {
        let kind = Door::kind_of(ex)?;
        Some(Door::classified(&Trace { exchanges: vec![ex.clone()], inputs: Vec::new() }, kind))
    }

    fn classified(trace: &Trace, kind: DoorKind) -> Door {
        // The credential the walk saw issued, or the vendor's published name when it saw none yet.
        let credential = trace
            .exchanges
            .iter()
            .filter_map(|e| Door::issued(e, kind))
            .next()
            .map(|(name, _)| name)
            .or_else(|| kind.credential().map(String::from));
        let ttl = trace
            .exchanges
            .iter()
            .filter_map(|e| Door::issued(e, kind))
            .next()
            .and_then(|(_, ttl)| ttl);
        let earn = match kind {
            // A device-bound credential is never re-issued on the site's own word: recompute alone would loop.
            k if k.device_bound() => Earn::BrowserOrOwner,
            _ => Earn::Recompute,
        };
        Door { kind, statuses: refused(), credential, ttl, earn, at: None }
    }

    /// The door in a sentence, for a person or an agent reading why a call or a walk stopped: what the wall is, the
    /// credential it issues, and what earns a fresh one.
    pub fn said(&self) -> String {
        let credential = self.credential.as_ref().map(|c| format!(" its `{c}`")).unwrap_or_default();
        let how = match self.earn {
            Earn::Recompute => "the site's own page re-issues it",
            Earn::Browser => "a browser in the site's profile earns it",
            Earn::BrowserOrOwner => "a browser in the site's profile earns it, and the owner's hand if the site asks",
        };
        format!("{:?}'s wall, which {how}{credential}", self.kind)
    }

    /// The credential of `kind` an answer issued, with the `Max-Age` its line gave, if that answer issued one.
    fn issued(ex: &Exchange, kind: DoorKind) -> Option<(String, Option<u64>)> {
        let wanted = kind.credential();
        ex.response_headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, line)| {
                let name = line.split(';').next()?.split_once('=')?.0.trim().to_ascii_lowercase();
                let matches = wanted.is_some_and(|w| name == w) || (wanted.is_none() && Door::names_a_wall_cookie(&name));
                if !matches {
                    return None;
                }
                let ttl = line.split(';').skip(1).find_map(|a| {
                    let (k, v) = a.split_once('=')?;
                    k.trim().eq_ignore_ascii_case("max-age").then(|| v.trim().parse::<u64>().ok()).flatten()
                });
                Some((name, ttl))
            })
            .next()
    }

    fn names_a_wall_cookie(name: &str) -> bool {
        matches!(name, "cf_clearance" | "_abck" | "bm_sz" | "reese84" | "datadome" | "_px3" | "_px2" | "_vcrcs")
    }

    /// The class of wall `ex` shows: its headers, its cookies, or the page it served. None when nothing marks a vendor.
    fn kind_of(ex: &Exchange) -> Option<DoorKind> {
        let header = |name: &str| ex.response_header(name).unwrap_or_default().to_ascii_lowercase();
        let cookies: Vec<String> = ex
            .response_headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|(_, line)| Some(line.split(';').next()?.split_once('=')?.0.trim().to_ascii_lowercase()))
            .collect();
        let named = |n: &str| cookies.iter().any(|c| c == n);
        let body = ex.response_body.as_deref().unwrap_or_default().to_ascii_lowercase();
        let says = |needle: &str| body.contains(needle);
        Some(if header("server").contains("cloudflare") || !header("cf-ray").is_empty() || named("cf_clearance") || says("cf-chl") || says("just a moment") {
            DoorKind::Cloudflare
        } else if named("_abck") || named("bm_sz") || named("ak_bmsc") || !header("x-akamai").is_empty() || says("reference #") {
            DoorKind::Akamai
        } else if named("reese84") || says("reese84") {
            DoorKind::Radware
        } else if named("datadome") || says("captcha-delivery") {
            DoorKind::DataDome
        } else if named("_px3") || named("_px2") || says("px-captcha") {
            DoorKind::PerimeterX
        } else if named("_vcrcs") || says("vercel security checkpoint") {
            DoorKind::Vercel
        } else {
            return None;
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum GraphError {
    #[error("no request in the first trace matches the target")]
    NoTarget,
    #[error("no trace given")]
    NoTrace,
}

/// Builds the graph for the last request in `traces[0]` that `is_target` accepts. A second
/// trace of the same flow, if given, settles which values are constant and which computed.
pub fn build(traces: &[Trace], is_target: impl Fn(&Exchange) -> bool) -> Result<Graph, GraphError> {
    // A route is the site's own API surface: the front door (a waiting room,
    // a challenge and its probes, read from the walk by `Trace::door`) was
    // passed by the browser at mint time and must never be replayed. Dropping
    // those exchanges first lets their cookies classify as Minted — supplied
    // by the session store.
    let cleaned: Vec<Trace> = traces.iter().map(|t| without_its_door(t, &is_target)).collect();
    let first = cleaned.first().ok_or(GraphError::NoTrace)?;
    // Pages are the browser's job too: a route is the site's API calls. Keep
    // the goal page only when the goal itself is one (a server-rendered search
    // page); every other document is minted, never replayed.
    let goal = first.exchanges.iter().rposition(&is_target).ok_or(GraphError::NoTarget)?;
    let read = pages_read(first, goal);
    // The walk's own pages, by address, before the pages are set aside: a call that sends one back reports it.
    let pages = page_addresses(first);
    // An upload is one step: its chunks, and the status probes and preflights to the same address among them, are
    // its parts, and its last chunk (the answer later steps read) stands for the whole. The ids the page made up for
    // the call are read from the whole walk, every page and answer in it, before anything is set aside.
    let runs = crate::upload::runs(first, &first.inputs);
    let fresh = crate::fresh::ids(first, cleaned.get(1));
    let parts: BTreeSet<usize> = runs.iter().flat_map(|r| r.members.iter().copied().filter(|&m| m != r.last)).filter(|&m| m != goal).collect();
    let ends: BTreeSet<usize> = runs.iter().map(|r| r.last).collect();
    // An upload's answer may be a page's type (a finished upload answers with a little HTML); it is still a call.
    let kept: Vec<usize> = (0..first.exchanges.len())
        .filter(|&i| !parts.contains(&i))
        .filter(|&i| i == goal || !is_document(&first.exchanges[i]) || read.contains(&i) || ends.contains(&i))
        .collect();
    let remap = |i: usize| kept.iter().position(|&k| k == i);
    let reduce = |t: &Trace| Trace {
        exchanges: kept.iter().filter_map(|&i| t.exchanges.get(i).cloned()).collect(),
        inputs: t.inputs.clone(),
    };
    // The first walk is cut to the calls a route may hold. A second walk is another visit, its calls in their own
    // order and number: it is read as it stands, and each call of the first finds its own there (`align`).
    let cleaned: Vec<Trace> = cleaned.iter().enumerate().map(|(n, t)| if n == 0 { reduce(t) } else { t.clone() }).collect();
    let traces = cleaned.as_slice();
    // From here the traces are fixed until the graph is built: each response's values are read once.
    let _memo = crate::provenance::Memo::start();
    let a = traces.first().ok_or(GraphError::NoTrace)?;
    let b = traces.get(1);
    let walk = Walk::of(a, fresh, runs.into_iter().filter_map(|r| Some((remap(r.last)?, r))));
    let target = a.exchanges.iter().rposition(is_target).ok_or(GraphError::NoTarget)?;
    // The route's own site: a value seen on both it and a third party's (ad tech,
    // metrics) derives from the site, so the graph doesn't grow steps elsewhere.
    let host = a.exchanges[target].url.host_str();
    let pairs = b.map(|b| align(a, b)).unwrap_or_default();

    let mut needed: BTreeSet<usize> = BTreeSet::from([target]);
    let mut queue: Vec<usize> = needed.iter().copied().collect();
    let mut fields_by_step = HashMap::new();
    // What each step must run after: the steps its values come from, and the steps that sent first an id it sends.
    let mut after: HashMap<usize, BTreeSet<usize>> = HashMap::new();
    loop {
        while let Some(i) = queue.pop() {
            let mut fields = classify(a, b, i, pairs.get(&i).copied(), host, &walk);
            // A cookie issued by a step plain HTTP cannot make is the browser's
            // to earn: the jar supplies it, and the step stays out of the route.
            for f in &mut fields {
                if let (Loc::Cookie(name), Class::Derived { origin }) = (&f.loc, &f.class) {
                    if browser_made(a, b, origin.exchange, pairs.get(&origin.exchange).copied(), host, &walk) {
                        f.class = Class::Minted { name: name.clone() };
                    }
                }
            }
            // And a value read from the answer to a call whose body the route cannot write (a challenge's reload, its
            // request an opaque blob) is one only the page can get: it is the page's to make, and the call that
            // carries it needs the page, rather than a route that fails at a step it could never send.
            for f in &mut fields {
                if let (false, Class::Derived { origin }) = (matches!(f.loc, Loc::Cookie(_)), &f.class) {
                    if unwritable(a, b, origin.exchange, pairs.get(&origin.exchange).copied(), host, &walk) {
                        f.class = Class::Computed;
                    }
                }
            }
            let mut prior = BTreeSet::new();
            for f in &fields {
                match &f.class {
                    Class::Derived { origin } => {
                        prior.insert(origin.exchange);
                    }
                    // The site knows an id the page made up only from the steps that sent it first (the upload it
                    // names): those run first, and a preflight is the browser's own.
                    // Only this site's steps: a beacon that sent the id to another site's analytics told this one nothing.
                    // Nor does one on the site's own hosts that reports a page (it sends the page's own address back) or
                    // answered with nothing: it told the site about the page, and no call waits on what it was told.
                    Class::Fresh { id, .. } => {
                        let here = a.exchanges[i].url.host_str().unwrap_or_default();
                        let same_site = |j: usize| a.exchanges[j].url.host_str().is_some_and(|h| crate::identity::same_site(h, here));
                        let told = |j: usize| !reports_a_page(&a.exchanges[j], &pages) && a.exchanges[j].response_body.as_deref().is_some_and(|b| !b.trim().is_empty());
                        // The site is told an id the page made up once, by the first call of its own that carried it:
                        // every call of the page carries a visitor id, and keeping all of them made a route hold the
                        // page's whole traffic to answer one call (22 steps for Trip.com's flight search, of which the
                        // target reads only the page).
                        let senders: Vec<usize> = (0..i)
                            .filter(|&j| a.exchanges[j].method != "OPTIONS" && same_site(j) && told(j) && crate::fresh::carries(&a.exchanges[j], id))
                            .collect();
                        // The site is told once, by the first call of its own that carried it. An upload that carries
                        // it is the thing the id was made for, and goes with it whole (a post's video and its cover).
                        if let Some(&first) = senders.first() {
                            prior.insert(first);
                        }
                        prior.extend(senders.iter().copied().filter(|j| walk.uploads.contains_key(j)));
                    }
                    _ => {}
                }
            }
            for &j in &prior {
                if needed.insert(j) {
                    queue.push(j);
                }
            }
            after.insert(i, prior);
            fields_by_step.insert(i, fields);
        }
        // An upload whose session a step of the route opened goes with that step: the session was opened for the
        // file, and what the route does next refers to the file only through ids the site keeps.
        let opened: Vec<usize> = walk
            .uploads
            .keys()
            .copied()
            // After the target it can't be the target's: the target is the route's last step, and its answer is in.
            .filter(|u| !needed.contains(u) && *u < target)
            .filter(|&u| {
                classify(a, b, u, pairs.get(&u).copied(), host, &walk)
                    .iter()
                    .any(|f| matches!(&f.class, Class::Derived { origin } if needed.contains(&origin.exchange)))
            })
            .collect();
        if opened.is_empty() {
            break;
        }
        for u in opened {
            needed.insert(u);
            queue.push(u);
        }
    }

    let mut steps: Vec<Step> = needed
        .into_iter()
        .map(|i| {
            let fields = fields_by_step.remove(&i).unwrap_or_default();
            let ex = &a.exchanges[i];
            // A piece of the address that holds the caller's word in the site's marks is a hole too: its recorded
            // value is written there with the word swapped (`Step::held`).
            let held_pieces: Vec<usize> = slots(ex)
                .iter()
                .filter(|s| !fields.iter().any(|f| f.loc == s.loc && matches!(f.class, Class::Input { .. })))
                .flat_map(|s| held_in(s, &a.inputs))
                .filter_map(|h| if let Loc::Path(n) = h.loc { Some(n) } else { None })
                .collect();
            let address = url_template(ex, &fields);
            let address = match held_pieces.is_empty() {
                true => address,
                false => {
                    let (head, query) = address.split_once('?').map(|(h, q)| (h.to_string(), Some(q.to_string()))).unwrap_or((address.clone(), None));
                    let (origin, path) = head.split_at(head.find("://").map(|at| head[at + 3..].find('/').map_or(head.len(), |p| at + 3 + p)).unwrap_or(0));
                    let pieces: Vec<String> = path.split('/').skip(1).enumerate().map(|(n, p)| if held_pieces.contains(&n) { format!("{{path[{n}]}}") } else { p.to_string() }).collect();
                    format!("{origin}/{}{}", pieces.join("/"), query.map(|q| format!("?{q}")).unwrap_or_default())
                }
            };
            Step {
                page_signed: false,
                page_producers: Vec::new(),
                exchange: i,
                method: ex.method.clone(),
                status: ex.status,
                url: address,
                body: match walk.uploads.get(&i) {
                    Some(u) => Some(Body::Upload { input: u.input.clone(), protocol: u.protocol.clone(), content_type: u.content_type.clone() }),
                    None => body_template(ex, &fields),
                },
                response_shape: answer_shape(ex, &a.inputs),
                reads_page: reads_page(ex, &a.inputs),
                needs_browser: fields.iter().any(|f| f.class == Class::Computed),
                sets_cookie: !ex.set_cookies().is_empty(),
                on_load: false,
                foreign: false,
                held: {
                    let bound = |loc: &Loc| fields.iter().any(|f| f.loc == *loc && matches!(f.class, Class::Input { .. }));
                    slots(ex).iter().filter(|s| !bound(&s.loc)).flat_map(|s| held_in(s, &a.inputs)).collect()
                },
                fields,
                fallbacks: Vec::new(),
            }
        })
        .collect();
    // State dependencies: a step that establishes session state (a login, a
    // guest registration) must run before the steps whose session cookies
    // the state lives behind. Values alone cannot see this: the login changes
    // what the server thinks of the session, not any captured value, so the
    // closure's value edges leave the establishing call stranded downstream.
    let pos_of_exchange: HashMap<usize, usize> =
        steps.iter().enumerate().map(|(pos, s)| (s.exchange, pos)).collect();
    // Ordering: value dependencies first (a step runs after everything it
    // takes values from), and among the ready steps the establishers go first —
    // a login changes what the server believes about the session, so it must
    // play before the calls whose recorded answers assume that belief.
    let mut edges: Vec<(usize, usize)> = Vec::new();
    for (pos, st) in steps.iter().enumerate() {
        for prior in after.get(&st.exchange).into_iter().flatten() {
            if let Some(&from) = pos_of_exchange.get(prior) {
                edges.push((from, pos));
            }
        }
        // A file goes up before anything the walk did after it: what follows (publishing it) needs it there.
        if matches!(st.body, Some(Body::Upload { .. })) {
            edges.extend(steps.iter().enumerate().filter(|(_, later)| later.exchange > st.exchange).map(|(to, _)| (pos, to)));
        }
    }
    let mut order: Vec<usize> = Vec::with_capacity(steps.len());
    let mut done = vec![false; steps.len()];
    while order.len() < steps.len() {
        let ready: Vec<usize> = (0..steps.len())
            .filter(|&p| !done[p] && edges.iter().filter(|(_, to)| *to == p).all(|(from, _)| done[*from]))
            .collect();
        let pick = ready
            .iter()
            .copied()
            .find(|&p| establishes_session(&steps[p], &steps))
            .or_else(|| ready.first().copied());
        match pick {
            Some(p) => {
                done[p] = true;
                order.push(p);
            }
            None => {
                for (p, d) in done.iter_mut().enumerate() {
                    if !*d {
                        *d = true;
                        order.push(p);
                    }
                }
            }
        }
    }
    steps = order.iter().map(|&p| steps[p].clone()).collect();

    let provisional = steps.iter().flat_map(|s| &s.fields).any(|f| matches!(f.class, Class::Unconfirmed { .. }));
    Ok(Graph { steps, provisional, page_origin: None, ..Graph::default() })
}

/// The shape of what a step answers with, which a replay must reproduce: its JSON, or for a page the state it embeds
/// when that state holds what the page shows (`page::answer`). A page whose state is a scrap of config (search
/// parameters, a phrasebook) answers with the page read, as the learner judged it, and keeps no shape: kept, the scrap's
/// would make every call answer with the scrap.
pub(crate) fn answer_shape(ex: &Exchange, inputs: &[crate::trace::Input]) -> Option<Value> {
    let body = ex.response_body.as_deref()?;
    let content_type = ex.response_header("content-type").unwrap_or(&ex.response_mime);
    if crate::page::is_markup(content_type, body) && serde_json::from_str::<Value>(body).is_err() {
        let asked: Vec<&str> = inputs.iter().filter(|i| !i.secret).map(|i| i.value.as_str()).collect();
        return match crate::page::answer_asked(body, &ex.url, &asked) {
            (state, false) => Some(shape(&state)),
            // Read for its text, a page still keeps the shape of the JSON script it carries: that shape is what tells a
            // later page from a wall put in its place (`ShapeMismatch`), though the script is never the answer.
            (_, true) => ex.json_body().map(|v| shape(&v)),
        };
    }
    ex.json_body().map(|v| shape(&v))
}

/// Whether a route that targets `ex` answers with the page read rather than a state it embeds (`page::answer_asked`).
pub(crate) fn reads_page(ex: &Exchange, inputs: &[crate::trace::Input]) -> bool {
    let Some(body) = ex.response_body.as_deref() else { return false };
    let content_type = ex.response_header("content-type").unwrap_or(&ex.response_mime);
    let asked: Vec<&str> = inputs.iter().filter(|i| !i.secret).map(|i| i.value.as_str()).collect();
    crate::page::is_markup(content_type, body) && serde_json::from_str::<Value>(body).is_err() && crate::page::answer_asked(body, &ex.url, &asked).1
}

/// The walk's own pages by address, host and path as read, the way a call reporting one sends it back
/// (`www.shop.example/search-results`). A site's front page (`/`) is left out: its host alone is in every address.
fn page_addresses(t: &Trace) -> Vec<String> {
    let mut out: Vec<String> = t
        .exchanges
        .iter()
        .filter(|e| e.is_main_document())
        .filter_map(|e| {
            let path = percent_encoding::percent_decode_str(e.url.path()).decode_utf8_lossy().trim_end_matches('/').to_string();
            let host = e.url.host_str()?;
            (!path.is_empty()).then(|| format!("{host}{path}").to_lowercase())
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Whether a call reports a page of the walk rather than asking the site for anything: it sends that page's own address
/// back, in its query or its body (an analytics hit, an ad conversion, a tag saying where it fired).
fn reports_a_page(e: &Exchange, pages: &[String]) -> bool {
    let (query, body) = (e.url.query().unwrap_or_default(), e.request_body.as_deref().unwrap_or_default());
    pages.iter().any(|p| crate::trace::carries_text(query, p) || crate::trace::carries_text(body, p))
}

/// Whether a step establishes the session, read from what it did on the walk rather than what its address is called:
/// it sent something to change the site, and answered with a cookie, sent a secret, or handed back the bearer token a
/// step of the route (`steps`) signs its calls with. A read that hands out a cookie doesn't: a site may issue one from
/// half its pages, and the state that matters changes where it is asked to.
fn establishes_session(step: &Step, steps: &[Step]) -> bool {
    let sends_a_secret = step.fields.iter().any(|f| matches!(f.class, Class::Input { secret: true, .. }));
    let signs_a_call = steps.iter().flat_map(|s| &s.fields).any(|f| match (&f.loc, &f.class) {
        (Loc::Header(h), Class::Derived { origin }) => h.eq_ignore_ascii_case("authorization") && origin.exchange == step.exchange,
        _ => false,
    });
    !matches!(step.method.as_str(), "GET" | "HEAD") && (step.sets_cookie || sends_a_secret || signs_a_call)
}

/// A page: the browser's material, not a call.
fn is_document(e: &Exchange) -> bool {
    e.resource_type.as_deref() == Some("Document")
        || e.response_mime.starts_with("text/html")
}

/// The pages the goal reads a value from: an identifier it sends that no API response before it carries, only a
/// page's data on the goal's own site (an item's internal id, embedded in the item's page), or one a page's redirect
/// hands over in the address it sends the browser to (a sign-in service's one-time flow id). The goal's own site, not
/// its host: a sign-in's page on `auth.` hands over what the call to `services.` sends. Such a page is the route's to
/// fetch; every other page stays the browser's.
fn pages_read(t: &Trace, goal: usize) -> BTreeSet<usize> {
    let target = &t.exchanges[goal];
    let host = target.url.host_str();
    let on_site = |e: &Exchange| match (e.url.host_str(), host) {
        (Some(h), Some(g)) => crate::identity::same_site(h, g),
        _ => false,
    };
    let pages: Vec<usize> = (0..goal).filter(|&i| is_document(&t.exchanges[i]) && on_site(&t.exchanges[i])).collect();
    if pages.is_empty() {
        return BTreeSet::new();
    }
    // Every trace searched is made before the memo starts and outlives it: the memo keys on where a trace lives.
    let apis = Trace { exchanges: t.exchanges[..goal].iter().filter(|e| !is_document(e)).cloned().collect(), inputs: t.inputs.clone() };
    let each: Vec<(usize, Trace)> = pages.iter().rev().map(|&i| (i, Trace { exchanges: vec![t.exchanges[i].clone()], inputs: Vec::new() })).collect();
    let _memo = crate::provenance::Memo::start();
    let typed = |v: &str| t.inputs.iter().any(|i| i.value == v);
    // An identifier, not a word: words of the call's own address and headers turn up in any page's text.
    let id_like = |v: &str| v.len() >= 8 && v.chars().any(|c| c.is_ascii_digit()) && !v.contains(char::is_whitespace);
    slots(target)
        .into_iter()
        .filter(|s| id_like(&s.value) && !typed(&s.value) && !matches!(s.loc, Loc::Cookie(_)))
        .filter(|s| find_origin_on(&apis, apis.exchanges.len(), &s.value, host).is_none())
        .filter_map(|s| {
            each.iter()
                .find(|(_, one)| find_origin_on(one, 1, &s.value, host).is_some_and(|o| matches!(o.at, At::Json { .. } | At::Text { .. } | At::HeaderQuery { .. })))
                .map(|(i, _)| *i)
        })
        .collect()
}

/// The trace without its front door, read against the site the walk landed on. The goal always stays: a door
/// that would swallow it is no door of this route's.
pub(crate) fn without_its_door(t: &Trace, is_target: &impl Fn(&Exchange) -> bool) -> Trace {
    let Some(site) = crate::walk::landed_site(t) else { return t.clone() };
    let door = t.door(&site);
    match t.exchanges.iter().rposition(is_target) {
        Some(goal) if !door.contains(&goal) => t.without_door(&site),
        _ => t.clone(),
    }
}

/// Whether a step is one only a browser makes: it takes nothing from the caller, and sends what plain HTTP cannot
/// reproduce, a value with no source the walk can show (a challenge's answer, a sensor's reading) or a body it
/// cannot read. Such a step is the door's, wherever it sits: what it issues is the session's.
fn browser_made(a: &Trace, b: Option<&Trace>, i: usize, j: Option<usize>, host: Option<&str>, walk: &Walk) -> bool {
    let fields = classify(a, b, i, j, host, walk);
    if fields.iter().any(|f| matches!(f.class, Class::Input { .. })) {
        return false;
    }
    let ex = &a.exchanges[i];
    let opaque = ex.request_body.as_deref().is_some_and(|b| !b.is_empty())
        && matches!(crate::slots::body_kind(ex), crate::slots::BodyKind::Other);
    opaque || fields.iter().any(|f| matches!(f.class, Class::Computed | Class::Unconfirmed { .. }))
}

/// Whether a step is one the route cannot send: its body is one it cannot read, so cannot write, and nothing of the
/// caller's goes into it. An upload is written from the caller's file, and is not such a step.
fn unwritable(a: &Trace, b: Option<&Trace>, i: usize, j: Option<usize>, host: Option<&str>, walk: &Walk) -> bool {
    let ex = &a.exchanges[i];
    let opaque = ex.request_body.as_deref().is_some_and(|b| !b.is_empty()) && matches!(crate::slots::body_kind(ex), crate::slots::BodyKind::Other);
    opaque && !walk.uploads.contains_key(&i) && !classify(a, b, i, j, host, walk).iter().any(|f| matches!(f.class, Class::Input { .. }))
}

/// What the walk as a whole says about its values: its uploads, by the exchange that stands for each, and the ids
/// the page's code made up for the call.
#[derive(Default)]
struct Walk {
    uploads: BTreeMap<usize, Upload>,
    fresh: Vec<(String, crate::fresh::Clock)>,
}

struct Upload {
    protocol: crate::upload::Protocol,
    size: u64,
    content_type: Option<String>,
    file_name: Option<String>,
    /// The route input the file comes in by.
    input: String,
}

impl Walk {
    /// Names each upload's file: the walk's own input whose file is that size, or `file`, `file_2`, ... in order.
    fn of(a: &Trace, fresh: Vec<(String, crate::fresh::Clock)>, runs: impl Iterator<Item = (usize, crate::upload::Run)>) -> Self {
        let mut uploads = BTreeMap::new();
        let mut used: Vec<String> = Vec::new();
        for (i, r) in runs {
            let named = a
                .inputs
                .iter()
                .find(|inp| !used.contains(&inp.name) && crate::files::size_of(&inp.value) == Some(r.size))
                .map(|inp| inp.name.clone());
            let input = named.unwrap_or_else(|| {
                (1..)
                    .map(|n| if n == 1 { "file".to_string() } else { format!("file_{n}") })
                    .find(|n| !used.contains(n) && !a.inputs.iter().any(|inp| &inp.name == n))
                    .expect("an unused name")
            });
            used.push(input.clone());
            uploads.insert(i, Upload { protocol: r.protocol, size: r.size, content_type: r.content_type, file_name: r.file_name, input });
        }
        Walk { uploads, fresh }
    }

    /// A value's class read from the walk as a whole, before it is traced: an id made up for the call, a fact of a
    /// file the route uploads at this step or after it, or a header of an upload protocol, which is route data.
    fn class_of(&self, i: usize, slot: &Slot) -> Option<Class> {
        if matches!(slot.loc, Loc::Cookie(_)) {
            return None;
        }
        if let Some((id, clock)) = self.fresh.iter().find(|(id, _)| crate::fresh::holds(&slot.value, id)) {
            return Some(Class::Fresh { value: slot.value.clone(), id: id.clone(), clock: *clock });
        }
        if !matches!(slot.loc, Loc::Path(_)) {
            for u in self.uploads.range(i..).map(|(_, u)| u) {
                // A length too short to be told from any other number is never taken for the file's.
                if u.size >= 1000 && slot.value == u.size.to_string() {
                    return Some(Class::File { name: u.input.clone(), of: crate::upload::FileFact::Size });
                }
                if u.file_name.as_deref().is_some_and(|n| !n.is_empty() && slot.value == n) {
                    return Some(Class::File { name: u.input.clone(), of: crate::upload::FileFact::Name });
                }
            }
        }
        match &slot.loc {
            Loc::Header(h) if crate::upload::protocol_header(h) => Some(Class::Constant { value: slot.value.clone(), origin: None }),
            _ => None,
        }
    }
}

/// The earlier answer that handed over a request's whole address: a header, or a JSON leaf, holding exactly it.
fn handed_over(a: &Trace, i: usize) -> Option<Origin> {
    let want = &a.exchanges[i].url;
    let same = |v: &str| url::Url::parse(v.trim()).is_ok_and(|u| &u == want);
    (0..i).rev().find_map(|j| {
        let e = &a.exchanges[j];
        let at = e
            .response_headers
            .iter()
            .find(|(k, v)| !k.eq_ignore_ascii_case("set-cookie") && same(v))
            .map(|(k, _)| At::Header { name: k.to_ascii_lowercase() })
            .or_else(|| {
                let json = e.json_body()?;
                crate::slots::json_leaves(&json).into_iter().find(|(_, v)| same(v)).map(|(pointer, _)| At::Json { pointer })
            })?;
        let url = format!("{}://{}{}", e.url.scheme(), e.url.host_str().unwrap_or_default(), e.url.path());
        Some(Origin { exchange: j, url, at, wrap: None })
    })
}

/// Whether the walk's browser held a cookie of this name with this value by exchange `i`: the session's own value, which
/// the jar carries from the walk and a call sends, rather than one the page's code makes.
fn held_under(a: &Trace, i: usize, name: &str, value: &str) -> bool {
    // Only a cookie the browser sent this call's own host: the jar a route runs with is that host's, and a cookie
    // the page's site keeps for another of its hosts is not in it. The page read such a value in its own code and
    // wrote it into the call; named as the session's, it would be looked for in a jar that never held it and the
    // call would go out without it.
    let host = a.exchanges.get(i).and_then(|e| e.url.host_str());
    a.exchanges.iter().take(i + 1).rev().filter(|e| e.url.host_str() == host).any(|e| e.cookies().iter().any(|(k, v)| k.eq_ignore_ascii_case(name) && v == value))
}

fn classify(a: &Trace, b: Option<&Trace>, i: usize, j: Option<usize>, host: Option<&str>, walk: &Walk) -> Vec<Field> {
    // A call the second walk never made is seen once: nothing there says its values moved, and reading every one of
    // them as missing would call each a thing the page computes.
    let b_slots: Option<Vec<Slot>> = b.and_then(|b| j.map(|j| slots(&b.exchanges[j])));
    let all = slots(&a.exchanges[i]);
    let browsers = crate::slots::BrowsersOwn::of(a);
    let mut fields: Vec<Field> = all
        .iter()
        .enumerate()
        .map(|(n, slot)| (input_at(&a.inputs, &all, n), slot.clone()))
        .map(|(chosen, slot)| {
            // A caller's value is an input wherever it sits, and the input it is the one its own place names
            // (`input_at`). In a path segment it is matched case-insensitively: a site may canonicalise the case on a
            // redirect (?search=planet -> /wiki/Planet), and the value must still bind as the input, not freeze as the
            // route's address (#23).
            if let Some(inp) = chosen {
                return Field {
                    class: Class::Input { name: input_name(&inp.name, &slot.loc), secret: inp.secret, default: Some(inp.value.clone()), optional: false },
                    loc: slot.loc,
                };
            }
            if !a.inputs.iter().any(|inp| inp.value == slot.value && !by_key_only(inp)) {
                if let Some(class) = walk.class_of(i, &slot) {
                    return Field { class, loc: slot.loc };
                }
            }
            // With a second trace: the value there, or `Some(None)` if it's missing there.
            let other = b_slots.as_ref().map(|b| b.iter().find(|s| s.loc == slot.loc).map(|s| s.value.as_str()));
            // A path segment that doesn't change is part of the route's address, not a value (a value the caller
            // asked for, `/search/iphone%2015/`, was bound as an input above).
            let address = matches!(slot.loc, Loc::Path(_))
                && (other == Some(Some(slot.value.as_str())) || (other.is_none() && find_origin_on(a, i, &slot.value, host).is_none()));
            let class = if address {
                Class::Constant { value: slot.value.clone(), origin: None }
            } else {
                classify_value(a, i, &slot.value, other, host)
            };
            // A value the walk's own browser held under this same name — a cookie `x-detected-locale` for the header
            // of that name — is the session's. The jar carries the walk's cookies, so replay sends it from there: one
            // sighting with no source is no signature when the session already holds that exact value. This is the
            // header that made Etsy's search route need the page's code, for a locale the browser sent all along.
            let class = match (&slot.loc, &class) {
                (loc, Class::Unconfirmed { .. }) => match key_of(loc).filter(|k| held_under(a, i, k, &slot.value)) {
                    Some(name) => Class::Minted { name },
                    None => class,
                },
                _ => class,
            };
            // A URL path segment traced to page text is an address component,
            // not page data: the segment spells the route ("sistic", "api"),
            // and a page's phrasing drifts where the address does not. Keep it
            // constant, with the origin retained so a refresh can still see it,
            // unless a second sighting shows the segment changing.
            let class = match (&slot.loc, &class) {
                (Loc::Path(_), Class::Derived { origin })
                    if matches!(origin.at, At::Text { .. }) && other.is_none() =>
                {
                    Class::Constant { value: slot.value.clone(), origin: Some(origin.clone()) }
                }
                // A request's content type is route data: it describes how the
                // call is made, not what a page said, so it stays constant even
                // when the trace shows the same string in an earlier response.
                (Loc::Header(name), _) if name.eq_ignore_ascii_case("content-type") => {
                    Class::Constant { value: slot.value.clone(), origin: None }
                }
                // The browser's own shape is the walk's word, not the session's: the client hints it sent (including
                // what a site asked for with `Accept-CH`), its fetch metadata, its priority and accepted languages.
                // Kept constant so a replay presents what the site was shown; the transport's UA and the jar's cookie
                // stay theirs.
                (Loc::Header(name), _) if browsers.carried(name, &slot.value) => {
                    Class::Constant { value: slot.value.clone(), origin: None }
                }
                _ => class,
            };
            Field { class, loc: slot.loc }
        })
        .collect();
    // An upload's chunk headers are the protocol's to set for the file it sends, and an address an earlier answer
    // handed over (a resumable session's) is taken from that answer whole.
    if let Some(u) = walk.uploads.get(&i) {
        fields.retain(|f| !matches!(&f.loc, Loc::Header(h) if u.protocol.sets(h)));
        if let Some(origin) = handed_over(a, i) {
            fields.retain(|f| !matches!(f.loc, Loc::Path(_) | Loc::Query(_)));
            fields.push(Field { loc: Loc::Url, class: Class::Derived { origin } });
        }
    }
    fields
}

/// The caller's input that slot `n` of a request holds, if it holds one. Two inputs may hold the same value
/// (`?limit=25&offset=25`), so the value alone never decides: the input the slot's own key names comes first, then
/// one no other slot of the request is named for. Path pieces have no key, and keep their order: the k-th piece
/// holding a value is the k-th input holding it, so `/firecrawl/firecrawl` asked as two inputs stays two. A flag
/// (`is_flag`) is the caller's only where its own key names the input: under another name (`has_opted_out=false` beside
/// a page's `?ascending=false`) it is that call's own setting.
/// The key a value sits under in a call: a query's or a form's name, a JSON body's last key. None for a path piece or
/// a whole address, which name no field.
pub fn key_of(loc: &Loc) -> Option<String> {
    match loc {
        Loc::Query(k) | Loc::Form(k) | Loc::Header(k) | Loc::Cookie(k) => Some(k.clone()),
        Loc::Part(k, p) if p.is_empty() => Some(k.clone()),
        Loc::Json(p) | Loc::Part(_, p) => p.rsplit('/').next().map(|k| k.replace("~1", "/").replace("~0", "~")),
        Loc::Path(_) | Loc::Url => None,
    }
}

/// What an input is called: the name the agent's step gave it, unless that name says nothing of the field (the ref a
/// snapshot numbered the control by, `@e129`, or the control's kind, `input`), when it is the key the call sends the
/// value under (`amount`, `fromAccountId`). A caller passes inputs by these names, and a ref is renumbered by every
/// snapshot.
pub(crate) fn input_name(said: &str, loc: &Loc) -> String {
    match key_of(loc).filter(|k| !k.trim().is_empty() && names_no_field(said)) {
        Some(k) => k,
        None => said.to_string(),
    }
}

/// Whether an input's name says nothing of the field it fills: the ref a snapshot numbered the control by (`@e129`), or
/// the control's kind (`input`).
fn names_no_field(said: &str) -> bool {
    let s = said.trim();
    let a_ref = s.strip_prefix('@').is_some_and(|r| r.chars().any(|c| c.is_ascii_digit()) && r.chars().all(|c| c.is_ascii_alphanumeric()));
    a_ref || matches!(s.to_ascii_lowercase().as_str(), "" | "input" | "textbox" | "textarea" | "combobox" | "select" | "searchbox" | "spinbutton")
}

/// Whether input `i` holds its value only under its own key (`slots::bound_by_key`): a flag, or a value one character
/// long that the page was asked for under a key (`adults=2`). A value typed into a control (an amount of `1` in `@e5`)
/// has no key to go by, and binds by its value as typed values do.
fn by_key_only(i: &crate::trace::Input) -> bool {
    crate::slots::is_flag(&i.value) || (crate::slots::bound_by_key(&i.value) && !names_no_field(&i.name))
}

fn input_at<'t>(inputs: &'t [crate::trace::Input], all: &[Slot], n: usize) -> Option<&'t crate::trace::Input> {
    let slot = &all[n];
    let path = matches!(slot.loc, Loc::Path(_));
    let own = key_of(&slot.loc);
    let same = |v: &str| if path { crate::slots::piece_holds(&slot.value, v) } else { v == slot.value };
    let holding: Vec<&crate::trace::Input> =
        inputs.iter().filter(|i| same(&i.value)).filter(|i| !by_key_only(i) || own.as_deref() == Some(i.name.as_str())).collect();
    if holding.len() <= 1 {
        return holding.first().copied();
    }
    if path {
        let before = all[..n].iter().filter(|s| matches!(s.loc, Loc::Path(_)) && same(&s.value)).count();
        return holding.get(before).or(holding.last()).copied();
    }
    if let Some(named) = holding.iter().find(|i| own.as_deref() == Some(i.name.as_str())) {
        return Some(named);
    }
    let others: Vec<String> = all.iter().enumerate().filter(|(m, _)| *m != n).filter_map(|(_, s)| key_of(&s.loc)).collect();
    holding.iter().find(|i| !others.contains(&i.name)).or(holding.first()).copied()
}

/// `in_b` is `None` with a single trace, else the value in the second trace if it has one.
fn classify_value(a: &Trace, i: usize, value: &str, in_b: Option<Option<&str>>, host: Option<&str>) -> Class {
    // A flag or a single character that reached here is under another input's name (`input_at`): the call's own setting.
    if let Some(input) = a.inputs.iter().find(|inp| inp.value == value && !by_key_only(inp)) {
        return Class::Input { name: input.name.clone(), secret: input.secret, default: Some(input.value.clone()), optional: false };
    }
    let Some(in_b) = in_b else { return classify_single(a, i, value, host) };
    let same = in_b == Some(value);
    if std::env::var_os("UNBROWSE_SIGN_DEBUG").is_some() && value.len() >= 20 {
        eprintln!("   [class] {} | there {:?} | origin {:?} | static {:?}", value.chars().take(40).collect::<String>(), in_b.map(|v| v.chars().take(40).collect::<String>()), find_origin_on(a, i, value, host).map(|o| o.url), find_in_static(a, i, value).map(|o| o.url));
    }
    // A second walk for another word moves every value that holds the word (a referer, the page's own address sent
    // along): that is the caller's value moving, not the page computing. Such a value is read as one sighting reads
    // it, and the word inside it is written where it sits.
    if !same && holds_an_input(a, value) {
        return classify_single(a, i, value, host);
    }
    match find_origin_on(a, i, value, host) {
        Some(origin) if same && one_of_a_list(a, &origin, value) => Class::Constant { value: value.into(), origin: Some(origin) },
        // A value from an API response is re-fetched at call time even if it didn't change.
        Some(origin) if !same || !matches!(origin.at, At::Text { .. }) => Class::Derived { origin },
        Some(origin) => Class::Constant { value: value.into(), origin: Some(origin) },
        // A plain word is too common to trace (`find_origin_on`), but whether it changed is what the second walk shows:
        // one sent otherwise there was made for each walk, however its letters fall (a hex signature can be all letters).
        None => {
            // A value that is a piece of what the caller sent (`date: 2026-11-12` for `?dateTime=2026-11-12T19:00:00`)
            // is written again from what they send now, whether or not it moved between sightings: a call for another
            // day must ask for that day. Only a piece that occurs once in the caller's value, and is long enough to
            // mean something (see `piece_of_an_input`).
            if let Some((input, from)) = piece_of_an_input(a, value) {
                return Class::Piece { input, from, len: value.chars().count() };
            }
            if same || value.len() < MIN_TRACEABLE {
                Class::Constant { value: value.into(), origin: find_in_static(a, i, value) }
            } else if crate::fresh::a_random_id(value) && in_b.is_some_and(crate::fresh::a_random_id) {
                // An id drawn at random on each visit, that no answer handed over: the page makes one up for the
                // call (a session of searching, a request's own name), and a route makes up its own. One sighting
                // cannot tell it from an id the site issued once; two show it move with nothing behind it.
                Class::Fresh { value: value.into(), id: value.into(), clock: crate::fresh::Clock::Random }
            } else if let Some(origin) = find_in_static(a, i, value) {
                // It moved between the two visits, and a script the page loaded spells it out: that script was
                // written for the visit, and is asked again for each call. One sighting cannot tell it from a
                // bundle's own text, which is why one sighting never reads a value from a script.
                Class::Derived { origin }
            } else {
                minted_or_computed(a, i, value)
            }
        }
    }
}

/// Whether `value` holds one of the caller's values inside it, as sent or as an address writes it.
fn holds_an_input(a: &Trace, value: &str) -> bool {
    let low = value.to_lowercase();
    a.inputs.iter().filter(|inp| inp.value.chars().count() >= 3).any(|inp| {
        let word = inp.value.to_lowercase();
        let percent = percent_encoding::utf8_percent_encode(&word, percent_encoding::NON_ALPHANUMERIC).to_string().to_lowercase();
        low != word && (low.contains(&word) || low.contains(&percent) || low.contains(&word.replace(' ', "+")) || low.contains(&word.replace(' ', "%20")) || low.contains(&word.replace(' ', "-")))
    })
}

/// A value with no source that differs between sightings: either the page's code made it
/// (only a browser can reproduce it), or it is a session value the node's browsing minted
/// before the capture. A cookie can only be the latter: the site set it on an earlier
/// visit. A header with no source is the same kind of thing: a token the session carries
/// (Carousell's csrf-token header travels with its session cookie and appears in no
/// response), so it is minted rather than computed.
fn minted_or_computed(a: &Trace, i: usize, value: &str) -> Class {
    let ex = &a.exchanges[i];
    let slot = slots(ex).into_iter().find(|s| s.value == value && matches!(s.loc, Loc::Cookie(_) | Loc::Header(_)));
    match slot.map(|s| s.loc) {
        Some(Loc::Cookie(name)) => Class::Minted { name },
        Some(Loc::Header(name)) => Class::Minted { name },
        _ => Class::Computed,
    }
}

/// Whether `value` was found only as one item of a list of words an earlier answer names (`"eligibleSources":
/// ["TRIP_SR", "SEARCH_RESULTS_MAP"]`): a word (letters, `_` or `-`, no digit) beside other words. The list offers
/// choices, and its order is the answer's to change; the call sends that word by the page's own code, so it is the
/// call's setting, kept with where it was seen. An id handed over (a token, a cursor) has digits, and is still traced.
fn one_of_a_list(a: &Trace, origin: &Origin, value: &str) -> bool {
    let At::Json { pointer } = &origin.at else { return false };
    let word = !value.is_empty() && value.chars().all(|c| c.is_alphabetic() || c == '_' || c == '-');
    let Some((parent, last)) = pointer.rsplit_once('/') else { return false };
    if !word || last.parse::<usize>().is_err() {
        return false;
    }
    let Some(answer) = a.exchanges.get(origin.exchange).and_then(|e| e.json_body()) else { return false };
    answer.pointer(parent).and_then(Value::as_array).is_some_and(|items| items.iter().any(|item| item.as_str().is_some_and(|s| s != value)))
}

/// Whether `value` is a piece of one of the values the caller sent: `2026-11-12` and `19:00` inside
/// `2026-11-12T19:00:00`, a `USD` inside `USD-SG`. Only a piece of at least four characters that occurs once in a
/// longer caller value counts: a `2` or a `true` is every call's own setting, and a piece that repeats says nothing
/// about which occurrence the call meant.
fn piece_of_an_input(a: &Trace, value: &str) -> Option<(String, usize)> {
    let piece: Vec<char> = value.chars().collect();
    if piece.len() < 4 {
        return None;
    }
    a.inputs.iter().find_map(|inp| {
        let hay: Vec<char> = inp.value.chars().collect();
        if hay.len() <= piece.len() {
            return None;
        }
        let at: Vec<usize> = hay.windows(piece.len()).enumerate().filter(|(_, w)| *w == piece.as_slice()).map(|(n, _)| n).collect();
        (at.len() == 1).then(|| (inp.name.clone(), at[0]))
    })
}

/// From one sighting: a value found in the page or an API response is re-fetched each time;
/// found only in static JS or CSS it is constant; found nowhere, a cookie is minted by an
/// earlier visit and anything else is unconfirmed.
fn classify_single(a: &Trace, i: usize, value: &str, host: Option<&str>) -> Class {
    match find_origin_on(a, i, value, host) {
        Some(origin) if one_of_a_list(a, &origin, value) => Class::Constant { value: value.into(), origin: Some(origin) },
        Some(origin) => Class::Derived { origin },
        None => {
            // A value that is a piece of what the caller sent (`date: 2026-11-12` for `?dateTime=2026-11-12T19:00:00`)
            // is written again from what they send now: a call for another day must ask for that day, not the walked
            // one. Only a piece that occurs once in the caller's value, and is long enough to mean something.
            if let Some((input, from)) = piece_of_an_input(a, value) {
                return Class::Piece { input, from, len: value.chars().count() };
            }
            if value.len() < MIN_TRACEABLE || crate::provenance::a_plain_word(value) {
                return Class::Constant { value: value.into(), origin: None };
            }
            if let Some(origin) = find_in_static(a, i, value) {
                return Class::Constant { value: value.into(), origin: Some(origin) };
            }
            // No source from one sighting: a cookie the earlier visit minted, an anti-forgery header the session
            // carries (the mint keeps both in the jar), or a value the second sighting settles.
            let ex = &a.exchanges[i];
            let session_header = |n: &str| n.contains("csrf") || n.contains("xsrf");
            match slots(ex).into_iter().find(|s| s.value == value && matches!(s.loc, Loc::Cookie(_) | Loc::Header(_))).map(|s| s.loc) {
                Some(Loc::Cookie(name)) => Class::Minted { name },
                Some(Loc::Header(name)) if session_header(&name) => Class::Minted { name },
                _ => Class::Unconfirmed { value: value.into() },
            }
        }
    }
}

/// The values of the call at `i` that the walk cannot source: no earlier answer, no static text of the page, no piece
/// of what the caller sent. The page's own code is what made them, so a route on this call computes them in the
/// sandbox — this is the reading `build` makes of every field, asked of one call so a candidate can say whether the
/// browserless path can close it. Cookies are the jar's, and the caller's own values are theirs; neither is the page's
/// to compute.
pub fn unsourced(a: &Trace, i: usize, host: Option<&str>) -> Vec<Loc> {
    unsourced_among(a, i, host, |_| true)
}

/// `unsourced`, asked only of the values at the places `of` names. Sourcing a value reads every answer the walk holds,
/// so a caller that cares about a few keys says which before that reading starts: asked of every value of every
/// candidate, a walk of a busy page (hundreds of calls, megabytes of answers) spent minutes here and the ask that
/// waited on it timed out.
pub fn unsourced_among(a: &Trace, i: usize, host: Option<&str>, of: impl Fn(&Loc) -> bool) -> Vec<Loc> {
    let all = slots(&a.exchanges[i]);
    let browsers = crate::slots::BrowsersOwn::of(a);
    all.iter()
        .filter(|s| of(&s.loc))
        .filter(|s| !matches!(s.loc, Loc::Cookie(_)))
        // The browser's own shape is the walk's, not the page's: its client hints, fetch metadata, priority and
        // languages are the transport's word about itself, and nothing on the page computes them.
        .filter(|s| !matches!(&s.loc, Loc::Header(h) if {
            let h = h.to_ascii_lowercase();
            // The request line itself (`:path`, `:authority`) is the call's own address, not a value it carries.
            h.starts_with(':') || browsers.wrote(&h, &s.value)
        }))
        .filter(|s| !a.inputs.iter().any(|inp| inp.value == s.value && !by_key_only(inp)))
        // The jar and the page's storage are sources too: a value one of them holds is the session's, not one the
        // page's code has to make.
        .filter(|s| !key_of(&s.loc).is_some_and(|k| held_under(a, i, &k, &s.value)))
        .filter(|s| matches!(classify_single(a, i, &s.value, host), Class::Computed | Class::Unconfirmed { .. }))
        .map(|s| s.loc.clone())
        .collect()
}

/// The values the page kept in its own storage under the same name a request sends: the session's, as a header the
/// page filled from `localStorage` is. A route stores no storage (nothing at replay reads it), so the jar carries the
/// values beside the cookies, and a call sends what the page would have read.
pub fn session_storage(graph: &mut Graph, storage: &crate::sandbox::Storage) -> Vec<(String, String)> {
    let look = |k: &str| storage.local.get(k).or_else(|| storage.session.get(k)).cloned();
    let mut moved: Vec<(String, String)> = Vec::new();
    for f in graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
        let Class::Unconfirmed { value } = &f.class else { continue };
        let Some(name) = key_of(&f.loc) else { continue };
        let held = value.clone();
        if look(&name).is_some_and(|stored| stored == held) {
            f.class = Class::Minted { name: name.clone() };
            moved.push((name, held));
        }
    }
    moved
}

/// Moves the header values seen once with no source out of the graph, for the session jar to keep. Such a value is
/// one the page carried in from its own state (a bearer token, an API key it stored), the same kind of thing as a
/// cookie: the jar is where the session lives, and the graph, which rides to disk and may be listed for others,
/// names the header and holds no value of it. Replayed, it is sent as before, from the jar (`Class::Minted`). The
/// graph stays provisional: what the value is, a second sighting still settles. A header name that carries two
/// different such values in one graph keeps them where they are, since one jar entry can hold only one.
/// Every cookie a later step derived from an earlier response, but that the walk's own later call already sent. The
/// walk repeated the session's value, so the jar keeps it and the field names it (`Minted`). A one-time bootstrap
/// (`createTUid`) whose cookie this is then has nothing later reading its response, and replay skips it.
pub fn walked_cookies(graph: &mut Graph, trace: &Trace) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for step in &mut graph.steps {
        let own = step.exchange;
        let method = step.method.clone();
        let url = step.url.clone();
        let path = url::Url::parse(&url).map(|u| u.path().to_string()).unwrap_or_else(|_| url.split('?').next().unwrap_or_default().to_string());
        for f in &mut step.fields {
            let (Class::Derived { origin }, Loc::Cookie(name)) = (&f.class, &f.loc) else { continue };
            if origin.exchange >= own {
                continue;
            }
            let Some(ex) = trace.exchanges.iter().rev().find(|e| e.method.eq_ignore_ascii_case(&method) && e.url.path() == path) else { continue };
            let Some(header) = ex.request_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("cookie")).map(|(_, v)| v.as_str()) else { continue };
            let Some((_, value)) = header.split(';').filter_map(|p| p.trim().split_once('=')).find(|(k, _)| *k == name.as_str()) else { continue };
            f.class = Class::Minted { name: name.clone() };
            out.push((name.clone(), value.to_string()));
        }
    }
    out
}

/// A value shorter than this is found in some answer by chance, and says nothing of where it came from.
const MIN_ISSUED: usize = 16;

/// A value a call handed the page during this very visit (a challenge's answer, in the response that issued it): it
/// was made for the visit, not kept from before it, and sent again later it is refused. It is the page's to make, so
/// the step needs the page, and the jar never holds it.
fn issued_this_visit(trace: &Trace, value: &str) -> bool {
    value.chars().count() >= MIN_ISSUED && trace.exchanges.iter().any(|e| e.response_body.as_deref().is_some_and(|b| b.contains(value)))
}

/// Whether the walk kept the header `name` at `value` across its requests: it sent the header once, or some request
/// repeated a value (session state: a token the session keeps, rotated now and then). One different on every request
/// is the page's to compute, per call (a signature), and stays for a producer or a recipe to be fitted to.
fn held_across(trace: &Trace, name: &str, value: &str) -> bool {
    let (mut sent, mut values) = (0usize, std::collections::HashSet::new());
    for s in trace.exchanges.iter().flat_map(slots) {
        if matches!(&s.loc, Loc::Header(n) if n.eq_ignore_ascii_case(name)) {
            sent += 1;
            values.insert(s.value);
        }
    }
    (sent == 1 || values.len() < sent) && values.contains(value)
}

/// Whether the header `name`, which the call at `i` of `trace` sends as `value`, is the session's: the jar keeps it,
/// and a route only names it. As [`session_headers`] decides it of a graph's field: a value one sighting cannot source
/// (no earlier answer, no script of the page, no piece of what the caller sent, not a word or a value too short to
/// trace), or the session's own anti-forgery header; that no answer handed the page during this visit; and that the
/// walk sent once or kept across its requests. A header the browser writes by itself is the browser's.
pub(crate) fn a_session_header(trace: &Trace, i: usize, name: &str, value: &str, host: Option<&str>) -> bool {
    if crate::slots::BrowsersOwn::of(trace).wrote(name, value) {
        return false;
    }
    match classify_single(trace, i, value, host) {
        Class::Minted { name: minted } => minted.eq_ignore_ascii_case(name),
        Class::Unconfirmed { .. } => !issued_this_visit(trace, value) && held_across(trace, name, value),
        _ => false,
    }
}

pub fn session_headers(graph: &mut Graph, trace: &Trace) -> Vec<(String, String)> {
    // What the walk sent for each header, across every request it made: a name whose value held is the session's (a
    // bearer token, an API key it kept); one whose value changed per call is the page's to compute — a signature —
    // and stays in the graph for a producer or a recipe to be fitted to.
    let issued = |value: &str| issued_this_visit(trace, value);
    for step in graph.steps.iter_mut() {
        let mut made = false;
        for f in step.fields.iter_mut() {
            if let (Loc::Header(name), Class::Unconfirmed { value }) = (&f.loc, &f.class) {
                // A header that only describes the body or the answer wanted (a media type, a coding, a language list)
                // is the call's own, the same on every call: neither a value the page made (a script may spell the same
                // type) nor one its session holds. A second walk would find it fixed; one walk is enough to say so.
                if crate::signing::says_what_the_body_is(name, value) {
                    f.class = Class::Constant { value: value.clone(), origin: None };
                } else if issued(value) {
                    f.class = Class::Computed;
                    made = true;
                }
            }
        }
        step.needs_browser |= made;
    }
    let mut seen: HashMap<String, Option<String>> = HashMap::new();
    for f in graph.steps.iter().flat_map(|s| &s.fields) {
        if let (Loc::Header(name), Class::Unconfirmed { value }) = (&f.loc, &f.class) {
            let e = seen.entry(name.to_ascii_lowercase()).or_insert_with(|| Some(value.clone()));
            if e.as_deref() != Some(value.as_str()) {
                *e = None;
            }
        }
    }
    let moved: Vec<(String, String)> = seen
        .into_iter()
        .filter_map(|(k, v)| {
            let v = v?;
            // One request only, or a value the walk repeated: the session's. Every request a different value: the
            // page's, kept for a producer or a recipe.
            held_across(trace, &k, &v).then_some((k, v))
        })
        .collect();
    for f in graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
        if let (Loc::Header(name), Class::Unconfirmed { .. }) = (&f.loc, &f.class) {
            let name = name.to_ascii_lowercase();
            if moved.iter().any(|(k, _)| *k == name) {
                f.class = Class::Minted { name };
            }
        }
    }
    moved
}

#[cfg(test)]
mod session_header_tests {
    use super::*;

    /// A header the page fills from a cookie the browser holds under the same name is the session's: the jar carries
    /// the walk's cookies, so replay sends it, and the route needs no page boot for it. A header of that name with a
    /// value no cookie holds is still the page's.
    #[test]
    fn a_header_a_cookie_holds_is_the_sessions() {
        let call = |held: &str| Exchange {
            method: "POST".into(),
            url: "https://www.example.com/api/search".parse().unwrap(),
            request_headers: vec![("cookie".into(), "x-detected-locale=en-GB-7; other=1".into()), ("x-detected-locale".into(), held.into())],
            request_body: Some("{}".into()),
            status: 200,
            response_headers: vec![],
            response_body: Some("{\"ok\":true}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        // A value of six characters or more is the only kind a source is looked for: `en-GB` is a plain setting of the
        // call's, like `page=2`, and never needed one. The rule is about values a site's cookie actually held.
        let graph = build(&[Trace { exchanges: vec![call("en-GB-7")], inputs: vec![] }], |e| e.url.path() == "/api/search").expect("a graph");
        let field = graph.steps.iter().flat_map(|s| &s.fields).find(|f| matches!(&f.loc, Loc::Header(h) if h == "x-detected-locale")).expect("the header is a field");
        assert!(matches!(field.class, Class::Minted { ref name } if name == "x-detected-locale"), "{:?}", field.class);

        let graph = build(&[Trace { exchanges: vec![call("fr-FR-9")], inputs: vec![] }], |e| e.url.path() == "/api/search").expect("a graph");
        let field = graph.steps.iter().flat_map(|s| &s.fields).find(|f| matches!(&f.loc, Loc::Header(h) if h == "x-detected-locale")).expect("the header is a field");
        assert!(matches!(field.class, Class::Unconfirmed { .. }), "a value no cookie holds is the page's: {:?}", field.class);
    }

    /// A header value some answer in the walk handed the page (a challenge's token) was issued for the visit: it is
    /// the page's to make and the step needs the page. The same header with no answer that issued it is the
    /// session's, as before.
    #[test]
    fn a_header_a_call_issued_during_the_visit_is_the_pages_to_make() {
        let token = "03AFcWeA7mG2kq9vXtR5nB8yLpZ1dQ4sU6wJ0hC3eK";
        let ex = |url: &str, sent: Option<&str>, answer: String| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: sent.map(|v| ("challenge-token".to_string(), v.to_string())).into_iter().collect(),
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(answer),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let search = ex("https://news.example/graphql?q=climate", Some(token), r#"{"data":{"posts":[{"title":"a"}]}}"#.into());
        let step = |g: &Graph| g.steps.last().unwrap().clone();
        let field = |g: &Graph| step(g).fields.into_iter().find(|f| matches!(&f.loc, Loc::Header(h) if h == "challenge-token")).map(|f| f.class);
        let unconfirmed = |g: &mut Graph| {
            for f in g.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
                if matches!(&f.loc, Loc::Header(h) if h == "challenge-token") {
                    f.class = Class::Unconfirmed { value: token.into() };
                }
            }
        };
        let issued = Trace { exchanges: vec![ex("https://challenge.example/reload", None, format!(r#"["rresp","{token}",null,120]"#)), search.clone()], inputs: vec![] };
        let mut g = build(std::slice::from_ref(&issued), |e| e.url.path() == "/graphql").expect("a graph");
        unconfirmed(&mut g);
        assert!(session_headers(&mut g, &issued).is_empty(), "the jar never holds it");
        assert!(step(&g).needs_browser && field(&g) == Some(Class::Computed), "{:?}", field(&g));
        let kept = Trace { exchanges: vec![search], inputs: vec![] };
        let mut g = build(std::slice::from_ref(&kept), |e| e.url.path() == "/graphql").expect("a graph");
        unconfirmed(&mut g);
        assert_eq!(session_headers(&mut g, &kept).len(), 1, "no call issued it: the session's");
        assert!(matches!(field(&g), Some(Class::Minted { .. })));
    }

    /// A header that only says what the body is, spelled also in a script the page loaded, was not issued for the visit
    /// and is not the session's: a media type is the same for every call, sent as the call sent it, and the step stays a
    /// plain one.
    #[test]
    fn a_media_type_a_script_also_spells_was_not_issued_for_the_visit() {
        let mime = "application/x-www-form-urlencoded";
        let bundle = Exchange {
            method: "GET".into(),
            url: "https://cdn.example/app.js".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(format!(r#"function send(x){{x.setRequestHeader("content-type","{mime}")}}"#)),
            response_mime: "application/javascript".into(),
            resource_type: Some("Script".into()),
            main_frame: None,
        };
        let call = Exchange { url: "https://api.example/h5/find/1.0/?q=lamps".parse().unwrap(), request_headers: vec![("content-type".into(), mime.into())], response_body: Some(r#"{"ret":["SUCCESS"]}"#.into()), response_mime: "application/json".into(), resource_type: Some("XHR".into()), ..bundle.clone() };
        let trace = Trace { exchanges: vec![bundle, call], inputs: vec![] };
        let mut g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/h5/find/1.0/").expect("a graph");
        for f in g.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
            if matches!(&f.loc, Loc::Header(h) if h == "content-type") {
                f.class = Class::Unconfirmed { value: mime.into() };
            }
        }
        session_headers(&mut g, &trace);
        let step = g.steps.last().unwrap();
        let class = step.fields.iter().find(|f| matches!(&f.loc, Loc::Header(h) if h == "content-type")).map(|f| f.class.clone());
        assert_eq!(class, Some(Class::Constant { value: mime.into(), origin: None }), "the call's own, as sent");
        assert!(!step.needs_browser, "a plain call");
    }

    /// A value the page kept in its storage under the same name a request sends is the session's too: the page read
    /// that storage, and the jar carries what it read. A name the page did not keep is still the page's.
    #[test]
    fn a_value_the_page_kept_in_its_storage_is_the_sessions() {
        let call = |recs: &str| Exchange {
            method: "POST".into(),
            url: "https://www.example.com/api/search".parse().unwrap(),
            request_headers: vec![("x-recs-primary-location".into(), recs.into())],
            request_body: Some("{}".into()),
            status: 200,
            response_headers: vec![],
            response_body: Some("{\"ok\":true}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let mut graph = build(&[Trace { exchanges: vec![call("114188912")], inputs: vec![] }], |e| e.url.path() == "/api/search").expect("a graph");
        let mut storage = crate::sandbox::Storage::default();
        storage.local.insert("x-recs-primary-location".into(), "114188912".into());
        assert_eq!(session_storage(&mut graph, &storage), vec![("x-recs-primary-location".to_string(), "114188912".to_string())]);
        let field = graph.steps.iter().flat_map(|s| &s.fields).find(|f| matches!(&f.loc, Loc::Header(h) if h == "x-recs-primary-location")).expect("the header is a field");
        assert!(matches!(field.class, Class::Minted { .. }), "{:?}", field.class);

        let mut graph = build(&[Trace { exchanges: vec![call("114188912")], inputs: vec![] }], |e| e.url.path() == "/api/search").expect("a graph");
        let mut other = crate::sandbox::Storage::default();
        other.local.insert("x-recs-primary-location".into(), "999999999".into());
        assert!(session_storage(&mut graph, &other).is_empty());
    }

    /// A header whose value changed between the walk's requests is the page's to compute (a signature), and stays in
    /// the graph: a per-call value frozen into the jar is a stale signature. One whose value held is the session's.
    #[test]
    fn a_header_that_changed_per_call_is_not_the_sessions() {
        let ex = |path: &str, sig: &str| Exchange {
            method: "POST".into(),
            url: format!("https://shop.example{path}").parse().unwrap(),
            request_headers: vec![("x-sig".into(), sig.into()), ("authorization".into(), "Bearer tok_dummy_123456".into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = Trace { exchanges: vec![ex("/a", "s-1"), ex("/b", "s-2")], inputs: vec![] };
        let mut g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/b").unwrap();
        let moved = session_headers(&mut g, &trace);
        assert!(moved.iter().any(|(k, _)| k == "authorization"), "a value that held is the session's: {moved:?}");
        assert!(!moved.iter().any(|(k, _)| k == "x-sig"), "a value that changed per call is the page's: {moved:?}");
        let sig = g.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Header("x-sig".into())).map(|f| f.class.clone());
        assert!(!matches!(sig, Some(Class::Minted { .. })), "the signature stays in the graph: {sig:?}");
    }

    /// A credential header seen once with no source is the session's: after the graph gives it up for the jar, the
    /// graph names the header and holds no value of it, and is still provisional.
    #[test]
    fn a_header_seen_once_is_never_kept_in_the_graph() {
        let ex = Exchange {
            method: "GET".into(),
            url: "https://api.shop.example/v1/me".parse().unwrap(),
            request_headers: vec![("authorization".into(), "Bearer tok_dummy_123456".into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"id":1,"name":"x"}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let trace = Trace { exchanges: vec![ex], inputs: vec![] };
        let mut g = build(std::slice::from_ref(&trace), |_| true).unwrap();
        assert!(g.provisional);
        let moved = session_headers(&mut g, &trace);
        assert_eq!(moved, vec![("authorization".to_string(), "Bearer tok_dummy_123456".to_string())]);
        let text = serde_json::to_string(&g).unwrap();
        assert!(!text.contains("tok_dummy_123456"), "{text}");
        assert!(g.steps[0].fields.iter().any(|f| f.loc == Loc::Header("authorization".into()) && f.class == Class::Minted { name: "authorization".into() }));
        assert!(g.provisional, "what the value is, a second sighting still settles");
    }
}

/// Pairs each exchange in `a` with the same request in `b`: same method, host and
/// number of path segments, most segments equal, at least one. Each `b` exchange
/// pairs at most once, so requests that arrive in a different order still pair.
///
/// A pair holds only where each is the other's best: the request of `b` that `a`'s call is most like must itself
/// be most like that call, among all of `a`. Several calls may share an address (the operations of one endpoint),
/// and a walk may never have made one of them: the best of what it did make is then some other call, which is
/// more like its own twin in `a` than like this one. That is no pair, and a call the other walk never made is a
/// call seen once. And a path that differs at a piece the walk cannot source (`find_origin_on`, or what the page
/// was asked) is another address: only a value moves. This is the one reader for "the same call on another walk" (`the_same_call_there`).
fn align(a: &Trace, b: &Trace) -> HashMap<usize, usize> {
    align_asked(a, b, &[], None)
}

/// [`align`] for the learner by example (`lab::sighting`), over whole walks: what `a`'s walk was asked is given
/// (`asked`, the lab keeps no typed inputs), and which calls were answered with something (`answered`). The same
/// reader as `align`, asked with more of what it reads.
pub(crate) fn align_by(a: &Trace, b: &Trace, asked: &[&str], answered: impl Fn(&Exchange) -> bool) -> HashMap<usize, usize> {
    let asked: Vec<String> = asked.iter().map(|v| v.to_string()).collect();
    align_with(a, b, &asked, None, answered)
}

/// `align`, knowing more of what `a` was asked than its typed inputs say (`asked`: the values its page's address
/// carried, which a walk reached by address never typed), and what stands in their place on `b` where that is known
/// (`now`): a piece that is an asked value moved only where `b`'s piece is the value it moved to.
fn align_asked(a: &Trace, b: &Trace, asked: &[String], now: Option<&str>) -> HashMap<usize, usize> {
    align_with(a, b, asked, now, |_| true)
}

/// The one reader of "the same call on another walk", whoever asks it.
///
/// A walk often asks one call twice and is answered the second time (a page held back, then served): the two copies
/// send the same, and the copy that answered nothing would take the other walk's one copy from the copy that
/// answered. So a call that was answered (`answered`) is paired before one that was not, and of two candidates alike
/// in every other way the answered one is taken. Nothing is left out: a copy that answered nothing still pairs with
/// what is left. Where every call counts as answered (the classifier, which cuts its walk to its chain first), this is
/// the pairing as it always was.
fn align_with(a: &Trace, b: &Trace, asked: &[String], now: Option<&str>, answered: impl Fn(&Exchange) -> bool) -> HashMap<usize, usize> {
    // What each request sends, read once: the pieces of its path, and its values with their places.
    let sent = |e: &Exchange| -> Vec<Slot> { slots(e).into_iter().filter(|s| !matches!(s.loc, Loc::Header(_) | Loc::Cookie(_) | Loc::Path(_))).collect() };
    let pieces = |e: &Exchange| -> Vec<String> { e.url.path_segments().map(|s| s.map(String::from).collect()).unwrap_or_default() };
    let (sa, sb): (Vec<Vec<Slot>>, Vec<Vec<Slot>>) = (a.exchanges.iter().map(sent).collect(), b.exchanges.iter().map(sent).collect());
    let (pa, pb): (Vec<Vec<String>>, Vec<Vec<String>>) = (a.exchanges.iter().map(pieces).collect(), b.exchanges.iter().map(pieces).collect());
    // How alike two requests are, when they can be the same request at all: mostly by the pieces of the path they
    // share, then by the values they send alike in the same places (an operation's name, a query's text).
    let alike = |i: usize, j: usize| -> Option<usize> {
        let (ea, eb) = (&a.exchanges[i], &b.exchanges[j]);
        let comparable = ea.method == eb.method && ea.url.host() == eb.url.host() && pa[i].len() == pb[j].len();
        let score = pa[i].iter().zip(&pb[j]).filter(|(x, y)| x == y).count();
        if !(comparable && score >= 1) {
            return None;
        }
        let sent_alike = sa[i].iter().filter(|x| sb[j].iter().any(|y| y.loc == x.loc && y.value == x.value)).count();
        Some((score * 10_000 + sent_alike.min(9_999)) * 2 + usize::from(answered(eb)))
    };
    let mut pairs = HashMap::new();
    let mut used = vec![false; b.exchanges.len()];
    let order: Vec<usize> = (0..a.exchanges.len()).filter(|&i| answered(&a.exchanges[i])).chain((0..a.exchanges.len()).filter(|&i| !answered(&a.exchanges[i]))).collect();
    for i in order {
        // Highest score, and the earliest unused among equals.
        let best = (0..b.exchanges.len()).filter(|j| !used[*j]).filter_map(|j| alike(i, j).map(|score| (score, j))).fold(None, |acc: Option<(usize, usize)>, (score, j)| match acc {
            Some((s, _)) if s >= score => acc,
            _ => Some((score, j)),
        });
        let Some((score, j)) = best else { continue };
        // A piece of the path that differs is a value only where the walk says whose: what the page was asked, or
        // something an earlier answer handed over. One with no such source is the address itself, and two addresses
        // are two calls (`/resource/Search/get/` beside `/resource/Topic/get/`). Asked of the one pair chosen: where
        // a value came from is read from every answer before it.
        // A value of several words may be written into a path with a mark in place of each space (`desk-lamp`,
        // `desk_lamp`): the piece is the value all the same.
        let spaced = |text: &str| text.replace(['-', '_'], " ");
        let is = |piece: &str, value: &str| {
            let plain = percent_encoding::percent_decode_str(piece).decode_utf8_lossy().replace('+', " ");
            let trimmed = plain.trim_matches(|c: char| !c.is_alphanumeric());
            value.chars().count() >= 2 && (plain.eq_ignore_ascii_case(value) || trimmed.eq_ignore_ascii_case(value) || (value.contains(' ') && spaced(trimmed).eq_ignore_ascii_case(value)))
        };
        let a_value = |x: &str, y: &str| {
            let moved = a.inputs.iter().map(|inp| &inp.value).chain(asked).any(|v| is(x, v)) && now.is_none_or(|w| is(y, w));
            moved || find_origin_on(a, i, x, None).is_some()
        };
        if !pa[i].iter().zip(&pb[j]).all(|(x, y)| x == y || a_value(x, y)) {
            continue;
        }
        // Its best must hold it as dear: no call of `a` is more like that request than this one is.
        if (0..a.exchanges.len()).filter_map(|k| alike(k, j)).all(|other| other <= score) {
            pairs.insert(i, j);
            used[j] = true;
        }
    }
    pairs
}

/// The request of `b` that is the same call as `a`'s `i`th, if `b` made it: the one reader for "the same call on
/// another walk" (`align`), for whoever asks it of one call. `asked` is what `a`'s page was asked beyond what was
/// typed in it, and `now` what `b`'s was asked in its place, where the caller knows.
pub fn the_same_call_there(a: &Trace, i: usize, b: &Trace, asked: &[String], now: Option<&str>) -> Option<usize> {
    align_asked(a, b, asked, now).get(&i).copied()
}

fn url_template(ex: &Exchange, fields: &[Field]) -> String {
    // A hole is a value the *caller* (or an earlier answer) fills. A piece the page's own code makes stays as the page
    // made it: a route step that is page-signed is found by the address the page called, and a template hole there sends
    // the signer looking for a URL the page never asks (trip.com's `/restapi/soa2/37106/%7Bpath[3]%7D`, which none of the
    // page's 402 calls was), so the whole chain failed on a step before the target.
    let variable = |loc: &Loc| {
        fields.iter().any(|f| {
            &f.loc == loc
                && matches!(
                    f.class,
                    Class::Input { .. } | Class::Derived { .. } | Class::Piece { .. } | Class::Fresh { .. } | Class::Minted { .. }
                )
        })
    };
    let mut url = format!("{}://{}", ex.url.scheme(), ex.url.host_str().unwrap_or_default());
    if let Some(port) = ex.url.port() {
        url.push_str(&format!(":{port}"));
    }
    for (i, seg) in ex.url.path_segments().into_iter().flatten().enumerate() {
        url.push('/');
        if variable(&Loc::Path(i)) {
            url.push_str(&format!("{{path[{i}]}}"));
        } else {
            url.push_str(seg);
        }
    }
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>();
    let query: Vec<String> = ex
        .url
        .query_pairs()
        .map(|(k, v)| if variable(&Loc::Query(k.to_string())) { format!("{}={{{k}}}", enc(&k)) } else { format!("{}={}", enc(&k), enc(&v)) })
        .collect();
    if !query.is_empty() {
        url.push('?');
        url.push_str(&query.join("&"));
    }
    url
}

fn is_constant(fields: &[Field], loc: &Loc) -> bool {
    fields.iter().any(|f| &f.loc == loc && matches!(f.class, Class::Constant { .. }))
}

fn body_template(ex: &Exchange, fields: &[Field]) -> Option<Body> {
    let body = ex.request_body.as_deref()?;
    // By content, not the declared type: a JSON body labelled as a form must stay
    // JSON, or the replay would send the server an encoded blob.
    match crate::slots::body_kind(ex) {
        crate::slots::BodyKind::Form => {
            let fields = url::form_urlencoded::parse(body.as_bytes())
                .map(|(k, v)| {
                    let keep = is_constant(fields, &Loc::Form(k.to_string()));
                    (k.into_owned(), keep.then(|| v.into_owned()))
                })
                .collect();
            return Some(Body::Form { fields });
        }
        crate::slots::BodyKind::Json => {}
        crate::slots::BodyKind::Multipart => {
            let boundary = crate::slots::boundary(ex)?;
            let parts = crate::slots::parts(ex)
                .unwrap_or_default()
                .into_iter()
                .map(|p| {
                    let json = (p.filename.is_none()).then(|| crate::slots::part_json(&p)).flatten();
                    let mut t = PartTemplate { name: p.name.clone(), filename: p.filename.clone(), content_type: p.content_type.clone(), text: None, json: None, types: BTreeMap::new() };
                    match json {
                        Some(mut template) => {
                            t.types = blank_variables(&mut template, |pointer| is_constant(fields, &Loc::Part(p.name.clone(), pointer.to_string())));
                            t.json = Some(template);
                        }
                        None if p.filename.is_some() || is_constant(fields, &Loc::Part(p.name.clone(), String::new())) => t.text = Some(p.value),
                        None => {}
                    }
                    t
                })
                .collect();
            return Some(Body::Multipart { boundary, parts });
        }
        crate::slots::BodyKind::Other => return Some(Body::Other),
    }
    let Ok(mut template) = serde_json::from_str::<Value>(body) else { return Some(Body::Other) };
    let types = blank_variables(&mut template, |pointer| is_constant(fields, &Loc::Json(pointer.to_string())));
    Some(Body::Json { template, types })
}

/// Blanks every leaf of `template` that isn't constant to `null`, and returns each blanked leaf's JSON type by
/// pointer, so the replay can put a value of the same type back.
fn blank_variables(template: &mut Value, constant: impl Fn(&str) -> bool) -> BTreeMap<String, String> {
    let mut types = BTreeMap::new();
    for (pointer, _) in crate::slots::json_leaves(&template.clone()) {
        if constant(&pointer) {
            continue;
        }
        if let Some(leaf) = template.pointer_mut(&pointer) {
            types.insert(pointer, match leaf { Value::Number(_) => "number", Value::Bool(_) => "bool", _ => "string" }.to_string());
            *leaf = Value::Null;
        }
    }
    types
}

/// Keys and value types of a JSON value, without the values. Arrays keep the
/// union of their items' shapes: entries can carry optional keys (`description`,
/// `thumbnail`), so the first item alone would fail honest answers.
pub fn shape(v: &Value) -> Value {
    match v {
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), shape(v))).collect()),
        Value::Array(items) => {
            let mut merged: Option<Value> = None;
            for item in items.iter().take(20) {
                let s = shape(item);
                merged = Some(match merged {
                    None => s,
                    Some(acc) => merge_shapes(acc, &s),
                });
            }
            Value::Array(merged.into_iter().collect())
        }
        Value::String(_) => "string".into(),
        Value::Number(_) => "number".into(),
        Value::Bool(_) => "bool".into(),
        Value::Null => "null".into(),
    }
}

/// Two shapes of the same kind of thing: keys either had, and nested objects
/// merge the same way.
fn merge_shapes(a: Value, b: &Value) -> Value {
    match (a, b) {
        (Value::Object(mut ma), Value::Object(mb)) => {
            for (k, v) in mb {
                let kept = ma.remove(k);
                ma.insert(k.clone(), match kept {
                    Some(av) => merge_shapes(av, v),
                    None => v.clone(),
                });
            }
            Value::Object(ma)
        }
        (a, _) => a,
    }
}

impl Graph {
    /// Whether `step` is asked for as a page, and not as a call a page's script made: its answer is the page read, or
    /// its reply holds no JSON, or it is a page the browser went to (`visited`). One answer for every caller that
    /// asks it: the request replay builds (`replay::script_shape`) and the body a graph says (`body::step_of`).
    pub fn asks_as_a_page(&self, step: &Step) -> bool {
        step.reads_page || step.response_shape.is_none() || self.visited.contains(&step.exchange)
    }

    /// Whether a step after `n` needs a value from step `n`'s answer. A call whose answer nothing later needs is the
    /// page's own: a route that can't make it can go on without it, as a browser that never made that call would.
    ///
    /// A later step the page signs takes its whole request from the page, so it needs nothing from an earlier answer
    /// except a value in its address — that is how its call is found among the page's. When every later step that reads
    /// from `n` is one the page signs that way, `n`'s answer is not needed at all.
    ///
    /// A value the graph keeps what the walk read for (`Step::fallback`) is sent as the walk read it when a fresh
    /// answer leaves it out, so a later step that holds one does not need `n`'s answer for it: the walk already said
    /// what to send.
    ///
    /// A step the page signs takes its whole request from the page only where the page makes it. Where the page's code
    /// makes no call and the step is a plain read (a GET or a HEAD, nothing written), the replay sends it as the route
    /// builds it, and then every value the route puts in it — its query and its headers as much as its address — is one
    /// the route has to source: a step the page makes whole is the one that takes nothing but an address value.
    pub fn feeds_later(&self, n: usize) -> bool {
        let Some(ex) = self.steps.get(n).map(|s| s.exchange) else { return false };
        // A value read from an earlier answer (`Class::Derived`) is one the route must source wherever it sits — a
        // header or a query as much as a path — unless the page makes the whole request (a page-signed step that is
        // not a plain read) or the walk kept what to send (`Step::fallback`).
        let signed_by_page = |s: &Step| {
            self.page.is_some() && s.is_page_signed()
        };
        let sent_as_built = |s: &Step| {
            let method = s.method.to_ascii_uppercase();
            (method == "GET" || method == "HEAD") && !crate::ledger::writes(s)
        };
        self.steps.iter().skip(n + 1).any(|s| {
            let reads = |f: &Field| matches!(&f.class, Class::Derived { origin } if origin.exchange == ex) && s.fallback(&f.loc).is_none();
            let reads_address = |f: &Field| reads(f) && matches!(f.loc, Loc::Path(_));
            if signed_by_page(s) && !sent_as_built(s) {
                s.fields.iter().any(reads_address)
            } else {
                s.fields.iter().any(reads)
            }
        })
    }

    /// A plain-text view for people reviewing a learned route.
    pub fn describe(&self) -> String {
        let mut out = String::new();
        for (n, step) in self.steps.iter().enumerate() {
            let browser = if step.is_page_signed() { "  [page-signed]" } else if step.needs_browser { "  [needs browser]" } else { "" };
            out.push_str(&format!("{}. {} {}{}\n", n + 1, step.method, step.url, browser));
            if let Some(Body::Upload { input, protocol, .. }) = &step.body {
                out.push_str(&format!("     {:<22} the file input `{input}`, sent as {protocol:?}\n", "body"));
            }
            for f in step.fields.iter().filter(|f| !(matches!(f.loc, Loc::Path(_)) && matches!(f.class, Class::Constant { .. }))) {
                let what = match &f.class {
                    Class::Input { name, secret: true, .. } => format!("input `{name}` (secret: from the vault)"),
                    Class::Input { name, .. } => format!("input `{name}`"),
                    Class::Constant { origin: Some(o), .. } => format!("constant, seen in {}", o.url),
                    Class::Constant { .. } => "constant".into(),
                    Class::Piece { input, from, .. } => format!("piece of `{input}` at {from}"),
                    Class::Derived { origin } => {
                        let from = self.steps.iter().position(|s| s.exchange == origin.exchange).map(|p| p + 1);
                        let at = match &origin.at {
                            At::Json { pointer } => format!("JSON {pointer}"),
                            At::Header { name } => format!("header {name}"),
                            At::HeaderQuery { name, key } => format!("{key} of the address header {name} hands over"),
                            At::SetCookie { name } => format!("Set-Cookie {name}"),
                            At::Text { before, .. } => format!("text after `{}`", before.trim()),
                        };
                        let wrap = origin.wrap.as_ref().map(|(p, s)| format!(" as `{p}{{}}{s}`")).unwrap_or_default();
                        format!("from step {} ({at}){wrap}", from.map_or("?".into(), |f| f.to_string()))
                    }
                    Class::Computed => "computed by the page".into(),
                    Class::Script { producer } => format!("made by the page's code ({} @ {})", producer.script, producer.at),
                    Class::Recipe { recipe } => format!("made by a recipe ({:?} over {} parts, {})", recipe.algo, recipe.parts.len(), recipe.separator),
                    Class::CookieIn { name, .. } => format!("the caller's cookie `{name}` written into the page's value"),
                    Class::Generated { evidence, .. } => format!("made by a generated program ({} sightings, proposed by {})", evidence.sightings, evidence.proposed_by),
                    Class::Minted { name } => format!("browser-minted `{name}` (from the node's session)"),
                    Class::Unconfirmed { value } => format!("provisional constant {value}: needs a second sighting"),
                    Class::Fresh { id, .. } => format!("made anew each call (the walk's was {id})"),
                    Class::File { name, of } => format!("the {} of file input `{name}`", match of {
                        crate::upload::FileFact::Size => "size",
                        crate::upload::FileFact::Name => "name",
                    }),
                };
                out.push_str(&format!("     {:<22} {what}\n", f.loc.to_string()));
            }
            for p in &step.page_producers {
                out.push_str(&format!("     {:<22} the page's own code makes it ({} @ {})\n", p.loc.to_string(), p.producer.script, p.producer.at));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The door is kept as a step of the route: the address the wall stood at in the walk, which need not be the
    /// page the walk began on. It is what the node's engine runs again to earn the pass; the route's own wire never
    /// asks it, so it is no step of the chain.
    #[test]
    fn a_door_is_a_step_the_route_can_run_again() {
        let answer = |url: &str, status: u16, headers: Vec<(&str, &str)>| Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            response_body: Some("<html></html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let walk = Trace {
            exchanges: vec![
                answer("https://shop.example/", 200, vec![]),
                answer("https://shop.example/gate?to=%2Fsearch", 403, vec![("set-cookie", "_abck=abc; Path=/; Max-Age=3600")]),
                answer("https://shop.example/search?q=lamp", 200, vec![]),
            ],
            inputs: vec![],
        };
        let door = Door::met(&walk, "shop.example").expect("a wall");
        assert_eq!(door.at.as_deref(), Some("https://shop.example/gate?to=%2Fsearch"), "the address the wall stood at, not the walk's first page");
        // It survives being written and read back, and a door kept before this was recorded reads with none.
        let kept: Door = serde_json::from_value(serde_json::to_value(&door).unwrap()).unwrap();
        assert_eq!(kept.at, door.at);
        let old: Door = serde_json::from_value(serde_json::json!({"kind": "akamai", "earn": "browser_or_owner"})).unwrap();
        assert_eq!(old.at, None);
    }

    /// A wall is read from what it answered with, never from its host: the vendor's cookie, header or page names the
    /// class; the credential it issued is kept with the life its line gave; and a device-bound one is a browser's to
    /// earn, since the site's own answers never re-issue a working one.
    #[test]
    fn a_wall_is_classed_from_what_it_answered() {
        let answer = |status: u16, headers: Vec<(&str, &str)>, body: &str| Exchange {
            method: "GET".into(),
            url: "https://shop.example/search?q=lamp".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            response_body: Some(body.into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let akamai = Trace {
            exchanges: vec![answer(403, vec![("set-cookie", "_abck=abc; Path=/; Max-Age=3600"), ("set-cookie", "bm_sz=x; Max-Age=3600")], "<html></html>")],
            inputs: vec![],
        };
        let door = Door::met(&akamai, "shop.example").expect("a wall");
        assert_eq!(door.kind, DoorKind::Akamai);
        assert_eq!(door.credential.as_deref(), Some("_abck"));
        assert_eq!(door.ttl, Some(3600), "the line's own life");
        assert_eq!(door.earn, Earn::BrowserOrOwner, "a device-bound credential is a browser's");
        assert_eq!(door.statuses, crate::trace::REFUSED.to_vec());

        let cloudflare = Trace {
            exchanges: vec![answer(403, vec![("cf-ray", "8a1b")], "<html><title>Just a moment...</title></html>")],
            inputs: vec![],
        };
        let door = Door::met(&cloudflare, "shop.example").expect("a wall");
        assert_eq!(door.kind, DoorKind::Cloudflare);

        assert_eq!(door.at.as_deref(), Some("https://shop.example/search?q=lamp"), "where the wall stood");

        // A refusal with no vendor's mark is the site's own rule: no door is claimed, and the values are what the
        // replay has to diagnose.
        let own = Trace { exchanges: vec![answer(403, vec![], "{\"error\":\"forbidden\"}")], inputs: vec![] };
        assert!(Door::met(&own, "shop.example").is_none(), "no vendor's mark is no vendor's door");

        // A call's own answer classifies the same way, without a walk.
        let answered = Door::answered(&answer(403, vec![("set-cookie", "reese84=t; Max-Age=60")], "")).expect("a wall");
        assert_eq!(answered.kind, DoorKind::Radware);
        assert_eq!(answered.ttl, Some(60));
    }

    /// Vercel's Security Checkpoint is a door: a 429 whose page says "Vercel Security Checkpoint" and whose line issues
    /// `_vcrcs`, a device-bound credential a browser earns by running the challenge. Without it the replay's 429 is
    /// read as the site's own rule and no door-pass runs.
    #[test]
    fn a_vercel_security_checkpoint_is_a_door() {
        let ex = Exchange {
            method: "GET".into(),
            url: url::Url::parse("https://shop.example/").unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 429,
            response_headers: vec![("set-cookie".into(), "_vcrcs=abc; Path=/; Max-Age=1800".into())],
            response_body: Some("<html><title>Vercel Security Checkpoint</title>We're verifying your browser</html>".into()),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        let door = Door::answered(&ex).expect("the Vercel checkpoint is a wall");
        assert_eq!(door.kind, DoorKind::Vercel);
        assert_eq!(door.credential.as_deref(), Some("_vcrcs"));
        assert_eq!(door.earn, Earn::BrowserOrOwner, "a device-bound credential is a browser's");
    }

    /// A call is the page's own only when no step after it reads its answer: one a later step takes a value from is
    /// not optional, and the route cannot go on without it.
    #[test]
    fn a_step_that_a_later_one_reads_from_is_not_the_pages_own() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [
                { "exchange": 4, "method": "POST", "status": 200, "url": "https://shop.example/api/a", "needs_browser": false, "fields": [] },
                { "exchange": 5, "method": "POST", "status": 200, "url": "https://shop.example/api/b", "needs_browser": false,
                  "fields": [{ "loc": { "in": "json", "key": "/id" }, "class": "derived",
                               "origin": { "exchange": 4, "url": "https://shop.example/api/a", "at": { "from": "json", "pointer": "/id" } } }] },
                { "exchange": 6, "method": "POST", "status": 200, "url": "https://shop.example/api/c", "needs_browser": false, "fields": [] }
            ],
            "provisional": false
        }))
        .unwrap();
        assert!(graph.feeds_later(0), "b reads its answer");
        assert!(!graph.feeds_later(1), "nothing after b reads it");
        assert!(!graph.feeds_later(2), "the target feeds nothing");
    }

    /// A value a later step reads from an earlier answer needs that answer wherever the value sits — a header as much
    /// as a path — even when the later step is the page's own signed call. The signing bridge re-makes the page's
    /// *computed* values, but a value read from the site's response (a tenant id, a business unit) comes from a call
    /// the route must make: skip its source and the signed call has nothing to read.
    #[test]
    fn a_page_signed_step_that_reads_a_header_from_an_earlier_answer_still_needs_its_source() {
        let graph: Graph = serde_json::from_value(serde_json::json!({
            "page": "https://shop.example/search?q={q}",
            "steps": [
                { "exchange": 4, "method": "GET", "status": 200, "url": "https://shop.example/api/bootstrap", "needs_browser": false, "fields": [] },
                { "exchange": 5, "method": "GET", "status": 200, "url": "https://shop.example/api/search", "needs_browser": false, "page_signed": true,
                  "fields": [{ "loc": { "in": "header", "key": "x-o-bu" }, "class": "derived",
                               "origin": { "exchange": 4, "url": "https://shop.example/api/bootstrap", "at": { "from": "json", "pointer": "/bu" } } }] }
            ],
            "provisional": false
        }))
        .unwrap();
        assert!(graph.feeds_later(0), "the signed search reads bootstrap's answer into a header; its source is not optional");
        // A page-signed step that reads nothing from the source still leaves it the page's own.
        let alone: Graph = serde_json::from_value(serde_json::json!({
            "page": "https://shop.example/search?q={q}",
            "steps": [
                { "exchange": 4, "method": "GET", "status": 200, "url": "https://shop.example/api/bootstrap", "needs_browser": false, "fields": [] },
                { "exchange": 5, "method": "GET", "status": 200, "url": "https://shop.example/api/search", "needs_browser": false, "page_signed": true, "fields": [] }
            ],
            "provisional": false
        }))
        .unwrap();
        assert!(!alone.feeds_later(0), "nothing reads bootstrap's answer");
    }

    /// A step the page signs takes its whole request from the page only where the page makes it. A plain read (a GET,
    /// nothing written) the page's code makes no call for is sent as the route builds it, so every value the route
    /// puts in it — its query and its headers as much as its address — is one it has to source. A POST is the page's
    /// whole, and only an address value keeps the earlier answer. Measured on a site whose search call is signed by
    /// the page and sent plain: skipping the page left `source_url` out and the site answered "Invalid Resource
    /// Request".
    #[test]
    fn a_page_signed_step_sent_as_built_needs_the_values_its_route_puts_in_it() {
        let mut graph: Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "page": "https://shop.example/search",
            "steps": [
                { "exchange": 4, "method": "GET", "status": 200, "url": "https://shop.example/search?q=lamp", "needs_browser": false, "fields": [] },
                { "exchange": 5, "method": "GET", "status": 200, "url": "https://shop.example/api/find?src={src}", "page_signed": true, "needs_browser": true,
                  "fields": [{ "loc": { "in": "query", "key": "src" }, "class": "derived",
                               "origin": { "exchange": 4, "url": "https://shop.example/search?q=lamp", "at": { "from": "text", "before": "pinterest:/", "after": "\"", "nth": 0 } } }] }
            ]
        }))
        .unwrap();
        assert!(graph.feeds_later(0), "a page-signed GET sent as built needs what its route puts in it");
        graph.steps[1].method = "POST".into();
        assert!(!graph.feeds_later(0), "a page-signed POST takes its whole request from the page");
    }

    /// A later step that holds what the walk read for a value (`Step::fallback`) sends that value when a fresh answer
    /// leaves the place out: it does not need the earlier answer, and the step that gave it is the page's own.
    #[test]
    fn a_value_the_walk_read_does_not_make_an_earlier_answer_needed() {
        let mut graph: Graph = serde_json::from_value(serde_json::json!({
            "steps": [
                { "exchange": 4, "method": "GET", "status": 200, "url": "https://shop.example/search?q=lamp", "needs_browser": false, "fields": [] },
                { "exchange": 5, "method": "POST", "status": 200, "url": "https://shop.example/api/b", "needs_browser": false,
                  "fields": [{ "loc": { "in": "header", "key": "x-app" }, "class": "derived",
                               "origin": { "exchange": 4, "url": "https://shop.example/search?q=lamp", "at": { "from": "text", "before": "<meta name=\"app-name\" content=\"", "after": "\"", "nth": 0 } } }] }
            ],
            "provisional": false
        }))
        .unwrap();
        assert!(graph.feeds_later(0), "b reads the page's answer");
        graph.steps[1].fallbacks = vec![(Loc::Header("x-app".into()), "seo_landing_page".into())];
        assert!(!graph.feeds_later(0), "b holds what the walk read, so the page's answer is not needed");
    }

    /// A date and a time the call sends are pieces of the date-time the page was asked for: a call for another day
    /// asks for that day, not the one that was walked. A short value (`2`, `true`) is every call's own setting, and a
    /// piece that repeats in the caller's value says nothing about which occurrence the call meant.
    #[test]
    fn a_date_and_a_time_are_pieces_of_what_the_caller_asked() {
        let mut page = walked("GET", "https://book.example/s/?dateTime=2026-11-12T19:00:00&covers=2", &[], None, "<html></html>");
        page.response_mime = "text/html".into();
        let mut call = walked(
            "POST",
            "https://book.example/api/availability",
            &[("content-type", "application/json")],
            None,
            r#"{"data":{"availability":[{"restaurantId":1}]}}"#,
        );
        call.request_body = Some(r#"{"date":"2026-11-12","time":"19:00","partySize":2}"#.into());
        let inputs = vec![
            crate::trace::Input::new("dateTime", "2026-11-12T19:00:00"),
            crate::trace::Input::new("covers", "2"),
        ];
        let walk = Trace { exchanges: vec![page, call], inputs };
        let g = build(&[walk], |e| e.url.path() == "/api/availability").unwrap();
        let step = g.steps.last().unwrap();
        let class = |pointer: &str| step.fields.iter().find(|f| f.loc == Loc::Json(pointer.into())).map(|f| f.class.clone());
        assert_eq!(class("/date"), Some(Class::Piece { input: "dateTime".into(), from: 0, len: 10 }));
        assert_eq!(class("/time"), Some(Class::Piece { input: "dateTime".into(), from: 11, len: 5 }));
        // A one-character value under another key (`partySize` beside the page's `covers`) is the call's own setting:
        // the engine cannot know the two name the same thing.
        assert_eq!(class("/partySize"), Some(Class::Constant { value: "2".into(), origin: None }));
    }

    /// A piece names the caller's value it came from only when it sits there once: a piece that repeats says nothing
    /// about which occurrence the call meant, and a piece shorter than four characters is any call's own setting.
    #[test]
    fn a_piece_of_a_caller_value_must_sit_there_once() {
        let inputs = vec![
            crate::trace::Input::new("dateTime", "2026-11-12T19:00:00"),
            crate::trace::Input::new("repeat", "2026/2026"),
        ];
        let trace = Trace { exchanges: Vec::new(), inputs };
        assert_eq!(piece_of_an_input(&trace, "2026-11-12"), Some(("dateTime".into(), 0)));
        assert_eq!(piece_of_an_input(&trace, "19:00"), Some(("dateTime".into(), 11)));
        assert_eq!(piece_of_an_input(&trace, "2026"), Some(("dateTime".into(), 0)), "the year sits there once");
        assert_eq!(piece_of_an_input(&trace, "2026/2026"), None, "a caller's value is not a piece of itself");
        assert_eq!(piece_of_an_input(&trace, "11"), None, "too short to name anything");
    }

    /// The browser's own shape rides with the call: the client hints it sent (including what a site asked for with
    /// `Accept-CH`), its fetch metadata, its priority and accepted languages are the walk's word, kept as constants, so
    /// a replay presents the shape the site was shown instead of guessing one. The session's cookie, the transport's
    /// framing and the identity are not carried.
    #[test]
    fn the_browsers_own_shape_rides_with_the_call() {
        let ex = walked(
            "POST",
            "https://shop.example/api/search",
            &[
                ("accept", "*/*"),
                ("accept-language", "en-GB,en;q=0.9"),
                ("priority", "u=1, i"),
                ("sec-ch-ua", "\"Chromium\";v=\"156\", \"Not.A/Brand\";v=\"99\""),
                ("sec-ch-ua-arch", "\"arm\""),
                ("sec-ch-ua-platform", "\"macOS\""),
                ("sec-fetch-site", "same-origin"),
                ("sec-fetch-mode", "cors"),
                ("user-agent", "Mozilla/5.0 (a browser)"),
                ("cookie", "sid=s-123"),
                ("content-length", "2"),
            ],
            None,
            r#"{"items":[1]}"#,
        );
        let walk = Trace { exchanges: vec![ex], inputs: Vec::new() };
        let g = build(&[walk], |e| e.url.path() == "/api/search").unwrap();
        let step = &g.steps[0];
        let value = |name: &str| step.fields.iter().find(|f| f.loc == Loc::Header(name.into())).map(|f| match &f.class {
            Class::Constant { value, .. } => value.as_str(),
            other => panic!("{name} is not the walk's own word: {other:?}"),
        });
        assert_eq!(value("accept"), Some("*/*"), "the walk's accept, not a guess");
        assert_eq!(value("accept-language"), Some("en-GB,en;q=0.9"));
        assert_eq!(value("priority"), Some("u=1, i"));
        assert_eq!(value("sec-ch-ua-arch"), Some("\"arm\""), "a hint the site asked for with Accept-CH");
        assert_eq!(value("sec-fetch-site"), Some("same-origin"));
        for name in ["user-agent", "cookie", "content-length"] {
            assert!(!step.fields.iter().any(|f| f.loc == Loc::Header(name.into())), "{name} is not the route's to carry");
        }
    }

    /// The page a call was made from rides with it: the walked `referer` is the route's constant, and the caller's word
    /// inside it is swapped like any other value (IEEE Xplore's `/rest/search` wants the search page's address, which
    /// the generic `https://host/` is not).
    #[test]
    fn the_page_a_call_was_made_from_rides_with_it() {
        let page = walked("GET", "https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=antenna", &[], None, "<html></html>");
        let mut call = walked(
            "POST",
            "https://ieeexplore.ieee.org/rest/search",
            &[
                ("content-type", "application/json"),
                ("accept", "application/json, text/plain, */*"),
                ("referer", "https://ieeexplore.ieee.org/search/searchresult.jsp?queryText=antenna"),
                ("x-security-request", "required"),
            ],
            None,
            r#"{"records":[{"title":"antenna"}]}"#,
        );
        call.request_body = Some(r#"{"queryText":"antenna","highlight":true}"#.into());
        let walk = Trace { exchanges: vec![page, call], inputs: vec![crate::trace::Input::new("queryText", "antenna")] };
        let g = build(&[walk], |e| e.url.path() == "/rest/search").unwrap();
        let step = g.steps.last().unwrap();
        let referer = step.fields.iter().find(|f| f.loc == Loc::Header("referer".into())).expect("the page it was made from");
        assert!(matches!(referer.class, Class::Constant { .. }), "{:?}", referer.class);
        let held = step.held.iter().find(|h| h.loc == Loc::Header("referer".into()) && h.input == "queryText");
        assert!(held.is_some(), "the caller's word inside the address: {:?}", step.held);
    }

    /// A caller's word that the site's own call carries *inside* a longer value is the caller's too, and is written
    /// into that value for the next call: a search's word rides in a GraphQL `variables` JSON in the query string
    /// (`?operationName=SearchQuery&variables={"query":"gaza"}`), so the route keeps the JSON and swaps the word,
    /// rather than freezing the walk's search as the route's (`Step::held`).
    #[test]
    fn a_word_inside_a_json_in_a_query_is_the_callers_word() {
        let page = walked("GET", "https://www.news.example/search/gaza", &[], None, "<html></html>");
        let variables = r#"{"query":"gaza","start":1,"sort":"relevance"}"#;
        let url = format!(
            "https://www.news.example/graphql?wp-site=aje&operationName=SearchQuery&variables={}&extensions={{}}",
            url::form_urlencoded::byte_serialize(variables.as_bytes()).collect::<String>()
        );
        let call = walked("GET", &url, &[("accept", "*/*")], None, r#"{"data":{"searchPosts":[]}}"#);
        let walk = Trace { exchanges: vec![page, call], inputs: vec![crate::trace::Input::new("q", "gaza")] };
        let g = build(&[walk], |e| e.url.path() == "/graphql").unwrap();
        let step = g.steps.last().unwrap();
        let held = step.held.iter().find(|h| h.input == "q").unwrap_or_else(|| panic!("no held word: {:?}", step.held));
        assert_eq!(held.sits, "gaza");
        assert_eq!(held.loc, Loc::Query("variables".into()));
        assert_eq!(held.written, Written::Json);
        // The route's own address keeps the JSON as it was walked, with the word inside it, not blanked or frozen.
        assert!(step.url.contains("variables="), "{}", step.url);
    }

    /// A caller's word that the site's own call carries in a POST JSON body is the caller's input, not the walk's
    /// constant: a search API that takes its query in the body (`{"q":"innodb"}`, mysql.com's Oracle search) is asked
    /// for another word by the same route. The body template blanks it and the replay writes what the caller sends.
    #[test]
    fn a_value_in_a_json_body_is_the_callers_input() {
        let page = walked("GET", "https://www.mysql.com/search/?q=innodb", &[], None, "<html></html>");
        let mut call = walked(
            "POST",
            "https://search-api.oracle.com/api/latest/qsearch",
            &[("content-type", "application/json"), ("accept", "application/json, text/plain, */*")],
            None,
            r#"{"searchQuery":"innodb","total":42}"#,
        );
        call.request_body = Some(r#"{"q":"innodb","size":10,"offset":0}"#.into());
        call.response_mime = "application/json".into();
        let walk = Trace { exchanges: vec![page, call], inputs: vec![crate::trace::Input::new("q", "innodb")] };
        let g = build(&[walk], |e| e.url.path().contains("qsearch")).unwrap();
        let step = g.steps.last().unwrap();
        let field = step.fields.iter().find(|f| f.loc == Loc::Json("/q".into())).expect("the body's q is a field");
        assert!(matches!(field.class, Class::Input { .. }), "the caller's word, not the walk's: {:?}", field.class);
        let template = match step.body.as_ref().expect("a body") {
            Body::Json { template, .. } => template.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(template.pointer("/q"), Some(&Value::Null), "the walk's word is not sent: {template}");
        // The other body values are still the call's own settings.
        assert_eq!(template.pointer("/size"), Some(&serde_json::json!(10)));
    }

    fn walked(method: &str, url: &str, sent: &[(&str, &str)], set_cookie: Option<&str>, body: &str) -> Exchange {
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: sent.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: None,
            status: 200,
            response_headers: set_cookie.map(|c| ("set-cookie".to_string(), c.to_string())).into_iter().collect(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        }
    }

    /// An id the page's own code made up (a clock reading) is told to the site once — by the first call of its own that
    /// carried it — not by every call of the page that happened to carry it afterwards. A visitor id rides on every
    /// request: keeping them all made Trip.com's route 22 steps for one search, of which the target read only the page.
    #[test]
    fn an_id_the_page_made_up_is_told_to_the_site_once() {
        let id = crate::fresh::make(crate::fresh::Clock::Millis, 5);
        let mut page = walked("GET", "https://shop.example/search", &[], None, "<html></html>");
        page.response_mime = "text/html".into();
        page.resource_type = Some("Document".into());
        page.main_frame = Some(true);
        let call = |path: &str| walked("POST", &format!("https://shop.example{path}?vid={id}"), &[], None, r#"{"ok":1}"#);
        let trace = Trace {
            exchanges: vec![page, call("/api/a"), call("/api/b"), call("/api/c"), call("/api/cart")],
            inputs: Vec::new(),
        };
        let g = build(&[trace], |e| e.url.path() == "/api/cart").unwrap();
        let urls: Vec<&str> = g.steps.iter().map(|s| s.url.as_str()).collect();
        assert_eq!(g.steps.len(), 2, "the first call that told the site the id, and the target: {urls:?}");
        assert!(urls[0].contains("/api/a"), "{urls:?}");
        assert!(urls[1].contains("/api/cart"), "{urls:?}");
    }

    /// Steps in the order they run, by path, for a walk whose target takes a value from each of the two steps before it.
    fn order_of(first: (&str, &str, Option<&str>), second: (&str, &str, Option<&str>)) -> Vec<String> {
        let (a, b) = ("tok_a8f3c91d7e42", "tok_b5d2e70a1c33");
        let walk = Trace {
            exchanges: vec![
                walked(first.0, first.1, &[], first.2, &format!(r#"{{"a":"{a}"}}"#)),
                walked(second.0, second.1, &[], second.2, &format!(r#"{{"b":"{b}"}}"#)),
                walked("GET", "https://shop.example/api/items", &[("x-a", a), ("x-b", b)], None, r#"{"items":[1]}"#),
            ],
            inputs: Vec::new(),
        };
        let g = build(&[walk], |e| e.url.path() == "/api/items").unwrap();
        g.steps.iter().map(|s| s.url.split("example").nth(1).unwrap_or_default().to_string()).collect()
    }

    /// What establishes a session is what the step did on the walk. Whatever a site calls its sign-in, a write that
    /// answered with a cookie runs first; a guestbook that sets none, and a read that hands one out, keep their place.
    #[test]
    fn a_step_establishes_the_session_by_what_it_did_not_what_it_is_called() {
        let cookie = Some("sid=dummy_session_1; Path=/");
        let read = ("GET", "https://shop.example/api/config", None);
        for signin in ["https://shop.example/account/signin", "https://shop.example/auth/session", "https://shop.example/connexion"] {
            let order = order_of(read, ("POST", signin, cookie));
            assert!(signin.ends_with(&order[0]), "{signin} goes first: {order:?}");
        }
        let order = order_of(read, ("POST", "https://shop.example/api/guestbook", None));
        assert_eq!(order[0], "/api/config", "a write that set no cookie keeps its place");
        let order = order_of(read, ("GET", "https://shop.example/api/guest-count", cookie));
        assert_eq!(order[0], "/api/config", "a read that hands out a cookie keeps its place");
    }

    /// A sign-up and a token renewal make the session as a sign-in does, read from what each did: the sign-up sent the
    /// password the owner typed, and set no cookie; the renewal handed back the bearer token the route's call signs
    /// with. Each runs before the calls that stand on it, and the call it signs names it as the token's source: the
    /// edge a route keeps to the call that makes its session.
    #[test]
    fn a_sign_up_and_a_token_renewal_make_the_session_the_route_stands_on() {
        let (a, b) = ("tok_a8f3c91d7e42", "tok_b5d2e70a1c33");
        let json = [("content-type", "application/json")];
        let config = walked("GET", "https://shop.example/api/config", &[], None, &format!(r#"{{"a":"{a}"}}"#));
        let mut sign_up = walked("POST", "https://shop.example/api/accounts", &json, None, &format!(r#"{{"b":"{b}"}}"#));
        sign_up.request_body = Some(r#"{"email":"ann@mail.example","password":"hunter2x-Q7"}"#.into());
        let items = walked("GET", "https://shop.example/api/items", &[("x-a", a), ("x-b", b)], None, r#"{"items":[1]}"#);
        let walk = Trace { exchanges: vec![config.clone(), sign_up, items], inputs: vec![crate::trace::Input::secret("password", "hunter2x-Q7")] };
        let g = build(&[walk], |e| e.url.path() == "/api/items").unwrap();
        let paths: Vec<&str> = g.steps.iter().map(|s| s.url.split("example").nth(1).unwrap_or_default()).collect();
        assert_eq!(paths.first(), Some(&"/api/accounts"), "the sign-up goes first: {paths:?}");
        let sign_up = &g.steps[0];
        assert!(!sign_up.sets_cookie, "it set no cookie: the secret it sent is what made the session");
        assert!(sign_up.fields.iter().any(|f| matches!(&f.class, Class::Input { secret: true, .. })), "the password stays the vault's to fill");

        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI0MiIsImV4cCI6MTc5NDM5ODQwMH0.c2lnbmVkLWJ5LXRoZS1zaXRl";
        let renew = walked("POST", "https://shop.example/oauth/token", &json, None, &format!(r#"{{"access_token":"{token}","expires_in":3600}}"#));
        let bearer = format!("Bearer {token}");
        let items = walked("GET", "https://shop.example/api/items", &[("x-a", a), ("authorization", bearer.as_str())], None, r#"{"items":[1]}"#);
        let walk = Trace { exchanges: vec![config, renew, items], inputs: Vec::new() };
        let g = build(&[walk], |e| e.url.path() == "/api/items").unwrap();
        let paths: Vec<&str> = g.steps.iter().map(|s| s.url.split("example").nth(1).unwrap_or_default()).collect();
        assert_eq!(paths.first(), Some(&"/oauth/token"), "the renewal goes first: {paths:?}");
        let target = g.steps.last().unwrap();
        let auth = target.fields.iter().find(|f| matches!(&f.loc, Loc::Header(h) if h.eq_ignore_ascii_case("authorization"))).expect("the call's token is a field");
        match &auth.class {
            Class::Derived { origin } => assert_eq!(origin.exchange, g.steps[0].exchange, "the token comes from the renewal"),
            other => panic!("the token is taken from the renewal's answer, not {other:?}"),
        }
    }


    fn page_and_api(pxhd: &str) -> Trace {
        let page = Exchange {
            method: "GET".into(),
            url: "https://shop.example/app".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: None,
            main_frame: None,
        };
        let api = Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("cookie".into(), format!("_pxhd={pxhd}"))],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        Trace { exchanges: vec![page, api], inputs: vec![] }
    }

    /// A cookie the site set before the capture started differs between sightings with no
    /// response source: it is a session value the node's browsing minted, not a value the
    /// page computes, so the step does not need a browser.
    #[test]
    fn a_cookie_from_before_the_capture_is_minted() {
        let a = page_and_api("px_aaa_111111");
        let b = page_and_api("px_bbb_222222");
        let g = build(&[a, b], |e| e.url.path() == "/api/p/list").unwrap();
        let target = g.steps.last().unwrap();
        let field = target.fields.iter().find(|f| f.loc == Loc::Cookie("_pxhd".into())).unwrap();
        assert_eq!(field.class, Class::Minted { name: "_pxhd".into() });
        assert!(!target.needs_browser, "a minted cookie does not send the step to a browser");
        assert!(!g.provisional);
    }

    fn call(method: &str, url: &str, cookie: Option<&str>, body: Option<(&str, &str)>, set_cookie: Option<&str>) -> Exchange {
        let mut request_headers: Vec<(String, String)> = cookie.map(|c| ("cookie".to_string(), c.to_string())).into_iter().collect();
        if let Some((kind, _)) = body {
            request_headers.push(("content-type".into(), kind.into()));
        }
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers,
            request_body: body.map(|(_, b)| b.to_string()),
            status: 200,
            response_headers: set_cookie.map(|c| ("set-cookie".to_string(), format!("{c}; Path=/"))).into_iter().collect(),
            response_body: Some(r#"{"items":[{"id":1}]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: Some(true),
        }
    }

    /// A walked page's `?sort.ascending=false`, and a sign-in widget's status call on it sending
    /// `has_opted_out_fedcm=false`: the same flag is no sign the call sends the caller's value. Under its own name it
    /// still is the caller's, and a value that isn't a flag binds by value under any name, as before.
    #[test]
    fn a_flag_under_another_name_is_the_calls_own_setting() {
        let target = call("GET", "https://accounts.widget.example/status?client_id=abc123&has_opted_out=false&ascending=false&q=desk", None, None, None);
        let inputs = vec![crate::trace::Input::new("sort.ascending", "false"), crate::trace::Input::new("ascending", "false"), crate::trace::Input::new("keyword", "desk")];
        let trace = Trace { exchanges: vec![target], inputs };
        let graph = build(&[trace], |e| e.url.path() == "/status").unwrap();
        let class = |key: &str| graph.steps[0].fields.iter().find(|f| f.loc == Loc::Query(key.into())).map(|f| f.class.clone()).unwrap();
        assert!(!matches!(class("has_opted_out"), Class::Input { .. }), "{:?}", class("has_opted_out"));
        assert!(matches!(class("ascending"), Class::Input { name, .. } if name == "ascending"));
        assert!(matches!(class("q"), Class::Input { name, .. } if name == "keyword"));
        let store_inputs: Vec<String> = graph.steps.iter().flat_map(|s| &s.fields).filter_map(|f| match &f.class { Class::Input { name, .. } => Some(name.clone()), _ => None }).collect();
        assert!(!store_inputs.contains(&"sort.ascending".to_string()), "no input the call never sends under its name");
    }

    #[test]
    fn redirected_search_path_keeps_query_as_input_when_case_changes() {
        let target = call("GET", "https://en.example/wiki/Planet", None, None, None);
        let trace = Trace { exchanges: vec![target], inputs: vec![crate::trace::Input::new("search", "planet")] };
        let graph = build(&[trace], |e| e.url.path() == "/wiki/Planet").unwrap();
        let field = graph.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Path(1)).unwrap();
        assert!(matches!(&field.class, Class::Input { name, .. } if name == "search"));
    }

    #[test]
    fn a_cookie_from_a_step_only_a_browser_makes_is_minted() {
        let trace = Trace {
            exchanges: vec![
                call("POST", "https://shop.example/x7f3/q9", None, Some(("text/plain", "aG9zdD1zaG9wJnQ9MTcwOTk5OTk5OSZtPTM4Mg==")), Some("clear=c_9f8e7d6c5b4a")),
                call("GET", "https://shop.example/api/items", Some("clear=c_9f8e7d6c5b4a"), None, None),
            ],
            inputs: vec![],
        };
        let g = build(&[trace], |e| e.url.path() == "/api/items").unwrap();
        assert_eq!(g.steps.len(), 1, "the door's step is not replayed");
        let field = g.steps[0].fields.iter().find(|f| f.loc == Loc::Cookie("clear".into())).unwrap();
        assert_eq!(field.class, Class::Minted { name: "clear".into() });
    }

    /// The walk that exposed it: a news search that sends, in a header, a token the page got from a challenge's
    /// reload, a call whose body is an opaque blob. The route had that reload as a step and failed at it every time.
    /// A value from a call the route cannot write is the page's to make: the reload is no step, and the search needs
    /// the page.
    #[test]
    fn a_value_from_a_call_the_route_cannot_write_is_the_pages_to_make() {
        let token = "03AFcWeA7mG2kq9vXtR5nB8yLpZ1dQ4sU6wJ0hC3eK";
        let mut reload = call("POST", "https://challenge.example/reload?k=site", None, Some(("application/x-protobuffer", "\u{1}\u{8}opaque\u{0}blob\u{7f}")), None);
        reload.response_body = Some(format!(r#"["rresp","{token}",null,120]"#));
        let search = walked("GET", "https://news.example/graphql?operationName=Search", &[("challenge-token", token)], None, r#"{"data":{"posts":[{"title":"a"}]}}"#);
        let trace = Trace { exchanges: vec![reload, search], inputs: vec![] };
        let g = build(&[trace], |e| e.url.path() == "/graphql").unwrap();
        assert_eq!(g.steps.len(), 1, "the reload is not replayed");
        assert!(g.steps[0].needs_browser, "the search needs the page");
    }

    /// The walk that exposed it: a recipe search at `/search/chicken-`, the site's own dash after the word. The piece
    /// is a hole that holds the word: the route's address leaves it open, and the word is swapped inside the marks.
    #[test]
    fn a_word_in_the_sites_own_marks_is_held_in_its_piece_of_the_address() {
        let page = call("GET", "https://www.recipes.example/search/chicken-", None, None, None);
        let trace = Trace { exchanges: vec![page], inputs: vec![crate::trace::Input::new("search", "chicken")] };
        let g = build(&[trace], |e| e.url.path().starts_with("/search/")).unwrap();
        let step = g.steps.last().unwrap();
        assert_eq!(step.url, "https://www.recipes.example/search/{path[1]}");
        assert_eq!(step.held, [Held { loc: Loc::Path(1), input: "search".into(), sits: "chicken".into(), written: Written::Plain, inside: None }]);
    }

    /// A step that takes what the caller typed is the caller's, not the door's: the session it opens is replayed.
    #[test]
    fn a_cookie_from_the_callers_own_step_is_derived() {
        let trace = Trace {
            exchanges: vec![
                call("POST", "https://shop.example/account/enter", None, Some(("application/x-www-form-urlencoded", "user=ana_lim&pass=hunter22")), Some("sid=s_1a2b3c4d5e6f")),
                call("GET", "https://shop.example/api/items", Some("sid=s_1a2b3c4d5e6f"), None, None),
            ],
            inputs: vec![crate::trace::Input::new("user", "ana_lim"), crate::trace::Input::new("pass", "hunter22")],
        };
        let g = build(&[trace], |e| e.url.path() == "/api/items").unwrap();
        assert_eq!(g.steps.len(), 2, "the caller's step stays in the route");
        let field = g.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Cookie("sid".into())).unwrap();
        assert!(matches!(field.class, Class::Derived { .. }));
    }

    /// The two sightings issued their shared requests in a different order; the
    /// pairing must still match them, so the path segment they share is constant.
    #[test]
    fn reordered_requests_still_pair() {
        let page = |v: &str| Exchange {
            method: "GET".into(),
            url: format!("https://shop.example/x/{v}").parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: None,
            main_frame: None,
        };
        let api = Exchange {
            method: "GET".into(),
            url: "https://shop.example/api/list".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        let a = Trace { exchanges: vec![page("AAA"), api.clone()], inputs: vec![] };
        let b = Trace { exchanges: vec![api, page("BBB")], inputs: vec![] };
        let g = build(&[a, b], |e| e.url.path() == "/api/list").unwrap();
        let target = g.steps.last().unwrap();
        let field = target.fields.iter().find(|f| f.loc == Loc::Path(1)).unwrap();
        assert!(matches!(field.class, Class::Constant { .. }), "the shared segment is the route's address");
        assert!(!target.needs_browser);
    }
}

#[cfg(test)]
mod header_minted_tests {
    use super::*;

    /// A header token that appears in no response but travels with the session
    /// (Carousell's csrf-token) is minted, not computed: the step stays replayable.
    #[test]
    fn a_session_header_token_is_minted() {
        let page = Exchange {
            method: "GET".into(),
            url: "https://shop.example/app".parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("<html>shop</html>".into()),
            response_mime: "text/html".into(),
            resource_type: None,
            main_frame: None,
        };
        let api = |csrf: &str| Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("csrf-token".into(), csrf.into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        let a = Trace { exchanges: vec![page.clone(), api("tok_aaa_111111")], inputs: vec![] };
        let b = Trace { exchanges: vec![page, api("tok_bbb_222222")], inputs: vec![] };
        let g = build(&[a, b], |e| e.url.path() == "/api/p/list").unwrap();
        let target = g.steps.last().unwrap();
        let field = target.fields.iter().find(|f| f.loc == Loc::Header("csrf-token".into())).unwrap();
        assert_eq!(field.class, Class::Minted { name: "csrf-token".into() });
        assert!(!target.needs_browser, "a minted header does not send the step to a browser");
    }

    /// A value the second walk sent otherwise was made for each walk, however its letters fall: a signature the page
    /// hashes can come out all letters (`bfcdebca`), and read as a word it was sent again as it was, and refused. A
    /// word both walks sent alike stays the call's own.
    #[test]
    fn a_value_the_second_walk_sent_otherwise_is_never_a_constant() {
        let call = |sig: &str, kind: &str, mode: &str| Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/order".parse().unwrap(),
            request_headers: vec![("x-sig".into(), sig.into())],
            request_body: Some(format!(r#"{{"kind":"{kind}","mode":"{mode}"}}"#)),
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"ok":true}"#.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let a = Trace { exchanges: vec![call("bfcdebca", "parcel", "Express")], inputs: vec![] };
        let b = Trace { exchanges: vec![call("dacefbbe", "letter", "Express")], inputs: vec![] };
        let g = build(&[a, b], |e| e.url.path() == "/api/order").unwrap();
        let class = |loc: Loc| g.steps.last().unwrap().fields.iter().find(|f| f.loc == loc).map(|f| f.class.clone()).unwrap();
        assert_eq!(class(Loc::Header("x-sig".into())), Class::Minted { name: "x-sig".into() });
        assert_eq!(class(Loc::Json("/kind".into())), Class::Computed);
        assert!(matches!(class(Loc::Json("/mode".into())), Class::Constant { value, .. } if value == "Express"));
    }

    /// One sighting is enough for an anti-forgery header: it is the session's, not a value to confirm.
    #[test]
    fn one_sighting_of_a_csrf_header_is_minted() {
        let api = Exchange {
            method: "POST".into(),
            url: "https://shop.example/api/p/list".parse().unwrap(),
            request_headers: vec![("csrf-token".into(), "tok_aaa_111111".into())],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(r#"{"items":[]}"#.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        };
        let g = build(&[Trace { exchanges: vec![api], inputs: vec![] }], |e| e.url.path() == "/api/p/list").unwrap();
        let field = g.steps[0].fields.iter().find(|f| f.loc == Loc::Header("csrf-token".into())).unwrap();
        assert_eq!(field.class, Class::Minted { name: "csrf-token".into() });
    }
}

#[cfg(test)]
mod page_read_tests {
    use super::*;

    /// The walk that exposed it: a shop whose page keeps a visitor id in a cookie for its own host and writes it into
    /// a call to another of its hosts. Named as the session's, the id was looked for in that host's jar, which never
    /// held the cookie, and the call went out without it: "required argument not specified", one learn in five. A
    /// value is the session's by a cookie only where the browser sends that cookie to the call's own host.
    #[test]
    fn a_cookie_another_host_keeps_does_not_name_a_calls_value_as_the_sessions() {
        let visit = |cookie_on_the_calls_host: bool| {
            let mut page = ex("GET", "https://www.shop.example/s?q=lamp", "text/html", "<html><body><div id=app></div></body></html>", None);
            page.request_headers = vec![("cookie".into(), "visitor_id=01A1D3A1CAD102009F00CFE6234A6754".into())];
            let mut call = ex("GET", "https://api.shop.example/v1/search?q=lamp&visitor_id=01A1D3A1CAD102009F00CFE6234A6754", "application/json", r#"{"products":[{"title":"brass lamp"},{"title":"desk lamp"}]}"#, None);
            if cookie_on_the_calls_host {
                call.request_headers = vec![("cookie".into(), "visitor_id=01A1D3A1CAD102009F00CFE6234A6754".into())];
            }
            Trace { exchanges: vec![page, call], inputs: vec![crate::trace::Input::new("q", "lamp")] }
        };
        let class_of = |t: &Trace| build(std::slice::from_ref(t), |e: &Exchange| e.url.path() == "/v1/search").unwrap().steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Query("visitor_id".into())).map(|f| f.class.clone()).unwrap();
        assert!(!matches!(class_of(&visit(false)), Class::Minted { .. }), "kept as the walk sent it: {:?}", class_of(&visit(false)));
        assert!(matches!(class_of(&visit(true)), Class::Minted { .. }), "sent to this host, it is the jar's: {:?}", class_of(&visit(true)));
    }

    /// The walk that exposed it: a games site whose search call carries a `sessionId` the page draws at random on
    /// each visit. Two walks showed it move with nothing behind it, the call was read as needing the page, and the
    /// first route stood with the walked id frozen in it. An id written as a random one is, moved between two visits
    /// and handed over by no answer, is made up afresh for each call.
    #[test]
    fn an_id_drawn_at_random_each_visit_is_made_up_afresh() {
        let visit = |word: &str, session: &str| {
            let call = ex("GET", &format!("https://api.games.example/search?q={word}&sessionId={session}&pageType=all"), "application/json", r#"{"results":[{"name":"a"},{"name":"b"}]}"#, None);
            Trace { exchanges: vec![call], inputs: vec![crate::trace::Input::new("q", word)] }
        };
        let (first, second) = (visit("racing", "080dbce1-3f6b-4a45-b181-2c6c26f285ca"), visit("obby", "3a034e78-8a0a-4fec-86e2-4100927d74e0"));
        let two = build(&[first.clone(), second], |e: &Exchange| e.url.path() == "/search").unwrap();
        let class = two.steps[0].fields.iter().find(|f| f.loc == Loc::Query("sessionId".into())).map(|f| f.class.clone()).unwrap();
        assert!(matches!(class, Class::Fresh { clock: crate::fresh::Clock::Random, .. }), "{class:?}");
        let made = crate::fresh::make(crate::fresh::Clock::Random, 0);
        assert!(crate::fresh::a_random_id(&made) && made != crate::fresh::make(crate::fresh::Clock::Random, 0), "{made}");
        assert!(!crate::fresh::a_random_id("9f36aeafbe60771e321a7cc95a78140772ab3e96"));
    }

    /// The walk that exposed it: a site whose search is an embedded widget. The widget's loader script carries the
    /// token every search call must send, a new one on each visit. One walk left the token as the walk sent it, and
    /// the route would stop when it aged out. The second walk of the page, for another word, is a second sighting:
    /// the token moved between the two, a script the page loaded spells it out on each, so the route asks that
    /// script again for every call. A value the same on both visits is the site's constant, a value holding the
    /// caller's word is written from what they send, and a second walk whose calls come in another order and number
    /// still pairs each call with its own.
    #[test]
    fn two_walks_of_a_page_settle_what_one_left_unexplained() {
        let visit = |word: &str, token: &str, extra: bool| {
            let mut loader = ex("GET", "https://widget.example/loader.js?cx=0132", "text/javascript", &format!(r#"(function(){{var o={{"cx":"0132","token": "{token}","lib":"dc6f600a0d4404e5"}};}})();"#), None);
            loader.resource_type = Some("Script".into());
            let other = ex("GET", &format!("https://widget.example/element/v1?kind=promos&from=https%3A%2F%2Fdocs.example%2Fsearch%2F%3Fq%3D{word}"), "application/json", r#"{"promos":[]}"#, None);
            let call = ex("GET", &format!("https://widget.example/element/v1?kind=search&lib=dc6f600a0d4404e5&q={word}&tok={token}&from=https%3A%2F%2Fdocs.example%2Fsearch%2F%3Fq%3D{word}"), "application/json", &format!(r#"{{"results":[{{"title":"{word} one"}},{{"title":"{word} two"}}]}}"#), None);
            let page = ex("GET", &format!("https://docs.example/search/?q={word}"), "text/html", "<html><body><div id=results></div></body></html>", None);
            // The second visit makes its calls in another order, with one more among them.
            let exchanges = if extra { vec![page, other, loader, call] } else { vec![page, loader, call, other] };
            Trace { exchanges, inputs: vec![crate::trace::Input::new("q", word)] }
        };
        let first = visit("ingress", "AHbIdTiMTvxowd-mjvSAMgVkzSHk:1794561167236", false);
        let second = visit("volumes", "AHbIdTgQ9pLr3xYt7mNw2KcVbZsE:1794561199871", true);
        let is_target = |e: &Exchange| e.url.query_pairs().any(|(k, v)| k == "kind" && v == "search");
        let class_of = |g: &Graph, key: &str| g.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Query(key.into())).map(|f| f.class.clone()).unwrap();

        let one = build(std::slice::from_ref(&first), is_target).unwrap();
        assert!(!matches!(class_of(&one, "tok"), Class::Derived { .. }), "one sighting cannot tell it from a bundle's own text: {:?}", class_of(&one, "tok"));
        assert_eq!(one.steps.len(), 1);

        let two = build(&[first.clone(), second], is_target).unwrap();
        let Class::Derived { origin } = class_of(&two, "tok") else { panic!("the token is read from its source: {:?}", class_of(&two, "tok")) };
        assert!(origin.url.contains("loader.js"), "{origin:?}");
        assert_eq!(two.steps.len(), 2, "the loader, then the call");
        assert!(two.steps[0].url.contains("loader.js"));
        assert!(matches!(class_of(&two, "lib"), Class::Constant { .. }), "the same on both visits: {:?}", class_of(&two, "lib"));
        assert!(matches!(class_of(&two, "q"), Class::Input { .. }));
        assert!(!matches!(class_of(&two, "from"), Class::Computed | Class::Script { .. }), "a value holding the caller's word is not the page computing: {:?}", class_of(&two, "from"));
        // Another operation under the same prefix is another call: a second walk that never made this one settles
        // nothing about it, and its address stays its address.
        let op = |name: &str, word: &str| {
            let call = ex("POST", &format!("https://fly.example/restapi/27015/{name}"), "application/json", r#"{"list":[{"price":1},{"price":2}]}"#, Some(&format!(r#"{{"from":"{word}"}}"#)));
            Trace { exchanges: vec![call], inputs: vec![crate::trace::Input::new("from", word)] }
        };
        let alone = build(&[op("FlightListSearch", "bkk"), op("FlightCalendar", "kul")], |e: &Exchange| e.url.path().ends_with("FlightListSearch")).unwrap();
        let last = alone.steps.last().unwrap();
        assert!(last.url.ends_with("/restapi/27015/FlightListSearch"), "{}", last.url);
        assert!(last.fields.iter().filter(|f| matches!(f.loc, Loc::Path(_))).all(|f| matches!(f.class, Class::Constant { .. })), "{:?}", last.fields);
    }

    fn ex(method: &str, url: &str, mime: &str, body: &str, sent: Option<&str>) -> Exchange {
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: sent.map(String::from),
            status: 200,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: mime.into(),
            resource_type: Some(if mime.starts_with("text/html") { "Document" } else { "Fetch" }.into()),
            main_frame: None,
        }
    }

    /// A page read as text keeps the shape of the JSON script it carries: that shape is what tells a later page from a
    /// wall the site put in its place, though the script is never the answer.
    #[test]
    fn a_page_answered_by_its_text_keeps_the_shape_that_guards_it() {
        let rows: String = (0..30).map(|n| format!("<p>Lamp number {n} in a fine cut with a long name</p>")).collect();
        let html = format!(r#"<html><body><script type="application/json">{{"navigation":{{"footer":[{{"label":"Help"}}]}}}}</script>{rows}</body></html>"#);
        let trace = Trace { exchanges: vec![ex("GET", "https://shop.example/search/?q=lamp", "text/html", &html, None)], inputs: vec![crate::trace::Input::new("q", "lamp")] };
        let g = build(&[trace], |e| e.url.path() == "/search/").unwrap();
        let page = g.steps.last().unwrap();
        assert!(page.reads_page);
        assert!(page.response_shape.as_ref().is_some_and(|s| s.get("navigation").is_some()), "{:?}", page.response_shape);
    }

    /// A search value that survives a redirect into the final path, with its case canonicalised by the site
    /// (?search=planet -> /wiki/Planet), still binds as the input, not the route's address (#23).
    #[test]
    fn a_redirect_canonicalised_path_value_binds_as_the_input() {
        let get = ex("GET", "https://en.wikipedia.org/wiki/Planet", "text/html", "<html><body>planet, the astronomical body</body></html>", None);
        let a = Trace { exchanges: vec![get], inputs: vec![crate::trace::Input::new("search", "planet")] };
        let fields = classify(&a, None, 0, None, None, &Walk::default());
        let seg = fields.iter().find(|f| f.loc == Loc::Path(1)).expect("the /wiki/{x} segment");
        assert!(matches!(&seg.class, Class::Input { name, .. } if name == "search"), "Planet binds to input search case-insensitively, got {:?}", seg.class);
    }

    /// Two inputs that happen to hold the same value each bind to the slot their own name says, never both to the
    /// first: `?limit=25&offset=25` keeps `{offset}` filled from `offset`, so a later `offset=48` reaches the site.
    #[test]
    fn inputs_sharing_a_value_bind_to_the_slot_their_name_says() {
        // From the walk that exposed it: api.apify.com/v2/store?limit=25&offset=25&sortBy=popularity.
        let get = ex("GET", "https://api.apify.com/v2/store?limit=25&offset=25&sortBy=popularity", "application/json", r#"{"data":{"total":1,"items":[]}}"#, None);
        let inputs = vec![crate::trace::Input::new("limit", "25"), crate::trace::Input::new("offset", "25"), crate::trace::Input::new("sortBy", "popularity")];
        let fields = classify(&Trace { exchanges: vec![get], inputs }, None, 0, None, None, &Walk::default());
        let bound = |key: &str| match &fields.iter().find(|f| f.loc == Loc::Query(key.into())).unwrap().class {
            Class::Input { name, .. } => name.clone(),
            other => panic!("{key} isn't an input: {other:?}"),
        };
        assert_eq!(bound("limit"), "limit");
        assert_eq!(bound("offset"), "offset");
        // A body field binds the same way, by its own key.
        let post = ex("POST", "https://shop.example/api/search", "application/json", r#"{"items":[]}"#, Some(r#"{"page":2,"size":2}"#));
        let inputs = vec![crate::trace::Input::new("size", "2"), crate::trace::Input::new("page", "2")];
        let fields = classify(&Trace { exchanges: vec![post], inputs }, None, 0, None, None, &Walk::default());
        let page = fields.iter().find(|f| f.loc == Loc::Json("/page".into())).unwrap();
        assert!(matches!(&page.class, Class::Input { name, .. } if name == "page"), "{:?}", page.class);
    }

    /// Path pieces holding the same value keep their order: the page `/repos/firecrawl/firecrawl` asked as two
    /// inputs is a call that takes two, so another owner's other repo fills both.
    #[test]
    fn path_pieces_sharing_a_value_stay_separate_inputs() {
        let get = ex("GET", "https://api.github.com/repos/firecrawl/firecrawl", "application/json", r#"{"name":"firecrawl","owner":{"login":"firecrawl"}}"#, None);
        let inputs = vec![crate::trace::Input::new("repos", "firecrawl"), crate::trace::Input::new("part2", "firecrawl")];
        let fields = classify(&Trace { exchanges: vec![get], inputs }, None, 0, None, None, &Walk::default());
        let at = |k: usize| match &fields.iter().find(|f| f.loc == Loc::Path(k)).unwrap().class {
            Class::Input { name, .. } => name.clone(),
            other => format!("{other:?}"),
        };
        assert_eq!((at(1), at(2)), ("repos".to_string(), "part2".to_string()));
    }

    /// An item's internal id that only its page carries is read from the page: the page becomes the route's first
    /// step, and the call takes the id from it. The page's words never pull it in, and an id an API also answers
    /// with comes from the API.
    #[test]
    fn an_id_only_the_page_carries_is_read_from_the_page() {
        let page = ex(
            "GET",
            "https://shop.example/p/77001/",
            "text/html",
            r#"<html><h1>product page</h1><script type="application/json">{"items":{"77001":{"uuid":"ab12cd34-0000-4b05-ae24-bb4d5b371117"}}}</script></html>"#,
            None,
        );
        let me = ex("GET", "https://shop.example/api/me/", "application/json", r#"{"user":"bob"}"#, None);
        let send = ex(
            "POST",
            "https://shop.example/api/product/ab12cd34-0000-4b05-ae24-bb4d5b371117/offer/",
            "application/json",
            r#"{"ok":true}"#,
            Some(r#"{"message":"still available?"}"#),
        );
        let trace = Trace { exchanges: vec![page, me.clone(), send.clone()], inputs: vec![crate::trace::Input::new("message", "still available?")] };
        let g = build(std::slice::from_ref(&trace), |e| e.method == "POST").unwrap();
        assert_eq!(g.steps.len(), 2, "the page, then the call");
        assert!(g.steps[0].url.contains("/p/77001/"));
        let last = g.steps.last().unwrap();
        let id = last.fields.iter().find(|f| f.loc == Loc::Path(2)).unwrap();
        assert!(matches!(&id.class, Class::Derived { origin } if matches!(&origin.at, At::Json { pointer } if pointer == "/items/77001/uuid")), "{:?}", id.class);
        let word = last.fields.iter().find(|f| f.loc == Loc::Path(1)).unwrap();
        assert!(matches!(word.class, Class::Constant { .. }), "a word of the address stays the address");

        // The same id answered by an API: the page stays the browser's.
        let api = ex("GET", "https://shop.example/api/items/77001", "application/json", r#"{"uuid":"ab12cd34-0000-4b05-ae24-bb4d5b371117"}"#, None);
        let mut both = trace.clone();
        both.exchanges.insert(2, api);
        let g = build(std::slice::from_ref(&both), |e| e.method == "POST").unwrap();
        assert!(g.steps.iter().all(|s| !s.url.contains("/p/77001/")), "{:?}", g.steps.iter().map(|s| &s.url).collect::<Vec<_>>());
    }
    /// A value the agent filled into a control with no name of its own is called by the key the call sends it under,
    /// not by the ref the snapshot numbered the control by: a demo bank's transfer learned `@e129`, `@e130` and
    /// `input` for `fromAccountId`, `toAccountId` and `amount` (2026-11-06). A name of the agent's own stays.
    #[test]
    fn an_input_filled_by_ref_is_called_by_its_key() {
        assert_eq!(input_name("@e129", &Loc::Query("fromAccountId".into())), "fromAccountId");
        assert_eq!(input_name("input", &Loc::Form("amount".into())), "amount");
        assert_eq!(input_name("@e4", &Loc::Json("/order/amount".into())), "amount");
        assert_eq!(input_name("Search stories", &Loc::Query("q".into())), "Search stories");
        assert_eq!(input_name("customer.firstName", &Loc::Form("customer.firstName".into())), "customer.firstName");
        // A path piece names no field: the agent's name stays.
        assert_eq!(input_name("@e7", &Loc::Path(2)), "@e7");
    }

}

#[cfg(test)]
mod held_tests {
    use super::*;

    fn slot(loc: Loc, value: &str) -> Slot {
        Slot { loc, value: value.to_string() }
    }

    fn asked(value: &str) -> Vec<crate::trace::Input> {
        vec![crate::trace::Input::new("q", value)]
    }

    /// A search's word often rides inside a longer value of the call that answers: a JSON a query carries, the page's
    /// own address. Read as that value's own, the word would stay the walk's on every call.
    #[test]
    fn a_callers_value_inside_a_longer_one_is_found_as_it_is_written() {
        let json = held_in(&slot(Loc::Query("data".into()), r#"{"options":{"query":"tiny house","scope":"pins"}}"#), &asked("tiny house"));
        assert_eq!(json.len(), 1);
        assert_eq!((json[0].sits.as_str(), json[0].written), ("tiny house", Written::Json));
        let page = held_in(&slot(Loc::Header("x-source-url".into()), "/search/pins/?q=tiny%20house&rs=typed"), &asked("tiny house"));
        assert_eq!((page[0].sits.as_str(), page[0].written), ("tiny%20house", Written::Percent));
        let plus = held_in(&slot(Loc::Query("from".into()), "/s?k=tiny+house"), &asked("tiny house"));
        assert_eq!((plus[0].sits.as_str(), plus[0].written), ("tiny+house", Written::Plus));
        // A code the page's address writes small, sent in capitals, is the caller's, and goes in in capitals.
        let code = held_in(&slot(Loc::Json("/journey/0/departCode".into()), "SIN"), &asked("sin"));
        assert_eq!((code[0].sits.as_str(), code[0].written), ("SIN", Written::Upper));
        assert_eq!(code[0].written.write("kul"), "KUL");
        assert!(held_in(&slot(Loc::Json("/note".into()), "Sin City"), &asked("sin")).is_empty(), "only a value in one case is the caller's code");
    }

    /// A value is found only where it stands whole, and never where it could be anything or must not stay.
    #[test]
    fn only_a_value_standing_whole_is_the_callers() {
        assert!(held_in(&slot(Loc::Query("x".into()), "an address of dresses"), &asked("dress")).is_empty());
        // A search packed into JSON and sent encoded: the word is in no value the request shows, and is found in what
        // the value decodes to, with how it was encoded kept so a call packs its own word the same way.
        use base64::Engine;
        let packed = base64::engine::general_purpose::STANDARD.encode(r#"{"query":"tiny house","first":3}"#);
        let inner = held_in(&slot(Loc::Query("v".into()), &packed), &asked("tiny house"));
        assert_eq!(inner.len(), 1, "{inner:?}");
        assert_eq!((inner[0].sits.as_str(), inner[0].written, inner[0].inside), ("tiny house", Written::Json, Some(Wrap::Base64)));
        let url_safe = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"query":"tiny house?","first":3}"#);
        assert_eq!(held_in(&slot(Loc::Query("v".into()), &url_safe), &asked("tiny house?"))[0].inside, Some(Wrap::Base64UrlNoPad));
        // An encoded value that holds none of the caller's words holds nothing of theirs, and a word that merely fits
        // the alphabet is no encoding.
        assert!(held_in(&slot(Loc::Query("v".into()), &packed), &asked("garden shed")).is_empty());
        assert_eq!(Wrap::of("tinyhousetinyhouse"), None);
        assert_eq!(Wrap::of("deadbeefdeadbeefdeadbeef"), None);
        assert!(held_in(&slot(Loc::Query("q".into()), "dress"), &asked("dress")).is_empty(), "the slot is the value: an input, not held");
        assert!(held_in(&slot(Loc::Query("x".into()), "a 10 b"), &asked("10")).is_empty());
        assert!(held_in(&slot(Loc::Query("x".into()), "true or not"), &asked("true")).is_empty());
        assert!(held_in(&slot(Loc::Cookie("last".into()), "shoes,dress"), &asked("dress")).is_empty(), "a cookie is the session's");
        let secret = vec![crate::trace::Input { secret: true, ..crate::trace::Input::new("p", "hunter2x") }];
        assert!(held_in(&slot(Loc::Query("x".into()), "pw hunter2x end"), &secret).is_empty());
    }

    #[test]
    fn a_new_value_goes_in_the_way_the_old_one_sat() {
        assert_eq!(Written::Json.write("say \"hi\""), r#"say \"hi\""#);
        assert_eq!(Written::Percent.write("tiny house"), "tiny%20house");
        assert_eq!(Written::Plus.write("tiny house"), "tiny+house");
        assert_eq!(swapped("/q=dress&x=dresses", "dress", "coat"), "/q=coat&x=dresses");
    }

    fn exchange(method: &str, url: &str, request: Option<&str>, headers: Vec<(&str, &str)>, answer: &str) -> crate::trace::Exchange {
        crate::trace::Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: headers.into_iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: request.map(String::from),
            status: 200,
            response_headers: vec![],
            response_body: Some(answer.to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        }
    }

    /// The call that answers is built from a walk: a word it carries inside its JSON query goes out as the caller's on
    /// every call, whatever the input was named by the page.
    #[test]
    fn a_route_keeps_where_a_value_rides_inside_a_call() {
        let url = "https://shop.example/resource/get/?data=%7B%22query%22%3A%22kitchen%22%2C%22scope%22%3A%22pins%22%7D";
        let trace = Trace { exchanges: vec![exchange("GET", url, None, vec![], r#"{"pins":[{"id":"abcdef1"}]}"#)], inputs: asked("kitchen") };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path().ends_with("/get/")).unwrap();
        let held = &g.steps[0].held;
        assert_eq!(held.len(), 1, "{held:?}");
        assert_eq!((&held[0].loc, held[0].input.as_str(), held[0].sits.as_str()), (&Loc::Query("data".into()), "q", "kitchen"));
    }

    fn step(exchange: usize, method: &str, fields: Vec<Field>) -> Step {
        Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: method.into(),
            status: 200,
            url: "https://shop.example/x".into(),
            fields,
            body: None,
            response_shape: None,
            needs_browser: false,
            sets_cookie: false,
            on_load: false,
            foreign: false,
            held: Vec::new(),
            reads_page: false,
            fallbacks: Vec::new(),
        }
    }

    fn input() -> Field {
        Field { loc: Loc::Query("q".into()), class: Class::Input { name: "q".into(), secret: false, default: Some("a".into()), optional: false } }
    }

    fn from(exchange: usize) -> Field {
        let origin = Origin { exchange, url: "https://shop.example/".into(), at: At::Header { name: "x-t".into() }, wrap: None };
        Field { loc: Loc::Header("x-t".into()), class: Class::Derived { origin } }
    }

    /// A value that goes only to a read the answer takes nothing from can't change the answer, so a call must not read
    /// as if it did. Sent by the target, by a step the target reads, or to a step that may keep it, it can.
    #[test]
    fn an_input_reaches_the_answer_only_along_what_the_target_depends_on() {
        let graph = |steps| Graph { steps, provisional: false, page_origin: None, ..Graph::default() };
        assert!(!reaches_the_answer(&graph(vec![step(0, "GET", vec![input()]), step(1, "GET", vec![])]), "q"), "a page the call never reads");
        assert!(reaches_the_answer(&graph(vec![step(0, "GET", vec![]), step(1, "GET", vec![input()])]), "q"));
        assert!(reaches_the_answer(&graph(vec![step(0, "GET", vec![input()]), step(1, "GET", vec![from(0)])]), "q"), "the call reads the step");
        assert!(reaches_the_answer(&graph(vec![step(0, "POST", vec![input()]), step(1, "GET", vec![])]), "q"), "a POST may keep it in the session");
        let mut rides = step(0, "GET", vec![]);
        rides.held.push(Held { loc: Loc::Query("data".into()), input: "q".into(), sits: "a".into(), written: Written::Json, inside: None });
        assert!(reaches_the_answer(&graph(vec![rides]), "q"), "inside a longer value");
        assert!(!reaches_the_answer(&graph(vec![step(0, "GET", vec![input()])]), "another"));
    }

    /// An id the page made up is known to the site from its own earlier calls. A beacon that told another site's
    /// analytics the same id told this site nothing, so it stays out of the route.
    #[test]
    fn a_beacon_to_another_site_is_no_step_of_a_route() {
        let id = "1793959471747";
        let beacon = exchange("POST", "https://events.metrics.example/", Some(r#"{"visit":"1793959471747"}"#), vec![("content-type", "application/json")], r#"{"status":"ok"}"#);
        let own = exchange("POST", "https://api.shop.example/visit", Some(r#"{"visit":"1793959471747"}"#), vec![("content-type", "application/json")], r#"{"known":true}"#);
        let call = exchange("GET", "https://api.shop.example/search", None, vec![("x-visit-id", id)], r#"{"items":[{"name":"lamp"}]}"#);
        let trace = Trace { exchanges: vec![beacon, own, call], inputs: vec![] };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/search").unwrap();
        let hosts: Vec<&str> = g.steps.iter().map(|s| s.url.split('/').nth(2).unwrap()).collect();
        assert!(!hosts.contains(&"events.metrics.example"), "{hosts:?}");
    }

    /// The site's own analytics hear the same id, on the site's own hosts: a hit that sends the walked page's own address
    /// back reports the page, and one answered with nothing was told, not asked. Neither is a step a route needs, and
    /// neither drags the ad tags and consent files it read from into the route. A call of the site's that took the id
    /// and answered still is one.
    #[test]
    fn the_sites_own_beacons_are_no_step_of_a_route() {
        // The page's answer says when it was sent; the id is a reading of the clock at that moment.
        let id = "1793383794123";
        let mut page = exchange("GET", "https://www.shop.example/search-results?q=lamp", None, vec![], "<html><body>lamps</body></html>");
        (page.resource_type, page.response_mime, page.main_frame) = (Some("Document".into()), "text/html".into(), Some(true));
        page.response_headers = vec![("date".into(), "Fri, 30 Oct 2026 18:09:54 GMT".into())];
        let json = vec![("content-type", "application/json")];
        let body = |extra: &str| format!(r#"{{"visit":"{id}"{extra}}}"#);
        let hit = exchange("POST", "https://metrics.shop.example/v1/multitrack", Some(&body(r#","page":"https://www.shop.example/search-results?q=lamp""#)), json.clone(), r#"{"status":"ok"}"#);
        let told = exchange("POST", "https://tags.shop.example/g/hit", Some(&body("")), json.clone(), "");
        let own = exchange("POST", "https://api.shop.example/visit", Some(&body("")), json, r#"{"known":true}"#);
        let call = exchange("GET", "https://api.shop.example/search", None, vec![("x-visit-id", id)], r#"{"items":[{"name":"lamp"}]}"#);
        let trace = Trace { exchanges: vec![page, hit, told, own, call], inputs: vec![] };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/search").unwrap();
        let target = g.steps.last().unwrap();
        assert!(target.fields.iter().any(|f| matches!(f.class, Class::Fresh { .. })), "the id is the page's own: {:?}", target.fields);
        let urls: Vec<&str> = g.steps.iter().map(|s| s.url.as_str()).collect();
        assert!(!urls.iter().any(|u| u.contains("multitrack") || u.contains("/g/hit")), "{urls:?}");
        assert!(urls.contains(&"https://api.shop.example/visit"), "the site's own call that took the id still runs first: {urls:?}");
    }

    /// One answer, wrapped each way a site wraps JSON, is the same answer everywhere it is read: the shape the learner
    /// records for a route (`answer_shape`), the JSON a call hands back (`json_body_like`) and the JSON that says
    /// whether the call failed (`answer::not_an_answer`) all come from `Exchange::own_json`. A wrapping one reader knew
    /// and another didn't was a route learned from an answer its own replay could not read, or a failure only one of
    /// them saw.
    #[test]
    fn an_answer_reads_the_same_at_learn_time_and_at_call_time_however_it_is_wrapped() {
        let answer = r#"{"results":[{"name":"Oak desk","price":"S$ 120"},{"name":"Pine desk","price":"S$ 80"}],"total":2}"#;
        let failure = r#"{"api":"shop.search","data":{},"ret":["FAIL_SYS_TOKEN_EMPTY::the token is empty"],"traceId":"d74c5c52","v":"1.0"}"#;
        let wrapped = |body: &str| -> Vec<(&'static str, String, String)> {
            vec![
                ("plain", "https://api.shop.example/search?q=desk".to_string(), body.to_string()),
                ("in a callback", "https://api.shop.example/search?q=desk&callback=cb7".to_string(), format!("cb7({body})")),
                ("behind a guard", "https://api.shop.example/search?q=desk".to_string(), format!(")]}}'\n{body}")),
            ]
        };
        let plain: Value = serde_json::from_str(answer).unwrap();
        for (how, url, body) in wrapped(answer) {
            let e = exchange("GET", &url, None, vec![], &body);
            assert_eq!(e.own_json().as_ref(), Some(&plain), "{how}: the answer's own JSON");
            assert_eq!(answer_shape(&e, &[]), Some(shape(&plain)), "{how}: the shape a route records");
            assert_eq!(e.json_body_like(Some(&shape(&plain))), Some(plain.clone()), "{how}: what a call hands back");
            assert!(crate::answer::not_an_answer(&e, false).is_none(), "{how}: an answer is an answer");
        }
        for (how, url, body) in wrapped(failure) {
            let e = exchange("GET", &url, None, vec![], &body);
            assert!(crate::answer::not_an_answer(&e, false).is_some_and(|w| w.contains("says it failed")), "{how}: a failure is a failure");
        }
        // A stream's events are read by both as the list of them: the learner and the call agree on that shape too.
        let stream = exchange("POST", "https://api.shop.example/search", None, vec![("content-type", "text/event-stream")], &format!("data: {answer}\n\n"));
        let events = stream.own_json().expect("the stream's events");
        assert_eq!(answer_shape(&stream, &[]), Some(shape(&events)));
        assert_eq!(stream.json_body_like(None), Some(events));
    }

    /// A page's answer is what the learner judged it by: the state it embeds when that holds what the page shows, else
    /// the page read. A page whose only state is a scrap of search parameters is read for its text (`reads_page`), so its
    /// calls answer with the page read, never the scrap; the scrap's shape stays only as the guard against a wall.
    #[test]
    fn a_page_keeps_the_shape_of_the_answer_it_gives() {
        let results: String = (0..40).map(|i| format!("<li><a href=\"/p/{i}\">Lamp model {i} with a long name</a> S$ {i}.99</li>")).collect();
        let scrap = r#"<script type="application/json">{"searchParams":{"k":"lamp","pageType":"Search"}}</script>"#;
        let mut page = exchange("GET", "https://www.shop.example/s?k=lamp", None, vec![], &format!("<html><body>{scrap}<ul>{results}</ul></body></html>"));
        (page.resource_type, page.response_mime) = (Some("Document".into()), "text/html".into());
        assert!(reads_page(&page, &[]), "the page read answers, not the scrap");
        let props = r#"<script type="application/json">{"items":[{"name":"Lamp model 1 with a long name"}]}</script>"#;
        let mut small = exchange("GET", "https://www.shop.example/p/1", None, vec![], &format!("<html><body>{props}<h1>Lamp model 1 with a long name</h1></body></html>"));
        (small.resource_type, small.response_mime) = (Some("Document".into()), "text/html".into());
        assert!(answer_shape(&small, &[]).is_some() && !reads_page(&small, &[]), "a state that holds the page is its answer");
        let api = exchange("GET", "https://api.shop.example/search", None, vec![], r#"{"items":[]}"#);
        assert!(answer_shape(&api, &[]).is_some());
        // A frame whose script draws the results from its state: its text (menus, a footer) never says the city asked,
        // and the state does, so the state is the answer.
        let menu: String = (0..80).map(|i| format!("<a href=\"/help/{i}\">Help topic {i}</a> ")).collect();
        let state = r#"<script type="application/json">{"results":[{"name":"Riverside loft","city":"Bangkok","price":"S$ 120"}]}</script>"#;
        // The menu is the page's own content here, not chrome: a page's answer is its text, and the nav/header/footer
        // elements are read as chrome and left out.
        let mut frame = exchange("GET", "https://www.stay.example/s/Bangkok/homes", None, vec![], &format!("<html><body>{state}<div>{menu}</div></body></html>"));
        (frame.resource_type, frame.response_mime) = (Some("Document".into()), "text/html".into());
        assert!(reads_page(&frame, &[]), "asked nothing, the frame's text reads as the page");
        let asked = [crate::trace::Input::new("s", "Bangkok")];
        assert!(answer_shape(&frame, &asked).is_some() && !reads_page(&frame, &asked), "the state says back what was asked, the frame never does");
    }

    /// A word the page's code sends (`"source": "SEARCH_RESULTS_MAP"`) that an earlier answer happens to list among its
    /// options (`"eligibleSources": ["TRIP_SR", "SEARCH_RESULTS_MAP"]`) is the call's setting: the list's order is the
    /// answer's, and the next page lists them otherwise. An id the answer hands over in a list is still taken from it.
    #[test]
    fn a_word_an_answer_lists_among_others_is_the_calls_own() {
        let config = exchange("GET", "https://www.stay.example/config", None, vec![], r#"{"eligibleSources":["TRIP_SR","SEARCH_RESULTS_MAP"],"ids":["a1b2c3d4e5","f6g7h8i9j0"]}"#);
        let search = exchange("POST", "https://www.stay.example/graphql", Some(r#"{"source":"SEARCH_RESULTS_MAP","pick":"f6g7h8i9j0"}"#), vec![("content-type", "application/json")], r#"{"data":{"results":[{"name":"x"}]}}"#);
        let trace = Trace { exchanges: vec![config, search], inputs: vec![] };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/graphql").unwrap();
        let class = |p: &str| g.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Json(p.into())).map(|f| f.class.clone()).unwrap();
        assert!(matches!(class("/source"), Class::Constant { value, origin: Some(_) } if value == "SEARCH_RESULTS_MAP"), "{:?}", class("/source"));
        assert!(matches!(class("/pick"), Class::Derived { .. }), "{:?}", class("/pick"));
    }

    /// A plain word a call sends (`"value": "Flight"`) that a config answer happens to say too (`"productLine":
    /// "Flight"`) is the call's own setting: tracing it would make the route ask the config first, a call a plain
    /// client may not be let make. A token in the same answer is still taken from it.
    #[test]
    fn a_plain_word_an_answer_also_says_is_the_calls_own() {
        assert!(crate::provenance::a_plain_word("Flight") && crate::provenance::a_plain_word("ONLINE") && crate::provenance::a_plain_word("homes"));
        assert!(!crate::provenance::a_plain_word("aBcDeFgH") && !crate::provenance::a_plain_word("tok3n9") && !crate::provenance::a_plain_word("red-runner"));
        let config = exchange("POST", "https://www.air.example/getConfiguration", None, vec![], r#"{"baseInfo":{"productLine":"Flight","token":"Zx81kQ0pL2"}}"#);
        let search = exchange("POST", "https://www.air.example/FlightListSearch", Some(r#"{"ext":[{"name":"entrance","value":"Flight"},{"name":"t","value":"Zx81kQ0pL2"}]}"#), vec![("content-type", "application/json")], r#"{"flights":[{"no":"SQ1"}]}"#);
        let trace = Trace { exchanges: vec![config, search], inputs: vec![] };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/FlightListSearch").unwrap();
        let class = |p: &str| g.steps.last().unwrap().fields.iter().find(|f| f.loc == Loc::Json(p.into())).map(|f| f.class.clone()).unwrap();
        assert!(matches!(class("/ext/0/value"), Class::Constant { value, .. } if value == "Flight"), "{:?}", class("/ext/0/value"));
        assert!(matches!(class("/ext/1/value"), Class::Derived { .. }), "{:?}", class("/ext/1/value"));
    }

    /// A value too short to say where it sits (a guest count, `adults=2`) is the caller's only under its own key: the
    /// page's own call sending `adults=2` takes it, another's `version=2` keeps its own value.
    #[test]
    fn a_one_character_value_binds_only_under_its_own_key() {
        let call = exchange("GET", "https://api.stay.example/search?city=bangkok&adults=2&version=2", None, vec![], r#"{"homes":[{"name":"x"}]}"#);
        let trace = Trace { exchanges: vec![call], inputs: vec![crate::trace::Input::new("city", "bangkok"), crate::trace::Input::new("adults", "2")] };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path() == "/search").unwrap();
        let class = |k: &str| g.steps[0].fields.iter().find(|f| f.loc == Loc::Query(k.into())).map(|f| f.class.clone()).unwrap();
        assert!(matches!(class("adults"), Class::Input { name, .. } if name == "adults"));
        assert!(!matches!(class("version"), Class::Input { .. }), "{:?}", class("version"));
        assert!(g.steps[0].url.contains("version=2"), "{}", g.steps[0].url);
    }

    /// A path written the way a form writes (`/maps/search/coffee+shops/`) holds the caller's value with its spaces, so
    /// a page that is its own route takes it as the input its calls send as "coffee shops".
    #[test]
    fn a_path_piece_with_pluses_holds_the_spaced_value() {
        let mut page = exchange("GET", "https://www.maps.example/maps/search/coffee+shops/", None, vec![], "<html><body>coffee shops near you</body></html>");
        (page.resource_type, page.response_mime) = (Some("Document".into()), "text/html".into());
        let trace = Trace { exchanges: vec![page], inputs: vec![crate::trace::Input::new("search", "coffee shops")] };
        let g = build(std::slice::from_ref(&trace), |e| e.url.path().starts_with("/maps/search/")).unwrap();
        assert!(g.steps[0].fields.iter().any(|f| f.loc == Loc::Path(2) && matches!(&f.class, Class::Input { name, .. } if name == "search")), "{:?}", g.steps[0].fields);
    }
    /// The walk that exposed it: a news site's search and its breaking-news ticker are two operations at one
    /// address. A second walk that met the site's door made only the ticker, and the builder paired the search with
    /// it as "the same request": the operation's name read as a value that moves, and the route then asked for the
    /// ticker. A walk that never made the call pairs nothing, and the call is read as seen once.
    #[test]
    fn a_call_pairs_only_with_the_same_call_on_the_other_walk() {
        let call = |url: &str| crate::trace::Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some("{}".into()),
            response_mime: "application/json".into(),
            resource_type: Some("Fetch".into()),
            main_frame: None,
        };
        let search = |word: &str| call(&format!("https://news.example/graphql?operationName=SearchQuery&variables=%7B%22query%22%3A%22{word}%22%2C%22start%22%3A1%7D"));
        let ticker = || call("https://news.example/graphql?operationName=BreakingTicker&variables=%7B%7D");
        let first = Trace { exchanges: vec![ticker(), search("climate")], inputs: vec![crate::trace::Input::new("search", "climate")] };
        let behind_a_door = Trace { exchanges: vec![ticker(), ticker()], inputs: vec![] };
        let pairs = align(&first, &behind_a_door);
        assert_eq!(pairs.get(&0), Some(&0), "the ticker is the ticker");
        assert_eq!(pairs.get(&1), None, "the search was never made there");
        let again = Trace { exchanges: vec![search("election"), ticker()], inputs: vec![] };
        assert_eq!(align(&first, &again).get(&1), Some(&0), "the same search for another word");
    }
}
