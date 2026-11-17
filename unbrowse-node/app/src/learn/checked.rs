//! The node checks the route it learned by example (`docs/REBUILD.md`, phase 4), behind the switch
//! (`learns_by_example`): the site's four tests (`unbrowse_learn::lab::verify`), then the smallest request the site
//! accepts (`lab::shrink`), asked of the live site over the route's own transport and session, within a small budget.
//!
//! The body put to the site is the one a call runs: the stored body laid over the graph (`body::overlay`), or the
//! graph said as a body where none is stored. What shrinking leaves out is taken out of the graph
//! (`shrink::left_out_of`): the graph carries every pass, and a stored body beside it, which says only what a graph
//! cannot (and which shrinking never tries), is laid over the shrunk graph as over any other. So the route that stands
//! is the shrunk one where the site still answers the walk's value and a second value as itself, and the route as it
//! was otherwise.
//!
//! What the site said is kept on the route (`Route::checked`), never shared. No write is sent: a route that writes is
//! not checked at all, and neither is one that sends a secret (a learn does not open the vault to check).

use std::collections::HashMap;

use unbrowse_learn::lab::site::{Live, Said, Site};
use unbrowse_learn::lab::{shrink, verify};

use super::{spares, words_asked};
use crate::store::{self, Checked, Route};

/// Asks of the site one check of a learned route may spend, whatever the site says it has left: the four tests are
/// three calls of the route (the walk's value, a second, a nonsense one), each a call of every step, and each part
/// shrinking tries is two more (the walk's value and the second, with the part out). Twelve covers the tests and the
/// first four parts of a one-step route, and of a two-step one the tests, the step nothing reads, and one part after.
/// Where the second look heard no word said back, finding one spends from the same twelve: a call per word asked,
/// never so many that the four tests after it would not fit. A learn has already spent the second look's asks (`SECOND_LOOK_ASKS`), and the caller's share is kept
/// beside them (`spares`). What the budget does not reach is said as untried, and a later look may try it.
pub(super) const CHECK_ASKS: usize = 12;

/// The site, counting what it is asked: the four tests and shrinking spend one budget between them.
struct Counting<'a> {
    site: &'a mut dyn Site,
    asks: usize,
}
impl Site for Counting<'_> {
    fn ask(&mut self, step: &unbrowse_learn::route::Step, built: &unbrowse_learn::route::Built) -> Said {
        self.asks += 1;
        self.site.ask(step, built)
    }
}

/// What a check made of a route: the route as it stands after it, and the `[verify]` line that says why.
pub(super) struct Checking {
    pub route: Route,
    pub said: String,
}

/// `route`, checked by the live site over its own transport and session (`client::as_its_client`), the egress it is
/// held to (`share::egress`), and the walk's own identity where the session store keeps no browser's sample.
/// `offered` are the words the walk's page offers beside the one it was asked (`trial::offered_words`), in their
/// order: where the second look heard none said back, the check asks for them itself.
pub(super) fn checked_by_the_site(route: &Route, agent: Option<&str>, offered: &[String]) -> Checking {
    let egress = crate::share::egress(route);
    let (mut transport, jar) = match unbrowse_learn::client::as_its_client(&route.graph, &store::jars_dir(), egress, agent) {
        Ok(it) => it,
        Err(e) => return Checking { route: route.clone(), said: format!("[verify] by example: not checked, the route's transport would not build ({e})") },
    };
    let now = store::now() * 1000;
    let mut site = Live { fetch: &mut transport, left: CHECK_ASKS };
    checked_with(route, offered, &jar, now, &mut site)
}

