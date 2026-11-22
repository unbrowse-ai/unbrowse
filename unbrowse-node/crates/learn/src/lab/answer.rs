//! Which call of a walk is the answer, from two walks of one page for two values (`docs/REBUILD.md`, section 6.4).
//!
//! One walk cannot tell a call that answers the caller from one that only carries the page's query: both send the
//! value, and both answer something. A second walk of the same page for another value is the experiment. A call the
//! page makes both times whose reply has nothing of its own beside the other's does not hear the caller, whatever it
//! is named and whatever it carries; one whose reply changes does, and the answer is the one of those that says its
//! own walk's value back on the most lines. The page itself is a candidate like any call.
//!
//! The properties are the node's two-walk experiment's (`told`, `says_back`, `speaks_against`, `answer_of_two` in the
//! node's `learn/experiment.rs`), asked of the engine's readers: a reply's JSON is [`Exchange::own_json`], a page is
//! [`crate::page::read`], and a call made again on the second walk is the one the engine pairs it with
//! ([`crate::lab::sighting::pairs`], the classifier's reader too). Nothing here asks a site.

use std::collections::{BTreeSet, HashMap};

use serde_json::Value;

use crate::lab::sighting::{made_again, pairs, Walk};
use crate::trace::{Exchange, Trace};

/// An answer with fewer lines than this says too little to tell two answers apart.
pub const TOO_LITTLE_TO_TELL: usize = 5;

/// What an answer says, line by line, with the words it was asked struck out wherever they stand: an answer that only
/// says the ask back (in a title, in its own address) then reads the same for any word, and one whose every record
/// names the word still reads as its records. A line says something when it has four letters or more.
///
/// The learn crate's reader of the lines of an answer. The node's `learn.rs` holds the same reading (`said_lines`,
/// with `nothing_of_its_own` and `TOO_LITTLE_TO_TELL`), which the engine cannot call from here; that copy is the one
/// to retire by asking this one.
pub fn said_lines(v: &Value, words: &[&str]) -> BTreeSet<String> {
    crate::slots::json_leaves(v)
        .into_iter()
        .flat_map(|(_, leaf)| leaf.lines().map(|l| l.trim().to_lowercase()).collect::<Vec<_>>())
        .map(|l| words.iter().filter(|w| !w.is_empty()).fold(l, |l, w| l.replace(&w.to_lowercase(), "\u{a7}")))
        .filter(|l| l.chars().filter(|c| c.is_alphabetic()).count() >= 4)
        .collect()
}

/// Whether `was` has nothing of its own beside `now`: a line or two may differ by a clock or an id, never the
/// records. A share of what the two have in common says little, since a results page is mostly its filters and its
/// menus whatever was asked.
pub fn nothing_of_its_own(was: &BTreeSet<String>, now: &BTreeSet<String>) -> bool {
    was.len() - was.intersection(now).count() <= (was.len() / 50).max(2)
}

/// What a second walk says of one call of the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Told {
    /// The page made the call both times and its reply changed with the value.
    Hears,
    /// The page made the call both times and it answered the same.
    Deaf,
    /// The second walk has no such call, or the replies say too little to tell apart: nothing is learned of it.
    Unseen,
}

/// What a call answered, as two answers are compared: its data, or the page it rendered.
pub fn answer_of(e: &Exchange) -> Option<Value> {
    if let Some(v) = e.own_json() {
        return Some(v);
    }
    let body = e.response_body.as_deref().filter(|b| crate::page::is_markup(&e.response_mime, b))?;
    Some(crate::page::read(body, &e.url))
}

/// What each of two walks was asked that the other was not: the values they differ by under the same name. The
/// experiment chose both, so whatever differs is the caller's; a value both were asked (a guest count) was not
/// varied and is not struck out of anything.
pub fn apart(first: &Walk, second: &Walk) -> (Vec<String>, Vec<String>) {
    let mut out: (Vec<String>, Vec<String>) = Default::default();
    for (name, x) in &first.asked {
        if let Some((_, y)) = second.asked.iter().find(|(n, _)| n == name) {
            if x != y && !x.is_empty() && !y.is_empty() {
                out.0.push(x.clone());
                out.1.push(y.clone());
            }
        }
    }
    out
}

fn words(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// Two walks of a page for two values, the second the experiment: what each was asked that the other was not
/// ([`apart`]), and where the second made each call of the first ([`pairs`]).
pub struct Two<'a> {
    pub first: &'a Trace,
    pub asked: Vec<String>,
    pub second: &'a Trace,
    pub other: Vec<String>,
    paired: HashMap<usize, usize>,
}

