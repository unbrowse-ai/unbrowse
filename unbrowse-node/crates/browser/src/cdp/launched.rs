//! Every browser this process launched and has not closed yet, so none outlives it.
//!
//! A browser is closed by the scope that opened it (`ChromeProcess`'s drop). That covers a scope that ends; it does
//! not cover a process that ends first. `std::process::exit` runs no other thread's drops, and a process killed runs
//! none at all, so a walk in flight when its process stopped left its browser running for good, in a process group of
//! its own that nothing reaps. (A scratch node restarted through a day left 292 such Chrome processes, 2 to 20 hours
//! old, under its tries' profiles.)
//!
//! Two records close that gap. In memory: [`close_all`] closes every browser still open, for a process about to
//! exit. On disk, when the process names a folder ([`keep_records_in`]): one file a browser, naming the process that
//! launched it and its profile, removed when the browser closes. A process that starts with that folder reaps every
//! browser whose launcher is gone, before it launches its own: the property is "its launcher is dead", read from the
//! record, never a name of a profile or a site.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// The browsers open now: the browser's process id, which is its process group's (it is launched as its group's
/// leader), and the record file kept for it, if any.
static OPEN: Mutex<Vec<(u32, Option<PathBuf>)>> = Mutex::new(Vec::new());

/// The folder launch records go in, once a process names one.
static RECORDS: OnceLock<PathBuf> = OnceLock::new();

/// What a record says.
#[derive(serde::Serialize, serde::Deserialize)]
struct Record {
    /// The process that launched the browser.
    owner: u32,
    /// The browser's own process, the leader of its group.
    browser: u32,
    /// The profile it was launched in, which its command line names: a process at that id that doesn't name it is
    /// another process the id was given to since.
    profile: String,
}

/// Keeps a record of each browser this process launches in `dir`, and first reaps every browser a dead launcher left
/// there. Answers how many it reaped. Called once, at the start; a second call reaps nothing and keeps the first folder.
pub fn keep_records_in(dir: &Path) -> usize {
    let reaped = reap_left_by_the_dead(dir);
    let _ = std::fs::create_dir_all(dir);
    let _ = RECORDS.set(dir.to_path_buf());
    reaped
}

/// Notes a browser this process just launched in `profile`.
pub(crate) fn opened(browser: u32, profile: &Path) {
    let file = RECORDS.get().map(|dir| dir.join(format!("{browser}.launch")));
    if let Some(file) = &file {
        let record = Record { owner: std::process::id(), browser, profile: profile.display().to_string() };
        if let Ok(text) = serde_json::to_string(&record) {
            let _ = std::fs::write(file, text);
        }
    }
    let Ok(mut open) = OPEN.lock() else { return };
    open.push((browser, file));
    // A process keeping records (the node) says each launch in its log, as a count: the x-ray's cost strip reads it.
    if RECORDS.get().is_some() {
        eprintln!("browser {{\"launched\":1,\"open\":{}}}", open.len());
    }
}

/// Notes a browser this process launched has closed.
pub(crate) fn closed(browser: u32) {
    let Ok(mut open) = OPEN.lock() else { return };
    open.retain(|(pid, file)| {
        if *pid == browser {
            if let Some(file) = file {
                let _ = std::fs::remove_file(file);
            }
        }
        *pid != browser
    });
}

/// How many browsers this process has open.
pub fn open_count() -> usize {
    OPEN.lock().map(|o| o.len()).unwrap_or(0)
}

/// Closes every browser this process launched and still has open, with its whole process group: for a process about
/// to exit, whose walks in flight will never reach their own close. Answers how many it closed.
pub fn close_all() -> usize {
    close_these(|_| true)
}

/// Closes the open browsers `which` picks (by process id), and takes them off the list: [`close_all`] picks every one.
fn close_these(which: impl Fn(u32) -> bool) -> usize {
    let open: Vec<(u32, Option<PathBuf>)> = OPEN
        .lock()
        .map(|mut o| {
            let (picked, kept) = std::mem::take(&mut *o).into_iter().partition(|(pid, _)| which(*pid));
            *o = kept;
            picked
        })
        .unwrap_or_default();
    for (pid, file) in &open {
        kill_group(*pid);
        if let Some(file) = file {
            let _ = std::fs::remove_file(file);
        }
    }
    open.len()
}

/// Reaps the browsers `dir`'s records say a launcher left: each whose launcher is no longer running (or is this
/// process, which at its start has launched nothing), and that is still the browser the record names. Every record
/// read is removed but those of a launcher still running.
pub fn reap_left_by_the_dead(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let me = std::process::id();
    let mut reaped = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "launch") {
            continue;
        }
        let Some(record) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Record>(&t).ok()) else {
            let _ = std::fs::remove_file(&path);
            continue;
        };
        if record.owner != me && crate::process::alive(record.owner) {
            continue;
        }
        if crate::process::alive(record.browser) && names_profile(record.browser, &record.profile) {
            kill_group(record.browser);
            reaped += 1;
        }
        let _ = std::fs::remove_file(&path);
    }
    reaped
}

