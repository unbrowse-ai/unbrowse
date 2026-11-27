//! What a reply came to, as one word of a closed set. Every reply of `unbrowse_do`, `unbrowse_call`, `unbrowse_browse`
//! and `unbrowse_challenge`, answered or failed, says its `outcome`, the reader that decided it (`outcome_from`), and
//! the call to make next as given (`next`, `{tool, args}`), absent when there is none. The prose stays in `why` and
//! `error`, for people: an agent branches on the word, never on a sentence.
//!
//! A reply's outcome is read once, where the reply is made: a place that knows more than the reply's own fields (a door
//! that held, a page that is gone) says it there (`Said::put`, `Failed::said`); the rest is read from the reply itself
//! (`outcome_of`) or, for a failure, from its status (`of_failure`), when it leaves the node (`stamp`). Nothing here
//! reads a walk: a warm call's outcome is its own `ok` and what it carries.

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The closed set: an agent can branch on every value, and nothing outside it is ever said.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    /// The site answered the ask.
    Answered,
    /// The site answered, and lists nothing for this value.
    AnsweredEmpty,
    /// Answered, with part of the answer left out (cut to the reply's size).
    AnsweredCut,
    /// The node answered before the work ended; the work goes on.
    StillWorking,
    /// Loading the page answers nothing: it needs clicks or typing.
    NeedsHands,
    /// A sign-in only the owner can give.
    NeedsPerson,
    /// A check for a person stood in the way.
    Challenge,
    /// The site's door refused this node.
    Refused,
    /// The page isn't there.
    Gone,
    /// The address can't be walked, or the call isn't this agent's to make.
    NotAllowed,
    /// Nothing kept does it, and nothing was learned.
    NoRoute,
    /// A route, or a step, was called and failed.
    CallFailed,
    /// The call ruled out the browser it needed.
    BrowserDeclined,
    /// The browser the node needs is absent or being fetched.
    BrowserMissing,
    /// The step needs the owner and none can be asked.
    OwnerUnavailable,
    /// A payment cap or a quota stopped it.
    BudgetSpent,
    /// The owner paused the node.
    Paused,
    /// The arguments are wrong.
    BadRequest,
    /// The agent gave up on the ask.
    Stopped,
}

impl Outcome {
    /// Every outcome, in the order the set is written.
    // Read by the manifest (`apischema`) and the tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) const ALL: [Outcome; 19] = [
        Outcome::Answered,
        Outcome::AnsweredEmpty,
        Outcome::AnsweredCut,
        Outcome::StillWorking,
        Outcome::NeedsHands,
        Outcome::NeedsPerson,
        Outcome::Challenge,
        Outcome::Refused,
        Outcome::Gone,
        Outcome::NotAllowed,
        Outcome::NoRoute,
        Outcome::CallFailed,
        Outcome::BrowserDeclined,
        Outcome::BrowserMissing,
        Outcome::OwnerUnavailable,
        Outcome::BudgetSpent,
        Outcome::Paused,
        Outcome::BadRequest,
        Outcome::Stopped,
    ];

    /// The word, as the wire says it.
    pub(crate) fn word(self) -> &'static str {
        match self {
            Outcome::Answered => "answered",
            Outcome::AnsweredEmpty => "answered_empty",
            Outcome::AnsweredCut => "answered_cut",
            Outcome::StillWorking => "still_working",
            Outcome::NeedsHands => "needs_hands",
            Outcome::NeedsPerson => "needs_person",
            Outcome::Challenge => "challenge",
            Outcome::Refused => "refused",
            Outcome::Gone => "gone",
            Outcome::NotAllowed => "not_allowed",
            Outcome::NoRoute => "no_route",
            Outcome::CallFailed => "call_failed",
            Outcome::BrowserDeclined => "browser_declined",
            Outcome::BrowserMissing => "browser_missing",
            Outcome::OwnerUnavailable => "owner_unavailable",
            Outcome::BudgetSpent => "budget_spent",
            Outcome::Paused => "paused",
            Outcome::BadRequest => "bad_request",
            Outcome::Stopped => "stopped",
        }
    }

    /// The outcome a reply names, if it names one of the set.
    pub(crate) fn of(v: &Value) -> Option<Outcome> {
        serde_json::from_value(v.get("outcome")?.clone()).ok()
    }
}

