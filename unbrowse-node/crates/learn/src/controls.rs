//! What a page offers its reader, read from the page alone. A server-rendered list says in its own markup which values
//! it takes: the form that asks for it, and the links that narrow it, order it or turn its page. Each is the same
//! address with one value changed, so a route learned on the page can take those values with nothing clicked.
//!
//! No word for "filter" or "next" is read. A form that sends to this page, and links that differ from it in one query
//! key, say what they are by where they go.

use std::collections::BTreeMap;

use scraper::{ElementRef, Html, Selector};
use url::Url;

use crate::paging::Paging;

/// The most keys and the most values of one key a route keeps: a page's whole taxonomy is no one's input list.
const MOST_KEYS: usize = 12;
const MOST_VALUES: usize = 40;

/// One value a page offers for a key, and the words it shows it with.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Choice {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// What the page offers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Controls {
    /// Query keys the page takes, with the values it offers: none for a box the reader types into.
    pub keys: BTreeMap<String, Vec<Choice>>,
    pub paging: Option<Paging>,
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}

fn same_page(a: &Url, b: &Url) -> bool {
    a.host_str() == b.host_str() && a.path().trim_end_matches('/') == b.path().trim_end_matches('/')
}

/// The one query key `link` sets differently from `page`, and its value: it keeps every other value the page has.
fn one_change(page: &Url, link: &Url) -> Option<(String, String)> {
    let here: BTreeMap<String, String> = page.query_pairs().into_owned().collect();
    let there: BTreeMap<String, String> = link.query_pairs().into_owned().collect();
    if here.keys().any(|k| !there.contains_key(k)) {
        return None;
    }
    let mut changed = there.into_iter().filter(|(k, v)| here.get(k) != Some(v));
    let one = changed.next()?;
    changed.next().is_none().then_some(one)
}

/// The one numbered query value `link` sets differently from `page`.
fn numbered_change(page: &Url, link: &Url) -> Option<(String, String)> {
    let here: BTreeMap<String, String> = page.query_pairs().into_owned().collect();
    let mut numbers = link.query_pairs().into_owned().filter(|(k, v)| here.get(k) != Some(v) && v.parse::<u64>().is_ok());
    let one = numbers.next()?;
    numbers.next().is_none().then_some(one)
}

fn add(keys: &mut BTreeMap<String, Vec<Choice>>, key: &str, choice: Choice) {
    let values = keys.entry(key.to_string()).or_default();
    if values.len() < MOST_VALUES && !values.iter().any(|c| c.value == choice.value) {
        values.push(choice);
    }
}

/// The label a form control shows: the `label` naming it or holding it.
fn label_of(doc: &Html, control: &ElementRef) -> Option<String> {
    let id = control.value().attr("id");
    let named = id.and_then(|id| doc.select(&sel("label[for]")).find(|l| l.value().attr("for") == Some(id)));
    let holding = control.ancestors().filter_map(ElementRef::wrap).find(|a| a.value().name() == "label");
    named.or(holding).map(|l| squash(&l.text().collect::<String>())).filter(|t| !t.is_empty())
}

/// The pieces of `page`'s path its own form says are an address: a GET form on the page that submits to this very
/// path, or to one the page's path begins with, writes those pieces itself and puts what its reader types in its
/// fields (`<form action="/search" method="get">` on `/search?q=lasagna`). A piece the form writes is never the
/// caller's value, whatever else on the page hands the same word on. Lowercased; empty when no form says so.
pub fn form_address_pieces(html: &str, page: &Url) -> Vec<String> {
    let doc = Html::parse_document(html);
    let pieces = |u: &Url| -> Vec<String> { u.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(|p| p.to_lowercase()).collect()).unwrap_or_default() };
    let here = pieces(page);
    let mut out: Vec<String> = Vec::new();
    for form in doc.select(&sel("form[action]")) {
        if !form.value().attr("method").unwrap_or("get").eq_ignore_ascii_case("get") {
            continue;
        }
        let Some(to) = form.value().attr("action").filter(|a| !a.is_empty()).and_then(|a| page.join(a).ok()) else { continue };
        let there = pieces(&to);
        if to.host_str() != page.host_str() || there.is_empty() || there.len() > here.len() || here[..there.len()] != there[..] {
            continue;
        }
        // A form with nothing to type into sends no value of its reader's: it says nothing of where values go.
        if form.select(&sel("input[name], select[name], textarea[name]")).next().is_none() {
            continue;
        }
        for piece in there {
            if !out.contains(&piece) {
                out.push(piece);
            }
        }
    }
    out
}

