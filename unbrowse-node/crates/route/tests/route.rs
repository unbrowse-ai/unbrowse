//! The body and its filler, held to the properties `docs/REBUILD.md` names for phase 1.

use std::collections::HashMap;

use serde_json::json;
use unbrowse_route::{Algo, Answer, At, Built, Caller, Clock, Expr, FileFact, Fits, Form, Hole, How, Place, Route, Sent, Step, Stuck, Way, Why, World, Wrap, VERSION};

/// A world a test writes by hand.
#[derive(Default)]
struct Hand {
    slots: HashMap<String, String>,
    jar: HashMap<String, String>,
    /// A step's reply, as the values at the JSON pointers a test reads.
    replies: HashMap<String, HashMap<String, String>>,
    /// A step's reply's lists, by step and pointer.
    lists: HashMap<(String, String), Vec<serde_json::Value>>,
    now: u64,
}

impl Hand {
    fn slot(mut self, name: &str, value: &str) -> Self {
        self.slots.insert(name.into(), value.into());
        self
    }
    fn cookie(mut self, name: &str, value: &str) -> Self {
        self.jar.insert(name.into(), value.into());
        self
    }
    fn reply(mut self, step: &str, values: &[(&str, &str)]) -> Self {
        self.replies.insert(step.into(), values.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect());
        self
    }
}

impl World for Hand {
    fn slot(&self, name: &str) -> Option<String> {
        self.slots.get(name).cloned()
    }
    fn cookie(&self, name: &str) -> Option<String> {
        self.jar.get(name).cloned()
    }
    fn read(&self, step: &str, at: &At) -> Option<String> {
        let At::Json { pointer } = at else { return None };
        self.replies.get(step)?.get(pointer).cloned()
    }
    fn list(&self, step: &str, pointer: &str) -> Option<Vec<serde_json::Value>> {
        self.lists.get(&(step.to_string(), pointer.to_string())).cloned()
    }
    fn answered(&self, step: &str) -> bool {
        self.replies.contains_key(step)
    }
    fn fresh(&mut self, _id: &str, clock: Clock) -> String {
        match clock {
            Clock::Millis => self.now.to_string(),
            Clock::Seconds => (self.now / 1000).to_string(),
            Clock::Random => "080dbce1-3f6b-4a45-b181-2c6c26f285ca".to_string(),
        }
    }
    fn now_ms(&self) -> u64 {
        self.now
    }
    fn digits(&mut self, n: usize) -> String {
        "7".repeat(n)
    }
    fn file(&self, named: &str, fact: FileFact) -> Result<String, String> {
        match fact {
            FileFact::Name => Ok(named.rsplit('/').next().unwrap_or(named).to_string()),
            FileFact::Size => Ok("12".into()),
        }
    }
    fn same_site(&self, a: &str, b: &str) -> bool {
        let site = |o: &str| o.rsplit('.').take(2).collect::<Vec<_>>().join(".");
        site(a) == site(b)
    }
}

fn way(expr: Expr) -> Way {
    Way { rung: 0, expr }
}

fn hole(at: Place, expr: Expr) -> Hole {
    Hole { at, ways: vec![way(expr)], over: false, open: false }
}

fn slot(name: &str) -> Expr {
    Expr::Slot { name: name.into(), or: None, optional: false }
}

fn step(method: &str, url: &str, holes: Vec<Hole>) -> Step {
    Step { id: "search".into(), method: method.into(), url: url.into(), holes, body: None, expect: 200, script: None, page: false, writes: false, on_load: false, sets_cookie: false, lifetime: None, shape: None }
}

fn built(step: &Step, world: &mut Hand) -> Built {
    unbrowse_route::request(step, world).unwrap_or_else(|stuck| panic!("{stuck}"))
}

fn stuck(step: &Step, world: &mut Hand) -> Stuck {
    unbrowse_route::request(step, world).expect_err("the request should not have been built")
}

fn header<'a>(built: &'a Built, name: &str) -> Option<&'a str> {
    built.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

