//! What an install leaves on this computer besides the programs: the agent skill, and the commands on the PATH.
//!
//! A disk image is a copy: dragging Unbrowse into Applications runs no code of its own, and a `.pkg`'s postinstall runs
//! as root, outside the owner's session, where it can see neither their agent folders nor their keychain. So what an
//! installer would do, the app does as its owner: the first time the terms are accepted, and again when a newer version
//! carries a different skill (`main.rs` `install_due`), from Settings, through `unbrowse_setup` (`do: "tools"`), or by
//! `unb install`. Two things a drag leaves undone, and this does both:
//!
//! - **The skill.** Written into the skills folder of every agent found on this machine (Claude Code's
//!   `~/.claude/skills/unbrowse`, and each other reader's own), from the copy this program carries, so no download and no
//!   terminal is needed. A folder this wrote, unchanged since, is replaced whole; anything else there is the owner's
//!   (their own skill of that name, or a copy they edited) and is moved to `unbrowse-kept` beside the skills folder,
//!   never deleted, so the agent doesn't load the old copy as a second skill.
//! - **The commands.** `unb`, `unbrowse-node` and `unbrowse` in `~/.local/bin`, each a link to the program of the
//!   install that is running: `unbrowse` is `unb` under the name a person types (see `bin/unb.rs`). Where `~/.local/bin`
//!   isn't on the PATH this shell reads, one guarded line is added to the file it reads at login.
//!
//! Every part is idempotent: a skill already as this program carries it and a link already pointing at these programs
//! are left alone and reported as unchanged, so a start may check every time.

use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::connect::Client;
use crate::legacy::Machine;

/// The skill this program carries: the one file of the repository's `skills/unbrowse`, put into the binary so a disk
/// image install has it with nothing to download. Its SHA-256 is what tells a later install whether the copy there is
/// still the one this wrote.
pub const SKILL: &str = include_str!("../../../skills/unbrowse/SKILL.md");

/// The file an install leaves beside the skill it wrote: each file's SHA-256, in the shape the npm package reads and
/// writes, so whichever installs last sees the other's copy as its own.
const RECORD: &str = ".unbrowse-installed.json";

/// Where a folder that isn't ours is kept: beside the agent's `skills` folder (`~/.claude/unbrowse-kept`), out of the
/// agent's way.
const KEPT: &str = "unbrowse-kept";

/// The folder the commands go in: the one this machine's shells look in that needs no administrator.
const BIN: &str = ".local/bin";

/// The file name of the skill's one file.
const SKILL_FILE: &str = "SKILL.md";

/// SHA-256 of the skill this program carries, as hex: what `settings.tools_skill` holds, so a newer skill is put in
/// place once and not on every start.
pub fn skill_hash() -> String {
    hex::encode(Sha256::digest(SKILL.as_bytes()))
}

/// One thing an install puts in place.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Placed {
    /// What it is, in words a person reads: an agent's name, or a command's.
    pub what: String,
    /// Where it is.
    pub at: PathBuf,
    /// What was in its place, kept as it was, when it wasn't a copy an Unbrowse install wrote.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept: Option<PathBuf>,
    /// Whether this run wrote it, or found it already right.
    pub changed: bool,
    /// Something a person reads about it, when it was left as it is rather than written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Which halves of the install a run does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parts {
    pub skill: bool,
    pub commands: bool,
}

impl Parts {
    /// Both: what the app does on first run and `unb install` does with no flag.
    pub const ALL: Parts = Parts { skill: true, commands: true };
}

/// What a run of the install did, or (dry) would do.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Done {
    pub skill: Vec<Placed>,
    pub commands: Vec<Placed>,
    /// The file a line putting `~/.local/bin` on the PATH was added to, when the shell didn't already read it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_file: Option<Placed>,
    /// Why some part was left undone, in words a person reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
    /// Nothing was written: this was asked what it would do.
    pub dry: bool,
}

impl Done {
    /// What the install did, in a line or two, for the setup step and the reply of `unb install`.
    pub fn said(&self) -> String {
        let names = |list: &[Placed]| list.iter().map(|p| p.what.as_str()).collect::<Vec<_>>().join(", ");
        let mut said = Vec::new();
        if self.skill.is_empty() {
            said.push("no agent on this computer reads skills".to_string());
        } else {
            said.push(format!("the skill is in {}", names(&self.skill)));
        }
        match (&self.commands[..], &self.path_file) {
            ([], _) => said.push("the commands are where the installer put them".to_string()),
            (list, Some(p)) if p.changed => said.push(format!("{} are on your PATH: one line added to {}", names(list), p.at.display())),
            (list, _) => said.push(format!("{} are on your PATH", names(list))),
        }
        if let Some(s) = &self.skipped {
            said.push(s.clone());
        }
        for p in self.skill.iter().chain(self.commands.iter()) {
            if let Some(note) = &p.note {
                said.push(format!("{}: {note}", p.what));
            }
        }
        if self.dry {
            said.push("(nothing was written: this was a dry run)".to_string());
        }
        said.join("; ")
    }
}

