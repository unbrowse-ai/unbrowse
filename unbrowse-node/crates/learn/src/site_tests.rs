//! The harness fetcher where no browser is needed: what it says of an address it cannot read, the fast path past a door.

use super::*;

/// A loopback site that answers every request 200 with `body`.
fn loopback(body: &'static str) -> String {
    use std::io::{Read, Write};
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut s in l.incoming().flatten() {
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    format!("http://127.0.0.1:{port}/catalog")
}

fn site_in(name: &str) -> (Site, PathBuf) {
    let dir = std::env::temp_dir().join(format!("site-extra-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (Site { jar_root: dir.clone(), capture_root: dir.join("captures"), profile_root: dir.join("profiles"), cdp_endpoint: None, ..Site::new() }, dir)
}

/// An address that is no address is said to be one before any browser is started, by the walk and by the fetch that
/// tried it twice (as itself, then as a browser): the first walk's reason is the answer.
#[test]
fn an_address_that_is_no_address_is_refused_before_a_browser_is_started() {
    let (site, dir) = site_in("bad");
    let said = site.attempt("not an address", Some(NODE_USER_AGENT), "self").expect_err("no address, no walk");
    assert!(said.starts_with("bad url: "), "{said}");
    let fetched = site.fetch("::::").expect_err("both tries fail");
    assert!(fetched.starts_with("bad url: "), "{fetched}");
    let all = site.fetch_all(&["::::".to_string(), "also not one".to_string()]);
    assert_eq!(all.len(), 2);
    assert!(all.iter().all(|r| r.as_ref().is_err_and(|e| e.starts_with("bad url"))));
    assert!(!dir.join("captures").exists(), "nothing was walked");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The default harness client keeps its folders under the node's home, where an owner's own client does.
#[test]
fn the_default_harness_client_keeps_its_profiles_captures_and_jars_under_one_home() {
    let site = Site::default();
    let home = unbrowse_files::private::home();
    assert_eq!(site.profile_root, home.join("profiles"));
    assert_eq!(site.jar_root, home.join("jars"));
    assert_eq!(site.capture_root, home.join("tmp").join("captures"));
    assert_eq!(site.settle_ms, 6_000);
}

/// A jar's answer that is a door's page, not the site's, is no fast answer: the walk is what clears it.
#[test]
fn a_jar_whose_answer_is_the_sites_door_is_no_fast_answer() {
    let url = loopback(r#"<html><head><title>Just a moment</title><script src="/challenge.js"></script></head><body>Checking</body></html>"#);
    let (site, dir) = site_in("door");
    site.write_jar("127.0.0.1", &HashMap::from([("sid".to_string(), "dummy-session-4".to_string())]));
    let page = site.cached_call(&url);
    assert!(page.is_none(), "{page:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A walk that cannot reach its browser is an error that says the mint failed, after the folders a walk keeps were made
/// private to the owner and its stale capture was cleared; and the fetch that tried twice says the first reason.
#[cfg(unix)]
#[test]
fn a_walk_whose_browser_cannot_be_reached_says_so_and_leaves_the_owners_folders_private() {
    use std::os::unix::fs::PermissionsExt;
    let (mut site, dir) = site_in("nobrowser");
    // A browser that is not there: the node launches nothing, it opens a tab in the one it is pointed at.
    site.cdp_endpoint = Some("http://127.0.0.1:1".to_string());
    let stale = agent_browser_core::session::capture_path(&site.capture_root, "127_0_0_1_self");
    std::fs::create_dir_all(&site.capture_root).unwrap();
    std::fs::write(&stale, "stale\n").unwrap();
    let said = site.attempt("http://127.0.0.1:1/catalog", Some(NODE_USER_AGENT), "self").expect_err("no browser, no walk");
    assert!(said.starts_with("mint: "), "{said}");
    assert!(!stale.exists(), "the last walk's capture is gone before a new one is made");
    // The folder the captures are kept in is the owner's alone, whatever mode it was made with.
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode & 0o077, 0, "the folder above the captures is the owner's alone: {mode:o}");
    let both = site.fetch("http://127.0.0.1:1/catalog").expect_err("both tries fail");
    assert!(both.starts_with("mint: "), "{both}");
    let _ = std::fs::remove_dir_all(&dir);
}
