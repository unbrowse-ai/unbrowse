//! The lab's reading of a sighting as a world, and the writings it knows a value by.

use super::*;
use crate::lab::sighting::tests::{call, trace, walk};
use route::World;

/// Two walks of a page that asks for a token and then searches with it: the token's reply holds a list.
fn two_walks() -> (crate::trace::Trace, crate::trace::Trace) {
    let walked = |word: &str, token: &str| {
        trace(vec![
            call("GET", "https://shop.example/api/session", &[], None, &format!(r#"{{"token":"{token}","list":[{{"name":"a"}},{{"name":"b"}}]}}"#)),
            call("GET", &format!("https://shop.example/api/search?q={word}"), &[("cookie", "sid=dummy-sid; theme=dark"), ("x-token", token)], None, &format!(r#"{{"items":["{word} one"]}}"#)),
        ])
    };
    (walked("lamp", "tok_9f8e7d6c5b"), walked("sofa", "tok_1a2b3c4d5e"))
}

/// One sighting is a world a way is worked out against: the caller's word, the cookie it carried, what an earlier reply
/// of the same walk held (and only an earlier one), the clock its request read, and nothing else: no file, no new id.
#[test]
fn a_sighting_is_a_world_that_holds_what_its_walk_held_and_nothing_later() {
    let (first, second) = two_walks();
    let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
    let kept = crate::sandbox::Storage { local: HashMap::from([("seed".to_string(), "s-1".to_string())]), session: HashMap::from([("tab".to_string(), "one".to_string())]) };
    let lab = Lab::new(&walks).storing(0, kept);
    let search = &first.exchanges[1];
    let mut world = Sighted { lab: &lab, walk: 0, at: 1, exchange: search, clock: None };
    assert_eq!(world.slot("q").as_deref(), Some("lamp"));
    assert_eq!(world.slot("page"), None);
    assert_eq!((world.cookie("sid").as_deref(), world.cookie("theme").as_deref(), world.cookie("gone")), (Some("dummy-sid"), Some("dark"), None));
    assert_eq!(world.cookie_for("sid", Some("shop.example")).as_deref(), Some("dummy-sid"), "the host does not change which cookie the sighting carried");
    assert_eq!((world.stored(route::expr::Area::Local, "seed").as_deref(), world.stored(route::expr::Area::Session, "tab").as_deref()), (Some("s-1"), Some("one")));
    assert_eq!(world.stored(route::expr::Area::Local, "tab"), None);
    let token = route::At::Json { pointer: "/token".into() };
    assert_eq!(world.read("x0", &token).as_deref(), Some("tok_9f8e7d6c5b"));
    assert_eq!(world.read("x1", &token), None, "the call itself is not an earlier reply");
    assert_eq!(world.read("not-a-step", &token), None);
    let names = world.list("x0", "/list").expect("an earlier reply's list");
    assert_eq!(names.len(), 2);
    assert_eq!(world.list("x0", "/token"), None, "a value that is no list");
    assert_eq!(world.list("x1", "/list"), None);
    assert!(world.answered("x0") && !world.answered("x1") && !world.answered("x7") && !world.answered("nope"));
    // The other walk is the other world.
    let other = Sighted { lab: &lab, walk: 1, at: 1, exchange: &second.exchanges[1], clock: None };
    assert_eq!((other.slot("q").as_deref(), other.read("x0", &token).as_deref()), (Some("sofa"), Some("tok_1a2b3c4d5e")));
    assert_eq!(other.stored(route::expr::Area::Local, "seed"), None, "a walk whose storage is not known holds none");
    // A new id is the id as it was; digits are zeros; a file is none; time is the clock the request read, else the reply's date.
    assert_eq!(world.fresh("id-1", route::Clock::Millis), "id-1");
    assert_eq!(world.digits(4), "0000");
    assert!(world.file("photo", route::FileFact::Size).is_err());
    assert_eq!(world.now_ms(), 1_794_398_400_000, "the date the reply was sent");
    let clocked = Sighted { lab: &lab, walk: 0, at: 1, exchange: search, clock: Some(1_794_398_399_120) };
    assert_eq!(clocked.now_ms(), 1_794_398_399_120);
    assert!(world.same_site("https://www.shop.example", "https://api.shop.example"));
    assert!(!world.same_site("https://shop.example", "https://other.example"));
    assert!(!world.same_site("not a url", "not a url"));
}

/// A second walk is asked where it made the first walk's call; a call the first walk never made has no sighting
/// anywhere, and a lab with no walks has none to say.
#[test]
fn a_call_the_first_walk_never_made_is_seen_nowhere() {
    let (first, second) = two_walks();
    let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "sofa")])];
    let lab = Lab::new(&walks);
    assert_eq!(lab.sightings(1), vec![Some(1), Some(1)]);
    assert_eq!(lab.sightings(9), vec![None, None]);
    assert!(Lab::new(&[]).sightings(0).is_empty());
}

