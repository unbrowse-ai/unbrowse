//! The redemption against what a shop's check sent on 2026-11-25 (`tests/fixtures/checks`): the page the wall named,
//! the frame its check is drawn in, and the request the frame sent once a solver's token was handed to it.

use super::*;
use crate::solver::{check_in_html, frames_in_html, Kind};
use unbrowse_learn::replay::ReplayError;
use unbrowse_learn::trace::Exchange;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/checks").join(name)).unwrap()
}

fn redeemed() -> Value {
    serde_json::from_str(&fixture("redeemed.json")).unwrap()
}

const TOKEN: &str = "TOKEN-THE-SOLVER-GAVE";

fn proposed() -> Redemption {
    let r = redeemed();
    let s = |k: &str| r[k].as_str().unwrap().to_string();
    let set: Vec<String> = r["set_cookie"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    propose(&Url::parse(&s("check")).unwrap(), TOKEN, &s("method"), &Url::parse(&s("url")).unwrap(), &s("content_type"), &s("body"), &names_set(&set)).expect("the request the page sent is a redemption")
}

/// The request the check's frame sent with the token is read for where each value came from: the token in the JSON a
/// field holds (with the short constant beside it), a value the frame's own address carries, and the cookie the answer
/// set. The long signature the page's own code computed beside the token is no value the walk can source, and is left
/// out: the site took the token without it (measured 2026-11-25).
#[test]
fn a_redemption_is_read_from_the_request_the_check_sent_with_the_token() {
    let r = proposed();
    assert_eq!((r.method.as_str(), r.to.as_str(), r.earns.as_slice()), ("POST", "validate", &["x5sec".to_string()][..]));
    assert_eq!(r.fields[0], Field { name: "x5secdata".into(), from: Slot::Address { param: "x5secdata".into() } });
    let Slot::TokenIn { key, with } = &r.fields[1].from else { panic!("{:?}", r.fields[1]) };
    assert_eq!((r.fields[1].name.as_str(), key.as_str()), ("token", "token"));
    assert_eq!(Value::Object(with.clone()), serde_json::json!({ "b": 1 }), "the constant kept, the page's own signature left out");
}

/// Made again for another check and another token: the same address beside the new check's document, the value its
/// address carries now, and the new token where the old one stood.
#[test]
fn a_redemption_is_made_again_for_another_check_and_token() {
    let r = proposed();
    let check = Url::parse("https://www.shop.example/tag/lamp/_____tmd_____/punish?recaptcha=1&iframe=1&x5step=2&x5secdata=NEW-DATA").unwrap();
    let (url, body) = r.request(&check, "T2").unwrap();
    assert_eq!(url.as_str(), "https://www.shop.example/tag/lamp/_____tmd_____/validate");
    let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
    assert_eq!(form["x5secdata"], "NEW-DATA");
    assert_eq!(serde_json::from_str::<Value>(&form["token"]).unwrap(), serde_json::json!({ "token": "T2", "b": 1 }));
    let bare = Url::parse("https://www.shop.example/tag/lamp/_____tmd_____/punish").unwrap();
    assert!(r.request(&bare, "T2").is_none(), "a check whose address lacks the value the request takes from it");
}

/// A request that carries no token, one whose answer set nothing, and one with no form body are no redemption.
#[test]
fn a_request_with_no_token_nothing_set_or_no_form_is_no_redemption() {
    let r = redeemed();
    let (check, url) = (Url::parse(r["check"].as_str().unwrap()).unwrap(), Url::parse(r["url"].as_str().unwrap()).unwrap());
    let (ct, body) = (r["content_type"].as_str().unwrap(), r["body"].as_str().unwrap());
    let set = vec!["x5sec".to_string()];
    assert!(propose(&check, "ANOTHER-TOKEN", "POST", &url, ct, body, &set).is_none(), "no token in it");
    assert!(propose(&check, TOKEN, "POST", &url, ct, body, &[]).is_none(), "nothing set in answer");
    assert!(propose(&check, TOKEN, "POST", &url, "application/json", body, &set).is_none(), "no form body");
}

/// The check is read from the markup the site sent, without running it: the frame holds the key in its own script
/// and loads the widget's enterprise code; the page the wall named holds no key, and frames the check on its site.
#[test]
fn the_check_is_read_from_the_markup_the_site_sent() {
    let frame_at = Url::parse("https://www.lazada.sg/tag/air-fryer/_____tmd_____/punish?recaptcha=1&iframe=1&x5step=2&x5secdata=xg").unwrap();
    let check = check_in_html(&fixture("a-shops-check-frame.html"), &frame_at).expect("the frame holds the check");
    assert_eq!((check.key.as_str(), check.kind), ("6LeKU1AnAAAAANDF_Hx4z4OgLH1CJRwTO4IQ0Rfa", Kind::RecaptchaV2Enterprise));
    assert_eq!(check.page_url, frame_at.as_str());
    let page_at = Url::parse("https://www.lazada.sg//tag/air-fryer//_____tmd_____/punish?x5secdata=xf").unwrap();
    let page = fixture("a-shops-check-page.html");
    assert!(check_in_html(&page, &page_at).is_none());
    let frames = frames_in_html(&page, &page_at);
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert!(frames[0].as_str().starts_with("https://www.lazada.sg/tag/air-fryer/_____tmd_____/punish?recaptcha=1&iframe=1&x5step=2&x5secdata=xg8537"), "{}", frames[0]);
}

/// The site as the captures show it: the page the wall named, the frame under it, and the redemption, which sets the
/// pass only for the token the solver gave with the value the frame's address carried.
struct Site {
    sets: bool,
    asked: Vec<(String, String)>,
}

impl Fetch for Site {
    fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.asked.push((req.method.clone(), req.url.to_string()));
        let body = String::from_utf8(req.body.clone().unwrap_or_default()).unwrap_or_default();
        let (status, headers, page) = if req.url.path().ends_with("/validate") {
            let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes()).into_owned().collect();
            // The value the frame's own address carries (`a-shops-check-page.html` frames it).
            let frame_data = "xg8537c834a4fd9378na";
            let took = form.get("x5secdata").is_some_and(|d| d.starts_with(frame_data)) && form.get("token").is_some_and(|t| t.contains("SOLVED"));
            let set = if took && self.sets { vec![("set-cookie".to_string(), "x5sec=the-pass; Max-Age=7000; Domain=lazada.sg; Path=/".to_string())] } else { Vec::new() };
            (200, set, r#"{"success":true}"#.to_string())
        } else if req.url.query().is_some_and(|q| q.contains("recaptcha=1")) {
            (200, vec![("set-cookie".to_string(), "frame=seen; Path=/".to_string())], fixture("a-shops-check-frame.html"))
        } else {
            (200, Vec::new(), fixture("a-shops-check-page.html"))
        };
        Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: req.headers.clone(), request_body: Some(body), status, response_headers: headers, response_body: Some(page), response_mime: String::new(), resource_type: None, main_frame: None })
    }

    fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
        self.fetch(req)
    }
}

