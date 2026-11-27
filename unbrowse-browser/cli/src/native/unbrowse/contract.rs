//! The node's argv, as this CLI parses it (UNB-208). No browser: these run with the rest of the CLI's tests.
//!
//! Every command line here is one the Unbrowse node builds (`unbrowse-node/app/src/browse.rs` `cli` and `run`,
//! `crates/learn/src/mint.rs`), behind the node's own prefix: `--config <home>/browser-config.json --session <s>
//! --profile <dir> --args <switches>`. Each must parse into the action the daemon dispatches, with the fields the
//! handler reads. An upstream release that renames a verb, a subcommand, a flag or an action fails here.
//! `contract_cli.rs` runs the same lines through the built binary in a real browser.

use serde_json::Value;

use crate::commands::parse_command;
use crate::flags::{clean_args, parse_flags, Flags};

const PROFILE: &str = "/home/owner/.unbrowse/profiles/example.com";
const SWITCHES: &str = "--disable-blink-features=AutomationControlled,--proxy-server=http://127.0.0.1:9000";

/// The node's prefix, then `line`.
fn node_argv(line: &[&str]) -> Vec<String> {
    // The node writes exactly `{}` there (`mint.rs` `on_its_own`). Written once: a config read while another test
    // rewrites it would be empty, and the CLI exits on a config it can't read.
    static CONFIG: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("unbrowse-contract-{}-browser-config.json", std::process::id()));
        std::fs::write(&path, "{}").unwrap();
        path
    });
    let mut argv: Vec<String> = ["--config", config.to_str().unwrap(), "--session", "example-com", "--profile", PROFILE, "--args", SWITCHES]
        .iter()
        .map(|s| s.to_string())
        .collect();
    argv.extend(line.iter().map(|s| s.to_string()));
    argv
}

fn parsed(line: &[&str]) -> (Flags, Value) {
    let argv = node_argv(line);
    let flags = parse_flags(&argv);
    let command = parse_command(&clean_args(&argv), &flags).unwrap_or_else(|e| panic!("{line:?} doesn't parse: {}", e.format()));
    (flags, command)
}

fn action(line: &[&str]) -> Value {
    let (_, command) = parsed(line);
    command
}

#[track_caller]
fn assert_action(line: &[&str], expected: &str) -> Value {
    let command = action(line);
    assert_eq!(command["action"], expected, "{line:?} parsed to {command}");
    command
}

#[test]
fn the_nodes_prefix_sets_its_session_profile_and_switches() {
    let (flags, command) = parsed(&["open", "https://example.com/"]);
    assert_eq!(flags.session, "example-com");
    assert_eq!(flags.profile.as_deref(), Some(PROFILE));
    assert_eq!(flags.args.as_deref(), Some(SWITCHES));
    assert!(!flags.json && !flags.headed);
    // The profile and the switches ride to the daemon in the launch settings, the switches one by one.
    let wire = crate::command_settings(&flags, &command).to_wire().unwrap_or(Value::Null);
    assert_eq!(wire["profile"], PROFILE, "{wire}");
    assert_eq!(wire["args"], serde_json::json!(["--disable-blink-features=AutomationControlled", "--proxy-server=http://127.0.0.1:9000"]), "{wire}");
}

#[test]
fn open_goto_and_navigate_go_to_the_url_and_a_retried_walk_opens_headed() {
    for verb in ["open", "goto", "navigate"] {
        let command = assert_action(&[verb, "https://example.com/a"], "navigate");
        assert_eq!(command["url"], "https://example.com/a");
    }
    let (flags, _) = parsed(&["open", "https://example.com/", "--headed"]);
    assert!(flags.headed, "mint.rs opens headed on a retry");
}

