//! A route is kept on the site's word, for two values, not on one page load's.
//!
//! A walk shows what one page sent for one value. That is a proposal about the site, not the site's capability: a
//! page may show a special view for the word it was asked and never send the call that answers every word. So the
//! learner asks the site. It takes another word from the page itself, calls the kept route with it over plain HTTP,
//! and reads whether the answer says that word back. A route that does not answer it gives way to the call the page
//! makes for that word, when the site answers that call for this page's word too. Generation proposes (the word, the
//! other call); the engine applies; the site verifies. Reads only, at learn time, never in the call path.

use super::*;

/// The words of a value as a search reads them: its runs of letters and digits, in small letters. A symbol, an
/// emoji, a mark a name is decorated with, is no word.
fn words_in(value: &str) -> Vec<String> {
    value.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect()
}

/// The words the page offers where it was asked `asked`, read from the walk, in the order a trial asks them. First,
/// the page's own links to itself with another value in the asked one's place (related searches, a "did you mean"),
/// the one it links to most first: the address is the site's own, so the word is one it answers. Then each longer
/// wording of the asked word that an answer in the walk offers (a suggestion, a completion), as the answers list them.
/// Last, the words the answer's own records share beside the asked one (`lab::answer::shared_words`), the most-shared
/// first: a person types a word, and a site says back a word its records share, where a whole record's title is said
/// back by that record alone. Each word once.
///
/// A word is another value only if it holds a word of its own: read as its words, one the asked value does not
/// hold. A name the asked word is decorated with (`Linux ✅` beside `linux`, an account's display name; `Linux
/// :linux:`) reads as the asked word again: a search for it is a search for the first, so its answer can tell
/// nothing apart, and no person would type it to search for something else.
pub(super) fn offered_words(trace: &Trace, url: &str, asked: &[String]) -> Vec<String> {
    let mut out = offered_without_records(trace, url, asked);
    for word in unbrowse_learn::lab::answer::shared_words(trace, url, asked) {
        if !out.iter().any(|w| w.eq_ignore_ascii_case(&word)) {
            out.push(word);
        }
    }
    out
}