/// A call's wall is cleared with no browser: the page it named is read, the check found in the frame under it, the
/// solver asked for that check, and the kept redemption sent with the token; what the site set is the pass, with the
/// life it gave. A site that takes the token and sets nothing has cleared nothing.
#[test]
fn a_wall_is_cleared_by_the_solver_and_the_redemption_kept_for_the_site() {
    let wall = Wall::Check { url: "https://www.lazada.sg//tag/air-fryer//_____tmd_____/punish?x5secdata=xf&x5step=1".into() };
    let kept = vec![proposed()];
    let mut asked_for = Vec::new();
    let mut site = Site { sets: true, asked: Vec::new() };
    let pass = clear_with(
        &wall,
        &kept,
        &mut site,
        &mut |c| {
            asked_for.push((c.key.clone(), c.kind));
            Some("SOLVED".into())
        },
        None,
    )
    .expect("the wall was cleared");
    assert_eq!(asked_for, [("6LeKU1AnAAAAANDF_Hx4z4OgLH1CJRwTO4IQ0Rfa".to_string(), Kind::RecaptchaV2Enterprise)]);
    assert_eq!((pass.cookies.get("x5sec").map(String::as_str), pass.ttl, pass.by), (Some("the-pass"), Some(7000), Some(Source::Solver)));
    let validate = site.asked.last().unwrap();
    assert_eq!((validate.0.as_str(), validate.1.as_str()), ("POST", "https://www.lazada.sg/tag/air-fryer/_____tmd_____/validate"));

    let mut stingy = Site { sets: false, asked: Vec::new() };
    assert!(clear_with(&wall, &kept, &mut stingy, &mut |_| Some("SOLVED".into()), None).is_none(), "the site set nothing");
    assert!(clear_with(&Wall::Rate, &kept, &mut Site { sets: true, asked: Vec::new() }, &mut |_| Some("SOLVED".into()), None).is_none(), "a wall that names no check");
    assert!(clear_with(&wall, &kept, &mut Site { sets: true, asked: Vec::new() }, &mut |_| None, None).is_none(), "no token");
}

