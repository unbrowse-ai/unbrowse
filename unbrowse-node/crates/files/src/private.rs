//! Where the node keeps its files, and how it writes them: readable by its owner alone.
//!
//! The node's files hold its sessions (jars), its routes, its keys and what it did, so every file it writes is 0600
//! and every folder it makes is 0700. A write lands whole or not at all: it goes to a temporary file of its own beside
//! the target and is renamed over it, so a reader never sees half of one, and two writers of one record never write
//! into the same temporary file (whichever renames last leaves a whole record). Windows keeps a file in the user's
//! profile to that user already.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The user's home folder: `HOME`, else Windows' `USERPROFILE`, else the working folder.
pub fn user_home() -> PathBuf {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// The node's home: the reader [`read_home_with`] set when there is one, else [`default_home`]. Every crate asks here,
/// so a test that gives its thread a scratch home has the engine and the learner open their profiles, jars and
/// browsers there too, never in the owner's.
pub fn home() -> PathBuf {
    match HOME_READER.get() {
        Some(read) => read(),
        None => default_home(),
    }
}

/// `UNBROWSE_HOME` when set, else `.unbrowse` in the user's home.
pub fn default_home() -> PathBuf {
    std::env::var_os("UNBROWSE_HOME").map(PathBuf::from).unwrap_or_else(|| user_home().join(".unbrowse"))
}

static HOME_READER: std::sync::OnceLock<fn() -> PathBuf> = std::sync::OnceLock::new();

/// Has [`home`] answer with `read` from now on, for the whole process (the first reader set stays). A test binary sets
/// the one that knows each test's scratch home; a node never sets one.
pub fn read_home_with(read: fn() -> PathBuf) {
    let _ = HOME_READER.set(read);
}

/// Writes `bytes` at `path`, whole, readable by the owner alone; the folder is made private if it isn't there.
pub fn write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        dir_at(dir)?;
    }
    let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.{n}.tmp", std::process::id()));
    let tmp = PathBuf::from(tmp);
    let written = open(&tmp, false).and_then(|mut f| f.write_all(bytes)).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Writes `bytes` as a new file at `path`, readable by the owner alone: one already there is never written over.
pub fn create_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)?.write_all(bytes)
}

/// A folder only its owner may enter, made if it isn't there (a folder already there keeps its mode; [`narrow`]
/// narrows one the node owns).
pub fn dir_at(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// Narrows a folder the node keeps its own state in to its owner alone (0700): one made before the node made its
/// folders private.
pub fn narrow(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Opens a file only its owner may read or change: emptied first, or appended to when `append`.
pub fn open(path: &Path, append: bool) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.create(true);
    if append {
        o.append(true);
    } else {
        o.write(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        o.mode(0o600);
        let f = o.open(path)?;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        Ok(f)
    }
    #[cfg(not(unix))]
    o.open(path)
}

/// The node's own scratch folder, for what it writes and reads back while it works (a walk's capture, a throwaway
/// profile, a command's output): under the node's home, its owner's alone (0700), never the machine's shared temporary
/// folder, where another local user could make a name first and have the node read their file or write through their
/// link.
pub fn scratch() -> std::io::Result<PathBuf> {
    scratch_in(&home())
}

/// [`scratch`], under `home`.
pub fn scratch_in(home: &Path) -> std::io::Result<PathBuf> {
    let dir = home.join("tmp");
    dir_at(&dir)?;
    narrow(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scratch folder sits in the node's home and is its owner's alone, a looser one narrowed.
    #[test]
    #[cfg(unix)]
    fn the_scratch_folder_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let home = scratch("tmp");
        std::fs::create_dir_all(home.join("tmp")).unwrap();
        std::fs::set_permissions(home.join("tmp"), std::fs::Permissions::from_mode(0o777)).unwrap();
        let dir = scratch_in(&home).unwrap();
        assert!(dir.starts_with(&home));
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        let _ = std::fs::remove_dir_all(home);
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("unbrowse-files-private-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_write_is_the_owners_alone_and_leaves_no_temporary_file() {
        let dir = scratch("write");
        let file = dir.join("nested/record.json");
        write(&file, b"one").unwrap();
        write(&file, b"two").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1, "only the record is left");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_file_is_never_written_over() {
        let dir = scratch("new");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("backup.json");
        create_new(&file, b"first").unwrap();
        assert!(create_new(&file, b"second").is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"first");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
