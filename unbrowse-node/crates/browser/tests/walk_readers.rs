//! What a walk's log says, read back: the page's own answer for a URL, the HAR a route is learned from, and the
//! profiles a refusal set aside. No browser: each test writes the log lines a walk writes.
use agent_browser_core::session::{capture_path, set_aside_profiles, walk_har, walk_page, walk_response};
use serde_json::{json, Value};
use std::path::Path;

fn write_log(dir: &Path, session: &str, lines: &[Value]) {
    let text: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(capture_path(dir, session), text).unwrap();
}

#[test]
fn a_walks_answer_for_a_url_is_the_exact_page_else_the_largest_one_without_its_query() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "s",
        &[
            json!({ "type": "request", "url": "https://a.example/p" }),
            json!({ "type": "response", "url": "https://a.example/p?utm=1", "status": 200, "mimeType": "text/html", "body": "<p>stub</p>" }),
            json!({ "type": "response", "url": "https://a.example/p?utm=2", "status": 203, "mimeType": "text/html", "body": "<p>the larger page, not the stub</p>" }),
            json!({ "type": "response", "url": "https://a.example/p?utm=3", "status": 200, "mimeType": "text/html", "body": "" }),
            json!({ "type": "response", "url": "https://a.example/other", "status": 200, "mimeType": "text/html", "body": "<p>another page entirely, and a longer one</p>" }),
            json!({ "type": "response", "url": "https://a.example/exact", "mimeType": "application/json", "body": "{}" }),
        ],
    );
    let (status, mime, body) = walk_response(dir.path(), "s", "https://a.example/p?utm=9").unwrap();
    assert_eq!((status, mime.as_str(), body.as_str()), (203, "text/html", "<p>the larger page, not the stub</p>"));
    // A recorded answer with no status says 200; one with no mime says nothing of its type.
    let (status, mime, body) = walk_response(dir.path(), "s", "https://a.example/exact").unwrap();
    assert_eq!((status, mime.as_str(), body.as_str()), (200, "application/json", "{}"));
    assert_eq!(walk_response(dir.path(), "s", "https://a.example/never-asked"), None);
    assert_eq!(walk_response(dir.path(), "no-such-walk", "https://a.example/p"), None);
}

#[test]
fn the_page_a_walk_ended_on_is_its_last_main_frame_html_document() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "s",
        &[
            json!({ "type": "mint" }),
            json!({ "type": "request", "requestId": "r1", "url": "https://a.example/", "resourceType": "Document", "frameId": "main" }),
            json!({ "type": "request", "requestId": "r2", "url": "https://ads.example/frame", "resourceType": "Document", "frameId": "ad" }),
            json!({ "type": "request", "requestId": "r3", "url": "https://a.example/landing", "resourceType": "Document", "frameId": "main" }),
            json!({ "type": "response", "requestId": "r1", "url": "https://a.example/", "status": 302, "mimeType": "text/html", "body": "<p>redirecting</p>" }),
            json!({ "type": "response", "requestId": "r2", "url": "https://ads.example/frame", "status": 200, "mimeType": "text/html", "body": "<p>an ad</p>" }),
            json!({ "type": "response", "requestId": "r4", "url": "chrome-untrusted://new-tab-page/", "mimeType": "text/html", "body": "<p>browser's own</p>" }),
            json!({ "type": "response", "url": "not a url", "mimeType": "text/html", "body": "<p>nowhere</p>" }),
            json!({ "type": "response", "requestId": "r5", "url": "https://a.example/data.json", "mimeType": "application/json", "body": "{}" }),
            json!({ "type": "response", "requestId": "r6", "url": "https://a.example/empty", "mimeType": "text/html", "body": "" }),
            json!({ "type": "response", "requestId": "r3", "url": "https://a.example/landing", "status": 200, "mimeType": "text/html; charset=utf-8", "body": "<p>landing</p>" }),
        ],
    );
    assert_eq!(
        walk_page(dir.path(), "s"),
        Some((200, "text/html; charset=utf-8".to_string(), "<p>landing</p>".to_string()))
    );
    assert_eq!(walk_page(dir.path(), "nothing"), None);
}

#[test]
fn a_har_says_each_answer_as_the_browser_typed_it() {
    let dir = tempfile::tempdir().unwrap();
    write_log(
        dir.path(),
        "s",
        &[
            json!({ "type": "request", "requestId": "d", "url": "data:text/plain,hi" }),
            json!({ "type": "request", "requestId": "css", "url": "https://a.example/a.css", "method": "GET" }),
            json!({ "type": "response", "requestId": "css", "url": "https://a.example/a.css", "mimeType": "text/css", "body": "a{}" }),
            json!({ "type": "request", "requestId": "js", "url": "https://a.example/a.js", "method": "GET" }),
            json!({ "type": "response", "requestId": "js", "url": "https://a.example/a.js", "mimeType": "application/javascript", "body": "1" }),
            json!({ "type": "request", "requestId": "img", "url": "https://a.example/a.png", "method": "GET" }),
            json!({ "type": "response", "requestId": "img", "url": "https://a.example/a.png", "mimeType": "image/png", "encoding": "base64", "body": "AAEC" }),
            json!({ "type": "request", "requestId": "post", "url": "https://a.example/api", "method": "POST", "resourceType": "Fetch",
                "headers": { "content-type": "application/octet-stream" }, "postData": "AAEC", "postDataEncoding": "base64" }),
            json!({ "type": "response", "requestId": "post", "url": "https://a.example/api", "status": 201, "mimeType": "application/json", "body": "{}" }),
        ],
    );
    let har = walk_har(dir.path(), "s");
    let entries = har["log"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 4, "the data: URL is no entry: {har}");
    let kind = |i: usize| entries[i]["_resourceType"].as_str().unwrap().to_string();
    assert_eq!((kind(0), kind(1), kind(2), kind(3)), ("Stylesheet".into(), "Script".into(), "Other".into(), "Fetch".into()));
    assert_eq!(entries[2]["response"]["content"]["encoding"], "base64");
    assert_eq!(entries[0]["response"]["content"].get("encoding"), None);
    let post = &entries[3]["request"]["postData"];
    assert_eq!((post["_encoding"].as_str(), post["text"].as_str()), (Some("base64"), Some("AAEC")));
    assert_eq!(post["mimeType"], "application/octet-stream");
    assert_eq!(entries[3]["response"]["status"], 201);
}

