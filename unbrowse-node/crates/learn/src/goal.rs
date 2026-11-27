//! What a goal asks an answer to hold, and whether an answer holds it. A goal names the fields it wants ("return
//! item title and price", "with title and link"); an answer holds them when its records carry them: by the field's
//! own word in the record's keys, or, for a field whose values have a shape (a price, a link, a date), by values of
//! that shape. A search's answer also says back what was searched for, record after record: a list that never
//! mentions it answers some other question (what is promoted, what was seen last), however well it is shaped.
//!
//! Nothing here knows a site. It reads the goal's words and the shapes answers come in.

use serde_json::Value;

/// How a field's values look, when they have a look of their own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// An amount of money: a currency sign or code beside a number (`S$828`, `$4.00`, `SGD 12`, `12,50 €`).
    Money,
    /// An address: `https://…`, or a path on the site.
    Link,
    /// A day: `2026-10-28`, or a month's name beside a number (`28 Oct`, `October 28`).
    Date,
    /// A published software release number, such as `2.34.2`.
    ReleaseVersion,
    /// No look of its own: only a key named for it shows it.
    Plain,
}

/// A field the goal asks for: its word, and the shape its values take.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub word: String,
    pub shape: Shape,
    /// The goal asks for it as it is now (`live price`, `current price`): a figure of the moment, not one over a span.
    pub now: bool,
}

/// The words that ask for a value as it is now.
const NOW: [&str; 5] = ["live", "current", "latest", "now", "spot"];

/// The words of a key that make a price one of the moment: the last trade, the best bid or ask, the mark.
pub const TRADED: [&str; 5] = ["last", "close", "bid", "ask", "mark"];

/// The words of a key that make it a figure about a value over a span (`priceMinToday`, `priceChange30day`,
/// `historyHighPrice`), not the value now.
const SPAN: [&str; 16] =
    ["min", "max", "high", "low", "change", "open", "prev", "previous", "avg", "average", "history", "historical", "rate", "ago", "estimated", "prediction"];

/// Whether a key's words make it a figure over a span: a span word, or a word holding a figure (`24h`, `30day`).
pub fn over_a_span(words: &[String]) -> bool {
    words.iter().any(|w| SPAN.contains(&w.as_str()) || w.chars().any(|c| c.is_ascii_digit()))
}

/// How many times a rendered page must show a field before it is a list of them, not a stray one.
pub const FEWEST: usize = 5;

pub fn has_rendered_links(page: &Value) -> bool {
    page["links"].as_array().is_some_and(|links| links.iter().filter(|link| link["text"].as_str().is_some_and(|text| !text.trim().is_empty())).take(FEWEST).count() >= FEWEST)
}

/// The words that join a goal's fields or point at the page, never fields themselves: a goal that says "get the
/// price on this page" asks for a price, not for a `get` or a `this`.
const JOINS: [&str; 22] = [
    "and", "or", "the", "its", "their", "each", "all", "with", "for", "plus", "any", "every", "get", "this", "that", "these", "those", "from",
    "into", "onto", "your", "our",
];

/// The fields a goal asks for: the words after it says what to give back (`return …`, `with …`, `…: a, b`), or
/// every word of it when it never says.
pub fn fields(goal: &str) -> Vec<Field> {
    let goal = goal.to_lowercase();
    let tail = [" return ", " returning ", " with ", ": "]
        .iter()
        .filter_map(|m| goal.rfind(m).map(|at| at + m.len()))
        .max()
        .map(|at| &goal[at..])
        .unwrap_or(&goal);
    let mut out: Vec<Field> = Vec::new();
    let now = goal.split(|c: char| !c.is_alphanumeric()).any(|w| NOW.contains(&w));
    let goal_words = || goal.split(|c: char| !c.is_alphanumeric());
    let release = goal_words().any(|w| matches!(w, "latest" | "current" | "published" | "release"));
    let release_tag = release && goal_words().any(|w| matches!(w, "image" | "release" | "version"));
    for w in tail.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3 && !JOINS.contains(w)) {
        if !out.iter().any(|f| f.word == w) {
            let shape = match stem(w) {
                "version" if release => Shape::ReleaseVersion,
                "tag" if release_tag => Shape::ReleaseVersion,
                _ => shape_of(w),
            };
            out.push(Field { word: w.to_string(), now: now && shape == Shape::Money, shape });
        }
    }
    out
}

/// Whether a goal asks for one thing (`get the price of a coin`, `get a crate's details`) rather than a list (`search
/// stories`, `list open markets`): it never asks for a list or for all of something.
pub fn wants_one(goal: &str) -> bool {
    let words: Vec<String> = goal.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect();
    let lists = ["search", "list", "find", "browse", "compare", "show", "all", "every", "each"];
    let shows_one_release = words.iter().any(|word| word == "show")
        && fields(goal).iter().any(|field| field.shape == Shape::ReleaseVersion && matches!(field.word.as_str(), "version" | "tag"));
    // A goal that asks for several of something names it up front (`flights from Singapore to Tokyo`), even where the
    // caller left out a list's verb. It was read as a goal for one thing, so the page's own last piece
    // (`showfarefirst` at `/flights/showfarefirst`) was taken for the thing it names and the streamed answer rejected
    // for never saying it. The head word is the first that isn't an article or a verb of asking; the endings that look
    // plural and are not (`status`, `analysis`, `gas`, `chaos`) and a number's pieces are left out.
    let lead = ["the", "a", "an", "me", "please", "get", "read", "give", "fetch", "retrieve", "check", "look", "for"];
    let plural = |w: &str| {
        w.chars().count() >= 4
            && w.ends_with('s')
            && !["ss", "us", "is", "as", "os"].iter().any(|e| w.ends_with(e))
            && w.chars().any(|c| c.is_alphabetic())
    };
    let head = words.iter().find(|w| !lead.contains(&w.as_str()));
    !words.iter().any(|w| lists.contains(&w.as_str()) && !(w == "show" && shows_one_release)) && !head.is_some_and(|w| plural(w))
}

/// The shape a field's word names. The word, not a site: what a price, a link or a date looks like is the same
/// everywhere.
/// The words that say a number is what a thing costs, in a goal's own words and in a key's: one list for both, so
/// a goal that asks for fares is answered by a call that names them prices.
pub const COSTS: [&str; 5] = ["price", "fare", "cost", "amount", "fee"];

/// Whether a key's word names a cost: the word itself, or its plural.
pub fn names_a_cost(word: &str) -> bool {
    COSTS.iter().any(|c| word == *c || word.strip_suffix('s') == Some(c))
}

fn shape_of(word: &str) -> Shape {
    let stem = stem(word);
    if COSTS.contains(&stem) {
        Shape::Money
    } else if ["link", "url", "href"].contains(&stem) {
        Shape::Link
    } else if ["date", "day", "when"].contains(&stem) {
        Shape::Date
    } else {
        Shape::Plain
    }
}

/// A word without its plural `s`: `prices` is asked for under a key `price`, `stars` under `stargazerCount`.
fn stem(word: &str) -> &str {
    match word.strip_suffix('s') {
        Some(s) if s.chars().count() >= 3 && !s.ends_with('s') => s,
        _ => word,
    }
}

/// What an answer holds of a goal: the fields its best list of records carries, whether those records say back what
/// was asked for, and how many there are.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Holding {
    /// The goal's fields the records carry, in the goal's order.
    pub covered: Vec<String>,
    /// How many of those have a shape of their own (a price, a link, a date) and showed it.
    pub shaped: usize,
    /// How many of the goal's fields have a shape of their own.
    pub shaped_asked: usize,
    /// Whether most of the records say back a value the caller asked for.
    pub echoes: bool,
    /// How many records (1 for a single object).
    pub records: usize,
    /// The same records supplied a plain field and the shaped fields.
    linked_records: bool,
}

