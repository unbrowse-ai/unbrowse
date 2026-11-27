//! Agents as an OS user of their own (`unbrowse-node agent-user …`).
//!
//! The node runs as the owner. An agent (Claude Code, Codex, a script) that runs as the owner too can read everything
//! the owner's user can: `owner.token`, a file-kept `root.key`, the owner passphrase's hash, the Linux Secret Service,
//! Windows' Credential Manager, and on X11 it can press buttons in the node's dialog. Run as another OS user, it can
//! read none of them: the node's folder (`~/.unbrowse`) is the owner's alone (0700, its files 0600; on Windows the
//! owner's profile), the keystores and the desktop session are per user, and one user's programs can't trace or read
//! another's. It still reaches the node the way every agent does, over `127.0.0.1` with its own agent key's token.
//!
//! `install` makes the user (`unbrowse-agent`) with no password and no admin rights, a private home, its own agent key
//! with the token in that home, and, on macOS and Linux, a sudoers rule that lets the owner (and only the owner) run
//! programs as it with no password. `run -- <program>` runs an agent harness as it. `status` checks, as the agent user,
//! that none of the owner's secrets can be read. `remove` undoes `install`. Making and removing a user needs the
//! machine's admin: `sudo` on macOS and Linux (the steps ask for the owner's password), an Administrator shell on
//! Windows.

use std::path::{Path, PathBuf};

/// The agents' OS user.
pub const NAME: &str = "unbrowse-agent";

/// Where `install` keeps the agent's settings, in the agent user's home: `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN`.
pub const ENV_FILE: &str = ".unbrowse-agent.env";

/// Where the sudoers rule goes on macOS and Linux.
pub const SUDOERS: &str = "/etc/sudoers.d/unbrowse-agent";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    Mac,
    Windows,
}

pub fn this_os() -> Os {
    if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Linux
    }
}

/// The agent user's home.
pub fn home(os: Os) -> PathBuf {
    match os {
        Os::Linux => PathBuf::from("/var/lib").join(NAME),
        Os::Mac => PathBuf::from("/Users").join(NAME),
        // Windows makes a profile only at a user's first logon, so the agent's settings live in a folder of their own.
        Os::Windows => windows_home(std::env::var("ProgramData").ok().as_deref()),
    }
}

/// The agent's folder on Windows, under `program_data` (`ProgramData`) when that is a plain path on a drive, else under
/// `C:\ProgramData`. The folder is written into the Administrator shell's script, so a value whose characters could
/// mean something there (a quote, `$`, `;`) is never used, and the script quotes it besides.
pub fn windows_home(program_data: Option<&str>) -> PathBuf {
    let plain = |p: &&str| {
        let b = p.as_bytes();
        b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '\\' | ' ' | '.' | '_' | '-' | '(' | ')'))
    };
    PathBuf::from(program_data.filter(plain).unwrap_or(r"C:\ProgramData")).join("Unbrowse").join("agent")
}

/// `s` as a PowerShell string literal: in single quotes, each quote doubled, so nothing in it is read as script.
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// One step that needs the machine's admin: a program and its arguments, and what goes to its stdin (a secret never
/// goes in an argument, where `ps` shows it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub what: String,
    pub argv: Vec<String>,
    pub stdin: Option<String>,
    /// It makes the user, and can't run twice: skipped when the user is there already. Every other step runs on every
    /// install, so one that was cut short after the user was made is finished by the next: a user left with no home, or
    /// a home left open, doesn't stay that way.
    pub make: bool,
}

fn step(what: &str, argv: &[&str]) -> Step {
    Step {
 what: what.into(), argv: argv.iter().map(|s| s.to_string()).collect(), stdin: None, make: true }
}

/// `s`, safe to run again on a user that is there already.
fn again(s: Step) -> Step {
    Step {
 make: false, ..s }
}

/// The agent user's login shell: none.
pub const NO_SHELL_LINUX: &str = "/usr/sbin/nologin";
pub const NO_SHELL_MAC: &str = "/usr/bin/false";

/// The step that takes the agent user's login shell away, run on every install.
fn no_shell(argv: &[&str]) -> Step {
    again(step(&format!("give {NAME} no login shell"), argv))
}

/// A user name the sudoers rule and the commands can carry as it is: letters, digits, `.`, `_` and `-`, not starting
/// with `-`. Anything else could change what a sudoers line or a command means.
pub fn plain_name(name: &str) -> Result<&str, String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(name)
    } else {
        Err(format!("{name:?} isn't a user name this can write into a sudoers rule"))
    }
}

