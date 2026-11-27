//! The owner's browsers that aren't Chromium: Firefox, whose cookies sit unsealed in each profile's `cookies.sqlite`,
//! and Safari, whose sit in `Cookies.binarycookies`. A session is read from them only when no Chromium browser holds
//! one for the host (`import::session`), so the session kept is one browser's, whole.
//!
//! Firefox's store is read from a private copy taken with its write-ahead log, so a sign-in made a moment ago, still in
//! the log, is there; the copy goes as soon as it is read (`import::leave_no_copies` takes one a killed import left).
//! Only the host's rows (and its parents') are asked for; only the default container's (`originAttributes` empty). No
//! value is printed or logged.
//!
//! Safari's file is read where it is. macOS lets a program read it only with Full Disk Access: refused, the owner is
//! told that and what else works, never a fake success.

use std::path::{Path, PathBuf};

use super::Cookie;

/// One browser's cookie store, found on this machine.
pub struct Store {
    pub name: String,
    pub kind: Kind,
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Firefox,
    Safari,
}

/// The stores of the non-Chromium browsers in the home folder `home`: every Firefox profile's (macOS, Linux, the Snap
/// and Flatpak homes), then Safari's.
pub fn stores(home: &Path) -> Vec<Store> {
    let mut out = Vec::new();
    let firefox_roots = [
        "Library/Application Support/Firefox/Profiles",
        ".mozilla/firefox",
        "snap/firefox/common/.mozilla/firefox",
        ".var/app/org.mozilla.firefox/.mozilla/firefox",
    ];
    for root in firefox_roots.iter().map(|r| home.join(r)) {
        let Ok(dir) = std::fs::read_dir(&root) else { continue };
        let mut profiles: Vec<PathBuf> = dir.flatten().map(|e| e.path().join("cookies.sqlite")).filter(|p| p.is_file()).collect();
        profiles.sort();
        for path in profiles {
            let profile = path.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            out.push(Store { name: format!("Firefox ({profile})"), kind: Kind::Firefox, path });
        }
    }
    for rel in ["Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies", "Library/Cookies/Cookies.binarycookies"] {
        let path = home.join(rel);
        // A file the system won't let this program look at still names Safari: reading it says why.
        if path.exists() || std::fs::metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied) {
            out.push(Store { name: "Safari".into(), kind: Kind::Safari, path });
            break;
        }
    }
    out
}

/// The cookies `store` holds for `host` and its parent domains. `work` is a scratch folder of the node's own for a copy.
pub fn read(store: &Store, host: &str, work: &Path) -> Result<Vec<Cookie>, String> {
    match store.kind {
        Kind::Firefox => firefox(&store.path, host, work),
        Kind::Safari => {
            let bytes = std::fs::read(&store.path).map_err(|e| safari_refused(&e))?;
            Ok(binarycookies(&bytes)?.into_iter().filter(|c| super::sent_to(&c.domain, host)).collect())
        }
    }
}

/// What the owner is told when Safari's cookies can't be read.
fn safari_refused(e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        "macOS keeps Safari's cookies from other programs: give Unbrowse Full Disk Access (System Settings, Privacy & Security), or sign in to the site in another browser".into()
    } else {
        format!("its cookies didn't read: {e}")
    }
}

/// The domains whose cookies a browser sends to `host`: the host and each name above it, with and without the dot a
/// domain cookie carries. `host` is a host name (`import::host_arg`: letters, digits, dots and dashes).
fn domains_of(host: &str) -> Vec<String> {
    let labels: Vec<&str> = host.split('.').collect();
    let mut out = Vec::new();
    for i in 0..labels.len().saturating_sub(1) {
        let d = labels[i..].join(".");
        out.push(d.clone());
        out.push(format!(".{d}"));
    }
    out
}

/// Firefox's `moz_cookies` rows for `host`, read from a copy of the store and its log.
fn firefox(store: &Path, host: &str, work: &Path) -> Result<Vec<Cookie>, String> {
    std::fs::create_dir_all(work).map_err(|e| format!("couldn't make a scratch folder: {e}"))?;
    let copy = work.join("cookies.sqlite");
    let read = (|| {
        std::fs::copy(store, &copy).map_err(|e| format!("its cookies didn't copy: {e}"))?;
        for side in ["-wal", "-shm"] {
            let from = PathBuf::from(format!("{}{side}", store.display()));
            if from.is_file() {
                let _ = std::fs::copy(&from, format!("{}{side}", copy.display()));
            }
        }
        let quoted: Vec<String> = domains_of(host).iter().map(|d| format!("'{d}'")).collect();
        let sql = format!(
            "select host, name, value, path, expiry, isSecure, isHttpOnly, sameSite from moz_cookies where originAttributes = '' and host in ({})",
            quoted.join(",")
        );
        sqlite(&copy, &sql)
    })();
    let _ = std::fs::remove_dir_all(work);
    Ok(read?.split('\x1e').filter(|l| !l.is_empty()).filter_map(firefox_row).collect())
}

