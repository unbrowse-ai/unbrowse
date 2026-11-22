//! A route learned from one sighting, confirmed by use (`UNBROWSE_CONFIRM_BY_USE`): its first ask for a new value is
//! served by the browser, a walk of the agent's own page for that value, and the route is called once beside it. The
//! walk is the second sighting the learner pairs with the first (`history_of`, `route_of_by`), so the route that
//! stands is built from two walks; the route's answer is held against the walk's own answer to the same call. The node
//! asks the site nothing of its own: the walk is the agent's ask, and the one call beside it is the comparison.

use super::*;

/// What came of serving a route's first ask for a new value by the browser, the route called beside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Confirmed {
    /// The route gave the answer the browser's walk got: it stands confirmed.
    Agreed,
    /// It answered something else, or the walk made no such call: the route of the two walks stands, unconfirmed.
    Differed { why: String },
    /// The route's call failed: the route of the two walks stands, unconfirmed.
    Failed { why: String },
    /// The route answered what the browser got, but the walks so far cannot tell two writings of the caller's value
    /// apart, and the two write the new value alike: its answer says nothing of a value they part on. The route of
    /// the two walks stands unconfirmed, not wrong, and the next new value that parts the writings settles it.
    CannotTell { why: String },
}

impl Confirmed {
    /// The verdict's word: `agreed`, `differed`, `failed` or `cannot-tell`.
    pub fn word(&self) -> &'static str {
        match self {
            Confirmed::Agreed => "agreed",
            Confirmed::Differed { .. } => "differed",
            Confirmed::Failed { .. } => "failed",
            Confirmed::CannotTell { .. } => "cannot-tell",
        }
    }

    /// Why, where the route was not confirmed.
    pub fn why(&self) -> Option<&str> {
        match self {
            Confirmed::Agreed => None,
            Confirmed::Differed { why } | Confirmed::Failed { why } | Confirmed::CannotTell { why } => Some(why),
        }
    }

    /// The verdict as the node's log says it: `agreed`, `differed: <why>`, `failed: <why>`, `cannot-tell: <why>`.
    pub fn said(&self) -> String {
        match self.why() {
            None => self.word().to_string(),
            Some(why) => format!("{}: {why}", self.word()),
        }
    }
}

/// A confirming browse: the verdict, and the route that stands after it (learned from the two walks).
#[derive(Clone, Debug)]
pub struct Confirmation {
    pub verdict: Confirmed,
    pub standing: Route,
    /// The requests sent while the one call beside the walk ran (`http::sent_so_far`): the comparison's own cost,
    /// told apart from anything the learn of the walk sent. Counted across the process, so a node serving other
    /// calls at the same time counts theirs too. Read by the matrix's arm B (`primitives`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub sent_beside: u64,
    /// What the browser's walk for the new value answered the agent's ask with (`the_browsers_answer`): the reply to
    /// the ask, whatever route stands. None where the walk made no call of either route.
    pub answer: Option<serde_json::Value>,
}

/// Whether `route` stands on one sighting: the site has not yet been seen to answer it for a second value (no word
/// said back, `Heard::said_back`). A use that agrees records one, and the route is no longer served by the browser.
pub fn stands_on_one_sighting(route: &Route) -> bool {
    route.heard.said_back.is_none()
}

/// The values `given` asks of `route` in place of those it was learned on: each input's name, the value it was
/// learned on, and the new one.
fn moved<'a>(route: &'a Route, given: &'a HashMap<String, String>) -> Vec<(&'a str, &'a str, &'a str)> {
    route
        .inputs
        .iter()
        .filter_map(|i| {
            let (was, now) = (i.default.as_deref()?, given.get(&i.name)?);
            (was != now && now.trim().chars().count() >= 2).then_some((i.name.as_str(), was, now.as_str()))
        })
        .collect()
}

/// Whether an ask with `given` is served by the browser and the route compared beside it (`confirm_by_use`): the
/// route only reads, it stands on one sighting, and the ask gives a value other than the one it was learned on. A
/// route asked its own value answers as it was seen to.
pub fn served_by_the_browser(route: &Route, given: &HashMap<String, String>) -> bool {
    !route.write && route.socket.is_none() && (stands_on_one_sighting(route) || route.heard.records_at.is_none()) && !moved(route, given).is_empty()
}

/// What the walk `trace` that taught `route` answered the ask with: the walk's own call of the route
/// (`its_call`), read as the route reads its answer (`as_the_route_reads`) for the values asked (`given`). The first
/// reply of a learn is this answer, the browser's for this value; the route's own first call confirms it behind the
/// reply. None where the walk made no answered call of the route.
pub fn walks_answer(route: &Route, trace: &Trace, given: &HashMap<String, String>) -> Option<serde_json::Value> {
    let j = its_call(route, trace)?;
    as_the_route_reads(route, &trace.exchanges[j], &asked_of(route, given))
}

/// The call of `trace` that is `route`'s target, answered: the last request the step would send, with a 2xx reply.
fn its_call(route: &Route, trace: &Trace) -> Option<usize> {
    its_calls(route, trace).first().copied()
}

/// Every answered request of `trace` that is `route`'s call, the route's own first: a page that loads twice (a check
/// that reloads it) made the call twice, and one that reads on as it scrolls made it once a page. The route's own is
/// the one that sends what the route sends where the caller gives nothing and nothing it leaves out: the fewest query
/// keys the route leaves empty (`leaves_out`: a page's fetch of its own next page or of its own link's data sends one
/// more key, and answers other records), then the most of its inputs' own values (the first page, the page's size),
/// then the latest.
fn its_calls(route: &Route, trace: &Trace) -> Vec<usize> {
    let Some(step) = route.graph.steps.last() else { return Vec::new() };
    let left_out = |e: &Exchange| e.url.query_pairs().filter(|(k, _)| leaves_out(step, k)).count();
    let own = |e: &Exchange| {
        step.fields
            .iter()
            .filter(|f| match (&f.loc, &f.class) {
                (unbrowse_learn::slots::Loc::Query(k), unbrowse_learn::graph::Class::Input { default: Some(d), .. }) => e.url.query_pairs().any(|(q, v)| q == k.as_str() && v == d.as_str()),
                _ => false,
            })
            .count()
    };
    let mut calls: Vec<usize> = (0..trace.exchanges.len()).filter(|&i| (200..300).contains(&trace.exchanges[i].status) && same_call(step, &trace.exchanges[i].method, &trace.exchanges[i].url, trace.exchanges[i].request_body.as_deref())).collect();
    calls.sort_by_key(|&i| (left_out(&trace.exchanges[i]), std::cmp::Reverse((own(&trace.exchanges[i]), i))));
    calls
}

/// Whether `step`, called with nothing the caller gives beyond its defaults, sends no value at query key `key`: the key
/// is not in its address and no field of it fills that key, or the field there is an input with no value of its own
/// (an optional one the caller may give: a page number, a filter).
fn leaves_out(step: &unbrowse_learn::Step, key: &str) -> bool {
    let in_address = url::Url::parse(&step.url.replace('{', "%7B").replace('}', "%7D")).is_ok_and(|u| u.query_pairs().any(|(k, _)| k == key));
    let field = step.fields.iter().find(|f| matches!(&f.loc, unbrowse_learn::slots::Loc::Query(k) if k == key));
    match field.map(|f| &f.class) {
        Some(unbrowse_learn::graph::Class::Input { default, .. }) => default.is_none(),
        Some(_) => false,
        None => !in_address,
    }
}

/// What the walk's record `e` of `route`'s call answered, read as the route's call reads its live answer, for a call
/// asked `asked`: a reply only the site's own code unpacks is unpacked first by the route's decoder
/// (`trace::decoded_answer`, as `replay::run` does at call time); then a page is read as the call reads its page
/// (`page::answer_like`), and any other reply as its data or the text it serves as data (`answer::data_of`). So the
/// route's answer and the walk's are compared by what each said: a reply of JSON lines, or one the page's script
/// deciphers, reads as what it holds on both sides, never as nothing on the walk's.
pub(crate) fn as_the_route_reads(route: &Route, e: &Exchange, asked: &[String]) -> Option<serde_json::Value> {
    let mut e = e.clone();
    if let Some(d) = route.body.as_ref().and_then(|b| b.answer.decode.as_ref()) {
        if let Some(text) = unbrowse_learn::trace::decoded_answer(&d.source, e.response_body.as_deref().unwrap_or_default(), &unbrowse_learn::generated::Environment::default()) {
            e.response_body = Some(text);
            e.response_mime = "application/json".into();
            e.response_headers.retain(|(k, _)| !k.eq_ignore_ascii_case("content-type"));
        }
    }
    let last = route.graph.steps.last();
    let like = last.and_then(|s| s.response_shape.as_ref());
    let body = e.response_body.as_deref().unwrap_or_default();
    let content_type = e.response_header("content-type").unwrap_or(&e.response_mime);
    if unbrowse_learn::page::is_markup(content_type, body) && serde_json::from_str::<serde_json::Value>(body).is_err() {
        // A page read for its text keeps its script's shape as a guard, never as the answer to read, as the call does.
        let like = like.filter(|_| !last.is_some_and(|s| s.reads_page));
        let asked: Vec<&str> = asked.iter().map(String::as_str).collect();
        return Some(unbrowse_learn::page::answer_like(body, &e.url, like, &asked).0);
    }
    unbrowse_learn::answer::data_of(&e, like)
}

/// The values a call of `route` with `given` is asked: each input's given value, else the one it was learned on.
fn asked_of(route: &Route, given: &HashMap<String, String>) -> Vec<String> {
    route.inputs.iter().filter_map(|i| given.get(&i.name).or(i.default.as_ref()).cloned()).collect()
}

/// What the route's answer to the new value (`answer`, or why its call failed) says beside the browser's walk for it
/// (`second`), and the first walk (`first`, where it is still in hand). Nothing here asks the site: both walks and the
/// one answer are read. The same answer is all of:
/// - the walk made the route's call (`graph::the_same_call_there` from the first walk's call, or the route's own
///   call where the first walk is gone), and it answered, read as the route's call reads its answer
///   (`as_the_route_reads`);
/// - the route's answer and the walk's answer to that call each hold no record the other lacks, a line or two by a
///   clock or an id aside (`nothing_of_its_own`, both ways). Where the call is the page, the page is read as shown;
/// - the walks' two calls do not leave two writings of the caller's value standing that write the new value alike
///   (`two_writings_fit`): where they do, the answer cannot tell, and the verdict says so (`CannotTell`);
/// - both answers hold records (`found_nothing`): two answers that found nothing agree on nothing, and the verdict
///   cannot tell (`CannotTell`);
/// - the route's answer says the new value back on two lines or more, and is not the first walk's answer;
/// - the two walks do not show the call deaf (`experiment::told`).
pub fn compared(first: Option<&Trace>, route: &Route, answer: Result<&serde_json::Value, &str>, second: &Trace, given: &HashMap<String, String>) -> Confirmed {
    let differed = |why: &str| Confirmed::Differed { why: why.to_string() };
    let answer = match answer {
        Ok(answer) => answer,
        Err(why) => return Confirmed::Failed { why: why.to_string() },
    };
    let moved = moved(route, given);
    let was: Vec<String> = moved.iter().map(|(_, was, _)| was.to_string()).collect();
    let now: Vec<String> = moved.iter().map(|(_, _, now)| now.to_string()).collect();
    if now.is_empty() {
        return differed("the ask gives no value other than the one the route was learned on");
    }
    // The first walk's call, where the first walk is still in hand and made it.
    let there = first.and_then(|a| its_call(route, a).map(|i| (a, i)));
    let Some(j) = walks_call(first, route, second, given) else {
        return differed("the browser's walk for the new value made no such call");
    };
    let Some(walked) = as_the_route_reads(route, &second.exchanges[j], &asked_of(route, given)).map(|v| as_records(&v)) else {
        return differed("the walk's own answer to the call reads as nothing");
    };
    let answer = &as_records(answer);
    let (theirs, ours) = (said_lines(&walked, &[]), said_lines(answer, &[]));
    // The first walk's answer to the call, as the route reads it: what a page for the new value is held beside, its
    // links that both carry being the page's frame (`answer::lists_nothing_beside`).
    let old_read = there.and_then(|(a, i)| as_the_route_reads(route, &a.exchanges[i], &asked_of(route, &HashMap::new())));
    // Where the route has no records place yet (one sighting) and the first walk's answer held records naming its
    // value, an answer in which no list names the value asked nor that one, and which is no single record saying either
    // back (`records_place` finds none), holds no records where the first walk had them: it found nothing. One that
    // names the old value answers another value, and one alike on both walks naming neither answers something else:
    // each is judged as such below.
    let first_had_records = old_read.as_ref().is_some_and(|v| records_place(v, &was).is_some());
    let telling = telling_words(&now, &was);
    let for_the_value = |read: &serde_json::Value| route.heard.records_at.is_none() && first_had_records && records_place(read, &telling).is_none() && records_place(read, &was).is_none();
    let nothing = |read: &serde_json::Value| found_nothing(&second.exchanges[j], read, &now, old_read.as_ref()) || nothing_at_its_records(route, read) || for_the_value(read);
    if ours.is_empty() {
        // Nothing found on both sides (empty lists, no line of its own) is no difference: it confirms nothing.
        if nothing(answer) && nothing(&walked) {
            return Confirmed::CannotTell { why: NO_RECORDS.into() };
        }
        return differed("the route's answer says nothing");
    }
    if !(the_same_records(&ours, &theirs) && the_same_records(&theirs, &ours)) {
        return differed("the route's answer and the browser's hold different records");
    }
    // The two agree on nothing found: an empty list says the new value back as readily as any call that carries it,
    // and the route that answers it may be another call than the one that lists the records.
    if nothing(&walked) || nothing(answer) {
        return Confirmed::CannotTell { why: NO_RECORDS.into() };
    }
    // Two writings of the caller's value fit both walks and write the new one alike: the route sent what the browser's
    // page sent, whichever writing it holds, and its answer settles nothing about a value they part on.
    if let Some((a, i)) = there {
        if let Some(why) = two_writings_fit(&a.exchanges[i], &second.exchanges[j], &moved) {
            return Confirmed::CannotTell { why };
        }
    }
    // Said back: the lines of the route's answer that name a new value, for the value said most; or, for a value a
    // search reads word by word, its records saying the words that tell it from the old one (`says_back_by_records`).
    let said_back = now.iter().map(|v| v.to_lowercase()).map(|v| ours.iter().filter(|l| l.contains(&v)).count()).max().unwrap_or(0);
    if said_back < 2 && !says_back_by_records(answer, &walked, &telling) {
        return differed("the route's answer never says the new value back");
    }
    if let Some((a, i)) = there {
        // Held against the first walk's answer both ways: the same answer twice is the first walk's; an answer that
        // has nothing of its own beside one that has records of its own is that answer's frame (a page's menus, the
        // same whatever was asked) without them, and found nothing.
        if let Some(old) = as_the_route_reads(route, &a.exchanges[i], &asked_of(route, &HashMap::new())).map(|v| said_lines(&v, &[])) {
            if !old.is_empty() && nothing_of_its_own(&ours, &old) {
                if !nothing_of_its_own(&old, &ours) {
                    return Confirmed::CannotTell { why: NO_RECORDS.into() };
                }
                return differed("the route answers what the first walk was answered, not the new value");
            }
        }
        // Deaf is the two walks answering the call alike each beside the other. A first walk whose answer has nothing
        // of its own beside the new one found nothing there, and says nothing of whether the call hears its caller.
        let deaf = experiment::told(a, i, &was, second, &now) == experiment::Told::Deaf;
        if deaf && experiment::told(second, j, &now, a, &was) == experiment::Told::Deaf {
            return differed("the two walks answered the call the same: it does not hear its caller");
        }
    }
    Confirmed::Agreed
}

