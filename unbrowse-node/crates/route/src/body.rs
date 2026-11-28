//! What a route is made of: its slots, its steps, each step's holes, and the ways each hole is filled.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::expr::Expr;

/// The version of the body this crate writes and reads. A body of a later version is refused whole: a part of it
/// this evaluator does not know could change what the rest means.
///
/// A route's tests and plan came after version 2 and did not move it: every type of a body refuses a field it does
/// not know, so a reader from before them refuses a body that holds them rather than misread it, and a body without
/// them is written as it always was.
pub const VERSION: u32 = 2;

/// A route: one thing a site does, as the calls that do it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub v: u32,
    /// The site the route calls, as its registrable domain.
    pub site: String,
    /// What a caller may write: every value of theirs the steps send.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<Slot>,
    /// The steps, in an order they can run in. The answer's step is among them.
    pub steps: Vec<Step>,
    pub answer: Answer,
    /// What it was learned against, as shapes ([`Test`]): no value of a session.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tests: Vec<Test>,
    /// What is needed to learn it again ([`Plan`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Plan>,
    /// What its values mean, where the learner found it (`meaning`): each slot's kind, and the answer's records.
    #[serde(default, skip_serializing_if = "crate::meaning::Meaning::is_empty")]
    pub meaning: crate::meaning::Meaning,
}

/// A value the caller writes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Slot {
    pub name: String,
    /// A secret is filled from the caller's own vault and never kept in a body (`credential.never`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
    /// What the walk sent here, as an example of what to write. Never a secret's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    /// The values the page offered for it, where it offered any.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<String>,
}

/// One request of a route.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    /// The step's name in this body: what a later step's read names.
    pub id: String,
    pub method: String,
    /// The address as walked, without its query, and with `{path[i]}` where piece `i` of the path is a hole. The
    /// query is written from the holes that sit in it, in their order.
    pub url: String,
    /// The places of the request that are not fixed text, in the order the request carries them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub holes: Vec<Hole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<Form>,
    /// The status the site answered with when the step was learned: a step that was refused then is expected to be
    /// refused again.
    pub expect: u16,
    /// A page's script made this call, so it goes out as a script's call does, from that page. None for a page,
    /// which is asked for as a page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<Caller>,
    /// The page's own request is this step's request: no way of this body makes all of it, and the step is made at
    /// rung 3 or below (`learn.rung`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub page: bool,
    /// The step may change what the site holds. It is never sent to try something and never sent twice.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub writes: bool,
    /// The page sent this call by itself as it loaded, before anything was done on it, and was answered with data:
    /// every visit to the page sends it again. What the node's caller reads of a step beside its address: such a call
    /// only asks, and one that nothing after it reads need not be sent.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub on_load: bool,
    /// The step's answer set a cookie when it was learned: the site's session bookkeeping, or its state kept in a
    /// cookie. What the node's caller reads of a step beside its address: a call the page sent as it loaded that set
    /// one may still change what the site holds, and a step that sets one is asked live, not read from a page kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sets_cookie: bool,
    /// Seconds the step's reply stays good for the same values (`learn.lifetime`). None: asked on every call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifetime: Option<u64>,
    /// The shape of the step's reply when it was learned: its keys and the kinds of their values, with no value.
    /// The answer's is what a call's answer is held to; another step's says what it answered with. None when the
    /// reply held no JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<Value>,
}

/// The page a script's call goes out from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Caller {
    /// The page's origin (scheme and host). None: the call's own origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}

/// A place in a request whose value is made for each call, and the ways to make it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hole {
    pub at: Place,
    /// Cheapest first. The first way that is ready fills the hole.
    pub ways: Vec<Way>,
    /// The value is written over what the body's template holds there. Without it a value goes only where the
    /// template is empty, so a fixed leaf keeps its type.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub over: bool,
    /// Seen once, with nothing to say what it is: sent as walked until a second sighting settles it. A body with an
    /// open hole is not published.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open: bool,
}

