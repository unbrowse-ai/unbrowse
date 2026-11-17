//! Local browser regression: a walk the site never answered is not a refusal, so
//! the profile it walked in stays where it is, whatever a later browser finds.
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_page_that_never_answered_leaves_the_profile_in_place() {
    // A first walk leaves the profile holding the site's cookie, as a sign-in does. After that, a browser carrying it
    // gets a closed connection and no document, which is what a dropped network looks like from inside the browser,
    // while one with no cookie is served the page: the network came back for whoever asks next. The site never
    // refused anything.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let server = std::thread::spawn(move || {
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let Ok((stream, _)) = listener.accept() else { continue };
            workers.push(std::thread::spawn(move || serve(stream)));
        }
        for worker in workers {
            let _ = worker.join();
        }
    });

    fn serve(mut stream: std::net::TcpStream) {
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => request.extend_from_slice(&chunk[..n]),
            }
        }
        let request = String::from_utf8_lossy(&request);
        if !request.starts_with("GET / ") || request.contains("Cookie: signed=in") {
            return;
        }
        let body = "<html><title>Ordinary page</title><body>The page itself.</body></html>";
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\nSet-Cookie: signed=in; Path=/; Max-Age=86400\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }

    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("site.example");
    let walk = |session: &str| MintOptions {
        url: format!("http://{address}/"),
        session: session.into(),
        profile: Some(profile.to_string_lossy().into_owned()),
        // No window on a test machine: the ask this test is about needs none.
        windowless: true,
        settle_ms: 2_000,
        ..Default::default()
    };
    mint(walk("first")).await.expect("the first walk must land");
    // A mark of this profile's own: whatever stands at its name after the blip is the same browser or it isn't.
    let mark = profile.join("the-owner-signed-in-here");
    std::fs::write(&mark, "yes").unwrap();

    let second = mint(walk("second")).await;
    assert!(mark.exists(), "the owner's profile was moved aside over a page that never answered: {second:?}");
    assert!(!root.path().join("refused").exists(), "nothing was refused, so nothing is set aside");
    let error = second.expect_err("a page that never answered is not a walk that landed");
    assert!(error.starts_with("mint unresolved (loading)"), "{error}");
    // The clean browser nobody needed leaves nothing beside the profile.
    let beside: Vec<_> = std::fs::read_dir(root.path()).unwrap().flatten().map(|e| e.file_name()).collect();
    assert_eq!(beside.len(), 1, "{beside:?}");

    stopped.store(true, Ordering::Relaxed);
    let _ = std::net::TcpStream::connect(address);
    server.join().unwrap();
}