/// Whether `route`'s own call for a new value (`given`), answered `answer` whole, stands as the value's answer by the
/// readers a confirming browse holds it to, with no page loaded: the call the agent asked for is the route's second
/// sighting (`api::goal`, calls first). Ok, with where its records are (`records_place`, None for no list of them) and
/// the value it said back:
/// - it lists something (`answer::lists_nothing_beside`, the one reader of an empty answer);
/// - it is not the first sighting's answer again (`sighted::first_answer`: what it says, its values by mark, of which
///   no more than a tenth its own, `says_what_it_said`): a call deaf to its caller answers every value with the first
///   one's records;
/// - it says the value back by its records (`says_back_by_records`'s reading: at one place, half of them or more, held
///   to the route's records place where it is known), never by the page's lines, which say the value back whatever
///   was found; a value in a search syntax by its terms. A value that names a thing (a piece of the
///   route's address, or an id or a date, one token with a digit in it; or any value of a route whose first answer
///   never said its own) is said back by an item's own record once, or not at all; such an answer
///   stands where its lines are not the first sighting's (it must differ where the value differs), and only then.
///
/// Err, why it is in doubt: the browser serves the value, and its walk is compared (`confirm_by_use`).
pub fn by_its_call(route: &Route, given: &HashMap<String, String>, answer: &serde_json::Value) -> Result<(Option<String>, String), String> {
    let moved = moved(route, given);
    let was: Vec<String> = moved.iter().map(|(_, was, _)| was.to_string()).collect();
    let now: Vec<String> = moved.iter().map(|(_, _, now)| now.to_string()).collect();
    if now.is_empty() {
        return Err("the ask gives no value other than the one the route was learned on".into());
    }
    let read = as_records(answer);
    let asked = asked_of(route, given);
    let asked: Vec<&str> = asked.iter().map(String::as_str).collect();
    if unbrowse_learn::answer::lists_nothing_beside(&read, &asked, None) || nothing_at_its_records(route, &read) {
        return Err("its answer lists nothing for the value".into());
    }
    let ours = said_lines(&read, &[]);
    if ours.is_empty() {
        return Err("its answer says nothing".into());
    }
    let telling = telling_words(&now, &was);
    let place = records_place(&read, &telling);
    let set = |v: &[String]| v.iter().cloned().collect::<std::collections::BTreeSet<String>>();
    let kept = super::sighted::first_answer(route);
    let first_rows = kept.as_ref().map(|h| set(&h.rows)).unwrap_or_default();
    // Said back by the records, never by the page's lines: a results page says the value back in its heading, its
    // crumb, its box and its share link whatever it found, its records empty (the incident this was built against).
    // Half the records name it, or half of those that are its own: a page read whole holds its results among the
    // links of its frame, which the first value's page held too (`own_naming_at`).
    let by_records = place.as_deref().filter(|p| *p != WHOLE && route.heard.records_at.as_deref().is_none_or(|seen| seen == *p)).is_some_and(|p| {
        let (naming, all) = naming_at(&read, p, &telling);
        let (own_naming, own) = own_naming_at(&read, p, &telling, &first_rows);
        (naming >= 2 && naming * 2 >= all) || (own_naming >= 2 && own_naming * 2 >= own)
    });
    let (said, lines) = (set(&super::sighted::said_of(&read)), set(&super::sighted::marks_of(&read)));
    let first = kept.as_ref().map(|h| (set(&h.said), set(&h.marks)));
    // The first answer again says what it said in both: its values (a statement's figures differ for another company)
    // and its lines (a narrower query's one item, beside the first's list), each no more than a tenth its own. Records
    // that say the new value back, at the records' place, are not the first value's: a page's state says its menus,
    // its footer and its translations again for every value, thousands of values beside twenty records, and a search
    // for another word read as the first word's answer again though every one of its records named the new word.
    if !by_records && first.as_ref().is_some_and(|(values, words)| !said.is_empty() && says_what_it_said(&said, values) && (words.is_empty() || says_what_it_said(&lines, words))) {
        return Err("its answer is the first value's records again".into());
    }
    // A value written in the site's search syntax (`repo:owner/name`) is said back by its terms, as the answer writes
    // them (`ethereum/go-ethereum` its full name, in its address): never the expression whole.
    let by_terms = now.iter().all(|v| terms_of(v).is_some_and(|terms| terms.iter().all(|t| ours.iter().filter(|l| l.contains(t.as_str())).count() >= 2)));
    let said = now[0].clone();
    if by_records || by_terms {
        return Ok((place, said));
    }
    // A route whose first answer never said its own value answers about a thing without naming it (a company's
    // statement: figures, no name), as one written into its address or holding a digit names one.
    let unnamed = kept.as_ref().is_some_and(|h| h.named == Some(false));
    if unnamed {
        // Such a route stands only by its records: those at the answer's own records place (`sighted::rows_of`), each
        // with a field every record repeats and the clock left out, more than a tenth of them not the first answer's.
        // Whatever a frame changes on each load (a token, a time, a strip that rotates one promotion) lives outside
        // the records or in fields they all repeat, and never counts. No records place, no standing.
        let rows: Vec<String> = super::sighted::rows_of(&read).unwrap_or_default();
        if first_rows.is_empty() || rows.is_empty() {
            return Err("its answer names no value, and holds no records to tell it from the first one's by".into());
        }
        let own = rows.iter().filter(|r| !first_rows.contains(*r)).count();
        if own * 10 <= rows.len() {
            return Err("its records are the first value's again".into());
        }
        return Ok((place.or_else(|| records_place(&read, &now)), now[0].clone()));
    }
    // A value of one token names a thing when it holds a digit (an id, a date) or the route writes it into its address;
    // words beside a number (`apollo 13`) are a search's, said back by its records.
    let names_a_thing = moved.iter().all(|(name, _, now)| !now.trim().contains(char::is_whitespace) && (now.chars().any(|c| c.is_ascii_digit()) || in_the_address(route, name)));
    if names_a_thing && first.is_some() {
        return Ok((place.or_else(|| records_place(&read, &now)), said));
    }
    Err(match (names_a_thing, first.is_some()) {
        (true, false) => "its answer names the thing asked once, and no first sighting's answer is kept to tell it from".into(),
        _ => "its answer never says the new value back".into(),
    })
}

/// Whether `now`, what a call's answer says (`sighted::said_of`, its values by mark), is what the first sighting's
/// answer said (`first`): no more than a tenth of what it says is its own. A share of what the answer says, never a
/// count: an answer of a few values (a statement's figures, a package's counts by day) that differs in one is another
/// answer; a page of records replayed as it was walked, sharing 255 of 256, is the same. Nothing said is no difference.
fn says_what_it_said(now: &std::collections::BTreeSet<String>, first: &std::collections::BTreeSet<String>) -> bool {
    now.difference(first).count() * 10 <= now.len()
}

/// The terms of a value written in a search syntax: each of its words that names a field (`repo:`, `user:`, a key of
/// letters before a colon) by what follows the colon, the rest as they are, lowercased. None for a value with no such
/// word: it is read by its words (`telling_words`).
fn terms_of(value: &str) -> Option<Vec<String>> {
    let words: Vec<&str> = value.split_whitespace().collect();
    fn keyed(w: &str) -> Option<(&str, &str)> {
        w.split_once(':').filter(|(k, v)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphabetic()) && !v.is_empty())
    }
    words.iter().any(|w| keyed(w).is_some()).then(|| words.iter().map(|w| keyed(w).map_or(*w, |(_, v)| v).to_lowercase()).collect())
}

/// Whether `route` writes its input `name` into a piece of its address's path: such a value names a thing (a package, a
/// repository, an invite), not a search's words.
fn in_the_address(route: &Route, name: &str) -> bool {
    route.graph.steps.iter().flat_map(|s| &s.fields).any(|f| matches!((&f.loc, &f.class), (unbrowse_learn::slots::Loc::Path(_), unbrowse_learn::graph::Class::Input { name: n, .. }) if n == name))
}

/// The words that tell the new values (`now`) from the ones a route was learned on (`was`): each new value whole, and
/// each word of it (three letters or more) that no old value says. A search that reads a value word by word answers
/// with records saying some of its words, seldom the whole of it ("zig" for "zig compiler"); a word both values share
/// ("hotels" in "osaka hotels" and "tokyo hotels") tells nothing, and a page's frame says it whatever was asked.
pub(crate) fn telling_words(now: &[String], was: &[String]) -> Vec<String> {
    let words = |v: &str| v.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(String::from).collect::<Vec<_>>();
    let old: Vec<String> = was.iter().flat_map(|v| words(v)).collect();
    let mut out: Vec<String> = now.iter().map(|v| v.to_lowercase()).collect();
    for w in now.iter().flat_map(|v| words(v)) {
        if !old.contains(&w) && !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

/// Whether `answer`, the route's, says the new value back by its records: the list of records that names a telling
/// word (`telling_words`) most is at the same place in the browser's answer (`walked`), and half its records or more,
/// two at least, name one. Held to the records, never to the page's lines: a frame's title or menu naming a word once
/// or twice is no list of records naming it.
fn says_back_by_records(answer: &serde_json::Value, walked: &serde_json::Value, telling: &[String]) -> bool {
    let Some(place) = records_place(answer, telling).filter(|p| p != WHOLE) else { return false };
    if records_place(walked, telling).as_deref() != Some(place.as_str()) {
        return false;
    }
    let (naming, all) = naming_at(answer, &place, telling);
    naming >= 2 && naming * 2 >= all
}

/// How many records `data` holds at `place` (`records_place`'s) that name one of `words`, and how many it holds.
fn naming_at(data: &serde_json::Value, place: &str, words: &[String]) -> (usize, usize) {
    let data = &as_records(data);
    let items = items_at(data, place);
    let naming = items.iter().filter(|x| names_one(x, words)).count();
    (naming, items.len())
}

/// The items of every list `data` holds at `place` (`records_place`'s), down the keys by name.
fn items_at<'a>(data: &'a serde_json::Value, place: &str) -> Vec<&'a serde_json::Value> {
    fn there<'a>(v: &'a serde_json::Value, path: &[&str], out: &mut Vec<&'a serde_json::Value>) {
        match (path.split_first(), v) {
            (None, serde_json::Value::Array(a)) => out.extend(a.iter()),
            (Some((&"[]", rest)), serde_json::Value::Array(a)) => a.iter().for_each(|x| there(x, rest, out)),
            (Some((name, rest)), serde_json::Value::Object(o)) => o.iter().filter(|(k, _)| key_name(k) == *name).for_each(|(_, x)| there(x, rest, out)),
            _ => {}
        }
    }
    let mut items = Vec::new();
    let path: Vec<&str> = if place.is_empty() { Vec::new() } else { place.split('/').collect() };
    there(data, &path, &mut items);
    items
}

/// Whether `x` is a record that names one of `words`.
fn names_one(x: &serde_json::Value, words: &[String]) -> bool {
    x.is_object() && words.iter().any(|w| x.to_string().to_lowercase().contains(w.as_str()))
}

/// [`naming_at`] over the records of `data` at `place` that the first answer did not hold (`first`, its records by
/// mark, `sighted::rows_of`): how many of them name one of `words`, and how many there are. A record both answers hold
/// is the page's frame (its menus, its footer, its links to the rest of the site), the same whatever was asked: a page
/// read whole keeps its own results among a hundred such links, and only the records that are not the first answer's
/// are this value's.
fn own_naming_at(data: &serde_json::Value, place: &str, words: &[String], first: &std::collections::BTreeSet<String>) -> (usize, usize) {
    let data = &as_records(data);
    let items: Vec<&serde_json::Value> = items_at(data, place).into_iter().filter(|x| x.is_object()).collect();
    let records: Vec<&serde_json::Map<String, serde_json::Value>> = items.iter().filter_map(|x| x.as_object()).collect();
    let marks = super::sighted::row_marks(&records);
    let own: Vec<&serde_json::Value> = items.into_iter().zip(&marks).filter(|(_, m)| !first.contains(*m)).map(|(x, _)| x).collect();
    (own.iter().filter(|x| names_one(x, words)).count(), own.len())
}

/// An answer as its records, for comparing: text a site serves as markup data (a feed, an XML list, often one line) is
/// read as its repeated elements (`answer::markup_records`), so its items are lines that say the value back and records
/// two answers share; any other answer as it is.
pub(crate) fn as_records(v: &serde_json::Value) -> serde_json::Value {
    let text = v.as_object().filter(|o| o.len() == 2 && o.contains_key("content_type")).and_then(|o| o.get("text")).and_then(serde_json::Value::as_str);
    text.and_then(unbrowse_learn::answer::markup_records).unwrap_or_else(|| v.clone())
}

/// A key by its name: the part before anything a site writes into it (`search({"input":…})` is `search`), so the
/// place of an answer's records reads the same whatever value the answer is for.
fn key_name(k: &str) -> &str {
    k.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '-')).next().unwrap_or(k)
}

/// Where `v`, an answer for `words`, holds its records: the list of objects that names a word on the most of its
/// objects (two at least), said as its keys by name (`key_name`) joined by `/`, `[]` for a list on the way. None where
/// no list of objects names a word twice: an answer with no records of its own has no place to keep.
pub(crate) fn records_place(v: &serde_json::Value, words: &[String]) -> Option<String> {
    let v = &as_records(v);
    let words: Vec<String> = words.iter().map(|w| w.to_lowercase()).filter(|w| w.chars().count() >= 2).collect();
    let mut best: Option<(usize, String)> = None;
    fn walk(v: &serde_json::Value, at: &mut Vec<String>, words: &[String], best: &mut Option<(usize, String)>) {
        match v {
            serde_json::Value::Array(a) => {
                let naming = a.iter().filter(|x| x.is_object() && words.iter().any(|w| x.to_string().to_lowercase().contains(w.as_str()))).count();
                if naming >= 2 && best.as_ref().is_none_or(|(n, _)| naming > *n) {
                    *best = Some((naming, at.join("/")));
                }
                at.push("[]".into());
                for x in a {
                    walk(x, at, words, best);
                }
                at.pop();
            }
            serde_json::Value::Object(o) => {
                for (k, x) in o {
                    at.push(key_name(k).to_string());
                    walk(x, at, words, best);
                    at.pop();
                }
            }
            _ => {}
        }
    }
    walk(v, &mut Vec::new(), &words, &mut best);
    // An answer that is one record (an item's own details: two values of its own or more) and says the value back is
    // its own record: the whole. A title alone is the page's, not a record.
    let fields = v.as_object().map_or(0, |o| o.values().filter(|x| x.is_string() || x.is_number() || x.is_boolean()).count());
    let whole = || (fields >= 2 && words.iter().any(|w| said_lines(v, &[]).iter().any(|l| l.contains(w.as_str())))).then(|| WHOLE.to_string());
    best.map(|(_, place)| place).or_else(whole)
}

/// The records place of an answer that is one record ([`records_place`]): the answer whole.
const WHOLE: &str = ".";

/// How many items `data` holds at `place` (`records_place`'s): the items of every list there, or 1 for an answer that
/// is one record ([`WHOLE`]) with something in it. None where the place is not there.
pub(crate) fn count_at(data: &serde_json::Value, place: &str) -> Option<usize> {
    let data = &as_records(data);
    if place == WHOLE {
        return Some(usize::from(at_place(data, place) == Some(true)));
    }
    fn there(v: &serde_json::Value, path: &[&str]) -> Option<usize> {
        match (path.split_first(), v) {
            (None, serde_json::Value::Array(a)) => Some(a.len()),
            (None, _) => None,
            (Some((&"[]", rest)), serde_json::Value::Array(a)) => a.iter().filter_map(|x| there(x, rest)).reduce(|a, b| a + b),
            (Some((name, rest)), serde_json::Value::Object(o)) => o.iter().filter(|(k, _)| key_name(k) == *name).filter_map(|(_, x)| there(x, rest)).reduce(|a, b| a + b),
            _ => None,
        }
    }
    let path: Vec<&str> = if place.is_empty() { Vec::new() } else { place.split('/').collect() };
    there(data, &path)
}

/// How many lines of its own an answer says, as two answers are compared (`said_lines`).
pub(crate) fn lines_of(data: &serde_json::Value) -> usize {
    lines_said(data).len()
}

/// The lines of its own an answer says, read as its records ([`as_records`]), as two answers are compared.
pub(crate) fn lines_said(data: &serde_json::Value) -> std::collections::BTreeSet<String> {
    said_lines(&as_records(data), &[])
}

