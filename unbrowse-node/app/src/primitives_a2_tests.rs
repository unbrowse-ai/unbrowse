//! Tests of the fixture site the matrix walks, over plain HTTP (UNB-208 step 6, owner A2): what it answers for a value
//! it holds nothing for, and for the words its catalogue names by their first letter.

use super::*;

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()
}

/// A search page the server renders says it found nothing for a value it holds nothing for, under its headings, and
/// lists no card; for any other value it lists three.
#[test]
fn the_server_rendered_search_page_says_it_found_nothing_for_a_made_up_word() {
    let (base, http) = (site(), client());
    let none = http.get(format!("{base}/p/first-unknown-page?q=qzxkettle")).send().unwrap().text().unwrap();
    assert!(none.contains("There was nothing for 'qzxkettle'") && none.contains("<strong>0</strong>"), "{none}");
    assert!(!none.contains("class=\"card\""));
    let found = http.get(format!("{base}/p/first-unknown-page?q=teapot")).send().unwrap().text().unwrap();
    assert!(found.contains("<strong>3</strong>") && found.contains("teapot one") && !found.contains("There was nothing for"), "{found}");
}

/// A results page whose state holds the records lists none for a made-up word, and other things for a word that
/// starts with another letter: not the same names with the word swapped.
#[test]
fn the_state_page_holds_no_records_for_a_made_up_word_and_other_ones_by_first_letter() {
    let (base, http) = (site(), client());
    let page = |q: &str| http.get(format!("{base}/p/unknown-frame?q={q}")).send().unwrap().text().unwrap();
    let none = page("qzxkettle");
    assert!(none.contains("Nothing matched your search.") && none.contains("\"results\":[]"), "{none}");
    let (t, s) = (page("teapot"), page("saucepan"));
    assert!(t.contains("teapot one bone china with gold rim") && !t.contains("Nothing matched"), "{t}");
    assert!(s.contains("saucepan one nonstick with glass lid"), "{s}");
    assert!(!s.contains("bone china"), "another letter, other records");
}

/// A page that sends a value it holds nothing for to its front page, with a marker of its own and none of the value,
/// searches any other.
#[test]
fn a_made_up_word_is_sent_to_the_front_page_without_the_word() {
    let (base, http) = (site(), client());
    let sent = http.get(format!("{base}/p/unknown-elsewhere?q=qzxkettle")).send().unwrap();
    assert_eq!(sent.status(), 302);
    let to = sent.headers()["location"].to_str().unwrap();
    assert_eq!(to, "/p/unknown-home?label=gen1&error_unknown=q");
    assert!(!to.contains("qzx"));
    assert_eq!(http.get(format!("{base}/p/unknown-elsewhere?q=teapot")).send().unwrap().status(), 200);
}

/// The records a subject's page lists are other things by the word's first letter, so a search for another word finds
/// other records.
#[test]
fn a_subjects_page_lists_other_records_for_a_word_that_starts_with_another_letter() {
    let (base, http) = (site(), client());
    let page = |q: &str| http.get(format!("{base}/p/foreign-subject?q={q}")).send().unwrap().text().unwrap();
    let (t, s, k) = (page("teapot"), page("saucepan"), page("kettle"));
    assert!(t.contains("bone china with gold rim") && !t.contains("nonstick"), "{t}");
    assert!(s.contains("nonstick with glass lid") && !s.contains("bone china"), "{s}");
    assert!(k.contains("enamel stovetop model"), "{k}");
}

/// A request signed with the standard digest is answered only when the signature is of this request, however current
/// its clock.
#[test]
fn a_standard_signature_that_is_not_of_this_request_is_refused() {
    let (base, http) = (site(), client());
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().to_string();
    let ask = |sig: &str| http.get(format!("{base}/api/signed-standard/search?q=teapot")).header("x-ts", &ts).header("x-sig", sig).send().unwrap();
    let bad = ask("0000");
    assert_eq!(bad.status(), 403);
    assert!(bad.text().unwrap().contains("the signature is not of this request"));
    let good = hex::encode(Sha256::digest(format!("{ts}:teapot:fixture-key").as_bytes()));
    assert!(ask(&good).text().unwrap().contains("teapot two"));
}
