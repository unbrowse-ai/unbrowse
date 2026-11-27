//! Coverage tests for `import.rs`: a cookie store copied for the browser to read, and the cookies a file says.

use super::*;

#[test]
fn a_cookie_store_that_cannot_be_copied_says_which_file() {
    let dir = std::env::temp_dir().join(format!("unbrowse-import-cov-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let profile = dir.join("profile");
    std::fs::create_dir_all(profile.join("Default")).unwrap();
    std::fs::write(profile.join("Local State"), b"{}").unwrap();
    let into = dir.join("copy");
    // A folder where the copy of a file would go: the copy fails, naming the file.
    std::fs::create_dir_all(into.join("Local State")).unwrap();
    let err = copy_cookie_store(&profile, &into).unwrap_err();
    assert!(err.contains("Local State"), "{err}");
    // With the place free, the same store copies, and has no cookie file yet.
    let free = dir.join("free");
    assert_eq!(copy_cookie_store(&profile, &free), Ok(false));
    assert!(free.join("Local State").is_file());
    std::fs::write(profile.join("Default/Cookies"), b"db").unwrap();
    assert_eq!(copy_cookie_store(&profile, &free), Ok(true));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_same_site_a_file_spells_any_way_is_read_as_the_browser_names_it() {
    let read = |site: &str| cookie_of(&json!({ "name": "sid", "value": "v", "domain": "shop.example", "sameSite": site }), "shop.example").unwrap().same_site;
    assert_eq!(read("STRICT").as_deref(), Some("Strict"));
    assert_eq!(read("lax").as_deref(), Some("Lax"));
    assert_eq!(read("no_restriction").as_deref(), Some("None"));
    assert_eq!(read("unspecified"), None, "a word the browsers don't know is left out");
}
