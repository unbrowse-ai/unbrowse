//! Connects the MCP clients on this machine to the node: Claude Code, Claude Desktop, Cursor, Codex, VS Code, Gemini CLI,
//! opencode and the rest of `ALL` (22 agent apps and command-line agents), each through its
//! own config file, with no terminal. The window's Connect button (`agent_connect`) and `unb connect --client` both come
//! here. Every client gets the same stdio entry, `<unb> mcp --agent first` with the node's address in its environment:
//! no token in any file, argument or line printed, since `unb mcp` reads the agent's token from the owner's grant.
//!
//! Each write keeps the file as it was beside it (`<file>.before-unbrowse-<time>`, owner-only), touches only the
//! `unbrowse` entry, replaces one an older Unbrowse wrote, and leaves one no Unbrowse wrote alone, saying so. The entry is
//! started and asked for its tools before any file is written, so a client is never pointed at a server that doesn't
//! answer. What each run changed is kept in a record, and `undo` puts every entry back as it was.
//!
//! Only std, serde_json, toml_edit and `legacy` (the classifier of older entries): both the node and `unb` include it.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::legacy::{self, Kind, Machine};

/// The name every client knows the node's server by.
pub const NAME: &str = "unbrowse";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    ClaudeCode,
    ClaudeDesktop,
    Cursor,
    Codex,
    VsCode,
    Windsurf,
    Devin,
    GeminiCli,
    Antigravity,
    QwenCode,
    CopilotCli,
    FactoryDroid,
    Kiro,
    Warp,
    Amp,
    Opencode,
    KiloCode,
    Augment,
    Junie,
    Cline,
    RooCode,
    LmStudio,
    Hermes,
    OpenClaw,
    ElizaOs,
}

pub const ALL: [Client; 25] = [
    Client::ClaudeCode,
    Client::ClaudeDesktop,
    Client::Cursor,
    Client::Codex,
    Client::VsCode,
    Client::Windsurf,
    Client::Devin,
    Client::GeminiCli,
    Client::Antigravity,
    Client::QwenCode,
    Client::CopilotCli,
    Client::FactoryDroid,
    Client::Kiro,
    Client::Warp,
    Client::Amp,
    Client::Opencode,
    Client::KiloCode,
    Client::Augment,
    Client::Junie,
    Client::Cline,
    Client::RooCode,
    Client::LmStudio,
    Client::Hermes,
    Client::OpenClaw,
    Client::ElizaOs,
];

/// How a client keeps one server, read from its own docs and the files it writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Shape {
    /// `{command, args, env}`.
    Plain,
    /// The same, naming its transport: `"type": "stdio"` (Claude Code, VS Code).
    Stdio,
    /// GitHub Copilot CLI: `"type": "local"`, and every tool the server lists (`"tools": ["*"]`).
    CopilotLocal,
    /// opencode and Kilo Code: `{type: "local", command: [program, args…], environment}`.
    Local,
    /// Codex's `[mcp_servers.unbrowse]` table.
    Toml,
    /// Hermes Agent's `mcp_servers:` in YAML, `{command, args, env}`.
    Yaml,
    /// Set up per project, in code (ElizaOS's characters): found and named, never written.
    Manual,
}

impl Client {
    pub fn id(self) -> &'static str {
        match self {
            Client::ClaudeCode => "claude_code",
            Client::ClaudeDesktop => "claude_desktop",
            Client::Cursor => "cursor",
            Client::Codex => "codex",
            Client::VsCode => "vscode",
            Client::Windsurf => "windsurf",
            Client::Devin => "devin",
            Client::GeminiCli => "gemini_cli",
            Client::Antigravity => "antigravity",
            Client::QwenCode => "qwen_code",
            Client::CopilotCli => "copilot_cli",
            Client::FactoryDroid => "factory_droid",
            Client::Kiro => "kiro",
            Client::Warp => "warp",
            Client::Amp => "amp",
            Client::Opencode => "opencode",
            Client::KiloCode => "kilo_code",
            Client::Augment => "augment",
            Client::Junie => "junie",
            Client::Cline => "cline",
            Client::RooCode => "roo_code",
            Client::LmStudio => "lm_studio",
            Client::Hermes => "hermes",
            Client::OpenClaw => "openclaw",
            Client::ElizaOs => "elizaos",
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Client::ClaudeCode => "Claude Code",
            Client::ClaudeDesktop => "Claude Desktop",
            Client::Cursor => "Cursor",
            Client::Codex => "Codex",
            Client::VsCode => "VS Code",
            Client::Windsurf => "Windsurf",
            Client::Devin => "Devin",
            Client::GeminiCli => "Gemini CLI",
            Client::Antigravity => "Antigravity",
            Client::QwenCode => "Qwen Code",
            Client::CopilotCli => "GitHub Copilot CLI",
            Client::FactoryDroid => "Factory Droid",
            Client::Kiro => "Kiro",
            Client::Warp => "Warp",
            Client::Amp => "Amp",
            Client::Opencode => "opencode",
            Client::KiloCode => "Kilo Code",
            Client::Augment => "Augment",
            Client::Junie => "Junie",
            Client::Cline => "Cline",
            Client::RooCode => "Roo Code",
            Client::LmStudio => "LM Studio",
            Client::Hermes => "Hermes Agent",
            Client::OpenClaw => "OpenClaw",
            Client::ElizaOs => "ElizaOS",
        }
    }

    /// A client by its id, or as a command line spells it (`claude-desktop`, `gemini-cli`).
    pub fn from_id(id: &str) -> Option<Client> {
        let id = id.trim().to_ascii_lowercase().replace('-', "_");
        ALL.into_iter().find(|c| c.id() == id)
    }

    /// Whether the client reads its config only as it starts, so a running one needs reopening. A command-line agent
    /// (Claude Code, Codex, Gemini CLI, opencode…) starts a new process for each session, which reads it afresh, and Kiro
    /// and Factory Droid read the file again when it changes.
    pub fn restart_needed(self) -> bool {
        matches!(
            self,
            Client::ClaudeDesktop
                | Client::Cursor
                | Client::VsCode
                | Client::Windsurf
                | Client::Devin
                | Client::Antigravity
                | Client::Warp
                | Client::Augment
                | Client::Junie
                | Client::Cline
                | Client::RooCode
                | Client::LmStudio
                | Client::Hermes
                | Client::OpenClaw
        )
    }

    /// Whether the client is set up per project rather than once for the machine, so Connect has no file to write:
    /// the app names it and says how.
    pub fn manual(self) -> bool {
        self.shape() == Shape::Manual
    }

    fn shape(self) -> Shape {
        match self {
            Client::Codex => Shape::Toml,
            Client::ClaudeCode | Client::VsCode => Shape::Stdio,
            Client::CopilotCli => Shape::CopilotLocal,
            Client::Opencode | Client::KiloCode => Shape::Local,
            Client::Hermes => Shape::Yaml,
            Client::ElizaOs => Shape::Manual,
            _ => Shape::Plain,
        }
    }

    /// Where in its JSON file the client keeps its servers: `mcpServers` for most.
    fn servers_at(self) -> &'static [&'static str] {
        match self {
            Client::VsCode => &["servers"],
            Client::Amp => &["amp.mcpServers"],
            Client::Opencode | Client::OpenClaw => &["mcp", "servers"],
            Client::KiloCode => &["mcp"],
            _ => &["mcpServers"],
        }
    }

    /// The file its MCP servers are kept in.
    pub fn config(self, m: &Machine) -> PathBuf {
        let h = &m.home;
        match self {
            Client::ClaudeCode => m.claude_json(),
            Client::ClaudeDesktop => app_dir(m, "Claude").join("claude_desktop_config.json"),
            Client::Cursor => h.join(".cursor").join("mcp.json"),
            Client::Codex => m.codex_toml(),
            Client::VsCode => vscode_user(m).join("mcp.json"),
            Client::Windsurf => h.join(".codeium").join("windsurf").join("mcp_config.json"),
            Client::Devin => devin_dir(m).join("mcp_config.json"),
            Client::GeminiCli => h.join(".gemini").join("settings.json"),
            Client::Antigravity => h.join(".gemini").join("config").join("mcp_config.json"),
            Client::QwenCode => h.join(".qwen").join("settings.json"),
            Client::CopilotCli => h.join(".copilot").join("mcp-config.json"),
            Client::FactoryDroid => h.join(".factory").join("mcp.json"),
            Client::Kiro => h.join(".kiro").join("settings").join("mcp.json"),
            Client::Warp => h.join(".warp").join(".mcp.json"),
            Client::Amp => config_home(m).join("amp").join("settings.json"),
            Client::Opencode => json_or_jsonc(&config_home(m).join("opencode"), "opencode"),
            Client::KiloCode => json_or_jsonc(&config_home(m).join("kilo"), "kilo"),
            Client::Augment => h.join(".augment").join("settings.json"),
            Client::Junie => h.join(".junie").join("mcp").join("mcp.json"),
            Client::Cline => vscode_user(m).join("globalStorage").join("saoudrizwan.claude-dev").join("settings").join("cline_mcp_settings.json"),
            Client::RooCode => vscode_user(m).join("globalStorage").join("rooveterinaryinc.roo-cline").join("settings").join("mcp_settings.json"),
            Client::LmStudio => h.join(".lmstudio").join("mcp.json"),
            Client::Hermes => h.join(".hermes").join("config.yaml"),
            Client::OpenClaw => h.join(".openclaw").join("openclaw.json"),
            // Each ElizaOS project keeps its own characters: there is no file of the machine's.
            Client::ElizaOs => PathBuf::new(),
        }
    }

    /// Whether the client is installed here: its program is, by the app or command its installer puts in place
    /// (`Machine::programs`), or by the VS Code extension it is. A settings folder alone isn't: other tools make them
    /// (a skills sync writes `~/.hermes/skills` and `~/.kiro/skills` on a machine with neither installed), and only an
    /// installed agent is connected.
    pub fn found(self, m: &Machine) -> bool {
        match self {
            // Claude Code writes `~/.claude.json` itself, and nothing else does.
            Client::ClaudeCode => m.claude_json().exists() || program(m, self.programs()),
            Client::Cline => vscode_extension(m, "saoudrizwan.claude-dev-"),
            Client::RooCode => vscode_extension(m, "rooveterinaryinc.roo-cline-"),
            _ => program(m, self.programs()),
        }
    }

    /// The app bundles and commands that say the client is installed (Cline and Roo Code are VS Code extensions).
    pub fn programs(self) -> &'static [&'static str] {
        match self {
            Client::ClaudeCode => &["claude"],
            Client::ClaudeDesktop => &["Claude.app", "Claude.exe", "claude-desktop"],
            Client::Cursor => &["Cursor.app", "cursor", "cursor-agent"],
            Client::Codex => &["codex", "Codex.app"],
            Client::VsCode => &["Visual Studio Code.app", "code"],
            Client::Windsurf => &["Windsurf.app", "windsurf"],
            Client::Devin => &["Devin.app", "devin"],
            Client::GeminiCli => &["gemini"],
            Client::Antigravity => &["Antigravity.app", "antigravity", "agy"],
            Client::QwenCode => &["qwen"],
            Client::CopilotCli => &["copilot"],
            Client::FactoryDroid => &["droid"],
            Client::Kiro => &["Kiro.app", "kiro", "kiro-cli"],
            Client::Warp => &["Warp.app", "warp"],
            Client::Amp => &["amp"],
            Client::Opencode => &["opencode", "OpenCode.app"],
            Client::KiloCode => &["kilo", "kilocode"],
            Client::Augment => &["auggie"],
            Client::Junie => &["junie"],
            Client::Cline | Client::RooCode => &[],
            Client::LmStudio => &["LM Studio.app", "lms"],
            Client::Hermes => &["hermes"],
            Client::OpenClaw => &["openclaw"],
            Client::ElizaOs => &["elizaos"],
        }
    }
}