impl Holding {
    /// Every field with a shape of its own is there: a goal that asks for prices is not answered without prices.
    pub fn has_shapes(&self) -> bool {
        self.shaped == self.shaped_asked
    }

    pub fn has_record_fields(&self, goal: &str, fields: &[Field]) -> bool {
        !linked_records_required(goal, fields) || self.has_linked_records()
    }

    fn has_linked_records(&self) -> bool {
        self.linked_records
    }

    /// In words, for the owner's window.
    pub fn said(&self) -> String {
        let mut s = if self.covered.is_empty() {
            format!("its answer holds none of the goal's fields ({} records)", self.records)
        } else {
            format!("its answer holds {} with {}", plural(self.records, "record"), self.covered.join(", "))
        };
        if self.echoes {
            s.push_str(", each saying back what was asked");
        }
        s
    }
}

fn linked_records_required(goal: &str, fields: &[Field]) -> bool {
    fields.iter().any(|f| f.shape == Shape::Link)
        && fields.iter().any(|f| f.shape == Shape::Plain)
        && goal.split(|c: char| !c.is_alphanumeric()).any(|w| w.eq_ignore_ascii_case("each") || w.eq_ignore_ascii_case("every"))
}

fn plural(n: usize, what: &str) -> String {
    if n == 1 {
        format!("1 {what}")
    } else {
        format!("{n} {what}s")
    }
}

/// What a JSON answer holds of `fields`: the best of its lists of records (an array of objects, an object of
/// objects keyed by id, or the answer itself as one record). `asked` is what the caller asked for (the search).
pub fn holding(answer: &Value, fields: &[Field], asked: &[String]) -> Holding {
    holding_ranked(answer, fields, asked, false, true)
}

pub fn holding_for_goal(answer: &Value, fields: &[Field], asked: &[String], goal: &str) -> Holding {
    holding_ranked(answer, fields, asked, linked_records_required(goal, fields), true)
}

/// What a record list holds, including a one-item list. Wrapper fields cannot stand for the list.
pub fn list_holding_for_goal(answer: &Value, fields: &[Field], asked: &[String], goal: &str) -> Holding {
    holding_ranked(answer, fields, asked, linked_records_required(goal, fields), false)
}

/// Embedded records can carry prices and names while the same document renders their links in its markup.
/// An anchor supplies a field only when its label names the record and its address is unique to that match.
pub struct RenderedHolding<'a> {
    pub holding: Holding,
    pub links: Vec<&'a Value>,
}

pub fn holding_with_rendered_links<'a>(answer: &Value, links: &'a [Value], fields: &[Field], asked: &[String], goal: &str) -> Option<RenderedHolding<'a>> {
    if links.is_empty() || !fields.iter().any(|f| f.shape == Shape::Link) {
        return None;
    }
    let anchors: Vec<_> = links.iter().filter_map(|anchor| {
        let address = anchor["url"].as_str().filter(|address| link(address))?;
        Some((anchor["text"].as_str().map(link_label)?, address, anchor))
    }).collect();
    let mut sets = Vec::new();
    if let Some(records) = answer.as_array() {
        let records: Vec<&Value> = records.iter().filter(|value| value.is_object()).collect();
        if !records.is_empty() {
            sets.push(records);
        }
    } else {
        lists(answer, 0, true, &mut sets);
    }
    let asked = asked_words(asked);
    sets.into_iter().map(|records| {
        let mut used = std::collections::HashSet::new();
        let mut matched = Vec::new();
        let reads: Vec<_> = records.into_iter().map(|record| {
            let mut read = Read::of(record, RECORD_DEPTH);
            if !read.link {
                let mut labels = Vec::new();
                record_labels(record, 0, &mut labels);
                let mut matching = anchors.iter().filter(|(anchor, _, _)| labels.iter().any(|label| {
                    anchor.match_indices(label.as_str()).any(|(start, sound)| {
                        (start == 0 || anchor[..start].ends_with(' '))
                            && (start + sound.len() == anchor.len() || anchor[start + sound.len()..].starts_with(' '))
                    })
                }));
                if let Some((_, _, anchor)) = matching.next().filter(|(_, address, _)| matching.next().is_none() && used.insert(*address)) {
                    read.link = true;
                    matched.push(*anchor);
                }
            }
            read
        }).collect();
        RenderedHolding { holding: held_reads(&reads, fields, &asked), links: matched }
    }).filter(|result| result.holding.has_shapes() && result.holding.has_record_fields(goal, fields))
        .max_by_key(|result| (rank(&result.holding), result.links.len()))
}

fn link_label(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn record_labels(record: &Value, depth: usize, labels: &mut Vec<String>) {
    let Some(object) = record.as_object().filter(|_| depth < 4) else { return };
    let mut names_itself = false;
    let mut qualified = Vec::new();
    for (key, value) in object {
        let words = key_words(key);
        if !words.iter().any(|word| matches!(word.as_str(), "name" | "title")) {
            continue;
        }
        let Some(text) = value.as_str().or_else(|| value.get("text").and_then(Value::as_str)) else { continue };
        let label = link_label(text);
        let own = words.len() == 1 || words.len() == 2 && words[0] == "display";
        names_itself |= own && !label.is_empty();
        if label.chars().count() >= 5 {
            if own { labels.push(label) } else { qualified.push(label) }
        }
    }
    // A wrapper can carry the record's name. Once a record names itself, nested entities' names are their own.
    if !names_itself {
        labels.extend(qualified);
        for value in object.values() {
            record_labels(value, depth + 1, labels);
        }
    }
}

fn holding_ranked(answer: &Value, fields: &[Field], asked: &[String], prefer_records: bool, allow_whole_record: bool) -> Holding {
    let asked = asked_words(asked);
    let mut sets: Vec<Vec<&Value>> = Vec::new();
    lists(answer, 0, prefer_records || !allow_whole_record, &mut sets);
    let ranked = |h: &Holding| (prefer_records && h.has_shapes() && h.has_linked_records(), rank(h));
    let mut best = sets.iter().map(|records| held(records, fields, &asked, RECORD_DEPTH)).max_by_key(ranked);
    // The answer as one record is read near its top only: a field is the answer's when it sits a few keys in, and a
    // config of thousands of settings names every word somewhere deep inside it.
    if allow_whole_record && answer.is_object() {
        let one = held_one(answer, fields, &asked);
        best = [best, Some(one)].into_iter().flatten().max_by_key(ranked);
    }
    best.unwrap_or_else(|| empty(fields))
}

/// The one thing a page is about, by its address: the last piece of its path (`tt0111161` of `/title/tt0111161/`),
/// decoded. None for a page at the site's root.
pub fn thing_of(page: &str) -> Option<String> {
    let page = url::Url::parse(page).ok()?;
    let piece = page.path_segments()?.rfind(|p| !p.is_empty())?;
    Some(percent_encoding::percent_decode_str(piece).decode_utf8_lossy().into_owned())
}

/// What the record of the one thing a goal asks about holds of `fields`: a record anywhere in the answer that names the
/// thing (a value of its own equal to `thing`, `id: "tt0111161"`), read as one record ([`held_one`]): its own fields,
/// never those of a list of other records inside it. A title's rating is its `ratingsSummary`; the ratings of its
/// featured reviews, listed under it, are theirs. Nothing when no record names the thing.
pub fn thing_holding(answer: &Value, fields: &[Field], thing: &str) -> Holding {
    fn naming<'a>(v: &'a Value, thing: &str, depth: usize, out: &mut Vec<&'a Value>) {
        if depth > 16 || out.len() >= 16 {
            return;
        }
        match v {
            Value::Object(map) => {
                if map.values().any(|x| x.as_str().is_some_and(|s| s.eq_ignore_ascii_case(thing))) {
                    out.push(v);
                }
                map.values().for_each(|x| naming(x, thing, depth + 1, out));
            }
            Value::Array(items) => items.iter().for_each(|x| naming(x, thing, depth + 1, out)),
            _ => {}
        }
    }
    let mut named = Vec::new();
    if thing.chars().count() >= 3 {
        naming(answer, thing, 0, &mut named);
    }
    named.into_iter().map(|r| held_one(r, fields, &[])).max_by_key(rank).unwrap_or_else(|| empty(fields))
}