/// What `compared` held: the walk's request it chose for the route's call, why (the keys it sends that the route leaves
/// empty), and how many lines each answer said and both did. For the route's sightings (`sighted`).
fn comparison(first: Option<&Trace>, route: &Route, answer: Option<&serde_json::Value>, second: &Trace, given: &HashMap<String, String>, verdict: &Confirmed) -> (Option<usize>, Option<serde_json::Value>, super::sighted::Compared) {
    let j = walks_call(first, route, second, given);
    let walked = j.and_then(|j| as_the_route_reads(route, &second.exchanges[j], &asked_of(route, given))).map(|v| as_records(&v));
    let step = route.graph.steps.last();
    let left_out = j.zip(step).map_or(0, |(j, step)| second.exchanges[j].url.query_pairs().filter(|(k, _)| leaves_out(step, k)).count());
    let (theirs, ours) = (walked.as_ref().map(|w| said_lines(w, &[])).unwrap_or_default(), answer.map(|a| said_lines(&as_records(a), &[])).unwrap_or_default());
    let compared = super::sighted::Compared { call: j, calls: its_calls(route, second).len(), left_out, ours: ours.len(), theirs: theirs.len(), shared: ours.intersection(&theirs).count(), verdict: verdict.said() };
    (j, walked, compared)
}

/// Whether `data` holds anything at `place` (`records_place`'s): a list there with an item, or for [`WHOLE`] an
/// answer with something in it. `Some(false)`: the place is there and empty; None: it is not there.
fn at_place(data: &serde_json::Value, place: &str) -> Option<bool> {
    let data = &as_records(data);
    if place == WHOLE {
        return Some(data.as_object().is_some_and(|o| !o.is_empty()) || data.as_array().is_some_and(|a| !a.is_empty()));
    }
    fn there(v: &serde_json::Value, path: &[&str]) -> Option<bool> {
        match (path.split_first(), v) {
            (None, serde_json::Value::Array(a)) => Some(!a.is_empty()),
            (None, _) => None,
            (Some((&"[]", rest)), serde_json::Value::Array(a)) => a.iter().filter_map(|x| there(x, rest)).reduce(|a, b| a || b),
            (Some((name, rest)), serde_json::Value::Object(o)) => o.iter().filter(|(k, _)| key_name(k) == *name).filter_map(|(_, x)| there(x, rest)).reduce(|a, b| a || b),
            _ => None,
        }
    }
    let path: Vec<&str> = if place.is_empty() { Vec::new() } else { place.split('/').collect() };
    there(data, &path)
}

/// Whether `data`, an answer of `route`, lacks the place its records were seen at (`Heard::records_at`): no list there,
/// down the keys by name. An empty list there is the site saying it found nothing, and is an answer; an answer without
/// the place (the page's title, its chrome, the session's earlier searches) holds no records for the value asked.
pub(crate) fn lacks_its_records(route: &Route, data: &serde_json::Value) -> bool {
    let Some(place) = route.heard.records_at.as_deref() else { return false };
    at_place(data, place).is_none()
}

/// Whether `data`, an answer of `route`, holds nothing where the route's records were seen (`Heard::records_at`): the
/// place is missing ([`lacks_its_records`]) or every list there is empty. Whatever else it holds (the page's copy, its
/// filters, its title naming the value) is no record: such an answer found nothing for the value, and confirms
/// nothing. False for a route with no place seen.
pub(crate) fn nothing_at_its_records(route: &Route, data: &serde_json::Value) -> bool {
    let Some(place) = route.heard.records_at.as_deref() else { return false };
    at_place(data, place) != Some(true)
}

/// Whether `was`, one answer to an ask, holds the records `now`, another answer to the same ask, holds: at most a
/// tenth of its lines are its own. A site ranks a page of results afresh for each ask, so two asks of one word may
/// fill the page's last places with other records; an answer for another word, or another call's, shares little
/// beyond the page's frame. (Two walks of the page asked two words are held apart by `nothing_of_its_own`.)
fn the_same_records(was: &std::collections::BTreeSet<String>, now: &std::collections::BTreeSet<String>) -> bool {
    was.len() - was.intersection(now).count() <= (was.len() / 10).max(2)
}

/// The browser's walk's (`second`) call of `route` for the new value (`given`), answered: the first walk's call made
/// again there (`graph::the_same_call_there`), or the route's own call where the first walk is gone. Where the first
/// walk made the call more than once (a page a check reloaded), it was made again if any of those was, the route's own
/// first (`its_calls`): one load on the new walk pairs with only one of them.
fn walks_call(first: Option<&Trace>, route: &Route, second: &Trace, given: &HashMap<String, String>) -> Option<usize> {
    let moved = moved(route, given);
    let was: Vec<String> = moved.iter().map(|(_, was, _)| was.to_string()).collect();
    let one_moved = (moved.len() == 1).then(|| moved[0].2);
    let found = match first.filter(|a| its_call(route, a).is_some()) {
        Some(a) => its_calls(route, a).into_iter().find_map(|i| unbrowse_learn::graph::the_same_call_there(a, i, second, &was, one_moved)),
        None => its_call(route, second),
    };
    found.filter(|&j| (200..300).contains(&second.exchanges[j].status))
}

/// What a confirming browse would say of `route`, learned from the walk `first`, where the browser's walk for the new
/// value (`given`) is `second`, read offline: the route's call answered as `second` recorded it (a recording answers
/// only what the walk asked: a call it does not hold is one the walk made no such call of). For the corpus.
#[cfg(test)]
pub(crate) fn as_a_kept_walk_says(first: &Trace, route: &Route, second: &Trace, given: &HashMap<String, String>) -> Confirmed {
    let answer = walks_call(Some(first), route, second, given).and_then(|j| as_the_route_reads(route, &second.exchanges[j], &asked_of(route, given)));
    match answer {
        Some(a) => compared(Some(first), route, Ok(&a), second, given),
        None => compared(Some(first), route, Err("the recording holds no such call"), second, given),
    }
}

/// Whether the browser's walk for the new value (`second`) found nothing: it made `route`'s call (`walks_call`), and
/// that call answered with no records (`found_nothing`), read as the route reads it. Such a sighting says what a call
/// answers when there is nothing to find; it cannot say which call lists what there is. A call whose answer held no
/// records on any of the first walk's makings of it (a frame of counts) answers so whatever is found: its empty answer says nothing of the
/// walk, and the sighting is not one that found nothing.
fn sighting_found_nothing(first: Option<&Trace>, route: &Route, second: &Trace, given: &HashMap<String, String>) -> bool {
    let learned_on = asked_of(route, &HashMap::new());
    let held = |a: &Trace, i: usize| as_the_route_reads(route, &a.exchanges[i], &learned_on).is_some_and(|read| !found_nothing(&a.exchanges[i], &read, &learned_on, None));
    let held_none = first.is_some_and(|a| !its_calls(route, a).is_empty() && !its_calls(route, a).into_iter().any(|i| held(a, i)));
    // The first walk's answer that held records, for a page of the new value to be held beside.
    let beside = first.and_then(|a| its_calls(route, a).into_iter().find(|&i| held(a, i)).and_then(|i| as_the_route_reads(route, &a.exchanges[i], &learned_on)));
    let asked = asked_of(route, given);
    !held_none
        && walks_call(first, route, second, given).is_some_and(|j| as_the_route_reads(route, &second.exchanges[j], &asked).is_some_and(|read| found_nothing(&second.exchanges[j], &read, &asked, beside.as_ref()) || nothing_at_its_records(route, &read)))
}

/// Why an answer that found nothing leaves the route unconfirmed.
const NO_RECORDS: &str = "an answer with no records confirms nothing";

/// Whether `read`, what the walk's call `e` (or the route's call beside it) answered for `asked`, found nothing: it
/// lists nothing (`answer::lists_nothing_beside`, the one reader of an empty answer, the agent's `answered_empty`
/// too), a page beside the same page for another value (`beside`) included; or, read as data, it holds no list of
/// records (`learn::holds_records`: an empty list, a frame of counts), which confirms nothing either. Text a site
/// serves as data (`answer::text_answer`: its type and its text) is read for its text and says what it found as text
/// does: it is not judged here.
fn found_nothing(e: &Exchange, read: &serde_json::Value, asked: &[String], beside: Option<&serde_json::Value>) -> bool {
    let asked: Vec<&str> = asked.iter().map(String::as_str).collect();
    if unbrowse_learn::answer::lists_nothing_beside(read, &asked, beside) {
        return true;
    }
    let body = e.response_body.as_deref().unwrap_or_default();
    let markup = unbrowse_learn::page::is_markup(e.response_header("content-type").unwrap_or(&e.response_mime), body) && serde_json::from_str::<serde_json::Value>(body).is_err();
    let text = read.as_object().is_some_and(|o| o.len() == 2 && o.get("text").is_some_and(serde_json::Value::is_string) && o.get("content_type").is_some_and(serde_json::Value::is_string));
    !markup && !text && !crate::learn::holds_records(read)
}

/// Where the first walk's call of the route (`was_call`) and the browser's walk's (`now_call`) send a moved value
/// (`moved`, each input's name, the value it was learned on and the new one) at the same place, and more than one
/// writing of it rebuilds both (`lab::forms::writings_left`): why the walks cannot tell those writings apart, by the
/// input's name and the place, never a value. A writing both walks bear out alone says nothing here.
fn two_writings_fit(was_call: &Exchange, now_call: &Exchange, moved: &[(&str, &str, &str)]) -> Option<String> {
    let there = unbrowse_learn::slots::slots(now_call);
    for slot in unbrowse_learn::slots::slots(was_call) {
        let Some(again) = there.iter().find(|s| s.loc == slot.loc) else { continue };
        for &(name, was, now) in moved {
            if unbrowse_learn::lab::forms::writings_left(name, &[(was, slot.value.as_str()), (now, again.value.as_str())]).is_some() {
                return Some(format!("two writings of {name} fit both walks at {}, and they write the new value alike: a value they part on settles it", slot.loc));
            }
        }
    }
    None
}

/// The first walk of `url`'s page in hand that made `route`'s call: the newest other walk of the page
/// (`history_of`), beside the walk `second`.
fn first_walk(walks: &Walks, second: &str, url: &str, route: &Route) -> Option<Trace> {
    let guard = walks.0.locked();
    history_of(&guard, second, url).into_iter().map(|(t, _)| t).find(|t| its_call(route, t).is_some())
}

/// Serves `route`'s first ask for a new value (`given`, on the page `url`) by the browser: the page is walked for it
/// through the learn an ask takes, with the same `walks`, so the walk is paired with the first as its second sighting
/// and the route that stands is built from both; the route is called once for the new value beside it, and its answer
/// held against the walk's (`compared`). Agreed, the route that stands is confirmed: no longer provisional, its
/// `heard` saying the new value back. Otherwise it stands unconfirmed. Said on the node's log as
/// `   [confirm] <route id>: agreed|differed: <why>|failed: <why>`. The reply to the ask is the browser's own answer for
/// the new value (`Confirmation::answer`, `the_browsers_answer`): what the walk's call answered, never `route`'s answer
/// nor a call of whatever route stands. Err: the walk learned nothing.
pub fn confirm_by_use(walks: &Walks, url: &str, goal: &str, who: &str, route: &Route, given: &HashMap<String, String>, node: Option<&crate::Node>) -> Result<Confirmation, Unlearned> {
    let first = route.clone();
    let (standing, _, walk) = match learn_goal_walked(walks, url, goal, who, &|_| {}, node) {
        Ok(learned) => learned,
        Err(e) => {
            eprintln!("   [confirm] {}: failed: the browser's walk for the new value learned nothing: {e}", first.id);
            return Err(e);
        }
    };
    let second = walks.0.locked().get(&walk).map(|w| w.trace.clone()).ok_or(Unlearned::Loading)?;
    let earlier = first_walk(walks, &walk, url, &first);
    // The one call beside the walk: the route as it was first learned, for the new value, answered as it stands.
    let filled = crate::vault::Filled { values: given.clone(), secrets: Vec::new(), held: Vec::new() };
    let sent_before = unbrowse_learn::http::sent_so_far();
    let called = not_learning_again(|| crate::run::call_watched(first.clone(), &filled, who, None, &["*".to_string()], None));
    let sent_beside = unbrowse_learn::http::sent_so_far().saturating_sub(sent_before);
    let answer: Result<serde_json::Value, String> = match called {
        Ok(c) if c.ok => the_whole(c.data, c.truncated.as_ref()).ok_or_else(|| "the route's call answered nothing".to_string()),
        Ok(c) => Err(c.error.unwrap_or_else(|| "the route's call failed".into())),
        Err(e) => Err(e),
    };
    let verdict = compared(earlier.as_ref(), &first, answer.as_ref().map_err(String::as_str), &second, given);
    eprintln!("   [confirm] {}: {}", first.id, verdict.said());
    let (call, walked, held) = comparison(earlier.as_ref(), &first, answer.as_ref().ok(), &second, given, &verdict);
    super::sighted::confirmed(&first, given, &second, call, walked.as_ref(), answer.as_ref().ok(), held);
    let nothing = sighting_found_nothing(earlier.as_ref(), &first, &second, given);
    let browsers = the_browsers_answer(earlier.as_ref(), &first, &standing, &second, given);
    let word = moved(&first, given).first().map(|(_, _, now)| now.to_string());
    // Where the records are is read by the words that tell the value from the one the route was learned on: a search
    // that reads it word by word lists records saying some of its words.
    let telling = telling_words(&word.iter().cloned().collect::<Vec<_>>(), &moved(&first, given).iter().map(|(_, was, _)| was.to_string()).collect::<Vec<_>>());
    let place = (!nothing).then(|| browsers.as_ref().and_then(|v| records_place(v, &telling))).flatten();
    let saw_records = place.is_some();
    let standing = if may_stand_in(&verdict, saw_records, &first, &standing) || (standing.id == first.id && verdict == Confirmed::Agreed && saw_records) {
        match &verdict {
            Confirmed::Agreed => {
                let confirmed = store::update_route(&standing.id, |r| {
                    r.provisional = false;
                    r.heard.said_back = word.clone();
                    r.heard.records_at = place.clone();
                })
                .ok()
                .flatten()
                .unwrap_or(standing);
                agreed_in_place(&first, &confirmed);
                confirmed
            }
            _ => {
                gives_way(&first, &standing);
                store::load_route(&standing.id).unwrap_or(standing)
            }
        }
    } else if !saw_records && standing.id != first.id {
        // The walk for the value saw no records (it found nothing, or what it learned answers with none): what it
        // learned stands in for nothing.
        first_stands(&first, &standing)
    } else {
        store::load_route(&standing.id).unwrap_or(standing)
    };
    Ok(Confirmation { verdict, standing, sent_beside, answer: browsers })
}

/// The whole answer of a call whose reply carried `data`: a reply cut to the budget a reply carries
/// (`run::REPLY_BUDGET`) keeps only the first records of each list, and held against the browser's whole answer it
/// would hold fewer records than the walk's; the whole is read from where the call kept it (`Truncated::whole`). The
/// cut answer where the whole was not kept.
fn the_whole(data: Option<serde_json::Value>, cut: Option<&crate::run::Truncated>) -> Option<serde_json::Value> {
    cut.and_then(|t| t.whole.as_ref()).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).or(data)
}

/// What the browser's walk for the new value (`second`) answered the agent's ask with: the walk's own call of the
/// route learned from it (`learned`), and the walk's call of the route it was compared beside (`first`, `walks_call`),
/// each read as that route reads its answer (`as_the_route_reads`). Of those whose request sends the new value, the
/// one with records for it (`found_nothing` false) answers; where neither holds any, the walk found nothing, and the
/// first that sends the value says so, never a call that does not send it (the page's own settings). Nothing is asked of the site: the browser already got it. None where the walk made neither call.
fn the_browsers_answer(earlier: Option<&Trace>, first: &Route, learned: &Route, second: &Trace, given: &HashMap<String, String>) -> Option<serde_json::Value> {
    let own = its_call(learned, second).and_then(|j| Some((j, as_the_route_reads(learned, &second.exchanges[j], &asked_of(learned, &HashMap::new()))?)));
    let beside = walks_call(earlier, first, second, given).and_then(|j| Some((j, as_the_route_reads(first, &second.exchanges[j], &asked_of(first, given))?)));
    // The call the ask was for held records on its first walk and holds none now: the walk found nothing, and that
    // call's own answer says so, whatever else the walk learned (a page's shell says nothing of the search).
    if let Some((_, v)) = beside.as_ref().filter(|_| sighting_found_nothing(earlier, first, second, given)) {
        return Some(v.clone());
    }
    let read: Vec<(usize, serde_json::Value)> = [own, beside].into_iter().flatten().collect();
    // A call that answers the ask sends the value asked: a call of the page's own (its server's name and settings)
    // that a walk which found nothing learned is no answer to it.
    let now: Vec<String> = moved(first, given).iter().map(|(_, _, now)| now.to_lowercase()).collect();
    let sends = |j: usize| now.is_empty() || unbrowse_learn::slots::slots(&second.exchanges[j]).iter().any(|s| now.iter().any(|v| s.value.to_lowercase().contains(v.as_str())));
    read.iter()
        .find(|(j, v)| sends(*j) && !found_nothing(&second.exchanges[*j], v, &asked_of(learned, given), None))
        .or_else(|| read.iter().find(|(j, _)| sends(*j)))
        .or(read.first())
        .map(|(_, v)| v.clone())
}

