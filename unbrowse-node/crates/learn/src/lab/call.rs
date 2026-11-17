//! A body, called: each step filled from the caller's values, the session and the replies before it, and asked of
//! a [`Site`].
//!
//! This is the learner's own caller, for checking a body it has just written against a recording or the site. The
//! node's caller, with its ledger of writes, its doors and its rungs, is `replay` until phase 5 of the rebuild.

use std::collections::HashMap;

use unbrowse_route as route;

use crate::body::at_back;
use crate::lab::site::{Said, Site};
use crate::trace::Exchange;

/// Why a call of a body stopped before its answer.
#[derive(Clone, Debug)]
pub enum Stopped {
    /// A step could not be built.
    Stuck { step: String, why: String },
    /// A step was built and the site (or its recording) has no reply for it.
    Unheard { step: String, nearest: Option<usize>, differs: Vec<String> },
    /// The body cannot be run as it stands, or a step was not sent or not answered: why.
    Refused(String),
    /// The answer's step was answered, and the reply is no answer, as the node's caller judges one: why.
    NotAnAnswer(String),
}

/// What one call of a body is filled from.
struct Calling<'a> {
    slots: &'a HashMap<String, String>,
    jar: &'a HashMap<String, String>,
    replies: HashMap<String, Exchange>,
    fresh: HashMap<String, String>,
    now: u64,
}

impl route::World for Calling<'_> {
    fn slot(&self, name: &str) -> Option<String> {
        self.slots.get(name).cloned()
    }
    fn cookie(&self, name: &str) -> Option<String> {
        self.jar.get(name).cloned()
    }
    /// The session's map holds what the page kept in its storage under the store's name for it (`Area::held_as`).
    fn stored(&self, area: route::expr::Area, key: &str) -> Option<String> {
        self.jar.get(&area.held_as(key)).cloned()
    }
    fn read(&self, step: &str, at: &route::At) -> Option<String> {
        crate::provenance::extract(self.replies.get(step)?, &at_back(at))
    }
    fn list(&self, step: &str, pointer: &str) -> Option<Vec<serde_json::Value>> {
        self.replies.get(step)?.own_json()?.pointer(pointer)?.as_array().cloned()
    }
    fn answered(&self, step: &str) -> bool {
        self.replies.contains_key(step)
    }
    fn fresh(&mut self, id: &str, clock: route::Clock) -> String {
        let n = self.fresh.len() as u64;
        let now = self.now;
        self.fresh
            .entry(id.to_string())
            .or_insert_with(|| match clock {
                route::Clock::Millis => (now + n).to_string(),
                route::Clock::Seconds => (now / 1000 + n).to_string(),
                // The learner's caller draws no chance of its own: an id drawn at random is one of its shape.
                route::Clock::Random => format!("00000000-0000-4000-a000-{n:012x}"),
            })
            .clone()
    }
    fn now_ms(&self) -> u64 {
        self.now
    }
    fn digits(&mut self, n: usize) -> String {
        // The learner's caller draws no chance of its own: a value that needs some is checked by its shape.
        "0".repeat(n)
    }
    fn file(&self, _named: &str, _fact: route::FileFact) -> Result<String, String> {
        Err("the learner sends no file".into())
    }
    fn same_site(&self, a: &str, b: &str) -> bool {
        let site = |origin: &str| url::Url::parse(origin).ok().and_then(|u| u.host_str().map(crate::identity::site_of));
        site(a).is_some() && site(a) == site(b)
    }
    /// A program of the site's own (rung 2) runs in the sandbox as the node's caller runs it (`generated::compute`),
    /// given the request as it stands and the session's cookies, with what the page kept in its storage as the
    /// session holds it. None where it fails or no runtime is on the machine: the step is made a rung down.
    fn program(&mut self, source: &str, sent: &route::Built) -> Option<String> {
        crate::generated::compute(source, &request_of(sent), &sent.cookies(), &self.environment())
    }
    /// A program whose reads of the page's world are fed (`Expr::ProgramReading`), run as the node's caller runs it:
    /// it sees what its feeds came to and nothing else of the session.
    fn program_reading(&mut self, source: &str, sent: &route::Built, fed: &[(route::Reach, Option<String>)]) -> Option<String> {
        crate::generated::compute_reading(source, &request_of(sent), &[], &crate::generated::Environment::default(), fed)
    }
}