/// What every step the owner's pause stops answers, in its words: the one reading of `paused`. A failure with another
/// cause at the same status (the node waiting on its key, the vault unread, an entry off the ranking) is not paused.
pub(crate) const PAUSED: &str = "the node is paused by its owner";

/// The tools whose every reply names an outcome.
pub(crate) const TOOLS: &[&str] = &["unbrowse_do", "unbrowse_call", "unbrowse_browse", "unbrowse_challenge"];

/// The tools a `next` may name: those, and the search for a page or a route when no page was given.
pub(crate) const NEXT_TOOLS: &[&str] = &["unbrowse_do", "unbrowse_call", "unbrowse_browse", "unbrowse_challenge", "unbrowse_search", "unbrowse_setup"];

/// An outcome, the reader that decided it, and the call to make next.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Said {
    pub(crate) outcome: Outcome,
    /// The reader: `status`, `call.ok`, `learn.gone`, `unread`, …
    pub(crate) from: &'static str,
    /// `{tool, args}`: a call the agent can make as given.
    pub(crate) next: Option<Value>,
}

impl Said {
    pub(crate) fn new(outcome: Outcome, from: &'static str) -> Said {
        Said { outcome, from, next: None }
    }

    /// The same, with the call to make next.
    pub(crate) fn then(mut self, tool: &str, args: Value) -> Said {
        self.next = Some(json!({ "tool": tool, "args": args }));
        self
    }

    /// Written into a reply: `outcome`, `outcome_from`, and `next` (removed where there is none, so `next` is never
    /// anything but a call).
    pub(crate) fn put(&self, v: &mut Value) {
        let Some(o) = v.as_object_mut() else { return };
        o.insert("outcome".into(), json!(self.outcome.word()));
        o.insert("outcome_from".into(), json!(self.from));
        match &self.next {
            Some(next) => o.insert("next".into(), next.clone()),
            None => o.remove("next"),
        };
    }
}

/// A primitive's failure as an agent hears it: the status (kept over HTTP), the words, and what it came to.
#[derive(Clone, Debug)]
pub(crate) struct Failed {
    pub(crate) status: StatusCode,
    pub(crate) error: String,
    /// Said where the failure was made; else read from the status as it leaves the node (`stamp`).
    pub(crate) said: Option<Said>,
    /// What stood in the way, where the failure's words are another's: an ask stopped while its walk met a check.
    pub(crate) why: Option<String>,
    /// The ask it answers (`api::asks`).
    pub(crate) ask: Option<String>,
}

impl From<(StatusCode, String)> for Failed {
    fn from((status, error): (StatusCode, String)) -> Failed {
        Failed { status, error, said: None, why: None, ask: None }
    }
}

impl Failed {
    pub(crate) fn new(status: StatusCode, error: impl Into<String>, said: Said) -> Failed {
        Failed { status, error: error.into(), said: Some(said), why: None, ask: None }
    }

    /// The status and the words alone, for a caller that reads only those.
    #[cfg(test)]
    pub(crate) fn plain(self) -> (StatusCode, String) {
        (self.status, self.error)
    }

    /// A route's call that failed and ends what called it: what the call's status says, read as the call's.
    pub(crate) fn of_call((status, error): (StatusCode, String)) -> Failed {
        let said = Said { from: "call.status", ..of_failure("unbrowse_call", status, &error) };
        Failed::new(status, error, said)
    }
}