/// [`checked_by_the_site`], over any `site`: what a test hands the learn, so no test asks a site.
pub(super) fn checked_with(route: &Route, offered: &[String], jar: &HashMap<String, String>, now: u64, site: &mut dyn Site) -> Checking {
    let unchanged = |said: String| Checking { route: route.clone(), said };
    // A write is learned from its walk and never sent to check; a secret is the vault's, which a learn does not open.
    if route.write || route.socket.is_some() || route.graph.steps.iter().any(unbrowse_learn::ledger::writes) {
        return unchanged("[verify] by example: not checked, the route writes, and a write is never sent to check".into());
    }
    if route.inputs.iter().any(|i| i.secret) {
        return unchanged("[verify] by example: not checked, the route sends a secret".into());
    }
    // Held, the route stands as walked and the site is asked nothing: the four tests are asked only to shrink by.
    if super::own_asks::held_at(super::own_asks::Ask::Shrink, "learn::checked::checked_with") {
        return unchanged("[verify] by example: not checked, shrinking is held (UNBROWSE_NO_SHRINK)".into());
    }
    // What the site says of its asks comes first: one that has few left is asked nothing.
    if !spares(route, CHECK_ASKS as u64) {
        return unchanged("[verify] by example: not checked, the site says it has few asks left".into());
    }
    // The body a call runs.
    let body = unbrowse_learn::body::overlay(&route.graph, route.body.as_ref()).body;
    let walked: HashMap<String, String> = route.inputs.iter().filter_map(|i| Some((i.name.clone(), i.default.clone()?))).collect();
    // The second value: the word the route already said back for this page (`Route::heard`), in each word the page
    // was asked. Where the second look heard none, the words the page offers, asked in turn by the trial's own reader
    // (`trial::says_back`) until one is said back, while the budget still holds the four tests after it.
    let asked: Vec<String> = walked.values().cloned().collect();
    // A slot whose kind the body says (a date, a listed word) is the one a second value of that kind goes in, and the
    // answer is read for it in any form the route writes it (`meaning::says_back`): the trial's reader holds words.
    let kinded = unbrowse_learn::lab::meaning::kind_slots(&body).into_iter().map(|(name, _)| name).find(|name| walked.contains_key(name));
    let in_the_words = |word: &str| -> Option<HashMap<String, String>> {
        if let Some(slot) = &kinded {
            let mut second = walked.clone();
            second.insert(slot.clone(), word.to_string());
            return Some(second);
        }
        let words = words_asked(route, &asked);
        (!words.is_empty()).then(|| {
            let mut second = walked.clone();
            for i in words {
                second.insert(i.name.clone(), word.to_string());
            }
            second
        })
    };
    let mut counting = Counting { site, asks: 0 };
    let mut asked_for: Vec<String> = Vec::new();
    let second: Option<HashMap<String, String>> = match &route.heard.said_back {
        Some(word) => in_the_words(word),
        None => {
            let steps = body.steps.len().max(1);
            let mut found = None;
            for word in offered {
                if counting.asks + steps + 3 * steps > CHECK_ASKS {
                    break;
                }
                asked_for.push(word.clone());
                if let (Some(slot), Some(inputs)) = (&kinded, in_the_words(word)) {
                    let answer = unbrowse_learn::lab::call::call(&body, &inputs, jar, now, &mut counting).ok().and_then(|c| unbrowse_learn::lab::answer::answer_of(&c.answer));
                    if answer.is_some_and(|a| unbrowse_learn::lab::meaning::says_back(&body, slot, word, &a)) {
                        found = Some(inputs);
                        break;
                    }
                    continue;
                }
                let mut answers = |_: &unbrowse_learn::Graph, inputs: &HashMap<String, String>| {
                    unbrowse_learn::lab::call::call(&body, inputs, jar, now, &mut counting).ok().and_then(|c| unbrowse_learn::lab::answer::answer_of(&c.answer))
                };
                if super::trial::says_back(route, &asked, word, &mut answers) == Some(true) {
                    found = in_the_words(word);
                    break;
                }
            }
            found
        }
    };
    let verdict = verify::verify(&body, &walked, second.as_ref(), jar, now, &mut counting);
    let held = |test: verify::Test| verdict.checks.iter().any(|(t, o)| *t == test && o.held());
    let mut checked = Checked { at: store::now(), tests: verdict.lines(), ..Checked::default() };
    // Where no second value was found, the verdict names the words tried, or that the page offered none.
    if second.is_none() {
        let why = if asked_for.is_empty() {
            "the second look heard no word said back, and the page offers no other word".to_string()
        } else {
            format!("no word the page offers was said back: tried {}", asked_for.iter().map(|w| format!("{w:?}")).collect::<Vec<_>>().join(", "))
        };
        for line in checked.tests.iter_mut().filter(|l| l.starts_with(verify::Test::SecondValue.name())) {
            *line = format!("{}: could not ask ({why})", verify::Test::SecondValue.name());
        }
    }
    let mut named: Vec<String> = Vec::new();
    // Shrinking only where both readings it is held to held: the walk's value and a second value as itself.
    let mut graph = route.graph.clone();
    let mut tried = 0usize;
    if held(verify::Test::WalksOwnValue) && held(verify::Test::SecondValue) {
        // Shrinking gets what the tests left of the budget, from the body they just found answering both; its asks go
        // through the same counter.
        let budget = CHECK_ASKS.saturating_sub(counting.asks);
        let shrunk = shrink::shrink_from(&body, &walked, second.as_ref(), jar, now, budget, &mut counting);
        tried = shrunk.tried.iter().filter(|(_, fate)| *fate != shrink::Fate::NotTried).count();
        for (part, fate) in &shrunk.tried {
            match fate {
                shrink::Fate::LeftOut => {
                    checked.left_out.push(part.say());
                    named.push(part.short());
                }
                shrink::Fate::Kept => checked.kept.push(part.say()),
                shrink::Fate::NotTried => checked.untried.push(part.say()),
            }
        }
        graph = shrink::left_out_of(&route.graph, &shrunk.tried);
        super::own_asks::say_left_out(&route.graph, &graph);
    }
    checked.asks = counting.asks;
    let tests = if verdict.checks.iter().all(|(_, o)| o.held()) {
        "the four tests held".to_string()
    } else {
        verdict.checks.iter().filter(|(_, o)| !o.held()).map(|(t, o)| format!("{}: {}", t.name(), o.word())).collect::<Vec<_>>().join("; ")
    };
    let shrunk = if tried == 0 {
        format!("nothing shrunk{}", if checked.untried.is_empty() { String::new() } else { format!(" ({} parts the asks did not reach)", checked.untried.len()) })
    } else {
        format!("{} of {tried} tried left out{}", checked.left_out.len(), if named.is_empty() { String::new() } else { format!(" ({})", named.join(", ")) })
    };
    let said = format!("[verify] by example: {tests}, {shrunk}, {} asks", checked.asks);
    let mut route = route.clone();
    route.steps = graph.steps.len();
    route.graph = graph;
    route.checked = Some(checked);
    Checking { route, said }
}