impl Calling<'_> {
    /// What the page's own code sees of the session: what the page kept in its storage, as the session holds it.
    fn environment(&self) -> crate::generated::Environment {
        let mut storage = crate::sandbox::Storage::default();
        for (name, value) in self.jar {
            if let Some(key) = name.strip_prefix("localStorage:") {
                storage.local.insert(key.to_string(), value.clone());
            } else if let Some(key) = name.strip_prefix("sessionStorage:") {
                storage.session.insert(key.to_string(), value.clone());
            }
        }
        crate::generated::Environment { storage, ..Default::default() }
    }
}

/// The request a program is given, as it stands: a binary body as its bytes (`route::wire::bytes_of`).
fn request_of(sent: &route::Built) -> crate::replay::Request {
    crate::replay::Request { method: sent.method.clone(), url: sent.url.clone(), exchange: 0, headers: sent.headers.clone(), body: sent.body.as_deref().map(unbrowse_route::wire::bytes_of) }
}

/// What a call of a body came to: the answer step's reply, and where each step's reply sits in the recording
/// when it came from one.
#[derive(Clone, Debug)]
pub struct Called {
    pub answer: Exchange,
    pub heard: Vec<(String, Option<usize>)>,
}

/// Calls `body` for `slots`, with the session's cookies in `jar`, asking `site` each step in turn. Whether a step
/// may be asked at all is the site's to say: a recording answers whatever it holds, and nothing is sent.
pub fn call(body: &route::Route, slots: &HashMap<String, String>, jar: &HashMap<String, String>, now: u64, site: &mut dyn Site) -> Result<Called, Stopped> {
    if let Some(why) = body.refused() {
        return Err(Stopped::Refused(why));
    }
    let mut world = Calling { slots, jar, replies: HashMap::new(), fresh: HashMap::new(), now };
    let mut heard = Vec::new();
    // The address the answer's step was asked at, as the judges of an answer read it.
    let mut asked: Option<url::Url> = None;
    for step in &body.steps {
        let built = route::request(step, &mut world).map_err(|stuck| Stopped::Stuck { step: step.id.clone(), why: stuck.to_string() })?;
        if step.id == body.answer.step {
            asked = Some(built.url.clone());
        }
        match site.ask(step, &built) {
            Said::Reply { at, reply } => {
                heard.push((step.id.clone(), at));
                world.replies.insert(step.id.clone(), reply);
            }
            Said::Unheard { nearest, differs } => return Err(Stopped::Unheard { step: step.id.clone(), nearest, differs }),
            Said::Refused(why) => return Err(Stopped::Refused(format!("step {}: {why}", step.id))),
        }
    }
    let mut answer = world.replies.remove(&body.answer.step).ok_or_else(|| Stopped::Refused(format!("the answer's step {} was never asked", body.answer.step)))?;
    // A reply only the site's own code unpacks is read as the node's caller reads it (`trace::decoded_answer`).
    if let Some(d) = body.answer.decode.as_ref() {
        if let Some(text) = crate::trace::decoded_answer(&d.source, answer.response_body.as_deref().unwrap_or_default(), &world.environment()) {
            answer.response_body = Some(text);
            answer.response_mime = "application/json".into();
        }
    }
    let step = body.step(&body.answer.step).expect("a body that is not refused has its answer's step");
    let asked = asked.ok_or_else(|| Stopped::Refused("the answer's step was never built".into()))?;
    if let Some(why) = not_the_answer(body, step, slots, &asked, &answer) {
        return Err(Stopped::NotAnAnswer(why));
    }
    Ok(Called { answer, heard })
}

