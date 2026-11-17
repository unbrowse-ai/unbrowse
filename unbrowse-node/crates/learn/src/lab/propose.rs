//! The proposer (`learn.proposer`, `docs/REBUILD.md` §6.5), where the search leaves a choice open: shown only what is
//! still open, in the same form the learner holds it; its answer is kept only where it is one of what the search
//! already held to every sighting, and the site's own tests judge the route after. A node with no proposer keeps what
//! the search found.
//!
//! Two choices are asked here: which of the readings that all rebuild every sighting a hole takes (which field of the
//! site's table the caller's word is held to), and what a slot the ways only say is free text is (a place).

use std::rc::Rc;

use serde_json::{json, Value};
use unbrowse_route::meaning::Kind;
use unbrowse_route::Expr;

/// A proposer: given an ask as JSON, its answer as JSON, or none.
pub type Proposer = Rc<dyn Fn(&Value) -> Option<Value>>;

/// The proposer the owner configured (`UNBROWSE_PROPOSE_PROGRAM`: a command that reads the ask as JSON on its stdin
/// and writes JSON), as the trial asks it for a second word. None where none is configured.
pub fn configured() -> Option<Proposer> {
    let command = std::env::var("UNBROWSE_PROPOSE_PROGRAM").ok().filter(|c| !c.trim().is_empty())?;
    Some(Rc::new(move |ask: &Value| {
        let said = crate::generated::run_agent(&command, &ask.to_string())?;
        serde_json::from_str(said.get(said.find('{')?..=said.rfind('}')?)?).ok()
    }))
}

/// What a proposer is told of a hole whose readings all rebuild every sighting.
const WHICH_READING: &str = "A request sends a value the learner found more than one way to make; each way, given every walk's own values, makes exactly what that walk sent. They part on another value (separates). Say which way is what the page does: the one a person's word would be turned into by the site. Answer with JSON only: {\"reading\": <its index>}.";

/// What a proposer is told of a slot the ways say only is free text.
const SLOT_KIND: &str = "A route takes a value a person writes (its name and the values the walks were asked). Say what kind of value it is: \"place\" for a place's name (a city, a country, an airport, a neighbourhood), or \"text\" for anything else. Answer with JSON only: {\"kind\": \"place\" or \"text\"}.";

/// Which of `readings` a hole takes, as the proposer says: an index among them, only where it names one. `at` is the
/// hole's place, `sent` what each walk sent there, `separates` the slot and the value the readings part on.
pub fn which_reading(proposer: &Proposer, at: &str, sent: &[Option<String>], readings: &[Expr], separates: &(String, String)) -> Option<usize> {
    let shown: Vec<Value> = readings
        .iter()
        .enumerate()
        .map(|(i, e)| json!({ "index": i, "way": shown(e), "sends_for_the_separating_value": crate::lab::forms::sends(e, &separates.0, &separates.1) }))
        .collect();
    let ask = json!({ "ask": "which_reading", "instruction": WHICH_READING, "place": at, "sent": sent, "readings": shown, "separates": { "slot": separates.0, "value": separates.1 } });
    let said = proposer(&ask)?;
    let i = usize::try_from(said.get("reading")?.as_u64()?).ok()?;
    (i < readings.len()).then_some(i)
}

/// A way as a proposer is shown it: the expression, with a table it looks up cut to its first records and their
/// fields, so the ask names which field each way holds the word to without carrying the site's whole table.
fn shown(e: &Expr) -> Value {
    match e {
        Expr::Lookup { rows, fits, take } => json!({ "looks_up": { "first_records": rows.iter().take(3).collect::<Vec<_>>(), "records": rows.len(), "fits": fits, "take": take } }),
        other => serde_json::to_value(other).unwrap_or_default(),
    }
}

/// What a slot whose ways say only that it is free text is, as the proposer says, held to every walk's value of it:
/// a place is a name, with a letter in it, that no form of a date, a time or a number reads. None where no proposer
/// answers, it says text, or a value of the walks is no place.
pub fn kind_of(proposer: &Proposer, slot: &str, values: &[String]) -> Option<Kind> {
    let ask = json!({ "ask": "slot_kind", "instruction": SLOT_KIND, "slot": slot, "asked": values });
    let said = proposer(&ask)?;
    let kind = said.get("kind")?.as_str()?;
    let a_place = |v: &String| v.chars().any(char::is_alphabetic) && crate::lab::forms::time_reads(v).is_empty() && unbrowse_route::format::Figure::read(v, ".", "").is_none();
    (kind.eq_ignore_ascii_case("place") && !values.is_empty() && values.iter().all(a_place)).then_some(Kind::Place)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn says(answer: Value) -> Proposer {
        Rc::new(move |_| Some(answer.clone()))
    }

    #[test]
    fn a_proposers_kind_is_kept_only_where_every_walks_value_is_one() {
        assert_eq!(kind_of(&says(json!({ "kind": "place" })), "q", &["Lisbon".into(), "Oslo".into()]), Some(Kind::Place));
        assert_eq!(kind_of(&says(json!({ "kind": "text" })), "q", &["Lisbon".into()]), None);
        assert_eq!(kind_of(&says(json!({ "kind": "place" })), "q", &["2026-03-04".into()]), None, "a date is no place, whatever the proposer says");
        assert_eq!(kind_of(&says(json!({ "nonsense": true })), "q", &["Lisbon".into()]), None);
    }

    #[test]
    fn a_proposers_reading_is_kept_only_where_it_names_one_of_them() {
        let readings = vec![Expr::text("a"), Expr::text("b")];
        let separates = ("q".to_string(), "Porto".to_string());
        assert_eq!(which_reading(&says(json!({ "reading": 1 })), "query city", &[Some("LIS".into())], &readings, &separates), Some(1));
        assert_eq!(which_reading(&says(json!({ "reading": 7 })), "query city", &[], &readings, &separates), None);
        assert_eq!(which_reading(&says(json!({ "pick": "b" })), "query city", &[], &readings, &separates), None);
    }
}
