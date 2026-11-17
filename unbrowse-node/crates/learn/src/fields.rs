//! An answer, field by field, and the part of it a call hands back. A site answers with everything its page needs
//! (ids, flags, images, tracking, every record's every attribute), and an agent reads all of it as tokens. A route
//! knows what it was learned for, so a call hands back the fields its goal asks for, the records' names, and what
//! says back the caller's search; the reply lists every other field by its path, and the agent adds the ones it
//! wants on its next call, or asks for the whole answer.
//!
//! A path names a field the same way in every record: `items[].title` is each item's title, `byId{}.price` the price
//! of every record of an object keyed by id, `total` a field of the answer itself, `[].name` each name of an answer
//! that is a list. Nothing here knows a site: it reads the goal's words, the shapes values come in, and the answer's
//! own structure.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::goal::{self, Shape};

/// A field of an answer: its path, what kind of value it holds, and one of its values, cut short.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Field {
    pub path: String,
    /// `text`, `long text`, `number`, `true/false`, `money`, `link`, `date`, `address`, `list`, `object` or `empty`.
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub example: Option<String>,
    /// The whole value, when it reads as an address with a query: an example is cut short, and a query sits at the end.
    #[serde(skip)]
    pub asking: Option<String>,
    /// The example's text, whole: an example is cut short, and what a record says back of a search can sit past the cut
    /// ("ASOS DESIGN satin midi slip dress").
    #[serde(skip)]
    pub whole: Option<String>,
    /// The list the field sits in was only ever seen holding one record: it wraps the answer (`data[0].results[]`),
    /// and the records are in a list inside it.
    #[serde(skip)]
    pub sole: bool,
    /// The most records one list of its kind was seen holding (the list the field sits in): what repeats most is
    /// what the answer lists.
    #[serde(skip)]
    pub most: usize,
}

/// Asks for the whole answer, in a call's `fields`.
pub const ALL: &str = "*";

/// An answer this small is handed back whole: trimming it saves less than listing what was left out costs.
pub const WHOLE_UNDER: usize = 3 * 1024;

/// The most fields a call hands back by default.
const MOST_DEFAULTS: usize = 16;

/// How many records of a list are read for its fields: records are alike, and a field the first ones lack is rare.
const RECORDS_READ: usize = 24;

/// The most paths read from one answer.
const MOST_PATHS: usize = 5000;

/// The longest a value that looks like money is, to be an amount: "S$828" is one, "Start trading with $20" mentions one.
const SHORT_MONEY: usize = 24;

/// A text this long is a body, not a value to scan: a description, an article, a page's text.
const LONG_TEXT: usize = 160;

/// Words a record's own name is kept under, wherever it is asked for: what tells one record from the next.
const NAMES: [&str; 9] = ["name", "title", "symbol", "ticker", "slug", "label", "id", "url", "link"];

/// Every field of `answer`, by path, in the order the answer gives them.
pub fn paths(answer: &Value) -> Vec<Field> {
    let mut out: Vec<Field> = Vec::new();
    walk(answer, "", 0, 0, &mut out);
    out
}

fn join(prefix: &str, key: &str) -> String {
    if prefix.is_empty() {
        key.to_string()
    } else {
        format!("{prefix}.{key}")
    }
}

/// A key as a path names it. A key that carries its own arguments (`search({"input":{…}})`, as a client's cache keys
/// a field by what it was asked with) names the same field whatever the arguments: it is written `search()`, and
/// read back as every key of that name (`Tree::keep`). Kept whole, the path held one request's ids and matched no
/// later answer, so a route's default fields found nothing in any answer but the first.
fn field_key(key: &str) -> String {
    match key.split_once('(') {
        Some((name, _)) if key.ends_with(')') && !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') => format!("{name}()"),
        _ => key.to_string(),
    }
}

/// An object of records keyed by their ids (`{"a1": {...}, "b2": {...}}`): five or more members, nearly all objects
/// alike enough to share most of the first one's keys. Its keys are values, not field names, so a path reads every record
/// through `{}`. Parts of one thing that share only a type tag (a form's `stays`, `guests`, `dates`, each with its own
/// fields and a `__typename`) are that thing's fields, not records: read as records, a page's search form stood as the
/// answer's main list, ahead of the results.
fn keyed_records(map: &Map<String, Value>) -> bool {
    let records: Vec<&Map<String, Value>> = map.values().filter_map(Value::as_object).collect();
    if records.len() < 5 || records.len() * 5 < map.len() * 4 {
        return false;
    }
    let first: std::collections::BTreeSet<&String> = records[0].keys().collect();
    let alike = records.iter().filter(|r| r.keys().filter(|k| first.contains(k)).count() * 2 > first.len()).count();
    alike * 5 >= records.len() * 4
}

/// `held` is how many records the list `prefix` sits in holds here (0 outside any list).
fn walk(v: &Value, prefix: &str, depth: usize, held: usize, out: &mut Vec<Field>) {
    if out.len() >= MOST_PATHS {
        return;
    }
    if depth > 12 {
        note(out, prefix, v, held);
        return;
    }
    match v {
        Value::Object(map) if keyed_records(map) => {
            let each = format!("{prefix}{{}}");
            for r in map.values().take(RECORDS_READ) {
                walk(r, &each, depth + 1, map.len(), out);
            }
        }
        Value::Object(map) if map.is_empty() => note(out, prefix, v, held),
        Value::Object(map) => {
            for (k, x) in map {
                walk(x, &join(prefix, &field_key(k)), depth + 1, held, out);
            }
        }
        Value::Array(items) if items.iter().any(|i| i.is_object() || i.is_array()) => {
            let each = format!("{prefix}[]");
            // What the list holds of records: a `null` beside one object is still one record.
            let records = items.iter().filter(|i| i.is_object() || i.is_array()).count();
            for i in items.iter().take(RECORDS_READ) {
                walk(i, &each, depth + 1, records, out);
            }
        }
        _ => note(out, prefix, v, held),
    }
}

/// One value at `path`: a new field, or a better sighting of one already seen (a value where the first record had
/// none).
fn note(out: &mut Vec<Field>, path: &str, v: &Value, held: usize) {
    let sole = held == 1;
    let path = if path.is_empty() { "." } else { path };
    let (kind, example) = kind_of(v);
    let asking = v.as_str().filter(|s| s.contains('?') && !s.contains(char::is_whitespace)).map(String::from);
    let whole = v.as_str().filter(|s| s.chars().count() <= LONG_TEXT && addresses(s).is_empty()).map(|s| s.to_lowercase());
    match out.iter_mut().find(|f| f.path == path) {
        Some(f) if f.kind == "empty" && kind != "empty" => {
            f.kind = kind;
            f.example = example;
            f.asking = asking;
            f.whole = whole;
            f.sole &= sole;
            f.most = f.most.max(held);
        }
        // Seen again in a list of several, the list is one of records.
        Some(f) => {
            f.sole &= sole;
            f.most = f.most.max(held);
        }
        None => out.push(Field { path: path.to_string(), kind, example, asking, whole, sole, most: held }),
    }
}

/// The public network addresses `s` holds, whole, each as where it starts and ends: a dotted quad of four numbers up to
/// 255, or a global IPv6 address. Private and local ones say nothing of who is asking.
fn addresses(s: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    let part = |c: char| c.is_ascii_hexdigit() || c == '.' || c == ':';
    for (at, c) in s.char_indices().chain([(s.len(), ' ')]) {
        if part(c) {
            continue;
        }
        // The address may end in the separator that follows it (`203.0.113.9:sra`): read to its last digit.
        let token = s[from..at].trim_matches([':', '.']);
        let start = from + s[from..at].find(token).unwrap_or(0);
        let head = token.split(':').next().unwrap_or_default();
        let v4 = head.parse::<std::net::Ipv4Addr>().ok().filter(|ip| !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() && !ip.is_broadcast());
        if v4.is_some() {
            out.push((start, start + head.len()));
        } else if token.parse::<std::net::Ipv6Addr>().is_ok_and(|ip| ip.segments()[0] & 0xe000 == 0x2000) {
            out.push((start, start + token.len()));
        }
        from = at + c.len_utf8();
    }
    out
}

/// What a text says with its addresses taken out.
fn unaddressed(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut from = 0;
    for (start, end) in addresses(s) {
        out.push_str(&s[from..start]);
        out.push_str(ADDRESS_HIDDEN);
        from = end;
    }
    out.push_str(&s[from..]);
    out
}

/// What stands for a network address in an answer no one asked it of.
pub const ADDRESS_HIDDEN: &str = "[address]";

/// `answer` with every public network address in it hidden, unless the goal names the field that holds it or the caller
/// asked for that field: a site that says the caller's own address back (in a client id, a log of the request) would
/// put the machine's address in front of an agent, and from there in anything the agent writes. Nothing here knows
/// whose address it is, so a caller who wants one names its field.
pub fn without_addresses(answer: Value, goal_text: &str, asked_for: &[String]) -> Value {
    if asked_for.iter().any(|a| a == ALL) {
        return answer;
    }
    fn walk(v: Value, path: String, goal_text: &str, asked_for: &[String]) -> Value {
        match v {
            Value::String(s) => {
                let asked = asked_for.iter().any(|a| path == *a || path.starts_with(&format!("{a}.")) || path.starts_with(&format!("{a}[]")) || path.starts_with(&format!("{a}{{}}")));
                Value::String(if asked || goal_says(goal_text, &path) { s } else { unaddressed(&s) })
            }
            Value::Array(a) => Value::Array(a.into_iter().map(|x| walk(x, format!("{path}[]"), goal_text, asked_for)).collect()),
            Value::Object(m) => Value::Object(m.into_iter().map(|(k, x)| { let p = join(&path, &k); (k, walk(x, p, goal_text, asked_for)) }).collect()),
            other => other,
        }
    }
    walk(answer, String::new(), goal_text, asked_for)
}

