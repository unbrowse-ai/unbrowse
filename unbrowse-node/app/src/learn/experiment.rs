//! Two walks of one page, for two values: what the second says of the first's calls.
//!
//! One walk cannot tell a call that answers the caller from one that merely carries the page's query: both send the
//! value, and both answer something. A second walk of the same page for another value is the experiment. A call the
//! page makes both times, whose answer has nothing of its own beside the other's, does not hear the caller, whatever
//! it is named and whatever it carries; one whose answer changes does. Nothing here asks a site: both walks are read.

use super::*;

/// What a second walk says of one call of the first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Told {
    /// The page made the call both times and its answer changed with the value.
    Hears,
    /// The page made the call both times and it answered the same.
    Deaf,
    /// The second walk has no such call, or its answers say too little to tell apart: nothing is learned of it.
    Unseen,
}

/// What two addresses of one page were each asked: the values they differ by, in the query (and a fragment written as
/// one) under the same key, and in the path at the same place, as the engine's one reader of two addresses says them
/// (`lab::sighting::apart`), each whole. The experiment chose both values, so it need not work out which parts of an
/// address are the caller's: whatever differs is.
pub(super) fn asked_apart(first: &str, second: &str) -> (Vec<String>, Vec<String>) {
    let (Ok(a), Ok(b)) = (url::Url::parse(first), url::Url::parse(second)) else { return Default::default() };
    unbrowse_learn::lab::sighting::apart(&a, &b).into_iter().map(|d| (d.first_whole(), d.second_whole())).unzip()
}

/// The page's address asked for `word` in place of each word it was asked (`values`): in the query under the same
/// key, and in the path at the same place. A flag, a number or a single letter is no word and stays: a guest count
/// asked as a nonsense word is another page, not another search. A date asked another date written the same way is
/// moved as a word is. None when the address holds no word to replace.
/// A path piece that is an asked word inside marks of the site's own is that word's place too: one walk reads the
/// word out of `chicken-`, and a second walk has to put another back in the same way.
pub(super) fn for_another_word(url: &str, values: &[String], word: &str) -> Option<String> {
    let mut u = url::Url::parse(url).ok()?;
    // A value of a kind the word is too (a date put in place of a date written the same way) is moved as a word is:
    // the page for it is the same page asked another value, not another page.
    let same_kind = |v: &str| {
        let theirs = unbrowse_learn::lab::forms::time_reads(word);
        unbrowse_learn::lab::forms::time_reads(v).iter().any(|form| theirs.contains(form))
    };
    let a_word = |v: &str| (v.chars().any(char::is_alphabetic) || same_kind(v)) && !unbrowse_learn::slots::is_flag(v) && v.chars().count() >= 2 && values.iter().any(|x| x == v);
    let mut replaced = false;
    let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    if pairs.iter().any(|(_, v)| a_word(v)) {
        replaced = true;
        let moved: Vec<(String, String)> = pairs.into_iter().map(|(k, v)| if a_word(&v) { (k, word.to_string()) } else { (k, v) }).collect();
        u.query_pairs_mut().clear().extend_pairs(moved);
    }
    let segments: Vec<String> = u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default();
    // A piece that is a word inside the site's own marks (`/search/chicken-`): the word is moved and the marks stay.
    let marked = |p: &str| {
        let core = p.trim_matches(|c: char| !c.is_alphanumeric());
        (core != p && a_word(core)).then(|| p.replacen(core, word, 1))
    };
    if segments.iter().any(|p| a_word(p) || marked(p).is_some()) {
        replaced = true;
        let moved: Vec<String> = segments.into_iter().map(|p| if a_word(&p) { word.to_string() } else { marked(&p).unwrap_or(p) }).collect();
        u.path_segments_mut().ok()?.clear().extend(moved.iter().map(String::as_str));
    }
    // A page may be asked in its fragment, written as a query is (`/search#q=bonds`): the word sits there, and the
    // page for another word is the same address with the word replaced there.
    if let Some(fragment) = u.fragment().filter(|f| f.contains('=')).map(String::from) {
        let pairs: Vec<(String, String)> = url::form_urlencoded::parse(fragment.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        if pairs.iter().any(|(_, v)| a_word(v)) {
            replaced = true;
            let moved: String = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(pairs.into_iter().map(|(k, v)| if a_word(&v) { (k, word.to_string()) } else { (k, v) })).finish();
            u.set_fragment(Some(&moved));
        }
    }
    replaced.then(|| u.to_string())
}

/// A call's address with the value the page was asked struck out of its path, so the same call made for another
/// value (`/search/chicken-`, `/search/pasta-`) is found again.
fn place(e: &Exchange, asked: &[String]) -> String {
    let path = percent_encoding::percent_decode_str(e.url.path()).decode_utf8_lossy().to_lowercase();
    let path = asked.iter().filter(|v| v.chars().count() >= 2).fold(path, |p, v| p.replace(&v.to_lowercase(), "\u{a7}"));
    format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), path)
}

