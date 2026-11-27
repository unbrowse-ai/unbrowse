//! Where the engine keeps its browser: the cache directory and the Chrome in it.

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};

/// The dotted version a browser directory name ends in (`chrome-131.0.6778.85`,
/// `mac_arm-131.0.6778.85`), as numbers.
fn version_of(name: &str) -> Option<Vec<u64>> {
    let tail = name.rsplit('-').next()?;
    tail.split('.').map(|part| part.parse().ok()).collect()
}

/// Orders browser directory names by the version they end in, numerically, so
/// `131.0.6778.264` comes after `131.0.6778.85`. A name with no version sorts
/// below every versioned one, and by its text among its kind.
pub fn version_order(a: &str, b: &str) -> Ordering {
    version_of(a).cmp(&version_of(b)).then_with(|| a.cmp(b))
}

/// The folder `agent-browser install` downloads Chrome for Testing into: `.agent-browser/browsers` under the user's
/// home as the standard library reads it (`USERPROFILE` on Windows, `HOME` elsewhere), the same rule the CLI uses.
pub fn get_browsers_dir() -> PathBuf {
    browsers_dirs(std::env::home_dir(), dirs::home_dir()).remove(0)
}

/// Every folder a downloaded Chrome for Testing may be in, the one the CLI installs into first. `home` is the user's
/// home as the CLI reads it; `profile` is the account's known profile folder. On Windows the two differ under a
/// service, `runas` or a hub that sets `USERPROFILE`: the CLI downloaded into the first while the engine looked only
/// in the second, so a node fetched 205 MB and then could not find it.
pub fn browsers_dirs(home: Option<PathBuf>, profile: Option<PathBuf>) -> Vec<PathBuf> {
    let under = |h: PathBuf| h.join(".agent-browser").join("browsers");
    let mut out = vec![under(home.clone().unwrap_or_else(|| PathBuf::from(".")))];
    if let Some(p) = profile.filter(|p| Some(p) != home.as_ref()) {
        out.push(under(p));
    }
    out
}

/// The folders [`find_installed_chrome`] looks in, in order.
pub fn browsers_dirs_here() -> Vec<PathBuf> {
    browsers_dirs(std::env::home_dir(), dirs::home_dir())
}

/// Where the engine notes each `refused/` folder it set a profile aside in, one path a line, so `doctor` can list what
/// is kept there for the owner. The profiles themselves live wherever the engine's caller keeps them.
pub fn set_aside_index() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agent-browser")
        .join("set-aside")
}

/// The newest Chrome in the cache, if one is installed: the engines's own
/// downloaded build (`chrome-*` version directories).
pub fn find_installed_chrome() -> Option<PathBuf> {
    browsers_dirs_here().iter().find_map(|d| installed_chrome_in(d))
}

/// The newest Chrome for Testing in one browsers folder.
pub fn installed_chrome_in(browsers_dir: &Path) -> Option<PathBuf> {
    if !browsers_dir.exists() {
        return None;
    }
    let mut versions: Vec<_> = fs::read_dir(browsers_dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("chrome-"))
        })
        .collect();
    // Newest version first, by number: the directory name's text would put
    // `.85` above `.264`.
    versions.sort_by(|a, b| {
        version_order(&b.file_name().to_string_lossy(), &a.file_name().to_string_lossy())
    });
    for entry in versions {
        let base = entry.path();
        let candidate = if cfg!(target_os = "macos") {
            base.join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")
        } else if cfg!(target_os = "windows") {
            base.join("chrome.exe")
        } else {
            base.join("chrome")
        };
        if candidate.exists() {
            return Some(candidate);
        }
        // Fall back to any executable named like Chrome inside the version dir.
        if let Ok(inner) = fs::read_dir(&base) {
            for f in inner.filter_map(|e| e.ok()) {
                let p = f.path();
                let name = f.file_name().to_string_lossy().to_string();
                if name.contains("hrome") && p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{browsers_dirs, installed_chrome_in, version_order};
    use std::cmp::Ordering;
    use std::path::PathBuf;

    fn chrome_name() -> &'static str {
        if cfg!(target_os = "macos") {
            "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
        } else if cfg!(target_os = "windows") {
            "chrome.exe"
        } else {
            "chrome"
        }
    }

    // Windows under a service, runas or a hub: USERPROFILE (the CLI's home) is not the account's profile folder.
    // The CLI downloads into the first; the engine must find it there.
    #[test]
    fn a_chrome_the_cli_downloaded_under_another_home_is_found() {
        let root = std::env::temp_dir().join(format!("ab-paths-{}", std::process::id()));
        let home = root.join("svc-home");
        let profile = root.join("Users").join("owner");
        let dirs = browsers_dirs(Some(home.clone()), Some(profile.clone()));
        assert_eq!(dirs[0], home.join(".agent-browser").join("browsers"), "the CLI's folder comes first");
        assert!(dirs.contains(&profile.join(".agent-browser").join("browsers")), "the profile folder is still read");
        let exe = dirs[0].join("chrome-157.0.8103.79").join(chrome_name());
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        let found = dirs.iter().find_map(|d| installed_chrome_in(d));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(found, Some(exe));
    }

    #[test]
    fn one_home_is_one_folder() {
        let h = PathBuf::from("/home/u");
        assert_eq!(browsers_dirs(Some(h.clone()), Some(h.clone())).len(), 1);
        assert_eq!(browsers_dirs(None, Some(h.clone()))[0], PathBuf::from(".").join(".agent-browser").join("browsers"));
    }

    fn newest(mut names: Vec<&str>) -> &str {
        names.sort_by(|a, b| version_order(b, a));
        names[0]
    }

    #[test]
    fn the_newest_browser_is_the_highest_version_not_the_last_name() {
        assert_eq!(newest(vec!["chrome-131.0.6778.85", "chrome-131.0.6778.264"]), "chrome-131.0.6778.264");
        assert_eq!(newest(vec!["chrome-131.0.6778.264", "chrome-131.0.6778.85"]), "chrome-131.0.6778.264");
        assert_eq!(newest(vec!["chrome-131.0.6778.264", "chrome-132.0.6834.83"]), "chrome-132.0.6834.83");
        assert_eq!(newest(vec!["chrome-99.0.1.1", "chrome-100.0.1.1"]), "chrome-100.0.1.1");
        assert_eq!(newest(vec!["mac_arm-131.0.6778.85", "mac_arm-131.0.6778.264"]), "mac_arm-131.0.6778.264");
        assert_eq!(newest(vec!["chrome-latest", "chrome-1.0.0.0"]), "chrome-1.0.0.0");
        assert_eq!(version_order("chrome-a", "chrome-b"), Ordering::Less);
    }
}