/// Whether one of `names` (an app bundle or a command) is in one of the folders programs are looked for in.
fn program(m: &Machine, names: &[&str]) -> bool {
    m.programs.iter().any(|d| {
        names.iter().any(|n| {
            let p = d.join(n);
            if n.ends_with(".app") {
                return p.is_dir();
            }
            p.is_file() || (cfg!(windows) && ["exe", "cmd"].iter().any(|x| p.with_extension(x).is_file()))
        })
    })
}

/// Whether a VS Code extension whose folder starts with `prefix` (`publisher.name-`) is installed.
fn vscode_extension(m: &Machine, prefix: &str) -> bool {
    std::fs::read_dir(m.home.join(".vscode").join("extensions"))
        .map(|d| d.filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().starts_with(prefix)))
        .unwrap_or(false)
}

/// The config home: `XDG_CONFIG_HOME`, else `~/.config`, where opencode, Kilo Code, Amp and Devin keep theirs on every OS.
fn config_home(m: &Machine) -> PathBuf {
    m.xdg_config_home.clone().unwrap_or_else(|| m.home.join(".config"))
}

/// A desktop app's folder: Application Support on a Mac, `%APPDATA%` on Windows, the config home elsewhere.
fn app_dir(m: &Machine, name: &str) -> PathBuf {
    if cfg!(target_os = "macos") {
        m.home.join("Library").join("Application Support").join(name)
    } else if cfg!(windows) {
        m.home.join("AppData").join("Roaming").join(name)
    } else {
        config_home(m).join(name)
    }
}

/// VS Code's user folder, where its own `mcp.json` is and its extensions (Cline, Roo Code) keep their settings.
fn vscode_user(m: &Machine) -> PathBuf {
    app_dir(m, "Code").join("User")
}

fn devin_dir(m: &Machine) -> PathBuf {
    if cfg!(windows) {
        m.home.join("AppData").join("Roaming").join("devin")
    } else {
        config_home(m).join("devin")
    }
}

/// `<dir>/<stem>.json`, or the `.jsonc` one when only that is there.
fn json_or_jsonc(dir: &Path, stem: &str) -> PathBuf {
    let json = dir.join(format!("{stem}.json"));
    let jsonc = dir.join(format!("{stem}.jsonc"));
    if !json.exists() && jsonc.exists() { jsonc } else { json }
}

/// The entry a client starts: `unb mcp --agent first`, the node's address in its environment.
pub fn entry(unb: &Path, node: &str) -> Value {
    json!({ "command": unb.display().to_string(), "args": ["mcp", "--agent", "first"], "env": { "UNBROWSE_NODE": node } })
}

/// The entry as `client` keeps it.
fn entry_for(client: Client, entry: &Value) -> Value {
    let mut e = entry.clone();
    match client.shape() {
        Shape::Plain | Shape::Toml | Shape::Yaml | Shape::Manual => {}
        Shape::Stdio => e["type"] = json!("stdio"),
        Shape::CopilotLocal => {
            e["type"] = json!("local");
            e["tools"] = json!(["*"]);
        }
        Shape::Local => {
            let mut command = vec![entry["command"].clone()];
            command.extend(entry["args"].as_array().cloned().unwrap_or_default());
            return json!({ "type": "local", "command": command, "environment": entry["env"].clone() });
        }
    }
    e
}

/// A client's entry as `{command, args, env}` (and `url`, for a remote one), whatever shape it keeps it in, so entries
/// are compared and classified the same way for every client.
fn canonical(client: Client, have: &Value) -> Value {
    if client.shape() != Shape::Local {
        return have.clone();
    }
    let mut e = Map::new();
    match have.get("command") {
        Some(Value::Array(words)) => {
            if let Some(first) = words.first() {
                e.insert("command".into(), first.clone());
            }
            e.insert("args".into(), Value::Array(words.iter().skip(1).cloned().collect()));
        }
        Some(other) => {
            e.insert("command".into(), other.clone());
        }
        None => {}
    }
    for (from, to) in [("environment", "env"), ("url", "url")] {
        if let Some(v) = have.get(from) {
            e.insert(to.into(), v.clone());
        }
    }
    Value::Object(e)
}

fn same(a: &Value, b: &Value) -> bool {
    a.get("command") == b.get("command") && a.get("args") == b.get("args") && a.get("env") == b.get("env") && a.get("url").is_none() && b.get("url").is_none()
}

/// One client as the window lists it.
#[derive(Clone, Debug, serde::Serialize)]
pub struct Status {
    pub id: &'static str,
    pub name: &'static str,
    pub found: bool,
    /// Its `unbrowse` entry is this node's, exactly as connect writes it.
    pub connected: bool,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Set up per project, so there is nothing for Connect to write: `note` says how.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub manual: bool,
    /// When the app last reached this node (unix seconds), by the name it gives at MCP `initialize` (`heard::stamp`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heard: Option<u64>,
}

/// What an owner does for ElizaOS, which keeps its plugins in each project's character.
pub const ELIZA_NOTE: &str = "set up in each project: add @unbrowse/plugin-unbrowse to your character's plugins (integrations/elizaos)";