/// Whether a goal says a field's own name, in any of its words: `get my ip address` says `ip`.
fn goal_says(goal_text: &str, path: &str) -> bool {
    let said: Vec<String> = goal_text.to_lowercase().split(|c: char| !c.is_alphanumeric()).map(String::from).collect();
    name_words(leaf(path)).iter().any(|w| said.contains(w))
}

fn kind_of(v: &Value) -> (&'static str, Option<String>) {
    match v {
        Value::Null => ("empty", None),
        Value::Bool(b) => ("true/false", Some(b.to_string())),
        Value::Number(n) => ("number", Some(n.to_string())),
        Value::String(s) if s.trim().is_empty() => ("empty", None),
        // Named, so it can be asked for, and never shown as an example.
        Value::String(s) if !addresses(s).is_empty() => ("address", None),
        Value::String(s) => {
            let kind = if s.chars().count() > LONG_TEXT {
                "long text"
            } else if goal::money(s) && s.chars().count() <= SHORT_MONEY {
                "money"
            } else if goal::link(s) {
                "link"
            } else if goal::date(s) {
                "date"
            } else {
                "text"
            };
            (kind, Some(cut(s, 24)))
        }
        Value::Array(a) if a.is_empty() => ("empty", None),
        Value::Array(a) => ("list", Some(cut(&Value::Array(a.iter().take(3).cloned().collect()).to_string(), 24))),
        Value::Object(_) => ("object", None),
    }
}

fn cut(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

fn name_words(key: &str) -> Vec<String> {
    goal::key_words(key)
}

/// What a key names a record by: its last word (`name`, `title`, `slug`), or the word before a last `text`, which says
/// how the name is written rather than what it is (`titleText`, `nameText`).
fn names_as(key: &str) -> Option<String> {
    let w = name_words(key);
    match w.as_slice() {
        [.., named, last] if last == "text" => Some(named.clone()),
        [.., last] => Some(last.clone()),
        [] => None,
    }
}

/// A field's own name: the last key of its path (`items[].price.amount` is `amount`, under `price`).
fn leaf(path: &str) -> &str {
    let last = path.rsplit('.').next().unwrap_or(path);
    last.trim_end_matches("[]").trim_end_matches("{}")
}

/// The keys a path passes through, without the records' marks: `items[].price.amount` is items, price, amount.
fn keys(path: &str) -> Vec<&str> {
    path.split('.').map(|k| k.trim_end_matches("[]").trim_end_matches("{}")).filter(|k| !k.is_empty()).collect()
}

/// The list of records a path sits in: everything up to its last `[]` or `{}` (`items[].price.amount` is in
/// `items[]`), or the answer itself.
/// The rule `defaults` chooses by, as a number a route's saved defaults are stamped with: raise it whenever `defaults`
/// would choose otherwise for the same answer, and every route's defaults are chosen again once. 2: a list of records
/// beats counts as rich as it, and a name written as text names the record (2026-11-06). 3: a record's name is the one at
/// its top, never a part's deeper in (2026-11-07). 4: a list that leads back to the page is its menu, not its records
/// (2026-11-07). 5: a record says back the search in the whole text it holds, past the example's cut (2026-11-07).
/// 6: parts of one thing that share only a type tag are its fields, not records, a list of one wraps the answer, and
/// a record that carries a price says it (2026-11-11).
pub const DEFAULTS_RULE: u32 = 6;

/// Whether fields chosen as a route's defaults miss every list of records in an answer that has one: chosen before the
/// rule could tell its records from its counts, they hand back the counts alone. Such defaults are chosen again; the
/// choice is the same when the answer is one thing that happens to hold a list.
pub fn misses_the_records(chosen: &[String], all: &[Field]) -> bool {
    let has_records = all.iter().any(|f| !records_of(&f.path).is_empty() && f.kind != "empty" && f.kind != "object");
    has_records && !chosen.is_empty() && chosen.iter().all(|p| records_of(p).is_empty())
}

/// The list of records with the most fields, when one has enough to be records rather than a list of settings. A list
/// only ever seen holding one record wraps the answer and is passed over for one that holds several: a page's state
/// handed over as `clientData[0][1]` has every field of the page in that one "record", and its results in a list inside.
fn richest_list<'f>(fields: &[&'f Field]) -> Option<&'f str> {
    let mut by_list: std::collections::BTreeMap<&str, (usize, bool)> = std::collections::BTreeMap::new();
    for f in fields {
        let seen = by_list.entry(records_of(&f.path)).or_insert((0, true));
        seen.0 += 1;
        seen.1 &= f.sole;
    }
    // What an answer lists is what repeats most and says most: a list is weighed by how many records one of it holds,
    // times all its records hold, parts included (a flight's legs and fares are the flight's). A flight with two legs
    // is then no rival to the two hundred flights, and a page's three zones none to the twenty products in one of
    // them. Counted by its own fields alone, a record whose fields mostly sit in its parts lost to one of those parts,
    // and a call handed back legs with no flight and no fare.
    let most = |l: &str| fields.iter().filter(|f| records_of(&f.path) == l).map(|f| f.most).max().unwrap_or(0);
    let several: Vec<&str> = by_list.iter().filter(|(l, (_, sole))| !l.is_empty() && !*sole).map(|(l, _)| *l).collect();
    let held = |l: &str| by_list.iter().filter(|(m, _)| m.starts_with(l)).map(|(_, (n, _))| *n).sum::<usize>();
    if let Some(best) = several.iter().copied().filter(|l| held(l) >= 3).max_by_key(|l| (most(l) * held(l), std::cmp::Reverse(l.len()))) {
        return Some(best);
    }
    by_list.into_iter().filter(|(l, (n, _))| !l.is_empty() && *n >= 3).max_by_key(|(l, (n, sole))| (!*sole, *n, std::cmp::Reverse(l.len()))).map(|(l, _)| l)
}


/// Whether a field is a price: text that shows an amount of money, or a number whose own key names one
/// (`totalPrice`, `fare`, `amount`), as an API hands a price over without its currency sign.
fn priced(f: &Field) -> bool {
    let figure = f.kind == "number" || f.example.as_deref().is_some_and(|e| e.replace(',', "").parse::<f64>().is_ok());
    // By its own key: a discount or a tax kept under `price` is a part of the price, not the price.
    f.kind == "money" || (figure && name_words(leaf(&f.path)).iter().any(|w| crate::goal::names_a_cost(w)))
}

/// How deep a field sits in its record: the keys between the record and it (`items[].title` is 1, `items[].price.label.title` 3).
/// A record's own name sits at its top; a title deeper in is a part's (a price box's heading, the same on every record).
fn depth_in(path: &str) -> usize {
    keys(&path[records_of(path).len()..]).len()
}

fn records_of(path: &str) -> &str {
    match path.rfind("[]").into_iter().chain(path.rfind("{}")).max() {
        Some(at) => &path[..at + 2],
        None => "",
    }
}

/// Whether `word` (a goal's) names the field: a key inside its record (`items[].price.amount` is price, amount), by the
/// key's own words, plural or not. The list's own name (`markets` in `markets[].ticker`) names every record, not one
/// of their fields.
fn names(path: &str, word: &str) -> bool {
    let want = singular(word);
    let inside = &path[records_of(path).len()..];
    keys(inside).iter().any(|k| name_words(k).iter().any(|w| singular(w) == want))
}

/// Whether a field's own key is a price of the moment by its words (`tick.close`, `bestBid`, `last`).
fn traded(path: &str) -> bool {
    name_words(leaf(path)).iter().any(|w| goal::TRADED.contains(&w.as_str()))
}

fn singular(w: &str) -> &str {
    match w.strip_suffix('s') {
        Some(s) if s.chars().count() >= 3 && !s.ends_with('s') => s,
        _ => w,
    }
}

/// Whether `value` is an address that asks `page` again: the same host and path, with a query that still holds a value of
/// the page's own query. A product's link may carry the search too, on another path, and a record's link on the page's
/// own path (`/item?id=5`) that carries none of it is a record.
fn asks_the_page_again(value: &str, page: &url::Url) -> bool {
    if !value.contains('?') {
        return false;
    }
    let Ok(to) = page.join(value) else { return false };
    let same = to.host_str() == page.host_str() && to.path().trim_end_matches('/') == page.path().trim_end_matches('/');
    let held: Vec<String> = page.query_pairs().map(|(_, v)| v.to_lowercase()).filter(|v| v.chars().count() >= 2).collect();
    same && to.query_pairs().any(|(_, v)| held.iter().any(|h| v.to_lowercase().contains(h.as_str())))
}

