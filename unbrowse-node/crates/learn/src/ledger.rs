//! What a call did to the site, and whether it may be run again.
//!
//! A read changes nothing, so a failed read may always be healed and retried. A
//! write may have changed the site before it failed, and running it again would
//! buy twice, book twice or send twice. Each write step is a commit mark, read
//! from the route's own shape rather than declared by hand: the target of a
//! write route is its commit, and every other write step is one too, whatever
//! it answered. A write that answered with a cookie may be a sign-in, or it may
//! be the site's state kept in a cookie (a cart line); its traffic can't tell
//! which, and sending a cart line twice costs more than a heal that can't sign
//! in again (the owner's call, audit CRATE-01.3).
//!
//! A mark is `NotSent` until its request is about to go out, `Sent` from the
//! moment it may have reached the site (the site answering at all, or the
//! transport failing after the request was handed over), and `Confirmed` only
//! where the site's own answer proves the write landed. Only a run whose marks
//! all stayed `NotSent` may be retried as it was.

use serde::{Deserialize, Serialize};

use crate::graph::{Graph, Step};

/// Whether a step changes state on the site. Anything but GET and HEAD does, except the POSTs sites use only to ask:
/// a search or query endpoint, a GraphQL request that is a query rather than a mutation, or a call the page sent by
/// itself as it loaded, before anything was done on it, that answered 2xx with data and set no cookie: every visit
/// to the page sends that call again, so calling it does nothing a visit doesn't. Those read, and are not commits.
/// One rule, used by the ledger and by the store's labelling, and by the learner by example through [`Call`].
pub fn writes(step: &Step) -> bool {
    writes_as(step, step.foreign)
}

/// [`writes`], with the step read as someone else's code (`foreign`) or as the node's own walk, whatever its mark: a
/// fetched route is held to the foreign rule even before its steps carry the mark, and a body is published as its
/// own walk read it, whichever node marked it.
pub fn writes_as(step: &Step, foreign: bool) -> bool {
    Call::of(step, foreign).writes()
}

/// A step as the rule of writes reads it: what a graph's step holds and a step learned by example holds too, so
/// both are asked of one rule ([`Call::writes`]).
#[derive(Clone, Debug)]
pub struct Call<'a> {
    pub method: &'a str,
    /// The address as the route holds it; a query on it is read as [`Call::query`] would be.
    pub address: &'a str,
    /// The status the site answered with when the step was learned.
    pub status: u16,
    /// The step is someone else's: its request is the body's word, and none of the read exceptions apply.
    pub foreign: bool,
    /// The page sent this call by itself as it loaded, before anything was done on it, and it answered with data.
    pub on_load: bool,
    /// Its recorded answer set a cookie.
    pub sets_cookie: bool,
    /// The texts the step's body sends as its walk sent them, each at its place: the route's own text (a leaf its
    /// template keeps, a part's text, a fixed field, a value sent as walked beside the template), never a value the
    /// caller or an earlier answer fills.
    pub body: Vec<(crate::slots::Loc, std::borrow::Cow<'a, str>)>,
    /// The values the step's address sends as the route holds them, where they are not in `address` itself.
    pub query: Vec<std::borrow::Cow<'a, str>>,
}

