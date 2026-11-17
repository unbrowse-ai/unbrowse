//! Local browser regression: walks that start together all go as the browser they are. Its own test binary: what a
//! build said about itself is kept per process, and this is about the first time it is asked.
use agent_browser_core::session::{mint, MintOptions};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires installed Chrome"]
async fn walks_that_start_together_all_hide_the_launch_mode() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stopped = Arc::new(AtomicBool::new(false));
    let stop = stopped.clone();
    let agents = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = agents.clone();
    let server = std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(10));
                continue;
            };
            let seen = seen.clone();
            std::thread::spawn(move || {
                stream.set_nonblocking(false).unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let request = String::from_utf8_lossy(&request).to_string();
                if !request.starts_with("GET / ") {
                    return;
                }
                let agent = request.lines().find(|l| l.to_ascii_lowercase().starts_with("user-agent:"));
                seen.lock().unwrap().push(agent.unwrap_or_default().to_string());
                let body = "<html><title>Ordinary page</title><body>The page itself.</body></html>";
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });

    // A profile each, in a folder of the test's own: a walk with none opens in the machine's shared runtime folder.
    let root = tempfile::tempdir().unwrap();
    let walks: Vec<_> = (0..4)
        .map(|n| {
            tokio::spawn(mint(MintOptions {
                url: format!("http://{address}/"),
                session: format!("walk{n}"),
                profile: Some(root.path().join(format!("walk{n}")).to_string_lossy().into_owned()),
                windowless: true,
                settle_ms: 1_000,
                ..Default::default()
            }))
        })
        .collect();
    for walk in walks {
        walk.await.unwrap().expect("every walk lands");
    }
    stopped.store(true, Ordering::Relaxed);
    server.join().unwrap();

    let agents = agents.lock().unwrap();
    assert!(agents.len() >= 4, "{agents:?}");
    assert!(!agents.iter().any(|a| a.contains("Headless")), "a walk went out as what it was launched as: {agents:?}");
}
