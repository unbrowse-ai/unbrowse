//! Every sighting of one call, across the walks of a learn.

use std::collections::HashMap;

use crate::trace::{Exchange, Trace};

/// One walk of a page, and what was true when it was made.
pub struct Walk<'a> {
    pub trace: &'a Trace,
    /// What the page was asked, by name: the same names on every walk of one page.
    pub asked: Vec<(String, String)>,
    /// Which session walked. Two walks of one learn share a session: they differ in what was asked and in the
    /// time, and a value that is the same on both may still be that session's alone.
    pub session: u32,
}

/// What the session held when `walk` made the call at `at`, as a node's jar holds it: each cookie the call sent, and
/// each header it sent that the session keeps (`graph::a_session_header`), under the header's name. The jar a lab's
/// caller is given to call a body for that walk.
#[cfg(test)]
pub fn jar_of(walk: &Walk, at: usize) -> std::collections::HashMap<String, String> {
    let Some(e) = walk.trace.exchanges.get(at) else { return Default::default() };
    let mut jar: std::collections::HashMap<String, String> = e.cookies().into_iter().collect();
    for (name, value) in &e.request_headers {
        if crate::graph::a_session_header(walk.trace, at, name, value, e.url.host_str()) {
            jar.insert(name.to_ascii_lowercase(), value.clone());
        }
    }
    jar
}

impl Walk<'_> {
    fn words(&self) -> Vec<&str> {
        self.asked.iter().map(|(_, v)| v.as_str()).collect()
    }
}

/// What a second walk of a page was asked, under the names the first walk was asked by (`asked`): the first walk's
/// page is at `first`, the second's at `second`. A name the second address asks by itself (`trace::asked_pairs`)
/// takes the value it asks there. A value that is a piece of the first address's path (`slots::piece_holds`: as it
/// is, or written the way a form writes it, or inside marks the site puts around it, `/search/chicken-`) takes the
/// piece at the same place in the second, read the same way. Anything else was asked the same on both.
pub fn asked_again(first: &url::Url, asked: &[(String, String)], second: &url::Url) -> Vec<(String, String)> {
    let theirs = crate::trace::asked_pairs(second);
    let pieces = |u: &url::Url| -> Vec<String> { u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default() };
    let (ours, again) = (pieces(first), pieces(second));
    asked
        .iter()
        .map(|(name, value)| {
            if let Some((_, v)) = theirs.iter().find(|(k, _)| k == name) {
                return (name.clone(), v.clone());
            }
            let found = ours.iter().enumerate().find_map(|(at, piece)| piece_again(piece, value, again.get(at)?));
            (name.clone(), found.unwrap_or_else(|| value.clone()))
        })
        .collect()
}

/// One place two addresses of one page differ at: where (`route::AskedAt`), the marks the page wrapped the value in
/// on both (what is neither a letter nor a digit at either end, the same on both: `chicken-`, `pasta-`), and what
/// stands inside them on each.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Apart {
    pub at: crate::route::AskedAt,
    pub before: String,
    pub first: String,
    pub second: String,
    pub after: String,
}

impl Apart {
    /// The first address's value at the place, marks and all.
    pub fn first_whole(&self) -> String {
        format!("{}{}{}", self.before, self.first, self.after)
    }

    /// The second address's value at the place, marks and all.
    pub fn second_whole(&self) -> String {
        format!("{}{}{}", self.before, self.second, self.after)
    }
}

/// The marks around a piece's word: what is neither a letter nor a digit at its start, the word, and the same at its
/// end. A piece of marks alone is all word.
pub fn within_marks(piece: &str) -> (&str, &str, &str) {
    let core = piece.trim_matches(|c: char| !c.is_alphanumeric());
    if core.is_empty() {
        return ("", piece, "");
    }
    let start = piece.find(core).unwrap_or(0);
    (&piece[..start], core, &piece[start + core.len()..])
}

