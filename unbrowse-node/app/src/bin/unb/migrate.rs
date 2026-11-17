//! `unbrowse connect` on a machine an older Unbrowse set up: what it found is shown first (`Plan::text`), then, in this
//! order, the old entries are backed up (`~/.unbrowse/migration/<time>/`), the new entry is checked to answer
//! (`initialize` and `tools/list`), added as `unbrowse-next`, the old entries are removed one by one by what they are
//! (an entry that isn't ours is never touched), and `unbrowse-next` is renamed `unbrowse`. A failure before the removes
//! leaves every old entry as it was. `--undo [<time>]` puts the backup back; `--undo --purge` then deletes it.
//!
//! Claude Code is changed only through its `claude` CLI, never by editing `~/.claude.json`, which a running Claude Code
//! rewrites. The new entry names the agent (`unb mcp --agent first`), never its token, so no command line, plan or
//! config written here holds one.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::legacy::{self, Found, Host, Kind, Machine, Scope};

/// What `connect` was asked to do.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Opts {
    pub index: Option<u32>,
    pub dry_run: bool,
    pub yes: bool,
    /// `--undo`, with the backup's time if one was named.
    pub undo: Option<Option<String>>,
    pub purge: bool,
}

pub const USAGE: &str = "usage: unbrowse connect [agent index] [--dry-run] [--yes]   |   unbrowse connect --undo [<time>] [--purge]";

pub fn parse(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut rest = args.iter().peekable();
    while let Some(a) = rest.next() {
        match a.as_str() {
            "--dry-run" | "-n" => o.dry_run = true,
            "--yes" | "-y" => o.yes = true,
            "--purge" => o.purge = true,
            "--undo" => o.undo = Some(rest.next_if(|n| !n.starts_with('-')).cloned()),
            n if o.index.is_none() && n.parse::<u32>().is_ok() => o.index = n.parse().ok(),
            _ => return Err(USAGE.into()),
        }
    }
    if o.purge && o.undo.is_none() {
        return Err(format!("--purge goes with --undo\n{USAGE}"));
    }
    Ok(o)
}

/// Whether connect goes ahead once the plan is shown.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    /// Show the plan and change nothing: a dry run, or a change asked for where nobody can answer (an agent's shell
    /// has no terminal, R-S1), so the owner decides.
    OnlyShow,
    /// Ask the owner at the terminal.
    Ask,
    Go,
}

pub fn next(o: &Opts, changes: bool, terminal: bool) -> Next {
    match (o.dry_run, changes && !o.yes, terminal) {
        (true, _, _) | (false, true, false) => Next::OnlyShow,
        (false, true, true) => Next::Ask,
        (false, false, _) => Next::Go,
    }
}

/// What changes a machine: the `claude` CLI, and starting an entry's program to ask it what it has.
pub trait Hosts {
    /// Runs `claude <args>` (in `cwd`, for a local-scope entry, which Claude keys by its project folder).
    fn claude(&mut self, args: &[String], cwd: Option<&Path>) -> Result<(), String>;
    /// Starts the entry's program, asks it `initialize` then `tools/list`, and says how many tools it has.
    fn verify(&mut self, entry: &Value) -> Result<usize, String>;
}

/// The entry this node is reached by: `unb mcp --agent <index|first>`, the node's address in its environment.
pub fn entry(base: &str, index: Option<u32>, unb: &Path) -> Value {
    let which = index.map(|i| i.to_string()).unwrap_or_else(|| "first".into());
    json!({ "type": "stdio", "command": unb.display().to_string(), "args": ["mcp", "--agent", which], "env": { "UNBROWSE_NODE": base } })
}

/// `claude mcp add` for `entry` under `name`: the program and its words, never a token.
pub fn add_args(name: &str, entry: &Value) -> Vec<String> {
    let mut args: Vec<String> = ["mcp", "add", "--scope", "user", name].map(String::from).to_vec();
    for (k, v) in entry["env"].as_object().into_iter().flatten() {
        args.push("--env".into());
        args.push(format!("{k}={}", v.as_str().unwrap_or_default()));
    }
    args.push("--".into());
    args.push(entry["command"].as_str().unwrap_or("unb").to_string());
    args.extend(entry["args"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)));
    args
}

fn remove_args(f: &Found) -> Vec<String> {
    ["mcp", "remove", "--scope", f.scope.word(), f.name.as_str()].map(String::from).to_vec()
}

fn same_entry(a: &Value, b: &Value) -> bool {
    a.get("command") == b.get("command") && a.get("args") == b.get("args") && a.get("env") == b.get("env") && a.get("url") == b.get("url")
}

const TEMP: &str = "unbrowse-next";

/// What connect will do, worked out before anything is written.
pub struct Plan {
    pub found: Vec<Found>,
    pub unread: Vec<String>,
    pub entry: Value,
    /// The backup's folder: `<node home>/migration/<UTC time>`.
    pub backup: PathBuf,
    pub machine: Machine,
}

/// What a found entry gets: replaced, uninstalled, edited by the owner (with the edit to make), or left as is.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Replace,
    Uninstall,
    Already,
    YouEdit(String),
    Keep,
    NotOurs,
}

impl Plan {
    pub fn new(machine: Machine, entry: Value, backup: PathBuf) -> Plan {
        let s = legacy::scan(&machine);
        Plan { found: s.found, unread: s.unread, entry, backup, machine }
    }

