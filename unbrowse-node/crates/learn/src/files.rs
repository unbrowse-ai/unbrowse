//! Where a route's file inputs may be read from.
//!
//! A route that uploads takes its file by path, and the path comes from whoever calls the route. So a path is
//! confined to the same root the node's browser confines its own file paths to: `AGENT_BROWSER_FILE_ROOT`, or
//! `~/.agent-browser/files` when that is unset. A relative path is taken from the root. A path that resolves outside
//! the root, through `..` or a symlink, is refused, and so is anything that is not a regular file. What a file holds
//! is never logged and never kept: it is read chunk by chunk as the upload sends it.

use std::fs::File;
use std::path::{Component, Path, PathBuf};

pub const FILE_ROOT_ENV: &str = "AGENT_BROWSER_FILE_ROOT";

/// The declared root, absolute (not yet canonical: it may not exist).
pub fn root() -> PathBuf {
    let declared = std::env::var(FILE_ROOT_ENV).ok().filter(|v| !v.trim().is_empty()).map(PathBuf::from);
    let root = declared.unwrap_or_else(|| dirs::home_dir().unwrap_or_else(std::env::temp_dir).join(".agent-browser").join("files"));
    normalize(&absolute(&root))
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")).join(path)
    }
}

/// Removes `.` and `..` without touching the filesystem, so the containment check sees the path the kernel will open.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(out.components().next_back(), None | Some(Component::RootDir) | Some(Component::Prefix(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// A file the caller named, as its real path inside `root`: it exists, is a regular file, and its real path, after
/// every symlink, is inside the root's real path.
pub fn input_path_in(raw: &str, root: &Path) -> Result<PathBuf, String> {
    // UNB-148: the refusal ends with the copy that works; an agent can't set the root, the owner does.
    let outside = || {
        let name = Path::new(raw).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| n != "..").unwrap_or_else(|| "file".into());
        let inside = root.join(&name);
        format!(
            "{raw} is outside the file root {} (the owner chooses the root with {FILE_ROOT_ENV}); copy the file in and give that path: cp '{}' '{}', then use '{}'",
            root.display(),
            raw.replace('\'', r"'\''"),
            inside.display().to_string().replace('\'', r"'\''"),
            inside.display()
        )
    };
    if raw.trim().is_empty() {
        return Err("no file path given".into());
    }
    let root = normalize(&absolute(root));
    let real_root = root.canonicalize().map_err(|_| outside())?;
    let raw_path = Path::new(raw);
    let joined = if raw_path.is_absolute() { raw_path.to_path_buf() } else { root.join(raw_path) };
    let resolved = normalize(&joined);
    if !resolved.starts_with(&root) && !resolved.starts_with(&real_root) {
        return Err(outside());
    }
    let real = resolved.canonicalize().map_err(|_| format!("{raw}: no such file in the file root"))?;
    if !real.starts_with(&real_root) {
        return Err(outside());
    }
    if !std::fs::metadata(&real).map_err(|_| format!("{raw}: can't be read"))?.is_file() {
        return Err(format!("{raw} is not a regular file"));
    }
    Ok(real)
}

/// A file the caller named, open for reading, with its size and its name. It is opened at its real path and then
/// checked to be the file that path named, so a symlink swapped in between the check and the open is refused.
pub struct Opened {
    pub file: File,
    pub size: u64,
    pub name: String,
}

pub fn open_in(raw: &str, root: &Path) -> Result<Opened, String> {
    let real = input_path_in(raw, root)?;
    let file = File::open(&real).map_err(|_| format!("{raw}: can't be read"))?;
    let meta = file.metadata().map_err(|_| format!("{raw}: can't be read"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = std::fs::symlink_metadata(&real).map_err(|_| format!("{raw}: can't be read"))?;
        if !named.file_type().is_file() || named.dev() != meta.dev() || named.ino() != meta.ino() {
            return Err(format!("{raw} changed while it was being opened"));
        }
    }
    if !meta.is_file() {
        return Err(format!("{raw} is not a regular file"));
    }
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Opened { file, size: meta.len(), name })
}

/// The size of a file the walk may have uploaded, when `raw` names one inside the default root.
pub fn size_of(raw: &str) -> Option<u64> {
    if raw.len() > 4096 || raw.contains('\n') {
        return None;
    }
    let real = input_path_in(raw, &root()).ok()?;
    std::fs::metadata(real).ok().map(|m| m.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("unbrowse-files-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn a_file_outside_the_root_is_refused_however_it_is_named() {
        let base = scratch("outside");
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(base.join("secret.txt"), "x").unwrap();
        std::fs::write(root.join("clip.mp4"), "video").unwrap();
        for raw in [base.join("secret.txt").to_string_lossy().into_owned(), "../secret.txt".into(), root.join("../secret.txt").to_string_lossy().into_owned(), "/etc/passwd".into()] {
            assert!(input_path_in(&raw, &root).is_err(), "{raw} must be refused");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), root.join("link.txt")).unwrap();
            assert!(input_path_in("link.txt", &root).is_err(), "a symlink out of the root is refused");
        }
        std::fs::create_dir_all(root.join("dir")).unwrap();
        assert!(input_path_in("dir", &root).is_err(), "a directory is not a file");
        let opened = open_in("clip.mp4", &root).unwrap();
        assert_eq!((opened.size, opened.name.as_str()), (5, "clip.mp4"));
        assert!(open_in(&root.join("clip.mp4").to_string_lossy(), &root).is_ok());
        let _ = std::fs::remove_dir_all(base);
    }

    // UNB-148: the refusal ends with the copy and the path that work, and that path is taken.
    #[test]
    fn a_refused_file_names_the_copy_that_works() {
        let base = scratch("door");
        let root = base.join("root");
        std::fs::create_dir_all(&root).unwrap();
        let cv = base.join("cv.pdf");
        std::fs::write(&cv, "x").unwrap();
        let err = input_path_in(&cv.to_string_lossy(), &root).unwrap_err();
        let inside = root.join("cv.pdf");
        assert!(err.ends_with(&format!("cp '{}' '{}', then use '{}'", cv.display(), inside.display(), inside.display())), "{err}");
        std::fs::copy(&cv, &inside).unwrap();
        assert!(input_path_in(&inside.to_string_lossy(), &root).is_ok(), "the named door opens");
        let _ = std::fs::remove_dir_all(base);
    }
}
