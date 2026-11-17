//! What a route's values mean (`route::meaning`), read from what the learner already found: a slot's kind from what
//! its ways do with it, and the answer's records from its replies on every walk. Nothing here asks a proposer or a
//! site: a kind is what a way does with the value (a way that reads it as a date makes it a date), never a guess at
//! what the value looks like.

use std::collections::BTreeMap;

use serde_json::Value;
use unbrowse_route as route;
use unbrowse_route::meaning::{Field, Kind, Records};
use unbrowse_route::{Expr, Pattern};

/// The kind a time form reads: a day, a time of day, or both.
fn kind_of_form(form: &str) -> Kind {
    let fields: Vec<&str> = route::format::pieces(form).into_iter().filter_map(|p| if let route::format::Piece::Field(f) = p { Some(f) } else { None }).collect();
    let day = fields.iter().any(|f| matches!(*f, "yyyy" | "yy" | "mm" | "m" | "mon" | "month" | "dd" | "d" | "s" | "ms"));
    let clock = fields.iter().any(|f| matches!(*f, "hh" | "h" | "min" | "ss"));
    match (day, clock) {
        (true, true) => Kind::Moment,
        (false, true) => Kind::Time,
        _ => Kind::Date,
    }
}

/// Each slot's kind, by what the body's ways do with it: read as a date, a time or a number (`Expr::Format`), looked up
/// in a table the site ships (`Expr::Lookup`), or, where a way does neither, sent as written with a letter in its
/// example (free text). And each looked-up slot's choices: what the table lists in the field the word is held to.
pub fn kinds(body: &route::Route) -> (BTreeMap<String, Kind>, BTreeMap<String, Vec<String>>) {
    let mut found: BTreeMap<String, Kind> = BTreeMap::new();
    let mut choices: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let exprs: Vec<&Expr> = body.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).flat_map(|w| w.expr.all()).collect();
    for e in &exprs {
        match e {
            Expr::Format { of, read, .. } => {
                for name in of.slots() {
                    let kind = match read {
                        Pattern::Time { form } => kind_of_form(form),
                        Pattern::Number { .. } => Kind::Number,
                    };
                    found.insert(name.to_string(), kind);
                }
            }
            Expr::Lookup { rows, fits, .. } => {
                let at = match fits {
                    route::Fits::Equals { at, .. } | route::Fits::Holds { at, .. } => at,
                };
                for name in fits.is().slots() {
                    found.insert(name.to_string(), Kind::Listed);
                    let listed: Vec<String> = rows.iter().filter_map(|r| r.pointer(at)).filter_map(|v| v.as_str().map(String::from).or_else(|| v.as_number().map(|n| n.to_string()))).collect();
                    choices.insert(name.to_string(), listed);
                }
            }
            _ => {}
        }
    }
    for slot in &body.slots {
        let words = slot.example.as_deref().is_some_and(|v| v.chars().any(char::is_alphabetic));
        if !found.contains_key(&slot.name) && !slot.secret && words && exprs.iter().any(|e| e.slots().contains(&slot.name.as_str())) {
            found.insert(slot.name.clone(), Kind::Text);
        }
    }
    (found, choices)
}

/// The longest list of records (objects) a reply holds, with its pointer: the first of them where two are as long.
fn records_list(v: &Value) -> Option<(String, &Vec<Value>)> {
    fn walk<'v>(v: &'v Value, at: String, best: &mut Option<(String, &'v Vec<Value>)>) {
        match v {
            Value::Array(a) => {
                if a.len() >= 2 && a.iter().all(Value::is_object) && best.as_ref().is_none_or(|(_, b)| a.len() > b.len()) {
                    *best = Some((at.clone(), a));
                }
                a.iter().enumerate().for_each(|(i, x)| walk(x, format!("{at}/{i}"), best));
            }
            Value::Object(o) => o.iter().for_each(|(k, x)| walk(x, format!("{at}/{}", k.replace('~', "~0").replace('/', "~1")), best)),
            _ => {}
        }
    }
    let mut best = None;
    walk(v, String::new(), &mut best);
    best
}

