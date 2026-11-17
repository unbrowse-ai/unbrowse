//! A page as an answer. When a route's target is the site's page rather than a data call (the site renders its
//! results into the HTML), the replay answers with what the page carries: its title, the state its own scripts were
//! handed (`__NEXT_DATA__`, `application/json` scripts, `window.__context__ = {…}`), its readable text and its links.
//! Nothing here knows any one site: it reads the shapes pages use to ship their data.

use scraper::{Html, Selector};
use serde_json::{json, Value};

/// How much readable text an answer carries; the state is the data, the text is for reading.
const TEXT_LIMIT: usize = 20_000;
const LINK_LIMIT: usize = 150;

/// Whether a body is an HTML page rather than data.
pub fn is_html(body: &str) -> bool {
    let head = body.trim_start().get(..512).unwrap_or(body.trim_start()).to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html") || head.contains("<head")
}

/// Whether an answer is markup to read as a page: a whole document, or a piece of one the site serves as HTML (a
/// results list a script drops into the page). Learning and calling read an answer by this same test, so a call kept
/// for what its HTML holds is read the same way when it is called.
pub fn is_markup(content_type: &str, body: &str) -> bool {
    let ct = content_type.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
    is_html(body) || (matches!(ct.as_str(), "text/html" | "application/xhtml+xml") && body.trim_start().starts_with('<'))
}

/// The page, read: `{ title, state, text, links }`. `state` is the largest JSON object the page embeds for its own
/// scripts, or null when it embeds none or the one it embeds doesn't hold what the page shows (`holds_the_page`):
/// then the page's answer is what it renders, its text and its links.
///
/// A page is read once: every question a learn asks of the walk's page (does it answer like the goal, does it fail
/// one, what does the call's answer hold) reads the same body, and parsing a large page took most of the node's own
/// time before its first reply (seven reads of one 350 KB page). The last few pages read are kept, by their bytes and
/// address, so a second read of one is a copy.
pub fn read(body: &str, base: &url::Url) -> Value {
    use std::hash::{Hash, Hasher};
    static READ: std::sync::Mutex<Vec<(u64, Value)>> = std::sync::Mutex::new(Vec::new());
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (body.len(), body, base.as_str()).hash(&mut h);
    let key = h.finish();
    if let Some((_, v)) = READ.lock().ok().and_then(|kept| kept.iter().find(|(k, _)| *k == key).cloned()) {
        return v;
    }
    let v = read_once(body, base);
    if let Ok(mut kept) = READ.lock() {
        if kept.len() >= PAGES_KEPT {
            kept.remove(0);
        }
        kept.push((key, v.clone()));
    }
    v
}

/// How many pages [`read`] keeps read: a learn's page, its second look's and a few the try opened.
const PAGES_KEPT: usize = 8;

#[cfg(test)]
thread_local! {
    /// The pages this thread has parsed, for a test to count.
    static PARSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn read_once(body: &str, base: &url::Url) -> Value {
    #[cfg(test)]
    PARSES.with(|n| n.set(n.get() + 1));
    let doc = Html::parse_document(body);
    let sel = |s: &str| Selector::parse(s).expect("static selector");
    let title = doc.select(&sel("title")).next().map(|t| squash(&t.text().collect::<String>())).unwrap_or_default();

    let mut states: Vec<(usize, Value)> = Vec::new();
    for script in doc.select(&sel("script")) {
        let kind = script.value().attr("type").unwrap_or_default().to_ascii_lowercase();
        let src = script.text().collect::<String>();
        if kind.contains("json") {
            if let Ok(v) = serde_json::from_str::<Value>(src.trim()) {
                states.push((src.len(), v));
            }
        } else if kind.is_empty() || kind.contains("javascript") {
            states.extend(assigned_objects(&src));
        }
    }
    states.extend(attribute_states(&doc));
    let state = states.into_iter().filter(|(_, v)| v.is_object() || v.is_array()).max_by_key(|(n, _)| *n).map(|(_, v)| v);

    // The page's chrome is not its answer: a search's results sit below a header's menu and a footer's links, and a
    // menu of a hundred labels would spend the text budget before the results are reached (Food Network's search
    // answered with its own navigation). Scripts and styles were already out; nav, header, footer and aside go too.
    let skipped = chrome(&doc, CHROME);
    let text_under = |root: scraper::ElementRef<'_>| {
        let mut text = String::new();
        for node in root.descendants() {
            if skipped.contains(&node.id()) {
                continue;
            }
            if let Some(t) = node.value().as_text() {
                let t = squash(t);
                if !t.is_empty() {
                    text.push_str(&t);
                    text.push('\n');
                }
            }
            if text.len() > TEXT_LIMIT {
                break;
            }
        }
        text
    };
    // The page's own content first: a search's results live in its main region, and a header's menu (a hundred links
    // and labels) would spend the whole text budget before the results are reached. `main`, its ARIA role, the ids
    // pages use for it, or an article; the body when a page names none. A region is the page's main one for what it
    // holds, not for its name: one that sits in the page's chrome or reads nothing (a "skip to main content" link,
    // a header called `navbar-main`) is passed over, or a page full of results would read as empty.
    let (main, mut text) = main_region(&doc, &skipped).map(|e| (Some(e.id()), text_under(e))).unwrap_or((None, String::new()));
    if main.is_none() {
        if let Some(body) = doc.select(&sel("body")).next() {
            text = text_under(body);
        }
    }

    let mut links = Vec::new();
    // The content region's own links before the page's: a search's results are its main region's anchors, and a menu's
    // hundred links would fill the budget first.
    let mut anchors: Vec<_> = doc.select(&sel("a[href]")).collect();
    if let Some(id) = main {
        anchors.sort_by_key(|a| if a.ancestors().any(|n| n.id() == id) { 0 } else { 1 });
    }
    for a in anchors {
        // A chrome link (a menu's, a footer's) is not a result.
        if skipped.contains(&a.id()) {
            continue;
        }
        // What the link says, never what styles or scripts it: a card drawn as a component carries its stylesheet
        // inside the anchor, and that is no part of its name.
        let label = squash(&a.descendants().filter(|n| !skipped.contains(&n.id())).filter_map(|n| n.value().as_text().map(|t| t.to_string())).collect::<Vec<_>>().join(" "));
        let Some(href) = a.value().attr("href").and_then(|h| base.join(h).ok()) else { continue };
        if label.is_empty() || !matches!(href.scheme(), "http" | "https") {
            continue;
        }
        links.push(json!({ "text": label, "url": href.as_str() }));
        if links.len() >= LINK_LIMIT {
            break;
        }
    }
    let text = text.trim_end();
    let state = state.filter(|v| holds_the_page(v, text));
    json!({ "title": title, "state": state, "text": text, "links": links })
}

/// What frames a page rather than says it: its scripts and styles, and the navigation, header, footer and asides
/// every page of the site repeats.
const CHROME: &str = "script, style, noscript, template, svg, nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]";

