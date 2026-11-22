//! What a call's repeats say about it. A walk that reads on, or a reader who sets a filter, makes the same call again
//! with one value changed. What changed, and how, says what that value is:
//!
//! | The value...                                                  | It is     | The route            |
//! |---------------------------------------------------------------|-----------|----------------------|
//! | sits in the answer before it, outside any list of records     | a token   | hands it on, read from each answer |
//! | climbs by the same step, from the start of a list             | a count   | adds the step        |
//! | is something else the page offered, short and readable        | a choice  | takes it as an input |
//! | is none of these (a nonce, an opaque id)                      | unknown   | keeps the first call's value |
//!
//! Nothing here knows a site or a word for "page": it reads where the value came from and how it moved.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::graph::{Body, Class, Field, Step};
use crate::slots::{json_leaves, slots, Loc};
use crate::trace::Exchange;

/// How a route reads on to the list's next page.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "by", rename_all = "snake_case")]
pub enum Paging {
    /// A number that climbs by `step` from one page to the next: a page number, an offset.
    Count { input: String, step: u64 },
    /// A value each answer hands over at `from` (a JSON pointer) for the call that reads on.
    Token { input: String, from: String },
}

impl Paging {
    pub fn input(&self) -> &str {
        match self {
            Paging::Count { input, .. } | Paging::Token { input, .. } => input,
        }
    }

    /// Whether the input this reads on with is a secret one of `graph`'s fields takes (`Class::Input { secret }`): a
    /// password, a code, a PIN, a card number the vault fills. The next page is worked out from what was sent, so a
    /// count over it would hand back the secret plus one, and a token in its place is the secret's own text. A call
    /// reads on over a secret never: the call is refused (the app's `api::call`), and no next page is said
    /// (`run::next_page`).
    pub fn over_secret(&self, graph: &crate::graph::Graph) -> bool {
        graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!(&f.class, Class::Input { name, secret: true, .. } if name == self.input()))
    }

    /// The value that reads on from `answer`, which `sent` asked for (None: the first page, asked for by leaving the
    /// input out). None when the answer says the list has ended: it hands over no token, or holds no records.
    pub fn next(&self, sent: Option<&str>, answer: &Value) -> Option<String> {
        match self {
            Paging::Token { from, .. } => match answer.pointer(from)? {
                Value::String(s) if !s.is_empty() => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            },
            Paging::Count { step, .. } => {
                let at = match sent {
                    Some(v) => v.trim().parse::<u64>().ok()?,
                    None => implied_first(*step),
                };
                holds_records(answer, 0).then(|| (at + step).to_string())
            }
        }
    }
}

/// The value a list left unnumbered starts from: 1 for a page number, 0 for an offset.
fn implied_first(step: u64) -> u64 {
    u64::from(step == 1)
}

/// The largest value a count starts from, or steps to: past it, it is a clock or an id, not a place in a list.
const MOST_COUNTED: u64 = 10_000_000;

/// The longest value a page offers as a choice.
const LONGEST_CHOICE: usize = 48;

/// Whether `answer` holds a list with something in it, or a page's text.
fn holds_records(v: &Value, depth: usize) -> bool {
    if depth > 16 {
        return false;
    }
    match v {
        Value::Array(a) => a.iter().any(|x| x.is_object() || x.is_string()) || a.iter().any(|x| holds_records(x, depth + 1)),
        Value::Object(o) => o.get("text").and_then(Value::as_str).is_some_and(|t| !t.trim().is_empty()) || o.values().any(|x| holds_records(x, depth + 1)),
        _ => false,
    }
}

/// What one changed value turned out to be.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reading {
    Paging { loc: Loc, paging: Paging, first: Option<String>, sample: String },
    /// A value the reader chose among: `values` are those the walk saw, the first call's first when it sent one.
    Choice { loc: Loc, name: String, values: Vec<String>, first: Option<String> },
    /// Changed, and says nothing more: the route keeps what the first call sent.
    Pinned { loc: Loc },
}

