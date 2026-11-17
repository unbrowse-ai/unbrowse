//! Local browser regression: an anti-forgery token the page sends is part of the session the walk hands back, whether or
//! not the walk also keeps a log of what it saw.
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc};

const PAGE: &str = r#"<html><head><title>Shop</title></head><body><script>
fetch('/api/cart', { headers: { 'x-csrf-token': 'minted-by-the-page' } });
</script></body></html>"#;

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_walk_with_no_log_still_keeps_the_pages_token() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let server = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let (mut stream, _) = match listener.accept() {
                Ok(c) => c,
                Err(_) => { std::thread::sleep(std::time::Duration::from_millis(10)); continue; }
            };
            std::thread::spawn(move || {
                let _ = stream.set_nonblocking(false);
                let mut request = [0; 8192];
                let n = stream.read(&mut request).unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..n]).to_string();
                let (kind, body) = if text.starts_with("GET /api/") {
                    ("application/json", "{}".to_string())
                } else {
                    ("text/html", PAGE.to_string())
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            });
        }
    });
    let profile = tempfile::tempdir().unwrap();
    let walked = mint(MintOptions {
        url: format!("http://{address}/"),
        profile: Some(profile.path().join("shop.example").to_string_lossy().into_owned()),
        session: "no-log".to_string(),
        capture_dir: None,
        settle_ms: 1_500,
        ..Default::default()
    })
    .await;
    stopped.store(true, Ordering::Relaxed);
    let _ = server.join();
    let session = walked.expect("the walk finishes");
    assert_eq!(session.tokens.get("x-csrf-token").map(String::as_str), Some("minted-by-the-page"), "{:?}", session.tokens);
}