impl<'a> Two<'a> {
    pub fn of(first: &'a Walk<'a>, second: &'a Walk<'a>) -> Two<'a> {
        let (asked, other) = apart(first, second);
        Two { first: first.trace, asked, second: second.trace, other, paired: pairs(first, second) }
    }

    /// Call `i` of the first walk made again on the second: the lines of the first's reply, the words its page was
    /// asked struck out, and the reply of the call the second walk made in its place ([`pairs`]), where it made one
    /// and it was answered, its lines struck the same way. None for a call with no reply to compare.
    fn again(&self, i: usize) -> Option<(BTreeSet<String>, Option<(BTreeSet<String>, Value)>)> {
        let was = said_lines(&answer_of(&self.first.exchanges[i])?, &words(&self.asked));
        let there = self.paired.get(&i).and_then(|j| self.second.exchanges.get(*j)).filter(|o| (200..300).contains(&o.status));
        let now = there.and_then(answer_of).map(|v| (said_lines(&v, &words(&self.other)), v));
        Some((was, now))
    }

    /// What the second walk says of call `i` of the first.
    pub fn told(&self, i: usize) -> Told {
        match self.again(i) {
            None => Told::Unseen,
            Some((was, _)) if was.len() < TOO_LITTLE_TO_TELL => Told::Unseen,
            Some((_, None)) => Told::Unseen,
            Some((was, Some((now, _)))) if nothing_of_its_own(&was, &now) => Told::Deaf,
            Some(_) => Told::Hears,
        }
    }

    /// How many lines of what call `i` of the first walk answered say back what its page was asked.
    pub fn says_back(&self, i: usize) -> usize {
        says_back(self.first, i, &self.asked)
    }

    /// Of the lines that say back what call `i`'s page was asked ([`says_back`]), how many are the reply's own: the
    /// second walk's reply to the same call does not hold them. A list of results says another word's results the
    /// second time, where a menu or a map that lists the word as one of its own entries says that line on both walks,
    /// whatever the second was asked, and changed between them for another reason if it changed at all. What the pick
    /// reads ([`Two::settle`]).
    pub fn own_lines_back(&self, i: usize) -> usize {
        let Some((_, Some((_, now)))) = self.again(i) else { return 0 };
        let Some(answer) = answer_of(&self.first.exchanges[i]) else { return 0 };
        let theirs = said_lines(&now, &[]);
        let own: Vec<String> = said_lines(&answer, &[]).into_iter().filter(|l| !theirs.contains(l)).collect();
        saying(&own, &self.asked)
    }

    /// Whether the second walk met the site's door where call `i` of the first was answered with its page: the call
    /// paired with a page that runs code and says nothing, or with a refusal ([`crate::page::a_door`]). A door is no
    /// second sighting of the page: the site never showed this walk what it would have answered, so the experiment
    /// did not run for it, and what it answered says nothing of the page.
    pub fn answered_by_the_door(&self, i: usize) -> bool {
        let Some(there) = self.paired.get(&i).and_then(|j| self.second.exchanges.get(*j)) else { return false };
        there.is_main_document() && crate::page::a_door(there.status, there.response_body.as_deref().unwrap_or_default(), &there.url)
    }

    /// How many lines of what `i` answered as a page say back what its page was asked, read as the page's own text
    /// alone: not its title, its links, nor the state it was built from. A search page sets each result on a line of
    /// its own; a page that only sends the value back in its address or in its search box says it nowhere.
    pub fn text_lines_back(&self, i: usize) -> usize {
        let Some(answer) = answer_of(&self.first.exchanges[i]) else { return 0 };
        let text = answer["text"].as_str().unwrap_or_default();
        saying(&said_lines(&Value::String(text.to_string()), &[]), &self.asked)
    }

    /// Whether the two walks speak against call `i` of the first as an answer: the second walk made it too, and
    /// either it answered the same for both values, or its reply changed and still says nothing of its own of what its
    /// page was asked (a map beside the results changes with the city and names no hotel; a menu that lists the word
    /// names it on both walks). A call the second walk never made is not spoken against: the experiment says nothing
    /// of it.
    pub fn speaks_against(&self, i: usize) -> bool {
        match self.told(i) {
            Told::Deaf => true,
            Told::Hears => self.own_lines_back(i) < 2,
            Told::Unseen => false,
        }
    }

    /// The answer the two walks agree on, of the first walk's `candidates` (each with whether it is the page itself):
    /// the one the second walk also made, whose reply changed with the value, and which says back what its own page
    /// was asked on the most lines of its own ([`Two::own_lines_back`]): a line the other walk's reply also holds is no
    /// evidence that the reply answered the value. A data call that says it back at least half as often as the best is
    /// taken before the page (the same answer without the page around it), and of those one that reads (a GET) before
    /// one that sends a body (a page often posts what it showed to a call that records it). Err, saying why, when no
    /// candidate both hears and says its value back on two lines of its own or more: then two walks settled nothing.
    ///
    /// The page is the exception, and it is the site's own answer: a page renders the value in the site's own words
    /// (`Flights from SIN to BKK` drawn as `singapore to bangkok`, a word translated, a code written out), so a page
    /// whose own document changed with the value has answered it where no call says it back. A data call is only such
    /// evidence with the word on two lines of its own, a page's own rendering being the whole answer.
    ///
    /// A page whose walk the site's door answered was never walked: the second walk met a wall where the page was, so
    /// it says nothing of what the page would answer, and the first walk's own page stands where its text sets the
    /// results of what it was asked on two lines or more ([`Two::answered_by_the_door`], [`Two::text_lines_back`]).
    pub fn settle(&self, candidates: &[(usize, bool)]) -> Result<usize, Unsettled> {
        if self.asked.is_empty() {
            return Err(Unsettled::AskedAlike);
        }
        let told: Vec<(usize, bool, Told)> = candidates.iter().map(|(i, page)| (*i, *page, self.told(*i))).collect();
        let deaf = told.iter().filter(|(_, _, t)| *t == Told::Deaf).count();
        let lines: Vec<(usize, bool, usize)> = told.iter().filter(|(_, _, t)| *t == Told::Hears).map(|(i, page, _)| (*i, *page, self.own_lines_back(*i))).collect();
        let heard: Vec<(usize, bool, usize)> = lines.iter().copied().filter(|(_, _, lines)| *lines >= 2).collect();
        // A walk the door answered where the page was was never walked: the door is no second sighting, so no reply of
        // the other walk can say what this page answered. The page whose own text sets the results of what it was asked,
        // on two lines or more, answered the search by itself; a page that sends the value back in its address or its
        // search box alone is the site's form, not its answer.
        let the_door_never_saw = || {
            candidates.iter().find(|(i, page)| *page && self.answered_by_the_door(*i) && self.text_lines_back(*i) >= 2).map(|(i, _)| *i)
        };
        if lines.is_empty() {
            if let Some(i) = the_door_never_saw() {
                return Ok(i);
            }
            return Err(Unsettled::NoneHeard { deaf });
        }
        let Some(most) = heard.iter().map(|(_, _, lines)| *lines).max() else {
            // No call says the value back, and a page that heard may still have answered: it says it in its own
            // words, and its own rendering changing with the value is what says so.
            if let Some((i, _, _)) = lines.iter().find(|(_, page, _)| *page) {
                return Ok(*i);
            }
            if let Some(i) = the_door_never_saw() {
                return Ok(i);
            }
            return Err(Unsettled::NoneSaysItBack { heard: lines.len(), most: lines.iter().map(|(_, _, n)| *n).max().unwrap_or(0) });
        };
        let reads = |i: usize| self.first.exchanges[i].method.eq_ignore_ascii_case("GET");
        let call = heard.iter().filter(|(_, page, lines)| !page && lines * 2 >= most).max_by_key(|(i, _, lines)| (reads(*i), *lines));
        let (i, _, _) = call.or_else(|| heard.iter().max_by_key(|(_, _, lines)| *lines)).expect("a call heard and said it back");
        Ok(*i)
    }
}

