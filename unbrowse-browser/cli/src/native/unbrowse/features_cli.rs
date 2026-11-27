//! `agent-browser skills` and `agent-browser plugin`, held through the built binary.
//!
//! Neither command touches the daemon or the network, and the node never calls them, but both ship in the same
//! binary and agents are told to use them (`skills get core`, `plugin run`). These tests build the skills
//! directory and the plugins (small `/bin/sh` scripts) they read in a temp HOME, run the real binary, and hold
//! what the user sees: the listing, the files, the errors, the config `plugin add` writes, what a plugin is sent.

use super::*;
use std::os::unix::fs::PermissionsExt;

/// Run the CLI with extra environment, retrying when a script another test just wrote is still open for
/// writing in a forked child ("Text file busy").
fn cli(d: &Daemon, envs: &[(&str, &str)], args: &[&str]) -> Output {
    run_cli(|| d.command(), envs, args)
}

/// `cli` with a copy of the binary in the temp HOME. Without `AGENT_BROWSER_SKILLS_DIR`, `skills` looks for
/// `skill-data/` in every folder above the binary first, and a build inside a checkout finds the repo's own skills.
fn cli_outside_repo(d: &Daemon, envs: &[(&str, &str)], args: &[&str]) -> Output {
    let bin = d.home().join("bin/agent-browser");
    if !bin.exists() {
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::copy(env!("CARGO_BIN_EXE_agent-browser"), &bin).unwrap();
    }
    run_cli(
        || {
            let base = d.command();
            let mut command = Command::new(&bin);
            command.env_clear();
            for (k, v) in base.get_envs() {
                if let Some(v) = v {
                    command.env(k, v);
                }
            }
            command.current_dir(base.get_current_dir().unwrap());
            command
        },
        envs,
        args,
    )
}