/// The pieces of `page`'s path its own links say are where the site lives: a piece that most of the page's links to
/// its own host carry in the same place (`/en/` on a page whose menus, footer and results all begin `/en/`). A value
/// the page was asked sits in its own address and in few of its links: the menus go elsewhere without it. Only
/// where the page links to enough of its own site to say so. Lowercased, with each piece's place.
pub fn link_address_pieces(html: &str, page: &Url) -> Vec<(usize, String)> {
    const ENOUGH_LINKS: usize = 12;
    let doc = Html::parse_document(html);
    let pieces = |u: &Url| -> Vec<String> { u.path_segments().map(|s| s.filter(|p| !p.is_empty()).map(|p| p.to_lowercase()).collect()).unwrap_or_default() };
    let here = pieces(page);
    let links: Vec<Vec<String>> = doc
        .select(&sel("a[href]"))
        .filter_map(|a| a.value().attr("href").and_then(|h| page.join(h).ok()))
        .filter(|to| to.host_str() == page.host_str() && to.path() != page.path() && to.path() != "/")
        .map(|to| pieces(&to))
        .collect();
    if links.len() < ENOUGH_LINKS {
        return Vec::new();
    }
    here.iter()
        .enumerate()
        .filter(|(at, piece)| links.iter().filter(|l| l.get(*at) == Some(*piece)).count() * 5 >= links.len() * 4)
        .map(|(at, piece)| (at, piece.clone()))
        .collect()
}

/// Reads what the form sending to this page takes. Only a GET form asks for a page: a POST changes something.
fn forms(doc: &Html, page: &Url, keys: &mut BTreeMap<String, Vec<Choice>>) {
    for form in doc.select(&sel("form")) {
        let method = form.value().attr("method").unwrap_or("get");
        let to = form.value().attr("action").filter(|a| !a.is_empty()).and_then(|a| page.join(a).ok()).unwrap_or_else(|| page.clone());
        if !method.eq_ignore_ascii_case("get") || !same_page(&to, page) {
            continue;
        }
        for control in form.select(&sel("select[name], input[name]")) {
            let (el, name) = (control.value(), control.value().attr("name").unwrap_or_default());
            if name.is_empty() {
                continue;
            }
            if el.name() == "select" {
                for option in control.select(&sel("option")) {
                    let shown = squash(&option.text().collect::<String>());
                    let value = option.value().attr("value").map(String::from).unwrap_or_else(|| shown.clone());
                    if !value.is_empty() {
                        add(keys, name, Choice { value, label: (!shown.is_empty()).then_some(shown) });
                    }
                }
                continue;
            }
            match el.attr("type").unwrap_or("text").to_ascii_lowercase().as_str() {
                "checkbox" | "radio" => {
                    let value = el.attr("value").unwrap_or("on").to_string();
                    add(keys, name, Choice { value, label: label_of(doc, &control) });
                }
                "text" | "search" | "number" | "date" | "month" | "week" | "tel" | "range" => {
                    keys.entry(name.to_string()).or_default();
                }
                // A hidden field is the form's own, a password or a file is never a query's, a button says nothing.
                _ => {}
            }
        }
    }
}

/// The step between the numbers a page's links go to, when they are a list's pages: the nearest is one step on from
/// where this page stands, and the next one step on from that. A link that says its own value in its words names a
/// choice ("Under 50" for `max=50`): an offset's link shows the page it reaches ("3" for `start=48`), never the offset.
fn pager(values: &[Choice], at: Option<u64>) -> Option<u64> {
    let mut numbers: Vec<u64> = values.iter().filter_map(|c| c.value.parse().ok()).collect();
    numbers.sort_unstable();
    numbers.dedup();
    // A list that names its first page links back to it even from there: unnumbered, this page is page 1.
    let at = at.or_else(|| numbers.contains(&1).then_some(1));
    let ahead: Vec<u64> = numbers.into_iter().filter(|n| at.is_none_or(|a| *n > a)).collect();
    let near = *ahead.first()?;
    // One link alone is a pager only as the very next page: 2 from an unnumbered first page, or one on from this one.
    let step = match ahead.get(1) {
        Some(then) => then - near,
        None => 1,
    };
    let start = at.unwrap_or(if step == 1 { 1 } else { 0 });
    let says_its_value = |c: &Choice| c.label.as_deref().is_some_and(|l| l.contains(c.value.as_str()));
    (near == start + step && (step == 1 || !values.iter().any(says_its_value))).then_some(step)
}