#[test]
fn profiles_set_aside_are_sized_through_their_folders_and_aged_from_their_stamp_or_their_folder() {
    let dir = tempfile::tempdir().unwrap();
    let refused = dir.path().join("refused");
    std::fs::create_dir_all(refused.join("site.example.1000/Default/deep")).unwrap();
    std::fs::write(refused.join("site.example.1000/Default/deep/Cookies"), vec![0u8; 700]).unwrap();
    std::fs::write(refused.join("site.example.1000/top"), vec![0u8; 5]).unwrap();
    std::fs::create_dir_all(refused.join("unstamped")).unwrap();
    std::fs::write(refused.join("a-file-is-no-profile"), "x").unwrap();
    let index = dir.path().join("set-aside");
    std::fs::write(&index, format!("\n{}\n{}\n", refused.display(), dir.path().join("gone").display())).unwrap();

    let now = std::time::UNIX_EPOCH + std::time::Duration::from_secs(5000);
    let kept = set_aside_profiles(&index, now);
    assert_eq!(kept.len(), 2, "{kept:?}");
    let stamped = kept.iter().find(|k| k.path.ends_with("site.example.1000")).unwrap();
    assert_eq!((stamped.bytes, stamped.age_secs), (705, 4000));
    // A folder with no stamp is aged by when it was made: just now, long after `now` in this clock, so no age at all.
    let unstamped = kept.iter().find(|k| k.path.ends_with("unstamped")).unwrap();
    assert_eq!((unstamped.bytes, unstamped.age_secs), (0, 0));
    assert_eq!(kept[0].path, stamped.path, "oldest first");
}

#[test]
fn a_session_lists_every_value_it_carries_and_takes_another_walks_over_its_own_with_that_walks_reach() {
    use agent_browser_core::session::{CookieFacts, MintedSession};
    let mut old = MintedSession::default();
    old.cookies.insert("sid".into(), "old".into());
    old.cookies.insert("keep".into(), "kept".into());
    old.tokens.insert("csrf".into(), "t0".into());
    old.domains.insert("sid".into(), ".a.example".into());
    old.facts.insert("sid".into(), CookieFacts { path: "/old".into(), http_only: true, expires: None });
    old.local_storage.insert("l".into(), "0".into());

    let mut new = MintedSession::default();
    new.cookies.insert("sid".into(), "new".into());
    new.cookies.insert("fresh".into(), "f".into());
    new.domains.insert("fresh".into(), ".b.example".into());
    new.facts.insert("fresh".into(), CookieFacts { path: "/".into(), http_only: false, expires: Some(5.0) });
    new.tokens.insert("csrf".into(), "t1".into());
    new.session_storage.insert("s".into(), "1".into());

    old.absorb(new);
    let mut values: Vec<(String, String)> = old.values().map(|(k, v)| (k.clone(), v.clone())).collect();
    values.sort();
    assert_eq!(
        values,
        [("csrf".into(), "t1".into()), ("fresh".into(), "f".into()), ("keep".into(), "kept".into()), ("sid".into(), "new".into())]
    );
    // A value never keeps what an older value of its name had: `sid` came with no reach and no facts this time.
    assert_eq!(old.domains.get("sid"), None);
    assert_eq!(old.facts.get("sid"), None);
    assert_eq!(old.domains.get("fresh").map(String::as_str), Some(".b.example"));
    assert_eq!(old.facts["fresh"].expires, Some(5.0));
    assert_eq!((old.local_storage.len(), old.session_storage.len()), (1, 1));
}

#[cfg(unix)]
#[test]
fn a_link_inside_a_profile_set_aside_adds_no_bytes_of_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let kept = dir.path().join("refused/site.example.7");
    std::fs::create_dir_all(&kept).unwrap();
    std::fs::write(kept.join("real"), vec![0u8; 40]).unwrap();
    std::os::unix::fs::symlink(kept.join("real"), kept.join("link")).unwrap();
    let index = dir.path().join("set-aside");
    std::fs::write(&index, format!("{}\n", dir.path().join("refused").display())).unwrap();
    let listed = set_aside_profiles(&index, std::time::UNIX_EPOCH + std::time::Duration::from_secs(10));
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].bytes, 40, "the link is not followed");
}
