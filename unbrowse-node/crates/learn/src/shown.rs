//! What a page showed its reader, and whether a call's answer says any of it. A page's own calls include many that
//! answer the page's scripts rather than its reader: a vendor's settings for a session recorder, a sign-in widget's
//! status, an ad's price floors. Each answers with JSON, often a lot of it, and some carry the goal's words by chance
//! (`read` inside `already`, a selector named for a review). What none of them says is anything the page showed: the
//! names, titles and figures a reader sees. So a call is held to that, read from the walk itself (the page's own
//! document and what the agent read off it), never from a list of hosts or vendors.

use serde_json::Value;

use crate::trace::Exchange;

/// The fewest words a page must show for a call to be judged by it. A document that holds fewer is an app shell its
/// scripts fill in (or a refusal): what it shows reaches the walk only once the agent reads the page.
pub const LEAST_WORDS: usize = 60;

/// How many places a value must stand at in what a page showed for the page to list records of it (`Shown::lists`).
pub const RECORDS: usize = 3;

/// The most values of one answer looked for in the page: a big answer says what it shares with the page early.
const MOST_VALUES: usize = 4000;

/// What a page showed: the readable text of its own documents as they were served (their content, not the navigation,
/// header and footer every page of the site repeats) and what the agent read off it, in lower case with its spaces
/// squashed; what the page is about, the words of its own address; and the site's own name, which every page shows and
/// every vendor's settings for the site name too, so it says nothing of what the page showed.
#[derive(Clone, Debug, Default)]
pub struct Shown {
    text: String,
    /// The documents as served, scripts and all, in lower case: where a page that fills itself spells what it asks for.
    served: String,
    words: usize,
    subject: Vec<String>,
    names: Vec<String>,
}

