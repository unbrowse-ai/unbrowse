//! `agent-browser doctor --offline --quick`, held through the built binary against files and variables it reads.
//!
//! Owners run `doctor` when the node's browser won't start, so what it says about Chrome, stale daemons, config
//! files, the encryption key and providers is what they act on. No network, no Chrome launch: a fake installed
//! Chrome answers `--version`.

use super::*;
use std::os::unix::fs::PermissionsExt;

fn fake_chrome(home: &Path) {
    let dir = home.join(".agent-browser/browsers/chrome-999.0.0.0");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("chrome"),
        "#!/bin/sh\necho 'Google Chrome for Testing 999.0.0.0'\n",
    )
    .unwrap();
    std::fs::set_permissions(dir.join("chrome"), std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// `doctor <args> --json` with `env` added: the report and the exit code.
fn doctor(daemon: &Daemon, args: &[&str], env: &[(&str, &str)]) -> (Value, i32) {
    let mut command = daemon.command();
    command
        .args(["doctor", "--offline", "--quick", "--json"])
        .args(args);
    for (k, v) in env {
        command.env(k, v);
    }
    let output = command.output().unwrap();
    let report: Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|e| panic!("{e}: {}", text(&output)));
    (report, output.status.code().unwrap_or(-1))
}

fn check<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no check {id} in {report:#}"))
}

fn says(report: &Value, id: &str, status: &str, words: &str) {
    let c = check(report, id);
    assert_eq!(c["status"], status, "{id}: {c}");
    assert!(
        c["message"].as_str().unwrap_or_default().contains(words),
        "{id} wanted {words:?}: {c}"
    );
}

#[test]
fn doctor_names_the_installed_chrome_and_each_running_or_stale_daemon() {
    let daemon = Daemon::start();
    let home = daemon.home().to_path_buf();
    fake_chrome(&home);
    // A session whose process is gone, and the live stand-in whose version is not the CLI's.
    std::fs::write(home.join("s/gone.pid"), "999999999").unwrap();
    std::fs::write(home.join("s/gone.sock"), "").unwrap();
    std::fs::write(home.join("s/surface.version"), "0.0.1").unwrap();
    // A pid file that holds no pid, a socket with no pid file, and a dashboard whose process is gone.
    std::fs::write(home.join("s/garbled.pid"), "not a pid").unwrap();
    std::fs::write(home.join("s/orphan.sock"), "").unwrap();
    std::fs::write(home.join("s/dashboard.pid"), "999999999").unwrap();

    let (report, code) = doctor(&daemon, &[], &[]);
    assert_eq!(code, 0, "{report:#}");
    says(
        &report,
        "chrome.installed",
        "pass",
        "Google Chrome for Testing 999.0.0.0",
    );
    says(
        &report,
        "daemon.cleaned.gone",
        "warn",
        "Cleaned stale files: gone",
    );
    says(
        &report,
        "daemon.session.surface",
        "warn",
        "version mismatch with CLI",
    );
    assert_eq!(
        check(&report, "daemon.session.surface")["fix"],
        "agent-browser --session surface close"
    );
    assert!(
        !home.join("s/gone.pid").exists(),
        "the stale pid file is still there"
    );
    says(
        &report,
        "daemon.cleaned.garbled",
        "warn",
        "(unreadable pid file)",
    );
    says(
        &report,
        "daemon.cleaned.orphan",
        "warn",
        "(orphaned socket)",
    );
    says(
        &report,
        "daemon.cleaned.dashboard",
        "warn",
        "(process gone)",
    );
    assert!(!home.join("s/orphan.sock").exists() && !home.join("s/dashboard.pid").exists());
    assert_eq!(report["summary"]["fail"], 0);

    std::fs::write(home.join("s/surface.version"), env!("CARGO_PKG_VERSION")).unwrap();
    std::fs::write(home.join("s/dashboard.pid"), std::process::id().to_string()).unwrap();
    let (report, _) = doctor(&daemon, &[], &[]);
    says(
        &report,
        "daemon.session.surface",
        "pass",
        "Session surface (pid",
    );
    says(
        &report,
        "daemon.dashboard",
        "pass",
        "Dashboard server running (pid",
    );
}