/// What a call answered, as something two answers are compared by: its data, or the page it rendered.
pub(super) fn answer_of(e: &Exchange) -> Option<serde_json::Value> {
    if let Some(v) = e.own_json() {
        return Some(v);
    }
    let body = e.response_body.as_deref().filter(|b| unbrowse_learn::page::is_markup(&e.response_mime, b))?;
    Some(unbrowse_learn::page::read(body, &e.url))
}

/// What `second`, a walk of the same page asked for `other`, says of call `i` of `first`, which was asked for `asked`.
/// Where the page made the call more than once, the answer nearest the first's is the one it is held against.
pub(super) fn told(first: &Trace, i: usize, asked: &[String], second: &Trace, other: &[String]) -> Told {
    let e = &first.exchanges[i];
    let Some(was) = answer_of(e) else { return Told::Unseen };
    fn words(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }
    let was = said_lines(&was, &words(asked));
    if was.len() < TOO_LITTLE_TO_TELL {
        return Told::Unseen;
    }
    let at = place(e, asked);
    let nearest = second
        .exchanges
        .iter()
        .filter(|o| (200..300).contains(&o.status) && place(o, other) == at)
        .filter_map(answer_of)
        .map(|v| said_lines(&v, &words(other)))
        .max_by_key(|now| was.intersection(now).count());
    match nearest {
        None => Told::Unseen,
        Some(now) if nothing_of_its_own(&was, &now) => Told::Deaf,
        Some(_) => Told::Hears,
    }
}

/// How many lines of what call `i` answered say back what the page was asked.
fn says_back(trace: &Trace, i: usize, asked: &[String]) -> usize {
    let Some(answer) = answer_of(&trace.exchanges[i]) else { return 0 };
    let lines = said_lines(&answer, &[]);
    // One character is a word in a script that writes words so (`傘`); one Latin letter is not.
    let a_word = |a: &&String| a.chars().count() >= 2 || a.chars().any(|c| !c.is_ascii() && c.is_alphabetic());
    asked.iter().filter(a_word).map(|a| a.to_lowercase()).map(|a| lines.iter().filter(|l| l.contains(&a)).count()).max().unwrap_or(0)
}

/// Whether two walks speak against call `i` of the first as an answer: the second walk made it too, and either it
/// answered the same for both values, or its answer changed and still says nothing of what its own page was asked
/// (a map beside the results changes with the city and names no hotel). A call the second walk never made is not
/// spoken against: the experiment says nothing of it.
pub(super) fn speaks_against(first: &Trace, i: usize, asked: &[String], second: &Trace, other: &[String]) -> bool {
    match told(first, i, asked, second, other) {
        Told::Deaf => true,
        Told::Hears => says_back(first, i, asked) < 2,
        Told::Unseen => false,
    }
}