/// With no redemption kept for the site, or one the site no longer pays out on, the check is met in the node's own
/// browser where the call may open it, and what was earned there is the pass; where it may not, nothing is.
#[test]
fn a_check_with_no_redemption_that_earns_is_met_in_the_nodes_browser_where_the_call_may_open_it() {
    let wall = Wall::Check { url: "https://www.lazada.sg//tag/air-fryer//_____tmd_____/punish?x5secdata=xf".into() };
    let met: std::cell::RefCell<Vec<String>> = Default::default();
    let mut browser = |url: &str| {
        met.borrow_mut().push(url.to_string());
        Some(in_the_browser(vec![("x5sec".into(), "from-the-browser".into(), Some(1_000_700.0)), ("other".into(), "v".into(), None)], &["x5sec".to_string()], 1_000_000.0))
    };
    let pass = clear_with(&wall, &[], &mut Site { sets: true, asked: Vec::new() }, &mut |_| Some("SOLVED".into()), Some(&mut browser)).expect("met in the browser");
    assert!(pass.browser && pass.cookies.get("x5sec").map(String::as_str) == Some("from-the-browser"), "{pass:?}");
    assert_eq!(pass.ttl, Some(700), "the life of the cookie a redemption earns");
    assert_eq!(*met.borrow(), [wall_url(&wall)]);

    let mut stingy = Site { sets: false, asked: Vec::new() };
    assert!(clear_with(&wall, &[proposed()], &mut stingy, &mut |_| Some("SOLVED".into()), Some(&mut browser)).is_some_and(|p| p.browser), "a redemption that earned nothing falls to the browser");
    assert_eq!(met.borrow().len(), 2);
    assert!(clear_with(&wall, &[], &mut Site { sets: true, asked: Vec::new() }, &mut |_| Some("SOLVED".into()), None).is_none(), "no browser where the call may not open one");
    assert_eq!(in_the_browser(vec![("x5sec".into(), "v".into(), None)], &[], 0.0).ttl, None, "no life said, none made up");
}

fn wall_url(wall: &Wall) -> String {
    match wall {
        Wall::Check { url } => url.clone(),
        _ => String::new(),
    }
}