/// The agents that read skills on this machine, each with the folder its skills go in: the reader of "is this agent
/// installed" is `Client::found` (its program, or the file only it writes), the one `connect` uses, so a settings folder
/// a sync made on a machine with no agent isn't mistaken for one. An agent whose skills folder this program doesn't know
/// is not in the list: a wrong path would write a skill nothing reads.
pub fn readers(m: &Machine) -> Vec<(Client, PathBuf)> {
    let home = &m.home;
    let xdg = m.xdg_config_home.clone().unwrap_or_else(|| home.join(".config"));
    let claude = m.claude_config_dir.clone().unwrap_or_else(|| home.join(".claude"));
    let codex = m.codex_home.clone().unwrap_or_else(|| home.join(".codex"));
    let places: [(Client, PathBuf); 6] = [
        (Client::ClaudeCode, claude.join("skills")),
        (Client::Codex, codex.join("skills")),
        (Client::Opencode, xdg.join("opencode").join("skills")),
        (Client::Hermes, home.join(".hermes").join("skills")),
        (Client::Kiro, home.join(".kiro").join("skills")),
        (Client::OpenClaw, home.join(".openclaw").join("skills")),
    ];
    places.into_iter().filter(|(c, _)| c.found(m)).collect()
}

/// The agents whose skills folder holds the skill this program carries, and the ones it is missing from: read, never
/// written, so the setup list can say where it stands without doing it again.
pub fn found(m: &Machine) -> (Vec<String>, Vec<String>) {
    let mut holds = Vec::new();
    let mut missing = Vec::new();
    for (client, skills) in readers(m) {
        if read(&skills.join("unbrowse").join(SKILL_FILE)).as_deref() == Some(SKILL) {
            holds.push(client.name().to_string());
        } else {
            missing.push(client.name().to_string());
        }
    }
    (holds, missing)
}

/// Puts the skill in `to`, the skill's own folder, and leaves the record of what it wrote. A copy an Unbrowse install
/// wrote and nobody changed since is replaced whole; anything else is moved to `unbrowse-kept` beside the folder it was
/// in first, and the result says where it went.
pub fn install_into(to: &Path, dry: bool) -> Result<Placed, String> {
    let kept = if ours(to) { None } else { kept_beside(to, dry)? };
    let changed = kept.is_some() || read(&to.join(SKILL_FILE)).as_deref() != Some(SKILL);
    if !dry {
        if exists(to) || is_link(to) {
            remove(to)?;
        }
        fs::create_dir_all(to).map_err(|e| format!("{}: {e}", to.display()))?;
        fs::write(to.join(SKILL_FILE), SKILL).map_err(|e| format!("{}: {e}", to.display()))?;
        let mut record = serde_json::Map::new();
        record.insert(SKILL_FILE.into(), serde_json::json!(hex::encode(Sha256::digest(SKILL.as_bytes()))));
        fs::write(to.join(RECORD), serde_json::to_vec_pretty(&serde_json::Value::Object(record)).map_err(|e| e.to_string())?)
            .map_err(|e| format!("{}: {e}", to.display()))?;
    }
    let what = to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "unbrowse".into());
    Ok(Placed { what, at: to.to_path_buf(), kept, changed, note: None })
}

/// The skill in an agent's skills folder, by the name every agent knows it as.
pub fn install_at(skills: &Path, name: &str, dry: bool) -> Result<Placed, String> {
    install_into(&skills.join(name), dry)
}

/// Whether `dir` holds nothing, or exactly the skill an Unbrowse install wrote there: the record that install left, every
/// file it wrote unchanged, and none added.
fn ours(dir: &Path) -> bool {
    let Ok(record) = fs::read(dir.join(RECORD)) else { return !exists(dir) };
    let Ok(serde_json::Value::Object(written)) = serde_json::from_slice::<serde_json::Value>(&record) else { return false };
    let Ok(entries) = fs::read_dir(dir) else { return false };
    let mut seen = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == RECORD {
            continue;
        }
        let Some(want) = written.get(&name).and_then(|v| v.as_str()) else { return false };
        let Some(have) = read(&entry.path()) else { return false };
        if hex::encode(Sha256::digest(have.as_bytes())) != want {
            return false;
        }
        seen += 1;
    }
    seen == written.len()
}