/// What a failure's status says it came to, for a failure nothing said more of. A 503 is `paused` only when it is the
/// owner's pause (`PAUSED`), and the owner's to give when the node waits on them for its key; any other is a step that
/// failed, its cause in its words.
pub(crate) fn of_failure(tool: &str, status: StatusCode, error: &str) -> Said {
    let browsing = matches!(tool, "unbrowse_browse" | "unbrowse_challenge");
    let outcome = match status.as_u16() {
        400 | 409 => Outcome::BadRequest,
        402 => Outcome::BudgetSpent,
        403 if browsing => Outcome::NeedsPerson,
        403 => Outcome::NotAllowed,
        404 if !browsing => Outcome::NoRoute,
        408 if browsing => Outcome::NeedsPerson,
        408 => Outcome::Stopped,
        410 => Outcome::Gone,
        424 => Outcome::BrowserMissing,
        // The node's own status for a call that ruled out the browser it needed (`api::BROWSER_DECLINED`).
        412 => return Said::new(Outcome::BrowserDeclined, "browser.declined"),
        503 if error == PAUSED => return Said::new(Outcome::Paused, "settings.paused"),
        // The node waits on the owner to let it read its key (the system's dialog): theirs to give, not a pause.
        503 if error == crate::WAITING_FOR_KEY => return Said::new(Outcome::NeedsPerson, "node.locked"),
        _ => Outcome::CallFailed,
    };
    Said::new(outcome, "status")
}

/// What a reply says it came to, read from its own fields: a call's `ok` and whether it was cut, a do's `how` and its
/// call's result, a browse step's `needs_owner` and the owner's answer, a check's `asks`.
pub(crate) fn outcome_of(tool: &str, v: &Value) -> Said {
    match tool {
        "unbrowse_call" => of_call(v, "call.ok", "call.truncated"),
        "unbrowse_do" => match v["how"].as_str() {
            Some("browse") => Said::new(Outcome::NeedsHands, "unread"),
            Some("pages") => of_pages(v),
            _ => match Outcome::of(&v["result"]) {
                // The reader the call's own reply named, where it is one a do repeats by name (the sandbox's).
                Some(outcome) => Said::new(outcome, repeated_from(&v["result"]).unwrap_or("result.outcome")),
                None => of_call(&v["result"], "result.ok", "result.truncated"),
            },
        },
        "unbrowse_browse" => match (v["needs_owner"].as_bool(), v["owner"].as_str()) {
            (Some(true), _) => Said::new(Outcome::NeedsHands, "browse.needs_owner"),
            (_, Some("done")) => Said::new(Outcome::Answered, "owner"),
            (_, Some(_)) => Said::new(Outcome::NeedsPerson, "owner"),
            _ => Said::new(Outcome::Answered, "browse.ran"),
        },
        "unbrowse_challenge" => match v["asks"].as_bool() {
            Some(false) => Said::new(Outcome::Answered, "challenge.asks"),
            _ => Said::new(Outcome::Challenge, "challenge.asks").then("unbrowse_challenge", json!({ "action": "look", "site": v["site"] })),
        },
        _ => Said::new(Outcome::Answered, "unread"),
    }
}

/// The sandbox's reader (`sandbox::unheld`) as a reply names it in `outcome_from`: no runtime, a runtime that lacks
/// what its own layer needs, or a layer of the sandbox that did not hold here (what the probe found, `sandbox::confined`).
pub(crate) fn unheld_from(u: &unbrowse_learn::sandbox::Unheld) -> &'static str {
    use unbrowse_learn::sandbox::Unheld;
    match u {
        Unheld::NoRuntime => "sandbox.no_runtime",
        Unheld::Lacks(_) => "sandbox.lacks",
        Unheld::NotConfined(_) => "sandbox.not_confined",
    }
}

/// A reply's `outcome_from` a do says again as its own: the readers a call's reply names that a do's place can't.
fn repeated_from(result: &Value) -> Option<&'static str> {
    use unbrowse_learn::sandbox::Unheld;
    let said = result["outcome_from"].as_str()?;
    [Unheld::NoRuntime, Unheld::Lacks(String::new()), Unheld::NotConfined(String::new())].iter().map(unheld_from).find(|f| *f == said)
}