    pub fn action(&self, f: &Found) -> Action {
        let edit = || {
            let mut short = serde_json::Map::new();
            short.insert("command".into(), json!("unbrowse"));
            short.insert("args".into(), self.entry["args"].clone());
            Value::Object(short).to_string()
        };
        match (f.host, f.kind, &f.scope) {
            (_, Kind::Unknown, _) => Action::NotOurs,
            (Host::Files, _, _) => Action::Keep,
            (Host::ClaudeCode, _, Scope::Project(p)) => match f.kind {
                Kind::Legacy => Action::YouEdit(format!("remove \"{}\" from {}", f.name, p.join(".mcp.json").display())),
                _ => Action::Keep,
            },
            (Host::ClaudeCode, Kind::Core, Scope::User) if f.name == "unbrowse" && same_entry(&f.raw, &self.entry) => Action::Already,
            // This node's entry for another agent (`unbrowse-<n>`) stays: only `unbrowse` and connect's own temporary
            // name are this run's to replace.
            (Host::ClaudeCode, Kind::Core, _) if f.name != "unbrowse" && f.name != TEMP => Action::Keep,
            (Host::ClaudeCode, _, _) => Action::Replace,
            (Host::ClaudePlugin, Kind::Legacy, _) => Action::Uninstall,
            (Host::ClaudePlugin, _, _) => Action::Keep,
            (Host::Codex, Kind::Legacy, _) => Action::YouEdit(format!(
                "replace [mcp_servers.{}] in {} with: command = \"unbrowse\", args = [\"mcp\", \"--agent\", \"{}\"]",
                f.name,
                f.file.display(),
                self.entry["args"][2].as_str().unwrap_or("first")
            )),
            (_, Kind::Legacy, _) => Action::YouEdit(format!("replace \"{}\" in {} with: {}", f.name, f.file.display(), edit())),
            _ => Action::Keep,
        }
    }

    fn with(&self, a: fn(&Action) -> bool) -> Vec<&Found> {
        self.found.iter().filter(|f| a(&self.action(f))).collect()
    }

    /// Whether going ahead removes or replaces anything (only adding needs no yes).
    pub fn changes(&self) -> bool {
        !self.with(|a| matches!(a, Action::Replace | Action::Uninstall)).is_empty()
    }

    pub fn moving(&self) -> bool {
        self.found.iter().any(|f| f.kind == Kind::Legacy)
    }

    /// What connect shows before it changes anything: no secret, only a key's last 4 characters.
    pub fn text(&self) -> String {
        let mut t = String::new();
        t.push_str(if self.moving() { "Unbrowse is moving this machine from the hosted service to your own node.\n\n" } else { "Unbrowse is connecting this machine's agents to your own node.\n\n" });
        let listed: Vec<&Found> = self.found.iter().filter(|f| f.host != Host::Files).collect();
        if listed.is_empty() {
            t.push_str("Found: no Unbrowse entry in any agent's settings.\n");
        } else {
            t.push_str("Found:\n");
            for f in &listed {
                let to = match self.action(f) {
                    Action::Replace => match &f.scope {
                        Scope::Local(p) => format!("will be replaced (project {})", p.display()),
                        _ => "will be replaced".into(),
                    },
                    Action::Uninstall => "will be uninstalled".into(),
                    Action::Already => "already set up".into(),
                    Action::YouEdit(e) => format!("you edit: {e}"),
                    Action::Keep => "left as is".into(),
                    Action::NotOurs => format!("not ours, left as is (to remove it yourself: {})", match f.host {
                        Host::ClaudeCode => format!("claude mcp remove --scope {} {}", f.scope.word(), f.name),
                        Host::ClaudePlugin => format!("claude plugin uninstall {} --scope {}", f.name, f.scope.word()),
                        _ => format!("remove \"{}\" from {}", f.name, f.file.display()),
                    }),
                };
                t.push_str(&format!("  {:<14}{:<18}{}  → {to}\n", f.host.label(), f.name, legacy::describe(f)));
            }
        }
        for u in &self.unread {
            t.push_str(&format!("  Couldn't read: {u}\n"));
        }
        let kept: Vec<String> = self.found.iter().filter(|f| f.host == Host::Files).map(legacy::describe).collect();
        t.push_str(&format!(
            "\nKept as is: {}your hosted account and saved logins.\n",
            kept.iter().map(|k| format!("{k}, ")).collect::<String>()
        ));
        t.push_str(&format!("Backup: {}/\n", self.backup.display()));
        t
    }
}

/// The time a backup is named by, in UTC: `2026-11-16T09-12-03Z`, which sorts as it happened.
pub fn stamp(unix: u64) -> String {
    let (days, secs) = ((unix / 86_400) as i64, unix % 86_400);
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}Z", secs / 3600, secs / 60 % 60, secs % 60)
}

const README: &str = "This folder holds what `unbrowse connect` replaced, so `unbrowse connect --undo` can put it back.\n\
entries.json and the copies beside it hold the old entries exactly as your agents had them, keys and headers included:\n\
they are secrets. Keep this folder private. `unbrowse connect --undo --purge` puts them back and deletes this folder.\n\
Nothing here is read by Unbrowse's reports or telemetry.\n";

fn found_json(f: &Found) -> Value {
    let project = match &f.scope {
        Scope::Local(p) | Scope::Project(p) => json!(p),
        Scope::User => Value::Null,
    };
    json!({ "host": f.host.label(), "scope": f.scope.word(), "project": project, "name": f.name, "raw": f.raw, "file": f.file })
}

