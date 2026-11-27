//! `connect`'s moves when each step can fail: the plan's words for every kind of entry, what is said when Claude Code
//! refuses a step, what `--undo` does with what is no longer there, and the machine's own `claude` and entry program.

use super::*;
use crate::legacy::tests::{home, machine, Home};

const BASE: &str = "http://127.0.0.1:7788";

/// Claude Code that keeps every command it was given, and refuses any whose words hold one of `fail`.
struct Script {
    lines: Vec<String>,
    cwds: Vec<Option<PathBuf>>,
    fail: Vec<&'static str>,
    tools: Result<usize, String>,
}

impl Script {
    fn new() -> Script {
        Script { lines: Vec::new(), cwds: Vec::new(), fail: Vec::new(), tools: Ok(9) }
    }
    fn failing(words: &[&'static str]) -> Script {
        Script { fail: words.to_vec(), ..Script::new() }
    }
}

impl Hosts for Script {
    fn claude(&mut self, args: &[String], cwd: Option<&Path>) -> Result<(), String> {
        let line = args.join(" ");
        self.lines.push(line.clone());
        self.cwds.push(cwd.map(Path::to_path_buf));
        if self.fail.iter().any(|w| line.contains(w)) { Err("refused".into()) } else { Ok(()) }
    }
    fn verify(&mut self, _: &Value) -> Result<usize, String> {
        self.tools.clone()
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn ours() -> Value {
    entry(BASE, None, Path::new("/x/unb"))
}

fn plan_in(h: &Home) -> Plan {
    Plan::new(machine(h), ours(), h.0.join("migration").join("T1"))
}

fn hosted() -> Value {
    json!({ "type": "http", "url": "https://unbrowse.ai/mcp" })
}

fn mine() -> Value {
    json!({ "type": "stdio", "command": "/x/unb", "args": ["mcp", "--agent", "first"], "env": { "UNBROWSE_NODE": BASE } })
}

fn run(plan: &Plan, hosts: &mut Script) -> (Result<(), String>, String) {
    let mut out = Vec::new();
    let r = apply(plan, hosts, &mut out);
    (r, String::from_utf8(out).unwrap())
}

#[test]
fn the_plan_says_what_each_kind_of_entry_gets_and_what_it_could_not_read() {
    let h = home("cov-plan");
    let proj = h.0.join("work/app");
    write(&proj.join(".mcp.json"), &json!({ "mcpServers": { "unbrowse": hosted() } }).to_string());
    write(
        &h.0.join(".claude.json"),
        &json!({
            "mcpServers": {
                "unbrowse-2": { "command": "/x/unb", "args": ["mcp", "--agent", "2"] },
                "unbrowse-fork": { "command": "my-own", "args": ["serve"] },
            },
            "projects": { proj.display().to_string(): { "mcpServers": { "unbrowse": hosted() } } }
        })
        .to_string(),
    );
    write(&h.0.join(".cursor/mcp.json"), &json!({ "mcpServers": { "unbrowse": hosted(), "unbrowse-old": { "command": "my-own" } } }).to_string());
    let plugin = h.0.join("cache/unbrowse");
    write(&h.0.join(".claude/plugins/installed_plugins.json"), &json!({ "plugins": { "unbrowse@theirs": [{ "scope": "user", "installPath": plugin }] } }).to_string());
    write(&h.0.join(".codex/config.toml"), "[mcp_servers.unbrowse\n");
    let plan = plan_in(&h);
    let text = plan.text();
    let said = |name: &str, host: &str| -> Vec<String> { text.lines().filter(|l| l.starts_with(&format!("  {host:<14}{name:<18}"))).map(String::from).collect() };
    let one = |name: &str, host: &str| -> String {
        let all = said(name, host);
        assert_eq!(all.len(), 1, "one line for {host} {name} in:\n{text}");
        all[0].clone()
    };
    assert!(said("unbrowse", "Claude Code").iter().any(|l| l.contains("will be replaced (project ")), "{text}");
    assert!(said("unbrowse", "Claude Code").iter().any(|l| l.contains("you edit: remove \"unbrowse\" from ") && l.contains(".mcp.json")), "a project's checked-in file is the owner's to edit:\n{text}");
    assert!(one("unbrowse-2", "Claude Code").contains("left as is"), "another agent's entry stays");
    assert!(one("unbrowse-fork", "Claude Code").contains("claude mcp remove --scope user unbrowse-fork"), "{text}");
    assert!(one("unbrowse", "Cursor").contains("you edit: replace \"unbrowse\" in ") && one("unbrowse", "Cursor").contains("\"command\":\"unbrowse\""), "{text}");
    assert!(one("unbrowse-old", "Cursor").contains("remove \"unbrowse-old\" from "), "{text}");
    assert!(one("unbrowse@theirs", "Claude plugin").contains("claude plugin uninstall unbrowse@theirs --scope user"), "{text}");
    assert!(text.contains("Couldn't read: ") && text.contains("config.toml isn't TOML this could read"), "{text}");
    assert!(plan.changes(), "the local entry is replaced");
    assert!(plan.action(plan.found.iter().find(|f| f.name == "unbrowse-2").unwrap()) == Action::Keep);
}

#[test]
fn a_codex_entry_from_the_hosted_client_is_the_owners_to_edit_with_the_agent_named() {
    let h = home("cov-codex-edit");
    write(&h.0.join(".codex/config.toml"), "[mcp_servers.unbrowse]\ncommand = \"npx\"\nargs = [\"-y\", \"unbrowse@12\", \"mcp\"]\n");
    let plan = Plan::new(machine(&h), entry(BASE, Some(3), Path::new("/x/unb")), h.0.join("migration/T1"));
    let f = plan.found.iter().find(|f| f.host == Host::Codex).unwrap();
    let Action::YouEdit(e) = plan.action(f) else { panic!("codex is the owner's to edit") };
    assert!(e.contains("[mcp_servers.unbrowse]") && e.contains("\"--agent\", \"3\""), "{e}");
    assert!(!plan.changes(), "nothing here replaces or uninstalls");
}

#[test]
fn a_step_claude_code_refuses_before_anything_was_removed_leaves_the_old_entries_and_says_so() {
    let h = home("cov-add-refused");
    write(&h.0.join(".claude.json"), &json!({ "mcpServers": { "unbrowse": hosted() } }).to_string());
    let plan = plan_in(&h);
    let mut hosts = Script::failing(&["add --scope user unbrowse-next"]);
    let (r, _) = run(&plan, &mut hosts);
    let e = r.unwrap_err();
    assert!(e.contains("Claude Code didn't take the new entry (refused)") && e.contains("your old Unbrowse still works"), "{e}");
    assert!(!hosts.lines.iter().any(|l| l.starts_with("mcp remove")), "nothing was removed: {:?}", hosts.lines);
    assert!(h.0.join("migration/T1/entries.json").exists(), "the backup was kept first");
}

#[test]
fn an_entry_named_unbrowse_that_is_not_ours_keeps_the_name_and_the_new_one_is_told_as_unbrowse_next() {
    let h = home("cov-name-taken");
    write(&h.0.join(".claude.json"), &json!({ "mcpServers": { "unbrowse": { "command": "my-own", "args": ["serve"] } } }).to_string());
    let plan = plan_in(&h);
    let mut hosts = Script::new();
    let (r, out) = run(&plan, &mut hosts);
    assert!(r.unwrap_err().contains("Some old entries are still there"));
    assert!(out.contains("! Claude Code: your node is set up as \"unbrowse-next\": the name unbrowse is still taken"), "{out}");
    assert!(out.contains("✓ Claude Code: unbrowse-next → your node (checked: 9 tools)"), "{out}");
    assert!(!hosts.lines.iter().any(|l| l.contains("add --scope user unbrowse ")), "the name wasn't taken: {:?}", hosts.lines);
}

#[test]
fn an_old_plugin_that_will_not_uninstall_is_named_with_the_command_that_removes_it() {
    let h = home("cov-plugin-refused");
    let plugin = h.0.join("cache/unbrowse");
    write(&plugin.join(".mcp.json"), &json!({ "mcpServers": { "unbrowse": hosted() } }).to_string());
    write(&h.0.join(".claude/plugins/installed_plugins.json"), &json!({ "plugins": { "unbrowse@unbrowse": [{ "scope": "user", "installPath": plugin }] } }).to_string());
    let plan = plan_in(&h);
    let (r, out) = run(&plan, &mut Script::failing(&["plugin uninstall"]));
    assert!(r.is_err());
    assert!(out.contains("! Claude plugin: couldn't uninstall unbrowse@unbrowse (refused); run: claude plugin uninstall unbrowse@unbrowse"), "{out}");
}

#[test]
fn an_old_plugin_alone_is_uninstalled_and_the_report_says_the_plugin_not_an_entry() {
    let h = home("cov-plugin-only");
    let plugin = h.0.join("cache/unbrowse");
    write(&plugin.join(".mcp.json"), &json!({ "mcpServers": { "unbrowse": hosted() } }).to_string());
    write(&h.0.join(".claude/plugins/installed_plugins.json"), &json!({ "plugins": { "unbrowse@unbrowse": [{ "scope": "user", "installPath": plugin }] } }).to_string());
    let plan = plan_in(&h);
    let mut hosts = Script::new();
    let (r, out) = run(&plan, &mut hosts);
    r.unwrap();
    assert!(out.contains("✓ Uninstalled the old plugin."), "{out}");
    assert!(hosts.lines.contains(&"plugin uninstall unbrowse@unbrowse --scope user".to_string()), "{:?}", hosts.lines);
}

#[test]
fn the_temporary_name_that_will_not_go_is_told_as_the_same_as_unbrowse() {
    let h = home("cov-temp-stays");
    write(&h.0.join(".claude.json"), &json!({ "mcpServers": {} }).to_string());
    let plan = plan_in(&h);
    let (r, out) = run(&plan, &mut Script::failing(&["remove --scope user unbrowse-next"]));
    assert!(r.is_err());
    assert!(out.contains("couldn't remove the temporary unbrowse-next (refused); it is the same as unbrowse"), "{out}");
    assert!(out.contains("✓ Claude Code: unbrowse → your node"), "unbrowse itself was added: {out}");
}

#[test]
fn a_node_already_set_up_still_has_its_old_local_entries_replaced() {
    let h = home("cov-already-and-old");
    let proj = h.0.join("work/app");
    std::fs::create_dir_all(&proj).unwrap();
    write(
        &h.0.join(".claude.json"),
        &json!({ "mcpServers": { "unbrowse": mine() }, "projects": { proj.display().to_string(): { "mcpServers": { "unbrowse": hosted() } } } }).to_string(),
    );
    let plan = plan_in(&h);
    let mut hosts = Script::new();
    let (r, out) = run(&plan, &mut hosts);
    r.unwrap();
    assert!(out.contains("✓ Claude Code: unbrowse → your node (checked: 9 tools)") && out.contains("✓ Removed 1 old entry."), "{out}");
    assert!(!hosts.lines.iter().any(|l| l.starts_with("mcp add")), "the entry that was right wasn't added again: {:?}", hosts.lines);
    assert_eq!(hosts.cwds[0].as_deref(), Some(proj.as_path()), "a local entry is removed from its own project");
}

#[test]
fn an_earlier_temporary_entry_that_will_not_go_or_is_not_ours_stops_the_run_before_any_change() {
    let h = home("cov-temp-before");
    write(&h.0.join(".claude.json"), &json!({ "mcpServers": { "unbrowse-next": hosted() } }).to_string());
    let (r, _) = run(&plan_in(&h), &mut Script::failing(&["remove --scope user unbrowse-next"]));
    assert!(r.unwrap_err().contains("Couldn't remove the earlier unbrowse-next"));
    write(&h.0.join(".claude.json"), &json!({ "mcpServers": { "unbrowse-next": { "command": "my-own" } } }).to_string());
    let mut hosts = Script::new();
    let (r, _) = run(&plan_in(&h), &mut hosts);
    assert!(r.unwrap_err().contains("that isn't Unbrowse's is in the way"));
    assert!(hosts.lines.is_empty(), "nothing was run: {:?}", hosts.lines);
}

#[test]
fn a_new_entry_that_does_not_answer_changes_nothing() {
    let h = home("cov-no-answer");
    let mut hosts = Script::new();
    hosts.tools = Err("no answer in 90s".into());
    let (r, _) = run(&plan_in(&h), &mut hosts);
    assert!(r.unwrap_err().contains("The new entry didn't answer (no answer in 90s)"));
    assert!(hosts.lines.is_empty());
}

fn record(h: &Home, name: &str, rec: &Value) -> PathBuf {
    let root = h.0.join("migration");
    write(&root.join(name).join("entries.json"), &rec.to_string());
    root
}

#[test]
fn an_undo_with_nothing_to_undo_or_a_time_with_no_backup_says_where_it_looked() {
    let h = home("cov-undo-none");
    let m = machine(&h);
    let root = h.0.join("migration");
    let mut out = Vec::new();
    let e = undo(&m, &root, None, false, &mut Script::new(), &mut out).unwrap_err();
    assert!(e.starts_with("There is no backup in "), "{e}");
    let e = undo(&m, &root, Some("2026-01-01T00-00-00Z"), false, &mut Script::new(), &mut out).unwrap_err();
    assert!(e.contains("has no backup to undo (see `ls "), "{e}");
}

#[test]
fn an_undo_that_claude_refuses_names_each_thing_it_could_not_put_back_and_keeps_the_backup() {
    let h = home("cov-undo-refused");
    let m = machine(&h);
    write(&h.0.join(".claude.json"), &json!({ "mcpServers": { "unbrowse": mine() } }).to_string());
    let gone = h.0.join("work/gone");
    let root = record(
        &h,
        "T1",
        &json!({
            "version": 1,
            "added": ["unbrowse"],
            "replaced": [
                { "scope": "user", "name": "unbrowse", "project": null, "raw": hosted() },
                { "scope": "local", "name": "unbrowse", "project": gone.display().to_string(), "raw": hosted() }
            ],
            "plugins": [{ "name": "unbrowse@unbrowse", "scope": "user" }]
        }),
    );
    let mut hosts = Script::failing(&["mcp remove", "add-json", "plugin install"]);
    let mut out = Vec::new();
    let r = undo(&m, &root, Some("T1"), true, &mut hosts, &mut out);
    assert_eq!(r.unwrap_err(), "Not everything was put back; each is named above.");
    let said = String::from_utf8(out).unwrap();
    assert!(said.contains("! couldn't remove unbrowse (refused)"), "{said}");
    assert!(said.contains("! \"unbrowse\" belonged to project ") && said.contains("which is gone"), "{said}");
    assert!(said.contains("! couldn't put back \"unbrowse\" (refused)"), "{said}");
    assert!(said.contains("! couldn't reinstall the plugin unbrowse@unbrowse (refused); run: claude plugin install unbrowse@unbrowse"), "{said}");
    assert!(said.contains("Kept the backup ") && said.contains("not everything was put back"), "{said}");
    assert!(root.join("T1/entries.json").exists(), "the only copy of the old keys is kept");
}

#[test]
fn an_undo_that_works_puts_back_what_is_missing_leaves_what_is_there_and_purge_deletes_the_backup() {
    let h = home("cov-undo-ok");
    let m = machine(&h);
    let proj = h.0.join("work/app");
    std::fs::create_dir_all(&proj).unwrap();
    // The project's entry is already back as it was; the user one is ours.
    write(
        &h.0.join(".claude.json"),
        &json!({ "mcpServers": { "unbrowse": mine() }, "projects": { proj.display().to_string(): { "mcpServers": { "unbrowse": hosted() } } } }).to_string(),
    );
    let root = record(
        &h,
        "T1",
        &json!({
            "version": 1,
            "added": ["unbrowse"],
            "replaced": [
                { "scope": "user", "name": "unbrowse", "project": null, "raw": hosted() },
                { "scope": "local", "name": "unbrowse", "project": proj.display().to_string(), "raw": hosted() }
            ],
            "plugins": [{ "name": "unbrowse@unbrowse", "scope": "user" }]
        }),
    );
    let mut hosts = Script::new();
    let mut out = Vec::new();
    undo(&m, &root, None, true, &mut hosts, &mut out).unwrap();
    let said = String::from_utf8(out).unwrap();
    assert!(said.contains("✓ Put back 2 old entries from ") && said.contains("✓ Deleted the backup "), "{said}");
    assert_eq!(
        hosts.lines,
        vec![
            "mcp remove --scope user unbrowse".to_string(),
            format!("mcp add-json --scope user unbrowse {}", hosted()),
            "plugin install unbrowse@unbrowse --scope user".to_string(),
        ],
        "the project's entry, already as it was, is not touched"
    );
    assert!(!root.join("T1").exists());
}

#[test]
fn a_backup_that_changed_nothing_is_not_the_one_undo_takes() {
    let h = home("cov-undo-skip");
    let m = machine(&h);
    record(&h, "T0", &json!({ "version": 1, "added": ["unbrowse"], "replaced": [], "plugins": [] }));
    let root = record(&h, "T1", &json!({ "version": 1, "added": [], "replaced": [], "plugins": [] }));
    let mut hosts = Script::new();
    let mut out = Vec::new();
    undo(&m, &root, None, false, &mut hosts, &mut out).unwrap();
    let said = String::from_utf8(out).unwrap();
    assert!(said.contains(&format!("from {}", root.join("T0").display())), "the run before the one that changed nothing is the one undone: {said}");
}

#[cfg(unix)]
mod programs {
    use super::*;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A program just written can't be run while another thread's fork still holds it open for writing.
        std::thread::sleep(std::time::Duration::from_millis(50));
        path
    }

    fn entry_of(program: &Path) -> Value {
        json!({ "command": program.display().to_string(), "args": ["mcp"], "env": { "COV_ENV": "yes" } })
    }

    #[test]
    fn the_machines_claude_is_run_in_the_folder_asked_and_what_it_says_is_the_reason() {
        let h = home("cov-real-claude");
        let log = h.0.join("log");
        let ok = script(&h.0, "claude-ok", &format!("echo \"$PWD $*\" >> '{}'", log.display()));
        let mut real = Real { claude: ok };
        real.claude(&["mcp".into(), "list".into()], Some(&h.0)).unwrap();
        let said = std::fs::read_to_string(&log).unwrap();
        assert!(said.contains("mcp list") && said.contains(&h.0.file_name().unwrap().to_string_lossy().to_string()), "{said}");
        let says = script(&h.0, "claude-says", "echo first >&2; echo 'no such server' >&2; echo >&2; exit 1");
        assert_eq!(Real { claude: says }.claude(&["x".into()], None), Err("no such server".into()));
        let silent = script(&h.0, "claude-silent", "exit 7");
        assert!(Real { claude: silent }.claude(&[], None).unwrap_err().starts_with("claude exited"));
        let e = Real { claude: h.0.join("nowhere") }.claude(&[], None).unwrap_err();
        assert!(e.contains("couldn't run "), "{e}");
    }

    #[test]
    fn an_entry_is_asked_for_its_tools_the_way_its_client_would_and_what_goes_wrong_is_named() {
        let h = home("cov-real-verify");
        let mut real = Real { claude: PathBuf::from("claude") };
        // Another answer and a line that isn't JSON come before the ones asked for; the program gets its environment.
        let good = script(
            &h.0,
            "good",
            "read a\necho 'a banner that is not JSON'\necho '{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}'\necho \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":1,\\\"result\\\":{\\\"env\\\":\\\"$COV_ENV\\\"}}\"\nread b\nread c\n\
             echo '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"a\"},{\"name\":\"b\"},{\"name\":\"c\"}]}}'\nsleep 5",
        );
        assert_eq!(real.verify(&entry_of(&good)), Ok(3));
        let locked = script(&h.0, "locked", "read a\necho 'it is locked' >&2\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"node locked\"}}'\nsleep 5");
        assert_eq!(real.verify(&entry_of(&locked)), Err("node locked: it is locked".into()));
        let gone = script(&h.0, "gone", "read a\nexit 0");
        assert_eq!(real.verify(&entry_of(&gone)), Err("it stopped before answering".into()));
        let empty = script(&h.0, "empty", "read a\necho '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'\nread b\nread c\necho '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}'\nsleep 5");
        assert_eq!(real.verify(&entry_of(&empty)), Err("it listed no tools".into()));
        assert_eq!(real.verify(&json!({ "args": [] })), Err("the entry runs no program".into()));
        let e = real.verify(&entry_of(&h.0.join("nowhere"))).unwrap_err();
        assert!(e.starts_with("couldn't start "), "{e}");
    }
}
