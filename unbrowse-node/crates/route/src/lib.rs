//! The body of a route, and the evaluator that fills it.
//!
//! A route body is data, never code (`R2.7`), and a graph (`R2.9`). The graph is and-or: a **hole** is a place in a
//! request, a **way** is one expression that fills it and needs all of its sources, and a hole may have several ways,
//! any one of which will do. A call takes the first way that is ready, and ways are kept cheapest first
//! (`learn.rung`).
//!
//! This crate holds the body ([`body`]), the closed list of expressions a way may be ([`expr`]) and how a step's
//! holes become a request ([`fill`]). It sends nothing and reads no reply: everything outside a body (the caller's
//! values, the jar, an earlier step's reply, the clock) is asked of a [`World`], which the node answers with the
//! readers it already has. So there is one reader for each question, and this crate builds and tests with none of
//! the node.
//!
//! The plan this follows is `docs/REBUILD.md`.

pub mod body;
pub mod expr;
pub mod fill;
pub mod format;
pub mod meaning;
pub mod wire;

pub use body::{fragment_pairs, Answer, Decode, Asked, AskedAt, AskedBy, Caller, Chars, Done, Form, Hole, Part, Place, Plan, Route, Seen, Shape, Sighting, Slot, Source, Step, Test, Way, VERSION};
pub use expr::{Algo, At, Clock, Expr, Feed, FileFact, Fits, How, Outcome, Reach, Sent, Stuck, Why, World, Wrap};
pub use fill::{request, start, start_below, Built, Draft};
pub use format::Pattern;
