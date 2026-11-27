//! The half of an install a disk image leaves to the app: the skill where each agent reads one, the commands on the
//! PATH, and what becomes of what was there already.

use super::*;

const NODE: &str = "http://127.0.0.1:7788";

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A scratch home and the programs folder beside it, with the agents named installed: each one's program, as an
/// installer leaves it there (`Client::found` is the reader of that).
fn machine(name: &str, agents: &[&str]) -> (Scratch, Machine) {
    let base = std::env::temp_dir().join(format!("unb-install-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let home = base.join("home");
    let programs = base.join("programs");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&programs).unwrap();
    for a in agents {
        std::fs::write(programs.join(a), "#!/bin/sh\n").unwrap();
    }
    let m = Machine {
        home,
        claude_config_dir: None,
        codex_home: None,
        unbrowse_config_dir: None,
        xdg_config_home: None,
        node: NODE.into(),
        programs: vec![programs],
    };
    (Scratch(base), m)
}

fn read_at(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

/// The skill goes into the skills folder of every agent found here, and nowhere else: an agent that isn't installed gets
/// nothing, so no folder an agent never reads is made to look like one it does.
#[test]
fn the_skill_goes_where_each_agent_on_this_machine_reads_one() {
    let (_s, m) = machine("readers", &["claude", "codex"]);
    let done = run(&m, &m.programs[0], Parts::ALL, false);
    assert_eq!(read_at(&m.home.join(".claude/skills/unbrowse/SKILL.md")), SKILL);
    assert_eq!(read_at(&m.home.join(".codex/skills/unbrowse/SKILL.md")), SKILL);
    assert!(!m.home.join(".hermes").exists(), "no Hermes here, so no skill for one");
    assert!(done.skill.iter().all(|p| p.changed), "{done:?}");
    assert!(done.skipped.is_none(), "{done:?}");
}

/// A folder at the skill's name that an Unbrowse install didn't write is the owner's: it is moved beside the skills
/// folder whole, never deleted, and the new skill takes its place.
#[test]
fn a_copy_unbrowse_didnt_write_is_kept_beside_the_skills_and_never_deleted() {
    let (_s, m) = machine("kept", &["claude"]);
    let own = m.home.join(".claude/skills/unbrowse");
    std::fs::create_dir_all(&own).unwrap();
    std::fs::write(own.join("SKILL.md"), "the owner's own skill").unwrap();
    let done = run(&m, &m.programs[0], Parts { skill: true, commands: false }, false);
    assert_eq!(read_at(&own.join("SKILL.md")), SKILL);
    let kept = done.skill[0].kept.as_ref().expect("what was there is kept");
    assert_eq!(read_at(&kept.join("SKILL.md")), "the owner's own skill");
    assert!(kept.starts_with(m.home.join(".claude/unbrowse-kept")), "{}", kept.display());
}

/// A copy this install wrote, edited since, is the owner's too: an edit is never taken for our own copy and replaced.
#[test]
fn a_copy_edited_after_its_install_is_the_owners() {
    let (_s, m) = machine("edited", &["claude"]);
    let own = m.home.join(".claude/skills/unbrowse");
    run(&m, &m.programs[0], Parts { skill: true, commands: false }, false);
    std::fs::write(own.join("SKILL.md"), "a line the owner added").unwrap();
    let done = run(&m, &m.programs[0], Parts { skill: true, commands: false }, false);
    let kept = done.skill[0].kept.as_ref().expect("the edit is kept");
    assert_eq!(read_at(&kept.join("SKILL.md")), "a line the owner added");
    assert_eq!(read_at(&own.join("SKILL.md")), SKILL);
}

/// The record this writes is the npm package's shape, so a copy that package installed reads as ours and is replaced
/// whole, with nothing kept aside.
#[test]
fn a_record_the_npm_install_wrote_reads_as_ours() {
    let (_s, m) = machine("npm", &["claude"]);
    let dir = m.home.join(".claude/skills/unbrowse");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("SKILL.md"), SKILL).unwrap();
    let record = serde_json::json!({ "SKILL.md": hex::encode(Sha256::digest(SKILL.as_bytes())) });
    std::fs::write(dir.join(RECORD), record.to_string()).unwrap();
    let placed = install_into(&dir, false).unwrap();
    assert!(placed.kept.is_none(), "{placed:?}");
    assert!(!placed.changed, "the copy is the one this build carries already");
}

/// Run again, nothing is written: a skill already as this build carries it, and a link already pointing at these
/// programs, are left alone and said to be unchanged, so a start may check every time.
#[test]
fn a_second_run_finds_the_skill_and_the_links_already_right() {
    let (_s, m) = machine("again", &["claude"]);
    run(&m, &m.programs[0], Parts::ALL, false);
    let again = run(&m, &m.programs[0], Parts::ALL, false);
    let all: Vec<&Placed> = again.skill.iter().chain(again.commands.iter()).chain(again.path_file.iter()).collect();
    assert!(!all.is_empty());
    assert!(all.iter().all(|p| !p.changed), "{again:?}");
}

/// The commands are links to the programs of the install that made them, so an update in place takes effect at once and
/// a second install of another version replaces the target rather than leaving a stale copy.
#[cfg(unix)]
#[test]
fn the_commands_are_links_to_the_programs_of_the_install_that_made_them() {
    let (_s, m) = machine("links", &["claude"]);
    let (placed, _bin) = commands(&m.home, &m.programs[0], false).unwrap();
    assert_eq!(placed.len(), 3);
    for (name, target) in [("unb", "unb"), ("unbrowse-node", "unbrowse-node"), ("unbrowse", "unb")] {
        let link = m.home.join(".local/bin").join(name);
        assert_eq!(std::fs::read_link(&link).unwrap(), m.programs[0].join(target), "{name}");
    }
}

/// The PATH line goes in once, into the file this shell reads, and a file that already names `~/.local/bin` is left
/// exactly as it was, whatever put the line there.
#[test]
fn a_path_line_goes_in_once_and_a_shell_that_has_it_is_left_alone() {
    let (_s, m) = machine("path", &["claude"]);
    std::env::set_var("SHELL", "/bin/zsh");
    let first = run(&m, &m.programs[0], Parts::ALL, false);
    let rc = m.home.join(".zprofile");
    assert!(first.path_file.as_ref().is_some_and(|p| p.changed));
    let after = read_at(&rc);
    assert_eq!(after.matches("# Unbrowse's commands").count(), 1, "{after}");
    assert!(after.contains("$HOME/.local/bin"), "{after}");
    run(&m, &m.programs[0], Parts::ALL, false);
    assert_eq!(read_at(&rc), after, "a second run adds nothing");
    std::fs::write(&rc, "export PATH=\"$HOME/.local/bin:$PATH\"\n").unwrap();
    let third = run(&m, &m.programs[0], Parts::ALL, false);
    assert!(!third.path_file.as_ref().unwrap().changed);
    assert_eq!(read_at(&rc), "export PATH=\"$HOME/.local/bin:$PATH\"\n");
    std::env::remove_var("SHELL");
}

/// A program running from a disk image or a translocated copy puts no commands on the PATH: the link would break the
/// moment the image went away. The skill still goes in — it is a copy, not a link — and the run says what to do first.
#[test]
fn the_commands_wait_for_an_app_in_applications() {
    let (_s, m) = machine("volume", &["claude"]);
    for from in ["/Volumes/Unbrowse/Unbrowse.app/Contents/MacOS", "/private/var/folders/x/AppTranslocation/1/d/Unbrowse.app/Contents/MacOS"] {
        let done = run(&m, Path::new(from), Parts::ALL, false);
        assert!(done.commands.is_empty(), "{done:?}");
        assert!(done.skipped.as_deref().unwrap_or_default().contains("Applications"), "{done:?}");
    }
    assert_eq!(read_at(&m.home.join(".claude/skills/unbrowse/SKILL.md")), SKILL, "the skill is a copy and goes in");
}

/// A dry run says what it would do and writes nothing at all: no skill, no link, no line in any file.
#[test]
fn a_dry_run_writes_nothing_and_says_what_it_would_do() {
    let (_s, m) = machine("dry", &["claude"]);
    std::env::set_var("SHELL", "/bin/zsh");
    let done = run(&m, &m.programs[0], Parts::ALL, true);
    assert!(!m.home.join(".claude/skills/unbrowse").exists());
    assert!(!m.home.join(".local/bin").exists());
    assert!(!m.home.join(".zprofile").exists());
    assert!(done.skill.iter().all(|p| p.changed), "it says what it would put there: {done:?}");
    assert!(done.said().contains("dry run"), "{}", done.said());
    std::env::remove_var("SHELL");
}

/// What the setup list says is read from the folders, not from a record of what a run thought it did: the agents whose
/// folder holds this build's skill, and the ones it is missing from.
#[test]
fn what_the_setup_list_says_is_read_from_the_folders() {
    let (_s, m) = machine("found", &["claude", "codex"]);
    assert_eq!(found(&m), (Vec::new(), vec!["Claude Code".to_string(), "Codex".to_string()]));
    run(&m, &m.programs[0], Parts::ALL, false);
    assert_eq!(found(&m), (vec!["Claude Code".to_string(), "Codex".to_string()], Vec::new()));
}

/// Two files that are not an Unbrowse install's link are never written over: the program of an install that lives in
/// the very folder the commands go in (a link there would point at itself, and making it would take the program with
/// it), and a program of somebody else's at a command's name. Both are left exactly as they were, and the run says so.
#[cfg(unix)]
#[test]
fn a_program_of_its_own_at_a_commands_name_is_left_as_it_is() {
    let (_s, m) = machine("ownprogram", &["claude"]);
    let bin = m.home.join(".local/bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("unb"), "somebody else's unb\n").unwrap();
    let (placed, _) = commands(&m.home, &m.programs[0], false).unwrap();
    assert_eq!(read_at(&bin.join("unb")), "somebody else's unb\n", "not replaced, not removed");
    let theirs = placed.iter().find(|p| p.what == "unb").unwrap();
    assert!(!theirs.changed);
    assert!(theirs.note.is_some(), "the run says it left it alone: {theirs:?}");
    // The program living in that folder is its own command: unb is a real file there and stays one.
    let here = Machine { home: bin.parent().unwrap().to_path_buf(), ..m.clone() };
    std::fs::create_dir_all(here.home.join(".local/bin")).unwrap();
    std::fs::write(here.home.join(".local/bin/unb"), "#!/bin/sh\n").unwrap();
    let (placed, _) = commands(&here.home, &here.home.join(".local/bin"), false).unwrap();
    assert_eq!(read_at(&here.home.join(".local/bin/unb")), "#!/bin/sh\n", "not taken away by a link to itself");
    assert!(placed.iter().find(|p| p.what == "unb").is_some_and(|p| !p.changed));
}

/// What a run says names each part as it stands: no agent that reads skills, commands already on the PATH (no line
/// added), why a part was left undone, and the note on anything left as it was.
#[test]
fn what_a_run_says_names_what_it_left_and_why() {
    let placed = |what: &str, note: Option<&str>| Placed { what: what.into(), at: PathBuf::from("/x"), kept: None, changed: false, note: note.map(String::from) };
    let done = Done {
        commands: vec![placed("unb", Some("a program of its own is there, so it is left as it is")), placed("unbrowse", None)],
        path_file: Some(placed("PATH", None)),
        skipped: Some("a folder only the owner can make".into()),
        ..Done::default()
    };
    let said = done.said();
    assert!(said.starts_with("no agent on this computer reads skills; "), "{said}");
    assert!(said.contains("unb, unbrowse are on your PATH;") && !said.contains("one line added"), "{said}");
    assert!(said.contains("; a folder only the owner can make"), "{said}");
    assert!(said.contains("unb: a program of its own is there"), "{said}");
    assert!(!said.contains("dry run"), "{said}");
}

/// The skill's hash is the SHA-256 of the skill this program carries, as hex: what the settings keep so a start knows
/// the skill in place is this build's.
#[test]
fn the_skill_hash_is_the_sha256_of_the_skill_carried() {
    let hash = skill_hash();
    assert_eq!(hash, hex::encode(Sha256::digest(SKILL.as_bytes())));
    assert_eq!(hash.len(), 64);
}

/// With no `date` to ask, the stamp is UTC worked out here: a unix time read as its calendar date and time, across a
/// leap day and before 1970.
#[test]
fn a_stamp_without_a_date_program_is_utc_worked_out_here() {
    assert_eq!(civil(0), (1970, 1, 1, 0, 0, 0));
    assert_eq!(civil(951_782_400), (2000, 2, 29, 0, 0, 0));
    assert_eq!(civil(1_000_000_000), (2001, 9, 9, 1, 46, 40));
    assert_eq!(civil(-1), (1969, 12, 31, 23, 59, 59));
    let said = stamp_by("no-such-date-program-unbrowse");
    assert_eq!(said.len(), 14, "{said}");
    assert!(said.chars().all(|c| c.is_ascii_digit()), "{said}");
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let (y, mo, d, ..) = civil(secs);
    let today = format!("{y:04}{mo:02}{d:02}");
    let (y, mo, d, ..) = civil(secs - 60);
    let a_minute_ago = format!("{y:04}{mo:02}{d:02}");
    assert!(said.starts_with(&today) || said.starts_with(&a_minute_ago), "{said} on {today}");
}

/// A second thing kept in the same second never takes the first one's name: it gets the next number after it.
#[test]
fn a_second_copy_kept_in_the_same_second_gets_a_name_of_its_own() {
    let (_s, m) = machine("collide", &[]);
    let to = m.home.join(".claude/skills/unbrowse");
    std::fs::create_dir_all(&to).unwrap();
    std::fs::write(to.join("SKILL.md"), "the owner's own skill").unwrap();
    let kept = m.home.join(".claude").join(KEPT);
    loop {
        let s = stamp();
        std::fs::create_dir_all(kept.join(format!("unbrowse.before-unbrowse-{s}"))).unwrap();
        let got = kept_beside(&to, true).unwrap().expect("there is something to keep");
        if stamp() == s {
            assert_eq!(got, kept.join(format!("unbrowse.before-unbrowse-{s}-1")));
            break;
        }
    }
    assert_eq!(read_at(&to.join("SKILL.md")), "the owner's own skill", "a dry run moves nothing");
}

/// The PATH line added to a file whose last line has no line end starts on a line of its own, and what was there is
/// left as it was.
#[test]
fn a_path_line_after_a_last_line_with_no_end_starts_on_its_own_line() {
    let (_s, m) = machine("noend", &[]);
    for f in [".zprofile", ".bash_profile", ".profile", ".config/fish/config.fish"] {
        let at = m.home.join(f);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, "export X=1").unwrap();
    }
    let p = ensure_path(&m.home, false).unwrap();
    assert!(p.changed);
    let after = read_at(&p.at);
    assert!(after.starts_with("export X=1\n\n# Unbrowse's commands\n"), "{after:?}");
}

/// A skills folder that can't be made (a file is at its name) leaves the skill undone and says why; the file is kept.
#[test]
fn a_skills_folder_that_cant_be_made_is_said_and_the_file_there_kept() {
    let (_s, m) = machine("noskills", &["claude"]);
    std::fs::create_dir_all(m.home.join(".claude")).unwrap();
    std::fs::write(m.home.join(".claude/skills"), "a file of the owner's").unwrap();
    let done = run(&m, &m.programs[0], Parts { skill: true, commands: false }, false);
    assert!(done.skill.is_empty(), "{done:?}");
    assert!(done.skipped.as_deref().unwrap_or_default().contains("skills"), "{done:?}");
    assert_eq!(read_at(&m.home.join(".claude/skills")), "a file of the owner's");
}

/// Commands that can't be linked (a file is where their folder goes) are said, and no PATH line is added for them.
#[cfg(unix)]
#[test]
fn commands_that_cant_be_linked_are_said_and_add_no_path_line() {
    let (_s, m) = machine("nobin", &[]);
    std::fs::create_dir_all(m.home.join(".local")).unwrap();
    std::fs::write(m.home.join(".local/bin"), "a file of the owner's").unwrap();
    let done = run(&m, &m.programs[0], Parts { skill: false, commands: true }, false);
    assert!(done.commands.is_empty(), "{done:?}");
    assert!(done.path_file.is_none(), "{done:?}");
    assert!(done.skipped.is_some(), "{done:?}");
    assert_eq!(read_at(&m.home.join(".local/bin")), "a file of the owner's");
}

/// A PATH line that can't be written (a folder is where the shell's file goes) is said; the commands are still linked.
#[cfg(unix)]
#[test]
fn a_path_line_that_cant_be_written_is_said() {
    let (_s, m) = machine("nopath", &[]);
    for f in [".zprofile", ".bash_profile", ".profile", ".config/fish/config.fish"] {
        std::fs::create_dir_all(m.home.join(f)).unwrap();
    }
    let done = run(&m, &m.programs[0], Parts { skill: false, commands: true }, false);
    assert_eq!(done.commands.len(), 3, "{done:?}");
    assert!(done.path_file.is_none(), "{done:?}");
    assert!(done.skipped.is_some(), "{done:?}");
}
