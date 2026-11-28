//! What each step of a route last did when it was called.
//!
//! A route's stats say how the route did; a refusal lands on one step. This is the record it lands on: for every step,
//! when it last answered, when it was last refused, how, and how many times running. From it the route knows which
//! steps are stale (the refused one and whatever reads from it), which hold, and which session values the refused
//! step was sending, so a mend can earn those again instead of walking the whole page.
//!
//! Nothing here asks the site anything: it is written from calls an agent already made.

use crate::graph::{Class, Graph, Step};
use crate::replay::ReplayError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How a step was refused, as the call's own outcome said it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Refused {
    /// The site's door answered in place of the step.
    Door,
    /// A 401 or 403 with no door's mark: the session is not one the site takes.
    Session,
    /// The site is out of asks for this caller (429).
    Rate,
    /// The step answered otherwise than when it was learned: another status, another shape, a value gone.
    Drift,
    /// The target answered with the site checking the caller.
    Challenge,
    /// The target answered, with no answer and no check.
    NotAnAnswer,
    /// The step wants the page's own code and the call had none to run it.
    NeedsBrowser,
}

/// One step's last word.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepHealth {
    /// When the step last answered as learned (seconds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answered_at: Option<u64>,
    /// When it was last refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused_at: Option<u64>,
    /// How it was refused then. None once it has answered since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub how: Option<Refused>,
    /// The status it answered with when refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// Refusals in a row, back to zero when it answers.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub refusals: u32,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

impl StepHealth {
    /// Whether the step's last word was a refusal.
    pub fn stale(&self) -> bool {
        self.how.is_some()
    }
}

/// A route's steps, each with its last word, by the step's own name (`key`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub steps: BTreeMap<String, StepHealth>,
}

/// A step's name in the record: its method and its address up to the query. A heal that rebuilds the chain keeps the
/// record of every step it kept, wherever the step now stands in the order.
pub fn key(step: &Step) -> String {
    let address = step.url.split(['?', '#']).next().unwrap_or_default();
    format!("{} {address}", step.method)
}

/// Which step a failed call was refused at (counted from one, as the error counts), how, and with what status. None
/// for a failure that says nothing of the site: a value the caller left out, a request the call's rule refused, a
/// wire that failed.
pub fn refused_at(e: &ReplayError, steps: usize) -> Option<(usize, Refused, Option<u16>)> {
    use ReplayError as E;
    Some(match e {
        E::Door { step, status, .. } => (*step, Refused::Door, Some(*status)),
        E::Failed { step, status: status @ (401 | 403), .. } => (*step, Refused::Session, Some(*status)),
        E::Failed { step, status: 429, .. } => (*step, Refused::Rate, Some(429)),
        E::Failed { step, status, .. } => (*step, Refused::Drift, Some(*status)),
        E::SourceMissing { step, .. } => (*step, Refused::Drift, None),
        E::NeedsBrowser { step, .. } => (*step, Refused::NeedsBrowser, None),
        E::ShapeMismatch { .. } => (steps, Refused::Drift, None),
        E::NotAnAnswer { status, challenge: true, .. } => (steps, Refused::Challenge, Some(*status)),
        E::NotAnAnswer { status, challenge: false, .. } => (steps, Refused::NotAnAnswer, Some(*status)),
        _ => return None,
    })
}

/// What one call said of the route's steps, kept apart from the error it came from so it can be held past the call.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Said {
    /// Every step answered.
    Answered,
    /// The step at this place (counted from one) was refused, this way, with this status.
    Refused(usize, Refused, Option<u16>),
    /// The failure says nothing of the site.
    Nothing,
}

/// What a call's outcome says of a route of `steps` steps.
pub fn said<T>(outcome: &Result<T, ReplayError>, steps: usize) -> Said {
    match outcome {
        Ok(_) => Said::Answered,
        Err(e) => refused_at(e, steps).map_or(Said::Nothing, |(n, how, status)| Said::Refused(n, how, status)),
    }
}

