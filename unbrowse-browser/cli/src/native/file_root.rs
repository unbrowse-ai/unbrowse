//! Unbrowse fork: where a command's own file paths may point.
//!
//! A daemon command can name a file to write (a screenshot, a PDF, a HAR, a
//! diff image) or to read (a file to upload, a diff baseline). The command may
//! come from an agent, so a path it names is confined to one declared root:
//! `AGENT_BROWSER_FILE_ROOT`, or `~/.agent-browser/files` when that is unset.
//! A relative path is taken from the working directory when that lies inside
//! the root, and from the root otherwise. A path that resolves outside the
//! root, through `..` or a symlink, is refused.
//!
//! Setting `AGENT_BROWSER_FILE_ROOT=/` is the owner's explicit opt-in to
//! upstream's behaviour, where any path the process can reach is accepted.
//!
//! Writes never follow a symlink at the file itself, and a name the daemon
//! makes up (a timestamped default) is created exclusively, so a file placed
//! there beforehand is never written through.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

pub const FILE_ROOT_ENV: &str = "AGENT_BROWSER_FILE_ROOT";

/// The declared root, absolute (not yet canonical: it may not exist).
pub fn root() -> PathBuf {
    let declared = std::env::var(FILE_ROOT_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let root = declared.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(".agent-browser")
            .join("files")
    });
    normalize(&absolute(&root))
}

fn absolute(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("/"))
            .join(path)
    }
}

/// Removes `.` and `..` without touching the filesystem, so the containment
/// check sees the path the kernel will open. `..` above the filesystem root
/// stays at the root.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !matches!(
                    out.components().next_back(),
                    None | Some(Component::RootDir) | Some(Component::Prefix(_))
                ) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    fs::create_dir_all(root)
        .map_err(|e| format!("Failed to create file root {}: {}", root.display(), e))?;
    root.canonicalize()
        .map_err(|e| format!("Failed to resolve file root {}: {}", root.display(), e))
}

/// The refusal ends with the step that works: an agent can't change the
/// root (the owner sets `AGENT_BROWSER_FILE_ROOT` for the process it runs
/// under), so it is told the path inside the root to use instead, and for a
/// file to read, the copy that puts it there.
fn outside(raw: &str, root: &Path, reading: bool) -> String {
    let name = Path::new(raw)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && n != "..")
        .unwrap_or_else(|| "file".to_string());
    let inside = root.join(&name);
    let door = if reading {
        format!(
            "copy the file in and give that path: cp {} {}, then use '{}'",
            sh_quote(raw),
            sh_quote(&inside.to_string_lossy()),
            inside.display()
        )
    } else {
        format!("write inside it instead, e.g. '{}'", inside.display())
    };
    format!(
        "Path '{}' is outside the file root {} (the owner chooses the root with {}); {}",
        raw,
        root.display(),
        FILE_ROOT_ENV,
        door
    )
}

/// A path as one shell word.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolves `raw` against `root` lexically and checks it stays inside the
/// root as written or as resolved (`real_root`).
fn resolve_in(raw: &str, root: &Path, real_root: &Path, reading: bool) -> Result<PathBuf, String> {
    let inside = |path: &Path| path.starts_with(root) || path.starts_with(real_root);
    if raw.is_empty() {
        return Err("Empty file path".to_string());
    }
    let raw_path = Path::new(raw);
    let joined = if raw_path.is_absolute() {
        raw_path.to_path_buf()
    } else {
        let cwd = std::env::current_dir().ok().map(|cwd| normalize(&cwd));
        match cwd {
            Some(cwd) if inside(&cwd) => cwd.join(raw_path),
            _ => root.join(raw_path),
        }
    };
    let resolved = normalize(&joined);
    if !inside(&resolved) {
        return Err(outside(raw, root, reading));
    }
    Ok(resolved)
}

/// A path a command may write to: inside the root, its directory created and
/// resolved through any symlinks to a place still inside the root.
pub fn output_path(raw: &str) -> Result<PathBuf, String> {
    output_path_in(raw, &root())
}

