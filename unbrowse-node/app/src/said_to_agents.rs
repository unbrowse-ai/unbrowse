//! What an agent is told never hands the person a command to type. An agent may have no terminal at all (ChatGPT and
//! Claude on the web, a phone), and one that has one shouldn't be steering its person to it: whatever needs the person
//! is a link they open, a place in the Unbrowse app, or a yes in the node's own dialog. A reply that names `unbrowse-node
//! …`, `unbrowse …`, `unb …` or `unbrowse-window` leaves an agent with no terminal stuck, and teaches one that has a
//! terminal to make its person use it.
//!
//! The check reads the source of the files that build what agents are answered (`AGENT_FACING`): the API and MCP, the
//! gateway and public peer, the browser and its asks, the node's health (which `unbrowse_whoami` carries), and the `unb`
//! program an agent's MCP client runs. What the owner's own terminal prints is theirs to keep: `println!`/`eprintln!`
//! lines, a usage line, and the functions named in `SAID_ON_THE_TERMINAL`. A new file that answers agents goes in
//! `AGENT_FACING`.

use std::path::{Path, PathBuf};

/// The source files (or folders of them) whose words reach an agent, relative to `src/`.
const AGENT_FACING: &[&str] = &[
    "api",
    "api.rs",
    "primitives.rs",
    "remote.rs",
    "hands.rs",
    "browse.rs",
    "browsers.rs",
    "learn.rs",
    "health.rs",
    "terms.rs",
    "passkey.rs",
    "import.rs",
    "autobounty.rs",
    "report.rs",
    "signed_client.rs",
    "bin/unb.rs",
    "setup.rs",
];

/// Functions and constants in those files whose words only the owner sees, on their own terminal or in the node's log:
/// the CLI's verbs, the notices the node prints when it starts, and what an owner command answers.
const SAID_ON_THE_TERMINAL: &[&str] = &[
    "cli",
    "joining",
    "announce",
    "announced",
    "public_cli",
    "make_peer_key",
    "peer_cli",
    "key_cli",
    "sign_in_cli",
    // passkey.rs: the owner's notice and their own commands' answers.
    "OFF",
    "NOTICE",
    "NONE_IN_FILE",
    "remove_in",
    // report.rs: printed in the node's log when it starts.
    "HOW_TO_STOP",
    // remote.rs: a gateway that changed who it is, a security warning for the owner (their window and the log).
    "gateway_peer",
];

/// Unbrowse's programs: a backticked span starting with one of these is a command for someone to type.
const PROGRAMS: &[&str] = &["unbrowse-node", "unbrowse-window", "unbrowse", "unb"];

/// The commands a line names: each backticked span whose first word is one of Unbrowse's programs.
pub fn commands_in(line: &str) -> Vec<String> {
    line.split('`')
        .skip(1)
        .step_by(2)
        .filter(|span| span.split_whitespace().next().is_some_and(|w| PROGRAMS.contains(&w)))
        .map(str::to_string)
        .collect()
}

/// The `.rs` files under `path`, or `path` itself; a module's own tests file is left out.
fn sources(path: &Path) -> Vec<PathBuf> {
    if path.is_file() {
        return vec![path.to_path_buf()];
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
        let p = entry.path();
        if p.is_dir() {
            out.extend(sources(&p));
        } else if p.extension().is_some_and(|e| e == "rs") && p.file_name().is_some_and(|n| n != "tests.rs") {
            out.push(p);
        }
    }
    out.sort();
    out
}

/// The name of the function or constant a line opens, if it opens one.
fn opens_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = [
        "pub(crate) async fn ",
        "pub(super) async fn ",
        "pub async fn ",
        "async fn ",
        "pub(crate) fn ",
        "pub(super) fn ",
        "pub fn ",
        "fn ",
        "pub(crate) const ",
        "pub const ",
        "const ",
    ]
    .iter()
    .find_map(|p| t.strip_prefix(p))?;
    rest.split(['(', '<', ':']).next()
}

/// Every place in one file's source that hands its reader a command, as `file:line: command`.
fn in_file(name: &str, source: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut on_terminal = false;
    let lines: Vec<&str> = source.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        // A file's test module is its last part: what the tests assert isn't said to anyone.
        if t == "#[cfg(test)]" && lines.get(i + 1).is_some_and(|n| n.trim_start().starts_with("mod ")) {
            break;
        }
        if let Some(item) = opens_item(line) {
            on_terminal = SAID_ON_THE_TERMINAL.contains(&item);
        }
        if on_terminal || t.starts_with("//") || ["println!", "eprintln!", "print!(", "eprint!(", "usage:"].iter().any(|p| line.contains(p)) {
            continue;
        }
        for c in commands_in(line) {
            found.push(format!("{name}:{}: `{c}`", i + 1));
        }
    }
    found
}

/// Everything under `src` (the crate's source folder) an agent would be told to type.
pub fn handed_to_agents(src: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for part in AGENT_FACING {
        for file in sources(&src.join(part)) {
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let name = file.strip_prefix(src).unwrap_or(&file).display().to_string();
            found.extend(in_file(&name, &text));
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The source this checks: this crate's own, or another copy of it (`UNBROWSE_REPLY_SCAN_ROOT`, an `src` folder),
    /// so the same check can be run on a tree from before it held.
    fn src() -> PathBuf {
        std::env::var_os("UNBROWSE_REPLY_SCAN_ROOT").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
    }

    #[test]
    fn a_reply_to_an_agent_never_hands_the_person_a_command() {
        let src = src();
        assert!(src.join("api").is_dir(), "no source to read at {}", src.display());
        let found = handed_to_agents(&src);
        assert!(
            found.is_empty(),
            "these reach an agent and name a command for someone to type; say where in the Unbrowse app it is done, give a link, or ask in the node's dialog instead:\n{}",
            found.join("\n")
        );
    }

    #[test]
    fn a_command_is_a_backticked_span_that_starts_with_an_unbrowse_program() {
        assert_eq!(commands_in("run `unbrowse-node remote on` now"), ["unbrowse-node remote on"]);
        assert_eq!(commands_in("open `unbrowse-window` or `unb mcp`"), ["unbrowse-window", "unb mcp"]);
        // A tool's name, a route's field or a path isn't a command.
        assert!(commands_in("call `unbrowse_do` with `url`, kept in `~/.unbrowse`").is_empty());
    }

    #[test]
    fn what_the_terminal_prints_and_what_tests_assert_are_left_alone() {
        let source = "fn reply() -> String {\n    \"open Unbrowse\".into()\n}\npub fn cli() {\n    let s = \"`unbrowse-node x`\";\n}\nfn said() {\n    println!(\"`unbrowse-node y`\");\n    // `unbrowse-node z`\n}\nfn told() -> &'static str {\n    \"run `unb mcp`\"\n}\n#[cfg(test)]\nmod tests {\n    const T: &str = \"`unbrowse-node w`\";\n}\n";
        assert_eq!(in_file("x.rs", source), ["x.rs:12: `unb mcp`"]);
    }
}
