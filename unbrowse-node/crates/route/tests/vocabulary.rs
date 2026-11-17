//! The operations and sources added after the first list: the caller's value in the site's format, and a table the
//! site's script ships.

use unbrowse_route::expr::Cx;
use unbrowse_route::{At, Clock, Expr, FileFact, Fits, Outcome, Pattern, Why, World};

struct Only(Vec<(String, String)>);

impl World for Only {
    fn slot(&self, name: &str) -> Option<String> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
    }
    fn cookie(&self, _: &str) -> Option<String> {
        None
    }
    fn read(&self, _: &str, _: &At) -> Option<String> {
        None
    }
    fn answered(&self, _: &str) -> bool {
        false
    }
    fn fresh(&mut self, id: &str, _: Clock) -> String {
        id.into()
    }
    fn now_ms(&self) -> u64 {
        0
    }
    fn digits(&mut self, n: usize) -> String {
        "0".repeat(n)
    }
    fn file(&self, _: &str, _: FileFact) -> Result<String, String> {
        Err(String::new())
    }
    fn same_site(&self, _: &str, _: &str) -> bool {
        false
    }
    fn program_reading(&mut self, _: &str, _: &unbrowse_route::Built, _: &[(unbrowse_route::Reach, Option<String>)]) -> Option<String> {
        Some("made".into())
    }
}

fn eval(expr: &Expr, slot: &str, value: &str) -> Result<Outcome, Why> {
    expr.eval(&mut Cx { world: &mut Only(vec![(slot.into(), value.into())]), host: None, sent: None })
}

fn slot(name: &str) -> Box<Expr> {
    Box::new(Expr::Slot { name: name.into(), or: None, optional: false })
}

#[test]
fn the_callers_date_is_sent_in_the_sites_format_and_a_value_that_is_no_date_stops_the_call() {
    let way = Expr::Format { of: slot("date"), read: Pattern::Time { form: "{yyyy}-{mm}-{dd}".into() }, write: Pattern::Time { form: "{dd}/{mm}/{yyyy}".into() } };
    assert_eq!(eval(&way, "date", "2026-11-07"), Ok(Outcome::Is("07/11/2026".into())));
    assert!(matches!(eval(&way, "date", "next tuesday"), Err(Why::Unread(_))));
    let said = serde_json::to_value(&way).unwrap();
    assert_eq!(said["op"], "format");
    assert_eq!(serde_json::from_value::<Expr>(said).unwrap(), way, "a format reads back as written");
}

#[test]
fn a_table_the_site_ships_turns_the_callers_word_into_its_code() {
    let rows = vec![serde_json::json!({ "name": "Lisbon", "code": "LIS" }), serde_json::json!({ "name": "Oslo", "code": "OSL" })];
    let way = Expr::Lookup { rows, fits: Fits::Equals { at: "/name".into(), is: slot("city") }, take: "/code".into() };
    assert_eq!(eval(&way, "city", "Oslo"), Ok(Outcome::Is("OSL".into())));
    assert_eq!(eval(&way, "city", "Atlantis"), Err(Why::NotListed("Atlantis".into())), "a word the site does not list stops the call");
    let said = serde_json::to_value(&way).unwrap();
    assert_eq!(serde_json::from_value::<Expr>(said.clone()).unwrap(), way);
    assert_eq!(way.slots(), vec!["city"]);
    // An older node, which does not know the source, reads no body that holds it (`a_body_with_an_expression_this_node_does_not_know_does_not_read`).
    let mut unknown = said;
    unknown["op"] = serde_json::json!("lookup_later");
    assert!(serde_json::from_value::<Expr>(unknown).is_err());
}

/// A search posted as a protobuf message with no schema: the body is the walk's message as fields, the word's leaf a
/// hole, and the request for another word is the same message with that leaf's bytes.
#[test]
fn a_binary_body_is_written_from_its_fields_with_the_callers_value_in_its_place() {
    use unbrowse_route::wire::{close, open, Codec};
    use unbrowse_route::{Form, Hole, Place, Step, Way};
    let message = |word: &str| {
        let mut b = vec![0x0a, word.len() as u8];
        b.extend(word.as_bytes());
        b.extend([0x10, 0x14]);
        b
    };
    let mut template = open(Codec::Protobuf, &message("kettle")).expect("the walk's body opens");
    template[0]["text"] = serde_json::Value::Null;
    let step = Step {
        id: "x0".into(),
        method: "POST".into(),
        url: "https://shop.example/api/search".into(),
        holes: vec![Hole { at: Place::Json("/0/text".into()), ways: vec![Way { rung: 0, expr: *slot("q") }], over: false, open: false }],
        body: Some(Form::Wire { codec: Codec::Protobuf, template: template.clone() }),
        expect: 200,
        script: None,
        page: false,
        writes: false,
        on_load: false,
        sets_cookie: false,
        lifetime: None,
        shape: None,
    };
    let built = unbrowse_route::fill::request(&step, &mut Only(vec![("q".into(), "teapot".into())])).expect("it builds");
    assert_eq!(built.body.map(String::into_bytes), Some(message("teapot")));
    assert_eq!(close(Codec::Protobuf, &template), None, "a leaf left empty writes no message");
    let said = serde_json::to_value(step.body.as_ref().unwrap()).unwrap();
    assert_eq!(said["kind"], "wire");
    assert_eq!(serde_json::from_value::<Form>(said).unwrap(), step.body.unwrap());
}