fn save(path: &Path, bytes: &[u8]) -> Result<(), String> {
    unbrowse_files::private::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// The record of a run: what was replaced and what was added, rewritten as each step lands so `--undo` knows.
struct Record {
    dir: PathBuf,
    replaced: Vec<Value>,
    plugins: Vec<Value>,
    added: Vec<String>,
}

impl Record {
    fn save(&self) -> Result<(), String> {
        let v = json!({ "version": 1, "replaced": self.replaced, "plugins": self.plugins, "added": self.added });
        save(&self.dir.join("entries.json"), serde_json::to_string_pretty(&v).unwrap_or_default().as_bytes())
    }
}

/// Writes the backup: the record, whole copies of each host's config it may change, the plan, and a README.
fn backup(plan: &Plan) -> Result<Record, String> {
    let dir = plan.backup.clone();
    let replaced = plan.with(|a| *a == Action::Replace).into_iter().map(found_json).collect();
    let plugins = plan.with(|a| *a == Action::Uninstall).into_iter().map(found_json).collect();
    let r = Record { dir: dir.clone(), replaced, plugins, added: Vec::new() };
    r.save()?;
    for (from, to) in [(plan.machine.claude_json(), "claude.json"), (plan.machine.plugins_json(), "installed_plugins.json"), (plan.machine.codex_toml(), "codex-config.toml")] {
        if let Ok(bytes) = std::fs::read(&from) {
            save(&dir.join(to), &bytes)?;
        }
    }
    save(&dir.join("plan.txt"), plan.text().as_bytes())?;
    save(&dir.join("README"), README.as_bytes())?;
    Ok(r)
}

fn append(dir: &Path, lines: &[String]) {
    let path = dir.join("plan.txt");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    text.push('\n');
    for l in lines {
        text.push_str(l);
        text.push('\n');
    }
    let _ = save(&path, text.as_bytes());
}

/// Carries the plan out (module doc). Says each step's outcome on `out`; an error is what went wrong, with whether
/// anything changed.
pub fn apply(plan: &Plan, hosts: &mut dyn Hosts, out: &mut dyn Write) -> Result<(), String> {
    let mut rec = backup(plan).map_err(|e| format!("✗ Couldn't write the backup ({e}). Nothing was changed."))?;
    let tools = hosts.verify(&plan.entry).map_err(|why| {
        format!("✗ The new entry didn't answer ({why}). Nothing was removed; your old Unbrowse still works. Open the Unbrowse app, check the node is running and the agent approved, then run unbrowse connect again.")
    })?;
    let mut said: Vec<String> = Vec::new();
    let mut stuck = false;
    let user = |name: &str| plan.found.iter().find(|f| f.host == Host::ClaudeCode && f.scope == Scope::User && f.name == name);
    let already = user("unbrowse").is_some_and(|f| plan.action(f) == Action::Already);
    if already && !plan.changes() {
        said.push(format!("✓ Claude Code: unbrowse → your node, already set up (checked: {tools} tools)"));
    } else {
        if !already {
            // An earlier run's `unbrowse-next` that stopped short is replaced like any of ours; one that isn't ours is
            // in the way.
            if let Some(f) = user(TEMP) {
                if plan.action(f) != Action::Replace {
                    return Err(format!("✗ An entry named {TEMP} that isn't Unbrowse's is in the way. Nothing was changed. Remove or rename it, then run unbrowse connect again."));
                }
                hosts.claude(&remove_args(f), None).map_err(|e| format!("✗ Couldn't remove the earlier {TEMP} ({e}). Nothing else was changed."))?;
            }
            hosts.claude(&add_args(TEMP, &plan.entry), None).map_err(|e| format!("✗ Claude Code didn't take the new entry ({e}). Nothing was removed; your old Unbrowse still works."))?;
            rec.added.push(TEMP.into());
            rec.save()?;
        }
        let (mut removed, mut failed) = (0usize, Vec::new());
        let mut user_name_free = true;
        for f in plan.with(|a| *a == Action::Replace) {
            if f.scope == Scope::User && f.name == TEMP {
                continue;
            }
            let cwd = match &f.scope {
                Scope::Local(p) if !p.is_dir() => {
                    failed.push(format!("! Claude Code: \"{}\" in project {} wasn't removed (the folder is gone); remove it there with: claude mcp remove --scope local {}", f.name, p.display(), f.name));
                    continue;
                }
                Scope::Local(p) => Some(p.as_path()),
                _ => None,
            };
            match hosts.claude(&remove_args(f), cwd) {
                Ok(()) => removed += 1,
                Err(e) => {
                    if f.scope == Scope::User && f.name == "unbrowse" {
                        user_name_free = false;
                    }
                    failed.push(format!("! Claude Code: couldn't remove \"{}\" ({e}); remove it with: claude mcp remove --scope {} {}", f.name, f.scope.word(), f.name));
                }
            }
        }
        if user("unbrowse").is_some_and(|f| plan.action(f) == Action::NotOurs) {
            user_name_free = false;
        }
        let mut uninstalled = 0usize;
        for p in plan.with(|a| *a == Action::Uninstall) {
            match hosts.claude(&["plugin", "uninstall", p.name.as_str(), "--scope", p.scope.word()].map(String::from), None) {
                Ok(()) => uninstalled += 1,
                Err(e) => failed.push(format!("! Claude plugin: couldn't uninstall {} ({e}); run: claude plugin uninstall {}", p.name, p.name)),
            }
        }
        let name = if already {
            "unbrowse"
        } else if user_name_free && hosts.claude(&add_args("unbrowse", &plan.entry), None).is_ok() {
            rec.added.push("unbrowse".into());
            rec.save()?;
            match hosts.claude(&["mcp", "remove", "--scope", "user", TEMP].map(String::from), None) {
                Ok(()) => {
                    rec.added.retain(|a| a != TEMP);
                    rec.save()?;
                }
                Err(e) => failed.push(format!("! Claude Code: couldn't remove the temporary {TEMP} ({e}); it is the same as unbrowse: claude mcp remove --scope user {TEMP}")),
            }
            "unbrowse"
        } else {
            failed.push(format!("! Claude Code: your node is set up as \"{TEMP}\": the name unbrowse is still taken"));
            TEMP
        };
        said.push(format!("✓ Claude Code: {name} → your node (checked: {tools} tools)"));
        if removed + uninstalled > 0 {
            let plugin = if uninstalled > 0 { ", uninstalled the old plugin" } else { "" };
            said.push(if removed == 0 { "✓ Uninstalled the old plugin.".into() } else { format!("✓ Removed {removed} old entr{}{plugin}.", if removed == 1 { "y" } else { "ies" }) });
        }
        stuck = !failed.is_empty();
        said.extend(failed);
    }
    for f in &plan.found {
        if let Action::YouEdit(e) = plan.action(f) {
            said.push(format!("! {}: {e}", f.host.label()));
        }
    }
    said.push("Restart Claude Code to use it.".into());
    said.push("Undo: unbrowse connect --undo".into());
    for l in &said {
        let _ = writeln!(out, "{l}");
    }
    append(&rec.dir, &said);
    if stuck {
        return Err("Some old entries are still there; each is named above with the command that removes it.".into());
    }
    Ok(())
}

/// The backups under `root` of runs that changed something, oldest first. A run that found everything set up
/// changed nothing, so it is skipped: `--undo` after `connect` twice undoes the first.
fn backups(root: &Path) -> Vec<String> {
    let changed = |dir: &Path| {
        let rec: Option<Value> = std::fs::read_to_string(dir.join("entries.json")).ok().and_then(|t| serde_json::from_str(&t).ok());
        rec.is_some_and(|r| ["replaced", "plugins", "added"].iter().any(|k| r[*k].as_array().is_some_and(|a| !a.is_empty())))
    };
    let mut names: Vec<String> = std::fs::read_dir(root).into_iter().flatten().flatten().filter(|e| changed(&e.path())).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

/// `connect --undo [<time>]`: removes the entries connect added (only while they are still this node's), puts every
/// replaced entry back exactly (scope, name, transport, headers, env) and reinstalls a removed plugin. `purge` then
/// deletes the backup, the only copy connect kept of the old keys. The restored entry is handed to `claude mcp
/// add-json`, the one way Claude Code takes an entry whole: its own header goes on that command's line while it runs,
/// as when the entry was first added.
pub fn undo(m: &Machine, root: &Path, at: Option<&str>, purge: bool, hosts: &mut dyn Hosts, out: &mut dyn Write) -> Result<(), String> {
    let name = match at {
        Some(t) => t.to_string(),
        None => backups(root).pop().ok_or_else(|| format!("There is no backup in {} to undo.", root.display()))?,
    };
    let dir = root.join(&name);
    let rec: Value = std::fs::read_to_string(dir.join("entries.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).ok_or_else(|| format!("{} has no backup to undo (see `ls {}`).", dir.display(), root.display()))?;
    let now = legacy::scan(m);
    let current = |scope: &str, project: &Value, name: &str| {
        now.found.iter().find(|f| f.host == Host::ClaudeCode && f.name == name && f.scope.word() == scope && match &f.scope {
            Scope::Local(p) => project.as_str() == Some(&p.display().to_string()),
            _ => true,
        })
    };
    let mut failed = Vec::new();
    let mut put_back = 0usize;
    let replaced = rec["replaced"].as_array().cloned().unwrap_or_default();
    let mut ours: Vec<String> = rec["added"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
    ours.extend(replaced.iter().filter(|r| r["scope"] == "user").filter_map(|r| r["name"].as_str().map(str::to_string)));
    ours.sort();
    ours.dedup();
    for n in &ours {
        match current("user", &Value::Null, n) {
            Some(f) if f.kind == Kind::Core && !replaced.iter().any(|r| r["scope"] == "user" && r["name"] == json!(n) && same_entry(&r["raw"], &f.raw)) => {
                if let Err(e) = hosts.claude(&["mcp", "remove", "--scope", "user", n.as_str()].map(String::from), None) {
                    failed.push(format!("! couldn't remove {n} ({e})"));
                }
            }
            _ => {}
        }
    }
    for r in &replaced {
        let (scope, name) = (r["scope"].as_str().unwrap_or("user"), r["name"].as_str().unwrap_or_default());
        if current(scope, &r["project"], name).is_some_and(|f| f.raw == r["raw"]) {
            continue;
        }
        let cwd = r["project"].as_str().map(PathBuf::from);
        if cwd.as_ref().is_some_and(|p| !p.is_dir()) {
            failed.push(format!("! \"{name}\" belonged to project {}, which is gone; it is in {}", r["project"].as_str().unwrap_or(""), dir.join("entries.json").display()));
            continue;
        }
        match hosts.claude(&["mcp", "add-json", "--scope", scope, name, r["raw"].to_string().as_str()].map(String::from), cwd.as_deref()) {
            Ok(()) => put_back += 1,
            Err(e) => failed.push(format!("! couldn't put back \"{name}\" ({e}); it is in {}", dir.join("entries.json").display())),
        }
    }
    for p in rec["plugins"].as_array().into_iter().flatten() {
        let (id, scope) = (p["name"].as_str().unwrap_or_default(), p["scope"].as_str().unwrap_or("user"));
        match hosts.claude(&["plugin", "install", id, "--scope", scope].map(String::from), None) {
            Ok(()) => put_back += 1,
            Err(e) => failed.push(format!("! couldn't reinstall the plugin {id} ({e}); run: claude plugin install {id}")),
        }
    }
    let mut said = vec![format!("✓ Put back {put_back} old entr{} from {}.", if put_back == 1 { "y" } else { "ies" }, dir.display())];
    said.extend(failed.iter().cloned());
    if purge && failed.is_empty() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("put back, but couldn't delete {}: {e}", dir.display()))?;
        said.push(format!("✓ Deleted the backup {} (it held the old keys).", dir.display()));
    } else if purge {
        said.push(format!("Kept the backup {}: not everything was put back.", dir.display()));
    }
    said.push("Restart Claude Code to use them. Your node keeps running.".into());
    for l in &said {
        let _ = writeln!(out, "{l}");
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err("Not everything was put back; each is named above.".into())
    }
}

/// The machine's own `claude`, and an entry's program started for real.
pub struct Real {
    pub claude: PathBuf,
}

impl Real {
    pub fn here() -> Real {
        Real { claude: std::env::var_os("UNBROWSE_CLAUDE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("claude")) }
    }
}

/// How long the new entry has to answer `tools/list`.
const VERIFY_WAIT: std::time::Duration = std::time::Duration::from_secs(90);

impl Hosts for Real {
    fn claude(&mut self, args: &[String], cwd: Option<&Path>) -> Result<(), String> {
        let mut cmd = std::process::Command::new(&self.claude);
        cmd.args(args).stdin(std::process::Stdio::null());
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        let out = cmd.output().map_err(|e| format!("couldn't run {}: {e}", self.claude.display()))?;
        if out.status.success() {
            return Ok(());
        }
        let said = String::from_utf8_lossy(&out.stderr);
        let said = said.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        Err(if said.is_empty() { format!("claude exited {}", out.status) } else { said })
    }

    fn verify(&mut self, entry: &Value) -> Result<usize, String> {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::legacy::tests::{home, machine, Home};

    const SECRET: &str = "ub_live_0123456789abcdef0123456789abcdefa1f3";

    /// Claude Code as its CLI changes `~/.claude.json`, kept in memory over the real file: every command line it was
    /// given is kept, and any `fail` word in one makes that command fail.
    struct Fake {
        file: PathBuf,
        plugins: PathBuf,
        lines: Vec<Vec<String>>,
        fail: Vec<String>,
        tools: Result<usize, String>,
        verified: usize,
    }

    impl Fake {
        fn new(m: &Machine) -> Fake {
            Fake { file: m.claude_json(), plugins: m.plugins_json(), lines: Vec::new(), fail: Vec::new(), tools: Ok(14), verified: 0 }
        }
        fn read(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(&self.file).unwrap_or("{}".into())).unwrap()
        }
        fn servers<'a>(cfg: &'a mut Value, scope: &str, cwd: Option<&Path>) -> &'a mut serde_json::Map<String, Value> {
            let at = if scope == "local" {
                let p = cwd.unwrap().display().to_string();
                &mut cfg["projects"][p]["mcpServers"]
            } else {
                &mut cfg["mcpServers"]
            };
            if !at.is_object() {
                *at = json!({});
            }
            at.as_object_mut().unwrap()
        }
    }

    impl Hosts for Fake {
        fn claude(&mut self, args: &[String], cwd: Option<&Path>) -> Result<(), String> {
            self.lines.push(args.to_vec());
            if args.iter().any(|a| self.fail.contains(a)) {
                return Err("refused".into());
            }
            let mut cfg = self.read();
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            match a.as_slice() {
                ["mcp", "add", "--scope", scope, name, rest @ ..] => {
                    let dash = rest.iter().position(|w| *w == "--").unwrap();
                    let mut env = serde_json::Map::new();
                    for pair in rest[..dash].chunks(2) {
                        let (k, v) = pair[1].split_once('=').unwrap();
                        env.insert(k.into(), json!(v));
                    }
                    let servers = Fake::servers(&mut cfg, scope, cwd);
                    if servers.contains_key(*name) {
                        return Err(format!("MCP server {name} already exists"));
                    }
                    servers.insert(name.to_string(), json!({ "type": "stdio", "command": rest[dash + 1], "args": rest[dash + 2..], "env": env }));
                }
                ["mcp", "add-json", "--scope", scope, name, j] => {
                    Fake::servers(&mut cfg, scope, cwd).insert(name.to_string(), serde_json::from_str(j).unwrap());
                }
                ["mcp", "remove", "--scope", scope, name] => {
                    Fake::servers(&mut cfg, scope, cwd).remove(*name).ok_or_else(|| format!("no server {name}"))?;
                }
                ["plugin", verb, id, ..] => {
                    // Uninstalled plugins are kept beside the list, so an install puts back the same install.
                    let mut list: Value = serde_json::from_str(&std::fs::read_to_string(&self.plugins).unwrap()).unwrap();
                    let aside = self.plugins.with_extension("removed");
                    if *verb == "uninstall" {
                        let gone = list["plugins"].as_object_mut().unwrap().remove(*id).ok_or("not installed")?;
                        std::fs::write(&aside, gone.to_string()).unwrap();
                    } else {
                        list["plugins"][*id] = serde_json::from_str(&std::fs::read_to_string(&aside).unwrap()).unwrap();
                    }
                    std::fs::write(&self.plugins, list.to_string()).unwrap();
                    return Ok(());
                }
                other => panic!("connect ran a claude command the fake doesn't know: {other:?}"),
            }
            std::fs::write(&self.file, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
            Ok(())
        }
        fn verify(&mut self, _: &Value) -> Result<usize, String> {
            self.verified += 1;
            self.tools.clone()
        }
    }

    /// A machine with the hosted service's entries in user and local scope, the old plugin, an entry not ours, and
    /// the v1 key.
    fn old_machine(name: &str) -> (Home, Machine, PathBuf) {
        let h = home(name);
        let proj = h.0.join("work/app");
        std::fs::create_dir_all(&proj).unwrap();
        let plugin = h.0.join(".claude/plugins/cache/unbrowse/unbrowse/12.5.0");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join(".mcp.json"), json!({ "mcpServers": { "unbrowse": { "type": "http", "url": "https://unbrowse.ai/mcp" } } }).to_string()).unwrap();
        std::fs::write(h.0.join(".claude/plugins/installed_plugins.json"), json!({ "version": 2, "plugins": { "unbrowse@unbrowse": [{ "scope": "user", "installPath": plugin }] } }).to_string()).unwrap();
        let cfg = json!({
            "mcpServers": {
                "unbrowse": { "type": "http", "url": "https://unbrowse.ai/mcp", "headers": { "Authorization": format!("Bearer {SECRET}") } },
                "unbrowse-work": { "type": "stdio", "command": "node", "args": ["/usr/lib/node_modules/unbrowse/dist/cli.js", "mcp", "--account", "work"], "env": { "UNBROWSE_CONFIG_DIR": "/x", "UNBROWSE_API_KEY": SECRET } },
                "unbrowse-acme": { "type": "http", "url": "https://mcp.acme.example/u" },
                "github": { "command": "gh-mcp" }
            },
            "projects": { proj.display().to_string(): { "mcpServers": { "unbrowse": { "type": "http", "url": "https://v3.unbrowse.ai/mcp" } } } }
        });
        let m = machine(&h);
        std::fs::write(m.claude_json(), serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
        std::fs::create_dir_all(h.0.join(".unbrowse")).unwrap();
        std::fs::write(h.0.join(".unbrowse/config.json"), json!({ "api_key": format!("ubr_{}", "cd".repeat(24)) }).to_string()).unwrap();
        (h, m, proj)
    }

    fn plan_for(h: &Home, m: &Machine) -> Plan {
        Plan::new(m.clone(), entry("http://127.0.0.1:7788", None, Path::new("/opt/unb")), h.0.join(".unbrowse/migration").join(stamp(1_763_284_323)))
    }

    fn sha(p: &Path) -> Vec<u8> {
        use sha2::Digest;
        sha2::Sha256::digest(std::fs::read(p).unwrap()).to_vec()
    }

    /// B2: a new entry that doesn't answer changes nothing: every old entry, and the whole file, stays byte-identical.
    #[test]
    fn a_failed_verify_leaves_old_entries_byte_identical() {
        let (h, m, _) = old_machine("failed-verify");
        let before = sha(&m.claude_json());
        let mut fake = Fake::new(&m);
        fake.tools = Err("owner hasn't approved this agent".into());
        let mut out = Vec::new();
        let said = apply(&plan_for(&h, &m), &mut fake, &mut out).expect_err("a failed verify fails connect");
        assert!(said.contains("didn't answer (owner hasn't approved this agent)") && said.contains("Nothing was removed"), "{said}");
        assert!(fake.lines.is_empty(), "no claude command ran: {:?}", fake.lines);
        assert_eq!(sha(&m.claude_json()), before);
        // Claude refusing the new entry is the same: nothing was removed.
        let mut fake = Fake::new(&m);
        fake.fail = vec!["unbrowse-next".into()];
        let said = apply(&plan_for(&h, &m), &mut fake, &mut Vec::new()).expect_err("claude refused");
        assert!(said.contains("Nothing was removed"), "{said}");
        assert_eq!(fake.lines.len(), 1, "only the add was tried: {:?}", fake.lines);
        assert_eq!(sha(&m.claude_json()), before);
    }

    /// B2 (R-S2): no token is on a command line connect runs or in what it shows: the old key by its last 4
    /// characters, the new entry by the agent's number.
    #[test]
    fn connect_puts_no_token_on_a_command_line_or_in_plan_output() {
        let (h, m, _) = old_machine("no-token");
        let plan = plan_for(&h, &m);
        let text = plan.text();
        let mut fake = Fake::new(&m);
        let mut out = Vec::new();
        apply(&plan, &mut fake, &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        for said in [&text, &out, &std::fs::read_to_string(plan.backup.join("plan.txt")).unwrap()] {
            assert!(!said.contains(SECRET) && !said.contains("ub_live") && !said.contains("ubr_") && !said.contains("Bearer"), "{said}");
        }
        assert!(text.contains("key …a1f3") && text.contains("v1 key …cdcd"), "{text}");
        for line in &fake.lines {
            let line = line.join(" ");
            assert!(!line.contains(SECRET) && !line.contains("Bearer") && !line.contains("UNBROWSE_AGENT_TOKEN") && !line.contains("unb_"), "{line}");
        }
        assert!(fake.lines.iter().any(|l| l.join(" ").ends_with("-- /opt/unb mcp --agent first")), "{:?}", fake.lines);
        let cfg = fake.read();
        assert_eq!(cfg["mcpServers"]["unbrowse"], json!({ "type": "stdio", "command": "/opt/unb", "args": ["mcp", "--agent", "first"], "env": { "UNBROWSE_NODE": "http://127.0.0.1:7788" } }));
        assert!(!cfg.to_string().contains("unb_"), "the config Claude keeps holds no token of this node's");
    }

    /// B2: the classified remove: each of ours, user and local scope, is removed and checked; the old plugin is
    /// uninstalled; the entry that isn't ours, and other servers, are left as they were.
    #[test]
    fn connect_replaces_ours_and_never_touches_an_entry_not_ours() {
        let (h, m, proj) = old_machine("classified");
        let before = Fake::new(&m).read();
        let mut fake = Fake::new(&m);
        let mut out = Vec::new();
        apply(&plan_for(&h, &m), &mut fake, &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        let cfg = fake.read();
        assert_eq!(cfg["mcpServers"]["unbrowse-acme"], before["mcpServers"]["unbrowse-acme"]);
        assert_eq!(cfg["mcpServers"]["github"], before["mcpServers"]["github"]);
        assert!(cfg["mcpServers"].get("unbrowse-work").is_none() && cfg["mcpServers"].get("unbrowse-next").is_none());
        assert!(cfg["projects"][proj.display().to_string()]["mcpServers"].get("unbrowse").is_none(), "the local-scope entry went too");
        assert!(fake.lines.iter().any(|l| l == &["plugin", "uninstall", "unbrowse@unbrowse", "--scope", "user"]), "{:?}", fake.lines);
        assert!(!fake.lines.iter().any(|l| l.contains(&"unbrowse-acme".to_string())), "{:?}", fake.lines);
        assert!(out.contains("✓ Claude Code: unbrowse → your node (checked: 14 tools)") && out.contains("✓ Removed 3 old entries, uninstalled the old plugin."), "{out}");
        // The order: the new entry is added (as unbrowse-next) before any old one is removed.
        let add = fake.lines.iter().position(|l| l[..2] == ["mcp", "add"]).unwrap();
        let first_remove = fake.lines.iter().position(|l| l[..2] == ["mcp", "remove"]).unwrap();
        assert!(add < first_remove, "{:?}", fake.lines);
        // A second run finds it set up and changes nothing.
        let again = plan_for(&h, &m);
        assert!(!again.changes(), "{}", again.text());
        let mut fake = Fake::new(&m);
        apply(&again, &mut fake, &mut Vec::new()).unwrap();
        assert!(fake.lines.is_empty(), "{:?}", fake.lines);
    }

    /// B2: `--undo` puts each replaced entry back exactly (scope, name, transport, headers, env) and removes the
    /// node's; `--undo --purge` then deletes the backup, the only copy of the old key connect kept.
    #[test]
    fn undo_puts_every_entry_back_exactly_and_purge_deletes_the_backup() {
        let (h, m, _) = old_machine("undo");
        let before = Fake::new(&m).read();
        let plan = plan_for(&h, &m);
        apply(&plan, &mut Fake::new(&m), &mut Vec::new()).unwrap();
        let held = std::fs::read_to_string(plan.backup.join("entries.json")).unwrap();
        assert!(held.contains(SECRET), "the backup keeps the old key so undo can restore it");
        let mut fake = Fake::new(&m);
        let mut out = Vec::new();
        undo(&m, &h.0.join(".unbrowse/migration"), None, true, &mut fake, &mut out).unwrap();
        assert_eq!(fake.read(), before, "{}", String::from_utf8_lossy(&out));
        assert!(fake.lines.iter().any(|l| l[..2] == ["plugin", "install"]), "{:?}", fake.lines);
        assert!(!plan.backup.exists(), "--purge deleted the backup");
        // With nothing left to undo, it says so.
        assert!(undo(&m, &h.0.join(".unbrowse/migration"), None, false, &mut Fake::new(&m), &mut Vec::new()).unwrap_err().contains("no backup"));
    }

    /// Found on a real machine (S8, UNB-158): `connect` run twice, the second finding everything set up, then
    /// `--undo`. The second run changed nothing, so undo skips its backup and undoes the first.
    #[test]
    fn undo_after_a_second_run_that_changed_nothing_undoes_the_first() {
        let (h, m, _) = old_machine("undo-twice");
        let before = Fake::new(&m).read();
        apply(&plan_for(&h, &m), &mut Fake::new(&m), &mut Vec::new()).unwrap();
        let again = Plan::new(m.clone(), entry("http://127.0.0.1:7788", None, Path::new("/opt/unb")), h.0.join(".unbrowse/migration").join(stamp(1_763_284_400)));
        assert!(!again.changes(), "{}", again.text());
        apply(&again, &mut Fake::new(&m), &mut Vec::new()).unwrap();
        assert!(again.backup.join("entries.json").is_file(), "the second run kept its record");
        let mut fake = Fake::new(&m);
        let mut out = Vec::new();
        undo(&m, &h.0.join(".unbrowse/migration"), None, false, &mut fake, &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert_eq!(fake.read(), before, "{out}");
        assert!(out.contains(&stamp(1_763_284_323)), "{out}");
    }

    /// The plan names the right command for a plugin that isn't ours: Claude removes plugins with `plugin
    /// uninstall`, not `mcp remove`.
    #[test]
    fn a_plugin_not_ours_is_named_with_the_command_that_removes_it() {
        let (h, m, _) = old_machine("plugin-not-ours");
        let plugin = h.0.join(".claude/plugins/cache/unbrowse/unbrowse/12.5.0");
        std::fs::write(plugin.join(".mcp.json"), json!({ "mcpServers": { "unbrowse": { "type": "http", "url": "https://mcp.acme.example/u" } } }).to_string()).unwrap();
        let text = plan_for(&h, &m).text();
        assert!(text.contains("claude plugin uninstall unbrowse@unbrowse --scope user") && !text.contains("claude mcp remove --scope user unbrowse@unbrowse"), "{text}");
    }

    /// The backup is private: its folder 0700, its files 0600, and its README says it holds secrets.
    #[cfg(unix)]
    #[test]
    fn the_backup_is_private_and_says_it_holds_secrets() {
        use std::os::unix::fs::PermissionsExt;
        let (h, m, _) = old_machine("private");
        let plan = plan_for(&h, &m);
        apply(&plan, &mut Fake::new(&m), &mut Vec::new()).unwrap();
        assert_eq!(std::fs::metadata(&plan.backup).unwrap().permissions().mode() & 0o777, 0o700);
        for f in ["entries.json", "claude.json", "installed_plugins.json", "plan.txt", "README"] {
            assert_eq!(std::fs::metadata(plan.backup.join(f)).unwrap().permissions().mode() & 0o777, 0o600, "{f}");
        }
        assert!(std::fs::read_to_string(plan.backup.join("README")).unwrap().contains("they are secrets"));
    }

    /// B6: connect never writes the v1 key's `~/.unbrowse/config.json`, the sign-in folder, or anything but its
    /// backup under the node's home.
    #[test]
    fn connect_and_undo_leave_the_old_files_byte_identical() {
        let (h, m, _) = old_machine("files");
        let v1 = h.0.join(".unbrowse/config.json");
        let before = sha(&v1);
        let plan = plan_for(&h, &m);
        apply(&plan, &mut Fake::new(&m), &mut Vec::new()).unwrap();
        undo(&m, &h.0.join(".unbrowse/migration"), None, true, &mut Fake::new(&m), &mut Vec::new()).unwrap();
        assert_eq!(sha(&v1), before);
        let mut left: Vec<String> = std::fs::read_dir(h.0.join(".unbrowse")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, ["config.json", "migration"]);
    }

    /// B2 (R-S1): without a terminal and without `--yes`, a plan that changes anything is only shown; `--dry-run`
    /// only shows; a plan that only adds the new entry (a fresh machine) goes ahead, as `connect` always has.
    #[test]
    fn without_a_terminal_or_yes_connect_only_shows_the_plan() {
        let o = |dry_run, yes| Opts { dry_run, yes, ..Opts::default() };
        assert_eq!(next(&o(false, false), true, false), Next::OnlyShow);
        assert_eq!(next(&o(false, false), true, true), Next::Ask);
        assert_eq!(next(&o(false, true), true, false), Next::Go);
        assert_eq!(next(&o(true, true), true, true), Next::OnlyShow);
        assert_eq!(next(&o(false, false), false, false), Next::Go);
        let (h, m, _) = old_machine("no-terminal");
        assert!(plan_for(&h, &m).changes(), "an old machine's plan changes things, so it needs a yes");
    }

    /// B6 (R-P1): no doc, guide, installer or script tells anyone to remove `~/.unbrowse` whole: it holds the node's
    /// key, the v1 key and connect's backup. Removing a named file or folder under it is fine.
    #[test]
    fn nothing_removes_the_nodes_home_wholesale() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut files = Vec::new();
        let mut dirs: Vec<PathBuf> = ["docs", "integrations", "scripts", "skills", "unbrowse-node/scripts", "unbrowse-sdk"].iter().map(|d| root.join(d)).collect();
        files.extend(["README.md", "PRIVACY.md", "SECURITY.md"].iter().map(|f| root.join(f)));
        while let Some(d) = dirs.pop() {
            for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
                let p = e.path();
                let name = e.file_name().to_string_lossy().into_owned();
                if p.is_dir() && !matches!(name.as_str(), "node_modules" | "target" | ".git" | "dist") {
                    dirs.push(p);
                } else if ["md", "sh", "ps1", "py", "ts", "mjs", "js", "json", "toml", "txt"].iter().any(|x| name.ends_with(&format!(".{x}"))) {
                    files.push(p);
                }
            }
        }
        assert!(files.len() > 50, "the walk found the repo's files: {}", files.len());
        let wholesale = |line: &str| {
            let removes = ["rm -rf", "rm -r ", "rm -fr", "Remove-Item", "rmdir", "remove_dir_all", "rmSync", "shutil.rmtree"].iter().any(|r| line.contains(r));
            removes
                && line.match_indices(".unbrowse").any(|(i, m)| {
                    let after = &line[i + m.len()..];
                    let next = after.chars().next();
                    // `.unbrowse` itself, or `.unbrowse/` with nothing under it named.
                    match next {
                        None => true,
                        Some('/') | Some('\\') => after[1..].chars().next().is_none_or(|c| c.is_whitespace() || c == '"' || c == '\'' || c == '`' || c == ')'),
                        Some(c) => c.is_whitespace() || c == '"' || c == '\'' || c == '`' || c == ')' || c == ';',
                    }
                })
        };
        let mut hits = Vec::new();
        for f in &files {
            for (n, line) in std::fs::read_to_string(f).unwrap_or_default().lines().enumerate() {
                if wholesale(line) {
                    hits.push(format!("{}:{}: {line}", f.display(), n + 1));
                }
            }
        }
        assert!(hits.is_empty(), "{hits:#?}");
        assert!(wholesale("rm -rf ~/.unbrowse") && wholesale("rm -rf \"$HOME/.unbrowse/\"") && wholesale("Remove-Item -Recurse $env:USERPROFILE\\.unbrowse"));
        assert!(!wholesale("rm -rf ~/.unbrowse/tools/leak-prover") && !wholesale("rm -rf \"$HOME/.unbrowse-agent-user-e2e\""));
    }

    /// This node's entry for another agent is kept, and so is anything a project checks in; only an old entry, or this
    /// node's `unbrowse`, is replaced.
    #[test]
    fn the_nodes_entry_for_another_agent_is_kept() {
        let (h, m, proj) = old_machine("another-agent");
        let mut cfg = Fake::new(&m).read();
        cfg["mcpServers"]["unbrowse-2"] = json!({ "type": "stdio", "command": "/opt/unb", "args": ["mcp", "--agent", "2"] });
        std::fs::write(m.claude_json(), cfg.to_string()).unwrap();
        std::fs::write(proj.join(".mcp.json"), json!({ "mcpServers": { "unbrowse": { "type": "http", "url": "https://unbrowse.ai/mcp" } } }).to_string()).unwrap();
        let plan = plan_for(&h, &m);
        let of = |name: &str, scope: &str| plan.found.iter().find(|f| f.host == Host::ClaudeCode && f.name == name && f.scope.word() == scope).map(|f| plan.action(f));
        assert_eq!(of("unbrowse-2", "user"), Some(Action::Keep));
        assert!(matches!(of("unbrowse", "project"), Some(Action::YouEdit(_))));
        let mut fake = Fake::new(&m);
        let mut out = Vec::new();
        apply(&plan, &mut fake, &mut out).expect("a project's file to edit by hand isn't a failure");
        assert_eq!(fake.read()["mcpServers"]["unbrowse-2"]["args"], json!(["mcp", "--agent", "2"]));
        assert!(String::from_utf8(out).unwrap().contains(".mcp.json"));
    }

    #[test]
    fn connect_reads_its_flags() {
        let p = |a: &[&str]| parse(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(p(&[]), Ok(Opts::default()));
        assert_eq!(p(&["3", "--yes"]), Ok(Opts { index: Some(3), yes: true, ..Opts::default() }));
        assert_eq!(p(&["--dry-run"]), Ok(Opts { dry_run: true, ..Opts::default() }));
        assert_eq!(p(&["--undo"]), Ok(Opts { undo: Some(None), ..Opts::default() }));
        assert_eq!(p(&["--undo", "2026-11-16T09-12-03Z", "--purge"]), Ok(Opts { undo: Some(Some("2026-11-16T09-12-03Z".into())), purge: true, ..Opts::default() }));
        assert!(p(&["--purge"]).is_err() && p(&["--token", "x"]).is_err());
    }

    #[test]
    fn a_backup_is_named_by_its_utc_time() {
        assert_eq!(stamp(0), "1970-01-01T00-00-00Z");
        assert_eq!(stamp(1_763_284_323), "2025-11-16T09-12-03Z");
        assert_eq!(stamp(1_709_164_800), "2024-02-29T00-00-00Z");
    }
}
