//! The four tests a site is held to before a route learned by example is kept (`CLAUDE.md`, `docs/REBUILD.md`): a
//! second value answers as itself, a nonsense value finds nothing where the site has a nothing, the walk's own value
//! answers as the walk did, and no write is sent twice.
//!
//! Each test is asked over a [`Site`], so a recording ([`crate::lab::site::Recorded`]) answers what it holds and the
//! live site ([`crate::lab::site::Live`]) answers the rest. A body whose steps the site cannot be asked — one with a
//! step that writes, which `Live` refuses — is not sent: its read tests say so and never reach the site.
//!
//! Nothing here is a new judgement. "Answers as itself" and "finds nothing" are read by the engine's own readers of an
//! answer ([`crate::lab::answer::said_lines`], [`nothing_of_its_own`], [`crate::answer::found_nothing_for`]), the same
//! the node's caller reads a reply by. A site that fills in for any word — a nonsense value still gets results of its
//! own — is said as such, not failed: the second-value test is what flags it, and the two tests together are the word.
//!
//! The verdict is data: which tests ran, which held, which could not be asked and why. A body is never changed by it.

use std::collections::HashMap;

use serde_json::Value;

use crate::lab::answer::{nothing_of_its_own, said_lines, TOO_LITTLE_TO_TELL};
use crate::lab::call::{call, Stopped};
use crate::lab::site::Site;
use unbrowse_route as route;

/// One of the four tests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Test {
    /// The walk's own value answers as the walk did.
    WalksOwnValue,
    /// A second value answers as itself, not as the first.
    SecondValue,
    /// A nonsense value finds nothing where the site has a nothing.
    NonsenseValue,
    /// A write is learned from its walk and never sent to check.
    NoWriteTwice,
}

impl Test {
    pub fn name(self) -> &'static str {
        match self {
            Test::WalksOwnValue => "the walk's own value answers as the walk did",
            Test::SecondValue => "a second value answers as itself",
            Test::NonsenseValue => "a nonsense value finds nothing",
            Test::NoWriteTwice => "no write is sent twice",
        }
    }
}

/// How a test came out.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Ran, and the site held the property.
    Held(String),
    /// Ran, and the site answered the same whatever the value: it fills in for any word. Said, not failed.
    FillsForAny(String),
    /// The question could not be put: the recording does not hold it, the step writes, or the answer says too little
    /// to tell two apart.
    CouldNotAsk(String),
    /// Ran, and the body did not hold: a real problem with the route.
    Failed(String),
}

impl Outcome {
    pub fn held(&self) -> bool {
        matches!(self, Outcome::Held(_))
    }
    /// How it came out, in a word or three.
    pub fn word(&self) -> &'static str {
        match self {
            Outcome::Held(_) => "held",
            Outcome::FillsForAny(_) => "the site fills in for any word",
            Outcome::CouldNotAsk(_) => "could not ask",
            Outcome::Failed(_) => "failed",
        }
    }
    fn why(&self) -> &str {
        match self {
            Outcome::Held(w) | Outcome::FillsForAny(w) | Outcome::CouldNotAsk(w) | Outcome::Failed(w) => w,
        }
    }
}

/// What the site said of a body.
#[derive(Clone, Debug)]
pub struct Verdict {
    pub checks: Vec<(Test, Outcome)>,
}

impl Verdict {
    /// A line per test: what it asked, how it came out, and why.
    pub fn lines(&self) -> Vec<String> {
        self.checks.iter().map(|(t, o)| format!("{}: {} ({})", t.name(), o.word(), o.why())).collect()
    }
    fn of(test: Test) -> impl Fn(Outcome) -> (Test, Outcome) {
        move |o| (test, o)
    }
}

/// A value no site has a word for, from `walked`'s own: a fixed improbable run of letters as long as the walk's value
/// (so a site that reads a length still answers), the same for the same value every run — never random, so a verify
/// is the same run twice. A value with no letters (an id, a number) keeps its own shape as a run of nines.
fn nonsense(walked: &str) -> String {
    const RUN: &str = "zqxjvkwfyb";
    let n = walked.chars().count().clamp(RUN.len(), RUN.len() * 3);
    if walked.chars().any(|c| c.is_alphabetic()) {
        RUN.chars().cycle().take(n).collect()
    } else {
        "9".repeat(walked.chars().count().max(6))
    }
}

/// `walked`, with every non-secret slot the body asks replaced by a value no site has a word for ([`nonsense`]); a
/// secret and an upload keep the walk's, so only the searchable value is made nonsense.
fn nonsense_inputs(body: &route::Route, walked: &HashMap<String, String>) -> HashMap<String, String> {
    let secret = |name: &str| body.slots.iter().any(|s| s.name == name && s.secret);
    let uploads: Vec<&str> = body.steps.iter().filter_map(|s| if let Some(route::Form::Upload { slot, .. }) = &s.body { Some(slot.as_str()) } else { None }).collect();
    // A slot whose kind says what a value of it is (a date) is asked a nonsense value of that kind (`meaning`), which
    // the route can send; any other, a nonsense word.
    walked
        .iter()
        .map(|(name, value)| {
            let made = if secret(name) || uploads.contains(&name.as_str()) { value.clone() } else { crate::lab::meaning::nonsense_of_its_kind(body, name, value).unwrap_or_else(|| nonsense(value)) };
            (name.clone(), made)
        })
        .collect()
}