/// Reads what changed between the repeats of a call, `first` among them. `asked` holds the caller's own values, which
/// are theirs whatever they do; a header or a cookie is the session's.
pub fn read(first: &Exchange, repeats: &[&Exchange], asked: &[&str]) -> Vec<Reading> {
    let value_at = |e: &Exchange, loc: &Loc| slots(e).into_iter().find(|s| s.loc == *loc).map(|s| s.value);
    let mut locs: Vec<Loc> = Vec::new();
    for e in std::iter::once(first).chain(repeats.iter().copied()) {
        for s in slots(e) {
            if !locs.contains(&s.loc) {
                locs.push(s.loc);
            }
        }
    }
    let mut out = Vec::new();
    let mut paged = false;
    for loc in locs {
        let at_first = value_at(first, &loc);
        if at_first.as_deref().is_some_and(|v| asked.contains(&v)) {
            continue;
        }
        let mut later: Vec<String> = Vec::new();
        for e in repeats {
            if let Some(v) = value_at(e, &loc).filter(|v| Some(v) != at_first.as_ref() && !later.contains(v)) {
                later.push(v);
            }
        }
        if later.is_empty() || later.iter().any(|v| asked.contains(&v.as_str())) {
            continue;
        }
        if matches!(loc, Loc::Header(_) | Loc::Cookie(_) | Loc::Url) {
            out.push(Reading::Pinned { loc });
            continue;
        }
        let name = name_of(&loc);
        let sample = later[0].clone();
        let paging = if paged { None } else { token(first, &later[0], &name).or_else(|| count(at_first.as_deref(), &later, &name)) };
        out.push(match paging {
            Some(paging) => {
                paged = true;
                Reading::Paging { loc, paging, first: at_first, sample }
            }
            None if name.is_some() && at_first.iter().chain(&later).all(|v| offered(v)) && !matches!(loc, Loc::Path(_)) => {
                let values = at_first.iter().chain(&later).cloned().collect();
                Reading::Choice { name: name.unwrap_or_default(), loc, values, first: at_first }
            }
            None => Reading::Pinned { loc },
        });
    }
    out
}

/// The name an input at `loc` goes by: the key the site itself gave it. A list's place in a JSON body names nothing.
fn name_of(loc: &Loc) -> Option<String> {
    match loc {
        Loc::Query(k) | Loc::Form(k) => Some(k.clone()),
        Loc::Json(p) => p.rsplit('/').find(|s| !s.is_empty() && !s.bytes().all(|b| b.is_ascii_digit())).map(String::from),
        _ => None,
    }
}

/// A token: the next call's value lies in the answer to the first, outside any list. A value in a list is one of the
/// records or facets the answer offers, which the reader picked; a token is the answer's own word about itself.
fn token(first: &Exchange, next: &str, name: &Option<String>) -> Option<Paging> {
    let input = name.clone()?;
    let answer = first.own_json()?;
    let (from, _) = json_leaves(&answer).into_iter().find(|(pointer, v)| v == next && !pointer.split('/').any(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())))?;
    Some(Paging::Token { input, from })
}

/// A count: the value climbs by one step, and the walk saw it start, or saw enough of it to know the step is steady.
fn count(first: Option<&str>, later: &[String], name: &Option<String>) -> Option<Paging> {
    let input = name.clone()?;
    let numbers: Vec<u64> = later.iter().map(|v| v.parse::<u64>().ok().filter(|n| *n <= MOST_COUNTED)).collect::<Option<_>>()?;
    let second = *numbers.first()?;
    let steady = |step: u64| numbers.windows(2).all(|w| w[1] == w[0] + step);
    let step = match first {
        Some(v) => {
            let start = v.parse::<u64>().ok().filter(|n| *n <= MOST_COUNTED)?;
            let step = second.checked_sub(start).filter(|s| *s > 0)?;
            (start <= 1 || numbers.len() >= 2).then_some(step)?
        }
        // The first call left it out: it starts at 1 when the next is 2, else from nothing.
        None if second == 2 => 1,
        None => second,
    };
    (step > 0 && steady(step)).then_some(Paging::Count { input, step })
}

/// Whether a value reads as something a page offers: short, and a word or a small number rather than an opaque id.
fn offered(v: &str) -> bool {
    let digits = v.bytes().filter(u8::is_ascii_digit).count();
    let opaque = v.len() >= 16 && digits * 3 >= v.len();
    !v.is_empty() && v.len() <= LONGEST_CHOICE && !opaque && !(digits == v.len() && digits > 9) && v.chars().all(|c| c.is_alphanumeric() || " _-.:,+/|".contains(c))
}