/// The sudoers rule: the owner may run any program as the agent user, with no password. Nothing else: the agent user
/// gets no rights at all, and nobody but the owner gets any over it. A program run as the agent user gets a terminal
/// of sudo's own (`use_pty`), never the owner's: on the owner's terminal it could push keys in (`TIOCSTI`) that the
/// owner's shell runs after it exits.
pub fn sudoers_rule(owner: &str) -> Result<String, String> {
    Ok(format!(
        "# Written by `unbrowse-node agent-user install`: {owner} runs agents as {NAME}, each in a terminal of its own.\nDefaults>{NAME} use_pty\n{} ALL=({NAME}) NOPASSWD: ALL\n",
        plain_name(owner)?
    ))
}

/// The settings the agent user's programs read: where the node is, and the agent key's token.
pub fn env_file(port: u16, token: &str) -> String {
    format!("export UNBROWSE_NODE=http://127.0.0.1:{port}\nexport UNBROWSE_AGENT_TOKEN={token}\n")
}

/// A UID and GID for the agent user on macOS, free in both lists: below 500, so the login window never shows it.
/// `users` and `groups` are `dscl . -list /Users UniqueID` and `dscl . -list /Groups PrimaryGroupID` as they print.
pub fn free_mac_id(users: &str, groups: &str) -> Option<u32> {
    let taken = |listing: &str| -> std::collections::BTreeSet<u32> { listing.lines().filter_map(|l| l.split_whitespace().last()?.parse().ok()).collect() };
    let (u, g) = (taken(users), taken(groups));
    (401..500).find(|id| !u.contains(id) && !g.contains(id))
}

/// The id the agent user has on macOS: the one it has when it is there (`existing`, as `id -u` prints it), since every
/// step is run again with this id and a new one would move the user off its own home; else a free one. None for an
/// answer that doesn't read: nothing is guessed for a user that exists.
pub fn mac_id(existing: Option<&str>, users: &str, groups: &str) -> Option<u32> {
    match existing {
        Some(id) => id.trim().parse().ok(),
        None => free_mac_id(users, groups),
    }
}

/// What the agent user's own key is called.
pub fn key_name() -> String {
    format!("agents (OS user {NAME})")
}

/// Which of the `live` keys (index and name) the agent user already has, so an install run again doesn't leave another
/// behind it. Not one in `exposed`: its token is in the owner's files, where the owner's programs read it.
pub fn own_key<'a>(mut live: impl Iterator<Item = (u32, &'a str)>, exposed: &[u32]) -> Option<u32> {
    let name = key_name();
    live.find(|(index, n)| *n == name && !exposed.contains(index)).map(|(index, _)| index)
}

