//! Unbrowse fork: everything the Unbrowse node needs from this browser that upstream does not have.
//!
//! Upstream's files call into this module from a few lines marked `Unbrowse fork:`; the behaviour itself
//! lives here, so an upstream update merges without touching it. `FORK.md` lists every such line.
//!
//! - [`capture`]: with `UNBROWSE_CAPTURE_DIR` set, each session appends what the page sent and what the
//!   agent did to `<dir>/<session>.jsonl`, which the node learns routes from.
//! - [`tab`]: a command that names its tab (`AGENT_BROWSER_TAB`) runs in that tab, so sessions that
//!   share one browser each act on their own page.
//! - [`fill`]: a value bound to a site (a login, a code, a card) goes only into a checked field of it.
//! - [`eval`]: `eval --timeout <ms>` lets a script that waits take longer than 30 s.
//! - [`world`]: a caller's script runs in an isolated world of its own, where the site's session reads as
//!   `{session}` and nothing reaches the page's own world; a command that activates an element never runs a
//!   script address in the page's world.
//! - [`busy`]: the node's own questions are answered while an agent's command holds the daemon.

pub mod busy;
pub mod capture;
pub mod eval;
pub mod fill;
pub mod network;
pub mod saved;
pub mod tab;
pub mod world;
#[cfg(test)]
mod contract;
#[cfg(test)]
mod surface;
#[cfg(test)]
mod flags_table;
#[cfg(test)]
mod chrome_search;
#[cfg(test)]
mod features;
#[cfg(test)]
mod handlers_e2e;
#[cfg(test)]
mod world_e2e;
#[cfg(test)]
mod provider_stubs;
#[cfg(test)]
mod webdriver_stub;

/// What the fork keeps for a daemon, as one field of upstream's `DaemonState`.
#[derive(Default)]
pub struct State {
    pub capture: capture::Capture,
    pub tabs: tab::Tabs,
    pub busy: std::sync::Arc<busy::WhileBusy>,
}

use serde_json::Value;

use super::actions::DaemonState;

/// Before a command is looked at. `Some` is the command's whole answer.
pub async fn before_command(state: &mut DaemonState, cmd: &Value) -> Option<Result<Value, String>> {
    capture::apply_queued(state);
    let action = cmd.get("action").and_then(Value::as_str).unwrap_or_default();
    // The node's own questions over the socket (`noLaunch`) never launch a browser: one launched here would
    // have none of the site's launch settings, its profile among them.
    if cmd.get("noLaunch").and_then(Value::as_bool) == Some(true) && state.browser.is_none() && action != "capture_forget" {
        return Some(Err("Browser not launched".to_string()));
    }
    capture::forget(state, cmd)
}

/// What [`before_action`] hands to [`after_action`].
pub struct Step {
    typed: Option<Value>,
    kept: tab::Kept,
}

/// Just before a command's handler runs.
pub async fn before_action(state: &mut DaemonState, action: &str, cmd: &Value) -> Step {
    Step { typed: capture::log_action(state, action, cmd).await, kept: tab::before(state, action) }
}

/// Just after a command's handler ran.
pub fn after_action(state: &mut DaemonState, action: &str, result: &Result<Value, String>, step: Step) {
    if result.is_ok() {
        capture::log_done(state, step.typed);
    }
    tab::after(state, action, result, step.kept);
    state.unbrowse.busy.seen(state.browser.as_ref().map(|mgr| (mgr.tab_list(), mgr.get_cdp_url().to_string())));
}