/// The lists of an answer whose records lead back to `page` still asking what it was asked: other ways of asking it (its
/// filters, its tabs, the searches it suggests, its next page). They are the page's menu, not what it found, however much
/// each record says of itself: a filter describes its look and its link at length, and a found record may be an id and
/// an image. A list inside one is part of it.
fn menus_of(fields: &[Field], page: &url::Url) -> Vec<String> {
    let mut out: Vec<String> = fields
        .iter()
        .filter(|f| !records_of(&f.path).is_empty() && f.asking.as_deref().is_some_and(|e| asks_the_page_again(e, page)))
        .map(|f| records_of(&f.path).to_string())
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The fields a call hands back by default, for a route that does `goal` and was asked `asked` (its inputs' values):
/// every field the goal names, by a key of its path or, for a field with a look of its own (a price, a link, a day),
/// by values of that look; then each matching record's name; then what says back the caller's search. An answer the
/// goal names nothing in hands back the first fields of its records, so a call is never empty by default.
pub fn defaults(fields: &[Field], goal_text: &str, asked: &[String]) -> Vec<String> {
    defaults_on(fields, goal_text, asked, "")
}

/// `defaults`, for a route learned on `page`: the lists that lead back to it (`menus_of`) are not read.
pub fn defaults_on(fields: &[Field], goal_text: &str, asked: &[String], page: &str) -> Vec<String> {
    let wanted = goal::fields(goal_text);
    let asked: Vec<String> = asked.iter().map(|a| a.to_lowercase()).filter(|a| a.chars().count() >= 2).collect();
    let menus = url::Url::parse(page).map(|p| menus_of(fields, &p)).unwrap_or_default();
    let in_a_menu = |f: &Field| menus.iter().any(|m| f.path.starts_with(m.as_str()));
    let usable: Vec<&Field> = fields.iter().filter(|f| f.kind != "empty" && f.kind != "object" && (f.kind != "address" || goal_says(goal_text, &f.path)) && !in_a_menu(f)).collect();
    let mut keep: Vec<&str> = Vec::new();
    // An answer with a list of records answers with them: the richest such list is its answer, and what sits outside
    // every list (the request said back, the session, settings) is about the call.
    let main_list = richest_list(&usable);
    // The goal's own fields: named by a key, or shown by a look of their own.
    for f in &usable {
        let figure = f.kind == "number" || f.kind == "money" || f.example.as_deref().is_some_and(|e| e.replace(',', "").parse::<f64>().is_ok());
        // Outside the records, in an answer that has them, a key above the field names nothing: `request.search.root`
        // is no field of a search's.
        let beside = main_list.is_some() && records_of(&f.path).is_empty();
        let by_name = wanted.iter().any(|w| (if beside { name_words(leaf(&f.path)).iter().any(|k| singular(k) == singular(&w.word)) } else { names(&f.path, &w.word) }) || (w.now && figure && traded(&f.path)));
        let by_look = wanted.iter().any(|w| match w.shape {
            Shape::Money => f.kind == "money",
            Shape::Link => f.kind == "link",
            Shape::Date => f.kind == "date",
            Shape::Plain => false,
        });
        if (by_name || by_look) && f.kind != "long text" {
            keep.push(&f.path);
        }
    }
    // An answer the goal names nothing in, with a text of its own at its top (a page's text, an article's body), says
    // what it says there: that text is handed back, cut to fit the reply, with the rest. A page read whose state
    // didn't hold the page (`page::read`) answers with its text.
    if keep.is_empty() {
        keep.extend(usable.iter().filter(|f| f.kind == "long text" && records_of(&f.path).is_empty()).map(|f| f.path.as_str()));
    }
    // What says back the search: a record's name for it. Outside any list, in an answer with records, it is the request
    // said back.
    for f in &usable {
        let a_record = main_list.is_none() || !records_of(&f.path).is_empty();
        let says = |e: &str| asked.iter().any(|a| e.to_lowercase().contains(a.as_str()));
        if a_record && f.kind != "long text" && f.whole.as_deref().or(f.example.as_deref()).is_some_and(says) {
            keep.push(&f.path);
        }
    }
    // The records come back with their names, whatever else was kept.
    if let Some(list) = main_list {
        if !keep.is_empty() {
            let named = NAMES.iter().filter_map(|n| usable.iter().filter(|f| records_of(&f.path) == list && name_words(leaf(&f.path)).last().is_some_and(|w| w == n) && f.kind != "long text").min_by_key(|f| depth_in(&f.path)));
            keep.extend(named.take(2).map(|f| f.path.as_str()));
        }
    }
    // A record that carries a price says it beside its name: a list of things with prices is read by what each is and
    // what it costs, whether or not the goal's words name a price (a search of homes handed back each home's title and
    // rating, and no price). The record's own, shallowest one; a goal that names a price has already kept its own.
    if let Some(list) = main_list {
        let has_price = |p: &str| p.starts_with(list) && usable.iter().any(|f| f.path == p && priced(f));
        if !keep.is_empty() && !keep.iter().any(|p| has_price(p)) {
            // The record's own price, or its parts' when the record keeps it in one (a flight's fare under its
            // policies): the one fewest keys down from the record.
            if let Some(f) = usable.iter().filter(|f| f.path.starts_with(list) && priced(f)).min_by_key(|f| keys(&f.path[list.len()..]).len()) {
                keep.push(&f.path);
            }
        }
    }
    // A record that names itself only by an id (`productCard.cgproductId`) says what it is in the text of its parts
    // (`infoFields[].fields[].paragraph.text`): the shallowest such text comes back with it, or every record reads as
    // a number and a price.
    if let Some(list) = main_list {
        let says_words = |f: &&Field| f.kind == "text" && f.example.as_deref().is_some_and(|e| e.chars().filter(|c| c.is_alphabetic()).count() >= 3);
        let kept_text = keep.iter().any(|p| p.starts_with(list) && usable.iter().any(|f| f.path == *p && says_words(f)));
        // Named by a word of its own (a ticker, a title), a record says what it is already.
        let a_name = keep.iter().any(|p| p.starts_with(list) && name_words(leaf(p)).last().is_some_and(|w| NAMES.contains(&w.as_str()) && w != "id"));
        if !keep.is_empty() && !kept_text && !a_name {
            if let Some(f) = usable.iter().filter(|f| f.path.starts_with(list) && f.path.len() > list.len() && says_words(f)).min_by_key(|f| depth_in(&f.path)) {
                keep.push(&f.path);
            }
        }
    }
    // The records the goal's fields sit in, and each one's name beside them.
    let mut lists: Vec<&str> = keep.iter().map(|p| records_of(p)).collect();
    lists.sort();
    lists.dedup();
    if keep.is_empty() {
        // Nothing named: the answer's main list (the one with most fields), else the answer itself. A list of records
        // as rich as the answer's top (a search's results beside its counts) is what it answers with.
        // A list of one record wraps the answer (`richest_list`): a list of several inside it is the answer's.
        let mut by_list: std::collections::BTreeMap<&str, (usize, bool)> = std::collections::BTreeMap::new();
        for f in &usable {
            let seen = by_list.entry(records_of(&f.path)).or_insert((0, true));
            seen.0 += 1;
            seen.1 &= f.sole;
        }
        let several = |l: &str, sole: bool| !l.is_empty() && !sole;
        let main = by_list
            .iter()
            .filter(|(l, (n, sole))| !by_list.iter().any(|(o, (m, other))| several(o, *other) && *m >= 3) || (several(l, *sole) && *n >= 3))
            .max_by_key(|(l, (n, _))| (*n, !l.is_empty(), std::cmp::Reverse(l.len())))
            .map(|(l, _)| *l)
            .unwrap_or("");
        lists = vec![main];
        // The record's own fields before its parts' (a price box's heading), each in the answer's order.
        let mut first: Vec<&&Field> = usable.iter().filter(|f| records_of(&f.path) == main && f.kind != "long text" && f.kind != "list").collect();
        first.sort_by_key(|f| depth_in(&f.path));
        keep.extend(first.into_iter().take(8).map(|f| f.path.as_str()));
    }
    // Two names at most: a title and a code (`title`, `ticker`) tell records apart; more is the record again.
    for list in &lists {
        let named = NAMES.iter().filter_map(|n| {
            usable.iter().filter(|f| records_of(&f.path) == *list && names_as(leaf(&f.path)).is_some_and(|w| w == *n) && f.kind != "long text").min_by_key(|f| depth_in(&f.path))
        });
        keep.extend(named.take(2).map(|f| f.path.as_str()));
    }
    // Each once, at most the default count, best first: a field the goal names by its own key that holds an amount
    // (`priceInfo.price`), then one named by the key above it (`priceHistoryInfo.price1MonthAgo`), then a value that
    // only looks like money (a banner's "from $10"), then the records' names, then the rest the goal names; each in
    // the answer's order. A page's state names the goal's words in hundreds of labels before it gets to the price.
    let amount = |f: &Field| f.kind == "number" || f.kind == "money" || f.example.as_deref().is_some_and(|e| e.replace(',', "").parse::<f64>().is_ok());
    let own = |f: &Field, w: &str| name_words(leaf(&f.path)).iter().any(|x| singular(x) == singular(w));
    let rank = |f: &Field| -> usize {
        let money_word = wanted.iter().filter(|w| w.shape == Shape::Money);
        let looked = wanted.iter().any(|w| match w.shape {
            Shape::Money => f.kind == "money",
            Shape::Link => f.kind == "link",
            Shape::Date => f.kind == "date",
            Shape::Plain => false,
        });
        let mut words = money_word.map(|w| w.word.as_str());
        // A price asked for as it is now: the key's own figure of the moment first, a figure over a span after.
        let span = |f: &Field| wanted.iter().any(|w| w.now) && goal::over_a_span(&name_words(leaf(&f.path)));
        let now = |f: &Field| wanted.iter().any(|w| w.now) && traded(&f.path);
        if amount(f) && !span(f) && (now(f) || wanted.iter().any(|w| w.shape == Shape::Money && own(f, &w.word))) {
            0
        } else if amount(f) && words.any(|w| names(&f.path, w)) {
            1
        } else if looked || (main_list.is_some_and(|l| f.path.starts_with(l)) && priced(f)) {
            // A look the goal asked for, or what a record costs (`priced`): beside its name, ahead of the rest.
            2
        } else if NAMES.iter().any(|n| name_words(leaf(&f.path)).last().is_some_and(|w| w == n)) {
            3
        } else {
            4
        }
    };
    // Beside the answer's records, what sits outside them comes last: it fills what room is left. Outside means
    // outside the main list, whether in no list at all or in another one (a search's cities and airports beside its
    // flights): a goal's word in their keys filled every place before the records were reached.
    let aside = |f: &Field| main_list.is_some_and(|l| !f.path.starts_with(l));
    // Of a rank, a record's own fields before its parts' (`title` before `priceBox.heading.title`).
    let mut ranked: Vec<(bool, usize, usize, usize, &str)> =
        fields.iter().enumerate().filter(|(_, f)| keep.contains(&f.path.as_str())).map(|(i, f)| (aside(f), rank(f), depth_in(&f.path), i, f.path.as_str())).collect();
    ranked.sort();
    let mut out: Vec<String> = Vec::new();
    for (_, _, _, _, p) in ranked {
        if !out.iter().any(|o| o == p) {
            out.push(p.to_string());
        }
    }
    out.truncate(MOST_DEFAULTS);
    out
}

/// The defaults for a page read (`page::read`: title, state, text, links): `defaults` when they say back what the
/// caller asked, else, when the page's rendered text says it back, the page as it renders (title, text, links). A
/// page whose state is a scrap of config (a footer's links, a script's settings) renders its results in its text,
/// and a default cut from that scrap answers every search the same.
pub fn page_defaults(answer: &Value, defaults: Vec<String>, asked: &[String]) -> Vec<String> {
    let asked: Vec<String> = asked.iter().map(|a| a.trim().to_lowercase()).filter(|a| a.chars().count() >= 2).collect();
    let Some(text) = answer.get("text").and_then(Value::as_str).filter(|_| answer.get("title").is_some()) else { return defaults };
    if asked.is_empty() || defaults.is_empty() || answer.get("state").is_none_or(Value::is_null) {
        return defaults;
    }
    let says = |t: &str| asked.iter().any(|a| t.contains(a.as_str()));
    if says(&project(answer, &defaults).to_string().to_lowercase()) || !says(&text.to_lowercase()) {
        return defaults;
    }
    ["title", "text", "links"].map(String::from).to_vec()
}

/// A path read as keys and records: `items[].price` is `items`, each, `price`.
#[derive(Clone, Debug, PartialEq)]
enum Step {
    Key(String),
    Each,
}

fn steps(path: &str) -> Vec<Step> {
    let mut out = Vec::new();
    if path == "." {
        return out;
    }
    for part in path.split('.') {
        let mut k = part;
        let mut marks = 0;
        while let Some(s) = k.strip_suffix("[]").or_else(|| k.strip_suffix("{}")) {
            k = s;
            marks += 1;
        }
        if !k.is_empty() {
            out.push(Step::Key(k.to_string()));
        }
        out.extend(std::iter::repeat_n(Step::Each, marks));
    }
    out
}

/// The shortest markup carried in a field that is read as a page: a snippet of formatting is a value.
const MARKUP_FIELD: usize = 2000;

/// `answer` with the markup its fields carry read as a page is read: a call may answer with its results drawn
/// already, a block of the page's own markup in one field (`{"output": {"html": "<div class=listing>…"}}`), and what
/// it lists is in that markup's text and links, not in the fields around it. Such a field becomes `{text, links}`,
/// as `page::read` gives them. Only markup long enough to be content that links somewhere: a formatted label, or a
/// block with no links in it, stays the text it is.
pub fn with_markup_read(answer: Value, base: &url::Url) -> Value {
    with_markup_read_at(answer, base).0
}

/// [`with_markup_read`], and the path of each field that was read, as a call's fields are written
/// (`output.results`): what the call drew is what it answers with, and a reply's defaults are its links.
pub fn with_markup_read_at(answer: Value, base: &url::Url) -> (Value, Vec<String>) {
    fn read_in(answer: Value, base: &url::Url, at: String, read_at: &mut Vec<String>) -> Value {
        match answer {
            Value::String(text) if text.len() >= MARKUP_FIELD && crate::page::is_markup("text/html", &text) => {
                let read = crate::page::read(&text, base);
                let links = read.get("links").and_then(Value::as_array).cloned().unwrap_or_default();
                if links.len() < 3 {
                    return Value::String(text);
                }
                let mut out = Map::new();
                out.insert("text".into(), read.get("text").cloned().unwrap_or(Value::Null));
                out.insert("links".into(), Value::Array(links));
                read_at.push(at);
                Value::Object(out)
            }
            Value::Array(items) => Value::Array(items.into_iter().map(|v| read_in(v, base, format!("{at}[]"), read_at)).collect()),
            Value::Object(members) => Value::Object(
                members
                    .into_iter()
                    .map(|(k, v)| {
                        let under = if at.is_empty() { k.clone() } else { format!("{at}.{k}") };
                        (k, read_in(v, base, under, read_at))
                    })
                    .collect(),
            ),
            other => other,
        }
    }
    let mut read_at = Vec::new();
    let read = read_in(answer, base, String::new(), &mut read_at);
    read_at.dedup();
    (read, read_at)
}

/// Whether `answer` is the frame of an answer with none of the records `fields` name: for every field that sits under
/// a list, the list it sits under is not there at all. A search that found nothing still answers with its list,
/// empty (`"results": []`); a page served without the data its script would fetch answers with the request's key
/// and nothing beneath it. A list that is there and empty, or reached through an empty list, is there. False where
/// no field sits under a list.
pub fn frame_without_records(answer: &Value, fields: &[String]) -> bool {
    fn there(v: &Value, path: &[Step]) -> bool {
        match path.split_first() {
            None => true,
            Some((Step::Key(k), rest)) => v.get(k).is_some_and(|x| there(x, rest)),
            Some((Step::Each, rest)) => match v {
                Value::Array(items) => items.is_empty() || items.iter().any(|x| there(x, rest)),
                Value::Object(members) => members.is_empty() || members.values().any(|x| there(x, rest)),
                _ => false,
            },
        }
    }
    // Each field's path as far as the last list it sits under, the list itself and not its records.
    let lists: Vec<Vec<Step>> = fields
        .iter()
        .map(|f| steps(f))
        .filter_map(|s| s.iter().rposition(|x| *x == Step::Each).map(|last| s[..last].to_vec()))
        .filter(|s| s.iter().any(|x| matches!(x, Step::Key(_))))
        .collect();
    !lists.is_empty() && !lists.iter().any(|list| there(answer, list))
}

#[derive(Default, Debug)]
struct Tree {
    whole: bool,
    keys: Vec<(String, Tree)>,
    each: Option<Box<Tree>>,
}

impl Tree {
    fn add(&mut self, steps: &[Step]) {
        match steps.split_first() {
            None => self.whole = true,
            Some((Step::Each, rest)) => self.each.get_or_insert_with(Default::default).add(rest),
            Some((Step::Key(k), rest)) => match self.keys.iter_mut().find(|(n, _)| n == k) {
                Some((_, t)) => t.add(rest),
                None => {
                    let mut t = Tree::default();
                    t.add(rest);
                    self.keys.push((k.clone(), t));
                }
            },
        }
    }

    fn keep(&self, v: &Value) -> Option<Value> {
        if self.whole {
            return Some(v.clone());
        }
        match v {
            Value::Object(map) => {
                let mut out = Map::new();
                if let Some(each) = &self.each {
                    for (k, x) in map {
                        if let Some(x) = each.keep(x) {
                            out.insert(k.clone(), x);
                        }
                    }
                }
                for (k, t) in &self.keys {
                    // A field named with its arguments left out (`search()`) is every key of that name.
                    if k.ends_with("()") {
                        for (held, x) in map.iter().filter(|(held, _)| field_key(held) == *k) {
                            if let Some(x) = t.keep(x) {
                                out.insert(held.clone(), x);
                            }
                        }
                    } else if let Some(x) = map.get(k).and_then(|x| t.keep(x)) {
                        out.insert(k.clone(), x);
                    }
                }
                (!out.is_empty()).then_some(Value::Object(out))
            }
            Value::Array(items) => {
                let each = self.each.as_deref()?;
                Some(Value::Array(items.iter().map(|i| each.keep(i).unwrap_or(Value::Null)).collect()))
            }
            _ => None,
        }
    }
}

/// `answer` with only the fields at `keep`, in the answer's own structure: lists keep every record, each with only
/// those fields. A path that names an object or a list keeps it whole. Nothing kept is `{}`.
pub fn project(answer: &Value, keep: &[String]) -> Value {
    if keep.iter().any(|k| k == ALL) {
        return answer.clone();
    }
    let mut tree = Tree::default();
    for k in keep {
        tree.add(&steps(k));
    }
    tree.keep(answer).unwrap_or_else(|| Value::Object(Map::new()))
}

/// What a call hands back of an answer, and what it left out: `returned` the paths kept, `more` every other field
/// (path, kind, a value), `whole` when the answer came back whole.
#[derive(Clone, Debug, Serialize)]
pub struct Shown {
    pub returned: Vec<String>,
    /// The fields left out, those beside the returned ones first, at most `MORE_LISTED`.
    pub more: Vec<Field>,
    /// How many fields were left out in all.
    pub more_total: usize,
    pub whole: bool,
    /// How to ask for more, when something was left out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add: Option<&'static str>,
}

/// The most left-out fields a reply lists.
pub const MORE_LISTED: usize = 20;

const ADD: &str = "data holds the fields in returned. To get others, call again with fields: the paths you want from more (a path ending in a list or an object brings all of it), or [\"*\"] for the whole answer.";

/// The records of `answer`'s lists that name one of `subject` (at the start of a word, any case), when some do and
/// some don't: a page for one thing (`/prices/bitcoin`) answered by a list of every thing gets back its own.
/// Lists that name none of them, or only them, are left as they are.
pub fn about(answer: &Value, subject: &[String]) -> Value {
    fn names(v: &Value, subject: &[String]) -> bool {
        let text = v.to_string().to_lowercase();
        subject.iter().any(|t| text.match_indices(t.as_str()).any(|(at, _)| at == 0 || !text[..at].chars().next_back().is_some_and(char::is_alphanumeric)))
    }
    match answer {
        Value::Array(items) if items.len() >= 3 && items.iter().all(Value::is_object) => {
            let kept: Vec<Value> = items.iter().filter(|i| names(i, subject)).cloned().collect();
            if kept.is_empty() || kept.len() == items.len() {
                Value::Array(items.iter().map(|i| about(i, subject)).collect())
            } else {
                Value::Array(kept)
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(|i| about(i, subject)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), about(v, subject))).collect()),
        _ => answer.clone(),
    }
}

/// The most figures a page read's text hands back by default.
const MOST_FIGURES: usize = 8;

/// The lines of a page's text that are figures with a look of money, each after the line before it (its label).
fn figures(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let mut out: Vec<String> = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if out.len() >= MOST_FIGURES {
            break;
        }
        if goal::money(l) && l.chars().count() <= SHORT_MONEY {
            let label = if i > 0 && !goal::money(lines[i - 1]) && lines[i - 1].chars().count() <= 60 { format!("{}: ", lines[i - 1]) } else { String::new() };
            out.push(format!("{label}{l}"));
        }
    }
    out.join("\n")
}