/// Run a command, again while the program to run is still open for writing somewhere ("Text file busy"). Linux
/// refuses to start such a program, and a test copying a binary or writing a script makes one for a moment: any
/// other test thread that forks then holds the file's write handle until its child execs. The refusal comes back
/// either from starting the program itself (the copied binary: `ETXTBSY` from `output()`, which panicked here on
/// Coverage 45379266094 and 45386214277) or from inside the CLI when it runs a plugin script (its output says so).
fn run_cli(make: impl Fn() -> Command, envs: &[(&str, &str)], args: &[&str]) -> Output {
    for _ in 0..20 {
        let mut command = make();
        for (k, v) in envs {
            command.env(k, v);
        }
        match command.args(args).stdin(Stdio::null()).output() {
            Ok(out) if !text(&out).contains("Text file busy") => return out,
            Ok(_) => {}
            Err(e) if e.raw_os_error() == Some(libc::ETXTBSY) => {}
            Err(e) => panic!("could not run {args:?}: {e}"),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("Text file busy for {args:?}");
}

fn code(out: &Output) -> i32 {
    out.status.code().unwrap()
}

fn out_text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn err_text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn write(path: &Path, content: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

// ---------------------------------------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------------------------------------

const LONG: &str = "Core commands for driving the browser from an agent and a long description that runs past seventy characters";

/// A skills directory: `core` (long multi-line description, two references and two templates), `slack`,
/// a hidden `stub`, `dup` whose references collide on a stem, plus things that are not skills.
fn skills_dir(d: &Daemon) -> PathBuf {
    let dir = d.home().join("skills-fixture");
    write(
        &dir.join("core/SKILL.md"),
        "---\nname: core\ndescription: Core commands for driving the browser from an agent\n  and a long description that runs past seventy characters\n---\n\n# Core\n\nBody of core.\n",
    );
    write(
        &dir.join("core/references/commands.md"),
        "# Commands\nclick and fill\n",
    );
    write(&dir.join("core/references/auth.md"), "# Auth\nlogin flows");
    write(
        &dir.join("core/templates/form.sh"),
        "#!/bin/sh\necho form\n",
    );
    write(
        &dir.join("slack/SKILL.md"),
        "---\nname: slack\ndescription: Work in Slack\n---\nSlack body without trailing newline",
    );
    write(
        &dir.join("stub/SKILL.md"),
        "---\nname: stub\ndescription: Bootstrap stub\nhidden: true\n---\n\nRun skills get core.\n",
    );
    write(
        &dir.join("dup/SKILL.md"),
        "---\nname: dup\ndescription: Collisions\n---\n\n# Dup\n",
    );
    write(&dir.join("dup/references/auth.md"), "dup ref one\n");
    write(&dir.join("dup/templates/auth.sh"), "dup ref two\n");
    write(
        &dir.join("bare/SKILL.md"),
        "---\nname: bare\ndescription: No references\n---\n\n# Bare\n",
    );
    write(
        &dir.join("nofront/SKILL.md"),
        "# Just a heading\nno frontmatter\n",
    );
    write(
        &dir.join("nodesc/SKILL.md"),
        "---\nname: nodesc\n---\n\n# Nodesc\n",
    );
    write(&dir.join("not-a-skill/README.md"), "hi");
    write(&dir.join("loose-file.md"), "not a directory");
    dir
}

fn skills_outside_repo(d: &Daemon, dir: &Path, args: &[&str]) -> Output {
    let mut full = vec!["skills"];
    full.extend_from_slice(args);
    cli_outside_repo(
        d,
        &[("AGENT_BROWSER_SKILLS_DIR", dir.to_str().unwrap())],
        &full,
    )
}

fn skills(d: &Daemon, dir: &Path, args: &[&str]) -> Output {
    let mut full = vec!["skills"];
    full.extend_from_slice(args);
    cli(
        d,
        &[("AGENT_BROWSER_SKILLS_DIR", dir.to_str().unwrap())],
        &full,
    )
}

#[test]
fn skills_list_shows_visible_skills_sorted_aligned_and_truncated() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let out = skills(&d, &dir, &["list"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    // Widest name is "nodesc" (6): names are padded to it; the long description is cut at a word boundary.
    assert_eq!(
        out_text(&out),
        "  bare    No references\n  core    Core commands for driving the browser from an agent and a long...\n  dup     Collisions\n  nodesc  \n  slack   Work in Slack\n"
    );
    assert!(LONG.len() > 70);
}

#[test]
fn skills_without_a_subcommand_lists_and_the_json_form_carries_name_and_description() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let bare = skills(&d, &dir, &[]);
    let list = skills(&d, &dir, &["list"]);
    assert_eq!(out_text(&bare), out_text(&list));

    let json = stdout_json(&skills(&d, &dir, &["list", "--json"]));
    assert_eq!(json["success"], true);
    let names: Vec<&str> = json["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["bare", "core", "dup", "nodesc", "slack"]);
    // The JSON form carries the whole multi-line description, joined on one line.
    assert_eq!(json["data"][1]["description"], LONG);
    assert_eq!(json["data"][3]["description"], "");
}

#[test]
fn skills_list_of_an_empty_directory_says_so() {
    let d = Daemon::start();
    let dir = d.home().join("empty-skills");
    std::fs::create_dir_all(&dir).unwrap();
    let out = skills(&d, &dir, &["list"]);
    assert_eq!(code(&out), 0);
    assert_eq!(out_text(&out), "No skills found\n");
    assert_eq!(
        stdout_json(&skills(&d, &dir, &["list", "--json"])),
        json!({"success": true, "data": []})
    );
}

#[test]
fn skills_with_no_directory_anywhere_fails_telling_where_to_install_them() {
    let d = Daemon::start();
    let out = cli_outside_repo(&d, &[], &["skills", "list"]);
    assert_eq!(code(&out), 1);
    assert!(
        err_text(&out).contains("Skills directory not found. Install skills under ~/.agent-browser/ or set AGENT_BROWSER_SKILLS_DIR."),
        "{}",
        text(&out)
    );
    let json = cli_outside_repo(&d, &[], &["skills", "list", "--json"]);
    assert_eq!(code(&json), 1);
    assert_eq!(
        stdout_json(&json),
        json!({"success": false, "error": "Skills directory not found. Install skills under ~/.agent-browser/ or set AGENT_BROWSER_SKILLS_DIR."})
    );
}

#[test]
fn skills_env_dir_that_does_not_exist_is_ignored_for_the_home_install() {
    let d = Daemon::start();
    write(
        &d.home().join(".agent-browser/skill-data/homed/SKILL.md"),
        "---\nname: homed\ndescription: From home\n---\n",
    );
    write(
        &d.home().join(".agent-browser/skills/stubby/SKILL.md"),
        "---\nname: stubby\ndescription: A stub\nhidden: yes\n---\n",
    );
    let missing = d.home().join("nope");
    let out = skills_outside_repo(&d, &missing, &["list"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(out_text(&out), "  homed  From home\n");
    // Both directories of the install are searched, in order, and a hidden skill can still be fetched by name.
    let paths = skills_outside_repo(&d, &missing, &["path"]);
    let home = d.home().display();
    assert_eq!(
        out_text(&paths),
        format!("{home}/.agent-browser/skills\n{home}/.agent-browser/skill-data\n")
    );
    let stub = skills_outside_repo(&d, &missing, &["get", "stubby"]);
    assert!(out_text(&stub).contains("name: stubby"), "{}", text(&stub));
}

#[test]
fn skills_get_prints_the_skill_file_and_separates_several() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let one = skills(&d, &dir, &["get", "core"]);
    assert_eq!(code(&one), 0);
    assert_eq!(
        out_text(&one),
        "---\nname: core\ndescription: Core commands for driving the browser from an agent\n  and a long description that runs past seventy characters\n---\n\n# Core\n\nBody of core.\n"
    );
    // A file with no trailing newline gets one, and skills are separated by a rule.
    let two = skills(&d, &dir, &["get", "slack", "bare"]);
    assert_eq!(
        out_text(&two),
        "---\nname: slack\ndescription: Work in Slack\n---\nSlack body without trailing newline\n\n---\n\n---\nname: bare\ndescription: No references\n---\n\n# Bare\n"
    );
}

#[test]
fn skills_get_all_skips_hidden_skills_but_a_hidden_skill_is_fetchable_by_name() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let all = out_text(&skills(&d, &dir, &["get", "--all"]));
    for name in ["name: bare", "name: core", "name: dup", "name: slack"] {
        assert!(all.contains(name), "{name}: {all}");
    }
    assert!(!all.contains("name: stub"), "{all}");
    let stub = skills(&d, &dir, &["get", "stub"]);
    assert_eq!(code(&stub), 0);
    assert!(out_text(&stub).contains("Run skills get core."));
    // `get --all` ignores names; the hidden skill is not in `list` either.
    assert!(!out_text(&skills(&d, &dir, &["list"])).contains("stub"));
}

#[test]
fn skills_get_full_appends_every_reference_and_template_under_its_path() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let out = skills(&d, &dir, &["get", "core", "--full"]);
    assert_eq!(code(&out), 0);
    let body = out_text(&out);
    let tail = body.split("Body of core.\n").nth(1).unwrap();
    assert_eq!(
        tail,
        "\n--- references/auth.md ---\n\n# Auth\nlogin flows\n\n--- references/commands.md ---\n\n# Commands\nclick and fill\n\n--- templates/form.sh ---\n\n#!/bin/sh\necho form\n"
    );
    let json = stdout_json(&skills(&d, &dir, &["get", "core", "--full", "--json"]));
    let files: Vec<&str> = json["data"][0]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(
        files,
        [
            "references/auth.md",
            "references/commands.md",
            "templates/form.sh"
        ]
    );
    assert_eq!(
        json["data"][0]["files"][2]["content"],
        "#!/bin/sh\necho form\n"
    );
    // Without --full there is no files field, and a skill with no references has none even with it.
    let plain = stdout_json(&skills(&d, &dir, &["get", "core", "--json"]));
    assert!(plain["data"][0].get("files").is_none());
    assert!(plain["data"][0]["content"]
        .as_str()
        .unwrap()
        .contains("# Core"));
    let bare = stdout_json(&skills(&d, &dir, &["get", "bare", "--full", "--json"]));
    assert!(bare["data"][0].get("files").is_none());
}

#[test]
fn skills_get_ref_resolves_path_file_name_or_stem() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    for wanted in [
        "references/commands.md",
        "./references/commands.md",
        "commands.md",
        "commands",
    ] {
        let out = skills(&d, &dir, &["get", "core", "--ref", wanted]);
        assert_eq!(code(&out), 0, "{wanted}: {}", text(&out));
        assert_eq!(out_text(&out), "# Commands\nclick and fill\n", "{wanted}");
    }
    let inline = skills(&d, &dir, &["get", "core", "--ref=form"]);
    assert_eq!(out_text(&inline), "#!/bin/sh\necho form\n");
    // A reference file without a trailing newline gets one.
    assert_eq!(
        out_text(&skills(&d, &dir, &["get", "core", "--ref", "auth"])),
        "# Auth\nlogin flows\n"
    );
}

#[test]
fn skills_get_several_refs_prints_each_under_a_header_and_repeats_collapse() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let out = skills(
        &d,
        &dir,
        &[
            "get",
            "core",
            "--ref",
            "commands",
            "--ref=form.sh",
            "--ref",
            "commands.md",
        ],
    );
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        out_text(&out),
        "--- references/commands.md ---\n\n# Commands\nclick and fill\n\n--- templates/form.sh ---\n\n#!/bin/sh\necho form\n"
    );
    let json = stdout_json(&skills(
        &d,
        &dir,
        &["get", "core", "--ref", "commands", "--json"],
    ));
    assert_eq!(
        json,
        json!({"success": true, "data": [{"name": "core", "files": [
            {"path": "references/commands.md", "content": "# Commands\nclick and fill\n"}]}]})
    );
}

