//! One reading of an answer that is the site refusing the caller, and of what may clear it.
//!
//! The pieces that tell a wall from a page were written where each was first needed (`trace::REFUSED`, `page::a_door`,
//! `challenge::shows_a_widget`, `answer::check_url`, `verify::challenge_response`). This is the one place that puts
//! them in an order and gives the result a name, so whoever meets a refusal (a replay, a walk, the report to the
//! agent) reads it the same way, and so what is tried against it is data here and not an order written into a call.
//!
//! Every test is a property of the answer itself: its status, what its page holds, what its body says. No vendor is
//! named. A wall nobody has met yet reads the same as one everybody has.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

/// What an answer is, when it is the site refusing the caller.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "wall", rename_all = "snake_case")]
pub enum Wall {
    /// The answer names the address of a check to pass (`answer::check_url`): a failure code beside a page to go to.
    Check { url: String },
    /// A page that shows a check's widget: it waits for a person, or for a token a person's answer would make.
    Person,
    /// A page that only waits on its own code: it runs a script, asks for nothing and links nowhere on its site. The
    /// script earns the pass by itself, wherever it is run.
    Script,
    /// The site is out of asks for this caller (429): nothing clears it but time.
    Rate,
    /// The session is not one the site takes (401).
    Session,
    /// A body that is a puzzle and not the site's data (`verify::challenge_response`).
    Puzzle,
    /// Refused outright (403, 503) with no page that says how to pass: the caller itself was judged, before any page.
    Refused,
}

/// One answer, as much of it as a reading needs.
pub struct Answer<'a> {
    pub status: u16,
    pub body: &'a str,
    /// The address the answer came from.
    pub url: &'a Url,
    /// The address that was asked for, where it is known: an answer from another address that carries this one as a
    /// value stands in front of it, and what the asked address named says what a page there would say.
    pub asked: Option<&'a Url>,
}

/// Whether the answer's address carries the asked one as a value: the page shown is to be passed on the way to the
/// page asked for (`?continue=<the page>`), so it is not that page.
fn stands_in_front(a: &Answer) -> bool {
    let Some(asked) = a.asked else { return false };
    if asked.path() == a.url.path() && asked.host_str() == a.url.host_str() {
        return false;
    }
    let whole = format!("{}{}", asked.origin().ascii_serialization(), asked.path());
    let path = asked.path();
    a.url.query_pairs().any(|(_, v)| v.starts_with(&whole) || (path.len() > 1 && v.starts_with(path)))
}

/// The wall an answer is, or None when it is a page or data of the site (or a plain error of its own: a 404, a 500).
///
/// Read in this order, the more a reading says first: an answer that names its check page; a page with a widget on
/// it and nothing else; a page that only runs code; then what the status alone says. A page of the site that carries
/// a widget among its own content (a form with a check before its submit) is the page asked for, not a wall.
pub fn read(a: &Answer) -> Option<Wall> {
    let json: Option<Value> = serde_json::from_str(a.body).ok();
    if let Some(url) = json.as_ref().and_then(crate::answer::check_url) {
        return Some(Wall::Check { url });
    }
    let html = a.body.trim_start().starts_with('<');
    if html {
        let door = crate::page::a_door(200, a.body, a.url);
        if crate::challenge::shows_a_widget(a.body, a.url) && (!crate::challenge::a_page_with_a_check(a.body, a.url) || stands_in_front(a)) {
            return Some(Wall::Person);
        }
        if door {
            return Some(Wall::Script);
        }
        // A page that links nowhere, says a few lines and says nothing of what the asked address named is a refusal
        // said in a page, whatever status it came with (`page::a_check_not_the_page`). Not a site out of asks: it has
        // said why in its status, and no door passes a rate limit — only time does (`Wall::Rate`, below).
        let named: Vec<String> = a.asked.map(|u| u.query_pairs().map(|(_, v)| v.into_owned()).collect()).unwrap_or_default();
        let named: Vec<&str> = named.iter().map(String::as_str).collect();
        if a.status != 429 && crate::page::a_check_not_the_page(&crate::page::read(a.body, a.url), &named).is_some() {
            return Some(Wall::Refused);
        }
    }
    match a.status {
        429 => return Some(Wall::Rate),
        401 => return Some(Wall::Session),
        _ => {}
    }
    if json.as_ref().is_some_and(|v| crate::verify::challenge_response(a.url, v)) {
        return Some(Wall::Puzzle);
    }
    crate::trace::REFUSED.contains(&a.status).then_some(Wall::Refused)
}

/// A way a wall may be cleared, from the cheapest to the dearest. Each is something the node already knows how to
/// do; which are tried, and in what order, is read from the wall (`Wall::sources`), never written into a call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// Wait: the site said when to ask again, or nothing but time helps.
    Wait,
    /// The site's own page, asked again over the call's wire, hands the pass back in a cookie.
    Page,
    /// The door's page, run in the sandbox: its script writes the pass.
    Sandbox,
    /// The owner's own browser on this machine already holds a session the site takes: it is taken in.
    OwnerSession,
    /// The node's engine opens the page and lets it run: the pass it earns is harvested.
    Engine,
    /// The owner's saved sign-in for the site.
    SignIn,
    /// A solver the owner configured answers the check.
    Solver,
    /// The owner, in a window.
    Owner,
}