/// Every client this machine could have, found or not, and whether each is connected to the node by `entry`.
pub fn clients(m: &Machine, entry: &Value) -> Vec<Status> {
    ALL.into_iter()
        .map(|c| {
            if c.manual() {
                return Status { id: c.id(), name: c.name(), found: c.found(m), connected: false, path: String::new(), note: Some(ELIZA_NOTE.into()), manual: true, heard: None };
            }
            let file = c.config(m);
            let (connected, note) = match current(c, &file).map(|h| h.map(|h| canonical(c, &h))) {
                Err(e) => (false, Some(e)),
                Ok(None) => (false, None),
                Ok(Some(have)) if same(&have, entry) => (true, None),
                Ok(Some(have)) => match legacy::classify(&have, &m.node) {
                    Kind::Unknown => (false, Some(format!("{} already has an \"unbrowse\" server that Unbrowse didn't add: it is left as it is", c.name()))),
                    Kind::Legacy => (false, Some("an older Unbrowse's server is there: Connect replaces it".into())),
                    Kind::Core => (false, Some("an Unbrowse server for another address or agent is there: Connect replaces it".into())),
                },
            };
            Status { id: c.id(), name: c.name(), found: c.found(m), connected, path: file.display().to_string(), note, manual: false, heard: None }
        })
        .collect()
}

// ---- reading and writing each client's file ----

fn read_text(file: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("couldn't read {}: {e}", file.display())),
    }
}

fn parse_json(file: &Path, text: Option<&str>) -> Result<Map<String, Value>, String> {
    match text.map(str::trim) {
        None | Some("") => Ok(Map::new()),
        Some(t) => match serde_json::from_str::<Value>(t) {
            Ok(Value::Object(o)) => Ok(o),
            _ => Err(format!("{} isn't plain JSON (it may hold comments), so it was left as it is: add the unbrowse server there by hand", file.display())),
        },
    }
}

/// The client's `unbrowse` entry now, if it has one. A file that can't be read as its client's format is an error, and
/// nothing is written to it.
fn current(c: Client, file: &Path) -> Result<Option<Value>, String> {
    let text = read_text(file)?;
    match c {
        Client::Codex => codex_entry(file, text.as_deref().unwrap_or("")),
        Client::Hermes => Ok(yaml_entry(text.as_deref().unwrap_or(""))),
        Client::ElizaOs => Ok(None),
        _ => {
            let doc = Value::Object(parse_json(file, text.as_deref())?);
            Ok(c.servers_at().iter().try_fold(&doc, |v, k| v.get(*k)).and_then(|s| s.get(NAME)).cloned())
        }
    }
}

/// Codex's `[mcp_servers.unbrowse]`, as JSON. One written inline (`mcp_servers = { … }`, `mcp_servers.unbrowse = …`)
/// is one this file can't rewrite line by line: an error names it, and the owner edits it.
fn codex_entry(file: &Path, text: &str) -> Result<Option<Value>, String> {
    let doc: toml_edit::DocumentMut = text.parse().map_err(|_| format!("{} isn't valid TOML, so it was left as it is", file.display()))?;
    let Some(servers) = doc.get("mcp_servers") else { return Ok(None) };
    let Some(table) = servers.as_table() else {
        return Err(format!("{} keeps mcp_servers on one line: add the unbrowse server there by hand", file.display()));
    };
    let Some(ours) = table.get(NAME) else { return Ok(None) };
    let Some(t) = ours.as_table() else {
        return Err(format!("{} keeps mcp_servers.unbrowse on one line: change it there by hand", file.display()));
    };
    let mut e = Map::new();
    for (k, v) in t.iter() {
        e.insert(k.to_string(), toml_json(v));
    }
    Ok(Some(Value::Object(e)))
}

fn toml_json(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::Value(v) => toml_value(v),
        toml_edit::Item::Table(t) => Value::Object(t.iter().map(|(k, v)| (k.to_string(), toml_json(v))).collect()),
        _ => Value::Null,
    }
}

fn toml_value(v: &toml_edit::Value) -> Value {
    match v {
        toml_edit::Value::String(s) => json!(s.value()),
        toml_edit::Value::Integer(i) => json!(i.value()),
        toml_edit::Value::Boolean(b) => json!(b.value()),
        toml_edit::Value::Array(a) => Value::Array(a.iter().map(toml_value).collect()),
        toml_edit::Value::InlineTable(t) => Value::Object(t.iter().map(|(k, v)| (k.to_string(), toml_value(v))).collect()),
        _ => Value::Null,
    }
}

/// Whether a TOML header line opens `[mcp_servers.unbrowse]` or one of its sub-tables.
fn our_codex_header(line: &str) -> Option<bool> {
    let t = line.trim_start();
    if !t.starts_with('[') {
        return None;
    }
    let t: String = t.split('#').next().unwrap_or("").chars().filter(|c| !c.is_whitespace() && *c != '"' && *c != '\'').collect();
    Some(t == "[mcp_servers.unbrowse]" || t.starts_with("[mcp_servers.unbrowse."))
}

/// `text` without the `[mcp_servers.unbrowse]` table and its sub-tables, and what was taken out.
fn codex_without(text: &str) -> (String, String) {
    let (mut kept, mut taken, mut dropping) = (String::new(), String::new(), false);
    for line in text.split_inclusive('\n') {
        if let Some(ours) = our_codex_header(line) {
            dropping = ours;
        }
        if dropping { taken.push_str(line) } else { kept.push_str(line) }
    }
    (kept, taken)
}

/// A TOML basic string: JSON's escapes are TOML's.
fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn codex_table(entry: &Value) -> String {
    let args: Vec<String> = entry["args"].as_array().into_iter().flatten().filter_map(Value::as_str).map(toml_str).collect();
    let mut t = format!("[mcp_servers.{NAME}]\ncommand = {}\nargs = [{}]\n", toml_str(entry["command"].as_str().unwrap_or("unb")), args.join(", "));
    if let Some(env) = entry["env"].as_object().filter(|e| !e.is_empty()) {
        t.push_str(&format!("\n[mcp_servers.{NAME}.env]\n"));
        for (k, v) in env {
            t.push_str(&format!("{k} = {}\n", toml_str(v.as_str().unwrap_or_default())));
        }
    }
    t
}

/// `text` with the client's `unbrowse` entry set to `to` (or taken out, for `None`). For Codex, `previous` is the text
/// to put back in its place, as `undo` restores it.
fn rewrite(c: Client, file: &Path, text: Option<&str>, to: Option<&Value>, previous: Option<&str>) -> Result<String, String> {
    match c {
        Client::Hermes => yaml_rewrite(file, text.unwrap_or(""), to, previous),
        Client::ElizaOs => Err(format!("ElizaOS is {ELIZA_NOTE}")),
        Client::Codex => {
            let (kept, _) = codex_without(text.unwrap_or(""));
            let mut out = kept.trim_end().to_string();
            let add = match (to, previous) {
                (Some(e), _) => Some(codex_table(e)),
                (None, Some(p)) if !p.trim().is_empty() => Some(p.to_string()),
                _ => None,
            };
            if let Some(add) = add {
                if !out.is_empty() {
                    out.push_str("\n\n");
                }
                out.push_str(add.trim_end());
            }
            out.push('\n');
            // What is written must read back as TOML with the entry meant: anything else is refused, the file unchanged.
            out.parse::<toml_edit::DocumentMut>().map_err(|_| format!("the new {} wouldn't be valid TOML: left as it is", file.display()))?;
            Ok(out)
        }
        _ => {
            let mut doc = Value::Object(parse_json(file, text)?);
            let at = c.servers_at();
            let Some(servers) = servers_mut(&mut doc, at) else {
                return Err(format!("{}'s {} isn't an object, so it was left as it is", file.display(), at.join(".")));
            };
            match to {
                Some(e) => {
                    servers.insert(NAME.into(), e.clone());
                }
                None => {
                    servers.remove(NAME);
                }
            }
            serde_json::to_string_pretty(&doc).map(|s| s + "\n").map_err(|e| e.to_string())
        }
    }
}

// ---- Hermes Agent's YAML ----
//
// No YAML library: Hermes's `mcp_servers:` is edited as lines, and only in the shapes this can read back for sure (the
// key absent, `mcp_servers: {}`, or a block of children). Anything else is left alone and named, for the owner to edit.
// The entry is written in flow style with JSON's quoting, which YAML reads as the same strings, list and map.

/// The line that opens the top-level `mcp_servers:`, and what follows its colon (a comment taken off).
fn yaml_header(lines: &[&str]) -> Option<(usize, String)> {
    lines.iter().position(|l| l.starts_with("mcp_servers:")).map(|i| (i, lines[i]["mcp_servers:".len()..].split(" #").next().unwrap_or("").trim().to_string()))
}