/// [`offered_words`]' first two sources: the page's own links and the answers' longer wordings, without the words the
/// records share.
pub(super) fn offered_without_records(trace: &Trace, url: &str, asked: &[String]) -> Vec<String> {
    let Ok(page) = url::Url::parse(url) else { return Vec::new() };
    let had: Vec<String> = asked.iter().flat_map(|a| words_in(a)).collect();
    let of_its_own = |w: &str| words_in(w).iter().any(|word| !had.contains(word));
    let a_word = |w: &str| (2..=40).contains(&w.chars().count()) && w.chars().any(char::is_alphabetic) && !unbrowse_learn::slots::is_flag(w) && !w.contains(['/', '<', '>', '{', '"']) && of_its_own(w);
    let other_than = |w: &str| !asked.iter().any(|a| a.eq_ignore_ascii_case(w));
    // Links, counted: the word the page links to most is the one it offers first.
    let mut linked: Vec<(String, usize)> = Vec::new();
    for doc in trace.exchanges.iter().filter(|e| e.is_main_document() && (200..300).contains(&e.status)) {
        let Some(body) = doc.response_body.as_deref() else { continue };
        for piece in body.split("href=\"").skip(1) {
            let Some(href) = piece.split('"').next().filter(|h| h.len() < 400) else { continue };
            let Ok(there) = page.join(&href.replace("&amp;", "&")) else { continue };
            let (was, now) = experiment::asked_apart(url, there.as_str());
            let ([was], [now]) = (&was[..], &now[..]) else { continue };
            if asked.iter().any(|a| a.eq_ignore_ascii_case(was)) && a_word(now) && other_than(now) {
                match linked.iter_mut().find(|(w, _)| w.eq_ignore_ascii_case(now)) {
                    Some(seen) => seen.1 += 1,
                    None => linked.push((now.clone(), 1)),
                }
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    if let Some((first, _)) = linked.iter().filter(|(w, _)| told_to_a_proposer(trace, w)).max_by_key(|(_, n)| *n) {
        out.push(first.clone());
    }
    let mut rest: Vec<&(String, usize)> = linked.iter().filter(|(w, _)| !out.contains(w) && told_to_a_proposer(trace, w)).collect();
    rest.sort_by_key(|a| std::cmp::Reverse(a.1));
    out.extend(rest.into_iter().map(|(w, _)| w.clone()));
    // A wording an answer offers beside the asked one: a longer one (`lamp shade` beside `lamp`), or one that opens
    // with the same word and goes on otherwise (`iphone 16` beside `iphone 15`). What a site offers beside a search
    // is a search it answers.
    let longer = |leaf: &str| {
        let leaf = leaf.to_lowercase();
        asked.iter().map(|a| a.to_lowercase()).any(|a| {
            let opens = a.split_whitespace().next().filter(|w| w.chars().count() >= 3 && a.contains(' '));
            a.chars().count() >= 2 && (leaf.starts_with(&format!("{a} ")) || opens.is_some_and(|w| leaf.starts_with(&format!("{w} "))))
        })
    };
    let wordings = trace
        .exchanges
        .iter()
        .filter(|e| !e.is_main_document())
        .filter_map(|e| e.own_json())
        .flat_map(|v| unbrowse_learn::slots::json_leaves(&v).into_iter().map(|(_, leaf)| leaf).collect::<Vec<_>>())
        .filter(|leaf| a_word(leaf) && longer(leaf) && told_to_a_proposer(trace, leaf));
    for leaf in wordings {
        if !out.iter().any(|w| w.eq_ignore_ascii_case(&leaf)) {
            out.push(leaf);
        }
    }
    out
}

/// Whether a word the site offers may be told to a proposer: not when it carries what the session holds, or is
/// written as a key. A site's answer is its own to write, and what it writes there is not thereby a word.
fn told_to_a_proposer(trace: &Trace, word: &str) -> bool {
    let held = unbrowse_learn::provenance::session_values(trace);
    !sitegraph::of_the_session(word, &held) && !word.split_whitespace().any(sitegraph::reads_as_a_key)
}

/// Another word the page offers where it was asked `asked`: the first of [`offered_words`]. None when the walk offers
/// none.
pub(super) fn another_word(trace: &Trace, url: &str, asked: &[String]) -> Option<String> {
    offered_words(trace, url, asked).into_iter().find(|w| told_to_a_proposer(trace, w))
}

/// What a proposer is asked for a second word: a search a person would plainly make on this site that has nothing to
/// do with the first, so the page it leads to is the site's ordinary one and not a view made for the first word.
const SECOND_WORD: &str = "A page of a website was asked for one value (asked), for the goal given. Propose one other value a person would plainly put in the same place on this same site, and that this site certainly has many results for: for a place, another well-known place; for a product, a common product of an unrelated category; for a topic, another common topic. It must not be a variant, a model or a sibling of the first, so the site's ordinary answer is seen and not a view special to the first. Where the page was asked more than one value, also say which one of them is what a person searched for, the value your word goes in place of (in_place_of, exactly as given in asked): a page's address also holds words that only name the page (search, results, a section, a language), and those stay. And say what a caller should call that value (called): one plain lower-case word for what it is, such as query, city, destination, product or topic. Answer with JSON only: {\"second_word\": \"...\", \"in_place_of\": \"...\", \"called\": \"...\"}. One to three plain words for second_word, in the language of the first.";

/// A second word from the proposer the owner configured (`UNBROWSE_PROPOSE_PROGRAM`: a command that reads the ask as
/// JSON on stdin and answers JSON), when there is one. It is told the goal, the page, what the page was asked and
/// the words the site itself offers; it is told nothing the session holds. Generation proposes: the word is only
/// ever used to ask the site, and what the site answers decides.
pub(super) fn proposed_word(url: &str, goal: &str, asked: &[String], offered: &[String], held: &[String]) -> Option<String> {
    proposed_word_and_place(url, goal, asked, offered, held).map(|(word, _, _)| word)
}

/// `proposed_word`, and with it the one asked value the proposer says a person searched for, when it names one of
/// those the page was asked: a judgement about meaning, which the walk for that word then bears out or does not
/// (`asked_the_same_page`). And what it says a caller should call that value, when it is a plain name.
pub(super) fn proposed_word_and_place(url: &str, goal: &str, asked: &[String], offered: &[String], held: &[String]) -> Option<(String, Option<String>, Option<String>)> {
    let command = proposer()?;
    let page = page_told(url, asked, held)?;
    let ask = serde_json::json!({ "ask": "second_word", "instruction": SECOND_WORD, "goal": goal, "page": page, "asked": asked, "the_site_offers": offered });
    let said = unbrowse_learn::generated::run_agent(&command, &ask.to_string())?;
    let word = word_in(&said)?;
    let fits = (2..=40).contains(&word.chars().count()) && word.chars().any(char::is_alphabetic) && !asked.iter().any(|a| a.eq_ignore_ascii_case(&word));
    let place = place_in(&said, asked);
    eprintln!("   [trial] the proposer offers \"{word}\"{}{}", place.as_ref().map(|p| format!(" in place of \"{p}\"")).unwrap_or_default(), if fits { "" } else { ": not a word to ask" });
    let called = place.as_ref().and_then(|_| called_in(&said));
    fits.then_some((word, place, called))
}

/// What a proposer's answer says the searched value is called (`called`), when it reads as a name an input can
/// take: lower-case letters, digits and underscores, two to twenty-four of them, opening with a letter.
fn called_in(said: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(said.get(said.find('{')?..=said.rfind('}')?)?).ok()?;
    let name = v.get("called").and_then(|w| w.as_str())?.trim().to_lowercase().replace([' ', '-'], "_");
    let fits = (2..=24).contains(&name.len()) && name.starts_with(|c: char| c.is_ascii_lowercase()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    fits.then_some(name)
}

/// The asked value a proposer's answer names as the searched one (`in_place_of`), when it is one of `asked`.
fn place_in(said: &str, asked: &[String]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(said.get(said.find('{')?..=said.rfind('}')?)?).ok()?;
    let named = v.get("in_place_of").and_then(|w| w.as_str())?.trim();
    asked.iter().find(|a| a.eq_ignore_ascii_case(named)).cloned()
}

/// The asked values to move for a second word, in the order to try them. First the one a proposer named, when it
/// named one. Then all of them, as one walk reads them. Last, where the address was asked words both in its query
/// and in its path, the query's alone: a query's value is asked of a page, and a path's pieces may only name it.
/// Each is a proposal; the walk decides (`asked_the_same_page`).
pub(super) fn places_to_move(url: &str, asked: &[String], named: Option<&String>) -> Vec<Vec<String>> {
    let in_query: Vec<String> = url::Url::parse(url).map(|u| unbrowse_learn::trace::asked_pairs(&u).into_iter().map(|(_, v)| v).filter(|v| asked.contains(v)).collect()).unwrap_or_default();
    let mut tries: Vec<Vec<String>> = Vec::new();
    for values in [named.map(|n| vec![n.clone()]).unwrap_or_default(), asked.to_vec(), if in_query.len() < asked.len() { in_query } else { Vec::new() }] {
        if !values.is_empty() && !tries.contains(&values) {
            tries.push(values);
        }
    }
    tries
}

/// Whether a walk for `word` asked the same page as `first`, which was asked `moved` where `word` now sits: it made
/// the call of the first that sent a moved value as a value of its own and answered with the most, at the same
/// address, sending the word that way too. A value of its own is a whole value of the query or the body, a field of a JSON one of them
/// carries, or a piece of the path. A word that only sits inside something longer (the page's own address, sent
/// along by every call of every page) is not one. A walk that made none of those calls landed somewhere else (a
/// word written over a piece that names the page), and what it sent says nothing of the first. Where no call of
/// the first sent a moved value as its own there is nothing to hold it to, and it stands.
pub(super) fn asked_the_same_page(first: &Trace, second: &Trace, moved: &[String], word: &str) -> bool {
    let plain = |s: &str| percent_encoding::percent_decode_str(s).decode_utf8_lossy().replace('+', " ").to_lowercase();
    let is = |piece: &str, value: &str| piece.eq_ignore_ascii_case(value) || piece.trim_matches(|c: char| !c.is_alphanumeric()).eq_ignore_ascii_case(value);
    let pieces = |e: &Exchange| -> Vec<String> { e.url.path_segments().map(|s| s.map(plain).collect()).unwrap_or_default() };
    // Whether the call sends `value` as a value of its own.
    let sends = |e: &Exchange, value: &str| {
        value.chars().count() >= 2
            && (pieces(e).iter().any(|p| is(p, value))
                || unbrowse_learn::slots::slots(e).iter().any(|s| !matches!(s.loc, unbrowse_learn::Loc::Header(_) | unbrowse_learn::Loc::Cookie(_) | unbrowse_learn::Loc::Path(_)) && holds_as_a_value(&s.value, value)))
    };
    let a_call = |e: &Exchange| !e.is_main_document() && (200..300).contains(&e.status);
    // Of the first's calls that sent a moved value, the one that answered with the most: a box that completes what
    // is typed asks for the word on any page that shows it, and the page's answer is the heavier call.
    let Some(heaviest) = (0..first.exchanges.len()).filter(|&i| a_call(&first.exchanges[i]) && moved.iter().any(|m| sends(&first.exchanges[i], m))).max_by_key(|&i| first.exchanges[i].response_body.as_deref().map_or(0, str::len)) else { return true };
    // The same call on the second walk, by the one reader for that (`graph::the_same_call_there`), sending the word.
    unbrowse_learn::graph::the_same_call_there(first, heaviest, second, moved, Some(word)).is_some_and(|j| a_call(&second.exchanges[j]) && sends(&second.exchanges[j], word))
}

/// The page as a proposer is told it: its site and path, each piece of the path the session holds, or written as a
/// key, named and not shown. What the page was asked is the caller's and is shown.
fn page_told(url: &str, asked: &[String], held: &[String]) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let is_asked = |piece: &str| asked.iter().any(|a| a.eq_ignore_ascii_case(&percent_encoding::percent_decode_str(piece).decode_utf8_lossy()));
    Some(format!("{}{}", u.host_str().unwrap_or_default(), sitegraph::path_shown(u.path(), |p| !is_asked(p) && (sitegraph::of_the_session(p, held) || sitegraph::reads_as_a_key(p)))))
}

/// The word in a proposer's answer: `{"second_word": "..."}`, wherever it sits in what it wrote.
fn word_in(said: &str) -> Option<String> {
    let from = said.find('{')?;
    let to = said.rfind('}')?;
    let v: serde_json::Value = serde_json::from_str(said.get(from..=to)?).ok()?;
    v.get("second_word").and_then(|w| w.as_str()).map(|w| w.trim().to_string()).filter(|w| !w.is_empty())
}

/// Of the pieces of a page's path taken for the caller's values (`in_path`: name and value), those the site says are
/// its address. One walk cannot tell `/search/lamps/` from `/lamps/search/`: a page hands both words on to its calls.
/// The site can: the page is asked for with one piece at a time replaced by a word nobody searches for, and a piece
/// whose replacement is no page at all (404, 410) while another's still is one is part of the address, not a value.
/// A lone piece is told from a word the page was asked in its query (`asked_in_query`): `/search/?q=lamps` is still
/// a page for another `q`, and no page at all without `search`. With nothing to tell a piece from, or when every
/// replacement is gone or none is, nothing is concluded. `status_of` is the site's status for an address, None when
/// it did not answer.
pub(super) fn of_the_address(url: &str, in_path: &[(String, String)], asked_in_query: &[String], status_of: &mut impl FnMut(&str) -> Option<u16>) -> Vec<String> {
    if in_path.is_empty() || in_path.len() + asked_in_query.len().min(1) < 2 {
        return Vec::new();
    }
    // Held, nothing is concluded: every piece stays the caller's.
    if own_asks::held_at(own_asks::Ask::Nonsense, "learn::trial::of_the_address") {
        return Vec::new();
    }
    let mut gone_at = |value: &String| experiment::for_another_word(url, std::slice::from_ref(value), NOBODYS_WORD).and_then(|other| status_of(&other)).map(|status| matches!(status, 404 | 410));
    let gone: Vec<(String, Option<bool>)> = in_path.iter().map(|(_, value)| (value.clone(), gone_at(value))).collect();
    // The page for another value in its query, asked only when the path's own pieces do not already show one staying.
    let stays = gone.iter().any(|(_, g)| *g == Some(false)) || asked_in_query.first().is_some_and(|word| gone_at(word) == Some(false));
    if !(gone.iter().any(|(_, g)| *g == Some(true)) && stays) {
        return Vec::new();
    }
    gone.into_iter().filter(|(_, g)| *g == Some(true)).map(|(value, _)| value).collect()
}

/// `in_path` without the pieces the site says are its address (`of_the_address`), asked over plain HTTP by the
/// browser the walk presented (`client::presenting`: the site's fingerprint sample, else `walked`, the walk's own user
/// agent), as the route's own calls will be. A value that was named for its place (`part1`) because the word before
/// it was taken for a value too is named for that word.
pub(super) fn callers_own(url: &str, in_path: Vec<(String, String)>, walked: Option<&str>) -> Vec<(String, String)> {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from));
    let mut status_of = |address: &str| -> Option<u16> {
        let mut transport = unbrowse_learn::client::presenting(host.as_deref(), &store::jars_dir(), unbrowse_learn::egress::Egress::Own, walked).ok()?;
        let req = unbrowse_learn::replay::Request { method: "GET".into(), url: address.parse().ok()?, exchange: 0, headers: Vec::new(), body: None };
        unbrowse_learn::replay::Fetch::fetch(&mut transport, &req).ok().map(|got| got.status)
    };
    // The words the page's query was asked, less any the path holds too.
    let in_query: Vec<String> = walk_inputs(url, &[], &[]).into_iter().map(|i| i.value).filter(|v| v.chars().count() >= 2 && v.chars().any(char::is_alphabetic) && !unbrowse_learn::slots::is_flag(v) && !in_path.iter().any(|(_, p)| p == v)).collect();
    let address = of_the_address(url, &in_path, &in_query, &mut status_of);
    if address.is_empty() {
        return in_path;
    }
    eprintln!("   [trial] {} of the path {} the page's address, not the caller's: the site has no page without {}", address.join(", "), if address.len() == 1 { "is" } else { "are" }, if address.len() == 1 { "it" } else { "them" });
    // Every later reading of this site's addresses agrees with what it just said: the route builder reads the
    // page's path again, and would bind the word again.
    note_address(url, &address);
    renamed(url, in_path, &address)
}

fn renamed(url: &str, in_path: Vec<(String, String)>, address: &[String]) -> Vec<(String, String)> {
    let segments: Vec<String> = url::Url::parse(url).ok().and_then(|u| u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect())).unwrap_or_default();
    in_path
        .into_iter()
        .filter(|(_, value)| !address.contains(value))
        .map(|(name, value)| {
            let before = segments.iter().position(|p| *p == value).and_then(|at| at.checked_sub(1)).map(|at| &segments[at]);
            match before {
                Some(word) if address.contains(word) && name.starts_with("part") => (word.clone(), value),
                _ => (name, value),
            }
        })
        .collect()
}

