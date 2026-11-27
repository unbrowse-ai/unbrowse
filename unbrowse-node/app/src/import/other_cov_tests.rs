//! Coverage tests for `import/other.rs`: Safari's and Firefox's stores read from files the test writes.

use super::tests::safari_file;
use super::*;

#[test]
fn a_safari_cookie_file_the_system_keeps_back_says_how_to_allow_it() {
    let denied = safari_refused(&std::io::Error::from(std::io::ErrorKind::PermissionDenied));
    assert!(denied.contains("Full Disk Access") && denied.contains("another browser"), "{denied}");
    let missing = safari_refused(&std::io::Error::from(std::io::ErrorKind::NotFound));
    assert!(missing.starts_with("its cookies didn't read:") && !missing.contains("Full Disk Access"), "{missing}");
}

#[test]
fn a_firefox_row_with_an_unknown_same_site_has_none() {
    let row = |site: &str| firefox_row(&format!("example.com\x1fsid\x1fs\x1f/\x1f0\x1f0\x1f0\x1f{site}")).unwrap();
    assert_eq!(row("0").same_site.as_deref(), Some("None"));
    assert_eq!(row("9").same_site, None);
    assert_eq!(row("").same_site, None);
}

#[test]
fn a_safari_page_that_is_not_a_page_is_refused_and_a_nameless_cookie_is_left_out() {
    let file = safari_file(&[("example.com", "sid", "/", "s", 0, 0.0)]);
    // The page's own magic is the first four bytes after the header (4 + 4 + 4 bytes): break it.
    let mut broken = file.clone();
    broken[12] = 9;
    assert!(binarycookies(&broken).is_err(), "a page that does not open as one is not read");
    // A cookie with no name is no cookie: it is dropped, the named one beside it kept.
    let mixed = safari_file(&[("example.com", "", "/", "nameless", 0, 0.0), ("example.com", "sid", "/", "s", 0, 0.0)]);
    let read = binarycookies(&mixed).unwrap();
    assert_eq!(read.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["sid"]);
}

#[test]
fn a_firefox_store_that_is_not_a_database_is_said_not_to_read() {
    let dir = std::env::temp_dir().join(format!("unbrowse-other-cov-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let store = dir.join("cookies.sqlite");
    std::fs::write(&store, b"this is not a database at all, only text padded out to be longer than a header").unwrap();
    // A log beside it is copied with it.
    std::fs::write(dir.join("cookies.sqlite-wal"), b"log").unwrap();
    let err = firefox(&store, "shop.example.com", &dir.join("work")).unwrap_err();
    assert!(err.contains("didn't read") || err.contains("sqlite3 didn't run"), "{err}");
    assert!(!dir.join("work").exists(), "the scratch copy is gone either way");
    let missing = firefox(&dir.join("nothing.sqlite"), "shop.example.com", &dir.join("work2")).unwrap_err();
    assert!(missing.contains("didn't copy"), "{missing}");
    let _ = std::fs::remove_dir_all(&dir);
}