/// Keeps a reading's value as `step` asks: the first call's value stands unless the caller says otherwise.
pub fn apply(step: &mut Step, reading: &Reading) {
    match reading {
        Reading::Paging { loc, paging, first, sample } => {
            // A token an earlier answer already gives is not the site's next-page token: it is a value the route
            // re-derives (a search's session, a clearance), and leaving it out is leaving out what the call needs. A
            // cursor the answer hands over for the next page is a value with no source before the call, and binds.
            if step.fields.iter().any(|f| f.loc == *loc && matches!(&f.class, Class::Derived { origin } if origin.exchange < step.exchange)) {
                return;
            }
            let start = from_the_start(paging, first.as_deref());
            // A token an answer handed over reads on from that answer: the first call the walk saw send one was already
            // reading on, and its token holds the walk's own search. A new call starts by leaving it out.
            let first = first.as_deref().filter(|_| !matches!(paging, Paging::Token { .. }));
            bind(step, loc, paging.input(), start.as_deref().or(first), Some(sample))
        }
        Reading::Choice { loc, name, values, first } => bind(step, loc, name, first.as_deref(), values.last().map(String::as_str)),
        Reading::Pinned { loc } => pin(step, loc),
    }
}

/// The value a count starts from, when the walk first saw it one step past its start: a page that arrives with its first
/// results asks its data call only for what comes next, so `page=2` is where the page's reader went, not where a new
/// search starts.
fn from_the_start(paging: &Paging, first: Option<&str>) -> Option<String> {
    let Paging::Count { step, .. } = paging else { return None };
    let start = implied_first(*step);
    (first?.parse::<u64>().ok()? == start + step).then(|| start.to_string())
}

/// `loc` as optional input `name`: a caller needn't give it. Left out, the call sends the first call's value, or, when
/// the first call sent none, nothing.
fn bind(step: &mut Step, loc: &Loc, name: &str, first: Option<&str>, sample: Option<&str>) {
    let Some(first) = first else {
        place_optional(step, loc, name, sample);
        return;
    };
    let class = Class::Input { name: name.to_string(), secret: false, default: Some(first.to_string()), optional: true };
    match step.fields.iter_mut().find(|f| f.loc == *loc) {
        Some(f) => f.class = class,
        None => step.fields.push(Field { loc: loc.clone(), class }),
    }
    if let (Loc::Json(pointer), Some(Body::Json { template, types })) = (loc, step.body.as_mut()) {
        if let Some(slot) = template.pointer_mut(pointer) {
            types.insert(pointer.clone(), json_type(slot).to_string());
            *slot = Value::Null;
        }
    }
}

/// Opens `loc` for the field that now gives its value: a JSON body's template keeps its own copy of a value the walk
/// sent, typed, and writes that copy unless its place is blanked. A value a trial moves, or a caller is now offered,
/// would otherwise never reach the site. The value's type is kept, so a number is sent as a number.
pub fn open_slot(step: &mut Step, loc: &Loc) {
    if let (Loc::Json(pointer), Some(Body::Json { template, types })) = (loc, step.body.as_mut()) {
        if let Some(slot) = template.pointer_mut(pointer).filter(|slot| !slot.is_null()) {
            types.insert(pointer.clone(), json_type(slot).to_string());
            *slot = Value::Null;
        }
    }
}

/// The first call's value stands. A value in a JSON body it never meant for the first page is left out of it.
fn pin(step: &mut Step, loc: &Loc) {
    if let Loc::Json(pointer) = loc {
        step.fields.retain(|f| f.loc != *loc);
        if let Some(Body::Json { template, types }) = step.body.as_mut() {
            types.remove(pointer);
            remove_pointer(template, pointer);
        }
    }
}

fn json_type(v: &Value) -> &'static str {
    match v {
        Value::Number(_) => "number",
        Value::Bool(_) => "bool",
        _ => "string",
    }
}

/// Adds an optional input at `loc`, a place the recorded call doesn't send: `sample` is a value seen there, for its
/// type. A JSON key goes in only under a parent the call sends, and a place a route can't leave out (a piece of the
/// path) takes none.
pub fn place_optional(step: &mut Step, loc: &Loc, name: &str, sample: Option<&str>) {
    let class = Class::Input { name: name.to_string(), secret: false, default: None, optional: true };
    match (loc, step.body.as_mut()) {
        (Loc::Query(_), _) => {}
        (Loc::Form(key), Some(Body::Form { fields })) => {
            if !fields.iter().any(|(k, _)| k == key) {
                fields.push((key.clone(), None));
            }
        }
        (Loc::Json(pointer), Some(Body::Json { template, types })) => {
            let (parent, key) = pointer.rsplit_once('/').unwrap_or(("", pointer.as_str()));
            let Some(Value::Object(o)) = template.pointer_mut(parent) else { return };
            o.insert(key.replace("~1", "/").replace("~0", "~"), Value::Null);
            let numeric = sample.is_some_and(|v| v.parse::<f64>().is_ok());
            types.insert(pointer.clone(), if numeric { "number" } else { "string" }.to_string());
        }
        _ => return,
    }
    match step.fields.iter_mut().find(|f| f.loc == *loc) {
        Some(f) => f.class = class,
        None => step.fields.push(Field { loc: loc.clone(), class }),
    }
}