/// What two addresses of one page were asked: every place they differ at, in the path at the same place (where both
/// have as many pieces), in the query under the same key, and in a fragment written as a query (`trace::asked_pairs`)
/// under the same key. A place where either is empty, or that one of them lacks, is not compared. Whoever chose the
/// two values chose them apart, so whatever differs is asked, and a place the same on both is the page's own,
/// whatever one walk would read it as. Where the page wraps the value in marks of its own and both have the same
/// marks, the value asked is what stands inside them.
pub fn apart(first: &url::Url, second: &url::Url) -> Vec<Apart> {
    use crate::route::AskedAt;
    let mut out = Vec::new();
    let mut differ = |at: AskedAt, x: &str, y: &str| {
        if x == y || x.is_empty() || y.is_empty() {
            return;
        }
        let ((xb, _, xa), (yb, _, ya)) = (within_marks(x), within_marks(y));
        let (before, after) = if xb == yb && xa == ya { (xb, xa) } else { ("", "") };
        let inside = |v: &str| v[before.len()..v.len() - after.len()].to_string();
        out.push(Apart { at, before: before.to_string(), first: inside(x), second: inside(y), after: after.to_string() });
    };
    let pieces = |u: &url::Url| -> Vec<String> { u.path_segments().map(|s| s.map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned()).collect()).unwrap_or_default() };
    let (pa, pb) = (pieces(first), pieces(second));
    if pa.len() == pb.len() {
        pa.iter().zip(&pb).enumerate().for_each(|(i, (x, y))| differ(AskedAt::Path(i), x, y));
    }
    let query = |u: &url::Url| -> Vec<(String, String)> { u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect() };
    let (qa, qb) = (query(first), query(second));
    for (k, x) in &qa {
        if let Some((_, y)) = qb.iter().find(|(key, _)| key == k) {
            differ(AskedAt::Query(k.clone()), x, y);
        }
    }
    // The fragment's pairs, read as `asked_pairs` reads them: a key the query holds is the query's.
    let fragment = |u: &url::Url, query: &[(String, String)]| -> Vec<(String, String)> {
        let Some((_, held)) = u.fragment().and_then(crate::route::fragment_pairs) else { return Vec::new() };
        let named = |k: &str| !k.is_empty() && k.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '[' | ']'));
        let mut out: Vec<(String, String)> = Vec::new();
        for (k, v) in url::form_urlencoded::parse(held.as_bytes()) {
            if named(&k) && !query.iter().any(|(have, _)| *have == k) && !out.iter().any(|(have, _)| *have == k) {
                out.push((k.into_owned(), v.into_owned()));
            }
        }
        out
    };
    let (fa, fb) = (fragment(first, &qa), fragment(second, &qb));
    for (k, x) in &fa {
        if let Some((_, y)) = fb.iter().find(|(key, _)| key == k) {
            differ(AskedAt::Fragment(k.clone()), x, y);
        }
    }
    out
}

/// Where `piece` of the first address holds `value`, the value its counterpart `there` holds in the same way: the
/// whole piece, the piece read the way a form writes a value (`slots::plus_spaced`), or what stands inside the same
/// marks the site put around it in the first. None when `piece` does not hold `value`.
fn piece_again(piece: &str, value: &str, there: &str) -> Option<String> {
    let read = |held: &str, there: &str| -> Option<String> {
        if held.eq_ignore_ascii_case(value) {
            Some(there.to_string())
        } else if crate::slots::piece_holds(held, value) {
            Some(crate::slots::plus_spaced(there).unwrap_or_else(|| there.to_string()))
        } else {
            None
        }
    };
    if let Some(found) = read(piece, there) {
        return Some(found);
    }
    // The site's marks around the word: what is not a letter or a digit at either end of the piece.
    let (before, core, after) = within_marks(piece);
    if core == piece {
        return None;
    }
    let inside = there.strip_prefix(before).and_then(|t| t.strip_suffix(after)).unwrap_or_else(|| within_marks(there).1);
    read(core, inside)
}

/// What differed between the walks a value was seen on. The time always did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Axes {
    /// What the page was asked.
    pub word: bool,
    /// The session that walked.
    pub session: bool,
}

