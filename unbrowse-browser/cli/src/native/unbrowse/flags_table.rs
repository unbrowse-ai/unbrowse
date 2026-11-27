//! Upstream's global flags, as this CLI parses them (no browser, no daemon).
//!
//! The node passes `--config`, `--session`, `--profile` and `--args`, but agents and owners use the rest, and an
//! upstream release that renames a flag's field, flips a `--no-` flag, or drops a check on a value fails here.

use crate::flags::{try_parse_flags, Flags};

fn parsed(argv: &[&str]) -> Flags {
    let args: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
    try_parse_flags(&args).unwrap_or_else(|e| panic!("{argv:?}: {e}"))
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn each_flag_that_takes_a_value_sets_its_field_and_marks_it_as_given_on_the_command_line() {
    let f = parsed(&[
        "--extension",
        "/x/a",
        "--extension",
        "/x/b",
        "--init-script",
        "i.js",
        "open",
    ]);
    assert_eq!(
        (f.extensions, f.cli_extensions),
        (strings(&["/x/a", "/x/b"]), true)
    );
    assert_eq!(
        (f.init_scripts, f.cli_init_scripts),
        (strings(&["i.js"]), true)
    );

    let f = parsed(&[
        "--enable",
        "react-devtools, ,webgpu",
        "--enable",
        "x",
        "open",
    ]);
    assert_eq!(
        (f.enable, f.cli_enable),
        (strings(&["react-devtools", "webgpu", "x"]), true)
    );

    let f = parsed(&[
        "--proxy",
        "http://p:1",
        "--proxy-bypass",
        "localhost",
        "open",
    ]);
    assert_eq!(
        (f.proxy.as_deref(), f.cli_proxy),
        (Some("http://p:1"), true)
    );
    assert_eq!(
        (f.proxy_bypass.as_deref(), f.cli_proxy_bypass),
        (Some("localhost"), true)
    );

    let f = parsed(&[
        "--device",
        "iPhone 16 Pro",
        "--session-name",
        "work",
        "--color-scheme",
        "dark",
        "open",
    ]);
    assert_eq!(f.device.as_deref(), Some("iPhone 16 Pro"));
    assert_eq!(f.session_name.as_deref(), Some("work"));
    assert_eq!(f.color_scheme.as_deref(), Some("dark"));

    let f = parsed(&[
        "--download-path",
        "/d",
        "--screenshot-dir",
        "/s",
        "--model",
        "m1",
        "--engine",
        "lightpanda",
        "open",
    ]);
    assert_eq!(
        (f.download_path.as_deref(), f.cli_download_path),
        (Some("/d"), true)
    );
    assert_eq!(f.screenshot_dir.as_deref(), Some("/s"));
    assert_eq!(f.model.as_deref(), Some("m1"));
    assert_eq!(f.engine.as_deref(), Some("lightpanda"));

    let f = parsed(&[
        "--action-policy",
        "/p/policy.json",
        "--confirm-actions",
        "eval,download",
        "open",
    ]);
    assert_eq!(f.action_policy.as_deref(), Some("/p/policy.json"));
    assert_eq!(f.confirm_actions.as_deref(), Some("eval,download"));

    let f = parsed(&[
        "--allowed-domains",
        "Example.COM, ,b.org",
        "--capture",
        " XHR,Fetch ,",
        "open",
    ]);
    assert_eq!(f.allowed_domains, Some(strings(&["example.com", "b.org"])));
    assert_eq!(f.capture, Some(strings(&["xhr", "fetch"])));

    let f = parsed(&["--restore=", "open"]);
    assert!(
        f.cli_restore && f.restore_uses_session,
        "--restore= restores the session's own state"
    );
    let f = parsed(&["--restore=saved-1", "open"]);
    assert_eq!(
        (f.restore.as_deref(), f.restore_uses_session),
        (Some("saved-1"), false)
    );
}

#[test]
fn a_flag_whose_value_is_out_of_range_keeps_its_default() {
    let f = parsed(&[
        "--max-output",
        "500",
        "--screenshot-quality",
        "80",
        "--screenshot-format",
        "jpeg",
        "open",
    ]);
    assert_eq!(f.max_output, Some(500));
    assert_eq!(f.screenshot_quality, Some(80));
    assert_eq!(f.screenshot_format.as_deref(), Some("jpeg"));
    assert_eq!(
        parsed(&["--input-mode", "human", "open"]).input_mode,
        "human"
    );
    assert!(parsed(&["--input-mode", "human", "open"]).cli_input_mode);

    let f = parsed(&[
        "--screenshot-quality",
        "101",
        "--screenshot-format",
        "gif",
        "--input-mode",
        "warp",
        "open",
    ]);
    assert_eq!(f.screenshot_quality, None, "quality above 100");
    assert_eq!(f.screenshot_format, None, "a format other than png or jpeg");
    assert!(
        !f.cli_input_mode && f.input_mode != "warp",
        "an input mode other than instant, smooth or human"
    );
    let f = parsed(&["--screenshot-quality", "high", "open"]);
    assert_eq!(f.screenshot_quality, None, "quality that is not a number");
}

#[test]
fn a_boolean_flag_takes_true_or_false_after_it_and_a_no_flag_turns_it_off() {
    let on = parsed(&[
        "--auto-connect",
        "--pin-tab",
        "--annotate",
        "--content-boundaries",
        "--confirm-interactive",
        "open",
    ]);
    assert!(on.auto_connect && on.cli_auto_connect && !on.no_auto_connect);
    assert!(on.pin_tab && on.cli_pin_tab);
    assert!(on.annotate && on.cli_annotate);
    assert!(on.content_boundaries && on.confirm_interactive);

    let off = parsed(&[
        "--auto-connect",
        "false",
        "--pin-tab",
        "false",
        "--annotate",
        "false",
        "--content-boundaries",
        "false",
        "--confirm-interactive",
        "false",
        "--no-auto-dialog",
        "false",
        "--relaunch",
        "false",
        "open",
    ]);
    assert!(
        !off.auto_connect && off.no_auto_connect,
        "--auto-connect false"
    );
    assert!(!off.pin_tab && off.cli_pin_tab, "--pin-tab false");
    assert!(!off.annotate && !off.content_boundaries && !off.confirm_interactive);
    assert!(!off.no_auto_dialog && !off.relaunch);

    let f = parsed(&[
        "--no-auto-connect",
        "--no-pin-tab",
        "--no-auto-dialog",
        "--relaunch",
        "true",
        "open",
    ]);
    assert!(!f.auto_connect && f.no_auto_connect, "--no-auto-connect");
    assert!(!f.pin_tab && f.cli_pin_tab, "--no-pin-tab");
    assert!(f.no_auto_dialog && f.relaunch);
    let f = parsed(&["--no-pin-tab", "false", "open"]);
    assert!(f.pin_tab, "--no-pin-tab false keeps the tab pinned");

    let f = parsed(&["-v", "-q", "open"]);
    assert!(f.verbose && f.quiet);
    let f = parsed(&["--verbose", "--quiet", "open"]);
    assert!(f.verbose && f.quiet);
}