/// The answer's records, read from its reply on each walk (`replies`, each with what that walk was asked, by slot
/// name): the list of records at the same place on every reply, each field every record of every walk carries, and,
/// for a field, the slot whose value it says (case aside) on most records of every walk. None where a reply holds no
/// such list, or the walks' lists sit in different places.
pub fn records(replies: &[(Value, Vec<(String, String)>)]) -> Option<Records> {
    let lists: Vec<(String, &Vec<Value>)> = replies.iter().map(|(v, _)| records_list(v)).collect::<Option<_>>()?;
    let list = lists.first()?.0.clone();
    if lists.iter().any(|(at, _)| *at != list) {
        return None;
    }
    let leaves = |r: &Value| crate::slots::json_leaves(r).into_iter().collect::<BTreeMap<String, String>>();
    let first = leaves(lists[0].1.first()?);
    let mut fields = Vec::new();
    for at in first.keys() {
        if !lists.iter().all(|(_, items)| items.iter().all(|r| r.pointer(at).is_some_and(|v| !v.is_object() && !v.is_array()))) {
            continue;
        }
        let name = at.trim_start_matches('/').replace('/', ".");
        // The slot this field says back: on every walk, on more than half of that walk's records.
        let says = replies.first().and_then(|(_, asked)| {
            asked.iter().map(|(n, _)| n.clone()).find(|name| {
                replies.iter().zip(&lists).all(|((_, asked), (_, items))| {
                    let Some((_, value)) = asked.iter().find(|(n, _)| n == name) else { return false };
                    let value = value.to_lowercase();
                    let saying = items.iter().filter(|r| r.pointer(at).and_then(Value::as_str).is_some_and(|f| !value.is_empty() && f.to_lowercase().contains(&value))).count();
                    saying * 2 > items.len()
                })
            })
        });
        fields.push(Field { name, at: at.clone(), says });
    }
    (!fields.is_empty()).then_some(Records { list, fields })
}

/// Other values a slot of a known kind takes, for a test of the route that asks it a second value: another date or
/// number in the form the slot is read in (`forms::others_of_its_kind`), or another of the words the site lists. In
/// the body's order of slots, each value once. Empty where no slot has a kind that says what another value is (free
/// text: a word is asked of the page, as before).
pub fn other_values(body: &route::Route) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let exprs: Vec<&Expr> = body.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).flat_map(|w| w.expr.all()).collect();
    for slot in &body.slots {
        let Some(example) = slot.example.as_deref() else { continue };
        let values: Vec<String> = match body.meaning.kinds.get(&slot.name) {
            Some(Kind::Date | Kind::Time | Kind::Moment | Kind::Number) => exprs
                .iter()
                .find_map(|e| match e {
                    Expr::Format { of, read, .. } if of.slots().contains(&slot.name.as_str()) => Some(crate::lab::forms::others_of_its_kind(example, read)),
                    _ => None,
                })
                .unwrap_or_default(),
            Some(Kind::Listed) => slot.choices.iter().filter(|c| !c.eq_ignore_ascii_case(example)).cloned().collect(),
            _ => Vec::new(),
        };
        for v in values {
            if !out.contains(&v) {
                out.push(v);
            }
        }
    }
    out
}

/// The slots of a body whose kind says what another value of them is (a date, a time, a number, a listed word), with
/// their kinds: what the four tests ask a value of that kind of, rather than a word.
pub fn kind_slots(body: &route::Route) -> Vec<(String, Kind)> {
    body.slots.iter().filter_map(|s| body.meaning.kinds.get(&s.name).filter(|k| **k != Kind::Text).map(|k| (s.name.clone(), *k))).collect()
}