/// The page a call was sent to is read before anything is spent on it: one that holds no check (the site's word that
/// it won't answer this caller) buys no token and opens no browser, and the wall is left to time.
#[test]
fn a_page_with_no_check_on_it_is_left_to_time_with_nothing_spent() {
    struct Says;
    impl Fetch for Says {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            let page = "<html><body><p>We have detected unusual traffic from your network, please try again later.</p></body></html>";
            Ok(Exchange { method: req.method.clone(), url: req.url.clone(), request_headers: vec![], request_body: None, status: 200, response_headers: vec![], response_body: Some(page.into()), response_mime: "text/html".into(), resource_type: None, main_frame: None })
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
    }
    let wall = Wall::Check { url: "https://deny.example/punish/template.html?action=deny".into() };
    let spent = std::cell::Cell::new(0);
    let mut browser = |_: &str| {
        spent.set(spent.get() + 1);
        None
    };
    let pass = clear_with(&wall, &[proposed()], &mut Says, &mut |_| {
        spent.set(spent.get() + 1);
        Some("SOLVED".into())
    }, Some(&mut browser));
    assert!(pass.is_none());
    assert_eq!(spent.get(), 0, "no token bought and no browser opened for a page that holds no check");
}

/// The solver clears a site at most once in a while: a wall back sooner is left to time.
#[test]
fn a_site_is_cleared_again_only_once_its_spacing_has_passed() {
    let now = std::time::Instant::now();
    assert!(spaced(None, now), "never cleared");
    assert!(!spaced(Some(now), now + SPACING / 2), "walled again soon after a pass");
    assert!(spaced(Some(now), now + SPACING), "once the spacing has passed");
}

/// The clearer as a call holds it: nothing without a solver or a transport; with no redemption kept, the check is met
/// in the node's browser (one that fails earns nothing); a site cleared a moment ago is left to time, whatever walls it
/// again; and the redemption kept for a site earns the pass over the call's transport.
#[test]
fn the_clearer_tries_its_solver_its_redemption_then_the_browser_and_spaces_its_clears() {
    crate::store::scratch_home("redeem-clearer");
    // The stand-in's check page frames its check on this host, as the site it was captured from does.
    let wall = Wall::Check { url: "https://www.lazada.sg//tag/air-fryer//_____tmd_____/punish?x5secdata=xf".into() };
    let solved = || -> Option<Token> { Some(Box::new(|_| Ok("SOLVED".to_string()))) };
    let site = |_: &str| -> Result<Box<dyn Fetch>, String> { Ok(Box::new(Site { sets: true, asked: Vec::new() })) };
    let unmet = |_: &str| -> Met { Err("no browser in a test".into()) };
    let met = |_: &str| -> Met { Ok(("solved in the tab".into(), vec![("pass".into(), "from-the-tab".into(), None)])) };

    assert!(clearer_with("www.lazada.sg".into(), true, || None, site, unmet)(&wall).is_none(), "no solver, no pass");
    let no_net = |_: &str| -> Result<Box<dyn Fetch>, String> { Err("no transport in a test".into()) };
    assert!(clearer_with("www.lazada.sg".into(), true, solved, no_net, unmet)(&wall).is_none(), "no transport, no pass");
    assert!(clearer_with("www.lazada.sg".into(), true, solved, site, unmet)(&wall).is_none(), "a browser that failed earned nothing");

    let mut tab = clearer_with("www.lazada.sg".into(), true, solved, site, met);
    assert!(tab(&wall).is_some_and(|p| p.browser && p.cookies.get("pass").map(String::as_str) == Some("from-the-tab")), "met in the node's browser");
    assert!(tab(&wall).is_none(), "walled again a moment after a pass: left to time");

    // Another site, its redemption kept: its pass earned over the call's own transport, no browser. Its check page is
    // the captured one, framed on the first site, so the stand-in is asked for it there.
    keep("lazada.sg", proposed());
    let mut kept = clearer_with("www.lazada.com.sg".into(), false, solved, site, unmet);
    let wall_too = Wall::Check { url: "https://www.lazada.sg//tag/air-fryer//_____tmd_____/punish?x5secdata=xf&step=2".into() };
    assert!(kept(&wall_too).is_none(), "no redemption kept for that site, and no browser for this call");
}