/// Where what is at `to` is moved to: `unbrowse-kept` beside the skills folder, with the stamp the Codex installer uses,
/// so a second one on the same second doesn't overwrite the first.
fn kept_beside(to: &Path, dry: bool) -> Result<Option<PathBuf>, String> {
    if !exists(to) && !is_link(to) {
        return Ok(None);
    }
    let skills = to.parent().ok_or_else(|| format!("{} has no folder", to.display()))?;
    let dir = skills.parent().map(|p| p.join(KEPT)).unwrap_or_else(|| skills.join(KEPT));
    let stamp = stamp();
    let name = to.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "unbrowse".into());
    let mut kept = dir.join(format!("{name}.before-unbrowse-{stamp}"));
    for n in 1.. {
        if !exists(&kept) && !is_link(&kept) {
            break;
        }
        kept = dir.join(format!("{name}.before-unbrowse-{stamp}-{n}"));
    }
    if !dry {
        fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        fs::rename(to, &kept).map_err(|e| format!("{}: {e}", to.display()))?;
    }
    Ok(Some(kept))
}

/// The local time an install stamps what it kept, as `YYYYMMDDhhmmss`, the name the npm install writes: the machine's
/// own `date`, and UTC worked out here when there is none (a bare container).
fn stamp() -> String {
    stamp_by("date")
}

/// `stamp`, asking the program `date` for the local time.
fn stamp_by(date: &str) -> String {
    if let Ok(out) = std::process::Command::new(date).arg("+%Y%m%d%H%M%S").output() {
        let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if said.len() == 14 && said.chars().all(|c| c.is_ascii_digit()) {
            return said;
        }
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let (y, mo, d, h, mi, s) = civil(secs);
    format!("{y:04}{mo:02}{d:02}{h:02}{mi:02}{s:02}")
}

/// A unix time as UTC's date and time parts.
fn civil(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    (y, m, d, (rem / 3600) as u32, (rem % 3600 / 60) as u32, (rem % 60) as u32)
}

/// Days since 1970-01-01 as a calendar date (Howard Hinnant's `civil_from_days`).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + i64::from(m <= 2), m, d)
}

/// The commands an install puts on the PATH, each pointing at the program of the install that is running, and the folder
/// they go in. A link needs a privilege Windows doesn't give an ordinary program: there the commands stay in the folder
/// the installer put them in, and the run says so.
pub fn commands(home: &Path, programs: &Path, dry: bool) -> Result<(Vec<Placed>, PathBuf), String> {
    let bin = home.join(BIN);
    #[cfg(not(unix))]
    {
        let _ = (programs, dry);
        return Ok((Vec::new(), bin));
    }
    #[cfg(unix)]
    {
        let mut placed = Vec::new();
        let want = |name: &str| if name == "unbrowse" { programs.join(exe("unb")) } else { programs.join(exe(name)) };
        for name in ["unb", "unbrowse-node", "unbrowse"] {
            let link = bin.join(exe(name));
            let to = want(name);
            // The program that lives in this very folder is its own command: a link here would point at itself, and
            // making one would take the program away with it. The two paths are compared as the filesystem resolves
            // them, since a temp folder on a Mac is `/var/…` by one name and `/private/var/…` by another.
            if fs::canonicalize(&link).ok().is_some_and(|at| Some(at) == fs::canonicalize(&to).ok()) {
                placed.push(Placed { what: name.to_string(), at: link, kept: None, changed: false, note: None });
                continue;
            }
            // A real file at that name is not an Unbrowse install's link: it is somebody's program, and is left alone.
            if exists(&link) && !is_link(&link) {
                placed.push(Placed {
                    what: name.to_string(),
                    at: link,
                    kept: None,
                    changed: false,
                    note: Some("a program of its own is there, so it is left as it is".into()),
                });
                continue;
            }
            let changed = fs::read_link(&link).map(|have| have != to).unwrap_or(true);
            if !dry {
                fs::create_dir_all(&bin).map_err(|e| format!("{}: {e}", bin.display()))?;
                if is_link(&link) {
                    remove(&link)?;
                }
                symlink(&to, &link)?;
            }
            placed.push(Placed { what: name.to_string(), at: link, kept: None, changed, note: None });
        }
        Ok((placed, bin))
    }
}