impl Shown {
    /// What the page at `url` showed: its documents among `pages`, and `read`, what the agent read off it.
    pub fn of<'e>(pages: impl IntoIterator<Item = &'e Exchange>, read: &[String], url: &str) -> Shown {
        let mut text = String::new();
        let mut served = String::new();
        for e in pages {
            let body = e.response_body.as_deref().unwrap_or_default();
            if crate::page::is_html(body) {
                text.push_str(&content(body));
                text.push('\n');
                served.push_str(&body.to_lowercase());
                served.push('\n');
            }
        }
        for r in read {
            text.push_str(r);
            text.push('\n');
        }
        let text = squash(&text);
        let words = text.split_whitespace().count();
        let address = url::Url::parse(url).ok();
        let site = address.as_ref().and_then(|u| u.host_str()).map(crate::identity::site_of).unwrap_or_default();
        let names = site.split('.').next().filter(|n| !n.is_empty()).map(|n| vec![n.to_lowercase()]).unwrap_or_default();
        let mut subject: Vec<String> = Vec::new();
        if let Some(u) = &address {
            let pieces = u.path_segments().into_iter().flatten().map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().into_owned());
            let values = u.query_pairs().map(|(_, v)| v.into_owned());
            for piece in pieces.chain(values) {
                let piece = squash(&piece);
                subject.extend(piece.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3 && w.chars().any(char::is_alphabetic)).map(String::from));
                subject.push(piece);
            }
        }
        subject.retain(|w| !names.contains(w) && !w.is_empty());
        Shown { text, served, words, subject, names }
    }

    /// Whether the page's own document asks for `e` by itself: its scripts spell the call's address, piece by piece
    /// around the ids in it, and hold those ids. A page that fills a table from such a call (`"/customers/" + 29528 +
    /// "/accounts"`) shows only the table's head until the call answers, so what it showed as served is no measure of
    /// the call: the page named it. The first piece may drop the leading segments the page's own address supplies
    /// (a relative address), keeping two at least; every other piece stands whole.
    pub fn asks_for(&self, e: &Exchange) -> bool {
        let segs: Vec<String> = e.url.path_segments().into_iter().flatten().filter(|s| !s.is_empty()).map(|s| s.to_lowercase()).collect();
        let id = |s: &str| s.chars().any(|c| c.is_ascii_digit()) && (s.chars().all(|c| c.is_ascii_digit()) || s.chars().count() >= 8);
        let mut pieces: Vec<Vec<&str>> = vec![Vec::new()];
        let mut ids: Vec<&str> = Vec::new();
        for s in &segs {
            if id(s) {
                ids.push(s);
                pieces.push(Vec::new());
            } else {
                pieces.last_mut().expect("a piece").push(s);
            }
        }
        pieces.retain(|p| !p.is_empty());
        let Some((first, rest)) = pieces.split_first() else { return false };
        let spelled_first = (0..first.len()).filter(|&k| first.len() - k >= 2).any(|k| self.served.contains(&first[k..].join("/")));
        let spelled_rest = rest.iter().all(|p| self.served.contains(&format!("/{}", p.join("/"))));
        spelled_first && spelled_rest && ids.iter().all(|i| self.served.contains(i))
    }

    /// Whether the page's own document lists records of a value it was asked (`asked`): the value stands whole in what
    /// it showed at [`RECORDS`] places or more, as a list of results or releases names it on each line. A page that is
    /// a shell names it in a heading at most, and its records come from elsewhere.
    pub fn lists(&self, asked: &[String]) -> bool {
        asked.iter().map(|v| v.to_lowercase()).filter(|v| v.chars().count() >= 3).any(|v| whole_count(&self.text, &v) >= RECORDS)
    }

    /// Whether the page showed enough to judge a call by.
    pub fn judges(&self) -> bool {
        self.words >= LEAST_WORDS
    }

    /// Whether `e`'s answer says something the page showed: one of its own values stands whole in the page's text, and
    /// is one a page shows its reader rather than a word any page has: a phrase (a name or a title of several words),
    /// a figure of four digits or more (written plain or with its thousands marked, as a page writes it), or a word of
    /// what the page is about (`bitcoin` on `/prices/bitcoin`, `btc` on `/price/btc`). Keys are the answer's own words,
    /// never shown; a link or a path is where something is, not what it says; a single common word (`hotels`,
    /// `search`) turns up in a vendor's settings and in a page's tabs alike; and a value that is only the site's name
    /// is on every page.
    pub fn says(&self, e: &Exchange) -> bool {
        e.json_body().is_some_and(|answer| self.says_of(&answer))
    }

    /// Whether `e`'s answer says what a page that lists records showed: [`RECORDS`] of the things it showed or more,
    /// besides the values the page was asked (`asked`) and their words, as the records the page lists do. A record
    /// about the page's subject names it, as the page's address does, and may share its one line of summary; neither
    /// is the page's listing.
    pub fn says_besides(&self, e: &Exchange, asked: &[String]) -> bool {
        let asked: Vec<String> = asked.iter().map(|a| squash(a)).collect();
        let words: Vec<String> = asked.iter().flat_map(|a| a.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(String::from).collect::<Vec<_>>()).collect();
        let found = std::cell::RefCell::new(std::collections::BTreeSet::new());
        let Some(answer) = e.json_body() else { return false };
        self.says_where(&answer, &|t: &str| {
            if !asked.iter().any(|a| a == t) && !words.iter().any(|w| w == t) {
                found.borrow_mut().insert(t.replace(',', ""));
            }
            found.borrow().len() >= RECORDS
        })
    }

    /// [`Shown::says`], of an answer in hand: whether one of its values is one the page showed.
    pub fn says_of(&self, answer: &Value) -> bool {
        self.says_where(answer, &|_| true)
    }

    /// [`Shown::says_of`], of the values `counts` keeps.
    fn says_where(&self, answer: &Value, counts: &dyn Fn(&str) -> bool) -> bool {
        let mut values = Vec::new();
        said(answer, &mut values);
        values.into_iter().take(MOST_VALUES).any(|v| {
            let telling = match &v {
                Said::Figure(_) => true,
                Said::Text(t) => (t.contains(' ') && t.chars().count() >= 4) || self.subject.contains(t),
            };
            let t = match &v {
                Said::Figure(t) | Said::Text(t) => t,
            };
            telling && !self.names.contains(t) && whole_in(&self.text, t) && counts(t)
        })
    }
}

/// A page's readable content: the text of its body, without its scripts and styles, and without the navigation,
/// header and footer that frame every page of the site.
fn content(body: &str) -> String {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(body);
    let skip = Selector::parse("script, style, noscript, template, svg, nav, header, footer").expect("static selector");
    let skipped: std::collections::HashSet<_> = doc.select(&skip).flat_map(|e| e.descendants().map(|n| n.id())).collect();
    let mut text = String::new();
    if let Some(root) = doc.select(&Selector::parse("body").expect("static selector")).next() {
        for node in root.descendants().filter(|n| !skipped.contains(&n.id())) {
            if let Some(t) = node.value().as_text() {
                text.push_str(t);
                text.push('\n');
            }
        }
    }
    text
}

/// A value of an answer as a page would write it, in lower case.
enum Said {
    /// Text with a letter in it, at least three characters long, that isn't a link.
    Text(String),
    /// The whole part of a number of four digits or more, plain and with its thousands marked (`1234567`,
    /// `1,234,567`), from a number or a text that is one (`"67123.45"`).
    Figure(String),
}