impl Hole {
    /// Where among its ways the first learn's value is recalled: a hole that has one is a value the page makes anew on
    /// every call, and the ways before it make it for this call (`route.value-dag`).
    pub fn recalled_at(&self) -> Option<usize> {
        self.ways.iter().position(|w| matches!(w.expr, crate::expr::Expr::Recalled { .. }))
    }
}

/// One way to fill a hole: an expression, and the rung of the maker it needs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Way {
    /// 0 the walk's own values, 1 an expression of standard operations, 2 a function run for the value.
    pub rung: u8,
    pub expr: Expr,
}

/// Where in a request a value sits.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "in", content = "key", rename_all = "snake_case")]
pub enum Place {
    /// A piece of the path, counted from zero.
    Path(usize),
    Query(String),
    Header(String),
    Cookie(String),
    /// A leaf of a JSON body, by pointer.
    Json(String),
    Form(String),
    /// A part of a multipart body by name, and a pointer into it when the part holds JSON (empty for its text).
    Part(String, String),
    /// The whole address, handed over by an earlier reply.
    Url,
}

impl std::fmt::Display for Place {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Place::Path(i) => write!(f, "path[{i}]"),
            Place::Query(k) => write!(f, "query {k}"),
            Place::Header(k) => write!(f, "header {k}"),
            Place::Cookie(k) => write!(f, "cookie {k}"),
            Place::Json(p) => write!(f, "body {p}"),
            Place::Form(k) => write!(f, "form {k}"),
            Place::Part(n, p) if p.is_empty() => write!(f, "part {n}"),
            Place::Part(n, p) => write!(f, "part {n} {p}"),
            Place::Url => write!(f, "the address"),
        }
    }
}

/// The body a step sends, as a template its holes are written into.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Form {
    /// JSON. A leaf that is a hole is `null` in the template, and `types` says what kind of leaf it was.
    Json {
        template: Value,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        types: BTreeMap<String, String>,
        /// Lists read off a list in an earlier reply, one element each: a reply with a shorter list leaves this one
        /// shorter, and its unfilled end is cut.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        follows: Vec<String>,
    },
    /// A form's fields in order, each with its text where that is fixed.
    Fields { fields: Vec<(String, Option<String>)> },
    /// A multipart form, sent on the boundary it was walked with.
    Multipart { boundary: String, parts: Vec<Part> },
    /// A file's bytes, read from the file the caller names in `slot`. How they are sent is the node's to say
    /// (`protocol` is its own record); this crate builds the request around them and never the bytes.
    Upload {
        slot: String,
        protocol: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
    /// A body that is none of these. A step with one cannot be built.
    Other,
    /// A binary body opened into fields with no schema (`wire`): `template` is what the walk sent as the codec's
    /// reader opens it, each hole's leaf `null`, and its holes sit at `Place::Json` pointers into it. Written by
    /// filling the leaves and encoding the tree again. Kept only where the walk's own bytes open and write back as
    /// they were. An older node does not read a body that holds one, and the route stands as its graph.
    Wire { codec: crate::wire::Codec, template: Value },
}

/// One part of a multipart body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Part {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// The part's text, where it is fixed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// For a part holding JSON: its template, as a JSON body's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json: Option<Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub types: BTreeMap<String, String>,
}

/// Which step's reply is the route's answer, and how it is known to be one: the shape it is held to is that
/// step's ([`Step::shape`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub step: String,
    /// The answer is the page itself, read as a page.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub page: bool,
    /// The reply is not read as it stands (JSON, a page, a stream, base64 of JSON): the site's own code unpacks it,
    /// and the decoder cut from the script that read the reply turns the raw bytes into what the page used. Run in
    /// the sandbox at call time over the live reply (`learn.isolate`). Private, as a program is, and stripped wherever
    /// a body is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decode: Option<Decode>,
}

/// A decoder the site's own code runs over a reply the standard readers cannot (a ciphered or obfuscated answer): a
/// program written for the reply and proved on the walks' own replies, carried on the route as an opaque leaf, never
/// shared.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decode {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Value>,
}