#[test]
fn a_body_read_back_is_the_body_written() {
    let route = Route {
        v: VERSION, tests: Vec::new(), plan: None, meaning: Default::default(),
        site: "shop.example".into(),
        slots: vec![unbrowse_route::Slot { name: "q".into(), secret: false, example: Some("lamp".into()), choices: vec![] }],
        steps: vec![
            Step { id: "token".into(), ..step("GET", "https://shop.example/session", vec![]) },
            Step {
                body: Some(Form::Json { template: json!({"q": null, "page": 1}), types: [("/q".to_string(), "string".to_string())].into(), follows: vec![] }),
                script: Some(Caller { origin: Some("https://www.shop.example".into()) }),
                shape: Some(json!({"items": "array"})),
                ..step(
                    "POST",
                    "https://api.shop.example/v2/{path[1]}/search",
                    vec![
                        hole(Place::Path(1), Expr::Written { of: Box::new(slot("q")), how: How::Dashed }),
                        hole(Place::Json("/q".into()), slot("q")),
                        Hole {
                            at: Place::Header("x-token".into()),
                            ways: vec![way(Expr::Read { step: "token".into(), at: At::Json { pointer: "/token".into() } }), way(Expr::Cookie { name: "token".into(), here: true })],
                            over: false,
                            open: false,
                        },
                        Hole {
                            at: Place::Header("x-sign".into()),
                            ways: vec![Way {
                                rung: 1,
                                expr: Expr::Hash {
                                    algo: Algo::Md5,
                                    of: Box::new(Expr::Join { parts: vec![Expr::Sent { part: Sent::Path }, Expr::Stamp { form: "{ms}-{d4}".into() }, Expr::Sent { part: Sent::Cookie("sid".into()) }], with: ";".into() }),
                                },
                            }],
                            over: false,
                            open: false,
                        },
                    ],
                )
            },
        ],
        answer: Answer { step: "search".into(), page: false, decode: None },
    };
    assert_eq!(route.refused(), None);
    let written = serde_json::to_string(&route).unwrap();
    let read: Route = serde_json::from_str(&written).unwrap();
    assert_eq!(read, route);
    assert_eq!(serde_json::to_string(&read).unwrap(), written, "written twice, a body is the same bytes");
    assert_eq!(route.asked(), ["q"]);
    assert!(!route.holds_code());
}

/// A node never runs part of a body it only half understands: an operation it does not know, or a part of a known
/// one it does not know, and the body does not read at all.
#[test]
fn a_body_with_an_expression_this_node_does_not_know_does_not_read() {
    let body = |expr: serde_json::Value| {
        json!({"v": 2, "site": "shop.example", "answer": {"step": "s"},
               "steps": [{"id": "s", "method": "GET", "url": "https://shop.example/", "expect": 200,
                          "holes": [{"at": {"in": "query", "key": "q"}, "ways": [{"rung": 0, "expr": expr}]}]}]})
    };
    assert!(serde_json::from_value::<Route>(body(json!({"op": "slot", "name": "q"}))).is_ok());
    assert!(serde_json::from_value::<Route>(body(json!({"op": "run_this", "code": "fetch('/')"}))).is_err());
    assert!(serde_json::from_value::<Route>(body(json!({"op": "slot", "name": "q", "then": "anything"}))).is_err());
    let mut later = body(json!({"op": "slot", "name": "q"}));
    later["v"] = json!(3);
    let later: Route = serde_json::from_value(later).unwrap();
    assert!(later.refused().is_some_and(|why| why.contains("version 3")));
}

#[test]
fn a_read_of_a_step_that_does_not_come_before_is_refused() {
    let read = |from: &str| hole(Place::Query("t".into()), Expr::Read { step: from.into(), at: At::Json { pointer: "/t".into() } });
    let route = |first: Step, second: Step| Route { v: VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![], steps: vec![first, second], answer: Answer { step: "search".into(), page: false, decode: None } };
    let token = Step { id: "token".into(), ..step("GET", "https://shop.example/t", vec![]) };
    assert_eq!(route(token.clone(), step("GET", "https://shop.example/s", vec![read("token")])).refused(), None);
    assert!(route(step("GET", "https://shop.example/s", vec![read("token")]), token).refused().is_some_and(|why| why.contains("does not come before")));
    assert!(route(Step { id: "a".into(), ..step("GET", "https://shop.example/a", vec![]) }, Step { id: "b".into(), ..step("GET", "https://shop.example/b", vec![]) })
        .refused()
        .is_some_and(|why| why.contains("the answer names step search")));
}

#[test]
fn the_first_way_that_is_ready_fills_the_hole() {
    let token = Hole {
        at: Place::Header("x-token".into()),
        ways: vec![way(Expr::Read { step: "token".into(), at: At::Json { pointer: "/token".into() } }), way(Expr::Cookie { name: "token".into(), here: false })],
        over: false,
        open: false,
    };
    let s = step("GET", "https://shop.example/search", vec![hole(Place::Query("q".into()), slot("q")), token]);
    // The reply holds it: the reply's is sent.
    let mut world = Hand::default().slot("q", "lamp").cookie("token", "from-the-jar").reply("token", &[("/token", "from-the-reply")]);
    assert_eq!(header(&built(&s, &mut world), "x-token"), Some("from-the-reply"));
    // The reply does not: the jar's is.
    let mut world = Hand::default().slot("q", "lamp").cookie("token", "from-the-jar").reply("token", &[]);
    assert_eq!(header(&built(&s, &mut world), "x-token"), Some("from-the-jar"));
    // Neither holds it: a cookie the jar lacks is not sent, as a browser omits one it does not have.
    let mut world = Hand::default().slot("q", "lamp");
    let b = built(&s, &mut world);
    assert_eq!(header(&b, "x-token"), None);
    assert_eq!(b.url.as_str(), "https://shop.example/search?q=lamp");
}