/// The steps that make the agent user, its home and its settings, on `os`. `owner` is the owner's user name, `env`
/// what [`env_file`] writes, `mac_id` the id [`free_mac_id`] found.
pub fn install_steps(os: Os, owner: &str, env: &str, mac_id: Option<u32>) -> Result<Vec<Step>, String> {
    plain_name(owner)?;
    if owner == NAME {
        return Err(format!("run this as the owner, not as {NAME}"));
    }
    let home = home(os);
    let home_s = home.to_string_lossy().to_string();
    let env_path = home.join(ENV_FILE).to_string_lossy().to_string();
    // The settings file is written by the agent user itself, from stdin, private from its first byte.
    let write_env = |argv: Vec<String>| Step {
 what: format!("write the agent's settings to {env_path}, readable by {NAME} alone"), argv, stdin: Some(env.to_string()), make: false };
    let sudoers = Step {
        what: format!("let {owner} run programs as {NAME} with no password ({SUDOERS}, checked with visudo first)"),
        argv: ["sudo", "sh", "-c", "umask 337 && cat > \"$1.new\" && visudo -cf \"$1.new\" && mv \"$1.new\" \"$1\"", "sh", SUDOERS].iter().map(|s| s.to_string()).collect(),
        stdin: Some(sudoers_rule(owner)?),
        make: false,
    };
    Ok(match os {
        Os::Linux => vec![
            // A system user: no password, so no one logs in as it; its own group; no other group, so no sudo or admin.
            step(&format!("make the user {NAME}, with no password and no groups but its own"), &["sudo", "useradd", "--system", "--user-group", "--create-home", "--home-dir", &home_s, "--shell", NO_SHELL_LINUX, "--comment", "Unbrowse agents", NAME]),
            // No login shell, on an older install's user too: `run` starts `sh -c` itself, and no one logs in as it.
            no_shell(&["sudo", "usermod", "--shell", NO_SHELL_LINUX, NAME]),
            again(step(&format!("keep {home_s} to {NAME} alone"), &["sudo", "chmod", "0700", &home_s])),
            write_env(["sudo", "-u", NAME, "-H", "sh", "-c", "umask 077 && cat > \"$1\"", "sh", &env_path].iter().map(|s| s.to_string()).collect()),
            sudoers,
        ],
        Os::Mac => {
            let id = mac_id.ok_or("no free user id below 500 for the agent user")?.to_string();
            let user = format!("/Users/{NAME}");
            let group = format!("/Groups/{NAME}");
            // Every one of these sets a value or makes what may be there already, so none is the kind that can't run twice.
            [
                // Its own group, never staff: the owner's home is group staff.
                step(&format!("make the group {NAME}"), &["sudo", "dscl", ".", "-create", &group, "PrimaryGroupID", &id]),
                step(&format!("make the user {NAME}"), &["sudo", "dscl", ".", "-create", &user, "UniqueID", &id]),
                step("with its own group", &["sudo", "dscl", ".", "-create", &user, "PrimaryGroupID", &id]),
                step("and no password, so no one logs in as it", &["sudo", "dscl", ".", "-create", &user, "Password", "*"]),
                step("hidden from the login window", &["sudo", "dscl", ".", "-create", &user, "IsHidden", "1"]),
                // No login shell, on an older install's user too: `run` starts `sh -c` itself, and no one logs in as it.
                no_shell(&["sudo", "dscl", ".", "-create", &user, "UserShell", NO_SHELL_MAC]),
                step("and its home", &["sudo", "dscl", ".", "-create", &user, "NFSHomeDirectory", &home_s]),
                step(&format!("make {home_s}"), &["sudo", "mkdir", "-p", &home_s]),
                step(&format!("give {home_s} to {NAME}"), &["sudo", "chown", &format!("{id}:{id}"), &home_s]),
                step(&format!("keep {home_s} to {NAME} alone"), &["sudo", "chmod", "0700", &home_s]),
                write_env(["sudo", "-u", NAME, "-H", "sh", "-c", "umask 077 && cat > \"$1\"", "sh", &env_path].iter().map(|s| s.to_string()).collect()),
                sudoers,
            ]
            .into_iter()
            .map(again)
            .collect()
        }
        Os::Windows => {
            // An Administrator PowerShell. The password goes in on stdin, never as an argument; the node keeps it in
            // the owner's Credential Manager, for `run`.
            let ps = |what: &str, script: &str, stdin: Option<String>, make: bool| Step {
                what: what.into(),
                argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", script].iter().map(|s| s.to_string()).collect(),
                stdin,
                make,
            };
            vec![
                ps(
                    &format!("make the local user {NAME}, a standard user (in Users, never Administrators)"),
                    &format!("$p = ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force; New-LocalUser -Name '{NAME}' -Password $p -PasswordNeverExpires -AccountNeverExpires -Description 'Unbrowse agents' | Out-Null; Add-LocalGroupMember -SID 'S-1-5-32-545' -Member '{NAME}'"),
                    // The password, filled in by `install` when it runs this.
                    Some(String::new()),
                    true,
                ),
                ps(
                    &format!("make {home_s}, for {NAME} and {owner} alone"),
                    &format!(
                        "New-Item -ItemType Directory -Force -Path {h} | Out-Null; icacls {h} /inheritance:r /grant:r {agent} {owner} 'SYSTEM:(OI)(CI)F' | Out-Null",
                        h = ps_quote(&home_s),
                        agent = ps_quote(&format!("{NAME}:(OI)(CI)F")),
                        owner = ps_quote(&format!("{owner}:(OI)(CI)F")),
                    ),
                    None,
                    false,
                ),
                ps(&format!("write the agent's settings to {env_path}"), &format!("[IO.File]::WriteAllText({}, [Console]::In.ReadToEnd())", ps_quote(&env_path)), Some(env.to_string()), false),
            ]
        }
    })
}

