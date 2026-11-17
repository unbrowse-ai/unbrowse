//! What a site needed done before it answered, read from the browsing that did it. Some of a site's state is only ever
//! made by hands on a page: a sign-in, a country or store picked on a page that asks. A route can't carry that as calls,
//! because pages are the browser's job, and a re-walk starts from the same page that asked. So the node keeps the steps
//! themselves, and runs them again in the site's browser when the session has lost what they made.
//!
//! Both are read from what the walk did, never from a site's words:
//!
//! - **A sign-in** is the run of steps that typed a vault login, up to the step that sent it.
//! - **A choice** is a step on a page after which the browser began sending a cookie it had never sent there, and either
//!   the site's next page was another page, or the step's own call went out with the page staying put (a store picker).
//!   A page that asked is kept by its title: an answer with that title means the choice has gone. Either way the cookies
//!   it earned are kept by name: a jar without them has lost it.
//!
//! Nothing here is ever shared: a setup holds the owner's account name and is theirs alone. A secret stays a vault
//! reference, filled by the same checked path an agent's fill takes. Steps that hold a secret the vault can't type (one
//! the owner typed by hand) can't run again, so no setup is kept: that sign-in stays the owner's to do.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::identity::on_site;
use crate::session::{Action, Session};

/// How soon after a step its own call goes out, in seconds.
const QUIET_WAIT: f64 = 0.5;

/// The most a call that says nothing of what was picked may send and still be taken for the step's own.
const SMALL_BODY: usize = 512;

/// The most setups kept for a site: what it asks is a few pages, never a history.
pub const MOST_KEPT: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    SignIn,
    Choice,
}

/// One step, aimed by a selector the browser found unique on the page when it was taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Step {
    /// `value` is the typed text, or a vault reference, which the node types itself.
    Fill { at: String, value: String },
    Select { at: String, value: String },
    Check { at: String },
    Uncheck { at: String },
    Click { at: String },
    Press { key: String },
}