/// One step's sightings, as the route was learned against them (`docs/REBUILD.md` §5, "a sighting as shapes"): for
/// each walk that made the call, what each place's value was made of and what it looked like. Never a value: a body
/// may be shared, and what a session sent stays with the session. A test is the walk's word on the body, and a body
/// run against a recording again can be held to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Test {
    /// The step it is of.
    pub step: String,
    /// Each sighting of the step: one walk's call.
    pub sightings: Vec<Sighting>,
    /// The SHA-256 of each script a digest of this step was made over a constant of: the site ships that constant to
    /// everyone, so it is kept as fixed text in the body, and the script's hash is noted here, so a deploy that
    /// changes the script (and may change the constant) is seen when the body is checked again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub over_scripts: Vec<String>,
}

/// One sighting of a step: each place the call sent, by where it came from and its shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sighting {
    pub seen: Vec<Seen>,
}

/// One place of one sighting.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Seen {
    pub at: Place,
    pub from: Source,
    pub shape: Shape,
}

/// Where a place's value came from, as the learner read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The same on every sighting.
    Fixed,
    /// The caller's value, or made from it.
    Caller,
    /// The session's: a cookie, or a value one is.
    Session,
    /// An earlier reply.
    Read,
    /// The clock.
    Clock,
    /// A digest over the request.
    Digest,
    /// A program of the site's own code, cut from the script that sent the call (`learn.isolate`).
    Function,
    /// An item picked from a list an earlier reply gave.
    Pick,
    /// The browser's own shape.
    Browser,
    /// Nothing the walks show.
    Open,
}

/// What a value looked like, never what it was: its length, and what it was made of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shape {
    pub len: usize,
    pub of: Chars,
}

/// What a value was made of.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Chars {
    Empty,
    /// Digits alone.
    Digits,
    /// Hexadecimal digits, some letters and some digits.
    Hex,
    /// Letters alone.
    Letters,
    /// Words: letters, with spaces or marks between them.
    Words,
    /// A token of letters and digits and the marks an encoding uses (`-`, `_`, `+`, `/`, `=`).
    Token,
    /// Anything else.
    Mixed,
}

impl Shape {
    /// The shape of `value`.
    pub fn of(value: &str) -> Shape {
        let len = value.chars().count();
        let all = |f: &dyn Fn(char) -> bool| value.chars().all(f);
        let of = if value.is_empty() {
            Chars::Empty
        } else if all(&|c| c.is_ascii_digit()) {
            Chars::Digits
        } else if all(&|c| c.is_ascii_hexdigit()) && value.chars().any(|c| c.is_ascii_digit()) {
            Chars::Hex
        } else if all(&char::is_alphabetic) {
            Chars::Letters
        } else if value.chars().any(char::is_alphabetic) && all(&|c| c.is_alphabetic() || c.is_whitespace() || matches!(c, '\'' | '-' | '.' | ',')) {
            Chars::Words
        } else if all(&|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=')) {
            Chars::Token
        } else {
            Chars::Mixed
        };
        Shape { len, of }
    }
}

/// What is needed to learn a route again (`docs/REBUILD.md` §5): the page it was learned on, with each place a value
/// was asked at written `{name}` (inside the page's own marks, where it wraps the value in some: `{word}-`); the goal
/// it was learned for; which name each asked value came under, and by what reading each place was found; and what
/// was done on the page beyond loading it. Never a value of the caller's: a secret's value has no place to stand in
/// it, and a plan whose page holds a value where one was asked does not read ([`Route::refused`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub page: String,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asked: Vec<Asked>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub done: Vec<Done>,
}

/// How an asked place of a plan was found.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskedBy {
    /// What two walks' addresses of the page differ by: a place that differs is asked, and one the same on both is
    /// the page's own.
    TwoWalks,
    /// One walk's reading of its address: the values it was asked, wherever they stand. A place the page wrote
    /// itself may be read as asked.
    #[default]
    OneWalk,
}

/// Where on the page a value was asked, under the name the walk gave it: a slot of the body where the call takes the
/// value, and the page's own ask where it does not. Either way the page is asked it again to learn the route again,
/// as the trial asks it for a second word.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asked {
    pub slot: String,
    pub at: AskedAt,
    /// A place written before this was said is one walk's reading.
    #[serde(default)]
    pub by: AskedBy,
}