/// A request is held as the filler holds it while one place of it is made: everything the sighting sent but that place,
/// and a query that held that place alone is no query at all.
#[test]
fn the_request_held_while_a_place_is_made_has_everything_but_that_place() {
    let only = call("GET", "https://shop.example/api/search?q=lamp", &[], None, "{}");
    assert_eq!(sent_but(&only, &Loc::Query("q".into())).url.as_str(), "https://shop.example/api/search");
    let two = call("GET", "https://shop.example/api/search?q=lamp&page=2", &[], None, "{}");
    assert_eq!(sent_but(&two, &Loc::Query("q".into())).url.as_str(), "https://shop.example/api/search?page=2");
    assert_eq!(sent_but(&two, &Loc::Query("zzz".into())).url.as_str(), "https://shop.example/api/search?q=lamp&page=2");
}

/// A place sends its value under a key where it has one: a query's or a form's name, the last piece of a JSON pointer;
/// a header, a path piece or a cookie has none.
#[test]
fn a_place_sends_its_value_under_a_key_where_it_has_one() {
    assert_eq!(key_of(&Loc::Query("q".into())), Some("q"));
    assert_eq!(key_of(&Loc::Form("term".into())), Some("term"));
    assert_eq!(key_of(&Loc::Json("/filter/term".into())), Some("term"));
    assert_eq!(key_of(&Loc::Header("x-token".into())), None);
}

/// A value that holds a brace of its own is not a stamp's form: a form of the clock is written with braces.
#[test]
fn a_value_with_a_brace_of_its_own_is_not_written_as_a_stamp() {
    assert_eq!(stamp_form("1794398399120{x}", 1_794_398_399_120), None);
    assert_eq!(stamp_form("a}b", 1_794_398_399_120), None);
}

/// A value the page wrote into a query in any of the four base64 writings, with the caller's word inside, is written back
/// the way the page wrote it.
#[test]
fn a_word_inside_a_base64_value_is_written_back_in_the_base64_the_page_used() {
    for (wrap, how) in [
        (Wrap::Base64, route::Wrap::Base64),
        (Wrap::Base64NoPad, route::Wrap::Base64NoPad),
        (Wrap::Base64Url, route::Wrap::Base64Url),
        (Wrap::Base64UrlNoPad, route::Wrap::Base64UrlNoPad),
    ] {
        // `>>>???` has bytes whose base64 uses the two characters the url alphabet changes; the word's own length decides the padding.
        let packed = |word: &str| url::form_urlencoded::byte_serialize(wrap.close(&format!(r#"{{"query":"{word}","sort":">>>???"}}"#)).as_bytes()).collect::<String>();
        let walked = |word: &str| trace(vec![call("GET", &format!("https://shop.example/gql?s={}", packed(word)), &[], None, "{}")]);
        let (a, b) = (walked("lamp"), walked("sofa"));
        let walks = [walk(&a, &[("q", "lamp")]), walk(&b, &[("q", "sofa")])];
        let holes = Lab::new(&walks).holes(0);
        let hole = holes.iter().find(|h| h.at == Loc::Query("s".into())).expect("the place");
        assert_eq!(hole.kind, Kind::Callers, "{wrap:?}: {:?}", hole.ways);
        assert!(matches!(&hole.ways[0].expr, Expr::Wrapped { how: got, .. } if *got == how), "{wrap:?}: {:?}", hole.ways[0].expr);
    }
}