#[test]
fn snapshot_takes_every_flag_the_node_lets_an_agent_send() {
    assert_action(&["snapshot"], "snapshot");
    for flag in ["-i", "--interactive"] {
        assert_eq!(assert_action(&["snapshot", flag], "snapshot")["interactive"], true, "{flag}");
    }
    for flag in ["-c", "--compact"] {
        assert_eq!(assert_action(&["snapshot", flag], "snapshot")["compact"], true, "{flag}");
    }
    for flag in ["-d", "--depth"] {
        assert_eq!(assert_action(&["snapshot", flag, "3"], "snapshot")["maxDepth"], 3, "{flag}");
    }
    for flag in ["-s", "--selector"] {
        assert_eq!(assert_action(&["snapshot", flag, "#main"], "snapshot")["selector"], "#main", "{flag}");
    }
    for flag in ["-u", "--urls"] {
        assert_eq!(assert_action(&["snapshot", flag], "snapshot")["urls"], true, "{flag}");
    }
}

#[test]
fn the_element_verbs_act_on_the_ref_or_selector_given() {
    for (verb, expected) in [
        ("click", "click"),
        ("dblclick", "dblclick"),
        ("check", "check"),
        ("uncheck", "uncheck"),
        ("hover", "hover"),
        ("focus", "focus"),
        ("scrollintoview", "scrollintoview"),
    ] {
        assert_eq!(assert_action(&[verb, "@e3"], expected)["selector"], "@e3", "{verb}");
    }
    let fill = assert_action(&["fill", "@e1", "hello world"], "fill");
    assert_eq!((fill["selector"].as_str(), fill["value"].as_str()), (Some("@e1"), Some("hello world")));
    let typed = assert_action(&["type", "#q", "shoes"], "type");
    assert_eq!((typed["selector"].as_str(), typed["text"].as_str()), (Some("#q"), Some("shoes")));
    assert_eq!(assert_action(&["press", "Enter"], "press")["key"], "Enter");
    let select = assert_action(&["select", "@e4", "red"], "select");
    assert_eq!(select["selector"], "@e4");
    assert_eq!(select["values"], "red");
    assert_eq!(action(&["select", "@e4", "red", "blue"])["values"], serde_json::json!(["red", "blue"]));
    let upload = assert_action(&["upload", "@e5", "/tmp/a.pdf"], "upload");
    assert_eq!(upload["selector"], "@e5");
    assert_eq!(upload["files"], serde_json::json!(["/tmp/a.pdf"]));
}

#[test]
fn scroll_takes_a_direction_an_amount_and_a_selector() {
    let scroll = assert_action(&["scroll", "down", "300"], "scroll");
    assert_eq!((scroll["direction"].as_str(), scroll["amount"].as_i64()), (Some("down"), Some(300)), "{scroll}");
    for flag in ["-s", "--selector"] {
        assert_eq!(assert_action(&["scroll", "down", flag, "#list"], "scroll")["selector"], "#list", "{flag}");
    }
}

#[test]
fn every_get_the_node_allows_reads_what_it_names() {
    for (line, expected) in [
        (&["get", "text", "body"][..], "gettext"),
        (&["get", "html", "#main"], "innerhtml"),
        (&["get", "value", "#q"], "inputvalue"),
        (&["get", "attr", "#a", "href"], "getattribute"),
        (&["get", "url"], "url"),
        (&["get", "title"], "title"),
        (&["get", "count", "input[type=password]"], "count"),
        (&["get", "box", "#a"], "boundingbox"),
        (&["get", "styles", "#a"], "styles"),
    ] {
        assert_action(line, expected);
    }
    assert_eq!(action(&["get", "count", "input[type=password]"])["selector"], "input[type=password]");
    assert_eq!(action(&["get", "attr", "#a", "href"])["attribute"], "href");
}

#[test]
fn every_is_the_node_allows_asks_what_it_names() {
    for (word, expected) in [("visible", "isvisible"), ("enabled", "isenabled"), ("checked", "ischecked")] {
        assert_eq!(assert_action(&["is", word, "#a"], expected)["selector"], "#a", "{word}");
    }
}