/// Whether `route`, called with `word` in place of each word the page was asked, answers it: the answer says the
/// word back on at least two of its lines. None when the route cannot be asked this way (it writes, a page signs its
/// call, none of its inputs is a word) or did not answer: nothing is concluded.
pub(super) fn says_back(route: &Route, asked: &[String], word: &str, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Option<bool> {
    if route.write || route.socket.is_some() || route.browser_assisted || route.graph.steps.iter().any(|s| s.is_page_signed()) {
        return None;
    }
    let probed = words_asked(route, asked);
    if probed.is_empty() {
        return None;
    }
    let mut moved: HashMap<String, String> = route.inputs.iter().filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d))).collect();
    for i in &probed {
        moved.insert(i.name.clone(), word.to_string());
    }
    let answer = answers(&route.graph, &moved)?;
    let said = word.to_lowercase();
    Some(said_lines(&answer, &[]).iter().filter(|line| line.contains(&said)).count() >= 2)
}

/// `says_back` where it asks the site for the second walk's word (`with_another_word`): that is the second look's
/// made-up second word, held with it (`UNBROWSE_NO_SECOND_LOOK`). Held, the site is asked nothing and nothing is
/// concluded (None). The pure comparison a confirming browse makes is not this: it reads an answer already in hand.
pub(super) fn says_the_second_word_back(route: &Route, asked: &[String], word: &str, answers: &mut impl FnMut(&unbrowse_learn::Graph, &HashMap<String, String>) -> Option<serde_json::Value>) -> Option<bool> {
    let mut held_or_asked = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
        if own_asks::held_at(own_asks::Ask::SecondLook, "learn::trial::with_another_word") {
            return None;
        }
        answers(g, i)
    };
    says_back(route, asked, word, &mut held_or_asked)
}

/// The site's answer to a route, over plain HTTP with the session the walk left.
pub(super) fn asks_the_site(graph: &unbrowse_learn::Graph, inputs: &HashMap<String, String>) -> Option<serde_json::Value> {
    let mut client = unbrowse_learn::RouteClient::new(graph.clone()).with_chrome_transport().with_session_store(store::jars_dir());
    client.call_with_ledger(inputs).0.ok()
}

/// The page walked a second time, for another word: the experiment a learn is judged by.
pub(super) struct Second {
    pub word: String,
    pub url: String,
    pub view: WalkView,
    /// The pieces of the page's path that the walk showed are its address, not the caller's (`the_address_left`).
    pub address: Vec<String>,
    /// The asked value the word went in place of and what a proposer says a caller should call it, when it said.
    pub called: Option<(String, String)>,
}

/// The pieces of a page's path (`in_path`: name and value) that a second walk showed are its address. The walk for
/// the second word moved `moved` and left the rest, and the page it led to made the first's calls. Left as they
/// were, those pieces still name the page. That is taken for the address where something says the pieces were not
/// just left out: a proposer named the one value that is the word (`named`), or the page walked with every value
/// moved was another page (`elsewhere`). Nothing otherwise: an unmoved piece may still be a second value.
pub(super) fn the_address_left(in_path: &[(String, String)], moved: &[String], named: bool, elsewhere: bool) -> Vec<String> {
    if !(named || elsewhere) {
        return Vec::new();
    }
    in_path.iter().map(|(_, value)| value).filter(|value| !moved.contains(value)).cloned().collect()
}

/// Walks the page of `url` for a second word: a proposer's when one is configured, else one the page offers. None
/// when there is no word to ask or the walk fails: then one walk is all there is.
pub(super) fn second_walk(walks: &Walks, first: &str, url: &str, goal: &str, id: &str, who: &str, in_path: &[(String, String)]) -> Option<Second> {
    let asked: Vec<String> = walk_inputs(url, in_path, &[]).into_iter().map(|i| i.value).collect();
    let walked = walks.0.locked().get(first)?.trace.clone();
    let held = unbrowse_learn::provenance::session_values(&walked);
    // Where a call of the walk sends an asked value in a format of the site's (a date written another way), the walk
    // says what to ask next: a value of the same kind, chosen so that the readings one walk leaves standing part on it
    // (a day above twelve, where the day and the month could each be the other). The page then says which; nothing is
    // guessed, and no proposer is asked for a word where the walk already names the value.
    let pairs: Vec<(String, String)> = asked.iter().map(|v| ("asked".to_string(), v.clone())).collect();
    if let Some((was, next)) = unbrowse_learn::lab::forms::next_value(&walked.exchanges, &pairs) {
        eprintln!("   [trial] a call sends \"{was}\" in a form of the site's: the page is walked for \"{next}\", which tells its readings apart");
        if let Some(found) = walk_for(walks, &walked, url, id, who, in_path, &asked, next, Some(was), None) {
            return Some(found);
        }
    }
    let offered: Vec<String> = another_word(&walked, url, &asked).into_iter().collect();
    let (word, named, called) = proposed_word_and_place(url, goal, &asked, &offered, &held).or_else(|| offered.first().cloned().map(|w| (w, None, None)))?;
    walk_for(walks, &walked, url, id, who, in_path, &asked, word, named, called)
}

/// The page of `url` walked for `word` in place of each reading of which asked value it replaces (`named` first, at
/// most two), the first walk that asked the same page kept as the second.
#[allow(clippy::too_many_arguments)]
fn walk_for(walks: &Walks, walked: &Trace, url: &str, id: &str, who: &str, in_path: &[(String, String)], asked: &[String], word: String, named: Option<String>, called: Option<String>) -> Option<Second> {
    let mut elsewhere = false;
    // Which of the asked values is the word is not in one walk: each reading is walked, at most two, and kept only
    // where the page it led to made a call of the first's.
    let mut tried: Vec<String> = Vec::new();
    for moved in places_to_move(url, asked, named.as_ref()) {
        let Some(other) = experiment::for_another_word(url, &moved, &word) else { continue };
        if tried.contains(&other) || tried.len() == 2 {
            continue;
        }
        tried.push(other.clone());
        match walk_as(walks, &other, &format!("{id}c"), who, &|_| {}) {
            Ok(view) => {
                let same = walks.0.locked().get(&view.walk).is_some_and(|w| asked_the_same_page(walked, &w.trace, &moved, &word));
                if same {
                    let by_name = named.as_ref().is_some_and(|n| moved.len() == 1 && moved[0] == *n);
                    let address = the_address_left(in_path, &moved, by_name, elsewhere && moved.len() < asked.len());
                    if !address.is_empty() {
                        eprintln!("   [trial] the page stayed the same page with {address:?} left as they were: its address, not the caller's");
                    }
                    let called = called.filter(|_| by_name).map(|name| (moved[0].clone(), name));
                    return Some(Second { word, url: other, view, address, called });
                }
                elsewhere |= moved.len() == asked.len();
                eprintln!("   [trial] walked for \"{word}\" in place of {moved:?}: the page made none of the calls that carried them, so it is another page");
            }
            Err(why) => {
                eprintln!("   [trial] the page was not walked for \"{word}\" ({other}): {why}");
                return None;
            }
        }
    }
    None
}

/// The answer the two walks agree on, as a candidate of the first (`experiment::answer_of_two`), among those that may
/// answer the goal at all.
pub(super) fn agreed(walks: &Walks, first: &WalkView, url: &str, goal: &str, second: &Second) -> Option<usize> {
    let guard = walks.0.locked();
    let (a, b) = (&guard.get(&first.walk)?.trace, &guard.get(&second.view.walk)?.trace);
    let (asked, other) = experiment::asked_apart(url, &second.url);
    let shown = page_shown(&a.exchanges, url, &[]);
    let candidates: Vec<(usize, bool)> = first.candidates.iter().filter(|c| may_answer(a, c.index, goal, url, &asked, &shown, &first.site)).map(|c| (c.index, c.page)).collect();
    experiment::answer_of_two(a, &candidates, &asked, b, &other)
}

/// What a proposer is asked for the answer.
const ANSWER: &str = "This is one page of a website walked twice in a browser, for two values (walks a and b), for the goal given. Each call lists what it sent, what it answered, how many lines of its answer say the asked value, and what the other walk says of it (hears: its answer changed with the value; deaf: it did not; unseen: the other walk has no such call). Name the one call of walk a that a person asking for the goal came for: the list of results itself, not suggestions, a completion, tracking, configuration, a side panel, or the details of one result. The page itself is a valid answer when it holds the results and no call does. Answer with JSON only: {\"answer\": \"<the id of the call in walk a, such as a:123>\", \"why\": \"<one sentence>\"}.";