/// The answer two walks of a page agree on: of the first walk's candidates (`candidates`, each with whether it is the
/// page itself), the one the second walk also made, whose answer changed with the value, and which says back what
/// its own page was asked on the most lines. One walk ranks calls by what they carry and how they are named; two
/// measure which one answers. A data call that says the value back at least half as often as the page does is
/// taken before the page: it is the same answer without the page around it. None when no candidate both hears and
/// says its value back on two lines or more: then two walks settled nothing, and the one walk's pick stands.
pub(super) fn answer_of_two(first: &Trace, candidates: &[(usize, bool)], asked: &[String], second: &Trace, other: &[String]) -> Option<usize> {
    let heard: Vec<(usize, bool, usize)> = candidates
        .iter()
        .filter(|(i, _)| told(first, *i, asked, second, other) == Told::Hears)
        .map(|(i, page)| (*i, *page, says_back(first, *i, asked)))
        .filter(|(_, _, lines)| *lines >= 2)
        .collect();
    let most = heard.iter().map(|(_, _, lines)| *lines).max()?;
    // Of the data calls that say it back at least half as often as the best does, one that only reads (a GET) before
    // one that sends a body: a goal that reads is answered by a call that reads, and a page often posts what it
    // showed to a call that records it.
    let reads = |i: usize| first.exchanges[i].method.eq_ignore_ascii_case("GET");
    let call = heard.iter().filter(|(_, page, lines)| !page && lines * 2 >= most).max_by_key(|(i, _, lines)| (reads(*i), *lines));
    call.or_else(|| heard.iter().max_by_key(|(_, _, lines)| *lines)).map(|(i, _, _)| *i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str, url: &str, body: &str) -> Exchange {
        Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: Some(true),
        }
    }

    fn records(word: &str) -> String {
        // What a search finds is other things for another word, not the same names with the word swapped.
        let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
        let rows: Vec<String> = (0..12).map(|n| format!(r#"{{"id":{n},"title":"{word} {} number {n}"}}"#, kinds[n % 4])).collect();
        format!(r#"{{"query":"{word}","results":[{}]}}"#, rows.join(","))
    }

    /// The search call answers each value with its own records; the recommendations strip carries the page's query
    /// like every call of the page and answers the same; a call the second walk never made says nothing.
    #[test]
    fn a_second_walk_says_which_calls_hear_the_caller() {
        let strip = r#"{"title":"You may also like","items":[{"name":"Garden chair"},{"name":"Desk fan"},{"name":"Wall clock"},{"name":"Door mat"},{"name":"Coat rack"}]}"#;
        let walk = |word: &str, extra: bool| Trace {
            exchanges: [
                Some(call("GET", &format!("https://shop.example/api/search?q={word}"), &records(word))),
                Some(call("GET", &format!("https://shop.example/api/strip?q={word}"), strip)),
                extra.then(|| call("GET", &format!("https://shop.example/api/once?q={word}"), &records(word))),
            ]
            .into_iter()
            .flatten()
            .collect(),
            inputs: Vec::new(),
        };
        let (first, second) = (walk("brass", true), walk("glass", false));
        let (a, b) = (vec!["brass".to_string()], vec!["glass".to_string()]);
        assert_eq!(told(&first, 0, &a, &second, &b), Told::Hears);
        assert_eq!(told(&first, 1, &a, &second, &b), Told::Deaf);
        assert_eq!(told(&first, 2, &a, &second, &b), Told::Unseen);
    }

    /// Two walks agree on the answer: the search call, which both made and which says each value back, is taken over
    /// the page that holds the same records around a shell, and over a strip that answers the same for both. A page
    /// that alone holds the records is the answer when no call does; and with nothing that hears, nothing is settled.
    #[test]
    fn two_walks_agree_on_the_call_that_answers() {
        let page = |word: &str, rows: usize| {
            let kinds = if word == "brass" { ["table lamp", "door knocker", "candle holder", "picture frame"] } else { ["mixing bowl", "storage jar", "flower vase", "water carafe"] };
            let body: String = (0..rows).map(|n| format!("<li><a href='/p/{word}{n}'>{word} {} number {n}</a></li>", kinds[n % 4])).collect();
            let mut e = call("GET", &format!("https://shop.example/s?q={word}"), &format!("<html><body><main><h1>Results</h1><ul>{body}</ul></main></body></html>"));
            e.response_mime = "text/html".into();
            e.resource_type = Some("Document".into());
            e
        };
        let strip = r#"{"title":"You may also like","items":[{"name":"Garden chair"},{"name":"Desk fan"},{"name":"Wall clock"},{"name":"Door mat"},{"name":"Coat rack"}]}"#;
        let walk = |word: &str, search: bool, rows: usize| Trace {
            exchanges: [Some(page(word, rows)), search.then(|| call("GET", &format!("https://shop.example/api/search?q={word}"), &records(word))), Some(call("GET", &format!("https://shop.example/api/strip?q={word}"), strip))].into_iter().flatten().collect(),
            inputs: Vec::new(),
        };
        let (a, b) = (vec!["brass".to_string()], vec!["glass".to_string()]);
        let with_call = [(0, true), (1, false), (2, false)];
        assert_eq!(answer_of_two(&walk("brass", true, 12), &with_call, &a, &walk("glass", true, 12), &b), Some(1), "the call, over the page around it");
        let page_only = [(0, true), (1, false)];
        assert_eq!(answer_of_two(&walk("brass", false, 12), &page_only, &a, &walk("glass", false, 12), &b), Some(0), "the page, when it alone holds the records");
        assert_eq!(answer_of_two(&walk("brass", false, 0), &page_only, &a, &walk("glass", false, 0), &b), None, "nothing hears: nothing is settled");
        // What the second walk speaks against: the strip that answers the same for both, never the search it bears
        // out, and never a call it did not make.
        let (one, two) = (walk("brass", true, 12), walk("glass", true, 12));
        assert!(speaks_against(&one, 2, &a, &two, &b) && !speaks_against(&one, 1, &a, &two, &b));
        assert!(!speaks_against(&one, 1, &a, &walk("glass", false, 12), &b), "a call the second walk never made is not spoken against");
        // A call that posts what the page showed says the value back as often as the search that read it: the read.
        let posted = |word: &str| {
            let mut t = walk(word, true, 12);
            let mut log = call("POST", "https://shop.example/api/seen/create", &records(word));
            log.request_body = Some(format!(r#"{{"shown":"{word}"}}"#));
            t.exchanges.push(log);
            t
        };
        assert_eq!(answer_of_two(&posted("brass"), &[(0, true), (1, false), (2, false), (3, false)], &a, &posted("glass"), &b), Some(1), "the call that reads, before the one that posts as much");
    }

    /// What two addresses were asked is what they differ by, wherever it sits: a query value, a piece of the path,
    /// a fragment written as a query. What they share (a guest count, a route word) was not varied.
    #[test]
    fn what_two_addresses_differ_by_is_what_was_asked() {
        assert_eq!(asked_apart("https://a.example/s?q=brass&adults=2", "https://a.example/s?q=glass&adults=2"), (vec!["brass".to_string()], vec!["glass".to_string()]));
        assert_eq!(asked_apart("https://a.example/search/iphone%2015/", "https://a.example/search/macbook%20air/"), (vec!["iphone 15".to_string()], vec!["macbook air".to_string()]));
        assert_eq!(asked_apart("https://a.example/find#q=brass", "https://a.example/find#q=glass").0, vec!["brass".to_string()]);
        assert_eq!(asked_apart("https://a.example/s?q=brass", "https://a.example/s?q=brass"), (vec![], vec![]));
    }

    /// The second walk's address asks a word nobody searches for wherever the first asked a word, and leaves the
    /// rest: a count, a flag, a route word the caller never gave.
    #[test]
    fn the_second_walk_asks_another_word_where_the_first_asked_one() {
        let asked = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(for_another_word("https://a.example/s?q=brass&adults=2&sort=new", &asked(&["brass", "2"]), "zqx").as_deref(), Some("https://a.example/s?q=zqx&adults=2&sort=new"));
        assert_eq!(for_another_word("https://a.example/search/iphone%2015/", &asked(&["iphone 15"]), "zqx").as_deref(), Some("https://a.example/search/zqx/"));
        assert_eq!(for_another_word("https://a.example/s?adults=2", &asked(&["2"]), "zqx"), None, "no word was asked");
        // The walk that exposed it: a fund site asked in its fragment, which got no second walk at all.
        assert_eq!(for_another_word("https://a.example/search#q=bonds&tab=all", &asked(&["bonds", "all"]), "zqx").as_deref(), Some("https://a.example/search#q=zqx&tab=zqx"));
        assert_eq!(for_another_word("https://a.example/docs#install", &asked(&["install"]), "zqx"), None, "a place on the page is not an ask");
        // The word inside the site's own marks is moved, and the marks stay; a piece that only resembles it is not.
        assert_eq!(for_another_word("https://a.example/search/chicken-", &asked(&["chicken"]), "pasta").as_deref(), Some("https://a.example/search/pasta-"));
        assert_eq!(for_another_word("https://a.example/search/chicken-", &asked(&["chicken"]), "beef stew").as_deref(), Some("https://a.example/search/beef%20stew-"));
        assert_eq!(for_another_word("https://a.example/search/chickens-", &asked(&["chicken"]), "pasta"), None);
    }

    /// The plan a body keeps writes the page for another word as the trial does: from the stored plan alone (its JSON
    /// read back), the lab's address is the one `for_another_word` gives for the same page and the same asked values,
    /// in the query, the path and the fragment, and none where the page was asked no word.
    #[test]
    fn the_page_a_stored_plan_writes_for_another_word_is_the_trials() {
        let cases: [(&str, &[(&str, &str)]); 5] = [
            ("https://a.example/s?q=brass&adults=2&sort=new", &[("q", "brass"), ("adults", "2")]),
            ("https://a.example/s?q=red+lamp", &[("q", "red lamp")]),
            ("https://a.example/search/iphone%2015/", &[("search", "iphone 15")]),
            ("https://a.example/search#q=bonds&tab=all", &[("q", "bonds"), ("tab", "all")]),
            ("https://a.example/s?adults=2", &[("adults", "2")]),
        ];
        for (url, asked) in cases {
            let named: Vec<(String, String)> = asked.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            let values: Vec<String> = named.iter().map(|(_, v)| v.clone()).collect();
            let plan = unbrowse_learn::lab::compile::plan_of(url, &[], "search", &named, &[], Vec::new()).unwrap();
            let stored: unbrowse_learn::route::Plan = serde_json::from_str(&serde_json::to_string(&plan).unwrap()).unwrap();
            for word in ["zqx", "green chair"] {
                assert_eq!(unbrowse_learn::lab::compile::page_for_another_word(&stored, word), for_another_word(url, &values, word), "{url} for {word:?}, from the plan {}", stored.page);
            }
        }
    }

    /// An answer that only says the ask back changes with the value and still has nothing of its own: the value is
    /// struck out before two answers are compared. And a call whose path carries the value is the same call.
    #[test]
    fn an_echo_is_deaf_and_a_value_in_the_path_is_the_same_call() {
        let echo = |word: &str| format!(r#"{{"query":"{word}","tracking":"search for {word} logged","shelf":"popular this week","hint":"try another word","note":"results may vary","zone":"header banner"}}"#);
        let first = Trace { exchanges: vec![call("POST", "https://shop.example/log?q=brass", &echo("brass")), call("GET", "https://shop.example/find/brass/list", &records("brass"))], inputs: Vec::new() };
        let second = Trace { exchanges: vec![call("POST", "https://shop.example/log?q=glass", &echo("glass")), call("GET", "https://shop.example/find/glass/list", &records("glass"))], inputs: Vec::new() };
        let (a, b) = (vec!["brass".to_string()], vec!["glass".to_string()]);
        assert_eq!(told(&first, 0, &a, &second, &b), Told::Deaf);
        assert_eq!(told(&first, 1, &a, &second, &b), Told::Hears);
    }
}
