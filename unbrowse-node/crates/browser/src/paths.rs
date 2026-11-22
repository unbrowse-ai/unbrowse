//! Where the engine keeps its browser: the cache directory and the Chrome in it.

use std::cmp::Ordering;
use std::fs;
use std::path::PathBuf;

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

pub fn get_browsers_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agent-browser")
        .join("browsers")
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
    let browsers_dir = get_browsers_dir();
    if !browsers_dir.exists() {
        return None;
    }
    let mut versions: Vec<_> = fs::read_dir(&browsers_dir)
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
    use super::version_order;
    use std::cmp::Ordering;

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