pub fn output_path_in(raw: &str, root: &Path) -> Result<PathBuf, String> {
    let root = normalize(&absolute(root));
    let real_root = canonical_root(&root)?;
    let resolved = resolve_in(raw, &root, &real_root, false)?;
    let file_name = resolved
        .file_name()
        .ok_or_else(|| format!("Path '{}' names no file", raw))?
        .to_os_string();
    let parent = resolved
        .parent()
        .ok_or_else(|| format!("Path '{}' names no file", raw))?;
    // Check the deepest directory that already exists before creating any,
    // so a symlinked directory inside the root cannot get directories made
    // outside it.
    let existing = parent
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .ok_or_else(|| outside(raw, &root, false))?;
    let real_existing = existing
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {}", existing.display(), e))?;
    if !real_existing.starts_with(&real_root) {
        return Err(outside(raw, &root, false));
    }
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create directory {}: {}", parent.display(), e))?;
    let real_parent = parent
        .canonicalize()
        .map_err(|e| format!("Failed to resolve {}: {}", parent.display(), e))?;
    if !real_parent.starts_with(&real_root) {
        return Err(outside(raw, &root, false));
    }
    Ok(real_parent.join(file_name))
}

/// A directory a command may have the daemon make up file names in.
pub fn output_dir(raw: &str) -> Result<PathBuf, String> {
    let root = root();
    let real_root = canonical_root(&root)?;
    let resolved = resolve_in(raw, &root, &real_root, false)?;
    let dir = output_path_in(&resolved.join("x").to_string_lossy(), &root)?;
    Ok(dir.parent().map(Path::to_path_buf).unwrap_or(dir))
}

/// A file a command may read: it exists, is a regular file, and its real
/// path, after every symlink, is inside the root.
pub fn input_path(raw: &str) -> Result<PathBuf, String> {
    input_path_in(raw, &root())
}

pub fn input_path_in(raw: &str, root: &Path) -> Result<PathBuf, String> {
    let root = normalize(&absolute(root));
    let real_root = root.canonicalize().map_err(|_| outside(raw, &root, true))?;
    let resolved = resolve_in(raw, &root, &real_root, true)?;
    let real = resolved
        .canonicalize()
        .map_err(|e| format!("Failed to resolve '{}': {}", raw, e))?;
    if !real.starts_with(&real_root) {
        return Err(outside(raw, &root, true));
    }
    let meta = fs::metadata(&real).map_err(|e| format!("Failed to read '{}': {}", raw, e))?;
    if !meta.is_file() {
        return Err(format!("Path '{}' is not a regular file", raw));
    }
    Ok(real)
}

fn open_for_write(path: &Path, exclusive: bool) -> std::io::Result<File> {
    if !exclusive {
        if let Ok(meta) = fs::symlink_metadata(path) {
            if !meta.file_type().is_file() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "not a regular file",
                ));
            }
        }
    }
    let mut options = OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// Writes a file the caller named: created or replaced, never through a
/// symlink at that name, never into anything but a regular file.
pub fn write_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    open_for_write(path, false)?.write_all(bytes)
}