/// A place of a page's address.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskedAt {
    /// A value of the query, by key.
    Query(String),
    /// A piece of the path, counted from zero.
    Path(usize),
    /// A value the fragment carries as a query does, by key.
    Fragment(String),
}

/// One thing done on the page: its kind (`click`, `type`, `select`, `press`), what it was done to, and the slot a
/// value typed or chosen there fills. What was typed is never kept: it is the caller's, in the slot, or nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Done {
    pub kind: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
}

/// Where `value` is a `{name}` inside the page's own marks (what is neither a letter nor a digit, at either end): the
/// marks before it, the name, and the marks after it.
fn slot_within(value: &str) -> Option<(&str, &str, &str)> {
    let (before, rest) = value.split_once('{')?;
    let (name, after) = rest.split_once('}')?;
    let marks = |m: &str| m.chars().all(|c| !c.is_alphanumeric() && c != '{' && c != '}');
    (!name.is_empty() && marks(before) && marks(after)).then_some((before, name, after))
}

/// A fragment read as a query is (`trace::asked_pairs`): what leads up to its pairs (`/search?`, `!/`, or nothing),
/// and the pairs. None where the fragment holds no pair.
pub fn fragment_pairs(fragment: &str) -> Option<(&str, &str)> {
    let (lead, pairs) = match fragment.find('?') {
        Some(at) => fragment.split_at(at + 1),
        None => fragment.split_at(fragment.len() - fragment.trim_start_matches(['!', '/']).len()),
    };
    pairs.contains('=').then_some((lead, pairs))
}

impl Plan {
    /// The value standing at each asked place of the page, as the page writes it: `{name}` where the plan is well
    /// formed, inside the page's own marks where it has some.
    fn stands_at(&self, at: &AskedAt) -> Option<String> {
        let u = url::Url::parse(&self.page).ok()?;
        match at {
            AskedAt::Query(key) => u.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned()),
            AskedAt::Path(i) => u.path_segments()?.nth(*i).map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()),
            AskedAt::Fragment(key) => url::form_urlencoded::parse(fragment_pairs(u.fragment()?)?.1.as_bytes()).find(|(k, _)| k == key).map(|(_, v)| v.into_owned()),
        }
    }

    /// The address of the page for `values`, by slot name: each `{name}` the page holds written as its value, in the
    /// query, the path and the fragment, as a second walk of the page for another value goes to it. A `{name}` with no
    /// value given stands as it is. None when the page does not read as an address.
    pub fn address(&self, values: &std::collections::HashMap<String, String>) -> Option<String> {
        let mut u = url::Url::parse(&self.page).ok()?;
        let given = |v: &str| slot_within(v).and_then(|(before, n, after)| values.get(n).map(|now| format!("{before}{now}{after}")));
        let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        if pairs.iter().any(|(_, v)| given(v).is_some()) {
            let moved: Vec<(String, String)> = pairs.into_iter().map(|(k, v)| match given(&v) {
                Some(now) => (k, now),
                None => (k, v),
            }).collect();
            u.query_pairs_mut().clear().extend_pairs(moved);
        }
        let segments: Vec<String> = u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default();
        if segments.iter().any(|p| given(p).is_some()) {
            let moved: Vec<String> = segments.into_iter().map(|p| given(&p).unwrap_or(p)).collect();
            u.path_segments_mut().ok()?.clear().extend(moved.iter().map(String::as_str));
        }
        if let Some((lead, held)) = u.fragment().and_then(fragment_pairs).map(|(l, p)| (l.to_string(), p.to_string())) {
            let pairs: Vec<(String, String)> = url::form_urlencoded::parse(held.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
            if pairs.iter().any(|(_, v)| given(v).is_some()) {
                let moved: String = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.into_iter().map(|(k, v)| match given(&v) {
                    Some(now) => (k, now),
                    None => (k, v),
                })).finish();
                u.set_fragment(Some(&format!("{lead}{moved}")));
            }
        }
        Some(u.to_string())
    }
}