/// The page's controls: what a reader works rather than reads (a form's fields, their labels, its buttons).
const CONTROLS: &str = "label, option, select, button, textarea, input";

/// The elements a page sets its text in blocks of: one block is one thing it says (a line of a result, a heading).
const BLOCKS: [&str; 26] = ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "th", "dd", "dt", "div", "section", "article", "tr", "ul", "ol", "table", "main", "figure", "figcaption", "blockquote", "pre", "dl", "form"];

/// Every node under an element `selector` names.
fn chrome(doc: &Html, selector: &str) -> std::collections::HashSet<ego_tree::NodeId> {
    let sel = Selector::parse(selector).expect("static selector");
    doc.select(&sel).flat_map(|e| e.descendants().map(|n| n.id())).collect()
}

/// The page's main region: `main`, its ARIA role, the ids pages use for it, or an article, the first that sits outside
/// the page's chrome (`skipped`) and reads something. None when the page names none.
fn main_region<'d>(doc: &'d Html, skipped: &std::collections::HashSet<ego_tree::NodeId>) -> Option<scraper::ElementRef<'d>> {
    let sel = Selector::parse("main, [role=main], #main, #content, #main-content, [id*=main], article").expect("static selector");
    doc.select(&sel).filter(|e| !skipped.contains(&e.id())).find(|e| e.descendants().any(|n| !skipped.contains(&n.id()) && n.value().as_text().is_some_and(|t| !t.trim().is_empty())))
}

/// Whether a page, as served, says nothing but the ask back: in its content (its main region where it marks one,
/// else its body; never its chrome, nor its controls) every block of text is a heading or says back a value it was
/// asked (`asked`, three characters or more), one or two blocks say it back (a value named at [`crate::shown::RECORDS`]
/// places or more is listed), and no link stands as a thing of its own: each sits inside a heading's words (`Filter by
/// <a>category</a>`). A results page sets each record in a block of its own, a line or a card, most often a link; a
/// page that found nothing for the value says so, naming it, under its headings, and links only from its frame. So
/// the page is judged by how it is built, never by the words it uses to say it found nothing.
pub fn says_only_the_ask(body: &str, asked: &[&str]) -> bool {
    let asked: Vec<String> = asked.iter().map(|a| squash(a).to_lowercase()).filter(|a| a.chars().count() >= 3).collect();
    if asked.is_empty() || !is_html(body) {
        return false;
    }
    let doc = Html::parse_document(body);
    let skipped = chrome(&doc, CHROME);
    let controls = chrome(&doc, CONTROLS);
    let hidden = |id: ego_tree::NodeId| skipped.contains(&id) || controls.contains(&id);
    let Some(region) = main_region(&doc, &skipped).or_else(|| doc.select(&Selector::parse("body").expect("static selector")).next()) else { return false };
    let is = |n: &ego_tree::NodeRef<'_, scraper::Node>, names: &[&str]| n.value().as_element().is_some_and(|e| names.contains(&e.name()));
    const HEADINGS: [&str; 6] = ["h1", "h2", "h3", "h4", "h5", "h6"];
    // The block a node's text belongs to (the region itself at the top), and whether it sits in a heading.
    let block_of = |n: ego_tree::NodeRef<'_, scraper::Node>| n.ancestors().take_while(|a| a.id() != region.id()).find(|a| is(a, &BLOCKS)).map_or(region.id(), |a| a.id());
    let in_heading = |n: ego_tree::NodeRef<'_, scraper::Node>| n.ancestors().take_while(|a| a.id() != region.id()).any(|a| is(&a, &HEADINGS)) || is(&region, &HEADINGS);
    let mut blocks: Vec<(ego_tree::NodeId, String, bool)> = Vec::new();
    let mut at_block: std::collections::HashMap<ego_tree::NodeId, usize> = std::collections::HashMap::new();
    for n in region.descendants().filter(|n| !hidden(n.id())) {
        let Some(t) = n.value().as_text() else { continue };
        let at = block_of(n);
        match at_block.get(&at) {
            Some(&i) => {
                blocks[i].1.push(' ');
                blocks[i].1.push_str(t);
            }
            None => {
                at_block.insert(at, blocks.len());
                blocks.push((at, t.to_string(), in_heading(n)));
            }
        }
    }
    let blocks_read: Vec<String> = blocks.iter().map(|(_, t, _)| squash(t).to_lowercase()).collect();
    let blocks: Vec<(String, bool)> = blocks_read.iter().zip(&blocks).map(|(t, (_, _, h))| (t.clone(), *h)).filter(|(t, _)| t.chars().any(char::is_alphanumeric)).collect();
    let says_back = |t: &str| asked.iter().any(|a| t.contains(a.as_str()));
    let anchor = Selector::parse("a[href]").expect("static selector");
    let a_record = region.select(&anchor).filter(|a| !hidden(a.id())).any(|a| {
        let label = squash(&a.descendants().filter(|n| !hidden(n.id())).filter_map(|n| n.value().as_text().map(|t| t.to_string())).collect::<Vec<_>>().join(" ")).to_lowercase();
        let whole = at_block.get(&block_of(*a)).map(|&i| blocks_read[i].as_str()).unwrap_or_default();
        !label.is_empty() && (!in_heading(*a) || a.descendants().skip(1).any(|n| is(&n, &BLOCKS)) || label == whole)
    });
    let echoes = blocks.iter().filter(|(t, _)| says_back(t)).count();
    !a_record && (1..crate::shown::RECORDS).contains(&echoes) && blocks.iter().all(|(t, heading)| *heading || says_back(t))
}

/// The fewest words a page's text must have for its state to be judged against it: an app shell's text ("Loading…")
/// says nothing of what its scripts will show, and its state is all there is.
const JUDGED_WORDS: usize = 60;

/// Whether a page's embedded state holds what the page shows: at least half its readable text, line by line, by
/// length, is among the state's own values. A state that holds the page (a framework's page props) says the same
/// names, titles and figures the page renders; one that holds a phrasebook, flags and settings (an i18n bundle, a
/// navigation's config) shares only the labels around the content, never the content, and answering with it would
/// answer with everything but what the page shows. A page whose text is too short to judge keeps its state.
pub fn holds_the_page(state: &Value, text: &str) -> bool {
    if text.split_whitespace().count() < JUDGED_WORDS {
        return true;
    }
    let mut values = Vec::new();
    strings(state, &mut values, 0);
    let values: Vec<String> = values.into_iter().map(|v| v.to_lowercase()).collect();
    let whole: std::collections::HashSet<&str> = values.iter().map(String::as_str).collect();
    let joined = values.join("\n");
    let mut lines: Vec<String> = text.lines().map(|l| squash(l).to_lowercase()).filter(|l| l.chars().any(char::is_alphanumeric)).collect();
    lines.sort();
    lines.dedup();
    let all: usize = lines.iter().map(|l| l.len()).sum();
    // A line is held as a value of its own, or inside a longer one (a sentence of a description); a short line is
    // looked for whole only, since any text holds a number or a short word somewhere.
    let held: usize = lines.iter().filter(|l| whole.contains(l.as_str()) || (l.len() >= 8 && joined.contains(l.as_str()))).map(|l| l.len()).sum();
    held * 2 >= all
}