#[test]
fn a_value_no_way_can_make_stops_the_call_and_says_which() {
    let s = step("GET", "https://shop.example/search", vec![hole(Place::Query("q".into()), slot("q")), hole(Place::Query("t".into()), Expr::Read { step: "token".into(), at: At::Json { pointer: "/t".into() } })]);
    let no_word = stuck(&s, &mut Hand::default());
    assert_eq!((no_word.at, no_word.why), (Some(Place::Query("q".into())), Why::Slot("q".into())));
    let no_token = stuck(&s, &mut Hand::default().slot("q", "lamp"));
    assert_eq!((no_token.at, no_token.why), (Some(Place::Query("t".into())), Why::Source { step: "token".into() }));
}

/// A value the walk read from a reply, which this call's reply does not hold: left out once that step has been
/// answered, and a call that cannot be made while it has not.
#[test]
fn a_value_a_reply_was_to_hold_is_left_out_only_once_the_step_was_answered() {
    let s = step(
        "GET",
        "https://shop.example/search",
        vec![Hole {
            at: Place::Header("x-request-id".into()),
            ways: vec![way(Expr::Read { step: "page".into(), at: At::Header { name: "x-request-id".into() } }), way(Expr::Nothing { after: Some("page".into()) })],
            over: false,
            open: false,
        }],
    );
    assert_eq!(stuck(&s, &mut Hand::default()).why, Why::Source { step: "page".into() });
    assert_eq!(header(&built(&s, &mut Hand::default().reply("page", &[])), "x-request-id"), None);
}