/// What differed between `walks`, taken together.
pub fn axes(walks: &[Walk]) -> Axes {
    let Some(first) = walks.first() else { return Axes::default() };
    Axes { word: walks.iter().any(|w| w.asked != first.asked), session: walks.iter().any(|w| w.session != first.session) }
}

/// A call's method, host and path, with what its walk was asked struck out of the path: the same call made for
/// another value (`/search/chicken-`, `/search/pasta-`) has the same place.
pub fn place(e: &Exchange, asked: &[&str]) -> String {
    let path = percent_encoding::percent_decode_str(e.url.path()).decode_utf8_lossy().to_lowercase();
    let path = asked.iter().filter(|v| v.chars().count() >= 2).fold(path, |p, v| p.replace(&v.to_lowercase(), "\u{a7}"));
    format!("{} {}{}", e.method, e.url.host_str().unwrap_or_default(), path)
}

/// Where `other` made each call `first` made, by its place in each walk: the one reader of "the same call on another
/// walk" (`graph::align_by`, which the classifier asks too), asked with what `first` was asked, a call [`answered`] with
/// something paired first. A call pairs with the call of the other walk at the same address, but for pieces of the
/// path that hold what the first walk was asked, that sends the most of the same values; each call of the other walk
/// pairs once. A value one walk sent otherwise is that call's own value made otherwise, whatever it reads as, never
/// another call.
pub fn pairs(first: &Walk, other: &Walk) -> HashMap<usize, usize> {
    crate::graph::align_by(first.trace, other.trace, &first.words(), answered)
}

/// Whether a walk's call was answered with something: a 2xx whose reply is not empty, and not a page that runs code
/// and says nothing (`page::a_door`). A walk often asks once and is answered on its second try (a page held back, then
/// served): the copy that answered pairs before the copy that answered nothing. Whether what it answered is a route's
/// answer is the judges' to say, later.
pub fn answered(e: &Exchange) -> bool {
    let body = e.response_body.as_deref().unwrap_or_default();
    (200..300).contains(&e.status) && !body.trim().is_empty() && !(e.is_main_document() && crate::page::a_door(e.status, body, &e.url))
}

/// Whether `b` is the call `a` made again within one walk, for its next page or with a filter set, or the page asking
/// twice: the same method and address (host and path), the same query keys, and the same value wherever both bodies
/// hold, at their top, one that reads as a name (letters, no digits: a GraphQL `operationName`), the caller's own
/// values (`asked`) aside. A cursor, or a filter's choice (a query's `sort=price`, a body's variables) may differ;
/// another method at the same address (`method=photos.search` with its own keys, beside `tags.getRelated`) is another
/// call. A later page may add the cursor or session token the previous answer handed it (`feedSessionId`, `next`): a
/// key one of them sends and the other not, whose value is no word, does not tell them apart; one whose value is a
/// word does.
///
/// The node's `learn.rs` holds the same reading (`same_operation`, which its callers hold to one address themselves),
/// and is the copy to point at this one when `app/` is next touched. Two walks' calls are paired by another question,
/// [`pairs`].
pub fn made_again(a: &Exchange, b: &Exchange, asked: &[&str]) -> bool {
    if a.method != b.method || a.url.host_str() != b.url.host_str() || a.url.path() != b.url.path() {
        return false;
    }
    let name = |v: &str| !v.is_empty() && v.chars().any(char::is_alphabetic) && !v.chars().any(|c| c.is_ascii_digit()) && !asked.contains(&v);
    let query = |e: &Exchange| e.url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect::<std::collections::BTreeMap<_, _>>();
    let (qa, qb) = (query(a), query(b));
    if qa.keys().ne(qb.keys()) {
        // Two operations at one address name themselves in a common key: a word that differs there is another call.
        if qa.iter().any(|(k, v)| qb.get(k).is_some_and(|w| v != w && name(v) && name(w))) {
            return false;
        }
        let only = |x: &std::collections::BTreeMap<String, String>, y: &std::collections::BTreeMap<String, String>| x.iter().filter(|(k, _)| !y.contains_key(*k)).all(|(_, v)| !name(v));
        if !(only(&qa, &qb) && only(&qb, &qa)) {
            return false;
        }
    }
    let json = |e: &Exchange| e.request_body.as_deref().and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok());
    match (json(a), json(b)) {
        (Some(serde_json::Value::Object(ja)), Some(serde_json::Value::Object(jb))) => {
            !ja.iter().any(|(k, va)| matches!((va, jb.get(k)), (serde_json::Value::String(x), Some(serde_json::Value::String(y))) if name(x) && name(y) && x != y))
        }
        _ => true,
    }
}