impl Wall {
    /// What may clear this wall, in the order to try it. A source the node lacks (no engine, no solver set) is passed
    /// over by whoever runs the list; the order itself is the wall's.
    pub fn sources(&self) -> &'static [Source] {
        use Source::*;
        match self {
            Wall::Rate => &[Wait],
            Wall::Session => &[Page, OwnerSession, SignIn, Owner],
            Wall::Script => &[Page, Sandbox, Engine],
            Wall::Refused => &[Page, OwnerSession, Engine],
            Wall::Check { .. } | Wall::Person | Wall::Puzzle => &[OwnerSession, Engine, Solver, Owner],
        }
    }

    /// Whether anything of the node's own may clear it without a person.
    pub fn clears_alone(&self) -> bool {
        self.sources().iter().any(|s| !matches!(s, Source::Owner | Source::Wait))
    }
}

/// What a source handed back: the values to send from now on, how long they last, and the client they were earned
/// by. A pass is the earner's: sent by another client it is refused, and sometimes refused where no pass at all
/// would have been let through. `bound_to` is that client's name (`identity_of`); a jar keeps it beside the value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cleared {
    pub cookies: std::collections::BTreeMap<String, String>,
    /// Seconds the pass lasts, where the site said.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ttl: Option<u64>,
    /// The client that earned it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_to: Option<String>,
    pub by: Option<Source>,
}

