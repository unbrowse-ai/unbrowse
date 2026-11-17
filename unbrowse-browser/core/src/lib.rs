//! agent-browser-core: the engine as a library.
//!
//! The CLI and the node share one implementation of the browser engine's
//! primitives — CDP transport, passive capture, session state, minting —
//! instead of the node driving a daemon over a socket. That removes the whole
//! class of bugs a process boundary brings: stale daemons, environment
//! captured at launch, sessions that survive their own relaunch.
//!
//! The CDP layer comes first: it is the engine's spine.

pub mod ca_bundle;
pub mod capture;
pub mod connection;
pub mod fingerprint;
pub mod intercept;
pub mod paths;
pub mod process;
pub mod screencast;
pub mod session;
pub mod cdp;

#[cfg(any(test, feature = "test-utils"))]
pub mod test_utils;