/// Whether the process at `pid` is still the browser launched in `profile`: its command line names it.
fn names_profile(pid: u32, profile: &str) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .is_ok_and(|out| String::from_utf8_lossy(&out.stdout).contains(profile))
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, profile);
        false
    }
}

/// Kills the process group `pid` leads, and `pid` itself should it have left it.
fn kill_group(pid: u32) {
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(pid) {
        if pid > 1 {
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;

    /// A stand-in for a browser: a shell leading a process group of its own, with a child in it, whose command line
    /// names `profile` as Chrome's names its `--user-data-dir`.
    fn a_browser(profile: &Path) -> std::process::Child {
        std::process::Command::new("sh")
            .args(["-c", "sleep 60 & wait", &format!("--user-data-dir={}", profile.display())])
            .process_group(0)
            .spawn()
            .unwrap()
    }

    /// How many processes are in `pid`'s group.
    fn in_group(pid: u32) -> usize {
        let out = std::process::Command::new("ps").args(["-A", "-o", "pgid="]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.trim() == pid.to_string()).count()
    }

    fn settle(pid: u32, want: usize) -> usize {
        for _ in 0..40 {
            if in_group(pid) == want {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        in_group(pid)
    }

    /// The id of a process that has ended.
    fn a_dead_pid() -> u32 {
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        pid
    }

    fn a_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("launched-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(dir: &Path, owner: u32, browser: u32, profile: &Path) {
        let r = Record { owner, browser, profile: profile.display().to_string() };
        std::fs::write(dir.join(format!("{browser}.launch")), serde_json::to_string(&r).unwrap()).unwrap();
    }

    /// A browser whose launcher died is reaped by the next process of the same home, its whole group: none is left.
    #[test]
    fn a_browser_a_dead_launcher_left_is_reaped_whole() {
        let dir = a_dir("dead");
        let profile = dir.join("try-profile");
        let mut browser = a_browser(&profile);
        let pid = browser.id();
        assert_eq!(settle(pid, 2), 2, "the stand-in runs as a group of two");
        record(&dir, a_dead_pid(), pid, &profile);
        assert_eq!(reap_left_by_the_dead(&dir), 1);
        let _ = browser.wait();
        assert_eq!(settle(pid, 0), 0, "no process of the browser's group is left");
        assert_eq!(std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().path().extension().is_some_and(|x| x == "launch")).count(), 0, "its record is gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A browser whose launcher still runs is that launcher's, and is left alone; so is a process the record's id was
    /// given to since, which doesn't name the profile.
    #[test]
    fn a_live_launchers_browser_and_a_reused_id_are_left_alone() {
        let dir = a_dir("live");
        let profile = dir.join("walk-profile");
        let mut owner = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        let mut browser = a_browser(&profile);
        let pid = browser.id();
        assert_eq!(settle(pid, 2), 2);
        record(&dir, owner.id(), pid, &profile);
        assert_eq!(reap_left_by_the_dead(&dir), 0, "its launcher runs");
        assert_eq!(in_group(pid), 2);
        record(&dir, a_dead_pid(), pid, &dir.join("another-profile"));
        assert_eq!(reap_left_by_the_dead(&dir), 0, "the id is another process's now");
        assert_eq!(in_group(pid), 2);
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        let _ = browser.wait();
        let _ = owner.kill();
        let _ = owner.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A process about to exit closes every browser it still has open, and has none after.
    #[test]
    fn closing_all_leaves_no_browser_of_this_process() {
        let dir = a_dir("all");
        let mut browsers: Vec<_> = (0..2).map(|i| a_browser(&dir.join(format!("p{i}")))).collect();
        let pids: Vec<u32> = browsers.iter().map(|b| b.id()).collect();
        for (pid, i) in pids.iter().zip(0..) {
            assert_eq!(settle(*pid, 2), 2);
            opened(*pid, &dir.join(format!("p{i}")));
        }
        // Only this test's: another test of this process may have a browser open (a fake Chrome mid-launch), and
        // closing it would fail that test. `close_all` is these, with every browser picked.
        let ours = |pid: u32| pids.contains(&pid);
        let open_of_ours = || OPEN.lock().unwrap().iter().filter(|(p, _)| ours(*p)).count();
        assert_eq!(open_of_ours(), 2);
        assert_eq!(close_these(ours), 2);
        for b in &mut browsers {
            let _ = b.wait();
        }
        for pid in &pids {
            assert_eq!(settle(*pid, 0), 0, "group {pid} is gone");
        }
        assert_eq!(open_of_ours(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod every_system_tests {
    use super::*;

    /// A launcher that is still running keeps its record, on every system: the reaper leaves it to its owner.
    #[test]
    fn a_live_launchers_record_is_kept_on_every_system() {
        let dir = std::env::temp_dir().join(format!("launched-kept-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        #[cfg(windows)]
        let mut owner = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        #[cfg(not(windows))]
        let mut owner = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let r = Record { owner: owner.id(), browser: u32::MAX - 1, profile: dir.join("p").display().to_string() };
        let file = dir.join(format!("{}.launch", r.browser));
        std::fs::write(&file, serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(reap_left_by_the_dead(&dir), 0);
        let kept = file.exists();
        let _ = owner.kill();
        let _ = owner.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(kept, "the record of a launcher still running was removed");
    }
}
