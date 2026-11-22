//! Unbrowse fork: a command that names its tab runs in that tab.
//!
//! The node gives each of its agent sessions a tab of the site's one browser and names it on every
//! command (`AGENT_BROWSER_TAB`, sent as `tab`). The daemon switches to that tab, making it the first
//! time it is named, before running the command. Switching happens under the daemon's state lock, so two
//! sessions never act on each other's page between a switch and the command. What a session had
//! snapshotted (its `@e` refs) and the frame it was in are parked under its label while another
//! session's command runs, and come back with it on the page they were made on.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::super::actions::{handle_tab_new, handle_tab_switch, DaemonState};
use super::super::browser::{format_tab_id, is_valid_label, PageInfo};
use super::super::element::RefMap;

/// What a labelled tab's session had numbered: its refs, the frame it was in, and the page they were made on.
pub struct Parked {
    refs: RefMap,
    frame: Option<String>,
    target: String,
}

#[derive(Default)]
pub struct Tabs {
    parked: HashMap<String, Parked>,
    /// The page the live refs were numbered on; none means the active page.
    refs_target: Option<String>,
    /// Each page a page opened (a popup, a `target=_blank` link, a 3-D Secure window), by its opener.
    opened_from: HashMap<String, String>,
}

impl Tabs {
    /// Notes which page opened a new one, from the event that announces it.
    pub fn on_event(&mut self, method: &str, params: &Value) {
        if method != "Target.targetCreated" && method != "Target.attachedToTarget" {
            return;
        }
        let info = &params["targetInfo"];
        if let (Some(target), Some(opener)) = (info["targetId"].as_str(), info["openerId"].as_str()) {
            self.opened_from.insert(target.to_string(), opener.to_string());
        }
    }
}

/// The tab a command names for itself, when it acts on a page. Tab management, browser lifecycle and
/// commands that touch no page run where they always did.
pub fn named<'a>(cmd: &'a Value, action: &str, skip_launch: bool) -> Option<&'a str> {
    let label = cmd.get("tab").and_then(Value::as_str).filter(|l| !l.is_empty())?;
    let own = matches!(action, "tab_list" | "tab_new" | "tab_switch" | "tab_close" | "window_new" | "capture_forget");
    (!skip_launch && !own).then_some(label)
}

/// Makes the page of the session whose tab is labelled `label` the active one: the newest page its tab
/// opened that is still open, else the tab itself, else a new tab (taking the place of the lone blank
/// page a browser starts with).
pub async fn enter(state: &mut DaemonState, label: &str) -> Result<(), String> {
    if !is_valid_label(label) {
        return Err(format!("Invalid tab label `{}`", label));
    }
    let (pages, active_tab, active_target) = {
        let mgr = state.browser.as_ref().ok_or("Browser not launched")?;
        (mgr.pages_list(), mgr.active_tab_id(), mgr.active_target_id().ok().map(String::from))
    };
    let tabs = &state.unbrowse.tabs;
    let want = session_page(&pages, &tabs.opened_from, label);
    let refs_on = tabs.refs_target.clone().or_else(|| active_target.clone());
    if want.is_some() && want == active_tab && refs_on == active_target {
        return Ok(());
    }
    // The refs being left are the session's whose page they were made on, while that page is open.
    let leaving = refs_on.as_deref().and_then(|t| session_of_page(&pages, &tabs.opened_from, t)).zip(refs_on.clone()).map(|(owner, target)| {
        (owner, Parked { refs: state.ref_map.clone(), frame: state.active_frame_id.clone(), target })
    });
    match want {
        Some(tab_id) if Some(tab_id) == active_tab => {}
        Some(tab_id) => {
            handle_tab_switch(&json!({ "tabId": format_tab_id(tab_id) }), state).await?;
        }
        None => {
            // Only the blank page a browser starts with gives way, never a page a session opened.
            let blank = match pages.as_slice() {
                [only] if only.label.is_none() && matches!(only.url.as_str(), "" | "about:blank" | "chrome://newtab/" | "chrome://new-tab-page/") => Some(only.tab_id),
                _ => None,
            };
            handle_tab_new(&json!({ "label": label }), state).await?;
            if let (Some(blank), Some(mgr)) = (blank, state.browser.as_mut()) {
                let _ = mgr.tab_close_by_id(Some(blank), None).await;
            }
        }
    }
    if let Some((owner, parked)) = leaving {
        state.unbrowse.tabs.parked.insert(owner, parked);
    }
    let now = state.browser.as_ref().and_then(|mgr| mgr.active_target_id().ok().map(String::from));
    restore(state, label, now);
    Ok(())
}

/// Gives the active page `now`, a page of the session labelled `label`, the refs and frame that session
/// parked on it, else none; and drops what was parked for tabs that have closed.
fn restore(state: &mut DaemonState, label: &str, now: Option<String>) {
    let back = state.unbrowse.tabs.parked.remove(label).filter(|p| Some(&p.target) == now.as_ref());
    let (mut refs, frame) = back.map_or_else(|| (RefMap::new(), None), |p| (p.refs, p.frame));
    // Numbers go on from wherever the browser has reached: a session's old `@e3` must never come to name a new element.
    refs.set_next_ref_num(refs.next_ref_num().max(state.ref_map.next_ref_num()));
    state.ref_map = refs;
    state.active_frame_id = frame;
    state.active_iframe_sessions.clear();
    super::super::element::set_active_frame(state.active_frame_id.as_deref());
    let tabs = &mut state.unbrowse.tabs;
    tabs.refs_target = now;
    if let Some(mgr) = state.browser.as_ref() {
        tabs.parked.retain(|l, p| mgr.has_label(l) && mgr.has_target(&p.target));
        tabs.opened_from.retain(|t, _| mgr.has_target(t));
    }
}