/// Every text and number in a JSON value, as text.
fn strings(v: &Value, out: &mut Vec<String>, depth: usize) {
    if depth > 64 {
        return;
    }
    match v {
        Value::Object(m) => m.values().for_each(|x| strings(x, out, depth + 1)),
        Value::Array(a) => a.iter().for_each(|x| strings(x, out, depth + 1)),
        Value::String(s) => out.push(squash(s)),
        Value::Number(n) => out.push(n.to_string()),
        _ => {}
    }
}

/// The page's headings, in its main part where it marks one, the first few, in order.
pub fn headings(body: &str) -> Vec<String> {
    let doc = Html::parse_document(body);
    let read = |selector: &str| -> Vec<String> {
        let selector = Selector::parse(selector).expect("static selector");
        doc.select(&selector).map(|h| h.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ")).filter(|t| !t.is_empty()).take(4).collect()
    };
    let main = read("main h1, main h2, main h3");
    if main.is_empty() { read("h1, h2") } else { main }
}

/// A page's answer, as a route that targets it answers: the JSON state it embeds in a `application/json` script
/// (`__NEXT_DATA__`) when that state holds what the page shows, else the page read (`read`). `true` beside it says
/// it is the page read.
pub fn answer(body: &str, base: &url::Url) -> (Value, bool) {
    answer_like(body, base, None, &[])
}

/// The same, knowing what the page was asked (`asked`, the caller's values). A page whose text never says a value it
/// was asked while its state does draws its answer from that state with its script (the results arrive as data, and
/// the page as served is their frame): the state answers, however little of the frame's text it holds.
pub fn answer_asked(body: &str, base: &url::Url, asked: &[&str]) -> (Value, bool) {
    answer_like(body, base, None, asked)
}

/// The same, for a route that recorded its answer's shape (`like`): the state blob shaped like it, which stands as
/// the answer even when it holds little of the page (a search with no results is still that search's state).
pub fn answer_like(body: &str, base: &url::Url, like: Option<&Value>, asked: &[&str]) -> (Value, bool) {
    let page = read(body, base);
    let shaped = like.filter(|l| l.as_object().is_some_and(|o| !o.is_empty()));
    let embedded = crate::trace::embedded_json_like(body, shaped).and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let like_it = |state: &Value| shaped.is_some_and(|l| crate::trace::shares_top_keys(state, l));
    let said = format!("{}\n{}", page["title"].as_str().unwrap_or_default(), page["text"].as_str().unwrap_or_default());
    let drawn_from = |state: &Value| {
        let state = state.to_string();
        asked.iter().filter(|v| v.trim().chars().count() >= 3 && !crate::slots::is_flag(v)).any(|v| crate::trace::carries_text(&state, v) && !says_most_of(&said, v))
    };
    match embedded {
        Some(state) if like_it(&state) => (state, false),
        // A reader sees the page's prices. A state that holds the page's words and none of the prices its text shows is
        // the frame the page drew them in, and the text answers.
        Some(state) if prices_only_in_text(&state, page["text"].as_str().unwrap_or_default()) => (page, true),
        Some(state) if holds_the_page(&state, page["text"].as_str().unwrap_or_default()) || drawn_from(&state) => (state, false),
        _ => (page, true),
    }
}

/// The fewest lines with a price that make a page's text a price list.
const FEWEST_PRICES: usize = 3;

/// Whether the page's text shows prices (`FEWEST_PRICES` lines that read as one) and its state holds no value that does.
fn prices_only_in_text(state: &Value, text: &str) -> bool {
    let shown = text.lines().filter(|l| crate::goal::money(l)).take(FEWEST_PRICES).count() >= FEWEST_PRICES;
    shown && !crate::slots::json_leaves(state).iter().any(|(_, v)| crate::goal::money(v))
}

/// Whether `text` says `value`, or most of its words when it is several: a page asked a sentence (`flights from SIN
/// to TYO on 2026-12-10`) answers in the parts the site read out of it, never the sentence back whole. Words under three
/// characters say nothing either way.
pub fn says_most_of(text: &str, value: &str) -> bool {
    let words: Vec<String> = value.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_lowercase).collect();
    if words.len() <= 1 {
        return crate::trace::carries_text(text, value);
    }
    let said = words.iter().filter(|w| crate::trace::carries_whole(text, w)).count();
    said * 2 >= words.len()
}

/// Whether a route that targets `ex` answers with the page read rather than a state it embeds (`answer`). A page's
/// largest JSON script is not its answer for being there: a site's menu in one would be taken for the answer on every
/// call after, whatever the page was asked.
pub fn reads_as_the_page(ex: &crate::trace::Exchange) -> bool {
    let body = ex.response_body.as_deref().unwrap_or_default();
    is_markup(ex.response_header("content-type").unwrap_or(&ex.response_mime), body) && serde_json::from_str::<Value>(body).is_err() && answer(body, &ex.url).1
}

/// The most a page read can say and still be a check rather than a page (`a_check_not_the_page`).
const A_CHECK_SAYS_AT_MOST: usize = 600;

/// Why a page read (`read`) is a check or a wall rather than the page a route answers with, if it is: it links
/// nowhere, says a few lines at most, and says none of what was asked (no value of `asked`, nor a word of one). A
/// page with results links to them; a page with none says back what found nothing ("No results for …"); a bot check
/// or an outage page does neither. Values under three characters say nothing either way and are passed over.
pub fn a_check_not_the_page(page: &Value, asked: &[&str]) -> Option<String> {
    let links = page["links"].as_array().map_or(0, Vec::len);
    let said = format!("{}\n{}", page["title"].as_str().unwrap_or_default(), page["text"].as_str().unwrap_or_default()).to_lowercase();
    let asked: Vec<String> = asked.iter().map(|v| v.trim().to_lowercase()).filter(|v| v.chars().count() >= 3).collect();
    let says_it = |v: &String| said.contains(v.as_str()) || v.split(|c: char| !c.is_alphanumeric()).any(|w| w.chars().count() >= 3 && said.contains(w));
    if links > 0 || said.chars().count() > A_CHECK_SAYS_AT_MOST || asked.is_empty() || asked.iter().any(says_it) {
        return None;
    }
    Some(format!("the site answered with a page that links nowhere and says nothing of what was asked ({} characters: {}): a check or a wall, not the page", said.chars().count(), said.trim().chars().take(80).collect::<String>().replace('\n', " ")))
}