/// Writes a file whose name the daemon made up: it must not exist yet.
pub fn write_new_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    open_for_write(path, true)?.write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ab-file-root-{}-{}-{}",
            name,
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn a_caller_path_outside_the_root_is_refused() {
        let base = scratch("outside");
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        let victim = base.join("victim.json");
        for raw in [
            victim.to_string_lossy().to_string(),
            root.join("../victim.json").to_string_lossy().to_string(),
            "/etc/passwd".to_string(),
        ] {
            assert!(output_path_in(&raw, &root).is_err(), "{raw} must be refused");
        }
        fs::write(&victim, "x").unwrap();
        assert!(input_path_in(&victim.to_string_lossy(), &root).is_err());
        let _ = fs::remove_dir_all(base);
    }

    // UNB-148: agents told only to "set AGENT_BROWSER_FILE_ROOT" (which they can't, under the node) tried again; the
    // refusal now ends with the copy and the path inside the root that work.
    #[test]
    fn a_refused_path_names_the_copy_and_the_path_that_work() {
        let base = scratch("door");
        let root = base.join("root");
        fs::create_dir_all(&root).unwrap();
        let cv = base.join("my CV.pdf");
        fs::write(&cv, "x").unwrap();
        let real_root = root.canonicalize().unwrap();
        let err = input_path_in(&cv.to_string_lossy(), &root).unwrap_err();
        let inside = root.join("my CV.pdf");
        assert!(err.ends_with(&format!("cp '{}' '{}', then use '{}'", cv.display(), inside.display(), inside.display())), "{err}");
        assert!(err.contains("the owner chooses the root with AGENT_BROWSER_FILE_ROOT"), "{err}");
        fs::copy(&cv, &inside).unwrap();
        assert_eq!(input_path_in(&inside.to_string_lossy(), &root).unwrap(), real_root.join("my CV.pdf"), "the named door opens");
        let err = output_path_in("/etc/shot.png", &root).unwrap_err();
        assert!(err.ends_with(&format!("write inside it instead, e.g. '{}'", root.join("shot.png").display())), "{err}");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_caller_path_inside_the_root_resolves_there() {
        let base = scratch("inside");
        let root = base.join("root");
        let out = output_path_in(&root.join("a/b/shot.png").to_string_lossy(), &root).unwrap();
        assert_eq!(out, root.canonicalize().unwrap().join("a/b/shot.png"));
        assert!(root.join("a/b").is_dir());
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_inside_the_root_never_leads_outside() {
        let base = scratch("symlink");
        let root = base.join("root");
        let elsewhere = base.join("elsewhere");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        let secret = elsewhere.join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        std::os::unix::fs::symlink(&elsewhere, root.join("dir")).unwrap();
        std::os::unix::fs::symlink(&secret, root.join("file.txt")).unwrap();

        assert!(output_path_in(&root.join("dir/new/x.png").to_string_lossy(), &root).is_err());
        assert!(!elsewhere.join("new").exists(), "no directory made outside the root");
        assert!(input_path_in(&root.join("file.txt").to_string_lossy(), &root).is_err());
        assert!(input_path_in(&root.join("dir/secret.txt").to_string_lossy(), &root).is_err());
        let _ = fs::remove_dir_all(base);
    }

    #[cfg(unix)]
    #[test]
    fn a_write_never_follows_a_symlink_at_the_file() {
        let base = scratch("nofollow");
        let victim = base.join("victim.txt");
        fs::write(&victim, "known").unwrap();
        let planted = base.join("screenshot-1.png");
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        assert!(write_file(&planted, b"png").is_err());
        assert!(write_new_file(&planted, b"png").is_err());
        assert_eq!(fs::read_to_string(&victim).unwrap(), "known");

        let dangling = base.join("screenshot-2.png");
        std::os::unix::fs::symlink(base.join("created-by-follow"), &dangling).unwrap();
        assert!(write_new_file(&dangling, b"png").is_err());
        assert!(!base.join("created-by-follow").exists());
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_made_up_name_is_never_written_through_an_existing_file() {
        let base = scratch("exclusive");
        let existing = base.join("screenshot-3.png");
        fs::write(&existing, "known").unwrap();
        let err = write_new_file(&existing, b"png").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&existing).unwrap(), "known");
        // A caller-named path is replaced in place.
        write_file(&existing, b"png").unwrap();
        assert_eq!(fs::read(&existing).unwrap(), b"png");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn the_filesystem_root_as_file_root_accepts_any_path() {
        let base = scratch("optin");
        let target = base.join("anywhere/out.pdf");
        let out = output_path_in(&target.to_string_lossy(), Path::new("/")).unwrap();
        assert_eq!(out, target);
        let _ = fs::remove_dir_all(base);
    }
}