#[cfg(test)]
mod tests {
    use super::*;
    use unbrowse_learn::trace::{Exchange, Trace};

    fn walked(method: &str, url: &str, headers: &[(&str, &str)], body: &str, doc: bool) -> Exchange {
        Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        }
    }

    fn records(word: &str) -> String {
        let names: [&str; 6] = match word {
            "lamp" => ["desk reading light 60w", "brass bedside glow", "floor standing arc", "clip on task bright", "vintage edison bulb", "dimmable ring halo"],
            _ => ["three seat couch grey", "foldaway bed settee", "chesterfield leather tan", "corner lounge modular", "two seat loveseat navy", "recliner powered cream"],
        };
        format!(r#"{{"results":[{}]}}"#, names.iter().map(|n| format!(r#"{{"name":"{n}"}}"#)).collect::<Vec<_>>().join(","))
    }

    /// Two walks of a shop at `host`: the page, then the calls `calls` makes for the word, the search last.
    fn learned(host: &str, calls: &dyn Fn(&str) -> Vec<Exchange>) -> Route {
        learned_from(host, calls).0
    }

    /// [`learned`], with the first walk beside the route: what the page offered is read from it.
    fn learned_from(host: &str, calls: &dyn Fn(&str) -> Vec<Exchange>) -> (Route, Trace) {
        let walk = |word: &str| {
            let root = format!("https://{host}/search?q={word}");
            let mut exchanges = vec![walked("GET", &root, &[], "<html><body>a shop</body></html>", true)];
            exchanges.extend(calls(word));
            let inputs = super::super::walk_inputs(&root, &[], &exchanges);
            Trace { exchanges, inputs }
        };
        let (first, second) = (walk("lamp"), walk("sofa"));
        let at = first.exchanges.len() - 1;
        let mut route = super::super::route_of_by(&first, at, "search the shop", &format!("https://{host}/search?q=lamp"), true, &[], &[(second, Vec::new())], None, true).unwrap();
        // The second look's trial said the route answers its second word back.
        route.heard.said_back = Some("sofa".into());
        (route, first)
    }

    /// Records for a word: `lamp`'s include two longer wordings a page would offer (`lamp shade linen`, `lamp post
    /// black`); `lamp post black` has records that say it; any other word its own.
    fn offering(word: &str) -> String {
        let names: Vec<String> = match word {
            "lamp" => ["lamp shade linen", "lamp post black", "desk reading light", "brass bedside glow", "floor standing arc", "clip on task bright"].iter().map(|n| n.to_string()).collect(),
            "lamp post black" => (0..6).map(|n| format!("lamp post black model {n}")).collect(),
            "lamp shade linen" => ["shade one", "shade two", "shade three", "shade four", "shade five", "shade six"].iter().map(|n| format!("woven {n}")).collect(),
            other => return records(other),
        };
        format!(r#"{{"results":[{}]}}"#, names.iter().map(|n| format!(r#"{{"name":"{n}"}}"#)).collect::<Vec<_>>().join(","))
    }

    /// A shop that keeps what it is asked: the search answers each word its own records and a nonsense word an empty
    /// list, if `needs` holds of the request; a 403 otherwise. Any other call answers `{}`.
    struct Shop<F: Fn(&unbrowse_learn::route::Built) -> bool> {
        needs: F,
        asked: Vec<String>,
    }
    impl<F: Fn(&unbrowse_learn::route::Built) -> bool> Site for Shop<F> {
        fn ask(&mut self, _step: &unbrowse_learn::route::Step, built: &unbrowse_learn::route::Built) -> Said {
            self.asked.push(built.url.path().to_string());
            let answer = |status: u16, body: String| Said::Reply { at: None, reply: Exchange { status, ..walked("GET", built.url.as_str(), &[], &body, false) } };
            if built.url.path() != "/api/search" {
                return answer(200, r#"{"token":"tok_9f8e7d6c5b4a3210"}"#.into());
            }
            if !(self.needs)(built) {
                return answer(403, r#"{"error":"forbidden"}"#.into());
            }
            let word = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
            answer(200, if word.chars().any(|c| "aeiou".contains(c)) { records(&word) } else { r#"{"results":[]}"#.into() })
        }
    }

    /// A shop whose search answers each word with `answer` of it, and keeps what it is asked.
    struct Offers<F: Fn(&str) -> String> {
        answer: F,
        asked: Vec<String>,
    }
    impl<F: Fn(&str) -> String> Site for Offers<F> {
        fn ask(&mut self, _step: &unbrowse_learn::route::Step, built: &unbrowse_learn::route::Built) -> Said {
            let word = built.url.query_pairs().find(|(k, _)| k == "q").map(|(_, v)| v.into_owned()).unwrap_or_default();
            self.asked.push(word.clone());
            let body = if word.chars().any(|c| "aeiou".contains(c)) { (self.answer)(&word) } else { r#"{"results":[]}"#.to_string() };
            Said::Reply { at: None, reply: walked("GET", built.url.as_str(), &[], &body, false) }
        }
    }

    fn header(built: &unbrowse_learn::route::Built, name: &str) -> Option<String> {
        built.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone())
    }

    /// Where the second look heard no word said back, the check asks the words the page offers itself, in the order
    /// the trial's reader gives them: the first is not said back, the next is, and that word is the second value the
    /// four tests and shrinking are held to. Shrinking then runs, and leaves out the header the site does not read.
    #[test]
    fn the_check_finds_a_second_word_the_page_offers_when_the_trial_heard_none() {
        let _old = crate::learn::own_asks::as_the_old_node();
        store::scratch_home("checked-finds-a-word");
        let (mut route, first) = learned_from("offers.shop.example", &|word| vec![walked("GET", &format!("https://offers.shop.example/api/search?q={word}"), &[("x-client", "web")], &offering(word), false)]);
        route.heard.said_back = None;
        let asked = ["lamp".to_string()];
        let offered = super::super::trial::offered_words(&first, "https://offers.shop.example/search?q=lamp", &asked);
        assert_eq!(offered, ["lamp shade linen", "lamp post black"], "the page offers both, the first first");
        let mut site = Offers { answer: offering, asked: Vec::new() };
        let checking = checked_with(&route, &offered, &HashMap::new(), 1, &mut site);
        assert_eq!(&site.asked[..2], ["lamp shade linen", "lamp post black"], "asked in turn until one is said back: {:?}", site.asked);
        let checked = checking.route.checked.clone().expect("what the site said is kept");
        assert!(checked.tests.iter().any(|t| t.starts_with("a second value answers as itself: held")), "{:?}", checked.tests);
        assert!(checked.left_out.iter().any(|p| p.contains("x-client")), "shrinking ran: {checked:?}");
        assert!(checking.said.contains("the four tests held") && checked.asks <= CHECK_ASKS, "{}", checking.said);
    }

    /// Where no word the page offers is said back, the second-value test could not be asked, and the verdict names the
    /// words tried; nothing is shrunk.
    #[test]
    fn the_check_names_the_words_it_tried_when_none_is_said_back() {
        let _old = crate::learn::own_asks::as_the_old_node();
        store::scratch_home("checked-names-words");
        let (mut route, first) = learned_from("deaf.shop.example", &|word| vec![walked("GET", &format!("https://deaf.shop.example/api/search?q={word}"), &[], &offering(word), false)]);
        route.heard.said_back = None;
        let offered = super::super::trial::offered_words(&first, "https://deaf.shop.example/search?q=lamp", &["lamp".to_string()]);
        // Every word answered with the walk's own records: none of them says the word asked back.
        let mut site = Offers { answer: |_: &str| offering("lamp"), asked: Vec::new() };
        let checking = checked_with(&route, &offered, &HashMap::new(), 1, &mut site);
        let checked = checking.route.checked.clone().expect("what the site said is kept");
        let second = checked.tests.iter().find(|t| t.starts_with("a second value answers as itself")).expect("the test is said");
        assert!(second.contains("could not ask") && second.contains(r#""lamp shade linen""#) && second.contains(r#""lamp post black""#), "{second}");
        assert!(checked.left_out.is_empty() && checked.kept.is_empty(), "nothing is shrunk: {checked:?}");
    }

    /// A learned route whose token step nothing reads any more (a pass moved the token it handed over to the jar) comes
    /// out without it: the site answers the walk's word and a second word as themselves with it gone.
    #[test]
    fn a_learned_route_whose_token_step_nothing_reads_comes_out_without_it() {
        let _old = crate::learn::own_asks::as_the_old_node();
        store::scratch_home("checked-token-step");
        // The token differs on each walk, and each walk's search sends its own: the search reads it from the token step.
        let token = |word: &str| if word == "lamp" { "tok_9f8e7d6c5b4a3210" } else { "tok_1a2b3c4d5e6f7a8b" };
        let mut route = learned("token.shop.example", &|word| {
            vec![walked("GET", "https://token.shop.example/api/token", &[], &format!(r#"{{"token":"{}"}}"#, token(word)), false), walked("GET", &format!("https://token.shop.example/api/search?q={word}"), &[("x-token", token(word))], &records(word), false)]
        });
        assert_eq!(route.graph.steps.len(), 2, "the token step is in the chain as learned");
        // The pass that keeps a handed-over value in the jar: the search names it, and nothing reads the token step.
        let search = route.graph.steps.last_mut().unwrap();
        for f in search.fields.iter_mut().filter(|f| f.loc == unbrowse_learn::Loc::Header("x-token".into())) {
            f.class = unbrowse_learn::Class::Minted { name: "x-token".into() };
        }
        let jar = HashMap::from([("x-token".to_string(), "tok_9f8e7d6c5b4a3210".to_string())]);
        let mut site = Shop { needs: |_: &unbrowse_learn::route::Built| true, asked: Vec::new() };
        let checking = checked_with(&route, &[], &jar, 1, &mut site);
        assert_eq!(checking.route.graph.steps.len(), 1, "{}", checking.said);
        assert!(checking.route.graph.steps[0].url.contains("/api/search"));
        let checked = checking.route.checked.expect("what the site said is kept");
        assert!(checked.left_out.iter().any(|p| p.contains("whose reply nothing reads")), "{checked:?}");
        assert!(checked.asks <= CHECK_ASKS, "{} of {CHECK_ASKS}", checked.asks);
        assert!(checking.said.starts_with("[verify] by example: the four tests held, 1 of 1 tried left out (a step nothing reads (x"), "{}", checking.said);
    }

    /// A part the site needs stays: with the fixed header it reads left out, the site refuses, so the header is kept,
    /// and the route stands as it was. (A short value: a longer one nothing explains is read as one the session keeps,
    /// as the classifier reads it, and comes from the jar.)
    #[test]
    fn a_part_the_site_refuses_without_is_kept() {
        let _old = crate::learn::own_asks::as_the_old_node();
        store::scratch_home("checked-kept");
        let route = learned("kept.shop.example", &|word| vec![walked("GET", &format!("https://kept.shop.example/api/search?q={word}"), &[("x-app", "web")], &records(word), false)]);
        let mut site = Shop { needs: |built: &unbrowse_learn::route::Built| header(built, "x-app").as_deref() == Some("web"), asked: Vec::new() };
        let checking = checked_with(&route, &[], &HashMap::new(), 1, &mut site);
        let checked = checking.route.checked.clone().expect("what the site said is kept");
        assert!(checked.kept.iter().any(|p| p.contains("x-app")), "{checked:?}");
        assert!(checked.left_out.is_empty(), "{checked:?}");
        assert_eq!(serde_json::to_string(&checking.route.graph).unwrap(), serde_json::to_string(&route.graph).unwrap(), "the route stands as it was");
    }

    /// A site that says it has few asks left is asked nothing: the check is not made.
    #[test]
    fn a_site_that_says_it_has_few_asks_left_is_asked_nothing() {
        let _old = crate::learn::own_asks::as_the_old_node();
        store::scratch_home("checked-few-asks");
        let route = learned("few.shop.example", &|word| vec![walked("GET", &format!("https://few.shop.example/api/search?q={word}"), &[], &records(word), false)]);
        let mut said = walked("GET", "https://few.shop.example/api/search", &[], "{}", false);
        said.response_headers = vec![("x-ratelimit-remaining".into(), "3".into())];
        unbrowse_learn::budget::note(&said);
        let mut site = Shop { needs: |_: &unbrowse_learn::route::Built| true, asked: Vec::new() };
        let checking = checked_with(&route, &[], &HashMap::new(), 1, &mut site);
        assert!(site.asked.is_empty(), "asked {:?}", site.asked);
        assert!(checking.said.contains("few asks left") && checking.route.checked.is_none(), "{}", checking.said);
    }

    /// A route that writes is not checked at all: nothing is sent, and nothing is said of it on the route.
    #[test]
    fn a_route_with_a_write_is_not_tested_at_all() {
        store::scratch_home("checked-writes");
        let mut route = learned("writes.shop.example", &|word| vec![walked("GET", &format!("https://writes.shop.example/api/search?q={word}"), &[], &records(word), false)]);
        route.write = true;
        let mut site = Shop { needs: |_: &unbrowse_learn::route::Built| true, asked: Vec::new() };
        let checking = checked_with(&route, &[], &HashMap::new(), 1, &mut site);
        assert!(site.asked.is_empty(), "asked {:?}", site.asked);
        assert!(checking.said.contains("writes") && checking.route.checked.is_none(), "{}", checking.said);
    }
}
