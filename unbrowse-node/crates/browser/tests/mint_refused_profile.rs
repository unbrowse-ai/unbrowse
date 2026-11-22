//! Local browser regression: a browser that remembers what the site refused is
//! replaced by one that remembers nothing, and what the site accepts takes its
//! place.
use agent_browser_core::session::{mint, MintOptions, Waits};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

#[tokio::test]
#[ignore = "requires installed Chrome"]
async fn a_profile_the_site_refuses_is_replaced_by_one_it_accepts() {
    // The site refuses any browser that carries the cookie it handed out, and
    // serves everyone else its page. Nothing here names a real site: the rule
    // is "what this browser remembers is what it is judged by". The one thing
    // that is not a function of that memory — handing the cookie out — is
    // counted per page request, so a socket the browser opened without asking
    // cannot consume the hand-out and leave the first walk without it.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    // The site hands out its reputation cookie once, to the first page request
    // it meets. Only page requests are counted: a socket the browser opened
    // without asking for anything is not a browser the site judges.
    let handed = Arc::new(AtomicUsize::new(0));
    let handed_by_server = handed.clone();
    let server = std::thread::spawn(move || {
        // A thread per connection: a browser opens sockets it never uses for a
        // page it is about to fetch, and one of those must not hold up the
        // page's own request.
        let mut workers = Vec::new();
        while !stop.load(Ordering::Relaxed) {
            let (stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
            };
            let counted = handed_by_server.clone();
            workers.push(std::thread::spawn(move || serve(stream, &counted)));
        }
        for worker in workers {
            let _ = worker.join();
        }
    });

    fn serve(mut stream: std::net::TcpStream, handed: &AtomicUsize) {
        stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
        // Read the whole head, not one chunk: a fragment can cut the request
        // line off before it can be read, and a socket the browser opened
        // without asking for anything is not a page request at all.
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
        if !line.starts_with("GET / ") {
            // A connection that asked for nothing is answered with nothing:
            // writing a page onto it would leave a response on a socket the
            // browser is about to send its real request down.
            if !line.is_empty() {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }
            return;
        }
        // What the browser remembers is what it is judged by, and nothing else.
        let remembered = request.contains("Cookie: vp=1");
        let first_ever = !remembered && handed.fetch_add(1, Ordering::SeqCst) == 0;
        if std::env::var_os("FIXTURE_TRACE").is_some() {
            eprintln!("   [fixture] {line:?} remembered={remembered} first={first_ever}");
        }
        let (body, set) = if remembered {
            // A door: something a person can pass, and the site's answer to
            // this browser's memory. The cookie it hands out here marks a walk
            // that kept the refusal rather than asking again.
            ("<html><title>Just a moment...</title><body>Verify you are human</body></html>", "Set-Cookie: held=1; Path=/; Max-Age=86400\r\n")
        } else if first_ever {
            ("<html><title>Ordinary page</title><body>The page itself.</body></html>", "Set-Cookie: vp=1; Path=/; Max-Age=86400\r\n")
        } else {
            ("<html><title>Ordinary page</title><body>The page itself.</body></html>", "")
        };
        // Never cacheable: a browser that kept the page on disk would open it
        // again without asking, and the site would never see the remembered
        // browser it is supposed to judge.
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nCache-Control: no-store\r\n{set}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    }

    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("site.example");
    let profile_arg = Some(profile.to_string_lossy().into_owned());
    // The door this site shows a browser it remembers never opens, and its pages answer from this machine: the door is
    // given up on after a second and a half, not 25 s, and each walk settles for the 2 s it asks, not the walk's least.
    let waits = Waits { door: std::time::Duration::from_millis(1_500), least_settle: std::time::Duration::ZERO, ..Default::default() };
    // The first walk lands, and its browser now remembers what the site handed
    // it. That memory is what the site refuses next time.
    let first = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "first".into(),
        profile: profile_arg.clone(),
        settle_ms: 2_000,
        waits,
        ..Default::default()
    })
    .await;
    let first = first.expect("the first walk must land");
    assert!(first.cookies.contains_key("vp"), "{:?}", first.cookies);
    assert!(!first.cookies.contains_key("held"), "{:?}", first.cookies);

    // The same browser comes back; the site refuses it. The walk answers with a
    // browser that remembers nothing, and that one lands.
    let second = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "second".into(),
        profile: profile_arg.clone(),
        settle_ms: 2_000,
        waits,
        ..Default::default()
    })
    .await;
    let second = second.expect("the refused walk must land in a browser that remembers nothing");
    // The walk kept the browser the site served its page to, not the one it
    // put behind a door: the door's cookie is absent, and so is the refused
    // browser's memory, which this clean browser never had.
    assert!(!second.cookies.contains_key("held"), "the walk kept the refusal: {:?}", second.cookies);
    assert!(!second.cookies.contains_key("vp"), "{:?}", second.cookies);

    // What the site accepted is what the next walk opens from: the clean
    // browser took the refused profile's place, and the refused one is kept
    // out of the profiles' way.
    assert!(profile.is_dir(), "the accepted browser must take the profile's name");
    let kept: Vec<_> = std::fs::read_dir(root.path().join("refused"))
        .expect("the refused profile must be kept")
        .flatten()
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");

    // And the walk from that profile opens without meeting the refusal again.
    let third = mint(MintOptions {
        url: format!("http://{address}/"),
        session: "third".into(),
        profile: profile_arg,
        settle_ms: 2_000,
        waits,
        ..Default::default()
    })
    .await;
    assert!(third.is_ok(), "{third:?}");

    stopped.store(true, Ordering::Relaxed);
    // Wake the server's accept loop so it can join the workers.
    let _ = std::net::TcpStream::connect(address);
    server.join().unwrap();
}