/// What a tab command may wipe that isn't its to wipe: the live refs and frame, and the page they are on.
pub struct Kept(Option<(RefMap, Option<String>, Option<String>)>);

/// Before a command runs: closing a tab clears the refs upstream, whichever tab closed.
pub fn before(state: &DaemonState, action: &str) -> Kept {
    if action != "tab_close" {
        return Kept(None);
    }
    let on = state.unbrowse.tabs.refs_target.clone().or_else(|| state.browser.as_ref().and_then(|m| m.active_target_id().ok().map(String::from)));
    Kept(Some((state.ref_map.clone(), state.active_frame_id.clone(), on)))
}

/// After a command ran: closing another session's tab leaves this one's refs as they were, and a tab the
/// agent made or switched to by hand starts with the refs upstream gave it.
pub fn after(state: &mut DaemonState, action: &str, result: &Result<Value, String>, kept: Kept) {
    match (action, result, kept.0) {
        ("tab_close", Ok(closed), Some((refs, frame, Some(on)))) => {
            let still_open = state.browser.as_ref().is_some_and(|m| m.has_target(&on));
            if still_open && closed.get("targetId").and_then(Value::as_str) != Some(on.as_str()) {
                state.ref_map = refs;
                state.active_frame_id = frame;
                super::super::element::set_active_frame(state.active_frame_id.as_deref());
                state.unbrowse.tabs.refs_target = Some(on);
            } else {
                state.unbrowse.tabs.refs_target = None;
            }
        }
        ("tab_new" | "tab_switch" | "window_new" | "close", Ok(_), _) => state.unbrowse.tabs.refs_target = None,
        _ => {}
    }
}

/// The tab a session labelled `label` acts in: the newest still-open page its own tab opened, or one of
/// those opened, else its tab. None when it has no tab yet.
fn session_page(pages: &[PageInfo], opened_from: &HashMap<String, String>, label: &str) -> Option<u32> {
    let own = pages.iter().find(|p| p.label.as_deref() == Some(label))?;
    let opened = pages.iter().filter(|p| p.label.is_none() && opened_by(opened_from, &p.target_id, &own.target_id)).map(|p| p.tab_id).max();
    Some(opened.unwrap_or(own.tab_id))
}

/// Whether the page `target` was opened by the page `by`, or by a page `by` opened.
fn opened_by(opened_from: &HashMap<String, String>, target: &str, by: &str) -> bool {
    let mut at = target;
    for _ in 0..32 {
        match opened_from.get(at) {
            Some(opener) if opener == by => return true,
            Some(opener) => at = opener,
            None => return false,
        }
    }
    false
}

/// The label of the session whose page `target` is: its own tab's, or the tab's that opened it.
fn session_of_page(pages: &[PageInfo], opened_from: &HashMap<String, String>, target: &str) -> Option<String> {
    let mut at = target;
    for _ in 0..32 {
        let page = pages.iter().find(|p| p.target_id == at)?;
        if let Some(label) = &page.label {
            return Some(label.clone());
        }
        at = opened_from.get(at)?;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(tab_id: u32, label: Option<&str>, target: &str) -> PageInfo {
        PageInfo {
            tab_id,
            label: label.map(String::from),
            target_id: target.to_string(),
            session_id: format!("s-{target}"),
            url: "https://shop.example/".into(),
            title: String::new(),
            target_type: "page".into(),
        }
    }

    /// A session acts in the newest page its own tab opened (a popup, and what the popup opened), never in
    /// a page another session's tab opened.
    #[test]
    fn a_session_follows_the_pages_its_own_tab_opened() {
        let pages = [page(1, Some("a"), "ta"), page(2, Some("b"), "tb"), page(3, None, "popup"), page(4, None, "popup2"), page(5, None, "stray")];
        let mut tabs = Tabs::default();
        tabs.on_event("Target.targetCreated", &json!({ "targetInfo": { "targetId": "popup", "openerId": "ta" } }));
        tabs.on_event("Target.targetCreated", &json!({ "targetInfo": { "targetId": "popup2", "openerId": "popup" } }));
        assert_eq!(session_page(&pages, &tabs.opened_from, "a"), Some(4));
        assert_eq!(session_page(&pages, &tabs.opened_from, "b"), Some(2));
        assert_eq!(session_page(&pages, &tabs.opened_from, "c"), None, "no tab yet");
        assert_eq!(session_of_page(&pages, &tabs.opened_from, "popup2").as_deref(), Some("a"));
        assert_eq!(session_of_page(&pages, &tabs.opened_from, "stray"), None);
    }

    /// Only a command that acts on a page is moved to its tab.
    #[test]
    fn tab_management_runs_where_it_always_did() {
        let cmd = json!({ "tab": "a" });
        assert_eq!(named(&cmd, "click", false), Some("a"));
        assert_eq!(named(&cmd, "tab_list", false), None);
        assert_eq!(named(&cmd, "capture_forget", false), None);
        assert_eq!(named(&cmd, "close", true), None, "a command that launches nothing");
        assert_eq!(named(&json!({}), "click", false), None);
    }
}