/// What a page holds of `fields`, read as the replay reads it (`page::read`: `{title, state, text, links}`): its
/// embedded state as JSON records, or what it renders, by how many times it shows each shaped field. A rendered
/// field without a shape can't be told from its text, so a page counts as holding the goal by its shapes alone.
pub fn page_holding(page: &Value, fields: &[Field], asked: &[String]) -> Holding {
    let from_state = page.get("state").filter(|s| !s.is_null()).map(|s| holding(s, fields, asked));
    let text = page.get("text").and_then(|t| t.as_str()).unwrap_or_default();
    // Read for a look as written: a price's currency code is in capitals (`SGD 331`), and lowered it is a word.
    let written: Vec<&str> = text.lines().collect();
    let lines: Vec<String> = written.iter().map(|l| l.to_lowercase()).collect();
    let links = page.get("links").and_then(|l| l.as_array()).map(|l| l.len()).unwrap_or(0);
    let words = asked_words(asked);
    let mut rendered = empty(fields);
    for f in fields {
        let shown = match f.shape {
            Shape::Money => written.iter().filter(|l| money(l)).count(),
            Shape::Date => written.iter().filter(|l| date(l)).count(),
            Shape::Link => links,
            Shape::ReleaseVersion => usize::from(page_shows_release(page["title"].as_str().unwrap_or_default(), text)),
            Shape::Plain => 0,
        };
        let needed = if f.shape == Shape::ReleaseVersion { 1 } else { FEWEST };
        if shown >= needed {
            rendered.covered.push(f.word.clone());
            rendered.shaped += 1;
            rendered.records = rendered.records.max(shown);
        }
    }
    rendered.echoes = !words.is_empty() && lines.iter().filter(|l| words.iter().any(|w| says(l, w))).count() >= FEWEST;
    [from_state, Some(rendered)].into_iter().flatten().max_by_key(rank).unwrap_or_else(|| empty(fields))
}

fn empty(fields: &[Field]) -> Holding {
    Holding { shaped_asked: fields.iter().filter(|f| f.shape != Shape::Plain).count(), ..Holding::default() }
}

/// Which list best answers: the one with the goal's shaped fields, then the one saying back what was asked, then
/// the one with most of the goal's fields, then the longest.
fn rank(h: &Holding) -> (usize, bool, usize, usize) {
    (h.shaped, h.echoes, h.covered.len(), h.records)
}

/// Whether a value is a list of records: three or more objects, or an object whose members are mostly objects.
fn records_in(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().filter(|i| i.is_object()).count() >= 3,
        Value::Object(map) => {
            let n = map.values().filter(|i| i.is_object()).count();
            n >= FEWEST && n * 5 >= map.len() * 4
        }
        _ => false,
    }
}

/// The lists of records in an answer: arrays of objects, and objects whose values are mostly objects (records
/// keyed by their ids). An explicit request for each record's link also considers shorter arrays. Only the first
/// few items of a list are searched for lists inside it.
fn lists<'a>(v: &'a Value, depth: usize, include_short: bool, out: &mut Vec<Vec<&'a Value>>) {
    if depth > 16 {
        return;
    }
    match v {
        Value::Array(items) => {
            let records: Vec<&Value> = items.iter().filter(|i| i.is_object()).collect();
            if records.len() >= 3 || (include_short && !records.is_empty() && records.len() == items.len()) {
                out.push(records);
            }
            items.iter().take(3).for_each(|i| lists(i, depth + 1, include_short, out));
        }
        Value::Object(map) => {
            let records: Vec<&Value> = map.values().filter(|i| i.is_object()).collect();
            if records.len() >= FEWEST && records.len() * 5 >= map.len() * 4 {
                out.push(records);
            }
            map.values().for_each(|i| lists(i, depth + 1, include_short, out));
        }
        _ => {}
    }
}

/// The longest a value with the look of a price is, to be one.
const SHORT: usize = 24;

/// How deep a record of a list is read for its fields, and how deep the answer read as one record is.
const RECORD_DEPTH: usize = 12;
const ONE_RECORD_DEPTH: usize = 8;

/// What the answer holds read as one record: its own fields, at any depth up to `ONE_RECORD_DEPTH`, but not the
/// lists of records inside it, which are read as lists.
fn held_one(answer: &Value, fields: &[Field], _asked: &[String]) -> Holding {
    let mut r = Read::default();
    r.walk(answer, 0, ONE_RECORD_DEPTH, false);
    r.text = r.text.to_lowercase();
    let includes_images = fields.iter().any(|f| image_word(&f.word));
    let mut h = empty(fields);
    for f in fields {
        if r.carries(f, includes_images) {
            h.covered.push(f.word.clone());
            if f.shape != Shape::Plain {
                h.shaped += 1;
            }
        }
    }
    h.records = 1;
    h
}

/// What one list holds: a field counts when at least half its records carry it, and the list says back what was
/// asked when at least half of its records do (a list of three or more; one object saying it back is only the
/// search repeated).
fn held(records: &[&Value], fields: &[Field], asked: &[String], depth: usize) -> Holding {
    let reads: Vec<Read> = records.iter().map(|r| Read::of(r, depth)).collect();
    held_reads(&reads, fields, asked)
}

fn held_reads(reads: &[Read], fields: &[Field], asked: &[String]) -> Holding {
    let half = |n: usize| n * 2 >= reads.len();
    let includes_images = fields.iter().any(|f| image_word(&f.word));
    let mut h = empty(fields);
    for f in fields {
        if half(reads.iter().filter(|r| r.carries(f, includes_images)).count()) {
            h.covered.push(f.word.clone());
            if f.shape != Shape::Plain {
                h.shaped += 1;
            }
        }
    }
    h.echoes = reads.len() >= 3 && !asked.is_empty() && half(reads.iter().filter(|r| asked.iter().any(|w| says(&r.text, w))).count());
    h.records = reads.len();
    h.linked_records = half(reads.iter().filter(|r| {
        fields.iter().any(|f| f.shape == Shape::Plain && r.carries(f, includes_images))
            && fields.iter().filter(|f| f.shape != Shape::Plain).all(|f| r.carries(f, includes_images))
    }).count());
    h
}

/// A record, read once: the words of every key in it that holds a value (`last_price_dollars` is last, price,
/// dollars), every string it holds, and the shapes those strings take. A key whose value is a switch (true, false)
/// or nothing names a setting, not a field the record carries.
#[derive(Default)]
struct Read {
    /// Each key's words, and whether its value is an amount (a number, a figure, money, or an object holding one).
    keys: Vec<(Vec<String>, bool)>,
    text: String,
    money: bool,
    link: bool,
    image_link: bool,
    date: bool,
    release_version: bool,
    /// Whether lists of records inside it are read too: a record's own parts are, an answer read as one record's
    /// lists are not.
    lists: bool,
}

impl Read {
    fn of(record: &Value, most: usize) -> Self {
        let mut r = Read { lists: true, ..Read::default() };
        r.walk(record, 0, most, false);
        r.text = r.text.to_lowercase();
        r
    }