/// The steps that undo [`install_steps`]. The agent key stays: revoke it in the window (Money, Agents) or with the SDK.
pub fn remove_steps(os: Os) -> Vec<Step> {
    let home_s = home(os).to_string_lossy().to_string();
    match os {
        Os::Linux => vec![
            step(&format!("remove the user {NAME} and its home"), &["sudo", "userdel", "--remove", NAME]),
            step("remove its sudoers rule", &["sudo", "rm", "-f", SUDOERS]),
        ],
        Os::Mac => vec![
            step(&format!("remove the user {NAME}"), &["sudo", "dscl", ".", "-delete", &format!("/Users/{NAME}")]),
            step(&format!("remove the group {NAME}"), &["sudo", "dscl", ".", "-delete", &format!("/Groups/{NAME}")]),
            step(&format!("remove {home_s}"), &["sudo", "rm", "-rf", &home_s]),
            step("remove its sudoers rule", &["sudo", "rm", "-f", SUDOERS]),
        ],
        Os::Windows => vec![Step {
            what: format!("remove the local user {NAME} and {home_s}"),
            argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", &format!("Remove-LocalUser -Name '{NAME}'; Remove-Item -Recurse -Force -Path {}", ps_quote(&home_s))].iter().map(|s| s.to_string()).collect(),
            stdin: None,
            make: true,
        }],
    }
}

/// How `run` starts `program` as the agent user on macOS and Linux, with the agent's settings read in first.
pub fn run_argv(program: &[String]) -> Vec<String> {
    let mut argv: Vec<String> = ["sudo", "-u", NAME, "-H", "sh", "-c", &format!(". \"$HOME/{ENV_FILE}\" && exec \"$@\""), "sh"].iter().map(|s| s.to_string()).collect();
    argv.extend(program.iter().cloned());
    argv
}

/// The command the owner's PowerShell sends to the agent's PowerShell through stdin. The agent's process reads its
/// settings from its own folder and passes the program its literal arguments.
pub fn run_windows_payload(program: &[String]) -> String {
    let env = home(Os::Windows).join(ENV_FILE).to_string_lossy().to_string();
    let call = program.iter().map(|a| ps_quote(a)).collect::<Vec<_>>().join(" ");
    let inner = format!(
        "foreach ($l in Get-Content {env}) {{ if ($l -match '^export ([A-Z_]+)=(.*)$') {{ [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }} }}; & {call}; exit $LASTEXITCODE",
        env = ps_quote(&env),
    );
    encoded_windows_script(&inner)
}

fn encoded_windows_script(script: &str) -> String {
    use base64::Engine;
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(utf16)
}

/// Read the password and payload in the owner's process, then forward only the payload to the agent user.
/// The logon API accepts at most 1,024 characters on its command line, so only the fixed reader goes there.
pub fn run_windows_script() -> String {
    let encoded = encoded_windows_script(
        "$ErrorActionPreference = 'Stop'; $in = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::ASCII); \
         & ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($in.ReadLine()))))",
    );
    // Any failure stops the script with an error, so a program that never started is never taken for one that ran.
    format!(
        "$ErrorActionPreference = 'Stop'; $p = ConvertTo-SecureString ([Console]::In.ReadLine()) -AsPlainText -Force; $payload = [Console]::In.ReadLine(); \
         $i = New-Object System.Diagnostics.ProcessStartInfo; $i.FileName = 'powershell'; \
         $i.Arguments = '-NoProfile -NonInteractive -EncodedCommand {encoded}'; $i.UserName = '{NAME}'; $i.Domain = $env:COMPUTERNAME; \
         $i.Password = $p; $i.UseShellExecute = $false; $i.LoadUserProfile = $true; $i.WorkingDirectory = {dir}; $i.RedirectStandardInput = $true; \
         $r = [System.Diagnostics.Process]::Start($i); $in = $r.StandardInput.BaseStream; \
         $bytes = [Text.Encoding]::ASCII.GetBytes($payload + [char]10); $in.Write($bytes, 0, $bytes.Length); $in.Close(); \
         $r.WaitForExit(); exit $r.ExitCode",
        dir = ps_quote(&home(Os::Windows).to_string_lossy()),
    )
}