#[test]
fn skills_get_ref_errors_name_the_problem_and_what_is_available() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let missing = skills(&d, &dir, &["get", "core", "--ref", "nope"]);
    assert_eq!(code(&missing), 1);
    assert!(
        err_text(&missing).contains("Reference not found: nope. Available: references/auth.md, references/commands.md, templates/form.sh"),
        "{}",
        text(&missing)
    );
    let ambiguous = skills(&d, &dir, &["get", "dup", "--ref", "auth"]);
    assert_eq!(code(&ambiguous), 1);
    assert!(
        err_text(&ambiguous).contains(
            "Ambiguous reference auth: matches references/auth.md, templates/auth.sh. Available:"
        ),
        "{}",
        text(&ambiguous)
    );
    let none = skills(&d, &dir, &["get", "bare", "--ref", "x", "--json"]);
    assert_eq!(code(&none), 1);
    assert_eq!(
        stdout_json(&none),
        json!({"success": false, "error": "Reference not found: x. bare has no references"})
    );
    // A path that climbs out of the skill is never matched against the file system.
    let outside = skills(&d, &dir, &["get", "core", "--ref", "../SKILL.md"]);
    assert_eq!(code(&outside), 1);
    assert!(
        err_text(&outside).contains("Reference not found: ../SKILL.md"),
        "{}",
        text(&outside)
    );
}

#[test]
fn skills_get_ref_rejects_missing_value_and_combinations() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let novalue = skills(&d, &dir, &["get", "core", "--ref"]);
    assert_eq!(code(&novalue), 1);
    assert!(
        err_text(&novalue)
            .contains("--ref needs a value. Usage: agent-browser skills get <name> --ref <ref>"),
        "{}",
        text(&novalue)
    );
    let usage = "--ref needs exactly one skill name and cannot be combined with --all or --full. Usage: agent-browser skills get <name> --ref <ref>";
    for args in [
        vec!["get", "core", "--ref", "commands", "--full"],
        vec!["get", "--all", "--ref", "commands"],
        vec!["get", "core", "slack", "--ref", "commands"],
    ] {
        let out = skills(&d, &dir, &args);
        assert_eq!(code(&out), 1, "{args:?}");
        assert!(err_text(&out).contains(usage), "{args:?}: {}", text(&out));
    }
    let json = skills(
        &d,
        &dir,
        &["get", "core", "--full", "--ref", "commands", "--json"],
    );
    assert_eq!(
        stdout_json(&json),
        json!({"success": false, "error": usage})
    );
}

#[test]
fn skills_get_unknown_skill_or_no_name_fails_with_a_message() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let unknown = skills(&d, &dir, &["get", "core", "ghost"]);
    assert_eq!(code(&unknown), 1);
    assert!(
        err_text(&unknown).contains("Skill not found: ghost"),
        "{}",
        text(&unknown)
    );
    // Nothing is printed for the skills found before the missing one.
    assert_eq!(out_text(&unknown), "");
    let json = skills(&d, &dir, &["get", "ghost", "--json"]);
    assert_eq!(code(&json), 1);
    assert_eq!(
        stdout_json(&json),
        json!({"success": false, "error": "Skill not found: ghost"})
    );

    let none = skills(&d, &dir, &["get"]);
    assert_eq!(code(&none), 1);
    assert!(
        err_text(&none).contains("No skill name provided. Usage: agent-browser skills get <name>"),
        "{}",
        text(&none)
    );
    let none_json = skills(&d, &dir, &["get", "--json"]);
    assert_eq!(
        stdout_json(&none_json),
        json!({"success": false, "error": "No skill name provided. Usage: agent-browser skills get <name>"})
    );
}