    fn walk(&mut self, v: &Value, depth: usize, most: usize, image: bool) {
        if depth > most {
            return;
        }
        if !self.lists && depth > 0 && records_in(v) {
            return;
        }
        match v {
            Value::Object(map) => {
                for (k, x) in map {
                    let words = key_words(k);
                    let image = image || words.iter().any(|w| image_word(w));
                    if !x.is_boolean() && !x.is_null() {
                        self.release_version |= x.as_str().is_some_and(|value| release_field(&words, value));
                        self.keys.push((words, amount(x)));
                    }
                    self.walk(x, depth + 1, most, image);
                }
            }
            Value::Array(items) => items.iter().for_each(|x| self.walk(x, depth + 1, most, image)),
            Value::String(s) => {
                // A price is a short value of its own (`S$828`, `From $4.00`); a sentence that mentions an amount
                // ("Free for orders over $35") is the site's words about prices.
                self.money |= money(s) && s.chars().count() <= SHORT;
                if image {
                    self.image_link |= link(s);
                } else {
                    self.link |= link(s);
                }
                self.date |= date(s);
                self.release_version |= depth == 0 && release_version_token(s);
                self.text.push_str(s);
                self.text.push('\n');
            }
            _ => {}
        }
    }

    /// The field by a word of a key that starts with it (`min_price`, `stargazerCount` for stars, `defaultBranch`),
    /// never by letters inside a word (`get` in `target`), or by its shape in a value.
    /// A field with a look of its own is named by a key only where the key holds such a value: `"price": 24.99` is a
    /// price, `"price": "Price"` is the word for one (a page's labels).
    fn carries(&self, f: &Field, includes_images: bool) -> bool {
        // A label or a photo inside a listing does not link to the listing itself.
        if f.shape == Shape::Link {
            return self.link || (includes_images && self.image_link);
        }
        if f.shape == Shape::ReleaseVersion {
            return self.release_version;
        }
        let stem = stem(&f.word);
        // A price asked for as it is now is a key's of the moment: not a figure over a span, and the last trade, a
        // bid or an ask is one.
        self.keys.iter().any(|(k, amount)| {
            (f.shape != Shape::Money || *amount)
                && ((k.iter().any(|w| w.starts_with(stem)) && !(f.now && over_a_span(k))) || (f.now && k.iter().any(|w| TRADED.contains(&w.as_str()))))
        })
            // What a thing costs is asked for in one word and handed over under another: a goal's `fares` is an
            // answer's `price`, an amount under a key that names any cost.
            || (f.shape == Shape::Money && !f.now && self.keys.iter().any(|(k, amount)| *amount && k.iter().any(|w| names_a_cost(w))))
            || match f.shape {
                Shape::Money => self.money,
                Shape::Date => self.date,
                Shape::Link | Shape::Plain | Shape::ReleaseVersion => false,
            }
    }
}

fn image_word(word: &str) -> bool {
    matches!(stem(word), "image" | "img" | "photo" | "picture" | "thumbnail" | "avatar" | "icon" | "logo" | "poster")
}

/// A page can show its release in its heading, a version label tied to the document, or a supported tag row.
fn page_shows_release(title: &str, text: &str) -> bool {
    let name = title.split_whitespace().next().unwrap_or_default();
    let heading = |line: &str| {
        line.trim().split_once(char::is_whitespace).is_some_and(|(subject, version)| {
            let version = version.trim();
            subject.eq_ignore_ascii_case(name)
                && release_parts(version).is_some_and(|parts| version.starts_with(['v', 'V']) || !dotted_day(parts))
        })
    };
    if heading(title) || text.lines().find(|line| !line.trim().is_empty()).is_some_and(|line| heading(line) || labelled_release(line)) {
        return true;
    }
    // A rendered tag list may put its comma separators on separate lines.
    let mut tag_lines = 0usize;
    text.replace("\n,\n", ", ").lines().any(|line| {
        let line = line.trim();
        if line.split_once(char::is_whitespace).is_some_and(|(subject, rest)| subject.eq_ignore_ascii_case(name) && labelled_release(rest)) {
            return true;
        }
        if let Some(primary) = tag_heading(line, name) {
            tag_lines = if primary { 3 } else { 0 };
            return false;
        }
        if tag_lines == 0 {
            return false;
        }
        // A short section heading can span several rendered lines before the tag row.
        tag_lines -= 1;
        let mut tags = line.split(',').map(str::trim);
        tags.next().is_some_and(release_version_token) && tags.any(|tag| tag.eq_ignore_ascii_case("latest"))
    })
}

/// Report whether a tag heading belongs to the document, including headings that end its own section.
fn tag_heading(line: &str, name: &str) -> Option<bool> {
    let line = line.to_ascii_lowercase();
    let rest = ["supported tags", "supported releases"].into_iter().find_map(|heading| line.strip_prefix(heading))?;
    Some(rest.is_empty() || rest.starts_with(" and respective")
        || rest.strip_prefix(" for ").is_some_and(|subject| subject.eq_ignore_ascii_case(name)))
}

fn labelled_release(line: &str) -> bool {
    let line = line.trim();
    let Some((label, value)) = line.split_once(':').or_else(|| line.rsplit_once(char::is_whitespace)) else { return false };
    matches!(label.trim().to_ascii_lowercase().as_str(), "latest version" | "latest release" | "latest tag" | "current version" | "current release" | "current tag")
        && release_version_token(value.trim().trim_end_matches('.'))
}

fn release_version_token(value: &str) -> bool {
    release_parts(value).is_some()
}

fn release_parts(value: &str) -> Option<[&str; 3]> {
    let version = value.trim();
    let version = version.strip_prefix(['v', 'V']).unwrap_or(version);
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.');
    let three = [parts.next()?, parts.next()?, parts.next()?];
    (parts.next().is_none() && three.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))).then_some(three)
}

/// Calendar dates can appear in rendered prose with dots. A named release field can still use a calendar version.
fn dotted_day([first, middle, last]: [&str; 3]) -> bool {
    let number = |part: &str| part.parse::<u16>().unwrap_or_default();
    let year = |part: &str| part.len() == 4 && (1900..=2199).contains(&number(part));
    let month = |part: &str| (1..=12).contains(&number(part));
    let day = |part: &str| (1..=31).contains(&number(part));
    (year(first) && month(middle) && day(last)) || (year(last) && day(first) && day(middle) && (month(first) || month(middle)))
}

pub(crate) fn release_field(words: &[String], value: &str) -> bool {
    let words = match words {
        [.., tag, name] if tag == "tag" && name == "name" => &words[..words.len() - 1],
        _ => words,
    };
    let Some((field, qualifiers)) = words.split_last() else { return false };
    matches!(field.as_str(), "version" | "tag" | "release" | "latest")
        && qualifiers.iter().all(|w| matches!(w.as_str(), "latest" | "current" | "published" | "release" | "newest" | "max" | "maximum" | "stable"))
        && release_version_token(value)
}

/// Whether a value is an amount: a number, a figure written as text (`"0.5600"`, `"1,299"`), money, a list of
/// numbers, or an object or list holding one at its first level (`{"amount": 2499, "currency": "USD"}`).
fn amount(v: &Value) -> bool {
    fn figure(v: &Value) -> bool {
        match v {
            Value::Number(_) => true,
            Value::String(s) => money(s) || s.trim().replace(',', "").parse::<f64>().is_ok(),
            _ => false,
        }
    }
    // A figure kept in a part's parts is still an amount: a price nested as `{current: {value: 4990, currency: …}}`
    // (a storefront's minor-unit amount with a sibling currency code), not only one at the object's first level.
    fn deep(v: &Value, depth: usize) -> bool {
        if depth > 4 {
            return false;
        }
        match v {
            Value::Object(m) => m.values().any(|x| figure(x) || deep(x, depth + 1)),
            Value::Array(a) => a.iter().take(4).any(|x| figure(x) || deep(x, depth + 1)),
            _ => figure(v),
        }
    }
    deep(v, 0)
}

