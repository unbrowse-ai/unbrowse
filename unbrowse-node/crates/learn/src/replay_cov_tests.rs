//! How a step's request is shaped and written (UNB-208): the headers a script's call says, and the bodies replay builds.
use super::*;
use crate::graph::{Body, PartTemplate, Step};

fn a_step(method: &str, body: Option<Body>) -> Step {
    Step { lifetime: None,
        page_signed: false,
        page_producers: Vec::new(),
        exchange: 1,
        method: method.into(),
        status: 200,
        url: "https://shop.example/api/save".into(),
        fields: vec![],
        body,
        response_shape: None,
        needs_browser: false,
        reads_page: false,
        sets_cookie: false,
        on_load: false,
        foreign: false,
        held: vec![],
        fallbacks: Vec::new(),
    }
}

fn shaped(method: &str, url: &str, page: Option<&str>, mut headers: Vec<(String, String)>) -> Vec<(String, String)> {
    script_shape(&a_step(method, None), false, &url.parse().unwrap(), page, &mut headers);
    headers
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// A script's call says where it comes from as a browser's fetch does: the same origin, the same site (another host of
/// it), or another site; a POST names its origin; what the route sets itself stands; a page asked for as a page is
/// shaped by nothing here.
#[test]
fn a_scripts_call_says_the_page_it_comes_from_as_a_browsers_fetch_does() {
    let same = shaped("GET", "https://shop.example/api/x", None, vec![]);
    assert_eq!((header(&same, "sec-fetch-site"), header(&same, "referer"), header(&same, "origin")), (Some("same-origin"), Some("https://shop.example/"), None));
    assert_eq!((header(&same, "sec-fetch-mode"), header(&same, "sec-fetch-dest"), header(&same, "accept")), (Some("cors"), Some("empty"), Some("application/json, text/plain, */*")));
    let site = shaped("GET", "https://api.shop.example/x", Some("https://www.shop.example"), vec![]);
    assert_eq!(header(&site, "sec-fetch-site"), Some("same-site"));
    let cross = shaped("POST", "https://api.shop.example/x", Some("https://www.other.example"), vec![]);
    assert_eq!((header(&cross, "sec-fetch-site"), header(&cross, "origin"), header(&cross, "referer")), (Some("cross-site"), Some("https://www.other.example"), Some("https://www.other.example/")));
    let own = shaped("GET", "https://shop.example/x", None, vec![("Accept".into(), "text/csv".into()), ("Referer".into(), "https://shop.example/mine".into())]);
    assert_eq!((header(&own, "Accept"), header(&own, "Referer")), (Some("text/csv"), Some("https://shop.example/mine")), "the route's own headers win");
    assert!(header(&own, "accept").is_none() && header(&own, "referer").is_none(), "and are not said twice");
    let mut page = vec![];
    script_shape(&a_step("GET", None), true, &"https://shop.example/".parse().unwrap(), None, &mut page);
    assert!(page.is_empty(), "a page asked for as a page gets nothing added");
}

/// A body replay can't write is refused by step: one that is neither JSON nor a form, and a file's bytes, which are
/// sent by their own protocol.
#[test]
fn a_body_that_is_neither_json_nor_form_nor_multipart_is_refused_by_step() {
    for body in [Body::Other, Body::Upload { input: "file".into(), protocol: crate::upload::Protocol::Single, content_type: None }] {
        let e = request_body(3, &a_step("POST", Some(body)), &[]).unwrap_err();
        assert!(matches!(e, ReplayError::UnsupportedBody { step: 3, .. }), "{e}");
    }
    assert_eq!(request_body(1, &a_step("GET", None), &[]).unwrap(), None);
}

/// A multipart body is sent on its recorded boundary, each part with its own headers: a constant text, a JSON part
/// filled from the call's values, and a part the caller gives. A value that holds the boundary would close its part
/// and open another, and is refused.
#[test]
fn a_multipart_body_is_written_on_its_boundary_with_each_parts_headers() {
    let part = |name: &str| PartTemplate { name: name.into(), filename: None, content_type: None, text: None, json: None, types: Default::default() };
    let parts = vec![
        PartTemplate { text: Some("fixed".into()), ..part("note") },
        PartTemplate { filename: Some("a.txt".into()), content_type: Some("text/plain".into()), ..part("file") },
        PartTemplate { json: Some(serde_json::json!({ "q": null, "k": 1 })), types: [("/q".to_string(), "string".to_string())].into(), ..part("meta") },
    ];
    let step = a_step("POST", Some(Body::Multipart { boundary: "BND".into(), parts }));
    let values = vec![(Loc::Part("file".into(), String::new()), "the file's text".to_string()), (Loc::Part("meta".into(), "/q".into()), "lamps".to_string())];
    let written = request_body(1, &step, &values).unwrap().unwrap();
    assert_eq!(
        written,
        "--BND\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nfixed\r\n\
         --BND\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\nContent-Type: text/plain\r\n\r\nthe file's text\r\n\
         --BND\r\nContent-Disposition: form-data; name=\"meta\"\r\n\r\n{\"q\":\"lamps\",\"k\":1}\r\n\
         --BND--\r\n"
    );
    let closing = vec![(Loc::Part("file".into(), String::new()), "x\r\n--BND\r\nContent-Disposition: form-data; name=\"admin\"".to_string())];
    let e = request_body(1, &step, &closing).unwrap_err();
    assert!(matches!(&e, ReplayError::BreaksBody { part, .. } if part == "file"), "{e}");
}

/// A form body sends what the route's field gives, else the walk's constant; an optional input nobody gave, with no
/// constant to stand, is not sent, and a field with neither is sent empty.
#[test]
fn a_form_leaves_out_an_optional_input_nobody_gave() {
    let mut step = a_step("POST", Some(Body::Form { fields: vec![("q".into(), Some("walked".into())), ("opt".into(), None), ("tag".into(), None)] }));
    step.fields.push(crate::graph::Field { loc: Loc::Form("opt".into()), class: Class::Input { name: "opt".into(), secret: false, default: None, optional: true } });
    let values = vec![(Loc::Form("q".into()), "lamps & more".to_string())];
    assert_eq!(request_body(1, &step, &values).unwrap().unwrap(), "q=lamps+%26+more&tag=");
    assert_eq!(request_body(1, &step, &[]).unwrap().unwrap(), "q=walked&tag=", "no value given: the walk's constant stands");
}

/// A site that answers with a door, a gone source, a new shape or a missing mint has changed; any other failure has not.
#[test]
fn a_stale_route_is_one_the_site_answered_otherwise_than_it_did() {
    let door = crate::graph::Door::answered(&crate::trace::Exchange { method: "GET".into(), url: "https://shop.example/".parse().unwrap(), request_headers: vec![], request_body: None, status: 403, response_headers: vec![], response_body: Some("<title>One moment</title><script src=/check.js></script>".into()), response_mime: "text/html".into(), resource_type: None, main_frame: None });
    if let Some(door) = door {
        assert!(ReplayError::Door { step: 1, url: String::new(), status: 403, door, wall: None }.is_stale());
    }
    assert!(ReplayError::Failed { step: 1, url: String::new(), status: 401, body: String::new() }.is_stale());
    assert!(!ReplayError::Failed { step: 1, url: String::new(), status: 500, body: String::new() }.is_stale());
    assert!(ReplayError::MissingMinted("sid".into()).is_stale());
    assert!(!ReplayError::MissingInput("q".into()).is_stale());
}

use crate::replay::fake_wire::Answer;

/// A site whose first page is answered with the site's check for a person.
struct Checking {
    page: &'static str,
    asked: Vec<String>,
}

const VENDORS: &str = "<html><head><title>Just a moment...</title><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></head><body><p>Checking your browser before accessing the site.</p></body></html>";
const OWN: &str = "<html><head><title>One moment</title><script src=/check.js></script></head><body><p>Checking your browser.</p></body></html>";

impl Answer for Checking {
    fn answer(&mut self, req: &Request) -> Result<crate::trace::Exchange, ReplayError> {
        self.asked.push(req.url.path().to_string());
        Ok(crate::trace::Exchange {
            method: req.method.clone(),
            url: req.url.clone(),
            request_headers: vec![],
            request_body: None,
            status: 200,
            response_headers: vec![],
            response_body: Some(self.page.into()),
            response_mime: "text/html".into(),
            resource_type: None,
            main_frame: None,
        })
    }
}

fn a_route_reading_its_first_page(feeds: bool) -> Graph {
    let mut list = a_step("GET", None);
    list.exchange = 1;
    list.url = "https://shop.example/api/list".into();
    if feeds {
        let origin = crate::provenance::Origin { exchange: 0, url: "https://shop.example/".into(), at: crate::provenance::At::Json { pointer: "/token".into() }, wrap: None };
        list.fields.push(crate::graph::Field { loc: Loc::Query("t".into()), class: Class::Derived { origin } });
    }
    let mut first = a_step("GET", None);
    first.exchange = 0;
    first.url = "https://shop.example/".into();
    Graph { steps: vec![first, list], provisional: false, page_origin: None, ..Graph::default() }
}

/// A page the route reads a value from that comes back as the site's check for a person holds none of the value: the
/// call fails at that step, as the site's door where the page is a vendor's, else as a plain failure, and the
/// step after is never asked. A step nothing reads is skipped, as a browser that never loaded it would.
#[test]
fn a_page_that_comes_back_as_the_sites_check_ends_the_call_at_that_step() {
    let mut fetch = Checking { page: VENDORS, asked: vec![] };
    let e = replay(&a_route_reading_its_first_page(true), &HashMap::new(), &mut fetch).unwrap_err();
    assert!(matches!(e, ReplayError::Door { step: 1, status: 200, .. }), "{e:?}");
    assert_eq!(fetch.asked, ["/"], "the step after was never asked");

    let mut plain = Checking { page: OWN, asked: vec![] };
    let e = replay(&a_route_reading_its_first_page(true), &HashMap::new(), &mut plain).unwrap_err();
    assert!(matches!(e, ReplayError::Failed { step: 1, status: 200, .. }), "no vendor marks the answer: {e:?}");
    assert_eq!(plain.asked, ["/"]);

    let mut unread = Checking { page: OWN, asked: vec![] };
    let _ = replay(&a_route_reading_its_first_page(false), &HashMap::new(), &mut unread);
    assert_eq!(unread.asked, ["/", "/api/list"], "a page nothing reads is skipped, and the call goes on");
}

/// A site that holds one session value, and answers nothing.
struct Holding(Option<&'static str>);

impl Answer for Holding {
    fn answer(&mut self, _req: &Request) -> Result<crate::trace::Exchange, ReplayError> {
        Err(ReplayError::Transport("nothing is sent here".into()))
    }
    fn minted(&self, _name: &str) -> Option<String> {
        self.0.map(String::from)
    }
}

fn with_fields(fields: Vec<(Loc, Class)>) -> Step {
    let mut step = a_step("GET", None);
    step.fields = fields.into_iter().map(|(loc, class)| crate::graph::Field { loc, class }).collect();
    step
}

fn realized(step: &Step, inputs: &[(&str, &str)], fetch: &Holding) -> Result<Vec<(Loc, String)>, ReplayError> {
    let inputs: HashMap<String, String> = inputs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    realize(&Graph::default(), 1, step, &inputs, fetch, &HashMap::new(), &HashMap::new(), false)
}

/// A field's value is the caller's, else the walk's default; an optional input nobody gave is left out, and one that is
/// not optional is the call's missing input.
#[test]
fn an_input_nobody_gave_is_left_out_when_optional_and_missing_when_not() {
    let input = |optional: bool, default: Option<&str>| Class::Input { name: "q".into(), secret: false, default: default.map(String::from), optional };
    let q = || Loc::Query("q".into());
    assert_eq!(realized(&with_fields(vec![(q(), input(true, None))]), &[], &Holding(None)).unwrap(), vec![]);
    assert!(matches!(realized(&with_fields(vec![(q(), input(false, None))]), &[], &Holding(None)), Err(ReplayError::MissingInput(name)) if name == "q"));
    assert_eq!(realized(&with_fields(vec![(q(), input(false, Some("walked")))]), &[], &Holding(None)).unwrap(), vec![(q(), "walked".to_string())]);
    assert_eq!(realized(&with_fields(vec![(q(), input(false, Some("walked")))]), &[("q", "lamps")], &Holding(None)).unwrap(), vec![(q(), "lamps".to_string())]);
}

/// A session value the store lacks is not sent, as a browser omits a cookie it does not hold; one it holds is.
#[test]
fn a_session_value_the_store_lacks_is_not_sent() {
    let step = with_fields(vec![(Loc::Header("x-session".into()), Class::Minted { name: "sid".into() })]);
    assert_eq!(realized(&step, &[], &Holding(None)).unwrap(), vec![]);
    assert_eq!(realized(&step, &[], &Holding(Some("s-1"))).unwrap(), vec![(Loc::Header("x-session".into()), "s-1".to_string())]);
}

/// A piece of what the caller sent is the same piece of what they send now; a value too short to hold it, or none at all,
/// ends the call at that step.
#[test]
fn a_piece_of_the_callers_value_is_cut_where_the_walk_cut_it() {
    let step = with_fields(vec![(Loc::Query("day".into()), Class::Piece { input: "when".into(), from: 0, len: 10 })]);
    assert_eq!(realized(&step, &[("when", "2026-11-12T19:00:00")], &Holding(None)).unwrap(), vec![(Loc::Query("day".into()), "2026-11-12".to_string())]);
    assert!(matches!(realized(&step, &[("when", "2026-11")], &Holding(None)), Err(ReplayError::SourceMissing { step: 1, .. })));
    assert!(matches!(realized(&step, &[], &Holding(None)), Err(ReplayError::MissingInput(name)) if name == "when"));
}

/// A step of a route this node didn't learn that puts a credential text of its own around a value the site gave is
/// refused whole; the scheme and a space (`Bearer `) alone is a credential as the site gave it.
#[test]
fn a_strangers_step_may_not_wrap_a_credential_in_text_of_its_own() {
    let wrapped = |before: &str, after: &str| {
        let origin = crate::provenance::Origin { exchange: 0, url: "https://shop.example/".into(), at: crate::provenance::At::Json { pointer: "/token".into() }, wrap: Some((before.into(), after.into())) };
        let mut step = with_fields(vec![(Loc::Header("authorization".into()), Class::Derived { origin })]);
        step.foreign = true;
        step
    };
    assert!(matches!(realized(&wrapped("steal=", ""), &[], &Holding(None)), Err(ReplayError::Refused(why)) if why.contains("didn't learn")));
    assert!(matches!(realized(&wrapped("Bearer ", "; evil=1"), &[], &Holding(None)), Err(ReplayError::Refused(_))));
    // The scheme alone passes the refusal, and the value, which no answer gave here, is then the step's missing source.
    assert!(matches!(realized(&wrapped("Bearer ", ""), &[], &Holding(None)), Err(ReplayError::SourceMissing { .. })));
}