/// One `moz_cookies` row, its fields split by 0x1f. Firefox has written `expiry` in seconds and, since its store's
/// schema 16, in milliseconds: a number past the year 5000 in seconds is read as milliseconds.
pub fn firefox_row(line: &str) -> Option<Cookie> {
    let f: Vec<&str> = line.split('\x1f').collect();
    if f.len() != 8 || f[1].is_empty() {
        return None;
    }
    let expiry: f64 = f[4].parse().unwrap_or(0.0);
    let expires = (expiry > 0.0).then(|| if expiry > 1e11 { expiry / 1000.0 } else { expiry });
    Some(Cookie {
        host_only: !f[0].starts_with('.'),
        domain: f[0].trim_start_matches('.').to_string(),
        name: f[1].into(),
        value: f[2].into(),
        path: f[3].into(),
        secure: f[5] == "1",
        http_only: f[6] == "1",
        expires,
        same_site: match f[7] {
            "0" => Some("None".into()),
            "1" => Some("Lax".into()),
            "2" => Some("Strict".into()),
            _ => None,
        },
    })
}

/// One query of a SQLite file with the system's `sqlite3`, fields split by 0x1f and rows by 0x1e.
fn sqlite(file: &Path, sql: &str) -> Result<String, String> {
    let program = ["/usr/bin/sqlite3", "/bin/sqlite3", "/usr/local/bin/sqlite3", "/opt/homebrew/bin/sqlite3"].into_iter().find(|p| Path::new(p).is_file()).unwrap_or("sqlite3");
    let out = std::process::Command::new(program)
        .args(["-separator", "\x1f", "-newline", "\x1e"])
        .arg(file)
        .arg(sql)
        .output()
        .map_err(|e| format!("sqlite3 didn't run, so Firefox's cookies can't be read here: {e}"))?;
    if !out.status.success() {
        return Err(format!("its cookies didn't read: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    String::from_utf8(out.stdout).map_err(|_| "its cookies aren't text".to_string())
}

/// Seconds from 1970-01-01 to 2001-01-01, where Safari counts from.
const MAC_EPOCH: f64 = 978_307_200.0;

/// The cookies in a `Cookies.binarycookies` file: "cook", the page count and each page's size (big-endian), then the
/// pages, each a list of records (little-endian) with their flags, the offsets of four NUL-ended strings (domain,
/// name, path, value) and the expiry in seconds from 2001.
pub fn binarycookies(b: &[u8]) -> Result<Vec<Cookie>, String> {
    let bad = || "Safari's cookie file isn't in a form Unbrowse reads".to_string();
    if b.get(..4) != Some(b"cook".as_slice()) {
        return Err(bad());
    }
    let be = |at: usize| b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]) as usize);
    let pages = be(4).ok_or_else(bad)?;
    let mut sizes = Vec::with_capacity(pages.min(4096));
    for i in 0..pages {
        sizes.push(be(8 + 4 * i).ok_or_else(bad)?);
    }
    let mut at = 8 + 4 * pages;
    let mut out = Vec::new();
    for size in sizes {
        let page = b.get(at..at + size).ok_or_else(bad)?;
        out.extend(page_cookies(page).ok_or_else(bad)?);
        at += size;
    }
    Ok(out)
}

fn le32(b: &[u8], at: usize) -> Option<usize> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as usize)
}

fn page_cookies(p: &[u8]) -> Option<Vec<Cookie>> {
    if p.get(..4)? != [0, 0, 1, 0] {
        return None;
    }
    let count = le32(p, 4)?;
    let mut out = Vec::new();
    for i in 0..count {
        let start = le32(p, 8 + 4 * i)?;
        let size = le32(p, start)?;
        let rec = p.get(start..start + size)?;
        if let Some(c) = record(rec) {
            out.push(c);
        }
    }
    Some(out)
}