/// The part of `answer` a call hands back: the whole of it when it is small or `asked_for` holds `*`; else the
/// route's `defaults` and the fields the caller added in `asked_for`. A path the caller added that the answer
/// doesn't hold is kept anyway: the next answer may hold it.
pub fn shown(answer: &Value, defaults: &[String], asked_for: &[String]) -> (Value, Shown) {
    let all = paths(answer);
    let small = answer.to_string().len() < WHOLE_UNDER;
    // A page read off its rendered text (title, text, links, and no state) is its text: trimming it leaves nothing.
    let rendered = answer.get("text").is_some() && answer.get("title").is_some() && answer.get("state").is_none_or(Value::is_null);
    if small || rendered || asked_for.iter().any(|a| a == ALL) || defaults.is_empty() {
        return (answer.clone(), Shown { returned: vec![ALL.to_string()], more: Vec::new(), more_total: 0, whole: true, add: None });
    }
    let mut keep: Vec<String> = defaults.to_vec();
    for a in asked_for {
        let a = a.trim();
        if !a.is_empty() && !keep.iter().any(|k| k == a) {
            keep.push(a.to_string());
        }
    }
    let mut kept = project(answer, &keep);
    // A page read keeps its text's figures, each beside the line that names it ("XRP Price: $1.24467"): its state
    // may round them (a FAQ's "$1.25").
    if let (Some(text), Value::Object(o)) = (answer.get("text").and_then(Value::as_str).filter(|_| answer.get("title").is_some()), &mut kept) {
        let figures = figures(text);
        if !keep.iter().any(|k| k == "text") && !figures.is_empty() {
            o.insert("text".into(), Value::String(figures));
        }
    }
    let covered = |p: &str| keep.iter().any(|k| p == k || p.starts_with(&format!("{k}.")) || p.starts_with(&format!("{k}[]")) || p.starts_with(&format!("{k}{{}}")));
    let lists: Vec<&str> = keep.iter().map(|k| records_of(k)).collect();
    let mut more: Vec<Field> = all.into_iter().filter(|f| !covered(&f.path) && f.kind != "empty").collect();
    // The lists of records first: the ones that came back, then the richest, each record's name before its other
    // fields. Then what sits outside any list: an answer with a list of hits shows them here, however much it says about
    // the request first.
    let mut rich: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for f in &more {
        *rich.entry(records_of(&f.path).to_string()).or_default() += 1;
    }
    let named = |f: &Field| NAMES.iter().any(|n| name_words(leaf(&f.path)).last().is_some_and(|w| w == n));
    more.sort_by_key(|f| {
        let list = records_of(&f.path);
        (list.is_empty(), !lists.contains(&list), std::cmp::Reverse(rich.get(list).copied().unwrap_or(0)), !named(f))
    });
    let more_total = more.len();
    more.truncate(MORE_LISTED);
    (kept, Shown { returned: keep, more, more_total, whole: false, add: Some(ADD) })
}

