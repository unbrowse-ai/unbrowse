//! Upstream's command lines, as this CLI parses them (no browser, no daemon). `surface_cli.rs` runs the binary.
//!
//! Each line holds what upstream's parser makes of a command: the action and the fields the daemon reads, or,
//! for a line that is wrong, which error it names (the missing argument's context, the subcommand it doesn't
//! know, or what was wrong with a value). An upstream release that changes a command's wire form or its usage
//! errors fails here.

use serde_json::{json, Value};

use crate::commands::{parse_command, ParseError};
use crate::flags::{clean_args, parse_flags};

fn parse(line: &[&str]) -> Result<Value, ParseError> {
    // A config of its own, so no user or project config is read. Written once (the CLI exits on a config it
    // can't read, and tests run in parallel).
    static CONFIG: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    let config = CONFIG.get_or_init(|| {
        let path = std::env::temp_dir().join(format!("unbrowse-surface-{}-config.json", std::process::id()));
        std::fs::write(&path, "{}").unwrap();
        path
    });
    let mut argv = vec!["--config".to_string(), config.to_string_lossy().to_string()];
    argv.extend(line.iter().map(|s| s.to_string()));
    let flags = parse_flags(&argv);
    parse_command(&clean_args(&argv), &flags)
}

/// Whether `actual` holds every field of `expected` (objects compared field by field, all else equal).
fn holds(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e.iter().all(|(k, v)| a.get(k).is_some_and(|got| holds(got, v))),
        _ => actual == expected,
    }
}

/// What a wrong line must fail with: `missing:<context>`, `sub:<subcommand>`, `invalid:<words of the message>`.
fn error_is(error: &ParseError, want: &str) -> bool {
    match (error, want.split_once(':')) {
        (ParseError::MissingArguments { context, .. }, Some(("missing", c))) => context == c,
        (ParseError::UnknownSubcommand { subcommand, .. }, Some(("sub", s))) => subcommand == s,
        (ParseError::InvalidValue { message, .. }, Some(("invalid", m))) => message.contains(m),
        (ParseError::InvalidSessionName { name }, Some(("name", n))) => name == n,
        _ => false,
    }
}

fn describe(error: &ParseError) -> String {
    match error {
        ParseError::MissingArguments { context, .. } => format!("missing:{context}"),
        ParseError::UnknownSubcommand { subcommand, .. } => format!("sub:{subcommand}"),
        ParseError::InvalidValue { message, .. } => format!("invalid:{message}"),
        ParseError::InvalidSessionName { name } => format!("name:{name}"),
        ParseError::UnknownCommand { command } => format!("command:{command}"),
    }
}

