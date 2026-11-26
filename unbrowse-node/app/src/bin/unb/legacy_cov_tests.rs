//! What a scan makes of the files an older Unbrowse and the agents' hosts leave: values of every TOML kind, files that
//! aren't what they should be, secrets in headers and environments, and where an agent's program may be.

use super::tests::{home, machine};
use super::*;

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[test]
fn a_codex_table_is_read_with_every_kind_of_value_it_may_hold() {
    let h = home("cov-toml");
    write(
        &h.0.join(".codex/config.toml"),
        "[mcp_servers.unbrowse]\ncommand = \"unbrowse\"\nargs = [\"mcp\", \"--agent\", \"first\"]\nretries = 2\nratio = 1.5\nquiet = true\nsince = 1979-05-27T07:32:00Z\n\
         [mcp_servers.unbrowse.env]\nUNBROWSE_NODE = \"http://127.0.0.1:7788\"\n\
         [[mcp_servers.unbrowse.extra]]\nname = \"a\"\n[[mcp_servers.unbrowse.extra]]\nname = \"b\"\n",
    );
    let s = scan(&machine(&h));
    let f = s.found.iter().find(|f| f.host == Host::Codex).expect("the table is found");
    assert_eq!((f.name.as_str(), f.kind), ("unbrowse", Kind::Core));
    assert_eq!(f.raw["retries"], json!(2));
    assert_eq!(f.raw["ratio"], json!(1.5));
    assert_eq!(f.raw["quiet"], json!(true));
    assert_eq!(f.raw["since"], json!("1979-05-27T07:32:00Z"), "a date is kept as its text");
    assert_eq!(f.raw["env"]["UNBROWSE_NODE"], "http://127.0.0.1:7788");
    assert_eq!(f.raw["extra"], json!([{ "name": "a" }, { "name": "b" }]), "an array of tables is an array of objects");
}

#[test]
fn a_codex_file_that_is_not_toml_is_said_not_skipped() {
    let h = home("cov-bad-toml");
    write(&h.0.join(".codex/config.toml"), "[mcp_servers.unbrowse\ncommand = ");
    let s = scan(&machine(&h));
    assert!(s.found.is_empty());
    assert_eq!(s.unread.len(), 1);
    assert!(s.unread[0].ends_with("config.toml isn't TOML this could read"), "{:?}", s.unread);
}

#[test]
fn a_claude_file_that_is_not_json_is_said_not_skipped() {
    let h = home("cov-bad-claude");
    write(&h.0.join(".claude.json"), "{ not json");
    let s = scan(&machine(&h));
    assert!(s.found.is_empty());
    assert!(s.unread.iter().any(|u| u.contains(".claude.json isn't JSON this could read")), "{:?}", s.unread);
}

#[test]
fn a_plugins_own_entry_is_read_with_its_address_filled_in_from_the_environment_or_its_default() {
    let h = home("cov-plugin");
    let install = h.0.join("plugins-cache/unbrowse");
    write(
        &install.join(".mcp.json"),
        r#"{"mcpServers":{"unbrowse":{"url":"${UNB_COV_NOT_SET_ANYWHERE:-https://unbrowse.ai}/mcp","headers":{"x-site":"${UNB_COV_NOT_SET_ANYWHERE}"},"args":["a","${UNB_COV_NOT_SET_ANYWHERE:-b}"],"retries":3}}}"#,
    );
    write(
        &h.0.join(".claude/plugins/installed_plugins.json"),
        &json!({ "plugins": { "unbrowse@market": [{ "scope": "user", "installPath": install.display().to_string() }] } }).to_string(),
    );
    let s = scan(&machine(&h));
    let f = s.found.iter().find(|f| f.host == Host::ClaudePlugin).expect("the plugin is found");
    assert_eq!(f.kind, Kind::Legacy, "what it ships calls the hosted service once its default is filled in");
}