#[cfg(test)]
mod tests {
    /// A shop's search for `dress`: each product's name is a description longer than an example, with the word past the
    /// cut, beside its brand. The description says the search back, so it comes back by default, not only the brand.
    /// A record that names itself only by an id says what it is in its parts' text, which comes back with it.
    #[test]
    fn a_record_named_only_by_an_id_comes_back_with_its_text() {
        let card = |id: &str, name: &str, price: &str| serde_json::json!({"productCard": {"cgproductId": id, "price": price, "infoFields": [{"fields": [{"paragraph": {"text": name}}]}]}});
        let answer = serde_json::json!({"results": [card("P1", "iPhone 15 128GB", "876.33"), card("P2", "iPhone 15 Pro", "999.00"), card("P3", "iPhone 15 Plus", "905.00")]});
        let chosen = defaults(&paths(&answer), "search listings with titles and prices", &["iphone 15".to_string()]);
        assert!(chosen.iter().any(|p| p.ends_with("paragraph.text")), "{chosen:?}");
    }

    #[test]
    fn a_record_says_the_search_back_past_the_example_cut() {
        let products: Vec<serde_json::Value> = (0..12)
            .map(|n| serde_json::json!({ "id": 200000 + n, "brandName": "ASOS DESIGN", "description": format!("ASOS DESIGN satin bias cut midi slip dress in shade {n}"), "price": { "current": { "text": format!("£{n}.00") } } }))
            .collect();
        let answer = serde_json::json!({ "search": { "products": products, "itemCount": 2000 } });
        // A goal that names the price keeps it, so what else comes back is what says the search back, and the brand.
        let chosen = defaults(&paths(&answer), "search ASOS products with their price", &["dress".to_string()]);
        assert!(chosen.iter().any(|p| p == "search.products[].description"), "{chosen:?}");
    }

    use super::*;

    /// A search's answer that describes its filters at length, each leading back to the page, beside results known only
    /// by an id and an image. The filters held more fields and said the search back, so a caller asking for the results
    /// got the filters. What leads back to the page is its menu; what it found is the answer, however little it says.
    #[test]
    fn a_list_that_leads_back_to_the_page_is_its_menu_not_its_records() {
        let page = "https://pics.example/search/pins/?q=kitchen";
        let chip = |label: &str| {
            json!({ "id": "1", "display": { "text": label, "icon": 3, "color": "#111", "border": "#222", "hover": "#333" },
                    "action": { "feed_url": format!("https://pics.example/search/pins/?rs=guide&source=one_bar&q=kitchen%20{label}"), "title": label, "query": format!("kitchen {label}"),
                                "filters": [{ "id": "2", "action": { "feed_url": "/search/videos/?q=kitchen&rs=filter", "id": "3" } }] },
                    "aux": { "entered_query": "kitchen", "label": label, "pos": 1, "rs": "guide", "type": "GUIDE" } })
        };
        let pin = |n: u32| json!({ "id": format!("e1_{n}"), "type": "pin", "images": { "orig": { "width": 1, "height": 2, "url": format!("https://img.example/{n}.jpg") } } });
        let chips: Vec<Value> = ["cabinets", "tiles", "taps"].into_iter().map(chip).collect();
        let pins: Vec<Value> = (0..25).map(pin).collect();
        let answer = json!({ "data": { "modules": chips, "results": pins, "guides": [{ "term": "kitchen ideas" }, { "term": "kitchen tiles" }] } });
        let d = defaults_on(&paths(&answer), "search pins", &["kitchen".into()], page);
        assert!(d.iter().any(|f| f == "data.results[].id"), "{d:?}");
        assert!(d.iter().any(|f| f.starts_with("data.results[].images")), "{d:?}");
        assert!(d.iter().any(|f| f == "data.guides[].term"), "what says back the search stays: {d:?}");
        assert!(!d.iter().any(|f| f.contains("modules")), "{d:?}");
    }