/// The words of a key's own name: `last_price_dollars` is last, price, dollars; `yesAskDollars` is yes, ask, dollars;
/// `24hrMax` is 24hr, max.
pub fn key_words(key: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut w = String::new();
    let mut prev: Option<char> = None;
    for c in key.chars() {
        let boundary = !c.is_alphanumeric() || (c.is_uppercase() && prev.is_some_and(|p| p.is_lowercase() || p.is_ascii_digit()));
        if boundary && !w.is_empty() {
            words.push(std::mem::take(&mut w));
        }
        if c.is_alphanumeric() {
            w.extend(c.to_lowercase());
        }
        prev = Some(c);
    }
    if !w.is_empty() {
        words.push(w);
    }
    words
}

/// What the caller asked for, each value by its most telling word, its longest: a search for `iphone 15` is said
/// back by "Apple iPhone 14 Pro" as well (a site answers a search with near things too), and `usb c cable` by
/// "USB-C Cable". A single letter or a short number would turn up anywhere.
fn asked_words(asked: &[String]) -> Vec<String> {
    asked
        .iter()
        .filter_map(|a| {
            let a = a.to_lowercase();
            a.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 2).max_by_key(|w| w.chars().count()).map(String::from)
        })
        .collect()
}

/// Whether `text` (lowercase) says an asked word.
fn says(text: &str, word: &str) -> bool {
    text.contains(word)
}

const SIGNS: [char; 9] = ['$', '€', '£', '¥', '₹', '₩', '₱', '฿', '₫'];

/// Whether a string shows an amount of money: a currency sign or a three-letter code just before a number
/// (`S$828`, `From $4.00`, `SGD 12`), or a sign just after one (`12,50 €`).
pub fn money(s: &str) -> bool {
    let c: Vec<char> = s.chars().collect();
    for i in 0..c.len() {
        if !c[i].is_ascii_digit() || (i > 0 && (c[i - 1].is_ascii_digit() || c[i - 1] == '.' || c[i - 1] == ',')) {
            continue;
        }
        let mut b = i;
        if b > 0 && c[b - 1] == ' ' {
            b -= 1;
        }
        if b > 0 && SIGNS.contains(&c[b - 1]) {
            return true;
        }
        if b >= 3 && c[b - 3..b].iter().all(|x| x.is_ascii_uppercase()) && (b == 3 || !c[b - 4].is_alphabetic()) && b < i {
            return true;
        }
        let mut e = i;
        while e < c.len() && (c[e].is_ascii_digit() || c[e] == '.' || c[e] == ',') {
            e += 1;
        }
        if e < c.len() && c[e] == ' ' {
            e += 1;
        }
        if e < c.len() && SIGNS.contains(&c[e]) {
            return true;
        }
    }
    false
}

/// Whether a string is an address: absolute, or a path on the site.
pub fn link(s: &str) -> bool {
    let s = s.trim();
    if s.contains(char::is_whitespace) {
        return false;
    }
    if let Some(relative) = s.strip_prefix("//") {
        return relative.split_once('/').is_some_and(|(host, path)| !host.is_empty() && !path.is_empty());
    }
    s.starts_with("https://") || s.starts_with("http://")
        || s.starts_with('/') && s.len() > 1
        || s.strip_prefix("../").or_else(|| s.strip_prefix("./")).is_some_and(|path| !path.is_empty())
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// Whether a string shows a day: `2026-10-28`, or a month's name beside a day's number (`28 Oct`, `October 28,`).
pub fn date(s: &str) -> bool {
    let b = s.as_bytes();
    let iso = b.windows(10).any(|w| {
        w[..4].iter().all(u8::is_ascii_digit) && w[4] == b'-' && w[5..7].iter().all(u8::is_ascii_digit) && w[7] == b'-' && w[8..].iter().all(u8::is_ascii_digit)
    });
    if iso {
        return true;
    }
    let words: Vec<String> = s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect();
    let day = |w: &String| w.len() <= 2 && w.parse::<u8>().is_ok_and(|d| (1..=31).contains(&d));
    words.iter().enumerate().any(|(i, w)| {
        let month = w.len() >= 3 && w.len() <= 9 && w.chars().all(char::is_alphabetic) && MONTHS.iter().any(|m| w.starts_with(m))
            && (w.len() == 3 || ["january", "february", "march", "april", "june", "july", "august", "september", "sept", "october", "november", "december"].contains(&w.as_str()));
        month && (i.checked_sub(1).and_then(|j| words.get(j)).is_some_and(day) || words.get(i + 1).is_some_and(day))
    })
}

/// A goal's words: lowercased, split on anything not a letter or digit. Two goals, or a goal and what a route does,
/// are the same ask when their words are; reputation groups a site's entries by them too
/// (`rank::reputation::route_key`), so a change here regroups every standing.
pub fn words(s: &str) -> std::collections::BTreeSet<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect()
}

// Three rules read a goal's intent from its words, and they differ on purpose until one vocabulary is chosen:
// `only_reads` and `asks_a_change` judge by any word, `opens_with_a_read` by the first word alone.

/// Whether `goal` only reads: it asks to see something, not to change it. A read goal must never auto-call or
/// auto-learn a route that writes (#25): a background write call that merely sits on the page is not the answer to
/// "list" or "show". The intent is read from the goal's own words, never from a host or a path.
pub fn only_reads(goal: &str) -> bool {
    const READS: &[&str] = &["list", "search", "read", "show", "get", "find", "view", "fetch", "see", "look", "check", "lookup", "query", "load", "open", "display"];
    let words = words(goal);
    READS.iter().any(|w| words.contains(*w)) && !asks_a_change(goal)
}

/// Whether `goal` asks for a change in its own words ("buy", "post", "cancel"). Another contributor's route that
/// writes runs, paid for without the owner, only for a goal that asks for a change: a goal that names none, however
/// it is worded, only reads.
pub fn asks_a_change(goal: &str) -> bool {
    let words = words(goal);
    WRITES.iter().any(|w| words.contains(*w))
}

/// The words that ask for a change (`asks_a_change`, `opens_with_a_change`).
const WRITES: &[&str] = &["buy", "purchase", "order", "pay", "checkout", "send", "post", "submit", "create", "add", "delete", "remove", "cancel", "update", "edit", "change", "save", "upload", "book", "register", "subscribe", "apply", "vote", "follow", "reply", "comment", "sign", "login", "logout", "message"];

/// Whether `goal` opens by asking for a change ("submit the order", "register an account", "check out", "log in"):
/// its command starts with the change it asks for, after any opening location clause ("On the demo site, register").
/// Loading a page changes nothing, so no call it sends by itself as it loads does what such a goal asks.
/// A goal that only names a change further on ("track my order", "latest blog post") is not one.
pub fn opens_with_a_change(goal: &str) -> bool {
    let command = goal
        .split_once(',')
        .and_then(|(context, command)| {
            let first = context.split_whitespace().next()?;
            ["on", "in", "at"].iter().any(|word| first.eq_ignore_ascii_case(word)).then_some(command)
        })
        .unwrap_or(goal);
    let mut words = command.split_whitespace().map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()).to_ascii_lowercase());
    let first = words.next().unwrap_or_default();
    let second = words.next().unwrap_or_default();
    (first == "check" && second == "out") || (first == "log" && matches!(second.as_str(), "in" | "out" | "on")) || WRITES.contains(&first.as_str())
}

/// Whether `goal` opens by asking to inspect data ("list ...", "check ..." but not "check out"). A walk's candidate
/// labelled as a state-changing call cannot satisfy one of these goals.
pub fn opens_with_a_read(goal: &str) -> bool {
    let mut words = goal.split_whitespace();
    let first = words.next().unwrap_or_default().trim_matches(|c: char| !c.is_alphanumeric()).to_ascii_lowercase();
    let second = words.next().unwrap_or_default().to_ascii_lowercase();
    (first == "check" && second != "out")
        || matches!(first.as_str(), "read" | "list" | "search" | "find" | "show" | "view" | "look" | "get" | "fetch" | "inspect" | "browse")
}

#[cfg(test)]
mod tests {

