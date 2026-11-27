//! What an older Unbrowse left on this machine, found and never written (`scan`): the MCP entries the hosted service's
//! client (12.x and before), its site, its plugin and its deeplinks added to each agent host, and the files it kept.
//! Each entry is classified: Legacy (the old hosted client, which `connect` replaces), Core (this node's own entry) or
//! Unknown (something else named `unbrowse…`, such as a user's fork, which nothing here ever touches).

use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The old hosted client: an address on unbrowse.ai, the 12.x CLI's `mcp` without `--agent`, or its settings.
    Legacy,
    /// This node's entry: `unb mcp --agent …` / `unbrowse mcp --agent …`, or the node's own address.
    Core,
    /// Anything else with the name: never touched, only reported.
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    ClaudeCode,
    ClaudePlugin,
    Codex,
    Cursor,
    VsCode,
    Gemini,
    Zed,
    /// A file the old client kept (its sign-in folder, the v1 key): always kept, listed so the owner knows.
    Files,
}

impl Host {
    pub fn label(self) -> &'static str {
        match self {
            Host::ClaudeCode => "Claude Code",
            Host::ClaudePlugin => "Claude plugin",
            Host::Codex => "Codex",
            Host::Cursor => "Cursor",
            Host::VsCode => "VS Code",
            Host::Gemini => "Gemini",
            Host::Zed => "Zed",
            Host::Files => "Files",
        }
    }
}

/// Where an entry lives in its host. Claude Code keeps a local-scope entry per project folder
/// (`projects[<path>].mcpServers`), which `claude mcp remove --scope user` never sees.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    User,
    Local(PathBuf),
    /// A project's checked-in `.mcp.json`: reported, never changed.
    Project(PathBuf),
}

impl Scope {
    pub fn word(&self) -> &'static str {
        match self {
            Scope::User => "user",
            Scope::Local(_) => "local",
            Scope::Project(_) => "project",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Found {
    pub host: Host,
    pub scope: Scope,
    pub name: String,
    pub kind: Kind,
    /// The entry exactly as its host keeps it (a JSON object; a Codex table converted to one).
    pub raw: Value,
    /// The file it was read from.
    pub file: PathBuf,
}

/// The machine `scan` reads: its home and the settings that move each host's files.
#[derive(Clone, Debug)]
pub struct Machine {
    pub home: PathBuf,
    pub claude_config_dir: Option<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub unbrowse_config_dir: Option<PathBuf>,
    pub xdg_config_home: Option<PathBuf>,
    /// The node's own address (`UNBROWSE_NODE`), so an entry pointing at it is Core whatever its port.
    pub node: String,
    /// Where installed programs are looked for (`connect::Client::found`): the PATH, the folders installers put
    /// command-line agents in (a GUI app's PATH reaches none of them), and the Applications folders.
    pub programs: Vec<PathBuf>,
}

impl Machine {
    pub fn here(node: &str) -> Machine {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        let home = var("HOME").or_else(|| var("USERPROFILE")).unwrap_or_else(|| PathBuf::from("."));
        Machine {
            programs: program_dirs(&home),
            home,
            claude_config_dir: var("CLAUDE_CONFIG_DIR"),
            codex_home: var("CODEX_HOME"),
            unbrowse_config_dir: var("UNBROWSE_CONFIG_DIR"),
            xdg_config_home: var("XDG_CONFIG_HOME"),
            node: node.to_string(),
        }
    }

    /// Claude Code's own config: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
    pub fn claude_json(&self) -> PathBuf {
        match &self.claude_config_dir {
            Some(d) => d.join(".claude.json"),
            None => self.home.join(".claude.json"),
        }
    }

    pub fn claude_dir(&self) -> PathBuf {
        self.claude_config_dir.clone().unwrap_or_else(|| self.home.join(".claude"))
    }

    pub fn plugins_json(&self) -> PathBuf {
        self.claude_dir().join("plugins").join("installed_plugins.json")
    }

    pub fn codex_toml(&self) -> PathBuf {
        self.codex_home.clone().unwrap_or_else(|| self.home.join(".codex")).join("config.toml")
    }

    fn config_home(&self) -> PathBuf {
        self.xdg_config_home.clone().unwrap_or_else(|| self.home.join(".config"))
    }

    /// The old client's sign-in folder.
    pub fn old_signin_dir(&self) -> PathBuf {
        self.unbrowse_config_dir.clone().unwrap_or_else(|| self.config_home().join("unbrowse"))
    }

    fn vscode_user_dirs(&self) -> Vec<PathBuf> {
        vec![
            self.config_home().join("Code").join("User"),
            self.home.join("Library").join("Application Support").join("Code").join("User"),
            self.home.join("AppData").join("Roaming").join("Code").join("User"),
        ]
    }
}

/// Where an agent's program may be: the PATH, then where installers put them (npm, bun, Homebrew, nvm, the agents'
/// own installers), then the Applications folders.
fn program_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for d in [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin", ".cargo/bin", ".opencode/bin", ".lmstudio/bin", ".claude/local", "bin"] {
        dirs.push(home.join(d));
    }
    if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
        dirs.extend(versions.filter_map(Result::ok).map(|v| v.path().join("bin")));
    }
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/usr/local/bin"), PathBuf::from("/Applications"), home.join("Applications")]);
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Programs"));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(roaming).join("npm"));
    }
    dirs
}