    /// Only a way back to the page is a menu. A product's link carries the search on another path, and a record's link on
    /// the page's own path carries none of it: both are records, and an address with nothing asked says nothing.
    #[test]
    fn a_link_is_a_way_back_only_on_the_pages_path_still_asking_what_it_asked() {
        let page = url::Url::parse("https://shop.example/s?k=lamp").unwrap();
        assert!(asks_the_page_again("/s?k=lamp&page=2", &page));
        assert!(asks_the_page_again("/s/?k=brass%20lamp&rh=color", &page));
        assert!(asks_the_page_again("https://shop.example/s?k=lamp+shade", &page));
        assert!(!asks_the_page_again("/dp/B0001?keywords=lamp&qid=1", &page), "a product that carries the search");
        assert!(!asks_the_page_again("/s?id=5", &page), "the page's path, asking something else");
        assert!(!asks_the_page_again("https://other.example/s?k=lamp", &page), "another host");
        assert!(!asks_the_page_again("/s", &page));
        let nothing = url::Url::parse("https://shop.example/item").unwrap();
        assert!(!asks_the_page_again("/item?id=5", &nothing), "a page asked nothing has nothing to ask again");
        let shop = json!({ "items": [{ "title": "Brass lamp", "url": "/dp/1?keywords=lamp", "price": 3, "sku": "a" }, { "title": "Paper lamp", "url": "/dp/2?keywords=lamp", "price": 4, "sku": "b" }] });
        assert!(defaults_on(&paths(&shop), "search lamps", &["lamp".into()], page.as_str()).iter().any(|f| f == "items[].title"));
    }

    /// A record is named by the name at its top: a title deeper in is a part's (a price box's heading, "Price details" on
    /// every record), even where the part's key comes first.
    #[test]
    fn a_record_is_named_by_its_own_title_not_a_parts() {
        let answer = serde_json::json!({ "results": (0..4).map(|i| serde_json::json!({
            "avgRating": 4.5, "priceBox": { "heading": { "title": "Price details" } }, "title": format!("Flat {i} in Sumida-ku") })).collect::<Vec<_>>() });
        let chosen = defaults(&paths(&answer), "search stays", &["Tokyo".into()]);
        let at = |p: &str| chosen.iter().position(|c| c == p);
        assert!(at("results[].title").is_some_and(|t| at("results[].priceBox.heading.title").is_none_or(|h| t < h)), "{chosen:?}");
    }
    use serde_json::json;

    /// A page whose state is a scrap of config (a footer's columns of links) and whose text renders the results is
    /// answered by what it renders: its default fields say back what was searched. A state that holds the results
    /// keeps its own fields.
    #[test]
    fn a_page_whose_state_never_says_the_search_answers_with_what_it_renders() {
        let footer: Vec<Value> = (0..6).map(|i| json!({"textContent": format!("Help {i}"), "href": format!("/help/{i}"), "qa": format!("footer:link-{i}")})).collect();
        let page = json!({
            "title": "Search Results | Films",
            "state": {"company": {"name": "Media Co", "href": "https://media.example/"}, "desktopColumn1": footer},
            "text": format!("Search results for alien\nAlien (1979)\nAliens (1986)\nAlien: Romulus (2024)\n{}", "Help\nAbout\n".repeat(LONG_TEXT)),
            "links": [{"text": "Help", "url": "https://films.example/help"}, {"text": "Alien", "url": "https://films.example/m/alien"}],
        });
        let asked = vec!["alien".to_string()];
        let d = defaults(&paths(&page), "search titles", &asked);
        assert!(!project(&page, &d).to_string().to_lowercase().contains("alien"), "the state defaults miss the search: {d:?}");
        assert_eq!(page_defaults(&page, d, &asked), ["title", "text", "links"]);
        // A state that says the search back keeps its fields.
        let held = json!({
            "title": "alien | Search results",
            "state": {"results": [{"name": "Alien", "year": 1979}, {"name": "Aliens", "year": 1986}]},
            "text": "Search results for alien\nAlien (1979)",
            "links": [],
        });
        let d = defaults(&paths(&held), "search titles", &asked);
        assert_eq!(page_defaults(&held, d.clone(), &asked), d);
        // Nothing asked, or a text that doesn't say it either: the defaults stay.
        let d = defaults(&paths(&page), "search titles", &[]);
        assert_eq!(page_defaults(&page, d.clone(), &[]), d);
    }

    fn markets() -> Value {
        let m = |t: &str, ask: &str, rules: &str| {
            json!({"ticker": t, "title": format!("Fed above {t}?"), "yes_ask_dollars": ask, "no_ask_dollars": "0.99", "volume_fp": "356.00",
                   "rules_primary": rules, "price_ranges": [{"start": "0.00", "end": "1.00", "step": "0.01"}], "result": ""})
        };
        let long = "If the upper bound of the target federal funds rate published on the Federal Reserve's official website is greater than this level following the meeting, then the market resolves to Yes.";
        json!({"cursor": "CgwI", "markets": [m("T6.00", "0.56", long), m("T5.75", "0.61", long), m("T5.50", "0.67", long)]})
    }

    #[test]
    fn every_record_shares_one_path_per_field() {
        let p: Vec<String> = paths(&markets()).into_iter().map(|f| f.path).collect();
        assert!(p.contains(&"markets[].ticker".to_string()));
        assert!(p.contains(&"markets[].price_ranges[].step".to_string()));
        assert_eq!(p.iter().filter(|x| x.as_str() == "markets[].ticker").count(), 1);
        // An object keyed by ids reads every record through {}.
        let keyed = json!({"result": {"XBT": {"c": ["1"], "v": "2"}, "ETH": {"c": ["1"], "v": "2"}, "SOL": {"c": ["1"], "v": "2"},
            "XRP": {"c": ["1"], "v": "2"}, "DOGE": {"c": ["1"], "v": "2"}}});
        let p: Vec<String> = paths(&keyed).into_iter().map(|f| f.path).collect();
        assert_eq!(p, ["result{}.c", "result{}.v"]);
    }

    #[test]
    fn a_call_hands_back_what_its_goal_names_and_each_records_name() {
        let d = defaults(&paths(&markets()), "list open markets for an event series with their yes ask price", &[]);
        assert!(d.contains(&"markets[].yes_ask_dollars".to_string()), "{d:?}");
        assert!(d.contains(&"markets[].ticker".to_string()), "{d:?}");
        // A long text is never handed back unasked.
        assert!(!d.iter().any(|p| p.ends_with("rules_primary")), "{d:?}");
    }

    #[test]
    fn a_price_is_found_by_its_look_when_no_key_names_it() {
        let shop = json!({"results": [{"name": "Hades", "cost": {"formatted": "$24.99"}, "img": "a.png", "id": 1},
            {"name": "Hades II", "cost": {"formatted": "$29.99"}, "img": "b.png", "id": 2}, {"name": "Hades OST", "cost": {"formatted": "$9.99"}, "img": "c.png", "id": 3}]});
        let d = defaults(&paths(&shop), "search the store for a game and get its price", &["hades".into()]);
        assert!(d.contains(&"results[].cost.formatted".to_string()), "{d:?}");
        assert!(d.contains(&"results[].name".to_string()), "{d:?}");
        assert!(!d.contains(&"results[].img".to_string()), "{d:?}");
    }

    #[test]
    fn projection_keeps_the_structure_and_every_record() {
        let kept = project(&markets(), &["markets[].ticker".into(), "markets[].price_ranges[].step".into()]);
        assert_eq!(kept, json!({"markets": [
            {"ticker": "T6.00", "price_ranges": [{"step": "0.01"}]},
            {"ticker": "T5.75", "price_ranges": [{"step": "0.01"}]},
            {"ticker": "T5.50", "price_ranges": [{"step": "0.01"}]}]}));
        // A path naming an object keeps it whole; `*` keeps everything.
        assert_eq!(project(&markets(), &["markets".into()]), json!({"markets": markets()["markets"]}));
        assert_eq!(project(&markets(), &[ALL.into()]), markets());
        // A root list.
        assert_eq!(project(&json!([{"a": 1, "b": 2}, {"a": 3, "b": 4}]), &["[].a".into()]), json!([{"a": 1}, {"a": 3}]));
    }

    #[test]
    fn what_was_left_out_is_listed_and_can_be_added() {
        let big = json!({"markets": (0..40).map(|i| json!({"ticker": format!("T{i}"), "yes_ask_dollars": "0.5", "volume_fp": "1.00",
            "rules_primary": "a long rule that nobody asked for, repeated so that the answer is big enough to trim down for the agent"})).collect::<Vec<_>>()});
        let d = defaults(&paths(&big), "list markets with yes ask price", &[]);
        let (kept, s) = shown(&big, &d, &[]);
        assert!(!s.whole && kept.to_string().len() * 3 < big.to_string().len());
        assert!(s.more.iter().any(|f| f.path == "markets[].volume_fp"));
        let (kept, s) = shown(&big, &d, &["markets[].volume_fp".into()]);
        assert_eq!(kept["markets"][0]["volume_fp"], "1.00");
        assert!(!s.more.iter().any(|f| f.path == "markets[].volume_fp"));
        // A small answer comes back whole.
        let (kept, s) = shown(&json!({"price": "1"}), &d, &[]);
        assert!(s.whole && kept == json!({"price": "1"}));
    }

    #[test]
    fn a_page_for_one_thing_gets_its_own_records() {
        let all = json!({"result": {"data": [{"symbol": "BTC", "name": "Bitcoin", "price": "1"}, {"symbol": "ETH", "name": "Ethereum", "price": "2"},
            {"symbol": "WBTC", "name": "Wrapped Bitcoin", "price": "3"}, {"symbol": "DOGE", "name": "Dogecoin", "price": "4"}]}});
        let got = about(&all, &["bitcoin".into()]);
        // Bitcoin and Wrapped Bitcoin both name it; Ether and Dogecoin don't.
        let names: Vec<&str> = got["result"]["data"].as_array().unwrap().iter().map(|r| r["symbol"].as_str().unwrap()).collect();
        assert_eq!(names, ["BTC", "WBTC"], "{got}");
        assert_eq!(about(&all, &["solana".into()]), all, "none named: left whole");
    }

