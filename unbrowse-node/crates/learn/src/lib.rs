//! Route learning and browserless replay (`unbrowse-learn`).
//!
//! Implements the core five-stage pipeline (`mint -> walk -> trace -> route -> call`):
//!
//! - **Walk & capture (`walk`, `mint`, `session`, `challenge`):** Drives `agent-browser-core`
//!   in-process, records every exchange from first navigation, and detects front-door challenges
//!   dynamically from the walk's own traffic (never hardcoded by host or vendor).
//! - **Trace & provenance (`trace`, `slots`, `provenance`, `identity`, `fields`):** Pairs raw
//!   traffic into exchanges and traces each parameter back to its source (caller input, constant,
//!   earlier response, session cookie, or page code).
//! - **Graph & route (`graph`, `schema`, `page`, `judge`, `goal`, `answer`):** Builds the
//!   minimal dependency graph that reproduces the target API call without recorded secrets.
//! - **Replay & safety (`client`, `http`, `replay`, `egress`, `proxy`, `verify`, `ledger`):**
//!   Replays routes over a Chrome-shaped TLS/HTTP2 transport with strict egress rules for
//!   shared routes (HTTPS and public addresses only) and safe write-retry tracking.

pub mod answer;
pub mod body;
pub mod blobs;
pub mod budget;
pub mod challenge;
pub mod client;
pub mod controls;
pub mod decision;
pub mod egress;
pub mod fields;
pub mod files;
pub mod fresh;
pub mod generated;
pub mod goal;
pub mod graph;
pub mod health;
pub mod hold;
pub mod http;
pub mod identity;
pub mod judge;
pub mod lab;
pub mod ledger;
pub mod mint;
pub mod page;
pub mod paging;
pub mod provenance;
pub mod proxy;
pub mod recording;
pub mod refusal;
pub mod replay;
pub mod rung;
pub mod robots;
pub mod sandbox;
pub mod slice;
/// Pictures of a walk, from the engine: what the browser shows while it walks.
pub use agent_browser_core::screencast;
/// The engine's DevTools line: the owner's hands on a browsing page go over it (the node's `hands`).
pub use agent_browser_core::cdp;
pub mod session;
pub mod setup;
pub mod shown;
pub mod signing;
pub mod site;
pub mod snapshot;
pub mod slots;
pub mod tls;
pub mod trace;
pub mod upload;
pub mod verify;
pub mod walk;

pub use graph::{build, reaches_the_answer, Body, Class, Field, Graph, GraphError, Held, PartTemplate, Step, Written};
pub use client::RouteClient;
/// The body a route is learned as by example (`unbrowse-route`), for the node to keep and call.
pub use unbrowse_route as route;
pub use identity::{at_or_under, on_site, same_site, site_of};
pub use ledger::{CommitMark, Effect, Ledger, MarkState, Retry};
pub use mint::{BrowserMint, Mint, MintError, MintedSession};
pub use replay::{HttpReplay, ReplayError};
pub use rung::{Made, Rung};
pub use session::{Action, Segment, Session, SocketEvent};
pub use slots::Loc;
pub use trace::{Exchange, Input, Trace, TraceError};