fn indent(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// The lines under the header that belong to it: up to the next line at the margin.
fn yaml_children(lines: &[&str], header: usize) -> std::ops::Range<usize> {
    let end = (header + 1..lines.len()).find(|&i| !lines[i].trim().is_empty() && indent(lines[i]) == 0).unwrap_or(lines.len());
    header + 1..end
}

/// `unbrowse:` under `mcp_servers:`: its line range and its text.
fn yaml_block(text: &str) -> Option<(std::ops::Range<usize>, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let (h, _) = yaml_header(&lines)?;
    let kids = yaml_children(&lines, h);
    let start = kids.clone().find(|&i| lines[i].trim_start().starts_with(&format!("{NAME}:")) && lines[i].trim_start()[NAME.len() + 1..].trim().is_empty())?;
    let ci = indent(lines[start]);
    let end = (start + 1..kids.end).find(|&i| !lines[i].trim().is_empty() && indent(lines[i]) <= ci).unwrap_or(kids.end);
    Some((start..end, lines[start..end].iter().map(|l| format!("{l}\n")).collect()))
}

/// Hermes's `unbrowse` entry as `{command, args, env}`, read from the keys connect writes. One it can't read that way
/// comes back as an unreadable command, which no Unbrowse wrote, so it is left alone.
fn yaml_entry(text: &str) -> Option<Value> {
    let (_, block) = yaml_block(text)?;
    let mut e = Map::new();
    for line in block.lines().skip(1) {
        let Some((k, v)) = line.trim().split_once(':') else { continue };
        let v = v.trim();
        let value = serde_json::from_str::<Value>(v).unwrap_or_else(|_| json!(v.trim_matches(|c| c == '"' || c == '\'')));
        e.insert(k.trim().to_string(), value);
    }
    if !e.get("args").is_none_or(Value::is_array) || !e.get("env").is_none_or(Value::is_object) {
        e.insert("command".into(), json!("(not readable)"));
    }
    Some(Value::Object(e))
}

/// The entry's lines at `pad`, its keys as far in again, as the servers beside it are written.
fn yaml_entry_lines(entry: &Value, pad: usize) -> Vec<String> {
    let (p, q) = (" ".repeat(pad), " ".repeat(pad * 2));
    let json = |v: &Value| serde_json::to_string(v).unwrap_or_default();
    vec![
        format!("{p}{NAME}:"),
        format!("{q}command: {}", json(&entry["command"])),
        format!("{q}args: {}", json(&entry["args"])),
        format!("{q}env: {}", json(&entry["env"])),
    ]
}

fn yaml_rewrite(file: &Path, text: &str, to: Option<&Value>, previous: Option<&str>) -> Result<String, String> {
    let by_hand = || format!("{} keeps mcp_servers in a form this can't edit safely, so it was left as it is: add the unbrowse server there by hand", file.display());
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if let Some((range, _)) = yaml_block(text) {
        lines.drain(range);
    }
    let add: Vec<String> = match (to, previous) {
        (Some(_), _) => Vec::new(),
        (None, Some(p)) if !p.trim().is_empty() => p.lines().map(str::to_string).collect(),
        _ => Vec::new(),
    };
    let view: Vec<&str> = lines.iter().map(String::as_str).collect();
    let header = yaml_header(&view);
    let header_at = match header {
        Some((i, rest)) if rest.is_empty() || rest == "{}" => {
            lines[i] = "mcp_servers:".into();
            i
        }
        Some(_) => return Err(by_hand()),
        // Nothing to put back where there was no `mcp_servers:`: the file stays without one.
        None if to.is_none() && add.is_empty() => return Ok(if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" }),
        None => {
            if !lines.is_empty() && !lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.push(String::new());
            }
            lines.push("mcp_servers:".into());
            lines.len() - 1
        }
    };
    let view: Vec<&str> = lines.iter().map(String::as_str).collect();
    let kids = yaml_children(&view, header_at);
    let pad = kids.clone().find(|&i| !view[i].trim().is_empty() && !view[i].trim_start().starts_with('#')).map(|i| indent(view[i])).unwrap_or(2);
    if pad == 0 {
        return Err(by_hand());
    }
    let new = match to {
        Some(e) => yaml_entry_lines(e, pad),
        None => add,
    };
    lines.splice(header_at + 1..header_at + 1, new);
    let view: Vec<&str> = lines.iter().map(String::as_str).collect();
    if !yaml_children(&view, header_at).any(|i| !view[i].trim().is_empty() && !view[i].trim_start().starts_with('#')) {
        lines[header_at] = "mcp_servers: {}".into();
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Ok(out)
}

/// The object at `at` in `doc`, made on the way where it isn't there yet; None where something else is in its place.
fn servers_mut<'a>(mut doc: &'a mut Value, at: &[&str]) -> Option<&'a mut Map<String, Value>> {
    for k in at {
        doc = doc.as_object_mut()?.entry(k.to_string()).or_insert_with(|| json!({}));
    }
    doc.as_object_mut()
}

/// Writes `text` to `file` whole or not at all (a file beside it, renamed over it), keeping the file's mode; a new file
/// is the owner's alone.
fn write_whole(file: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let part = file.with_extension(format!("{}.unbrowse-part", file.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let mode = std::fs::metadata(file).ok().map(|m| m.permissions());
    {
        let mut f = std::fs::File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("{}: {e}", part.display()))?;
        f.sync_all().ok();
    }
    match mode {
        Some(p) => std::fs::set_permissions(&part, p).map_err(|e| e.to_string())?,
        None => private(&part),
    }
    std::fs::rename(&part, file).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("{}: {e}", file.display())
    })
}

fn private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

// ---- a run ----

/// What one client's write changed, kept so `undo` can put it back.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Change {
    pub client: String,
    pub file: PathBuf,
    /// The `unbrowse` entry before (JSON clients), or null when there was none.
    pub previous: Value,
    /// Codex: the `[mcp_servers.unbrowse]` text taken out.
    #[serde(default)]
    pub previous_text: String,
    /// The file didn't exist before.
    pub created: bool,
    /// The file as it was, kept beside it.
    pub backup: Option<PathBuf>,
    /// The file exactly as connect wrote it: undo puts the backup back whole only while the file is still this.
    pub written: String,
}

/// How one client came out, as the window shows it.
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
pub struct Outcome {
    pub id: &'static str,
    pub name: &'static str,
    pub ok: bool,
    pub restart_needed: bool,
    pub error: Option<String>,
}