impl Health {
    /// Writes one call's outcome onto the steps it reached. A call that passed says every step answered. A call
    /// refused at step `n` says the steps before it answered and `n` was refused; the steps after it were never asked
    /// and keep what they had. A failure that says nothing of the site writes nothing.
    pub fn note(&mut self, graph: &Graph, said: Said, at: u64) {
        let reached = match said {
            Said::Answered => graph.steps.len(),
            Said::Refused(n, how, status) => {
                if let Some(step) = n.checked_sub(1).and_then(|i| graph.steps.get(i)) {
                    let h = self.steps.entry(key(step)).or_default();
                    h.refused_at = Some(at);
                    h.how = Some(how);
                    h.status = status;
                    h.refusals += 1;
                }
                n.saturating_sub(1)
            }
            Said::Nothing => return,
        };
        for step in graph.steps.iter().take(reached) {
            let h = self.steps.entry(key(step)).or_default();
            h.answered_at = Some(at);
            h.how = None;
            h.status = None;
            h.refusals = 0;
        }
    }

    /// The record of one step.
    pub fn of(&self, step: &Step) -> Option<&StepHealth> {
        self.steps.get(&key(step))
    }

    /// The steps that are stale, by their place in the chain (from zero): each step whose last word was a refusal, and
    /// every later step that reads a value from a stale one, however many steps on. Every other step's record stands.
    pub fn stale(&self, graph: &Graph) -> Vec<usize> {
        let mut stale: Vec<usize> = graph.steps.iter().enumerate().filter(|(_, s)| self.of(s).is_some_and(StepHealth::stale)).map(|(n, _)| n).collect();
        for (n, step) in graph.steps.iter().enumerate() {
            if stale.contains(&n) {
                continue;
            }
            let reads_stale = step.fields.iter().any(|f| matches!(&f.class, Class::Derived { origin } if stale.iter().any(|&m| m < n && graph.steps[m].exchange == origin.exchange)));
            if reads_stale {
                stale.push(n);
            }
        }
        stale.sort_unstable();
        stale
    }

    /// Where a mend starts: the first stale step. None when every step's last word was an answer.
    pub fn mend_from(&self, graph: &Graph) -> Option<usize> {
        self.stale(graph).into_iter().next()
    }
}

