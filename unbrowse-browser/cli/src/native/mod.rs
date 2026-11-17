#[allow(dead_code)]
pub mod a11y;
#[allow(dead_code)]
pub mod actions;
pub mod agent_world;
#[allow(dead_code)]
pub mod auth;
#[allow(dead_code)]
pub mod browser;
#[allow(dead_code)]
pub mod capture;
#[allow(dead_code)]
// The CDP engine lives in agent-browser-core: one implementation, two consumers.
pub use agent_browser_core::cdp;
#[allow(dead_code)]
pub mod cookies;
#[allow(dead_code)]
pub mod daemon;
#[allow(dead_code)]
pub mod diff;
#[allow(dead_code)]
pub mod element;
#[allow(dead_code)]
pub mod file_root;
#[allow(dead_code)]
pub mod inspect_server;
#[allow(dead_code)]
pub mod interaction;
#[allow(dead_code)]
pub mod network;
#[allow(dead_code)]
pub mod policy;
#[allow(dead_code)]
pub mod providers;
#[allow(dead_code)]
pub mod react;
#[allow(dead_code)]
pub mod recording;
#[allow(dead_code)]
pub mod screenshot;
#[allow(dead_code)]
pub mod snapshot;
#[allow(dead_code)]
pub mod state;
#[allow(dead_code)]
pub mod storage;
#[allow(dead_code)]
pub mod stream;
#[allow(dead_code)]
pub mod tab_binding;
#[allow(dead_code)]
pub mod tracing;
#[allow(dead_code)]
pub mod webdriver;
#[allow(dead_code)]
pub mod webmcp;

#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod parity_tests;