/// Every wrong line fails with the error that names what is wrong, and its message carries the usage.
#[test]
fn a_wrong_command_line_names_what_is_missing_or_wrong() {
    let lines: &[(&[&str], &str)] = &[
        (&["click"], "missing:click"),
        (&["dblclick"], "missing:dblclick"),
        (&["fill"], "missing:fill"),
        (&["type"], "missing:type"),
        (&["type", "#q", "--delay"], "missing:type --delay"),
        (&["type", "#q", "--delay", "soon"], "invalid:--delay expects a number in ms, got 'soon'"),
        (&["hover"], "missing:hover"),
        (&["focus"], "missing:focus"),
        (&["check"], "missing:check"),
        (&["uncheck"], "missing:uncheck"),
        (&["select"], "missing:select"),
        (&["select", "#s"], "missing:select"),
        (&["drag"], "missing:drag"),
        (&["drag", "#a"], "missing:drag"),
        (&["upload"], "missing:upload"),
        (&["download"], "missing:download"),
        (&["download", "#d"], "missing:download"),
        (&["press"], "missing:press"),
        (&["keydown"], "missing:keydown"),
        (&["keyup"], "missing:keyup"),
        (&["keyboard"], "missing:keyboard"),
        (&["keyboard", "type"], "missing:keyboard type"),
        (&["keyboard", "inserttext"], "missing:keyboard inserttext"),
        (&["keyboard", "press", "a"], "sub:press"),
        (&["scrollintoview"], "missing:scrollintoview"),
        (&["wait", "--timeout"], "missing:wait --timeout"),
        (&["wait", "#a", "--timeout", "soon"], "invalid:--timeout expects a number in ms, got 'soon'"),
        (&["wait", "#a", "--state"], "missing:wait --state"),
        (&["wait", "--url"], "missing:wait --url"),
        (&["wait", "--fn"], "missing:wait --fn"),
        (&["wait", "--text"], "missing:wait --text"),
        (&["pdf"], "missing:pdf"),
        (&["eval", "--timeout", "soon", "1"], "invalid:--timeout takes milliseconds"),
        (&["eval", "-b", "/w=="], "invalid:Base64 decoded to invalid UTF-8"),
        (&["auth", "save"], "missing:auth save"),
        (&["auth", "save", "a"], "missing:auth save"),
        (&["auth", "save", "a", "--url", "https://a.test/"], "missing:auth save"),
        (&["auth", "save", "a", "--url", "https://a.test/", "--username", "u"], "missing:auth save"),
        (&["auth", "save", "a", "--bogus"], "invalid:unknown flag '--bogus' for auth save"),
        (&["auth", "login"], "missing:auth login"),
        (&["confirm"], "missing:confirm"),
        (&["deny"], "missing:deny"),
        (&["stream", "enable", "--port"], "missing:stream enable --port"),
        (&["stream", "pause"], "sub:pause"),
        (&["cookies", "set"], "missing:cookies set"),
        (&["cookies", "set", "--curl"], "missing:cookies set --curl"),
        (&["cookies", "set", "--curl", "/nonexistent/cookies.txt"], "invalid:cookies --curl: cannot read '/nonexistent/cookies.txt'"),
        (&["window"], "missing:window"),
        (&["window", "close"], "sub:close"),
        (&["frame"], "missing:frame"),
        (&["dialog"], "missing:dialog"),
        (&["dialog", "maybe"], "sub:maybe"),
        (&["trace"], "missing:trace"),
        (&["trace", "pause"], "sub:pause"),
        (&["highlight"], "missing:highlight"),
        (&["state"], "missing:state"),
        (&["state", "move"], "sub:move"),
        (&["state", "save"], "missing:state save"),
        (&["state", "load"], "missing:state load"),
        (&["state", "show"], "missing:state show"),
        (&["state", "clean"], "missing:state clean"),
        (&["state", "rename", "a"], "missing:state rename"),
        (&["state", "rename", "a b", "c"], "name:a b"),
        (&["state", "rename", "a", "c d"], "name:c d"),
        (&["state", "clear", "x y"], "name:x y"),
        (&["tap"], "missing:tap"),
        (&["swipe"], "missing:swipe"),
        (&["swipe", "sideways"], "invalid:Invalid swipe direction: sideways"),
        (&["device", "boot"], "sub:boot"),
        (&["pushstate"], "missing:pushstate"),
        (&["removeinitscript"], "missing:removeinitscript"),
        (&["flow"], "missing:flow"),
        (&["flow", "run"], "missing:flow run"),
        (&["flow", "run", "f", "--param", "x"], "invalid:Invalid --param 'x': expected name=value"),
        (&["flow", "run", "f", "--where", "x"], "invalid:Invalid --where 'x': expected field=value"),
        (&["flow", "run", "f", "--limit", "x"], "invalid:Invalid --limit 'x'"),
        (&["webmcp"], "missing:webmcp"),
        (&["webmcp", "invoke"], "missing:webmcp invoke"),
        (&["webmcp", "invoke", "t", "--params"], "missing:webmcp invoke --params"),
        (&["webmcp", "invoke", "t", "--frame"], "missing:webmcp invoke --frame"),
        (&["webmcp", "invoke", "t", "--timeout"], "missing:webmcp invoke --timeout"),
        (&["webmcp", "result"], "missing:webmcp result"),
        (&["webmcp", "result", "i", "--timeout"], "missing:webmcp result --timeout"),
        (&["webmcp", "result", "i", "--timeout", "x"], "invalid:--timeout expects a number in ms, got 'x'"),
        (&["webmcp", "cancel"], "missing:webmcp cancel"),
        (&["webmcp", "explode"], "sub:explode"),
        (&["read", "--llms"], "missing:read --llms"),
        (&["read", "--filter"], "missing:read --filter"),
        (&["read", "--timeout"], "missing:read --timeout"),
        (&["record", "start", "r.webm", "--contact-sheet-threshold"], "missing:record start --contact-sheet-threshold"),
        (&["react", "renders", "pause"], "sub:pause"),
        (&["get", "html"], "missing:get html"),
        (&["get", "value"], "missing:get value"),
        (&["get", "attr"], "missing:get attr"),
        (&["get", "attr", "a"], "missing:get attr"),
        (&["get", "count"], "missing:get count"),
        (&["get", "box"], "missing:get box"),
        (&["get", "styles"], "missing:get styles"),
        (&["is", "visible"], "missing:is visible"),
        (&["is", "enabled"], "missing:is enabled"),
        (&["is", "checked"], "missing:is checked"),
        (&["is", "hidden", "#a"], "sub:hidden"),
        (&["find"], "missing:find"),
        (&["find", "role"], "missing:find role"),
        (&["find", "nth"], "missing:find nth"),
        (&["find", "nth", "2"], "missing:find nth"),
        (&["find", "upwards", "x"], "sub:upwards"),
        (&["mouse", "move"], "missing:mouse move"),
        (&["mouse", "move", "1"], "missing:mouse move"),
        (&["mouse", "move", "1", "2", "--steps"], "missing:mouse move --steps"),
        (&["mouse", "move", "1", "2", "--steps", "x"], "invalid:--steps expects a non-negative integer, got 'x'"),
        (&["mouse", "jump"], "sub:jump"),
        (&["set", "viewport"], "missing:set viewport"),
        (&["set", "viewport", "800"], "missing:set viewport"),
        (&["set", "device"], "missing:set device"),
        (&["set", "geo"], "missing:set geo"),
        (&["set", "geo", "1"], "missing:set geo"),
        (&["set", "headers"], "missing:set headers"),
        (&["set", "credentials"], "missing:set credentials"),
        (&["set", "credentials", "u"], "missing:set credentials"),
        (&["set", "nothing"], "sub:nothing"),
        (&["network", "route"], "missing:network route"),
        (&["network", "har", "pause"], "sub:pause"),
        (&["network", "bogus"], "sub:bogus"),
        (&["storage", "local", "set"], "missing:storage local set"),
        (&["diff", "screenshot"], "missing:diff screenshot"),
        (&["diff", "snapshot", "--depth"], "missing:diff snapshot --depth"),
        (&["diff", "snapshot", "--depth", "x"], "invalid:x"),
    ];
    let mut wrong = Vec::new();
    for (line, want) in lines {
        match parse(line) {
            Ok(command) => wrong.push(format!("{line:?} parsed to {command}, wanted {want}")),
            Err(error) if !error_is(&error, want) => wrong.push(format!("{line:?}: {} ({}), wanted {want}", describe(&error), error.format())),
            Err(error) => {
                if let ParseError::MissingArguments { usage, .. } | ParseError::InvalidValue { usage, .. } = &error {
                    if !error.format().contains(usage) {
                        wrong.push(format!("{line:?}: the message doesn't carry the usage: {}", error.format()));
                    }
                }
            }
        }
    }
    assert!(wrong.is_empty(), "{} wrong:\n{}", wrong.len(), wrong.join("\n"));
}

