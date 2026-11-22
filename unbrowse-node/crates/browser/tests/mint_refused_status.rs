//! Local browser regression: a door that refuses the page by its status alone —
//! no challenge words, an empty shell — is still a refusal, so the walk asks
//! again instead of keeping the refusal as the page.
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_document_refused_by_status_is_refused_without_words() {
    // The first document the site serves is a refusal that says nothing: a
    // title, an empty body, no challenge words and no challenge script. Every
    // document after it is served the page, which hands out a cookie the
    // refusal never did — so what the walk keeps says which answer it kept.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let documents = Arc::new(AtomicUsize::new(0));
    let server = std::thread::spawn(move || {
        // A thread per connection: a browser opens sockets it never uses, and
        // one of those must not hold up the page's own request.
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let (stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
            };
            let counted = documents.clone();
            workers.push(std::thread::spawn(move || serve(stream, &counted)));
        }
        for worker in workers {
            let _ = worker.join();
        }
    });

    fn serve(mut stream: std::net::TcpStream, documents: &AtomicUsize) {
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        // Read the whole head, not one chunk: a fragment can cut the request
        // line off before it can be read.
        let mut request = Vec::new();
        let mut chunk = [0; 4096];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => request.extend_from_slice(&chunk[..n]),
            }
        }
        let request = String::from_utf8_lossy(&request);
        let line = request.lines().next().unwrap_or_default().to_string();
        // The page itself is the root a browser asks for; its icon is not.
        if !line.starts_with("GET / ") {
            return;
        }
        let first = documents.fetch_add(1, Ordering::SeqCst) == 0;
        let response = if first {
            // A refusal with no words at all: the page cannot read it off its
            // title, and only the status says what happened.
            let body = "<html><head><title>site.example</title></head><body></body></html>";
            format!("HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
        } else {
            let body = "<html><head><title>The page itself</title></head><body><h1>Welcome</h1></body></html>";
            format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nSet-Cookie: in=1; Path=/; Max-Age=86400\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
        };
        let _ = stream.write_all(response.as_bytes());
    }

    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("site.example");
    let minted = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "status".into(),
        profile: Some(profile.to_string_lossy().into_owned()),
        settle_ms: 2_000,
        ..Default::default()
    })
    .await;

    stopped.store(true, Ordering::Relaxed);
    // Wake the server's accept loop so it can join the workers.
    let _ = std::net::TcpStream::connect(address);
    server.join().unwrap();

    // What the walk kept is what the site accepted: the refusal handed out no
    // cookie, and the page did.
    let minted = minted.expect("a refusal by status alone must send the walk back to the site");
    assert!(
        minted.cookies.contains_key("in"),
        "the walk kept the refusal instead of asking again: {:?}",
        minted.cookies
    );
    assert!(profile.is_dir(), "the accepted browser takes the profile's name");
}