    /// The owner's window says what an answer holds in words: how many records, which of the goal's fields, and
    /// whether each says back the ask; one record is "1 record".
    #[test]
    fn what_an_answer_holds_is_said_in_words() {
        let none = super::Holding { shaped_asked: 1, records: 4, ..Default::default() };
        assert_eq!(none.said(), "its answer holds none of the goal's fields (4 records)");
        assert!(!none.has_shapes());
        let one = super::Holding { covered: vec!["price".into(), "name".into()], shaped: 1, shaped_asked: 1, echoes: true, records: 1, ..Default::default() };
        assert_eq!(one.said(), "its answer holds 1 record with price, name, each saying back what was asked");
        assert!(one.has_shapes());
        let many = super::Holding { records: 12, echoes: false, ..one };
        assert_eq!(many.said(), "its answer holds 12 records with price, name");
    }

    use super::*;

    #[test]
    fn linked_results_can_be_a_list_of_one_or_two_records() {
        let goal = "list saved articles with each title and link";
        let fields = fields(goal);
        for count in [1, 2] {
            let articles: Vec<_> = (1..=count).map(|i| serde_json::json!({"title":format!("Article {i}"),"url":format!("/articles/{i}")})).collect();
            let answer = serde_json::json!({"title":"Home","url":"/","articles":articles});
            let holding = holding_for_goal(&answer, &fields, &[], goal);
            assert!(holding.has_shapes() && holding.has_record_fields(goal, &fields), "{holding:?}");
            assert_eq!(holding.records, count);
        }
        let shell = serde_json::json!({"title":"Home","url":"/","articles":[]});
        assert!(!holding_for_goal(&shell, &fields, &[], goal).has_record_fields(goal, &fields));
        let split = serde_json::json!([{"title":"Article A"},{"url":"/articles/b"}]);
        assert!(!holding_for_goal(&split, &fields, &[], goal).has_record_fields(goal, &fields));
    }

    #[test]
    fn links_to_photos_do_not_supply_the_listing_link() {
        let listings = (1..=5).map(|n| serde_json::json!({
            "name": format!("Room {n}"),
            "price": "$36.00",
            "linkLabel": "Open details",
            "property": {"photos": {"main": {"relativeUrl": format!("/img/room-{n}")}}}
        })).collect::<Vec<_>>();
        let answer = serde_json::json!({"results": listings});
        let goal = "list the results with name, price and link of each";
        let requested = fields(goal);
        assert!(!holding_for_goal(&answer, &requested, &[], goal).has_shapes());
        let photo_goal = "list the results with a photo link";
        assert!(holding_for_goal(&answer, &fields(photo_goal), &[], photo_goal).has_shapes());

        let mut answer = answer;
        for (n, row) in answer["results"].as_array_mut().unwrap().iter_mut().enumerate() {
            row["url"] = serde_json::json!(format!("/property/{n}"));
        }
        let held = holding_for_goal(&answer, &requested, &[], goal);
        assert!(held.has_shapes() && held.has_record_fields(goal, &requested));
    }

    #[test]
    fn rendered_links_must_identify_distinct_records() {
        let goal = "list results with name, price and link of each";
        let answer = serde_json::json!({"results": (0..5).map(|i| serde_json::json!({
            "property": {"displayName": {"text": format!("Meadow Room {i}")}},
            "price": "$36"
        })).collect::<Vec<_>>()});
        let anchors: Vec<_> = (0..5).map(|i| serde_json::json!({
            "text": format!("Top rated Meadow Room {i} $36"), "url": format!("/property/{i}")
        })).collect();
        assert!(holding_with_rendered_links(&answer, &anchors, &fields(goal), &[], goal).is_some());
        let duplicate_address: Vec<_> = anchors.iter().cloned().map(|mut anchor| {
            anchor["url"] = "/property".into();
            anchor
        }).collect();
        assert!(holding_with_rendered_links(&answer, &duplicate_address, &fields(goal), &[], goal).is_none());
        let ambiguous: Vec<_> = anchors.iter().cloned().chain(anchors.iter().cloned().map(|mut anchor| {
            anchor["url"] = format!("{}?other=1", anchor["url"].as_str().unwrap()).into();
            anchor
        })).collect();
        assert!(holding_with_rendered_links(&answer, &ambiguous, &fields(goal), &[], goal).is_none());
        let partial: Vec<_> = (0..5).map(|i| serde_json::json!({
            "text": format!("Top rated Meadow Room {i}0 $36"), "url": format!("/property/{i}0")
        })).collect();
        assert!(holding_with_rendered_links(&answer, &partial, &fields(goal), &[], goal).is_none());
        assert!(holding_with_rendered_links(&answer, &anchors, &fields("name and price"), &[], "name and price").is_none());
    }

    #[test]
    fn a_related_entitys_link_cannot_stand_for_the_record() {
        let goal = "list results with name, price and link of each";
        let answer = serde_json::json!({"results": (0..5).map(|i| serde_json::json!({
            "title":format!("Meadow Room {i}"), "price":"$36", "manufacturer":{"name":format!("Pine Maker {i}")}
        })).collect::<Vec<_>>()});
        let makers: Vec<_> = (0..5).map(|i| serde_json::json!({
            "text":format!("Pine Maker {i}"), "url":format!("/maker/{i}")
        })).collect();
        assert!(holding_with_rendered_links(&answer, &makers, &fields(goal), &[], goal).is_none());
        let both: Vec<_> = makers.into_iter().chain((0..5).map(|i| serde_json::json!({
            "text":format!("Top rated Meadow Room {i}"), "url":format!("/rooms/{i}")
        }))).collect();
        let matched = holding_with_rendered_links(&answer, &both, &fields(goal), &[], goal).unwrap();
        assert_eq!(matched.links.len(), 5);
        assert_eq!(matched.links[0]["url"], "/rooms/0");

        let wrappers = serde_json::json!({"results": (0..5).map(|i| serde_json::json!({
            "property":{"displayName":{"text":format!("Meadow Room {i}")}}, "price":"$36", "chainName":format!("Inn Collection {i}")
        })).collect::<Vec<_>>()});
        let wrapped = holding_with_rendered_links(&wrappers, &both, &fields(goal), &[], goal).unwrap();
        assert_eq!(wrapped.links.len(), 5);
        assert_eq!(wrapped.links[0]["url"], "/rooms/0");
    }

    /// A storefront grid keeps each price as a numeric minor-unit amount with a sibling currency
    /// (`pricing.price.current.value: 4990`, `currency.code: "SGD"`): no single string looks like money, but the
    /// cost-naming key holds a figure nested in its parts. The answer holds the price.
    #[test]
    fn a_numeric_minor_unit_price_with_a_sibling_currency_is_a_price() {
        let product = |name: &str, cents: u64| serde_json::json!({
            "name": name,
            "pricing": {"price": {"current": {"value": cents, "currency": {"code": "SGD", "exponent": -2}}}}
        });
        let answer = serde_json::json!({"components": {
            "1": product("CROPPED LACE T-SHIRT", 2990), "2": product("LINEN SHIRT", 4990),
            "3": product("WOOL COAT", 9990), "4": product("COTTON HAT", 1990),
            "5": product("SILK SCARF", 1590), "6": product("ANKLE SOCKS", 990)
        }});
        let h = holding(&answer, &fields("t-shirt products with name and price"), &["t-shirt".to_string()]);
        assert!(h.has_shapes(), "a numeric price nested under a cost-naming key is a price: {}", h.said());
    }

    #[test]
    fn a_goal_opens_with_a_change_by_its_first_word() {
        for goal in ["submit a pizza order form", "register a new customer account", "Send a message", "check out the cart", "log in to the bank", "book a table for two", "post a comment"] {
            assert!(opens_with_a_change(goal), "{goal:?} opens with a change");
        }
        for goal in ["track my order", "read the latest blog post", "search orders", "check guest access", "list comments", "top stories", ""] {
            assert!(!opens_with_a_change(goal), "{goal:?} opens with no change");
        }
    }

