//! The expressions that rebuild each place of a call on every sighting of it.
//!
//! For each place a request sends a value, candidate expressions are proposed from what each walk held when the
//! call was made: what the page was asked, the cookies the request carried, the replies before it, the clock. A
//! candidate is kept only if the body's own evaluator, given one sighting's world, makes the value that sighting
//! sent, for every sighting ([`Lab::rebuilds`]). So what the learner believes a way does and what a call will do
//! with it are the same code, and a wrong candidate costs nothing: no site is asked.
//!
//! What moved between the sightings decides what can be said. A value the same on walks for two words is not the
//! word's. Whether it is fixed for everyone or this session's alone, walks that share a session cannot say, and the
//! hole says so ([`Hole::axes`]) and keeps what one walk would have tied it to ([`Hole::tied`]).
//!
//! A value that moves on every sighting and that nothing above makes may be a digest of the request itself: the
//! engine's search for a signature's parts (`signing::fit_by_search`) proposes which, and the candidate is held to
//! each sighting's own request exactly as the filler holds a request while it signs it.

use std::cell::RefCell;
use std::collections::HashMap;

use unbrowse_route as route;
use unbrowse_route::{Expr, How, Outcome, Way};

use crate::graph::Wrap;
use crate::lab::sighting::{axes, pairs, Axes, Walk};
use crate::provenance::{a_plain_word, extract, find_origin_on, MIN_TRACEABLE};
use crate::replay::Request;
use crate::signing::Sighting;
use crate::slots::{bound_by_key, Loc, Slot};
use crate::trace::Exchange;

/// What a place of a call turned out to be.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Kind {
    /// The same on every sighting.
    Fixed,
    /// What the page was asked, or made from it.
    Callers,
    /// The session's: a cookie, or a value that is one.
    Session,
    /// Read from an earlier reply, at the same place on every walk.
    Read,
    /// A reading of the clock.
    Clock,
    /// A digest of parts of its own request and of the session, made anew for every call once the rest of the
    /// request is built.
    Digest,
    /// A program of the site's own code, cut from the script that sent the call and run in the sandbox
    /// (`learn.isolate`): what no standard operation and no digest search reproduces.
    Function,
    /// Picked from a list an earlier reply gave: the place inside the item of the list that fits, on every walk.
    Pick,
    /// A header the browser writes by itself (its hints, its fetch metadata), which moved between the walks as the
    /// browser's own state did. It is sent as the walk's browser sent it.
    Browsers,
    /// It moved, and nothing the walks show makes it.
    Open,
}

/// A place of a call, across its sightings.
#[derive(Clone, Debug)]
pub struct Hole {
    pub at: Loc,
    /// What each walk's sighting sent here. None for a walk that never made the call, or made it without this place.
    pub sent: Vec<Option<String>>,
    pub kind: Kind,
    /// The ways that rebuild the value on every sighting, cheapest first. An open hole has none, or the one way the
    /// first walk alone reads it as the caller's, which the other walks do not bear out.
    pub ways: Vec<Way>,
    /// For a value the sightings sent the same: the earlier reply one walk shows holding it. One walk would tie the
    /// value to that reply; the walks that agree on it cannot say the tie is real.
    pub tied: Option<Expr>,
    /// What differed between the sightings this was seen on.
    pub axes: Axes,
    /// Where more than one reading of the caller's value rebuilds every sighting and they part on another value (a
    /// day of twelve or less read as a day or as a month): every reading, and the value a next walk is to be asked so
    /// the site says which ([`crate::lab::forms::Left`]). The hole's first way is the first of them until then.
    pub left: Option<crate::lab::forms::Left>,
}

/// How a caller's value may be written where it sits, plainest first.
const HOWS: [How; 7] = [How::Plain, How::Percent, How::Plus, How::Lower, How::Upper, How::Dashed, How::Json];

/// The ways a caller's value may be written where it sits, the plainest first: as it is, each one way of writing,
/// then one way after another (a page that reads a word off its own address as the address writes it, and encodes
/// that again, sends it written twice). Which one a place uses is never assumed: each is a candidate, and stands
/// only if it makes what every sighting sent.
fn writings() -> Vec<Vec<How>> {
    let mut out: Vec<Vec<How>> = HOWS.iter().map(|how| if *how == How::Plain { Vec::new() } else { vec![*how] }).collect();
    for outer in HOWS.iter().filter(|h| **h != How::Plain) {
        for inner in HOWS.iter().filter(|h| **h != How::Plain && *h != outer) {
            out.push(vec![*inner, *outer]);
        }
    }
    out
}

/// `value` written each of `hows` in turn.
fn written(value: &str, hows: &[How]) -> String {
    hows.iter().fold(value.to_string(), |v, how| how.write(&v))
}

/// `expr` written each of `hows` in turn.
fn written_as(expr: Expr, hows: &[How]) -> Expr {
    hows.iter().fold(expr, |of, how| Expr::Written { of: Box::new(of), how: *how })
}

/// The fewest zeros a searched-for count's digest must open with on every sighting to be read as a search: three
/// hexadecimal digits each, which chance gives one candidate in 4096 a sighting, and two sightings in some sixteen
/// million.
const MIN_ZEROS: u32 = 3;

/// The most cookies a cut function's reading of `document.cookie` is shrunk over, one left out at a time: a jar past
/// this is fed whole.
const MOST_COOKIE_READS: usize = 16;

/// How far a clock's reading in a request may be from the date its reply carries: the page's clock and the
/// server's differ by a little, and a page reads its clock a while before it sends.
const NEAR_MS: u64 = 300_000;

/// One walk's sighting of the call.
struct Seen<'a> {
    /// Which walk.
    walk: usize,
    /// Where in that walk.
    at: usize,
    exchange: &'a Exchange,
    slots: Vec<Slot>,
}

/// The walks of one learn, and where each made the calls of the first.
pub struct Lab<'a> {
    pub walks: &'a [Walk<'a>],
    /// Where each other walk made each call of the first ([`pairs`]), read once per walk.
    paired: RefCell<HashMap<usize, HashMap<usize, usize>>>,
    /// Each reply's JSON (`Exchange::own_json`), by walk and place, read once.
    json: RefCell<HashMap<(usize, usize), Option<std::rc::Rc<serde_json::Value>>>>,
    /// The string literals of the script that sent the call being compiled, with that script's SHA-256: candidate
    /// constants for a digest of that one call (`reading`). Empty unless the caller read the walk's recording.
    literals: Vec<String>,
    sender_sha: Option<String>,
    /// The index, in the first walk, of the call the literals are the sender script's of: a digest of another call
    /// is not offered them.
    target_at: Option<usize>,
    /// The frame the recording says sent the target call ([`recording::Recording::sent_by_value`]), and the scripts
    /// the walk fetched, by url: a header no expression and no digest makes, that this frame's own function set, is
    /// cut from these and run ([`Lab::program`]). None when the walk kept no recording.
    sender: Option<crate::signing::Producer>,
    scripts: Vec<(String, String)>,
    /// What each walk's page kept in its storage, by walk, where the walk's recording says ([`Lab::storing`], [`Lab::stored`]). A walk
    /// with none known holds nothing a stored value could be read from.
    storage: Vec<Option<crate::sandbox::Storage>>,
    /// The tables the script that sent the target call ships (`slice::tables`): the site's data, which a page may turn
    /// the caller's word into its code by with no call made ([`Lab::listed`]). Offered to that one call only.
    tables: Vec<Vec<serde_json::Value>>,
    /// The proposer, where one is configured (`lab::propose`): asked only where the search leaves a choice open.
    proposer: Option<crate::lab::propose::Proposer>,
    /// The places a cut function was found for and refused, with why: the reads it makes that the node holds no source
    /// for ([`Lab::refusals`]).
    refused: RefCell<Vec<(Loc, String)>>,
    /// The names of the values the walk kept as secrets (a password, a message the site never said back): the
    /// caller's to give like any other, but their walked value is never kept on the body nor shown to the proposer.
    secrets: Vec<String>,
}

/// One sighting as a world: what a way is worked out against to see whether it makes what that sighting sent.
struct Sighted<'l, 'a> {
    lab: &'l Lab<'a>,
    walk: usize,
    at: usize,
    exchange: &'a Exchange,
    /// The clock as the sighting's own request read it, where a way hashes a reading of it: the time the reply is
    /// dated is near it, and a digest of a time near it is another digest.
    clock: Option<u64>,
}

impl route::World for Sighted<'_, '_> {
    fn slot(&self, name: &str) -> Option<String> {
        self.lab.walks[self.walk].asked.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }
    fn cookie(&self, name: &str) -> Option<String> {
        self.exchange.cookies().into_iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }
    fn cookie_for(&self, name: &str, _host: Option<&str>) -> Option<String> {
        self.cookie(name)
    }
    fn stored(&self, area: route::expr::Area, key: &str) -> Option<String> {
        self.lab.stored_on(self.walk, area, key)
    }
    fn read(&self, step: &str, at: &route::At) -> Option<String> {
        let source = self.lab.sightings(crate::body::exchange_of(step)?)[self.walk].filter(|&i| i < self.at)?;
        extract(&self.lab.walks[self.walk].trace.exchanges[source], &crate::body::at_back(at))
    }
    fn list(&self, step: &str, pointer: &str) -> Option<Vec<serde_json::Value>> {
        let source = self.lab.sightings(crate::body::exchange_of(step)?)[self.walk].filter(|&i| i < self.at)?;
        self.lab.json_of(self.walk, source)?.pointer(pointer)?.as_array().cloned()
    }
    fn answered(&self, step: &str) -> bool {
        crate::body::exchange_of(step).is_some_and(|e| self.lab.sightings(e)[self.walk].is_some_and(|i| i < self.at))
    }
    fn fresh(&mut self, id: &str, _clock: route::Clock) -> String {
        id.to_string()
    }
    fn now_ms(&self) -> u64 {
        self.clock.or_else(|| said_at(self.exchange)).unwrap_or(0)
    }
    fn digits(&mut self, n: usize) -> String {
        "0".repeat(n)
    }
    fn file(&self, _named: &str, _fact: route::FileFact) -> Result<String, String> {
        Err("a walk holds no file".into())
    }
    fn same_site(&self, a: &str, b: &str) -> bool {
        let site = |origin: &str| url::Url::parse(origin).ok().and_then(|u| u.host_str().map(crate::identity::site_of));
        site(a).is_some() && site(a) == site(b)
    }
}

/// When a call was answered, by the date its reply carries, in milliseconds since 1970.
fn said_at(e: &Exchange) -> Option<u64> {
    crate::fresh::http_date(e.response_header("date")?).and_then(|s| u64::try_from(s).ok()).map(|s| s * 1000)
}

/// A run of digits read as the clock near `now`: 13 digits are its milliseconds, 10 its seconds. The reading in
/// milliseconds, and how a stamp's form writes it.
fn reading(run: &str, now: u64) -> Option<(u64, &'static str)> {
    let v = run.parse::<u64>().ok()?;
    match run.len() {
        13 if v.abs_diff(now) <= NEAR_MS => Some((v, "{ms}")),
        10 if (v * 1000).abs_diff(now) <= NEAR_MS => Some((v * 1000, "{s}")),
        _ => None,
    }
}

