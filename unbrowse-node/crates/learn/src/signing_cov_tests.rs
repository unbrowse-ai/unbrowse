//! What a signature is fitted from, and what a route carries of its page's answers (UNB-208).
use super::*;

fn a_call(url: &str) -> crate::replay::Request {
    crate::replay::Request { method: "POST".into(), url: url.parse().unwrap(), exchange: 0, headers: Vec::new(), body: None }
}

/// A signature of 40 hex digits is a SHA-1, of the call's key and its body, proven on a second sighting with another
/// body; an upper-case one, one of an odd length, and one the call's parts do not make are not fitted.
#[test]
fn a_sha1_signature_over_the_calls_key_and_body_is_fitted_and_proven_on_a_second_sighting() {
    let (one, two) = (Algo::Sha1.hash("secret1&amount=5"), Algo::Sha1.hash("secret1&amount=9"));
    let (first, second) = (a_call(&format!("https://pay.shop.example/api?k=secret1&sign={one}")), a_call(&format!("https://pay.shop.example/api?k=secret1&sign={two}")));
    let both = [Sighting { value: &one, request: &first, body: Some("amount=5"), cookies: &[] }, Sighting { value: &two, request: &second, body: Some("amount=9"), cookies: &[] }];
    let recipe = fit_by_search(&both, "sign").expect("a recipe");
    assert_eq!((recipe.algo, recipe.separator.as_str()), (Algo::Sha1, "&"));
    assert_eq!(recipe.parts, vec![Part::Query { key: "k".into() }, Part::Body]);
    assert_eq!(compute_with(&recipe, &first, Some("amount=77"), &[], 0, |_| String::new()), Some(Algo::Sha1.hash("secret1&amount=77")), "the recipe signs a call it never saw");

    // The same value in capitals is not a digest this search reads.
    let (loud_one, loud_two) = (one.to_uppercase(), two.to_uppercase());
    let loud = [Sighting { value: &loud_one, request: &first, body: Some("amount=5"), cookies: &[] }, Sighting { value: &loud_two, request: &second, body: Some("amount=9"), cookies: &[] }];
    assert!(fit_by_search(&loud, "sign").is_none());
    // A hex value of no digest's length.
    let short = [Sighting { value: "abcdef0123", request: &first, body: Some("amount=5"), cookies: &[] }, Sighting { value: "abcdef0124", request: &second, body: Some("amount=9"), cookies: &[] }];
    assert!(fit_by_search(&short, "sign").is_none());
    // A digest nothing the call carries makes: the search runs out of choices and says nothing.
    let other = Algo::Sha1.hash("nothing of this call");
    let nothing = [Sighting { value: &other, request: &first, body: Some("amount=5"), cookies: &[] }, Sighting { value: &other, request: &second, body: Some("amount=9"), cookies: &[] }];
    assert!(fit_by_search(&nothing, "sign").is_none());
    // A first sighting with the right digest, a second that the recipe does not make: refuted, not fitted.
    let refuted = [Sighting { value: &one, request: &first, body: Some("amount=5"), cookies: &[] }, Sighting { value: &two, request: &second, body: Some("amount=10"), cookies: &[] }];
    assert!(fit_by_search(&refuted, "sign").is_none());
}

/// A value the page's code hashed over the call's method, its path with its query and its body is fitted to those
/// parts by name, so it is made again for any call.
#[test]
fn a_value_hashed_over_method_path_with_query_and_body_is_fitted_by_part() {
    let request = crate::replay::Request { method: "POST".into(), url: "https://shop.example/api/x?q=1".parse().unwrap(), exchange: 0, headers: Vec::new(), body: None };
    let input = "POST;/api/x?q=1;body-text";
    let recipe = fit(&Algo::Md5.hash(input), input, &request, Some("body-text"), &[], 1_794_000_000_000).expect("a recipe");
    assert_eq!(recipe.parts, vec![Part::Method, Part::Path, Part::Body]);
    assert_eq!(recipe.separator, ";");
    let bare = crate::replay::Request { url: "https://shop.example/api/x".parse().unwrap(), ..request.clone() };
    let input = "POST;/api/x;body-text";
    assert_eq!(fit(&Algo::Md5.hash(input), input, &bare, Some("body-text"), &[], 0).expect("a recipe").parts, vec![Part::Method, Part::Path, Part::Body], "a path with no query");
    assert!(fit(&Algo::Md5.hash(input), input, &bare, Some("another body"), &[], 0).is_none(), "a piece nothing accounts for is not fitted");
}

fn an_answer(url: &str, status: u16, mime: &str, body: &str, kind: Option<&str>) -> crate::trace::Exchange {
    crate::trace::Exchange {
        method: "GET".into(),
        url: url.parse().unwrap(),
        request_headers: vec![],
        request_body: None,
        status,
        response_headers: vec![],
        response_body: Some(body.into()),
        response_mime: mime.into(),
        resource_type: kind.map(String::from),
        main_frame: None,
    }
}

/// The answers a route carries are the page's own data calls: JSON that its code asked for, from its own site, once
/// per address, answered 2xx, each and all within a bound.
#[test]
fn a_route_carries_only_the_pages_own_json_answers_within_its_bounds() {
    let json = "{\"a\":1}";
    let trace = crate::trace::Trace {
        exchanges: vec![
            an_answer("https://shop.example/api/one", 200, "application/json", json, Some("XHR")),
            an_answer("https://shop.example/api/one", 200, "application/json", json, Some("XHR")),
            an_answer("https://shop.example/api/failed", 500, "application/json", json, Some("XHR")),
            an_answer("https://shop.example/page", 200, "text/html", "<html></html>", Some("Document")),
            an_answer("https://tracker.example/pixel", 200, "application/json", json, Some("XHR")),
            an_answer("https://shop.example/api/bare", 200, "text/plain", "[1,2]", Some("Fetch")),
            an_answer("https://shop.example/api/text", 200, "text/plain", "plain words", Some("Fetch")),
            an_answer("https://shop.example/api/huge", 200, "application/json", &"x".repeat(ANSWER_MAX + 1), Some("XHR")),
        ],
        inputs: vec![],
    };
    let urls: Vec<String> = answers(&trace, "shop.example").into_iter().map(|a| a.url).collect();
    assert_eq!(urls, ["https://shop.example/api/one", "https://shop.example/api/bare"]);

    let many = crate::trace::Trace { exchanges: (0..ANSWERS + 5).map(|n| an_answer(&format!("https://shop.example/api/{n}"), 200, "application/json", json, Some("XHR"))).collect(), inputs: vec![] };
    assert_eq!(answers(&many, "shop.example").len(), ANSWERS, "no more answers than a route carries");

    let big = "[".to_string() + &"1,".repeat(100 * 1024) + "1]";
    let heavy = crate::trace::Trace { exchanges: (0..4).map(|n| an_answer(&format!("https://shop.example/api/{n}"), 200, "application/json", &big, Some("XHR"))).collect(), inputs: vec![] };
    let kept = answers(&heavy, "shop.example");
    assert!(!kept.is_empty() && kept.iter().map(|a| a.body.len()).sum::<usize>() <= ANSWERS_CAP && kept.len() < 4, "the answers' bytes are bounded: {}", kept.len());
}