    #[test]
    fn an_opening_site_context_does_not_hide_the_command() {
        assert!(opens_with_a_change("On the demo bank, register a fresh account, then read Accounts Overview."));
        assert!(opens_with_a_change("In the test store, log in and check the account."));
        assert!(!opens_with_a_change("On the demo bank, read the registration instructions, then list the fields."));
        assert!(!opens_with_a_change("Read the help page, register an account is one of the links."));
    }

    #[test]
    fn a_goal_that_names_a_read_only_reads() {
        assert!(only_reads("list WordPress admin posts"));
        assert!(only_reads("search Hacker News stories"));
        assert!(!only_reads("post a comment on the thread"));
        assert!(!only_reads("buy the item"));
        assert!(!only_reads("add it to the cart"));
    }

    #[test]
    fn a_goal_asks_a_change_only_in_its_own_words() {
        // The network path pays and runs another contributor's route without the owner, so a goal that names no
        // change only reads, whatever its first word.
        for goal in ["please search for red shoes", "red shoes under 50", "what's on the front page", "list the posts"] {
            assert!(!asks_a_change(goal), "{goal:?} asks for no change");
        }
        for goal in ["buy the red shoes", "post a comment on the thread", "cancel my order", "add it to the cart"] {
            assert!(asks_a_change(goal), "{goal:?} asks for a change");
        }
    }

    #[test]
    fn a_goal_opening_with_a_read_never_authorizes_a_background_write() {
        assert!(opens_with_a_read("list WordPress admin posts"));
        assert!(opens_with_a_read("check guest access"));
        assert!(!opens_with_a_read("send a message"));
        assert!(!opens_with_a_read("check out"));
    }
    use serde_json::json;

    fn words(fs: &[Field]) -> Vec<(&str, Shape)> {
        fs.iter().map(|f| (f.word.as_str(), f.shape)).collect()
    }

    #[test]
    fn a_goal_names_its_fields_after_saying_what_to_give_back() {
        assert_eq!(words(&fields("search Shop items, return item title and price")), [("item", Shape::Plain), ("title", Shape::Plain), ("price", Shape::Money)]);
        assert_eq!(words(&fields("list front page stories with title and link")), [("title", Shape::Plain), ("link", Shape::Link)]);
        assert_eq!(words(&fields("list current events with title and date")), [("title", Shape::Plain), ("date", Shape::Date)]);
        assert_eq!(
            words(&fields("repository metadata for a/b: description, stars, forks, default branch")),
            [("description", Shape::Plain), ("stars", Shape::Plain), ("forks", Shape::Plain), ("default", Shape::Plain), ("branch", Shape::Plain)]
        );
        // A goal that never says what to give back asks for all of its words.
        assert_eq!(words(&fields("sign up for the newsletter")), [("sign", Shape::Plain), ("newsletter", Shape::Plain)]);
    }

    #[test]
    fn a_release_read_requires_a_version_in_the_answer() {
        use serde_json::json;

        let version = "2.34.2";
        let flag_data = json!({"flags": [{"name": "show-install-guide", "enabled": true}]});
        let repository = json!({"name": "example library", "description": "The latest source code"});
        let page = json!({"title": "Example library", "text": "Supported releases\n2.34.2, stable, latest"});
        for ask in ["latest published version of the example package", "latest tag available for the official example image"] {
            let asked = fields(ask);
            assert!(!holding(&flag_data, &asked, &[]).has_shapes(), "feature settings supply no release");
            assert!(!holding(&repository, &asked, &[]).has_shapes(), "a repository read supplies no release");
            assert!(page_holding(&page, &asked, &[]).has_shapes(), "a single rendered release is an answer");
            assert!(holding(&json!({"release_version": version}), &asked, &[]).has_shapes(), "a release named in data also answers");
        }
    }

    #[test]
    fn showing_one_release_is_a_single_record_read() {
        assert!(wants_one("show the latest published version of widget"));
        assert!(!wants_one("show all published versions of widget"));
        assert!(!wants_one("show the latest tags for images"));
        assert!(!wants_one("show me the product listings"));
    }

    #[test]
    fn a_named_tag_field_holds_the_published_release() {
        let ask = fields("Get the latest tag of the widget image");
        assert!(holding(&serde_json::json!({"tag_name":"v2.34.2"}), &ask, &[]).has_shapes());
        assert!(!holding(&serde_json::json!({"dependency_tag_name":"v2.34.2"}), &ask, &[]).has_shapes());
    }

    #[test]
    fn a_foreign_tag_heading_ends_the_packages_tag_section() {
        let ask = fields("latest published version of Widget");
        let page = serde_json::json!({"title":"Widget", "text":"Supported tags\nSupported tags for Python\n3.11.2, latest"});
        assert!(!page_holding(&page, &ask, &[]).has_shapes());
    }

    #[test]
    fn a_release_read_distinguishes_a_page_date_from_a_published_version() {
        let asked = fields("latest published version of the example package");
        for date in ["2026.11.26", "26.11.2026", "11.26.2026"] {
            let page = serde_json::json!({"title":"Example library", "text":format!("Last updated: {date}. No releases have been published.")});
            assert!(!page_holding(&page, &asked, &[]).has_shapes(), "{date}");
            let page = serde_json::json!({"title":"Widget", "text":format!("Widget {date}")});
            assert!(!page_holding(&page, &asked, &[]).has_shapes(), "{date}");
        }
        for version in ["2.34.2", "v2026.11.26"] {
            let page = serde_json::json!({"title":"Widget", "text":format!("Latest version {version}\nLast updated: 2026.11.26")});
            assert!(page_holding(&page, &asked, &[]).has_shapes(), "{version}");
        }
        assert!(holding(&serde_json::json!({"latest_version":"2026.11.26"}), &asked, &[]).has_shapes());
    }

    #[test]
    fn a_release_read_requires_the_packages_own_version_on_a_rendered_page() {
        let ask = fields("latest published version of widget");
        for text in ["No Widget releases have been published. Requires Python 3.11.2.", "No Widget releases have been published\nBuild dependencies\nPython\nLatest version: 3.11.2", "No Widget releases have been published\nSupported tags for Python\n3.11.2, latest", "Examples\nInstall widget 2.33.0\nUpdated instructions for 2.34.2", "Changelog\n2.33.0\n2.32.0"] {
            assert!(!page_holding(&serde_json::json!({"title":"Widget", "text":text}), &ask, &[]).has_shapes(), "{text}");
        }
        for text in ["Widget 2.34.2\nRequires Python 3.11.2", "Supported tags\n2.34.2\n,\nstable\n,\nlatest", "Supported tags for Widget\n2.34.2, latest", "Details\nWidget latest version: 2.34.2"] {
            assert!(page_holding(&serde_json::json!({"title":"Widget | Registry", "text":text}), &ask, &[]).has_shapes(), "{text}");
        }
    }

    #[test]
    fn money_links_and_days_are_read_by_their_look() {
        for yes in ["S$828", "From $4.00", "SGD 12", "12,50 €", "£3", "price: $1,299.00"] {
            assert!(money(yes), "{yes}");
        }
        for no in ["iPhone 15", "10 in stock", "OnePlus 15 5G", "HTTP 404", "v2 API"] {
            assert!(!money(no), "{no}");
        }
        assert!(link("https://shop.example/item/1") && link("/item/1"));
        assert!(link("../products/lamp") && link("./products/lamp") && link("//shop.example/products/lamp"));
        assert!(!link("a title") && !link("//cdn") && !link("/"));
        for yes in ["2026-10-28T10:00:00Z", "28 Oct 2026", "October 28, 2026", "Sat, 1 Nov"] {
            assert!(date(yes), "{yes}");
        }
        for no in ["12 items", "Mark 2", "mayonnaise 12"] {
            assert!(!date(no), "{no}");
        }
    }