impl Step {
    /// The selector the step aims at; a key press aims at whatever has the focus.
    pub fn at(&self) -> Option<&str> {
        match self {
            Step::Fill { at, .. } | Step::Select { at, .. } | Step::Check { at } | Step::Uncheck { at } | Step::Click { at } => Some(at),
            Step::Press { .. } => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Setup {
    pub kind: Kind,
    /// The page the steps start on.
    pub page: String,
    /// The title of the page that asked, for a choice: an answer under this title means it must be made again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asks: Option<String>,
    /// The cookies a choice earned, by name: a route that sends one needs it made again once the jar has lost it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub earns: Vec<String>,
    pub steps: Vec<Step>,
}

impl Setup {
    /// Whether two setups do the same thing: the newer one replaces the older.
    pub fn same_as(&self, other: &Setup) -> bool {
        self.kind == other.kind && (self.kind == Kind::SignIn || (self.asks == other.asks && (self.asks.is_some() || self.earns == other.earns)))
    }

    /// Whether a route sending `cookies` has lost what this quiet choice earned, its jar holding only `held`.
    pub fn lost_from(&self, cookies: &[&str], held: &dyn Fn(&str) -> bool) -> bool {
        // A page that asked says so itself, and what it earned may be any cookie its next page sent.
        self.kind == Kind::Choice && self.asks.is_none() && self.earns.iter().any(|c| cookies.contains(&c.as_str()) && !held(c))
    }

    /// Whether `answer`, a page read (`page::read`), is the page this choice answers: the site is asking again.
    pub fn asked_by(&self, answer: &serde_json::Value) -> bool {
        self.kind == Kind::Choice && answer.get("text").is_some() && self.asks.as_deref().is_some_and(|t| answer.get("title").and_then(|v| v.as_str()) == Some(t))
    }
}

fn is_vault(value: &str) -> bool {
    value.starts_with("vault:")
}

/// `a` as a step: None when it does nothing to the page, an error when it did something that can't be done again (it
/// has no selector that holds, or typed a secret the vault can't type).
fn step_of(a: &Action) -> Result<Option<Step>, ()> {
    let at = || a.locator.clone().ok_or(());
    Ok(Some(match a.kind.as_str() {
        "fill" | "type" => {
            let value = a.value.clone().ok_or(())?;
            // The log masks a value it learns is only ever checked: what's left is its name, not anything to type.
            if (a.secret && !is_vault(&value)) || value.starts_with("secret:") {
                return Err(());
            }
            Step::Fill { at: at()?, value }
        }
        "select" => Step::Select { at: at()?, value: a.value.clone().ok_or(())? },
        "check" => Step::Check { at: at()? },
        "uncheck" => Step::Uncheck { at: at()? },
        "click" => Step::Click { at: at()? },
        "press" => Step::Press { key: a.value.clone().ok_or(())? },
        _ => return Ok(None),
    }))
}

fn steps_of(actions: &[Action]) -> Option<Vec<Step>> {
    actions.iter().map(step_of).collect::<Result<Vec<_>, _>>().ok().map(|s| s.into_iter().flatten().collect())
}

/// The last sign-in in the session: from the page it opened on to the step that sent the last vault login typed.
fn sign_in(session: &Session, site: &str) -> Option<Setup> {
    let actions = &session.actions;
    let typed = |a: &Action| matches!(a.kind.as_str(), "fill" | "type") && a.secret && a.value.as_deref().is_some_and(is_vault);
    let last = actions.iter().rposition(typed)?;
    let opened = actions[..last].iter().rposition(|a| a.kind == "navigate")?;
    let page = actions[opened].value.clone()?;
    // A sign-in that crosses to another site's page isn't one the site's own browser session can run: the vault fills a
    // login only on its own site, and the steps can't say which page each belongs to.
    if !url::Url::parse(&page).ok()?.host_str().is_some_and(|h| on_site(h, site)) {
        return None;
    }
    let mut sent = last + 1 + actions[last + 1..].iter().position(|a| matches!(a.kind.as_str(), "click" | "press"))?;
    // A login typed on a provider's page comes back through its screens (a consent, a "stay signed in"): those steps are
    // the sign-in too, up to the first page back on the site.
    let trace = &session.trace;
    let time = actions[last].t;
    let page_at = |on: bool| (0..trace.exchanges.len()).find(|&i| session.time_of(i) > time && trace.exchanges[i].is_main_document() && trace.exchanges[i].url.host_str().is_some_and(|h| on_site(h, site)) == on);
    if let (Some(away), Some(back)) = (page_at(false), page_at(true)) {
        if session.time_of(away) < session.time_of(back) {
            let until = session.time_of(back);
            while actions.get(sent + 1).is_some_and(|a| a.t <= until && matches!(a.kind.as_str(), "click" | "press")) {
                sent += 1;
            }
        }
    }
    Some(Setup { kind: Kind::SignIn, page, asks: None, earns: Vec::new(), steps: steps_of(&actions[opened + 1..=sent])? })
}

/// Whether an exchange loaded the tab's page. A browsing log may not mark frames, so a frame's own document reads as a
/// main one: the browser says which it is on the request itself, once it says so of anything in the log (`marked`).
fn is_page(e: &crate::trace::Exchange, marked: bool) -> bool {
    let dest = e.request_header("sec-fetch-dest");
    e.is_main_document() && if marked { dest.is_some_and(|d| d.eq_ignore_ascii_case("document")) } else { dest.is_none() }
}

/// The names of the cookies `e`'s answer set.
fn set_by(e: &crate::trace::Exchange) -> BTreeSet<String> {
    e.response_headers.iter().filter(|(k, _)| k.eq_ignore_ascii_case("set-cookie")).filter_map(|(_, v)| v.split('=').next().map(|n| n.trim().to_string())).collect()
}

/// Each choice in the session (see the module's words): one per page that asked, the last made standing.
fn choices(session: &Session, site: &str) -> Vec<Setup> {
    let trace = &session.trace;
    let door = trace.door(site);
    let on_own = |i: usize| trace.exchanges[i].url.host_str().is_some_and(|h| on_site(h, site));
    let marked = trace.exchanges.iter().any(|e| e.is_main_document() && e.request_header("sec-fetch-dest").is_some());
    // A redirect is no page: a choice's link often answers with one, and the cookie shows on the page it leads to.
    let pages: Vec<usize> = (0..trace.exchanges.len()).filter(|&i| is_page(&trace.exchanges[i], marked) && on_own(i) && !door.contains(&i) && (200..300).contains(&trace.exchanges[i].status)).collect();
    let title = |i: usize| {
        let e = &trace.exchanges[i];
        e.response_body.as_deref().map(|b| crate::page::read(b, &e.url)["title"].as_str().unwrap_or_default().to_string()).unwrap_or_default()
    };
    let mut out: Vec<Setup> = Vec::new();
    for pair in pages.windows(2) {
        let (asked, then) = (pair[0], pair[1]);
        let (from, to) = (session.time_of(asked), session.time_of(then));
        let done: Vec<Action> = session.actions.iter().filter(|a| a.t > from && a.t <= to && a.kind != "navigate").cloned().collect();
        let Some(last) = done.last().filter(|a| matches!(a.kind.as_str(), "click" | "select" | "check")) else { continue };
        if done.iter().any(|a| a.secret) || session.actions.iter().any(|a| a.t > from && a.t <= to && a.kind == "navigate") {
            continue;
        }
        let sent_before: BTreeSet<String> = (0..trace.exchanges.len()).filter(|&i| session.time_of(i) <= last.t && on_own(i)).flat_map(|i| trace.exchanges[i].cookies().into_iter().map(|(k, _)| k)).collect();
        let earns: Vec<String> = trace.exchanges[then].cookies().into_iter().map(|(k, _)| k).filter(|k| !sent_before.contains(k)).collect();
        if earns.is_empty() {
            continue;
        }
        let (asks, answered) = (title(asked), title(then));
        if asks.is_empty() || asks == answered {
            continue;
        }
        let Some(steps) = steps_of(&done) else { continue };
        let setup = Setup { kind: Kind::Choice, page: trace.exchanges[asked].url.to_string(), asks: Some(asks), earns, steps };
        out.retain(|s| !s.same_as(&setup));
        out.push(setup);
    }
    // A choice with the page staying put: the step's own call changed something and set a cookie later calls send. No page
    // asked, so there's no title to know it by: the cookie stands for it. A page's scripts post beside any click (a
    // sensor, a beacon), so the call must be the step's: it carries what was typed or picked, or it is small and went at
    // once. A big opaque body that happens to follow a click is nobody's choice.
    for (n, a) in session.actions.iter().enumerate().filter(|(_, a)| matches!(a.kind.as_str(), "click" | "select" | "check")) {
        let Some(&on) = pages.iter().rfind(|&&i| session.time_of(i) <= a.t) else { continue };
        let at = session.time_of(on);
        let done: Vec<Action> = session.actions[..=n].iter().filter(|b| b.t > at && b.kind != "navigate").cloned().collect();
        if done.iter().any(|b| b.secret) {
            continue;
        }
        let typed: Vec<&str> = done.iter().filter(|b| matches!(b.kind.as_str(), "fill" | "type" | "select")).filter_map(|b| b.value.as_deref()).collect();
        let next = session.actions.get(n + 1).map_or(f64::INFINITY, |b| b.t);
        let its_call = (0..trace.exchanges.len()).filter(|&i| {
            let (e, t) = (&trace.exchanges[i], session.time_of(i));
            let body = e.request_body.as_deref().unwrap_or_default();
            let carries = typed.iter().any(|v| crate::trace::carries_text(e.url.as_str(), v) || crate::trace::carries_text(body, v));
            t > a.t && t <= next && on_own(i) && !door.contains(&i) && !e.is_main_document() && !e.is_asset() && !e.method.eq_ignore_ascii_case("GET")
                && (200..300).contains(&e.status) && (carries || (body.len() <= SMALL_BODY && t - a.t <= QUIET_WAIT))
        });
        let set: BTreeSet<String> = its_call.flat_map(|i| set_by(&trace.exchanges[i])).collect();
        let sent_later: BTreeSet<String> = (0..trace.exchanges.len()).filter(|&i| session.time_of(i) > a.t + QUIET_WAIT && on_own(i)).flat_map(|i| trace.exchanges[i].cookies().into_iter().map(|(k, _)| k)).collect();
        let earns: Vec<String> = set.intersection(&sent_later).cloned().collect();
        if earns.is_empty() {
            continue;
        }
        let Some(steps) = steps_of(&done) else { continue };
        let setup = Setup { kind: Kind::Choice, page: trace.exchanges[on].url.to_string(), asks: None, earns, steps };
        out.retain(|s| !s.same_as(&setup));
        out.push(setup);
    }
    out
}

/// What the browsing in `session` shows `site` needs done.
pub fn read(session: &Session, site: &str) -> Vec<Setup> {
    let mut out = choices(session, site);
    out.extend(sign_in(session, site));
    out
}

/// `kept` with `fresh` in it: each replaces what it does the same as, and the newest stay. Past the most kept the oldest
/// choice goes first: a site keeps one sign-in, and it is the one setup a route can't do without.
pub fn merge(mut kept: Vec<Setup>, fresh: Vec<Setup>) -> Vec<Setup> {
    for f in fresh {
        kept.retain(|k| !k.same_as(&f));
        kept.push(f);
    }
    while kept.len() > MOST_KEPT {
        let oldest = kept.iter().position(|k| k.kind != Kind::SignIn).unwrap_or(0);
        kept.remove(oldest);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn action(t: f64, kind: &str, locator: Option<&str>, value: Option<&str>, secret: bool) -> Value {
        json!({ "type": "action", "t": t, "action": kind, "selector": "@e1", "locator": locator, "value": value, "secret": secret })
    }

    fn page(t: f64, url: &str, title: &str, cookie: &str) -> Value {
        let headers = if cookie.is_empty() { json!([]) } else { json!([{ "name": "cookie", "value": cookie }]) };
        json!({ "type": "exchange", "t": t, "resourceType": "Document", "entry": {
            "_resourceType": "Document",
            "request": { "method": "GET", "url": url, "headers": headers },
            "response": { "status": 200, "headers": [], "content": { "mimeType": "text/html", "text": format!("<html><head><title>{title}</title></head><body>{title}</body></html>") } } } })
    }

    fn session(lines: &[Value]) -> Session {
        Session::from_log(&lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap()
    }

    fn signing_in() -> Vec<Value> {
        vec![
            action(1.0, "navigate", None, Some("https://shop.example/login"), false),
            action(2.0, "fill", Some("#email"), Some("me@mail.example"), false),
            action(3.0, "click", Some("button[type=\"submit\"]"), None, false),
            action(4.0, "fill", Some("#password"), Some("vault:shop.example:me"), true),
            action(5.0, "fill", Some("#code"), Some("vault:code:shop.example:me"), true),
            action(6.0, "press", None, Some("Enter"), false),
            action(7.0, "click", Some("a.orders"), None, false),
        ]
    }

    /// Every screen of a sign-in is kept, up to the step that sent the last login, and nothing after it.
    #[test]
    fn a_sign_in_is_the_steps_that_typed_a_login() {
        let s = sign_in(&session(&signing_in()), "shop.example").unwrap();
        assert_eq!(s.page, "https://shop.example/login");
        assert_eq!(s.steps.len(), 5, "{:?}", s.steps);
        assert_eq!(s.steps[2], Step::Fill { at: "#password".into(), value: "vault:shop.example:me".into() });
        assert_eq!(s.steps.last(), Some(&Step::Press { key: "Enter".into() }));
    }

    /// A step only a person could take makes the whole sign-in the owner's: part of one signs nobody in.
    #[test]
    fn a_secret_the_vault_cant_type_keeps_no_sign_in() {
        let mut lines = signing_in();
        lines.insert(4, action(4.5, "fill", Some("#pin"), Some("secret:1"), true));
        assert!(sign_in(&session(&lines), "shop.example").is_none());
    }

    /// A username the log later masked reads as `secret:2`: typing that would sign nobody in, so the setup a first reading
    /// kept stands rather than this one.
    #[test]
    fn a_value_the_log_masked_is_nothing_to_type() {
        let mut lines = signing_in();
        lines[1] = action(2.0, "fill", Some("#email"), Some("secret:2"), false);
        assert!(sign_in(&session(&lines), "shop.example").is_none());
    }

    #[test]
    fn a_step_with_no_lasting_selector_keeps_no_sign_in() {
        let mut lines = signing_in();
        lines[2] = action(3.0, "click", None, None, false);
        assert!(sign_in(&session(&lines), "shop.example").is_none());
    }

    #[test]
    fn a_sign_in_on_another_site_isnt_this_sites_to_run() {
        let mut lines = signing_in();
        lines[0] = action(1.0, "navigate", None, Some("https://id.provider.example/login"), false);
        assert!(sign_in(&session(&lines), "shop.example").is_none());
    }

    #[test]
    fn a_login_never_sent_is_no_sign_in() {
        let lines = &signing_in()[..5];
        assert!(sign_in(&session(lines), "shop.example").is_none());
    }

    fn choosing() -> Vec<Value> {
        vec![
            action(1.0, "navigate", None, Some("https://shop.example/"), false),
            page(1.5, "https://shop.example/", "Choose your country", "seen=1"),
            action(2.0, "click", Some("a[href=\"/?c=us\"]"), None, false),
            page(3.0, "https://shop.example/?c=us", "Shop: home", "seen=1; region=us"),
        ]
    }

    /// The site's next page was another page, and the browser began sending a cookie: the step made a choice, and the
    /// page that asked is known by its title.
    #[test]
    fn a_step_that_earned_a_cookie_and_another_page_is_a_choice() {
        let found = choices(&session(&choosing()), "shop.example");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].asks.as_deref(), Some("Choose your country"));
        assert_eq!(found[0].steps, vec![Step::Click { at: "a[href=\"/?c=us\"]".into() }]);
        assert!(found[0].asked_by(&json!({ "title": "Choose your country", "text": "Pick one", "links": [] })));
        assert!(!found[0].asked_by(&json!({ "title": "Shop: home", "text": "Lamps" })));
        assert!(!found[0].asked_by(&json!({ "title": "Choose your country" })), "a call's own JSON with a title isn't the page");
    }

    /// The walk that exposed it: the country's link answers 302 and sets the cookie, and the page it leads to is the first
    /// to send it.
    #[test]
    fn a_choice_that_redirects_is_read_from_the_page_it_leads_to() {
        let mut hop = page(2.5, "https://shop.example/set?c=us", "", "seen=1");
        hop["entry"]["response"]["status"] = json!(302);
        let lines = vec![
            action(1.0, "navigate", None, Some("https://shop.example/"), false),
            page(1.5, "https://shop.example/", "Choose your country", "seen=1"),
            action(2.0, "click", Some("#us"), None, false),
            hop,
            page(3.0, "https://shop.example/", "Shop: home", "seen=1; region=us"),
        ];
        let found = choices(&session(&lines), "shop.example");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].earns, ["region"]);
    }

    /// The walk that exposed it: a page's analytics frame loads a document of its own, between the page and the step, and
    /// its request says nothing of what it is, where the pages' requests do.
    #[test]
    fn a_frame_on_the_page_is_not_the_page_that_asked() {
        let framed = |mut v: Value, dest: &str| {
            v["entry"]["request"]["headers"].as_array_mut().unwrap().push(json!({ "name": "sec-fetch-dest", "value": dest }));
            v
        };
        let lines = vec![
            action(1.0, "navigate", None, Some("https://shop.example/"), false),
            framed(page(1.5, "https://shop.example/", "Choose your country", "seen=1"), "document"),
            page(1.6, "https://shop.example/sandbox.html", "", ""),
            action(2.0, "click", Some("#us"), None, false),
            framed(page(3.0, "https://shop.example/?c=us", "Shop: home", "seen=1; region=us"), "document"),
        ];
        let found = choices(&session(&lines), "shop.example");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].asks.as_deref(), Some("Choose your country"));
    }

    /// An ordinary link earns no cookie, so reading on through a site is no choice.
    #[test]
    fn following_a_link_is_no_choice() {
        let mut lines = choosing();
        lines[3] = page(3.0, "https://shop.example/lamps", "Lamps", "seen=1");
        assert!(choices(&session(&lines), "shop.example").is_empty());
    }

    /// A page that comes back the same after the step asked for nothing.
    #[test]
    fn the_same_page_again_is_no_choice() {
        let mut lines = choosing();
        lines[3] = page(3.0, "https://shop.example/?c=us", "Choose your country", "seen=1; region=us");
        assert!(choices(&session(&lines), "shop.example").is_empty());
    }

    /// The agent opening a page is its own going there, not the page's answer to the step before it.
    #[test]
    fn a_page_the_agent_opened_is_no_ones_answer() {
        let mut lines = choosing();
        lines.insert(3, action(2.5, "navigate", None, Some("https://shop.example/?c=us"), false));
        assert!(choices(&session(&lines), "shop.example").is_empty());
    }

    /// A sign-in earns a cookie and another page too: it is a sign-in, never a choice to replay in the clear.
    #[test]
    fn a_sign_in_is_no_choice() {
        let mut lines = vec![action(1.0, "navigate", None, Some("https://shop.example/login"), false), page(1.5, "https://shop.example/login", "Sign in", "")];
        lines.push(action(2.0, "fill", Some("#password"), Some("vault:shop.example:me"), true));
        lines.push(action(2.5, "click", Some("#go"), None, false));
        lines.push(page(3.0, "https://shop.example/account", "Your account", "sid=abc"));
        let found = read(&session(&lines), "shop.example");
        assert_eq!(found.iter().map(|s| s.kind).collect::<Vec<_>>(), vec![Kind::SignIn]);
    }

    fn call(t: f64, method: &str, url: &str, cookie: &str) -> Value {
        let headers = if cookie.is_empty() { json!([]) } else { json!([{ "name": "cookie", "value": cookie }]) };
        json!({ "type": "exchange", "t": t, "resourceType": "XHR", "entry": { "_resourceType": "XHR",
            "request": { "method": method, "url": url, "headers": headers },
            "response": { "status": 200, "headers": [], "content": { "mimeType": "application/json", "text": "{}" } } } })
    }

    fn posted(t: f64, url: &str, body: &str, sets: &str) -> Value {
        let mut v = call(t, "POST", url, "seen=1");
        v["entry"]["request"]["postData"] = json!({ "text": body });
        v["entry"]["response"]["headers"] = json!([{ "name": "Set-Cookie", "value": format!("{sets}; Path=/") }]);
        v
    }

    fn picking(zip_call: Value) -> Vec<Value> {
        vec![
            action(1.0, "navigate", None, Some("https://shop.example/lamps"), false),
            page(1.5, "https://shop.example/lamps", "Lamps", "seen=1"),
            action(2.0, "fill", Some("#zip"), Some("94103"), false),
            action(3.0, "click", Some("#set-store"), None, false),
            zip_call,
            call(5.0, "GET", "https://shop.example/api/search?q=lamp", "seen=1; store=42"),
        ]
    }

    /// A store picked on the page: no page came, and no title asks again. The cookie its own call set stands for it, so a
    /// route that sends that cookie knows when the jar has lost it.
    #[test]
    fn a_call_that_sent_what_was_typed_and_set_a_cookie_is_a_quiet_choice() {
        let found = choices(&session(&picking(posted(3.1, "https://shop.example/api/store", "94103", "store=42"))), "shop.example");
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!((found[0].earns.as_slice(), &found[0].asks), (&["store".to_string()][..], &None));
        assert_eq!(found[0].steps[0], Step::Fill { at: "#zip".into(), value: "94103".into() });
        assert!(found[0].lost_from(&["store", "seen"], &|c| c == "seen"));
        assert!(!found[0].lost_from(&["store", "seen"], &|_| true), "the jar still holds it");
        assert!(!found[0].lost_from(&["seen"], &|_| false), "this route doesn't send it");
    }

    /// The walk that exposed it: a real site's bot sensor posts beside any click and sets cookies of its own. It carries
    /// nothing of the step and its body is big: it's no choice, however close it follows.
    #[test]
    fn a_sensor_beside_a_click_is_no_choice() {
        let sensor = posted(3.1, "https://shop.example/KkbDHhVOV39h/b4mOzDf3", &"sensor_data=x".repeat(100), "store=42");
        assert!(choices(&session(&picking(sensor)), "shop.example").is_empty());
    }

    /// A call that went out long after the step isn't the step's, unless it says what the step picked.
    #[test]
    fn a_late_call_that_says_nothing_of_the_step_is_no_choice() {
        let mut lines = picking(posted(4.5, "https://shop.example/api/beat", "{}", "store=42"));
        lines.insert(4, action(4.8, "read", None, None, false));
        assert!(choices(&session(&lines), "shop.example").is_empty());
    }

    /// A page that asked says so by its title: a cookie it happened to earn is no reason to answer it again.
    #[test]
    fn a_page_choice_answers_only_when_asked() {
        let found = choices(&session(&choosing()), "shop.example");
        assert!(!found[0].lost_from(&["region"], &|_| false));
    }

    /// A read a page makes as it goes earns nothing: a GET after a click is no change to the site.
    #[test]
    fn a_click_that_only_read_is_no_quiet_choice() {
        let lines = vec![
            action(1.0, "navigate", None, Some("https://shop.example/lamps"), false),
            page(1.5, "https://shop.example/lamps", "Lamps", "seen=1"),
            action(3.0, "click", Some("#more"), None, false),
            call(3.1, "GET", "https://shop.example/api/more", "seen=1"),
            call(5.0, "GET", "https://shop.example/api/more?p=2", "seen=1; visits=2"),
        ];
        assert!(choices(&session(&lines), "shop.example").is_empty());
    }

    /// A login typed on a provider's page is still this site's sign-in, and the provider's consent on the way back is a
    /// step of it: what comes after the site's own page isn't.
    #[test]
    fn a_sign_in_through_a_provider_runs_back_to_the_site() {
        let lines = vec![
            action(1.0, "navigate", None, Some("https://shop.example/login"), false),
            page(1.5, "https://shop.example/login", "Sign in", ""),
            action(2.0, "click", Some("#with-provider"), None, false),
            page(2.5, "https://id.provider.example/authorize", "Provider", ""),
            action(3.0, "fill", Some("#password"), Some("vault:id.provider.example:me"), true),
            action(3.5, "click", Some("#next"), None, false),
            page(4.0, "https://id.provider.example/consent", "Allow?", ""),
            action(4.5, "click", Some("#allow"), None, false),
            page(5.0, "https://shop.example/account", "Your account", "sid=1"),
            action(6.0, "click", Some("a.orders"), None, false),
        ];
        let s = sign_in(&session(&lines), "shop.example").unwrap();
        assert_eq!(s.steps.last(), Some(&Step::Click { at: "#allow".into() }));
        assert_eq!(s.steps.len(), 4, "{:?}", s.steps);
    }

    #[test]
    fn a_newer_setup_replaces_what_it_does_the_same_as() {
        let setup = |page: &str, asks: Option<&str>, kind| Setup { kind, page: page.into(), asks: asks.map(String::from), earns: Vec::new(), steps: Vec::new() };
        let kept = vec![setup("/a", None, Kind::SignIn), setup("/b", Some("Ask"), Kind::Choice)];
        let merged = merge(kept, vec![setup("/c", None, Kind::SignIn)]);
        assert_eq!(merged.iter().map(|s| s.page.as_str()).collect::<Vec<_>>(), ["/b", "/c"]);
        let many = (0..20).map(|i| setup("/x", Some(&format!("{i}")), Kind::Choice)).collect();
        assert_eq!(merge(Vec::new(), many).len(), MOST_KEPT);
        // However many choices come after it, the sign-in stands.
        let choices: Vec<Setup> = (0..MOST_KEPT + 3).map(|i| setup(&format!("/choice/{i}"), Some(&format!("asked {i}")), Kind::Choice)).collect();
        let merged = merge(vec![setup("/signin", None, Kind::SignIn)], choices);
        assert_eq!(merged.len(), MOST_KEPT);
        assert!(merged.iter().any(|s| s.kind == Kind::SignIn), "{merged:?}");
    }
}