impl Route {
    /// The step named `id`.
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    /// Why this body cannot be run as it stands, if it cannot: a later version, a read of a step that is not there
    /// or comes later, an answer that names no step, two steps of one name. An expression this crate does not know
    /// never gets this far: such a body does not read at all.
    pub fn refused(&self) -> Option<String> {
        if self.v != VERSION {
            return Some(format!("the body is version {}, and this node reads version {VERSION}", self.v));
        }
        let mut seen: Vec<&str> = Vec::new();
        for step in &self.steps {
            if seen.contains(&step.id.as_str()) {
                return Some(format!("two steps are named {}", step.id));
            }
            for hole in &step.holes {
                if hole.ways.is_empty() {
                    return Some(format!("step {}: {} has no way to fill it", step.id, hole.at));
                }
                for way in &hole.ways {
                    for read in way.expr.reads() {
                        if !seen.contains(&read) {
                            return Some(format!("step {}: {} reads step {read}, which does not come before it", step.id, hole.at));
                        }
                    }
                }
            }
            seen.push(&step.id);
        }
        if !seen.contains(&self.answer.step.as_str()) {
            return Some(format!("the answer names step {}, which the body does not have", self.answer.step));
        }
        // A test is of a step the body has, and a value it saw made for the call (anything but the step's own fixed
        // text, or the browser's) sits at a hole of that step: the body makes it there.
        for test in &self.tests {
            let Some(step) = self.step(&test.step) else { return Some(format!("a test is of step {}, which the body does not have", test.step)) };
            let made = |from: Source| !matches!(from, Source::Fixed | Source::Browser);
            if let Some(seen) = test.sightings.iter().flat_map(|s| &s.seen).find(|seen| made(seen.from) && !step.holes.iter().any(|h| h.at == seen.at)) {
                return Some(format!("a test of step {} saw a value made at {}, where the step has no hole", test.step, seen.at));
            }
        }
        // A plan's page holds `{name}` wherever a value was asked: never a value, and never a secret's. What was done
        // on the page fills a slot of the body or a value the page was asked, nothing else.
        if let Some(plan) = &self.plan {
            if url::Url::parse(&plan.page).is_err() {
                return Some(format!("the plan's page {} is no address", plan.page));
            }
            for asked in &plan.asked {
                let stands = plan.stands_at(&asked.at);
                if stands.as_deref().and_then(slot_within).map(|(_, name, _)| name) != Some(asked.slot.as_str()) {
                    let what = if self.slots.iter().any(|s| s.name == asked.slot && s.secret) { "a secret's value" } else { "a value" };
                    return Some(format!("the plan's page holds {what} where {} was asked, not {{{}}}", asked.slot, asked.slot));
                }
            }
            let named = |n: &String| self.slots.iter().any(|s| s.name == *n) || plan.asked.iter().any(|a| a.slot == *n);
            if let Some(done) = plan.done.iter().find(|d| d.slot.as_ref().is_some_and(|n| !named(n))) {
                return Some(format!("the plan's {} on {} fills {}, which is neither a slot of the body nor asked of the page", done.kind, done.target, done.slot.as_deref().unwrap_or_default()));
            }
        }
        None
    }