/// The written forms of `value` an answer may say it back in: as it is, and as each format the body's ways write the
/// slot `name` in (`Expr::Format`). A date asked `2026-03-25` and sent `25/03/2026` is said back in either.
pub fn said_as(body: &route::Route, name: &str, value: &str) -> Vec<String> {
    let mut out = vec![value.to_string()];
    for way in body.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways) {
        for e in way.expr.all() {
            if let Expr::Format { of, read, write } = e {
                if of.slots().contains(&name) {
                    if let Some(v) = route::format::reformat(value, read, write).filter(|v| !out.contains(v)) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

/// Whether an answer says `value` of the slot `name` back, in any form the route writes it ([`said_as`]): on more than
/// half of its records where the body knows its records and which field says the asked value back, else on two of
/// its lines at least, as the trial's reader holds a word.
pub fn says_back(body: &route::Route, name: &str, value: &str, answer: &Value) -> bool {
    let forms: Vec<String> = said_as(body, name, value).into_iter().map(|f| f.to_lowercase()).collect();
    if let Some((n, saying)) = records_saying(body, answer, name, &forms) {
        return n > 0 && saying * 2 > n;
    }
    crate::lab::answer::said_lines(answer, &[]).iter().filter(|line| forms.iter().any(|f| line.contains(f.as_str()))).count() >= 2
}

/// How many records the answer holds (`Meaning::records`), and how many of them say one of `forms` (small letters) in
/// the field that says the slot `name` back. None where the body knows no such field.
pub fn records_saying(body: &route::Route, answer: &Value, name: &str, forms: &[String]) -> Option<(usize, usize)> {
    records_saying_but(body, answer, name, forms, &[])
}

/// [`records_saying`], counting only the records that say none of `but`: a second value that holds the first
/// (`kettle one` beside `kettle`) says the first in every record of its own, and a record is the first's only where
/// it says the first and not the second.
pub fn records_saying_but(body: &route::Route, answer: &Value, name: &str, forms: &[String], but: &[String]) -> Option<(usize, usize)> {
    let records = body.meaning.records.as_ref()?;
    let field = records.fields.iter().find(|f| f.says.as_deref() == Some(name))?;
    let items = answer.pointer(&records.list).and_then(Value::as_array).cloned().unwrap_or_default();
    let says = |f: &str, forms: &[String]| forms.iter().any(|form| f.to_lowercase().contains(form.as_str()));
    let saying = items.iter().filter(|r| r.pointer(&field.at).and_then(Value::as_str).is_some_and(|f| says(f, forms) && !says(f, but))).count();
    Some((items.len(), saying))
}

/// A nonsense value of a slot's kind, where its kind says what one is: a date of the slot's own form a century from
/// the walk's (a site has nothing for it, or fills in), a number of its form far from any. None for a listed word: the
/// site's own table is what a nonsense word is held to ([`listed_nothing`]), and none for free text, which the tests
/// give a nonsense word as before.
pub fn nonsense_of_its_kind(body: &route::Route, name: &str, walked: &str) -> Option<String> {
    let read = body.steps.iter().flat_map(|s| &s.holes).flat_map(|h| &h.ways).flat_map(|w| w.expr.all()).find_map(|e| match e {
        Expr::Format { of, read, .. } if of.slots().contains(&name) => Some(read.clone()),
        _ => None,
    })?;
    match &read {
        Pattern::Time { form } => {
            let m = route::format::Moment::read(walked, form)?;
            route::format::Moment { year: m.year.map(|y| y - 100), ..m }.write(form)
        }
        Pattern::Number { point, group, .. } => Some(route::format::Figure { negative: false, whole: "987654321".into(), fraction: String::new() }.write(point, group, None)),
    }
}

/// Where a slot of `inputs` is a listed word (`Kind::Listed`) that the site's own table does not list: no record fits
/// it, and the page sends nothing for it. The slot and the word.
pub fn listed_nothing(body: &route::Route, inputs: &std::collections::HashMap<String, String>) -> Option<(String, String)> {
    body.slots.iter().filter(|s| body.meaning.kinds.get(&s.name) == Some(&Kind::Listed) && !s.choices.is_empty()).find_map(|s| {
        let v = inputs.get(&s.name)?;
        (!s.choices.iter().any(|c| c.eq_ignore_ascii_case(v))).then(|| (s.name.clone(), v.clone()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn way(expr: Expr) -> route::Way {
        route::Way { rung: 0, expr }
    }

    fn slot(name: &str, example: &str) -> route::Slot {
        route::Slot { name: name.into(), secret: false, example: Some(example.into()), choices: Vec::new() }
    }

    /// A slot read as a date is a date, one looked up in the site's table is one of its words (the table's names its
    /// choices), and one sent as written is free text; a slot nothing reads has no kind.
    #[test]
    fn a_slots_kind_is_what_its_ways_do_with_it() {
        let of = |name: &str| Box::new(Expr::Slot { name: name.into(), or: None, optional: false });
        let ways = vec![
            way(Expr::Format { of: of("when"), read: Pattern::Time { form: "{yyyy}-{mm}-{dd}".into() }, write: Pattern::Time { form: "{dd}/{mm}/{yyyy}".into() } }),
            way(Expr::Lookup { rows: vec![json!({ "name": "Lisbon", "code": "LIS" }), json!({ "name": "Oslo", "code": "OSL" })], fits: route::Fits::Equals { at: "/name".into(), is: of("city") }, take: "/code".into() }),
            way(Expr::Written { of: of("q"), how: route::How::Percent }),
            way(Expr::Format { of: of("at"), read: Pattern::Time { form: "{hh}:{min}".into() }, write: Pattern::Time { form: "{h}h{min}".into() } }),
        ];
        let holes = ways.into_iter().enumerate().map(|(i, w)| route::Hole { at: route::Place::Query(format!("k{i}")), ways: vec![w], over: false, open: false }).collect();
        let step = route::Step { id: "x0".into(), method: "GET".into(), url: "https://shop.example/api".into(), holes, body: None, expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None };
        let body = route::Route { v: route::VERSION, site: "shop.example".into(), slots: vec![slot("when", "2026-03-04"), slot("city", "Lisbon"), slot("q", "red lamp"), slot("at", "09:30"), slot("unused", "x")], steps: vec![step], answer: route::Answer { step: "x0".into(), page: false, decode: None }, tests: Vec::new(), plan: None, meaning: Default::default() };
        let (kinds, choices) = kinds(&body);
        assert_eq!(kinds, BTreeMap::from([("when".into(), Kind::Date), ("city".into(), Kind::Listed), ("q".into(), Kind::Text), ("at".into(), Kind::Time)]));
        assert_eq!(choices["city"], vec!["Lisbon".to_string(), "Oslo".to_string()]);
        // A second value of each kind, for the route's tests: another date in the slot's own form, then another of
        // the site's words. Free text and a time say nothing here before a date does.
        let mut body = body;
        body.meaning.kinds = kinds;
        body.slots[1].choices = choices["city"].clone();
        let others = other_values(&body);
        assert_eq!(others.first().map(String::as_str), Some("2026-03-25"));
        assert!(others.contains(&"Oslo".to_string()) && !others.contains(&"Lisbon".to_string()));
    }

    /// The answer's records are the list every walk's reply holds in one place, each field all their records carry,
    /// and the field that says what each walk was asked.
    #[test]
    fn the_answers_fields_are_what_every_record_of_every_walk_carries() {
        let reply = |q: &str| json!({ "query": q, "results": [{ "title": format!("{q} one"), "price": 12, "tags": ["a"] }, { "title": format!("{q} two"), "price": 34, "tags": [] }] });
        let found = records(&[(reply("kettle"), vec![("q".into(), "kettle".into())]), (reply("teapot"), vec![("q".into(), "teapot".into())])]).expect("records");
        assert_eq!(found.list, "/results");
        assert_eq!(found.fields, vec![Field { name: "price".into(), at: "/price".into(), says: None }, Field { name: "title".into(), at: "/title".into(), says: Some("q".into()) }]);
        assert_eq!(records(&[(json!({ "ok": true }), Vec::new())]), None, "a reply with no list of records has none");
    }
}