    /// The parts of a page's search form share a type tag and nothing else: they are one thing's fields, never records,
    /// and the results beside them are the answer's list. Read as records, the form's labels were all a search of
    /// homes handed back ("Adults", "Date"), with not one home.
    #[test]
    fn parts_that_share_only_a_type_tag_are_not_records() {
        let part = |kind: &str, label: &str| serde_json::json!({ "__typename": kind, (label): { "text": { "title": label }, "id": 1 } });
        let answer = serde_json::json!({
            "results": {
                "searchInput": {
                    "stays": part("StaysInput", "dates"), "guests": part("GuestsInput", "adults"), "experiences": part("ExperiencesInput", "when"),
                    "wide": part("WideInput", "where"), "clear": part("ClearParams", "reset"), "trip": part("TripDates", "flexible")
                },
                "searchResults": (0..8).map(|i| serde_json::json!({ "title": format!("Flat in Lisbon {i}"), "subtitle": "Entire home", "rating": "4.9", "id": i })).collect::<Vec<_>>()
            }
        });
        let all = paths(&answer);
        assert!(!all.iter().any(|f| f.path.contains("{}")), "{:?}", all.iter().map(|f| &f.path).collect::<Vec<_>>());
        let d = defaults(&all, "search homes", &["lisbon".into()]);
        assert!(d.iter().any(|p| p == "results.searchResults[].title"), "{d:?}");
        assert!(!d.iter().any(|p| p.contains("searchInput")), "{d:?}");
    }

    /// A field keyed by what it was asked with is one field: its path leaves the arguments out, and the same path
    /// reads the next answer, whose key holds another request's arguments.
    #[test]
    fn a_key_that_carries_its_arguments_names_one_field() {
        let state = |request: &str, city: &str| {
            let mut search = Map::new();
            search.insert(format!("search({{\"input\":{{\"requestId\":\"{request}\",\"location\":{{\"name\":\"{city}\"}}}}}})"), serde_json::json!({
                "results": (0..6).map(|i| serde_json::json!({ "name": format!("Hotel {city} {i}"), "price": format!("S$ {}", 100 + i) })).collect::<Vec<_>>()
            }));
            serde_json::json!({ "ROOT_QUERY": { "searchQueries": Value::Object(search) } })
        };
        let first = state("32f73a0b5eb00a55", "Paris");
        let chosen = defaults(&paths(&first), "search stays", &["paris".into()]);
        assert!(chosen.iter().any(|p| p == "ROOT_QUERY.searchQueries.search().results[].name"), "{chosen:?}");
        assert!(!chosen.iter().any(|p| p.contains("32f73a0b5eb00a55")), "no request's id in a path: {chosen:?}");
        let later = project(&state("9c1d4e77aa015b02", "Osaka"), &chosen);
        assert!(later.to_string().contains("Hotel Osaka 3"), "{later}");
    }

    /// A record is the outermost thing that repeats, and what its parts hold is the record's: a flight whose fields
    /// mostly sit in its legs and its fares is still the record, and comes back with a fare a number under a key that
    /// names a price says, as an API hands one over with no currency sign.
    #[test]
    fn a_list_inside_a_record_is_a_part_of_it() {
        let flight = |i: usize| serde_json::json!({
            "id": format!("it-{i}"),
            "legs": [{ "flightNo": format!("CX{}", 500 + i), "depart": "2027-06-01 02:35:00", "arrive": "2027-06-01 06:30:00", "from": "PEK", "to": "HKG", "aircraft": "A350", "meal": "yes", "cabin": "Y" },
                     { "flightNo": format!("CX{}", 700 + i), "depart": "2027-06-01 08:00:00", "arrive": "2027-06-01 12:00:00", "from": "HKG", "to": "SIN", "aircraft": "A330", "meal": "yes", "cabin": "Y" }],
            "policies": [{ "policyId": format!("p-{i}"), "price": { "totalPrice": 196 + i, "tax": 98.9 } }]
        });
        let answer = serde_json::json!([{ "head": { "transactionID": "t1" }, "cityList": [{ "name": "Beijing", "cityId": 1 }, { "name": "Singapore", "cityId": 73 }], "itineraryList": (0..12).map(flight).collect::<Vec<_>>() }]);
        let d = defaults(&paths(&answer), "search flights from a city", &["bjs".into()]);
        assert!(d.iter().any(|p| p == "[].itineraryList[].policies[].price.totalPrice"), "the fare: {d:?}");
        assert!(d.iter().any(|p| p.starts_with("[].itineraryList[].legs[]")), "what the flight is: {d:?}");
    }

    /// What repeats most is what the answer lists: a page laid out as a few zones, one of which holds the twenty
    /// products, answers with the products, not with its zones.
    #[test]
    fn the_list_that_repeats_most_is_the_answers() {
        let item = |i: usize| serde_json::json!({ "title": format!("Towel set {i}"), "brand": "Casaluna", "summary": { "price": { "current": format!("${}.00", 10 + i) }, "rating": 4.5, "reviews": 120 + i } });
        let zone = |name: &str, items: Vec<Value>| serde_json::json!({ "zone_id": name, "layout": "grid", "theme": "light", "modules": [{ "slot": "main", "kind": "list", "items": items }] });
        let answer = serde_json::json!({ "zones": [zone("header", vec![]), zone("results", (0..20).map(item).collect()), zone("footer", vec![])] });
        let d = defaults(&paths(&answer), "search products", &["towels".into()]);
        assert!(d.iter().any(|p| p == "zones[].modules[].items[].title"), "{d:?}");
        assert!(d.first().is_some_and(|p| p.starts_with("zones[].modules[].items[]")), "the products lead: {d:?}");
    }

    /// A record with a price comes back with it, whatever the goal's words: its own price, the shallowest, once.
    #[test]
    fn a_record_that_carries_a_price_says_it_beside_its_name() {
        let answer = serde_json::json!({ "results": (0..8).map(|i| serde_json::json!({
            "title": format!("Flat in Lisbon {i}"), "rating": "4.9", "id": i,
            "displayPrice": { "primaryLine": { "price": format!("${} SGD", 900 + i), "label": "for 5 nights" }, "details": [{ "priceString": "$1,485.71 SGD" }] }
        })).collect::<Vec<_>>() });
        let d = defaults(&paths(&answer), "search homes", &["lisbon".into()]);
        assert!(d.iter().any(|p| p == "results[].title"), "{d:?}");
        assert!(d.iter().any(|p| p == "results[].displayPrice.primaryLine.price"), "{d:?}");
        assert!(!d.iter().any(|p| p.ends_with("priceString")), "one price, the record's own: {d:?}");
    }

    /// A list that holds one record wraps the answer: the records are the list inside it, however many more fields the
    /// wrapping has. A page's state handed over as one element of a list made every field of the page a "record's", and
    /// a search whose results never say the search back handed back the page's labels and none of the results.
    #[test]
    fn a_list_of_one_wraps_the_answer_and_is_not_its_records() {
        let chrome: serde_json::Map<String, serde_json::Value> = (0..40).map(|i| (format!("label{i}"), serde_json::json!(format!("Label {i}")))).collect();
        let answer = serde_json::json!({
            "clientData": [[null, { "data": { "page": chrome, "results": (0..8).map(|i| serde_json::json!({ "title": format!("Flat by the river {i}"), "subtitle": "Entire home", "rating": "4.9", "id": i })).collect::<Vec<_>>() } }]]
        });
        let d = defaults(&paths(&answer), "search homes", &["bangkok".into()]);
        assert!(d.iter().any(|p| p == "clientData[][].data.results[].title"), "{d:?}");
    }

    /// A search's answer whose results have no field the goal names, beside as many counts at its top, hands back the
    /// results, not the counts. The answer that exposed it: a news search's `result[]` (headline, url, body …) next
    /// to a `meta` of eight numbers, answered with the numbers alone.
    #[test]
    fn a_list_of_records_beats_counts_as_rich_as_it() {
        let answer = serde_json::json!({
            "message": "success",
            "meta": { "start": 1, "end": 10, "of": 1959, "total": 10, "maxScore": 0, "duration": 0, "excludedContent": 0 },
            "result": (0..10).map(|i| serde_json::json!({ "path": format!("https://news.example/{i}"), "type": "NewsArticle", "headline": format!("Story {i} on the weather"), "thumbnail": format!("https://img.example/{i}.jpg"), "stellarID": format!("id{i}"), "url": format!("https://news.example/{i}"), "lastModifiedDate": "2026-11-03T15:52:49.829Z", "body": "A long body of text ".repeat(20) })).collect::<Vec<_>>(),
        });
        let d = defaults(&paths(&answer), "search the site's news stories", &["climate".into()]);
        assert!(d.iter().any(|p| p.starts_with("result[]")), "{d:?}");
        assert!(!d.iter().any(|p| p.starts_with("meta.")), "{d:?}");
    }