/// Command lines that MCP has no tool for parse into the action and fields the daemon reads.
#[test]
fn a_command_line_with_no_mcp_tool_parses_into_what_the_daemon_reads() {
    let lines: &[(&[&str], Value)] = &[
        (&["click", "#a", "--new-tab"], json!({"action": "click", "selector": "#a", "newTab": true})),
        (&["key", "Enter"], json!({"action": "press", "key": "Enter"})),
        (&["keyboard", "insertText", "x y"], json!({"action": "keyboard", "subaction": "insertText", "text": "x y"})),
        (&["eval", "-b", "MSsx"], json!({"action": "evaluate", "script": "1+1"})),
        (&["auth", "list"], json!({"action": "auth_list"})),
        (&["auth", "show", "acct"], json!({"action": "auth_show", "name": "acct"})),
        (&["auth", "delete", "acct"], json!({"action": "auth_delete", "name": "acct"})),
        (&["auth", "save", "acct", "--url", "https://a.test/", "--username", "u", "--password", "p"],
         json!({"action": "auth_save", "name": "acct", "url": "https://a.test/", "username": "u", "password": "p"})),
        (&["window", "new"], json!({"action": "window_new"})),
        (&["frame", "main"], json!({"action": "mainframe"})),
        (&["dialog", "dismiss", "no"], json!({"action": "dialog", "response": "dismiss", "promptText": "no"})),
        (&["trace", "stop"], json!({"action": "trace_stop"})),
        (&["state", "save", "s.json"], json!({"action": "state_save", "path": "s.json"})),
        (&["state", "load", "s.json"], json!({"action": "state_load", "path": "s.json"})),
        (&["state", "list"], json!({"action": "state_list"})),
        (&["state", "clear", "--all"], json!({"action": "state_clear", "all": true})),
        (&["state", "clear", "myapp"], json!({"action": "state_clear", "sessionName": "myapp"})),
        (&["state", "show", "myapp-default.json"], json!({"action": "state_show", "path": "myapp-default.json"})),
        (&["state", "clean", "--older-than", "7"], json!({"action": "state_clean", "days": 7})),
        (&["state", "rename", "old.json", "new"], json!({"action": "state_rename", "oldName": "old", "newName": "new"})),
        (&["device"], json!({"action": "device_list"})),
        (&["swipe", "left"], json!({"action": "swipe", "direction": "left"})),
        (&["react", "tree", "--raw-json"], json!({"action": "react_tree", "json": true})),
        (&["flow", "list"], json!({"action": "flow_list"})),
        (&["read", "https://a.test/"], json!({"action": "read", "url": "https://a.test/"})),
        (&["mouse", "down"], json!({"action": "mousedown"})),
        (&["mouse", "up", "middle"], json!({"action": "mouseup", "button": "middle"})),
        (&["set", "offline"], json!({"action": "offline", "offline": true})),
        (&["set", "media", "light", "no-preference"], json!({"action": "emulatemedia", "colorScheme": "light"})),
        (&["network", "unroute", "**/x"], json!({"action": "unroute", "url": "**/x"})),
        (&["network", "unroute"], json!({"action": "unroute"})),
        (&["find", "text", "Sign in"], json!({"action": "getbytext", "text": "Sign in"})),
        (&["find", "placeholder", "Search", "fill", "q"], json!({"action": "getbyplaceholder", "placeholder": "Search", "value": "q"})),
        (&["find", "title", "Help", "hover"], json!({"action": "getbytitle", "text": "Help"})),
        (&["find", "first", ".row", "click"], json!({"action": "nth", "selector": ".row", "index": 0})),
        (&["find", "last", ".row", "fill", "z"], json!({"action": "nth", "selector": ".row", "index": -1, "value": "z"})),
        (&["find", "nth", "1", ".row", "fill", "a", "b"], json!({"action": "nth", "selector": ".row", "index": 1, "value": "a b"})),
        (&["get", "title"], json!({"action": "title"})),
    ];
    let mut wrong = Vec::new();
    for (line, want) in lines {
        match parse(line) {
            Ok(command) if holds(&command, want) => {}
            Ok(command) => wrong.push(format!("{line:?} parsed to {command}, wanted at least {want}")),
            Err(error) => wrong.push(format!("{line:?} failed: {}", error.format())),
        }
    }
    assert!(wrong.is_empty(), "{} wrong:\n{}", wrong.len(), wrong.join("\n"));
}