#[test]
fn an_optional_slot_left_unset_takes_its_key_with_it() {
    let optional = |name: &str| Expr::Slot { name: name.into(), or: None, optional: true };
    let json = Step {
        body: Some(Form::Json { template: json!({"q": null, "sort": null, "safe": true}), types: [("/q".to_string(), "string".to_string()), ("/sort".to_string(), "string".to_string())].into(), follows: vec![] }),
        ..step(
            "POST",
            "https://shop.example/search",
            vec![hole(Place::Json("/q".into()), slot("q")), hole(Place::Json("/sort".into()), optional("sort")), hole(Place::Query("page".into()), optional("page"))],
        )
    };
    let b = built(&json, &mut Hand::default().slot("q", "lamp"));
    assert_eq!(b.body.as_deref(), Some(r#"{"q":"lamp","safe":true}"#));
    assert_eq!(b.url.as_str(), "https://shop.example/search");
    let b = built(&json, &mut Hand::default().slot("q", "lamp").slot("sort", "price").slot("page", "2"));
    assert_eq!(b.body.as_deref(), Some(r#"{"q":"lamp","sort":"price","safe":true}"#));
    assert_eq!(b.url.as_str(), "https://shop.example/search?page=2");

    let form = Step {
        body: Some(Form::Fields { fields: vec![("q".into(), None), ("sort".into(), None), ("lang".into(), Some("en".into()))] }),
        ..step("POST", "https://shop.example/search", vec![hole(Place::Form("q".into()), slot("q")), hole(Place::Form("sort".into()), optional("sort"))])
    };
    assert_eq!(built(&form, &mut Hand::default().slot("q", "desk lamp")).body.as_deref(), Some("q=desk+lamp&lang=en"));
}

/// A form's field sends what its hole gives. The form's own text is what the walk sent, and stands only where the
/// hole gives nothing: left to stand over the hole, it would send the walk's value to every caller.
#[test]
fn a_forms_field_sends_what_its_hole_gives_and_the_walks_text_only_where_it_gives_nothing() {
    let optional = |name: &str| Expr::Slot { name: name.into(), or: None, optional: true };
    let form = Step {
        body: Some(Form::Fields { fields: vec![("q".into(), None), ("count".into(), Some("10".into())), ("first".into(), Some("0".into()))] }),
        ..step("POST", "https://funds.example/rest/search", vec![hole(Place::Form("q".into()), slot("q")), hole(Place::Form("count".into()), optional("count"))])
    };
    assert_eq!(built(&form, &mut Hand::default().slot("q", "index funds").slot("count", "25")).body.as_deref(), Some("q=index+funds&count=25&first=0"));
    assert_eq!(built(&form, &mut Hand::default().slot("q", "index funds")).body.as_deref(), Some("q=index+funds&count=10&first=0"), "left unset, the walk's value");
}

/// A slot the caller left empty sends what the walk sent there, so a call with nothing written is the walk's call.
#[test]
fn a_slot_left_empty_sends_what_the_walk_sent() {
    let s = step("GET", "https://shop.example/search", vec![hole(Place::Query("q".into()), Expr::Slot { name: "q".into(), or: Some("lamp".into()), optional: false })]);
    assert_eq!(built(&s, &mut Hand::default()).url.as_str(), "https://shop.example/search?q=lamp");
    assert_eq!(built(&s, &mut Hand::default().slot("q", "desk")).url.as_str(), "https://shop.example/search?q=desk");
}

#[test]
fn a_fixed_leaf_keeps_its_kind_and_a_hole_is_written_as_the_kind_the_walk_sent() {
    let s = Step {
        body: Some(Form::Json {
            template: json!({"count": null, "exact": null, "q": null, "page": 1}),
            types: [("/count".to_string(), "number".to_string()), ("/exact".to_string(), "bool".to_string()), ("/q".to_string(), "string".to_string())].into(),
            follows: vec![],
        }),
        ..step("POST", "https://shop.example/search", vec![hole(Place::Json("/count".into()), slot("n")), hole(Place::Json("/exact".into()), slot("exact")), hole(Place::Json("/q".into()), slot("q"))])
    };
    let b = built(&s, &mut Hand::default().slot("n", "20").slot("exact", "true").slot("q", "42"));
    assert_eq!(b.body.as_deref(), Some(r#"{"count":20,"exact":true,"q":"42","page":1}"#));
}

#[test]
fn the_callers_word_goes_where_the_walks_stood_in_a_longer_value() {
    let swap = |inside: Option<Wrap>, within: &str, how: How| Expr::Swap { within: Box::new(Expr::text(within)), was: "lamp".into(), now: Box::new(Expr::Written { of: Box::new(Expr::Given { name: "q".into() }), how }), inside };
    // In a JSON a query carries.
    let s = step("GET", "https://shop.example/gql", vec![hole(Place::Query("variables".into()), swap(None, r#"{"term":"lamp","lamps":3}"#, How::Json))]);
    let b = built(&s, &mut Hand::default().slot("q", "desk \"light\""));
    assert_eq!(b.url.query_pairs().next().unwrap().1, r#"{"term":"desk \"light\"","lamps":3}"#, "the word is swapped where it stands whole, and not inside another");
    // With nothing given, the value goes as the walk sent it.
    assert_eq!(built(&s, &mut Hand::default()).url.query_pairs().next().unwrap().1, r#"{"term":"lamp","lamps":3}"#);
    // In a text that is encoded again.
    let packed = Wrap::Base64.close(r#"{"q":"lamp","n":10}"#);
    let s = step("GET", "https://shop.example/find", vec![hole(Place::Query("s".into()), swap(Some(Wrap::Base64), &packed, How::Json))]);
    let sent = built(&s, &mut Hand::default().slot("q", "desk")).url.query_pairs().next().unwrap().1.into_owned();
    assert_eq!(Wrap::Base64.open(&sent).as_deref(), Some(r#"{"q":"desk","n":10}"#));
}

/// The walk's own text may say the caller's new word somewhere else: as a key of the JSON the word rides in, or as
/// an earlier search a history holds. The word still goes where the walk's stood. Only a value this call read from
/// a reply, which the site wrote for this call, is left for saying it already.
#[test]
fn a_word_the_walked_value_says_elsewhere_is_still_written_where_the_walks_stood() {
    let swap = |within: Expr| Expr::Swap { within: Box::new(within), was: "lamp".into(), now: Box::new(Expr::Written { of: Box::new(Expr::Given { name: "q".into() }), how: How::Json }), inside: None };
    let walked = step("GET", "https://shop.example/gql", vec![hole(Place::Query("variables".into()), swap(Expr::text(r#"{"query":"lamp","past":["desk"]}"#)))]);
    let sent = |word: &str| built(&walked, &mut Hand::default().slot("q", word)).url.query_pairs().next().unwrap().1.into_owned();
    assert_eq!(sent("query"), r#"{"query":"query","past":["desk"]}"#, "asked for a word that is a key of the value");
    assert_eq!(sent("desk"), r#"{"query":"desk","past":["desk"]}"#, "asked for a word the value holds elsewhere");
    // Read from a reply that already says the caller's word: the site's own text for this call, sent as it is.
    let read = step("GET", "https://shop.example/gql", vec![hole(Place::Query("cursor".into()), swap(Expr::Read { step: "page".into(), at: At::Json { pointer: "/cursor".into() } }))]);
    let from = |reply: &str| built(&read, &mut Hand::default().slot("q", "desk").reply("page", &[("/cursor", reply)])).url.query_pairs().next().unwrap().1.into_owned();
    assert_eq!(from("after:desk:lamp:20"), "after:desk:lamp:20", "the reply says the word already");
    assert_eq!(from("after:lamp:20"), "after:desk:20", "the reply says the walk's word: the caller's goes there");
}

#[test]
fn a_piece_of_the_callers_value_is_cut_from_what_they_give_now() {
    let piece = |from, len| Expr::Slice { of: Box::new(Expr::Given { name: "when".into() }), from, len };
    let s = step("GET", "https://tables.example/find", vec![hole(Place::Query("date".into()), piece(0, 10)), hole(Place::Query("time".into()), piece(11, 5))]);
    assert_eq!(built(&s, &mut Hand::default().slot("when", "2027-03-09T20:30:00")).url.as_str(), "https://tables.example/find?date=2027-03-09&time=20%3A30");
    assert_eq!(stuck(&s, &mut Hand::default().slot("when", "2027-03-09")).why, Why::Short);
    assert_eq!(stuck(&s, &mut Hand::default()).why, Why::Slot("when".into()));
}

/// A signature is made over the request as it is sent, so it is worked out last and written into what it was made
/// over: a header set, or a value of the address appended after the others.
#[test]
fn a_signature_over_the_request_is_written_after_the_request_is_built() {
    let signature = Expr::Hash {
        algo: Algo::Md5,
        of: Box::new(Expr::Join {
            parts: vec![Expr::Sent { part: Sent::Path }, Expr::Sent { part: Sent::Method }, Expr::Stamp { form: "-{ms}-{d3}".into() }, Expr::Sent { part: Sent::Cookie("GUID".into()) }, Expr::text("")],
            with: ";".into(),
        }),
    };
    let holes = |at: Place| vec![hole(Place::Query("q".into()), slot("q")), hole(Place::Cookie("GUID".into()), Expr::Cookie { name: "GUID".into(), here: false }), Hole { at, ways: vec![Way { rung: 1, expr: signature.clone() }], over: false, open: false }];
    let world = || Hand { now: 1_794_198_118_858, ..Hand::default() }.slot("q", "tokyo").cookie("GUID", "0903410231");
    let made_over = "/flights?q=tokyo;GET;-1794198118858-777;0903410231;";

    let in_a_header = built(&step("get", "https://air.example/flights", holes(Place::Header("x-sign".into()))), &mut world());
    assert_eq!(header(&in_a_header, "x-sign"), Some(Algo::Md5.hash(made_over).as_str()));
    assert_eq!(in_a_header.rung(), 1);

    let in_the_address = built(&step("get", "https://air.example/flights", holes(Place::Query("sign".into()))), &mut world());
    assert_eq!(in_the_address.url.as_str(), format!("https://air.example/flights?q=tokyo&sign={}", Algo::Md5.hash(made_over)));

    // The jar does not hold a cookie it is made over yet: it is signed over nothing in that cookie's place, as a page's
    // own code signs before its gateway hands it the token (#705). The site that issues the cookie answers that call with
    // it, and the call is signed again with what it handed over (`replay::resigned`).
    let no_cookie = built(&step("get", "https://air.example/flights", holes(Place::Header("x-sign".into()))), &mut Hand { now: 1_794_198_118_858, ..Hand::default() }.slot("q", "tokyo"));
    assert_eq!(header(&no_cookie, "x-sign"), Some(Algo::Md5.hash("/flights?q=tokyo;GET;-1794198118858-777;;").as_str()));
    assert_eq!(header(&no_cookie, "cookie"), None, "the blank cookie is what the digest reads, never what is sent");
}

/// What a digest is made over never reaches the request as itself: only the digest does. A reading of the clock
/// joined into a value is in the clear; one hashed into it is not.
#[test]
fn what_a_digest_is_made_over_is_not_in_the_clear() {
    let stamp = || Expr::Stamp { form: "{ms}".into() };
    let sent = Expr::Join { parts: vec![Expr::text("r-"), stamp()], with: String::new() };
    assert!(sent.in_the_clear().iter().any(|e| matches!(e, Expr::Stamp { .. })));
    for digest in [Expr::Hash { algo: Algo::Sha1, of: Box::new(stamp()) }, Expr::Hmac { algo: Algo::Sha256, key: Box::new(Expr::text("k")), of: Box::new(stamp()) }] {
        let beside = Expr::Join { parts: vec![Expr::text("v1."), digest], with: String::new() };
        assert!(!beside.in_the_clear().iter().any(|e| matches!(e, Expr::Stamp { .. })), "{beside:?}");
        assert!(beside.all().iter().any(|e| matches!(e, Expr::Stamp { .. })), "every expression inside it is still among all of them");
    }
}

#[test]
fn the_digests_are_the_standard_ones() {
    assert_eq!(Algo::Md5.hash("abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(Algo::Sha1.hash("abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert_eq!(Algo::Sha256.hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // RFC 2202 and RFC 4231, test case 2.
    assert_eq!(Algo::Md5.keyed("Jefe", "what do ya want for nothing?"), "750c783e6ab0b503eaa86e310a5db738");
    assert_eq!(Algo::Sha1.keyed("Jefe", "what do ya want for nothing?"), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    assert_eq!(Algo::Sha256.keyed("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
}

#[test]
fn a_list_with_a_gap_is_not_sent_and_a_list_read_off_a_shorter_list_ends_where_it_ended() {
    let ids = |follows: Vec<String>| Step {
        body: Some(Form::Json {
            template: json!({"ids": [null, null, null]}),
            types: (0..3).map(|i| (format!("/ids/{i}"), "number".to_string())).collect(),
            follows,
        }),
        ..step(
            "POST",
            "https://tables.example/availability",
            (0..3)
                .map(|i| Hole {
                    at: Place::Json(format!("/ids/{i}")),
                    ways: vec![way(Expr::Read { step: "list".into(), at: At::Json { pointer: format!("/places/{i}/id") } }), way(Expr::Nothing { after: Some("list".into()) })],
                    over: false,
                    open: false,
                })
                .collect(),
        )
    };
    let two = || Hand::default().reply("list", &[("/places/0/id", "11"), ("/places/1/id", "12")]);
    let gap = stuck(&ids(vec![]), &mut two());
    assert_eq!((gap.at, gap.why), (Some(Place::Json("/ids/2".into())), Why::Gap));
    assert_eq!(built(&ids(vec!["/ids".into()]), &mut two()).body.as_deref(), Some(r#"{"ids":[11,12]}"#));
    // A reply with no list at all leaves the first place empty, and that is still a gap.
    assert_eq!(stuck(&ids(vec!["/ids".into()]), &mut Hand::default().reply("list", &[])).why, Why::Gap);
}

#[test]
fn a_scripts_call_says_the_page_it_comes_from_and_a_page_is_asked_for_as_a_page() {
    let call = |origin: Option<&str>, method: &str| Step { script: Some(Caller { origin: origin.map(String::from) }), ..step(method, "https://api.shop.example/search", vec![hole(Place::Header("accept".into()), Expr::text("application/vnd.shop+json"))]) };
    let b = built(&call(Some("https://www.shop.example"), "POST"), &mut Hand::default());
    assert_eq!(header(&b, "accept"), Some("application/vnd.shop+json"), "a header the step sets itself stands");
    assert_eq!(header(&b, "sec-fetch-site"), Some("same-site"));
    assert_eq!(header(&b, "referer"), Some("https://www.shop.example/"));
    assert_eq!(header(&b, "origin"), Some("https://www.shop.example"));
    let b = built(&call(None, "GET"), &mut Hand::default());
    assert_eq!((header(&b, "sec-fetch-site"), header(&b, "origin")), (Some("same-origin"), None));
    assert_eq!(header(&built(&call(Some("https://other.example"), "GET"), &mut Hand::default()), "sec-fetch-site"), Some("cross-site"));
    let page = step("GET", "https://shop.example/search", vec![]);
    assert!(built(&page, &mut Hand::default()).headers.is_empty());
}

#[test]
fn an_address_handed_over_is_taken_whole_only_on_the_steps_own_origin() {
    let s = step("PUT", "https://upload.shop.example/{path[0]}", vec![hole(Place::Url, Expr::Read { step: "start".into(), at: At::Json { pointer: "/to".into() } })]);
    let b = built(&s, &mut Hand::default().reply("start", &[("/to", " https://upload.shop.example/files/9?sig=ab ")]));
    assert_eq!(b.url.as_str(), "https://upload.shop.example/files/9?sig=ab");
    let elsewhere = stuck(&s, &mut Hand::default().reply("start", &[("/to", "https://files.other.example/9")]));
    assert!(matches!(elsewhere.why, Why::OtherOrigin { .. }), "{elsewhere}");
}

#[test]
fn a_value_that_holds_the_bodys_boundary_is_refused() {
    let part = |name: &str| unbrowse_route::Part { name: name.into(), filename: None, content_type: None, text: None, json: None, types: Default::default() };
    let s = Step {
        body: Some(Form::Multipart { boundary: "XyZ".into(), parts: vec![part("title"), unbrowse_route::Part { text: Some("en".into()), ..part("lang") }] }),
        ..step("POST", "https://shop.example/post", vec![hole(Place::Part("title".into(), String::new()), slot("title"))])
    };
    assert_eq!(
        built(&s, &mut Hand::default().slot("title", "A lamp")).body.as_deref(),
        Some("--XyZ\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nA lamp\r\n--XyZ\r\nContent-Disposition: form-data; name=\"lang\"\r\n\r\nen\r\n--XyZ--\r\n")
    );
    assert_eq!(stuck(&s, &mut Hand::default().slot("title", "x\r\n--XyZ\r\nmore")).why, Why::Breaks { part: "title".into() });
}

#[test]
fn a_piece_of_the_path_is_written_as_an_address_writes_it() {
    let s = step("GET", "https://shop.example/search/{path[1]}/all", vec![hole(Place::Path(1), slot("q")), hole(Place::Query("n".into()), Expr::text("10"))]);
    assert_eq!(built(&s, &mut Hand::default().slot("q", "desk lamp/é")).url.as_str(), "https://shop.example/search/desk%20lamp%2F%C3%A9/all?n=10");
}

#[test]
fn a_program_runs_only_where_the_world_runs_one() {
    let s = step("GET", "https://shop.example/search", vec![Hole { at: Place::Header("x-sig".into()), ways: vec![Way { rung: 2, expr: Expr::Program { source: "function sign(ctx) {}".into(), evidence: None } }], over: false, open: false }]);
    let no_runner = stuck(&s, &mut Hand::default());
    assert_eq!((no_runner.at, no_runner.why), (Some(Place::Header("x-sig".into())), Why::Needs(2)));
    let route = Route { v: VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![], steps: vec![s], answer: Answer { step: "search".into(), page: false, decode: None } };
    assert!(route.holds_code(), "a body that holds a program is never shared");
}

/// A city's id, picked from the list an earlier reply gave: the first item whose name is the caller's city, in the
/// list's order. None that fits stops the call; two that fit give the first.
#[test]
fn a_pick_takes_the_first_item_of_a_list_that_fits() {
    let cities = |names: &[&str]| names.iter().enumerate().map(|(n, name)| json!({ "name": name, "id": format!("c{n}"), "region": { "code": format!("r{n}") } })).collect::<Vec<_>>();
    let world = |names: &[&str], city: &str| Hand { lists: HashMap::from([(("x0".to_string(), "/data/cities".to_string()), cities(names))]), ..Hand::default() }.slot("city", city);
    let pick = |fits: Fits, take: &str| Expr::Pick { step: "x0".into(), list: "/data/cities".into(), fits, take: take.into() };
    let by_name = || Fits::Equals { at: "/name".into(), is: Box::new(slot("city")) };
    let s = |expr: Expr| step("GET", "https://air.example/fares", vec![hole(Place::Query("city".into()), expr)]);
    // Fits one.
    assert_eq!(built(&s(pick(by_name(), "/id")), &mut world(&["Lisbon", "Porto", "Faro"], "Porto")).url.as_str(), "https://air.example/fares?city=c1");
    assert_eq!(built(&s(pick(by_name(), "/region/code")), &mut world(&["Lisbon", "Porto"], "Lisbon")).url.as_str(), "https://air.example/fares?city=r0");
    // Fits none: the call stops, as at a value the reply was to hold and did not.
    assert_eq!(stuck(&s(pick(by_name(), "/id")), &mut world(&["Lisbon", "Porto"], "Madrid")).why, Why::Source { step: "x0".into() });
    // Fits two: the first, in the list's order.
    let holds = Fits::Holds { at: "/name".into(), is: Box::new(slot("city")) };
    assert_eq!(built(&s(pick(holds, "/id")), &mut world(&["Porto Santo", "Porto", "Oporto"], "porto")).url.as_str(), "https://air.example/fares?city=c0");
    // A list the reply does not hold stops the call too.
    assert_eq!(stuck(&s(pick(by_name(), "/id")), &mut Hand::default().slot("city", "Porto")).why, Why::Source { step: "x0".into() });
    // A pick reads its step, and names the slot it is held to.
    let p = pick(by_name(), "/id");
    assert_eq!((p.reads(), p.slots()), (vec!["x0"], vec!["city"]));
}

/// A pick is data: it reads back as it was written, and a condition this evaluator does not know refuses the body.
#[test]
fn a_pick_reads_back_and_an_unknown_condition_does_not_read() {
    let pick = Expr::Pick { step: "x0".into(), list: "/items".into(), fits: Fits::Holds { at: "/title".into(), is: Box::new(Expr::Written { of: Box::new(slot("q")), how: How::Lower }) }, take: "/id".into() };
    let written = serde_json::to_string(&pick).unwrap();
    assert_eq!(serde_json::from_str::<Expr>(&written).unwrap(), pick);
    let unknown = written.replace("\"when\":\"holds\"", "\"when\":\"matches\"");
    assert_ne!(unknown, written);
    assert!(serde_json::from_str::<Expr>(&unknown).is_err(), "a condition this node does not know");
    let free = r#"{"op":"pick","step":"x0","list":"/items","take":"/id","fits":{"when":"equals","at":"/a","is":{"op":"text","is":"x"},"code":"item.a > 1"}}"#;
    assert!(serde_json::from_str::<Expr>(free).is_err(), "no free-form predicate rides on a known one");
}

/// A search body with one slot, `q` (secret where `secret`), filled into the query.
fn searched(secret: bool) -> Route {
    let s = step("GET", "https://shop.example/search", vec![Hole { at: Place::Query("q".into()), ways: vec![Way { rung: 0, expr: Expr::Slot { name: "q".into(), or: None, optional: false } }], over: false, open: false }]);
    let slot = unbrowse_route::Slot { name: "q".into(), secret, example: None, choices: Vec::new() };
    Route { v: VERSION, tests: Vec::new(), plan: None, meaning: Default::default(), site: "shop.example".into(), slots: vec![slot], steps: vec![s], answer: Answer { step: "search".into(), page: false, decode: None } }
}

fn plan(page: &str) -> unbrowse_route::Plan {
    unbrowse_route::Plan { page: page.into(), goal: "search the shop".into(), asked: vec![unbrowse_route::Asked { slot: "q".into(), at: unbrowse_route::AskedAt::Query("q".into()), by: unbrowse_route::AskedBy::TwoWalks }], done: Vec::new() }
}

/// A plan keeps the page with `{name}` where a slot was asked. One that holds a value there does not read, and the
/// refusal says a secret's value where the slot is one: a secret's value has no place to stand in a plan.
#[test]
fn a_plan_with_a_value_where_a_slot_was_asked_does_not_read() {
    let mut route = searched(false);
    route.plan = Some(plan("https://shop.example/search?q={q}&sort=new"));
    assert_eq!(route.refused(), None);
    route.plan = Some(plan("https://shop.example/search?q=lamp&sort=new"));
    assert!(route.refused().is_some_and(|why| why.contains("holds a value where q was asked")), "{:?}", route.refused());
    let mut secret = searched(true);
    secret.plan = Some(plan("https://shop.example/login?q=hunter2"));
    assert!(secret.refused().is_some_and(|why| why.contains("a secret's value")), "{:?}", secret.refused());
    // Read and written again, a well-formed plan is the same.
    route.plan = Some(plan("https://shop.example/search?q={q}&sort=new"));
    let written = serde_json::to_string(&route).unwrap();
    assert_eq!(serde_json::from_str::<Route>(&written).unwrap(), route);
}

/// A plan names every value its page was asked, whether or not the call takes it: a page's own ask the body has no
/// slot for reads, as long as its place stands as `{name}`. What was done on the page fills a slot of the body or a
/// value the page was asked, and nothing else.
#[test]
fn a_plan_names_what_its_page_was_asked_and_what_was_done_fills_one_of_them() {
    let mut route = searched(false);
    let mut both = plan("https://shop.example/search?q={q}&in={in}");
    both.asked.push(unbrowse_route::Asked { slot: "in".into(), at: unbrowse_route::AskedAt::Query("in".into()), by: unbrowse_route::AskedBy::OneWalk });
    both.done = vec![unbrowse_route::Done { kind: "select".into(), target: "Department".into(), slot: Some("in".into()) }];
    route.plan = Some(both.clone());
    assert_eq!(route.refused(), None);
    both.done[0].slot = Some("colour".into());
    route.plan = Some(both);
    assert!(route.refused().is_some_and(|why| why.contains("neither a slot of the body nor asked of the page")), "{:?}", route.refused());
}

/// A slot may stand inside the page's own marks (`{q}-`): those are written back around the value. A letter or a
/// digit beside it is a value, not a mark, and such a plan does not read.
#[test]
fn a_slot_inside_the_pages_own_marks_reads_and_one_beside_a_value_does_not() {
    let mut route = searched(false);
    let mut marked = plan("https://shop.example/search?q={q}-");
    route.plan = Some(marked.clone());
    assert_eq!(route.refused(), None);
    assert_eq!(marked.address(&HashMap::from([("q".to_string(), "lamp".to_string())])).as_deref(), Some("https://shop.example/search?q=lamp-"));
    marked.page = "https://shop.example/search?q=lamp{q}".into();
    route.plan = Some(marked);
    assert!(route.refused().is_some_and(|why| why.contains("where q was asked")), "{:?}", route.refused());
}

/// A plan written before it said how its places were found reads each as one walk's reading.
#[test]
fn a_place_that_does_not_say_how_it_was_found_is_one_walks() {
    let plan: unbrowse_route::Plan = serde_json::from_str(r#"{"page":"https://shop.example/search?q={q}","goal":"search","asked":[{"slot":"q","at":{"query":"q"}}]}"#).unwrap();
    assert_eq!(plan.asked[0].by, unbrowse_route::AskedBy::OneWalk);
}

/// The address a plan says for another value: the value in each place a slot was asked, in the query, the path and
/// the fragment, the rest of the page as it was.
#[test]
fn a_plans_address_writes_each_slot_where_it_was_asked() {
    let values = HashMap::from([("q".to_string(), "desk lamp".to_string())]);
    let at = |page: &str| plan(page).address(&values).unwrap();
    assert_eq!(at("https://shop.example/search?q={q}&sort=new"), "https://shop.example/search?q=desk+lamp&sort=new");
    assert_eq!(at("https://shop.example/search/{q}/all"), "https://shop.example/search/desk%20lamp/all");
    assert_eq!(at("https://shop.example/search#q={q}&page=1"), "https://shop.example/search#q=desk+lamp&page=1");
}

/// A test is of a step the body has, and a value made for the call is seen at one of its holes: one of another step,
/// or that saw the caller's value where the step has no hole, does not read. A value is kept as its shape.
#[test]
fn a_test_is_of_a_step_the_body_has_and_keeps_shapes() {
    use unbrowse_route::{Chars, Seen, Shape, Sighting, Source, Test};
    assert_eq!(Shape::of("lamp"), Shape { len: 4, of: Chars::Letters });
    assert_eq!(Shape::of("desk lamp"), Shape { len: 9, of: Chars::Words });
    assert_eq!(Shape::of("1794398399120"), Shape { len: 13, of: Chars::Digits });
    assert_eq!(Shape::of("9f8e7d6c5b4a"), Shape { len: 12, of: Chars::Hex });
    assert_eq!(Shape::of("tok_9f8e-7d"), Shape { len: 11, of: Chars::Token });
    let seen = |at: Place, from: Source| Seen { at, from, shape: Shape::of("lamp") };
    let mut route = searched(false);
    route.tests = vec![Test { step: "search".into(), sightings: vec![Sighting { seen: vec![seen(Place::Query("q".into()), Source::Caller), seen(Place::Header("x-client".into()), Source::Fixed)] }], over_scripts: Vec::new() }];
    assert_eq!(route.refused(), None, "a fixed value may sit in the step's own text");
    route.tests[0].sightings[0].seen.push(seen(Place::Header("x-token".into()), Source::Read));
    assert!(route.refused().is_some_and(|why| why.contains("where the step has no hole")), "{:?}", route.refused());
    route.tests = vec![Test { step: "other".into(), sightings: Vec::new(), over_scripts: Vec::new() }];
    assert!(route.refused().is_some_and(|why| why.contains("step other")), "{:?}", route.refused());
}