/// Where the confirming browse's walk found nothing (`sighting_found_nothing`), the route learned from it beside the
/// first walk (`standing`), another call, does not choose the answer: a sighting of nothing found cannot tell the
/// call that lists records from one that answers alike when there are none (a frame of counts). The route of one
/// sighting (`first`) stands, unconfirmed and in its place, and `standing`, learned from two sightings one of which
/// found nothing, is not kept beside it, however many sightings either was learned from: it is retired for `first`
/// (`store::retire_route_for`), so an id handed out for it is answered by `first`, and no later call is answered by
/// it. A route that stands on a record (`Route::stands`) is never retired. The route that stands.
fn first_stands(first: &Route, standing: &Route) -> Route {
    eprintln!("   [confirm] {}: stands; {} was learned from a sighting that found nothing", first.id, standing.id);
    if let Err(e) = store::retire_route_for(&standing.id, &first.id) {
        eprintln!("   [confirm] {}: could not retire {}: {e}", first.id, standing.id);
    }
    store::load_route(&first.id).unwrap_or_else(|| first.clone())
}

/// Whether `standing`, the route a confirming browse learned from the browser's walk for a new value, may stand in for
/// `first`, the route the browse was compared beside: the one rule for a route taking another's place. Only another
/// route, only where the walk saw records for the value (`saw_records`: it did not find nothing, and its answer holds
/// a records place, `records_place`), and only where the browse agreed, or did not and `standing` was learned from two
/// sightings where `first` was learned from one (a route of one sighting that baked a value of its walk). A browse that
/// cannot tell replaces nothing, and a walk that saw no records puts nothing in a route's place.
fn may_stand_in(verdict: &Confirmed, saw_records: bool, first: &Route, standing: &Route) -> bool {
    standing.id != first.id
        && saw_records
        && match verdict {
            Confirmed::Agreed => true,
            Confirmed::Differed { .. } | Confirmed::Failed { .. } => of_two_sightings(standing) && !of_two_sightings(first),
            Confirmed::CannotTell { .. } => false,
        }
}

/// Where a confirming browse agreed, the route of one sighting it confirmed (`first`) is not kept beside the route of
/// two that stands confirmed (`confirmed`), another id: it is retired for it (`store::retire_route_for`), so its id is
/// answered by the confirmed route, and a later ask is never served by the unconfirmed copy (and browsed again). A
/// route that stands on a record (`Route::stands`) is never retired. Whether it was.
fn agreed_in_place(first: &Route, confirmed: &Route) -> bool {
    if first.id == confirmed.id || confirmed.provisional {
        return false;
    }
    match store::retire_route_for(&first.id, &confirmed.id) {
        Ok(done) => done,
        Err(e) => {
            eprintln!("   [confirm] {}: could not give way to {}: {e}", first.id, confirmed.id);
            false
        }
    }
}

/// Whether `route` was learned from two sightings of its call: the body it was learned as holds two walks' calls of
/// its answer's step (`Test::sightings`). The route a confirming browse learns from the first walk and its own is one.
fn of_two_sightings(route: &Route) -> bool {
    route.body.as_ref().is_some_and(|b| b.tests.iter().any(|t| t.step == b.answer.step && t.sightings.len() >= 2))
}