    /// Defaults chosen before the rule told a search's results from its counts (`meta.*`) are chosen again: they miss
    /// the answer's records. Defaults that hold a list's fields, or an answer with no list, stand.
    #[test]
    fn defaults_that_miss_the_records_are_chosen_again() {
        let answer = serde_json::json!({ "meta": { "of": 1959, "total": 10 }, "result": [{ "headline": "a", "url": "https://n.example/a" }, { "headline": "b", "url": "https://n.example/b" }] });
        let all = paths(&answer);
        assert!(misses_the_records(&["meta.of".into(), "meta.total".into()], &all));
        assert!(!misses_the_records(&["result[].headline".into()], &all));
        assert!(!misses_the_records(&[], &all));
        let one = paths(&serde_json::json!({ "price": 3, "name": "coin" }));
        assert!(!misses_the_records(&["price".into()], &one));
    }

    /// A record's name written as text (`titleText`) is its title: a film search's results are named by it, not by
    /// their ids.
    #[test]
    fn a_name_written_as_text_names_the_record() {
        let answer = serde_json::json!({ "results": [{ "index": "tt1375666", "listItem": { "titleId": "tt1375666", "originalTitleText": "Inception", "titleText": "Inception", "titleType": { "id": "movie" } } }, { "index": "tt0816692", "listItem": { "titleId": "tt0816692", "originalTitleText": "Interstellar", "titleText": "Interstellar", "titleType": { "id": "movie" } } }] });
        let d = defaults(&paths(&answer), "search IMDb titles", &["space station drama".into()]);
        assert!(d.iter().any(|p| p.ends_with("TitleText") || p.ends_with("titleText")), "{d:?}");
        assert_eq!(names_as("titleText").as_deref(), Some("title"));
        assert_eq!(names_as("name").as_deref(), Some("name"));
        assert_eq!(names_as("text").as_deref(), Some("text"));
    }

    /// An archive's search: a report of the request and the session at the top, the hits far below. The defaults are
    /// the hits and their names; what the request said back stays out.
    #[test]
    fn an_answer_with_records_answers_with_them_not_the_request_said_back() {
        let answer = json!({
            "session": {"client": {"archive_user": false, "tier": "free"}},
            "request": {"search": {"user_query": "apollo 11", "client_url": "https://archive.example/search?query=apollo%2011", "hits_per_page": 50, "items": 3}},
            "response": {"body": {"hits": {"total": 2, "hits": [
                {"fields": {"title": "Apollo 11 launch", "mediatype": "movies", "downloads": 10, "date": "1969-07-16"}},
                {"fields": {"title": "Apollo 11 landing", "mediatype": "audio", "downloads": 20, "date": "1969-07-20"}}]}}},
        });
        let d = defaults(&paths(&answer), "search archive items", &["apollo 11".into()]);
        assert!(d.contains(&"response.body.hits.hits[].fields.title".to_string()), "{d:?}");
        assert!(!d.iter().any(|p| p == "request.search.user_query"), "the request said back: {d:?}");
        let last = d.iter().rposition(|p| p.starts_with("response.")).unwrap();
        assert!(d[..=last].iter().all(|p| p.starts_with("response.")), "the records come first: {d:?}");
    }

    /// What a reply leaves out leads to the answer's records, however much it says about the request before them.
    #[test]
    fn what_was_left_out_shows_the_records_first() {
        let report: serde_json::Map<String, Value> = (0..40).map(|i| (format!("setting_{i}"), json!(format!("value of setting {i} that nobody asked for")))).collect();
        let answer = json!({ "report": report, "padding": "x".repeat(4000), "stats": {"took": 3},
            "body": {"hits": [{"title": "One", "creator": "A", "year": 1969, "extra": {"a": 1, "b": 2}}, {"title": "Two", "creator": "B", "year": 1970, "extra": {"a": 1, "b": 2}}]} });
        let (_, s) = shown(&answer, &["stats.took".to_string()], &[]);
        assert!(s.more.iter().take(5).any(|f| f.path == "body.hits[].title"), "{:?}", s.more.iter().take(6).map(|f| &f.path).collect::<Vec<_>>());
    }

    /// A site's log of the request can name the machine that asked. It is never a default, nor shown as an example, and
    /// is hidden wherever else it comes back; a caller who asks for that field, or a goal that names it, gets it.
    #[test]
    fn a_callers_network_address_comes_back_only_when_asked_for() {
        let answer = json!({"session": {"client_id": "8.8.4.4:sra:cip", "note": "from 2001:4860:4860::8888 today"}, "version": "10.0.0.1", "at": "127.0.0.1",
            "hits": [{"title": "One", "year": 1969, "pages": 3}, {"title": "Two", "year": 1970, "pages": 4}]});
        let all = paths(&answer);
        assert_eq!(all.iter().find(|f| f.path == "session.client_id").map(|f| (f.kind, f.example.clone())), Some(("address", None)));
        assert!(!defaults(&all, "search items", &[]).contains(&"session.client_id".to_string()));
        let hidden = without_addresses(answer.clone(), "search items", &[]);
        assert_eq!(hidden["session"]["client_id"], "[address]:sra:cip");
        assert_eq!(hidden["session"]["note"], "from [address] today");
        assert_eq!((hidden["version"].clone(), hidden["at"].clone()), (json!("10.0.0.1"), json!("127.0.0.1")), "a private or local address says nothing");
        assert_eq!(without_addresses(answer.clone(), "search items", &["session.client_id".into()])["session"]["client_id"], "8.8.4.4:sra:cip");
        assert_eq!(without_addresses(answer.clone(), "search items", &["session".into()])["session"]["client_id"], "8.8.4.4:sra:cip");
        assert_eq!(without_addresses(answer.clone(), "search items", &[ALL.into()]), answer);
        assert_eq!(without_addresses(json!({"ip": "8.8.4.4"}), "get my ip address", &[]), json!({"ip": "8.8.4.4"}));
        assert_eq!(without_addresses(json!({"v": "1.2.3", "n": "12.5", "t": "2026.11.06"}), "x", &[]), json!({"v": "1.2.3", "n": "12.5", "t": "2026.11.06"}));
    }

    #[test]
    fn names_are_read_by_their_words() {
        assert_eq!(name_words("last_price_dollars"), ["last", "price", "dollars"]);
        assert_eq!(name_words("yesAskDollars"), ["yes", "ask", "dollars"]);
        assert!(names("data.coinInfo.price", "prices"));
        assert!(names("results[].full_price.amount", "price"));
        assert!(!names("markets[].close_time", "markets"), "a list's name is not its records' field");
        assert!(!names("data.pageProps.budget", "get"));
    }
    /// The walk that exposed it: a stays search read from the page's own state. After a few plain asks the site
    /// served the page without that state, the request's key and nothing beneath it, and the call handed the frame
    /// back as an answer. Its records' list is not there at all; a search that found nothing has its list, empty.
    #[test]
    fn a_frame_with_none_of_the_routes_records_is_told_from_a_search_that_found_nothing() {
        let fields = vec!["client[][].data.search.results[].title".to_string(), "client[][].data.search.results[].price".to_string()];
        let answered: Value = serde_json::from_str(r#"{"client":[["key",{"data":{"search":{"results":[{"title":"Flat","price":"$9"}]}}}]]}"#).unwrap();
        let nothing_found: Value = serde_json::from_str(r#"{"client":[["key",{"data":{"search":{"results":[]}}}]]}"#).unwrap();
        let frame: Value = serde_json::from_str(r#"{"client":[["key"]]}"#).unwrap();
        assert!(!frame_without_records(&answered, &fields));
        assert!(!frame_without_records(&nothing_found, &fields), "the list is there, empty");
        assert!(frame_without_records(&frame, &fields));
        assert!(!frame_without_records(&frame, &["title".to_string(), "text".to_string()]), "no field under a list says nothing");
        assert!(!frame_without_records(&serde_json::json!({ "results": [] }), &["results[].title".to_string()]));
        assert!(frame_without_records(&serde_json::json!({ "error": "x" }), &["results[].title".to_string()]));
    }

    /// The walk that exposed it: a marketplace whose search call answers with its listings drawn already, markup in
    /// one field, beside flags and ranking notes. The default answer was the notes; the fifty-nine listings were in
    /// a long text nobody was shown. Markup a field carries is read as a page is: its text and its links.
    #[test]
    fn markup_carried_in_a_field_is_read_as_a_page() {
        let base: url::Url = "https://www.market.example/search?q=scarf".parse().unwrap();
        let cards: String = (0..20).map(|i| format!(r#"<li class="card"><a href="/listing/{i}/wool-scarf-number-{i}"><h3>Wool scarf number {i}, hand knitted in the hills</h3></a><span>${i}.00</span></li>"#)).collect();
        let answer = serde_json::json!({ "jsData": { "organic_count": 20 }, "output": { "results": format!("<ul>{cards}</ul>") }, "label": "<b>New</b>" });
        let read = with_markup_read(answer, &base);
        let links = read["output"]["results"]["links"].as_array().expect("the markup's links");
        assert_eq!(links.len(), 20);
        assert_eq!(links[0]["url"], "https://www.market.example/listing/0/wool-scarf-number-0");
        assert!(read["output"]["results"]["text"].as_str().is_some_and(|t| t.contains("Wool scarf number 7")));
        assert_eq!(with_markup_read_at(serde_json::json!({ "output": { "results": format!("<ul>{cards}</ul>") } }), &base).1, vec!["output.results".to_string()]);
        assert_eq!(read["label"], "<b>New</b>", "a formatted label is a value");
        assert_eq!(read["jsData"]["organic_count"], 20);
        let prose = format!("<p>{}</p>", "a long note with no link in it. ".repeat(100));
        assert_eq!(with_markup_read(Value::String(prose.clone()), &base), Value::String(prose), "markup that links nowhere stays text");
    }

}