#[test]
fn skills_get_ignores_an_unknown_flag_with_a_warning_and_still_serves_the_skill() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let out = skills(&d, &dir, &["get", "bare", "-z"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert!(
        err_text(&out).contains("Unknown flag ignored: -z"),
        "{}",
        text(&out)
    );
    assert!(out_text(&out).contains("# Bare"));
}

#[test]
fn skills_path_prints_the_skill_directory_or_the_search_directories() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let named = skills(&d, &dir, &["path", "core"]);
    assert_eq!(out_text(&named), format!("{}/core\n", dir.display()));
    let json = stdout_json(&skills(&d, &dir, &["path", "slack", "--json"]));
    assert_eq!(
        json,
        json!({"success": true, "data": {"name": "slack", "path": format!("{}/slack", dir.display())}})
    );
    let all = skills(&d, &dir, &["path"]);
    assert_eq!(out_text(&all), format!("{}\n", dir.display()));
    let all_json = stdout_json(&skills(&d, &dir, &["path", "--json"]));
    assert_eq!(
        all_json,
        json!({"success": true, "data": {"paths": [dir.display().to_string()]}})
    );
}

#[test]
fn skills_path_of_an_unknown_skill_and_unknown_subcommands_fail() {
    let d = Daemon::start();
    let dir = skills_dir(&d);
    let ghost = skills(&d, &dir, &["path", "ghost"]);
    assert_eq!(code(&ghost), 1);
    assert!(
        err_text(&ghost).contains("Skill not found: ghost"),
        "{}",
        text(&ghost)
    );
    let ghost_json = skills(&d, &dir, &["path", "ghost", "--json"]);
    assert_eq!(
        stdout_json(&ghost_json),
        json!({"success": false, "error": "Skill not found: ghost"})
    );

    let unknown = skills(&d, &dir, &["frobnicate"]);
    assert_eq!(code(&unknown), 1);
    assert!(
        err_text(&unknown).contains("Unknown skills subcommand: frobnicate"),
        "{}",
        text(&unknown)
    );
    let unknown_json = skills(&d, &dir, &["frobnicate", "--json"]);
    assert_eq!(
        stdout_json(&unknown_json),
        json!({"success": false, "error": "Unknown skills subcommand: frobnicate"})
    );
}

// ---------------------------------------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------------------------------------

const PROTOCOL: &str = "agent-browser.plugin.v1";