/// What the agent user must never read: the node's folder and the secrets in it.
pub fn owner_secrets(data: &Path) -> Vec<PathBuf> {
    let mut paths = vec![data.to_path_buf()];
    if let Ok(dir) = std::fs::read_dir(data) {
        let mut files: Vec<PathBuf> = dir.filter_map(Result::ok).filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.path()).collect();
        files.sort();
        paths.extend(files);
    }
    paths
}

/// The probe's last line, once it has tried every path: without it, the probe never ran to the end.
pub const PROBED: &str = "unbrowse-agent-probe-done";

/// How `status` asks, as the agent user, which of `paths` it can read: the probe prints each one it could, then
/// [`PROBED`]. A path it can't read is the answer hoped for, never a failure of the probe.
pub fn probe_argv(paths: &[PathBuf]) -> Vec<String> {
    let script = format!(
        "for f; do if [ -d \"$f\" ]; then ls \"$f\" >/dev/null 2>&1 && echo \"$f\"; else head -c 1 \"$f\" >/dev/null 2>&1 && echo \"$f\"; fi; done; echo {PROBED}"
    );
    let mut argv: Vec<String> = ["sudo", "-n", "-u", NAME, "sh", "-c", &script, "sh"].iter().map(|s| s.to_string()).collect();
    argv.extend(paths.iter().map(|p| p.to_string_lossy().to_string()));
    argv
}

/// What the probe's output says: the paths it could read, or `None` when it didn't run to the end.
pub fn probed(stdout: &str) -> Option<Vec<String>> {
    let lines: Vec<&str> = stdout.lines().collect();
    match lines.split_last() {
        Some((last, read)) if *last == PROBED => Some(read.iter().map(|l| l.to_string()).collect()),
        _ => None,
    }
}

/// Files in the owner's home that hold one of `tokens` (live agent keys' tokens): an agent set up as the owner's user,
/// before it moves to the agent user. Searched to `depth` folders down, in files up to 256 KiB; the node's own folder,
/// and folders of downloaded or built things, are skipped.
pub fn token_copies(home: &Path, data: &Path, tokens: &[String], depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if tokens.is_empty() {
        return found;
    }
    let skip = |p: &Path| p == data || p.file_name().is_some_and(|n| matches!(n.to_str(), Some("node_modules" | ".git" | "target" | ".cache" | "Library" | ".npm" | ".cargo" | ".rustup")));
    let mut stack = vec![(home.to_path_buf(), 0usize)];
    while let Some((dir, d)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.filter_map(Result::ok) {
            let p = e.path();
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() && d < depth && !skip(&p) {
                stack.push((p, d + 1));
            } else if t.is_file() && e.metadata().is_ok_and(|m| m.len() <= 256 * 1024) {
                if let Ok(bytes) = std::fs::read(&p) {
                    let text = String::from_utf8_lossy(&bytes);
                    if tokens.iter().any(|t| text.contains(t.as_str())) {
                        found.push(p);
                    }
                }
            }
        }
    }
    found.sort();
    found
}