fn record(r: &[u8]) -> Option<Cookie> {
    let flags = le32(r, 8)?;
    let text = |at: usize| -> Option<String> {
        let from = le32(r, at)?;
        let rest = r.get(from..)?;
        let end = rest.iter().position(|&c| c == 0)?;
        String::from_utf8(rest[..end].to_vec()).ok()
    };
    let (domain, name, path, value) = (text(16)?, text(20)?, text(24)?, text(28)?);
    let expiry = f64::from_le_bytes(r.get(40..48)?.try_into().ok()?);
    if name.is_empty() {
        return None;
    }
    Some(Cookie {
        host_only: !domain.starts_with('.'),
        domain: domain.trim_start_matches('.').to_string(),
        name,
        value,
        path,
        secure: flags & 1 != 0,
        http_only: flags & 4 != 0,
        expires: (expiry > 0.0).then_some(expiry + MAC_EPOCH),
        same_site: None,
    })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A `Cookies.binarycookies` file holding `cookies` (domain, name, path, value, flags, expiry in seconds from 1970),
    /// laid out as Safari writes it: one page.
    pub fn safari_file(cookies: &[(&str, &str, &str, &str, u32, f64)]) -> Vec<u8> {
        let mut records = Vec::new();
        for (domain, name, path, value, flags, expires) in cookies {
            let mut strings = Vec::new();
            let mut offsets = Vec::new();
            for s in [domain, name, path, value] {
                offsets.push(56 + strings.len() as u32);
                strings.extend_from_slice(s.as_bytes());
                strings.push(0);
            }
            let size = 56 + strings.len() as u32;
            let mut r = Vec::new();
            r.extend(size.to_le_bytes());
            r.extend(0u32.to_le_bytes());
            r.extend(flags.to_le_bytes());
            r.extend(0u32.to_le_bytes());
            for o in offsets {
                r.extend(o.to_le_bytes());
            }
            r.extend([0u8; 8]);
            r.extend((expires - MAC_EPOCH).to_le_bytes());
            r.extend(0f64.to_le_bytes());
            r.extend(strings);
            records.push(r);
        }
        let head = 8 + 4 * records.len() + 4;
        let mut page = vec![0, 0, 1, 0];
        page.extend((records.len() as u32).to_le_bytes());
        let mut at = head;
        for r in &records {
            page.extend((at as u32).to_le_bytes());
            at += r.len();
        }
        page.extend([0u8; 4]);
        for r in records {
            page.extend(r);
        }
        let mut file = b"cook".to_vec();
        file.extend(1u32.to_be_bytes());
        file.extend((page.len() as u32).to_be_bytes());
        file.extend(page);
        file
    }

    #[test]
    fn safaris_cookie_file_reads_with_each_cookies_reach_and_life() {
        let file = safari_file(&[(".example.com", "sid", "/", "s-1", 5, 2_000_000_000.0), ("shop.example.com", "cart", "/cart", "c-2", 0, 0.0)]);
        let c = binarycookies(&file).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].domain.as_str(), c[0].host_only, c[0].name.as_str(), c[0].value.as_str()), ("example.com", false, "sid", "s-1"));
        assert!(c[0].secure && c[0].http_only);
        assert_eq!(c[0].expires.map(|e| e.round()), Some(2_000_000_000.0));
        assert_eq!((c[1].host_only, c[1].path.as_str(), c[1].expires), (true, "/cart", None));
        assert!(binarycookies(b"not a cookie file").is_err());
        assert!(binarycookies(b"cook\0\0\0\x09").is_err(), "a page count with no pages is refused, not read past");
    }

    #[test]
    fn a_firefox_row_reads_its_expiry_in_seconds_or_milliseconds() {
        let secs = firefox_row("\x2eexample.com\x1fsid\x1fs-1\x1f/\x1f2000000000\x1f1\x1f1\x1f1").unwrap();
        let ms = firefox_row("example.com\x1fsid\x1fs-1\x1f/\x1f2000000000000\x1f0\x1f0\x1f2").unwrap();
        assert_eq!((secs.expires, secs.host_only, secs.same_site.as_deref()), (Some(2_000_000_000.0), false, Some("Lax")));
        assert_eq!((ms.expires, ms.host_only, ms.same_site.as_deref()), (Some(2_000_000_000.0), true, Some("Strict")));
        assert!(firefox_row("example.com\x1f\x1fv\x1f/\x1f0\x1f0\x1f0\x1f0").is_none(), "a cookie with no name is none");
    }

    #[test]
    fn a_firefox_profile_is_read_from_a_copy_with_its_log_and_only_for_the_host() {
        if !Path::new("/usr/bin/sqlite3").is_file() {
            eprintln!("no /usr/bin/sqlite3 on this machine: the Firefox store isn't read here");
            return;
        }
        let home = crate::store::scratch_home("firefox-profile");
        let dir = home.join("Library/Application Support/Firefox/Profiles/abc.default-release");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cookies.sqlite");
        let made = std::process::Command::new("/usr/bin/sqlite3")
            .arg(&db)
            .arg(
                "pragma journal_mode=wal; create table moz_cookies (id integer primary key, originAttributes text not null default '', name text, value text, host text, path text, expiry integer, lastAccessed integer, creationTime integer, isSecure integer, isHttpOnly integer, inBrowserElement integer default 0, sameSite integer default 0, rawSameSite integer default 0, schemeMap integer default 0); \
                 insert into moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) values \
                 ('', 'sid', 's-1', '.example.com', '/', 2000000000000, 1, 1, 1), \
                 ('', 'other', 'o-1', '.elsewhere.com', '/', 2000000000, 1, 1, 1), \
                 ('^userContextId=2', 'sid', 'container', '.example.com', '/', 2000000000, 1, 1, 1);",
            )
            .status()
            .unwrap();
        assert!(made.success());
        let found = stores(&home);
        assert_eq!(found.iter().map(|s| (s.name.as_str(), s.kind)).collect::<Vec<_>>(), vec![("Firefox (abc.default-release)", Kind::Firefox)]);
        let work = home.join("import/ff-test");
        let c = read(&found[0], "www.example.com", &work).unwrap();
        assert_eq!(c.iter().map(|c| (c.name.as_str(), c.value.as_str())).collect::<Vec<_>>(), vec![("sid", "s-1")], "the host's own, from the default container only");
        assert!(!work.exists(), "the copy of the store goes once it is read");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn with_nothing_from_chromium_the_first_other_browser_that_holds_the_site_is_kept_whole() {
        let home = crate::store::scratch_home("other-chosen");
        let garbled = home.join("garbled.binarycookies");
        std::fs::write(&garbled, b"not a cookie file").unwrap();
        let empty = home.join("empty.binarycookies");
        std::fs::write(&empty, safari_file(&[(".elsewhere.com", "x", "/", "x-1", 0, 2_000_000_000.0)])).unwrap();
        let holds = home.join("holds.binarycookies");
        std::fs::write(&holds, safari_file(&[(".example.org", "sid", "/", "s-1", 5, 2_000_000_000.0)])).unwrap();
        let later = home.join("later.binarycookies");
        std::fs::write(&later, safari_file(&[(".example.org", "other", "/", "o-1", 0, 2_000_000_000.0)])).unwrap();
        let store = |name: &str, path: &Path| Store { name: name.into(), kind: Kind::Safari, path: path.to_path_buf() };
        let others = [store("Garbled", &garbled), store("Empty", &empty), store("Holds", &holds), store("Later", &later)];
        let import = home.join("import");

        // Chromium held a store but none of the site's cookies: the others, in turn, until one holds them.
        let (mine, from) = super::super::chosen("example.org", &["Chrome"], &others, &import, vec![], vec!["Chrome".into()], vec![]).unwrap();
        assert_eq!(from, "Holds");
        assert_eq!(mine.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["sid"], "one browser's session, never mixed with a later one's");

        // Chromium's own cookies win: no other browser is read.
        let chromes = vec![Cookie { name: "c".into(), value: "v".into(), domain: "example.org".into(), host_only: true, path: "/".into(), secure: true, http_only: true, expires: None, same_site: None }];
        let (mine, from) = super::super::chosen("example.org", &["Chrome"], &others, &import, chromes, vec!["Chrome".into()], vec![]).unwrap();
        assert_eq!((mine.len(), from.as_str()), (1, "Chrome"));

        // No browser with any cookies: where it looked, and what didn't read.
        let none = super::super::chosen("example.org", &["Chrome"], &others[..1], &import, vec![], vec![], vec![]).unwrap_err();
        assert!(none.contains("no browser here has cookies yet (looked in Chrome, Garbled)") && none.contains("Couldn't read: Garbled"), "{none}");

        // Browsers with cookies, none of the site's: which were read.
        let missing = super::super::chosen("example.org", &["Chrome"], &others[..2], &import, vec![], vec!["Chrome".into()], vec![]).unwrap_err();
        assert!(missing.contains("no cookies for example.org in your browsers (Chrome, Empty)") && missing.contains("Couldn't read: Garbled"), "{missing}");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn safari_is_found_by_its_file_and_reads_the_hosts_cookies() {
        let home = crate::store::scratch_home("safari-file");
        let dir = home.join("Library/Containers/com.apple.Safari/Data/Library/Cookies");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cookies.binarycookies"), safari_file(&[(".example.com", "sid", "/", "s-1", 5, 2_000_000_000.0), (".elsewhere.com", "x", "/", "x-1", 0, 2_000_000_000.0)])).unwrap();
        let found = stores(&home);
        assert_eq!(found.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["Safari"]);
        let c = read(&found[0], "example.com", &home.join("import/s")).unwrap();
        assert_eq!(c.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), vec!["sid"]);
        let refused = safari_refused(&std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert!(refused.contains("Full Disk Access") && refused.contains("another browser"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