/// Takes the value at `pointer` out of a JSON body.
pub fn remove_pointer(body: &mut Value, pointer: &str) {
    let (parent, key) = pointer.rsplit_once('/').unwrap_or(("", pointer));
    if let Some(Value::Object(o)) = body.pointer_mut(parent) {
        o.remove(&key.replace("~1", "/").replace("~0", "~"));
    }
}

/// `step`'s body with `loc`, an optional input's place, gone: what the step sends when nobody gives it.
pub fn unplace(step: &mut Step, loc: &Loc) {
    step.fields.retain(|f| f.loc != *loc);
    match (loc, step.body.as_mut()) {
        (Loc::Form(key), Some(Body::Form { fields })) => fields.retain(|(k, _)| k != key),
        (Loc::Json(pointer), Some(Body::Json { template, types })) => {
            types.remove(pointer);
            remove_pointer(template, pointer);
        }
        _ => {}
    }
}

#[cfg(test)]
mod start_tests {
    use super::*;

    /// A page that serves its first results itself has its script ask for the second page first. A route learned from
    /// that call starts a new search from the start, not from where the walk's reader had got to.
    #[test]
    fn a_count_first_seen_past_its_start_starts_from_the_start() {
        let page = Paging::Count { input: "page".into(), step: 1 };
        assert_eq!(from_the_start(&page, Some("2")).as_deref(), Some("1"));
        assert_eq!(from_the_start(&page, Some("1")), None, "already the start");
        assert_eq!(from_the_start(&page, Some("7")), None, "a place the walk was sent to");
        let offset = Paging::Count { input: "offset".into(), step: 24 };
        assert_eq!(from_the_start(&offset, Some("24")).as_deref(), Some("0"));
        assert_eq!(from_the_start(&offset, Some("0")), None);
        assert_eq!(from_the_start(&Paging::Token { input: "after".into(), from: "/next".into() }, Some("2")), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(url: &str, answer: Value) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(answer.to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        }
    }

    fn posted(body: Value, answer: Value) -> Exchange {
        let mut e = call("https://shop.example/api/search", answer);
        e.method = "POST".into();
        e.request_headers = vec![("content-type".into(), "application/json".into())];
        e.request_body = Some(body.to_string());
        e
    }

    fn step(e: &Exchange) -> Step {
        let trace = crate::Trace { exchanges: vec![e.clone()], inputs: Vec::new() };
        crate::build(&[trace], |x| x.url == e.url).unwrap().steps.pop().unwrap()
    }

    fn only(readings: Vec<Reading>) -> Reading {
        assert_eq!(readings.len(), 1, "{readings:?}");
        readings.into_iter().next().unwrap()
    }


    /// A token an earlier answer already gives is not the site's next-page token: the route re-derives it, and leaving
    /// it out would send a call without the session it needs. A token with no source before the call still binds.
    #[test]
    fn a_token_an_earlier_answer_gave_is_not_paging() {
        let ex = |method: &str, url: &str, body: Option<&str>, answer: Value| Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: vec![],
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![],
            response_body: Some(answer.to_string()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        };
        let config = ex("GET", "https://shop.example/api/config", None, json!({"session": "abc123"}));
        let search = ex("POST", "https://shop.example/api/search", Some(r#"{"session":"abc123"}"#), json!({"items": []}));
        let g = crate::build(&[crate::Trace { exchanges: vec![config, search], inputs: vec![] }], |e| e.method == "POST").unwrap();
        let mut st = g.steps.last().unwrap().clone();
        let loc = Loc::Json("/session".into());
        assert!(st.fields.iter().any(|f| f.loc == loc && matches!(f.class, Class::Derived { .. })), "{:?}", st.fields);
        let token = Reading::Paging { loc: loc.clone(), paging: Paging::Token { input: "session".into(), from: "/session".into() }, first: Some("abc123".into()), sample: "def456".into() };
        apply(&mut st, &token);
        assert!(matches!(st.fields.iter().find(|f| f.loc == loc).unwrap().class, Class::Derived { .. }), "the session is the page's, not a cursor");
        for f in &mut st.fields {
            if f.loc == loc {
                f.class = Class::Unconfirmed { value: "abc123".into() };
            }
        }
        apply(&mut st, &token);
        assert!(matches!(st.fields.iter().find(|f| f.loc == loc).unwrap().class, Class::Input { optional: true, .. }), "a token with no source before it is paging");
    }

    /// A number that climbs from the list's start is a place in it, by page or by offset.
    #[test]
    fn a_value_that_climbs_from_the_start_is_a_count() {
        let a = call("https://shop.example/api?q=lamp&page=1", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/api?q=lamp&page=2", json!({"items": [{"id": 2}]}));
        let Reading::Paging { paging, first, .. } = only(read(&a, &[&a, &b], &["lamp"])) else { panic!() };
        assert_eq!(paging, Paging::Count { input: "page".into(), step: 1 });
        assert_eq!(first.as_deref(), Some("1"));
        let a = call("https://shop.example/api?offset=0", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/api?offset=24", json!({"items": [{"id": 2}]}));
        let c = call("https://shop.example/api?offset=48", json!({"items": [{"id": 3}]}));
        let Reading::Paging { paging, .. } = only(read(&a, &[&a, &b, &c], &[])) else { panic!() };
        assert_eq!(paging, Paging::Count { input: "offset".into(), step: 24 });
    }

    /// The first page often names no page at all: the next one's value says where the list starts.
    #[test]
    fn a_first_page_that_names_no_page_still_counts() {
        let a = call("https://shop.example/search?q=lamp", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/search?q=lamp&p=2", json!({"items": [{"id": 2}]}));
        let Reading::Paging { paging, first, sample, .. } = only(read(&a, &[&a, &b], &["lamp"])) else { panic!() };
        assert_eq!((paging.clone(), first, sample.as_str()), (Paging::Count { input: "p".into(), step: 1 }, None, "2"));
        assert_eq!(paging.next(None, &json!({"items": [{"id": 1}]})).as_deref(), Some("2"));
    }

    /// A clock climbs too, and in no steady step: it is nobody's page.
    #[test]
    fn a_clock_is_not_a_count() {
        let a = call("https://shop.example/api?_=1793383794019", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/api?_=1793383794450", json!({"items": [{"id": 2}]}));
        assert!(matches!(only(read(&a, &[&a, &b], &[])), Reading::Pinned { .. }));
    }

    /// The next call's value was the answer's own word about itself: every later answer hands the next one over.
    #[test]
    fn a_value_the_answer_handed_over_is_a_token() {
        let a = call("https://shop.example/api", json!({"items": [{"id": 1}], "meta": {"next": "b64Zm9v"}}));
        let b = call("https://shop.example/api?after=b64Zm9v", json!({"items": [{"id": 2}], "meta": {"next": null}}));
        let Reading::Paging { paging, .. } = only(read(&a, &[&a, &b], &[])) else { panic!() };
        assert_eq!(paging, Paging::Token { input: "after".into(), from: "/meta/next".into() });
        assert_eq!(paging.next(Some("x"), &json!({"meta": {"next": "c2Vjb25k"}})).as_deref(), Some("c2Vjb25k"));
        assert_eq!(paging.next(Some("x"), &json!({"meta": {"next": null}})), None, "the list has ended");
    }

    /// The first call the walk saw send a token was already reading on: its token holds the walk's own search, so a
    /// route that kept it as the default would answer every later search with the walk's next page. The input starts
    /// empty, and a call that gives none asks for the first page.
    #[test]
    fn a_token_the_walk_read_on_with_is_never_the_default() {
        let a = call("https://shop.example/api?q=lamp&after=Zmlyc3Q", json!({"items": [{"id": 1}], "meta": {"next": "c2Vjb25k"}}));
        let b = call("https://shop.example/api?q=lamp&after=c2Vjb25k", json!({"items": [{"id": 2}], "meta": {"next": null}}));
        let r = only(read(&a, &[&a, &b], &["lamp"]));
        let mut s = step(&a);
        apply(&mut s, &r);
        let f = s.fields.iter().find(|f| f.loc == Loc::Query("after".into())).expect("the token is an input");
        assert!(matches!(&f.class, Class::Input { default: None, optional: true, .. }), "{:?}", f.class);
    }

    /// A value picked from a list the answer offered is the reader's choice, even though the answer held it.
    #[test]
    fn a_value_from_the_answers_facets_is_a_choice() {
        let a = call("https://shop.example/api?q=lamp", json!({"facets": [{"value": "brass"}, {"value": "paper"}]}));
        let b = call("https://shop.example/api?q=lamp&material=brass", json!({"facets": []}));
        let Reading::Choice { name, values, first, .. } = only(read(&a, &[&a, &b], &["lamp"])) else { panic!() };
        assert_eq!((name.as_str(), values, first), ("material", vec!["brass".to_string()], None));
    }

    /// A value a reader changed is a choice, with both the walk saw: what a chart's tabs and a list's sort send.
    #[test]
    fn a_changed_word_is_a_choice() {
        let a = call("https://shop.example/api?sort=relevance", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/api?sort=price_asc", json!({"items": [{"id": 2}]}));
        let Reading::Choice { name, values, first, .. } = only(read(&a, &[&a, &b], &[])) else { panic!() };
        assert_eq!((name.as_str(), first.as_deref()), ("sort", Some("relevance")));
        assert_eq!(values, vec!["relevance", "price_asc"]);
    }

    /// An opaque value that changes with no source is a nonce or a signature: nothing a caller can choose.
    #[test]
    fn an_opaque_value_is_nobodys_choice() {
        let a = call("https://shop.example/api?sig=a81f0c39b2d47e6601ab", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/api?sig=77c2e9014fd3b85a2c10", json!({"items": [{"id": 2}]}));
        assert!(matches!(only(read(&a, &[&a, &b], &[])), Reading::Pinned { .. }));
    }

    /// One value pages the list: a second that moves with it (a page number beside an offset) stays as the first call sent.
    #[test]
    fn one_value_pages_a_list() {
        let a = call("https://shop.example/api?page=1&offset=0", json!({"items": [{"id": 1}]}));
        let b = call("https://shop.example/api?page=2&offset=24", json!({"items": [{"id": 2}]}));
        let readings = read(&a, &[&a, &b], &[]);
        assert_eq!(readings.iter().filter(|r| matches!(r, Reading::Paging { .. })).count(), 1, "{readings:?}");
    }

    /// The caller's own value is theirs, however it moved.
    #[test]
    fn the_callers_value_is_never_read() {
        let a = call("https://shop.example/api?q=lamp", json!({"items": []}));
        let b = call("https://shop.example/api?q=lamps", json!({"items": []}));
        assert!(read(&a, &[&a, &b], &["lamp", "lamps"]).is_empty());
    }

    /// The route the first call makes, with the input bound: the next page is one value away, and leaving it out asks
    /// for what the first call asked.
    #[test]
    fn a_json_body_reads_on_and_leaves_an_unset_key_out() {
        let a = posted(json!({"q": "lamp", "page": 1}), json!({"items": [{"id": 1}]}));
        let b = posted(json!({"q": "lamp", "page": 2}), json!({"items": [{"id": 2}]}));
        let mut s = step(&a);
        for r in read(&a, &[&a, &b], &["lamp"]) {
            apply(&mut s, &r);
        }
        let Some(Body::Json { template, types }) = &s.body else { panic!() };
        assert!(template["page"].is_null());
        assert_eq!(types["/page"], "number");
        assert!(s.fields.iter().any(|f| matches!(&f.class, Class::Input { name, default: Some(d), .. } if name == "page" && d == "1")));
    }

    /// A key the first call never sent goes in as optional, in its place in the body, and only there.
    #[test]
    fn a_key_only_later_calls_sent_is_optional() {
        let a = posted(json!({"q": "lamp"}), json!({"items": [{"id": 1}], "cursor": "n3xt"}));
        let b = posted(json!({"q": "lamp", "after": "n3xt"}), json!({"items": [{"id": 2}]}));
        let mut s = step(&a);
        for r in read(&a, &[&a, &b], &["lamp"]) {
            apply(&mut s, &r);
        }
        assert!(s.fields.iter().any(|f| f.loc == Loc::Json("/after".into()) && matches!(&f.class, Class::Input { optional: true, default: None, .. })));
        unplace(&mut s, &Loc::Json("/after".into()));
        let Some(Body::Json { template, .. }) = &s.body else { panic!() };
        assert!(template.get("after").is_none());
    }

    #[test]
    fn an_empty_answer_ends_a_count() {
        let p = Paging::Count { input: "page".into(), step: 1 };
        assert_eq!(p.next(Some("3"), &json!({"items": [{"id": 1}]})).as_deref(), Some("4"));
        assert_eq!(p.next(Some("3"), &json!({"items": []})), None);
        assert_eq!(p.next(Some("not a number"), &json!({"items": [{"id": 1}]})), None);
    }
}
