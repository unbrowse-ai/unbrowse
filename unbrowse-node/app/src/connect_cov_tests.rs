//! More of `connect`: the real check of the node's MCP server, the notes the window shows for an entry already there,
//! the shapes each client keeps an entry in, and what `undo` does when a file changed since.

use super::*;

const NODE: &str = "http://127.0.0.1:7788";

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn home(name: &str) -> (Scratch, Machine) {
    let dir = std::env::temp_dir().join(format!("unb-connect-cov-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let m = Machine { home: dir.clone(), claude_config_dir: None, codex_home: None, unbrowse_config_dir: None, xdg_config_home: None, node: NODE.into(), programs: vec![dir.join("programs")] };
    (Scratch(dir), m)
}

fn put(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn install(m: &Machine, c: Client) {
    let first = c.programs()[0];
    let p = m.programs[0].join(first);
    if first.ends_with(".app") {
        std::fs::create_dir_all(p).unwrap();
    } else {
        put(&p, "#!/bin/sh\n");
    }
}

fn ours() -> Value {
    entry(Path::new("/opt/unbrowse/unb"), NODE)
}

fn ok(_: &Value) -> Result<usize, String> {
    Ok(7)
}

fn status(m: &Machine, id: &str) -> Status {
    clients(m, &ours()).into_iter().find(|s| s.id == id).unwrap()
}

/// A program that answers the two MCP calls `verify` makes: `$ANSWER` is what it sends for `tools/list`, and
/// `$BEFORE` what it sends for `initialize`.
#[cfg(unix)]
fn mcp_script(dir: &Path, body: &str) -> Value {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join("fake-mcp.sh");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    // A program just written can't be run while another thread's fork still holds it open for writing.
    std::thread::sleep(std::time::Duration::from_millis(100));
    json!({ "command": p.display().to_string(), "args": ["mcp", "--agent", "first"], "env": { "ANSWER": r#"{"tools":[{"name":"a"},{"name":"b"},{"name":"c"}]}"# } })
}

const SPEAKS: &str = "read l; echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}'; read l; read l; echo '{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}'; echo \"{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"id\\\":2,\\\"result\\\":$ANSWER}\"; sleep 5";

#[cfg(unix)]
#[test]
fn a_server_that_lists_its_tools_is_counted_and_the_entrys_own_environment_reaches_it() {
    let (_h, m) = home("verify-ok");
    let entry = mcp_script(&m.home, SPEAKS);
    assert_eq!(verify(&entry), Ok(3), "other messages on the line are read past");
}

#[cfg(unix)]
#[test]
fn a_server_whose_only_tool_says_to_connect_is_not_the_nodes_server() {
    let (_h, m) = home("verify-connect");
    let mut entry = mcp_script(&m.home, SPEAKS);
    entry["env"]["ANSWER"] = json!(r#"{"tools":[{"name":"unbrowse_connect","description":"run unbrowse connect first"}]}"#);
    assert_eq!(verify(&entry), Err("run unbrowse connect first".to_string()));
    entry["env"]["ANSWER"] = json!(r#"{"tools":[]}"#);
    assert_eq!(verify(&entry), Err("it listed no tools".to_string()));
    entry["env"]["ANSWER"] = json!(r#"{}"#);
    assert_eq!(verify(&entry), Err("it listed no tools".to_string()));
}

#[cfg(unix)]
#[test]
fn a_server_that_stops_before_answering_says_its_last_words() {
    let (_h, m) = home("verify-dies");
    let entry = mcp_script(&m.home, "echo 'first line' >&2; echo 'no key yet' >&2; exit 1");
    let why = verify(&entry).unwrap_err();
    assert_eq!(why, "it stopped before answering: no key yet");
    let silent = mcp_script(&m.home, "exit 0");
    assert_eq!(verify(&silent).unwrap_err(), "it stopped before answering", "no stderr, nothing to add");
}

#[cfg(unix)]
#[test]
fn a_server_that_answers_initialize_with_an_error_says_the_error() {
    let (_h, m) = home("verify-error");
    let entry = mcp_script(&m.home, "read l; echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"message\":\"bad token\"}}'; sleep 5");
    assert_eq!(verify(&entry).unwrap_err(), "bad token");
    let nameless = mcp_script(&m.home, "read l; echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{}}'; sleep 5");
    assert_eq!(verify(&nameless).unwrap_err(), "an error");
}

#[test]
fn an_entry_with_no_program_is_not_run() {
    assert_eq!(verify(&json!({ "args": ["mcp"] })), Err("the entry runs no program".to_string()));
}

#[cfg(unix)]
#[test]
fn claude_is_found_where_its_installers_put_it_when_the_path_has_none() {
    let (_h, m) = home("find-claude");
    // The variable and the PATH belong to the process: only what this machine's own folders give is judged here.
    if std::env::var_os("UNBROWSE_CLAUDE").is_some_and(|v| !v.is_empty()) {
        return;
    }
    let local = m.home.join(".local/bin/claude");
    put(&local, "#!/bin/sh\n");
    let found = find_claude(&m).expect("a claude in the machine's own bin folder is found");
    assert!(found.is_file() && found.ends_with("claude"));
    // With a claude on this process's own PATH that one wins, so only a PATH with none can show where it was found.
    let on_path = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("claude").is_file()));
    if !on_path {
        assert_eq!(found, local, "the installers' own folder is searched when the PATH has none");
    }
}

/// opencode keeps an entry as one list (`command`) and an `environment`: connect reads it back as the same entry, so
/// what it wrote shows as connected, and what someone else wrote there is told apart for what it is.
#[test]
fn an_entry_kept_as_one_command_list_is_read_back_as_ours_or_told_for_what_it_is() {
    let (_h, m) = home("local-shape");
    install(&m, Client::Opencode);
    let file = Client::Opencode.config(&m);
    let got = connect(&m, &[Client::Opencode], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
    assert!(got[0].ok, "{got:?}");
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(written["mcp"]["servers"]["unbrowse"]["command"], json!(["/opt/unbrowse/unb", "mcp", "--agent", "first"]));
    assert_eq!(written["mcp"]["servers"]["unbrowse"]["environment"]["UNBROWSE_NODE"], NODE);
    let s = status(&m, "opencode");
    assert!(s.connected && s.note.is_none() && s.found);
    // Connecting again changes nothing: the entry is already the node's.
    let again = connect(&m, &[Client::Opencode], &ours(), &m.home.join("records"), "20261122T000001Z", None, &mut ok);
    assert!(again[0].ok);
    assert_eq!(serde_json::from_str::<Value>(&std::fs::read_to_string(&file).unwrap()).unwrap(), written);
    // The same program for another node: replaced by Connect, and the window says so.
    put(&file, r#"{"mcp":{"servers":{"unbrowse":{"type":"local","command":["/opt/unbrowse/unb","mcp","--agent","2"],"environment":{"UNBROWSE_NODE":"http://127.0.0.1:9999"}}}}}"#);
    let s = status(&m, "opencode");
    assert!(!s.connected);
    assert!(s.note.as_deref().unwrap().contains("another address or agent"), "{:?}", s.note);
    // The old hosted client: replaced.
    put(&file, r#"{"mcp":{"servers":{"unbrowse":{"type":"local","command":["npx","-y","unbrowse@12","mcp"]}}}}"#);
    assert!(status(&m, "opencode").note.as_deref().unwrap().contains("older Unbrowse"));
    // A server of the same name that isn't Unbrowse's: left as it is, and an entry with a url only is read too.
    put(&file, r#"{"mcp":{"servers":{"unbrowse":{"type":"remote","url":"https://example.com/mcp"}}}}"#);
    let s = status(&m, "opencode");
    assert!(!s.connected && s.note.as_deref().unwrap().contains("didn't add: it is left as it is"), "{:?}", s.note);
    let refused = connect(&m, &[Client::Opencode], &ours(), &m.home.join("records"), "20261122T000002Z", None, &mut ok);
    assert!(!refused[0].ok && refused[0].error.as_deref().unwrap().contains("left as it is"), "{refused:?}");
    // A command given as a plain string reads as that program.
    put(&file, r#"{"mcp":{"servers":{"unbrowse":{"command":"/opt/unbrowse/unb"}}}}"#);
    assert!(status(&m, "opencode").note.is_some());
}

#[test]
fn a_config_that_wont_read_is_the_clients_note_not_a_crash() {
    let (_h, m) = home("note-error");
    install(&m, Client::Cursor);
    put(&m.home.join(".cursor/mcp.json"), "{ not json");
    let s = status(&m, "cursor");
    assert!(!s.connected && s.found);
    assert!(s.note.is_some(), "the reason the file didn't read is told");
    // A file that is a folder can't be read either.
    install(&m, Client::Windsurf);
    std::fs::create_dir_all(Client::Windsurf.config(&m)).unwrap();
    let s = status(&m, "windsurf");
    assert!(s.note.as_deref().unwrap().starts_with("couldn't read "), "{:?}", s.note);
}

#[test]
fn a_codex_entry_is_read_back_with_every_kind_of_value_it_holds() {
    let (_h, m) = home("codex-values");
    install(&m, Client::Codex);
    let file = Client::Codex.config(&m);
    put(&file, "[mcp_servers.unbrowse]\ncommand = \"/opt/unbrowse/unb\"\nargs = [\"mcp\", \"--agent\", \"first\"]\nport = 5\nverbose = true\nrate = 1.5\nenv = { UNBROWSE_NODE = \"http://127.0.0.1:7788\" }\n\n[mcp_servers.unbrowse.extra]\nk = \"v\"\n");
    let got = current(Client::Codex, &file).unwrap().unwrap();
    assert_eq!(got["command"], "/opt/unbrowse/unb");
    assert_eq!(got["args"], json!(["mcp", "--agent", "first"]));
    assert_eq!((got["port"].clone(), got["verbose"].clone()), (json!(5), json!(true)));
    assert_eq!(got["rate"], Value::Null, "a kind of value connect never writes reads as nothing");
    assert_eq!(got["env"]["UNBROWSE_NODE"], NODE);
    assert_eq!(got["extra"]["k"], "v");
    // Written inline, the entry itself is the owner's to change by hand; invalid TOML is named too.
    put(&file, "[mcp_servers]\nunbrowse = { command = \"x\" }\n");
    assert!(current(Client::Codex, &file).unwrap_err().contains("mcp_servers.unbrowse on one line"));
    put(&file, "mcp_servers = 5\n");
    assert!(current(Client::Codex, &file).unwrap_err().contains("one line"));
    put(&file, "= nope");
    assert!(current(Client::Codex, &file).unwrap_err().contains("isn't valid TOML"));
    put(&file, "[other]\nx = 1\n");
    assert_eq!(current(Client::Codex, &file).unwrap(), None, "no servers, no entry");
}

#[test]
fn hermes_entry_it_cannot_read_back_is_left_alone_and_a_block_at_the_margin_is_not_edited() {
    let (_h, m) = home("hermes-odd");
    install(&m, Client::Hermes);
    let file = Client::Hermes.config(&m);
    // Keys connect never writes, or values it can't read as its own shape, show as an entry no Unbrowse wrote.
    put(&file, "mcp_servers:\n  unbrowse:\n    command: run\n    args: nope\n    env: {}\n");
    let e = yaml_entry(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(e["command"], "(not readable)");
    let got = connect(&m, &[Client::Hermes], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
    assert!(!got[0].ok, "{got:?}");
    // Children at the margin are no block this can add to.
    put(&file, "mcp_servers:\n# comment\n\nmodel: x\n");
    let text = std::fs::read_to_string(&file).unwrap();
    let wrote = yaml_rewrite(&file, &text, Some(&ours()), None).unwrap();
    assert!(wrote.contains("mcp_servers:\n  unbrowse:\n    command: \"/opt/unbrowse/unb\""), "{wrote}");
    put(&file, "mcp_servers:\ngithub: {}\n");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(yaml_rewrite(&file, &text, Some(&ours()), None).unwrap().contains("  unbrowse:"));
}

#[test]
fn a_client_set_up_per_project_is_never_written_and_one_not_installed_says_so() {
    let (_h, m) = home("not-written");
    let why = write(Client::ElizaOs, &m, &ours(), "t", None).unwrap_err();
    assert!(why.contains("set up in each project"), "{why}");
    let why = write(Client::Cursor, &m, &ours(), "t", None).unwrap_err();
    assert!(why.contains("isn't installed"), "{why}");
    let (stat, elizas) = (status(&m, "elizaos"), Client::ElizaOs);
    assert!(stat.manual && elizas.manual() && !stat.connected);
    assert_eq!(rewrite(Client::ElizaOs, Path::new("x"), None, None, None).unwrap_err(), format!("ElizaOS is {ELIZA_NOTE}"));
}

#[test]
fn a_clients_servers_that_are_not_an_object_leave_the_file_as_it_is() {
    let (_h, m) = home("servers-not-object");
    install(&m, Client::Cursor);
    let file = Client::Cursor.config(&m);
    put(&file, r#"{"mcpServers": 5}"#);
    let got = connect(&m, &[Client::Cursor], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
    assert!(!got[0].ok && got[0].error.as_deref().unwrap().contains("isn't an object"), "{got:?}");
    assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"mcpServers": 5}"#);
    // A folder that can't hold the entry is the client's failure with the reason.
    let mut doc = json!(5);
    assert!(servers_mut(&mut doc, &["a"]).is_none());
}

#[test]
fn copilot_gets_all_its_tools_and_a_codex_entry_keeps_its_environment_as_a_table() {
    let (_h, m) = home("shapes");
    install(&m, Client::CopilotCli);
    install(&m, Client::Codex);
    let got = connect(&m, &[Client::CopilotCli, Client::Codex], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
    assert!(got.iter().all(|o| o.ok), "{got:?}");
    let copilot: Value = serde_json::from_str(&std::fs::read_to_string(Client::CopilotCli.config(&m)).unwrap()).unwrap();
    assert_eq!(copilot["mcpServers"]["unbrowse"]["type"], "local");
    assert_eq!(copilot["mcpServers"]["unbrowse"]["tools"], json!(["*"]));
    let codex = std::fs::read_to_string(Client::Codex.config(&m)).unwrap();
    assert!(codex.contains("[mcp_servers.unbrowse.env]") && codex.contains("UNBROWSE_NODE = \"http://127.0.0.1:7788\""), "{codex}");
}

/// What undo does depends on what the file is now: as connect left it, it is restored whole (or removed, when connect
/// made it); changed since, only the entry goes; with its copy gone, it says so.
#[test]
fn undo_restores_a_file_as_it_was_whatever_became_of_it_since() {
    let (_h, m) = home("undo-paths");
    let rec = m.home.join("records");
    install(&m, Client::Cursor);
    install(&m, Client::Windsurf);
    // Cursor's file didn't exist: connect made it, and undo removes it while it is still as written.
    let got = connect(&m, &[Client::Cursor], &ours(), &rec, "20261122T000000Z", None, &mut ok);
    assert!(got[0].ok);
    let cursor = Client::Cursor.config(&m);
    assert!(cursor.is_file());
    let back = undo(&rec).unwrap();
    assert_eq!(back, vec![(Client::Cursor, cursor.clone())]);
    assert!(!cursor.exists(), "a file connect made is removed");
    assert!(rec.join("20261122T000000Z.undone").is_file(), "a run undone is not undone twice");
    assert!(undo(&rec).unwrap_err().contains("hasn't changed anything"));
    // Windsurf's file existed: the copy from before is put back whole.
    let wind = Client::Windsurf.config(&m);
    put(&wind, r#"{"mcpServers":{"other":{"command":"o"}}}"#);
    connect(&m, &[Client::Windsurf], &ours(), &rec, "20261122T000001Z", None, &mut ok);
    assert!(std::fs::read_to_string(&wind).unwrap().contains("unbrowse"));
    undo(&rec).unwrap();
    assert_eq!(std::fs::read_to_string(&wind).unwrap(), r#"{"mcpServers":{"other":{"command":"o"}}}"#);
    // The copy is gone: undo says so and changes nothing.
    put(&wind, r#"{"mcpServers":{"other":{"command":"o"}}}"#);
    connect(&m, &[Client::Windsurf], &ours(), &rec, "20261122T000002Z", None, &mut ok);
    let change: Record = serde_json::from_slice(&std::fs::read(rec.join("20261122T000002Z.json")).unwrap()).unwrap();
    std::fs::remove_file(change.changes[0].backup.as_ref().unwrap()).unwrap();
    let written = std::fs::read_to_string(&wind).unwrap();
    let why = undo(&rec).unwrap_err();
    assert!(why.contains("couldn't put back") && why.contains("No such file"), "{why}");
    assert_eq!(std::fs::read_to_string(&wind).unwrap(), written);
    // A record that names no copy at all.
    let mut raw: Value = serde_json::from_slice(&std::fs::read(rec.join("20261122T000002Z.json")).unwrap()).unwrap();
    raw["changes"][0]["backup"] = Value::Null;
    std::fs::write(rec.join("20261122T000002Z.json"), raw.to_string()).unwrap();
    let why = undo(&rec).unwrap_err();
    assert!(why.contains("its copy from before is gone"), "{why}");
}

#[test]
fn undo_with_a_record_that_is_not_one_names_the_file_and_one_for_a_client_it_no_longer_knows_is_skipped() {
    let (_h, m) = home("undo-bad");
    let rec = m.home.join("records");
    assert!(undo(&rec).unwrap_err().contains("hasn't changed anything"), "no folder");
    put(&rec.join("20261122T000000Z.json"), "not json");
    let why = undo(&rec).unwrap_err();
    assert!(why.contains("20261122T000000Z.json"), "{why}");
    std::fs::remove_file(rec.join("20261122T000000Z.json")).unwrap();
    let skipped = Record { at: "x".into(), changes: vec![Change { client: "retired-client".into(), file: m.home.join("f"), previous: Value::Null, previous_text: String::new(), created: true, backup: None, written: String::new() }] };
    put(&rec.join("20261122T000001Z.json"), &serde_json::to_string(&skipped).unwrap());
    assert_eq!(undo(&rec).unwrap(), vec![]);
}

#[test]
fn a_run_that_cannot_keep_its_record_still_changes_the_files() {
    let (_h, m) = home("record-unkept");
    install(&m, Client::Cursor);
    // The records folder is a file: nothing can be kept there.
    let rec = m.home.join("records");
    put(&rec, "a file");
    let got = connect(&m, &[Client::Cursor], &ours(), &rec, "20261122T000000Z", None, &mut ok);
    assert!(got[0].ok);
    assert!(Client::Cursor.config(&m).is_file());
    assert_eq!(std::fs::read_to_string(&rec).unwrap(), "a file");
}

#[test]
fn a_toml_value_of_a_kind_connect_never_writes_reads_as_nothing() {
    let doc: toml_edit::DocumentMut = "d = 1979-05-27T07:32:00Z\ns = \"x\"\n".parse().unwrap();
    assert_eq!(toml_json(&doc["d"]), Value::Null);
    assert_eq!(toml_json(&doc["s"]), json!("x"));
    let none = toml_edit::Item::None;
    assert_eq!(toml_json(&none), Value::Null);
}

#[test]
fn programs_are_found_by_name_app_bundle_or_extension_folder_and_not_by_a_missing_one() {
    let (_h, m) = home("programs");
    assert!(!program(&m, &["tool"]));
    put(&m.programs[0].join("tool"), "x");
    assert!(program(&m, &["tool"]));
    std::fs::create_dir_all(m.programs[0].join("Thing.app")).unwrap();
    assert!(program(&m, &["Thing.app"]));
    put(&m.programs[0].join("Other.app"), "a file is no bundle");
    assert!(!program(&m, &["Other.app"]));
    assert!(!vscode_extension(&m, "pub.name-"));
    std::fs::create_dir_all(m.home.join(".vscode/extensions/pub.name-1.2.3")).unwrap();
    assert!(vscode_extension(&m, "pub.name-"));
    assert!(!vscode_extension(&m, "pub.other-"));
}