#[test]
fn what_a_secret_looks_like_in_an_entry_is_found_in_its_headers_or_its_environment() {
    assert_eq!(secret_in(&json!({ "headers": { "Authorization": "Bearer abc123" } })).as_deref(), Some("abc123"));
    assert_eq!(secret_in(&json!({ "headers": { "authorization": "bearer lower" } })).as_deref(), Some("lower"));
    assert_eq!(secret_in(&json!({ "headers": { "X-Api-Key": "  k-1 " } })).as_deref(), Some("k-1"));
    assert_eq!(secret_in(&json!({ "headers": { "x-session-token": "t-2" } })).as_deref(), Some("t-2"));
    assert_eq!(secret_in(&json!({ "headers": { "accept": "json", "authorization": 5 } })), None, "a header that isn't text holds no secret");
    assert_eq!(secret_in(&json!({ "env": { "UNBROWSE_API_KEY": "" } })), None, "an empty one is none");
    assert_eq!(secret_in(&json!({ "env": { "PATH": "/bin", "MY_SECRET": "s-3" } })).as_deref(), Some("s-3"));
    assert_eq!(secret_in(&json!({ "env": { "GH_TOKEN": "t-4" } })).as_deref(), Some("t-4"));
    assert_eq!(secret_in(&json!({ "command": "x" })), None);
}

#[test]
fn an_old_cli_started_by_a_windows_path_or_with_no_agent_is_legacy_and_one_with_an_agent_is_this_nodes() {
    let node = "http://127.0.0.1:7788";
    let win = json!({ "command": "node", "args": ["C:\\Users\\me\\unbrowse\\dist\\cli.js", "mcp"] });
    assert_eq!(classify(&win, node), Kind::Legacy);
    assert_eq!(classify(&json!({ "command": "unbrowse", "args": ["mcp", "--account", "x"] }), node), Kind::Legacy);
    assert_eq!(classify(&json!({ "command": "C:\\bin\\unbrowse.exe", "args": ["mcp", "--agent", "first"] }), node), Kind::Core);
    assert_eq!(classify(&json!({ "command": "/usr/bin/unb", "args": ["mcp"] }), node), Kind::Legacy);
    assert_eq!(classify(&json!({ "command": "my-own-mcp", "args": ["serve"] }), node), Kind::Unknown);
    assert_eq!(classify(&json!({ "command": { "path": "unb", "args": ["mcp", "--agent", "2"] } }), node), Kind::Core, "Zed's shape");
}

#[test]
fn the_old_clients_files_are_listed_by_where_they_are_and_a_v1_key_by_its_last_four() {
    let h = home("cov-files");
    let m = machine(&h);
    std::fs::create_dir_all(m.old_signin_dir()).unwrap();
    write(&h.0.join(".unbrowse/config.json"), r#"{"api_key":"sk-secret-wxyz"}"#);
    let s = scan(&m);
    let files: Vec<&Found> = s.found.iter().filter(|f| f.host == Host::Files).collect();
    assert_eq!(files.len(), 2);
    let signin = files.iter().find(|f| f.name == "sign-in").unwrap();
    assert_eq!(describe(signin), signin.file.display().to_string(), "a folder with no key is shown by its place");
    let v1 = files.iter().find(|f| f.name == "v1 key").unwrap();
    let said = describe(v1);
    assert!(said.starts_with("v1 key …wxyz in ") && !said.contains("sk-secret"), "{said}");
}

// Not on Windows: there the test binary's other tests read the real LOCALAPPDATA/APPDATA this sets and removes.
#[cfg(not(windows))]
#[test]
fn an_agents_program_is_looked_for_in_each_node_version_and_in_the_windows_folders() {
    let h = home("cov-dirs");
    std::fs::create_dir_all(h.0.join(".nvm/versions/node/v20.1.0/bin")).unwrap();
    std::fs::create_dir_all(h.0.join(".nvm/versions/node/v22.0.0/bin")).unwrap();
    std::env::set_var("LOCALAPPDATA", h.0.join("local"));
    std::env::set_var("APPDATA", h.0.join("roaming"));
    let dirs = program_dirs(&h.0);
    std::env::remove_var("LOCALAPPDATA");
    std::env::remove_var("APPDATA");
    assert!(dirs.contains(&h.0.join(".nvm/versions/node/v20.1.0/bin")) && dirs.contains(&h.0.join(".nvm/versions/node/v22.0.0/bin")));
    assert!(dirs.contains(&h.0.join("local").join("Programs")), "a Windows install under LOCALAPPDATA");
    assert!(dirs.contains(&h.0.join("roaming").join("npm")), "npm's global folder under APPDATA");
    assert!(dirs.contains(&h.0.join(".local/bin")));
}