/// The names an Unbrowse entry goes by: `unbrowse`, or `unbrowse-<account>` as the 12.x CLI named a second account's.
pub fn is_our_name(name: &str) -> bool {
    match name.strip_prefix("unbrowse") {
        Some("") => true,
        Some(rest) => rest.strip_prefix('-').is_some_and(|a| !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')),
        None => false,
    }
}

/// The hosted service's addresses: unbrowse.ai and its `www.`, `api.` and `v3.` names.
fn is_hosted(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(host.as_str(), "unbrowse.ai" | "www.unbrowse.ai" | "api.unbrowse.ai" | "v3.unbrowse.ai")
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1")
}

/// The port the node listens on, from its address.
fn node_port(node: &str) -> Option<u16> {
    url::Url::parse(node).ok().and_then(|u| u.port_or_known_default())
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        Some(Value::String(s)) => s.split_whitespace().map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// An entry's address, under whichever key its host uses.
pub fn entry_url(entry: &Value) -> Option<&str> {
    ["url", "serverUrl", "httpUrl", "uri"].iter().find_map(|k| entry.get(*k).and_then(Value::as_str))
}

/// Whether a program word runs the Unbrowse CLI: `unbrowse`, `unb`, `unbrowse@<v>` (through npx), a path to either.
fn runs_unbrowse(word: &str) -> bool {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".cmd")).unwrap_or(base);
    base == "unbrowse" || base == "unb" || base.starts_with("unbrowse@")
}

/// What an entry is (module doc), read from what it runs or the address it calls, and its settings.
pub fn classify(entry: &Value, node: &str) -> Kind {
    if let Some(u) = entry_url(entry) {
        let Ok(parsed) = url::Url::parse(u) else { return Kind::Unknown };
        let host = parsed.host_str().unwrap_or("");
        if is_hosted(host) {
            return Kind::Legacy;
        }
        let ours = node_port(node);
        if is_loopback(host) && (parsed.port_or_known_default() == Some(7788) || parsed.port_or_known_default() == ours) {
            return Kind::Core;
        }
        return Kind::Unknown;
    }
    // Zed keeps `command` as `{ path, args, env }`; the others keep `command`, `args` and `env` side by side.
    let at = match entry.get("command") {
        Some(c @ Value::Object(_)) => c,
        _ => entry,
    };
    let mut words = strings(at.get("path").or(entry.get("command")).filter(|c| !c.is_object()));
    words.extend(strings(at.get("args")));
    let env: Vec<&str> = at.get("env").and_then(Value::as_object).map(|e| e.keys().map(String::as_str).collect()).unwrap_or_default();
    if env.iter().any(|k| *k == "UNBROWSE_CONFIG_DIR" || *k == "UNBROWSE_SHARED_SIGNIN") {
        return Kind::Legacy;
    }
    if words.windows(2).any(|w| (w[0].ends_with("dist/cli.js") || w[0].ends_with("dist\\cli.js")) && w[1] == "mcp") {
        return Kind::Legacy;
    }
    if words.iter().any(|w| w.starts_with("unbrowse@12") || w.starts_with("unbrowse@6") || w.starts_with("unbrowse@0.") || w.starts_with("unbrowse@1.")) {
        return Kind::Legacy;
    }
    // `unbrowse mcp …`: with `--agent` it is this node's bridge; without, the 12.x client's.
    if let Some(at) = words.iter().position(|w| runs_unbrowse(w)) {
        if words.get(at + 1).map(String::as_str) == Some("mcp") {
            let rest = &words[at + 2..];
            if rest.iter().any(|w| w == "--agent") {
                return Kind::Core;
            }
            return Kind::Legacy;
        }
    }
    Kind::Unknown
}

/// The last 4 characters of a secret, the most a plan or a message shows of one.
pub fn last4(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("…{tail}")
}