/// An executable `/bin/sh` script in the temp HOME.
fn script(d: &Daemon, name: &str, body: &str) -> PathBuf {
    let path = d.home().join("plugins-bin").join(name);
    write(&path, &format!("#!/bin/sh\n{body}\n"));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// A plugin that answers every request with its own request echoed back inside a successful response.
fn echo_plugin(d: &Daemon) -> PathBuf {
    script(
        d,
        "echo.sh",
        &format!("printf '{{\"protocol\":\"{PROTOCOL}\",\"success\":true,\"got\":%s}}' \"$(cat)\""),
    )
}

fn plugins_env(plugins: Value) -> String {
    plugins.to_string()
}

fn plugin(d: &Daemon, plugins: &Value, args: &[&str]) -> Output {
    let mut full = vec!["plugin"];
    full.extend_from_slice(args);
    cli(
        d,
        &[("AGENT_BROWSER_PLUGINS", &plugins_env(plugins.clone()))],
        &full,
    )
}

fn sample() -> Value {
    json!([
        {"name": "vault", "command": "old-vault", "capabilities": ["credential.read"]},
        {"name": "captcha", "command": "captcha-bin", "args": ["--fast", "-v"], "capabilities": ["captcha.solve", "command.run"]},
        {"name": "vault", "command": "new-vault", "capabilities": ["credential.read", "browser.provider"]},
        {"name": "bare", "command": "bare-bin"},
    ])
}

#[test]
fn plugin_list_prints_each_plugin_with_its_capabilities() {
    let d = Daemon::start();
    let out = plugin(&d, &sample(), &["list"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        out_text(&out),
        "vault  credential.read\ncaptcha  captcha.solve, command.run\nvault  credential.read, browser.provider\nbare  (no capabilities)\n"
    );
    // No subcommand means list; `plugins` is an alias.
    assert_eq!(out_text(&plugin(&d, &sample(), &[])), out_text(&out));
    let alias = cli(
        &d,
        &[("AGENT_BROWSER_PLUGINS", &sample().to_string())],
        &["plugins", "list"],
    );
    assert_eq!(out_text(&alias), out_text(&out));
}

#[test]
fn plugin_list_json_carries_the_configured_plugins_and_none_says_so() {
    let d = Daemon::start();
    let json = stdout_json(&plugin(
        &d,
        &json!([{"name": "a", "command": "a-bin", "args": ["x"], "capabilities": ["c.d"], "source": "npm:a"}]),
        &["list", "--json"],
    ));
    assert_eq!(
        json,
        json!({"plugins": [{"name": "a", "command": "a-bin", "args": ["x"], "capabilities": ["c.d"], "source": "npm:a"}]})
    );
    let none = cli(&d, &[], &["plugin", "list"]);
    assert_eq!(code(&none), 0);
    assert_eq!(out_text(&none), "No plugins configured\n");
    assert_eq!(
        stdout_json(&cli(&d, &[], &["plugin", "list", "--json"])),
        json!({"plugins": []})
    );
}

#[test]
fn plugin_show_prints_the_last_plugin_of_that_name() {
    let d = Daemon::start();
    let out = plugin(&d, &sample(), &["show", "vault"]);
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        out_text(&out),
        "Name: vault\nCommand: new-vault\nCapabilities: credential.read, browser.provider\n"
    );
    let captcha = plugin(&d, &sample(), &["show", "captcha"]);
    assert_eq!(
        out_text(&captcha),
        "Name: captcha\nCommand: captcha-bin\nArgs: --fast -v\nCapabilities: captcha.solve, command.run\n"
    );
    let bare = plugin(&d, &sample(), &["show", "bare"]);
    assert_eq!(
        out_text(&bare),
        "Name: bare\nCommand: bare-bin\nCapabilities: (none)\n"
    );
    let json = stdout_json(&plugin(&d, &sample(), &["show", "vault", "--json"]));
    assert_eq!(
        json,
        json!({"plugin": {"name": "vault", "command": "new-vault", "args": [], "capabilities": ["credential.read", "browser.provider"]}})
    );
}

#[test]
fn plugin_show_without_a_name_or_for_an_unknown_one_fails() {
    let d = Daemon::start();
    let noname = plugin(&d, &sample(), &["show"]);
    assert_eq!(code(&noname), 1);
    assert_eq!(err_text(&noname), "plugin show requires a plugin name\n");
    let ghost = plugin(&d, &sample(), &["show", "ghost"]);
    assert_eq!(code(&ghost), 1);
    assert_eq!(err_text(&ghost), "Plugin 'ghost' is not configured\n");
    let json = plugin(&d, &sample(), &["show", "ghost", "--json"]);
    assert_eq!(code(&json), 1);
    assert_eq!(
        stdout_json(&json),
        json!({"success": false, "error": "Plugin 'ghost' is not configured"})
    );
}

#[test]
fn plugin_unknown_subcommand_lists_the_valid_ones() {
    let d = Daemon::start();
    let out = plugin(&d, &json!([]), &["remove"]);
    assert_eq!(code(&out), 1);
    assert_eq!(
        err_text(&out),
        "Unknown plugin subcommand 'remove'. Valid options: add, list, show, run\n"
    );
    let json = plugin(&d, &json!([]), &["remove", "--json"]);
    assert_eq!(
        stdout_json(&json),
        json!({"success": false, "error": "Unknown plugin subcommand 'remove'. Valid options: add, list, show, run"})
    );
}

#[test]
fn plugin_run_sends_the_plugin_a_protocol_request_and_prints_its_reply() {
    let d = Daemon::start();
    let cmd = echo_plugin(&d);
    let plugins =
        json!([{"name": "echo", "command": cmd, "args": [], "capabilities": ["captcha.solve"]}]);

    // A request type the plugin declares is sent as its own capability.
    let out = plugin(
        &d,
        &plugins,
        &[
            "run",
            "echo",
            "captcha.solve",
            "--payload",
            r#"{"site":"example.com","n":3}"#,
        ],
    );
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        stdout_json(&out),
        json!({"protocol": PROTOCOL, "success": true, "got": {
            "protocol": PROTOCOL, "type": "captcha.solve", "capability": "captcha.solve",
            "request": {"site": "example.com", "n": 3}}})
    );
    // Any other type needs the plugin to declare command.run; without it the run is refused before it starts.
    let refused = plugin(&d, &plugins, &["run", "echo", "other.thing"]);
    assert_eq!(code(&refused), 1);
    assert_eq!(
        err_text(&refused),
        "Plugin 'echo' does not declare required capability 'command.run'\n"
    );

    let general = json!([{"name": "echo", "command": cmd, "capabilities": ["command.run"]}]);
    let ok = plugin(&d, &general, &["run", "echo", "other.thing"]);
    assert_eq!(code(&ok), 0, "{}", text(&ok));
    assert_eq!(
        stdout_json(&ok)["got"],
        json!({"protocol": PROTOCOL, "type": "other.thing", "capability": "command.run", "request": {}})
    );
}

#[test]
fn plugin_run_argument_errors_say_what_is_missing() {
    let d = Daemon::start();
    let cmd = echo_plugin(&d);
    let plugins = json!([{"name": "echo", "command": cmd, "capabilities": ["command.run"]}]);
    let cases: [(&[&str], &str); 7] = [
        (&["run"], "plugin run requires a plugin name"),
        (&["run", "echo"], "plugin run requires a request type"),
        (&["run", "echo", "x", "--payload"], "plugin run --payload requires JSON"),
        (&["run", "echo", "x", "--payload", "{nope"], "plugin run --payload is invalid JSON: "),
        (&["run", "echo", "x", "--bogus"], "unknown flag '--bogus' for plugin run"),
        (&["run", "ghost", "x"], "Plugin 'ghost' is not configured"),
        (&["run", "echo", "credential.resolve"], "plugin run cannot invoke core plugin entrypoint 'credential.resolve'; use the dedicated agent-browser command path"),
    ];
    for (args, expected) in cases {
        let out = plugin(&d, &plugins, args);
        assert_eq!(code(&out), 1, "{args:?}");
        assert!(
            err_text(&out).starts_with(expected),
            "{args:?}: {}",
            text(&out)
        );
    }
    let json = plugin(&d, &plugins, &["run", "echo", "browser.launch", "--json"]);
    assert_eq!(code(&json), 1);
    assert!(stdout_json(&json)["error"]
        .as_str()
        .unwrap()
        .contains("core plugin entrypoint 'browser.launch'"));
}