/// A program's file name here: Windows' end in `.exe`.
fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
}

#[cfg(unix)]
fn symlink(to: &Path, at: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(to, at).map_err(|e| format!("{}: {e}", at.display()))
}

/// The file this machine's shell reads at login, and the line that puts `~/.local/bin` on its PATH. A shell this doesn't
/// know by name is a POSIX one whose login file is `~/.profile`.
fn shell_line(home: &Path) -> (PathBuf, &'static str) {
    let shell = std::env::var("SHELL").unwrap_or_default();
    let shell = Path::new(&shell).file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let posix = "case \":$PATH:\" in *:\"$HOME/.local/bin\":*) ;; *) export PATH=\"$HOME/.local/bin:$PATH\" ;; esac\n";
    let file = match shell.as_str() {
        "zsh" => home.join(".zprofile"),
        "bash" => home.join(".bash_profile"),
        "fish" => return (home.join(".config/fish/config.fish"), "fish_add_path $HOME/.local/bin\n"),
        "" if cfg!(target_os = "macos") => home.join(".zprofile"),
        _ => home.join(".profile"),
    };
    (file, posix)
}

/// Adds the PATH line to the file the shell reads, when it isn't there already: one guarded line, appended, and the file
/// it went to is what the run says. A file already naming `~/.local/bin` is left alone, whatever put it there.
pub fn ensure_path(home: &Path, dry: bool) -> Result<Placed, String> {
    let (file, line) = shell_line(home);
    let now = read(&file).unwrap_or_default();
    if now.contains(".local/bin") {
        return Ok(Placed { what: "PATH".into(), at: file, kept: None, changed: false, note: None });
    }
    if !dry {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut add = String::new();
        if !now.is_empty() && !now.ends_with('\n') {
            add.push('\n');
        }
        add.push_str("\n# Unbrowse's commands\n");
        add.push_str(line);
        fs::write(&file, format!("{now}{add}")).map_err(|e| format!("{}: {e}", file.display()))?;
    }
    Ok(Placed { what: "PATH".into(), at: file, kept: None, changed: true, note: None })
}

/// The whole install, or the half of it asked for: the skill for every agent found, the commands, and the PATH line when
/// the shell doesn't have it. `dry` writes nothing and says what it would do.
pub fn run(m: &Machine, programs: &Path, parts: Parts, dry: bool) -> Done {
    let mut done = Done { dry, ..Done::default() };
    if parts.skill {
        for (client, skills) in readers(m) {
            if !skills.is_dir() && !dry {
                // The agent is installed; its skills folder is made by the agent, or here, on the first skill it gets.
                if let Err(e) = fs::create_dir_all(&skills) {
                    done.skipped = Some(format!("{}: {e}", skills.display()));
                    continue;
                }
            }
            match install_at(&skills, "unbrowse", dry) {
                Ok(mut p) => {
                    p.what = client.name().to_string();
                    done.skill.push(p);
                }
                Err(e) => done.skipped = Some(e),
            }
        }
    }
    if !parts.commands {
        return done;
    }
    // A link into a disk image, a translocated copy or a folder that goes away would break: the window's "Move to
    // Applications" step comes first, and the commands wait for it.
    let programs = programs.to_path_buf();
    if unstable(&programs) {
        done.skipped = Some("open Unbrowse from Applications once, and its commands go on the PATH then".to_string());
        return done;
    }
    match commands(&m.home, &programs, dry) {
        Ok((placed, _bin)) => done.commands = placed,
        Err(e) => done.skipped = Some(e),
    }
    if done.commands.is_empty() {
        return done;
    }
    match ensure_path(&m.home, dry) {
        Ok(p) => done.path_file = Some(p),
        Err(e) => done.skipped = Some(e),
    }
    done
}

/// Whether the programs run from somewhere that won't be there later: inside a mounted disk image, or a copy macOS
/// translocated for quarantine.
fn unstable(programs: &Path) -> bool {
    let p = programs.to_string_lossy();
    p.starts_with("/Volumes/") || p.contains("/AppTranslocation/")
}

fn read(p: &Path) -> Option<String> {
    fs::read_to_string(p).ok()
}

fn exists(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

fn remove(p: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
    let out = if meta.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
    out.map_err(|e| format!("{}: {e}", p.display()))
}

#[cfg(test)]
#[path = "install_cov_tests.rs"]
mod install_cov_tests;