/// Why the reply to the answer's step is no answer, asked of the judges the node's caller asks of a route's target
/// (`replay`), in its order: a status the walk did not see, unless the site said it found nothing; then the reply
/// that is no answer (`answer::not_an_answer_for`); then a reply not in the shape the step's was when it was learned.
fn not_the_answer(body: &route::Route, step: &route::Step, slots: &HashMap<String, String>, asked: &url::Url, got: &Exchange) -> Option<String> {
    let secret = |name: &str| body.slots.iter().any(|s| s.name == name && s.secret);
    let judged = crate::answer::Judged { status: step.expect, writes: step.writes, sends_a_secret: step.holes.iter().flat_map(|h| &h.ways).flat_map(|w| w.expr.slots()).any(secret) };
    let found_nothing = crate::answer::found_nothing_for(judged, slots, got);
    if !((200..400).contains(&got.status) || got.status == step.expect || found_nothing) {
        return Some(format!("the site answered {}", got.status));
    }
    if found_nothing {
        return None;
    }
    if let Some(why) = crate::answer::not_an_answer_for(judged, asked, got) {
        return Some(why);
    }
    let expected = step.shape.as_ref()?;
    let shape = got.json_body_like(Some(expected)).map(|v| crate::graph::shape(&v));
    (!shape.as_ref().is_some_and(|got| crate::replay::answers_like(expected, got))).then(|| "the target answered, but not in the recorded shape".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lab::compile;
    use crate::lab::sighting::tests::{call as seen, trace, walk};
    use crate::lab::site::Recorded;
    use crate::lab::synth::Lab;
    use crate::trace::Trace;

    /// A page that asks for a token, then searches with it: the token differs on each walk, the search sends the
    /// word in its address, its body and its referer, a reading of the clock, and a tracing id nothing explains.
    fn walked(word: &str, token: &str, ms: &str, trace_id: &str, found: &str) -> Trace {
        trace(vec![
            seen("GET", "https://shop.example/api/session", &[], None, &format!(r#"{{"token":"{token}"}}"#)),
            seen("GET", "https://shop.example/api/menu", &[], None, r#"{"items":["home","deals"]}"#),
            seen(
                "POST",
                &format!("https://shop.example/api/find/{word}/all?q={word}&size=20&_={ms}"),
                &[("x-token", token), ("x-trace-id", trace_id), ("referer", &format!("https://shop.example/search?q={word}")), ("content-type", "application/json")],
                Some(&format!(r#"{{"term":"{word}","page":1,"exact":false,"filters":{{"lang":"en"}}}}"#)),
                // What a search finds is other things for another word, not the same names with the word swapped.
                &format!(r#"{{"items":[{}]}}"#, (0..6).map(|n| format!(r#"{{"name":"{found} number {n}"}}"#)).collect::<Vec<_>>().join(",")),
            ),
        ])
    }

    fn two_walks() -> (Trace, Trace) {
        // The replies are dated Wed, 11 Nov 2026 12:00:00 GMT.
        (walked("lamp", "tok_9f8e7d6c5b", "1794398399120", "7f3a9c21e5b84d06", "Desk lamp"), walked("sofa", "tok_1a2b3c4d5e", "1794398401877", "c40e18b72a9d5f63", "Red sofa"))
    }

    fn asked(word: &str) -> HashMap<String, String> {
        HashMap::from([("q".to_string(), word.to_string())])
    }

    /// The whole of it, with no site asked: a body written from two walks, called for the word each walk was asked,
    /// sends the requests that walk sent, in order, and comes to the answer that walk got.
    #[test]
    fn a_body_learned_from_two_walks_sends_what_each_walk_sent_and_hears_its_answer() {
        let (first, second) = two_walks();
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let body = compile::route(&Lab::new(&walks), 2, "shop.example").expect("the search is a call of the first walk");
        assert_eq!(body.refused(), None);
        assert_eq!(body.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["x0", "x2"], "the token's call comes before the search, and the menu is not needed");
        assert_eq!(body.asked(), ["q"]);
        assert!(!body.holds_code());
        for (walk, word, found) in [(&walks[0], "lamp", "Desk lamp"), (&walks[1], "sofa", "Red sofa")] {
            // Called with what the session held when the walk made the search, as a node calls with its jar.
            let jar = crate::lab::sighting::jar_of(walk, 2);
            let called = call(&body, &asked(word), &jar, 0, &mut Recorded { walk }).unwrap_or_else(|stopped| panic!("for {word}: {stopped:?}"));
            assert_eq!(called.heard, [("x0".to_string(), Some(0)), ("x2".to_string(), Some(2))]);
            assert!(called.answer.response_body.as_deref().is_some_and(|b| b.contains(found)));
        }
    }

    /// A value a request sends that the walk's page held in its storage is the storage's: the page issued a token
    /// once, kept it, and every later call sends what it kept, so two walks of one session send the same text. Read as
    /// the storage's (`Expr::Stored`), a call sends what the session holds now, not the walk's own token; a walk whose
    /// storage is not known says nothing, and the place stays the fixed text it was.
    #[test]
    fn a_value_the_page_kept_in_its_storage_is_the_storages() {
        let token = "t_8c1d4e9a2f7b3c50";
        let first = trace(vec![
            seen("POST", "https://shop.example/api/issue", &[], None, &format!(r#"{{"token":"{token}"}}"#)),
            seen("GET", "https://shop.example/api/search?q=lamp", &[("x-token", token)], None, r#"{"items":[{"name":"Desk lamp"}]}"#),
        ]);
        // The second walk found the token kept, and asked for none.
        let second = trace(vec![seen("GET", "https://shop.example/api/search?q=sofa", &[("x-token", token)], None, r#"{"items":[{"name":"Red sofa"}]}"#)]);
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let kept = crate::sandbox::Storage { local: HashMap::from([("token".to_string(), token.to_string()), ("theme".to_string(), "dark".to_string())]), session: HashMap::new() };
        let stored = route::Expr::Stored { area: route::expr::Area::Local, key: "token".into() };
        let header = crate::slots::Loc::Header("x-token".into());
        let holes = Lab::new(&walks).storing(0, kept.clone()).holes(1);
        let hole = holes.iter().find(|h| h.at == header).expect("the header is a place");
        assert_eq!((hole.kind, &hole.ways[0].expr), (crate::lab::synth::Kind::Session, &stored));
        // Unknown storage: as before, the walked text.
        let holes = Lab::new(&walks).holes(1);
        assert_eq!(holes.iter().find(|h| h.at == header).map(|h| h.kind), Some(crate::lab::synth::Kind::Fixed));
        // A storage that holds another value under the key is not where the header came from.
        let other = crate::sandbox::Storage { local: HashMap::from([("token".to_string(), "t_000000000000000".to_string())]), session: HashMap::new() };
        let holes = Lab::new(&walks).storing(0, other).holes(1);
        assert_ne!(holes.iter().find(|h| h.at == header).map(|h| &h.ways[0].expr), Some(&stored));
        // The body sends what the session's storage holds when it is called: a token the walk never saw.
        let body = compile::route(&Lab::new(&walks).storing(0, kept), 1, "shop.example").expect("the search is a call of the first walk");
        assert!(body.steps.iter().all(|s| s.id != "x0"), "the token's issuing is not re-sent: the storage holds it");
        let now = "t_ffff0000eeee1111";
        let jar = HashMap::from([(route::expr::Area::Local.held_as("token"), now.to_string())]);
        struct Echo(Option<String>);
        impl Site for Echo {
            fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
                self.0 = built.headers.iter().find(|(k, _)| k == "x-token").map(|(_, v)| v.clone());
                let mut e = seen("GET", built.url.as_str(), &[], None, r#"{"items":[{"name":"Green sofa"}]}"#);
                e.url = built.url.clone();
                Said::Reply { at: None, reply: e }
            }
        }
        let mut site = Echo(None);
        call(&body, &asked("sofa"), &jar, 0, &mut site).expect("called");
        assert_eq!(site.0.as_deref(), Some(now));
    }

    /// A body whose value only the site's own function makes (rung 2) is called by the learner's own caller: the
    /// program runs for the request as it stands, so the four tests and shrinking can ask such a body, and a call for
    /// a word neither walk sent is signed for that word.
    #[test]
    fn the_learners_caller_runs_a_program_of_the_sites_own() {
        if crate::sandbox::runtime().is_none() {
            eprintln!("no signing runtime on this machine: the program-caller test is skipped");
            return;
        }
        use crate::lab::synth::tests::mix;
        const SCRIPT: &str = "(function () {\n  function mix(s) { var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; h ^= h >>> 13; } return ('0000000' + (h >>> 0).toString(16)).slice(-8); }\n  window.searchSigned = function (q, done) {\n    var ts = String(Date.now());\n    fetch('/api/search?q=' + encodeURIComponent(q), { headers: { 'x-ts': ts, 'x-sig': mix(ts + '|' + q) + mix(q + '|' + ts) } }).then(function (r) { return r.json(); }).then(done);\n  };\n})();\n";
        let walked = |q: &str, ts: &str| {
            let sig = format!("{}{}", mix(&format!("{ts}|{q}")), mix(&format!("{q}|{ts}")));
            trace(vec![seen("GET", &format!("https://sign.example/api/search?q={q}&_={ts}"), &[("x-ts", ts), ("x-sig", &sig)], None, r#"{"results":[{"name":"one"}]}"#)])
        };
        let (first, second) = (walked("lamp", "1794398399120"), walked("desk", "1794398401877"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        let line = SCRIPT.lines().position(|l| l.contains("fetch(")).expect("the fetch line") as u32;
        let col = SCRIPT.lines().nth(line as usize).unwrap().find("fetch(").unwrap() as u32;
        let producer = crate::signing::Producer { script: "https://sign.example/s/app.js".into(), at: crate::slice::offset_at(SCRIPT, line, col).expect("the frame sits in its script"), frame: true };
        let lab = Lab::new(&walks).reading(0, Vec::new(), None, Some(producer), vec![("https://sign.example/s/app.js".to_string(), SCRIPT.to_string())]);
        let body = compile::route(&lab, 0, "sign.example").expect("the search is a call");
        assert!(body.holds_code(), "x-sig is the site's own function");
        struct Checks(Option<bool>);
        impl Site for Checks {
            fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
                let head = |k: &str| built.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
                let q = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
                let (ts, sig) = (head("x-ts"), head("x-sig"));
                self.0 = Some(sig == format!("{}{}", mix(&format!("{ts}|{q}")), mix(&format!("{q}|{ts}"))));
                let mut e = seen("GET", built.url.as_str(), &[], None, r#"{"results":[{"name":"teapot one"}]}"#);
                e.url = built.url.clone();
                Said::Reply { at: None, reply: e }
            }
        }
        let mut site = Checks(None);
        call(&body, &asked("teapot"), &HashMap::new(), 1_794_398_500_000, &mut site).unwrap_or_else(|stopped| panic!("{stopped:?}"));
        assert_eq!(site.0, Some(true), "the signature is the site's own, for the word asked and the clock sent");
    }

    /// The learner's own pick, written as a route: the search, which both walks made and whose reply says each
    /// walk's word, with the token's call its read needs before it. Written again from the same walks it is the same
    /// bytes, however many times: nothing on the way to a body is taken in the order a map keeps.
    #[test]
    fn a_route_learned_twice_from_the_same_walks_is_the_same_bytes() {
        let (first, second) = two_walks();
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let body = compile::learn(&walks, "shop.example").expect("the walks settle the answer");
        assert_eq!((body.answer.step.as_str(), body.answer.page), ("x2", false));
        assert_eq!(body.steps.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["x0", "x2"]);
        let once = serde_json::to_string(&body).unwrap();
        for _ in 0..8 {
            assert_eq!(serde_json::to_string(&compile::learn(&walks, "shop.example").unwrap()).unwrap(), once);
        }
        // Walks that settle nothing write nothing, and say why.
        let alone = [walk(&first, &[("q", "lamp")])];
        assert_eq!(compile::learn(&alone, "shop.example"), Err(compile::Unlearned::Unsettled(crate::lab::answer::Unsettled::OneWalk)));
    }

    /// A word no walk asked is one the recording cannot answer for: the ask is named, with the places it differs
    /// at, and no reply is made up.
    #[test]
    fn an_ask_the_recording_does_not_hold_is_named_and_never_answered() {
        let (first, second) = two_walks();
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let body = compile::route(&Lab::new(&walks), 2, "shop.example").unwrap();
        match call(&body, &asked("chair"), &HashMap::new(), 0, &mut Recorded { walk: &walks[0] }) {
            Err(Stopped::Unheard { step, differs, .. }) => {
                assert_eq!(step, "x2");
                assert!(differs.iter().any(|d| d == "query q") && differs.iter().any(|d| d == "body /term"), "{differs:?}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// The learner's caller holds the reply to its answer's step to the judges the node's caller asks of a target: a
    /// recording that answers the very ask with nothing, with a status the walk did not see, or with a reply of
    /// another shape than the step's was, has not answered it, though it answered. A step that may write is judged by
    /// its ledger, as the node's caller judges one, and only its shape is held here.
    #[test]
    fn the_learners_caller_holds_a_reply_to_the_judges_the_nodes_caller_asks() {
        let records = |word: &str| format!(r#"{{"items":[{}]}}"#, (0..6).map(|n| format!(r#"{{"name":"{word} number {n}"}}"#)).collect::<Vec<_>>().join(","));
        let search = |word: &str| trace(vec![seen("GET", &format!("https://shop.example/api/search?q={word}"), &[], None, &records(word))]);
        let (first, second) = (search("lamp"), search("sofa"));
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let body = compile::route(&Lab::new(&walks), 0, "shop.example").unwrap();
        assert!(!body.steps[0].writes);
        let answered = |status: u16, reply: &str| {
            let mut t = first.clone();
            t.exchanges[0].status = status;
            t.exchanges[0].response_body = Some(reply.into());
            t
        };
        for (status, reply, said) in [(200, "", "with nothing"), (500, "{}", "500"), (200, r#"{"suggest":["lamp shade","lamp post"],"total":2}"#, "shape")] {
            let t = answered(status, reply);
            let w = walk(&t, &[("q", "lamp")]);
            match call(&body, &asked("lamp"), &HashMap::new(), 0, &mut Recorded { walk: &w }) {
                Err(Stopped::NotAnAnswer(why)) => assert!(why.contains(said), "{status} {reply}: {why}"),
                other => panic!("{status} {reply}: {other:?}"),
            }
        }
        // The walk's own reply is its answer.
        assert!(call(&body, &asked("lamp"), &HashMap::new(), 0, &mut Recorded { walk: &walks[0] }).is_ok());
        // A step that may write is held to its shape alone.
        let (first, second) = two_walks();
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let body = compile::route(&Lab::new(&walks), 2, "shop.example").unwrap();
        let mut t = first.clone();
        t.exchanges[2].response_body = Some(r#"{"error":{"code":500}}"#.into());
        let w = walk(&t, &[("q", "lamp")]);
        assert!(matches!(call(&body, &asked("lamp"), &crate::lab::sighting::jar_of(&w, 2), 0, &mut Recorded { walk: &w }), Err(Stopped::NotAnAnswer(why)) if why.contains("shape")));
    }

    /// A site that answers every ask with an empty list, and keeps what it was asked.
    #[derive(Default)]
    struct Keeping {
        asked: Vec<route::Built>,
    }
    impl Site for Keeping {
        fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
            self.asked.push(built.clone());
            Said::Reply { at: None, reply: seen(&built.method, built.url.as_str(), &[], None, r#"{"items":[]}"#) }
        }
    }

    /// A body learned from two walks of a signed call signs each call anew, over the request it builds: a word no
    /// walk asked goes out with the digest the page's own code would have made for it. Against each walk's own
    /// recording it still comes to that walk's answer, though its time, and so its digest, are this call's.
    #[test]
    fn a_signed_call_is_signed_anew_for_each_call_and_its_recording_still_answers_it() {
        use crate::lab::synth::tests::signed;
        let (first, second) = (trace(vec![signed("lamps", "1794398399120", "Desk lamp")]), trace(vec![signed("kettles", "1794398401877", "Steel kettle")]));
        let walks = [walk(&first, &[("q", "lamps")]), walk(&second, &[("q", "kettles")])];
        let body = compile::route(&Lab::new(&walks), 0, "shop.example").unwrap();
        let jar = HashMap::from([("_tk".to_string(), "5f3a9c21e4d7b8a6_1794402700000".to_string()), ("lang".to_string(), "en-SG-long".to_string())]);
        for (walk, word, found) in [(&walks[0], "lamps", "Desk lamp"), (&walks[1], "kettles", "Steel kettle")] {
            let called = call(&body, &asked(word), &jar, 1_794_402_699_999, &mut Recorded { walk }).unwrap_or_else(|stopped| panic!("for {word}: {stopped:?}"));
            assert!(called.answer.response_body.as_deref().is_some_and(|b| b.contains(found)));
        }
        let mut site = Keeping::default();
        call(&body, &asked("sofas"), &jar, 1_794_402_699_999, &mut site).expect("a call for a word no walk asked is built and sent");
        let sent = &site.asked[0];
        let sign = sent.url.query_pairs().find(|(k, _)| k == "sign").map(|(_, v)| v.into_owned());
        assert_eq!(sign, Some(route::Algo::Md5.hash(r#"5f3a9c21e4d7b8a6&1794402699999&24677475&{"q":"sofas"}"#)));
        assert!(sent.made.iter().any(|(at, rung)| *at == route::Place::Query("sign".into()) && *rung == 1), "{:?}", sent.made);
    }

    /// What the step holds: the address with its made piece marked, a fixed leaf in the template as the kind of
    /// leaf it is, a made leaf as a hole, and the one value nothing explains sent as walked and marked open.
    #[test]
    fn a_step_keeps_what_is_fixed_as_its_own_text_and_what_is_made_as_holes() {
        let (first, second) = two_walks();
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
        let step = compile::step(&Lab::new(&walks), 2).unwrap();
        assert_eq!(step.url, "https://shop.example/api/find/{path[2]}/all");
        let Some(route::Form::Json { template, types, .. }) = &step.body else { panic!("{:?}", step.body) };
        assert_eq!(template, &serde_json::json!({"term": null, "page": 1, "exact": false, "filters": {"lang": "en"}}));
        assert_eq!(types.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect::<Vec<_>>(), [("/term", "string")]);
        let open: Vec<String> = step.holes.iter().filter(|h| h.open).map(|h| h.at.to_string()).collect();
        assert_eq!(open, ["header x-trace-id"]);
        assert!(step.writes, "a POST whose address and own text say nothing of asking may change what the site holds");
    }

    /// Whether a step writes is asked of the ledger's one rule, not of its method: a POST to a search, or a GraphQL
    /// query (its document the route's own text, whether the caller's word sits in its variables or in the document),
    /// only asks, and is no write. A POST the rule cannot say that of is one: a mutation, a cart, a persisted query
    /// that sends only a hash.
    #[test]
    fn a_post_the_rule_of_writes_says_only_asks_is_no_write_and_one_it_cannot_is() {
        let writes = |url: &str, body: &dyn Fn(&str) -> String| {
            let walked = |word: &str| trace(vec![seen("POST", url, &[("content-type", "application/json")], Some(&body(word)), r#"{"data":{}}"#)]);
            let (first, second) = (walked("lamp"), walked("sofa"));
            let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
            compile::step(&Lab::new(&walks), 0).unwrap().writes
        };
        let asks: [(&str, &dyn Fn(&str) -> String); 3] = [
            ("https://shop.example/api/v2/search", &|w| format!(r#"{{"term":"{w}","page":1}}"#)),
            ("https://shop.example/graphql", &|w| format!(r#"{{"query":"query Find($q: String!) {{ find(q: $q) {{ id }} }}","variables":{{"q":"{w}"}}}}"#)),
            ("https://shop.example/api/v1", &|w| format!(r#"{{"query":"{{ find(q: \"{w}\") {{ id name }} }}"}}"#)),
        ];
        for (url, body) in asks {
            assert!(!writes(url, body), "{url} {}", body("lamp"));
        }
        let changes: [(&str, &dyn Fn(&str) -> String); 3] = [
            ("https://shop.example/graphql", &|w| format!(r#"{{"query":"mutation Add($q: String!) {{ add(q: $q) {{ ok }} }}","variables":{{"q":"{w}"}}}}"#)),
            ("https://shop.example/api/cart/items", &|w| format!(r#"{{"sku":"{w}","count":1}}"#)),
            ("https://shop.example/graphql", &|w| format!(r#"{{"extensions":{{"persistedQuery":{{"sha256Hash":"9f8e7d6c5b4a39281706f5e4d3c2b1a0"}}}},"variables":{{"q":"{w}"}}}}"#)),
        ];
        for (url, body) in changes {
            assert!(writes(url, body), "{url} {}", body("lamp"));
        }
    }

    /// The learner's own caller runs every operation a body may hold, as the node's caller does: a date in the site's
    /// format, a word turned into the site's code by its table, a searched-for count, a program of the site's own fed
    /// the page's storage, a binary body written from its fields, and an answer only the site's own code unpacks. So
    /// the four tests and shrinking ask such a body rather than saying they could not.
    #[test]
    fn the_learners_own_caller_runs_every_operation_a_body_holds() {
        use route::{Expr, Feed, Fits, Form, Hole, Place, Reach, Step, Way};
        let slot = |name: &str| Box::new(Expr::Slot { name: name.into(), or: None, optional: false });
        let hole = |at: Place, expr: Expr| Hole { at, ways: vec![Way { rung: 0, expr }], over: false, open: false };
        let stored = Expr::Stored { area: route::expr::Area::Local, key: "seed".into() };
        let message = |word: &str| {
            let mut b = vec![0x0a, word.len() as u8];
            b.extend(word.as_bytes());
            b.extend([0x10, 0x14]);
            b
        };
        let mut template = route::wire::open(route::wire::Codec::Protobuf, &message("kettle")).expect("the walk's body opens");
        template[0]["text"] = serde_json::Value::Null;
        let runtime = crate::sandbox::available();
        let mut holes = vec![
            hole(Place::Json("/0/text".into()), *slot("q")),
            hole(Place::Query("d".into()), Expr::Format { of: slot("when"), read: route::Pattern::Time { form: "{yyyy}-{mm}-{dd}".into() }, write: route::Pattern::Time { form: "{dd}/{mm}/{yyyy}".into() } }),
            hole(Place::Query("code".into()), Expr::Lookup { rows: vec![serde_json::json!({ "name": "Lisbon", "code": "LIS" }), serde_json::json!({ "name": "Porto", "code": "OPO" })], fits: Fits::Equals { at: "/name".into(), is: slot("city") }, take: "/code".into() }),
            hole(Place::Query("n".into()), Expr::Solve { algo: route::Algo::Sha256, before: Box::new(Expr::text("ch_1:")), after: Box::new(Expr::text("")), zeros: 2 }),
        ];
        if runtime {
            holes.push(hole(Place::Header("x-sig".into()), Expr::ProgramReading { source: "function sign(ctx) { return 'sig:' + (localStorage.getItem('seed') || ''); }".into(), reads: vec![Feed { read: Reach::Local("seed".into()), from: stored }], evidence: None }));
        }
        let step = Step { id: "x0".into(), method: "POST".into(), url: "https://shop.example/api/search?d=x&code=x&n=0".into(), holes, body: Some(Form::Wire { codec: route::wire::Codec::Protobuf, template }), expect: 200, script: Some(route::Caller { origin: None }), page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None };
        let slots_of = ["q", "when", "city"].map(|name| route::Slot { name: name.into(), secret: false, example: None, choices: Vec::new() }).to_vec();
        // The site's own code reverses its answer's text: no standard reader reads it.
        let decode = runtime.then(|| route::Decode { source: "function sign(ctx) { return ctx.body.split('').reverse().join(''); }".into(), evidence: None });
        let body = route::Route { v: route::VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: slots_of, steps: vec![step], answer: route::Answer { step: "x0".into(), page: false, decode } };
        assert_eq!(body.refused(), None);
        struct Checks(Vec<route::Built>, bool);
        impl Site for Checks {
            fn ask(&mut self, _step: &route::Step, built: &route::Built) -> Said {
                self.0.push(built.clone());
                let answer: String = r#"{"results":[{"title":"teapot one"},{"title":"teapot two"}]}"#.to_string();
                let text = if self.1 { answer.chars().rev().collect() } else { answer };
                let reply = Exchange { method: built.method.clone(), url: built.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some(text), response_mime: "text/plain".into(), resource_type: Some("XHR".into()), main_frame: None };
                Said::Reply { at: None, reply }
            }
        }
        let mut site = Checks(Vec::new(), runtime);
        let slots = HashMap::from([("q", "teapot"), ("when", "2026-11-07"), ("city", "Porto")].map(|(k, v)| (k.to_string(), v.to_string())));
        let jar = HashMap::from([(route::expr::Area::Local.held_as("seed"), "sd-kept".to_string())]);
        let called = call(&body, &slots, &jar, 0, &mut site).unwrap_or_else(|stopped| panic!("the body is not called: {stopped:?}"));
        let sent = &site.0[0];
        let query = |k: &str| sent.url.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.into_owned());
        assert_eq!(query("d").as_deref(), Some("07/11/2026"), "the caller's date in the site's format");
        assert_eq!(query("code").as_deref(), Some("OPO"), "the caller's word as the site's code");
        let n = query("n").expect("a count");
        assert!(route::Algo::Sha256.hash(&format!("ch_1:{n}")).starts_with("00"), "a count that meets the condition");
        assert_eq!(sent.body.as_deref().map(route::wire::bytes_of), Some(message("teapot")), "the binary body with the caller's word in its place");
        if runtime {
            assert_eq!(sent.headers.iter().find(|(k, _)| k == "x-sig").map(|(_, v)| v.as_str()), Some("sig:sd-kept"), "the program fed the session's storage");
            assert_eq!(called.answer.own_json().and_then(|v| v["results"][0]["title"].as_str().map(String::from)).as_deref(), Some("teapot one"), "the answer as the site's own code unpacks it");
        }
    }
}