/// The readings of the clock a sighting's own request carries, in milliseconds, wherever it carries them but at
/// `loc`, the place being made.
fn readings(seen: &Seen<'_>, loc: &Loc) -> Vec<u64> {
    let Some(now) = said_at(seen.exchange) else { return Vec::new() };
    let runs = |s: &Slot| s.value.split(|c: char| !c.is_ascii_digit()).filter_map(|run| reading(run, now)).map(|(ms, _)| ms).collect::<Vec<_>>();
    let mut out: Vec<u64> = seen.slots.iter().filter(|s| s.loc != *loc).flat_map(runs).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// The request a sighting sent, as the filler holds a request while it makes a value over it (`route::Draft`):
/// everything the sighting sent but the place being made, which is written in once it is made. Its cookies are
/// the ones the sighting carried, as one header.
fn sent_but(e: &Exchange, loc: &Loc) -> route::Built {
    let mut url = e.url.clone();
    if let Loc::Query(key) = loc {
        let others: Vec<(String, String)> = url.query_pairs().filter(|(k, _)| k != key).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        if others.is_empty() {
            url.set_query(None);
        } else {
            url.query_pairs_mut().clear().extend_pairs(others);
        }
    }
    let mut headers: Vec<(String, String)> = e.request_headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie") && !matches!(loc, Loc::Header(own) if own.eq_ignore_ascii_case(k))).cloned().collect();
    let cookies = e.cookies();
    if !cookies.is_empty() {
        headers.push(("cookie".into(), cookies.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")));
    }
    route::Built { method: e.method.clone(), url, headers, body: e.request_body.clone(), made: Vec::new() }
}

/// `value` with each reading of the clock near `now` struck out for what it is: `{ms}` for milliseconds, `{s}` for
/// seconds. None when it holds no such reading.
fn stamp_form(value: &str, now: u64) -> Option<String> {
    let chars: Vec<char> = value.chars().collect();
    let (mut out, mut at, mut found) = (String::new(), 0, false);
    while at < chars.len() {
        if !chars[at].is_ascii_digit() {
            // A brace of the value's own would read as a form's: such a value is not written as a stamp.
            if matches!(chars[at], '{' | '}') {
                return None;
            }
            out.push(chars[at]);
            at += 1;
            continue;
        }
        let start = at;
        while at < chars.len() && chars[at].is_ascii_digit() {
            at += 1;
        }
        let run: String = chars[start..at].iter().collect();
        match reading(&run, now) {
            Some((_, form)) => {
                out.push_str(form);
                found = true;
            }
            None => out.push_str(&run),
        }
    }
    found.then_some(out)
}

/// The key a place sends its value under, where it has one.
fn key_of(loc: &Loc) -> Option<&str> {
    match loc {
        Loc::Query(k) | Loc::Form(k) => Some(k.as_str()),
        Loc::Json(pointer) => pointer.rsplit('/').next(),
        _ => None,
    }
}

fn way(expr: Expr) -> Way {
    Way { rung: 0, expr }
}

/// Whether a value holds a word the page was asked, whole: a caller's word never rides another call as the walk's.
fn holds_a_word(value: &str, words: &[&str]) -> bool {
    words.iter().any(|w| !w.trim().is_empty() && crate::trace::carries_whole(value, w))
}

impl<'a> Lab<'a> {
    pub fn new(walks: &'a [Walk<'a>]) -> Self {
        Lab { walks, paired: RefCell::new(HashMap::new()), json: RefCell::new(HashMap::new()), literals: Vec::new(), sender_sha: None, target_at: None, sender: None, scripts: Vec::new(), tables: Vec::new(), proposer: None, storage: Vec::new(), refused: RefCell::new(Vec::new()), secrets: Vec::new() }
    }

    /// The lab with what each walk's page kept in its storage when it made the call, by walk (None: that walk's
    /// recording held none).
    pub fn stored(mut self, stores: Vec<Option<crate::sandbox::Storage>>) -> Self {
        self.storage = stores;
        self
    }

    /// What walk `walk`'s page kept in its storage when it made the call. The one seam a cut function's storage reads
    /// go through, the same the learners' own storage source (`Expr::Stored`, [`Lab::stored_on`]) reads.
    fn storage_when_made(&self, walk: usize) -> Option<&crate::sandbox::Storage> {
        self.storage.get(walk).and_then(Option::as_ref)
    }

    /// The places a function of the sending script was cut for and refused, each with the reads it made that no source
    /// the node holds answers (or why else it was refused), in the order found.
    pub fn refusals(&self) -> Vec<(Loc, String)> {
        self.refused.borrow().clone()
    }

    /// The lab reading the recording of the walk for the call at `at`: `literals` are the sender script's string
    /// literals (`slice::literals`) and `sha` its SHA-256, candidate constants a digest of that call may be made
    /// over; `sender` the frame that sent the call and `scripts` the walk's fetched code, from which a header the
    /// sending function set is cut and run ([`Lab::program`]). A digest or a program of any other call is not offered
    /// them (a constant and a sender belong to the script that sent their own call).
    pub fn reading(mut self, at: usize, literals: Vec<String>, sha: Option<String>, sender: Option<crate::signing::Producer>, scripts: Vec<(String, String)>) -> Self {
        self.literals = literals;
        self.sender_sha = sha;
        self.target_at = Some(at);
        self.sender = sender;
        self.scripts = scripts;
        self
    }

    /// The lab knowing what walk `walk`'s page kept in its storage (its recording's snapshot of the page's origin):
    /// a value a call sends that the page held there whole is the storage's ([`Lab::of_the_storage`]).
    pub fn storing(mut self, walk: usize, storage: crate::sandbox::Storage) -> Self {
        if self.storage.len() <= walk {
            self.storage.resize(walk + 1, None);
        }
        self.storage[walk] = Some(storage);
        self
    }

    /// What walk `walk`'s page kept under `key` in `area`, where the lab knows.
    fn stored_on(&self, walk: usize, area: route::expr::Area, key: &str) -> Option<String> {
        let storage = self.storage_when_made(walk)?;
        let kept = match area {
            route::expr::Area::Local => &storage.local,
            route::expr::Area::Session => &storage.session,
        };
        kept.get(key).cloned()
    }

    /// The lab with a proposer to ask where the search leaves a choice open (`lab::propose`).
    pub fn with_proposer(mut self, proposer: Option<crate::lab::propose::Proposer>) -> Self {
        self.proposer = proposer;
        self
    }

    /// The proposer the lab asks, where it has one.
    pub fn proposer(&self) -> Option<&crate::lab::propose::Proposer> {
        self.proposer.as_ref()
    }

    /// The lab offered the tables the sending script of the call [`Lab::reading`] names ships (`slice::tables`).
    /// The lab with the names of the values the walk kept as secrets ([`Lab::is_secret`]).
    pub fn with_secrets(mut self, names: Vec<String>) -> Self {
        self.secrets = names;
        self
    }

    /// Whether the walk asked the value it names as a secret: the caller's slot, whose walked value no body keeps and
    /// no proposer is shown.
    pub fn is_secret(&self, name: &str) -> bool {
        self.secrets.iter().any(|s| s == name)
    }

    pub fn with_tables(mut self, tables: Vec<Vec<serde_json::Value>>) -> Self {
        self.tables = tables;
        self
    }

    /// The SHA-256 of the script a digest of the call at `at` was offered constants of, when one was and the step
    /// kept a digest over a constant (`compile::route` notes it on the step's test).
    pub fn sender_sha_for(&self, at: usize) -> Option<&str> {
        (self.target_at == Some(at)).then_some(self.sender_sha.as_deref()).flatten()
    }

    /// The JSON walk `walk`'s call at `at` answered with (`Exchange::own_json`), read once.
    fn json_of(&self, walk: usize, at: usize) -> Option<std::rc::Rc<serde_json::Value>> {
        if let Some(json) = self.json.borrow().get(&(walk, at)) {
            return json.clone();
        }
        let json = self.walks.get(walk)?.trace.exchanges.get(at)?.own_json().map(std::rc::Rc::new);
        self.json.borrow_mut().insert((walk, at), json.clone());
        json
    }

    /// The value sits in an item of a list an earlier reply of the first walk gave, at one place inside the item;
    /// the item is the one a condition picks. Each candidate is a list on the way to the value in that reply, the
    /// value's place inside its item, and a condition the item meets there: one of its fields is the caller's value
    /// written some way, or holds it; or is the value another place of this request sends; or is a fixed text. In a
    /// fixed order (the nearest reply first, each reply's leaves and each item's fields in their order), so a body
    /// is the same bytes written twice. Whether it picks what each walk sent is for [`Lab::rebuilds`] to say.
    fn pick(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str]) -> Vec<Expr> {
        let first = &seen[0];
        let asked = self.askable(seen, loc, true);
        let own_key = |k: &str| matches!(loc, Loc::Query(q) if q == k);
        let query: Vec<(String, String)> = first.exchange.url.query_pairs().filter(|(k, _)| !own_key(k)).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let mut out = Vec::new();
        for j in (0..first.at).rev() {
            let Some(json) = self.json_of(first.walk, j) else { continue };
            for (pointer, leaf) in crate::slots::json_leaves(&json) {
                if leaf != values[0] {
                    continue;
                }
                // Each list on the way to the value: the pointer up to a place in it, the place, and the rest.
                let parts: Vec<&str> = pointer.split('/').collect();
                for k in 1..parts.len() {
                    if parts[k].parse::<usize>().is_err() {
                        continue;
                    }
                    let list = parts[..k].join("/");
                    let take: String = parts[k + 1..].iter().map(|p| format!("/{p}")).collect();
                    if !json.pointer(&list).is_some_and(serde_json::Value::is_array) {
                        continue;
                    }
                    let Some(item) = json.pointer(&format!("{list}/{}", parts[k])) else { continue };
                    let step = crate::body::step_id(j);
                    let mut push = |fits: route::Fits| out.push(Expr::Pick { step: step.clone(), list: list.clone(), fits, take: take.clone() });
                    for (at, field) in crate::slots::json_leaves(item) {
                        if at == take || field.is_empty() {
                            continue;
                        }
                        for (_, name, theirs) in &asked {
                            for hows in writings() {
                                let written = hows.iter().fold(theirs[0].to_string(), |v, how| how.write(&v));
                                let is = || Box::new(written_as(Self::slot(name, theirs[0]), &hows));
                                if field == written {
                                    push(route::Fits::Equals { at: at.clone(), is: is() });
                                } else if written.chars().count() >= 2 && field.to_lowercase().contains(&written.to_lowercase()) {
                                    push(route::Fits::Holds { at: at.clone(), is: is() });
                                }
                            }
                        }
                        for (key, sent) in &query {
                            if field == *sent {
                                push(route::Fits::Equals { at: at.clone(), is: Box::new(Expr::Sent { part: route::Sent::Query(key.clone()) }) });
                            }
                        }
                        push(route::Fits::Equals { at: at.clone(), is: Box::new(Expr::text(field.as_str())) });
                    }
                }
            }
        }
        out
    }

    /// Where each walk made the call the first walk made at `at` (`sighting::sightings`), each other walk paired with
    /// the first once.
    pub fn sightings(&self, at: usize) -> Vec<Option<usize>> {
        let Some(first) = self.walks.first() else { return Vec::new() };
        if first.trace.exchanges.get(at).is_none() {
            return vec![None; self.walks.len()];
        }
        let mut out = vec![Some(at)];
        for (k, walk) in self.walks.iter().enumerate().skip(1) {
            let mut paired = self.paired.borrow_mut();
            let pairs = paired.entry(k).or_insert_with(|| pairs(first, walk));
            out.push(pairs.get(&at).copied());
        }
        out
    }

    /// Whether `expr`, worked out in each sighting's own world, makes what that sighting sent at `loc`. An
    /// expression over the request is given the request that sighting sent, but for `loc` itself ([`sent_but`]).
    ///
    /// A reading of the clock sent as itself is held to being one, not to the millisecond: when the page read its
    /// clock is not in the walk. One hashed into a digest cannot be held so, and the digest is never compared
    /// loosely for it: the clock is each reading the sighting's own request carries, and the digest must be the very
    /// one made from one of them.
    fn rebuilds(&self, expr: &Expr, seen: &[Seen<'a>], values: &[&str], loc: &Loc) -> bool {
        let stamps = |exprs: Vec<&Expr>| exprs.into_iter().filter(|e| matches!(e, Expr::Stamp { .. })).count();
        let loose = stamps(expr.in_the_clear()) > 0;
        let hashed = stamps(expr.all()) > stamps(expr.in_the_clear());
        let over_the_request = expr.reads_the_request();
        seen.iter().zip(values).all(|(s, sent)| {
            let built = over_the_request.then(|| sent_but(s.exchange, loc));
            let clocks: Vec<Option<u64>> = if hashed { readings(s, loc).into_iter().map(Some).collect() } else { vec![None] };
            clocks.into_iter().any(|clock| {
                let mut world = Sighted { lab: self, walk: s.walk, at: s.at, exchange: s.exchange, clock };
                let made = expr.eval(&mut route::expr::Cx { world: &mut world, host: s.exchange.url.host_str(), sent: built.as_ref() });
                match made {
                    Ok(Outcome::Is(made)) if loose => said_at(s.exchange).is_some_and(|now| stamp_form(&made, now) == stamp_form(sent, now)),
                    Ok(Outcome::Is(made)) => made == *sent,
                    _ => false,
                }
            })
        })
    }

    /// [`Lab::rebuilds`] for one sighting.
    fn rebuilds_one(&self, expr: &Expr, s: &Seen<'a>, sent: &str, loc: &Loc) -> bool {
        self.rebuilds(expr, std::slice::from_ref(s), &[sent], loc)
    }

    /// What each walk's page was asked under the name the first walk asked at `j`: None when some walk was not
    /// asked it.
    fn asked_at(&self, seen: &[Seen<'a>], j: usize) -> Option<(&'a str, Vec<&'a str>)> {
        let (name, _) = self.walks[seen[0].walk].asked.get(j)?;
        let theirs: Option<Vec<&str>> = seen.iter().map(|s| self.walks[s.walk].asked.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str())).collect();
        Some((name.as_str(), theirs?))
    }

    /// The asked values a place may be made from. `moved`: those that differed between the sightings, which a value
    /// that moved with them may be made from. Not `moved`: those every sighting was asked alike, which is all of
    /// them where there is one sighting. Nothing moved to say whose a value equal to one of those is, so it is read
    /// as one walk reads it: the caller's where the asked value says enough to be told by itself, or the place sits
    /// under its own name.
    fn askable(&self, seen: &[Seen<'a>], loc: &Loc, moved: bool) -> Vec<(usize, &'a str, Vec<&'a str>)> {
        let first = &self.walks[seen[0].walk].asked;
        (0..first.len())
            .filter_map(|j| self.asked_at(seen, j).map(|(name, theirs)| (j, name, theirs)))
            .filter(|(_, name, theirs)| {
                let differed = theirs.iter().any(|v| *v != theirs[0]);
                match moved {
                    true => differed,
                    false => !differed && (!bound_by_key(theirs[0]) || key_of(loc) == Some(*name)),
                }
            })
            .collect()
    }

    /// The slot a caller's value is written from, with what the first walk sent as what it sends when nothing is
    /// given.
    fn slot(name: &str, walked: &str) -> Expr {
        Expr::Slot { name: name.to_string(), or: Some(walked.to_string()), optional: false }
    }

    /// The value is what the page was asked, written some way.
    fn callers(&self, seen: &[Seen<'a>], loc: &Loc, moved: bool) -> Vec<Expr> {
        let mut out = Vec::new();
        for (_, name, theirs) in self.askable(seen, loc, moved) {
            for hows in writings() {
                out.push(written_as(Self::slot(name, theirs[0]), &hows));
            }
        }
        out
    }

    /// The value holds what the page was asked inside a longer text that is otherwise the same on every sighting.
    fn holding(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], moved: bool) -> Option<Expr> {
        let mark = |m: usize| format!("\u{e000}{m}\u{e001}");
        // A word that moved with the walks is known by its moving. One every sighting was asked alike is known only
        // by standing in the value, and is held to the bar the classifier holds a word inside a longer value to
        // (`graph::held_in_text`): three characters, a letter among them, and no flag.
        let says_enough = |v: &str| moved || (v.chars().count() >= 3 && v.chars().any(char::is_alphabetic) && !crate::slots::is_flag(v));
        let mut asked: Vec<(&str, Vec<&str>)> = self.askable(seen, loc, moved).into_iter().map(|(_, name, theirs)| (name, theirs)).filter(|(_, theirs)| says_enough(theirs[0])).collect();
        // The longest first: a word inside another asked value is not struck out of it.
        asked.sort_by_key(|(_, theirs)| std::cmp::Reverse(theirs[0].chars().count()));
        // A word asked alike on every sighting is looked for written one way only: with nothing moved to hold a
        // reading to, a second writing is a second guess.
        let forms: Vec<Vec<How>> = writings().into_iter().filter(|hows| moved || hows.len() <= 1).collect();
        let mut text = values[0].to_string();
        let mut used: Vec<(&str, &[&str], Vec<How>)> = Vec::new();
        for (name, theirs) in &asked {
            for hows in &forms {
                let form = written(theirs[0], hows);
                if form.chars().count() < 2 {
                    continue;
                }
                // The caller's value goes where it stands as a word of its own, on every sighting: one that turns up
                // only inside a longer word (a key name such as `search_params`) does not make the literal the
                // caller's, however it was written.
                if !values.iter().enumerate().all(|(k, v)| theirs.get(k).is_some_and(|t| route::expr::stands_as_a_word(v, &written(t, hows)))) {
                    continue;
                }
                // A writing is read from every sighting, not the first alone: two writings of the first value can be
                // the same text (a word with no space, plain or with a plus for each space), and only a later
                // sighting's value tells them apart. A writing some sighting does not hold is not how it was written.
                if !values.iter().enumerate().skip(1).all(|(k, v)| theirs.get(k).is_some_and(|t| v.contains(written(t, hows).as_str()))) {
                    continue;
                }
                let struck = route::expr::swapped(&text, &form, &mark(used.len()));
                if struck != text {
                    text = struck;
                    used.push((name, theirs, hows.clone()));
                }
            }
        }
        if used.is_empty() {
            return None;
        }
        for (k, value) in values.iter().enumerate().skip(1) {
            let mut theirs_text = value.to_string();
            for (m, (_, theirs, hows)) in used.iter().enumerate() {
                theirs_text = route::expr::swapped(&theirs_text, &written(theirs[k], hows), &mark(m));
            }
            if theirs_text != text {
                return None;
            }
        }
        let mut parts = Vec::new();
        let mut rest = text.as_str();
        while let Some(start) = rest.find('\u{e000}') {
            if start > 0 {
                parts.push(Expr::text(&rest[..start]));
            }
            let end = start + rest[start..].find('\u{e001}')?;
            let (name, theirs, hows) = used.get(rest[start + '\u{e000}'.len_utf8()..end].parse::<usize>().ok()?)?;
            parts.push(written_as(Self::slot(name, theirs[0]), hows));
            rest = &rest[end + '\u{e001}'.len_utf8()..];
        }
        if !rest.is_empty() {
            parts.push(Expr::text(rest));
        }
        Some(Expr::Join { parts, with: String::new() })
    }

    /// The value is a text encoded again, and the text holds what the page was asked.
    fn holding_inside(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], moved: bool) -> Option<Expr> {
        let (wrap, _) = Wrap::of(values[0])?;
        let texts: Vec<String> = values.iter().map(|v| Wrap::of(v).filter(|(w, _)| *w == wrap).map(|(_, text)| text)).collect::<Option<_>>()?;
        let texts: Vec<&str> = texts.iter().map(String::as_str).collect();
        let inner = self.holding(seen, loc, &texts, moved)?;
        let how = match wrap {
            Wrap::Base64 => route::Wrap::Base64,
            Wrap::Base64NoPad => route::Wrap::Base64NoPad,
            Wrap::Base64Url => route::Wrap::Base64Url,
            Wrap::Base64UrlNoPad => route::Wrap::Base64UrlNoPad,
        };
        Some(Expr::Wrapped { of: Box::new(inner), how })
    }

    /// The value is a piece of what the page was asked: the same piece on every sighting.
    ///
    /// A piece cut from a value that moved is held to two values, and stands on that. One cut from a value every
    /// sighting was asked alike is held to nothing but sitting inside it, and a plain word sits inside many values:
    /// a page's code sends the words it uses (`post` in an address, beside a page asked for `all_posts`), and an
    /// asked value that happens to hold the same letters is not where the word came from (`provenance::a_plain_word`,
    /// the bar a value is held to before it is traced anywhere). A date or a time is no word, and is still cut.
    fn piece(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], moved: bool) -> Vec<Expr> {
        let len = values[0].chars().count();
        if len < 4 || (!moved && a_plain_word(values[0])) {
            return Vec::new();
        }
        self.askable(seen, loc, moved)
            .into_iter()
            .filter_map(|(_, name, theirs)| {
                let from = theirs[0].find(values[0]).filter(|_| theirs[0].matches(values[0]).count() == 1).map(|at| theirs[0][..at].chars().count())?;
                Some(Expr::Slice { of: Box::new(Expr::Given { name: name.to_string() }), from, len })
            })
            .collect()
    }

    /// The value is what the page was asked, as a date, a time or a number written in the site's own form, whole or
    /// inside a longer text that is otherwise the same on every sighting ([`crate::lab::forms::candidates`]): both forms read from
    /// the first sighting, the asked value's and the sent one's.
    fn formatted(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], moved: bool) -> Vec<Expr> {
        self.askable(seen, loc, moved).into_iter().flat_map(|(_, name, theirs)| crate::lab::forms::candidates(name, theirs[0], values[0], moved)).collect()
    }

    /// The value is a field of the record, in a table the sending script ships, that another of its fields says the
    /// caller's word in (the caller says a city, the request sends its code): each table of the script, each record
    /// holding the value sent, each other field of it equal to what the page was asked written some way.
    /// In a fixed order (the script's tables in its order, a record's fields in theirs), so a body is the same bytes
    /// written twice. Which field fits is held to every sighting by [`Lab::rebuilds`]; a word one walk cannot tell the
    /// fields apart by is the first that fits.
    fn listed(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], moved: bool) -> Vec<Expr> {
        if self.tables.is_empty() || self.target_at != Some(seen[0].at) {
            return Vec::new();
        }
        let asked = self.askable(seen, loc, moved);
        let mut out = Vec::new();
        for rows in &self.tables {
            for row in rows {
                let leaves = crate::slots::json_leaves(row);
                for (take, _) in leaves.iter().filter(|(_, v)| v == values[0]) {
                    for (at, field) in leaves.iter().filter(|(at, f)| at != take && !f.is_empty()) {
                        for (_, name, theirs) in &asked {
                            for hows in writings() {
                                let written = written(theirs[0], &hows);
                                let is = || Box::new(written_as(Self::slot(name, theirs[0]), &hows));
                                // The walks show a field equal to the word as written, so that is the condition: a field that
                                // holds it inside a longer text is more than they show.
                                if *field != written {
                                    continue;
                                }
                                let fits = route::Fits::Equals { at: at.clone(), is: is() };
                                let e = Expr::Lookup { rows: rows.clone(), fits, take: take.clone() };
                                if !out.contains(&e) {
                                    out.push(e);
                                }
                            }
                        }
                    }
                }
            }
        }
        out
    }

    /// Where `kept` looks the caller's word up in a table the script ships, every other field of the table that also
    /// rebuilds every sighting, and the first word the table lists on which they send different things: which field
    /// the site holds the word to, the walks cannot say there ([`crate::lab::forms::Left`]).
    fn listed_left(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], kept: &Expr, moved: bool) -> Option<crate::lab::forms::Left> {
        if !kept.all().iter().any(|e| matches!(e, Expr::Lookup { .. })) {
            return None;
        }
        let name = kept.slots().first()?.to_string();
        let words: Vec<String> = self.tables.iter().flatten().flat_map(crate::slots::json_leaves).map(|(_, v)| v).filter(|v| v.chars().any(char::is_alphabetic)).collect();
        // Readings that send the same for every word the table lists are one reading written twice (a field held
        // `equals` and `holds`, a word written as it is and in small letters): the first of each is kept.
        let mut standing: Vec<Expr> = Vec::new();
        let mut does: Vec<Vec<Option<String>>> = Vec::new();
        for e in self.listed(seen, loc, values, moved).into_iter().filter(|e| self.rebuilds(e, seen, values, loc)) {
            let sends: Vec<Option<String>> = words.iter().map(|w| crate::lab::forms::sends(&e, &name, w)).collect();
            if !does.contains(&sends) {
                does.push(sends);
                standing.push(e);
            }
        }
        if standing.len() < 2 {
            return None;
        }
        let separates = words.into_iter().find(|w| {
            let said: Vec<Option<String>> = standing.iter().map(|e| crate::lab::forms::sends(e, &name, w)).collect();
            said.iter().any(|s| *s != said[0])
        })?;
        Some(crate::lab::forms::Left { readings: standing, separates: (name, separates), by_proposer: false })
    }

    /// Where `kept` formats the caller's value, every other reading that also rebuilds every sighting, and whether
    /// they part on another value ([`crate::lab::forms::left_standing`]).
    fn formats_left(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str], kept: &Expr, moved: bool) -> Option<crate::lab::forms::Left> {
        if !kept.all().iter().any(|e| matches!(e, Expr::Format { .. })) {
            return None;
        }
        let standing: Vec<Expr> = self.formatted(seen, loc, values, moved).into_iter().filter(|e| self.rebuilds(e, seen, values, loc)).collect();
        let walked = kept.slots().first().and_then(|name| self.walks[seen[0].walk].asked.iter().find(|(n, _)| n == name)).map(|(_, v)| v.clone())?;
        crate::lab::forms::left_standing(&standing, &walked)
    }

    /// The value is a cookie the request carries.
    fn of_the_session(&self, seen: &[Seen<'a>], values: &[&str]) -> Vec<Expr> {
        if values[0].len() < MIN_TRACEABLE || a_plain_word(values[0]) {
            return Vec::new();
        }
        seen[0].exchange.cookies().into_iter().filter(|(_, v)| v == values[0]).map(|(name, _)| Expr::Cookie { name, here: false }).collect()
    }

    /// The value is one the first walk's page kept whole in its storage, under a key: the storage's, as a cookie is
    /// the jar's, read from what the session holds when the call is made. Where the page got it (an answer it read,
    /// a value it made) is the page's business: what the request sends is what the storage holds. The local store
    /// first, then the session's, each key in its order, so a body is the same bytes written twice. Whether each walk
    /// held it there is for [`Lab::rebuilds`] to say; a walk whose storage is not known holds nothing.
    fn of_the_storage(&self, seen: &[Seen<'a>], values: &[&str]) -> Vec<Expr> {
        if values[0].len() < MIN_TRACEABLE || a_plain_word(values[0]) {
            return Vec::new();
        }
        let Some(storage) = self.storage.get(seen[0].walk).and_then(Option::as_ref) else { return Vec::new() };
        let sorted = |kept: &HashMap<String, String>| {
            let mut keys: Vec<String> = kept.iter().filter(|(_, v)| v.as_str() == values[0]).map(|(k, _)| k.clone()).collect();
            keys.sort();
            keys
        };
        let local = sorted(&storage.local).into_iter().map(|key| Expr::Stored { area: route::expr::Area::Local, key });
        let session = sorted(&storage.session).into_iter().map(|key| Expr::Stored { area: route::expr::Area::Session, key });
        local.chain(session).collect()
    }

    /// Whether `expr`, a value of the page's storage, makes what each sighting sent whose walk's storage the lab
    /// knows, the first's among them. For a value every sighting sent alike: a walk whose storage is not known sent
    /// the same, and says nothing against it.
    fn rebuilds_where_stored(&self, expr: &Expr, seen: &[Seen<'a>], values: &[&str], loc: &Loc) -> bool {
        let known = |s: &Seen<'a>| self.storage.get(s.walk).is_some_and(Option::is_some);
        known(&seen[0]) && seen.iter().zip(values).filter(|(s, _)| known(s)).all(|(s, sent)| self.rebuilds_one(expr, s, sent, loc))
    }

    /// The name the jar keeps a header under, where the header at `loc`, sent as `value` by the first walk's call, is
    /// one the session keeps as the classifier reads it (`graph::a_session_header`): one reader for both learners.
    fn a_session_header(&self, seen: &[Seen<'a>], loc: &Loc, value: &str) -> Option<String> {
        let Loc::Header(name) = loc else { return None };
        let first = &seen[0];
        crate::graph::a_session_header(self.walks[first.walk].trace, first.at, name, value, first.exchange.url.host_str()).then(|| name.to_ascii_lowercase())
    }

    /// The value sits in an earlier reply of the first walk. Whether the same place of the same call's reply holds
    /// it on every other walk is for [`Lab::rebuilds`] to say.
    fn read(&self, seen: &[Seen<'a>], values: &[&str]) -> Option<Expr> {
        let first = &seen[0];
        let origin = find_origin_on(self.walks[first.walk].trace, first.at, values[0], first.exchange.url.host_str())?;
        let read = Expr::Read { step: crate::body::step_id(origin.exchange), at: crate::body::at_of(&origin.at) };
        Some(match origin.wrap {
            Some((before, after)) => Expr::Join { parts: vec![Expr::text(before), read, Expr::text(after)], with: String::new() },
            None => read,
        })
    }

    /// The value is, or holds, a reading of the clock.
    fn clock(&self, seen: &[Seen<'a>], values: &[&str]) -> Option<Expr> {
        let form = stamp_form(values[0], said_at(seen[0].exchange)?)?;
        Some(Expr::Stamp { form })
    }

    /// The value is a digest of parts of its own request and the session, joined: what the engine's search for a
    /// signature's parts finds over the requests the sightings sent ([`fit_by_search`]), said as an expression over
    /// the request. Only where a value made over the request can be written once the rest is built: the address or
    /// a header. The search wants two sightings at least, and so does this.
    fn digest(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str]) -> Option<Expr> {
        if seen.len() < 2 || !matches!(loc, Loc::Query(_) | Loc::Header(_)) {
            return None;
        }
        let built: Vec<route::Built> = seen.iter().map(|s| sent_but(s.exchange, loc)).collect();
        let requests: Vec<Request> = built.iter().map(|b| Request { method: b.method.clone(), url: b.url.clone(), exchange: 0, headers: b.headers.clone(), body: b.body.clone().map(String::into_bytes) }).collect();
        let cookies: Vec<Vec<(String, String)>> = built.iter().map(route::Built::cookies).collect();
        let sightings: Vec<Sighting<'_>> = values.iter().zip(&requests).zip(&cookies).zip(&built).map(|(((value, request), cookies), b)| Sighting { value, request, body: b.body.as_deref(), cookies }).collect();
        let own = if let Loc::Query(key) = loc { key.as_str() } else { "" };
        // The constants of the script that sent this one call, when the lab read the recording and this is that
        // call: a value the site ships to everyone is a part its signature may be hashed over.
        let constants: &[String] = if self.target_at == Some(seen[0].at) { &self.literals } else { &[] };
        let browsers = crate::slots::BrowsersOwn::of(self.walks[seen[0].walk].trace);
        crate::signing::fit_by_search_by(&sightings, own, constants, &|name, value| browsers.wrote(name, value)).map(|recipe| crate::body::recipe_expr(&recipe))
    }

    /// The value is a header the page's own sending function set, which no standard operation and no digest search
    /// reproduces: the function is cut from the script the recording names as the call's sender (`Lab::reading`), run
    /// in the sandbox with the caller's word in the request it carries, and the header it sets on the request it
    /// sends is read off its captured network ([`slice::assemble_sender`]). Kept only where the program reproduces
    /// what every sighting sent, held to each by [`generated::verify`] exactly as a call runs it — so a program that
    /// reads a value the call does not carry (a cookie, the DOM) makes another value and is refused. A program of
    /// another call than the one the recording's sender sent is not offered (`target_at`); two sightings at least,
    /// as a program that answers one could be a constant.
    ///
    /// The word the function is run with is read from the request the same way at learn time and at call time (the
    /// caller's value, off the query key it rides), so a call for another word is signed for that word. Which of the
    /// function's parameters the word goes in is not assumed: each is tried, and the one that reproduces is kept.
    fn program(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str]) -> Option<Expr> {
        let Loc::Header(header) = loc else { return None };
        let producer = self.sender.as_ref().filter(|_| self.target_at == Some(seen[0].at))?;
        if seen.len() < 2 {
            return None;
        }
        // The word the sending function reads, off the request it carries: the query key whose value is a caller's.
        // Read the same at learn time (the sighting's own request) and at call time (`ctx`), so a program verified on
        // the walk's words signs a new one.
        let mut words: Vec<String> = Vec::new();
        for (_, val) in &self.walks[seen[0].walk].asked {
            if let Some((key, _)) = seen[0].exchange.url.query_pairs().find(|(_, v)| v == val) {
                let key = serde_json::to_string(key.as_ref()).ok()?;
                let word = format!("new URLSearchParams(String((ctx && ctx.search) || '')).get({key})");
                if !words.contains(&word) {
                    words.push(word);
                }
            }
        }
        if words.is_empty() {
            return None;
        }
        // The samples the program is held to: each sighting's request, and the value it sent here, without the
        // header being made or the cookie header (a program reads the real cookies at call time from `ctx`).
        let samples: Vec<crate::generated::Sample> = seen
            .iter()
            .zip(values)
            .map(|(s, &value)| crate::generated::Sample {
                method: s.exchange.method.clone(),
                url: s.exchange.url.to_string(),
                body: s.exchange.request_body.clone(),
                cookies: s.exchange.cookies(),
                headers: s.exchange.request_headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie") && !k.eq_ignore_ascii_case(header)).cloned().collect(),
                expected: value.to_string(),
                pre: None,
            })
            .collect();
        // The sending function and what it calls, cut once (the slicer spawns a runtime); each word and parameter is
        // then a cheap string, tried in turn.
        let scripts: Vec<(&str, &str)> = self.scripts.iter().map(|(u, b)| (u.as_str(), b.as_str())).collect();
        let slice = crate::slice::of(&scripts, producer);
        let params = slice.call.as_ref().map(|c| c.params.len()).unwrap_or(3).clamp(1, 4);
        let mut unsourced: Vec<String> = Vec::new();
        for word in &words {
            for arg in 0..params {
                let Some(program) = crate::slice::assemble_sender(&slice, header, word, arg) else { continue };
                // What the function reads of the page's world, run once in the world the first walk's page had: its
                // storage, its cookies, the browser it said it was. Each read is strung to a source the node holds at
                // call time ([`Lab::feeds`]); one with none is named.
                let reads = crate::generated::reads_of(&program, &samples[0], &self.world_of(&seen[0], &samples[0]));
                let (feeds, missing) = self.feeds(seen, &reads);
                for m in missing {
                    if !unsourced.contains(&m) {
                        unsourced.push(m);
                    }
                }
                let Some(mut feeds) = feeds else { continue };
                let passes = |feeds: &[route::Feed]| {
                    let (samples, envs) = self.fed_samples(seen, &samples, feeds);
                    crate::generated::verify_each(&program, &samples, &envs) == crate::generated::Verdict::Passed
                };
                if !passes(&feeds) {
                    continue;
                }
                // A cookie the page's jar listed that the value does not move with is no read of its: each is left out
                // in turn, and stays out while the program still rebuilds every sighting.
                let mut i = 0;
                while i < feeds.len() {
                    if matches!(feeds[i].read, route::Reach::Cookie(_)) && feeds.iter().filter(|f| matches!(f.read, route::Reach::Cookie(_))).count() <= MOST_COOKIE_READS {
                        let mut fewer = feeds.clone();
                        fewer.remove(i);
                        if passes(&fewer) {
                            feeds = fewer;
                            continue;
                        }
                    }
                    i += 1;
                }
                let evidence = crate::generated::Evidence {
                    header: header.clone(),
                    sightings: samples.len(),
                    producer: Some(producer.clone()),
                    proposed_by: "the sending script".into(),
                    evidence_hash: crate::generated::evidence_hash(header, &samples),
                    exact: true,
                    scripts: Vec::new(),
                };
                let evidence = serde_json::to_value(evidence).ok();
                return Some(if feeds.is_empty() { Expr::Program { source: program, evidence } } else { Expr::ProgramReading { source: program, reads: feeds, evidence } });
            }
        }
        let why = if unsourced.is_empty() {
            "the function cut from the sending script does not rebuild what every sighting sent".to_string()
        } else {
            format!("the function cut from the sending script reads {}, which no source the node holds answers", unsourced.join(", "))
        };
        let mut refused = self.refused.borrow_mut();
        if !refused.iter().any(|(at, _)| at == loc) {
            refused.push((loc.clone(), why));
        }
        None
    }

    /// The value is a count the page searched for (a proof of work): on every sighting, the digest of another part of
    /// the same request (the challenge it was handed) joined with the count opens with more zeros than chance gives.
    /// Said as a search ([`Expr::Solve`]) for that condition: which digest, which part, the join, and the fewest zeros
    /// any sighting's digest opened with, all read from the sightings. The site checks the condition, not which count
    /// the page found, so the node's own count is one it accepts; the site's answer is the judge. A count is decimal
    /// digits; a part is a value of the query or a header of the same request (a challenge handed back in the
    /// request), never a cookie's or the browser's own. Two sightings at least, and [`MIN_ZEROS`] zeros on each.
    fn solved(&self, seen: &[Seen<'a>], loc: &Loc, values: &[&str]) -> Option<Expr> {
        if seen.len() < 2 || !values.iter().all(|v| !v.is_empty() && v.len() <= 12 && v.bytes().all(|b| b.is_ascii_digit())) {
            return None;
        }
        let built: Vec<route::Built> = seen.iter().map(|s| sent_but(s.exchange, loc)).collect();
        let mut parts: Vec<route::Sent> = built[0].url.query_pairs().map(|(k, _)| route::Sent::Query(k.into_owned())).collect();
        parts.extend(built[0].headers.iter().filter(|(k, _)| !k.eq_ignore_ascii_case("cookie") && !crate::slots::is_browser_header(k)).map(|(k, _)| route::Sent::Header(k.to_ascii_lowercase())));
        parts.dedup();
        let algos = [route::Algo::Sha256, route::Algo::Sha1, route::Algo::Md5];
        for part in &parts {
            let Some(challenges) = built.iter().map(|b| b.part(part).filter(|c| !c.is_empty())).collect::<Option<Vec<String>>>() else { continue };
            for algo in algos {
                for sep in ["", ":", "|", "-", ".", "+", "/"] {
                    for challenge_first in [true, false] {
                        let joined = |challenge: &str, count: &str| if challenge_first { format!("{challenge}{sep}{count}") } else { format!("{count}{sep}{challenge}") };
                        let zeros = challenges.iter().zip(values).map(|(c, v)| route::expr::leading_zeros(&algo.hash(&joined(c, v)))).min()?;
                        if zeros < MIN_ZEROS {
                            continue;
                        }
                        let zeros = zeros.min(route::expr::MOST_ZEROS);
                        let sent = Expr::Sent { part: part.clone() };
                        let (before, after) = if challenge_first {
                            (if sep.is_empty() { sent } else { Expr::Join { parts: vec![sent, Expr::text(sep)], with: String::new() } }, Expr::text(""))
                        } else {
                            (Expr::text(""), if sep.is_empty() { sent } else { Expr::Join { parts: vec![Expr::text(sep), sent], with: String::new() } })
                        };
                        return Some(Expr::Solve { algo, before: Box::new(before), after: Box::new(after), zeros });
                    }
                }
            }
        }
        None
    }

    /// The world one sighting's page had, as the sandbox puts it in front of a program: the walk's storage, the
    /// cookies its request carried, and the browser its request said it was (its name and languages). What a cut
    /// function is first run in, to see what it reads.
    fn world_of(&self, s: &Seen<'a>, sample: &crate::generated::Sample) -> crate::generated::Environment {
        let mut env = crate::generated::Environment { storage: self.storage_when_made(s.walk).cloned().unwrap_or_default(), ..Default::default() };
        let mut fp = serde_json::Map::new();
        for (name, key) in [("user-agent", "ua"), ("accept-language", "lang")] {
            if let Some((_, v)) = sample.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)) {
                let v = if key == "lang" { v.split(',').next().unwrap_or_default().split(';').next().unwrap_or_default().trim().to_string() } else { v.clone() };
                fp.insert(key.into(), serde_json::Value::String(v));
            }
        }
        env.fingerprint = serde_json::Value::Object(fp);
        env
    }

    /// Each read a cut function made (the sandbox's names for them, [`generated::reads_of`]), strung to a source the
    /// node holds at call time: a stored key to the page's storage, `document.cookie` to each cookie of the jar the
    /// sighting's request carried, the browser's name and languages to what the same request says of them. A read of
    /// the clock needs none (the program runs at the time its request says). Every other read, and a stored key no
    /// walk's recording held, has no source and is handed back by name; the feeds are then None when the function
    /// cannot run without it.
    fn feeds(&self, seen: &[Seen<'a>], reads: &[String]) -> (Option<Vec<route::Feed>>, Vec<String>) {
        use route::{Feed, Reach};
        let mut feeds: Vec<Feed> = Vec::new();
        let mut missing: Vec<String> = Vec::new();
        let header_of = |name: &str| seen.iter().all(|s| s.exchange.request_headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)));
        let sent_header = |name: &str| Expr::Sent { part: route::Sent::Header(name.into()) };
        for read in reads {
            if read == "the clock" {
                continue;
            }
            let stored = read.strip_prefix("localStorage ").map(|k| (route::expr::Area::Local, k)).or_else(|| read.strip_prefix("sessionStorage ").map(|k| (route::expr::Area::Session, k)));
            if let Some((area, key)) = stored {
                if !seen.iter().all(|s| self.storage_when_made(s.walk).is_some()) {
                    missing.push(format!("{read} (the walk kept no storage)"));
                    continue;
                }
                let reach = if area == route::expr::Area::Local { Reach::Local(key.into()) } else { Reach::Session(key.into()) };
                feeds.push(Feed { read: reach, from: Expr::Stored { area, key: key.into() } });
            } else if read == "document.cookie" {
                for (name, _) in seen[0].exchange.cookies() {
                    if !feeds.iter().any(|f| f.read == Reach::Cookie(name.clone())) {
                        feeds.push(Feed { read: Reach::Cookie(name.clone()), from: Expr::Cookie { name, here: false } });
                    }
                }
            } else if read == "navigator.userAgent" && header_of("user-agent") {
                feeds.push(Feed { read: Reach::Navigator("userAgent".into()), from: sent_header("user-agent") });
            } else if (read == "navigator.language" || read == "navigator.languages") && header_of("accept-language") {
                let name = read.trim_start_matches("navigator.");
                let from = if name == "language" { Expr::Piece { of: Box::new(Expr::Piece { of: Box::new(sent_header("accept-language")), split: ",".into(), index: 0 }), split: ";".into(), index: 0 } } else { sent_header("accept-language") };
                feeds.push(Feed { read: Reach::Navigator(name.into()), from });
            } else if read.starts_with("navigator.") {
                // The sandbox answers the rest of the browser as a browser most often is; a value that moved with it
                // does not rebuild, and the read is then named.
                missing.push(read.clone());
            } else {
                missing.push(read.clone());
            }
        }
        // A stored key no recording held stops the function; a read the sandbox answers by itself does not, until
        // the program fails to rebuild without it.
        let stops = missing.iter().any(|m| m.contains("the walk kept no storage"));
        ((!stops).then_some(feeds), missing)
    }

    /// The samples and environments a fed program is held to, a sighting each: what each feed came to on that walk
    /// (its storage, its request's cookies and headers), put where the page's code reads it ([`generated::fed`]). The
    /// cookies a fed program sees are those its feeds hand it, and no others, as at call time.
    fn fed_samples(&self, seen: &[Seen<'a>], samples: &[crate::generated::Sample], feeds: &[route::Feed]) -> (Vec<crate::generated::Sample>, Vec<crate::generated::Environment>) {
        seen.iter()
            .zip(samples)
            .map(|(s, sample)| {
                let fed: Vec<(route::Reach, Option<String>)> = feeds.iter().map(|f| (f.read.clone(), self.fed_on(s, &f.from))).collect();
                let (env, cookies) = crate::generated::fed(&crate::generated::Environment::default(), &[], &fed);
                (crate::generated::Sample { cookies, ..sample.clone() }, env)
            })
            .unzip()
    }

    /// What a feed's source came to on one sighting: the walk's stored key, its request's cookie or header.
    fn fed_on(&self, s: &Seen<'a>, from: &Expr) -> Option<String> {
        match from {
            Expr::Stored { area, key } => {
                let store = self.storage_when_made(s.walk)?;
                (if *area == route::expr::Area::Local { &store.local } else { &store.session }).get(key).cloned()
            }
            Expr::Cookie { name, .. } => s.exchange.cookies().into_iter().find(|(k, _)| k == name).map(|(_, v)| v),
            Expr::Sent { part: route::Sent::Header(name) } => s.exchange.request_headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone()),
            Expr::Piece { of, split, index } => self.fed_on(s, of)?.split(split.as_str()).nth(*index).map(String::from),
            _ => None,
        }
    }


    /// The site's own decoder for the target reply, when the standard readers cannot read it: cut from the script that
    /// read the reply (the recording's sender of the answer call, whose `.then` holds the unpacker) and run over the
    /// reply at call time (`route::Decode`, `generated::decode`). None when the reply reads by itself (JSON, a stream,
    /// base64 of JSON, a page) -- that is a rung-0/1 answer, not a rung-2 decode -- or when no cut function turns every
    /// walk's reply into JSON that says that walk's word back. Held to every walk's reply (`generated::verify_decoder`),
    /// two at least. The sending script's SHA is handed back, to note on the answer step's test.
    pub fn decoder(&self, at: usize) -> Option<(route::Decode, Option<String>)> {
        let producer = self.sender.as_ref().filter(|_| self.target_at == Some(at))?;
        let seen = self.seen(at);
        if seen.len() < 2 {
            return None;
        }
        // Each walk's raw reply and the words that walk was asked: a reply that reads by itself, or is a page, is no
        // decode.
        let mut replies: Vec<(String, Vec<String>)> = Vec::new();
        for s in &seen {
            let body = s.exchange.response_body.as_deref().filter(|b| !b.trim().is_empty())?;
            if crate::page::is_markup(&s.exchange.response_mime, body) {
                return None;
            }
            let words: Vec<String> = self.walks[s.walk].asked.iter().map(|(_, v)| v.clone()).collect();
            replies.push((body.to_string(), words));
        }
        let already = |reply: &str| crate::trace::body_json(reply).is_some() || crate::trace::encoded_json(reply).is_some();
        if replies.iter().any(|(r, _)| already(r)) {
            return None;
        }
        let env = crate::generated::Environment::default();
        // The one script that sent (and so read) the call is run, and the function it exposes is fed the reply, the
        // decoded answer read off the callback it hands it to (`slice::assemble_decoder`): the page's private decoder
        // need not be named. Only that script, not the page's whole bundle — a browser-internal script among the rest
        // would throw and take the decoder with it.
        let sender = self.scripts.iter().find(|(u, _)| *u == producer.script)?;
        let program = crate::slice::assemble_decoder(&[(sender.0.as_str(), sender.1.as_str())])?;
        if !crate::generated::verify_decoder(&program, &replies, &already, &env) {
            return None;
        }
        let evidence = crate::generated::Evidence {
            header: String::new(),
            sightings: replies.len(),
            producer: Some(producer.clone()),
            proposed_by: "the reply's own script".into(),
            evidence_hash: String::new(),
            exact: true,
            scripts: Vec::new(),
        };
        Some((route::Decode { source: program, evidence: serde_json::to_value(evidence).ok() }, self.sender_sha_for(at).map(String::from)))
    }

    /// Each walk's sighting of the call the first walk made at `at`, with what it sent: the first walk's first.
    fn seen(&self, at: usize) -> Vec<Seen<'a>> {
        self.sightings(at)
            .iter()
            .enumerate()
            .filter_map(|(walk, at)| {
                let at = (*at)?;
                let exchange = self.walks[walk].trace.exchanges.get(at)?;
                Some(Seen { walk, at, exchange, slots: crate::slots::slots_with_wire(exchange) })
            })
            .collect()
    }

    /// Every place of the call the first walk made at `at`, across its sightings, with the ways that rebuild it.
    pub fn holes(&self, at: usize) -> Vec<Hole> {
        let seen = self.seen(at);
        let Some(first) = seen.first().filter(|s| s.walk == 0) else { return Vec::new() };
        let seen_on = {
            let made: Vec<&Walk> = seen.iter().map(|s| &self.walks[s.walk]).collect();
            let all = axes(self.walks);
            Axes { word: all.word && made.iter().any(|w| w.asked != made[0].asked), session: all.session && made.iter().any(|w| w.session != made[0].session) }
        };
        let mut out = Vec::new();
        // Which headers the first walk's browser wrote by itself, read from that walk (`slots::BrowsersOwn`).
        let own = crate::slots::BrowsersOwn::of(self.walks[first.walk].trace);
        for slot in &first.slots {
            let sent: Vec<Option<String>> = (0..self.walks.len()).map(|walk| seen.iter().find(|s| s.walk == walk).and_then(|s| s.slots.iter().find(|t| t.loc == slot.loc)).map(|t| t.value.clone())).collect();
            let hole = |kind: Kind, ways: Vec<Way>, tied: Option<Expr>| Hole { at: slot.loc.clone(), sent: sent.clone(), kind, ways, tied, axes: seen_on, left: None };
            // A cookie is the session's, whatever it holds.
            if let Loc::Cookie(name) = &slot.loc {
                out.push(hole(Kind::Session, vec![way(Expr::Cookie { name: name.clone(), here: false })], None));
                continue;
            }
            // A sighting that made the call without this place says the place is not always sent, and nothing more.
            let values: Option<Vec<&str>> = seen.iter().map(|s| s.slots.iter().find(|t| t.loc == slot.loc).map(|t| t.value.as_str())).collect();
            let browsers = matches!(&slot.loc, Loc::Header(name) if own.wrote(name, &slot.value));
            let Some(values) = values else {
                // A header the browser writes by itself is sent or not as the browser's own state has it.
                out.push(if browsers { hole(Kind::Browsers, vec![way(Expr::text(slot.value.as_str()))], None) } else { hole(Kind::Open, Vec::new(), None) });
                continue;
            };
            let kept = |candidates: Vec<Expr>| candidates.into_iter().find(|e| self.rebuilds(e, &seen, &values, &slot.loc));
            let same = values.iter().all(|v| *v == values[0]);
            // The caller's: what the page was asked, written some way, whole or inside a longer value, or a piece of
            // it. A value that differs between the sightings may be made from an asked value that differed; one that
            // is the same on all of them, from one they were all asked alike.
            let of_the_caller = |moved: bool| {
                kept(self.callers(&seen, &slot.loc, moved))
                    .or_else(|| kept(self.holding(&seen, &slot.loc, &values, moved).into_iter().collect()))
                    .or_else(|| kept(self.holding_inside(&seen, &slot.loc, &values, moved).into_iter().collect()))
                    .or_else(|| kept(self.piece(&seen, &slot.loc, &values, moved)))
                    .or_else(|| kept(self.formatted(&seen, &slot.loc, &values, moved)))
                    .or_else(|| kept(self.listed(&seen, &slot.loc, &values, moved)))
            };
            if let Some(expr) = of_the_caller(!same) {
                // A table the site ships is its data, kept on the route as a digest's constant is: rung 1.
                let rung = u8::from(expr.all().iter().any(|e| matches!(e, Expr::Lookup { .. })));
                let mut made = hole(Kind::Callers, vec![Way { rung, expr: expr.clone() }], None);
                made.left = self.formats_left(&seen, &slot.loc, &values, &expr, !same).or_else(|| self.listed_left(&seen, &slot.loc, &values, &expr, !same));
                // Where readings are left standing, the proposer (if any) is shown them and names one; it is one the
                // search held to every sighting, and the site's tests judge it after.
                let shows_a_secret = expr.slots().iter().any(|n| self.is_secret(n));
                if let (Some(left), Some(proposer), false) = (made.left.as_mut(), self.proposer.as_ref(), shows_a_secret) {
                    if let Some(i) = crate::lab::propose::which_reading(proposer, &slot.loc.to_string(), &made.sent, &left.readings, &left.separates) {
                        left.readings.swap(0, i);
                        left.by_proposer = true;
                        made.ways = vec![Way { rung, expr: left.readings[0].clone() }];
                    }
                }
                out.push(made);
            } else if same && seen.len() > 1 {
                // The same on walks that differed, and nothing they were asked: not what moved between them.
                if let Some(cookie) = kept(self.of_the_session(&seen, &values)) {
                    out.push(hole(Kind::Session, vec![way(cookie)], None));
                } else if let Some(stored) = self.of_the_storage(&seen, &values).into_iter().find(|e| self.rebuilds_where_stored(e, &seen, &values, &slot.loc)) {
                    // What the page kept in its storage, sent alike by walks of one session: the storage's.
                    out.push(hole(Kind::Session, vec![way(stored)], None));
                } else if let Some(name) = self.a_session_header(&seen, &slot.loc, values[0]) {
                    // A header the session keeps, as the classifier reads one: the jar holds it, and the route names it.
                    out.push(hole(Kind::Session, vec![way(Expr::Cookie { name, here: false })], None));
                } else {
                    let tied = if matches!(slot.loc, Loc::Header(_)) { None } else { self.read(&seen, &values).filter(|e| self.rebuilds(e, &seen[..1], &values[..1], &slot.loc)) };
                    out.push(hole(Kind::Fixed, vec![way(Expr::text(values[0]))], tied));
                }
            } else if browsers {
                // A header the browser wrote by itself is the browser's, sent as it sent it: never read from an earlier
                // reply, the clock or the session, whatever one of those happens to hold the same text (a referer that
                // names a frame an earlier reply linked to).
                out.push(hole(Kind::Browsers, vec![way(Expr::text(values[0]))], None));
            } else if let Some(expr) = kept(self.of_the_session(&seen, &values)) {
                out.push(hole(Kind::Session, vec![way(expr)], None));
            } else if let Some(expr) = kept(self.of_the_storage(&seen, &values)) {
                // What each walk's page kept in its storage, moved with it: the storage's.
                out.push(hole(Kind::Session, vec![way(expr)], None));
            } else if let Some(expr) = kept(self.read(&seen, &values).into_iter().collect()) {
                // The read, and what the walk read there where a later reply does not hold the place. A value of the
                // page's own load (an experiment's code, a visitor's id, a piece of the state it renders) is a thing
                // the page made for that load, not a thing the site is asked: a fresh load that omits it is no reason
                // to stop the call, as a browser's page holds what its own load gave it. Nothing stands in for a
                // value that holds the word the page was asked: that word never rides a call as the walk's.
                let mut ways = vec![way(expr)];
                if !holds_a_word(values[0], &self.walks[first.walk].words()) {
                    ways.push(way(Expr::text(values[0])));
                }
                out.push(hole(Kind::Read, ways, None));
            } else if let Some(expr) = kept(self.clock(&seen, &values).into_iter().collect()) {
                out.push(hole(Kind::Clock, vec![way(expr)], None));
            } else if seen.len() == 1 {
                // One sighting, and nothing it shows makes the value: sent as walked, and open, since one walk cannot
                // tell the site's own text from the session's or a value made anew for each call. A header the
                // session keeps, as the classifier reads one from one walk, is the jar's.
                // A piece of the path is the address's own: the call is known by it. So is the request's content type,
                // as the classifier reads it: it says how the body is written, not a value the page makes (left open,
                // every page whose scripts name the header, a jQuery or a fetch wrapper, read as making it, and the
                // route went to the browser). A multipart boundary is made anew for each call, and stays open.
                let content_type = matches!(&slot.loc, Loc::Header(h) if h.eq_ignore_ascii_case("content-type")) && !values[0].to_ascii_lowercase().contains("boundary=");
                match self.a_session_header(&seen, &slot.loc, values[0]).filter(|_| !content_type) {
                    Some(name) => out.push(hole(Kind::Session, vec![way(Expr::Cookie { name, here: false })], None)),
                    None if matches!(slot.loc, Loc::Path(_)) || content_type => out.push(hole(Kind::Fixed, vec![way(Expr::text(values[0]))], None)),
                    None => out.push(hole(Kind::Open, vec![way(Expr::text(values[0]))], None)),
                }
            } else if let Some(expr) = kept(self.digest(&seen, &slot.loc, &values).into_iter().collect()) {
                // An expression of standard operations over the request: rung 1 (`learn.rung`).
                out.push(hole(Kind::Digest, vec![Way { rung: 1, expr }], None));
            } else if let Some(expr) = self.solved(&seen, &slot.loc, &values) {
                // A count the page searched for, the condition it met read from every sighting: a standard search
                // over a digest, rung 1 (`learn.rung`).
                out.push(hole(Kind::Digest, vec![Way { rung: 1, expr }], None));
            } else if let Some(expr) = kept(self.pick(&seen, &slot.loc, &values)) {
                out.push(hole(Kind::Pick, vec![way(expr)], None));
            } else if let Some(expr) = self.program(&seen, &slot.loc, &values) {
                // The site's own function, cut from the script that sent the call and run in the sandbox: rung 2
                // (`learn.rung`). Held to every sighting by `generated::verify`, not the evaluator, since the pure
                // evaluator runs no program.
                out.push(hole(Kind::Function, vec![Way { rung: 2, expr }], None));
            } else {
                // Nothing makes what every sighting sent. Where the first walk alone reads the place as the caller's,
                // that reading is kept as its way: sent as walked, the place would send the first walk's word to
                // every caller. It stays open, since the other walks do not bear the reading out.
                let alone = &seen[..1];
                let first_reading = self.callers(alone, &slot.loc, false).into_iter().chain(self.holding(alone, &slot.loc, &values[..1], false)).find(|e| self.rebuilds(e, alone, &values[..1], &slot.loc));
                out.push(hole(Kind::Open, first_reading.into_iter().map(way).collect(), None));
            }
        }
        out
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::lab::sighting::tests::{call, trace, walk};
    use crate::trace::Trace;

    /// A value's writing is read from every sighting: the first walk's word has no space, so written plainly or with
    /// a plus for each space it is the same text, and only the second walk's (`kettle one`, sent `kettle+one` in the
    /// page's own address the referer carries) tells the writings apart. Read from the first alone, the referer was
    /// left as the walk's text, and a call for another word sent the walked word in it.
    #[test]
    fn a_values_writing_is_read_from_every_sighting_not_the_first_alone() {
        let walked = |word: &str| {
            let referer = format!("https://shop.example/p/search?q={}", word.replace(' ', "+"));
            trace(vec![call("GET", &format!("https://shop.example/api/search?q={}", word.replace(' ', "%20")), &[("referer", &referer)], None, &format!(r#"{{"results":[{{"title":"{word} one"}}]}}"#))])
        };
        let (a, b) = (walked("kettle"), walked("kettle one"));
        let walks = [walk(&a, &[("q", "kettle")]), walk(&b, &[("q", "kettle one")])];
        let lab = Lab::new(&walks);
        let holes = lab.holes(0);
        let referer = at(&holes, &Loc::Header("referer".into()));
        assert_eq!(referer.kind, Kind::Callers, "{:?}", referer.ways);
        let step = crate::lab::compile::step(&lab, 0).expect("a step");
        struct Q;
        impl route::World for Q {
            fn slot(&self, n: &str) -> Option<String> { (n == "q").then(|| "red lamp".to_string()) }
            fn cookie(&self, _: &str) -> Option<String> { None }
            fn read(&self, _: &str, _: &route::At) -> Option<String> { None }
            fn answered(&self, _: &str) -> bool { false }
            fn fresh(&mut self, id: &str, _: route::Clock) -> String { id.into() }
            fn now_ms(&self) -> u64 { 0 }
            fn digits(&mut self, n: usize) -> String { "0".repeat(n) }
            fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> { Err(String::new()) }
            fn same_site(&self, _: &str, _: &str) -> bool { true }
        }
        let built = route::fill::request(&step, &mut Q).expect("it builds");
        assert_eq!(built.headers.iter().find(|(k, _)| k == "referer").map(|(_, v)| v.as_str()), Some("https://shop.example/p/search?q=red+lamp"));
    }

    fn at<'h>(holes: &'h [Hole], loc: &Loc) -> &'h Hole {
        holes.iter().find(|h| h.at == *loc).unwrap_or_else(|| panic!("no hole at {loc}"))
    }

    fn the_way(hole: &Hole) -> &Expr {
        &hole.ways.first().unwrap_or_else(|| panic!("{} is {:?} with no way", hole.at, hole.kind)).expr
    }

    fn query(k: &str) -> Loc {
        Loc::Query(k.into())
    }

    /// One walk ties a number an advert answered with to the search that also sends it. Two walks for two words
    /// send the same number: it is not the word's, and it is sent as it was. What one walk would have tied it to
    /// is kept beside it, since two walks of one session cannot say the tie is false.
    #[test]
    fn a_value_two_walks_sent_the_same_is_fixed_whatever_one_walk_tied_it_to() {
        let walked = |word: &str| {
            trace(vec![
                call("GET", "https://ads.shop.example/slot", &[], None, r#"{"placement":"8842190117"}"#),
                call("GET", &format!("https://shop.example/api/search?q={word}&placement=8842190117&size=20"), &[], None, "{}"),
            ])
        };
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(1);
        let placement = at(&holes, &query("placement"));
        assert_eq!(placement.kind, Kind::Fixed);
        assert_eq!(the_way(placement), &Expr::text("8842190117"));
        assert!(matches!(placement.tied, Some(Expr::Read { .. })), "{:?}", placement.tied);
        assert_eq!(placement.axes, Axes { word: true, session: false });
        assert_eq!(at(&holes, &query("size")).tied, None, "a short number is tied to nothing");
        // One walk alone has only the tie to go on, and says so by its axes.
        let alone = [walk(&first, &[("q", "lamp")])];
        let holes = Lab::new(&alone).holes(1);
        assert_eq!((at(&holes, &query("placement")).kind, at(&holes, &query("placement")).axes), (Kind::Read, Axes::default()));
    }

    #[test]
    fn a_value_that_moves_with_the_word_is_the_callers_however_it_is_written() {
        let walked = |word: &str, plus: &str, dashed: &str, upper: &str, pct: &str| {
            trace(vec![call(
                "POST",
                &format!("https://shop.example/find/{dashed}/all?q={plus}&lang=en"),
                &[("referer", &format!("https://shop.example/search?q={pct}&from=home"))],
                Some(&format!(r#"{{"term":"{upper}","exact":"{word}","page":1}}"#)),
                "{}",
            )])
        };
        let (first, second) = (walked("desk lamp", "desk+lamp", "desk-lamp", "DESK LAMP", "desk%20lamp"), walked("red sofa", "red+sofa", "red-sofa", "RED SOFA", "red%20sofa"));
        let walks = [walk(&first, &[("q", "desk lamp")]), walk(&second, &[("q", "red sofa")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(Lab::new(&walks).sightings(0), [Some(0), Some(0)], "the word written dashed in the path is the word: one call on both walks");
        let slot = || Expr::Slot { name: "q".into(), or: Some("desk lamp".into()), optional: false };
        let written = |how| Expr::Written { of: Box::new(slot()), how };
        assert_eq!(the_way(at(&holes, &query("q"))), &slot(), "a query's value is read as it means, and written as a query writes it");
        assert_eq!(the_way(at(&holes, &Loc::Path(1))), &written(How::Dashed));
        assert_eq!(the_way(at(&holes, &Loc::Json("/term".into()))), &written(How::Upper));
        assert_eq!(the_way(at(&holes, &Loc::Json("/exact".into()))), &slot());
        assert_eq!(
            the_way(at(&holes, &Loc::Header("referer".into()))),
            &Expr::Join { parts: vec![Expr::text("https://shop.example/search?q="), written(How::Percent), Expr::text("&from=home")], with: String::new() }
        );
        assert_eq!(at(&holes, &query("lang")).kind, Kind::Fixed);
        assert_eq!(at(&holes, &Loc::Json("/page".into())).kind, Kind::Fixed);
        assert!(holes.iter().filter(|h| h.kind == Kind::Callers).count() == 5, "{:?}", holes.iter().map(|h| (h.at.to_string(), h.kind)).collect::<Vec<_>>());
    }

    #[test]
    fn the_callers_word_inside_a_longer_value_is_written_into_its_place() {
        let packed = |word: &str| Wrap::Base64.close(&format!(r#"{{"query":"{word}","rows":24}}"#));
        let walked = |word: &str| trace(vec![call("GET", &format!("https://shop.example/gql?variables=%7B%22term%22%3A%22{word}%22%2C%22n%22%3A10%7D&s={}", packed(word)), &[], None, "{}")]);
        let (first, second) = (walked("lamp"), walked("sofa"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let holes = Lab::new(&walks).holes(0);
        let slot = || Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false };
        assert_eq!(the_way(at(&holes, &query("variables"))), &Expr::Join { parts: vec![Expr::text(r#"{"term":""#), slot(), Expr::text(r#"","n":10}"#)], with: String::new() });
        assert_eq!(
            the_way(at(&holes, &query("s"))),
            &Expr::Wrapped { of: Box::new(Expr::Join { parts: vec![Expr::text(r#"{"query":""#), slot(), Expr::text(r#"","rows":24}"#)], with: String::new() }), how: route::Wrap::Base64 }
        );
    }

    /// A caller's value that turns up in a longer literal only inside a longer word (here the page's address word
    /// `search`, inside the key `search_params` of a cursor the page carried) does not make that literal the caller's:
    /// the literal is not split around it, and the place is not the caller's. Where the value stands as a word of its
    /// own in the same literal, it is still written into its place.
    #[test]
    fn a_callers_value_inside_a_longer_word_does_not_make_the_literal_the_callers() {
        let cursor = Wrap::Base64.close(r#"{"search_params":{"page":2},"offset":48,"session_id":"0f3c9a7e-11aa-4b2c-9d41-5e6f7a8b9c0d"}"#);
        let first = trace(vec![call("POST", "https://shop.example/api/search", &[], Some(&format!(r#"{{"query":"desk lamp","session":"{cursor}"}}"#)), "{}")]);
        let walks = [walk(&first, &[("part0", "search"), ("q", "desk lamp")])];
        let holes = Lab::new(&walks).holes(0);
        let session = at(&holes, &Loc::Json("/session".into()));
        assert_ne!(session.kind, Kind::Callers, "a key name holding the word is not the caller's place: {:?}", session.ways);
        let names_a_slot = |e: &Expr| serde_json::to_string(e).unwrap().contains("\"slot\"");
        assert!(!session.ways.iter().any(|w| names_a_slot(&w.expr)), "{:?}", session.ways);
        assert_eq!(the_way(at(&holes, &Loc::Json("/query".into()))), &Expr::Slot { name: "q".into(), or: Some("desk lamp".into()), optional: false });
        // The same word standing as a word of its own in a literal is still the caller's, spliced into its place.
        let named = Wrap::Base64.close(r#"{"mode":"search","offset":48}"#);
        let second = trace(vec![call("POST", "https://shop.example/api/search", &[], Some(&format!(r#"{{"query":"desk lamp","session":"{named}"}}"#)), "{}")]);
        let walks = [walk(&second, &[("part0", "search"), ("q", "desk lamp")])];
        let holes = Lab::new(&walks).holes(0);
        assert!(at(&holes, &Loc::Json("/session".into())).ways.iter().any(|w| names_a_slot(&w.expr)), "a word of its own is still spliced in");
    }

    /// A tie is real when it holds on every walk: each walk's own reply, at the same place, holds what that walk
    /// sent. A value an earlier reply holds on one walk and not on the other is not read from it.
    #[test]
    fn a_value_an_earlier_reply_holds_on_every_walk_is_read_from_it() {
        let walked = |word: &str, token: &str, stray: &str| {
            trace(vec![
                call("GET", "https://shop.example/api/session", &[], None, &format!(r#"{{"token":"{token}","seen":"{stray}"}}"#)),
                call("GET", &format!("https://shop.example/api/search?q={word}"), &[("x-token", token), ("x-trace", "b3f1c2a9d4e5")], None, "{}"),
            ])
        };
        let (first, second) = (walked("lamp", "tok_9f8e7d6c5b", "b3f1c2a9d4e5"), walked("desk", "tok_1a2b3c4d5e", "000000000000"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(1);
        let token = at(&holes, &Loc::Header("x-token".into()));
        assert_eq!(token.kind, Kind::Read);
        assert_eq!(the_way(token), &Expr::Read { step: "x0".into(), at: route::At::Json { pointer: "/token".into() } });
        // The trace header is the same on both walks though only the first walk's reply says it: fixed, not read.
        assert_eq!(at(&holes, &Loc::Header("x-trace".into())).kind, Kind::Fixed);
    }

    #[test]
    fn a_cookie_is_the_sessions_and_so_is_a_value_that_is_one() {
        let walked = |word: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?q={word}"), &[("cookie", "sid=s%3Aabc; csrf=9d8c7b6a5f4e"), ("x-csrf-token", "9d8c7b6a5f4e")], None, "{}")]);
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(the_way(at(&holes, &Loc::Cookie("sid".into()))), &Expr::Cookie { name: "sid".into(), here: false });
        let header = at(&holes, &Loc::Header("x-csrf-token".into()));
        assert_eq!((header.kind, the_way(header)), (Kind::Session, &Expr::Cookie { name: "csrf".into(), here: false }));
    }

    /// A header both walks of one session send alike, that no cookie holds and that nothing the walk shows explains
    /// (a token the page kept), is the session's, as the classifier reads one (`graph::a_session_header`): the jar
    /// holds it, and the body only names it. A short fixed header stays the call's own text, and so does one an
    /// earlier answer of the walk handed over.
    #[test]
    fn a_header_the_session_keeps_is_the_jars() {
        let walked = |word: &str| {
            trace(vec![
                call("GET", "https://shop.example/api/config", &[], None, r#"{"nonce":"n0nce_7c6b5a4f3e2d1c0b"}"#),
                call("GET", &format!("https://shop.example/api/search?q={word}"), &[("authorization", "Bearer tok_5f4e3d2c1b0a9f8e7d6c"), ("x-client", "web"), ("x-nonce", "n0nce_7c6b5a4f3e2d1c0b")], None, "{}"),
            ])
        };
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(1);
        let token = at(&holes, &Loc::Header("authorization".into()));
        assert_eq!((token.kind, the_way(token)), (Kind::Session, &Expr::Cookie { name: "authorization".into(), here: false }));
        assert_eq!(at(&holes, &Loc::Header("x-client".into())).kind, Kind::Fixed);
        assert_eq!(at(&holes, &Loc::Header("x-nonce".into())).kind, Kind::Fixed, "an earlier answer handed it over");
    }

    /// One walk cannot say where a header came from, so it is open; a request's content type is not, since it says how
    /// the body is written (ieeexplore.ieee.org: open, jQuery's own `"Content-Type"` read as its producer, and every
    /// call went to the browser). A multipart boundary is made for each call, and is not fixed.
    #[test]
    fn a_content_type_seen_once_is_fixed_and_a_multipart_boundary_is_not() {
        let json = trace(vec![call("POST", "https://shop.example/rest/search", &[("content-type", "application/json"), ("x-app-width", "1280")], Some(r#"{"q":"lamp"}"#), "{}")]);
        let walks = [walk(&json, &[("q", "lamp")])];
        let holes = Lab::new(&walks).holes(0);
        let kind = at(&holes, &Loc::Header("content-type".into()));
        assert_eq!((kind.kind, the_way(kind)), (Kind::Fixed, &Expr::text("application/json")));
        assert_ne!(at(&holes, &Loc::Header("x-app-width".into())).kind, Kind::Fixed, "no other header one walk shows is fixed by it");
        let form = trace(vec![call("POST", "https://shop.example/rest/upload", &[("content-type", "multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxk")], Some("------WebKitFormBoundary7MA4YWxk--"), "{}")]);
        let walks = [walk(&form, &[])];
        assert_ne!(at(&Lab::new(&walks).holes(0), &Loc::Header("content-type".into())).kind, Kind::Fixed, "a boundary is no fixed text");
    }

    #[test]
    fn a_reading_of_the_clock_is_read_anew() {
        // The replies are dated Wed, 11 Nov 2026 12:00:00 GMT: 1794398400 seconds.
        let walked = |word: &str, ms: &str, s: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?q={word}&_={ms}&rid=r-{s}-web&build=1794000000000"), &[], None, "{}")]);
        let (first, second) = (walked("lamp", "1794398399120", "1794398399"), walked("desk", "1794398401877", "1794398401"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!((at(&holes, &query("_")).kind, the_way(at(&holes, &query("_")))), (Kind::Clock, &Expr::Stamp { form: "{ms}".into() }));
        assert_eq!(the_way(at(&holes, &query("rid"))), &Expr::Stamp { form: "r-{s}-web".into() });
        assert_eq!(at(&holes, &query("build")).kind, Kind::Fixed, "a number of the clock's length that is days old is no reading of it");
    }

    #[test]
    fn a_piece_of_what_the_page_was_asked_is_cut_from_it() {
        let walked = |date: &str, time: &str| trace(vec![call("GET", &format!("https://tables.example/api/find?date={date}&time={time}&covers=2"), &[], None, "{}")]);
        let (first, second) = (walked("2027-03-09", "20:30"), walked("2027-04-17", "18:00"));
        let walks = [walk(&first, &[("dateTime", "2027-03-09T20:30:00"), ("covers", "2")]), walk(&second, &[("dateTime", "2027-04-17T18:00:00"), ("covers", "2")])];
        let holes = Lab::new(&walks).holes(0);
        let piece = |from, len| Expr::Slice { of: Box::new(Expr::Given { name: "dateTime".into() }), from, len };
        assert_eq!(the_way(at(&holes, &query("date"))), &piece(0, 10));
        assert_eq!(the_way(at(&holes, &query("time"))), &piece(11, 5));
        // Asked the same on both walks, under its own name: still the caller's to set.
        let covers = at(&holes, &query("covers"));
        assert_eq!((covers.kind, the_way(covers)), (Kind::Callers, &Expr::Slot { name: "covers".into(), or: Some("2".into()), optional: false }));
    }

    /// A value that moved, which nothing the walks hold makes, is not guessed at: it is open, and says what was
    /// different about the walks it was seen on, so what is asked next (another session, the page's code) is known.
    #[test]
    fn a_value_that_moves_with_nothing_the_walks_show_is_open() {
        let walked = |word: &str, trace_id: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?q={word}"), &[("x-trace-id", trace_id)], None, "{}")]);
        let (first, second) = (walked("lamp", "7f3a9c21e5b84d06"), walked("desk", "c40e18b72a9d5f63"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        let id = at(&holes, &Loc::Header("x-trace-id".into()));
        assert_eq!((id.kind, id.ways.len(), id.axes), (Kind::Open, 0, Axes { word: true, session: false }));
        assert_eq!(id.sent, [Some("7f3a9c21e5b84d06".to_string()), Some("c40e18b72a9d5f63".to_string())]);
    }

    /// A header the browser writes by itself moves with the browser's own state, not with anything the page was
    /// asked: it is not open, and is sent as the walk's browser sent it.
    #[test]
    fn a_header_the_browser_writes_by_itself_is_sent_as_the_walks_browser_sent_it() {
        let walked = |word: &str, width: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?q={word}"), &[("sec-ch-viewport-width", width), ("x-app-width", width)], None, "{}")]);
        let (first, second) = (walked("lamp", "1280"), walked("desk", "1432"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        let hint = at(&holes, &Loc::Header("sec-ch-viewport-width".into()));
        assert_eq!((hint.kind, the_way(hint)), (Kind::Browsers, &Expr::text("1280")));
        assert_eq!(at(&holes, &Loc::Header("x-app-width".into())).kind, Kind::Open, "a header the page writes is the page's to explain");
        // Sent on one walk and not on the other, it is still the browser's.
        let bare = trace(vec![call("GET", "https://shop.example/api/search?q=desk", &[], None, "{}")]);
        let walks = [walk(&first, &[("q", "lamp")]), walk(&bare, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(at(&holes, &Loc::Header("sec-ch-viewport-width".into())).kind, Kind::Browsers);
        assert_eq!(at(&holes, &Loc::Header("x-app-width".into())).kind, Kind::Open);
    }

    /// A made-up signed call: `sign` is an MD5 over the first piece of a session cookie, the call's time, its key and
    /// its data, joined by `&`, as a page's code makes it.
    pub(crate) fn signed(word: &str, t: &str, found: &str) -> Exchange {
        let data = format!(r#"{{"q":"{word}"}}"#);
        let sign = route::Algo::Md5.hash(&format!("5f3a9c21e4d7b8a6&{t}&24677475&{data}"));
        let url = url::Url::parse_with_params("https://api.shop.example/h5/find/1.0/", &[("jsv", "2.7.2"), ("appKey", "24677475"), ("t", t), ("sign", &sign), ("api", "find"), ("data", &data)]).unwrap();
        call("GET", url.as_str(), &[("cookie", "_tk=5f3a9c21e4d7b8a6_1794402700000; lang=en-SG-long")], None, &format!(r#"{{"items":[{{"name":"{found}"}}]}}"#))
    }

    /// A value that moves on every sighting, that nothing the walks hold makes and that reads as a digest, is made
    /// over parts of its own request and the session: the engine's search for a signature's parts proposes which,
    /// and each sighting's own request bears it out. A value of a digest's shape that nothing it carries makes is
    /// still open.
    #[test]
    fn a_value_that_moves_and_reads_as_a_digest_is_made_over_parts_of_its_own_request() {
        // The replies are dated Wed, 11 Nov 2026 12:00:00 GMT: 1794398400 seconds.
        let (first, second) = (trace(vec![signed("lamps", "1794398399120", "Desk lamp")]), trace(vec![signed("kettles", "1794398401877", "Steel kettle")]));
        let walks = [walk(&first, &[("q", "lamps")]), walk(&second, &[("q", "kettles")])];
        let holes = Lab::new(&walks).holes(0);
        let sign = at(&holes, &query("sign"));
        let sent = |part| Expr::Sent { part };
        let expected = Expr::Hash {
            algo: route::Algo::Md5,
            of: Box::new(Expr::Join {
                parts: vec![
                    Expr::Piece { of: Box::new(sent(route::Sent::Cookie("_tk".into()))), split: "_".into(), index: 0 },
                    sent(route::Sent::Query("t".into())),
                    sent(route::Sent::Query("appKey".into())),
                    sent(route::Sent::Query("data".into())),
                ],
                with: "&".into(),
            }),
        };
        assert_eq!((sign.kind, sign.ways[0].rung, the_way(sign)), (Kind::Digest, 1, &expected));
        assert_eq!(at(&holes, &query("t")).kind, Kind::Clock, "what it is made over is made as itself");
        assert_eq!(at(&holes, &query("data")).kind, Kind::Callers);

        // The same shape, made from something the call does not carry: open, and no digest is guessed.
        let unmade = |word: &str, t: &str, made_of: &str| {
            let url = format!("https://api.shop.example/h5/find/1.0/?t={t}&q={word}&sign={}", route::Algo::Md5.hash(made_of));
            trace(vec![call("GET", &url, &[], None, "{}")])
        };
        let (first, second) = (unmade("lamps", "1794398399120", "a secret the page holds:lamps"), unmade("kettles", "1794398401877", "a secret the page holds:kettles"));
        let walks = [walk(&first, &[("q", "lamps")]), walk(&second, &[("q", "kettles")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(at(&holes, &query("sign")).kind, Kind::Open);
    }

    /// A reading of the clock hashed into a digest cannot be read again from the walk to the millisecond, and the
    /// digest is never compared loosely for it: the clock is the time the sighting's own request says, and the
    /// digest is the one made from that or the candidate is not kept.
    #[test]
    fn a_clock_hashed_into_a_digest_is_the_time_its_own_request_says() {
        let walked = |word: &str, ms: &str, hashed_ms: &str| {
            let sig = route::Algo::Sha1.hash(&format!("{hashed_ms}:{word}"));
            trace(vec![call("GET", &format!("https://shop.example/api/search?q={word}&_={ms}&sig={sig}"), &[], None, "{}")])
        };
        let candidate = |with: &str| Expr::Hash { algo: route::Algo::Sha1, of: Box::new(Expr::Join { parts: vec![Expr::Stamp { form: "{ms}".into() }, Lab::slot("q", "lamp")], with: with.into() }) };
        let check = |first: &Trace, second: &Trace, expr: &Expr| {
            let walks = [walk(first, &[("q", "lamp")]), walk(second, &[("q", "desk")])];
            let lab = Lab::new(&walks);
            let seen = lab.seen(0);
            let values: Vec<&str> = seen.iter().map(|s| s.slots.iter().find(|t| t.loc == query("sig")).map(|t| t.value.as_str()).unwrap()).collect();
            lab.rebuilds(expr, &seen, &values, &query("sig"))
        };
        let (first, second) = (walked("lamp", "1794398399120", "1794398399120"), walked("desk", "1794398401877", "1794398401877"));
        assert!(check(&first, &second, &candidate(":")), "the time each request says, hashed with its word");
        assert!(!check(&first, &second, &candidate(";")), "another digest is another digest");
        // The page hashed a reading a millisecond off what its request sent: near is not the same digest.
        let off = walked("desk", "1794398401877", "1794398401878");
        assert!(!check(&first, &off, &candidate(":")));
    }

    /// Two walks of a page for the same word are two sightings in which what was asked did not move. A value equal
    /// to it is the same on both, and that says nothing of whose it is: it is read as one walk reads it, the
    /// caller's, under whatever key the call sends it and inside the longer value that holds it. A route learned
    /// from such a pair must still take the word.
    #[test]
    fn a_value_both_walks_were_asked_alike_is_still_the_callers() {
        let walked = |stamp: &str| {
            trace(vec![call(
                "GET",
                &format!("https://help.example/api/search?query=domain&size=10&_={stamp}"),
                &[("referer", "https://help.example/support/?s=domain"), ("x-lang", "en")],
                None,
                "{}",
            )])
        };
        let (first, second) = (walked("1794398399120"), walked("1794398401877"));
        let walks = [walk(&first, &[("s", "domain"), ("n", "1")]), walk(&second, &[("s", "domain"), ("n", "1")])];
        let holes = Lab::new(&walks).holes(0);
        let slot = || Expr::Slot { name: "s".into(), or: Some("domain".into()), optional: false };
        let word = at(&holes, &query("query"));
        assert_eq!((word.kind, the_way(word)), (Kind::Callers, &slot()), "the word, though the call sends it under another key than the page was asked it");
        assert_eq!(word.axes, Axes::default(), "and it says nothing moved to show it");
        assert_eq!(the_way(at(&holes, &Loc::Header("referer".into()))), &Expr::Join { parts: vec![Expr::text("https://help.example/support/?s="), slot()], with: String::new() });
        // What was not asked stays the call's own text, and a value too short to tell is the caller's only under its own name.
        assert_eq!(at(&holes, &query("size")).kind, Kind::Fixed);
        assert_eq!(at(&holes, &Loc::Header("x-lang".into())).kind, Kind::Fixed);
        assert_eq!(at(&holes, &query("_")).kind, Kind::Clock);
    }

    /// Where the word did move, a value the walks sent the same is not the word's, whatever else they were asked
    /// alike: the two readings do not mix.
    #[test]
    fn a_word_that_moved_and_one_asked_alike_are_each_read_by_what_is_known_of_them() {
        let walked = |word: &str| trace(vec![call("GET", &format!("https://help.example/api/search?query={word}&locale=en-GB&echo=lamp"), &[], None, "{}")]);
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("s", "lamp"), ("lang", "en-GB")]), walk(&second, &[("s", "desk"), ("lang", "en-GB")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(the_way(at(&holes, &query("query"))), &Expr::Slot { name: "s".into(), or: Some("lamp".into()), optional: false });
        assert_eq!(the_way(at(&holes, &query("locale"))), &Expr::Slot { name: "lang".into(), or: Some("en-GB".into()), optional: false }, "asked alike on both walks: the caller's, as one walk reads it");
        assert_eq!(at(&holes, &query("echo")).kind, Kind::Fixed, "the first walk's word, sent the same on a walk for another: not the word");
    }

    /// A page may read a word off its own address as the address writes it (a plus for a space) and encode that
    /// again before it sends it. One word shows nothing of this; two words do. The word is found written twice
    /// over, as the page writes it, and not left as a value nothing explains.
    #[test]
    fn a_word_the_page_writes_twice_over_is_found_as_the_page_writes_it() {
        let walked = |sent: &str| trace(vec![call("GET", &format!("https://help.example/api/search?query={sent}&size=10"), &[], None, "{}")]);
        // The call's `query` is the text `domain%2Bconnect`: the address's own `domain+connect`, percent-encoded.
        let (first, second) = (walked("domain"), walked("domain%252Bconnect"));
        let walks = [walk(&first, &[("s", "domain")]), walk(&second, &[("s", "domain connect")])];
        let holes = Lab::new(&walks).holes(0);
        let word = at(&holes, &query("query"));
        assert_eq!(word.sent, [Some("domain".to_string()), Some("domain%2Bconnect".to_string())]);
        let slot = Expr::Slot { name: "s".into(), or: Some("domain".into()), optional: false };
        let twice = Expr::Written { of: Box::new(Expr::Written { of: Box::new(slot), how: How::Plus }), how: How::Percent };
        assert_eq!((word.kind, the_way(word)), (Kind::Callers, &twice));
    }

    /// Where no expression makes what every walk sent in a place the first walk reads as the caller's, the place
    /// is open, and it still takes the caller's word as the first walk read it. Sent as walked it would send one
    /// walk's word to every caller, and a route that takes no word answers no one.
    #[test]
    fn an_open_place_one_walk_reads_as_the_callers_still_takes_the_callers_word() {
        let walked = |sent: &str| trace(vec![call("GET", &format!("https://help.example/api/search?query={sent}&id=7f3a9c21e5b84d06"), &[], None, "{}")]);
        let (first, second) = (walked("lamp"), walked("x9-k2-q7"));
        let walks = [walk(&first, &[("s", "lamp")]), walk(&second, &[("s", "sofa")])];
        let holes = Lab::new(&walks).holes(0);
        let word = at(&holes, &query("query"));
        assert_eq!((word.kind, the_way(word)), (Kind::Open, &Expr::Slot { name: "s".into(), or: Some("lamp".into()), optional: false }));
        let body = crate::lab::compile::step(&Lab::new(&walks), 0).unwrap();
        let place = body.holes.iter().find(|h| h.at == route::Place::Query("query".into())).unwrap();
        assert!(place.open && place.ways[0].expr.slots() == ["s"], "the step's hole is open and still asks the caller: {place:?}");
    }

    /// A value read from a different item of a list on each walk, the one whose name is the word the walk was asked,
    /// is picked from that list by the caller's word: not read at one place, and not open. A graph has no class for a
    /// pick, and says so; written twice, the body is the same bytes.
    #[test]
    fn a_value_picked_from_a_list_by_the_callers_word_is_a_pick() {
        let cities = r#"{"cities":[{"name":"Lisbon","id":"c-11"},{"name":"Porto","id":"c-27"},{"name":"Faro","id":"c-34"}]}"#;
        let walked = |word: &str, id: &str| trace(vec![call("GET", "https://air.example/api/cities", &[], None, cities), call("GET", &format!("https://air.example/api/fares?to={id}&q={word}"), &[], None, "{}")]);
        let (first, second) = (walked("Porto", "c-27"), walked("Faro", "c-34"));
        let walks = [walk(&first, &[("q", "Porto")]), walk(&second, &[("q", "Faro")])];
        let holes = Lab::new(&walks).holes(1);
        let to = at(&holes, &query("to"));
        assert_eq!(to.kind, Kind::Pick);
        assert_eq!(the_way(to), &Expr::Pick { step: "x0".into(), list: "/cities".into(), fits: route::Fits::Equals { at: "/name".into(), is: Box::new(Lab::slot("q", "Porto")) }, take: "/id".into() });
        let body = crate::lab::compile::route(&Lab::new(&walks), 1, "air.example").unwrap();
        assert_eq!(body.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["x0", "x1"], "the list's call comes before the pick");
        assert_eq!(serde_json::to_string(&crate::lab::compile::route(&Lab::new(&walks), 1, "air.example").unwrap()).unwrap(), serde_json::to_string(&body).unwrap());
        let refused = crate::body::to_graph(&body).unwrap_err();
        assert_eq!((refused.at, refused.why), (Some(route::Place::Query("to".into())), "a graph has no class for a value picked from a list in an earlier reply"));
    }

    /// A value that moved with nothing the caller asked, the id of the list's item the reply marks as the current
    /// one, is picked by that mark: the item whose field is the same fixed text on every walk.
    #[test]
    fn a_value_that_moved_with_nothing_asked_is_picked_by_the_lists_own_mark() {
        let walked = |word: &str, sessions: &str, id: &str| trace(vec![call("GET", "https://shop.example/api/sessions", &[], None, sessions), call("GET", &format!("https://shop.example/api/search?q={word}&session={id}"), &[], None, "{}")]);
        let (first, second) = (
            walked("lamp", r#"{"sessions":[{"id":"s-9f2a","current":false},{"id":"s-4c1d","current":true}]}"#, "s-4c1d"),
            walked("desk", r#"{"sessions":[{"id":"s-77b0","current":true},{"id":"s-2e95","current":false},{"id":"s-0aa3","current":false}]}"#, "s-77b0"),
        );
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(1);
        let session = at(&holes, &query("session"));
        assert_eq!(session.kind, Kind::Pick);
        assert_eq!(the_way(session), &Expr::Pick { step: "x0".into(), list: "/sessions".into(), fits: route::Fits::Equals { at: "/current".into(), is: Box::new(Expr::text("true")) }, take: "/id".into() });
        // A list whose items say nothing that picks the one sent on both walks leaves the place open.
        let blind = |word: &str, ids: &str, id: &str| trace(vec![call("GET", "https://shop.example/api/sessions", &[], None, ids), call("GET", &format!("https://shop.example/api/search?q={word}&session={id}"), &[], None, "{}")]);
        let (first, second) = (blind("lamp", r#"{"sessions":[{"id":"s-9f2a"},{"id":"s-4c1d"}]}"#, "s-4c1d"), blind("desk", r#"{"sessions":[{"id":"s-77b0"},{"id":"s-2e95"}]}"#, "s-77b0"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        assert_eq!(at(&Lab::new(&walks).holes(1), &query("session")).kind, Kind::Open);
    }

    /// A word of the call's own address is not a piece of what the page was asked because an asked value, the same
    /// on both walks, happens to hold its letters. A date inside an asked date and time, the same on both walks, is
    /// still the caller's: nothing moved to show either, and a date is no word a page's code would send by itself.
    #[test]
    fn a_plain_word_is_no_piece_of_a_value_every_walk_was_asked_alike() {
        let walked = |word: &str| trace(vec![call("GET", &format!("https://letters.example/api/v1/post/search?query={word}&day=2027-03-09"), &[], None, "{}")]);
        let (first, second) = (walked("climate"), walked("startups"));
        let asked = |word: &'static str| [("word", word), ("searching", "all_posts"), ("when", "2027-03-09T20:30:00")];
        let walks = [walk(&first, &asked("climate")), walk(&second, &asked("startups"))];
        let holes = Lab::new(&walks).holes(0);
        let piece = at(&holes, &Loc::Path(2));
        assert_eq!((piece.kind, the_way(piece)), (Kind::Fixed, &Expr::text("post")), "the address's own word");
        assert_eq!(the_way(at(&holes, &query("day"))), &Expr::Slice { of: Box::new(Expr::Given { name: "when".into() }), from: 0, len: 10 });
        assert_eq!(the_way(at(&holes, &query("query"))), &Expr::Slot { name: "word".into(), or: Some("climate".into()), optional: false });
    }

    /// The FNV-shaped mixer `/s/signed-own.js` ships, in Rust, so a fixture's header is the one the script makes.
    /// `charCodeAt` reads UTF-16 units, as `encode_utf16` does.
    /// A header the browser wrote by itself is the browser's, even where an earlier reply holds the same text: one
    /// walk's call to a token service names, as its referer, a player frame an earlier reply linked to. Read from
    /// that reply, the route would load the frame's page as a step; it is sent as the browser sent it.
    #[test]
    fn a_header_the_browser_wrote_is_never_read_from_an_earlier_reply() {
        let frame = "https://player.example/embed/x1a2b3.html";
        let mut page = call("GET", "https://shop.example/search/volcano", &[("referer", "https://shop.example/")], None, "<html></html>");
        page.resource_type = Some("Document".into());
        let t = trace(vec![
            page,
            call("GET", "https://shop.example/api/config", &[], None, &format!(r#"{{"player":"{frame}"}}"#)),
            call("POST", "https://auth.example/token", &[("referer", frame)], Some("grant=client"), r#"{"token":"t"}"#),
        ]);
        let walks = [walk(&t, &[("q", "volcano")])];
        let holes = Lab::new(&walks).holes(2);
        let referer = at(&holes, &Loc::Header("referer".into()));
        assert_eq!((referer.kind, the_way(referer)), (Kind::Browsers, &Expr::text(frame)));
    }

    pub(crate) fn mix(s: &str) -> String {
        let mut h: u32 = 0x811c_9dc5;
        for c in s.encode_utf16() {
            h ^= u32::from(c);
            h = h.wrapping_mul(0x0100_0193);
            h ^= h >> 13;
        }
        format!("{h:08x}")
    }

    /// A header a page's own function makes by a mixer no standard operation is: cut from the script the recording
    /// names as the call's sender, run in the sandbox, verified on every sighting, and rebuilt for a word neither
    /// walk sent. The site is a fixture here; the engine names none.
    #[test]
    fn a_header_a_function_of_the_sending_script_makes_is_cut_and_run() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the sender-program test is skipped");
            return;
        }
        const SCRIPT: &str = "(function () {\n  function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n  window.searchSigned = function (q, done) {\n    var ts = String(Date.now());\n    fetch('/api/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q) + mix(q + '|' + ts) } }).then(function (r) { return r.json(); }).then(done);\n  };\n})();\n";
        let walked = |q: &str, ts: &str| {
            let sig = format!("{}{}", mix(&format!("{ts}|{q}")), mix(&format!("{q}|{ts}")));
            trace(vec![call("GET", &format!("https://sign.example/api/search?q={q}"), &[("x-ts", ts), ("x-sig", &sig)], None, r#"{"results":[]}"#)])
        };
        let (first, second) = (walked("lamp", "1794398399120"), walked("desk", "1794398401877"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let line = SCRIPT.lines().position(|l| l.contains("fetch(")).expect("the fetch line") as u32;
        let col = SCRIPT.lines().nth(line as usize).unwrap().find("fetch(").unwrap() as u32;
        let producer = crate::signing::Producer { script: "https://sign.example/s/app.js".into(), at: crate::slice::offset_at(SCRIPT, line, col).expect("the frame sits in its script"), frame: true };
        let scripts = vec![("https://sign.example/s/app.js".to_string(), SCRIPT.to_string())];
        let lab = Lab::new(&walks).reading(0, Vec::new(), None, Some(producer), scripts);
        let holes = lab.holes(0);
        let sig = at(&holes, &Loc::Header("x-sig".into()));
        assert_eq!((sig.kind, sig.ways[0].rung), (Kind::Function, 2));
        let source = match the_way(sig) {
            Expr::Program { source, .. } => source.clone(),
            other => panic!("the cut header is not a program: {other:?}"),
        };
        // Rebuilt for a word neither walk sent: the program signs a new request, reading its word off the address and
        // its clock off `x-ts`, as a call does.
        let ts = "1794398500000";
        let url = url::Url::parse("https://sign.example/api/search?q=teapot").unwrap();
        let req = crate::replay::Request { method: "GET".into(), url, exchange: 0, headers: vec![("x-ts".into(), ts.into())], body: None };
        let made = crate::generated::compute(&source, &req, &[], &crate::generated::Environment::default()).expect("the program runs for a new word");
        assert_eq!(made, format!("{}{}", mix(&format!("{ts}|teapot")), mix(&format!("teapot|{ts}"))));
    }

    /// A function that reads a value the call does not carry (a seed the page kept in storage, which the request
    /// never sends) makes a value the sandbox cannot reproduce: the program is refused, and the place stays open.
    #[test]
    fn a_function_that_reads_a_value_the_call_does_not_carry_is_refused() {
        if !crate::sandbox::available() {
            eprintln!("no signing runtime on this machine: the refusal test is skipped");
            return;
        }
        const SCRIPT: &str = "(function () {\n  function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n  window.searchSigned = function (q, done) {\n    var ts = String(Date.now());\n    var seed = localStorage.getItem('seed') || '';\n    fetch('/api/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q + '|' + seed) } }).then(function (r) { return r.json(); }).then(done);\n  };\n})();\n";
        // The browser that walked had a seed; the request never carried it, so the sandbox reads none.
        let walked = |q: &str, ts: &str| {
            let sig = mix(&format!("{ts}|{q}|dev-7f3a9c21"));
            trace(vec![call("GET", &format!("https://sign.example/api/search?q={q}"), &[("x-ts", ts), ("x-sig", &sig)], None, r#"{"results":[]}"#)])
        };
        let (first, second) = (walked("lamp", "1794398399120"), walked("desk", "1794398401877"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let line = SCRIPT.lines().position(|l| l.contains("fetch(")).expect("the fetch line") as u32;
        let col = SCRIPT.lines().nth(line as usize).unwrap().find("fetch(").unwrap() as u32;
        let producer = crate::signing::Producer { script: "https://sign.example/s/app.js".into(), at: crate::slice::offset_at(SCRIPT, line, col).expect("the frame sits in its script"), frame: true };
        let scripts = vec![("https://sign.example/s/app.js".to_string(), SCRIPT.to_string())];
        let holes = Lab::new(&walks).reading(0, Vec::new(), None, Some(producer), scripts).holes(0);
        let sig = at(&holes, &Loc::Header("x-sig".into()));
        assert_eq!((sig.kind, sig.ways.len()), (Kind::Open, 0), "a program that reads what the call does not carry is refused");
    }

    /// The frame a fixture's sending script calls `fetch` from, as the recording names it.
    fn the_fetch_frame(script: &str) -> crate::signing::Producer {
        let line = script.lines().position(|l| l.contains("fetch(")).expect("the fetch line") as u32;
        let col = script.lines().nth(line as usize).unwrap().find("fetch(").unwrap() as u32;
        crate::signing::Producer { script: "https://sign.example/s/app.js".into(), at: crate::slice::offset_at(script, line, col).expect("the frame sits in its script"), frame: true }
    }

    fn the_fetch_frame_in(url: &str, script: &str) -> crate::signing::Producer {
        let line = script.lines().position(|l| l.contains("fetch(")).expect("the fetch line") as u32;
        let col = script.lines().nth(line as usize).unwrap().find("fetch(").unwrap() as u32;
        crate::signing::Producer { script: url.into(), at: crate::slice::offset_at(script, line, col).expect("the frame sits in its script"), frame: true }
    }

    fn stored(local: &[(&str, &str)]) -> crate::sandbox::Storage {
        crate::sandbox::Storage { local: local.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), session: Default::default() }
    }

    /// A function that reads the page's world — a cookie of the jar and a seed the page keeps in its storage, neither
    /// of which the call carries as itself — is cut and kept with each read a hole of its own: the cookie from the
    /// jar, the seed from the page's storage. Held to each walk with that walk's own seed, and rebuilt for a word and a
    /// seed neither walk had, as a call feeds it. The site is a fixture here; the engine names none.
    #[test]
    fn a_function_that_reads_the_pages_cookie_and_storage_is_cut_with_each_read_a_hole() {
        if crate::sandbox::runtime().is_none() {
            eprintln!("no signing runtime on this machine: the test is skipped");
            return;
        }
        const SCRIPT: &str = "(function () {\n  function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n  function vid() { var m = document.cookie.match(/(?:^|; )vid=([^;]*)/); return m ? m[1] : ''; }\n  window.searchSigned = function (q, done) {\n    var ts = String(Date.now());\n    var seed = localStorage.getItem('seed') || '';\n    fetch('/api/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q + '|' + seed + '|' + vid()) } }).then(function (r) { return r.json(); }).then(done);\n  };\n})();\n";
        let walked = |q: &str, ts: &str, seed: &str| {
            let sig = mix(&format!("{ts}|{q}|{seed}|v_42"));
            trace(vec![call("GET", &format!("https://sign.example/api/search?q={q}"), &[("x-ts", ts), ("x-sig", &sig), ("cookie", "theme=dark; vid=v_42")], None, r#"{"results":[]}"#)])
        };
        let (first, second) = (walked("lamp", "1794398399120", "sd-one"), walked("desk", "1794398401877", "sd-two"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let scripts = vec![("https://sign.example/s/app.js".to_string(), SCRIPT.to_string())];
        let lab = Lab::new(&walks).reading(0, Vec::new(), None, Some(the_fetch_frame(SCRIPT)), scripts).stored(vec![Some(stored(&[("seed", "sd-one")])), Some(stored(&[("seed", "sd-two")]))]);
        let holes = lab.holes(0);
        let sig = at(&holes, &Loc::Header("x-sig".into()));
        assert_eq!((sig.kind, sig.ways.first().map(|w| w.rung)), (Kind::Function, Some(2)), "refused: {:?}", lab.refusals());
        let Expr::ProgramReading { source, reads, .. } = the_way(sig) else { panic!("the cut header is not a program with reads: {:?}", the_way(sig)) };
        let reached: Vec<&route::Reach> = reads.iter().map(|f| &f.read).collect();
        assert_eq!(reached, [&route::Reach::Local("seed".into()), &route::Reach::Cookie("vid".into())], "the seed and the one cookie it reads, not the jar's other cookie");
        assert_eq!(reads[0].from, Expr::Stored { area: route::expr::Area::Local, key: "seed".into() });
        assert_eq!(reads[1].from, Expr::Cookie { name: "vid".into(), here: false });
        // A call for another word, with the seed and the cookie the node holds now.
        let ts = "1794398500000";
        let req = crate::replay::Request { method: "GET".into(), url: url::Url::parse("https://sign.example/api/search?q=teapot").unwrap(), exchange: 0, headers: vec![("x-ts".into(), ts.into())], body: None };
        let fed = [(route::Reach::Local("seed".into()), Some("sd-three".to_string())), (route::Reach::Cookie("vid".into()), Some("v_43".to_string()))];
        let made = crate::generated::compute_reading(source, &req, &[], &crate::generated::Environment::default(), &fed).expect("the program runs for a new word");
        assert_eq!(made, mix(&format!("{ts}|teapot|sd-three|v_43")));
    }

    /// A function that reads what no source the node holds answers (the page's own markup, here) is refused, and the
    /// refusal names the read.
    #[test]
    fn a_function_that_reads_what_the_node_holds_no_source_for_is_refused_naming_the_read() {
        if crate::sandbox::runtime().is_none() {
            eprintln!("no signing runtime on this machine: the test is skipped");
            return;
        }
        const SCRIPT: &str = "(function () {\n  function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n  window.searchSigned = function (q, done) {\n    var ts = String(Date.now());\n    var m = document.querySelector('meta[name=k]');\n    fetch('/api/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q + '|' + (m ? m.content : 'none')) } }).then(function (r) { return r.json(); }).then(done);\n  };\n})();\n";
        let walked = |q: &str, ts: &str| {
            let sig = mix(&format!("{ts}|{q}|k-in-the-markup"));
            trace(vec![call("GET", &format!("https://sign.example/api/search?q={q}"), &[("x-ts", ts), ("x-sig", &sig)], None, r#"{"results":[]}"#)])
        };
        let (first, second) = (walked("lamp", "1794398399120"), walked("desk", "1794398401877"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let scripts = vec![("https://sign.example/s/app.js".to_string(), SCRIPT.to_string())];
        let lab = Lab::new(&walks).reading(0, Vec::new(), None, Some(the_fetch_frame(SCRIPT)), scripts);
        let holes = lab.holes(0);
        let sig = at(&holes, &Loc::Header("x-sig".into()));
        assert_eq!((sig.kind, sig.ways.len()), (Kind::Open, 0));
        let refusals = lab.refusals();
        let (_, why) = refusals.iter().find(|(at, _)| *at == Loc::Header("x-sig".into())).expect("the refusal is said");
        assert!(why.contains("document.querySelector meta[name=k]"), "it names the read: {why}");
    }

    /// The least count whose SHA-256 after `challenge` and a colon opens with `zeros` zeros, as a page's solver finds it.
    fn work(challenge: &str, zeros: u32) -> String {
        route::expr::solve(route::Algo::Sha256, &format!("{challenge}:"), "", zeros).expect("a count within the bound").to_string()
    }

    /// A count the page searched for, so that the digest of the challenge it was handed and the count opens with
    /// zeros, is read as that search: the digest, the part of the request that is the challenge, the join and the
    /// zeros, from the sightings alone. The node's own search then finds a count the condition accepts for a challenge
    /// neither walk was handed.
    #[test]
    fn a_count_the_page_searched_for_is_read_as_the_search_and_the_condition_it_met() {
        let walked = |q: &str, c: &str| trace(vec![call("GET", &format!("https://work.example/api/search?q={q}&c={c}&n={}", work(c, 3)), &[], None, r#"{"results":[]}"#)]);
        let (first, second) = (walked("lamp", "ch-81f2"), walked("desk", "ch-07aa"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        let n = at(&holes, &query("n"));
        assert_eq!((n.kind, n.ways[0].rung), (Kind::Digest, 1));
        let Expr::Solve { algo, before, after, zeros } = the_way(n) else { panic!("the count is not a search: {:?}", the_way(n)) };
        assert_eq!((*algo, *zeros), (route::Algo::Sha256, 3));
        assert_eq!(**before, Expr::Join { parts: vec![Expr::Sent { part: route::Sent::Query("c".into()) }, Expr::text(":")], with: String::new() });
        assert_eq!(**after, Expr::text(""));
        let found = route::expr::solve(*algo, "ch-new1:", "", *zeros).expect("the node finds a count");
        assert!(route::Algo::Sha256.hash(&format!("ch-new1:{found}")).starts_with("000"));
    }

    /// A number that moves with nothing, whose digest with the request's other parts opens with no more zeros than
    /// chance gives, is no search: it stays open.
    #[test]
    fn a_number_no_digest_of_the_request_meets_a_condition_for_is_no_search() {
        let walked = |q: &str, c: &str, n: &str| trace(vec![call("GET", &format!("https://work.example/api/search?q={q}&c={c}&n={n}"), &[], None, r#"{"results":[]}"#)]);
        let (first, second) = (walked("lamp", "ch-81f2", "48213"), walked("desk", "ch-07aa", "90377"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(at(&holes, &query("n")).kind, Kind::Open);
    }

    /// The ciphered reply, as `/s/cipher.js` writes it: the JSON XORed with the key the page's own `unpack` knows,
    /// then base64. `charCodeAt` reads UTF-16 units, as the page does.
    fn cipher(text: &str) -> String {
        use base64::Engine;
        let xored: Vec<u8> = text.bytes().map(|b| b ^ 0x5a).collect();
        base64::engine::general_purpose::STANDARD.encode(xored)
    }

    /// An answer no standard reader reads, that the site's own function unpacks: the decoder is cut from the script
    /// that read the reply, run over every walk's reply, and kept because it turns each into JSON that says that
    /// walk's word back. Run over a reply for a word neither walk had, it unpacks it the same. The engine names no site.
    #[test]
    fn an_answer_only_the_sites_own_function_unpacks_is_cut_and_run() {
        if crate::sandbox::runtime().is_none() {
            eprintln!("no signing runtime on this machine: the decoder test is skipped");
            return;
        }
        const SCRIPT: &str = "(function () {\n  function unpack(t) { var raw = atob(t), out = ''; for (var i = 0; i < raw.length; i++) out += String.fromCharCode(raw.charCodeAt(i) ^ 0x5a); return JSON.parse(out); }\n  window.searchCipher = function (q, done) {\n    fetch('/api/cipher-answer/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n  };\n})();\n";
        let walked = |q: &str| {
            let reply = cipher(&format!("{{\"query\":\"{q}\",\"results\":[{{\"title\":\"{q} one\"}},{{\"title\":\"{q} two\"}}]}}"));
            trace(vec![call("GET", &format!("https://cy.example/api/cipher-answer/search?q={q}"), &[], None, &reply)])
        };
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let scripts = vec![("https://cy.example/s/cipher.js".to_string(), SCRIPT.to_string())];
        let lab = Lab::new(&walks).reading(0, Vec::new(), None, Some(the_fetch_frame_in("https://cy.example/s/cipher.js", SCRIPT)), scripts);
        let (decode, sha) = lab.decoder(0).expect("the decoder is cut and verified");
        assert_eq!(sha, None, "no recording sha was handed in this test");
        // Run over a reply for a word neither walk had.
        let reply = cipher("{\"query\":\"teapot\",\"results\":[{\"title\":\"teapot one\"}]}");
        let env = crate::generated::Environment::default();
        let out = crate::generated::decode(&decode.source, &reply, &env).expect("the decoder runs");
        let v: serde_json::Value = serde_json::from_str(&out).expect("it answers JSON");
        assert_eq!(v["results"][0]["title"], "teapot one");
    }

    /// A reply that reads as JSON by itself is no decode: the standard readers have it, and the decoder is not reached.
    #[test]
    fn a_reply_that_reads_as_json_is_no_decode() {
        if crate::sandbox::runtime().is_none() {
            return;
        }
        const SCRIPT: &str = "(function () {\n  function unpack(t) { return JSON.parse(t); }\n  window.searchCipher = function (q, done) {\n    fetch('/api/plain/search?q=' + encodeURIComponent(q)).then(function (r) { return r.text(); }).then(function (t) { done(unpack(t)); });\n  };\n})();\n";
        let walked = |q: &str| trace(vec![call("GET", &format!("https://cy.example/api/plain/search?q={q}"), &[], None, &format!("{{\"query\":\"{q}\",\"results\":[{{\"title\":\"{q} one\"}}]}}"))]);
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let scripts = vec![("https://cy.example/s/cipher.js".to_string(), SCRIPT.to_string())];
        let lab = Lab::new(&walks).reading(0, Vec::new(), None, Some(the_fetch_frame_in("https://cy.example/s/cipher.js", SCRIPT)), scripts);
        assert!(lab.decoder(0).is_none(), "a reply that is already JSON needs no decoder");
    }

    /// A walk that never made the call says nothing of it: its places are read from the walks that did.
    #[test]
    fn a_walk_that_never_made_the_call_is_no_sighting_of_it() {
        let first = trace(vec![call("GET", "https://shop.example/api/search?q=lamp&n=10", &[], None, "{}")]);
        let second = trace(vec![call("GET", "https://shop.example/api/other", &[], None, "{}")]);
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(at(&holes, &query("q")).sent, [Some("lamp".to_string()), None]);
        assert_eq!(at(&holes, &query("q")).kind, Kind::Callers, "one sighting reads as one walk does");
        assert_eq!(at(&holes, &query("q")).axes, Axes::default());
    }

    /// The caller's date, sent in the site's own written form: two walks for two dates, each sent as the day, the
    /// month and the year with slashes, are one format of the slot, and a call for a third date sends it so.
    #[test]
    fn the_callers_date_in_the_sites_format_is_read_from_two_walks() {
        let walked = |d: &str| trace(vec![call("GET", &format!("https://shop.example/api/slots?d={d}&n=2"), &[], None, "{}")]);
        let (first, second) = (walked("14%2F03%2F2026"), walked("05%2F11%2F2026"));
        let walks = [walk(&first, &[("date", "2026-03-14")]), walk(&second, &[("date", "2026-11-05")])];
        let holes = Lab::new(&walks).holes(0);
        let d = at(&holes, &query("d"));
        assert_eq!(d.kind, Kind::Callers);
        assert!(matches!(the_way(d), Expr::Format { .. }), "{:?}", the_way(d));
        assert_eq!(crate::lab::forms::sends(the_way(d), "date", "2027-01-31").as_deref(), Some("31/01/2027"));
        assert_eq!(d.left, None, "a day above twelve and a day below ten leave one reading");
    }

    /// One walk on the fourth of March: the day and the month could each be the other, and the hole says so, with
    /// the value a next walk is to be asked. A second walk on that value leaves one reading.
    #[test]
    fn a_date_one_walk_cannot_read_says_which_value_would_separate_its_readings() {
        let walked = |d: &str| trace(vec![call("GET", &format!("https://shop.example/api/slots?d={d}&n=2"), &[], None, "{}")]);
        let first = walked("04%2F03%2F2026");
        let alone = [walk(&first, &[("date", "2026-03-04")])];
        let holes = Lab::new(&alone).holes(0);
        let d = at(&holes, &query("d"));
        assert_eq!(d.kind, Kind::Callers);
        let left = d.left.as_ref().expect("two readings left standing");
        assert_eq!(left.readings.len(), 2);
        assert_eq!(left.separates, ("date".to_string(), "2026-03-25".to_string()));
        let second = walked("25%2F03%2F2026");
        let walks = [walk(&first, &[("date", "2026-03-04")]), walk(&second, &[("date", "2026-03-25")])];
        let holes = Lab::new(&walks).holes(0);
        let d = at(&holes, &query("d"));
        assert_eq!(d.left, None, "the site said which");
        assert_eq!(crate::lab::forms::sends(the_way(d), "date", "2026-12-01").as_deref(), Some("01/12/2026"));
    }

    /// The caller says a city and the search sends its code, which no call looked up: the page's script ships the
    /// table. Two walks for two cities each send the code of the record their city is in, and the hole is a lookup of
    /// that table, which sends a third city's code; a word the table does not list stops the call.
    #[test]
    fn the_callers_word_turned_into_the_sites_code_by_a_table_its_script_ships_is_a_lookup() {
        let walked = |code: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?city={code}&n=2"), &[], None, "{}")]);
        let (first, second) = (walked("LIS"), walked("OSL"));
        let walks = [walk(&first, &[("q", "Lisbon")]), walk(&second, &[("q", "Oslo")])];
        let table = vec![serde_json::json!({ "name": "Lisbon", "code": "LIS" }), serde_json::json!({ "name": "Oslo", "code": "OSL" }), serde_json::json!({ "name": "Porto", "code": "OPO" })];
        let holes = Lab::new(&walks).reading(0, Vec::new(), Some("5c1d".into()), None, Vec::new()).with_tables(vec![table]).holes(0);
        let city = at(&holes, &query("city"));
        assert_eq!(city.kind, Kind::Callers);
        assert_eq!(city.ways[0].rung, 1, "the site's data kept on the route, as a digest's constant");
        assert!(matches!(the_way(city), Expr::Lookup { take, .. } if take == "/code"), "{:?}", the_way(city));
        assert_eq!(crate::lab::forms::sends(the_way(city), "q", "Porto").as_deref(), Some("OPO"));
        assert_eq!(crate::lab::forms::sends(the_way(city), "q", "Atlantis"), None);
        // Without the table the code is nothing the walks show.
        let holes = Lab::new(&walks).holes(0);
        assert_eq!(at(&holes, &query("city")).kind, Kind::Open);
    }

    /// A search posted as a protobuf message with no schema: each field of the message is a place, the word's the
    /// caller's, the count fixed, and the step is written as the message's fields, which a call for another word
    /// writes back as that word's message, byte for byte.
    #[test]
    fn a_binary_bodys_fields_are_places_like_any_other() {
        let message = |word: &str| {
            let mut b = vec![0x0a, word.len() as u8];
            b.extend(word.as_bytes());
            b.extend([0x10, 0x14]);
            String::from_utf8(b).unwrap()
        };
        let walked = |word: &str| trace(vec![call("POST", "https://shop.example/api/search", &[("content-type", "application/x-protobuf")], Some(&message(word)), "{}")]);
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let lab = Lab::new(&walks);
        let holes = lab.holes(0);
        let word = at(&holes, &Loc::Json("/0/text".into()));
        assert_eq!(word.kind, Kind::Callers);
        assert_eq!(at(&holes, &Loc::Json("/1/int".into())).kind, Kind::Fixed);
        let step = crate::lab::compile::step(&lab, 0).expect("a step");
        assert!(matches!(step.body, Some(route::Form::Wire { codec: route::wire::Codec::Protobuf, .. })), "{:?}", step.body);
        struct Q;
        impl route::World for Q {
            fn slot(&self, n: &str) -> Option<String> { (n == "q").then(|| "teapot".to_string()) }
            fn cookie(&self, _: &str) -> Option<String> { None }
            fn read(&self, _: &str, _: &route::At) -> Option<String> { None }
            fn answered(&self, _: &str) -> bool { false }
            fn fresh(&mut self, id: &str, _: route::Clock) -> String { id.into() }
            fn now_ms(&self) -> u64 { 0 }
            fn digits(&mut self, n: usize) -> String { "0".repeat(n) }
            fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> { Err(String::new()) }
            fn same_site(&self, _: &str, _: &str) -> bool { true }
        }
        let built = route::fill::request(&step, &mut Q).expect("it builds");
        assert_eq!(built.body, Some(message("teapot")));
    }

    /// A message no text carries (a field of 150 bytes, a count of 300: both written with bytes past 127) is the
    /// walk's bytes, and a call for another word sends the same bytes with that word in its place, byte for byte, as
    /// the transport sends them.
    #[test]
    fn a_binary_body_that_is_no_text_is_sent_as_its_bytes() {
        let filler = "x".repeat(150);
        let message = |word: &str| {
            let mut b = vec![0x0a, word.len() as u8];
            b.extend(word.as_bytes());
            b.extend([0x10, 0xac, 0x02]); // field 2: 300
            b.extend([0x1a, 0x96, 0x01]); // field 3: 150 bytes
            b.extend(filler.as_bytes());
            b
        };
        assert!(std::str::from_utf8(&message("lamp")).is_err(), "the message is no text");
        let walked = |word: &str| trace(vec![call("POST", "https://shop.example/api/search", &[("content-type", "application/x-protobuf")], Some(&route::wire::carried(&message(word))), "{}")]);
        let (first, second) = (walked("lamp"), walked("desk"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let lab = Lab::new(&walks);
        let holes = lab.holes(0);
        assert_eq!(at(&holes, &Loc::Json("/0/text".into())).kind, Kind::Callers);
        assert_eq!(at(&holes, &Loc::Json("/1/int".into())).sent[0].as_deref(), Some("300"));
        let step = crate::lab::compile::step(&lab, 0).expect("a step");
        struct Q;
        impl route::World for Q {
            fn slot(&self, n: &str) -> Option<String> { (n == "q").then(|| "teapot".to_string()) }
            fn cookie(&self, _: &str) -> Option<String> { None }
            fn read(&self, _: &str, _: &route::At) -> Option<String> { None }
            fn answered(&self, _: &str) -> bool { false }
            fn fresh(&mut self, id: &str, _: route::Clock) -> String { id.into() }
            fn now_ms(&self) -> u64 { 0 }
            fn digits(&mut self, n: usize) -> String { "0".repeat(n) }
            fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> { Err(String::new()) }
            fn same_site(&self, _: &str, _: &str) -> bool { true }
        }
        let built = route::fill::request(&step, &mut Q).expect("it builds");
        assert_eq!(built.body.as_deref().map(route::wire::bytes_of), Some(message("teapot")));
        // The route file holds the message as its fields, and reads back as written.
        let said = serde_json::to_string(&step.body).unwrap();
        assert_eq!(serde_json::from_str::<Option<route::Form>>(&said).unwrap(), step.body);
    }

    /// Two fields of the site's table say both walks' words (a name and an alias), and they part on a word the table
    /// lists: the hole says so. With no proposer the first field stands, as the search found it; a proposer shown only
    /// the two readings names the other, which is one the search already held to every sighting.
    #[test]
    fn which_table_field_a_word_is_held_to_is_the_proposers_where_the_walks_cannot_say() {
        let walked = |code: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?city={code}"), &[], None, "{}")]);
        let (first, second) = (walked("LIS"), walked("OSL"));
        let walks = [walk(&first, &[("q", "Lisbon")]), walk(&second, &[("q", "Oslo")])];
        let table = vec![
            serde_json::json!({ "name": "Lisbon", "alias": "Lisbon", "code": "LIS" }),
            serde_json::json!({ "name": "Oslo", "alias": "Oslo", "code": "OSL" }),
            serde_json::json!({ "name": "Porto", "alias": "Oporto", "code": "OPO" }),
        ];
        let lab = || Lab::new(&walks).reading(0, Vec::new(), None, None, Vec::new()).with_tables(vec![table.clone()]);
        let holes = lab().holes(0);
        let city = at(&holes, &query("city"));
        let left = city.left.as_ref().expect("two fields left standing");
        assert_eq!((left.readings.len(), left.separates.1.as_str(), left.by_proposer), (2, "Porto", false));
        assert_eq!(crate::lab::forms::sends(the_way(city), "q", "Porto").as_deref(), Some("OPO"), "with no proposer, the first field the search found");
        let asked = std::rc::Rc::new(std::cell::RefCell::new(None));
        let seen = asked.clone();
        let proposer: crate::lab::propose::Proposer = std::rc::Rc::new(move |ask: &serde_json::Value| {
            *seen.borrow_mut() = Some(ask.clone());
            Some(serde_json::json!({ "reading": 1 }))
        });
        let holes = lab().with_proposer(Some(proposer)).holes(0);
        let city = at(&holes, &query("city"));
        assert!(city.left.as_ref().is_some_and(|l| l.by_proposer));
        assert_eq!(crate::lab::forms::sends(the_way(city), "q", "Oporto").as_deref(), Some("OPO"), "the alias, as the proposer named it");
        let shown = asked.borrow().clone().expect("the proposer was asked");
        assert_eq!(shown["readings"].as_array().map(Vec::len), Some(2), "shown only what is open: {shown}");
        assert_eq!(shown["separates"]["value"], "Porto");
    }

    /// A slot the ways say only is free text is a place where the proposer says so and every walk's value is a name;
    /// with no proposer it stays text.
    #[test]
    fn a_free_text_slot_is_a_place_where_the_proposer_says_so() {
        let walked = |q: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?q={q}"), &[], None, r#"{"results":[{"title":"x"},{"title":"y"}]}"#)]);
        let (first, second) = (walked("Lisbon"), walked("Oslo"));
        let walks = [walk(&first, &[("q", "Lisbon")]), walk(&second, &[("q", "Oslo")])];
        let kind = |lab: Lab| crate::lab::compile::route(&lab, 0, "shop.example").and_then(|b| b.meaning.kinds.get("q").copied());
        assert_eq!(kind(Lab::new(&walks)), Some(route::meaning::Kind::Text));
        let place: crate::lab::propose::Proposer = std::rc::Rc::new(|_| Some(serde_json::json!({ "kind": "place" })));
        assert_eq!(kind(Lab::new(&walks).with_proposer(Some(place))), Some(route::meaning::Kind::Place));
    }

    /// A value the walk read from an earlier reply is sent as the walk read it where a later reply does not hold the
    /// place: an experiment's code, a visitor's id, a piece of the state a page renders for its own load. A fresh load
    /// that omits it is no reason to stop the call — the browser would have had the page's own load too — and the
    /// value that stands in is a value the walk really sent, not a made-up one.
    #[test]
    fn a_value_a_fresh_reply_does_not_hold_is_sent_as_the_walk_read_it() {
        let mut page = call("GET", "https://shop.example/flights?dcity=sha", &[], None, r#"<html><script>var abt="M:63,251031_IBU_lppg:A;M:62,4c7d21ab:"</script></html>"#);
        page.response_mime = "text/html".into();
        let walked = trace(vec![
            page,
            call("POST", "https://shop.example/api/search", &[], Some(r#"{"abt":"4c7d21ab"}"#), r#"{"flights":[{"from":"Shanghai"}]}"#),
        ]);
        let walks = [walk(&walked, &[("dcity", "sha")])];
        let lab = Lab::new(&walks);
        let holes = lab.holes(1);
        let abt = at(&holes, &Loc::Json("/abt".into()));
        assert_eq!(abt.kind, Kind::Read, "{:?}", abt.ways);
        assert!(matches!(the_way(abt), Expr::Read { .. }), "{:?}", abt.ways);
        assert_eq!(abt.ways.len(), 2, "the read, then what the walk read there: {:?}", abt.ways);
        assert_eq!(&abt.ways[1].expr, &Expr::text("4c7d21ab"));
        // Filled against a reply that no longer holds the place (the world reads no value there), the call is made
        // with the walk's own reading rather than stopped.
        let step = crate::lab::compile::step(&lab, 1).expect("a step");
        struct Fresh;
        impl route::World for Fresh {
            fn slot(&self, n: &str) -> Option<String> { (n == "dcity").then(|| "sha".to_string()) }
            fn cookie(&self, _: &str) -> Option<String> { None }
            fn read(&self, _: &str, _: &route::At) -> Option<String> { None }
            fn answered(&self, _: &str) -> bool { false }
            fn fresh(&mut self, id: &str, _: route::Clock) -> String { id.into() }
            fn now_ms(&self) -> u64 { 0 }
            fn digits(&mut self, n: usize) -> String { "0".repeat(n) }
            fn file(&self, _: &str, _: route::FileFact) -> Result<String, String> { Err(String::new()) }
            fn same_site(&self, _: &str, _: &str) -> bool { true }
        }
        let built = route::fill::request(&step, &mut Fresh).expect("it builds without the place");
        assert_eq!(built.body.as_deref(), Some(r#"{"abt":"4c7d21ab"}"#), "the walk's reading, not a stopped call");
    }

    /// A value that holds a word the page was asked is the caller's, and no value of the walk's stands in for it: a
    /// call never asks the site for the word the walk asked.
    #[test]
    fn a_value_holding_the_word_the_page_was_asked_is_never_the_walks_to_send() {
        assert!(holds_a_word("/search/pins/?q=garden&rs=typed", &["garden"]));
        assert!(holds_a_word("sha-1234", &["sha"]), "a word inside a value's own words is the word");
        assert!(!holds_a_word("4c7d21ab", &["sha"]));
        assert!(!holds_a_word("gardenia", &["garden"]), "a longer word that merely starts alike is not the word");
    }
}