/// A client's name for binding a pass to it: a digest of what a site can tell one client from another by and that
/// this node controls: the browser it presents as (the sampled fingerprint: user agent, client hints, the handshake
/// it shapes) and the address it leaves from. Two calls with the same name look like one client to a site; a pass
/// earned under one name is not sent under another.
pub fn identity_of(fingerprint: &Value, egress: &str) -> String {
    use sha2::{Digest, Sha256};
    // The sample's members in one order whatever order they were written in: the same sample, the same name.
    fn plain(v: &Value, out: &mut String) {
        match v {
            Value::Object(o) => {
                let mut keys: Vec<&String> = o.keys().collect();
                keys.sort();
                out.push('{');
                for k in keys {
                    out.push_str(k);
                    out.push(':');
                    plain(&o[k], out);
                    out.push(',');
                }
                out.push('}');
            }
            Value::Array(a) => {
                out.push('[');
                for x in a {
                    plain(x, out);
                    out.push(',');
                }
                out.push(']');
            }
            other => out.push_str(&other.to_string()),
        }
    }
    let mut said = String::new();
    plain(fingerprint, &mut said);
    let mut h = Sha256::new();
    h.update(said.as_bytes());
    h.update([0]);
    h.update(egress.as_bytes());
    h.finalize().iter().take(8).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(u: &str) -> Url {
        Url::parse(u).unwrap()
    }

    fn wall(status: u16, body: &str) -> Option<Wall> {
        let asked = at("https://shop.example.com/search?q=lamp");
        read(&Answer { status, body, url: &asked, asked: Some(&asked) })
    }

    /// A check shown at another address, carrying the asked one to continue to, stands in front of the page however
    /// much of a page it is itself (a form, links around the site): it is a check for a person. The same page at the
    /// address that was asked for is that address's own page.
    #[test]
    fn a_check_that_carries_the_asked_address_stands_in_front_of_it() {
        let page = r#"<html><head><script src="/w.js"></script></head><body><a href="/terms">Terms</a><form action="index"><div data-sitekey="k1"></div><textarea name="response"></textarea><input type="hidden" name="continue" value="https://shop.example.com/search?q=lamp"></form><p>Unusual traffic from your network.</p></body></html>"#;
        let asked = at("https://shop.example.com/search?q=lamp");
        let shown = at("https://shop.example.com/sorry/index?continue=https://shop.example.com/search%3Fq%3Dlamp&t=1");
        assert_eq!(read(&Answer { status: 200, body: page, url: &shown, asked: Some(&asked) }), Some(Wall::Person));
        assert_eq!(read(&Answer { status: 200, body: page, url: &asked, asked: Some(&asked) }), None, "at the asked address it is that address's page, with a check on it");
        assert_eq!(read(&Answer { status: 200, body: page, url: &shown, asked: None }), None, "with no asked address known, nothing says it stands in front");
    }

    /// A refusal said in a page and served as a page (200): it links nowhere, runs nothing, and says nothing of what
    /// was asked. A short page that does say what was asked ("No results for lamp") is the site's answer.
    #[test]
    fn a_page_that_only_says_no_is_a_refusal_whatever_its_status() {
        assert_eq!(wall(200, "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don't have permission to access this on this server.<p>Reference 18.8ba2</p></body></html>"), Some(Wall::Refused));
        assert_eq!(wall(200, "<html><body><p>No results for lamp.</p></body></html>"), None);
    }

    const PAGE: &str = r#"<html><head><title>Lamps</title><script src="/app.js"></script></head><body><a href="/lamps/1">Brass lamp</a><a href="/lamps/2">Desk lamp</a><form><input name="q"></form></body></html>"#;
    const WAITS: &str = r#"<html><head><title>One moment</title></head><body><script src="/check.js"></script><p>Checking.</p></body></html>"#;
    const WIDGET: &str = r#"<html><head><script src="/w.js"></script></head><body><div data-sitekey="k1"></div><p>Confirm you are a person.</p></body></html>"#;
    const FORM_WITH_A_CHECK: &str = r#"<html><body><a href="/">Home</a><form><input name="email"><div data-sitekey="k1"></div><button>Join</button></form></body></html>"#;

    /// Each kind of refusal is read from the answer's own properties, in one order, and a page of the site is none.
    #[test]
    fn every_refusal_has_one_name_and_a_page_has_none() {
        assert_eq!(wall(200, PAGE), None, "a page that links around its site and asks for something");
        assert_eq!(wall(200, r#"{"items":[{"name":"Lamp"}]}"#), None, "the site's data");
        assert_eq!(wall(404, "<html><body><a href=\"/\">Home</a><p>Not found</p></body></html>"), None, "the site's own error is not a wall");
        assert_eq!(wall(200, WAITS), Some(Wall::Script), "a page that only waits on its own code, whatever its status");
        assert_eq!(wall(403, WAITS), Some(Wall::Script));
        assert_eq!(wall(200, WIDGET), Some(Wall::Person));
        assert_eq!(wall(403, WIDGET), Some(Wall::Person), "what the page holds says more than its status");
        assert_eq!(wall(200, FORM_WITH_A_CHECK), None, "a form of the site with a check before its submit is the page asked for");
        assert_eq!(wall(429, "slow down"), Some(Wall::Rate));
        assert_eq!(
            wall(429, "<html><head><title>429 Too Many Requests</title></head><body><center><h1>429 Too Many Requests</h1></center><hr><center>nginx</center></body></html>"),
            Some(Wall::Rate),
            "out of asks is what its status says: a page that only says no beside a 429 is no door, and time is all that clears it"
        );
        assert_eq!(wall(429, WIDGET), Some(Wall::Person), "a check for a person beside a 429 is still one a person may pass");
        assert_eq!(wall(401, "{}"), Some(Wall::Session));
        assert_eq!(wall(403, "Forbidden"), Some(Wall::Refused));
        assert_eq!(wall(503, ""), Some(Wall::Refused));
        assert_eq!(wall(200, r#"{"ret":["FAIL_SYS_USER_VALIDATE"],"data":{"url":"https://shop.example.com/_check/punish?x=1"}}"#), Some(Wall::Check { url: "https://shop.example.com/_check/punish?x=1".into() }));
        assert_eq!(wall(200, r#"{"captcha_token":"a","challenge":"b"}"#), Some(Wall::Puzzle));
    }

    /// What is tried against a wall is read from the wall: a page that earns its own pass never asks a person, time
    /// alone clears a site out of asks, and a check for a person tries the owner's own session and the engine before
    /// a solver, and the owner last.
    #[test]
    fn what_clears_a_wall_is_read_from_the_wall() {
        use Source::*;
        assert_eq!(Wall::Script.sources(), &[Page, Sandbox, Engine]);
        assert!(!Wall::Script.sources().contains(&Owner) && Wall::Script.clears_alone());
        assert_eq!(Wall::Rate.sources(), &[Wait]);
        assert!(!Wall::Rate.clears_alone());
        let person = Wall::Person.sources();
        assert_eq!(person.last(), Some(&Owner), "the owner is asked last");
        assert!(person.iter().position(|s| *s == OwnerSession) < person.iter().position(|s| *s == Solver));
        assert_eq!(Wall::Check { url: String::new() }.sources(), person, "a named check and a widget are cleared the same ways");
    }

    /// A client's name is the same for the same browser and address, and another for another of either.
    #[test]
    fn a_client_is_named_by_what_a_site_can_tell_it_by() {
        let chrome = serde_json::json!({"userAgent": "Mozilla/5.0 Chrome/158", "platform": "macOS"});
        let other = serde_json::json!({"userAgent": "Mozilla/5.0 Chrome/145", "platform": "Windows"});
        let reordered = serde_json::json!({"platform": "macOS", "userAgent": "Mozilla/5.0 Chrome/158"});
        assert_eq!(identity_of(&chrome, "own"), identity_of(&reordered, "own"), "the same sample written in another order");
        assert_ne!(identity_of(&chrome, "own"), identity_of(&other, "own"), "another browser");
        assert_ne!(identity_of(&chrome, "own"), identity_of(&chrome, "proxy:1.2.3.4"), "another address");
        assert_eq!(identity_of(&chrome, "own").len(), 16);
    }
}