/// What an entry is, in words that name no secret: its address without query, or that it runs the CLI, and its key
/// by its last 4 characters.
pub fn describe(f: &Found) -> String {
    let what = match f.kind {
        Kind::Legacy => "hosted",
        Kind::Core => "your node",
        Kind::Unknown => "not ours",
    };
    if f.host == Host::Files {
        return match f.raw.get("api_key").and_then(Value::as_str) {
            Some(k) => format!("v1 key {} in {}", last4(k), f.file.display()),
            None => format!("{}", f.file.display()),
        };
    }
    let mut parts = Vec::new();
    if let Some(u) = entry_url(&f.raw) {
        // An address not ours is shown by its host alone: its path may carry the key of whatever it is.
        let path = |p: &url::Url| if f.kind == Kind::Unknown { String::new() } else { p.path().to_string() };
        let shown = url::Url::parse(u).map(|p| format!("{}://{}{}", p.scheme(), p.host_str().unwrap_or(""), path(&p))).unwrap_or_else(|_| "an address".into());
        parts.push(shown);
    } else if f.raw.get("command").is_some() {
        let args = strings(f.raw.get("args"));
        match args.iter().position(|a| a == "--account").and_then(|i| args.get(i + 1)) {
            Some(a) => parts.push(format!("stdio, account \"{a}\"")),
            None => parts.push("stdio".into()),
        }
    }
    if let Some(k) = secret_in(&f.raw) {
        parts.push(format!("key {}", last4(&k)));
    }
    if parts.is_empty() {
        what.to_string()
    } else {
        format!("{what} ({})", parts.join(", "))
    }
}

/// A secret an entry carries, if it does: a bearer header, or a key or token in its environment.
pub fn secret_in(entry: &Value) -> Option<String> {
    let headers = entry.get("headers").and_then(Value::as_object);
    for (k, v) in headers.into_iter().flatten() {
        if k.eq_ignore_ascii_case("authorization") || k.to_ascii_lowercase().contains("key") || k.to_ascii_lowercase().contains("token") {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                return Some(s.strip_prefix("Bearer ").or_else(|| s.strip_prefix("bearer ")).unwrap_or(s).trim().to_string());
            }
        }
    }
    let env = entry.get("env").and_then(Value::as_object);
    for (k, v) in env.into_iter().flatten() {
        let k = k.to_ascii_uppercase();
        if k.contains("TOKEN") || k.contains("KEY") || k.contains("SECRET") {
            if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
                return Some(s.to_string());
            }
        }
    }
    None
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// What a scan found, and what it couldn't read (said, never guessed at).
#[derive(Debug, Default)]
pub struct Scan {
    pub found: Vec<Found>,
    pub unread: Vec<String>,
}

/// Every Unbrowse entry and file on the machine, read-only (module doc).
pub fn scan(m: &Machine) -> Scan {
    let mut s = Scan::default();
    claude_code(m, &mut s);
    claude_plugins(m, &mut s);
    codex(m, &mut s);
    let servers = |host: Host, file: PathBuf, keys: &[&str], s: &mut Scan| json_servers(host, &file, keys, &m.node, s);
    servers(Host::Cursor, m.home.join(".cursor").join("mcp.json"), &["mcpServers"], &mut s);
    for dir in m.vscode_user_dirs() {
        servers(Host::VsCode, dir.join("mcp.json"), &["servers"], &mut s);
        servers(Host::VsCode, dir.join("settings.json"), &["mcp", "servers"], &mut s);
    }
    servers(Host::Gemini, m.home.join(".gemini").join("settings.json"), &["mcpServers"], &mut s);
    let gemini_ext = m.home.join(".gemini").join("extensions").join("unbrowse").join("gemini-extension.json");
    servers(Host::Gemini, gemini_ext, &["mcpServers"], &mut s);
    servers(Host::Zed, m.config_home().join("zed").join("settings.json"), &["context_servers"], &mut s);
    files(m, &mut s);
    s
}

fn push_servers(host: Host, scope: Scope, file: &Path, servers: Option<&Map<String, Value>>, node: &str, s: &mut Scan) {
    for (name, raw) in servers.into_iter().flatten() {
        if is_our_name(name) || (host != Host::ClaudeCode && name == "mcp-server-unbrowse") {
            s.found.push(Found { host, scope: scope.clone(), name: name.clone(), kind: classify(raw, node), raw: raw.clone(), file: file.to_path_buf() });
        }
    }
}