/// The values of an answer a reader could be shown.
fn said(v: &Value, out: &mut Vec<Said>) {
    if out.len() >= MOST_VALUES {
        return;
    }
    let figure = |n: &str, out: &mut Vec<Said>| {
        let whole = n.trim().trim_start_matches('-').split('.').next().unwrap_or_default();
        if whole.len() >= 4 && whole.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(i) = whole.parse::<u64>() {
                out.push(Said::Figure(thousands(i)));
            }
            out.push(Said::Figure(whole.to_string()));
        }
    };
    match v {
        Value::Object(m) => m.values().for_each(|x| said(x, out)),
        Value::Array(a) => a.iter().for_each(|x| said(x, out)),
        Value::String(s) => {
            let s = squash(s);
            if s.chars().count() >= 3 && s.chars().any(char::is_alphabetic) && !crate::goal::link(&s) {
                out.push(Said::Text(s));
            } else {
                figure(&s, out);
            }
        }
        Value::Number(n) => figure(&n.to_string(), out),
        _ => {}
    }
}

fn thousands(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// Lower case, every run of spaces and line breaks one space.
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// Whether `text` holds `value` whole: not as part of a longer word or number.
/// How many places `value` stands whole at in `text`.
fn whole_count(text: &str, value: &str) -> usize {
    text.match_indices(value)
        .filter(|(at, _)| {
            let before = text[..*at].chars().next_back();
            let after = text[at + value.len()..].chars().next();
            !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
        })
        .count()
}

fn whole_in(text: &str, value: &str) -> bool {
    text.match_indices(value).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + value.len()..].chars().next();
        !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(url: &str, mime: &str, body: &str) -> Exchange {
        Exchange {
            method: "GET".into(),
            url: url::Url::parse(url).unwrap(),
            request_headers: Vec::new(),
            request_body: None,
            status: 200,
            response_headers: Vec::new(),
            response_body: Some(body.into()),
            response_mime: mime.into(),
            resource_type: Some(if mime.contains("html") { "Document" } else { "XHR" }.into()),
            main_frame: Some(true),
        }
    }

    fn page(text: &str) -> Exchange {
        exchange("https://shop.example/c/desks", "text/html", &format!("<!doctype html><html><head><title>Desks</title></head><body><main>{text}</main></body></html>"))
    }

    fn filler() -> String {
        (0..LEAST_WORDS).map(|i| format!("word{i}")).collect::<Vec<_>>().join(" ")
    }

    /// A page lists records of what it was asked when the value stands whole at three places or more of what it
    /// showed; one heading naming it, or the value inside longer words, is no listing.
    #[test]
    fn a_page_that_names_the_ask_on_each_line_lists_its_records() {
        let at = "https://shop.example/c/desks";
        let listing = Shown::of([&page(&format!("<li>Oak desk, small</li><li>Oak desk, tall</li><li>White oak desk</li>{}", filler()))], &[], at);
        assert!(listing.lists(&["Oak Desk".to_string()]));
        assert!(!listing.lists(&["ok".to_string()]), "a value under three letters names nothing");
        let heading = Shown::of([&page(&format!("<h1>Oak desk</h1><p>Our range</p>{}", filler()))], &[], at);
        assert!(!heading.lists(&["oak desk".to_string()]), "a heading names it once");
        let inside = Shown::of([&page(&format!("<p>oakdesks oakdesk oakdesker</p>{}", filler()))], &[], at);
        assert!(!inside.lists(&["oakdesk".to_string()]), "inside longer words it stands whole once");
    }

    /// An answer says what a listing page showed when three things it showed are in it besides the ask and its words.
    #[test]
    fn an_answer_says_a_listing_by_three_things_it_showed_besides_the_ask() {
        let shown = Shown::of([&page(&format!("<li>Oak Writing Desk</li><li>Pine Standing Desk</li><li>Walnut Corner Desk</li>{}", filler()))], &[], "https://shop.example/c/desks");
        let three = exchange("https://api.shop.example/items", "application/json", r#"{"items":[{"name":"Oak Writing Desk"},{"name":"Pine Standing Desk"},{"name":"Walnut Corner Desk"}]}"#);
        assert!(shown.says_besides(&three, &["desk".to_string()]));
        assert!(!shown.says_besides(&three, &["Oak Writing Desk".to_string()]), "the ask itself is not one of the three");
        let one = exchange("https://api.shop.example/items", "application/json", r#"{"query":"desk","items":[{"name":"Oak Writing Desk"}]}"#);
        assert!(!shown.says_besides(&one, &["desk".to_string()]));
        let html = exchange("https://api.shop.example/items", "text/html", "<p>Oak Writing Desk</p>");
        assert!(!shown.says_besides(&html, &[]), "an answer that isn't JSON says nothing here");
    }

    #[test]
    fn a_value_the_page_shows_is_said_and_a_setting_is_not() {
        let shown = Shown::of([&page(&format!("<p>Oak Writing Desk</p><p>1,299 sold</p><p>Shop</p>{}", filler()))], &[], "https://shop.example/c/desks");
        assert!(shown.judges());
        let records = exchange("https://api.shop.example/items", "application/json", r#"{"items":[{"name":"Oak Writing Desk","sold":1299}]}"#);
        assert!(shown.says(&records));
        let figure = exchange("https://api.shop.example/stats", "application/json", r#"{"sold":1299,"id":"x"}"#);
        assert!(shown.says(&figure), "a figure is said as the page writes it");
        let settings = exchange(
            "https://cfg.vendor.example/config",
            "application/json",
            r#"{"configs":{"replay":{"capture_enabled":true,"maskSelector":["[class*=\"Desk\"] *"],"sample":0.01}},"site":"Shop"}"#,
        );
        assert!(!shown.says(&settings), "a selector and a flag show the reader nothing; a short word is no evidence");
        let named = exchange("https://cfg.vendor.example/config", "application/json", r#"{"project":"shop","host":"https://shop.example/"}"#);
        assert!(!Shown::of([&page(&format!("Shop {}", filler()))], &[], "https://shop.example/c/desks").says(&named), "the site's own name is on every page");
    }

    #[test]
    fn a_single_common_word_is_no_evidence_but_the_pages_own_subject_is() {
        let tabs = format!("<p>Hotels</p><p>Restaurants</p><p>Bitcoin</p><p>Price today</p>{}", filler());
        let shown = Shown::of([&page(&tabs)], &[], "https://shop.example/prices/bitcoin");
        let vendor = exchange("https://sdk.vendor.example/api/data", "application/json", r#"{"cards":[{"category":"Hotels"},{"category":"Restaurants"}]}"#);
        assert!(!shown.says(&vendor), "a page's tab and a vendor's category share a word by chance");
        let coin = exchange("https://api.shop.example/assets/BTC", "application/json", r#"{"name":"Bitcoin","price":"67.5"}"#);
        assert!(shown.says(&coin), "the thing the page's address names");
    }

    #[test]
    fn the_navigation_every_page_repeats_is_not_what_the_page_showed() {
        let html = format!("<!doctype html><html><body><header><a>Write a review</a></header><nav>Company reviews</nav><main>{}</main><footer>Cookie consent tool</footer></body></html>", filler());
        let shown = Shown::of([&exchange("https://shop.example/", "text/html", &html)], &[], "https://shop.example/");
        assert!(shown.judges());
        let bundle = exchange("https://shop.example/i18n", "application/json", r#"{"header":{"review":"Write a review","reviews":"Company reviews","consent":"Cookie consent tool"}}"#);
        assert!(!shown.says(&bundle));
    }

    #[test]
    fn a_shell_shows_too_little_to_judge_until_the_agent_reads_it() {
        let shell = Shown::of([&page("Loading…")], &[], "https://shop.example/c/desks");
        assert!(!shell.judges());
        let read = Shown::of([&page("Loading…")], &[format!("- link \"Oak Writing Desk\" [ref=e4] {}", filler())], "https://shop.example/c/desks");
        assert!(read.judges());
        assert!(read.says(&exchange("https://api.shop.example/items", "application/json", r#"[{"title":"Oak Writing Desk"}]"#)));
    }

    #[test]
    fn a_value_inside_a_longer_word_is_not_said() {
        let shown = Shown::of([&page(&format!("Deskmate pro {}", filler()))], &[], "https://shop.example/c/desks");
        assert!(!shown.says(&exchange("https://api.shop.example/x", "application/json", r#"{"kind":"desk"}"#)));
        assert!(!shown.says(&exchange("https://api.shop.example/x", "application/json", r#")]}' [["abc"]]"#)), "an answer that isn't JSON says nothing");
    }
    /// A page that fills its table from its own call spells the call in its script: the call is the page's own,
    /// whatever the served page showed. One whose script names another address, or holds another id, doesn't.
    #[test]
    fn a_page_asks_for_the_call_its_script_spells() {
        let page = r#"<html><body><table id="t"><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody></tbody></table>
            <script>$.ajax({ url: "services_proxy/bank/customers/" + 29528 + "/accounts", type: "GET" });</script></body></html>"#;
        let doc = exchange("https://bank.example/parabank/overview.htm", "text/html", page);
        let shown = Shown::of([&doc], &[], "https://bank.example/parabank/overview.htm");
        let call = |u: &str| exchange(u, "application/json", "[]");
        assert!(shown.asks_for(&call("https://bank.example/parabank/services_proxy/bank/customers/29528/accounts")));
        assert!(!shown.asks_for(&call("https://bank.example/parabank/services_proxy/bank/customers/11111/accounts")), "another id");
        assert!(!shown.asks_for(&call("https://bank.example/parabank/services_proxy/bank/customers/29528/loans")), "another address");
        assert!(!shown.asks_for(&call("https://bank.example/collect")), "one segment is nothing spelled");
    }

}