/// The time a run is named by: `20261121T051822Z`.
pub fn stamp(unix: u64) -> String {
    let days = unix / 86_400;
    let secs = unix % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// Claude Code's own CLI, which a GUI app's short PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) doesn't reach: UNBROWSE_CLAUDE,
/// then PATH, then where its installers put it. `UNBROWSE_CLAUDE=none` edits its file instead.
pub fn find_claude(m: &Machine) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("UNBROWSE_CLAUDE").filter(|p| !p.is_empty()) {
        return (p != "none").then(|| PathBuf::from(p));
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    dirs.extend([m.home.join(".local/bin"), m.home.join(".claude/local"), PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin")]);
    dirs.into_iter().map(|d| d.join("claude")).find(|p| p.is_file())
}

/// `claude mcp add --scope user unbrowse --env K=V -- <command> <args>`: the program and its words, never a token.
fn claude_add_args(entry: &Value) -> Vec<String> {
    let mut args: Vec<String> = ["mcp", "add", "--scope", "user", NAME].map(String::from).to_vec();
    for (k, v) in entry["env"].as_object().into_iter().flatten() {
        args.push("--env".into());
        args.push(format!("{k}={}", v.as_str().unwrap_or_default()));
    }
    args.push("--".into());
    args.push(entry["command"].as_str().unwrap_or("unb").to_string());
    args.extend(entry["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)));
    args
}

fn run_claude(claude: &Path, home: &Path, args: &[String]) -> Result<(), String> {
    let out = std::process::Command::new(claude)
        .args(args)
        .current_dir(home)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("couldn't run {}: {e}", claude.display()))?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    let said = said.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
    Err(if said.is_empty() { format!("claude exited {}", out.status) } else { format!("claude: {said}") })
}

/// Sets `client`'s entry to `entry`, keeping the file as it was beside it. `None`: it already was, nothing written.
/// Claude Code is changed through its CLI (`claude`) when there is one, since a running Claude Code rewrites its file;
/// without one its file is edited.
pub fn write(client: Client, m: &Machine, entry: &Value, at: &str, claude: Option<&Path>) -> Result<Option<Change>, String> {
    if client.manual() {
        return Err(format!("ElizaOS is {ELIZA_NOTE}"));
    }
    if !client.found(m) {
        return Err(format!("{} isn't installed on this computer, so nothing was written for it", client.name()));
    }
    let file = client.config(m);
    let want = entry_for(client, entry);
    let text = read_text(&file)?;
    let have = current(client, &file)?;
    if let Some(have) = have.as_ref().map(|h| canonical(client, h)) {
        if same(&have, entry) {
            return Ok(None);
        }
        if legacy::classify(&have, &m.node) == Kind::Unknown {
            return Err(format!("{} already has an \"unbrowse\" server that Unbrowse didn't add, so it was left as it is: remove it in {} to connect this node", client.name(), file.display()));
        }
    }
    let new = rewrite(client, &file, text.as_deref(), Some(&want), None)?;
    let backup = match &text {
        Some(t) => {
            let b = PathBuf::from(format!("{}.before-unbrowse-{at}", file.display()));
            std::fs::write(&b, t).map_err(|e| format!("couldn't keep {}: {e}", b.display()))?;
            private(&b);
            Some(b)
        }
        None => None,
    };
    match (client, claude) {
        (Client::ClaudeCode, Some(cli)) => {
            if have.is_some() {
                run_claude(cli, &m.home, &["mcp", "remove", "--scope", "user", NAME].map(String::from))?;
            }
            run_claude(cli, &m.home, &claude_add_args(entry))?;
        }
        _ => write_whole(&file, &new)?,
    }
    let new = read_text(&file)?.unwrap_or(new);
    let previous_text = match client {
        Client::Codex => codex_without(text.as_deref().unwrap_or("")).1,
        Client::Hermes => yaml_block(text.as_deref().unwrap_or("")).map(|(_, b)| b).unwrap_or_default(),
        _ => String::new(),
    };
    let previous = if matches!(client, Client::Codex | Client::Hermes) { Value::Null } else { have.unwrap_or(Value::Null) };
    Ok(Some(Change { client: client.id().into(), file, previous, previous_text, created: text.is_none(), backup, written: new }))
}

/// One run's record: what it changed, in `dir/<at>.json`, owner-only.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct Record {
    pub at: String,
    pub changes: Vec<Change>,
}

/// Connects `chosen` to the node by `entry`. The entry is started and asked for its tools first (`verify`): if it doesn't
/// answer, nothing is written anywhere. What changed is kept under `records` for `undo`.
pub fn connect(m: &Machine, chosen: &[Client], entry: &Value, records: &Path, at: &str, claude: Option<&Path>, verify: &mut dyn FnMut(&Value) -> Result<usize, String>) -> Vec<Outcome> {
    let outcome = |c: Client, error: Option<String>| Outcome { id: c.id(), name: c.name(), ok: error.is_none(), restart_needed: error.is_none() && c.restart_needed(), error };
    if let Err(why) = verify(entry) {
        let why = format!("the node's MCP server didn't answer, so nothing was changed: {why}");
        return chosen.iter().map(|c| outcome(*c, Some(why.clone()))).collect();
    }
    let mut changes = Vec::new();
    let mut out = Vec::new();
    for c in chosen {
        match write(*c, m, entry, at, claude) {
            Ok(change) => {
                changes.extend(change);
                out.push(outcome(*c, None));
            }
            Err(e) => out.push(outcome(*c, Some(e))),
        }
    }
    if !changes.is_empty() {
        let record = Record { at: at.into(), changes };
        let kept = std::fs::create_dir_all(records)
            .map_err(|e| e.to_string())
            .and_then(|_| serde_json::to_vec_pretty(&record).map_err(|e| e.to_string()))
            .and_then(|b| std::fs::write(records.join(format!("{at}.json")), b).map_err(|e| e.to_string()));
        match kept {
            Ok(()) => private(&records.join(format!("{at}.json"))),
            Err(e) => eprintln!("connect: couldn't keep what it changed, so undo won't find this run: {e}"),
        }
    }
    out
}

/// The client by its kept id.
fn client_of(c: &Change) -> Option<Client> {
    Client::from_id(&c.client)
}

/// Puts back what the last connect run changed and returns the files it restored. A file connect created is removed
/// while it holds only what connect wrote. A file the client changed since is edited, not replaced: only the
/// `unbrowse` entry goes back to what it was, so nothing the client wrote in between is lost.
pub fn undo(records: &Path) -> Result<Vec<(Client, PathBuf)>, String> {
    let mut runs: Vec<PathBuf> = std::fs::read_dir(records)
        .map_err(|_| "connect hasn't changed anything to undo".to_string())?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    runs.sort();
    let last = runs.pop().ok_or("connect hasn't changed anything to undo")?;
    let record: Record = serde_json::from_slice(&std::fs::read(&last).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", last.display()))?;
    let mut restored = Vec::new();
    let mut failed = Vec::new();
    for ch in &record.changes {
        let Some(c) = client_of(ch) else { continue };
        let now = read_text(&ch.file)?;
        let done = if now.as_deref() == Some(ch.written.as_str()) {
            match (&ch.backup, ch.created) {
                (_, true) => std::fs::remove_file(&ch.file).map_err(|e| e.to_string()),
                (Some(b), false) => std::fs::read_to_string(b).map_err(|e| e.to_string()).and_then(|t| write_whole(&ch.file, &t)),
                (None, false) => Err("its copy from before is gone".into()),
            }
        } else {
            let previous = (!ch.previous.is_null()).then_some(&ch.previous);
            rewrite(c, &ch.file, now.as_deref(), previous, Some(&ch.previous_text)).and_then(|t| write_whole(&ch.file, &t))
        };
        match done {
            Ok(()) => restored.push((c, ch.file.clone())),
            Err(e) => failed.push(format!("{}: {e}", ch.file.display())),
        }
    }
    if !failed.is_empty() {
        return Err(format!("couldn't put back {}", failed.join("; ")));
    }
    std::fs::rename(&last, last.with_extension("undone")).map_err(|e| e.to_string())?;
    Ok(restored)
}

/// How long an entry has to answer `tools/list`: a node started on demand takes a few seconds.
const VERIFY_WAIT: std::time::Duration = std::time::Duration::from_secs(90);

/// Starts the entry's program as its client would and asks it `initialize` then `tools/list`: how many tools it lists.
pub fn verify(entry: &Value) -> Result<usize, String> {
    use std::io::{BufRead, BufReader};
    let program = entry["command"].as_str().ok_or("the entry runs no program")?;
    let mut cmd = std::process::Command::new(program);
    cmd.args(entry["args"].as_array().into_iter().flatten().filter_map(Value::as_str));
    for (k, v) in entry["env"].as_object().into_iter().flatten() {
        cmd.env(k, v.as_str().unwrap_or_default());
    }
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start {program}: {e}"))?;
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if tx.send(v).is_err() {
                    break;
                }
            }
        }
    });
    let stderr = child.stderr.take();
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let init = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "unbrowse-connect", "version": env!("CARGO_PKG_VERSION") } } });
    let wait_for = |id: u64, rx: &std::sync::mpsc::Receiver<Value>| -> Result<Value, String> {
        let deadline = std::time::Instant::now() + VERIFY_WAIT;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match rx.recv_timeout(left) {
                Ok(v) if v["id"] == json!(id) => {
                    return match v.get("error") {
                        Some(e) => Err(e["message"].as_str().unwrap_or("an error").to_string()),
                        None => Ok(v["result"].clone()),
                    };
                }
                Ok(_) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(format!("no answer in {}s", VERIFY_WAIT.as_secs())),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err("it stopped before answering".into()),
            }
        }
    };
    let result = (|| {
        writeln!(stdin, "{init}").map_err(|e| e.to_string())?;
        wait_for(1, &rx)?;
        writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).map_err(|e| e.to_string())?;
        writeln!(stdin, "{}", json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).map_err(|e| e.to_string())?;
        let tools = wait_for(2, &rx)?;
        match tools["tools"].as_array() {
            // The one tool an unconnected `unb mcp` lists says how to connect: not the node's server.
            Some(t) if t.len() == 1 && t[0]["name"] == "unbrowse_connect" => Err(t[0]["description"].as_str().unwrap_or("not connected").to_string()),
            Some(t) if !t.is_empty() => Ok(t.len()),
            _ => Err("it listed no tools".to_string()),
        }
    })();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    result.map_err(|why| {
        let mut said = String::new();
        if let Some(mut e) = stderr {
            let _ = std::io::Read::read_to_string(&mut e, &mut said);
        }
        match said.lines().rev().find(|l| !l.trim().is_empty()) {
            Some(last) => format!("{why}: {}", last.trim()),
            None => why,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODE: &str = "http://127.0.0.1:7788";
    const SECRET: &str = "unb_0123456789abcdef0123456789abcdef0123456789abcdef";

    struct Home(PathBuf);
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn home(name: &str) -> (Home, Machine) {
        let dir = std::env::temp_dir().join(format!("unb-connect-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let m = Machine { home: dir.clone(), claude_config_dir: None, codex_home: None, unbrowse_config_dir: None, xdg_config_home: None, node: NODE.into(), programs: vec![dir.join("programs")] };
        (Home(dir), m)
    }

    /// Installs `c` as its installer would leave it, as far as `found` looks: its app or command, or its extension.
    fn install(m: &Machine, c: Client) {
        match c {
            Client::Cline => std::fs::create_dir_all(m.home.join(".vscode/extensions/saoudrizwan.claude-dev-3.40.0")).unwrap(),
            Client::RooCode => std::fs::create_dir_all(m.home.join(".vscode/extensions/rooveterinaryinc.roo-cline-3.30.1")).unwrap(),
            _ => {
                let first = c.programs()[0];
                let p = m.programs[0].join(first);
                if first.ends_with(".app") { std::fs::create_dir_all(p).unwrap() } else { put(&p, "#!/bin/sh\n") }
            }
        }
    }

    fn put(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn ours() -> Value {
        entry(Path::new("/Applications/Unbrowse.app/Contents/MacOS/unb"), NODE)
    }

    fn ok(_: &Value) -> Result<usize, String> {
        Ok(12)
    }

    /// The four clients connect began with, each set up as its installer leaves it by `every_client_installed`.
    const FOUR: [Client; 4] = [Client::ClaudeCode, Client::ClaudeDesktop, Client::Cursor, Client::Codex];

    fn every_client_installed(m: &Machine) {
        for c in FOUR {
            install(m, c);
        }
        put(&m.home.join(".claude.json"), r#"{"numStartups": 3, "mcpServers": {"github": {"command": "gh-mcp"}}}"#);
        std::fs::create_dir_all(app_dir(m, "Claude")).unwrap();
        put(&m.home.join(".cursor/mcp.json"), r#"{"mcpServers": {"linear": {"url": "https://mcp.linear.app/sse"}}}"#);
        put(&m.home.join(".codex/config.toml"), "model = \"o4\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n\n[profiles.fast]\nmodel = \"mini\"\n");
    }

    /// Each client's entry is written where it reads it, every other server and setting stays, and the list then says
    /// each is connected.
    #[test]
    fn connect_writes_each_client_and_keeps_everything_else() {
        let (_h, m) = home("all");
        every_client_installed(&m);
        let rec = m.home.join("records");
        let got = connect(&m, &FOUR, &ours(), &rec, "20261121T000000Z", None, &mut ok);
        assert!(got.iter().all(|o| o.ok), "{got:?}");
        assert_eq!(got.iter().filter(|o| o.restart_needed).map(|o| o.id).collect::<Vec<_>>(), ["claude_desktop", "cursor"]);
        let cc: Value = serde_json::from_str(&std::fs::read_to_string(m.home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(cc["numStartups"], 3);
        assert_eq!(cc["mcpServers"]["github"]["command"], "gh-mcp");
        assert_eq!(cc["mcpServers"]["unbrowse"]["type"], "stdio");
        assert_eq!(cc["mcpServers"]["unbrowse"]["args"], json!(["mcp", "--agent", "first"]));
        let desk: Value = serde_json::from_str(&std::fs::read_to_string(Client::ClaudeDesktop.config(&m)).unwrap()).unwrap();
        assert_eq!(desk["mcpServers"]["unbrowse"]["env"]["UNBROWSE_NODE"], NODE);
        let cursor: Value = serde_json::from_str(&std::fs::read_to_string(m.home.join(".cursor/mcp.json")).unwrap()).unwrap();
        assert_eq!(cursor["mcpServers"]["linear"]["url"], "https://mcp.linear.app/sse");
        let codex = std::fs::read_to_string(m.home.join(".codex/config.toml")).unwrap();
        let doc: toml_edit::DocumentMut = codex.parse().unwrap();
        assert_eq!(doc["model"].as_str(), Some("o4"));
        assert_eq!(doc["profiles"]["fast"]["model"].as_str(), Some("mini"));
        assert_eq!(doc["mcp_servers"]["github"]["command"].as_str(), Some("gh-mcp"));
        assert_eq!(doc["mcp_servers"]["unbrowse"]["command"].as_str(), Some("/Applications/Unbrowse.app/Contents/MacOS/unb"));
        assert_eq!(doc["mcp_servers"]["unbrowse"]["env"]["UNBROWSE_NODE"].as_str(), Some(NODE));
        let list: Vec<Status> = clients(&m, &ours()).into_iter().filter(|s| FOUR.iter().any(|c| c.id() == s.id)).collect();
        assert!(list.len() == 4 && list.iter().all(|s| s.found && s.connected && s.note.is_none()), "{list:?}");
        // A second run changes nothing and keeps no record.
        let again = connect(&m, &FOUR, &ours(), &rec, "20261121T000001Z", None, &mut ok);
        assert!(again.iter().all(|o| o.ok));
        assert!(!rec.join("20261121T000001Z.json").exists());
    }

    /// No token reaches any file connect writes or keeps.
    #[test]
    fn no_token_in_any_file() {
        let (_h, m) = home("token");
        every_client_installed(&m);
        connect(&m, &ALL, &ours(), &m.home.join("records"), "20261121T000000Z", None, &mut ok);
        fn walk(p: &Path, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(p).unwrap().flatten() {
                if e.path().is_dir() { walk(&e.path(), out) } else { out.push(e.path()) }
            }
        }
        let mut files = vec![];
        walk(&m.home, &mut files);
        assert!(files.len() >= 6);
        for f in files {
            let t = std::fs::read_to_string(&f).unwrap_or_default();
            assert!(!t.contains("unb_") && !t.contains(SECRET), "{}", f.display());
        }
    }

    /// A server named unbrowse that no Unbrowse wrote is left alone and reported; an older Unbrowse's is replaced.
    #[test]
    fn an_entry_not_ours_stays_and_an_old_one_is_replaced() {
        let (_h, m) = home("theirs");
        install(&m, Client::Cursor);
        put(&m.home.join(".cursor/mcp.json"), r#"{"mcpServers": {"unbrowse": {"command": "my-fork", "args": ["serve"]}}}"#);
        put(&m.home.join(".claude.json"), r#"{"mcpServers": {"unbrowse": {"command": "npx", "args": ["-y", "unbrowse", "mcp"]}}}"#);
        let before = std::fs::read_to_string(m.home.join(".cursor/mcp.json")).unwrap();
        let list = clients(&m, &ours());
        assert!(list.iter().find(|s| s.id == "cursor").unwrap().note.as_deref().unwrap().contains("didn't add"));
        assert!(list.iter().find(|s| s.id == "claude_code").unwrap().note.as_deref().unwrap().contains("older"));
        let got = connect(&m, &[Client::Cursor, Client::ClaudeCode], &ours(), &m.home.join("records"), "20261121T000000Z", None, &mut ok);
        assert!(!got[0].ok && got[0].error.as_deref().unwrap().contains("left as it is"));
        assert!(got[1].ok);
        assert_eq!(std::fs::read_to_string(m.home.join(".cursor/mcp.json")).unwrap(), before, "byte for byte");
        let cc: Value = serde_json::from_str(&std::fs::read_to_string(m.home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(cc["mcpServers"]["unbrowse"]["args"], json!(["mcp", "--agent", "first"]));
    }

    /// A server that doesn't answer gets nothing written anywhere.
    #[test]
    fn a_failed_verify_writes_nothing() {
        let (_h, m) = home("verify");
        every_client_installed(&m);
        let before: Vec<Option<String>> = ALL.iter().map(|c| std::fs::read_to_string(c.config(&m)).ok()).collect();
        let got = connect(&m, &ALL, &ours(), &m.home.join("records"), "20261121T000000Z", None, &mut |_| Err("no answer in 90s".into()));
        assert!(got.iter().all(|o| !o.ok && o.error.as_deref().unwrap().contains("nothing was changed")));
        let after: Vec<Option<String>> = ALL.iter().map(|c| std::fs::read_to_string(c.config(&m)).ok()).collect();
        assert_eq!(before, after);
        assert!(!m.home.join("records").exists());
    }

    /// Undo puts every file back byte for byte, removes a file connect created, and keeps a client's own later edit.
    #[test]
    fn undo_puts_every_file_back() {
        let (_h, m) = home("undo");
        every_client_installed(&m);
        let before: Vec<Option<String>> = FOUR.iter().map(|c| std::fs::read_to_string(c.config(&m)).ok()).collect();
        assert!(before[1].is_none(), "Claude Desktop has no config file yet");
        let rec = m.home.join("records");
        connect(&m, &FOUR, &ours(), &rec, "20261121T000000Z", None, &mut ok);
        // Claude Code writes its own file in between: that write survives the undo.
        let cc = m.home.join(".claude.json");
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&cc).unwrap()).unwrap();
        v["numStartups"] = json!(4);
        std::fs::write(&cc, serde_json::to_string(&v).unwrap()).unwrap();
        let restored = undo(&rec).unwrap();
        assert_eq!(restored.len(), 4);
        let after: Vec<Option<String>> = FOUR.iter().map(|c| std::fs::read_to_string(c.config(&m)).ok()).collect();
        assert_eq!(after[1..], before[1..], "Claude Desktop, Cursor and Codex as they were");
        let cc: Value = serde_json::from_str(&std::fs::read_to_string(m.home.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(cc["numStartups"], 4);
        assert!(cc["mcpServers"].get("unbrowse").is_none() && cc["mcpServers"]["github"].is_object());
        assert!(undo(&rec).is_err(), "nothing left to undo");
    }

    /// A Codex config replaced over an older Unbrowse's table gets that table back on undo, sub-table and all.
    #[test]
    fn codex_old_table_is_replaced_and_comes_back() {
        let (_h, m) = home("codex");
        install(&m, Client::Codex);
        let old = "model = \"o4\"\n\n[mcp_servers.unbrowse]\ncommand = \"npx\"\nargs = [\"-y\", \"unbrowse\", \"mcp\"]\n\n[mcp_servers.unbrowse.env]\nUNBROWSE_CONFIG_DIR = \"/x\"\n\n[tui]\ntheme = \"dark\"\n";
        put(&m.home.join(".codex/config.toml"), old);
        let rec = m.home.join("records");
        assert!(connect(&m, &[Client::Codex], &ours(), &rec, "20261121T000000Z", None, &mut ok)[0].ok);
        let now = std::fs::read_to_string(m.home.join(".codex/config.toml")).unwrap();
        assert!(!now.contains("npx") && !now.contains("UNBROWSE_CONFIG_DIR") && now.contains("theme = \"dark\""), "{now}");
        // Codex rewrote nothing: the file comes back whole.
        undo(&rec).unwrap();
        assert_eq!(std::fs::read_to_string(m.home.join(".codex/config.toml")).unwrap(), old);
    }

    /// Files that can't be read as their format, or an inline Codex table, are left alone with a reason.
    #[test]
    fn a_malformed_or_inline_config_is_left_alone() {
        let (_h, m) = home("bad");
        install(&m, Client::Cursor);
        install(&m, Client::Codex);
        put(&m.home.join(".cursor/mcp.json"), "{ not json");
        put(&m.home.join(".codex/config.toml"), "mcp_servers = { github = { command = \"gh\" } }\n");
        let got = connect(&m, &[Client::Cursor, Client::Codex], &ours(), &m.home.join("records"), "20261121T000000Z", None, &mut ok);
        assert!(got.iter().all(|o| !o.ok), "{got:?}");
        assert_eq!(std::fs::read_to_string(m.home.join(".cursor/mcp.json")).unwrap(), "{ not json");
        assert!(got[1].error.as_deref().unwrap().contains("one line"));
    }

    /// The backup keeps the file as it was and is the owner's alone; the rewritten file keeps its own mode.
    #[cfg(unix)]
    #[test]
    fn backups_are_private_and_modes_kept() {
        use std::os::unix::fs::PermissionsExt;
        let (_h, m) = home("mode");
        install(&m, Client::Cursor);
        let f = m.home.join(".cursor/mcp.json");
        put(&f, "{}");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644)).unwrap();
        let change = write(Client::Cursor, &m, &ours(), "20261121T000000Z", None).unwrap().unwrap();
        assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o644);
        let b = change.backup.unwrap();
        assert_eq!(std::fs::metadata(&b).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(b).unwrap(), "{}");
    }

    /// Every harness connect knows is set up here (its folder, and some with servers of their own), the way it keeps its
    /// servers: one Connect writes each in the shape it reads, keeps what was there, lists each connected, and Undo puts
    /// every file back as it was.
    #[test]
    fn every_harness_gets_the_entry_in_its_own_shape_and_undo_takes_it_back() {
        let (_h, m) = home("every");
        every_client_installed(&m);
        let every: Vec<Client> = ALL.into_iter().filter(|c| !c.manual()).collect();
        for c in &every {
            install(&m, *c);
        }
        put(&Client::Hermes.config(&m), "model: hermes-4\nmcp_servers: {}\n");
        put(&m.home.join(".gemini/settings.json"), r#"{"mcpServers": {"nanomon": {"command": "nanomon"}}}"#);
        put(&Client::Opencode.config(&m), r#"{"$schema": "https://opencode.ai/config.json", "mcp": {"servers": {"scratch": {"type": "local", "command": ["python3", "bridge.py"]}}}}"#);
        put(&Client::VsCode.config(&m), r#"{"servers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/"}}, "inputs": []}"#);
        put(&Client::Amp.config(&m), r#"{"amp.dangerouslyAllowAll": false}"#);
        let before: Vec<(Client, Option<String>)> = every.iter().map(|c| (*c, std::fs::read_to_string(c.config(&m)).ok())).collect();
        let rec = m.home.join("records");
        let got = connect(&m, &every, &ours(), &rec, "20261122T000000Z", None, &mut ok);
        assert!(got.iter().all(|o| o.ok), "{got:?}");
        let read = |c: Client| -> Value { serde_json::from_str(&std::fs::read_to_string(c.config(&m)).unwrap()).unwrap() };
        let unb = "/Applications/Unbrowse.app/Contents/MacOS/unb";
        for c in every.iter().copied() {
            if matches!(c, Client::Codex | Client::Hermes) {
                continue;
            }
            let doc = read(c);
            let at = c.servers_at().iter().fold(&doc, |v, k| &v[*k]);
            let e = &at[NAME];
            match c {
                Client::Opencode | Client::KiloCode => {
                    assert_eq!(e["type"], "local", "{}", c.name());
                    assert_eq!(e["command"], json!([unb, "mcp", "--agent", "first"]), "{}", c.name());
                    assert_eq!(e["environment"]["UNBROWSE_NODE"], NODE, "{}", c.name());
                    assert!(e.get("args").is_none() && e.get("env").is_none(), "{}: {e}", c.name());
                }
                _ => {
                    assert_eq!(e["command"], unb, "{}: {doc}", c.name());
                    assert_eq!(e["args"], json!(["mcp", "--agent", "first"]), "{}", c.name());
                    assert_eq!(e["env"]["UNBROWSE_NODE"], NODE, "{}", c.name());
                }
            }
        }
        assert_eq!(read(Client::VsCode)["servers"]["unbrowse"]["type"], "stdio");
        assert_eq!(read(Client::VsCode)["servers"]["github"]["url"], "https://api.githubcopilot.com/mcp/");
        assert_eq!(read(Client::VsCode)["inputs"], json!([]));
        assert_eq!(read(Client::CopilotCli)["mcpServers"]["unbrowse"]["type"], "local");
        assert_eq!(read(Client::CopilotCli)["mcpServers"]["unbrowse"]["tools"], json!(["*"]));
        assert_eq!(read(Client::Opencode)["$schema"], "https://opencode.ai/config.json");
        assert_eq!(read(Client::Opencode)["mcp"]["servers"]["scratch"]["command"], json!(["python3", "bridge.py"]));
        assert_eq!(read(Client::Amp)["amp.dangerouslyAllowAll"], false);
        assert_eq!(read(Client::GeminiCli)["mcpServers"]["nanomon"]["command"], "nanomon");
        let hermes = std::fs::read_to_string(Client::Hermes.config(&m)).unwrap();
        assert_eq!(hermes, format!("model: hermes-4\nmcp_servers:\n  unbrowse:\n    command: \"{unb}\"\n    args: [\"mcp\",\"--agent\",\"first\"]\n    env: {{\"UNBROWSE_NODE\":\"{NODE}\"}}\n"));
        let list: Vec<Status> = clients(&m, &ours()).into_iter().filter(|s| !s.manual).collect();
        assert!(list.len() == 24 && list.iter().all(|s| s.found && s.connected && s.note.is_none()), "{list:?}");
        assert!(connect(&m, &every, &ours(), &rec, "20261122T000001Z", None, &mut ok).iter().all(|o| o.ok));
        assert!(!rec.join("20261122T000001Z.json").exists(), "a second run changed something");
        undo(&rec).unwrap();
        for (c, was) in before {
            assert_eq!(std::fs::read_to_string(c.config(&m)).ok(), was, "{} wasn't put back", c.name());
        }
    }

    /// A settings folder isn't an installed agent: a skills sync makes `~/.hermes/skills`, `~/.kiro/skills` and the like
    /// on a machine with neither. Only the program says it is there, and nothing is written for one that isn't.
    #[test]
    fn only_an_installed_agent_is_found_or_connected() {
        let (_h, m) = home("installed");
        for d in [".hermes/skills", ".kiro/skills", ".openclaw/skills", ".gemini", ".codeium/windsurf", ".config/devin", ".junie", ".augment"] {
            std::fs::create_dir_all(m.home.join(d)).unwrap();
        }
        assert!(clients(&m, &ours()).iter().all(|s| !s.found), "{:?}", clients(&m, &ours()));
        let got = connect(&m, &[Client::Kiro, Client::Hermes], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
        assert!(got.iter().all(|o| !o.ok && o.error.as_deref().unwrap().contains("isn't installed on this computer")), "{got:?}");
        assert!(!Client::Kiro.config(&m).exists() && !Client::Hermes.config(&m).exists());
        install(&m, Client::Kiro);
        install(&m, Client::Hermes);
        let found: Vec<&str> = clients(&m, &ours()).into_iter().filter(|s| s.found).map(|s| s.id).collect();
        assert_eq!(found, ["kiro", "hermes"]);
        assert!(connect(&m, &[Client::Kiro, Client::Hermes], &ours(), &m.home.join("records"), "20261122T000001Z", None, &mut ok).iter().all(|o| o.ok));
        assert_eq!(Client::from_id("gemini-cli"), Some(Client::GeminiCli));
        assert_eq!(Client::from_id("lm-studio"), Some(Client::LmStudio));
    }

    /// ElizaOS keeps its plugins in each project's character: found, it is named with what to do, and never written.
    #[test]
    fn elizaos_is_named_with_its_setup_and_never_written() {
        let (_h, m) = home("eliza");
        install(&m, Client::ElizaOs);
        let s = clients(&m, &ours()).into_iter().find(|s| s.id == "elizaos").unwrap();
        assert!(s.found && s.manual && !s.connected && s.note.as_deref().unwrap().contains("@unbrowse/plugin-unbrowse"), "{s:?}");
        let got = connect(&m, &[Client::ElizaOs], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
        assert!(!got[0].ok && got[0].error.as_deref().unwrap().contains("each project"), "{got:?}");
        assert_eq!(serde_json::to_value(&s).unwrap()["manual"], true);
    }

    /// Hermes's YAML is written only in the shapes it can be read back in: added under a block of other servers at their
    /// indent, put back as it was, and an inline map it can't edit safely is left alone.
    #[test]
    fn hermes_yaml_is_edited_only_where_it_reads_back() {
        let (_h, m) = home("hermes");
        install(&m, Client::Hermes);
        let file = Client::Hermes.config(&m);
        let rec = m.home.join("records");
        // A block of servers four spaces in, with a comment: ours goes in at their indent, and theirs stays.
        let text = "# my agent\nmcp_servers:\n    github:\n        command: gh-mcp\nmodel: x\n";
        put(&file, text);
        assert!(connect(&m, &[Client::Hermes], &ours(), &rec, "20261122T000000Z", None, &mut ok)[0].ok);
        let now = std::fs::read_to_string(&file).unwrap();
        assert!(now.starts_with("# my agent\nmcp_servers:\n    unbrowse:\n        command: \"/Applications/Unbrowse.app/Contents/MacOS/unb\"\n"), "{now}");
        assert!(now.contains("    github:\n        command: gh-mcp\nmodel: x\n"), "{now}");
        assert!(clients(&m, &ours()).iter().find(|s| s.id == "hermes").unwrap().connected);
        // Hermes rewrote its file since: undo takes out only ours.
        std::fs::write(&file, format!("{now}theme: dark\n")).unwrap();
        undo(&rec).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{text}theme: dark\n"));
        // No mcp_servers at all: added at the end; and the empty one comes back as `{}` once ours is taken out.
        put(&file, "model: x\n");
        assert!(connect(&m, &[Client::Hermes], &ours(), &rec, "20261122T000001Z", None, &mut ok)[0].ok);
        let now = std::fs::read_to_string(&file).unwrap();
        assert!(now.starts_with("model: x\n\nmcp_servers:\n  unbrowse:\n"), "{now}");
        assert_eq!(yaml_rewrite(&file, &now, None, None).unwrap(), "model: x\n\nmcp_servers: {}\n");
        // A map written inline is the owner's to edit.
        put(&file, "mcp_servers: {github: {command: gh-mcp}}\n");
        let got = connect(&m, &[Client::Hermes], &ours(), &rec, "20261122T000002Z", None, &mut ok);
        assert!(!got[0].ok && got[0].error.as_deref().unwrap().contains("by hand"), "{got:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "mcp_servers: {github: {command: gh-mcp}}\n");
        // An unbrowse server someone else wrote there is left alone.
        put(&file, "mcp_servers:\n  unbrowse:\n    url: https://example.com/mcp\n");
        let got = connect(&m, &[Client::Hermes], &ours(), &rec, "20261122T000003Z", None, &mut ok);
        assert!(!got[0].ok, "{got:?}");
    }

    /// A config written with comments (opencode's `.jsonc`) is never rewritten, since writing it back would drop them:
    /// it is named, and left as it was.
    #[test]
    fn a_config_with_comments_is_left_as_it_was() {
        let (_h, m) = home("jsonc");
        install(&m, Client::Opencode);
        let jsonc = m.home.join(".config/opencode/opencode.jsonc");
        let text = "// my settings\n{ \"model\": \"x\" }\n";
        put(&jsonc, text);
        assert_eq!(Client::Opencode.config(&m), jsonc);
        let got = connect(&m, &[Client::Opencode], &ours(), &m.home.join("records"), "20261122T000000Z", None, &mut ok);
        assert!(!got[0].ok && got[0].error.as_deref().unwrap_or("").contains("may hold comments"), "{got:?}");
        assert_eq!(std::fs::read_to_string(&jsonc).unwrap(), text);
    }

    #[test]
    fn clients_are_found_by_their_programs() {
        let (_h, m) = home("found");
        assert!(clients(&m, &ours()).iter().all(|s| !s.found && !s.connected));
        install(&m, Client::Cursor);
        install(&m, Client::Codex);
        let found: Vec<&str> = clients(&m, &ours()).into_iter().filter(|s| s.found).map(|s| s.id).collect();
        assert_eq!(found, ["cursor", "codex"]);
        assert_eq!(Client::from_id("claude-desktop"), Some(Client::ClaudeDesktop));
        assert_eq!(stamp(1_763_702_302), "20251121T051822Z");
    }

    /// With a `claude` CLI, Claude Code's entry goes in through it, never a token on its command line; an older entry
    /// is removed through it first.
    #[cfg(unix)]
    #[test]
    fn claude_code_is_changed_through_its_cli() {
        use std::os::unix::fs::PermissionsExt;
        let (_h, m) = home("cli");
        put(&m.home.join(".claude.json"), r#"{"mcpServers": {"unbrowse": {"command": "npx", "args": ["-y", "unbrowse", "mcp"]}}}"#);
        let log = m.home.join("claude.log");
        let cli = m.home.join("bin/claude");
        put(&cli, &format!("#!/bin/sh\necho \"$@\" >> {}\n", log.display()));
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        let got = connect(&m, &[Client::ClaudeCode], &ours(), &m.home.join("records"), "20261121T000000Z", Some(&cli), &mut ok);
        assert!(got[0].ok, "{got:?}");
        let said = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            said.lines().collect::<Vec<_>>(),
            ["mcp remove --scope user unbrowse", "mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:7788 -- /Applications/Unbrowse.app/Contents/MacOS/unb mcp --agent first"]
        );
        // A CLI that fails is the client's failure, with its last words.
        put(&cli, "#!/bin/sh\necho 'not signed in' >&2\nexit 1\n");
        let got = connect(&m, &[Client::ClaudeCode], &ours(), &m.home.join("records"), "20261121T000001Z", Some(&cli), &mut ok);
        assert_eq!(got[0].error.as_deref(), Some("claude: not signed in"));
    }

    /// The real check starts the program: one that isn't there fails with its reason.
    #[test]
    fn verify_reports_a_program_that_wont_start() {
        let e = verify(&entry(Path::new("/nonexistent/unb"), NODE)).unwrap_err();
        assert!(e.contains("couldn't start"), "{e}");
    }
}

#[cfg(test)]
#[path = "connect_cov_tests.rs"]
mod connect_cov_tests;