/// Whether an answer to a request for a page at `at` is a door rather than the page: the site refused it while it
/// decides (`trace::REFUSED`), or it is a page that only waits on its own code. Such a page runs a script, leaves the
/// reader nothing to type in, says a few lines at most and links nowhere on its site: at most to whoever runs the
/// check. Read from the page itself, never from the words a vendor chose or from an address, so a door at the site's
/// own address is one, and one nobody has met yet is one too. A page with no script is a plain page however little it
/// says, and a sign-in, which asks for something, is a page of the site.
pub fn a_door(status: u16, body: &str, at: &url::Url) -> bool {
    if crate::trace::REFUSED.contains(&status) {
        return true;
    }
    if !is_html(body) {
        return false;
    }
    // Asked of the same answers again and again (the trace's door, each graph's steps, each call's check): a verdict
    // is kept, by the answer's bytes and address, so a page is parsed for it once.
    use std::hash::{Hash, Hasher};
    static SAID: std::sync::Mutex<Vec<(u64, bool)>> = std::sync::Mutex::new(Vec::new());
    let mut h = std::collections::hash_map::DefaultHasher::new();
    (body.len(), body, at.as_str()).hash(&mut h);
    let key = h.finish();
    if let Some(said) = SAID.lock().ok().and_then(|kept| kept.iter().find(|(k, _)| *k == key).map(|(_, d)| *d)) {
        return said;
    }
    let door = an_html_door(body, at);
    if let Ok(mut kept) = SAID.lock() {
        if kept.len() >= 64 {
            kept.remove(0);
        }
        kept.push((key, door));
    }
    door
}

fn an_html_door(body: &str, at: &url::Url) -> bool {
    #[cfg(test)]
    PARSES.with(|n| n.set(n.get() + 1));
    let sel = |s: &str| Selector::parse(s).expect("static selector");
    let doc = Html::parse_document(body);
    let runs_code = doc.select(&sel("script")).next().is_some();
    let asks = doc.select(&sel("input:not([type=hidden]):not([type=checkbox]), textarea, select")).next().is_some();
    let own = |h: &str| !h.starts_with('#') && at.join(h).ok().and_then(|u| u.host_str().map(String::from)).zip(at.host_str()).is_some_and(|(to, here)| crate::identity::same_site(&to, here));
    let links_home = doc.select(&sel("a[href]")).filter_map(|a| a.value().attr("href")).any(own);
    if !runs_code || asks || links_home {
        return false;
    }
    let page = read(body, at);
    format!("{}\n{}", page["title"].as_str().unwrap_or_default(), page["text"].as_str().unwrap_or_default()).chars().count() <= A_CHECK_SAYS_AT_MOST
}

/// The value a page's `<option>` showing `label` sends, when it has one.
pub fn option_value(body: &str, label: &str) -> Option<String> {
    let option = Selector::parse("option[value]").expect("static selector");
    let doc = Html::parse_document(body);
    let found = doc.select(&option).find(|o| o.text().collect::<String>().trim().eq_ignore_ascii_case(label.trim()));
    found.and_then(|o| o.value().attr("value")).filter(|v| !v.is_empty()).map(String::from)
}

/// The `content` of the page's `<meta name="…">` (or `property="…"`): a token a page states in its head and a route
/// sends as a header (an anti-forgery token, a build id). None when the page says no such thing.
pub fn meta_content(body: &str, name: &str) -> Option<String> {
    let selector = Selector::parse("meta").expect("static selector");
    let doc = Html::parse_document(body);
    doc.select(&selector)
        .find(|m| {
            let said = m.value().attr("name").or_else(|| m.value().attr("property")).unwrap_or_default();
            said.eq_ignore_ascii_case(name)
        })
        .and_then(|m| m.value().attr("content"))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
}

/// Whether a page offers `key` as a select, by the control's name or its id: what a form sends under that key is a choice
/// the page holds out, whether or not anyone moved it.
pub fn offers_a_choice(body: &str, key: &str) -> bool {    let select = Selector::parse("select").expect("static selector");
    let doc = Html::parse_document(body);
    let offered = doc.select(&select).any(|s| s.value().attr("name") == Some(key) || s.value().id() == Some(key));
    offered
}

/// Whether a page read says any of `asked`, whole or by a word of it, in its title, its text or what it links to (a list
/// of results links to its own next page with the search in the address). Values under three characters say nothing
/// either way, so a page asked only those passes.
pub fn says_any(page: &Value, asked: &[&str]) -> bool {
    let asked: Vec<String> = asked.iter().map(|v| v.trim().to_lowercase()).filter(|v| v.chars().count() >= 3).collect();
    if asked.is_empty() {
        return true;
    }
    let links = page["links"].as_array().map(|l| l.iter().map(Value::to_string).collect::<Vec<_>>().join(" ")).unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(&links).decode_utf8_lossy().into_owned();
    let said = format!("{}\n{}\n{decoded}", page["title"].as_str().unwrap_or_default(), page["text"].as_str().unwrap_or_default()).to_lowercase();
    asked.iter().any(|v| said.contains(v.as_str()) || v.split(|c: char| !c.is_alphanumeric()).any(|w| w.chars().count() >= 3 && said.contains(w)))
}

/// The fewest bytes a value must take to count as state a page handed its scripts, rather than a small setting.
const SMALLEST_STATE: usize = 64;

/// Values a script assigns whole, the way server-rendered pages hand their data to the client:
/// `window.__context__ = {…}`, `self.__STATE__=[…]`, `window["__STATE__"] = {…}`, and the same as a string the script
/// parses (`= JSON.parse("{…}")`). Each is parsed from its opening to its matching end.
fn assigned_objects(src: &str) -> Vec<(usize, Value)> {
    let mut out = Vec::new();
    let mut rest = src;
    while let Some(eq) = rest.find('=') {
        let after = rest[eq + 1..].trim_start();
        let lhs = rest[..eq].trim_end();
        let named = lhs.ends_with(']') || !lhs.rsplit(|c: char| !(c.is_alphanumeric() || c == '_' || c == '.' || c == '$')).next().unwrap_or_default().is_empty();
        if named && !lhs.ends_with(['=', '!', '<', '>']) {
            if after.starts_with(['{', '[']) {
                let mut stream = serde_json::Deserializer::from_str(after).into_iter::<Value>();
                if let Some(Ok(v)) = stream.next() {
                    let n = stream.byte_offset();
                    if n > SMALLEST_STATE {
                        out.push((n, v));
                    }
                    rest = &after[n..];
                    continue;
                }
            } else if let Some((text, n)) = after.strip_prefix("JSON.parse(").and_then(|a| string_literal(a.trim_start()).map(|(t, n)| (t, n + after.len() - a.len()))) {
                if let Some(v) = serde_json::from_str::<Value>(&text).ok().filter(|v| text.len() > SMALLEST_STATE && (v.is_object() || v.is_array())) {
                    out.push((text.len(), v));
                }
                rest = &after[n..];
                continue;
            }
        }
        rest = &rest[eq + 1..];
    }
    out
}