/// What `html`, the page at `page`, offers.
pub fn read(html: &str, page: &Url) -> Controls {
    let doc = Html::parse_document(html);
    let mut offered = Controls::default();
    forms(&doc, page, &mut offered.keys);
    let mut linked: BTreeMap<String, Vec<Choice>> = BTreeMap::new();
    let mut next: Option<(String, String)> = None;
    for a in doc.select(&sel("a[href], link[rel~=next][href]")) {
        let Some(link) = a.value().attr("href").and_then(|h| page.join(h).ok()) else { continue };
        if !same_page(page, &link) {
            continue;
        }
        // The page's own word for its next page may carry the list's defaults along (`&order=relevance`): the number
        // among what it changes is the one that turns the page.
        if a.value().attr("rel").is_some_and(|r| r.split_whitespace().any(|w| w.eq_ignore_ascii_case("next"))) {
            next = next.or(numbered_change(page, &link));
        }
        let Some((key, value)) = one_change(page, &link) else { continue };
        let label = squash(&a.text().collect::<String>());
        add(&mut linked, &key, Choice { value, label: (!label.is_empty()).then_some(label) });
    }
    let at = |key: &str| page.query_pairs().find(|(k, _)| k == key).and_then(|(_, v)| v.parse::<u64>().ok());
    // The page's own word for what comes next, else a run of numbers on one key.
    let by_rel = next.and_then(|(key, value)| {
        let n = value.parse::<u64>().ok()?;
        let start = at(&key);
        let step = match start {
            Some(a) => n.checked_sub(a).filter(|s| *s > 0)?,
            None if n == 2 => 1,
            None => n,
        };
        Some(Paging::Count { input: key, step })
    });
    offered.paging = by_rel.or_else(|| linked.iter().find_map(|(key, values)| pager(values, at(key)).map(|step| Paging::Count { input: key.clone(), step })));
    let paged = offered.paging.as_ref().map(|p| p.input().to_string());
    // One link sets a value by chance (a language, a campaign); several on one key are a list of what it can be.
    for (key, values) in linked {
        if Some(&key) != paged.as_ref() && values.len() >= 2 {
            for c in values {
                add(&mut offered.keys, &key, c);
            }
        }
    }
    if let Some(key) = &paged {
        offered.keys.remove(key);
    }
    while offered.keys.len() > MOST_KEYS {
        // The keys with the most to say stay: a box is the first to go, then the shortest list.
        let Some(least) = offered.keys.iter().min_by_key(|(_, v)| v.len()).map(|(k, _)| k.clone()) else { break };
        offered.keys.remove(&least);
    }
    offered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(u: &str) -> Url {
        Url::parse(u).unwrap()
    }

    fn values(c: &Controls, key: &str) -> Vec<String> {
        c.keys[key].iter().map(|c| c.value.clone()).collect()
    }

    /// The form that asks for this list says what it takes, with the words it shows them in.
    #[test]
    fn a_form_sending_to_the_page_says_what_it_takes() {
        let c = read(
            r#"<form action="/search" method="get"><input name="q" type="search">
            <select name="sort"><option value="">Best match</option><option value="price">Price</option><option>Newest</option></select>
            <label><input type="checkbox" name="used" value="1"> Used only</label>
            <input type="radio" id="r1" name="ship" value="free"><label for="r1">Free shipping</label>
            <input type="hidden" name="token" value="abc"><input type="password" name="pw"><button name="go">Go</button></form>"#,
            &page("https://shop.example/search?q=lamp"),
        );
        assert_eq!(values(&c, "sort"), ["price", "Newest"]);
        assert_eq!(c.keys["sort"][0].label.as_deref(), Some("Price"));
        assert_eq!(c.keys["used"][0], Choice { value: "1".into(), label: Some("Used only".into()) });
        assert_eq!(c.keys["ship"][0].label.as_deref(), Some("Free shipping"));
        assert!(c.keys["q"].is_empty(), "a box takes what's typed");
        assert!(!c.keys.contains_key("token") && !c.keys.contains_key("pw") && !c.keys.contains_key("go"));
    }

    /// A form that changes something, or that asks for another page, offers nothing here.
    #[test]
    fn a_post_or_another_pages_form_offers_nothing() {
        let c = read(
            r#"<form method="post"><select name="plan"><option value="a">A</option></select></form>
            <form action="/newsletter"><select name="topic"><option value="x">X</option></select></form>"#,
            &page("https://shop.example/search"),
        );
        assert!(c.keys.is_empty());
    }

    /// Links that are this page with one value changed narrow it, and several on one key are a list of what it can be.
    #[test]
    fn links_that_change_one_value_are_what_it_can_be() {
        let c = read(
            r#"<a href="?q=lamp&color=red">Red</a><a href="/search?q=lamp&color=blue">Blue</a>
            <a href="?q=lamp&lang=fr">Français</a><a href="?other=1">Elsewhere</a><a href="/about?color=red">About</a>
            <a href="?q=lamp&color=red&size=m">Both at once</a>"#,
            &page("https://shop.example/search?q=lamp"),
        );
        assert_eq!(values(&c, "color"), ["red", "blue"]);
        assert_eq!(c.keys["color"][0].label.as_deref(), Some("Red"));
        assert!(!c.keys.contains_key("lang"), "one link is no list");
        assert!(!c.keys.contains_key("other"), "it drops the page's own value");
    }

    /// A run of numbers on one key is a pager, whatever the key's called and whatever the links say.
    #[test]
    fn a_run_of_numbers_is_a_pager() {
        let c = read(r#"<a href="?q=lamp&pg=2">2</a><a href="?q=lamp&pg=3">3</a><a href="?q=lamp&pg=4">→</a>"#, &page("https://shop.example/s?q=lamp"));
        assert_eq!(c.paging, Some(Paging::Count { input: "pg".into(), step: 1 }));
        assert!(!c.keys.contains_key("pg"), "the pager isn't a filter too");
        let c = read(r#"<a href="?start=48">3</a><a href="?start=72">4</a><a href="?start=0">1</a>"#, &page("https://shop.example/s?start=24"));
        assert_eq!(c.paging, Some(Paging::Count { input: "start".into(), step: 24 }));
    }

    /// Numbers that aren't one step on from here aren't this list's pages: a price range, a year.
    #[test]
    fn numbers_that_dont_follow_on_are_choices() {
        let c = read(r#"<a href="?max=50">Under 50</a><a href="?max=100">Under 100</a>"#, &page("https://shop.example/s"));
        assert_eq!(c.paging, None);
        assert_eq!(values(&c, "max"), ["50", "100"]);
    }

    /// The page's own word for its next page settles it, with one link or a `link` in its head.
    #[test]
    fn rel_next_names_the_pager() {
        let c = read(r#"<head><link rel="next" href="?page=3"></head>"#, &page("https://shop.example/s?page=2"));
        assert_eq!(c.paging, Some(Paging::Count { input: "page".into(), step: 1 }));
    }

    /// A next link that also spells out the list's defaults still turns the page by one number.
    #[test]
    fn rel_next_may_carry_the_lists_defaults() {
        let c = read(r#"<a rel="next" href="/search?q=lamp&order=relevance&page=2">Next</a>"#, &page("https://shop.example/search?q=lamp"));
        assert_eq!(c.paging, Some(Paging::Count { input: "page".into(), step: 1 }));
    }

    /// A long list may show only its next page: one link, one on from here.
    #[test]
    fn one_link_to_the_very_next_page_is_a_pager() {
        let c = read(r#"<a href="?keywords=tax&page=2">Next 2 of 634</a>"#, &page("https://gov.example/search?keywords=tax"));
        assert_eq!(c.paging, Some(Paging::Count { input: "page".into(), step: 1 }));
        let c = read(r#"<a href="?keywords=tax&page=6">Next</a>"#, &page("https://gov.example/search?keywords=tax&page=5"));
        assert_eq!(c.paging, Some(Paging::Count { input: "page".into(), step: 1 }));
        let c = read(r#"<a href="?keywords=tax&page=9">Last</a>"#, &page("https://gov.example/search?keywords=tax"));
        assert_eq!(c.paging, None, "a far page says nothing of the step");
    }

    /// A pager that links to page 1 from page 1, unnumbered in the address, is still one step on from there.
    #[test]
    fn a_pager_may_name_the_first_page() {
        let c = read(r#"<a href="?page=1">&lt;</a><a href="?page=2">2</a><a href="?page=3">3</a>"#, &page("https://shop.example/products"));
        assert_eq!(c.paging, Some(Paging::Count { input: "page".into(), step: 1 }));
        assert!(!c.keys.contains_key("page"));
    }

    #[test]
    fn a_taxonomy_is_cut_down() {
        let links: String = (0..30).map(|k| format!(r#"<a href="?k{k}=a">a</a><a href="?k{k}=b">b</a>"#)).collect();
        assert_eq!(read(&links, &page("https://shop.example/s")).keys.len(), MOST_KEYS);
    }
    /// The walk that exposed it: a recipe site's `/search?q=lasagna`, whose route offered the word `search` to its
    /// caller as a value because a call on the page sent the same word. The page's own form submits to `/search` and
    /// takes what is typed in its field: the form writes that piece, so it is the address.
    #[test]
    fn a_piece_the_pages_own_form_submits_to_is_the_address() {
        let page: Url = "https://www.recipes.example/search?q=lasagna".parse().unwrap();
        let html = r#"<form role="search" action="/search" method="get"><input name="q"></form><form action="/newsletter" method="post"><input name="email"></form>"#;
        assert_eq!(form_address_pieces(html, &page), vec!["search".to_string()]);
        // A form to another page, one that posts, and one with no field say nothing of this page's path.
        let other: Url = "https://www.recipes.example/recipes/lasagna".parse().unwrap();
        assert!(form_address_pieces(html, &other).is_empty());
        assert!(form_address_pieces(r#"<form action="/search" method="post"><input name="q"></form>"#, &page).is_empty());
        assert!(form_address_pieces(r#"<form action="/search"><button>Go</button></form>"#, &page).is_empty());
        // A path that goes on past the form's address keeps the rest for the caller.
        let deeper: Url = "https://shop.example/search/lamps".parse().unwrap();
        assert_eq!(form_address_pieces(r#"<form action="/search"><input name="q"></form>"#, &deeper), vec!["search".to_string()]);
    }

    /// The walk that exposed it: a hotel site's `/en/search/?query=paris`, whose language piece was taken for one of
    /// the caller's words. The second walk put its word there too, asked for `/tokyo/search/?query=tokyo`, and met the
    /// site's door. Every link on the page begins `/en/`: that piece is where the site lives. A searched word in the
    /// path is in the page's own address and few of its links.
    #[test]
    fn a_piece_the_pages_own_links_all_carry_is_where_the_site_lives() {
        let menu: String = (0..20).map(|i| format!(r#"<a href="/en/hotels/place-{i}/">Place {i}</a>"#)).collect();
        let page: Url = "https://www.stay.example/en/search/?query=paris".parse().unwrap();
        assert_eq!(link_address_pieces(&format!("<nav>{menu}</nav><a href='/en/search/?query=paris&page=2'>Next</a>"), &page), vec![(0, "en".to_string())]);
        // A shop's search word in its path: the menus go elsewhere without it.
        let shop: Url = "https://shop.example/search/lamps/".parse().unwrap();
        let aisles: String = (0..20).map(|i| format!(r#"<a href="/aisle/{i}/">Aisle {i}</a>"#)).collect();
        let pages: String = (2..5).map(|i| format!(r#"<a href="/search/lamps/?page={i}">{i}</a>"#)).collect();
        assert!(link_address_pieces(&format!("{aisles}{pages}"), &shop).is_empty());
        // Too few links say nothing.
        assert!(link_address_pieces(r#"<a href="/en/a">a</a><a href="/en/b">b</a>"#, &page).is_empty());
    }

}