/// How many lines of what call `i` answered say back what its page was asked.
pub fn says_back(trace: &Trace, i: usize, asked: &[String]) -> usize {
    let Some(answer) = answer_of(&trace.exchanges[i]) else { return 0 };
    saying(&said_lines(&answer, &[]), asked)
}

/// The words that say nothing of a topic in any language a site answers in: a word shorter than four letters (`a`,
/// `the`, `of`, `de`, `und`, `les`), which is most of every language's function words, and the handful of English's
/// commonest that are longer. A list this short is the property's exception, not a list to grow: a topic word is long,
/// and a function word is almost always short.
const FUNCTION_WORDS: &[&str] = &["about", "from", "have", "that", "their", "there", "this", "what", "which", "will", "with", "your"];

/// The words of `text` a person would type to search: runs of letters only, four or more of them, in small letters,
/// that are not a function word.
fn topic_words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphabetic()).filter(|w| w.chars().count() >= 4).map(str::to_lowercase).filter(|w| !FUNCTION_WORDS.contains(&w.as_str()))
}

/// Whether a value names a place rather than saying something: an address, an `@`-handle, a host. It has no space,
/// and holds an `@`, a `/`, or a dot between two letters (`programming.dev`).
fn names_a_place(value: &str) -> bool {
    let v = value.trim();
    !v.contains(char::is_whitespace) && (v.contains(['@', '/']) || v.as_bytes().windows(3).any(|w| w[0].is_ascii_alphabetic() && w[1] == b'.' && w[2].is_ascii_alphabetic()))
}

/// A record's own text: each string it holds that says something in words, as the words a person would type. A piece
/// of markup is read as the text it shows (`page::read`). A value that names a place says nothing, and neither does a
/// single word on its own: that is a code, a setting or a label (`public` for who may see a record, a field's name),
/// which names where a sentence or a name of several words says.
fn record_words(record: &Value, base: &url::Url) -> Vec<String> {
    fn strings<'v>(v: &'v Value, out: &mut Vec<&'v str>) {
        match v {
            Value::String(s) => out.push(s),
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Object(o) => o.values().for_each(|x| strings(x, out)),
            _ => {}
        }
    }
    let mut leaves = Vec::new();
    strings(record, &mut leaves);
    let mut words: Vec<String> = Vec::new();
    for leaf in leaves.into_iter().filter(|l| !names_a_place(l)) {
        let text = if crate::page::is_markup("text/html", leaf) { crate::page::read(leaf, base)["text"].as_str().unwrap_or_default().to_string() } else { leaf.to_string() };
        if text.split_whitespace().count() < 2 {
            continue;
        }
        for word in topic_words(&text) {
            if !words.contains(&word) {
                words.push(word);
            }
        }
    }
    words
}

/// The longest list an answer holds, the first of them where two are as long: its records (`learn.rs` counts an
/// answer's records the same way).
fn the_longest_list(v: &Value) -> Option<&Vec<Value>> {
    let mut best: Option<&Vec<Value>> = None;
    fn walk<'v>(v: &'v Value, best: &mut Option<&'v Vec<Value>>) {
        match v {
            Value::Array(a) => {
                if best.is_none_or(|b| a.len() > b.len()) {
                    *best = Some(a);
                }
                a.iter().for_each(|x| walk(x, best));
            }
            Value::Object(o) => o.values().for_each(|x| walk(x, best)),
            _ => {}
        }
    }
    walk(v, &mut best);
    best
}

/// The words the walk's answer says on several of its own records, beside the one it was asked: what a site says back
/// for a second word, read from the answer itself. A person types a word, and a site says back a word its records
/// share; a whole record's title is said back by that record alone.
///
/// The answer is the call of the walk that says the asked word back on the most lines ([`says_back`]), a page among
/// them (read as a page, [`answer_of`]); its records, its longest list. A word counts once per record that says it, in the record's own text ([`record_words`]). Left
/// out: the asked word and its words, a word under four letters or one of the handful of longer function words
/// (`FUNCTION_WORDS`), and the site's own chrome (a word every record carries, or one the page's own address or title
/// carries). A word said by one record only is that record's own. In order of how many records say it, the first said
/// first where two are said as often, so the order is the same every time.
pub fn shared_words(trace: &Trace, page: &str, asked: &[String]) -> Vec<String> {
    let Ok(base) = url::Url::parse(page) else { return Vec::new() };
    // A page is an answer too, read as a page (`answer_of`): its records are its longest list, the links it shows.
    let answer = (0..trace.exchanges.len())
        .map(|i| (i, says_back(trace, i, asked)))
        .filter(|(_, n)| *n > 0)
        .max_by_key(|(i, n)| (*n, std::cmp::Reverse(*i)))
        .and_then(|(i, _)| answer_of(&trace.exchanges[i]));
    let Some(answer) = answer else { return Vec::new() };
    let Some(records) = the_longest_list(&answer) else { return Vec::new() };
    let asked_words: Vec<String> = asked.iter().flat_map(|a| a.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect::<Vec<_>>()).collect();
    // The page's own chrome: the words of its address, and of its title where the walk holds the page.
    let title = trace.exchanges.iter().find(|e| e.is_main_document() && (200..300).contains(&e.status)).and_then(|e| e.response_body.as_deref()).map(|b| crate::page::read(b, &base)["title"].as_str().unwrap_or_default().to_string()).unwrap_or_default();
    let chrome: Vec<String> = topic_words(page).chain(topic_words(&title)).collect();
    // How many records say each word, and where it was first said.
    let mut said: Vec<(String, usize)> = Vec::new();
    for record in records {
        for word in record_words(record, &base) {
            match said.iter_mut().find(|(w, _)| *w == word) {
                Some(seen) => seen.1 += 1,
                None => said.push((word, 1)),
            }
        }
    }
    let every = records.len();
    let mut shared: Vec<(String, usize)> = said.into_iter().filter(|(w, n)| *n >= 2 && *n < every && !asked_words.contains(w) && !chrome.contains(w)).collect();
    // Stable: words said by as many records keep the order they were first said in.
    shared.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    shared.into_iter().map(|(w, _)| w).collect()
}