/// The next `n` characters as a hexadecimal number.
fn hex_digits(chars: &mut impl Iterator<Item = (usize, char)>, n: usize) -> Option<u32> {
    let digits: String = chars.take(n).map(|(_, d)| d).collect();
    (digits.len() == n).then(|| u32::from_str_radix(&digits, 16).ok()).flatten()
}

/// The JavaScript string literal `src` opens with, its escapes undone, and how many bytes of `src` it took.
fn string_literal(src: &str) -> Option<(String, usize)> {
    let quote = src.chars().next().filter(|c| matches!(c, '"' | '\'' | '`'))?;
    let mut out = String::new();
    // A `\uD83D` waiting for the `\uDE00` that completes its character.
    let mut high: Option<u32> = None;
    let mut chars = src.char_indices().skip(1).peekable();
    while let Some((at, c)) = chars.next() {
        if c == quote {
            return Some((out, at + c.len_utf8()));
        }
        if c != '\\' {
            out.push(c);
            continue;
        }
        let (_, e) = chars.next()?;
        let code = match e {
            'n' => '\n' as u32,
            't' => '\t' as u32,
            'r' => '\r' as u32,
            'b' => 8,
            'f' => 12,
            'v' => 11,
            '0' => 0,
            // A backslash before a line's end joins the lines.
            '\n' => continue,
            'x' => hex_digits(&mut chars, 2)?,
            'u' if chars.peek().is_some_and(|(_, d)| *d == '{') => {
                chars.next();
                let digits: String = chars.by_ref().map(|(_, d)| d).take_while(|d| *d != '}').collect();
                u32::from_str_radix(&digits, 16).ok()?
            }
            'u' => hex_digits(&mut chars, 4)?,
            other => other as u32,
        };
        match (high.take(), code) {
            (None, 0xD800..=0xDBFF) => high = Some(code),
            (Some(h), 0xDC00..=0xDFFF) => out.extend(char::from_u32(0x10000 + ((h - 0xD800) << 10) + (code - 0xDC00))),
            (_, code) => out.extend(char::from_u32(code)),
        }
    }
    None
}