#[test]
fn plugin_run_reports_what_went_wrong_in_the_plugin() {
    let d = Daemon::start();
    let reply = |body: &str| {
        script(
            &d,
            &format!("r{}.sh", body.len()),
            &format!("cat >/dev/null\n{body}"),
        )
    };
    let cases: Vec<(PathBuf, &str)> = vec![
        (reply(&format!("echo '{{\"protocol\":\"{PROTOCOL}\",\"success\":false,\"error\":\"quota exceeded\"}}'")), "Plugin 'p' failed: quota exceeded"),
        (reply(&format!("echo '{{\"protocol\":\"{PROTOCOL}\"}}'")), "Plugin 'p' failed: plugin returned success=false"),
        (reply("echo '{\"protocol\":\"v0\",\"success\":true}'"), "Plugin 'p' used unsupported protocol 'v0'"),
        (reply("echo '{\"success\":true}'"), "Plugin 'p' used unsupported protocol ''"),
        (reply("echo 'not json at all'"), "Plugin 'p' returned invalid JSON"),
        (reply("exit 3"), "Plugin 'p' exited unsuccessfully"),
    ];
    for (command, expected) in cases {
        let plugins = json!([{"name": "p", "command": command, "capabilities": ["command.run"]}]);
        let out = plugin(&d, &plugins, &["run", "p", "do.it"]);
        assert_eq!(code(&out), 1, "{expected}");
        assert_eq!(err_text(&out), format!("{expected}\n"), "{expected}");
        assert_eq!(out_text(&out), "");
    }
    let plugins = json!([{"name": "p", "command": "/nonexistent/plugin-bin", "capabilities": ["command.run"]}]);
    let out = plugin(&d, &plugins, &["run", "p", "do.it", "--json"]);
    assert_eq!(code(&out), 1);
    let error = stdout_json(&out)["error"].as_str().unwrap().to_string();
    assert!(
        error.starts_with("Plugin 'p' failed to start")
            || error.starts_with("Failed to start plugin 'p': "),
        "{error}"
    );
    let missing_parts = json!([{"name": "q", "command": "", "capabilities": ["command.run"]}]);
    let out = plugin(&d, &missing_parts, &["run", "q", "do.it"]);
    assert_eq!(err_text(&out), "Plugin 'q' is missing a command\n");
}

// -- plugin add -------------------------------------------------------------------------------------------