/// How many of `lines` say one value of `asked`, for the value said most. One character is a word in a script that
/// writes words so (`傘`); one Latin letter is not.
fn saying<'l>(lines: impl IntoIterator<Item = &'l String> + Clone, asked: &[String]) -> usize {
    let a_word = |a: &&String| a.chars().count() >= 2 || a.chars().any(|c| !c.is_ascii() && c.is_alphabetic());
    asked.iter().filter(a_word).map(|a| a.to_lowercase()).map(|a| lines.clone().into_iter().filter(|l| l.contains(&a)).count()).max().unwrap_or(0)
}

/// Why two walks settle no answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unsettled {
    /// Fewer than two walks: one cannot tell a call that answers the caller from one that carries the page's query.
    OneWalk,
    /// The two walks were asked the same: nothing differed for a reply to change with.
    AskedAlike,
    /// No call of the first walk's reply changed with the value: `deaf` answered the same on both walks, and the
    /// second walk never made the rest, or their replies say too little to tell apart.
    NoneHeard { deaf: usize },
    /// `heard` calls' replies changed with the value, none of them the page, and none says it back on two lines of
    /// its own: the most any said was `most`.
    NoneSaysItBack { heard: usize, most: usize },
}

impl std::fmt::Display for Unsettled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Unsettled::OneWalk => write!(f, "one walk cannot say which call answers the caller"),
            Unsettled::AskedAlike => write!(f, "the two walks were asked the same, so no reply could change with the value"),
            Unsettled::NoneHeard { deaf } => write!(f, "no reply changed with the value ({deaf} answered the same on both walks; the second walk never made the rest, or they say too little)"),
            Unsettled::NoneSaysItBack { heard, most } => write!(f, "{heard} replies changed with the value, and none says it back on two lines of its own (the most was {most})"),
        }
    }
}

/// Every call of a walk that may be its answer, each with whether it is the page itself: whatever answered, the
/// main frame's own documents among them. Of the calls the walk made again (`sighting::made_again`: its next pages,
/// the page asking twice), only the first that was answered with something (`sighting::answered`) is a candidate:
/// a call made again to read on is the same answer's next page, and a person came for the first.
pub fn candidates(walk: &Walk) -> Vec<(usize, bool)> {
    let asked: Vec<&str> = walk.asked.iter().map(|(_, v)| v.as_str()).collect();
    let exchanges = &walk.trace.exchanges;
    let answered: Vec<usize> = (0..exchanges.len()).filter(|&i| (200..300).contains(&exchanges[i].status)).collect();
    // The first of each call's copies, the first answered where one was.
    let mut firsts: Vec<usize> = Vec::new();
    for &i in &answered {
        let e = &exchanges[i];
        match firsts.iter().position(|&f| made_again(&exchanges[f], e, &asked)) {
            Some(at) if !crate::lab::sighting::answered(&exchanges[firsts[at]]) && crate::lab::sighting::answered(e) => firsts[at] = i,
            Some(_) => {}
            None => firsts.push(i),
        }
    }
    firsts.sort_unstable();
    firsts.into_iter().map(|i| (i, exchanges[i].is_main_document())).collect()
}

/// Which call of the first walk is the answer, with the second as the experiment: [`Two::settle`] over every call of
/// the first ([`candidates`]). None with fewer than two walks, or when the two settle nothing.
pub fn answer(walks: &[Walk]) -> Option<usize> {
    settle(walks).ok()
}