#[test]
fn doctor_fails_a_config_file_that_is_not_json_and_a_key_or_policy_it_cannot_use() {
    let daemon = Daemon::start();
    let home = daemon.home().to_path_buf();
    fake_chrome(&home);
    std::fs::write(
        home.join(".agent-browser/config.json"),
        r#"{"headed": true}"#,
    )
    .unwrap();
    std::fs::write(home.join("work/agent-browser.json"), "{not json").unwrap();
    let policy = home.join("policy.json");
    std::fs::write(&policy, r#"{"default": "allow"}"#).unwrap();
    let missing = home.join("nowhere.json");
    let custom = home.join("custom.json");
    std::fs::write(&custom, "{}").unwrap();
    let (report, code) = doctor(
        &daemon,
        &[],
        &[
            ("AGENT_BROWSER_CONFIG", custom.to_str().unwrap()),
            ("AGENT_BROWSER_ENCRYPTION_KEY", "xyz"),
            ("AGENT_BROWSER_ACTION_POLICY", policy.to_str().unwrap()),
            ("AGENT_BROWSER_PROVIDER", "browserless"),
            ("BROWSERBASE_API_KEY", "k"),
            ("AWS_PROFILE", "p"),
            ("AI_GATEWAY_API_KEY", "k"),
        ],
    );
    assert_eq!(code, 1, "a failed check exits 1: {report:#}");
    assert_eq!(report["success"], false);
    says(&report, "config.user", "pass", "(valid JSON)");
    says(&report, "config.project", "fail", "agent-browser.json");
    assert_eq!(
        check(&report, "config.project")["fix"],
        "edit agent-browser.json"
    );
    says(&report, "config.custom", "pass", "custom.json");
    assert_eq!(check(&report, "security.encryption_key")["status"], "fail");
    says(&report, "security.action_policy", "pass", "Action policy:");
    assert_eq!(
        check(&report, "providers.browserless")["status"],
        "fail",
        "the active provider has no key"
    );
    says(
        &report,
        "providers.browserbase",
        "info",
        "Browserbase: API key present",
    );
    let agentcore = check(&report, "providers.agentcore")["message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        !agentcore.contains("no AWS credentials"),
        "AWS_PROFILE is set: {agentcore}"
    );
    says(&report, "providers.active", "info", "browserless");

    std::fs::write(&policy, "[oops").unwrap();
    let (report, _) = doctor(
        &daemon,
        &[],
        &[("AGENT_BROWSER_ACTION_POLICY", policy.to_str().unwrap())],
    );
    says(&report, "security.action_policy", "fail", "Action policy:");
    let (report, _) = doctor(
        &daemon,
        &[],
        &[("AGENT_BROWSER_ACTION_POLICY", missing.to_str().unwrap())],
    );
    assert_eq!(
        check(&report, "security.action_policy")["status"],
        "fail",
        "a policy file that is not there"
    );
    let (report, _) = doctor(
        &daemon,
        &[],
        &[("AGENT_BROWSER_ENCRYPTION_KEY", &"a".repeat(64))],
    );
    assert_eq!(check(&report, "security.encryption_key")["status"], "pass");
}

#[test]
fn doctor_fix_purges_expired_state_creates_the_key_and_closes_running_sessions() {
    let daemon = Daemon::start();
    let home = daemon.home().to_path_buf();
    fake_chrome(&home);
    let sessions = home.join(".agent-browser/sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    std::fs::write(sessions.join("a.json"), "{}").unwrap();
    std::fs::write(sessions.join("b.json"), "{}").unwrap();
    let key = home.join(".agent-browser/.encryption-key");
    std::fs::write(&key, "b".repeat(64)).unwrap();
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    let expired = [("AGENT_BROWSER_STATE_EXPIRE_DAYS", "0")];

    let (report, _) = doctor(&daemon, &[], &expired);
    says(
        &report,
        "security.encryption_key",
        "warn",
        "too permissive (644)",
    );
    assert_eq!(
        check(&report, "security.state_count")["status"],
        "warn",
        "{report:#}"
    );
    assert!(
        sessions.join("a.json").exists(),
        "doctor without --fix removed state"
    );

    std::fs::remove_file(&key).unwrap();
    std::fs::write(home.join("s/surface.version"), "0.0.1").unwrap();
    daemon.seen.lock().unwrap().clear();
    let (report, _) = doctor(&daemon, &["--fix"], &expired);
    let fixed = report["fixed"].to_string();
    assert!(
        !sessions.join("a.json").exists() && !sessions.join("b.json").exists(),
        "{fixed}"
    );
    let written = std::fs::read_to_string(&key).expect("--fix writes the missing key");
    assert!(written.trim().len() == 64 && written.trim().chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        std::fs::metadata(&key).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let closes = daemon
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c["action"] == "close")
        .count();
    assert_eq!(
        closes, 1,
        "--fix closes the version-mismatched session: {fixed}"
    );
    assert!(
        fixed.contains("Closed 1 version-mismatched daemon(s)"),
        "{fixed}"
    );
    assert!(report["fixed"].as_array().unwrap().len() >= 3, "{fixed}");
}

#[test]
fn doctor_without_json_prints_each_category_its_checks_and_their_fixes() {
    let daemon = Daemon::start();
    let home = daemon.home().to_path_buf();
    fake_chrome(&home);
    std::fs::write(home.join("work/agent-browser.json"), "{not json").unwrap();
    let output = daemon.run(&["doctor", "--offline", "--quick"], "");
    let out = String::from_utf8_lossy(&output.stdout);
    assert_eq!(output.status.code(), Some(1), "{out}");
    assert!(out.starts_with("agent-browser doctor\n"), "{out}");
    for category in ["Environment", "Chrome", "Daemons", "Security", "Providers"] {
        assert!(
            out.lines().any(|l| l == category),
            "no {category} heading:\n{out}"
        );
    }
    assert!(out.contains("Google Chrome for Testing 999.0.0.0"), "{out}");
    assert!(out.contains("fix: edit agent-browser.json"), "{out}");
}