    /// The names of every value of the caller's the steps send, in the order they are first sent.
    pub fn asked(&self) -> Vec<&str> {
        let mut out: Vec<&str> = Vec::new();
        for way in self.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways) {
            for name in way.expr.slots() {
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
        for step in &self.steps {
            if let Some(Form::Upload { slot, .. }) = &step.body {
                if !out.contains(&slot.as_str()) {
                    out.push(slot);
                }
            }
        }
        out
    }

    /// Whether the body holds anything that may not leave the node: a program written for a value is the route's
    /// private data and is never shared (`R2.7`).
    pub fn holds_code(&self) -> bool {
        self.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).any(|w| w.expr.holds_code())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(id: &str, holes: Vec<Hole>, body: Option<Form>) -> Step {
        Step { id: id.into(), method: "GET".into(), url: "https://shop.example/api".into(), holes, body, expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None }
    }

    fn slot_hole(at: Place, name: &str) -> Hole {
        Hole { at, ways: vec![Way { rung: 0, expr: Expr::Slot { name: name.into(), or: None, optional: false } }], over: false, open: false }
    }

    fn route(steps: Vec<Step>, answer: &str) -> Route {
        Route { v: VERSION, site: "shop.example".into(), slots: Vec::new(), steps, answer: Answer { step: answer.into(), page: false, decode: None }, tests: Vec::new(), plan: None, meaning: Default::default() }
    }

    /// Every place of a request is named the way an agent reads it in a refusal.
    #[test]
    fn every_place_of_a_request_is_named_for_the_reader_of_a_refusal() {
        for (place, named) in [
            (Place::Path(2), "path[2]"),
            (Place::Query("q".into()), "query q"),
            (Place::Header("x-id".into()), "header x-id"),
            (Place::Cookie("sid".into()), "cookie sid"),
            (Place::Json("/a/b".into()), "body /a/b"),
            (Place::Form("f".into()), "form f"),
            (Place::Part("meta".into(), String::new()), "part meta"),
            (Place::Part("meta".into(), "/n".into()), "part meta /n"),
            (Place::Url, "the address"),
        ] {
            assert_eq!(place.to_string(), named);
        }
    }

    /// A body is refused whole where it could not run: a hole with no way to fill it (named by its place), a step that
    /// reads one that comes after it, two steps of one name, an answer from a step it lacks, a plan whose page is no
    /// address, a version this node does not read. A sound body is not refused.
    #[test]
    fn a_body_that_could_not_run_is_refused_and_says_where() {
        let sound = route(vec![step("a", vec![slot_hole(Place::Query("q".into()), "q")], None), step("b", vec![], None)], "b");
        assert_eq!(sound.refused(), None);

        let empty = Hole { at: Place::Header("x".into()), ways: vec![], over: false, open: false };
        assert_eq!(route(vec![step("a", vec![empty], None)], "a").refused().as_deref(), Some("step a: header x has no way to fill it"));

        let read = |of: &str| Hole { at: Place::Query("t".into()), ways: vec![Way { rung: 0, expr: Expr::Read { step: of.into(), at: crate::expr::At::Json { pointer: "/t".into() } } }], over: false, open: false };
        let refused = route(vec![step("a", vec![read("b")], None), step("b", vec![], None)], "b").refused().unwrap();
        assert_eq!(refused, "step a: query t reads step b, which does not come before it");
        assert_eq!(route(vec![step("b", vec![], None), step("a", vec![read("b")], None)], "a").refused(), None);

        assert_eq!(route(vec![step("a", vec![], None), step("a", vec![], None)], "a").refused().as_deref(), Some("two steps are named a"));
        assert_eq!(route(vec![step("a", vec![], None)], "z").refused().as_deref(), Some("the answer names step z, which the body does not have"));
        let mut old = route(vec![step("a", vec![], None)], "a");
        old.v = VERSION + 1;
        assert!(old.refused().unwrap().starts_with(&format!("the body is version {}", VERSION + 1)));
        let mut planned = route(vec![step("a", vec![], None)], "a");
        planned.plan = Some(Plan { page: "not an address".into(), goal: "g".into(), asked: vec![], done: vec![] });
        assert_eq!(planned.refused().as_deref(), Some("the plan's page not an address is no address"));
        let mut tested = route(vec![step("a", vec![], None)], "a");
        tested.tests = vec![Test { step: "gone".into(), sightings: vec![], over_scripts: vec![] }];
        assert_eq!(tested.refused().as_deref(), Some("a test is of step gone, which the body does not have"));
    }

    /// What a caller must give is each slot the steps read, once, in the order they are first sent, and the slot a file
    /// upload reads is among them after the others.
    #[test]
    fn what_a_caller_must_give_lists_each_slot_once_and_the_upload_last() {
        let upload = Form::Upload { slot: "file".into(), protocol: json!({}), content_type: None };
        let r = route(
            vec![
                step("a", vec![slot_hole(Place::Query("q".into()), "q"), slot_hole(Place::Header("x".into()), "q"), slot_hole(Place::Query("n".into()), "n")], None),
                step("b", vec![slot_hole(Place::Query("m".into()), "m")], Some(upload.clone())),
                step("c", vec![], Some(upload)),
            ],
            "c",
        );
        assert_eq!(r.asked(), ["q", "n", "m", "file"]);
    }
}
