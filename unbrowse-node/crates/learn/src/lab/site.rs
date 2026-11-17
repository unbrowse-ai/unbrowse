//! The site, as the learner asks it: live, or answered from a recording.
//!
//! Every ask a learn makes of a site goes through [`Site`]. Live, that is the transport. Offline it is a walk
//! answering as the site answered it ([`Recorded`]): a request is answered with the reply to the walked call it
//! is, and a request the walk never made is named as unheard, never guessed at. So a body can be run end to end
//! with no site asked, and what a learner would have had to ask is known.
//!
//! The live site ([`Live`]) is held to two rules of its own. A step that may change what the site holds is never
//! sent: a write is learned from the walk it was made in, and never tried. And a learn asks a site no more than it
//! was given asks for. What a site itself says of how many asks it has left (`budget.rs`) and a door's rest are
//! not read here yet.

use unbrowse_route as route;
use unbrowse_route::Place;

use crate::body::place_of;
use crate::lab::sighting::Walk;
use crate::replay::{Fetch, Request};
use crate::slots::{is_browser_header, slots};
use crate::trace::Exchange;

/// What a site said to one ask.
#[derive(Clone, Debug)]
pub enum Said {
    /// Its reply, and where in the recording it is when it came from one.
    Reply { at: Option<usize>, reply: Exchange },
    /// The recording holds no such ask: the walked call nearest it, and the places where the ask differs.
    Unheard { nearest: Option<usize>, differs: Vec<String> },
    /// The ask was not made, or the site could not be reached: why.
    Refused(String),
}

/// A site that can be asked.
pub trait Site {
    fn ask(&mut self, step: &route::Step, built: &route::Built) -> Said;
}

/// A walk, answering as the site answered it.
pub struct Recorded<'a> {
    pub walk: &'a Walk<'a>,
}

/// The places of a step whose value is not the site's to match against a recording: a cookie (the session moves
/// through a walk), a header the browser writes by itself, a reading of the clock, a hole nothing explains, which
/// is sent as one walk sent it, and a value made over any of those in the same request (a digest over the call's
/// time is as new as the time).
fn loose(step: &route::Step, at: &Place) -> bool {
    loose_in(step, at, true)
}

/// [`loose`], following a value made over the request into the places it is made over when `follow`: once, since
/// what a value is made over is the request less the values made over it.
fn loose_in(step: &route::Step, at: &Place, follow: bool) -> bool {
    match at {
        Place::Cookie(_) => true,
        Place::Header(name) if is_browser_header(name) => true,
        _ => step.holes.iter().any(|h| {
            h.at == *at
                && (h.open
                    || h.ways.iter().any(|w| {
                        w.expr.all().into_iter().any(|e| match e {
                            route::Expr::Stamp { .. } => true,
                            route::Expr::Sent { part } if follow => made_over(step, at, part).iter().any(|p| loose_in(step, p, false)),
                            _ => false,
                        })
                    }))
        }),
    }
}

/// The places of `step`'s request that a value at `at` reads when it reads `part` of the request.
fn made_over(step: &route::Step, at: &Place, part: &route::Sent) -> Vec<Place> {
    let others = |of: fn(&Place) -> bool| step.holes.iter().map(|h| h.at.clone()).filter(|p| p != at && of(p)).collect::<Vec<_>>();
    match part {
        route::Sent::Query(key) => vec![Place::Query(key.clone())],
        route::Sent::Cookie(name) => vec![Place::Cookie(name.clone())],
        route::Sent::Header(name) => vec![Place::Header(name.clone())],
        route::Sent::Path => others(|p| matches!(p, Place::Path(_) | Place::Query(_))),
        route::Sent::Body => others(|p| matches!(p, Place::Json(_) | Place::Form(_) | Place::Part(..))),
        route::Sent::Method => Vec::new(),
    }
}

/// Whether a walked call is at the step's address: the same method and origin, and the same path but for the
/// pieces the step makes for each call.
fn at_the_address(step: &route::Step, e: &Exchange) -> bool {
    let address = step.url.split('?').next().unwrap_or_default().replace('{', "%7B").replace('}', "%7D");
    let Ok(template) = url::Url::parse(&address) else { return false };
    let pieces = |u: &url::Url| u.path().split('/').map(|p| percent_encoding::percent_decode_str(p).decode_utf8_lossy().to_lowercase()).collect::<Vec<_>>();
    let (ours, theirs) = (pieces(&template), pieces(&e.url));
    e.method.eq_ignore_ascii_case(&step.method)
        && template.origin() == e.url.origin()
        && ours.len() == theirs.len()
        && ours.iter().zip(&theirs).all(|(ours, theirs)| ours.starts_with("{path[") || ours == theirs)
}