/// The call a proposer names as the answer, as a candidate of the first walk, when a proposer is configured: it is
/// shown both walks of the page as one graph (`sitegraph`), with nothing the session holds. None when there is no
/// proposer, it names no call of the first walk's, or what it names is no candidate.
pub(super) fn proposed_answer(walks: &Walks, first: &WalkView, url: &str, goal: &str, second: &Second) -> Option<usize> {
    let command = proposer()?;
    let graph = {
        let guard = walks.0.locked();
        let (a, b) = (&guard.get(&first.walk)?.trace, &guard.get(&second.view.walk)?.trace);
        sitegraph::for_a_proposer(sitegraph::of_two_walks(goal, (url, a), (&second.url, b), None))
    };
    let ask = serde_json::json!({ "ask": "answer", "instruction": ANSWER, "graph": graph });
    let said = unbrowse_learn::generated::run_agent(&command, &ask.to_string())?;
    let index = answer_in(&said)?;
    let known = first.candidates.iter().any(|c| c.index == index);
    eprintln!("   [trial] the proposer names call {index} as the answer{}", if known { "" } else { ": no candidate of this walk" });
    known.then_some(index)
}

/// The call in a proposer's answer: `{"answer": "a:123"}`, wherever it sits in what it wrote. Only a call of the
/// first walk is one the learn can keep.
fn answer_in(said: &str) -> Option<usize> {
    let v: serde_json::Value = serde_json::from_str(said.get(said.find('{')?..=said.rfind('}')?)?).ok()?;
    v.get("answer")?.as_str()?.trim().strip_prefix("a:")?.parse().ok()
}

/// `route`, just learned from a walk of `url`, held to the second walk's word. Answering it, the route is marked as
/// having said it back. Not answering it, the call the page made for that word is kept in `route`'s place when the
/// site answers that call for this page's word too. Says, beside the route, whether the site answered a second
/// word for it: then it hears its caller, and no other probe need ask. With no second walk, or a route that cannot
/// be asked, `route` stands as it was and nothing is said.
#[allow(clippy::too_many_arguments)]
pub(super) fn with_another_word(walks: &Walks, mut route: Route, url: &str, goal: &str, who: &str, in_path: &[(String, String)], second: Option<&Second>, is_the_page: bool, agreed: bool) -> (Route, bool) {
    let asked: Vec<String> = walk_inputs(url, in_path, &[]).into_iter().map(|i| i.value).collect();
    let Some(second) = second else { return (route, false) };
    let word = second.word.clone();
    match says_the_second_word_back(&route, &asked, &word, &mut asks_the_site) {
        None => (route, false),
        Some(true) => {
            eprintln!("   [trial] {} {} answers \"{word}\" too", route.method, route.site);
            route.heard = store::Heard { probed: true, said_back: Some(word), ..Default::default() };
            let _ = store::save_route(&route);
            // The page answers both words. A data call the page made for the second word is the same answer
            // without the page around it, when the site answers that call for the first word too: the calls of
            // both walks are the site's, not only the first walk's.
            match is_the_page.then(|| from_the_page_for(walks, &route, url, goal, who, second, true)).flatten() {
                Some(call) => {
                    if call.id != route.id {
                        let _ = store::drop_learned(&route.id);
                    }
                    (call, true)
                }
                None => (route, true),
            }
        }
        // The two walks agreed on this call: the page made it for this very word and it answered. A plain call that
        // says less is a call the route does not yet reproduce, not another call's turn.
        Some(false) if agreed => {
            eprintln!("   [trial] {} {} answered \"{word}\" on its walk and not to a plain call: the route stands, unverified", route.method, route.site);
            (route, false)
        }
        Some(false) => {
            eprintln!("   [trial] {} {} does not answer \"{word}\": looking at what the page sent for it", route.method, route.site);
            match from_the_page_for(walks, &route, url, goal, who, second, false) {
                Some(other) => {
                    if other.id != route.id {
                        let _ = store::drop_learned(&route.id);
                    }
                    (other, true)
                }
                None => (route, false),
            }
        }
    }
}

/// The call the page makes for `word`, kept as a route, when the site answers it for the first page's words too
/// (`asked`): a call found on one walk, verified on the other's value. None, with nothing kept, otherwise.
fn from_the_page_for(walks: &Walks, first: &Route, url: &str, goal: &str, who: &str, second: &Second, calls_only: bool) -> Option<Route> {
    let (other_url, view, word) = (second.url.clone(), &second.view, &second.word);
    let (index, in_path) = {
        let guard = walks.0.locked();
        let trace = &guard.get(&view.walk)?.trace;
        // What the caller's is, between two addresses of one page, is what they differ by: a word of the address is
        // in both.
        let (_, differs) = experiment::asked_apart(url, &other_url);
        let in_path: Vec<(String, String)> = path_inputs(&other_url, goal, trace).0.into_iter().filter(|(_, value)| differs.contains(value)).collect();
        let query_values = asked_values(&other_url, &in_path);
        let scores = rule_scores(trace, view, goal, &query_values, &[]);
        let shown = page_shown(&trace.exchanges, &other_url, &[]);
        let passes = |i: usize| may_answer(trace, i, goal, &other_url, &query_values, &shown, &view.site);
        // `calls_only`: a data call or nothing. The page is what the first route already is.
        let scores: Vec<_> = scores.into_iter().filter(|(_, i, _, _)| !calls_only || !trace.exchanges[*i].is_main_document()).collect();
        let index = walk_pick(trace, view, goal, &query_values, scores, &passes, None)?.0;
        if calls_only && trace.exchanges[index].is_main_document() {
            return None;
        }
        (index, in_path)
    };
    let other = keep_as(walks, &view.walk, index, goal, &in_path, who, true).ok()?;
    // The same call again is no other call: the first route already did not answer this word.
    let same = other.method == first.method && other.site == first.site && other.path == first.path;
    let (was, now) = experiment::asked_apart(url, &other_url);
    // The site answers it for this page's word, and that answer is its own: beside the answer to the second word
    // it holds more than the word said back (a page that only echoes what it was asked reads the same for both).
    let verified = !same
        && was.first().is_some_and(|first_word| {
            let mut answers = Vec::new();
            let mut asks = |g: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
                let got = asks_the_site(g, i);
                answers.extend(got.clone());
                got
            };
            says_back(&other, &now, first_word, &mut asks) == Some(true) && says_back(&other, &now, word, &mut asks).is_some() && {
                let [a, b] = &answers[..] else { return false };
                !nothing_of_its_own(&said_lines(a, &[first_word.as_str()]), &said_lines(b, &[word.as_str()]))
            }
        });
    if !verified {
        // A route is named for its call: the same call learned again took the first route's place in the store, so
        // the first is put back as it was; another call is dropped.
        let _ = if other.id == first.id { store::save_route(first).map(|_| ()) } else { store::drop_learned(&other.id).map(|_| ()) };
        return None;
    }
    eprintln!("   [trial] {} {}{} answers both \"{word}\" and this page's word: kept in its place", other.method, other.site, other.path.chars().take(50).collect::<String>());
    let mut other = other;
    // The route is kept for the page that was asked: what it sends when the caller says nothing is that page's
    // word, not the word the experiment walked.
    if let Some(first_word) = was.first() {
        for input in other.inputs.iter_mut().filter(|i| i.default.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(word))) {
            input.default = Some(first_word.clone());
        }
        for field in other.graph.steps.iter_mut().flat_map(|s| s.fields.iter_mut()) {
            if let unbrowse_learn::graph::Class::Input { default, .. } = &mut field.class {
                if default.as_deref().is_some_and(|d| d.eq_ignore_ascii_case(word)) {
                    *default = Some(first_word.clone());
                }
            }
        }
    }
    other.heard = store::Heard { probed: true, said_back: was.first().cloned(), ..Default::default() };
    let _ = store::save_route(&other);
    Some(other)
}

/// The proposer the owner configured (`UNBROWSE_PROPOSE_PROGRAM`), None when there is none. In tests it is the one
/// `with_a_proposer` set on the test's own thread, never the process's: tests run side by side, and one test's
/// proposer must not answer another's walk.
pub(super) fn proposer() -> Option<String> {
    #[cfg(test)]
    let set = TEST_PROPOSER.with(|p| p.borrow().clone());
    #[cfg(not(test))]
    let set = std::env::var("UNBROWSE_PROPOSE_PROGRAM").ok();
    set.filter(|c| !c.trim().is_empty())
}