/// What a route's values mean is kept with the body and read back as written: a slot's kind, and the answer's
/// records as pointers into its reply. An empty one is left out, so a body with none is written as it always was.
#[test]
fn a_routes_meaning_reads_back_and_an_empty_one_is_left_out() {
    use unbrowse_route::meaning::{Field, Kind, Meaning, Records};
    let meaning = Meaning {
        kinds: [("when".to_string(), Kind::Date), ("city".to_string(), Kind::Listed)].into(),
        records: Some(Records { list: "/results".into(), fields: vec![Field { name: "title".into(), at: "/title".into(), says: Some("q".into()) }] }),
    };
    let said = serde_json::to_value(&meaning).unwrap();
    assert_eq!(said["kinds"]["when"], "date");
    assert_eq!(serde_json::from_value::<Meaning>(said).unwrap(), meaning);
    assert!(Meaning::default().is_empty());
    assert!(serde_json::from_value::<Meaning>(serde_json::json!({ "kinds": { "when": "weekday" } })).is_err(), "a kind this node does not know does not read");
}

/// Every new operation reports its rung through the one counter (`Built::rung`), whatever rung its way was written
/// with: the site's format of a value 0, a table's code 1, a searched-for count 1, a fed program of the site's own 2.
#[test]
fn every_new_operation_reports_its_rung_through_the_one_counter() {
    use unbrowse_route::{Algo, Feed, Hole, Place, Reach, Step, Way};
    let rung_of = |expr: Expr| {
        let step = Step {
            id: "x0".into(),
            method: "GET".into(),
            url: "https://shop.example/api/search?v=x".into(),
            holes: vec![Hole { at: Place::Query("v".into()), ways: vec![Way { rung: 0, expr }], over: false, open: false }],
            body: None,
            expect: 200,
            script: None,
            page: false,
            writes: false,
            on_load: false,
            sets_cookie: false,
            lifetime: None,
            shape: None,
        };
        unbrowse_route::fill::request(&step, &mut Only(vec![("q".into(), "2026-11-07".into()), ("city".into(), "Porto".into())])).expect("it builds").rung()
    };
    let format = Expr::Format { of: slot("q"), read: Pattern::Time { form: "{yyyy}-{mm}-{dd}".into() }, write: Pattern::Time { form: "{dd}/{mm}/{yyyy}".into() } };
    let lookup = Expr::Lookup { rows: vec![serde_json::json!({ "name": "Porto", "code": "OPO" })], fits: Fits::Equals { at: "/name".into(), is: slot("city") }, take: "/code".into() };
    let solve = Expr::Solve { algo: Algo::Sha256, before: Box::new(Expr::text("ch:")), after: Box::new(Expr::text("")), zeros: 1 };
    let reading = Expr::ProgramReading { source: "function sign(ctx) { return 'x'; }".into(), reads: vec![Feed { read: Reach::Local("seed".into()), from: Expr::text("s") }], evidence: None };
    assert_eq!([rung_of(format), rung_of(lookup), rung_of(solve), rung_of(reading)], [0, 1, 1, 2]);
}

/// A body holding every operation added after the first list at once (a date in the site's format, a table's code, a
/// searched-for count, a fed program of the site's own, a binary body, what its values mean and the answer's decoder)
/// reads here as written, and is run. An older node reads none of it and the route stands as its graph there:
/// `scripts/older-node/check.sh <base> tests/fixtures/a_body_holding_every_new_operation.json` reads it with that
/// node's own crate, which refuses each of them by name.
#[test]
fn a_body_holding_every_new_operation_reads_here_and_is_run() {
    let text = include_str!("fixtures/a_body_holding_every_new_operation.json");
    let body: unbrowse_route::Route = serde_json::from_str(text).expect("this build reads it");
    assert_eq!(body.refused(), None);
    let ops: Vec<&str> = body.steps[0].holes.iter().map(|h| match &h.ways[0].expr {
        Expr::Format { .. } => "format",
        Expr::Lookup { .. } => "lookup",
        Expr::Solve { .. } => "solve",
        Expr::ProgramReading { .. } => "program_reading",
        _ => "other",
    }).collect();
    assert_eq!(ops, ["other", "format", "lookup", "solve", "program_reading"]);
    assert!(matches!(body.steps[0].body, Some(unbrowse_route::Form::Wire { .. })));
    assert!(body.answer.decode.is_some() && body.meaning.records.is_some());
    assert_eq!(serde_json::to_value(&body).unwrap(), serde_json::from_str::<serde_json::Value>(text).unwrap(), "it writes back as it reads");
}