impl Site for Recorded<'_> {
    fn ask(&mut self, step: &route::Step, built: &route::Built) -> Said {
        let ask = Exchange {
            method: built.method.clone(),
            url: built.url.clone(),
            request_headers: built.headers.clone(),
            request_body: built.body.clone(),
            status: 0,
            response_headers: Vec::new(),
            response_body: None,
            response_mime: String::new(),
            resource_type: None,
            main_frame: None,
        };
        let sent = slots(&ask);
        let mut nearest: Option<(usize, Vec<String>)> = None;
        for (i, e) in self.walk.trace.exchanges.iter().enumerate() {
            // A walked call at the step's address holds this ask when every value it sent is the ask's: no rule of
            // which operation a call is comes first, since the values say it.
            if !at_the_address(step, e) {
                continue;
            }
            let walked = slots(e);
            // Every place the walked call sent a value at, the ask sends the same, and it sends nothing more.
            let mut differs: Vec<String> = Vec::new();
            for s in walked.iter().filter(|s| !loose(step, &place_of(&s.loc))) {
                match sent.iter().find(|t| t.loc == s.loc) {
                    Some(t) if t.value == s.value => {}
                    Some(_) => differs.push(s.loc.to_string()),
                    None => differs.push(format!("{} (not sent)", s.loc)),
                }
            }
            for t in sent.iter().filter(|t| !loose(step, &place_of(&t.loc)) && !walked.iter().any(|s| s.loc == t.loc)) {
                differs.push(format!("{} (the walk sent none)", t.loc));
            }
            if differs.is_empty() {
                return Said::Reply { at: Some(i), reply: e.clone() };
            }
            if nearest.as_ref().is_none_or(|(_, least)| differs.len() < least.len()) {
                nearest = Some((i, differs));
            }
        }
        match nearest {
            Some((i, differs)) => Said::Unheard { nearest: Some(i), differs },
            None => Said::Unheard { nearest: None, differs: Vec::new() },
        }
    }
}

/// The site itself, asked over a transport the caller built (the route's own, with the walk's browser sample).
pub struct Live<'f, F: Fetch> {
    pub fetch: &'f mut F,
    /// How many asks this learn may still make of the site.
    pub left: usize,
}

impl<F: Fetch> Site for Live<'_, F> {
    fn ask(&mut self, step: &route::Step, built: &route::Built) -> Said {
        if step.writes {
            return Said::Refused("the step may change what the site holds, and a learn sends no such step".into());
        }
        if self.left == 0 {
            return Said::Refused("the learn has no asks of this site left".into());
        }
        let request = Request { method: built.method.clone(), url: built.url.clone(), exchange: 0, headers: built.headers.clone(), body: built.body.as_deref().map(unbrowse_route::wire::bytes_of) };
        if let Err(refusal) = self.fetch.allows(&request) {
            return Said::Refused(refusal.to_string());
        }
        // From here the ask may reach the site, whatever comes back.
        self.left -= 1;
        match self.fetch.fetch(&request) {
            Ok(reply) => Said::Reply { at: None, reply },
            Err(failure) => Said::Refused(failure.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::ReplayError;

    /// A transport that counts what it is asked.
    #[derive(Default)]
    struct Counting {
        asked: Vec<String>,
    }
    impl Fetch for Counting {
        fn fetch(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.asked.push(format!("{} {}", req.method, req.url));
            Ok(Exchange {
                method: req.method.clone(),
                url: req.url.clone(),
                request_headers: req.headers.clone(),
                request_body: None,
                status: 200,
                response_headers: vec![],
                response_body: Some("{}".into()),
                response_mime: "application/json".into(),
                resource_type: None,
                main_frame: None,
            })
        }
        fn fetch_unredirected(&mut self, req: &Request) -> Result<Exchange, ReplayError> {
            self.fetch(req)
        }
    }

    fn step(method: &str, writes: bool) -> (route::Step, route::Built) {
        let step = route::Step { id: "s".into(), method: method.into(), url: "https://shop.example/api/x".into(), holes: vec![], body: None, expect: 200, script: None, page: false, writes, on_load: false, sets_cookie: false, lifetime: None, shape: None };
        let built = route::Built { method: method.into(), url: "https://shop.example/api/x".parse().unwrap(), headers: vec![], body: None, made: vec![] };
        (step, built)
    }

    /// A write is learned from the walk it was made in. It is never sent to see what happens.
    #[test]
    fn a_step_that_may_write_is_never_sent_to_a_site() {
        let mut transport = Counting::default();
        let (order, built) = step("POST", true);
        assert!(matches!(Live { fetch: &mut transport, left: 5 }.ask(&order, &built), Said::Refused(why) if why.contains("change what the site holds")));
        assert!(transport.asked.is_empty(), "nothing reached the site");
    }

    #[test]
    fn a_learn_asks_a_site_no_more_than_it_was_given() {
        let mut transport = Counting::default();
        let (read, built) = step("GET", false);
        let mut site = Live { fetch: &mut transport, left: 2 };
        assert!(matches!(site.ask(&read, &built), Said::Reply { at: None, .. }));
        assert!(matches!(site.ask(&read, &built), Said::Reply { .. }));
        assert!(matches!(site.ask(&read, &built), Said::Refused(why) if why.contains("no asks")));
        assert_eq!(transport.asked.len(), 2);
    }
}