/// Where a confirming browse did not agree (`verdict`), the route it learned from two sightings (`standing`) takes the
/// place of the route of one sighting it was compared beside (`first`), when it is another call: `first` is retired
/// for it (`store::retire_route_for`), so an id handed out for `first` is answered by the route that stands, and the
/// route of one sighting is no longer kept, failing, beside the route of two. The same call learned again is written
/// under its own id and replaces nothing, and a route that stands on a record (`Route::stands`) is never retired.
/// Whether `first` gave way.
fn gives_way(first: &Route, standing: &Route) -> bool {
    match store::retire_route_for(&first.id, &standing.id) {
        Ok(true) => {
            eprintln!("   [confirm] {}: gives way to {}, learned from two sightings", first.id, standing.id);
            true
        }
        Ok(false) => false,
        Err(e) => {
            eprintln!("   [confirm] {}: could not give way to {}: {e}", first.id, standing.id);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(url: &str, body: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        }
    }

    fn records(word: &str) -> serde_json::Value {
        // What a search finds is other things for another word, not the same names with the word swapped.
        let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
        let rows: Vec<serde_json::Value> = (0..8).map(|n| serde_json::json!({ "id": n, "title": format!("{word} {} number {n}", kinds[n % 4]) })).collect();
        serde_json::json!({ "query": word, "results": rows })
    }

    /// A walk of the shop's search page for `word`: the page asks its search call, and a strip that answers alike.
    fn walk(word: &str, search: bool) -> Trace {
        let strip = r#"{"title":"You may also like","items":[{"name":"Garden chair"},{"name":"Desk fan"},{"name":"Wall clock"}]}"#;
        let mut exchanges = vec![call(&format!("https://shop.example/api/strip?q={word}"), strip)];
        if search {
            exchanges.push(call(&format!("https://shop.example/api/search?q={word}"), &records(word).to_string()));
        }
        Trace { exchanges, inputs: Vec::new() }
    }

    /// The search route learned on one walk for `brass`.
    fn route() -> Route {
        serde_json::from_value(serde_json::json!({
            "id": "once", "site": "shop.example", "what": "search", "method": "GET", "path": "/api/search?q={q}",
            "root": "https://shop.example/search?q=brass", "steps": 1, "browser_assisted": false, "write": false, "provisional": true, "learned_at": 1,
            "inputs": [{ "name": "q", "secret": false, "default": "brass" }],
            "graph": { "steps": [{ "exchange": 1, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "brass" }] }], "provisional": false }
        }))
        .unwrap()
    }

    fn glass() -> HashMap<String, String> {
        HashMap::from([("q".to_string(), "glass".to_string())])
    }

    /// A learn's first reply is the walk's own answer for the asked value, read as the route reads it: the records the
    /// route's own first call would have answered (the walk's call is that call), from the walk's own call of the
    /// route and never from another call of the page (the strip beside it). A walk that made no such call has none.
    #[test]
    fn a_learns_first_answer_is_the_walks_own_call_read_as_the_route_reads() {
        let brass = HashMap::from([("q".to_string(), "brass".to_string())]);
        assert_eq!(walks_answer(&route(), &walk("brass", true), &brass), Some(records("brass")));
        assert_eq!(walks_answer(&route_with_its_pages(), &walk_and_its_next_page("brass"), &brass), Some(records("brass")), "the route's own call, not the page's next page");
        assert_eq!(walks_answer(&route(), &walk("brass", false), &brass), None, "the walk made no call of the route");
    }

    /// The route answers the new value with the records the browser's walk got for it: the two agree, and the route is
    /// confirmed. Its call failing is no agreement.
    #[test]
    fn a_route_that_answers_what_the_browser_got_is_confirmed() {
        let (first, second) = (walk("brass", true), walk("glass", true));
        assert_eq!(compared(Some(&first), &route(), Ok(&records("glass")), &second, &glass()), Confirmed::Agreed);
        assert_eq!(compared(None, &route(), Ok(&records("glass")), &second, &glass()), Confirmed::Agreed, "the route's own call is found where the first walk is gone");
        assert_eq!(compared(Some(&first), &route(), Err("403"), &second, &glass()), Confirmed::Failed { why: "403".into() });
    }

    /// The search route as learned where the page also fetched its own next page: `page` and `_rsc` are inputs of its
    /// own the caller may give, sent by nothing the route sends when they are not.
    fn route_with_its_pages() -> Route {
        let mut route = route();
        for key in ["page", "_rsc"] {
            route.graph.steps[0].fields.push(serde_json::from_value(serde_json::json!({ "loc": { "in": "query", "key": key }, "class": "input", "name": key, "secret": false, "default": null, "optional": true })).unwrap());
        }
        route
    }

    /// A walk of the search page for `word` that, once loaded, fetches its own link to the next page (one more key, and
    /// a key of its own the page sends): the same path, other records.
    fn walk_and_its_next_page(word: &str) -> Trace {
        let mut trace = walk(word, true);
        let next: Vec<serde_json::Value> = (0..8).map(|n| serde_json::json!({ "id": 100 + n, "title": format!("{word} page two item {n}") })).collect();
        trace.exchanges.push(call(&format!("https://shop.example/api/search?q={word}&page=2&_rsc=x1"), &serde_json::json!({ "query": word, "results": next }).to_string()));
        trace
    }

    /// The walk's call that is the route's call is the one that sends what the route sends and no key the route leaves
    /// empty: the page's later fetch of its own next page is the same path, and is not it. Held against that fetch the
    /// route's right answer would read as other records; held against the route's own call it agrees. And no pairing
    /// lets an answer that holds none of the asked value's records agree.
    #[test]
    fn the_walks_call_is_the_one_sending_what_the_route_sends() {
        let (first, second) = (walk_and_its_next_page("brass"), walk_and_its_next_page("glass"));
        let route = route_with_its_pages();
        assert_eq!(its_call(&route, &first), Some(1), "the route's own call, not the later fetch of page two");
        assert_eq!(compared(Some(&first), &route, Ok(&records("glass")), &second, &glass()), Confirmed::Agreed);
        assert_eq!(compared(None, &route, Ok(&records("glass")), &second, &glass()), Confirmed::Agreed);
        for wrong in [records("brass"), serde_json::json!({ "query": "glass", "results": [] })] {
            assert_ne!(compared(Some(&first), &route, Ok(&wrong), &second, &glass()), Confirmed::Agreed, "{wrong}");
        }
        // The sighting says which call it was held against and why: the route's own, sending no key it leaves empty,
        // of the two the walk made, both answers saying their records alike.
        let (call, _, held) = comparison(Some(&first), &route, Some(&records("glass")), &second, &glass(), &Confirmed::Agreed);
        assert_eq!((call, held.calls, held.left_out), (Some(1), 2, 0));
        assert!(held.shared > 0 && held.shared == held.ours && held.ours == held.theirs, "{held:?}");
        assert_eq!(count_at(&records("glass"), "results"), Some(8));
        // Where the walk made only the fetch that sends one more key, it is still the call the route makes.
        let mut only = walk_and_its_next_page("glass");
        only.exchanges.remove(1);
        assert_eq!(its_call(&route, &only), Some(1));
    }

    /// An answer that holds the walk's records but never says the new value back is the site answering something else
    /// that happens to match: it is not confirmed.
    #[test]
    fn a_route_that_agrees_but_never_says_the_new_word_is_not_confirmed() {
        let shelf = serde_json::json!({ "results": (0..8).map(|n| serde_json::json!({ "id": n, "title": format!("shelf item number {n}") })).collect::<Vec<_>>() });
        let (mut first, mut second) = (walk("brass", false), walk("glass", false));
        first.exchanges.push(call("https://shop.example/api/search?q=brass", &shelf.to_string()));
        second.exchanges.push(call("https://shop.example/api/search?q=glass", &shelf.to_string()));
        let verdict = compared(Some(&first), &route(), Ok(&shelf), &second, &glass());
        assert_eq!(verdict, Confirmed::Differed { why: "the route's answer never says the new value back".into() });
    }

    /// The browser's walk for the new value made no such call: nothing it got can confirm the route.
    #[test]
    fn a_route_whose_call_the_browser_never_made_is_not_confirmed() {
        let (first, second) = (walk("brass", true), walk("glass", false));
        let verdict = compared(Some(&first), &route(), Ok(&records("glass")), &second, &glass());
        assert_eq!(verdict, Confirmed::Differed { why: "the browser's walk for the new value made no such call".into() });
    }

    /// The route answering what the first walk was answered is not the new value's answer, though the browser too got
    /// the old records.
    #[test]
    fn a_route_that_answers_the_old_records_is_not_confirmed() {
        let first = walk("brass", true);
        let mut second = walk("glass", false);
        second.exchanges.push(call("https://shop.example/api/search?q=glass", &records("brass").to_string()));
        let verdict = compared(Some(&first), &route(), Ok(&records("brass")), &second, &glass());
        assert!(matches!(verdict, Confirmed::Differed { .. }), "{verdict:?}");
    }

    /// A search's answer for a word nobody searches for: no records, and the word said back on lines of its own.
    fn nothing_found(word: &str) -> serde_json::Value {
        serde_json::json!({ "query": word, "params": format!("query={word}&per_page=100"), "message": format!("no items match {word}"), "results": [] })
    }

    /// The route and the browser's walk both answer a word nobody searches for with an empty list that says the word
    /// back: they agree, and the agreement confirms nothing. The verdict cannot tell, and says why. Records on both
    /// sides still agree as before.
    #[test]
    fn an_answer_with_no_records_confirms_nothing() {
        let word = "qzxvorb";
        let first = walk("brass", true);
        let mut second = walk(word, false);
        second.exchanges.push(call(&format!("https://shop.example/api/search?q={word}"), &nothing_found(word).to_string()));
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        let verdict = compared(Some(&first), &route(), Ok(&nothing_found(word)), &second, &asked);
        assert_eq!(verdict, Confirmed::CannotTell { why: NO_RECORDS.into() });
        assert!(!verdict.said().contains(word), "the reason never names the caller's value: {}", verdict.said());
        assert_eq!(compared(Some(&first), &route(), Ok(&records("glass")), &walk("glass", true), &glass()), Confirmed::Agreed);
    }

    /// A route that stands on one sighting, asked a value other than the one it was learned on, is served by the
    /// browser and compared; asked its own value, or once a use has confirmed it and given it a records place, or a
    /// write, it is called. A route said back with no records place is not yet confirmed.
    #[test]
    fn an_unverified_route_is_served_by_the_browser_and_compared() {
        let once = route();
        assert!(served_by_the_browser(&once, &glass()));
        assert!(!served_by_the_browser(&once, &HashMap::from([("q".to_string(), "brass".to_string())])), "its own value");
        let mut confirmed = once.clone();
        confirmed.heard.said_back = Some("glass".into());
        assert!(served_by_the_browser(&confirmed, &glass()), "said back with no records place: not yet confirmed");
        confirmed.heard.records_at = Some("results".into());
        assert!(!served_by_the_browser(&confirmed, &glass()), "a use already confirmed it, and gave it a records place");
        let mut write = once.clone();
        write.write = true;
        assert!(!served_by_the_browser(&write, &glass()), "a write is never asked twice");
    }

    /// The walk's own answer to the route's call is read as the route's call reads its answer: a reply of one record a
    /// line is the text it serves as data on both sides, and a reply only the page's script deciphers is deciphered by
    /// the route's own decoder on both sides. Read by the plain reader, each walk's answer is nothing, and a route
    /// that answered what the browser got was said to differ.
    #[test]
    fn a_confirming_browse_reads_the_walks_answer_as_the_route_does() {
        // One record a line: the site's own type for it, no one JSON document.
        let lines = |word: &str| records(word)["results"].as_array().unwrap().iter().map(|r| format!("{r}\n")).collect::<String>();
        let walk_of = |word: &str, body: String, mime: &str| {
            let mut t = walk(word, false);
            let mut e = call(&format!("https://shop.example/api/search?q={word}"), &body);
            e.response_mime = mime.into();
            e.response_headers = vec![("content-type".into(), mime.into())];
            t.exchanges.push(e);
            t
        };
        let (first, second) = (walk_of("brass", lines("brass"), "application/x-ndjson"), walk_of("glass", lines("glass"), "application/x-ndjson"));
        assert!(experiment::answer_of(&second.exchanges[1]).is_none(), "the plain reader reads such a reply as nothing");
        // What the route's call hands back for it (`answer::data_of`): the text, as data.
        let answered = unbrowse_learn::answer::text_answer("application/x-ndjson", &lines("glass")).unwrap();
        assert_eq!(compared(Some(&first), &route(), Ok(&answered), &second, &glass()), Confirmed::Agreed);

        if !unbrowse_learn::sandbox::available() {
            eprintln!("no runtime on this machine for the site's decoder: the ciphered half is skipped");
            return;
        }
        use base64::Engine;
        const SCRIPT: &str = "(function () {\n  function unpack(t) { var raw = atob(t), out = ''; for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a); return JSON.parse(out); }\n  window.searchCipher = function (q, done) {\n    fetch('/api/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n  };\n})();\n";
        let ciphered = |word: &str| base64::engine::general_purpose::STANDARD.encode(records(word).to_string().bytes().map(|b| b ^ 0x5a).collect::<Vec<u8>>());
        let (first, second) = (walk_of("brass", ciphered("brass"), "text/plain"), walk_of("glass", ciphered("glass"), "text/plain"));
        let mut deciphers = route();
        let mut body = unbrowse_learn::body::from_graph(&deciphers.graph, &deciphers.site);
        let program = unbrowse_learn::slice::assemble_decoder(&[("https://shop.example/s/app.js", SCRIPT)]).expect("a decoder");
        body.answer.decode = Some(unbrowse_learn::route::Decode { source: program, evidence: None });
        deciphers.body = Some(body);
        assert!(experiment::answer_of(&second.exchanges[1]).is_none(), "the plain reader reads a ciphered reply as nothing");
        // The route's call deciphered its live reply (`replay::run`): its answer is the records.
        assert_eq!(compared(Some(&first), &deciphers, Ok(&records("glass")), &second, &glass()), Confirmed::Agreed);
        // A route that answered the first walk's records is still told apart, read the same way.
        assert!(matches!(compared(Some(&first), &deciphers, Ok(&records("brass")), &second, &glass()), Confirmed::Differed { .. }));
    }

    /// The route of `id` learned as a body whose answer's step was seen on `sightings` walks.
    fn sighted(id: &str, sightings: usize) -> Route {
        let mut r = route();
        r.id = id.into();
        let mut body = unbrowse_learn::body::from_graph(&r.graph, &r.site);
        let step = body.answer.step.clone();
        body.tests = vec![unbrowse_learn::route::Test { step, sightings: vec![unbrowse_learn::route::Sighting { seen: Vec::new() }; sightings], over_scripts: Vec::new() }];
        r.body = Some(body);
        r
    }

    /// A confirming browse that did not agree learned another call from the first walk and its own: the route of one
    /// sighting gives way to it, and its id is answered by the route of two. A route of one sighting beside it, or the
    /// same call learned again, replaces nothing; a browse that agreed lets the route it confirmed stand in. Either
    /// way only where the walk saw records for the value (`may_stand_in`).
    #[test]
    fn a_route_the_second_sighting_replaced_is_no_longer_kept() {
        let home = store::scratch_home("confirm-gives-way");
        store::use_home(&home);
        let (once, twice, other_once) = (sighted("once", 1), sighted("twice", 2), sighted("other-once", 1));
        for r in [&once, &twice, &other_once] {
            store::save_route(r).unwrap();
        }
        let differed = Confirmed::Differed { why: "the route's answer and the browser's hold different records".into() };
        assert!(may_stand_in(&Confirmed::Agreed, true, &once, &twice), "a browse that agreed lets the route it confirmed stand in");
        assert!(!may_stand_in(&differed, true, &once, &other_once), "a route of one sighting takes no one's place");
        assert!(!may_stand_in(&differed, true, &once, &once), "the same call learned again is written under its own id");
        assert!(store::load_route("once").is_some());
        let failed = Confirmed::Failed { why: "403".into() };
        assert!(may_stand_in(&failed, true, &once, &twice));
        assert!(gives_way(&once, &twice));
        assert!(store::load_route("once").is_none(), "the route of one sighting is no longer kept");
        assert_eq!(store::took_the_place_of("once").map(|r| r.id), Some("twice".to_string()));
    }

    /// What must hold for a route to stand in for another, the other way: a walk that saw no records for the value
    /// (it found nothing, or what it learned answers with none, as a page's interface copy does) puts nothing in a
    /// route's place, whatever the browse said; nor does a browse that cannot tell.
    #[test]
    fn a_walk_that_saw_no_records_puts_nothing_in_a_routes_place() {
        let (once, twice) = (sighted("once", 1), sighted("twice", 2));
        let differed = Confirmed::Differed { why: "the route's answer and the browser's hold different records".into() };
        assert!(!may_stand_in(&Confirmed::Agreed, false, &once, &twice), "agreed on an answer with no records place");
        assert!(!may_stand_in(&differed, false, &once, &twice), "two sightings of a walk that saw no records");
        assert!(!may_stand_in(&Confirmed::Failed { why: "403".into() }, false, &once, &twice));
        assert!(!may_stand_in(&Confirmed::CannotTell { why: NO_RECORDS.into() }, true, &once, &twice), "a browse that cannot tell replaces nothing");
        // The interface copy of a page has no records place for the value; a page of its results has one.
        let copy = serde_json::json!({ "copyTags": { "a": "Where are you going next", "b": "Deals for the weekend away" } });
        assert_eq!(records_place(&copy, &["tokyo".into()]), None);
        let stays = serde_json::json!({ "results": [{ "name": "Tokyo harbour flat" }, { "name": "Tokyo hill cabin" }] });
        assert_eq!(records_place(&stays, &["tokyo".into()]).as_deref(), Some("results"));
    }

    /// The records place of a feed is read by its items, as a confirm compares a feed, and of an answer that is one
    /// record saying the value back, the answer whole: each of them a place a later answer is held to.
    #[test]
    fn a_feed_and_a_single_record_have_a_records_place() {
        let feed = |w: &str, n: usize| serde_json::json!({ "content_type": "application/rss+xml", "text": format!("<rss><channel><title>{w}</title>{}</channel></rss>", (0..n).map(|k| format!("<item><title>{w} news {k}</title><link>https://n.example/{k}</link></item>")).collect::<String>()) });
        let place = records_place(&feed("zig", 3), &["zig".into()]).expect("a feed's items are its records");
        let mut r = route();
        r.heard.records_at = Some(place);
        assert!(!lacks_its_records(&r, &feed("rust", 3)) && !nothing_at_its_records(&r, &feed("rust", 3)));
        assert!(nothing_at_its_records(&r, &feed("qzxv", 0)), "a feed with no items found nothing");
        let item = serde_json::json!({ "symbol": "ZIGC", "name": "Zig Corp", "price": 12.5 });
        assert_eq!(records_place(&item, &["zig corp".into()]).as_deref(), Some(WHOLE));
        r.heard.records_at = Some(WHOLE.into());
        assert!(!nothing_at_its_records(&r, &item) && nothing_at_its_records(&r, &serde_json::json!({})));
    }

    /// The confirming browse's walk was asked a word nobody searches for: the search call it shares with the first
    /// walk answers an empty list, and a counts call beside it a frame of counts. The route learned from the two walks
    /// picked the counts call; it does not take the place of the search route, which stands unconfirmed under its own
    /// id, and the counts route is no longer kept. A sighting with records is not one that found nothing.
    #[test]
    fn a_sighting_that_found_nothing_never_replaces_a_route_that_did() {
        let home = store::scratch_home("confirm-found-nothing");
        store::use_home(&home);
        let word = "qzxvorb";
        let counts = |w: &str, n: u64| call(&format!("https://shop.example/api/search?q={w}&per_page=0"), &serde_json::json!({ "query": w, "results": [], "counts": { "lamps": n, "jars": n / 2 } }).to_string());
        let mut first = walk("brass", true);
        first.exchanges.push(counts("brass", 12));
        let mut second = walk(word, false);
        second.exchanges.push(call(&format!("https://shop.example/api/search?q={word}"), &nothing_found(word).to_string()));
        second.exchanges.push(counts(word, 0));
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        let (once, by_counts) = (sighted("once", 1), sighted("by-counts", 2));
        for r in [&once, &by_counts] {
            store::save_route(r).unwrap();
        }
        assert!(sighting_found_nothing(Some(&first), &once, &second, &asked));
        assert!(!sighting_found_nothing(Some(&first), &once, &walk("glass", true), &glass()), "a sighting with records found something");
        let stands = first_stands(&once, &by_counts);
        assert_eq!(stands.id, "once", "the route whose answer held records stands");
        assert!(stands_on_one_sighting(&stands), "unconfirmed");
        assert!(store::load_route("once").is_some(), "kept in its place");
        assert!(store::load_route("by-counts").is_none(), "the route of the sighting that found nothing is not kept");
        assert_eq!(store::took_the_place_of("by-counts").map(|r| r.id), Some("once".to_string()));
    }

    /// The route stood on a counts call (learned where a walk found nothing), and the browser's walk for a word with
    /// records made both that call and the search call: the counts call answered a frame of counts, the search call
    /// the records for the word. The reply to the ask is what the browser got for the word, the records, whichever
    /// route stands; where the walk found nothing, the walk's own answer says so; where it made neither call, none.
    #[test]
    fn the_confirming_browse_answers_with_what_the_browser_got() {
        // The page's search call and its counts call: one address, one asking a page of records, one asking none.
        let searched = |w: &str, found: bool| {
            let listed = if found { records(w) } else { nothing_found(w) };
            let n = if found { 12 } else { 0 };
            let counts = serde_json::json!({ "query": w, "results": [], "counts": { "lamps": n, "jars": n / 2 } });
            let mut t = walk(w, false);
            t.exchanges.push(call(&format!("https://shop.example/api/search?q={w}&per_page=20"), &listed.to_string()));
            t.exchanges.push(call(&format!("https://shop.example/api/search?q={w}&per_page=0"), &counts.to_string()));
            t
        };
        // A route of the call that sends `per_page` as `per`, learned on `word`.
        let on = |id: &str, per: &str, word: &str| {
            let mut r = route();
            r.id = id.into();
            r.path = format!("/api/search?q={{q}}&per_page={per}");
            r.inputs[0].default = Some(word.into());
            let step = &mut r.graph.steps[0];
            step.url = format!("https://shop.example/api/search?q={{q}}&per_page={per}");
            step.fields.push(serde_json::from_value(serde_json::json!({ "loc": { "in": "query", "key": "per_page" }, "class": "constant", "value": per, "origin": null })).unwrap());
            r
        };
        let (first, second) = (searched("brass", true), searched("glass", true));
        // The route that stood is the counts call; the route learned from the browser's walk is the search call.
        let (by_counts, learned) = (on("by-counts", "0", "brass"), on("learned", "20", "glass"));
        let answer = the_browsers_answer(Some(&first), &by_counts, &learned, &second, &glass()).expect("the browser got an answer");
        assert_eq!(answer, records("glass"), "the records the browser got for the word, not the counts");
        assert_eq!(the_browsers_answer(Some(&first), &learned, &by_counts, &second, &glass()), Some(records("glass")), "whichever of the two is which");
        // The walk found nothing: its own answer, which says so, is the reply.
        let word = "qzxvorb";
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        assert_eq!(the_browsers_answer(Some(&first), &by_counts, &on("learned", "20", word), &searched(word, false), &asked), Some(nothing_found(word)));
        // The walk made neither call: no answer of the browser's, and the route that stands is called.
        assert_eq!(the_browsers_answer(Some(&first), &by_counts, &learned, &walk("glass", false), &glass()), None);
    }

    /// A walk of the shop's slots page for the day `iso`, whose call sends it day first (`sent`), answered with that
    /// day's slots: other things on another day, not the same names with the day swapped.
    fn dated_walk(iso: &str, sent: &str) -> (Trace, serde_json::Value) {
        let kinds = match iso {
            "2026-03-04" => ["morning yoga", "pottery class", "wine tasting", "city walk"],
            "2026-11-07" => ["evening choir", "bread baking", "chess club", "film night"],
            _ => ["harbour cruise", "life drawing", "salsa lesson", "book swap"],
        };
        let answer = serde_json::json!({ "day": iso, "slots": (0..8).map(|n| serde_json::json!({ "id": n, "title": format!("{iso} {} number {n}", kinds[n % 4]) })).collect::<Vec<_>>() });
        let address = format!("https://shop.example/api/slots?d={}", sent.replace('/', "%2F"));
        (Trace { exchanges: vec![call(&address, &answer.to_string())], inputs: Vec::new() }, answer)
    }

    /// The slots route learned on one walk for the fourth of March, sent day first.
    fn dated_route() -> Route {
        serde_json::from_value(serde_json::json!({
            "id": "slots", "site": "shop.example", "what": "find slots", "method": "GET", "path": "/api/slots?d={d}",
            "root": "https://shop.example/slots?d=2026-03-04", "steps": 1, "browser_assisted": false, "write": false, "provisional": true, "learned_at": 1,
            "inputs": [{ "name": "d", "secret": false, "default": "2026-03-04" }],
            "graph": { "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/slots?d={d}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "d" }, "class": "input", "name": "d", "secret": false, "default": "2026-03-04" }] }], "provisional": false }
        }))
        .unwrap()
    }

    /// Asked the seventh of November after the fourth of March, both days of twelve or less, the walks cannot tell a
    /// day written first from a month written first: both writings send the new day alike, so the route's answer,
    /// though it is what the browser got, settles nothing about a day they part on. The verdict says it cannot tell,
    /// and is no agreement and no difference. The twenty-first of June parts them, and the same comparison agrees.
    #[test]
    fn a_value_two_writings_fit_leaves_the_route_unconfirmed_not_wrong() {
        let (first, _) = dated_walk("2026-03-04", "04/03/2026");
        let asked = |d: &str| HashMap::from([("d".to_string(), d.to_string())]);
        let (second, answered) = dated_walk("2026-11-07", "07/11/2026");
        let verdict = compared(Some(&first), &dated_route(), Ok(&answered), &second, &asked("2026-11-07"));
        assert!(matches!(verdict, Confirmed::CannotTell { .. }), "{verdict:?}");
        assert_eq!(verdict.word(), "cannot-tell");
        assert!(!verdict.said().contains("2026"), "the reason names the input and its place, never a value: {}", verdict.said());
        // Its call failing is still a failure, and an answer of other records still a difference.
        assert!(matches!(compared(Some(&first), &dated_route(), Err("403"), &second, &asked("2026-11-07")), Confirmed::Failed { .. }));
        let (_, other) = dated_walk("2026-06-21", "21/06/2026");
        assert!(matches!(compared(Some(&first), &dated_route(), Ok(&other), &second, &asked("2026-11-07")), Confirmed::Differed { .. }));
        // A day above twelve leaves one writing standing: the route is confirmed by the answer as any route is.
        let (parts, answered) = dated_walk("2026-06-21", "21/06/2026");
        assert_eq!(compared(Some(&first), &dated_route(), Ok(&answered), &parts, &asked("2026-06-21")), Confirmed::Agreed);
    }

    /// The search page itself as a walk's document for `word`: the site's frame (its menus and its sponsors, the same
    /// whatever was asked), then what it found: `found` records for the word, or a line saying nothing matched it.
    fn page(word: &str, found: bool, referer: bool) -> Exchange {
        let frame = ["Browse all projects", "Help and documentation", "Sponsors of the index", "Log in to your account", "Register a new account", "Filter by classifier", "Sort by relevance", "Status of the service"];
        let found_lines: Vec<String> = if found {
            // Other things for another word, not the same names with the word swapped.
            let kinds = if word == "brass" { ["lamp fittings", "door knockers", "candle holders", "picture frames"] } else { ["mixing bowls", "storage jars", "flower vases", "water carafes"] };
            (0..8).map(|n| format!("<li><a href=\"/project/{word}-{n}\">{word} {} kit {n}</a></li>", kinds[n % 4])).collect()
        } else {
            vec![format!("<p>0 projects for \"{word}\"</p>"), format!("<p>There were no results for '{word}'</p>")]
        };
        let body = format!(
            "<html><head><title>Search results</title></head><body><div>{}</div><div><ul>{}</ul></div></body></html>",
            frame.iter().map(|l| format!("<p>{l}</p>")).collect::<String>(),
            found_lines.concat()
        );
        let mut e = call(&format!("https://index.example/search/?q={word}"), &body);
        e.response_mime = "text/html".into();
        e.resource_type = Some("Document".into());
        if referer {
            e.request_headers = vec![("Referer".into(), format!("https://index.example/search/?q={word}"))];
        }
        e
    }

    /// The route whose answer is the search page itself, learned for `brass`.
    fn page_route() -> Route {
        serde_json::from_value(serde_json::json!({
            "id": "page", "site": "index.example", "what": "search", "method": "GET", "path": "/search/?q={q}",
            "root": "https://index.example/search/?q=brass", "steps": 1, "browser_assisted": false, "write": false, "provisional": true, "learned_at": 1,
            "inputs": [{ "name": "q", "secret": false, "default": "brass" }],
            "graph": { "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://index.example/search/?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "brass" }] }], "provisional": false }
        }))
        .unwrap()
    }

    fn page_walk(word: &str, found: bool) -> Trace {
        Trace { exchanges: vec![page(word, found, false)], inputs: Vec::new() }
    }

    /// The route's answer for `word`, read off the browser's walk as the route's own call reads its page.
    fn page_answer(walk: &Trace, word: &str) -> serde_json::Value {
        as_the_route_reads(&page_route(), &walk.exchanges[0], &[word.to_string()]).unwrap()
    }

    fn q(word: &str) -> HashMap<String, String> {
        HashMap::from([("q".to_string(), word.to_string())])
    }

    /// The first walk's page loaded twice (the site's check reloaded it, the second time with the page as its
    /// referrer), and the browser's walk for the new value loaded it once: the page's call was made on the new walk,
    /// whichever of the first walk's two loads it is paired with.
    #[test]
    fn a_call_the_first_walk_made_twice_is_made_on_a_walk_that_made_it_once() {
        let first = Trace { exchanges: vec![page("brass", true, false), page("brass", true, true)], inputs: Vec::new() };
        let second = page_walk("glass", true);
        assert_eq!(walks_call(Some(&first), &page_route(), &second, &q("glass")), Some(0));
    }

    /// A page answer's frame is the same whatever was asked: an answer that holds only the frame and a line saying
    /// nothing matched found nothing, held beside a first walk that found records. It is no sign the route answers
    /// the first walk's ask, nor that the call is deaf: the verdict cannot tell. Found the other way round (the first
    /// walk found nothing, the new one records), the first walk says nothing against the route, which agrees.
    #[test]
    fn a_page_that_found_nothing_beside_one_that_found_records_cannot_tell() {
        let word = "qzxvorb";
        let (found, nothing) = (page_walk("brass", true), page_walk(word, false));
        assert_eq!(compared(Some(&found), &page_route(), Ok(&page_answer(&nothing, word)), &nothing, &q(word)), Confirmed::CannotTell { why: NO_RECORDS.into() });
        let glass = page_walk("glass", true);
        assert_eq!(compared(Some(&nothing), &page_route(), Ok(&page_answer(&glass, "glass")), &glass, &q("glass")), Confirmed::Agreed);
        // Two pages that found records for two words still agree, and a route answering the first walk's page differs.
        assert_eq!(compared(Some(&found), &page_route(), Ok(&page_answer(&glass, "glass")), &glass, &q("glass")), Confirmed::Agreed);
    }

    /// A page that says nothing was found without saying the value back ("No results."), whose only links are the site's menus (outside any `nav`) that the first walk's page carries too, lists nothing
    /// (`answer::lists_nothing_beside`): the made-up value confirms nothing, and the route is not set aside. The
    /// page with a result of its own for another value still agrees.
    #[test]
    fn a_page_that_says_it_found_nothing_with_only_its_menus_cannot_tell() {
        let menus = ["/import", "/groups", "/help"].iter().map(|u| format!("<a href=\"{u}\">Menu {u}</a>")).collect::<String>();
        let page = |word: &str, found: bool| {
            // Other books for another word, not the same names with the word swapped.
            let kinds = if word == "brass" { ["band marches", "instrument care", "fittings at home"] } else { ["blowing for beginners", "stained windows", "kilns and colour"] };
            let results = if found { (0..6).map(|n| format!("<li><a href=\"/book/{word}-{n}\">{word}: {} {n}</a></li>", kinds[n % 3])).collect::<String>() } else { "<p>No results.</p><p>Looking for a book? Check the spelling.</p>".to_string() };
            let body = format!("<html><head><title>Book search results</title></head><body><div class=menu>{menus}</div><ul>{results}</ul></body></html>");
            let mut e = call(&format!("https://index.example/search/?q={word}"), &body);
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            Trace { exchanges: vec![e], inputs: Vec::new() }
        };
        let word = "qzxvorb";
        let (found, nothing) = (page("brass", true), page(word, false));
        assert_eq!(compared(Some(&found), &page_route(), Ok(&page_answer(&nothing, word)), &nothing, &q(word)), Confirmed::CannotTell { why: NO_RECORDS.into() });
        let glass = page("glass", true);
        assert_eq!(compared(Some(&found), &page_route(), Ok(&page_answer(&glass, "glass")), &glass, &q("glass")), Confirmed::Agreed);
        assert!(sighting_found_nothing(Some(&found), &page_route(), &nothing, &q(word)), "the browser's walk for the made-up value found nothing");
    }

    /// A call whose answer held no records on the walk the route was learned from (a frame of counts) finds nothing
    /// on no later walk either: its empty answer there is what it always answers, no sign the walk found nothing.
    #[test]
    fn a_call_that_never_held_records_finds_nothing_on_no_walk() {
        let counts = |w: &str, n: u64| call(&format!("https://shop.example/api/search?q={w}&per_page=0"), &serde_json::json!({ "query": w, "results": [], "counts": { "lamps": n, "jars": n / 2 } }).to_string());
        let counts_route: Route = {
            let mut r = route();
            r.path = "/api/search?q={q}&per_page=0".into();
            r.graph.steps[0].url = "https://shop.example/api/search?q={q}&per_page=0".into();
            r.graph.steps[0].exchange = 0;
            r
        };
        let first = Trace { exchanges: vec![counts("zqx", 0)], inputs: Vec::new() };
        let mut second = walk("glass", true);
        second.exchanges.push(counts("glass", 12));
        assert!(!sighting_found_nothing(Some(&first), &counts_route, &second, &glass()));
    }

    /// The route learned from a sighting that found nothing is retired for the route that stands, however many
    /// sightings either was learned from: it is never kept to answer a later call.
    #[test]
    fn a_route_learned_beside_a_sighting_that_found_nothing_is_never_kept() {
        let home = store::scratch_home("confirm-nothing-retired");
        store::use_home(&home);
        let (two, by_counts) = (sighted("two", 2), sighted("by-counts", 2));
        for r in [&two, &by_counts] {
            store::save_route(r).unwrap();
        }
        assert_eq!(first_stands(&two, &by_counts).id, "two");
        assert!(store::load_route("two").is_some());
        assert!(store::load_route("by-counts").is_none(), "the route of the sighting that found nothing is not kept");
        assert_eq!(store::took_the_place_of("by-counts").map(|r| r.id), Some("two".to_string()));
    }


    /// The search answered `n` records for `word`, the first `shared` of them the same as `of`'s (a page of results
    /// whose last places another ask of the same word fills with others).
    fn ranked(word: &str, n: usize, shared: usize) -> serde_json::Value {
        let rows: Vec<serde_json::Value> = (0..n).map(|k| if k < shared { serde_json::json!({ "id": k, "title": format!("{word} item kept at place {k}") }) } else { serde_json::json!({ "id": 1000 + k, "title": format!("{word} other item moved in at {k}") }) }).collect();
        serde_json::json!({ "query": word, "results": rows })
    }

    /// Two asks of the same word fill a page's last places with other records (the site ranks them afresh each time):
    /// the route and the browser still hold the same records, and agree. An answer that shares less than nine in ten
    /// of its records differs.
    #[test]
    fn a_page_of_results_whose_last_places_moved_still_agrees() {
        let first = walk("brass", true);
        let mut second = walk("glass", false);
        second.exchanges.push(call("https://shop.example/api/search?q=glass", &ranked("glass", 40, 40).to_string()));
        assert_eq!(compared(Some(&first), &route(), Ok(&ranked("glass", 40, 37)), &second, &glass()), Confirmed::Agreed);
        assert!(matches!(compared(Some(&first), &route(), Ok(&ranked("glass", 40, 20)), &second, &glass()), Confirmed::Differed { .. }));
    }

    /// Page `n` of the search for `word`: other records on each page.
    fn paged(word: &str, n: usize) -> Exchange {
        let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
        let rows: Vec<serde_json::Value> = (0..8).map(|k| serde_json::json!({ "id": n * 100 + k, "title": format!("{word} {} {k} on page {n}", kinds[k % 4]) })).collect();
        call(&format!("https://shop.example/api/search?q={word}&page={n}"), &serde_json::json!({ "query": word, "page": n, "results": rows }).to_string())
    }

    /// The search route with its page as an optional input, learned on page 1 for `brass`.
    fn paged_route() -> Route {
        serde_json::from_value(serde_json::json!({
            "id": "paged", "site": "shop.example", "what": "search", "method": "GET", "path": "/api/search?q={q}&page={page}",
            "root": "https://shop.example/search?q=brass", "steps": 1, "browser_assisted": false, "write": false, "provisional": true, "learned_at": 1,
            "inputs": [{ "name": "q", "secret": false, "default": "brass" }, { "name": "page", "secret": false, "default": "1", "optional": true }],
            "graph": { "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}&page={page}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "brass" },
                           { "loc": { "in": "query", "key": "page" }, "class": "input", "name": "page", "secret": false, "default": "1", "optional": true }] }], "provisional": false }
        }))
        .unwrap()
    }

    /// Both walks read on as the page scrolled (pages 1, 2 and 3 of the search): the walk's call of the route is the
    /// one that sends the route's own values (page 1), not the last page the walk fetched, and the route's answer
    /// for the new value is held against that.
    #[test]
    fn the_walks_call_of_a_route_is_the_one_sending_the_routes_own_values() {
        let pages = |w: &str| Trace { exchanges: (1..=3).map(|n| paged(w, n)).collect(), inputs: Vec::new() };
        let (first, second) = (pages("brass"), pages("glass"));
        assert_eq!(walks_call(Some(&first), &paged_route(), &second, &glass()), Some(0));
        assert_eq!(walks_call(None, &paged_route(), &second, &glass()), Some(0));
        let answer = serde_json::from_str::<serde_json::Value>(paged("glass", 1).response_body.as_deref().unwrap()).unwrap();
        assert_eq!(compared(Some(&first), &paged_route(), Ok(&answer), &second, &glass()), Confirmed::Agreed);
    }

    /// A route's answer over the budget a reply carries is cut to its first records; the comparison reads the whole
    /// answer the call kept, and the cut one only where none was kept.
    #[test]
    fn a_cut_answer_is_compared_whole() {
        let home = store::scratch_home("confirm-whole");
        let (whole, cut) = (records("glass"), serde_json::json!({ "query": "glass", "results": [records("glass")["results"][0]] }));
        let path = home.join("whole.json");
        std::fs::write(&path, serde_json::to_vec(&whole).unwrap()).unwrap();
        let t = crate::run::Truncated { kept_bytes: 10, total_bytes: 100, cuts: Vec::new(), whole: Some(path.to_string_lossy().into_owned()), left_out: Vec::new(), next_page: None, note: String::new() };
        assert_eq!(the_whole(Some(cut.clone()), Some(&t)), Some(whole.clone()));
        assert_eq!(the_whole(Some(cut.clone()), None), Some(cut.clone()));
        let gone = crate::run::Truncated { whole: None, ..t };
        assert_eq!(the_whole(Some(cut.clone()), Some(&gone)), Some(cut.clone()));
        let (first, second) = (walk("brass", true), walk("glass", true));
        assert_eq!(compared(Some(&first), &route(), Ok(&the_whole(Some(cut), Some(&crate::run::Truncated { whole: Some(path.to_string_lossy().into_owned()), ..gone })).unwrap()), &second, &glass()), Confirmed::Agreed);
    }

    /// The browser's walk for a word nobody searches for found nothing on the search call, and the route it learned is
    /// a call of the page's own that never sends the word (the server's name and settings): the reply is the search
    /// call's own empty answer, never the page's settings.
    #[test]
    fn a_walk_that_found_nothing_answers_with_the_call_that_was_asked() {
        let word = "qzxvorb";
        let settings = call("https://shop.example/api/settings", r#"{"title":"The shop","search_enabled":true,"languages":["en","fr"]}"#);
        let mut second = walk(word, false);
        second.exchanges.push(settings);
        second.exchanges.push(call(&format!("https://shop.example/api/search?q={word}"), &nothing_found(word).to_string()));
        let mut learned = route();
        learned.id = "settings".into();
        learned.path = "/api/settings".into();
        learned.inputs.clear();
        learned.graph.steps[0].url = "https://shop.example/api/settings".into();
        learned.graph.steps[0].fields.clear();
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        assert_eq!(the_browsers_answer(Some(&walk("brass", true)), &route(), &learned, &second, &asked), Some(nothing_found(word)));
    }

    /// A confirming browse agreed: the route of two sightings stands confirmed, and the route of one it confirmed is not
    /// kept beside it, its id answered by the confirmed route. The same id, or a route left unconfirmed, retires nothing.
    #[test]
    fn a_route_confirmed_in_its_place_is_not_kept_beside_it() {
        let home = store::scratch_home("confirm-agreed-in-place");
        store::use_home(&home);
        let (once, mut twice) = (sighted("once", 1), sighted("twice", 2));
        twice.provisional = false;
        for r in [&once, &twice] {
            store::save_route(r).unwrap();
        }
        assert!(!agreed_in_place(&once, &once));
        assert!(!agreed_in_place(&once, &sighted("unconfirmed", 2)), "an unconfirmed route takes no one's place");
        assert!(agreed_in_place(&once, &twice));
        assert!(store::load_route("once").is_none());
        assert_eq!(store::took_the_place_of("once").map(|r| r.id), Some("twice".to_string()));
    }

    /// The search route held records on its first walk; the browser's walk for a word nobody searches for found
    /// nothing on it, and learned the page itself, whose shell names the site and no result: the reply is the search
    /// call's own empty answer, not the page.
    #[test]
    fn a_walk_that_found_nothing_on_the_asked_call_answers_with_it_not_the_page() {
        let word = "qzxvorb";
        let mut second = walk(word, false);
        let mut shell = call(&format!("https://shop.example/search?q={word}"), "<html><head><title>The shop</title></head><body><div id=app>The shop</div></body></html>");
        shell.response_mime = "text/html".into();
        second.exchanges.insert(0, shell);
        second.exchanges.push(call(&format!("https://shop.example/api/search?q={word}"), &nothing_found(word).to_string()));
        let mut page = route();
        page.id = "page".into();
        page.path = "/search?q={q}".into();
        page.graph.steps[0].url = "https://shop.example/search?q={q}".into();
        page.graph.steps[0].exchange = 0;
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        assert_eq!(the_browsers_answer(Some(&walk("brass", true)), &route(), &page, &second, &asked), Some(nothing_found(word)));
    }

    /// A feed served as one line of XML: the route's answer and the browser's are its items, which say the new value
    /// back one an item, so the two agree; held as one line of text they never said it back twice.
    #[test]
    fn a_feed_of_one_line_is_compared_by_its_items() {
        let feed = |w: &str, kinds: [&str; 4]| {
            let items: String = (0..6).map(|n| format!("<item><title>{w} {} {n}</title><link>https://news.example/{w}/{n}</link></item>", kinds[n % 4])).collect();
            format!("<?xml version=\"1.0\"?><rss><channel><title>{w} - News</title>{items}</channel></rss>")
        };
        let xml = |w: &str, kinds| {
            let mut e = call(&format!("https://shop.example/api/search?q={w}"), &feed(w, kinds));
            e.response_mime = "application/rss+xml".into();
            Trace { exchanges: vec![e], inputs: Vec::new() }
        };
        let (first, second) = (xml("brass", ["lamp news", "knocker story", "holder report", "frame review"]), xml("glass", ["bowl news", "jar story", "vase report", "carafe review"]));
        let mut r = route();
        r.graph.steps[0].exchange = 0;
        let answer = unbrowse_learn::answer::data_of(&second.exchanges[0], None).unwrap();
        assert_eq!(compared(Some(&first), &r, Ok(&answer), &second, &glass()), Confirmed::Agreed);
    }

    /// A confirming browse saw the records of a results page's state under a key the site writes the search into:
    /// the place is kept by the keys' names, so another value's answer holds it (an empty list there is the site
    /// finding nothing), and an answer that holds only the page's title, or the session's earlier searches, lacks it.
    #[test]
    fn an_answer_without_the_place_its_records_were_seen_at_holds_none() {
        let results = |w: &str, n: usize| serde_json::json!({ "STATE": { format!("search({{\"input\":{{\"text\":\"{w}\"}}}})"): { "results": (0..n).map(|k| serde_json::json!({ "name": format!("{w} stay {k}") })).collect::<Vec<_>>() }, "meta": { "title": format!("Stays in {w}") } } });
        let place = records_place(&results("osaka", 6), &["osaka".into()]).expect("a place");
        assert_eq!(place, "STATE/search/results");
        let mut r = route();
        assert!(!lacks_its_records(&r, &serde_json::json!({})), "a route with no place seen lacks nothing");
        r.heard.records_at = Some(place);
        assert!(!lacks_its_records(&r, &results("tokyo", 6)));
        assert!(!lacks_its_records(&r, &results("zqxv", 0)), "an empty list there is the site finding nothing");
        assert!(lacks_its_records(&r, &serde_json::json!({ "STATE": { "meta": { "title": "Stays in tokyo" } } })), "only the title");
        assert!(lacks_its_records(&r, &serde_json::json!({ "STATE": { "earlier": [{ "name": "osaka" }, { "name": "tokyo" }] } })), "the session's earlier searches");
        assert_eq!(records_place(&serde_json::json!({ "title": "osaka" }), &["osaka".into()]), None, "no records, no place");
    }

    /// A route whose records were seen at a place (a results page's state) is asked a value the site has nothing for:
    /// the page's state still holds its copy, its filters (a list of named things, the same for every value) and names the value in its heading, its crumbs and its box, with an empty list where the records
    /// were. That answer found nothing: the verdict cannot tell, the browser's walk is one that found nothing, so the
    /// route that stands is kept and nothing learned from that walk takes its place (`first_stands`). Before, the
    /// copy's words read as records and the value said back twice: agreed, and a route of the copy stood.
    #[test]
    fn an_answer_with_nothing_where_the_routes_records_were_seen_cannot_tell() {
        let state = |w: &str, n: usize| {
            serde_json::json!({ "STATE": {
                // Other stays for another value, not the same names with the value swapped.
                "search": { "results": (0..n).map(|k| serde_json::json!({ "name": format!("{w} {} {k}", if w == "brass" { ["harbour flat", "old town loft", "river house"][k % 3] } else { ["garden suite", "hill cabin", "station hostel"][k % 3] }) })).collect::<Vec<_>>() },
                "copy": { "a": { "label": "Where are you going next" }, "b": { "label": "Deals for the weekend away" }, "c": { "label": "Sign in and save money" } },
                "filters": [{ "name": "Free cancellation" }, { "name": "Breakfast included" }, { "name": "Swimming pool" }],
                "searched": { "text": format!("stays for {w}"), "heading": format!("Your search for {w}"), "crumb": format!("Home > Search > {w}"), "box": format!("Destination: {w}"), "share": format!("Share your search for {w} with friends") },
                "meta": { "title": format!("Stays matching {w}") } } })
        };
        let at = |w: &str, n: usize| Trace { exchanges: vec![call(&format!("https://shop.example/api/search?q={w}"), &state(w, n).to_string())], inputs: Vec::new() };
        let mut r = route();
        r.heard.records_at = records_place(&state("brass", 6), &["brass".into()]);
        assert_eq!(r.heard.records_at.as_deref(), Some("STATE/search/results"));
        let word = "qzxvorb";
        let (first, second) = (at("brass", 6), at(word, 0));
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        assert!(nothing_at_its_records(&r, &state(word, 0)) && !nothing_at_its_records(&r, &state("glass", 6)));
        assert_eq!(compared(Some(&first), &r, Ok(&state(word, 0)), &second, &asked), Confirmed::CannotTell { why: NO_RECORDS.into() });
        assert!(sighting_found_nothing(Some(&first), &r, &second, &asked), "the browser's walk for the value found nothing");
        // A route of one sighting, with no records place yet: the first walk's records named its value, and this answer
        // names none: it found nothing too.
        assert_eq!(compared(Some(&first), &route(), Ok(&state(word, 0)), &second, &asked), Confirmed::CannotTell { why: NO_RECORDS.into() });
        // Another value with records of its own still agrees.
        assert_eq!(compared(Some(&first), &r, Ok(&state("glass", 6)), &at("glass", 6), &glass()), Confirmed::Agreed);
    }

    /// The route and the browser both answered a word nobody searches for with empty lists and not one line of their
    /// own: that is no difference, and the verdict cannot tell. An empty answer beside the browser's records differs.
    #[test]
    fn an_empty_answer_beside_an_empty_walk_cannot_tell() {
        let word = "qzxvorb";
        let empty = serde_json::json!({ "accounts": [], "statuses": [], "hashtags": [] });
        let mut second = walk(word, false);
        second.exchanges.push(call(&format!("https://shop.example/api/search?q={word}"), &empty.to_string()));
        let asked = HashMap::from([("q".to_string(), word.to_string())]);
        assert_eq!(compared(Some(&walk("brass", true)), &route(), Ok(&empty), &second, &asked), Confirmed::CannotTell { why: NO_RECORDS.into() });
        assert!(matches!(compared(Some(&walk("brass", true)), &route(), Ok(&empty), &walk("glass", true), &glass()), Confirmed::Differed { .. }));
    }

    /// A route learned on a two-word value, and the browser's walk and the route's call for another two-word value: the
    /// feed's items say `word` (its first word) and never the value whole, as a news search reads a value word by word.
    fn word_feed(word: &str, kinds: [&str; 4]) -> Trace {
        let items: String = (0..8).map(|n| format!("<item><title>{word} {} {n}</title><link>https://news.example/{word}/{n}</link></item>", kinds[n % 4])).collect();
        let mut e = call(&format!("https://shop.example/api/search?q={word}"), &format!("<?xml version=\"1.0\"?><rss><channel><title>News</title>{items}</channel></rss>"));
        e.response_mime = "application/rss+xml".into();
        Trace { exchanges: vec![e], inputs: Vec::new() }
    }

    fn two_words(was: &str) -> Route {
        let mut r = route();
        r.graph.steps[0].exchange = 0;
        r.inputs[0].default = Some(was.into());
        r
    }

    /// A search that reads its value word by word answers with records saying the words that tell the value from the
    /// one the route was learned on ("zig" for "zig compiler"), seldom the value whole: those records, at the place the
    /// browser's walk holds them, say it back, and the route that answers what the browser got is confirmed. Before, only
    /// a line holding the value whole counted, and a news feed's confirmed route was browsed for such a value. The
    /// place the confirm keeps is read by the same words.
    #[test]
    fn a_search_read_word_by_word_says_the_value_back_by_its_records() {
        let first = word_feed("rust", ["release notes", "safety story", "compiler report", "crate review"]);
        let second = word_feed("zig", ["release notes", "build story", "allocator report", "linker review"]);
        let route = two_words("rust language");
        let asked = HashMap::from([("q".to_string(), "zig compiler".to_string())]);
        let answer = unbrowse_learn::answer::data_of(&second.exchanges[0], None).unwrap();
        assert_eq!(compared(Some(&first), &route, Ok(&answer), &second, &asked), Confirmed::Agreed);
        assert_eq!(compared(None, &route, Ok(&answer), &second, &asked), Confirmed::Agreed, "where the first walk is gone");
        let telling = telling_words(&["zig compiler".into()], &["rust language".into()]);
        assert_eq!(telling, vec!["zig compiler", "zig", "compiler"]);
        assert_eq!(records_place(&answer, &telling).as_deref(), Some("records"));
    }

    /// A word the asked value shares with the one the route was learned on tells nothing, and a list that names it is no
    /// list of the value's records: the route and the browser both answer with a strip of the site's own offers, each
    /// naming "hotels", for "tokyo hotels" after "osaka hotels". It is not confirmed, and says so as before; nor is a
    /// list where only one record of many names the new word.
    #[test]
    fn a_wrong_answer_sharing_one_word_with_the_asked_value_still_differs() {
        let offers = serde_json::json!({ "offers": (0..8).map(|n| serde_json::json!({ "id": n, "title": format!("Hotels near you, deal {n}") })).collect::<Vec<_>>() });
        let mut second = walk("tokyo hotels", false);
        second.exchanges.push(call("https://shop.example/api/search?q=tokyo+hotels", &offers.to_string()));
        let route = two_words("osaka hotels");
        let asked = HashMap::from([("q".to_string(), "tokyo hotels".to_string())]);
        let never = Confirmed::Differed { why: "the route's answer never says the new value back".into() };
        assert_eq!(compared(None, &route, Ok(&offers), &second, &asked), never);
        let once = serde_json::json!({ "offers": (0..8).map(|n| serde_json::json!({ "id": n, "title": if n == 3 { "Tokyo hotels deal".to_string() } else { format!("Hotels near you, deal {n}") } })).collect::<Vec<_>>() });
        let mut third = walk("tokyo hotels", false);
        third.exchanges.push(call("https://shop.example/api/search?q=tokyo+hotels", &once.to_string()));
        assert_eq!(compared(None, &route, Ok(&once), &third, &asked), never, "one record of eight");
        assert!(!telling_words(&["tokyo hotels".into()], &["osaka hotels".into()]).contains(&"hotels".to_string()));
    }

    /// Calls first: the route of one sighting is called for the new value, and its answer is held to what a
    /// confirming browse holds it to, with no page loaded. Its first sighting's answer is kept by its lines' marks
    /// (`sighted`). A call answering the new value's records, saying it back by them, stands: it is the route's second
    /// sighting. One answering the first value's records again (a call deaf to its caller) is in doubt, and so is a
    /// strip of the site's own offers naming a word both values share, or an answer that lists nothing: the browser
    /// serves those.
    #[test]
    fn a_call_for_the_new_value_stands_on_its_own_answer_or_goes_to_the_browser() {
        store::scratch_home("calls-first");
        let route = route();
        super::super::sighted::called(&route, &HashMap::new(), Some(&records("brass")), true, 40, 0);
        assert!(super::super::sighted::first_answer(&route).is_some(), "the first sighting's answer is kept by mark");
        let (place, said) = by_its_call(&route, &glass(), &records("glass")).expect("the new value's own records stand");
        assert_eq!((place.as_deref(), said.as_str()), (Some("results"), "glass"));
        assert_eq!(by_its_call(&route, &glass(), &records("brass")), Err("its answer is the first value's records again".into()), "deaf: the first value's records");
        let offers = serde_json::json!({ "offers": (0..8).map(|n| serde_json::json!({ "id": n, "title": format!("Hotels near you, deal {n}") })).collect::<Vec<_>>() });
        let mut hotels = route.clone();
        hotels.inputs[0].default = Some("osaka hotels".into());
        let asked = HashMap::from([("q".to_string(), "tokyo hotels".to_string())]);
        assert!(by_its_call(&hotels, &asked, &offers).is_err(), "a strip naming only the word both values share");
        assert!(by_its_call(&route, &glass(), &serde_json::json!({ "query": "glass", "results": [] })).is_err(), "nothing found");
    }

    /// A page's state says its menus, its footer and its translations again for every value: thousands of values beside
    /// a few records. A call whose records say the new value back is not the first value's answer again, however much
    /// of the page around them is; one whose records are still the first value's is.
    #[test]
    fn records_that_say_the_new_value_back_are_not_the_first_answer_again_however_big_the_page_around_them() {
        store::scratch_home("calls-first-page-state");
        let frame: serde_json::Map<String, serde_json::Value> = (0..400).map(|n| (format!("label_{n}"), serde_json::json!(format!("Menu entry {n}")))).collect();
        let page = |word: &str| {
            let mut answer = records(word);
            answer["translations"] = serde_json::Value::Object(frame.clone());
            answer
        };
        let route = route();
        super::super::sighted::called(&route, &HashMap::new(), Some(&page("brass")), true, 40, 0);
        assert!(by_its_call(&route, &glass(), &page("glass")).is_ok(), "the new value's records, in the same page");
        assert_eq!(by_its_call(&route, &glass(), &page("brass")), Err("its answer is the first value's records again".into()), "deaf: the first value's records, in the same page");
    }

    /// A page read whole holds its results among the links of its frame (its menus, its footer, the rest of the site),
    /// the same links for every value: a hundred beside eight results, so fewer than half its links name the value
    /// whatever it found. Its own records are the links the first value's page did not hold: where those name the new
    /// value, the call says it back by its records and stands, with no browser. Live, a location search's page (8
    /// results among 112 links) and a site search's (26 among 150) went to the browser for every second value, and the
    /// browser's walk replaced the route. The first value's page again, or the frame alone, is still in doubt.
    #[test]
    fn a_pages_own_records_say_the_new_value_back_among_the_links_of_its_frame() {
        store::scratch_home("calls-first-page-frame");
        let frame: Vec<serde_json::Value> = (0..100).map(|n| serde_json::json!({ "text": format!("Site section {n}"), "url": format!("https://shop.example/section/{n}") })).collect();
        let page = |word: &str, found: usize| {
            let mut links = frame.clone();
            links.extend((0..found).map(|n| serde_json::json!({ "text": format!("{word} place {n}, region {n}"), "url": format!("https://shop.example/place?key={word}-{n}") })));
            serde_json::json!({ "title": "Find your place | Shop", "text": format!("Results for {word}\nSite section 1\nSite section 2"), "links": links })
        };
        let route = route();
        super::super::sighted::called(&route, &HashMap::new(), Some(&page("brass", 8)), true, 40, 0);
        let (naming, all) = naming_at(&page("glass", 8), "links", &["glass".into()]);
        assert!(naming * 2 < all, "the frame drowns the page's own records: {naming} of {all}");
        let (place, said) = by_its_call(&route, &glass(), &page("glass", 8)).expect("the page's own records name the new value");
        assert_eq!((place.as_deref(), said.as_str()), (Some("links"), "glass"));
        assert_eq!(by_its_call(&route, &glass(), &page("brass", 8)), Err("its answer is the first value's records again".into()), "deaf: the first value's page");
        assert!(by_its_call(&route, &glass(), &page("glass", 0)).is_err(), "the frame alone, the value said only in its heading");
        assert!(by_its_call(&route, &glass(), &page("glass", 1)).is_err(), "one record of its own is no list of them");
    }

    /// A value that names a thing (an id: a digit in it) is said back by the thing's own record once: such an answer
    /// stands where its lines are not the first sighting's, and is in doubt where they are, or where no first answer is
    /// kept to tell it from.
    #[test]
    fn a_call_for_another_thing_stands_where_its_record_is_not_the_first_ones() {
        store::scratch_home("calls-first-thing");
        let invite = |code: &str, name: &str, members: u32| serde_json::json!({ "code": code, "guild": { "id": format!("10{members}"), "name": name, "member_count": members }, "channel": { "name": format!("{name}-welcome") } });
        let mut route = route();
        route.id = "thing".into();
        route.inputs[0].default = Some("Qx7Lm2Pa".into());
        let asked = HashMap::from([("q".to_string(), "Rt5Wn8Kd".to_string())]);
        assert!(by_its_call(&route, &asked, &invite("Rt5Wn8Kd", "Harbour", 4211)).is_err(), "no first answer kept");
        super::super::sighted::called(&route, &HashMap::new(), Some(&invite("Qx7Lm2Pa", "Kilns", 912)), true, 40, 0);
        assert!(by_its_call(&route, &asked, &invite("Rt5Wn8Kd", "Harbour", 4211)).is_ok(), "another thing's record");
        assert!(by_its_call(&route, &asked, &invite("Qx7Lm2Pa", "Kilns", 912)).is_err(), "the first thing's record again");
    }

    /// A route whose answers say little in words is held to what they say: its values. A package's downloads by day (a
    /// name, then a day and a count a day) and a company's statement (figures, and no name) said one line of words or
    /// none, and read by their lines two such answers for two values were "the same", though both were right (live).
    /// By what they say they differ. The downloads stand by their records; the statement names no value and holds no
    /// list of records to be told by, and stays in doubt. A page of records replayed as it was walked (a call whose page-signed
    /// step made no call and answered the first value's page) says what the first said, a clock reading aside: in doubt.
    #[test]
    fn a_short_answer_for_another_value_is_another_answer() {
        store::scratch_home("calls-first-short");
        let downloads = |package: &str, from: u32, base: u32| serde_json::json!({ "start": format!("2026-09-{from:02}"), "end": "2026-09-30", "package": package,
            "downloads": (0..10).map(|d| serde_json::json!({ "day": format!("2026-09-{:02}", from + d), "downloads": base + d * 37 })).collect::<Vec<_>>() });
        let mut counts = route();
        counts.id = "counts".into();
        counts.inputs[0].default = Some("2025-05-01:2026-10-29".into());
        super::super::sighted::called(&counts, &HashMap::new(), Some(&downloads("kettlejs", 1, 1200)), true, 40, 0);
        let next = HashMap::from([("q".to_string(), "2026-09-01:2026-09-30".to_string())]);
        assert!(by_its_call(&counts, &next, &downloads("teapotdb", 11, 98_000)).is_ok(), "another package's days");
        assert_eq!(by_its_call(&counts, &next, &downloads("kettlejs", 1, 1200)), Err("its answer is the first value's records again".into()));
        let statement = |base: f64| serde_json::json!({ "period": "Annual statement", "Operating Income": (0..11).map(|y| format!("{:.2}", base - y as f64 * 4_311.0)).collect::<Vec<_>>(), "Net Income": (0..11).map(|y| format!("{:.2}", base * 0.8 - y as f64 * 3_907.0)).collect::<Vec<_>>() });
        let mut figures = route();
        figures.id = "figures".into();
        figures.inputs[0].default = Some("KTTL".into());
        super::super::sighted::called(&figures, &HashMap::new(), Some(&statement(158_063.0)), true, 40, 0);
        let other = HashMap::from([("q".to_string(), "TPOT".to_string())]);
        // Named by neither, and no records to tell them by (lists of figures, no list of records): in doubt, the
        // browser serves it. A right answer browsed is a cost; a wrong one served warm is not shipped.
        assert!(by_its_call(&figures, &other, &statement(163_191.0)).is_err(), "figures and no records: in doubt");
        assert!(by_its_call(&figures, &other, &statement(158_063.0)).is_err(), "the first company's figures again");
        let page = |moved: &str| {
            let mut v = records("brass");
            v["results"][3]["title"] = serde_json::json!(moved);
            v["elapsed_ms"] = serde_json::json!(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64);
            v
        };
        let mut replayed = route();
        replayed.id = "replayed".into();
        let mut first = records("brass");
        first["results"] = serde_json::Value::Array((0..40).map(|n| serde_json::json!({ "id": n, "title": format!("brass record number {n}") })).collect());
        super::super::sighted::called(&replayed, &HashMap::new(), Some(&first), true, 40, 0);
        let mut again = page("brass record moved");
        again["results"] = first["results"].clone();
        again["results"][3]["title"] = serde_json::json!("brass record moved");
        assert_eq!(by_its_call(&replayed, &glass(), &again), Err("its answer is the first value's records again".into()), "39 of 40 records, a clock reading aside");
    }

    /// A value written in the site's search syntax (`repo:owner/name`) is said back by its terms as the answer writes
    /// them (its full name, its address), never by the expression whole: a narrower query's one record stood unsaid
    /// (live). A value of plain words has no terms, and is read by its words as before.
    #[test]
    fn a_value_in_a_search_syntax_is_said_back_by_its_terms() {
        store::scratch_home("calls-first-terms");
        let repo = |full: &str, stars: u32| serde_json::json!({ "full_name": full, "name": full.rsplit('/').next().unwrap(), "html_url": format!("https://code.example/{full}"), "description": format!("the {full} project"), "stargazers_count": stars });
        let mut search = route();
        search.id = "terms".into();
        search.inputs[0].default = Some("repo:kilnworks/glaze repo:harbour/rigging".into());
        super::super::sighted::called(&search, &HashMap::new(), Some(&serde_json::json!({ "total_count": 2, "items": [repo("kilnworks/glaze", 5120), repo("harbour/rigging", 880)] })), true, 40, 0);
        let narrower = HashMap::from([("q".to_string(), "repo:kilnworks/glaze".to_string())]);
        assert!(by_its_call(&search, &narrower, &serde_json::json!({ "total_count": 1, "items": [repo("kilnworks/glaze", 5133)] })).is_ok());
        assert_eq!(terms_of("repo:kilnworks/glaze user:harbour"), Some(vec!["kilnworks/glaze".to_string(), "harbour".to_string()]));
        assert_eq!(terms_of("tokyo hotels"), None);
    }

    /// A route whose first answer never said its value is held to its records alone, never its whole answer: a page's
    /// frame answers every value with the same records beside what it changes on each load (a token, ids made of the
    /// time, one promotion rotated into its list), and that is the first value's answer again: in doubt. The same route
    /// whose records themselves differ stands. (The project's worst incident was a frame served warm as another
    /// value's answer.)
    #[test]
    fn a_frame_that_changes_on_each_load_is_never_another_values_answer() {
        store::scratch_home("calls-first-frame");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let frame = |token: &str, at: u64, promo: &str, items: &[&str]| {
            let mut list: Vec<serde_json::Value> = items.iter().enumerate().map(|(n, t)| serde_json::json!({ "id": at + n as u64, "title": t, "price": 20 + n, "shelf": "picks" })).collect();
            list.push(serde_json::json!({ "id": at + 99, "title": promo, "price": 1, "shelf": "picks" }));
            serde_json::json!({ "session": token, "rendered_at": at, "strip": { "banner": promo }, "items": list })
        };
        let picks = ["Garden chair", "Desk fan", "Wall clock", "Bread bin", "Tea towel", "Plant pot", "Door mat", "Lamp shade", "Coat hook", "Step stool"];
        let mut route = route();
        route.id = "frame".into();
        super::super::sighted::called(&route, &HashMap::new(), Some(&frame("tok-a1", now, "Half price rugs", &picks)), true, 40, 0);
        let again = frame("tok-z9", now + 5_000, "Free delivery week", &picks);
        assert!(by_its_call(&route, &glass(), &again).is_err(), "the same records beside a new token, new times, one rotated promotion");
        let other = ["Mixing bowl", "Storage jar", "Flower vase", "Water carafe", "Butter dish", "Salt cellar", "Milk jug", "Sugar bowl", "Cake stand", "Gravy boat"];
        assert!(by_its_call(&route, &glass(), &frame("tok-z9", now + 5_000, "Free delivery week", &other)).is_ok(), "other records");
    }

    /// The incident's shape, from the matrix's unknown-frame page: for a value the site holds nothing for, the page's
    /// state says the value back in its heading, its crumb, its box and its share link, beside its filters and an
    /// empty list where the records were. The route's call for it says the value back on four lines and holds no
    /// record of it: in doubt, never served warm. A real value's records stand.
    #[test]
    fn a_page_that_says_the_value_back_only_in_its_copy_is_in_doubt() {
        store::scratch_home("calls-first-copy");
        let state = |q: &str, found: bool| {
            let results: Vec<serde_json::Value> = if found { ["enamel stovetop model", "brushed steel classic", "glass electric with light", "copper camping edition"].iter().map(|k| serde_json::json!({ "title": format!("{q} {k}"), "price": 12, "seller": "The shop's own range of things for the kitchen" })).collect() } else { Vec::new() };
            serde_json::json!({ "search": { "query": q, "results": results }, "filters": [{ "name": "Free returns" }, { "name": "In stock" }, { "name": "On sale today" }],
                "said": { "heading": format!("Results for {q}"), "crumb": format!("Home > Search > {q}"), "box": format!("You searched for {q}"), "share": format!("Share your search for {q}") } })
        };
        let mut route = route();
        route.id = "copy".into();
        route.inputs[0].default = Some("kettle".into());
        super::super::sighted::called(&route, &HashMap::new(), Some(&state("kettle", true)), true, 40, 0);
        let unknown = HashMap::from([("q".to_string(), "qzxvorb".to_string())]);
        assert!(by_its_call(&route, &unknown, &state("qzxvorb", false)).is_err());
        let teapot = HashMap::from([("q".to_string(), "teapot".to_string())]);
        assert!(by_its_call(&route, &teapot, &state("teapot", true)).is_ok());
    }

    /// A search's value with a number in it (`apollo 13`) is a search's words, not a thing's id: the call that answered
    /// with the first value's records again, more of them than the first answer held (a page-signed call that took
    /// another visit's request, live), says none of its records for it and is in doubt. One token with a digit (an id)
    /// still names a thing.
    #[test]
    fn words_beside_a_number_are_a_search_not_a_things_id() {
        store::scratch_home("calls-first-number");
        let page = |w: &str, n: usize| serde_json::json!({ "hits": (0..n).map(|k| serde_json::json!({ "identifier": format!("{}-reel-{k}", w.replace(' ', "-")), "title": format!("{w} mission reel {k}") })).collect::<Vec<_>>() });
        let mut search = route();
        search.id = "number".into();
        search.inputs[0].default = Some("apollo 11".into());
        super::super::sighted::called(&search, &HashMap::new(), Some(&page("apollo 11", 50)), true, 40, 0);
        let thirteen = HashMap::from([("q".to_string(), "apollo 13".to_string())]);
        assert!(by_its_call(&search, &thirteen, &page("apollo 11", 100)).is_err(), "the first value's records, more of them");
        assert!(by_its_call(&search, &thirteen, &page("apollo 13", 100)).is_ok(), "its own records");
    }

    /// The verdict is named by its own word, with its why where it has one.
    #[test]
    fn a_verdict_is_said_by_its_word_and_its_why() {
        let said = |v: Confirmed| (v.word(), v.said());
        assert_eq!(said(Confirmed::Agreed), ("agreed", "agreed".to_string()));
        assert_eq!(said(Confirmed::Differed { why: "other records".into() }), ("differed", "differed: other records".to_string()));
        assert_eq!(said(Confirmed::Failed { why: "403".into() }), ("failed", "failed: 403".to_string()));
        assert_eq!(said(Confirmed::CannotTell { why: "no records".into() }), ("cannot-tell", "cannot-tell: no records".to_string()));
    }

    /// A kept walk says what a confirming browse would: the route's call answered as the second walk recorded it,
    /// held against the first; a walk that holds no such call is a call that failed, not a disagreement.
    #[test]
    fn a_kept_walk_says_what_a_confirming_browse_would_say_of_the_route() {
        let first = walk("brass", true);
        assert_eq!(as_a_kept_walk_says(&first, &route(), &walk("glass", true), &glass()), Confirmed::Agreed);
        assert_eq!(as_a_kept_walk_says(&first, &route(), &walk("glass", false), &glass()), Confirmed::Failed { why: "the recording holds no such call".into() });
        let given = HashMap::from([("q".to_string(), "brass".to_string())]);
        assert!(matches!(compared(Some(&first), &route(), Ok(&records("brass")), &first, &given), Confirmed::Differed { why } if why.contains("no value other")), "the value the route was learned on is no new value");
    }

    /// The first walk of a page is the newest other walk of it that made the route's call: a later walk of the page
    /// that made another call is not it, and with none the browse has no first walk to hold the second beside.
    #[test]
    fn the_first_walk_is_the_newest_other_walk_that_made_the_routes_call() {
        let held = |trace: Trace, url: &str, age: u64| crate::learn::Walk { url: url.into(), trace, probes: Vec::new(), recording: None, at: std::time::Instant::now() - std::time::Duration::from_secs(age), addresses: None };
        let walks = Walks::default();
        walks.0.locked().insert("second".into(), held(walk("glass", true), "https://shop.example/search?q=glass", 1));
        assert!(first_walk(&walks, "second", "https://shop.example/search?q=glass", &route()).is_none(), "no other walk");
        walks.0.locked().insert("elsewhere".into(), held(walk("iron", false), "https://shop.example/search?q=iron", 5));
        assert!(first_walk(&walks, "second", "https://shop.example/search?q=glass", &route()).is_none(), "a walk that made another call");
        walks.0.locked().insert("first".into(), held(walk("brass", true), "https://shop.example/search?q=brass", 20));
        let found = first_walk(&walks, "second", "https://shop.example/search?q=glass", &route()).expect("the first walk");
        assert_eq!(found.exchanges[1].url.query(), Some("q=brass"));
    }

    /// A place is followed down the lists and the keys of an answer by name: how many records are there, whether there
    /// is one, and how many of them name a word.
    #[test]
    fn a_place_is_followed_down_lists_and_keys() {
        let answer = serde_json::json!({ "query": "x", "groups": [{ "items": [{ "t": "brass lamp" }, { "t": "glass jar" }] }, { "items": [{ "t": "brass bell" }] }, { "other": 1 }] });
        let empty = serde_json::json!({ "query": "x", "groups": [{ "items": [] }, { "items": [] }] });
        assert_eq!(count_at(&answer, "groups/[]/items"), Some(3));
        assert_eq!(count_at(&answer, "groups/[]/nothing"), None);
        assert_eq!(count_at(&empty, "groups/[]/items"), Some(0));
        assert_eq!(at_place(&answer, "groups/[]/items"), Some(true));
        assert_eq!(at_place(&empty, "groups/[]/items"), Some(false), "there, and empty");
        assert_eq!(at_place(&answer, "groups/[]/nothing"), None);
        assert_eq!(naming_at(&answer, "groups/[]/items", &["brass".to_string()]), (2, 3));
        assert_eq!(naming_at(&answer, "groups/[]/nothing", &["brass".to_string()]), (0, 0));
    }

    /// A route a confirming browse gave way to the route of two sightings is retired for it, once; one that is not in the
    /// store gives way to nothing.
    #[test]
    fn the_route_of_one_sighting_gives_way_to_the_route_of_two_once() {
        let home = store::scratch_home("confirm-gives-way");
        store::use_home(&home);
        let (once, twice) = (sighted("gives-once", 1), sighted("gives-twice", 2));
        for r in [&once, &twice] {
            store::save_route(r).unwrap();
        }
        assert!(gives_way(&once, &twice));
        assert!(store::load_route("gives-once").is_none());
        assert_eq!(store::took_the_place_of("gives-once").map(|r| r.id), Some("gives-twice".to_string()));
        assert!(!gives_way(&once, &twice), "already retired: nothing to give way");
    }

    /// An answer that holds only records the first walk's answer held too, with that answer holding many more of its
    /// own (a feed of every value), is the feed's frame and found nothing: it cannot tell.
    #[test]
    fn an_answer_that_is_a_part_of_the_first_walks_feed_cannot_tell() {
        let feed = |words: &[&str]| {
            let rows: Vec<serde_json::Value> = words.iter().flat_map(|w| (0..8).map(move |n| serde_json::json!({ "id": n, "title": format!("{w} {} number {n}", ["table lamp", "door knocker", "candle holder", "picture frame"][n % 4]) }))).collect();
            serde_json::json!({ "query": "everything", "results": rows })
        };
        let mut first = walk("brass", false);
        first.exchanges.push(call("https://shop.example/api/search?q=brass", &feed(&["brass", "glass"]).to_string()));
        let mut second = walk("glass", false);
        second.exchanges.push(call("https://shop.example/api/search?q=glass", &feed(&["glass"]).to_string()));
        let verdict = compared(Some(&first), &route(), Ok(&feed(&["glass"])), &second, &glass());
        assert_eq!(verdict, Confirmed::CannotTell { why: NO_RECORDS.into() });
    }

    /// A confirming browse of a page the node never walks (not a web page) learns nothing, and says so as the walk
    /// failed.
    #[test]
    fn a_confirming_browse_of_a_page_that_is_never_walked_learns_nothing() {
        let walks = Walks::default();
        let verdict = confirm_by_use(&walks, "ftp://shop.example/search?q=glass", "search", "You", &route(), &glass(), None);
        assert!(matches!(verdict, Err(Unlearned::Unwalkable(_))), "{:?}", verdict.map(|c| c.verdict));
    }
}