impl<'a> Call<'a> {
    /// A graph's step, read as the rule reads it.
    pub fn of(step: &'a Step, foreign: bool) -> Call<'a> {
        use crate::graph::Body;
        use crate::slots::Loc;
        use std::borrow::Cow;
        let mut body: Vec<(Loc, Cow<'a, str>)> = Vec::new();
        let leaves = |v: &serde_json::Value, at: &dyn Fn(String) -> Loc| crate::slots::json_leaves(v).into_iter().map(|(pointer, leaf)| (at(pointer), Cow::Owned(leaf))).collect::<Vec<_>>();
        match &step.body {
            Some(Body::Json { template, .. }) => body.extend(leaves(template, &Loc::Json)),
            Some(Body::Multipart { parts, .. }) => {
                for p in parts {
                    if let Some(j) = &p.json {
                        body.extend(leaves(j, &|pointer| Loc::Part(p.name.clone(), pointer)));
                    }
                    if let Some(t) = &p.text {
                        body.push((Loc::Part(p.name.clone(), String::new()), Cow::Borrowed(t.as_str())));
                    }
                }
            }
            Some(Body::Form { fields }) => body.extend(fields.iter().filter_map(|(name, v)| Some((Loc::Form(name.clone()), Cow::Borrowed(v.as_deref()?))))),
            Some(Body::Other) | Some(Body::Upload { .. }) | None => {}
        }
        body.extend(sent_as_walked(step).filter(|(loc, _)| matches!(loc, Loc::Json(_) | Loc::Form(_))).map(|(loc, text)| (loc.clone(), Cow::Borrowed(text))));
        Call { method: &step.method, address: &step.url, status: step.status, foreign, on_load: step.on_load, sets_cookie: step.sets_cookie, body, query: Vec::new() }
    }

    /// Whether the step changes state on the site: the rule [`writes`] says.
    pub fn writes(&self) -> bool {
        if matches!(self.method, "GET" | "HEAD") {
            return false;
        }
        // A step of someone else's body says its own path and body: a decoy `search` path or `query` value proves nothing.
        if self.method != "POST" || self.foreign {
            return true;
        }
        if self.on_load && (200..300).contains(&self.status) && !self.sets_cookie {
            return false;
        }
        let path = self.address.split(['?', '#']).next().unwrap_or_default().to_ascii_lowercase();
        let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
        let asks = matches!(last, "query" | "queries" | "search" | "_search" | "msearch" | "_msearch" | "autocomplete" | "suggest");
        let graphql_query = (path.contains("graphql") || self.posts_a_graphql_document()) && self.proves_a_query();
        !(asks || graphql_query)
    }

    /// Whether the step posts a GraphQL request, by the request's own shape and whatever its address: a JSON body whose
    /// `query` member is a document that asks. A site may serve GraphQL at any path (`/v1`).
    fn posts_a_graphql_document(&self) -> bool {
        self.body.iter().any(|(loc, text)| matches!(loc, crate::slots::Loc::Json(at) if at == "/query") && a_query_document(text))
    }

    /// Whether the step's own recorded request proves it is a GraphQL query: the route keeps the operation's text (a
    /// constant the template holds, not a blanked slot), and it is a query document, with no mutation in anything the
    /// request carries. A template whose operation was blanked, or a persisted query that sends only a hash, proves
    /// nothing, and a call that may write is held to the write rules.
    fn proves_a_query(&self) -> bool {
        let mut texts: Vec<&str> = self.body.iter().map(|(_, text)| text.as_ref()).collect();
        let in_address: Vec<String> = self.address.split_once('?').map(|(_, query)| url::form_urlencoded::parse(query.as_bytes()).map(|(_, v)| v.into_owned()).collect()).unwrap_or_default();
        texts.extend(in_address.iter().map(String::as_str).chain(self.query.iter().map(|v| v.as_ref())).filter(|v| !v.starts_with('{') || !v.ends_with('}') || v.contains(' ')));
        texts.iter().any(|t| a_query_document(t)) && !texts.iter().any(|t| t.contains("mutation"))
    }
}

/// Whether a text is a GraphQL document that asks: it opens with `query`, or with a selection (`{`, and is no JSON),
/// or with the fragments its query uses, the query after them. A document may define its fragments first.
fn a_query_document(text: &str) -> bool {
    let t = text.trim_start();
    let opens = |t: &str| t.starts_with("query") || (t.starts_with('{') && serde_json::from_str::<serde_json::Value>(t).is_err());
    opens(t) || (t.starts_with("fragment ") && t.lines().any(|l| l.starts_with("query") && l[5..].starts_with([' ', '(', '{'])))
}

/// The values a step sends as its walk sent them, each with its place: the route's own text, whether it sits in the
/// body's template or in a field beside it (a route rebuilt from a fresh sighting keeps a long text there). A slot
/// the caller or an earlier answer fills is not among them.
fn sent_as_walked(step: &Step) -> impl Iterator<Item = (&crate::slots::Loc, &str)> {
    step.fields.iter().filter_map(|f| match &f.class {
        crate::graph::Class::Constant { value, .. } | crate::graph::Class::Unconfirmed { value } => Some((&f.loc, value.as_str())),
        _ => None,
    })
}

/// How far one commit got.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkState {
    /// The request never left: it failed before dispatch, or the run stopped before reaching it.
    #[default]
    NotSent,
    /// The request may be at the site. Even a failure from here on may have changed it.
    Sent,
    /// The site's answer proves the write landed.
    Confirmed,
}

/// One step that could change the site, and how far it got.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CommitMark {
    /// The step's number in the route (1-based), and what it does.
    pub step: usize,
    pub method: String,
    pub url: String,
    pub state: MarkState,
}