/// Makes the node's folder, and every file and folder directly in it, the owner's alone (no group or other bits),
/// whatever an older node
/// or a copy left them as: the agent user, like every other user, can then neither list nor read them.
pub fn keep_folder_private(data: &Path) -> Result<Vec<PathBuf>, String> {
    let mut changed = Vec::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // Only the group's and others' bits go: the owner's own (a program's x) stay as they were.
        let tighten = |p: &Path, changed: &mut Vec<PathBuf>| -> Result<(), String> {
            let m = std::fs::symlink_metadata(p).map_err(|e| format!("{}: {e}", p.display()))?;
            if m.file_type().is_symlink() || m.mode() & 0o077 == 0 {
                return Ok(());
            }
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(m.mode() & 0o700)).map_err(|e| format!("{}: {e}", p.display()))?;
            changed.push(p.to_path_buf());
            Ok(())
        };
        if !data.exists() {
            return Ok(changed);
        }
        tighten(data, &mut changed)?;
        for e in std::fs::read_dir(data).map_err(|e| format!("{}: {e}", data.display()))?.filter_map(Result::ok) {
            let p = e.path();
            match e.file_type() {
                Ok(t) if t.is_file() => tighten(&p, &mut changed)?,
                Ok(t) if t.is_dir() => tighten(&p, &mut changed)?,
                _ => {}
            }
        }
    }
    #[cfg(not(unix))]
    let _ = data;
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// On every OS the agent user has no password (no one logs in as it), no admin rights and no group the owner's
    /// files are shared with, a home only it reads, and settings only it reads, written from stdin: the token is never
    /// an argument `ps` shows.
    #[test]
    fn the_agent_user_has_no_password_no_admin_and_a_private_home() {
        let env = env_file(7788, "tok-secret");
        for os in [Os::Linux, Os::Mac, Os::Windows] {
            let steps = install_steps(os, "lewis", &env, Some(450)).unwrap();
            let all: Vec<String> = steps.iter().flat_map(|s| s.argv.clone()).collect();
            assert!(all.iter().all(|a| !a.contains("tok-secret")), "{os:?}: the token is never an argument");
            assert!(steps.iter().any(|s| s.stdin.as_deref() == Some(env.as_str())), "{os:?}: the settings go in on stdin");
            let joined = all.join(" ");
            for admin in ["wheel", "admin", "sudo ALL", "Administrators", "staff", "-G ", "--groups"] {
                assert!(!joined.contains(admin), "{os:?} puts the agent user in {admin}: {joined}");
            }
            match os {
                Os::Linux => {
                    assert!(joined.contains("useradd --system --user-group"));
                    assert!(joined.contains("chmod 0700 /var/lib/unbrowse-agent"));
                    assert!(!joined.contains("--password"));
                }
                Os::Mac => {
                    assert!(joined.contains("Password *"), "no password");
                    assert!(joined.contains("PrimaryGroupID 450"), "its own group");
                    assert!(joined.contains("chmod 0700 /Users/unbrowse-agent"));
                }
                Os::Windows => {
                    assert!(joined.contains("S-1-5-32-545"), "a standard user");
                    assert!(joined.contains("/inheritance:r"), "its folder keeps no inherited access");
                }
            }
        }
        assert!(install_steps(Os::Mac, "lewis", &env, None).is_err(), "no free id: nothing is made");
        assert!(install_steps(Os::Linux, NAME, &env, None).is_err(), "run as the owner, never as the agent user");
    }

    /// The sudoers rule lets the owner run programs as the agent user and gives nobody anything else; a name that
    /// could change what the line means is refused before anything is written.
    #[test]
    fn the_sudoers_rule_names_the_owner_and_grants_only_the_agent_user() {
        let rule = sudoers_rule("lewis").unwrap();
        let lines: Vec<&str> = rule.lines().filter(|l| !l.starts_with('#')).collect();
        assert_eq!(lines, ["Defaults>unbrowse-agent use_pty", "lewis ALL=(unbrowse-agent) NOPASSWD: ALL"]);
        for bad in ["lewis ALL=(ALL)", "a,b", "-x", "", "x\nroot ALL=(ALL) ALL", "%admin"] {
            assert!(sudoers_rule(bad).is_err(), "{bad:?}");
        }
    }

    /// An install cut short leaves a user that exists and steps that never ran. Only what truly can't run twice is
    /// skipped the next time, so a Mac user with a password field still unset, or a home still open, gets finished.
    #[test]
    fn an_install_cut_short_is_finished_by_the_next() {
        let rerun = |os: Os| -> String {
            let steps = install_steps(os, "lewis", "", Some(450)).unwrap();
            steps.iter().filter(|s| !s.make).map(|s| s.argv.join(" ")).collect::<Vec<_>>().join("\n")
        };
        let linux = rerun(Os::Linux);
        assert!(linux.contains("chmod 0700") && !linux.contains("useradd"), "{linux}");
        let mac = rerun(Os::Mac);
        for needed in ["Password *", "IsHidden 1", "NFSHomeDirectory", "mkdir -p", "chown 450:450", "chmod 0700"] {
            assert!(mac.contains(needed), "{needed} in {mac}");
        }
        let windows = rerun(Os::Windows);
        assert!(windows.contains("icacls") && !windows.contains("New-LocalUser"), "{windows}");
    }

    /// Run again on a user that exists, every Mac step carries that user's id, never the next free one: a new id would
    /// move the user off the home it owns.
    #[test]
    fn a_mac_user_that_exists_keeps_its_id() {
        let (users, groups) = ("root 0\nunbrowse-agent 401\n", "wheel 0\nunbrowse-agent 401\n");
        assert_eq!(mac_id(Some("401\n"), users, groups), Some(401));
        assert_eq!(mac_id(None, users, groups), Some(402), "a new user takes a free one");
        assert_eq!(mac_id(Some("no such user"), users, groups), None, "and nothing is guessed");
    }

    /// Each try of an install used to leave another live key. The agent user's own key is used again, unless its token
    /// is in the owner's files.
    #[test]
    fn an_install_run_again_uses_the_key_it_made() {
        let name = key_name();
        let live = || [(1, "my laptop"), (4, name.as_str()), (7, name.as_str())].into_iter();
        assert_eq!(own_key(live(), &[]), Some(4));
        assert_eq!(own_key(live(), &[4]), Some(7), "not one the owner's programs can read");
        assert_eq!(own_key(live(), &[4, 7]), None);
        assert_eq!(own_key([(1, "my laptop")].into_iter(), &[]), None);
    }

    /// External security review round 3, 2026-11-04. The agent user has no login shell (an install from before this
    /// takes it away too), and what it runs gets a terminal of sudo's own, never the owner's, where it could push keys
    /// in that the owner's shell runs after it exits.
    #[test]
    fn the_agent_user_has_no_login_shell_and_no_terminal_of_the_owners() {
        for (os, no_shell) in [(Os::Linux, NO_SHELL_LINUX), (Os::Mac, NO_SHELL_MAC)] {
            let steps = install_steps(os, "lewis", "", Some(450)).unwrap();
            let joined = steps.iter().map(|s| s.argv.join(" ")).collect::<Vec<_>>().join("\n");
            assert!(!joined.contains("/bin/sh ") && !joined.contains("/bin/zsh"), "{os:?}: no login shell: {joined}");
            assert!(steps.iter().any(|s| !s.make && s.argv.iter().any(|a| a == no_shell)), "{os:?}: taken away on every install, an older user's too");
        }
        let rule = sudoers_rule("lewis").unwrap();
        assert!(rule.lines().any(|l| l == "Defaults>unbrowse-agent use_pty"), "{rule}");
    }

    /// External security review round 3, 2026-11-04. The Windows folder is never a value of the environment that could
    /// mean something in the Administrator shell's script, and every path the script carries is quoted.
    #[test]
    fn no_environment_value_is_read_as_script_in_the_admin_shell() {
        let sly = r"C:\ProgramData'; Remove-Item -Recurse -Force C:\Users; '";
        let default = windows_home(None);
        assert!(default.starts_with(r"C:\ProgramData"));
        assert_eq!(windows_home(Some(sly)), default, "a value with a quote and a ; is never used");
        assert_eq!(windows_home(Some("$(evil)")), default);
        assert!(windows_home(Some(r"D:\Data")).starts_with(r"D:\Data"), "a plain path is");
        assert_eq!(ps_quote("it's"), "'it''s'");
        let scripts: Vec<String> = install_steps(Os::Windows, "lewis", "", None).unwrap().into_iter().chain(remove_steps(Os::Windows)).map(|s| s.argv.join(" ")).collect();
        let home = home(Os::Windows).to_string_lossy().to_string();
        for s in scripts.iter().filter(|s| s.contains(&home)) {
            assert!(s.match_indices(&home).all(|(i, _)| s[..i].ends_with('\'')), "the folder only ever starts a quoted string: {s}");
        }
    }

    #[test]
    fn a_mac_id_is_free_in_both_lists_and_hidden() {
        let users = "_www 70\nlewis 501\n_unbrowse 401\n";
        let groups = "staff 20\nsomething 402\n";
        assert_eq!(free_mac_id(users, groups), Some(403));
        let full: String = (401..500).map(|i| format!("u{i} {i}\n")).collect();
        assert_eq!(free_mac_id(&full, ""), None);
    }

    /// `run` reads the agent's settings as the agent user and runs the program with its arguments as they are, never
    /// through a shell that would read them again.
    #[test]
    fn run_passes_the_program_and_its_arguments_as_they_are() {
        let argv = run_argv(&["claude".into(), "--print".into(), "a; rm -rf ~".into()]);
        assert_eq!(&argv[..4], ["sudo", "-u", NAME, "-H"]);
        assert_eq!(argv.last().unwrap(), "a; rm -rf ~", "one argument, never read as script");
        let win = run_windows_script();
        assert!(win.contains("$i.UserName = 'unbrowse-agent'") && win.contains("-EncodedCommand"), "{win}");
        assert!(win.starts_with("$ErrorActionPreference = 'Stop'"), "a program that never started fails the run: {win}");
        assert!(!win.contains("it's") && !win.contains("claude"), "the program goes encoded, never as script text: {win}");
        let encoded = run_windows_payload(&["claude".into(), "it's".into()]);
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        let inner = String::from_utf16(&bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).unwrap();
        assert!(inner.contains("& 'claude' 'it''s'"), "{inner}");
    }

    #[test]
    fn a_long_windows_agent_command_fits_the_logon_api() {
        let program = ["powershell".into(), "-Command".into(), "Write-Output 'still one argument'; ".repeat(120)];
        let payload = run_windows_payload(&program);
        let script = run_windows_script();
        let args = script.split("$i.Arguments = '").nth(1).unwrap().split('\'').next().unwrap();
        let wide = "powershell.exe ".encode_utf16().count() + args.encode_utf16().count();
        assert!(wide < 1024, "CreateProcessWithLogonW accepts up to 1024 characters, got {wide}");
        assert!(payload.len() > 1024 && !script.contains(&payload));
        assert!(script.contains("$r.StandardInput.BaseStream") && script.contains("[Text.Encoding]::ASCII.GetBytes($payload + [char]10)"));
    }

    /// The probe runs to the end whatever it can't read, and lists only what it could: a last path it can't read
    /// (the answer hoped for) is never taken for the probe failing. Run here as this user, without the `sudo -u`.
    #[cfg(unix)]
    #[test]
    fn the_probe_lists_what_it_could_read_and_runs_to_the_end() {
        let dir = std::env::temp_dir().join(format!("unbrowse-agent-user-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("open"), "x").unwrap();
        let paths = [dir.clone(), dir.join("open"), dir.join("not-there")];
        let argv = probe_argv(&paths);
        assert_eq!(&argv[..4], ["sudo", "-n", "-u", NAME]);
        let out = std::process::Command::new(&argv[4]).args(&argv[5..]).output().unwrap();
        assert!(out.status.success(), "the probe ran to the end: {out:?}");
        let read = probed(&String::from_utf8_lossy(&out.stdout)).expect("its last line");
        assert_eq!(read, [dir.to_string_lossy().to_string(), dir.join("open").to_string_lossy().to_string()]);
        assert_eq!(probed("half a probe\n"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The migration finds every file in the owner's home that holds a live agent key's token (an agent set up as the
    /// owner's user), and nothing in the node's own folder.
    #[test]
    fn the_migration_finds_each_copy_of_an_agent_token_in_the_owners_files() {
        let home = std::env::temp_dir().join(format!("unbrowse-agent-user-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let data = home.join(".unbrowse");
        std::fs::create_dir_all(home.join(".config/agent")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(home.join("node_modules/x")).unwrap();
        std::fs::write(home.join(".zshrc"), "export UNBROWSE_AGENT_TOKEN=tok-one\n").unwrap();
        std::fs::write(home.join(".config/agent/settings.json"), "{\"bearer\": \"tok-two\"}").unwrap();
        std::fs::write(home.join(".config/agent/other.json"), "{}").unwrap();
        std::fs::write(data.join("agents.json"), "tok-one").unwrap();
        std::fs::write(home.join("node_modules/x/a.js"), "tok-one").unwrap();
        let found = token_copies(&home, &data, &["tok-one".into(), "tok-two".into()], 3);
        assert_eq!(found, [home.join(".config/agent/settings.json"), home.join(".zshrc")]);
        assert!(token_copies(&home, &data, &[], 3).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The node's folder and everything directly in it become the owner's alone, whatever an older install left them
    /// as, so the agent user can neither list nor read them.
    #[cfg(unix)]
    #[test]
    fn the_nodes_folder_becomes_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let data = std::env::temp_dir().join(format!("unbrowse-agent-user-perms-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&data);
        std::fs::create_dir_all(data.join("routes")).unwrap();
        for f in ["owner.token", "root.key", "vault.sealed.json"] {
            std::fs::write(data.join(f), "x").unwrap();
            std::fs::set_permissions(data.join(f), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(data.join("routes"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let changed = keep_folder_private(&data).unwrap();
        assert_eq!(changed.len(), 5, "{changed:?}");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&data), 0o700);
        assert_eq!(mode(&data.join("routes")), 0o700);
        assert_eq!(mode(&data.join("owner.token")), 0o600);
        assert!(keep_folder_private(&data).unwrap().is_empty(), "nothing left to change");
        let _ = std::fs::remove_dir_all(&data);
    }
}