#[test]
fn every_find_the_node_allows_finds_and_acts() {
    let role = assert_action(&["find", "role", "button", "click", "--name", "Sign in", "--exact"], "getbyrole");
    assert_eq!((role["role"].as_str(), role["name"].as_str(), role["exact"].as_bool()), (Some("button"), Some("Sign in"), Some(true)), "{role}");
    assert_eq!(role["subaction"], "click");
    for (by, expected) in [
        ("text", "getbytext"),
        ("label", "getbylabel"),
        ("placeholder", "getbyplaceholder"),
        ("alt", "getbyalttext"),
        ("title", "getbytitle"),
        ("testid", "getbytestid"),
    ] {
        assert_eq!(assert_action(&["find", by, "Email", "click"], expected)["subaction"], "click", "{by}");
    }
    for (by, expected) in [("first", "nth"), ("last", "nth")] {
        assert_action(&["find", by, ".item", "click"], expected);
    }
    assert_eq!(assert_action(&["find", "nth", "2", ".item", "click"], "nth")["index"], 2);
}

#[test]
fn every_wait_the_node_allows_waits_for_what_it_names() {
    assert_eq!(assert_action(&["wait", "500"], "wait")["timeout"], 500);
    assert_eq!(assert_action(&["wait", "--text", "Welcome"], "wait")["text"], "Welcome");
    assert_eq!(assert_action(&["wait", "--url", "**/done"], "waitforurl")["url"], "**/done");
    assert_eq!(assert_action(&["wait", "--load", "networkidle"], "waitforloadstate")["state"], "networkidle");
    let script = assert_action(&["wait", "--fn", "window.ready === true"], "waitforfunction");
    assert_eq!(script["expression"], "window.ready === true");
    assert_eq!(assert_action(&["wait", "--text", "Hi", "--timeout", "9000"], "wait")["timeout"], 9000);
}

#[test]
fn an_eval_with_the_nodes_timeout_runs_its_script_that_long() {
    // `browse.rs` moves `--timeout <ms>` right after `eval`, and puts in 30000 when the agent gave none.
    let eval = assert_action(&["eval", "--timeout", "30000", "document.title"], "evaluate");
    assert_eq!((eval["script"].as_str(), eval["timeout"].as_u64()), (Some("document.title"), Some(30000)), "{eval}");
    assert_eq!(assert_action(&["eval", "document.documentElement.outerHTML"], "evaluate")["script"], "document.documentElement.outerHTML");
}

#[test]
fn history_screenshot_close_and_frames_are_the_actions_the_node_expects() {
    for verb in ["back", "forward", "reload", "close"] {
        assert_action(&[verb], verb);
    }
    assert_action(&["screenshot"], "screenshot");
    assert_eq!(assert_action(&["screenshot", "--full"], "screenshot")["fullPage"], true);
    assert_eq!(assert_action(&["screenshot", "--annotate"], "screenshot")["annotate"], true);
    assert_eq!(assert_action(&["frame", "#checkout"], "frame")["selector"], "#checkout");
    assert_action(&["frame", "main"], "mainframe");
    // One agent's tab alone (`browse.rs` `tab close <tab>`).
    assert_action(&["tab", "close", "t2"], "tab_close");
}

#[test]
fn the_nodes_own_reads_of_cookies_and_calls_parse_as_json_requests() {
    let (flags, cookies) = parsed(&["--json", "cookies", "get"]);
    assert!(flags.json);
    assert_eq!(cookies["action"], "cookies_get");
    assert_action(&["--json", "network", "requests"], "requests");
    assert_eq!(assert_action(&["network", "requests", "--clear"], "requests")["clear"], true);
    assert_eq!(assert_action(&["--json", "network", "request", "1234.5"], "request_detail")["requestId"], "1234.5");
}

#[test]
fn a_tab_named_in_the_environment_rides_on_the_command() {
    let _guard = crate::test_utils::EnvGuard::new(&["AGENT_BROWSER_TAB"]);
    std::env::set_var("AGENT_BROWSER_TAB", "agent7");
    let (_, mut command) = parsed(&["get", "url"]);
    crate::attach_tab_to_command(&mut command);
    assert_eq!(command["tab"], "agent7");
}
