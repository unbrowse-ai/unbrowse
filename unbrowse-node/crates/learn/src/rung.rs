//! Which maker made a step of a call (`learn.rung`), the cheapest first, and what a whole call reached.
//!
//! One number per step, so the node can say what a call cost its owner's machine: the first four rungs need no
//! browser, and coverage without a browser (`decide.coverage-kpi`) counts the calls that stayed on them.

use serde::{Deserialize, Serialize};

/// The maker of a step's values. The order is the cost: a call makes each value at the lowest rung that holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(into = "u8", try_from = "u8")]
pub enum Rung {
    /// The walk's own values: what the caller gave, constants, values taken from earlier answers, the jar.
    #[default]
    Walk = 0,
    /// An expression of standard operations the node evaluates itself.
    Expression = 1,
    /// One function of the site's script, or its wasm module, called in the sealed isolate.
    Function = 2,
    /// The page's whole script, booted in the sealed isolate.
    Bundle = 3,
    /// A page kept open in the node's browser, whose own call is read back.
    Page = 4,
    /// The browser making the step itself.
    Browser = 5,
}

impl Rung {
    pub const ALL: [Rung; 6] = [Rung::Walk, Rung::Expression, Rung::Function, Rung::Bundle, Rung::Page, Rung::Browser];

    pub fn number(self) -> u8 {
        self as u8
    }

    /// Whether a browser process has to run for a value made at this rung.
    pub fn needs_browser(self) -> bool {
        self >= Rung::Page
    }
}

impl From<Rung> for u8 {
    fn from(r: Rung) -> u8 {
        r.number()
    }
}

impl TryFrom<u8> for Rung {
    type Error = String;

    fn try_from(n: u8) -> Result<Rung, String> {
        Rung::ALL.get(n as usize).copied().ok_or_else(|| format!("{n} is not a rung: they run 0 to 5"))
    }
}

/// What a call cost: the rung of each step of the run that answered, and the highest rung anything done for the call
/// reached, whether or not it answered. A walk of the route's page to mend it, or a sign-in, is the browser's work
/// for the call, so it reaches the last rung though every step that then answered was plain.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Made {
    /// The rung of each step of the run that answered, in the order they were made. Empty when none answered.
    pub steps: Vec<Rung>,
    /// The highest rung the call reached.
    pub reached: Rung,
}

impl Made {
    /// Counts something done for the call at `rung`.
    pub fn reach(&mut self, rung: Rung) {
        self.reached = self.reached.max(rung);
    }

    /// Keeps the steps of the run that answered.
    pub fn answered(&mut self, steps: Vec<Rung>) {
        for r in &steps {
            self.reached = self.reached.max(*r);
        }
        self.steps = steps;
    }

    /// Whether a browser process ran for the call.
    pub fn browser(&self) -> bool {
        self.reached.needs_browser()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rung_is_written_as_its_number_and_read_back() {
        for r in Rung::ALL {
            let written = serde_json::to_value(r).unwrap();
            assert_eq!(written, serde_json::json!(r.number()));
            assert_eq!(serde_json::from_value::<Rung>(written).unwrap(), r);
        }
        assert!(serde_json::from_value::<Rung>(serde_json::json!(6)).is_err(), "there is no seventh rung");
    }

    #[test]
    fn only_the_last_two_rungs_need_a_browser() {
        let needing: Vec<u8> = Rung::ALL.iter().filter(|r| r.needs_browser()).map(|r| r.number()).collect();
        assert_eq!(needing, [4, 5]);
    }

    #[test]
    fn a_call_mended_by_a_walk_reached_the_browser_though_its_steps_were_plain() {
        let mut made = Made::default();
        made.reach(Rung::Browser);
        made.answered(vec![Rung::Walk, Rung::Walk]);
        assert_eq!(made.reached, Rung::Browser);
        assert!(made.browser());
        let mut plain = Made::default();
        plain.answered(vec![Rung::Walk, Rung::Bundle]);
        assert_eq!(plain.reached, Rung::Bundle);
        assert!(!plain.browser());
    }
}
