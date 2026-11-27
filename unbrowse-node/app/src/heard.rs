//! The agent apps that have reached this node: each MCP client's own name, as it says it at `initialize`, with when it
//! first and last did, and whether it came through the node's web address. Connecting an app writes a file the app
//! reads when it starts; this is the other half, the app showing up. The window and `setup_status` read it, so an owner
//! who pressed Connect sees "reached Unbrowse" rather than taking it on trust.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{connect, store};

/// Every app heard, newest last.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct Heard {
    #[serde(default)]
    pub apps: Vec<App>,
}

/// One app, by the name it gave.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
pub struct App {
    pub name: String,
    /// It came through the node's web address (ChatGPT or Claude on the web), not from this computer.
    #[serde(default)]
    pub web: bool,
    pub first: u64,
    pub last: u64,
}

/// The most apps kept: the ones heard longest ago go first.
const KEPT: usize = 32;

/// The longest name kept, in characters.
const LONGEST: usize = 64;

fn path_in(dir: &Path) -> PathBuf {
    dir.join("heard.json")
}

pub fn load() -> Heard {
    load_in(&store::home())
}

fn load_in(dir: &Path) -> Heard {
    store::read_json(&path_in(dir), &unbrowse_files::HEARD)
}

/// The name an app gave, as kept: its printable characters, trimmed, at most `LONGEST` of them. None when nothing is
/// left, or when it is one of Unbrowse's own programs (`unbrowse-connect` checking a server it wrote): those are the
/// node talking to itself, not an app reaching it.
pub fn clean(name: &str) -> Option<String> {
    let kept: String = name.chars().filter(|c| !c.is_control()).take(LONGEST).collect();
    let kept = kept.trim();
    (!kept.is_empty() && !squash(kept).starts_with("unbrowse")).then(|| kept.to_string())
}

/// Notes in `dir` that the app called `name` reached the node at `now`. True the first time it is heard.
fn note_in(dir: &Path, name: &str, web: bool, now: u64) -> bool {
    let mut heard = load_in(dir);
    let first = match heard.apps.iter_mut().find(|a| a.name == name && a.web == web) {
        Some(a) => {
            a.last = now;
            false
        }
        None => {
            heard.apps.push(App { name: name.to_string(), web, first: now, last: now });
            true
        }
    };
    heard.apps.sort_by_key(|a| a.last);
    let over = heard.apps.len().saturating_sub(KEPT);
    heard.apps.drain(..over);
    if let Err(e) = store::write_json(&path_in(dir), &unbrowse_files::HEARD, &heard) {
        eprintln!("heard: couldn't keep which apps reached this node: {e}");
    }
    first
}

/// An MCP `initialize` from the app that names itself `client_name`, which came through the node's web address when
/// `web`: kept, and the first time, said in the activity log ("Claude Code reached Unbrowse"), which the window shows.
pub fn note(node: &crate::Node, client_name: &str, web: bool) {
    let Some(name) = clean(client_name) else {
        return;
    };
    if !note_in(&store::home(), &name, web, store::now()) {
        return;
    }
    store::log_activity(&store::Activity {
        at: store::now(),
        who: shown(&name),
        site: "This node".into(),
        what: if web { "Reached Unbrowse through its web address".into() } else { "Reached Unbrowse".into() },
        kind: "connect".into(),
        result: "done".into(),
        ms: None,
        unb: None,
        tx: None,
        note: None,
    });
    node.events.emit("activity", ());
}

/// A name as the owner reads it: the app Connect knows it as, else the name it gave.
pub fn shown(name: &str) -> String {
    connect::ALL.into_iter().find(|c| names(name, *c)).map(|c| c.name().to_string()).unwrap_or_else(|| name.to_string())
}

/// Letters and digits alone, in lower case: "Claude Code", "claude-code" and "claude_code" all read "claudecode".
fn squash(s: &str) -> String {
    s.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

/// Whether the name an app gave is `client`'s: it starts with the client's id or the name Connect shows it by, so
/// `claude-code` is Claude Code and `codex-mcp-client` is Codex, and `cursor-vscode` is Cursor and not VS Code.
fn names(name: &str, client: connect::Client) -> bool {
    let name = squash(name);
    [squash(client.id()), squash(client.name())].iter().any(|w| !w.is_empty() && name.starts_with(w.as_str()))
}

/// When `client` last reached this node from this computer, among the apps in `heard`.
pub fn last(heard: &Heard, client: connect::Client) -> Option<u64> {
    heard.apps.iter().filter(|a| !a.web && names(&a.name, client)).map(|a| a.last).max()
}

/// Each client in `list` with when it last reached this node (`Status::heard`).
pub fn stamp(list: &mut [connect::Status]) {
    let heard = load();
    for s in list.iter_mut() {
        s.heard = connect::Client::from_id(s.id).and_then(|c| last(&heard, c));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_app_is_known_by_the_name_it_starts_with() {
        assert!(names("claude-code", connect::Client::ClaudeCode));
        assert!(names("codex-mcp-client", connect::Client::Codex));
        assert!(names("opencode", connect::Client::Opencode));
        assert!(names("LM Studio", connect::Client::LmStudio));
        assert!(names("cursor-vscode", connect::Client::Cursor));
        assert!(
            !names("cursor-vscode", connect::Client::VsCode),
            "a name is the app it starts with, not one it mentions"
        );
        assert!(!names("claude-ai", connect::Client::ClaudeCode));
        assert_eq!(shown("claude-code"), "Claude Code");
        assert_eq!(shown("some-new-agent"), "some-new-agent", "an app Connect doesn't know keeps the name it gave");
    }

    #[test]
    fn unbrowse_s_own_programs_and_empty_names_are_not_apps() {
        assert_eq!(clean("unbrowse-connect"), None);
        assert_eq!(clean("Unbrowse Answer"), None);
        assert_eq!(clean("  \u{7}\n "), None);
        assert_eq!(clean(" claude-code\n").as_deref(), Some("claude-code"));
        assert_eq!(clean(&"x".repeat(500)).map(|n| n.chars().count()), Some(LONGEST));
    }

    #[test]
    fn an_app_is_new_once_and_then_only_seen_again() {
        let d = store::scratch_home("heard-once");
        assert!(note_in(&d, "claude-code", false, 100));
        assert!(!note_in(&d, "claude-code", false, 200));
        assert!(note_in(&d, "claude-code", true, 300), "the same app through the web address is heard apart");
        let h = load_in(&d);
        assert_eq!(h.apps.len(), 2);
        let here = h.apps.iter().find(|a| !a.web).unwrap();
        assert_eq!((here.first, here.last), (100, 200));
        assert_eq!(
            last(&h, connect::Client::ClaudeCode),
            Some(200),
            "only from this computer counts for a connected app"
        );
        assert_eq!(last(&h, connect::Client::Codex), None);
    }

    #[test]
    fn the_apps_heard_longest_ago_go_first() {
        let d = store::scratch_home("heard-kept");
        for i in 0..(KEPT as u64 + 5) {
            note_in(&d, &format!("app-{i}"), false, i);
        }
        let h = load_in(&d);
        assert_eq!(h.apps.len(), KEPT);
        assert_eq!(h.apps.first().map(|a| a.name.as_str()), Some("app-5"));
    }
}
