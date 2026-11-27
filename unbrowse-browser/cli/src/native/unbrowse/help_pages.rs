//! Upstream's `<command> --help` pages, held through the built binary.
//!
//! Agents learn agent-browser from these pages (and from `skills`), so an upgrade that drops a page, gives two
//! commands the same page, or documents an example the parser refuses misleads every agent that reads it.

use super::*;

/// Every top-level command with its own page, aliases after the name the page is titled with.
const PAGES: &[&[&str]] = &[
    &["open", "goto", "navigate"],
    &["back"],
    &["forward"],
    &["reload"],
    &["read"],
    &["click"],
    &["dblclick"],
    &["fill"],
    &["type"],
    &["hover"],
    &["focus"],
    &["check"],
    &["uncheck"],
    &["select"],
    &["drag"],
    &["upload"],
    &["download"],
    &["press", "key"],
    &["keydown"],
    &["keyup"],
    &["keyboard"],
    &["scroll"],
    &["scrollintoview", "scrollinto"],
    &["wait"],
    &["screenshot"],
    &["pdf"],
    &["snapshot"],
    &["eval"],
    &["close", "quit", "exit"],
    &["inspect"],
    &["get"],
    &["is"],
    &["find"],
    &["mouse"],
    &["set"],
    &["network"],
    &["storage"],
    &["cookies"],
    &["tab"],
    &["window"],
    &["frame"],
    &["auth"],
    &["confirm", "deny"],
    &["dialog"],
    &["trace"],
    &["profiler"],
    &["record"],
    &["console"],
    &["errors"],
    &["highlight"],
    &["clipboard"],
    &["state"],
    &["session"],
    &["install"],
    &["upgrade"],
    &["doctor"],
    &["dashboard"],
    &["connect"],
    &["stream"],
    &["tap"],
    &["swipe"],
    &["device"],
    &["diff"],
    &["batch"],
    &["a11y"],
    &["profiles"],
    &["chat"],
    &["mcp"],
    &["skills"],
    &["plugin", "plugins"],
];

/// Top-level commands upstream ships without a page of their own: `--help` on them prints the general help.
const NO_PAGE: &[&str] = &[
    "react",
    "vitals",
    "web-vitals",
    "pushstate",
    "removeinitscript",
    "webmcp",
    "flow",
];

/// Pages whose examples run outside the daemon (install, servers, other processes, the network): their examples
/// are not run here.
const LOCAL: &[&str] = &[
    "install",
    "upgrade",
    "doctor",
    "dashboard",
    "chat",
    "mcp",
    "skills",
    "plugin",
    "stream",
    "connect",
    "device",
    "profiles",
    "inspect",
    "session",
];

const GENERAL: &str = "Start here (for AI agents):";

fn help(daemon: &Daemon, args: &[&str]) -> String {
    let output = daemon.run(args, "");
    assert_eq!(output.status.code(), Some(0), "{args:?}: {}", text(&output));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn every_command_prints_its_own_help_page_and_its_aliases_print_the_same_one() {
    let daemon = Daemon::start();
    let mut seen: Vec<(&str, String)> = Vec::new();
    for names in PAGES {
        let name = names[0];
        let page = help(&daemon, &[name, "--help"]);
        let title = page.lines().next().unwrap_or_default();
        assert!(
            title.starts_with(&format!("agent-browser {name} "))
                || title.starts_with(&format!("agent-browser {name}/")),
            "{name} --help is titled {title:?}"
        );
        assert!(
            !page.contains(GENERAL),
            "{name} --help printed the general help"
        );
        assert!(
            page.contains("Usage:"),
            "{name} --help has no usage line:\n{page}"
        );
        assert!(
            page.contains(&format!("agent-browser {name}")),
            "{name} --help never shows the command"
        );
        for alias in &names[1..] {
            assert_eq!(
                help(&daemon, &[alias, "--help"]),
                page,
                "{alias} --help is not {name}'s page"
            );
            assert_eq!(
                help(&daemon, &[alias, "-h"]),
                page,
                "{alias} -h is not {name}'s page"
            );
        }
        if let Some((other, _)) = seen.iter().find(|(_, p)| *p == page) {
            panic!("{name} --help prints the same page as {other}");
        }
        seen.push((name, page));
    }
    assert!(
        daemon.seen.lock().unwrap().is_empty(),
        "a help page asked the daemon something"
    );
}

#[test]
fn help_with_no_command_or_a_command_without_a_page_prints_the_general_help() {
    let daemon = Daemon::start();
    let general = help(&daemon, &["--help"]);
    assert!(general.contains(GENERAL), "--help:\n{general}");
    assert!(general.contains("Usage: agent-browser <command> [args] [options]"));
    assert_eq!(help(&daemon, &["-h"]), general);
    assert_eq!(help(&daemon, &["--json", "--help"]), general);
    for name in NO_PAGE {
        assert_eq!(help(&daemon, &[name, "--help"]), general, "{name} --help");
    }
    // `--help` after a command's own arguments still finds the command's page.
    let click = help(&daemon, &["click", "#submit", "--help"]);
    assert!(click.starts_with("agent-browser click "), "{click}");
}

/// The words of a shell line up to its first pipe, list or redirect, with quotes removed and `# comments` dropped.
fn shell_words(line: &str) -> Vec<String> {
    let (mut words, mut word, mut quote, mut started) = (Vec::new(), String::new(), None, false);
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some('"'), '\\') if matches!(chars.peek(), Some('"' | '\\' | '$')) => {
                word.push(chars.next().unwrap())
            }
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                started = true;
            }
            (None, '\\') => {
                if let Some(next) = chars.next() {
                    word.push(next);
                    started = true;
                }
            }
            (None, c) if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            (None, '#') if !started => break,
            (None, '|' | ';' | '&' | '>' | '<') => break,
            (None, c) => {
                word.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(word);
    }
    words
}

#[test]
fn every_example_on_a_daemon_commands_page_is_a_command_line_the_parser_takes() {
    let daemon = Daemon::start();
    let (mut ran, mut refused) = (0, Vec::new());
    for names in PAGES {
        let name = names[0];
        if LOCAL.contains(&name) {
            continue;
        }
        let page = help(&daemon, &[name, "--help"]);
        let examples = page
            .split("\nExamples:")
            .skip(1)
            .flat_map(|block| {
                block
                    .lines()
                    .take_while(|l| l.is_empty() || l.starts_with(' '))
            })
            .map(str::trim)
            .filter(|l| l.starts_with("agent-browser "));
        for example in examples {
            let words = shell_words(example);
            if words.iter().any(|w| w.contains('$') || w.starts_with('<')) {
                continue; // a placeholder the reader fills in
            }
            let mut argv = vec!["--json".to_string()];
            argv.extend(words.into_iter().skip(1));
            let args: Vec<&str> = argv.iter().map(String::as_str).collect();
            let output = daemon.run(&args, "[]");
            ran += 1;
            let answer: Value = serde_json::from_slice(&output.stdout).unwrap_or(Value::Null);
            let kind = answer["type"].as_str().unwrap_or_default();
            if matches!(
                kind,
                "unknown_command"
                    | "unknown_subcommand"
                    | "missing_arguments"
                    | "invalid_value"
                    | "invalid_session_name"
            ) {
                refused.push(format!(
                    "{name}: `{example}` -> {kind}: {}",
                    answer["error"]
                ));
            }
        }
    }
    assert!(ran > 150, "only {ran} examples ran");
    assert!(
        refused.is_empty(),
        "{} of {ran} documented examples are refused:\n{}",
        refused.len(),
        refused.join("\n")
    );
}