#[cfg(test)]
thread_local! {
    static TEST_PROPOSER: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// Runs `f` with `program` as the configured proposer, seen only by this test's thread ([`proposer`]). Shared with the
/// links tests.
#[cfg(test)]
pub(super) fn with_a_proposer<T>(program: &str, f: impl FnOnce() -> T) -> T {
    struct Unset;
    impl Drop for Unset {
        fn drop(&mut self) {
            TEST_PROPOSER.with(|p| *p.borrow_mut() = None);
        }
    }
    TEST_PROPOSER.with(|p| *p.borrow_mut() = Some(program.to_string()));
    let _unset = Unset;
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seen(method: &str, url: &str, body: &str, doc: bool) -> Exchange {
        Exchange {
            method: method.into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: if doc { "text/html".into() } else { "application/json".into() },
            resource_type: Some(if doc { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        }
    }

    /// The walk that exposed it: a page at `/search/pins/?q=garden`, whose path pieces one walk also took for words,
    /// so the second walk went to `/tattoo/tattoo/?q=tattoo`, another page, which never made the search call. A walk
    /// for another word is the same page only where it makes a call of the first's that carried what was moved. The
    /// word's place is tried as a proposer names it, then the query's alone, then every asked value.
    #[test]
    fn a_second_walk_that_makes_none_of_the_firsts_calls_asked_another_page() {
        let url = "https://pics.example/search/pins/?q=garden";
        let asked = vec!["garden".to_string(), "search".to_string(), "pins".to_string()];
        // Every page of the site reports its own address in a call; only the search carries the word as its own.
        let reports = |page: &str| seen("GET", &format!("https://pics.example/resource/Experience/get/?source_url={}", percent_encoding::utf8_percent_encode(page, percent_encoding::NON_ALPHANUMERIC)), "{}", false);
        // And every page with the search box asks for completions of the word in it: a light call, made anywhere.
        let completes = |w: &str| seen("GET", &format!("https://pics.example/resource/Typeahead/get/?data=%7B%22term%22%3A%22{w}%22%7D"), r#"{"s":[]}"#, false);
        let results = "{\"results\":[1,2,3,4,5,6,7,8,9,10,11,12]}";
        let first = Trace { exchanges: vec![seen("GET", url, "<html>", true), completes("garden"), reports("/search/pins/?q=garden"), seen("GET", "https://pics.example/resource/Search/get/?source_url=%2Fsearch%2Fpins%2F%3Fq%3Dgarden&data=%7B%22query%22%3A%22garden%22%2C%22scope%22%3A%22pins%22%7D", results, false)], inputs: Vec::new() };
        let same = Trace { exchanges: vec![seen("GET", "https://pics.example/search/pins/?q=tattoo", "<html>", true), completes("tattoo"), reports("/search/pins/?q=tattoo"), seen("GET", "https://pics.example/resource/Search/get/?source_url=%2Fsearch%2Fpins%2F%3Fq%3Dtattoo&data=%7B%22query%22%3A%22tattoo%22%7D", "{}", false)], inputs: Vec::new() };
        let elsewhere = Trace { exchanges: vec![seen("GET", "https://pics.example/tattoo/tattoo/?q=tattoo", "<html>", true), completes("tattoo"), reports("/tattoo/tattoo/?q=tattoo"), seen("GET", "https://pics.example/resource/Topic/get/?data=%7B%22name%22%3A%22tattoo%22%7D", "{}", false)], inputs: Vec::new() };
        assert!(asked_the_same_page(&first, &same, &asked, "tattoo"), "every value moved, on a page that is the same page");
        assert!(asked_the_same_page(&first, &same, &["garden".to_string()], "tattoo"));
        assert!(!asked_the_same_page(&first, &elsewhere, &asked, "tattoo"), "a call that reports the page's address, and one that completes the word in the box, are made by any page");
        // A word that sits in the call's own path is the same call for another word.
        let by_path = |w: &str| Trace { exchanges: vec![seen("GET", &format!("https://food.example/api/search/{w}-/results"), "{}", false)], inputs: Vec::new() };
        assert!(asked_the_same_page(&by_path("chicken"), &by_path("salmon"), &["chicken".to_string()], "salmon"));
        // No call of the first carried the word (the page itself is the answer): nothing to hold the second to.
        let page_only = Trace { exchanges: vec![seen("GET", url, "<html>", true)], inputs: Vec::new() };
        assert!(asked_the_same_page(&page_only, &elsewhere, &asked, "tattoo"));

        assert_eq!(places_to_move(url, &asked, None), [asked.clone(), vec!["garden".to_string()]], "all, as one walk reads them, then the query's value alone");
        assert_eq!(places_to_move(url, &asked, Some(&"pins".to_string())), [vec!["pins".to_string()], asked.clone(), vec!["garden".to_string()]], "a proposer's reading first");
        let in_path = vec!["chicken".to_string()];
        assert_eq!(places_to_move("https://food.example/search/chicken-", &in_path, None), std::slice::from_ref(&in_path), "an address asked only in its path");
        assert_eq!(place_in(r#"ok {"second_word":"tattoo","in_place_of":"Garden"}"#, &asked).as_deref(), Some("garden"));
        assert_eq!(place_in(r#"{"second_word":"tattoo","in_place_of":"flowers"}"#, &asked), None, "only a value the page was asked");

        // The pieces left as they were, on a page that stayed the same page, are its address: where a proposer named
        // the word, or where the page with every piece moved was another page. Left unsaid otherwise.
        let in_path = vec![("part0".to_string(), "search".to_string()), ("part1".to_string(), "pins".to_string())];
        let word = vec!["garden".to_string()];
        assert_eq!(the_address_left(&in_path, &word, true, false), ["search", "pins"]);
        assert_eq!(the_address_left(&in_path, &word, false, true), ["search", "pins"]);
        assert!(the_address_left(&in_path, &word, false, false).is_empty(), "left alone is not shown to be the address");
        assert_eq!(the_address_left(&in_path, &["garden".to_string(), "pins".to_string()], true, false), ["search"]);
        assert_eq!(called_in(r#"{"second_word":"tattoo","in_place_of":"garden","called":"Search Query"}"#).as_deref(), Some("search_query"));
        assert_eq!(called_in(r#"{"second_word":"tattoo","called":"q"}"#), None, "a name says what the value is");
        assert_eq!(called_in(r#"{"second_word":"tattoo","called":"what you'd search for!"}"#), None);
    }

    /// The second word is the page's own: a link to itself with another value where the asked one sits, the one it
    /// links to most. A link elsewhere, a link that changes something else, and the asked word itself are none.
    #[test]
    fn another_word_is_one_the_page_links_itself_with() {
        let url = "https://shop.example/search/iphone%2015/?sort=new";
        let page = r#"<a href="/search/iphone%2014/?sort=new">iphone 14</a><a href="/search/iphone%2014/?sort=new">again</a>
            <a href="/search/phone%20case/?sort=new">cases</a><a href="/search/iphone%2015/?sort=new">this</a>
            <a href="/search/iphone%2015/?sort=old">oldest</a><a href="/help/returns/?sort=new">help</a><a href="https://other.example/search/laptop/?sort=new">ad</a>"#;
        let trace = Trace { exchanges: vec![seen("GET", url, page, true)], inputs: Vec::new() };
        assert_eq!(another_word(&trace, url, &["iphone 15".to_string()]).as_deref(), Some("iphone 14"));
    }

    /// With no such link, a longer wording an answer in the walk offers; with neither, no word.
    #[test]
    fn another_word_may_be_a_longer_wording_an_answer_offers() {
        let url = "https://shop.example/s?q=lamp";
        let offers = seen("GET", "https://shop.example/api/complete?q=lamp", r#"{"suggestions":["lamp","lamp shade","lamp oil"]}"#, false);
        let trace = Trace { exchanges: vec![seen("GET", url, "<html></html>", true), offers], inputs: Vec::new() };
        assert_eq!(another_word(&trace, url, &["lamp".to_string()]).as_deref(), Some("lamp shade"));
        let siblings = seen("GET", "https://shop.example/api/expand?q=iphone+15", r#"{"query":[{"queryTerm":"iphone"},{"queryTerm":"iphone15"},{"queryTerm":"iphone 16"}]}"#, false);
        let page = "https://shop.example/s?q=iphone+15";
        let trace = Trace { exchanges: vec![seen("GET", page, "<html></html>", true), siblings], inputs: Vec::new() };
        assert_eq!(another_word(&trace, page, &["iphone 15".to_string()]).as_deref(), Some("iphone 16"), "a wording that opens the same and goes on otherwise");
        // A wording that carries a key is no word to tell a proposer, and neither is the page's own path where it
        // holds one; what the page was asked is the caller's and is told.
        let keyed = seen("GET", "https://shop.example/api/complete?q=lamp", r#"{"suggestions":["lamp k7Qm2xP9aL4tZ8"]}"#, false);
        let trace = Trace { exchanges: vec![seen("GET", url, "<html></html>", true), keyed], inputs: Vec::new() };
        assert_eq!(another_word(&trace, url, &["lamp".to_string()]), None);
        let over = seen("GET", "https://shop.example/api/complete?q=lamp", r#"{"suggestions":["lamp %256B%2537%2551%256D%2532%2578%2550%2539"]}"#, false);
        let trace = Trace { exchanges: vec![seen("GET", url, "<html></html>", true), over], inputs: Vec::new() };
        assert_eq!(another_word(&trace, url, &["lamp".to_string()]), None, "a key written over is a key");
        let held = vec!["Zx81kQ0pLm".to_string()];
        assert_eq!(page_told("https://shop.example/u/Zx81kQ0pLm/k7Qm2xP9aL4tZ8/search/lamp?t=1", &["lamp".to_string()], &held).as_deref(), Some("shop.example/u/{session}/{session}/search/lamp"));
        let bare = Trace { exchanges: vec![seen("GET", url, "<html></html>", true)], inputs: Vec::new() };
        assert_eq!(another_word(&bare, url, &["lamp".to_string()]), None);
    }

    /// The live run that exposed it: a social site's search for `linux` lists accounts whose display names decorate
    /// the word (`Linux ✅`, `Linux :linux:`), beside one that adds a word (`Linux Foundation`). A decorated name read
    /// as its words is the asked word again: it is not offered, and the trial no longer asks it. Asked, as the run did,
    /// the route's answer says it back on one line only (the account's own name, where the rest say `linux`), so the
    /// trial could never have heard it: no answer tells a search for `Linux ✅` from one for `linux`. The word that
    /// adds one of its own is offered.
    #[test]
    fn a_name_that_decorates_the_asked_word_is_not_another_word() {
        let url = "https://social.example/search?q=linux";
        let accounts = |names: &[&str]| serde_json::json!({
            "accounts": names.iter().enumerate().map(|(n, name)| serde_json::json!({ "display_name": name, "acct": format!("linux@host{n}.example"), "username": "linux" })).collect::<Vec<_>>(),
            "statuses": [{ "content": "<p>Linux kernel news</p>" }],
            "hashtags": [{ "name": "linux" }, { "name": "linuxmint" }],
        });
        let answer = accounts(&["Linux ✅", "Linux", "Linux :linux:", "Linux", "Asahi Linux", "Linux Foundation"]);
        let search = seen("GET", "https://social.example/api/v2/search?q=linux&limit=11", &answer.to_string(), false);
        let trace = Trace { exchanges: vec![seen("GET", url, "<html><body>a search</body></html>", true), search], inputs: Vec::new() };
        let asked = ["linux".to_string()];
        assert_eq!(offered_words(&trace, url, &asked), ["Linux Foundation"], "a decorated name is the asked word again");
        assert_eq!(another_word(&trace, url, &asked).as_deref(), Some("Linux Foundation"));
        // What the run asked, read by the trial's own reader: the route answered the same accounts, and the whole value
        // stands on one line of them, so it was never heard said back.
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({ "provisional": false, "steps": [{ "exchange": 1, "method": "GET", "status": 200,
            "url": "https://social.example/api/v2/search?q={q}&limit=11", "needs_browser": false,
            "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "linux" }] }] }))
        .unwrap();
        let route = Route::from_graph("r".into(), "search".into(), url.into(), graph).unwrap();
        let mut same = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(answer.clone());
        assert_eq!(says_back(&route, &asked, "Linux ✅", &mut same), Some(false), "said back on one line only");
        // A word that adds one of its own, answered with records that say it, is said back.
        let mut its_own = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(accounts(&["Linux Foundation", "Linux Foundation Events", "Linux Foundation Europe"]));
        assert_eq!(says_back(&route, &asked, "Linux Foundation", &mut its_own), Some(true));
    }

    /// What a walk a node kept offers as a second word, by source and in order: `UNBROWSE_WALK=<capture.jsonl>
    /// UNBROWSE_WALK_URL=<the page it walked> cargo test -p unbrowse-node-app what_a_kept_walk_offers -- --nocapture`.
    /// The capture is the owner's and stays outside the repository. Prints; it judges nothing.
    #[test]
    fn what_a_kept_walk_offers() {
        let (Some(capture), Some(url)) = (std::env::var_os("UNBROWSE_WALK").map(std::path::PathBuf::from), std::env::var("UNBROWSE_WALK_URL").ok()) else { return };
        let (dir, session) = (capture.parent().expect("a folder"), capture.file_stem().and_then(|s| s.to_str()).expect("a name"));
        let trace = trace_from_walk(dir, session).expect("the capture holds a walk");
        let asked: Vec<String> = walk_inputs(&url, &[], &[]).into_iter().map(|i| i.value).collect();
        println!("asked {asked:?}");
        println!("the page's links and the answers' wordings: {:?}", offered_without_records(&trace, &url, &asked));
        println!("the words the answer's records share: {:?}", unbrowse_learn::lab::answer::shared_words(&trace, &url, &asked));
        println!("offered, in the order a trial asks them: {:?}", offered_words(&trace, &url, &asked));
    }

    /// The site says which pieces of a path are its address: asked for with one piece replaced, the page is gone
    /// for the route word and still a page for the value. The value is then named for the word before it. A site
    /// that answers the same for both, or does not answer, says nothing.
    #[test]
    fn a_piece_whose_replacement_is_no_page_is_the_address() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let url = "https://shop.example/search/iphone%2015/";
        let in_path = vec![("part0".to_string(), "search".to_string()), ("part1".to_string(), "iphone 15".to_string())];
        let mut site = |address: &str| Some(if address.contains("/search/") { 200 } else { 404 });
        let address = of_the_address(url, &in_path, &[], &mut site);
        assert_eq!(address, vec!["search".to_string()]);
        assert_eq!(renamed(url, in_path.clone(), &address), vec![("search".to_string(), "iphone 15".to_string())]);
        let mut all_gone = |_: &str| Some(404);
        assert!(of_the_address(url, &in_path, &[], &mut all_gone).is_empty(), "every replacement gone says nothing");
        let mut refused = |_: &str| Some(403);
        assert!(of_the_address(url, &in_path, &[], &mut refused).is_empty(), "a door says nothing");
        let mut silent = |_: &str| None;
        assert!(of_the_address(url, &in_path, &[], &mut silent).is_empty());
        assert!(of_the_address(url, &in_path[1..], &[], &mut site).is_empty(), "one piece has nothing to be told from");
        // A lone piece beside a value in the query: the page is still one for another query, and none without the piece.
        let page = "https://shop.example/search/?q=lamps";
        let lone = vec![("part0".to_string(), "search".to_string())];
        let mut by_query = |address: &str| Some(if address.contains("/search/") { 200 } else { 404 });
        assert_eq!(of_the_address(page, &lone, &["lamps".to_string()], &mut by_query), vec!["search".to_string()]);
        assert!(of_the_address(page, &lone, &[], &mut by_query).is_empty());
    }

    /// A proposer's answer is read for its word wherever it sits in what it wrote, and nothing else of it is used.
    #[test]
    fn a_proposers_word_is_read_from_its_answer() {
        assert_eq!(word_in(r#"{"second_word": "macbook air"}"#).as_deref(), Some("macbook air"));
        assert_eq!(word_in("Here you go:\n```json\n{\"second_word\": \" sofa \"}\n```").as_deref(), Some("sofa"));
        assert_eq!(word_in("I would search for a sofa"), None);
        assert_eq!(word_in(r#"{"second_word": ""}"#), None);
    }

    /// Once a site has said a word is its address, no reading of its paths takes that word for a value again: the
    /// page hands `search` on to its own call, and one walk would bind it.
    #[test]
    fn a_word_the_site_called_its_address_is_never_bound_again() {
        let url = "https://market.example/search/desk%20lamp/";
        let call = seen("POST", "https://market.example/api/find?kind=search&q=desk%20lamp", r#"{"kind":"search","results":[{"title":"desk lamp one"},{"title":"desk lamp two"}]}"#, false);
        let trace = Trace { exchanges: vec![seen("GET", url, "<html><body>desk lamp</body></html>", true), call], inputs: Vec::new() };
        let before = path_inputs(url, "search the market", &trace).0;
        assert!(before.iter().any(|(_, v)| v == "search"), "one walk takes the address word for a value: {before:?}");
        note_address(url, &["search".to_string()]);
        assert_eq!(path_inputs(url, "search the market", &trace).0, vec![("search".to_string(), "desk lamp".to_string())]);
    }

    /// A proposer's answer names a call of the first walk by its id; anything else names nothing.
    #[test]
    fn a_proposers_answer_names_a_call_of_the_first_walk() {
        assert_eq!(answer_in(r#"{"answer": "a:123", "why": "the list"}"#), Some(123));
        assert_eq!(answer_in("```json\n{\"answer\":\"a:7\"}\n```"), Some(7));
        assert_eq!(answer_in(r#"{"answer": "b:9"}"#), None, "a call of the second walk is not one the learn can keep");
        assert_eq!(answer_in(r#"{"answer": "GET shop.example/api"}"#), None);
        assert_eq!(answer_in("the search call"), None);
    }

    /// The second look held, the route is not asked the second walk's word: the site hears nothing, nothing is
    /// concluded, and the hold is said once.
    #[test]
    fn a_held_second_look_sends_no_made_up_word() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp", "optional": false }] }]
        }))
        .unwrap();
        let route = Route::from_graph("r".into(), "search".into(), "https://shop.example/".into(), graph).unwrap();
        let asked = vec!["lamp".to_string()];
        let sent = std::cell::RefCell::new(Vec::new());
        let mut hears = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
            let word = i.get("q").cloned().unwrap_or_default();
            sent.borrow_mut().push(word.clone());
            Some(serde_json::json!({ "results": [{ "title": format!("Brass {word} one") }, { "title": format!("Glass {word} two") }] }))
        };
        assert_eq!(says_the_second_word_back(&route, &asked, "kettle", &mut hears), Some(true), "unheld, the site is asked the word");
        assert_eq!(*sent.borrow(), ["kettle"]);
        sent.borrow_mut().clear();
        let (heard, said) = own_asks::holding(own_asks::Ask::SecondLook, || says_the_second_word_back(&route, &asked, "kettle", &mut hears));
        assert_eq!(heard, None, "held, nothing is concluded");
        assert!(sent.borrow().is_empty(), "held, the site is sent no made-up word");
        assert_eq!(said, vec!["   [own-ask] held: second-look at learn::trial::with_another_word".to_string()]);
    }

    /// A route answers a word when its answer says the word back; a strip that answers the same for any word does
    /// not; and a route no word can be put into is not asked.
    #[test]
    fn a_route_answers_a_word_when_its_answer_says_it_back() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp", "optional": false }] }]
        }))
        .unwrap();
        let route = Route::from_graph("r".into(), "search".into(), "https://shop.example/".into(), graph).unwrap();
        let asked = vec!["lamp".to_string()];
        let mut hears = |_: &unbrowse_learn::Graph, i: &HashMap<String, String>| {
            let word = i.get("q").cloned().unwrap_or_default();
            Some(serde_json::json!({ "results": [{ "title": format!("Brass {word} one") }, { "title": format!("Glass {word} two") }, { "title": "Wall clock" }] }))
        };
        assert_eq!(says_back(&route, &asked, "kettle", &mut hears), Some(true));
        let mut strip = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(serde_json::json!({ "items": [{ "name": "Garden chair" }, { "name": "Desk fan" }] }));
        assert_eq!(says_back(&route, &asked, "kettle", &mut strip), Some(false));
        let mut silent = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| None;
        assert_eq!(says_back(&route, &asked, "kettle", &mut silent), None);
        assert_eq!(says_back(&route, &["other".to_string()], "kettle", &mut hears), None, "no input holds a word the page was asked");
    }

    /// What is kept of a site's address words is bounded: a site that answers so as to name a great many, or a
    /// caller that names them, grows nothing past the bound.
    #[test]
    fn a_sites_address_words_are_kept_within_a_bound() {
        let url = "https://bounded-words.example/a/b/";
        let many: Vec<String> = (0..500).map(|n| format!("word{n}")).collect();
        note_address(url, &many);
        note_address(url, &many);
        let kept = ADDRESS_WORDS.locked().get("bounded-words.example").map(|w| w.len()).unwrap_or(0);
        assert!(kept > 0 && kept <= ADDRESS_WORDS_A_SITE_MOST, "{kept}");
    }

    /// The second word came from the page as the owner's session saw it: an agent shown the route learns that there
    /// was one, not which, whether or not the route carries anything else of the session's.
    #[test]
    fn an_agent_is_never_shown_the_second_word() {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": "https://shop.example/api/search?q={q}", "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": "q" }, "class": "input", "name": "q", "secret": false, "default": "lamp", "optional": false }] }]
        }))
        .unwrap();
        let mut route = Route::from_graph("r".into(), "search".into(), "https://shop.example/".into(), graph).unwrap();
        route.heard.said_back = Some("lamp for the flat on Elm Row".into());
        for session_gave in [false, true] {
            route.session_gave = session_gave;
            let shown = serde_json::to_string(&route.shown_to_an_agent()).unwrap();
            assert!(!shown.contains("Elm Row") && shown.contains("{word}"), "{shown}");
        }
        route.heard.said_back = None;
        assert_eq!(route.shown_to_an_agent().heard.said_back, None);
    }

    /// A site on this machine, for the trial that asks one: it answers every request with `answer(target)` as JSON.
    fn a_site(answer: impl Fn(&str) -> (u16, String) + Send + 'static) -> u16 {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let (status, body) = answer(request.split_whitespace().nth(1).unwrap_or(""));
                let _ = write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            }
        });
        port
    }

    /// The records a search site lists for `word`: each says it, and each word has records of its own beside.
    fn records_for(word: &str) -> serde_json::Value {
        let own: &[&str] = match word {
            "lamp" => &["Anodised arc fitting from Leeds", "Warm light for the reading nook", "Dimmer switch included", "Fits a standard socket"],
            "kettle" => &["Boils two litres in minutes", "Whistles when the steam is ready", "Cordless jug with a base", "Lime scale filter inside"],
            _ => &["Wall clock", "Garden chair"],
        };
        serde_json::json!({ "results": [{ "title": format!("Brass {word} one") }, { "title": format!("Glass {word} two") }, { "title": format!("Tall {word} three") }, { "note": own[0] }, { "note": own[1] }, { "note": own.get(2) }, { "note": own.get(3) }] })
    }

    /// What a search site answers for the word in `q` or `term`: records that say it.
    fn says_the_word(target: &str) -> (u16, String) {
        let word = url::Url::parse(&format!("http://site.example{target}")).ok().and_then(|u| u.query_pairs().find(|(k, _)| k == "q" || k == "term").map(|(_, v)| v.into_owned())).unwrap_or_default();
        (200, records_for(&word).to_string())
    }

    fn search_route(port: u16, path: &str, key: &str) -> Route {
        let graph: unbrowse_learn::Graph = serde_json::from_value(serde_json::json!({
            "provisional": false,
            "steps": [{ "exchange": 0, "method": "GET", "status": 200, "url": format!("http://127.0.0.1:{port}{path}?{key}={{{key}}}"), "needs_browser": false,
                "fields": [{ "loc": { "in": "query", "key": key }, "class": "input", "name": key, "secret": false, "default": "lamp", "optional": false }] }]
        }))
        .unwrap();
        Route::from_graph(format!("trial-test-{port}"), "search".into(), format!("http://127.0.0.1:{port}/"), graph).unwrap()
    }

    fn walk_of(trace: &Trace, url: &str) -> Walk {
        Walk { url: url.into(), trace: trace.clone(), probes: Vec::new(), recording: None, at: std::time::Instant::now(), addresses: None }
    }

    /// The page `url` walked, and the call it made: a list of records that say the word.
    fn page_with_search(host: &str, word: &str) -> (String, Trace) {
        let url = format!("https://{host}/s?q={word}");
        let list = records_for(word);
        let trace = Trace { exchanges: vec![seen("GET", &url, "<html><body>results</body></html>", true), seen("GET", &format!("https://{host}/api/search?q={word}"), &list.to_string(), false)], inputs: Vec::new() };
        (url, trace)
    }

    /// The proposer is told the page and what it was asked, never what the session holds, and its word is kept only
    /// where it is a word to ask: with the value it stands in place of, and what a caller calls that value.
    #[test]
    fn a_proposer_names_the_second_word_and_where_it_goes() {
        let dir = std::env::temp_dir().join(format!("trial-ask-{}-{}", std::process::id(), store::now()));
        std::fs::create_dir_all(&dir).unwrap();
        let heard = dir.join("ask.json");
        let program = format!("cat > '{}'; echo 'I would try {{\"second_word\":\"kettle\",\"in_place_of\":\"LAMP\",\"called\":\"Product Name\"}}'", heard.display());
        let held = vec!["Zx81kQ0pLm".to_string()];
        let asked = vec!["lamp".to_string()];
        let url = "https://shop.example/u/Zx81kQ0pLm/search/lamp";
        let said = with_a_proposer(&program, || proposed_word_and_place(url, "find lamps", &asked, &["lamp shade".to_string()], &held));
        assert_eq!(said, Some(("kettle".to_string(), Some("lamp".to_string()), Some("product_name".to_string()))));
        let text = std::fs::read_to_string(&heard).unwrap();
        let ask: serde_json::Value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{e}: ...{}", text.chars().skip(1150).collect::<String>()));
        assert_eq!(ask["page"], "shop.example/u/{session}/search/lamp", "the session's piece is named, not shown");
        assert_eq!((ask["goal"].as_str(), ask["asked"][0].as_str(), ask["the_site_offers"][0].as_str()), (Some("find lamps"), Some("lamp"), Some("lamp shade")));
        assert_eq!(with_a_proposer(&program, || proposed_word(url, "find lamps", &asked, &[], &held)).as_deref(), Some("kettle"));
        // A name that is not one an input can take is left unsaid, and the word still stands.
        let odd = "echo '{\"second_word\":\"kettle\",\"in_place_of\":\"lamp\",\"called\":\"q\"}'";
        assert_eq!(with_a_proposer(odd, || proposed_word_and_place(url, "g", &asked, &[], &held)), Some(("kettle".to_string(), Some("lamp".to_string()), None)));
        // The asked word again, or a word that is no word, is not one to ask; nor is an answer that is not one.
        let again = "echo '{\"second_word\":\"LAMP\"}'";
        assert_eq!(with_a_proposer(again, || proposed_word_and_place(url, "g", &asked, &[], &held)), None);
        let symbol = "echo '{\"second_word\":\"%%\"}'";
        assert_eq!(with_a_proposer(symbol, || proposed_word(url, "g", &asked, &[], &held)), None);
        assert_eq!(with_a_proposer("echo nothing", || proposed_word(url, "g", &asked, &[], &held)), None);
        assert_eq!(with_a_proposer("  ", || proposed_word(url, "g", &asked, &[], &held)), None, "a blank program is none");
        assert_eq!(with_a_proposer(&program, || proposed_word("not an address", "g", &asked, &[], &held)), None, "no page, no ask");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two walks of a page, a call that answers each word with its own records: the answer the two agree on is the
    /// call (`agreed`), and a proposer that names a call of the first walk names it too; one that names a call the walk
    /// never made, or the page's own address, names none.
    #[test]
    fn a_proposer_names_the_call_the_two_walks_answer() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let (url, first) = page_with_search("shop.example", "lamp");
        let (other_url, second) = page_with_search("shop.example", "kettle");
        let walks = Walks::default();
        walks.0.locked().insert("one".into(), walk_of(&first, &url));
        walks.0.locked().insert("two".into(), walk_of(&second, &other_url));
        let site = site_of("shop.example");
        let view = view_of("one", &url, &site, &first, 0);
        let again = Second { word: "kettle".into(), url: other_url.clone(), view: view_of("two", &other_url, &site, &second, 0), address: Vec::new(), called: None };
        let call = view.candidates.iter().find(|c| !c.page).map(|c| c.index).expect("the search call is a candidate");
        assert_eq!(agreed(&walks, &view, &url, "search for items", &again), Some(call));
        assert_eq!(agreed(&walks, &view_of("lost", &url, &site, &first, 0), &url, "search for items", &again), None, "a walk the node no longer holds agrees with nothing");
        let names = |said: &str| with_a_proposer(&format!("cat >/dev/null; echo '{said}'"), || proposed_answer(&walks, &view, &url, "search for items", &again));
        assert_eq!(names(&format!("{{\"answer\":\"a:{call}\"}}")), Some(call));
        assert_eq!(names("{\"answer\":\"a:41\"}"), None, "a call the first walk never made");
        assert_eq!(names("no idea"), None);
        assert_eq!(with_a_proposer("", || proposed_answer(&walks, &view, &url, "search for items", &again)), None, "no proposer, no answer");
    }

    /// With no walk of the page kept there is no second walk and no proposer is asked; with the walk kept, the
    /// proposer is asked for the word, and a door that has just refused the walk's browser is not walked again for it.
    #[test]
    fn a_second_walk_needs_a_walk_and_a_word_and_a_door_that_lets_it() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let dir = std::env::temp_dir().join(format!("second-walk-{}-{}", std::process::id(), store::now()));
        std::fs::create_dir_all(&dir).unwrap();
        let asked_mark = dir.join("asked");
        let program = format!("cat >/dev/null; touch '{}'; echo '{{\"second_word\":\"kettle\"}}'", asked_mark.display());
        let walks = Walks::default();
        let (url, first) = page_with_search("closed-door.example", "lamp");
        assert!(with_a_proposer(&program, || second_walk(&walks, "one", &url, "g", "w", "You", &[])).is_none(), "no walk held");
        assert!(!asked_mark.exists(), "no walk, no proposer asked");
        walks.0.locked().insert("one".into(), walk_of(&first, &url));
        REFUSED.locked().insert(site_of("closed-door.example"), std::time::Instant::now());
        let found = with_a_proposer(&program, || second_walk(&walks, "one", &url, "g", "w", "You", &[]));
        REFUSED.locked().remove(&site_of("closed-door.example"));
        assert!(found.is_none(), "a rested door is not walked again");
        assert!(asked_mark.exists(), "the proposer was asked for the word");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The words the records of an answer share beside the asked one are offered after the page's own links, and a
    /// route that writes is never asked a word.
    #[test]
    fn the_words_the_records_share_are_offered_and_a_write_is_never_asked() {
        let url = "https://shop.example/s?q=lamp";
        let answer = serde_json::json!({ "results": [{ "name": "Brass lamp shade" }, { "name": "Glass lamp shade" }, { "name": "Tall lamp shade" }, { "name": "Wall lamp stand" }] });
        let trace = Trace { exchanges: vec![seen("GET", url, "<html></html>", true), seen("GET", "https://shop.example/api/s?q=lamp", &answer.to_string(), false)], inputs: Vec::new() };
        assert_eq!(offered_words(&trace, url, &["lamp".to_string()]), ["shade"]);
        assert!(offered_without_records(&trace, url, &["lamp".to_string()]).is_empty());
        let mut route = search_route(1, "/api/search", "q");
        route.write = true;
        let mut hears = |_: &unbrowse_learn::Graph, _: &HashMap<String, String>| Some(records_for("kettle"));
        assert_eq!(says_back(&route, &["lamp".to_string()], "kettle", &mut hears), None);
        route.write = false;
        assert_eq!(says_back(&route, &["lamp".to_string()], "kettle", &mut hears), Some(true));
    }

    /// The site is asked for the pieces of a path one at a time over plain HTTP: the piece with no page without it is
    /// its address, and the value is named for the word before it.
    #[test]
    fn the_pieces_of_a_path_are_told_apart_by_asking_the_site() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let port = a_site(|target| (if target.starts_with("/search/") { 200 } else { 404 }, "{}".to_string()));
        let url = format!("http://127.0.0.1:{port}/search/lamp/");
        let in_path = vec![("part0".to_string(), "search".to_string()), ("part1".to_string(), "lamp".to_string())];
        assert_eq!(callers_own(&url, in_path, Some("Mozilla/5.0 test")), vec![("search".to_string(), "lamp".to_string())]);
        // A site that answers every address alike says nothing: both pieces stay the caller's.
        let any = a_site(|_| (200, "{}".to_string()));
        let url = format!("http://127.0.0.1:{any}/search/lamp/");
        let in_path = vec![("part0".to_string(), "search".to_string()), ("part1".to_string(), "lamp".to_string())];
        assert_eq!(callers_own(&url, in_path.clone(), None), in_path);
    }

    /// A route that answers the second word is marked as having said it back; one that does not, with the walk of
    /// that call agreed, stands unverified; and with no second walk nothing is asked at all.
    #[test]
    fn a_route_is_held_to_the_second_word_the_page_was_walked_for() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let walks = Walks::default();
        let (other_url, second) = page_with_search("held.example", "kettle");
        let site = site_of("held.example");
        let again = Second { word: "kettle".into(), url: other_url.clone(), view: view_of("two", &other_url, &site, &second, 0), address: Vec::new(), called: None };
        let page = "http://127.0.0.1:1/s?q=lamp".to_string();
        let hears = a_site(says_the_word);
        let route = search_route(hears, "/api/search", "q");
        let (stood, said) = with_another_word(&walks, route.clone(), &page, "search", "You", &[], None, false, false);
        assert_eq!((said, stood.heard.said_back), (false, None), "no second walk, nothing asked");
        let (stood, said) = with_another_word(&walks, route.clone(), &page, "search", "You", &[], Some(&again), false, false);
        assert!(said && stood.heard.probed, "the site answers the word");
        assert_eq!(stood.heard.said_back.as_deref(), Some("kettle"));
        assert_eq!(store::load_route(&route.id).and_then(|r| r.heard.said_back).as_deref(), Some("kettle"), "and the route kept says so");
        // The answer a page of the other word made, a strip that says the same for any word: the route does not hear.
        let deaf_site = a_site(|_| (200, r#"{"items":[{"name":"Garden chair"},{"name":"Desk fan"}]}"#.to_string()));
        let deaf = search_route(deaf_site, "/api/strip", "q");
        let (stood, said) = with_another_word(&walks, deaf.clone(), &page, "search", "You", &[], Some(&again), false, true);
        assert!(!said && stood.heard.said_back.is_none() && stood.id == deaf.id, "walked on this very call: the route stands, unverified");
        let (stood, said) = with_another_word(&walks, deaf.clone(), &page, "search", "You", &[], Some(&again), false, false);
        assert!(!said && stood.id == deaf.id, "no walk of the page's own call is held: the route stands");
        // The page's own call is no better a proof than the page: the walk of the other word was never kept.
        let (stood, said) = with_another_word(&walks, route.clone(), &page, "search", "You", &[], Some(&again), true, false);
        assert!(said && stood.id == route.id, "no call of the other word's walk to take its place");
    }

    /// A route that does not answer the second word gives way to the call the page made for it, when the site
    /// answers that call for the first word too and the answers differ.
    #[test]
    fn a_route_that_does_not_hear_gives_way_to_the_call_the_page_made() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let ear = a_site(says_the_word);
        let deaf_site = a_site(|_| (200, r#"{"items":[{"name":"Garden chair"},{"name":"Desk fan"}]}"#.to_string()));
        let (url, other_url) = (format!("http://127.0.0.1:{ear}/s?q=lamp"), format!("http://127.0.0.1:{ear}/s?q=kettle"));
        let list = |word: &str| records_for(word).to_string();
        let second = Trace { exchanges: vec![seen("GET", &other_url, "<html><body>results</body></html>", true), seen("GET", &format!("http://127.0.0.1:{ear}/api/find?term=kettle"), &list("kettle"), false)], inputs: Vec::new() };
        let walks = Walks::default();
        walks.0.locked().insert("two".into(), walk_of(&second, &other_url));
        let again = Second { word: "kettle".into(), url: other_url.clone(), view: view_of("two", &other_url, "127.0.0.1", &second, 0), address: Vec::new(), called: None };
        let deaf = search_route(deaf_site, "/api/strip", "q");
        let (stood, said) = with_another_word(&walks, deaf.clone(), &url, "search", "You", &[], Some(&again), true, false);
        assert!(said, "the page's other call answers both words");
        assert_ne!(stood.id, deaf.id, "the call the page made took the deaf route's place");
        assert_eq!(stood.heard.said_back.as_deref(), Some("lamp"), "kept for the page that was asked");
        assert!(stood.inputs.iter().all(|i| i.default.as_deref() != Some("kettle")), "its default is the page's word, not the experiment's");
    }

    /// Where the only call the page made for the second word is the route's own call, it is no other call's turn: the
    /// route that answered the word stands, said back, and nothing is put in its place.
    #[test]
    fn the_call_the_route_already_is_is_not_taken_for_another_call() {
        let _old = crate::learn::own_asks::as_the_old_node();
        let ear = a_site(says_the_word);
        let (url, other_url) = (format!("http://127.0.0.1:{ear}/s?q=lamp"), format!("http://127.0.0.1:{ear}/s?q=kettle"));
        let second = Trace { exchanges: vec![seen("GET", &other_url, "<html><body>results</body></html>", true), seen("GET", &format!("http://127.0.0.1:{ear}/api/own?term=kettle"), &records_for("kettle").to_string(), false)], inputs: Vec::new() };
        let walks = Walks::default();
        walks.0.locked().insert("two".into(), walk_of(&second, &other_url));
        let again = Second { word: "kettle".into(), url: other_url.clone(), view: view_of("two", &other_url, "127.0.0.1", &second, 0), address: Vec::new(), called: None };
        let route = search_route(ear, "/api/own", "term");
        let (stood, said) = with_another_word(&walks, route.clone(), &url, "search", "You", &[], Some(&again), true, false);
        assert!(said, "the route answers the word");
        assert_eq!((stood.id.as_str(), stood.heard.said_back.as_deref()), (route.id.as_str(), Some("kettle")), "the route stands, as it heard the word");
        assert_eq!(store::load_route(&route.id).and_then(|r| r.heard.said_back).as_deref(), Some("kettle"));
    }
}