/// Claude Code: user scope (`mcpServers`) and every project's local scope (`projects[<path>].mcpServers`).
fn claude_code(m: &Machine, s: &mut Scan) {
    let file = m.claude_json();
    if !file.exists() {
        return;
    }
    let Some(cfg) = read_json(&file) else {
        s.unread.push(format!("{} isn't JSON this could read", file.display()));
        return;
    };
    push_servers(Host::ClaudeCode, Scope::User, &file, cfg.get("mcpServers").and_then(Value::as_object), &m.node, s);
    for (project, p) in cfg.get("projects").and_then(Value::as_object).into_iter().flatten() {
        push_servers(Host::ClaudeCode, Scope::Local(PathBuf::from(project)), &file, p.get("mcpServers").and_then(Value::as_object), &m.node, s);
        let shared = Path::new(project).join(".mcp.json");
        if let Some(v) = read_json(&shared) {
            push_servers(Host::ClaudeCode, Scope::Project(PathBuf::from(project)), &shared, v.get("mcpServers").and_then(Value::as_object), &m.node, s);
        }
    }
}

/// A plugin's `.mcp.json` with its `${NAME}` and `${NAME:-default}` filled in as Claude Code fills them: from the
/// environment, else the default. The old plugin ships `"url": "${UNBROWSE_MCP_URL:-https://unbrowse.ai/mcp}"`.
fn expand(v: &Value) -> Value {
    match v {
        Value::String(s) => {
            let mut out = String::new();
            let mut rest = s.as_str();
            while let Some(at) = rest.find("${") {
                let Some(end) = rest[at..].find('}') else { break };
                out.push_str(&rest[..at]);
                let inner = &rest[at + 2..at + end];
                let (name, default) = inner.split_once(":-").unwrap_or((inner, ""));
                out.push_str(&std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string()));
                rest = &rest[at + end + 1..];
            }
            out.push_str(rest);
            Value::String(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(expand).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), expand(v))).collect()),
        other => other.clone(),
    }
}

/// The Claude plugin `unbrowse@<marketplace>`: Legacy when the MCP entry it ships calls the hosted service.
fn claude_plugins(m: &Machine, s: &mut Scan) {
    let file = m.plugins_json();
    let Some(cfg) = read_json(&file) else { return };
    for (id, installs) in cfg.get("plugins").and_then(Value::as_object).into_iter().flatten() {
        if id.split('@').next() != Some("unbrowse") {
            continue;
        }
        for install in installs.as_array().into_iter().flatten() {
            let scope = match install.get("scope").and_then(Value::as_str) {
                Some("local") => Scope::Local(PathBuf::from(install.get("projectPath").and_then(Value::as_str).unwrap_or(""))),
                Some("project") => Scope::Project(PathBuf::from(install.get("projectPath").and_then(Value::as_str).unwrap_or(""))),
                _ => Scope::User,
            };
            let shipped = install.get("installPath").and_then(Value::as_str).map(|p| Path::new(p).join(".mcp.json")).and_then(|p| read_json(&p));
            let servers = shipped.as_ref().map(|v| v.get("mcpServers").unwrap_or(v)).and_then(Value::as_object);
            let kinds: Vec<Kind> = servers.into_iter().flatten().map(|(_, e)| classify(&expand(e), &m.node)).collect();
            let kind = if kinds.contains(&Kind::Legacy) {
                Kind::Legacy
            } else if kinds.contains(&Kind::Core) {
                Kind::Core
            } else {
                Kind::Unknown
            };
            s.found.push(Found { host: Host::ClaudePlugin, scope, name: id.clone(), kind, raw: install.clone(), file: file.clone() });
        }
    }
}

/// Codex: `[mcp_servers.<name>]` tables in `config.toml`, the same tables `install.sh` matches.
fn codex(m: &Machine, s: &mut Scan) {
    let file = m.codex_toml();
    let Ok(text) = std::fs::read_to_string(&file) else { return };
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
        s.unread.push(format!("{} isn't TOML this could read", file.display()));
        return;
    };
    let Some(servers) = doc.get("mcp_servers").and_then(|i| i.as_table_like()) else { return };
    let mut map = Map::new();
    for (name, item) in servers.iter() {
        map.insert(name.to_string(), toml_item(item));
    }
    push_servers(Host::Codex, Scope::User, &file, Some(&map), &m.node, s);
}

fn toml_value(v: &toml_edit::Value) -> Value {
    match v {
        toml_edit::Value::String(s) => json!(s.value()),
        toml_edit::Value::Integer(i) => json!(i.value()),
        toml_edit::Value::Float(f) => json!(f.value()),
        toml_edit::Value::Boolean(b) => json!(b.value()),
        toml_edit::Value::Datetime(d) => json!(d.value().to_string()),
        toml_edit::Value::Array(a) => Value::Array(a.iter().map(toml_value).collect()),
        toml_edit::Value::InlineTable(t) => Value::Object(t.iter().map(|(k, v)| (k.to_string(), toml_value(v))).collect()),
    }
}