/// Where each walk made the call the first walk made at `at` ([`pairs`]): `at` itself for the first. None for a
/// walk that never made it.
pub fn sightings(walks: &[Walk], at: usize) -> Vec<Option<usize>> {
    let Some(first) = walks.first() else { return Vec::new() };
    if first.trace.exchanges.get(at).is_none() {
        return vec![None; walks.len()];
    }
    std::iter::once(Some(at)).chain(walks[1..].iter().map(|w| pairs(first, w).get(&at).copied())).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// What two addresses of one page differ by, place by place: a path piece at the same place, a query value under
    /// the same key, a fragment's value read as a query is; inside the page's own marks where both carry the same.
    /// What is the same on both, or on one only, is not there.
    #[test]
    fn what_two_addresses_of_one_page_differ_by_is_what_was_asked() {
        use crate::route::AskedAt;
        let at = |a: &str, b: &str| apart(&a.parse().unwrap(), &b.parse().unwrap());
        let found = at("https://a.example/search/chicken-?tab=all&page=1", "https://a.example/search/pasta-?tab=all&sort=new");
        assert_eq!(found, vec![Apart { at: AskedAt::Path(1), before: String::new(), first: "chicken".into(), second: "pasta".into(), after: "-".into() }]);
        assert_eq!(found[0].first_whole(), "chicken-");
        let found = at("https://a.example/find#/search?q=bonds", "https://a.example/find#/search?q=gilts");
        assert_eq!(found.iter().map(|d| (&d.at, d.first.as_str())).collect::<Vec<_>>(), [(&AskedAt::Fragment("q".into()), "bonds")]);
        // Marks that differ are not the page's: the value is asked whole.
        let found = at("https://a.example/s?q=lamp", "https://a.example/s?q=%22desk%20lamp%22");
        assert_eq!((found[0].first.as_str(), found[0].second.as_str()), ("lamp", "\"desk lamp\""));
        assert!(at("https://a.example/s/a/b", "https://a.example/s/a").is_empty(), "pieces at no common place are not compared");
    }

    pub(crate) fn call(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&str>, reply: &str) -> Exchange {
        Exchange {
            method: method.into(),
            url: url.parse().unwrap(),
            request_headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            request_body: body.map(String::from),
            status: 200,
            response_headers: vec![("date".into(), "Wed, 11 Nov 2026 12:00:00 GMT".into())],
            response_body: Some(reply.into()),
            response_mime: "application/json".into(),
            resource_type: Some("XHR".into()),
            main_frame: None,
        }
    }

    pub(crate) fn trace(exchanges: Vec<Exchange>) -> Trace {
        Trace { exchanges, inputs: vec![] }
    }

    pub(crate) fn walk<'a>(trace: &'a Trace, asked: &[(&str, &str)]) -> Walk<'a> {
        Walk { trace, asked: asked.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), session: 1 }
    }

    /// A value of several words written into a path with a mark for each space (`desk-lamp`, `red_sofa`) is the
    /// value: the two walks' calls are one call. What the first walk's piece is decides; the other walk's piece is
    /// whatever its page was asked.
    #[test]
    fn a_value_written_into_a_path_with_a_mark_for_each_space_is_the_value() {
        let first = trace(vec![call("GET", "https://shop.example/find/desk-lamp/all", &[], None, "{}")]);
        for piece in ["red-sofa", "red_sofa", "Red-Sofa"] {
            let second = trace(vec![call("GET", &format!("https://shop.example/find/{piece}/all"), &[], None, "{}")]);
            assert_eq!(sightings(&[walk(&first, &[("q", "desk lamp")]), walk(&second, &[("q", "red sofa")])], 0), [Some(0), Some(0)], "{piece}");
        }
        let other = trace(vec![call("GET", "https://shop.example/find/sofas-red/all", &[], None, "{}")]);
        assert_eq!(sightings(&[walk(&first, &[("q", "desk lamp")]), walk(&other, &[("q", "red sofa")])], 0), [Some(0), Some(0)], "the first walk's piece is its word, whatever the second's is");
    }

    /// The same call is found again in a walk for another value, though its path holds the value and another
    /// operation shares its address.
    #[test]
    fn a_call_is_found_again_in_a_walk_for_another_word() {
        let gql = |op: &str, word: &str| call("POST", "https://shop.example/graphql", &[], Some(&format!(r#"{{"operationName":"{op}","variables":{{"q":"{word}"}}}}"#)), "{}");
        let first = trace(vec![gql("Menu", "x"), gql("Search", "lamp"), call("GET", "https://shop.example/find/lamp-/all", &[], None, "{}")]);
        let second = trace(vec![call("GET", "https://shop.example/find/desk-/all", &[], None, "{}"), gql("Search", "desk"), gql("Menu", "x")]);
        let walks = [walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])];
        assert_eq!(sightings(&walks, 1), [Some(1), Some(1)], "the search, not the menu at the same address");
        assert_eq!(sightings(&walks, 2), [Some(2), Some(0)], "the word in the path is struck out of the place");
        assert_eq!(sightings(&walks, 0), [Some(0), Some(2)]);
        let alone = trace(vec![call("GET", "https://shop.example/other", &[], None, "{}")]);
        assert_eq!(sightings(&[walk(&first, &[("q", "lamp")]), walk(&alone, &[("q", "desk")])], 1), [Some(1), None]);
    }

    /// A value that holds what the page was asked (the page's own address, sent along with the call) does not keep
    /// the call from being found again on a walk for another word. Nor does a value that reads as a name and was sent
    /// otherwise (`kind=related`): by the one reader, that is the call's own value sent otherwise, not another call.
    /// The name rule this replaced said the second walk never made the call.
    #[test]
    fn a_value_that_holds_the_word_does_not_keep_a_call_from_being_found_again() {
        let resource = |word: &str| call("GET", &format!("https://pins.example/resource/get/?source_url=%2Fsearch%2Fpins%2F%3Fq%3D{word}%26rs%3Dtyped&kind=search"), &[], None, "{}");
        let (first, second) = (trace(vec![resource("garden")]), trace(vec![resource("coffee")]));
        assert_eq!(sightings(&[walk(&first, &[("q", "garden")]), walk(&second, &[("q", "coffee")])], 0), [Some(0), Some(0)]);
        let other = trace(vec![call("GET", "https://pins.example/resource/get/?source_url=%2Fsearch%2Fpins%2F%3Fq%3Dcoffee%26rs%3Dtyped&kind=related", &[], None, "{}")]);
        assert_eq!(sightings(&[walk(&first, &[("q", "garden")]), walk(&other, &[("q", "coffee")])], 0), [Some(0), Some(0)]);
    }

    /// The classifier's own case (`graph::a_value_the_second_walk_sent_otherwise_is_never_a_constant`): two walks of
    /// one call that send a signature all of letters, and a kind, otherwise, and a mode alike. It is one call, made
    /// again: its sighting is found, and the values it sent otherwise are not the call's fixed text.
    #[test]
    fn a_value_the_second_walk_sent_otherwise_is_the_calls_own_value_made_otherwise() {
        let order = |sig: &str, kind: &str| call("POST", "https://shop.example/api/order", &[("x-sig", sig)], Some(&format!(r#"{{"kind":"{kind}","mode":"Express"}}"#)), r#"{"ok":true}"#);
        let (first, second) = (trace(vec![order("bfcdebca", "parcel")]), trace(vec![order("dacefbbe", "letter")]));
        let walks = [walk(&first, &[]), walk(&second, &[])];
        assert_eq!(sightings(&walks, 0), [Some(0), Some(0)]);
        let holes = crate::lab::synth::Lab::new(&walks).holes(0);
        let kind = |loc: crate::slots::Loc| holes.iter().find(|h| h.at == loc).map(|h| h.kind).unwrap();
        use crate::lab::synth::Kind;
        assert_ne!(kind(crate::slots::Loc::Header("x-sig".into())), Kind::Fixed);
        assert_ne!(kind(crate::slots::Loc::Json("/kind".into())), Kind::Fixed);
        assert_eq!(kind(crate::slots::Loc::Json("/mode".into())), Kind::Fixed);
    }

    /// A walk that asked a page twice and was answered with nothing the first time (an empty reply, a page that runs
    /// code and says nothing): the copy that answered pairs with the other walk's, though the empty copy sent the same
    /// and came first. The empty copy pairs with whatever the other walk has left: here, nothing.
    #[test]
    fn a_copy_answered_with_nothing_is_no_sighting_of_the_call() {
        let page = |word: &str, body: &str| {
            let mut e = call("GET", &format!("https://shop.example/s?k={word}"), &[], None, body);
            e.resource_type = Some("Document".into());
            e.main_frame = Some(true);
            e.response_mime = "text/html".into();
            e
        };
        let results = |word: &str| format!("<html><body><h1>Results for {word}</h1><ul><li><a href='/p/1'>{word} one</a></li><li><a href='/p/2'>{word} two</a></li></ul></body></html>");
        let first = trace(vec![page("lamp", ""), page("lamp", &results("lamp"))]);
        let second = trace(vec![page("desk", &results("desk"))]);
        let walks = [walk(&first, &[("k", "lamp")]), walk(&second, &[("k", "desk")])];
        assert_eq!(sightings(&walks, 1), [Some(1), Some(0)], "the copy that answered");
        assert_eq!(sightings(&walks, 0), [Some(0), None], "the copy that answered nothing pairs with nothing");
    }

    /// Where a walk made the call more than once, the sighting is the one that sends the most of what the first
    /// walk sent, and the earliest of those: a later repeat is the next page.
    #[test]
    fn of_a_calls_repeats_the_one_most_like_the_first_walks_is_its_sighting() {
        let page = |word: &str, n: &str| call("GET", &format!("https://shop.example/api/search?q={word}&page={n}&size=20"), &[], None, "{}");
        let first = trace(vec![page("lamp", "1")]);
        let second = trace(vec![page("desk", "2"), page("desk", "1"), page("desk", "1")]);
        assert_eq!(sightings(&[walk(&first, &[("q", "lamp")]), walk(&second, &[("q", "desk")])], 0), [Some(0), Some(1)]);
    }

    /// A call a walk makes again is one call: its next page, adding the cursor its previous answer handed it, or the
    /// page asking twice, the same request. A filter's word, another method at one address, another operation's name
    /// in the body: another call. (The node's `same_operation` cases.)
    #[test]
    fn a_call_made_again_within_a_walk_is_one_call() {
        let get = |u: &str| call("GET", u, &[], None, "{}");
        let first = get("https://shop.example/api/search?query=lamp&page=0");
        assert!(made_again(&first, &get("https://shop.example/api/search?query=lamp&page=1&feedSessionId=8f14e45f"), &["lamp"]), "the later page is the same call");
        assert!(made_again(&first, &get("https://shop.example/api/search?query=lamp&page=0"), &["lamp"]), "the page asking twice");
        assert!(!made_again(&first, &get("https://shop.example/api/search?query=lamp&page=0&sort=relevance"), &["lamp"]), "a filter's word is another operation");
        assert!(!made_again(&first, &get("https://shop.example/api/other?query=lamp&page=0"), &["lamp"]), "another address");
        let tags = get("https://api.photos.example/services/rest?tag=lighthouse&method=photos.tags.getRelated&format=json");
        let photos = get("https://api.photos.example/services/rest?text=lighthouse&method=photos.photos.search&format=json&page=1");
        let page2 = get("https://api.photos.example/services/rest?text=lighthouse&method=photos.photos.search&format=json&page=2");
        assert!(!made_again(&tags, &photos, &["lighthouse"]) && made_again(&photos, &page2, &["lighthouse"]), "another method at one address is no repeat");
        let gql = |op: &str| call("POST", "https://shop.example/graphql", &[], Some(&format!(r#"{{"operationName":"{op}","variables":{{"q":"lamp","page":2}}}}"#)), "{}");
        assert!(!made_again(&gql("Search"), &gql("Menu"), &["lamp"]) && made_again(&gql("Search"), &gql("Search"), &["lamp"]), "an operation's name in the body");
    }

    fn url(u: &str) -> url::Url {
        u.parse().unwrap()
    }

    fn named(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// A name the second address asks by itself takes the value it asks there, in its query or in a fragment written
    /// as one, whatever the first walk was asked under it.
    #[test]
    fn a_name_the_second_address_asks_takes_its_value_there() {
        let asked = named(&[("q", "brass"), ("adults", "2")]);
        assert_eq!(asked_again(&url("https://a.example/s?q=brass&adults=2"), &asked, &url("https://a.example/s?q=glass&adults=3")), named(&[("q", "glass"), ("adults", "3")]));
        assert_eq!(asked_again(&url("https://a.example/find#q=brass"), &named(&[("q", "brass")]), &url("https://a.example/find#q=desk%20lamp")), named(&[("q", "desk lamp")]));
    }

    /// A word that is a piece of the first address's path takes the piece at the same place in the second, read the
    /// same way: as it is, or with a space for each plus where the first was written so.
    #[test]
    fn a_word_in_the_path_takes_the_piece_at_the_same_place_in_the_second() {
        let asked = named(&[("word", "iphone 15")]);
        assert_eq!(asked_again(&url("https://a.example/search/iphone%2015/"), &asked, &url("https://a.example/search/macbook%20air/")), named(&[("word", "macbook air")]));
        let asked = named(&[("word", "coffee shops")]);
        assert_eq!(asked_again(&url("https://maps.example/maps/search/coffee+shops/"), &asked, &url("https://maps.example/maps/search/tea+rooms/")), named(&[("word", "tea rooms")]));
    }

    /// A word inside marks the site puts around it in its path is read inside the same marks in the second address.
    #[test]
    fn a_word_inside_the_sites_marks_in_the_path_is_read_inside_the_same_marks() {
        let asked = named(&[("word", "chicken")]);
        assert_eq!(asked_again(&url("https://recipes.example/search/chicken-"), &asked, &url("https://recipes.example/search/pasta-")), named(&[("word", "pasta")]));
        let asked = named(&[("word", "lamp")]);
        assert_eq!(asked_again(&url("https://shop.example/c/-lamp-/all"), &asked, &url("https://shop.example/c/-desk%20fan-/all")), named(&[("word", "desk fan")]));
    }

    /// What the second address does not ask by name and does not hold where the first held it was asked the same.
    #[test]
    fn a_value_the_second_address_does_not_ask_was_asked_the_same() {
        let asked = named(&[("q", "brass"), ("currency", "SGD")]);
        assert_eq!(asked_again(&url("https://a.example/s?q=brass"), &asked, &url("https://a.example/s?q=glass")), named(&[("q", "glass"), ("currency", "SGD")]));
        // A path shorter than the first's holds no piece at the word's place.
        assert_eq!(asked_again(&url("https://a.example/search/brass"), &named(&[("word", "brass")]), &url("https://a.example/search")), named(&[("word", "brass")]));
    }

    #[test]
    fn what_differed_between_walks_is_said_and_never_assumed() {
        let t = trace(vec![]);
        let same = [walk(&t, &[("q", "lamp")]), walk(&t, &[("q", "lamp")])];
        assert_eq!(axes(&same), Axes { word: false, session: false });
        let words = [walk(&t, &[("q", "lamp")]), walk(&t, &[("q", "desk")])];
        assert_eq!(axes(&words), Axes { word: true, session: false }, "two walks of one learn share a session");
        let sessions = [walk(&t, &[("q", "lamp")]), Walk { session: 2, ..walk(&t, &[("q", "lamp")]) }];
        assert_eq!(axes(&sessions), Axes { word: false, session: true });
    }
}