    /// A goal that asks for fares is answered by a list that names them prices: what a thing costs is asked for
    /// in one word and handed over under another, as a plain number with no currency sign. A list with no amount
    /// under any cost's name holds none, and a key that only spells like one (`feet`) names no cost.
    #[test]
    fn fares_asked_for_are_held_by_an_answer_that_calls_them_prices() {
        let goal = fields("find flights and fares");
        let flights = serde_json::json!({"itineraryList": (0..6).map(|n| serde_json::json!({"flightNo": format!("CA9{n}"), "policies": [{"price": {"totalPrice": 1449 + n, "adultPrice": 1300 + n}}]})).collect::<Vec<_>>()});
        assert!(holding(&flights, &goal, &[]).has_shapes(), "prices are the fares");
        let no_cost = serde_json::json!({"itineraryList": (0..6).map(|n| serde_json::json!({"flightNo": format!("CA9{n}"), "seats": 9 - n, "feet": 38000})).collect::<Vec<_>>()});
        assert!(!holding(&no_cost, &goal, &[]).has_shapes(), "a count and a height are no fare");
        assert!(names_a_cost("prices") && names_a_cost("fare") && !names_a_cost("feet") && !names_a_cost("priceless"));
    }

    /// A page's text that writes its prices with a currency code (`SGD 331`) holds prices: the code is read in the
    /// capitals it is written in.
    #[test]
    fn a_page_priced_by_currency_code_holds_prices() {
        let text = (0..6).map(|i| format!("SIN to BKK nonstop\nSGD {}", 300 + i)).collect::<Vec<_>>().join("\n");
        let page = serde_json::json!({"title": "Flights", "text": text, "links": []});
        let h = page_holding(&page, &fields("find flights and fares from the search"), &[]);
        assert!(h.has_shapes(), "{h:?}");
    }

    /// A shop's search answer and the widget beside it both list priced things; only the search's records say back
    /// what was searched for, and only the search answers it.
    #[test]
    fn the_list_that_says_back_the_search_is_the_answer() {
        let goal = fields("search listings for a product, return listing title and price");
        let asked = vec!["iphone 15".to_string()];
        let card = |name: &str, price: &str| json!({"productCard": {"infoFields": [{"text": name}, {"text": format!("From {price}")}]}});
        let widget = json!({"results": [card("OnePlus 15 5G", "S$828"), card("Galaxy S25", "S$900"), card("Pixel 10", "S$700")]});
        let search = json!({"results": [card("iPhone 15 128GB", "S$650"), card("Apple iPhone 14 Pro", "S$900"), card("iphone 15 case", "S$5")]});
        let w = holding(&widget, &goal, &asked);
        let s = holding(&search, &goal, &asked);
        assert!(w.has_shapes() && s.has_shapes(), "both carry prices");
        assert!(!w.echoes && s.echoes);
        assert!(rank(&s) > rank(&w));
    }

    /// Suggestions for what to search say the search back, but carry no prices: they don't answer a goal that asks
    /// for prices.
    #[test]
    fn an_answer_without_the_shaped_field_does_not_hold_the_goal() {
        let goal = fields("search items, return item title and price");
        let suggestions = json!({"results": [{"title": "nike women"}, {"title": "nike men"}, {"title": "nike kids"}]});
        let h = holding(&suggestions, &goal, &["nike".to_string()]);
        assert!(h.echoes && h.covered.contains(&"title".to_string()));
        assert!(!h.has_shapes());
        // Labels for a search box hold no records of anything.
        let labels = json!({"label_search_products": "Search products", "label_in_shop": "In this shop"});
        assert!(!holding(&labels, &goal, &["airpods".to_string()]).has_shapes());
        // Records keyed by their ids, with the price under a key named for it, do.
        let keyed = json!({"byId": {"a": {"name": "x", "pricing": {"price": 27900}}, "b": {"name": "y", "pricing": {"price": 1}},
            "c": {"name": "z", "pricing": {"price": 2}}, "d": {"name": "w", "pricing": {"price": 3}}, "e": {"name": "v", "pricing": {"price": 4}}}});
        let h = holding(&keyed, &goal, &[]);
        assert!(h.has_shapes() && h.records == 5, "{h:?}");
    }

    /// A page with no state of its own holds what it renders: thirty stories are thirty links.
    #[test]
    fn a_rendered_page_holds_what_it_shows_often_enough() {
        let goal = fields("list front page stories with title and link");
        let links: Vec<Value> = (0..30).map(|i| json!({"text": format!("Story {i}"), "url": format!("https://news.example/{i}")})).collect();
        let page = json!({"title": "News", "state": null, "text": "1.\nStory 0\n2.\nStory 1", "links": links});
        let h = page_holding(&page, &goal, &[]);
        assert!(h.has_shapes() && h.covered == ["link"], "{h:?}");
        // A page that shows a price once is not a list of priced things.
        let shop = fields("search items, return item title and price");
        let one = json!({"title": "Shop", "state": null, "text": "Sign up\nToday only $5 off", "links": []});
        assert!(!page_holding(&one, &shop, &["nike".to_string()]).has_shapes());
        let many = json!({"title": "Shop", "state": null, "text": "Nike\n$4.00\nNike\n$18.00\nNike\n$16.00\nNike\n$7.00\nNike\n$2.00\n", "links": []});
        let h = page_holding(&many, &shop, &["nike".to_string()]);
        assert!(h.has_shapes() && h.echoes, "{h:?}");
    }

    /// A field is named by a word of a key, never by letters inside one, and a switch names a setting, not a field.
    #[test]
    fn keys_name_fields_by_their_words() {
        let goal = fields("list items with price and title");
        let not = json!({"items": [{"target": 1, "priceEnabled": true, "subtitles": "x"}, {"target": 2, "priceEnabled": true, "subtitles": "y"}, {"target": 3, "priceEnabled": false, "subtitles": "z"}]});
        assert!(holding(&not, &goal, &[]).covered.is_empty(), "{:?}", holding(&not, &goal, &[]));
        let yes = json!({"items": [{"title": "a", "salesPrice": {"numeral": 249}}, {"title": "b", "salesPrice": {"numeral": 99}}, {"title": "c", "salesPrice": {"numeral": 5}}]});
        assert_eq!(holding(&yes, &goal, &[]).covered, ["price", "title"]);
        assert_eq!(key_words("last_price_dollars"), ["last", "price", "dollars"]);
        assert_eq!(key_words("yesAskDollars"), ["yes", "ask", "dollars"]);
    }

    /// An answer read as one record holds what sits in it, not what its lists of other records hold.
    #[test]
    fn one_record_is_read_without_its_lists() {
        let goal = fields("get the price of a coin");
        let tags = json!({"code": 0, "data": (0..5).map(|i| json!({"tag": format!("t{i}"), "avg_price_change": 1.5})).collect::<Vec<_>>()});
        let h = held_one(&tags, &goal, &[]);
        assert!(h.covered.is_empty(), "{h:?}");
        let state = json!({"app": {"props": {"ssr": {"detail": {"priceInfo": {"price": "78025.9"}}}}}});
        assert!(held_one(&state, &goal, &[]).has_shapes());
    }

    #[test]
    fn one_object_is_one_record_with_the_fields_its_keys_name() {
        let goal = fields("repository metadata for a/b: description, stars, forks, default branch");
        let repo = json!({"repo": {"description": "the package manager", "stargazerCount": 15645, "forkCount": 3093, "defaultBranch": "master"}});
        let h = holding(&repo, &goal, &[]);
        assert_eq!(h.covered, ["description", "stars", "forks", "default", "branch"]);
        assert_eq!(h.records, 1);
        assert!(!h.echoes);
    }
}