/// The slot the second value moves, the second value and the walk's, where the body knows its answer's records and
/// which field of them says that slot back (`Meaning::records`).
fn by_records(body: &route::Route, walked: &HashMap<String, String>, second: &HashMap<String, String>) -> Option<(String, String, String)> {
    let records = body.meaning.records.as_ref()?;
    records.fields.iter().filter_map(|f| f.says.clone()).find_map(|slot| {
        let (first, theirs) = (walked.get(&slot)?, second.get(&slot)?);
        (first != theirs).then(|| (slot.clone(), theirs.clone(), first.clone()))
    })
}

/// A body's answer step as the judges of an answer read it ([`crate::answer::Judged`]), for `found_nothing`.
fn judged(body: &route::Route) -> Option<crate::answer::Judged> {
    let step = body.step(&body.answer.step)?;
    let secret = |name: &str| body.slots.iter().any(|s| s.name == name && s.secret);
    Some(crate::answer::Judged {
        status: step.expect,
        writes: step.writes,
        sends_a_secret: step.holes.iter().flat_map(|h| &h.ways).flat_map(|w| w.expr.slots()).any(secret),
    })
}

/// The lines an answer says of its own, with the words it was asked struck out ([`said_lines`]): what two answers are
/// told apart by.
fn lines(answer: &crate::trace::Exchange, struck: &[&str]) -> std::collections::BTreeSet<String> {
    said_lines(&crate::lab::answer::answer_of(answer).unwrap_or(Value::Null), struck)
}

/// The site's four tests, asked of `body` with `walked` (the walk's own values), `second` (a different real value,
/// where there is one to try), the session's `jar`, the clock at `now`, over `site`.
pub fn verify(body: &route::Route, walked: &HashMap<String, String>, second: Option<&HashMap<String, String>>, jar: &HashMap<String, String>, now: u64, site: &mut dyn Site) -> Verdict {
    let mut checks = Vec::new();
    // A body with a step that writes is never sent to a site: the write is learned from the walk it was made in. Its
    // read tests cannot be asked, and the one test that holds is that no write was sent.
    if body.steps.iter().any(|s| s.writes) {
        for test in [Test::WalksOwnValue, Test::SecondValue, Test::NonsenseValue] {
            checks.push((test, Outcome::CouldNotAsk("the body writes, and a write is learned from its walk, never sent to check".into())));
        }
        checks.push((Test::NoWriteTwice, Outcome::Held("the body writes and was not sent".into())));
        return Verdict { checks };
    }

    // The walk's own value, first: a body whose own value no longer answers cannot judge another.
    let walked_call = call(body, walked, jar, now, site);
    let walked_words: Vec<&str> = walked.values().map(String::as_str).collect();
    let (walked_lines, walked_ok) = match &walked_call {
        Ok(c) => {
            checks.push((Test::WalksOwnValue, Outcome::Held("the site answered it as the walk did".into())));
            (lines(&c.answer, &walked_words), true)
        }
        Err(stopped) => {
            checks.push(Verdict::of(Test::WalksOwnValue)(walks_own(stopped)));
            (Default::default(), false)
        }
    };

    // A second value: it must answer, and say something of its own beside the walk's answer. Where it answers the same,
    // the site fills in for any word.
    let second_out = match (walked_ok, second) {
        (false, _) => Outcome::CouldNotAsk("the walk's own value did not answer, so nothing is told from a second".into()),
        (true, None) => Outcome::CouldNotAsk("no second value to try".into()),
        // Where the body knows its answer's records and which field says the asked value back, the second value is
        // judged by its records: they say it back, and none says the first (`meaning::records_saying`).
        (true, Some(second)) if by_records(body, walked, second).is_some() => match call(body, second, jar, now, site) {
            Ok(c) => {
                let (slot, theirs, first) = by_records(body, walked, second).expect("matched just above");
                let answer = crate::lab::answer::answer_of(&c.answer).unwrap_or(Value::Null);
                let forms = |v: &str| crate::lab::meaning::said_as(body, &slot, v).into_iter().map(|f| f.to_lowercase()).collect::<Vec<_>>();
                let (n, saying) = crate::lab::meaning::records_saying(body, &answer, &slot, &forms(&theirs)).unwrap_or_default();
                let (_, saying_first) = crate::lab::meaning::records_saying_but(body, &answer, &slot, &forms(&first), &forms(&theirs)).unwrap_or_default();
                if n == 0 {
                    Outcome::CouldNotAsk("the second value's answer holds no records".into())
                } else if saying_first * 2 > n {
                    Outcome::FillsForAny("the second value's records say the first value back".into())
                } else if saying * 2 > n {
                    Outcome::Held("the second value's records say it back, and not the first".into())
                } else {
                    Outcome::CouldNotAsk("the second value's records say neither value back".into())
                }
            }
            Err(Stopped::Unheard { .. }) => Outcome::CouldNotAsk("the recording holds no answer for the second value".into()),
            Err(Stopped::NotAnAnswer(why)) => Outcome::CouldNotAsk(format!("the site did not answer the second value: {why}")),
            Err(other) => Outcome::CouldNotAsk(format!("the second value could not be asked: {other:?}")),
        },
        (true, Some(second)) if walked_lines.len() < TOO_LITTLE_TO_TELL => {
            let _ = second;
            Outcome::CouldNotAsk("the walk's answer says too little to tell two values apart".into())
        }
        (true, Some(second)) => match call(body, second, jar, now, site) {
            Ok(c) => {
                let words: Vec<&str> = second.values().map(String::as_str).collect();
                let theirs = lines(&c.answer, &words);
                if theirs.len() < TOO_LITTLE_TO_TELL {
                    Outcome::CouldNotAsk("the second value's answer says too little to tell two apart".into())
                } else if nothing_of_its_own(&theirs, &walked_lines) {
                    Outcome::FillsForAny("the second value answered the same as the first".into())
                } else {
                    Outcome::Held("the second value answered as itself, not as the first".into())
                }
            }
            Err(Stopped::Unheard { .. }) => Outcome::CouldNotAsk("the recording holds no answer for the second value".into()),
            Err(Stopped::NotAnAnswer(why)) => Outcome::CouldNotAsk(format!("the site did not answer the second value: {why}")),
            Err(other) => Outcome::CouldNotAsk(format!("the second value could not be asked: {other:?}")),
        },
    };
    checks.push((Test::SecondValue, second_out));

    // A nonsense value: the site finds nothing where it has a nothing, or fills in with results of its own.
    let nonsense_out = if !walked_ok {
        Outcome::CouldNotAsk("the walk's own value did not answer, so nothing is told from a nonsense one".into())
    } else {
        let inputs = nonsense_inputs(body, walked);
        match call(body, &inputs, jar, now, site) {
            // A listed word the site's own table does not list has no code to send: the page finds nothing for it,
            // by the site's own data, and nothing is sent.
            Err(Stopped::Stuck { .. }) if crate::lab::meaning::listed_nothing(body, &inputs).is_some() => {
                Outcome::Held("the site's own table lists nothing for a nonsense word, and nothing is sent".into())
            }
            Ok(c) => {
                let words: Vec<&str> = inputs.values().map(String::as_str).collect();
                let theirs = lines(&c.answer, &words);
                if judged(body).is_some_and(|j| crate::answer::found_nothing_for(j, &inputs, &c.answer)) {
                    Outcome::Held("the site said it found nothing for a nonsense value".into())
                } else if nothing_of_its_own(&theirs, &walked_lines) {
                    Outcome::Held("a nonsense value answered with nothing of its own".into())
                } else {
                    Outcome::FillsForAny("a nonsense value still got results of its own".into())
                }
            }
            Err(Stopped::NotAnAnswer(_)) => Outcome::Held("the site gave no answer for a nonsense value".into()),
            Err(Stopped::Unheard { .. }) => Outcome::CouldNotAsk("the recording holds no answer for a nonsense value".into()),
            Err(other) => Outcome::CouldNotAsk(format!("a nonsense value could not be asked: {other:?}")),
        }
    };
    checks.push((Test::NonsenseValue, nonsense_out));

    checks.push((Test::NoWriteTwice, Outcome::Held("the body only reads; no write was sent".into())));
    Verdict { checks }
}