fn toml_item(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::Value(v) => toml_value(v),
        toml_edit::Item::Table(t) => Value::Object(t.iter().map(|(k, v)| (k.to_string(), toml_item(v))).collect()),
        toml_edit::Item::ArrayOfTables(a) => Value::Array(a.iter().map(|t| Value::Object(t.iter().map(|(k, v)| (k.to_string(), toml_item(v))).collect())).collect()),
        toml_edit::Item::None => Value::Null,
    }
}

/// A host keeping its MCP servers in a JSON file, under `keys` (`["mcp", "servers"]` is VS Code's settings).
fn json_servers(host: Host, file: &Path, keys: &[&str], node: &str, s: &mut Scan) {
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        // Settings files may carry comments; one that names Unbrowse and can't be read is said, not skipped quietly.
        if text.contains("unbrowse") {
            s.unread.push(format!("{} names Unbrowse but isn't plain JSON: check it by hand", file.display()));
        }
        return;
    };
    let servers = keys.iter().try_fold(&v, |at, k| at.get(*k)).and_then(Value::as_object);
    push_servers(host, Scope::User, file, servers, node, s);
}

/// The files the old client kept: its sign-in folder and the v1 key in `~/.unbrowse/config.json`. Listed, never
/// changed: a downgrade to 12.5.0 still reads them.
fn files(m: &Machine, s: &mut Scan) {
    let signin = m.old_signin_dir();
    if signin.is_dir() {
        s.found.push(Found { host: Host::Files, scope: Scope::User, name: "sign-in".into(), kind: Kind::Legacy, raw: json!({}), file: signin });
    }
    let v1 = m.home.join(".unbrowse").join("config.json");
    if let Some(cfg) = read_json(&v1) {
        if let Some(key) = cfg.get("api_key").and_then(Value::as_str) {
            s.found.push(Found { host: Host::Files, scope: Scope::User, name: "v1 key".into(), kind: Kind::Legacy, raw: json!({ "api_key": key }), file: v1 });
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A scratch home, removed when dropped.
    pub struct Home(pub PathBuf);
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub fn home(name: &str) -> Home {
        let d = std::env::temp_dir().join(format!("unb-legacy-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Home(d)
    }

    pub fn machine(h: &Home) -> Machine {
        Machine { home: h.0.clone(), claude_config_dir: None, codex_home: None, unbrowse_config_dir: None, xdg_config_home: None, node: "http://127.0.0.1:7788".into(), programs: vec![] }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn only(s: &Scan, host: Host) -> Vec<(&str, Kind, &Scope)> {
        s.found.iter().filter(|f| f.host == host).map(|f| (f.name.as_str(), f.kind, &f.scope)).collect()
    }

    /// P1: the 12.x CLI's `unbrowse mcp add`, stdio in Claude Code (`node …/dist/cli.js mcp --account`, `npx -y
    /// unbrowse mcp`) and in Codex.
    #[test]
    fn p1_the_old_clis_stdio_entries_are_legacy() {
        let h = home("p1");
        write(
            &h.0.join(".claude.json"),
            &json!({ "mcpServers": {
                "unbrowse": { "type": "stdio", "command": "npx", "args": ["-y", "unbrowse", "mcp"] },
                "unbrowse-work": { "type": "stdio", "command": "node", "args": ["/usr/lib/node_modules/unbrowse/dist/cli.js", "mcp", "--account", "work"], "env": { "UNBROWSE_CONFIG_DIR": "/home/a/.config/unbrowse" } },
                "unbrowse-pinned": { "command": "npx", "args": ["-y", "unbrowse@12.5.0", "mcp", "--base-url", "https://unbrowse.ai"] },
                "other": { "command": "unbrowse", "args": ["mcp"] }
            }})
            .to_string(),
        );
        write(&h.0.join(".codex/config.toml"), "model = \"o3\"\n\n[mcp_servers.unbrowse]\ncommand = \"npx\"\nargs = [\"-y\", \"unbrowse\", \"mcp\"]\n\n[mcp_servers.unbrowse.env]\nUNBROWSE_SHARED_SIGNIN = \"1\"\n\n[mcp_servers.github]\ncommand = \"gh-mcp\"\n");
        let s = scan(&machine(&h));
        let mut claude = only(&s, Host::ClaudeCode);
        claude.sort_by_key(|f| f.0);
        assert_eq!(claude, [("unbrowse", Kind::Legacy, &Scope::User), ("unbrowse-pinned", Kind::Legacy, &Scope::User), ("unbrowse-work", Kind::Legacy, &Scope::User)], "a name not ours is never listed");
        assert_eq!(only(&s, Host::Codex), [("unbrowse", Kind::Legacy, &Scope::User)]);
        let work = s.found.iter().find(|f| f.name == "unbrowse-work").unwrap();
        assert_eq!(describe(work), "hosted (stdio, account \"work\")");
    }

    /// P2: the site's, `install.sh`'s and the keys page's http entry on unbrowse.ai (any of its names), with a
    /// `ub_live` bearer header; the plan names the key by its last 4 characters only.
    #[test]
    fn p2_a_hosted_http_entry_is_legacy_and_shown_by_its_last_4() {
        let h = home("p2");
        write(
            &h.0.join(".claude.json"),
            &json!({ "mcpServers": {
                "unbrowse": { "type": "http", "url": "https://unbrowse.ai/mcp?ref=keys", "headers": { "Authorization": "Bearer ub_live_0123456789abcdefa1f3" } },
                "unbrowse-v3": { "type": "http", "url": "https://v3.unbrowse.ai/mcp" },
                "unbrowse-api": { "type": "sse", "url": "https://API.unbrowse.ai/mcp" }
            }})
            .to_string(),
        );
        let s = scan(&machine(&h));
        assert!(only(&s, Host::ClaudeCode).iter().all(|f| f.1 == Kind::Legacy), "{:?}", only(&s, Host::ClaudeCode));
        let main = s.found.iter().find(|f| f.name == "unbrowse").unwrap();
        let said = describe(main);
        assert_eq!(said, "hosted (https://unbrowse.ai/mcp, key …a1f3)");
        assert!(!said.contains("ub_live") && !said.contains("ref="), "{said}");
    }

    /// P3: the old marketplace's plugin, whose `.mcp.json` calls the hosted service, is Legacy; the same plugin id
    /// shipping this node's bridge is Core.
    #[test]
    fn p3_the_old_plugin_is_legacy_and_the_new_one_core() {
        let h = home("p3");
        let old = h.0.join(".claude/plugins/cache/unbrowse/unbrowse/12.5.0");
        let new = h.0.join(".claude/plugins/cache/unbrowse/unbrowse/13.0.0");
        // The `.mcp.json` the old marketplace's plugin 12.5.0 really ships (unbrowse-ai/unbrowse 0b9123a8).
        write(&old.join(".mcp.json"), &json!({ "mcpServers": { "unbrowse": { "type": "http", "url": "${UNBROWSE_MCP_URL:-https://unbrowse.ai/mcp}", "headersHelper": "${CLAUDE_PLUGIN_ROOT}/scripts/headers.sh" } } }).to_string());
        write(&new.join(".mcp.json"), &json!({ "unbrowse": { "command": "unbrowse", "args": ["mcp", "--agent", "first"] } }).to_string());
        let installs = |path: &Path| json!({ "version": 2, "plugins": { "unbrowse@unbrowse": [{ "scope": "user", "installPath": path, "version": "x" }], "octopus@octopus": [{ "scope": "user", "installPath": "/x" }] } });
        write(&h.0.join(".claude/plugins/installed_plugins.json"), &installs(&old).to_string());
        assert_eq!(only(&scan(&machine(&h)), Host::ClaudePlugin), [("unbrowse@unbrowse", Kind::Legacy, &Scope::User)]);
        write(&h.0.join(".claude/plugins/installed_plugins.json"), &installs(&new).to_string());
        assert_eq!(only(&scan(&machine(&h)), Host::ClaudePlugin), [("unbrowse@unbrowse", Kind::Core, &Scope::User)]);
    }

    /// P4: the Cursor and VS Code deeplinks' entries.
    #[test]
    fn p4_cursor_and_vscode_deeplink_entries_are_legacy() {
        let h = home("p4");
        write(&h.0.join(".cursor/mcp.json"), &json!({ "mcpServers": { "unbrowse": { "url": "https://unbrowse.ai/mcp" } } }).to_string());
        write(&h.0.join(".config/Code/User/mcp.json"), &json!({ "servers": { "unbrowse": { "type": "http", "url": "https://www.unbrowse.ai/mcp" } } }).to_string());
        write(&h.0.join(".config/Code/User/settings.json"), "// comments make this JSONC\n{ \"mcp\": { \"servers\": { \"unbrowse\": { \"url\": \"https://unbrowse.ai/mcp\" } } } }");
        let s = scan(&machine(&h));
        assert_eq!(only(&s, Host::Cursor), [("unbrowse", Kind::Legacy, &Scope::User)]);
        assert_eq!(only(&s, Host::VsCode), [("unbrowse", Kind::Legacy, &Scope::User)]);
        assert_eq!(s.unread.len(), 1, "a settings file naming Unbrowse that isn't plain JSON is said: {:?}", s.unread);
    }

    /// P5: Gemini's extension and settings, Zed's context servers (grok-build and Cline keep the same JSON shape).
    #[test]
    fn p5_gemini_and_zed_entries_are_legacy() {
        let h = home("p5");
        write(&h.0.join(".gemini/extensions/unbrowse/gemini-extension.json"), &json!({ "name": "unbrowse", "mcpServers": { "unbrowse": { "command": "npx", "args": ["-y", "unbrowse@12.5.0", "mcp"] } } }).to_string());
        write(&h.0.join(".gemini/settings.json"), &json!({ "mcpServers": { "mcp-server-unbrowse": { "httpUrl": "https://unbrowse.ai/mcp" } } }).to_string());
        write(&h.0.join(".config/zed/settings.json"), &json!({ "context_servers": { "unbrowse": { "command": { "path": "npx", "args": ["-y", "unbrowse", "mcp"] } }, "unbrowse-zed": { "command": { "path": "/opt/unb", "args": ["mcp", "--agent", "2"] } } } }).to_string());
        let s = scan(&machine(&h));
        let mut gemini = only(&s, Host::Gemini);
        gemini.sort_by_key(|f| f.0);
        assert_eq!(gemini, [("mcp-server-unbrowse", Kind::Legacy, &Scope::User), ("unbrowse", Kind::Legacy, &Scope::User)]);
        let mut zed = only(&s, Host::Zed);
        zed.sort_by_key(|f| f.0);
        assert_eq!(zed, [("unbrowse", Kind::Legacy, &Scope::User), ("unbrowse-zed", Kind::Core, &Scope::User)], "Zed's command is an object");
    }

    /// P6: the v1 CLI's key in `~/.unbrowse/config.json` and the 12.x sign-in folder: found, shown by the key's last
    /// 4 characters, and kept.
    #[test]
    fn p6_the_v1_key_and_old_signin_are_found_and_kept() {
        let h = home("p6");
        write(&h.0.join(".unbrowse/config.json"), &json!({ "api_key": format!("ubr_{}", "ab".repeat(24)) }).to_string());
        write(&h.0.join(".config/unbrowse/cli.json"), "{}");
        let s = scan(&machine(&h));
        let files: Vec<&Found> = s.found.iter().filter(|f| f.host == Host::Files).collect();
        assert_eq!(files.len(), 2);
        let key = files.iter().find(|f| f.name == "v1 key").unwrap();
        assert!(describe(key).starts_with("v1 key …abab in "), "{}", describe(key));
        assert!(!describe(key).contains("ubr_"));
    }

    /// Unknown: a fork or another org's proxy named `unbrowse…` is listed as not ours; this node's own entries are Core.
    #[test]
    fn an_entry_not_ours_is_unknown_and_the_nodes_own_is_core() {
        let h = home("unknown");
        write(
            &h.0.join(".claude.json"),
            &json!({ "mcpServers": {
                "unbrowse-acme": { "type": "http", "url": "https://mcp.acme.example/unbrowse" },
                "unbrowse-fork": { "command": "/opt/fork/bin/serve", "args": ["--stdio"] },
                "unbrowse-brain": { "type": "http", "url": "https://unbrowse-brain.example.workers.dev/mcp", "headers": { "Authorization": "Bearer x" } },
                "unbrowse": { "type": "http", "url": "http://127.0.0.1:7788/mcp", "headers": { "Authorization": "Bearer unb_tok" } },
                "unbrowse-next": { "command": "/opt/unb", "args": ["mcp", "--agent", "first"], "env": { "UNBROWSE_NODE": "http://127.0.0.1:7788" } },
                "unbrowsefoo": { "url": "https://unbrowse.ai/mcp" }
            }})
            .to_string(),
        );
        let s = scan(&machine(&h));
        let mut got = only(&s, Host::ClaudeCode);
        got.sort_by_key(|f| f.0);
        assert_eq!(
            got,
            [("unbrowse", Kind::Core, &Scope::User), ("unbrowse-acme", Kind::Unknown, &Scope::User), ("unbrowse-brain", Kind::Unknown, &Scope::User), ("unbrowse-fork", Kind::Unknown, &Scope::User), ("unbrowse-next", Kind::Core, &Scope::User)],
            "`unbrowsefoo` isn't one of our names"
        );
    }

    /// Local scope: an entry under `projects[<path>].mcpServers`, which `claude mcp remove --scope user` never sees,
    /// is found with its project; a project's checked-in `.mcp.json` is found as project scope (reported only).
    #[test]
    fn a_local_scope_entry_is_found_with_its_project() {
        let h = home("local");
        let proj = h.0.join("work/app");
        write(&proj.join(".mcp.json"), &json!({ "mcpServers": { "unbrowse": { "type": "http", "url": "https://unbrowse.ai/mcp" } } }).to_string());
        write(&h.0.join(".claude.json"), &json!({ "projects": { proj.display().to_string(): { "mcpServers": { "unbrowse": { "type": "http", "url": "https://v3.unbrowse.ai/mcp", "headers": { "Authorization": "Bearer ub_live_zzzz9999" } } } } } }).to_string());
        let s = scan(&machine(&h));
        assert_eq!(only(&s, Host::ClaudeCode), [("unbrowse", Kind::Legacy, &Scope::Local(proj.clone())), ("unbrowse", Kind::Legacy, &Scope::Project(proj.clone()))]);
    }

    /// `CLAUDE_CONFIG_DIR` and `CODEX_HOME` move where the hosts keep their config, and the scan follows them.
    #[test]
    fn the_scan_follows_each_hosts_config_dir() {
        let h = home("dirs");
        write(&h.0.join("cc/.claude.json"), &json!({ "mcpServers": { "unbrowse": { "url": "https://unbrowse.ai/mcp" } } }).to_string());
        write(&h.0.join("cx/config.toml"), "[mcp_servers.unbrowse]\nurl = \"https://unbrowse.ai/mcp\"\n");
        let m = Machine { claude_config_dir: Some(h.0.join("cc")), codex_home: Some(h.0.join("cx")), ..machine(&h) };
        let s = scan(&m);
        assert_eq!(only(&s, Host::ClaudeCode).len(), 1);
        assert_eq!(only(&s, Host::Codex), [("unbrowse", Kind::Legacy, &Scope::User)]);
    }

    #[test]
    fn our_names_are_unbrowse_and_unbrowse_dash_an_account() {
        for n in ["unbrowse", "unbrowse-work", "unbrowse-a_b-1"] {
            assert!(is_our_name(n), "{n}");
        }
        for n in ["unbrowse-", "unbrowsefoo", "my-unbrowse", "unbrowse-a b", "unbrowse.x"] {
            assert!(!is_our_name(n), "{n}");
        }
    }

    /// An entry in Codex's tables keeps its numbers, flags, dates and nested tables as JSON, and the machine this runs on
    /// is read from the environment the hosts use; each host has its name.
    #[test]
    fn a_codex_entry_keeps_every_kind_of_value_it_holds() {
        let h = home("codex-values");
        write(
            &h.0.join(".codex/config.toml"),
            "[mcp_servers.unbrowse]\ncommand = \"unbrowse\"\nargs = [\"mcp\", \"--agent\", \"first\"]\nstartup_timeout_sec = 20\nratio = 1.5\nenabled = true\nsince = 2026-01-01T00:00:00Z\nenv = { A = \"1\" }\n\n[[mcp_servers.unbrowse.extra]]\nk = 1\n",
        );
        let s = scan(&machine(&h));
        let f = s.found.iter().find(|f| f.host == Host::Codex).expect("the entry");
        assert_eq!(f.kind, Kind::Core);
        assert_eq!((f.raw["startup_timeout_sec"].clone(), f.raw["ratio"].clone(), f.raw["enabled"].clone()), (json!(20), json!(1.5), json!(true)));
        assert_eq!((f.raw["since"].as_str().map(|d| d.starts_with("2026-01-01")), f.raw["env"]["A"].clone(), f.raw["extra"][0]["k"].clone()), (Some(true), json!("1"), json!(1)));
        let labels: Vec<&str> = [Host::ClaudeCode, Host::ClaudePlugin, Host::Codex, Host::Cursor, Host::VsCode, Host::Gemini, Host::Zed, Host::Files].iter().map(|h| h.label()).collect();
        assert_eq!(labels, ["Claude Code", "Claude plugin", "Codex", "Cursor", "VS Code", "Gemini", "Zed", "Files"]);
        let here = Machine::here("http://127.0.0.1:9999");
        assert_eq!(here.node, "http://127.0.0.1:9999");
        let home_var = std::env::var_os("HOME").filter(|v| !v.is_empty()).or_else(|| std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()));
        assert_eq!(here.home, home_var.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")));
    }
}

#[cfg(test)]
#[path = "legacy_cov_tests.rs"]
mod legacy_cov_tests;