impl CommitMark {
    /// Whether the site may hold this step's effect.
    pub fn possible(&self) -> bool {
        self.state != MarkState::NotSent
    }
}

/// What a finished or failed call did to the site.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// The route only reads, or every commit failed before it was sent.
    #[default]
    NotSent,
    /// The route only reads: nothing it sends changes the site.
    ReadOnly,
    /// A commit may be at the site, and the site did not confirm it.
    MaybeCommitted,
    /// The site's answer confirmed the write.
    Committed,
}

/// What a caller may do with a failed call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retry {
    /// The call sent nothing that changes the site: run it again as it was.
    AsIs,
    /// The site may hold the write: ask the site what it holds before running again.
    CheckFirst,
    /// Nothing more may be sent: the write landed, or whether it landed is the caller's to settle.
    Never,
}

/// The write ledger of one call: its commit marks and what they add up to.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Ledger {
    /// The steps that may change the site, in the order they run.
    pub marks: Vec<CommitMark>,
}

impl Ledger {
    /// The ledger of a route: a read has none; every write step is a commit, the route's target among them. A write
    /// that answered with a cookie in the middle of a route is one too: it may be the site's state kept in a cookie (a
    /// cart line), and once sent it must never go a second time. The cost, accepted: a heal can't run again a sign-in
    /// that is such a write, so a call whose later step fails after it is left to the caller.
    pub fn of(graph: &Graph) -> Self {
        Self::of_route(graph, false)
    }

    /// [`Ledger::of`], for a route someone saw change the site whatever the rule reads of its requests (`judged`, an
    /// agent's word, R1.25): its target is a commit too, so a call that sent it is never retried as it was.
    pub fn of_route(graph: &Graph, judged: bool) -> Self {
        let mut marks: Vec<CommitMark> = graph
            .steps
            .iter()
            .enumerate()
            .filter(|(_, step)| writes(step))
            .map(|(n, step)| CommitMark {
                step: n + 1,
                method: step.method.clone(),
                url: step.url.clone(),
                state: MarkState::NotSent,
            })
            .collect();
        if let Some(target) = graph.steps.last().filter(|_| judged) {
            let n = graph.steps.len();
            if !marks.iter().any(|m| m.step == n) {
                marks.push(CommitMark { step: n, method: target.method.clone(), url: target.url.clone(), state: MarkState::NotSent });
            }
        }
        marks.sort_by_key(|m| m.step);
        Self { marks }
    }

    /// The request for `step` is about to go out.
    pub fn sending(&mut self, step: usize) {
        if let Some(m) = self.marks.iter_mut().find(|m| m.step == step) {
            m.state = MarkState::Sent;
        }
    }

    /// A call that is one frame over a page's socket rather than a sequence of requests: the frame is the whole
    /// route. A frame the site never received sent nothing; the frame is the mark.
    pub fn frame(url: &str, writes: bool) -> Self {
        if !writes {
            return Self::default();
        }
        Self { marks: vec![CommitMark { step: 1, method: "FRAME".into(), url: url.into(), state: MarkState::NotSent }] }
    }

    /// The site answered whatever this mark is with an answer that proves it landed (a frame's answer is its proof).
    pub fn confirmed(&mut self, step: usize) {
        if let Some(m) = self.marks.iter_mut().find(|m| m.step == step) {
            m.state = MarkState::Confirmed;
        }
    }

    /// The site answered `step` with `status`: its answer proves the write only where a write is proven by its
    /// status, and otherwise it may have landed.
    pub fn answered(&mut self, step: usize, status: u16) {
        if let Some(m) = self.marks.iter_mut().find(|m| m.step == step) {
            m.state = match status {
                // The site refused the write: nothing was written.
                400..=499 if !matches!(status, 408 | 409 | 425 | 429) => MarkState::NotSent,
                // The site took it and answered under 300.
                200..=299 => MarkState::Confirmed,
                // Anything else — a success with a status this rule cannot vouch for, a server error, a timeout —
                // may have landed.
                _ => MarkState::Sent,
            };
        }
    }