/// JSON a page hands its scripts in an element's attribute (`<div id="app" data-page="{…}">`). Read from the
/// attribute's value alone, so no attribute is named: a value that opens as JSON and parses as it is state.
fn attribute_states(doc: &Html) -> Vec<(usize, Value)> {
    doc.root_element()
        .descendants()
        .filter_map(|n| n.value().as_element().map(|e| e.attrs().map(|(_, v)| v).collect::<Vec<_>>()))
        .flatten()
        .filter(|v| v.len() > SMALLEST_STATE && v.trim_start().starts_with(['{', '[']))
        .filter_map(|v| serde_json::from_str::<Value>(v).ok().map(|parsed| (v.len(), parsed)))
        .collect()
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Whether a document runs code of its own while it is parsed: a `<script>` with code in it (not one that only names a
/// file, and not a block of data such as JSON), an attribute that is a handler (`onload=`), a frame written inline
/// (`srcdoc`), or an address that is code (`javascript:`). Such code can run before
/// anything the document names is fetched, so nothing fetched after it is known to be the parser's.
pub fn runs_code_as_parsed(document: &str) -> bool {
    let doc = scraper::Html::parse_document(document);
    let Ok(scripts) = scraper::Selector::parse("script") else { return true };
    let code = doc.select(&scripts).any(|s| {
        let kind = s.value().attr("type").unwrap_or_default().trim().to_ascii_lowercase();
        let runs = kind.is_empty() || kind == "module" || kind.contains("javascript") || kind.contains("ecmascript");
        runs && s.value().attr("src").is_none() && !s.text().collect::<String>().trim().is_empty()
    });
    let Ok(all) = scraper::Selector::parse("*") else { return true };
    // A handler (`onload=`), a frame whose document is written inline (`srcdoc`, which may hold code of its own), or an
    // address that is code (`javascript:`) runs code too.
    code || doc.select(&all).any(|e| {
        e.value().attrs().any(|(name, value)| {
            let name = name.to_ascii_lowercase();
            (name.len() > 2 && name.starts_with("on")) || name == "srcdoc" || value.trim_start().to_ascii_lowercase().starts_with("javascript:")
        })
    })
}

#[cfg(test)]
mod tests {

    /// A document runs code as it is parsed when it holds code of its own in any form: a script with code in it, a
    /// handler, a frame written inline, an address that is code. One that only names its scripts, or holds data, doesn't.
    #[test]
    fn a_document_that_holds_code_of_its_own_runs_it_as_it_is_parsed() {
        assert!(!runs_code_as_parsed(r#"<html><head><script src="/app.js"></script><script type="application/json">{"a":1}</script></head><body></body></html>"#));
        for code in [
            "<script>var t = location.hash;</script>",
            r#"<body onload="go()"></body>"#,
            r#"<iframe srcdoc="<script>parent.x = location.hash</script>"></iframe>"#,
            r#"<iframe src="javascript:parent.go()"></iframe>"#,
        ] {
            assert!(runs_code_as_parsed(&format!("<html><body>{code}</body></html>")), "{code}");
        }
    }
    use super::*;

    /// A page asked about twice is parsed once, and the second answer is the first's; another page, or the same page at
    /// another address, is read for itself.
    #[test]
    fn a_page_is_parsed_once_however_often_it_is_read() {
        let base = url::Url::parse("https://shop.example/search?q=kettle").unwrap();
        let body = format!("<html><title>Kettles {}</title><body><main><a href='/k/1'>Kettle one</a></main></body></html>", std::process::id());
        let parses = || PARSES.with(|n| n.get());
        let before = parses();
        let first = read(&body, &base);
        let second = read(&body, &base);
        assert_eq!(first, second);
        assert_eq!(parses() - before, 1, "the second read is a copy");
        read(&body.replace("one", "two"), &base);
        read(&body, &url::Url::parse("https://other.example/search?q=kettle").unwrap());
        assert_eq!(parses() - before, 3, "another page, or another address, is read for itself");
        let door = "<html><script>check()</script><body>One moment</body></html>";
        let before = parses();
        assert_eq!(a_door(200, door, &base), a_door(200, door, &base));
        assert_eq!(parses() - before, 2, "a door's verdict is parsed for once (and its text read once)");
    }

    /// A page's main region is the one that holds its content, whatever is named like one: a "skip to main content"
    /// link and a header called `navbar-main` come first in the document and read nothing, and the results below them
    /// are still the page (Amazon Japan's search read as an empty page, so a 239-byte script stood as its answer).
    #[test]
    fn a_region_named_main_that_reads_nothing_is_not_the_main_region() {
        let body = r##"<!doctype html><html><head><title>Results</title></head><body>
            <a href="#skip" id="nav-assist-skip-to-main-content"></a>
            <header id="navbar-main"><a href="/cart">Cart</a></header>
            <div id="search"><a href="/dp/1">Steel flask 500 ml</a><span>1,980</span></div>
            <footer>About</footer></body></html>"##;
        let page = read(body, &"https://www.shop.example/s?k=flask".parse().unwrap());
        let text = page["text"].as_str().unwrap();
        assert!(text.contains("Steel flask 500 ml") && text.contains("1,980"), "{text:?}");
        assert!(!text.contains("Cart") && !text.contains("About"), "the chrome stays out: {text:?}");
        // A main region that does hold the content is still read alone.
        let body = r#"<!doctype html><html><body><div id="promo">Deals today</div><main><p>Steel flask</p></main></body></html>"#;
        let page = read(body, &"https://www.shop.example/s?k=flask".parse().unwrap());
        assert_eq!(page["text"].as_str().unwrap(), "Steel flask");
    }

    /// A search page's results are its main region's: a header's menu of a hundred links would spend the answer's text
    /// budget before the results are reached, and the page would answer with its own navigation (Food Network's
    /// server-rendered search did exactly that).
    #[test]
    fn a_pages_results_are_read_before_its_menu() {
        let menu: String = (0..120).map(|i| format!("<li><a href=\"/recipes/category-{i}\">Category {i}</a></li>")).collect();
        let body = format!(
            "<html><head><title>Search</title></head><body><nav><ul>{menu}</ul></nav><main><h1>Chicken</h1><a href=\"/recipes/chicken-piccata\">Chicken Piccata</a><p>Lemon, capers, butter.</p></main></body></html>"
        );
        let read = read(&body, &url::Url::parse("https://shop.example/search?q=chicken").unwrap());
        let text = read["text"].as_str().unwrap_or_default();
        assert!(text.contains("Chicken Piccata"), "the result is read: {}", &text[..text.len().min(160)]);
        let links = read["links"].as_array().cloned().unwrap_or_default();
        assert!(links.iter().any(|l| l["url"].as_str().is_some_and(|u| u.ends_with("/recipes/chicken-piccata"))), "its link is kept");
        assert!(links[0]["url"].as_str().is_some_and(|u| u.ends_with("/recipes/chicken-piccata")), "the result's link comes before the menu's");
    }

    /// A page whose text lists prices, embedding a state with the same words and its prices as bare numbers, answers
    /// with its text: what a reader sees. A state that writes its prices as prices is the answer, as before.
    #[test]
    fn a_state_without_the_prices_the_text_shows_is_its_frame() {
        let base = url::Url::parse("https://air.example/flights?q=sin+bkk").unwrap();
        let rows = (0..4).map(|i| format!("<li>SIN to BKK nonstop SGD {}</li>", 200 + i)).collect::<String>();
        let frame = (0..4).map(|i| format!(r#"{{"route":"SIN to BKK nonstop","fare":{}}}"#, 200 + i)).collect::<Vec<_>>().join(",");
        let html = format!(r#"<html><body><ul>{rows}</ul><script>window.__STATE__ = {{"results":[{frame}]}};</script></body></html>"#);
        let (v, is_read) = answer(&html, &base);
        assert!(is_read && v["text"].as_str().unwrap().contains("SGD 201"), "{v}");
        let text = v["text"].as_str().unwrap();
        assert!(prices_only_in_text(&serde_json::json!({"results": [{"fare": 201}, {"fare": 202}]}), text));
        assert!(!prices_only_in_text(&serde_json::json!({"results": [{"fare": "SGD 201"}]}), text), "a state that says its prices answers");
    }

    /// A page asked a sentence answers in the parts its site read out of it. Its text saying most of the sentence's
    /// words is the page answering, so the state that carries the sentence back whole is not taken over it.
    #[test]
    fn a_page_that_says_most_of_a_sentence_answers_it() {
        let base = url::Url::parse("https://air.example/flights?q=flights+from+SIN+to+TYO+one+way").unwrap();
        let html = r#"<html><head><title>Flights</title></head><body><main><h1>Flights from SIN</h1>
            <p>SIN to HND Nonstop SGD 331, one way</p><p>SIN to NRT 1 stop SGD 360</p></main>
            <script>window.__STATE__ = {"request":{"q":"flights from SIN to TYO one way","origin":"SIN"},"page":1,"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"};</script></body></html>"#;
        let (v, is_read) = answer_asked(html, &base, &["flights from SIN to TYO one way"]);
        assert!(is_read, "the text answers: {v}");
        assert!(v["text"].as_str().unwrap().contains("SGD 331"));
        assert!(says_most_of("SIN to HND, one way", "flights from SIN to TYO one way"));
        assert!(!says_most_of("Welcome to our site", "flights from SIN to TYO one way"));
        assert_eq!(says_most_of("bangkok hotels", "bangkok"), crate::trace::carries_text("bangkok hotels", "bangkok"));
    }

    #[test]
    fn reads_a_server_rendered_page() {
        let html = r#"<!DOCTYPE html><html><head><title> Search results </title></head><body>
            <nav><a href="/login">Sign in</a></nav>
            <main><h1>3 packages found</h1><p><a href="/packages/playwright">playwright</a> <b>1.56</b></p></main>
            <script>window.__context__ = {"context":{"objects":[{"package":{"name":"playwright","version":"1.56.0"}}],"total":3}}; var x = 1;</script>
            <script>console.log("a == b")</script>
            <style>.x{}</style></body></html>"#;
        let base = url::Url::parse("https://www.example.com/search?q=playwright").unwrap();
        assert!(is_html(html));
        let v = read(html, &base);
        assert_eq!(v["title"], "Search results");
        assert_eq!(v["state"]["context"]["total"], 3);
        assert_eq!(v["state"]["context"]["objects"][0]["package"]["name"], "playwright");
        assert!(v["text"].as_str().unwrap().contains("3 packages found"));
        assert!(!v["text"].as_str().unwrap().contains("console.log"));
        // The result's link, not the menu's: a page's chrome is not its answer.
        assert_eq!(v["links"][0]["url"], "https://www.example.com/packages/playwright");
        assert!(!v["links"].as_array().unwrap().iter().any(|l| l["url"] == "https://www.example.com/login"));
    }

    #[test]
    fn prefers_the_largest_embedded_state() {
        let html = r#"<html><head></head><body>
            <script type="application/ld+json">{"@type":"WebSite"}</script>
            <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[1,2,3,4,5,6,7,8,9,10,11,12]}}}</script>
            </body></html>"#;
        let v = read(html, &url::Url::parse("https://example.com/").unwrap());
        assert_eq!(v["state"]["props"]["pageProps"]["items"][11], 12);
    }

    /// A page cut from a walk (`tests/fixtures/pages`): structure and text only, its state scrubbed.
    fn fixture(name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pages").join(name)).expect("the fixture")
    }

    /// The walk that exposed it: a review site's search results, signed out. The page renders the companies found,
    /// with their ratings and counts; the biggest object its scripts are handed is the site's phrasebook (`Write a
    /// review`, `Company reviews`). Its route answered with the title and the phrasebook, never a company. The answer
    /// is what the page renders, and that is what a call of it hands back by default.
    #[test]
    fn a_page_route_answers_with_what_the_page_shows() {
        let base = url::Url::parse("https://www.glassdoor.sg/Search/results.htm?keyword=Open%20Government%20Products").unwrap();
        let (answer, read) = answer(&fixture("search-results-signed-out.html"), &base);
        assert!(read, "the page read, not its state");
        assert!(answer["state"].is_null(), "a phrasebook isn't what the page shows");
        let text = answer["text"].as_str().unwrap();
        for shown in ["Open Government Partnership", "3.8", "80", "reviews", "Senior Software Engineer, Payment Products"] {
            assert!(text.contains(shown), "{shown}");
        }
        let defaults = crate::fields::defaults(&crate::fields::paths(&answer), "find a company's reviews and rating on Glassdoor", &["Open Government Products".to_string()]);
        assert!(defaults.iter().any(|f| f == "text"), "a call hands back the page's text by default: {defaults:?}");
    }

    /// The same property on other sites' walks: a code host's organisation page, whose embedded state is feature
    /// flags, answers with what it renders; a blog post whose embedded state is the post answers with that state.
    #[test]
    fn a_state_answers_for_the_page_only_when_it_holds_it() {
        let org = url::Url::parse("https://github.com/superdesigndev").unwrap();
        let (flags, read) = answer(&fixture("org-page-its-state-is-flags.html"), &org);
        assert!(read && flags["state"].is_null());
        assert!(flags["text"].as_str().unwrap().contains("superdesigndev"));
        let post = url::Url::parse("https://blog.ethereum.org/2014/08/08/ether-sale-a-statistical-overview").unwrap();
        let (state, read) = answer(&fixture("blog-post-its-state-holds.html"), &post);
        assert!(!read, "the state holds the post");
        assert!(state.to_string().contains("Ether Sale: A Statistical Overview"));
    }

    /// The shapes a page hands its scripts data in, each read as the page's state whatever the site calls it.
    #[test]
    fn a_page_hands_its_state_over_in_any_of_its_shapes() {
        let base = url::Url::parse("https://shop.example/search?q=lamp").unwrap();
        let items = r#"{"items":[{"title":"Brass lamp","price":120},{"title":"Paper lamp","price":45}],"total":2}"#;
        let quoted = items.replace('"', "\\\"");
        let attribute = items.replace('"', "&quot;");
        let list = r#"[{"title":"Brass lamp","price":120},{"title":"Paper lamp","price":45}]"#;
        for page in [
            format!(r#"<script>window.__APP__ = JSON.parse("{quoted}");</script>"#),
            format!("<script>self.__APP__ = JSON.parse('{items}');</script>"),
            format!(r#"<script>window["__APP__"] = {items};</script>"#),
            format!("<script>window.__APP__ = {list};</script>"),
            format!(r#"<div id="app" data-page="{attribute}"></div>"#),
        ] {
            let v = read(&format!("<html><body>{page}</body></html>"), &base);
            assert!(v["state"].to_string().contains("Brass lamp"), "{page}: {v}");
        }
    }

    /// A page that carries its menu as a JSON script and shows its results as text: the page is the answer, so its route
    /// says so, and a call reads the page it got. Followed, the menu's shape answered the menu for every value. A page
    /// whose JSON script is what it shows is still read as that script.
    #[test]
    fn a_pages_menu_is_not_its_answer() {
        let menu = format!(r#"<script type="application/json">{{"navigation":{{"footer":[{{"label":"Help"}},{{"label":"Track order"}}]}},"pad":"{}"}}</script>"#, "x".repeat(4000));
        let page = |item: &str| {
            let rows: String = (0..30).map(|n| format!("<p>{item} number {n} in a fine cut with a long name</p>")).collect();
            format!("<html><head><title>Search: {item}</title></head><body>{menu}{rows}</body></html>")
        };
        let ex = |html: String, url: &str| crate::trace::Exchange {
            method: "GET".into(),
            url: url.parse().unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: vec![("content-type".into(), "text/html; charset=utf-8".into())],
            response_body: Some(html),
            response_mime: "text/html".into(),
            resource_type: Some("Document".into()),
            main_frame: Some(true),
        };
        assert!(reads_as_the_page(&ex(page("Lamp"), "https://shop.example/search/?q=lamp")), "the menu is not the answer");
        let items: Vec<String> = (0..30).map(|n| format!(r#"{{"title":"Lamp number {n} in a fine cut with a long name"}}"#)).collect();
        let state = format!(r#"<script type="application/json">{{"items":[{}]}}</script>"#, items.join(","));
        let rows: String = (0..30).map(|n| format!("<p>Lamp number {n} in a fine cut with a long name</p>")).collect();
        assert!(!reads_as_the_page(&ex(format!("<html><body>{state}{rows}</body></html>"), "https://shop.example/search/?q=lamp")));
        assert!(!reads_as_the_page(&ex(r#"{"items":[]}"#.into(), "https://shop.example/api/items")), "data is no page");
    }

    /// A string's escapes are undone the way a script's engine undoes them, so the state holds what the page shows.
    #[test]
    fn a_parsed_string_says_what_the_script_would_read() {
        let (text, took) = string_literal(r#""a\"b\u00e9\x41\ud83d\ude00\u{1F600}\/" + 1"#).unwrap();
        assert_eq!(text, "a\"béA😀😀/");
        assert_eq!(&r#""a\"b\u00e9\x41\ud83d\ude00\u{1F600}\/" + 1"#[took..], " + 1");
        assert!(string_literal("no quote").is_none());
        assert!(string_literal(r#""never closes"#).is_none());
    }

    /// A small setting is no page's state, and neither is an attribute that only looks like JSON, or a comparison.
    #[test]
    fn a_setting_is_not_the_pages_state() {
        let base = url::Url::parse("https://shop.example/").unwrap();
        let v = read(
            r#"<html><body><div data-config="{&quot;theme&quot;:&quot;dark&quot;}" title="{not json at all, however long this attribute happens to run on for}"></div>
            <script>var flags = [1, 2]; if (a == {}) {}; var parsed = JSON.parse("{}");</script></body></html>"#,
            &base,
        );
        assert!(v["state"].is_null(), "{v}");
    }

    #[test]
    fn json_is_not_a_page() {
        assert!(!is_html(r#"{"hits":[]}"#));
    }
    /// A replayed search that comes back as a check (a short page, no links, none of what was asked) is no answer;
    /// a page of results, and a page saying the value found nothing, are answers. The pages that exposed it: a
    /// journal's search answered its third value with "Client Challenge" and a line about a part that couldn't load.
    #[test]
    fn a_page_says_what_it_was_asked_in_its_text_or_where_it_links() {
        let page = json!({ "title": "Search", "text": "Menu\nFooter", "links": [{ "text": "Next", "url": "https://shop.example/s?q=tiny%20house&page=2" }] });
        assert!(says_any(&page, &["tiny house"]));
        assert!(says_any(&json!({ "title": "Lamps", "text": "12 lamps" }), &["lamp"]));
        assert!(!says_any(&json!({ "title": "Search", "text": "Menu\nFooter", "links": [] }), &["creeper"]));
        assert!(says_any(&json!({ "title": "Search", "text": "" }), &["ab"]), "too short to say either way");
        assert!(says_any(&json!({ "title": "Search", "text": "" }), &[]), "nothing asked");
    }

    /// Doors as they are met, by what the page does and not by the words its vendor chose. Each of these was named in a
    /// list once, or would have needed to be.
    #[test]
    fn a_door_is_read_from_the_page_not_its_vendors_words() {
        let at = url::Url::parse("https://shop.example/items").unwrap();
        let doors = [
            // Served 200 at the site's own address: the status says nothing, and the address nothing.
            r#"<!DOCTYPE html><html><head><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/orchestrate.js"></script></head><body><h1>shop.example</h1><p>Verifying you are human. This may take a few seconds.</p><noscript>Enable JavaScript and cookies to continue</noscript><a href="https://www.cloudflare.com?utm_source=challenge">Performance &amp; security by Cloudflare</a></body></html>"#,
            r#"<html><head><title>Human Verification</title><script src="https://token.awswaf.example/challenge.js"></script></head><body><div id="captcha-container"></div></body></html>"#,
            r#"<html><head><title>Un instant</title><script>window.__check={};</script></head><body><p>Nous vérifions votre navigateur.</p></body></html>"#,
            r#"<html><head><title>Pardon Our Interruption</title><script src="/check.js"></script></head><body><input type="hidden" name="t" value="1"><p>Please wait.</p></body></html>"#,
        ];
        for door in doors {
            assert!(a_door(200, door, &at), "{door}");
        }
        assert!(a_door(403, "<html><body><h1>Access Denied</h1></body></html>", &at), "a refusal is one whatever it says");
        assert!(a_door(503, "", &at));
        assert!(a_door(429, "{}", &at));

        let pages = [
            ("a plain page of a few lines", r#"<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>For use in documents.</p><a href="https://www.iana.org/domains/example">More</a></body></html>"#),
            ("a sign-in asks for something", r#"<html><head><title>Sign in</title><script src="/app.js"></script></head><body><form><input type="email" name="e"><input type="password" name="p"></form></body></html>"#),
            ("a page with a way into the site", r#"<html><head><title>No results</title><script src="/app.js"></script></head><body><p>Nothing found.</p><a href="/items">All items</a></body></html>"#),
            ("not a page at all", r#"{"items":[]}"#),
        ];
        for (why, page) in pages {
            assert!(!a_door(200, page, &at), "{why}");
        }
    }

    /// Checked against pages that aren't the ones this rule was written from: every document in the walks the node
    /// recorded is a page of its site.
    #[test]
    fn a_walked_page_is_no_door() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/tests/fixtures/walks");
        let mut read = 0;
        for walk in std::fs::read_dir(dir).unwrap().flatten() {
            for line in std::fs::read_to_string(walk.path()).unwrap().lines() {
                let o: Value = serde_json::from_str(line).unwrap();
                if o["type"] == "exchange" && o["resourceType"] == "Document" {
                    let url: url::Url = o["entry"]["request"]["url"].as_str().unwrap().parse().unwrap();
                    let status = o["entry"]["response"]["status"].as_u64().unwrap() as u16;
                    assert!(!a_door(status, o["entry"]["response"]["content"]["text"].as_str().unwrap_or_default(), &url), "{url}");
                    read += 1;
                }
            }
        }
        assert!(read >= 3, "the walks hold their pages");
    }

    #[test]
    fn a_short_page_that_says_nothing_asked_is_a_check() {
        let base = url::Url::parse("https://journal.example/search?q=coral").unwrap();
        let check = read("<html><head><title>Client Challenge</title></head><body><p>A required part of this site couldn\u{2019}t load. This may be due to a browser extension, network issues, or browser settings.</p><script src='/x.js'></script></body></html>", &base);
        assert!(a_check_not_the_page(&check, &["coral reef bleaching"]).is_some_and(|w| w.contains("Client Challenge".to_lowercase().as_str())));
        let none = read("<html><head><title>Search</title></head><body><p>No results for zqxjvbnmqw</p></body></html>", &base);
        assert!(a_check_not_the_page(&none, &["zqxjvbnmqw"]).is_none(), "a page saying the value found nothing answers it");
        let results = read("<html><body><a href='/a/1'>Reef study one</a><a href='/a/2'>Reef study two</a></body></html>", &base);
        assert!(a_check_not_the_page(&results, &["coral reef bleaching"]).is_none());
        // A route asked nothing worth looking for is never judged by it.
        assert!(a_check_not_the_page(&check, &["ab"]).is_none() && a_check_not_the_page(&check, &[]).is_none());
    }

    /// A page's `<meta name="…">` is read by that name, in either attribute order: it is where a page states a token
    /// its own calls carry (an anti-forgery token, a build id), and a route sends it as a header.
    #[test]
    fn a_pages_meta_tag_is_read_by_its_name() {
        let body = r#"<html><head><meta name="csrf-token" content="tok-123"><meta content="b-7" property="build"><meta name="other" content="no"></head></html>"#;
        assert_eq!(meta_content(body, "csrf-token").as_deref(), Some("tok-123"));
        assert_eq!(meta_content(body, "build").as_deref(), Some("b-7"), "a property is read too, and the order doesn't matter");
        assert_eq!(meta_content(body, "missing"), None);
        assert_eq!(meta_content("<html><meta name='csrf-token' content='q'><html>", "csrf-token").as_deref(), Some("q"), "either quote");
    }

    /// The walk that exposed it: a marketplace's listing cards, each a link holding a stylesheet for the component it
    /// is drawn with. The link's text came out as the stylesheet. A link says its words, not its styles.
    #[test]
    fn a_links_text_is_what_it_says_not_what_styles_it() {
        let base: url::Url = "https://www.market.example/search".parse().unwrap();
        let html = r#"<html><body><a href="/listing/1/wool-scarf"><template shadowrootmode="open"><style>:host{box-sizing:border-box}</style></template><style>.card{color:red}</style><h3>Wool scarf, hand knitted</h3><span>$12.00</span></a></body></html>"#;
        let read = read(html, &base);
        let text = read["links"][0]["text"].as_str().unwrap();
        assert!(text.contains("Wool scarf, hand knitted") && text.contains("$12.00"), "{text}");
        assert!(!text.contains("box-sizing") && !text.contains("color:red"), "{text}");
    }

}