/// What a call's reply says when the sandbox ran none of the page's code (`sandbox::unheld`): which reader said so,
/// the fact as the sandbox says it, what the owner can do, and what answers meanwhile. A call that failed for it
/// names it as its outcome's reader too (`unheld_said`).
pub(crate) fn held_back(u: &unbrowse_learn::sandbox::Unheld) -> Value {
    held_back_with(u, "the browser runs what the page's code would: unbrowse_do on the page with browser \"auto\" answers through it, slower")
}

/// [`held_back`], with what answers meanwhile said for where it is said (a call; a learn, whose page is the browser's
/// to read).
pub(crate) fn held_back_with(u: &unbrowse_learn::sandbox::Unheld, meanwhile: &str) -> Value {
    use unbrowse_learn::sandbox::Unheld;
    let owner_can = match u {
        Unheld::NoRuntime => "install a JavaScript runtime (Node) on the node's PATH, or set SIGNING_PROGRAM to one, then restart the node",
        Unheld::Lacks(_) => "put a runtime that has it (a newer Node) first on the node's PATH, or set SIGNING_PROGRAM to one, then restart the node",
        Unheld::NotConfined(_) => "run the node where that layer holds, or set SIGNING_PROGRAM to a runtime the sandbox can hold, then restart the node",
    };
    json!({
        "outcome_from": unheld_from(u),
        "fact": u.said(),
        "owner_can": owner_can,
        "meanwhile": meanwhile,
    })
}

/// A call that failed where the sandbox ran none of the page's code: a failed call, the sandbox's reader its cause.
pub(crate) fn unheld_said(u: &unbrowse_learn::sandbox::Unheld) -> Said {
    Said::new(Outcome::CallFailed, unheld_from(u))
}

/// A call's answer: `ok`, cut where it says so, and empty where its data lists nothing (`lists_nothing`, with no
/// value of the ask to hold it to here: the call's own place says that, `answered_with`).
fn of_call(v: &Value, ok: &'static str, cut: &'static str) -> Said {
    match v["ok"].as_bool() {
        Some(true) if !v["truncated"].is_null() => Said::new(Outcome::AnsweredCut, cut),
        Some(true) if lists_nothing(&v["data"], &[]) => Said::new(Outcome::AnsweredEmpty, "call.data"),
        Some(true) => Said::new(Outcome::Answered, ok),
        _ => Said::new(Outcome::CallFailed, ok),
    }
}

/// A call's answer as its own place says it, knowing the values it asked: one that lists nothing for them is
/// `answered_empty`; the rest is left to the answer's own fields (`outcome_of`).
pub(crate) fn answered_with<'a>(reply: &mut Value, asked: impl IntoIterator<Item = &'a String>) {
    let asked: Vec<&str> = asked.into_iter().map(String::as_str).collect();
    if reply["ok"].as_bool() == Some(true) && reply["truncated"].is_null() && lists_nothing(&reply["data"], &asked) {
        Said::new(Outcome::AnsweredEmpty, "call.data").put(reply);
    }
}

/// Whether an answer lists nothing, by the one reader of an empty answer (`answer::lists_nothing`), which a confirming
/// browse asks too.
pub(crate) use unbrowse_learn::answer::lists_nothing;

/// Several pages at once: still working while any is pending, answered when any page answered, else what the first
/// page came to.
pub(crate) fn of_pages(v: &Value) -> Said {
    let pages = v["pages"].as_array().map(Vec::as_slice).unwrap_or_default();
    let pending = v["pending"].as_array().is_some_and(|p| !p.is_empty());
    let answered = pages.iter().any(|p| matches!(Outcome::of(p), Some(Outcome::Answered | Outcome::AnsweredCut | Outcome::AnsweredEmpty)));
    match pages.first().and_then(Outcome::of) {
        _ if pending => Said::new(Outcome::StillWorking, "pages.pending"),
        _ if answered => Said::new(Outcome::Answered, "pages"),
        Some(first) => Said::new(first, "pages"),
        None => Said::new(Outcome::NoRoute, "pages"),
    }
}