    /// The site answered `step`'s request to `asked` with `ex`. What it says of the write is read from the hop that
    /// took the write, so a mark never takes a verdict from a page the write merely led to: a POST that landed and
    /// was sent on to a 404 was still sent, and one sent on to a sign-in that answers 200 was never proven. Any
    /// redirect the answer came through leaves the mark `Sent`, whatever the last hop said: the first hop's status
    /// is a 3xx, which proves nothing either way. A 2xx whose own words say it failed proves nothing either.
    pub fn heard(&mut self, step: usize, asked: &url::Url, ex: &crate::trace::Exchange) {
        let says_it_failed = (200..300).contains(&ex.status) && crate::answer::not_an_answer(ex, true).is_some();
        if ex.url != *asked || says_it_failed {
            self.sending(step);
        } else {
            self.answered(step, ex.status);
        }
    }

    /// The ledger of a call made twice (a heal's retry): a call that may have committed in either attempt did.
    pub fn fold(mut self, other: Ledger) -> Ledger {
        let rank = |s: MarkState| match s {
            MarkState::NotSent => 0,
            MarkState::Sent => 1,
            MarkState::Confirmed => 2,
        };
        for m in other.marks {
            match self.marks.iter_mut().find(|s| s.step == m.step) {
                Some(s) if rank(m.state) > rank(s.state) => *s = m,
                Some(_) => {}
                None => self.marks.push(m),
            }
        }
        self.marks.sort_by_key(|m| m.step);
        self
    }

    /// Whether every commit stayed unsent: the run sent nothing that changes the site.
    pub fn sent_nothing(&self) -> bool {
        self.marks.iter().all(|m| m.state == MarkState::NotSent)
    }

    /// Whether any commit may be at the site.
    pub fn possible_commit(&self) -> bool {
        self.marks.iter().any(CommitMark::possible)
    }

    /// What the call did, for a route that writes (`writes`) or only reads. A mark is a write whatever the caller read
    /// of the route: `writes` is read before the call, and a heal can hand it a chain that writes.
    pub fn effect(&self, writes: bool) -> Effect {
        if !writes && self.marks.is_empty() {
            return Effect::ReadOnly;
        }
        if self.marks.iter().any(|m| m.state == MarkState::Confirmed) {
            return Effect::Committed;
        }
        if self.possible_commit() {
            Effect::MaybeCommitted
        } else {
            Effect::NotSent
        }
    }

    /// What a failed call may do next. A read may always run again. A write may run again only when it sent nothing
    /// that changes the site; if it landed, never; if it may have, the caller checks the site first.
    pub fn retry(&self, writes: bool) -> Retry {
        match self.effect(writes) {
            Effect::ReadOnly | Effect::NotSent => Retry::AsIs,
            Effect::Committed => Retry::Never,
            Effect::MaybeCommitted => Retry::CheckFirst,
        }
    }
}