/// The walk's-own-value outcome for a call that did not answer: a reply that is no answer is the route broken, and
/// anything else is a question that could not be put.
fn walks_own(stopped: &Stopped) -> Outcome {
    match stopped {
        Stopped::NotAnAnswer(why) => Outcome::Failed(format!("the walk's own value no longer answers: {why}")),
        Stopped::Unheard { step, .. } => Outcome::CouldNotAsk(format!("the recording holds no answer for step {step}")),
        other => Outcome::CouldNotAsk(format!("{other:?}")),
    }
}

/// What a body's own tests say of it, run again against a recording (`Route::tests`): the four tests over the walk's
/// own values, and the places the body sends now held to the shapes its test kept for that walk.
#[derive(Clone, Debug)]
pub struct AgainstItsTests {
    pub verdict: Verdict,
    /// Each place whose value the body now sends otherwise than its test saw: the step, the place, and the two shapes.
    pub differ: Vec<String>,
    /// How many places were held to their shape.
    pub held: usize,
}

/// A body run against `walk`, the recording of the walk it learned sighting `sighting` from, and held to its own tests:
/// the site's four tests (`verify` over `Recorded`, the walk's own values, no second), and each place the body builds
/// for that walk, step by step, held to the shape the test kept of it. Offline: the recording answers.
pub fn against_its_tests(body: &route::Route, sighting: usize, walk: &crate::lab::sighting::Walk<'_>, jar: &HashMap<String, String>, now: u64) -> AgainstItsTests {
    let walked: HashMap<String, String> = walk.asked.iter().cloned().collect();
    // The requests the body builds, kept as the recording is asked them.
    struct Keeping<'a, 'w> {
        site: crate::lab::site::Recorded<'a>,
        built: &'w mut Vec<(String, route::Built)>,
    }
    impl Site for Keeping<'_, '_> {
        fn ask(&mut self, step: &route::Step, built: &route::Built) -> crate::lab::site::Said {
            self.built.push((step.id.clone(), built.clone()));
            self.site.ask(step, built)
        }
    }
    let mut built: Vec<(String, route::Built)> = Vec::new();
    let verdict = verify(body, &walked, None, jar, now, &mut Keeping { site: crate::lab::site::Recorded { walk }, built: &mut built });
    let (mut differ, mut held) = (Vec::new(), 0usize);
    for test in &body.tests {
        let Some(seen) = test.sightings.get(sighting) else { continue };
        // The first request the body built for this step: the walk's own value.
        let Some((_, request)) = built.iter().find(|(id, _)| *id == test.step) else { continue };
        let sent = crate::trace::Exchange { method: request.method.clone(), url: request.url.clone(), request_headers: request.headers.clone(), request_body: request.body.clone(), status: 0, response_headers: Vec::new(), response_body: None, response_mime: String::new(), resource_type: None, main_frame: None };
        let places: Vec<(route::Place, String)> = crate::slots::slots(&sent).into_iter().map(|s| (crate::body::place_of(&s.loc), s.value)).collect();
        // What the session or the browser sends moves with them: only what the body makes for the call is held.
        for seen in seen.seen.iter().filter(|s| !matches!(s.from, route::Source::Session | route::Source::Browser | route::Source::Clock | route::Source::Digest | route::Source::Open)) {
            match places.iter().find(|(at, _)| *at == seen.at) {
                Some((_, value)) if route::Shape::of(value) == seen.shape => held += 1,
                Some((_, value)) => differ.push(format!("step {}, {}: {:?} where the test saw {:?}", test.step, seen.at, route::Shape::of(value), seen.shape)),
                None => differ.push(format!("step {}, {}: not sent, where the test saw {:?}", test.step, seen.at, seen.shape)),
            }
        }
    }
    AgainstItsTests { verdict, differ, held }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lab::site::{Said, Site};
    use route::Expr;
    use crate::trace::Exchange;

    /// A one-step search body: GET `/api/search?q={q}`, its answer the reply, `q` the one slot.
    fn search_body() -> route::Route {
        use route::{Answer, Expr, Hole, Slot, Step, Way};
        let hole = Hole { at: route::Place::Query("q".into()), ways: vec![Way { rung: 0, expr: Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false } }], over: false, open: false };
        let step = Step { id: "x0".into(), method: "GET".into(), url: "https://shop.example/api/search".into(), holes: vec![hole], body: None, expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None };
        route::Route { v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![Slot { name: "q".into(), secret: false, example: Some("lamp".into()), choices: Vec::new() }], answer: Answer { step: "x0".into(), page: false, decode: None }, steps: vec![step] }
    }

    fn asked(word: &str) -> HashMap<String, String> {
        HashMap::from([("q".to_string(), word.to_string())])
    }

    fn reply(status: u16, mime: &str, body: &str) -> Exchange {
        Exchange { method: "GET".into(), url: "https://shop.example/api/search".parse().unwrap(), request_headers: vec![], request_body: None, status, response_headers: vec![], response_body: Some(body.into()), response_mime: mime.into(), resource_type: Some("XHR".into()), main_frame: None }
    }

    /// A site answered by a closure of the word it was asked.
    struct Shop<F: FnMut(&str) -> Exchange>(F);
    impl<F: FnMut(&str) -> Exchange> Site for Shop<F> {
        fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
            let word = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
            Said::Reply { at: None, reply: (self.0)(&word) }
        }
    }

    fn outcome(v: &Verdict, test: Test) -> &Outcome {
        &v.checks.iter().find(|(t, _)| *t == test).expect("every test is checked").1
    }

    /// A date slot (`Kind::Date`, read and sent as the site writes it) whose answer is three short records: judged by its
    /// records, not its size, the second date answers as itself, and a nonsense date of the slot's form is asked and
    /// run rather than refused as no date.
    #[test]
    fn a_date_slot_is_asked_dates_and_its_answer_judged_by_its_records() {
        use route::meaning::{Field, Kind, Meaning, Records};
        let mut body = search_body();
        body.steps[0].holes[0].ways[0].expr = Expr::Format {
            of: Box::new(Expr::Slot { name: "q".into(), or: Some("2026-03-04".into()), optional: false }),
            read: route::Pattern::Time { form: "{yyyy}-{mm}-{dd}".into() },
            write: route::Pattern::Time { form: "{dd}/{mm}/{yyyy}".into() },
        };
        body.meaning = Meaning { kinds: [("q".to_string(), Kind::Date)].into(), records: Some(Records { list: "/results".into(), fields: vec![Field { name: "title".into(), at: "/title".into(), says: Some("q".into()) }] }) };
        // The site answers the date it was sent, day first, as the ISO date it names: three records saying it.
        let records = |d: &str| {
            let iso = d.split('/').rev().collect::<Vec<_>>().join("-");
            reply(200, "application/json", &format!(r#"{{"results":[{{"title":"{iso} one"}},{{"title":"{iso} two"}},{{"title":"{iso} three"}}]}}"#))
        };
        let shop = |w: &str| records(w);
        let walked = asked("2026-03-04");
        let v = verify(&body, &walked, Some(&asked("2026-03-25")), &HashMap::new(), 1, &mut Shop(shop));
        assert!(outcome(&v, Test::WalksOwnValue).held(), "{:?}", outcome(&v, Test::WalksOwnValue));
        assert!(outcome(&v, Test::SecondValue).held(), "{:?}", outcome(&v, Test::SecondValue));
        assert!(!matches!(outcome(&v, Test::NonsenseValue), Outcome::CouldNotAsk(_)), "the nonsense date is asked: {:?}", outcome(&v, Test::NonsenseValue));
        assert_eq!(nonsense_inputs(&body, &walked)["q"], "1926-03-04");
        // A site that answers the walk's date whatever it is sent fills in.
        let v = verify(&body, &walked, Some(&asked("2026-03-25")), &HashMap::new(), 1, &mut Shop(|_: &str| records("04/03/2026")));
        assert!(matches!(outcome(&v, Test::SecondValue), Outcome::FillsForAny(_)), "{:?}", outcome(&v, Test::SecondValue));
    }

    /// A listed slot looked up in the site's table: a nonsense word is none the table lists, the page sends nothing for
    /// it, and the test holds by the site's own data without asking.
    #[test]
    fn a_listed_slots_nonsense_word_finds_nothing_in_the_sites_own_table() {
        use route::meaning::{Kind, Meaning};
        let mut body = search_body();
        let rows = vec![serde_json::json!({ "name": "Lisbon", "code": "LIS" }), serde_json::json!({ "name": "Oslo", "code": "OSL" })];
        body.steps[0].holes[0].ways[0].expr = Expr::Lookup { rows, fits: route::Fits::Equals { at: "/name".into(), is: Box::new(Expr::Slot { name: "q".into(), or: None, optional: false }) }, take: "/code".into() };
        body.slots[0].choices = vec!["Lisbon".into(), "Oslo".into()];
        body.meaning = Meaning { kinds: [("q".to_string(), Kind::Listed)].into(), records: None };
        let shop = |code: &str| reply(200, "application/json", &format!(r#"{{"results":[{{"title":"{code} a"}},{{"title":"{code} b"}},{{"title":"{code} c"}},{{"title":"{code} d"}},{{"title":"{code} e"}}]}}"#));
        let v = verify(&body, &asked("Lisbon"), None, &HashMap::new(), 1, &mut Shop(shop));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::Held(why) if why.contains("table")), "{:?}", outcome(&v, Test::NonsenseValue));
    }

    /// A site that hears: each word its own results, a nonsense word a 404 page saying it found nothing. Every read
    /// test holds.
    #[test]
    fn a_site_that_hears_holds_every_read_test() {
        let records = |word: &str| match word {
            "lamp" => reply(200, "application/json", r#"{"items":[{"name":"desk reading light 60w"},{"name":"brass bedside glow"},{"name":"floor standing arc"},{"name":"clip on task bright"},{"name":"vintage edison bulb set"},{"name":"dimmable ring halo"}]}"#),
            "sofa" => reply(200, "application/json", r#"{"items":[{"name":"three seat couch grey"},{"name":"foldaway bed settee"},{"name":"chesterfield leather tan"},{"name":"corner lounge modular"},{"name":"two seat loveseat navy"},{"name":"recliner powered cream"}]}"#),
            other => reply(404, "text/html", &format!("<html><head><title>No results for {other}</title></head><body><h1>Nothing found for {other}</h1></body></html>")),
        };
        let v = verify(&search_body(), &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut Shop(records));
        assert!(outcome(&v, Test::WalksOwnValue).held(), "{:?}", outcome(&v, Test::WalksOwnValue));
        assert!(outcome(&v, Test::SecondValue).held(), "{:?}", outcome(&v, Test::SecondValue));
        assert!(outcome(&v, Test::NonsenseValue).held(), "{:?}", outcome(&v, Test::NonsenseValue));
        assert!(outcome(&v, Test::NoWriteTwice).held());
    }

    /// A site that fills in for any word (the same records whatever is asked, only the word echoed in a line): the
    /// second-value test is what flags it, since a template echoed back reads the same once the word is struck. The
    /// nonsense value is said to fill in or to find nothing — both are "said, not failed"; it is never a failure.
    #[test]
    fn a_site_that_fills_in_for_any_word_is_flagged_by_the_second_value() {
        let records = |word: &str| reply(200, "application/json", &format!(r#"{{"items":[{{"name":"showing results for {word}"}},{{"name":"popular pick one"}},{{"name":"popular pick two"}},{{"name":"popular pick three"}},{{"name":"popular pick four"}},{{"name":"popular pick five"}}]}}"#));
        let v = verify(&search_body(), &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut Shop(records));
        assert!(outcome(&v, Test::WalksOwnValue).held());
        assert!(matches!(outcome(&v, Test::SecondValue), Outcome::FillsForAny(_)), "the second value answered the same: {:?}", outcome(&v, Test::SecondValue));
        assert!(!matches!(outcome(&v, Test::NonsenseValue), Outcome::Failed(_)), "the nonsense value is never a failure: {:?}", outcome(&v, Test::NonsenseValue));
    }

    /// A site that answers a nonsense value with results of its own (trending, unrelated to the walk's word) is flagged
    /// by the nonsense test: it has a nothing nowhere, and fills in.
    #[test]
    fn a_nonsense_value_that_gets_results_of_its_own_fills_in() {
        let records = |word: &str| match word {
            "lamp" => reply(200, "application/json", r#"{"items":[{"name":"desk reading light 60w"},{"name":"brass bedside glow"},{"name":"floor standing arc"},{"name":"clip on task bright"},{"name":"vintage edison bulb set"},{"name":"dimmable ring halo"}]}"#),
            _ => reply(200, "application/json", r#"{"items":[{"name":"trending winter coat"},{"name":"trending phone case"},{"name":"trending water bottle"},{"name":"trending yoga mat"},{"name":"trending desk pad"},{"name":"trending travel mug"}]}"#),
        };
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Shop(records));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::FillsForAny(_)), "{:?}", outcome(&v, Test::NonsenseValue));
    }

    /// A nonsense value that answers an empty list, where the walk's value got records: finds nothing.
    #[test]
    fn a_nonsense_value_that_answers_empty_finds_nothing() {
        let records = |word: &str| if word == "lamp" { reply(200, "application/json", r#"{"items":[{"name":"desk reading light"},{"name":"brass bedside glow"},{"name":"floor standing arc"},{"name":"clip on task bright"},{"name":"vintage edison set"},{"name":"dimmable ring halo"}]}"#) } else { reply(200, "application/json", r#"{"items":[]}"#) };
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Shop(records));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::Held(_)), "{:?}", outcome(&v, Test::NonsenseValue));
        // With no second value, the second test could not be asked.
        assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(_)));
    }

    /// The walk's own value no longer answering (a reply that is no answer) fails the walk's-own test and leaves the
    /// others unasked: nothing is told from a second or a nonsense value when the first did not answer.
    #[test]
    fn the_walks_own_value_not_answering_fails_and_leaves_the_rest_unasked() {
        let records = |_: &str| reply(500, "application/json", r#"{"error":"down"}"#);
        let v = verify(&search_body(), &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut Shop(records));
        assert!(matches!(outcome(&v, Test::WalksOwnValue), Outcome::Failed(_)), "{:?}", outcome(&v, Test::WalksOwnValue));
        assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(_)));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::CouldNotAsk(_)));
    }

    /// A recording answers the walk's own value and nothing else: the second and nonsense tests could not be asked,
    /// which is how most of the corpus reads.
    #[test]
    fn a_recording_answers_the_walk_alone_and_the_rest_could_not_be_asked() {
        let records = |word: &str| if word == "lamp" { reply(200, "application/json", r#"{"items":[{"name":"desk reading light"},{"name":"brass bedside glow"},{"name":"floor standing arc"},{"name":"clip on task bright"},{"name":"vintage edison set"},{"name":"dimmable ring halo"}]}"#) } else { Exchange { status: 0, ..reply(0, "", "") } };
        // A site that answers only "lamp" and names any other ask unheard: as a recording does.
        struct OnlyLamp<F: FnMut(&str) -> Exchange>(F);
        impl<F: FnMut(&str) -> Exchange> Site for OnlyLamp<F> {
            fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
                let word = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
                if word == "lamp" {
                    Said::Reply { at: Some(0), reply: (self.0)(&word) }
                } else {
                    Said::Unheard { nearest: Some(0), differs: vec!["query q".into()] }
                }
            }
        }
        let v = verify(&search_body(), &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut OnlyLamp(records));
        assert!(outcome(&v, Test::WalksOwnValue).held());
        assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(w) if w.contains("holds no answer")), "{:?}", outcome(&v, Test::SecondValue));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::CouldNotAsk(_)));
    }

    /// A body with a step that writes is never sent: its read tests could not be asked, and the write test holds.
    #[test]
    fn a_body_that_writes_is_never_sent() {
        let mut body = search_body();
        body.steps[0].method = "POST".into();
        body.steps[0].url = "https://shop.example/api/cart/add".into();
        body.steps[0].writes = true;
        let mut asked_the_site = false;
        let mut site = Shop(|_: &str| {
            asked_the_site = true;
            reply(200, "application/json", "{}")
        });
        let v = verify(&body, &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut site);
        assert!(matches!(outcome(&v, Test::NoWriteTwice), Outcome::Held(_)));
        assert!(matches!(outcome(&v, Test::WalksOwnValue), Outcome::CouldNotAsk(w) if w.contains("writes")), "{:?}", outcome(&v, Test::WalksOwnValue));
        assert!(!asked_the_site, "a body that writes is never sent to the site");
    }

    /// A body learned from two walks carries the tests it was learned against, as shapes and with no value in them,
    /// and run again against the first walk's recording it holds to them: the walk's own value answers, and every
    /// place it makes for the call has the shape its test kept.
    #[test]
    fn a_body_run_against_its_recording_holds_to_its_own_tests() {
        use crate::lab::sighting::tests::{call, trace, walk};
        let walked = |word: &str, token: &str| {
            trace(vec![
                call("GET", "https://shop.example/api/session", &[], None, &format!(r#"{{"token":"{token}"}}"#)),
                call("GET", &format!("https://shop.example/api/search?q={word}&size=20"), &[("x-token", token)], None, &format!(r#"{{"items":[{{"name":"{word} one"}},{{"name":"{word} two"}}]}}"#)),
            ])
        };
        let (first, second) = (walked("lamp", "tok_9f8e7d6c5b4a"), walked("sofa", "tok_1a2b3c4d5e6f"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let body = crate::lab::compile::route(&crate::lab::synth::Lab::new(&walks), 1, "shop.example").expect("a body");
        assert_eq!(body.refused(), None);
        assert_eq!(body.tests.len(), body.steps.len(), "a test of every step");
        let text = serde_json::to_string(&body.tests).unwrap();
        assert!(!text.contains("tok_9f8e7d6c5b4a") && !text.contains("lamp"), "no value in a test: {text}");
        let search = body.tests.iter().find(|t| t.step == "x1").expect("the search's test");
        assert_eq!(search.sightings.len(), 2, "one sighting a walk");
        assert!(search.sightings[0].seen.iter().any(|s| s.at == route::Place::Query("q".into()) && s.from == route::Source::Caller && s.shape == route::Shape { len: 4, of: route::Chars::Letters }));
        let run = against_its_tests(&body, 0, &walks[0], &HashMap::new(), 1);
        assert!(run.verdict.checks.iter().any(|(t, o)| *t == Test::WalksOwnValue && o.held()), "{:?}", run.verdict.lines());
        assert!(run.differ.is_empty() && run.held > 0, "{:?} ({} held)", run.differ, run.held);
    }

    /// A nonsense value is made up the same every run, improbable, and as long as the walk's value: a verify is the
    /// same twice.
    #[test]
    fn a_nonsense_value_is_fixed_and_improbable() {
        assert_eq!(nonsense("lamp"), nonsense("sofa"), "a nonsense value of the same length is the same");
        assert_eq!(nonsense("desk lamp"), nonsense("desk lamp"), "the same value every run");
        assert!(!nonsense("lamp").chars().any(|c| "aeiou".contains(c)), "no vowels: not a word on any site");
        assert_eq!(nonsense("12345"), "999999", "a value with no letters keeps its own shape");
    }

    /// Five records of the walk's own answer: enough lines to tell two answers apart.
    fn lamps() -> Exchange {
        reply(200, "application/json", r#"{"items":[{"name":"desk reading light 60w"},{"name":"brass bedside glow"},{"name":"floor standing arc"},{"name":"clip on task bright"},{"name":"vintage edison bulb set"},{"name":"dimmable ring halo"}]}"#)
    }

    /// A site that answers the walk's own word with `lamps`, and every other word as `other` says (unheard, refused, or
    /// a reply).
    struct Others<F: FnMut(&str) -> Said>(F);
    impl<F: FnMut(&str) -> Said> Site for Others<F> {
        fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
            let word = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
            if word == "lamp" {
                Said::Reply { at: None, reply: lamps() }
            } else {
                (self.0)(&word)
            }
        }
    }

    /// A verdict is said a line per test, each with its name, how it came out in a few words, and why: a body that
    /// writes says three could-not-ask lines and the write test held.
    #[test]
    fn a_verdict_says_a_line_per_test_with_how_it_came_out_and_why() {
        let mut body = search_body();
        body.steps[0].method = "POST".into();
        body.steps[0].writes = true;
        let v = verify(&body, &asked("lamp"), None, &HashMap::new(), 1, &mut Shop(|_: &str| lamps()));
        let said = v.lines();
        assert_eq!(said.len(), 4);
        let why = "the body writes, and a write is learned from its walk, never sent to check";
        assert_eq!(said[0], format!("the walk's own value answers as the walk did: could not ask ({why})"));
        assert_eq!(said[1], format!("a second value answers as itself: could not ask ({why})"));
        assert_eq!(said[2], format!("a nonsense value finds nothing: could not ask ({why})"));
        assert_eq!(said[3], "no write is sent twice: held (the body writes and was not sent)");
        let words: Vec<&str> = [Outcome::Held(String::new()), Outcome::FillsForAny(String::new()), Outcome::CouldNotAsk(String::new()), Outcome::Failed(String::new())].iter().map(Outcome::word).collect();
        assert_eq!(words, ["held", "the site fills in for any word", "could not ask", "failed"]);
    }

    /// A walk whose own answer says too little (fewer than five lines) cannot tell a second value from itself: the second
    /// test says so and the site is not asked the second value.
    #[test]
    fn a_walks_answer_that_says_too_little_cannot_tell_a_second_value_apart() {
        let mut asked_words: Vec<String> = Vec::new();
        let mut site = Shop(|word: &str| {
            asked_words.push(word.to_string());
            reply(200, "application/json", r#"{"items":[{"name":"desk reading light"},{"name":"brass bedside glow"}]}"#)
        });
        let v = verify(&search_body(), &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut site);
        assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(w) if w.contains("says too little to tell two values apart")), "{:?}", outcome(&v, Test::SecondValue));
        assert!(!asked_words.contains(&"sofa".to_string()), "the second value is never asked: {asked_words:?}");
    }

    /// A second value the site refuses to answer is said as it came: a reply that is no answer says the site did not
    /// answer it, and a question that could not be put says so, in both the plain test and the records test.
    #[test]
    fn a_second_value_the_site_does_not_answer_is_said_as_it_came() {
        use route::meaning::{Field, Meaning, Records};
        let plain = search_body();
        let mut by_records = search_body();
        by_records.meaning = Meaning { kinds: Default::default(), records: Some(Records { list: "/items".into(), fields: vec![Field { name: "name".into(), at: "/name".into(), says: Some("q".into()) }] }) };
        for (what, body) in [("plain", &plain), ("records", &by_records)] {
            let v = verify(body, &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut Others(|_: &str| Said::Reply { at: None, reply: reply(500, "application/json", r#"{"error":"down"}"#) }));
            assert!(outcome(&v, Test::WalksOwnValue).held(), "{what}");
            assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(w) if w.contains("the site did not answer the second value") && w.contains("500")), "{what}: {:?}", outcome(&v, Test::SecondValue));
            let v = verify(body, &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut Others(|_: &str| Said::Refused("no network".into())));
            assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(w) if w.contains("the second value could not be asked") && w.contains("no network")), "{what}: {:?}", outcome(&v, Test::SecondValue));
            let v = verify(body, &asked("lamp"), Some(&asked("sofa")), &HashMap::new(), 1, &mut Others(|_: &str| Said::Unheard { nearest: None, differs: Vec::new() }));
            assert!(matches!(outcome(&v, Test::SecondValue), Outcome::CouldNotAsk(w) if w.contains("holds no answer for the second value")), "{what}: {:?}", outcome(&v, Test::SecondValue));
        }
    }

    /// A nonsense value the site gives no answer to (a reply that is no answer) held: the site found nothing. One that
    /// could not be asked (the site refuses the question) is not held, and says what it was.
    #[test]
    fn a_nonsense_value_the_site_gives_no_answer_to_is_held_and_one_it_refuses_is_not() {
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Others(|_: &str| Said::Reply { at: None, reply: reply(500, "application/json", r#"{"error":"down"}"#) }));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::Held(w) if w.contains("gave no answer")), "{:?}", outcome(&v, Test::NonsenseValue));
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Others(|_: &str| Said::Refused("no network".into())));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::CouldNotAsk(w) if w.contains("a nonsense value could not be asked") && w.contains("no network")), "{:?}", outcome(&v, Test::NonsenseValue));
    }

    /// The walk's own value not asked at all (the recording holds no answer, or the site refuses the question) is no
    /// failure of the route: it could not be asked, and says which. Only a reply that is no answer is a failure.
    #[test]
    fn the_walks_own_value_that_could_not_be_asked_is_no_failure_of_the_route() {
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Others(|_: &str| Said::Unheard { nearest: None, differs: Vec::new() }));
        assert!(v.checks.iter().all(|(_, o)| !matches!(o, Outcome::Failed(_))), "{:?}", v.lines());
        struct Silent(Said);
        impl Site for Silent {
            fn ask(&mut self, _step: &route::Step, _built: &route::Built) -> Said {
                std::mem::replace(&mut self.0, Said::Refused("asked twice".into()))
            }
        }
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Silent(Said::Unheard { nearest: Some(0), differs: vec!["query q".into()] }));
        assert!(matches!(outcome(&v, Test::WalksOwnValue), Outcome::CouldNotAsk(w) if w == "the recording holds no answer for step x0"), "{:?}", outcome(&v, Test::WalksOwnValue));
        assert!(matches!(outcome(&v, Test::NonsenseValue), Outcome::CouldNotAsk(_)));
        let v = verify(&search_body(), &asked("lamp"), None, &HashMap::new(), 1, &mut Silent(Said::Refused("no network".into())));
        assert!(matches!(outcome(&v, Test::WalksOwnValue), Outcome::CouldNotAsk(w) if w.contains("Refused") && w.contains("no network")), "{:?}", outcome(&v, Test::WalksOwnValue));
    }

    /// A body held to its own tests again says each place it now sends otherwise than its test saw: a place whose value
    /// has another shape than the test kept, and a place the test saw that the body, as it stands, does not send.
    #[test]
    fn a_place_the_body_sends_otherwise_than_its_test_saw_is_said() {
        use crate::lab::sighting::tests::{call, trace, walk};
        let walked = |word: &str| trace(vec![call("GET", &format!("https://shop.example/api/search?q={word}&size=20"), &[], None, &format!(r#"{{"items":[{{"name":"{word} one"}},{{"name":"{word} two"}}]}}"#))]);
        let (first, second) = (walked("lamp"), walked("sofa"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let mut body = crate::lab::compile::route(&crate::lab::synth::Lab::new(&walks), 0, "shop.example").expect("a body");
        let held = against_its_tests(&body, 0, &walks[0], &HashMap::new(), 1);
        assert!(held.differ.is_empty() && held.held > 0, "{:?} ({} held)", held.differ, held.held);
        // The body has since come to ask for a filter the walk never set: optional, so a call that gives none sends none.
        body.steps[0].holes.push(route::Hole { at: route::Place::Query("opt".into()), ways: vec![route::Way { rung: 0, expr: Expr::Slot { name: "opt".into(), or: None, optional: true } }], over: false, open: false });
        let seen = &mut body.tests[0].sightings[0].seen;
        let q = seen.iter_mut().find(|s| s.at == route::Place::Query("q".into())).expect("the walk's word is a place");
        q.shape = route::Shape { len: 9, of: route::Chars::Digits };
        seen.push(route::Seen { at: route::Place::Query("opt".into()), from: route::Source::Caller, shape: route::Shape { len: 3, of: route::Chars::Letters } });
        let run = against_its_tests(&body, 0, &walks[0], &HashMap::new(), 1);
        assert_eq!(run.differ.len(), 2, "{:?}", run.differ);
        assert!(run.differ.iter().any(|d| d.starts_with("step x0, query q:") && d.contains("where the test saw")), "{:?}", run.differ);
        assert!(run.differ.iter().any(|d| d.starts_with("step x0, query opt: not sent, where the test saw")), "{:?}", run.differ);
    }
}