/// [`answer`], saying why when the walks settle nothing.
pub fn settle(walks: &[Walk]) -> Result<usize, Unsettled> {
    let [first, second, ..] = walks else { return Err(Unsettled::OneWalk) };
    Two::of(first, second).settle(&candidates(first))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A search's records share a topic word beside the asked one (`shade` on three lamps, `brass` on two), one word
    /// every record carries (`shop`, the site's own), and one a record says alone (a whole title of its own). The words
    /// several records share are offered, the most-shared first; the asked word, a word every record carries, the
    /// page's own words, a function word, and a record's lone title are not.
    #[test]
    fn the_words_an_answers_records_share_are_offered_the_most_shared_first() {
        let records = serde_json::json!({ "results": [
            { "name": "lamp with linen shade", "seller": "shop", "url": "https://lamps.example/item/1", "desc": "<p>A <b>brass</b> base</p>" },
            { "name": "brass lamp shade", "seller": "shop", "url": "https://lamps.example/item/2", "handle": "lamps@lamps.example" },
            { "name": "lamp shade drum", "seller": "shop", "url": "https://lamps.example/item/3" },
            { "name": "Edison bulb lamp 1994 limited release", "seller": "shop", "url": "https://lamps.example/item/4" },
        ]});
        let page = "https://lamps.example/search?q=lamp";
        let answer = Exchange { response_body: Some(records.to_string()), response_mime: "application/json".into(), resource_type: Some("XHR".into()), main_frame: None, url: "https://lamps.example/api/search?q=lamp".parse().unwrap(), ..crate::lab::sighting::tests::call("GET", "https://lamps.example/api/search?q=lamp", &[], None, "{}") };
        let doc = Exchange { response_body: Some("<html><head><title>Lamps | Search</title></head><body>a shop</body></html>".into()), response_mime: "text/html".into(), resource_type: Some("Document".into()), main_frame: Some(true), url: page.parse().unwrap(), ..answer.clone() };
        let trace = Trace { exchanges: vec![doc, answer], inputs: Vec::new() };
        let words = shared_words(&trace, page, &["lamp".to_string()]);
        assert_eq!(words, ["shade", "brass"], "{words:?}");
    }
    use crate::lab::sighting::tests::{call, trace, walk};

    fn records(word: &str) -> String {
        // What a search finds is other things for another word, not the same names with the word swapped.
        let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
        let rows: Vec<String> = (0..12).map(|n| format!(r#"{{"id":{n},"title":"{word} {} number {n}"}}"#, kinds[n % 4])).collect();
        format!(r#"{{"query":"{word}","results":[{}]}}"#, rows.join(","))
    }

    const STRIP: &str = r#"{"title":"You may also like","items":[{"name":"Garden chair"},{"name":"Desk fan"},{"name":"Wall clock"},{"name":"Door mat"},{"name":"Coat rack"}]}"#;

    fn get(url: &str, reply: &str) -> Exchange {
        call("GET", url, &[], None, reply)
    }

    /// The page itself, as the main frame loaded it: the records as a list of links, `rows` of them.
    fn page(word: &str, rows: usize) -> Exchange {
        let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
        let body: String = (0..rows).map(|n| format!("<li><a href='/p/{word}{n}'>{word} {} number {n}</a></li>", kinds[n % 4])).collect();
        let mut e = get(&format!("https://shop.example/s?q={word}"), &format!("<html><body><main><h1>Results</h1><ul>{body}</ul></main></body></html>"));
        e.response_mime = "text/html".into();
        e.resource_type = Some("Document".into());
        e.main_frame = Some(true);
        e
    }

    fn of(word: &str) -> Vec<String> {
        vec![word.to_string()]
    }

    /// The search call answers each value with its own records; the recommendations strip carries the page's query
    /// like every call of the page and answers the same; a call the second walk never made says nothing.
    #[test]
    fn a_second_walk_says_which_calls_hear_the_caller() {
        let walked = |word: &str, extra: bool| {
            let mut calls = vec![get(&format!("https://shop.example/api/search?q={word}"), &records(word)), get(&format!("https://shop.example/api/strip?q={word}"), STRIP)];
            if extra {
                calls.push(get(&format!("https://shop.example/api/once?q={word}"), &records(word)));
            }
            trace(calls)
        };
        let (first, second) = (walked("brass", true), walked("glass", false));
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(0), Told::Hears);
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(1), Told::Deaf);
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(2), Told::Unseen);
    }

    /// The answer is the call both walks make whose reply changes with the value and says its own walk's value back:
    /// the search, over the page that holds the same records around a shell, and over a strip that answers the same
    /// for both. The page itself is a candidate, and is the answer when no call holds the records; with nothing
    /// that hears, nothing is settled.
    #[test]
    fn two_walks_agree_on_the_call_that_answers_and_the_page_is_one_of_the_calls() {
        let walked = |word: &str, search: bool, rows: usize| {
            let mut calls = vec![page(word, rows)];
            if search {
                calls.push(get(&format!("https://shop.example/api/search?q={word}"), &records(word)));
            }
            calls.push(get(&format!("https://shop.example/api/strip?q={word}"), STRIP));
            trace(calls)
        };
        let answer_of_walks = |first: &Trace, second: &Trace| answer(&[walk(first, &[("q", "brass")]), walk(second, &[("q", "glass")])]);
        assert_eq!(answer_of_walks(&walked("brass", true, 12), &walked("glass", true, 12)), Some(1), "the call, over the page around it");
        assert_eq!(answer_of_walks(&walked("brass", false, 12), &walked("glass", false, 12)), Some(0), "the page, when it alone holds the records");
        assert_eq!(answer_of_walks(&walked("brass", false, 0), &walked("glass", false, 0)), None, "nothing hears: nothing is settled");
        assert_eq!(candidates(&walk(&walked("brass", true, 12), &[("q", "brass")])), [(0, true), (1, false), (2, false)], "the main frame's document is the page");

        // What the second walk speaks against: the strip that answers the same for both, never the search it bears
        // out, and never a call it did not make.
        let (one, two) = (walked("brass", true, 12), walked("glass", true, 12));
        assert!(Two::of(&walk(&one, &[("q", "brass")]), &walk(&two, &[("q", "glass")])).speaks_against(2) && !Two::of(&walk(&one, &[("q", "brass")]), &walk(&two, &[("q", "glass")])).speaks_against(1));
        assert!(!Two::of(&walk(&one, &[("q", "brass")]), &walk(&walked("glass", false, 12), &[("q", "glass")])).speaks_against(1), "a call the second walk never made is not spoken against");
    }

    /// A page answers in the site's own words: asked `Flights from SIN to BKK on 2027-03-10 one way`, it draws
    /// `singapore to bangkok` and the date it read out, so none of its own lines holds what it was asked whole. A
    /// ticker beside it changed for its own reason and says nothing of the ask. The page's own rendering moved with
    /// the value, which is the page's way of answering it, so the page is the answer where no call says the value
    /// back. A page that renders the same for both values is a shell and answers nothing, and a call that hears and
    /// says nothing of the value is no answer on its own.
    #[test]
    fn a_page_that_renders_the_value_in_its_own_words_is_the_answer() {
        let ask = |city: &str| format!("Flights from SIN to {city} on 2027-03-10 one way");
        // The page draws the cities the codes name, and the flights it found between them.
        let drawn = |city: &str, airline: &str| {
            let body = format!(
                "<html><head><title>{city} | flights</title></head><body><main><h1>singapore to {city}</h1>\
                 <p>track prices from singapore to {city} departing 2027-03-10</p><p>{airline}</p>\
                 <p>1 stop in kuala lumpur</p><p>2 hr 20 min</p><p>104 kg co2e</p></main></body></html>"
            );
            let mut e = get(&format!("https://flights.example/search?q={}", ask(city)), &body);
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e
        };
        // The page as served to both values: the app's shell, with nothing of the ask drawn in it.
        let shell = |city: &str| {
            let mut e = get(&format!("https://flights.example/search?q={}", ask(city)), "<html><body><main><h1>Flights</h1><p>Loading results…</p></main></body></html>");
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e
        };
        // A ticker that changed between the two walks for its own reason, and says nothing of the ask.
        let ticker = |headline: &str| {
            let items = [
                format!(r#"{{"title":"{headline}"}}"#),
                format!(r#"{{"title":"more on {headline}"}}"#),
                format!(r#"{{"title":"and {headline} again"}}"#),
            ];
            let rest = ["airport strike called off", "rail fares rise in april", "runway closed for repairs", "cabin crew talks resume", "new terminal opens", "weather delays expected", "baggage rules tightened"];
            let mut all = items.to_vec();
            all.extend(rest.iter().map(|t| format!(r#"{{"title":"{t}"}}"#)));
            get("https://flights.example/api/ticker", &format!(r#"{{"items":[{}]}}"#, all.join(",")))
        };
        let walked = |page: Exchange, headline: &str, _city: &str| trace(vec![page, ticker(headline)]);

        let (first, second) = (walked(drawn("bangkok", "thai airways"), "thai airways adds a route", "BKK"), walked(drawn("tokyo", "japan airlines"), "japan airlines adds a route", "TYO"));
        assert_eq!(candidates(&walk(&first, &[("q", &ask("BKK"))])), [(0, true), (1, false)], "the main frame's document is the page");
        assert_eq!(says_back(&first, 0, &of(&ask("BKK"))), 0, "the page says none of the ask whole");
        assert_eq!(answer(&[walk(&first, &[("q", &ask("BKK"))]), walk(&second, &[("q", &ask("TYO"))])]), Some(0), "the page, which drew the cities the codes name");
        assert_eq!(
            settle(&[walk(&first, &[("q", &ask("BKK"))]), walk(&second, &[("q", &ask("TYO"))])]),
            Ok(0),
            "and it settles rather than saying the walks settled nothing"
        );

        // The same page served to both values is a shell: its own rendering says nothing, and neither does the ticker.
        let (one, two) = (walked(shell("BKK"), "strike called off", "BKK"), walked(shell("TYO"), "fares rise", "TYO"));
        assert_eq!(answer(&[walk(&one, &[("q", &ask("BKK"))]), walk(&two, &[("q", &ask("TYO"))])]), None);
        // And a call that hears with nothing of its own of the ask is no answer without the page beside it.
        let heard = |headline: &str| trace(vec![ticker(headline), get("https://flights.example/api/strip", STRIP)]);
        assert_eq!(answer(&[walk(&heard("strike called off"), &[("q", &ask("BKK"))]), walk(&heard("fares rise"), &[("q", &ask("TYO"))])]), None);
        assert_eq!(
            settle(&[walk(&heard("strike called off"), &[("q", &ask("BKK"))]), walk(&heard("fares rise"), &[("q", &ask("TYO"))])]),
            Err(Unsettled::NoneSaysItBack { heard: 1, most: 0 }),
            "what the walks settled is said: a call that hears and says nothing back is not the answer"
        );
    }

    /// A walk that met the site's door where the page was was never walked: the door is no second sighting of the
    /// page, so the experiment did not run for it and nothing of the second walk says the page answered nothing. The
    /// page whose own text sets each result of what it was asked is the answer (eBay serves its results in the page
    /// and walls the second walk); a page that only sends the value back in its address, or in its search box, is the
    /// site's form, and a walk the door never stopped still leaves the two walks unsettled.
    #[test]
    fn a_page_the_other_walks_door_refused_is_answered_by_its_own_text() {
        // The results the page serves: a line for each record, as eBay's search page has them.
        let results = |word: &str| {
            let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
            let items: String = (0..8).map(|n| format!("<li><a href='/p/{word}{n}'>{word} {} number {n}</a></li>", kinds[n % 4])).collect();
            format!("<html><head><title>{word} | search</title></head><body><main><h1>Results for {word}</h1><ul>{items}</ul></main></body></html>")
        };
        let page = |word: &str, body: String| {
            let mut e = get(&format!("https://shop.example/s?q={word}"), &body);
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e
        };
        // The site's door: a refusal where the page was, saying nothing of the search.
        let door = |word: &str| {
            let mut e = get(&format!("https://shop.example/s?q={word}"), "<html><body><p>Access denied: a check is running</p></body></html>");
            e.status = 403;
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e
        };
        let results_page = trace(vec![page("brass", results("brass"))]);
        let stopped = trace(vec![door("glass")]);
        let bounced = [walk(&results_page, &[("q", "brass")]), walk(&stopped, &[("q", "glass")])];
        assert!(Two::of(&bounced[0], &bounced[1]).answered_by_the_door(0), "the second walk met the door where the page was");
        assert_eq!(Two::of(&bounced[0], &bounced[1]).told(0), Told::Unseen, "a door is no sighting, so it is not heard either");
        assert_eq!(settle(&bounced), Ok(0), "the page its own text answers the search with");

        // The same page with the value only in its title, its address and its search box: the site's form, not its
        // answer, whatever the door did.
        let form = |word: &str| {
            format!("<html><head><title>{word} | search</title></head><body><main><form><input name=q value='{word}'/></form><p>Type a word to search.</p></main></body></html>")
        };
        let form_page = trace(vec![page("brass", form("brass"))]);
        let bounced = [walk(&form_page, &[("q", "brass")]), walk(&stopped, &[("q", "glass")])];
        assert_eq!(settle(&bounced), Err(Unsettled::NoneHeard { deaf: 0 }), "an echo of the ask is no answer");

        // And where no door stopped the second walk, the page it served for another value is a sighting: two shells
        // answered the same for both, so the walks settle nothing, and no door is there to say why.
        let shell = "<html><head><title>Search results</title></head><body><main><h1>Search</h1><p>loading results…</p><p>this page needs its code to run</p><p>one moment please</p><a href='/about'>about this shop</a></main></body></html>";
        let one = trace(vec![page("brass", shell.to_string())]);
        let two = trace(vec![page("glass", shell.to_string())]);
        let walked = [walk(&one, &[("q", "brass")]), walk(&two, &[("q", "glass")])];
        assert!(!Two::of(&walked[0], &walked[1]).answered_by_the_door(0), "the page itself answered the second walk");
        assert_eq!(settle(&walked), Err(Unsettled::NoneHeard { deaf: 1 }), "a shell is a sighting, and it says the page answered nothing");
    }

    /// A call that posts what the page showed says the value back as often as the search that read it: the call that
    /// reads is the answer.
    #[test]
    fn of_two_calls_that_say_as_much_the_one_that_reads_is_the_answer() {
        let walked = |word: &str| {
            trace(vec![
                get(&format!("https://shop.example/api/search?q={word}"), &records(word)),
                call("POST", "https://shop.example/api/seen/create", &[], Some(&format!(r#"{{"shown":"{word}"}}"#)), &records(word)),
            ])
        };
        let (first, second) = (walked("brass"), walked("glass"));
        assert_eq!(answer(&[walk(&first, &[("q", "brass")]), walk(&second, &[("q", "glass")])]), Some(0));
    }

    /// An answer that only says the ask back changes with the value and still has nothing of its own: the value is
    /// struck out before two replies are compared. And a call whose path carries the value is the same call.
    #[test]
    fn an_echo_is_deaf_and_a_value_in_the_path_is_the_same_call() {
        let echo = |word: &str| format!(r#"{{"query":"{word}","tracking":"search for {word} logged","shelf":"popular this week","hint":"try another word","note":"results may vary","zone":"header banner"}}"#);
        let walked = |word: &str| trace(vec![call("POST", &format!("https://shop.example/log?q={word}"), &[], None, &echo(word)), get(&format!("https://shop.example/find/{word}/list"), &records(word))]);
        let (first, second) = (walked("brass"), walked("glass"));
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(0), Told::Deaf);
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(1), Told::Hears);
    }

    /// The second walk's call made again is the one the engine pairs with the first's (`sighting::pairs`): at an
    /// address that answers every operation, the call of the second walk that sends the most of the same values. With
    /// the search there, it is the search, and not the menu beside it. With only the menu there, the one reader pairs
    /// the two (a value the second walk sent otherwise is that call's own value, as the classifier reads it), and the
    /// menu's reply is held against the search's; the name rule this replaced said the second walk made no search.
    #[test]
    fn the_call_made_again_is_the_one_the_engine_pairs_it_with() {
        let gql = |op: &str, word: &str, reply: &str| call("POST", "https://shop.example/graphql", &[], Some(&format!(r#"{{"operationName":"{op}","variables":{{"q":"{word}"}}}}"#)), reply);
        let menu = |season: &str| format!(r#"{{"menu":["{season} garden chairs","{season} desk fans","{season} wall clocks","{season} door mats","{season} coat racks"]}}"#);
        let first = trace(vec![gql("Search", "brass", &records("brass"))]);
        let second = trace(vec![gql("Menu", "glass", &menu("winter")), gql("Search", "glass", &records("glass"))]);
        let (a, b) = (walk(&first, &[("q", "brass")]), walk(&second, &[("q", "glass")]));
        assert_eq!(pairs(&a, &b).get(&0), Some(&1), "the search, which sends the same operation's name");
        assert_eq!(Two::of(&a, &b).told(0), Told::Hears);
        let only_the_menu = trace(vec![gql("Menu", "glass", &menu("winter"))]);
        assert_eq!(pairs(&a, &walk(&only_the_menu, &[("q", "glass")])).get(&0), Some(&0), "the one call at the address, by the one reader");
    }

    /// A menu that lists the word among its own entries says it back on both walks, whatever the second was asked:
    /// none of those lines is its own. A list of results says the first word's results only the first time.
    #[test]
    fn a_line_both_walks_reply_with_is_not_a_line_of_its_own() {
        let menu = |season: &str| format!(r#"{{"menu":["{season} offers","brass fittings","glass shelves","garden chairs","desk fans","wall clocks"]}}"#);
        let walked = |word: &str, season: &str| trace(vec![get(&format!("https://shop.example/api/search?q={word}"), &records(word)), get(&format!("https://shop.example/api/menu?q={word}"), &menu(season))]);
        let (first, second) = (walked("brass", "summer"), walked("glass", "winter"));
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(1), Told::Hears, "the menu changed with the season");
        assert_eq!((says_back(&first, 1, &of("brass")), Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).own_lines_back(1)), (1, 0));
        assert_eq!((says_back(&first, 0, &of("brass")), Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).own_lines_back(0)), (13, 13), "every line that says the word is the first walk's own");
    }

    /// A site's menu changed between the walks for another reason (the season) and lists the asked word among its
    /// entries on more lines than the results say it: it hears, by the letter, and says the word back more often.
    /// None of those lines is its own, and the results are the answer.
    #[test]
    fn a_reply_that_changed_for_another_reason_does_not_win_for_the_lines_it_shares() {
        let menu = |season: &str| {
            let entries: Vec<String> = (0..30).map(|n| format!(r#""brass and glass fittings, aisle {n}""#)).collect();
            format!(r#"{{"season":"{season} offers","menu":[{}]}}"#, entries.join(","))
        };
        let walked = |word: &str, season: &str| trace(vec![get(&format!("https://shop.example/api/menu?q={word}"), &menu(season)), get(&format!("https://shop.example/api/search?q={word}"), &records(word))]);
        let (first, second) = (walked("brass", "summer"), walked("glass", "winter"));
        assert_eq!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).told(0), Told::Hears, "the menu changed");
        assert!(says_back(&first, 0, &of("brass")) > says_back(&first, 1, &of("brass")), "and says the word on more lines than the results");
        assert_eq!(answer(&[walk(&first, &[("q", "brass")]), walk(&second, &[("q", "glass")])]), Some(1));
        assert!(Two::of(&walk(&first, &[("q", "brass")]), &walk(&second, &[("q", "glass")])).speaks_against(0));
        // The menu alone settles nothing: no reply says the word on lines of its own.
        let alone = |word: &str, season: &str| trace(vec![get(&format!("https://shop.example/api/menu?q={word}"), &menu(season))]);
        assert_eq!(answer(&[walk(&alone("brass", "summer"), &[("q", "brass")]), walk(&alone("glass", "winter"), &[("q", "glass")])]), None);
    }

    /// Where two walks settle nothing they say why: one walk, two walks asked alike, no reply that changed, or
    /// replies that changed and say the value on no line of their own.
    #[test]
    fn two_walks_that_settle_nothing_say_why() {
        let walked = |word: &str, reply: &str| trace(vec![get(&format!("https://shop.example/api/strip?q={word}"), reply)]);
        let (first, second) = (walked("brass", STRIP), walked("glass", STRIP));
        assert_eq!(settle(&[walk(&first, &[("q", "brass")])]), Err(Unsettled::OneWalk));
        assert_eq!(settle(&[walk(&first, &[("q", "brass")]), walk(&second, &[("q", "brass")])]), Err(Unsettled::AskedAlike));
        assert_eq!(settle(&[walk(&first, &[("q", "brass")]), walk(&second, &[("q", "glass")])]), Err(Unsettled::NoneHeard { deaf: 1 }));
        let changed = |n: usize| format!(r#"{{"items":["garden chair {n}","desk fan {n}","wall clock {n}","door mat {n}","coat rack {n}"]}}"#);
        let (first, second) = (walked("brass", &changed(1)), walked("glass", &changed(2)));
        assert_eq!(settle(&[walk(&first, &[("q", "brass")]), walk(&second, &[("q", "glass")])]), Err(Unsettled::NoneSaysItBack { heard: 1, most: 0 }));
    }

    /// A walk reads on: it asks the search again for the next page, each later page adding the session id the page
    /// before it handed over, and the later pages say the word on more lines. The answer is the first page: a call
    /// made again to read on is the same answer's next page, and the route is that one call. A copy answered with
    /// nothing before it is no first page.
    #[test]
    fn the_answer_is_the_first_of_a_calls_repeats() {
        let page = |word: &str, n: usize, session: Option<&str>| {
            // What a search finds is other things for another word, not the same titles with the word swapped.
            let kinds = if word == "brass" { ["band", "polish", "lamp", "knocker"] } else { ["blower", "vase", "shelf", "jar"] };
            let items: Vec<String> = (0..4 + n * 4).map(|k| format!(r#"{{"title":"{word} {} story {n}-{k}"}}"#, kinds[k % 4])).collect();
            let next = format!("sess-{word}-{}", n + 1);
            let address = match session {
                Some(s) => format!("https://news.example/api/v1/post/search?query={word}&page={n}&feedSessionId={s}"),
                None => format!("https://news.example/api/v1/post/search?query={word}&page={n}"),
            };
            get(&address, &format!(r#"{{"results":[{}],"feedSessionId":"{next}"}}"#, items.join(",")))
        };
        let walked = |word: &str| {
            let s1 = format!("sess-{word}-1");
            let s2 = format!("sess-{word}-2");
            trace(vec![page(word, 0, None), page(word, 1, Some(&s1)), page(word, 2, Some(&s2))])
        };
        let (first, second) = (walked("brass"), walked("glass"));
        let walks = [walk(&first, &[("query", "brass")]), walk(&second, &[("query", "glass")])];
        assert_eq!(candidates(&walks[0]), [(0, false)], "the later pages are the first made again");
        assert_eq!(answer(&walks), Some(0));
        let body = crate::lab::compile::learn(&walks, "news.example").unwrap();
        assert_eq!(body.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["x0"], "one step: the first page reads no session id");
        // The page asked once with nothing to show for it, then answered: the copy that answered is the first.
        let mut held = walked("brass");
        let mut empty = held.exchanges[0].clone();
        empty.response_body = Some(String::new());
        held.exchanges.insert(0, empty);
        assert_eq!(candidates(&walk(&held, &[("query", "brass")])), [(1, false)]);
    }

    /// What two walks were asked apart is what differs between them under one name; what both were asked is not.
    #[test]
    fn what_two_walks_were_asked_apart_is_what_differs_under_one_name() {
        let t = trace(vec![]);
        let (a, b) = (walk(&t, &[("q", "brass"), ("adults", "2")]), walk(&t, &[("q", "glass"), ("adults", "2")]));
        assert_eq!(apart(&a, &b), (of("brass"), of("glass")));
    }

    /// The lines of an answer are its leaves' lines in small letters, the words it was asked struck out, and only
    /// those that say something: four letters or more.
    #[test]
    fn the_lines_of_an_answer_strike_the_words_it_was_asked() {
        let lines = said_lines(&serde_json::json!({"title": "Brass lamps\nfor the hall", "n": 12, "tag": "ok", "who": "brass"}), &["brass"]);
        assert_eq!(lines.into_iter().collect::<Vec<_>>(), ["for the hall", "\u{a7} lamps"]);
    }

    /// A call says back what its page was asked on as many lines as hold the word: the search that lists three records,
    /// two of them brass, says it twice; a strip that lists nothing of it says it on none.
    #[test]
    fn a_call_says_back_the_word_on_as_many_lines_as_hold_it() {
        let answer = |word: &str| format!(r#"{{"results":[{{"t":"{word} lamp one"}},{{"t":"{word} kettle two"}},{{"t":"copper pan"}}]}}"#);
        let walked = |word: &str| trace(vec![get(&format!("https://shop.example/api/search?q={word}"), &answer(word)), get(&format!("https://shop.example/api/strip?q={word}"), STRIP)]);
        let (first, second) = (walked("brass"), walked("glass"));
        let (a, b) = (walk(&first, &[("q", "brass")]), walk(&second, &[("q", "glass")]));
        let two = Two::of(&a, &b);
        assert_eq!(two.says_back(0), 2);
        assert_eq!(two.says_back(1), 0);
        assert_eq!(says_back(&first, 0, &of("glass")), 0, "the other walk's word is not said in this walk's reply");
    }

    /// Each reason two walks settle nothing is said in words that carry its numbers.
    #[test]
    fn why_two_walks_settle_nothing_is_said_with_its_numbers() {
        assert_eq!(Unsettled::OneWalk.to_string(), "one walk cannot say which call answers the caller");
        assert_eq!(Unsettled::AskedAlike.to_string(), "the two walks were asked the same, so no reply could change with the value");
        let heard = Unsettled::NoneHeard { deaf: 3 }.to_string();
        assert!(heard.starts_with("no reply changed with the value (3 answered the same"), "{heard}");
        assert_eq!(Unsettled::NoneSaysItBack { heard: 2, most: 1 }.to_string(), "2 replies changed with the value, and none says it back on two lines of its own (the most was 1)");
    }

    /// A record's words are read from all it holds, nested lists and objects as well as its top: a word two records
    /// say inside a list of tags or an object of their own is shared, as one said at the top is.
    #[test]
    fn the_words_records_share_are_read_inside_their_lists_and_objects() {
        let reply = serde_json::json!({ "results": [
            { "name": "water tank", "tags": ["copper fitting"], "meta": { "note": "boxed" } },
            { "name": "water pump", "tags": ["copper elbow"], "meta": { "note": "boxed" } },
            { "name": "water filter", "tags": [], "meta": { "note": "stainless gasket kit" } },
            { "name": "water valve", "tags": [], "meta": { "note": "stainless gasket ring" } },
        ]});
        let t = trace(vec![get("https://plumb.example/api/search?q=water", &reply.to_string())]);
        let mut words = shared_words(&t, "https://plumb.example/search?q=water", &of("water"));
        words.sort();
        assert_eq!(words, ["copper", "gasket", "stainless"], "{words:?}");
    }
}