/// Whether a route changes state on the site anywhere: a read route may always be healed and retried.
pub fn route_writes(graph: &Graph) -> bool {
    graph.steps.iter().any(writes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::{Body, Step};

    fn step(n: usize, method: &str, url: &str, sets_cookie: bool) -> Step {
        Step {
            page_signed: false,
            page_producers: Vec::new(),
            exchange: n,
            method: method.into(),
            status: 200,
            url: url.into(),
            fields: Vec::new(),
            body: if method == "GET" { None } else { Some(Body::Other) },
            response_shape: None,
            needs_browser: false,
            sets_cookie,
            on_load: false,
            foreign: false,
            held: Vec::new(),
            reads_page: false,
        }
    }

    fn graph(steps: Vec<Step>) -> Graph {
        Graph { steps, provisional: false, page_origin: None, ..Graph::default() }
    }

    /// A write route: a session POST that answered with a cookie (a commit too), then the target POST.
    fn write_route() -> Ledger {
        Ledger::of(&graph(vec![
            step(0, "POST", "https://shop.example/api/session", true),
            step(1, "POST", "https://shop.example/api/orders", false),
        ]))
    }

    /// The money rule: a write whose request may have reached the site is never healed and retried, and the caller is
    /// told the site may hold it.
    #[test]
    fn a_write_that_may_have_committed_is_not_retried() {
        let mut ledger = write_route();
        assert!(ledger.sent_nothing(), "nothing has been sent yet");
        ledger.sending(2);
        assert!(!ledger.sent_nothing() && ledger.possible_commit());
        assert_eq!(ledger.effect(true), Effect::MaybeCommitted);
        assert_eq!(ledger.retry(true), Retry::CheckFirst);
        // A server error after the request went out still may have written.
        ledger.answered(2, 502);
        assert_eq!(ledger.effect(true), Effect::MaybeCommitted);
        // And a success the rule cannot vouch for is not a stay of execution either.
        ledger.answered(2, 304);
        assert_eq!(ledger.effect(true), Effect::MaybeCommitted);
        assert_eq!(ledger.retry(true), Retry::CheckFirst);
        // A confirmed write is never run again.
        ledger.answered(2, 201);
        assert_eq!(ledger.effect(true), Effect::Committed);
        assert_eq!(ledger.retry(true), Retry::Never);
    }

    /// A write that never reached the site (refused, or refused before dispatch) may run again as it was.
    fn answer(url: &str, status: u16, body: &str) -> crate::trace::Exchange {
        crate::trace::Exchange {
            method: "POST".into(),
            url: url.parse().unwrap(),
            request_headers: vec![],
            request_body: None,
            status,
            response_headers: vec![],
            response_body: Some(body.into()),
            response_mime: "application/json".into(),
            resource_type: None,
            main_frame: None,
        }
    }

    /// A write redirected to another page was taken by the hop before it: what that page answers is no verdict on the
    /// write. A 404 at the end never says nothing was sent, and a 200 at the end never proves it landed.
    #[test]
    fn a_redirected_write_is_judged_by_no_page_it_led_to() {
        let asked: url::Url = "https://shop.example/api/orders".parse().unwrap();
        for (landed, status) in [("https://shop.example/orders/gone", 404), ("https://shop.example/signin", 401), ("https://shop.example/signin", 200)] {
            let mut l = write_route();
            let target = l.marks.last().unwrap().step;
            l.sending(target);
            l.heard(target, &asked, &answer(landed, status, "<html></html>"));
            assert_eq!(l.marks.last().unwrap().state, MarkState::Sent, "{landed} {status}");
            assert_eq!(l.retry(true), Retry::CheckFirst, "{landed} {status}");
        }
    }

    /// An answer straight from the hop that took the write is read as ever: a refusal sent nothing, a 2xx landed.
    #[test]
    fn an_answer_from_the_hop_that_took_the_write_is_its_verdict() {
        let asked: url::Url = "https://shop.example/api/orders".parse().unwrap();
        let state = |status, body| {
            let mut l = write_route();
            let target = l.marks.last().unwrap().step;
            l.sending(target);
            l.heard(target, &asked, &answer(asked.as_str(), status, body));
            l.marks.last().unwrap().state
        };
        assert_eq!(state(400, ""), MarkState::NotSent);
        assert_eq!(state(201, r#"{"id":"o1"}"#), MarkState::Confirmed);
        assert_eq!(state(500, ""), MarkState::Sent);
    }

    /// A site that answers every failure 200 says so in its body: the write isn't proven, and may still have landed.
    #[test]
    fn a_2xx_that_says_it_failed_proves_no_write() {
        let asked: url::Url = "https://shop.example/api/orders".parse().unwrap();
        let mut l = write_route();
        let target = l.marks.last().unwrap().step;
        l.sending(target);
        l.heard(target, &asked, &answer(asked.as_str(), 200, r#"{"success":false,"error":"card declined"}"#));
        assert_eq!(l.marks.last().unwrap().state, MarkState::Sent);
        assert_eq!(l.effect(true), Effect::MaybeCommitted);
    }

    /// `writes` is read before the call; a heal may hand it a chain that writes, and the marks of that run stand.
    #[test]
    fn a_mark_counts_though_the_route_was_read_as_a_read() {
        let mut l = write_route();
        let target = l.marks.last().unwrap().step;
        l.sending(target);
        assert_eq!(l.effect(false), Effect::MaybeCommitted);
        assert_eq!(l.retry(false), Retry::CheckFirst);
    }

    #[test]
    fn a_write_that_sent_nothing_may_retry() {
        let mut ledger = write_route();
        ledger.sending(2);
        ledger.answered(2, 422);
        assert_eq!(ledger.effect(true), Effect::NotSent);
        assert_eq!(ledger.retry(true), Retry::AsIs);
        // A run that stopped before the commit (a source missing from an earlier read) sent nothing either.
        let untouched = write_route();
        assert_eq!(untouched.retry(true), Retry::AsIs);
    }

    /// A read heals and retries as it always has, whatever its statuses.
    #[test]
    fn a_read_heals_and_retries_as_today() {
        let mut ledger = Ledger::of(&read_graph());
        ledger.sending(1);
        ledger.answered(1, 500);
        assert_eq!(ledger.effect(false), Effect::ReadOnly);
        assert_eq!(ledger.retry(false), Retry::AsIs);
    }

    /// A route an agent saw change the site is held to the write rules though the rule reads its request as a read: a
    /// call that sent its target is never advised to run again as it was, so a retry or a heal can't send it twice.
    #[test]
    fn a_target_someone_saw_write_is_a_commit_whatever_its_request_reads() {
        let g = graph(vec![step(0, "GET", "https://shop.example/api/unsubscribe?id={id}", false)]);
        let mut read = Ledger::of(&g);
        read.sending(1);
        assert_eq!(read.retry(true), Retry::AsIs, "the rule alone sees no commit");
        let mut judged = Ledger::of_route(&g, true);
        assert_eq!(judged.retry(true), Retry::AsIs, "nothing sent yet");
        judged.sending(1);
        assert!(judged.possible_commit());
        assert_eq!(judged.retry(true), Retry::CheckFirst);
        assert_eq!(Ledger::of_route(&g, false).marks.len(), 0, "unjudged, nothing changes");
    }

    /// The marks are read from the route's own shape: every write is a commit, one answering with a cookie too, and a
    /// read route has none.
    #[test]
    fn the_marks_are_read_from_the_route() {
        let ledger = Ledger::of(&graph(vec![
            step(0, "POST", "https://shop.example/api/session", true),
            step(1, "POST", "https://shop.example/api/orders", false),
            step(2, "GET", "https://shop.example/api/orders/1", false),
        ]));
        assert_eq!(ledger.marks.iter().map(|m| m.step).collect::<Vec<_>>(), [1, 2]);
        // A write route whose target did set a cookie still marks the target: the target is the route's commit.
        let ledger = Ledger::of(&graph(vec![
            step(0, "GET", "https://shop.example/app", false),
            step(1, "POST", "https://shop.example/login", true),
        ]));
        assert_eq!(ledger.marks.iter().map(|m| m.step).collect::<Vec<_>>(), [2]);
        // A read route marks nothing and is never mistaken for a write.
        let read = Ledger::of(&graph(vec![step(0, "GET", "https://shop.example/api/orders/1", false)]));
        assert!(read.marks.is_empty());
        assert!(!read.possible_commit());
        assert!(!route_writes(&read_graph()));
    }

    /// A frame over a socket is the whole route: it is the mark, and its answer is its proof.
    #[test]
    fn a_frame_is_its_own_mark() {
        let mut frame = Ledger::frame("wss://chat.example/socket", true);
        assert_eq!(frame.marks.len(), 1, "the frame is the route");
        assert!(frame.sent_nothing());
        frame.sending(1);
        assert_eq!(frame.retry(true), Retry::CheckFirst, "a frame that went out may have been acted on");
        frame.confirmed(1);
        assert_eq!(frame.effect(true), Effect::Committed);
        assert_eq!(frame.retry(true), Retry::Never);
        // A frame the site never received (the socket refused) sent nothing.
        assert_eq!(Ledger::frame("wss://chat.example/socket", true).retry(true), Retry::AsIs);
        // A read route's ledger holds no marks, and a read heals as it always has.
        assert!(Ledger::frame("wss://chat.example/socket", false).marks.is_empty());
    }

    fn read_graph() -> Graph {
        graph(vec![step(0, "GET", "https://shop.example/api/orders/1", false)])
    }

    /// Asking is a read: a search POST and a GraphQL query are not commits, so their routes heal and retry.
    #[test]
    fn a_call_that_only_asks_is_a_read() {
        for url in ["https://shop.example/api/search", "https://shop.example/1/indexes/products/query"] {
            let step = step(0, "POST", url, false);
            assert!(!writes(&step), "{url}");
        }
        let mut gql = step(0, "POST", "https://shop.example/graphql", false);
        gql.body = Some(crate::graph::Body::Json {
            template: serde_json::json!({ "query": "query Items($q: String) { items(q: $q) { id } }", "variables": { "q": null } }),
            types: Default::default(),
        });
        assert!(!writes(&gql), "a GraphQL query the route keeps the text of");
    }

    /// A GraphQL call is a read only when its own request proves it asks: an operation whose text the template
    /// blanked, a persisted query that sends only a hash, or no body at all proves nothing, and is held to the write
    /// rules, so a failed mutation is never sent again.
    #[test]
    fn a_graphql_call_is_a_read_only_when_its_request_proves_it() {
        let with = |template: serde_json::Value| {
            let mut s = step(0, "POST", "https://shop.example/graphql", false);
            s.body = Some(crate::graph::Body::Json { template, types: Default::default() });
            s
        };
        assert!(writes(&with(serde_json::json!({ "query": null, "variables": { "item": null } }))), "the operation was blanked");
        assert!(writes(&with(serde_json::json!({ "operationName": "AddToCart", "extensions": { "persistedQuery": { "sha256Hash": "abc" } } }))));
        assert!(writes(&with(serde_json::json!({ "query": "mutation Buy { buy { id } }" }))));
        // A query that defines its fragments first is still a query, and GraphQL is GraphQL at any address.
        let fragments_first = serde_json::json!({ "operationName": "SEARCH", "variables": { "query": null }, "query": "fragment VIDEO on Video {\n  id\n}\n\nquery SEARCH($query: String!) {\n  search { videos(query: $query) { ...VIDEO } }\n}" });
        assert!(!writes(&with(fragments_first.clone())));
        let elsewhere = |body: serde_json::Value| {
            let mut s = step(0, "POST", "https://search.video.example/v1", false);
            s.body = Some(crate::graph::Body::Json { template: body, types: Default::default() });
            s
        };
        assert!(!writes(&elsewhere(fragments_first)));
        assert!(writes(&elsewhere(serde_json::json!({ "query": "fragment A on B { id }\nmutation Buy { buy { ...A } }" }))));
        assert!(writes(&elsewhere(serde_json::json!({ "query": "lamp" }))), "a search box's word is no document");
        // The text kept in a field beside a template that blanks it is the route's own text all the same.
        let mut beside = elsewhere(serde_json::json!({ "operationName": null, "variables": { "query": null }, "query": null }));
        beside.fields.push(crate::graph::Field { loc: crate::slots::Loc::Json("/query".into()), class: crate::graph::Class::Unconfirmed { value: "fragment A on B { id }\nquery SEARCH { search { ...A } }".into() } });
        assert!(!writes(&beside));
        let mut buys = elsewhere(serde_json::json!({ "query": null }));
        buys.fields.push(crate::graph::Field { loc: crate::slots::Loc::Json("/query".into()), class: crate::graph::Class::Unconfirmed { value: "mutation Buy { buy { id } }".into() } });
        assert!(writes(&buys));
        assert!(writes(&step(0, "POST", "https://shop.example/graphql", false)), "no body proves nothing");
        assert!(!writes(&with(serde_json::json!({ "query": "{ items { id } }" }))), "the query shorthand");
        assert!(writes(&step(0, "POST", "https://shop.example/api/orders", false)));
        assert!(writes(&step(0, "DELETE", "https://shop.example/api/orders/1", false)));
        assert!(!writes(&step(0, "GET", "https://shop.example/api/orders/1", false)));
    }

    /// A POST the page sent by itself as it loaded, answering 2xx with data and setting no cookie, is a read: every
    /// visit sends it again. One that set a cookie, was refused, or that nobody marked as sent on load still writes.
    #[test]
    fn a_post_the_page_sends_as_it_loads_is_a_read() {
        let on_load = |sets_cookie: bool, status: u16| {
            let mut s = step(0, "POST", "https://adstransparency.example.com/anji/_/rpc/SearchService/SearchCreatives", sets_cookie);
            s.on_load = true;
            s.status = status;
            s
        };
        assert!(!writes(&on_load(false, 200)));
        assert!(writes(&on_load(true, 200)), "a cookie set: the site's session bookkeeping");
        assert!(writes(&on_load(false, 403)));
        assert!(writes(&step(0, "POST", "https://adstransparency.example.com/anji/_/rpc/SearchService/SearchCreatives", false)));
        // Only POST: a page's DELETE is a write however it was sent.
        let mut delete = on_load(false, 200);
        delete.method = "DELETE".into();
        assert!(writes(&delete));
    }
}