fn global_config(d: &Daemon) -> PathBuf {
    d.home().join(".agent-browser/config.json")
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A fake `npx` first on PATH: reads the manifest request and answers with `reply` (a shell fragment).
fn fake_npx(d: &Daemon, body: &str) -> String {
    let dir = d.home().join("fakebin");
    let path = dir.join("npx");
    write(&path, &format!("#!/bin/sh\n{body}\n"));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    format!(
        "{}:{}",
        dir.display(),
        std::env::var("PATH").unwrap_or_default()
    )
}

#[test]
fn plugin_add_with_capabilities_writes_the_global_config_and_list_reads_it_back() {
    let d = Daemon::start();
    let out = cli(
        &d,
        &[],
        &[
            "plugin",
            "add",
            "@acme/agent-browser-plugin-vault@1.2.0",
            "--capability",
            "credential.read, browser.provider",
            "--no-manifest",
        ],
    );
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(
        out_text(&out),
        format!(
            "Added plugin 'vault'\nConfig: {}\nSource: npm:@acme/agent-browser-plugin-vault@1.2.0\nCommand: npx -y @acme/agent-browser-plugin-vault@1.2.0\nCapabilities: credential.read, browser.provider\n",
            global_config(&d).display()
        )
    );
    assert_eq!(
        read_json(&global_config(&d)),
        json!({"plugins": [{
            "name": "vault", "command": "npx", "args": ["-y", "@acme/agent-browser-plugin-vault@1.2.0"],
            "capabilities": ["credential.read", "browser.provider"], "source": "npm:@acme/agent-browser-plugin-vault@1.2.0"}]})
    );
    // The next invocation finds it through the same config file.
    let list = cli(&d, &[], &["plugin", "list"]);
    assert_eq!(
        out_text(&list),
        "vault  credential.read, browser.provider\n"
    );
}

#[test]
fn plugin_add_derives_the_name_from_the_reference_shape() {
    let d = Daemon::start();
    let cases = [
        (
            "agent-browser-plugin-captcha@2.0.1",
            "captcha",
            "npm:agent-browser-plugin-captcha@2.0.1",
            "agent-browser-plugin-captcha@2.0.1",
        ),
        (
            "plugin-stealth",
            "stealth",
            "npm:plugin-stealth",
            "plugin-stealth",
        ),
        (
            "acme/plugin-proxy",
            "proxy",
            "github:acme/plugin-proxy",
            "github:acme/plugin-proxy",
        ),
        (
            "./local/dir",
            "./local/dir",
            "npm:./local/dir",
            "./local/dir",
        ),
    ];
    for (reference, name, source, spec) in cases {
        let out = cli(
            &d,
            &[],
            &[
                "plugin",
                "add",
                reference,
                "--capabilities",
                "x.y",
                "--no-manifest",
                "--name",
                name,
                "--json",
            ],
        );
        assert_eq!(code(&out), 0, "{reference}: {}", text(&out));
        let json = stdout_json(&out);
        assert_eq!(json["success"], true);
        assert_eq!(json["plugin"]["source"], source, "{reference}");
        assert_eq!(json["plugin"]["args"], json!(["-y", spec]), "{reference}");
        assert_eq!(json["configPath"], global_config(&d).display().to_string());
    }
    // Without --name the derived name is used.
    let derived = cli(
        &d,
        &[],
        &[
            "plugin",
            "install",
            "acme/plugin-proxy",
            "--capability",
            "x.y",
            "--no-manifest",
            "--json",
        ],
    );
    assert_eq!(stdout_json(&derived)["plugin"]["name"], "proxy");
    let scoped = cli(
        &d,
        &[],
        &[
            "plugin",
            "add",
            "@acme/agent-browser-plugin-vault@1.0.0",
            "--capability",
            "x.y",
            "--no-manifest",
            "--json",
        ],
    );
    assert_eq!(stdout_json(&scoped)["plugin"]["name"], "vault");
    let plain = cli(
        &d,
        &[],
        &[
            "plugin",
            "add",
            "agent-browser-plugin-captcha@2.0.1",
            "--capability",
            "x.y",
            "--no-manifest",
            "--json",
        ],
    );
    assert_eq!(stdout_json(&plain)["plugin"]["name"], "captcha");
}

#[test]
fn plugin_add_replaces_a_same_named_plugin_and_keeps_the_rest_of_the_config() {
    let d = Daemon::start();
    write(
        &global_config(&d),
        r#"{"headed": true, "plugins": [{"name": "keep", "command": "k"}, {"name": "vault", "command": "old"}]}"#,
    );
    let out = cli(
        &d,
        &[],
        &[
            "plugin",
            "add",
            "acme/plugin-vault",
            "--capability",
            "credential.read",
            "--no-manifest",
        ],
    );
    assert_eq!(code(&out), 0, "{}", text(&out));
    let config = read_json(&global_config(&d));
    assert_eq!(config["headed"], true);
    let plugins = config["plugins"].as_array().unwrap();
    assert_eq!(plugins.len(), 2);
    assert_eq!(plugins[0]["name"], "keep");
    assert_eq!(plugins[1]["name"], "vault");
    assert_eq!(plugins[1]["source"], "github:acme/plugin-vault");
}

#[test]
fn plugin_add_project_scope_writes_agent_browser_json_in_the_working_directory() {
    let d = Daemon::start();
    let out = cli(
        &d,
        &[],
        &[
            "plugin",
            "add",
            "plugin-stealth",
            "--capability",
            "launch.mutate",
            "--no-manifest",
            "--project",
            "--json",
        ],
    );
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(stdout_json(&out)["configPath"], "agent-browser.json");
    let config = read_json(&d.home().join("work/agent-browser.json"));
    assert_eq!(config["plugins"][0]["name"], "stealth");
    assert_eq!(
        config["plugins"][0]["capabilities"],
        json!(["launch.mutate"])
    );
    assert!(!global_config(&d).exists());
}

#[test]
fn plugin_add_discovers_name_and_capabilities_from_the_plugins_manifest() {
    let d = Daemon::start();
    let path = fake_npx(
        &d,
        &format!("cat >/dev/null\necho '{{\"protocol\":\"{PROTOCOL}\",\"success\":true,\"manifest\":{{\"name\":\"vaulty\",\"capabilities\":[\"credential.read\"],\"description\":\"d\"}}}}'"),
    );
    let out = cli(
        &d,
        &[("PATH", &path)],
        &["plugin", "add", "acme/agent-browser-plugin-whatever"],
    );
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert!(
        out_text(&out).starts_with("Added plugin 'vaulty'\n"),
        "{}",
        text(&out)
    );
    assert!(
        out_text(&out).ends_with("Capabilities: credential.read\n"),
        "{}",
        text(&out)
    );

    // The manifest may come under `data`, and an explicit --name and --capability win over it.
    let path = fake_npx(
        &d,
        &format!("cat >/dev/null\necho '{{\"protocol\":\"{PROTOCOL}\",\"success\":true,\"data\":{{\"name\":\"from-data\",\"capabilities\":[\"a.b\"]}}}}'"),
    );
    let data = cli(
        &d,
        &[("PATH", &path)],
        &["plugin", "add", "some-pkg", "--json"],
    );
    assert_eq!(stdout_json(&data)["plugin"]["name"], "from-data");
    let named = cli(
        &d,
        &[("PATH", &path)],
        &[
            "plugin",
            "add",
            "some-pkg",
            "--name",
            "mine",
            "--capability",
            "z.z",
            "--json",
        ],
    );
    let named = stdout_json(&named);
    assert_eq!(named["plugin"]["name"], "mine");
    assert_eq!(named["plugin"]["capabilities"], json!(["z.z"]));
}

#[test]
fn plugin_add_manifest_failure_asks_for_capabilities_unless_they_were_given() {
    let d = Daemon::start();
    let broken = fake_npx(&d, "cat >/dev/null\nexit 1");
    let out = cli(&d, &[("PATH", &broken)], &["plugin", "add", "some-pkg"]);
    assert_eq!(code(&out), 1);
    assert_eq!(
        err_text(&out),
        "Plugin 'some-pkg' exited unsuccessfully. Rerun with --capability <name> to add the plugin without manifest discovery.\n"
    );
    assert!(!global_config(&d).exists());
    // With capabilities given the failed discovery is not fatal.
    let given = cli(
        &d,
        &[("PATH", &broken)],
        &["plugin", "add", "some-pkg", "--capability", "a.b", "--json"],
    );
    assert_eq!(code(&given), 0, "{}", text(&given));
    assert_eq!(
        stdout_json(&given)["plugin"]["capabilities"],
        json!(["a.b"])
    );

    // A manifest that declares nothing, and no --capability, is refused.
    let empty = fake_npx(&d, &format!("cat >/dev/null\necho '{{\"protocol\":\"{PROTOCOL}\",\"success\":true,\"manifest\":{{\"name\":\"x\"}}}}'"));
    let out = cli(&d, &[("PATH", &empty)], &["plugin", "add", "other-pkg"]);
    assert_eq!(code(&out), 1);
    assert_eq!(
        err_text(&out),
        "Plugin did not declare capabilities; rerun with --capability <name> or use a plugin that supports plugin.manifest\n"
    );
    // Manifest replies the protocol does not allow are named.
    let cases = [
        (
            format!("echo '{{\"protocol\":\"{PROTOCOL}\",\"success\":true}}'"),
            "Plugin 'p1-pkg' returned no manifest.",
        ),
        (
            format!(
                "echo '{{\"protocol\":\"{PROTOCOL}\",\"success\":true,\"manifest\":\"text\"}}'"
            ),
            "Plugin 'p2-pkg' returned invalid manifest JSON.",
        ),
        (
            "echo '{\"protocol\":\"old\",\"success\":true}'".to_string(),
            "Plugin 'p3-pkg' used unsupported protocol 'old'.",
        ),
        (
            format!("echo '{{\"protocol\":\"{PROTOCOL}\",\"success\":false,\"error\":\"no\"}}'"),
            "Plugin 'p4-pkg' failed: no.",
        ),
    ];
    for (i, (reply, expected)) in cases.iter().enumerate() {
        let path = fake_npx(&d, &format!("cat >/dev/null\n{reply}"));
        let out = cli(
            &d,
            &[("PATH", &path)],
            &["plugin", "add", &format!("p{}-pkg", i + 1)],
        );
        assert_eq!(code(&out), 1, "{expected}");
        assert!(
            err_text(&out).starts_with(expected),
            "{expected}: {}",
            text(&out)
        );
    }
}

#[test]
fn plugin_add_refuses_bad_arguments_with_a_reason() {
    let d = Daemon::start();
    let cases: [(&[&str], &str); 8] = [
        (
            &["add"],
            "plugin add requires a package or repository reference",
        ),
        (
            &["add", "pkg", "--name"],
            "plugin add --name requires a value",
        ),
        (
            &["add", "pkg", "--capability"],
            "plugin add --capability requires a value",
        ),
        (
            &["add", "pkg", "--capabilities"],
            "plugin add --capabilities requires a value",
        ),
        (
            &["add", "pkg", "--frob"],
            "unknown flag '--frob' for plugin add",
        ),
        (
            &["add", "pkg", "other"],
            "unexpected argument 'other' for plugin add",
        ),
        (
            &[
                "add",
                "pkg",
                "--no-manifest",
                "--capability",
                "a.b",
                "--name",
                "two words",
            ],
            "plugin name cannot contain whitespace or ':'",
        ),
        (
            &[
                "add",
                "pkg",
                "--no-manifest",
                "--capability",
                ",",
                "--name",
                "ok",
            ],
            "Plugin did not declare capabilities; rerun with --capability <name>",
        ),
    ];
    for (args, expected) in cases {
        let mut full = vec!["plugin"];
        full.extend_from_slice(args);
        let out = cli(&d, &[], &full);
        assert_eq!(code(&out), 1, "{args:?}");
        assert!(
            err_text(&out).starts_with(expected),
            "{args:?}: {}",
            text(&out)
        );
    }
    assert!(!global_config(&d).exists());
    let colon = cli(
        &d,
        &[],
        &[
            "plugin",
            "add",
            "pkg",
            "--no-manifest",
            "--capability",
            "a.b",
            "--name",
            "a:b",
            "--json",
        ],
    );
    assert_eq!(
        stdout_json(&colon),
        json!({"success": false, "error": "plugin name cannot contain whitespace or ':'"})
    );
}

#[test]
fn plugin_add_refuses_a_config_it_cannot_extend() {
    let d = Daemon::start();
    let add = [
        "plugin",
        "add",
        "pkg",
        "--no-manifest",
        "--capability",
        "a.b",
    ];
    let config = global_config(&d);
    // `plugin add` reads the default config path itself, so a broken file there is reported by add.
    write(&config, "{ not json");
    let out = cli(&d, &[], &add);
    assert_eq!(code(&out), 1);
    assert!(
        text(&out).contains(&format!("Config {} is invalid JSON", config.display())),
        "{}",
        text(&out)
    );

    write(&config, "[1, 2]");
    let out = cli(&d, &[], &add);
    assert_eq!(code(&out), 1);
    assert!(
        text(&out).contains(&format!(
            "Config {} must be a JSON object",
            config.display()
        )),
        "{}",
        text(&out)
    );

    write(&config, r#"{"plugins": "nope"}"#);
    let out = cli(&d, &[], &add);
    assert_eq!(code(&out), 1);
    assert!(
        text(&out).contains(&format!(
            "Config {} field 'plugins' must be an array",
            config.display()
        )),
        "{}",
        text(&out)
    );
}

/// A program still open for writing when it is run is run again once it is closed, not reported as a failure to
/// start. Linux refuses to start it (`ETXTBSY`); the race that made the refusal came from another test thread's fork,
/// and here the writer is held on purpose and closed after a moment, so the refusal comes every time on Linux.
#[test]
fn a_program_still_being_written_is_run_once_it_is_closed() {
    let dir = std::env::temp_dir().join(format!("busy-{}-{}", std::process::id(), line!()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("prog.sh");
    let mut writer = std::fs::File::create(&script).unwrap();
    std::io::Write::write_all(&mut writer, b"#!/bin/sh\necho ran\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let held = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        drop(writer);
    });
    let out = run_cli(|| Command::new(&script), &[], &[]);
    held.join().unwrap();
    assert_eq!(code(&out), 0, "{}", text(&out));
    assert_eq!(out_text(&out), "ran\n");
    let _ = std::fs::remove_dir_all(&dir);
}