/// The session values a step sends that no step of the chain makes: the ones the node's own session supplies
/// (`Class::Minted`). When that step is refused, these are what the refusal is about, and what a mend earns again.
pub fn session_values_of(step: &Step) -> Vec<String> {
    let mut names: Vec<String> = step.fields.iter().filter_map(|f| if let Class::Minted { name } = &f.class { Some(name.clone()) } else { None }).collect();
    names.sort();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::Field;
    use crate::slots::Loc;
    use crate::provenance::{At, Origin};

    fn step(exchange: usize, path: &str) -> Step {
        Step { lifetime: None,
            page_signed: false,
            page_producers: Vec::new(),
            exchange,
            method: "GET".into(),
            status: 200,
            url: format!("https://shop.example.com{path}"),
            fields: vec![],
            body: None,
            response_shape: None,
            needs_browser: false,
            reads_page: false,
            sets_cookie: false,
            on_load: false,
            foreign: false,
            held: vec![],
            fallbacks: Vec::new(),
        }
    }

    fn reads(mut s: Step, from: usize) -> Step {
        let origin = Origin { exchange: from, url: "https://shop.example.com/".into(), at: At::Json { pointer: "/id".into() }, wrap: None };
        s.fields.push(Field { loc: Loc::Query("id".into()), class: Class::Derived { origin } });
        s
    }

    fn sends_session(mut s: Step, name: &str) -> Step {
        s.fields.push(Field { loc: Loc::Header("cookie".into()), class: Class::Minted { name: name.into() } });
        s
    }

    /// Four steps: the settings stand alone; the cart is read by the order, the order by the receipt.
    fn chain() -> Graph {
        let steps = vec![step(0, "/api/settings"), sends_session(step(1, "/api/cart"), "pass"), reads(step(2, "/api/order"), 1), reads(step(3, "/api/receipt"), 2)];
        Graph { steps, provisional: false, page_origin: None, ..Graph::default() }
    }

    fn door(step: usize) -> ReplayError {
        let door = crate::graph::Door { kind: crate::graph::DoorKind::Unknown, statuses: vec![403], credential: Some("pass".into()), ttl: None, earn: crate::graph::Earn::Recompute, at: None };
        ReplayError::Door { step, url: "https://shop.example.com/api/cart".into(), status: 403, door, wall: None }
    }

    /// A refusal is written on the step that got it, with how and when: the steps before it answered, the steps after
    /// it were never asked and keep what they had.
    #[test]
    fn a_refusal_lands_on_the_step_that_got_it() {
        let g = chain();
        let mut h = Health::default();
        h.note(&g, said::<()>(&Ok(()), g.steps.len()), 100);
        assert!(g.steps.iter().all(|s| h.of(s).unwrap().answered_at == Some(100)), "a call that passed says every step answered");
        h.note(&g, said::<()>(&Err(door(2)), g.steps.len()), 200);
        let cart = h.of(&g.steps[1]).unwrap();
        assert_eq!((cart.how, cart.status, cart.refused_at, cart.refusals, cart.answered_at), (Some(Refused::Door), Some(403), Some(200), 1, Some(100)));
        assert_eq!(h.of(&g.steps[0]).unwrap().answered_at, Some(200), "the step before it answered in that call");
        assert_eq!(h.of(&g.steps[2]).unwrap().answered_at, Some(100), "the step after it was never asked");
        h.note(&g, said::<()>(&Err(door(2)), g.steps.len()), 300);
        assert_eq!(h.of(&g.steps[1]).unwrap().refusals, 2, "refusals in a row are counted");
        h.note(&g, said::<()>(&Ok(()), g.steps.len()), 400);
        let cart = h.of(&g.steps[1]).unwrap();
        assert_eq!((cart.how, cart.refusals, cart.answered_at, cart.refused_at), (None, 0, Some(400), Some(300)), "an answer clears the refusal and keeps when it was");
    }

    /// A refusal reopens the step that got it and the steps that read from it, however far on, and no other: a step
    /// that reads nothing from them keeps its record, and the mend starts at the refused step, not at the route's top.
    #[test]
    fn a_refusal_reopens_only_what_stands_on_it() {
        let g = chain();
        let mut h = Health::default();
        h.note(&g, said::<()>(&Ok(()), g.steps.len()), 100);
        assert_eq!(h.stale(&g), Vec::<usize>::new());
        assert_eq!(h.mend_from(&g), None);
        h.note(&g, said::<()>(&Err(door(2)), g.steps.len()), 200);
        assert_eq!(h.stale(&g), vec![1, 2, 3], "the cart, the order that reads it and the receipt that reads the order");
        assert_eq!(h.mend_from(&g), Some(1), "the mend starts at the refused step");
        assert!(!h.of(&g.steps[0]).unwrap().stale(), "the settings read nothing from them: their record stands");
        assert_eq!(session_values_of(&g.steps[1]), vec!["pass".to_string()], "what the refused step was sending of the session is what the mend earns again");
        // A refusal at the last step reopens that step alone.
        let mut h = Health::default();
        h.note(&g, said::<()>(&Err(ReplayError::NotAnAnswer { status: 200, why: "a check".into(), challenge: true }), g.steps.len()), 300);
        assert_eq!(h.stale(&g), vec![3]);
        assert_eq!(h.of(&g.steps[3]).unwrap().how, Some(Refused::Challenge));
    }

    /// A failure that says nothing of the site (a value the caller left out, a wire that failed) writes nothing.
    #[test]
    fn a_failure_that_is_not_the_sites_writes_nothing() {
        let g = chain();
        let mut h = Health::default();
        h.note(&g, said::<()>(&Err(ReplayError::MissingInput("q".into())), g.steps.len()), 100);
        h.note(&g, said::<()>(&Err(ReplayError::Transport("reset".into())), g.steps.len()), 100);
        assert!(h.steps.is_empty());
    }

    /// A step is named by its method and address, not its place: a chain rebuilt with a step added before it keeps
    /// that step's record.
    #[test]
    fn a_steps_record_follows_the_step_not_its_place() {
        let g = chain();
        let mut h = Health::default();
        h.note(&g, said::<()>(&Err(door(2)), g.steps.len()), 200);
        let mut rebuilt = chain();
        rebuilt.steps.insert(0, step(9, "/api/hello"));
        assert_eq!(h.of(&rebuilt.steps[2]).unwrap().how, Some(Refused::Door));
        assert_eq!(h.stale(&rebuilt), vec![2, 3, 4]);
    }
}
