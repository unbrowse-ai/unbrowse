//! The learner by example (`docs/REBUILD.md`, section 6).
//!
//! One walk shows what a page sent for one value. Which of those values are fixed, which are the caller's and
//! which were read from an earlier reply, one walk cannot say: a number an advert answered with and the search also
//! sends looks like a tie, and is a coincidence. So every sighting of one call, across the walks of a learn, is
//! lined up ([`sighting`]), and for each place of the request the expressions that rebuild the value on every
//! sighting are kept ([`synth`]). What rebuilds none is open, and says what was different about the sightings it
//! was seen on.
//!
//! Which call of a walk is the answer the two walks say themselves ([`answer`]): the call both make whose reply
//! changes with the value and says its own walk's value back, the page among the calls.
//!
//! Nothing here asks a site: the walks are read. Nothing here names one either. What the walks cannot settle goes
//! to a proposer and then to the site (`learn.proposer`), which this module does not do yet.

pub mod answer;
pub mod call;
pub mod compile;
pub mod forms;
pub mod kept;
pub mod meaning;
pub mod propose;
pub mod sighting;
pub mod site;
pub mod synth;
pub mod shrink;
pub mod verify;

#[cfg(test)]
mod corpus;
