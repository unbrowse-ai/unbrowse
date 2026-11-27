//! Which Chrome agent-browser launches when no `--executable-path` is given (no browser is started).
//!
//! The node runs `agent-browser install` and then lets the CLI find that Chrome, so the search order is part of its
//! interface: the Chrome that `install` downloaded first (newest version that holds a binary), then the system's,
//! then Puppeteer's and Playwright's caches. An upgrade that reorders or drops one of these launches a different
//! browser than the one the node installed, or none.
#![cfg(target_os = "linux")]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::install::find_installed_chrome;
use crate::native::cdp::chrome::find_chrome;
use crate::test_utils::EnvGuard;

const VARS: &[&str] = &[
    "HOME",
    "PATH",
    "PUPPETEER_CACHE_DIR",
    "PLAYWRIGHT_BROWSERS_PATH",
    "AGENT_BROWSER_DEBUG",
];

fn binary(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "").unwrap();
    path.to_path_buf()
}

/// A temp HOME, and a PATH holding only a `which` that knows `chromium` when `system` is set.
fn home(guard: &EnvGuard, system: Option<&str>) -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let found = system
        .map(|p| format!("[ \"$1\" = chromium ] && echo {p} && exit 0\n"))
        .unwrap_or_default();
    let which = bin.join("which");
    std::fs::write(&which, format!("#!/bin/sh\n{found}exit 1\n")).unwrap();
    std::fs::set_permissions(&which, std::fs::Permissions::from_mode(0o755)).unwrap();
    guard.set("HOME", root.path().to_str().unwrap());
    guard.set("PATH", bin.to_str().unwrap());
    guard.remove("PUPPETEER_CACHE_DIR");
    guard.remove("PLAYWRIGHT_BROWSERS_PATH");
    guard.remove("AGENT_BROWSER_DEBUG");
    root
}

#[test]
fn the_installed_chrome_is_the_newest_version_folder_that_holds_a_binary() {
    let guard = EnvGuard::new(VARS);
    let root = home(&guard, None);
    assert_eq!(find_installed_chrome(), None, "no browsers folder");

    let browsers = root.path().join(".agent-browser/browsers");
    std::fs::create_dir_all(browsers.join("chrome-140.0.1")).unwrap(); // newest, but empty
    let flat = binary(&browsers.join("chrome-130.0.1/chrome"));
    binary(&browsers.join("chrome-120.0.1/chrome-linux64/chrome"));
    binary(&browsers.join("other-150/chrome"));
    assert_eq!(find_installed_chrome(), Some(flat.clone()));

    std::fs::remove_dir_all(flat.parent().unwrap()).unwrap();
    let nested = browsers.join("chrome-120.0.1/chrome-linux64/chrome");
    assert_eq!(
        find_installed_chrome(),
        Some(nested.clone()),
        "the zip's own chrome-linux64 folder"
    );

    guard.set("AGENT_BROWSER_DEBUG", "1");
    assert_eq!(
        find_installed_chrome(),
        Some(nested),
        "the debug trace changes nothing"
    );
    std::fs::remove_dir_all(browsers.join("chrome-120.0.1")).unwrap();
    assert_eq!(
        find_installed_chrome(),
        None,
        "only folders without a binary"
    );
}

#[test]
fn without_an_installed_chrome_the_system_one_comes_before_puppeteer_and_playwright() {
    let guard = EnvGuard::new(VARS);
    let root = home(&guard, None);
    assert_eq!(find_chrome(), None, "nothing anywhere");

    let installed = binary(
        &root
            .path()
            .join(".agent-browser/browsers/chrome-131/chrome"),
    );
    binary(
        &root
            .path()
            .join(".cache/puppeteer/chrome/linux-140/chrome-linux64/chrome"),
    );
    assert_eq!(
        find_chrome(),
        Some(installed.clone()),
        "install's Chrome first"
    );
    std::fs::remove_file(&installed).unwrap();

    let puppeteer = root
        .path()
        .join(".cache/puppeteer/chrome/linux-140/chrome-linux64/chrome");
    binary(
        &root
            .path()
            .join(".cache/puppeteer/chrome/linux-139/chrome-linux64/chrome"),
    );
    assert_eq!(
        find_chrome(),
        Some(puppeteer.clone()),
        "an empty install cache falls back to Puppeteer's newest"
    );

    let custom = root.path().join("pcache");
    let chosen = binary(&custom.join("chrome/linux-120/chrome-linux64/chrome"));
    guard.set("PUPPETEER_CACHE_DIR", custom.to_str().unwrap());
    assert_eq!(
        find_chrome(),
        Some(chosen),
        "PUPPETEER_CACHE_DIR before ~/.cache/puppeteer"
    );
    guard.remove("PUPPETEER_CACHE_DIR");
    std::fs::remove_dir_all(root.path().join(".cache/puppeteer")).unwrap();

    let playwright = root.path().join("pw");
    binary(&playwright.join("chromium-1100/chrome-linux/chrome"));
    let newest = binary(&playwright.join("chromium-1200/chrome-linux64/chrome"));
    binary(&playwright.join("firefox-1300/chrome-linux/chrome"));
    guard.set("PLAYWRIGHT_BROWSERS_PATH", playwright.to_str().unwrap());
    assert_eq!(
        find_chrome(),
        Some(newest),
        "Playwright's newest chromium-* folder"
    );

    let _system = home(&guard, Some("/opt/fake/chromium"));
    guard.set("PLAYWRIGHT_BROWSERS_PATH", playwright.to_str().unwrap());
    assert_eq!(
        find_chrome(),
        Some(PathBuf::from("/opt/fake/chromium")),
        "a system Chrome on PATH wins"
    );
}