/// A reply of one of `TOOLS` as it leaves the node: what it already says, else what its own fields say, or for a
/// failure its status.
pub(crate) fn stamp(tool: &str, r: &mut Result<Value, Failed>) {
    if !TOOLS.contains(&tool) {
        return;
    }
    match r {
        Ok(v) if v.get("outcome").is_none() => outcome_of(tool, v).put(v),
        Ok(_) => {}
        Err(f) => {
            if f.said.is_none() {
                f.said = Some(of_failure(tool, f.status, &f.error));
            }
        }
    }
}

/// A failure's body, with what it came to beside its words, and what stood in the way where that is said apart.
pub(crate) fn failure_body(mut body: Value, f: &Failed) -> Value {
    if let Some(said) = &f.said {
        said.put(&mut body);
    }
    if let Some(why) = &f.why {
        body["why"] = json!(why);
    }
    if let Some(ask) = &f.ask {
        body["ask"] = json!(ask);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words are the wire's: serde's snake case, one each, nineteen.
    /// A page read as the answer that links nowhere and holds no records lists nothing; one that links to a result,
    /// or whose state holds one, lists something.
    #[test]
    fn a_page_read_as_the_answer_says_when_it_lists_nothing() {
        let page = |links: Value, state: Value| json!({ "title": "Search · shop.example", "state": state, "text": "Search\nNo results for \"zqxv\". Try another word.", "links": links });
        assert!(lists_nothing(&page(json!([]), Value::Null), &[]));
        assert!(lists_nothing(&page(json!([]), json!({ "search": { "q": "zqxv", "hits": [] } })), &["zqxv"]));
        assert!(!lists_nothing(&page(json!([{ "text": "Brass desk lamp", "url": "https://shop.example/p/1" }]), Value::Null), &[]));
        assert!(!lists_nothing(&page(json!([]), json!({ "hits": [{ "name": "Brass desk lamp" }] })), &[]));
        // As a call's outcome: answered, empty.
        let said = outcome_of("unbrowse_call", &json!({ "ok": true, "data": page(json!([]), Value::Null), "truncated": null }));
        assert_eq!((said.outcome, said.from), (Outcome::AnsweredEmpty, "call.data"));
        let said = outcome_of("unbrowse_do", &json!({ "how": "called", "result": { "ok": true, "data": page(json!([]), Value::Null), "truncated": null } }));
        assert_eq!(said.outcome, Outcome::AnsweredEmpty);
    }

    /// JSON that only says back what was asked, beside a list with nothing in it, is the site's empty answer for the
    /// value; a list with a record, or words of the site's own beside it, is not.
    #[test]
    fn an_answer_echoing_the_query_beside_an_empty_list_is_empty() {
        let asked = ["zqxv"];
        assert!(lists_nothing(&json!({ "query": "zqxv", "results": [], "total": 0, "page": 1, "exact": true }), &asked));
        assert!(lists_nothing(&json!({ "data": { "search": { "term": "ZQXV", "items": [] } } }), &asked));
        assert!(lists_nothing(&json!([]), &[]));
        assert!(!lists_nothing(&json!({ "query": "zqxv", "results": [{ "name": "Brass desk lamp" }] }), &asked));
        assert!(!lists_nothing(&json!({ "query": "zqxv", "results": [], "message": "the search is down for a moment" }), &asked));
        assert!(!lists_nothing(&json!({ "query": "zqxv", "total": 0 }), &asked), "no list, nothing said of one");
        assert!(!lists_nothing(&json!({ "query": "zqxv", "results": [] }), &[]), "an echo is only one of what was asked");
        let mut reply = json!({ "ok": true, "data": { "query": "zqxv", "results": [] }, "truncated": null });
        answered_with(&mut reply, &["zqxv".to_string()]);
        assert_eq!((reply["outcome"].as_str(), reply["outcome_from"].as_str()), (Some("answered_empty"), Some("call.data")));
        let mut failed = json!({ "ok": false, "data": { "query": "zqxv", "results": [] }, "truncated": null });
        answered_with(&mut failed, &["zqxv".to_string()]);
        assert!(failed.get("outcome").is_none(), "a failed call is not an empty answer");
    }

    #[test]
    fn the_set_is_closed_and_said_as_the_wire_says_it() {
        let words: std::collections::BTreeSet<&str> = Outcome::ALL.iter().map(|o| o.word()).collect();
        assert_eq!(words.len(), 19);
        for o in Outcome::ALL {
            assert_eq!(json!(o), json!(o.word()));
            assert_eq!(serde_json::from_value::<Outcome>(json!(o.word())).unwrap(), o);
        }
        assert!(serde_json::from_value::<Outcome>(json!("timed_out")).is_err(), "nothing outside the set");
    }
}

#[cfg(test)]
mod unheld_tests {
    use super::*;
    use unbrowse_learn::sandbox::Unheld;

    fn reply_of(u: Unheld, ok: bool) -> Value {
        let mut out = json!({ "ok": ok, "data": null });
        out["held_back"] = held_back(&u);
        if !ok {
            unheld_said(&u).put(&mut out);
        }
        stamp_ok(&mut out);
        out
    }

    fn stamp_ok(v: &mut Value) {
        let mut r: Result<Value, Failed> = Ok(v.take());
        stamp("unbrowse_call", &mut r);
        *v = r.ok().unwrap();
    }

    /// No runtime on the machine: the reply names the sandbox's reader, says the fact in the reader's own words, and
    /// says what the owner can do and what answers meanwhile. A call that failed for it says so as its outcome's cause;
    /// a do that carried the call says the same reader.
    #[test]
    fn no_runtime_is_said_as_the_sandboxs_reader_with_its_next_steps() {
        let failed = reply_of(Unheld::NoRuntime, false);
        assert_eq!((failed["outcome"].as_str(), failed["outcome_from"].as_str()), (Some("call_failed"), Some("sandbox.no_runtime")), "{failed}");
        let held = &failed["held_back"];
        assert_eq!(held["outcome_from"], "sandbox.no_runtime");
        assert_eq!(held["fact"], Unheld::NoRuntime.said());
        assert!(held["owner_can"].as_str().unwrap().contains("SIGNING_PROGRAM"), "{held}");
        assert!(held["meanwhile"].as_str().unwrap().contains("browser"), "{held}");
        let done = outcome_of("unbrowse_do", &json!({ "how": "called", "result": failed }));
        assert_eq!((done.outcome, done.from), (Outcome::CallFailed, "sandbox.no_runtime"));
    }

    /// A runtime that can't be held (it lacks what its own layer needs, or a layer refused): told apart from none,
    /// never "no runtime", each by its own reader. A call that still answered (the browser did the page's code) is
    /// answered, and says the fact beside it.
    #[test]
    fn a_runtime_that_cant_be_held_is_said_apart_from_none_and_an_answer_still_stands() {
        let lacks = Unheld::Lacks("has no permission model (process.permission)".into());
        let failed = reply_of(lacks.clone(), false);
        assert_eq!(failed["outcome_from"], "sandbox.lacks", "{failed}");
        assert!(!failed["held_back"]["fact"].as_str().unwrap().contains("no JavaScript runtime"));
        assert!(failed["held_back"]["fact"].as_str().unwrap().contains("permission model"));
        assert!(failed["held_back"]["owner_can"].as_str().unwrap().contains("first on the node's PATH"));
        let answered = reply_of(lacks, true);
        assert_eq!(answered["outcome"], "answered", "{answered}");
        assert_eq!(answered["held_back"]["outcome_from"], "sandbox.lacks");
        let refused = reply_of(Unheld::NotConfined("the network was reachable".into()), false);
        assert_eq!(refused["outcome_from"], "sandbox.not_confined", "{refused}");
        let done = outcome_of("unbrowse_do", &json!({ "how": "called", "result": refused }));
        assert_eq!(done.from, "sandbox.not_confined");
    }
}

#[cfg(test)]
#[path = "outcome_cov_tests.rs"]
mod outcome_cov_tests;
