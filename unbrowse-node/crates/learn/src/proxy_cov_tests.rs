//! The browser proxy's SOCKS5 talk (UNB-208): what it accepts from the browser, and how it greets an upstream.
use super::*;
use std::io::{Read, Write};

fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

/// A browser that says `bytes` and listens to what it is answered: the proxy's reading of it, and what it answered.
fn browser_says(bytes: Vec<u8>) -> (Option<(String, u16)>, Vec<u8>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let at = listener.local_addr().unwrap();
    let client = std::thread::spawn(move || {
        let mut s = std::net::TcpStream::connect(at).unwrap();
        s.write_all(&bytes).unwrap();
        // The proxy may already have refused and closed with bytes unread (a reset): then there is no write side left
        // to end (macOS says `NotConnected`), and what was answered is still read below.
        let _ = s.shutdown(std::net::Shutdown::Write);
        let mut answered = Vec::new();
        let _ = s.read_to_end(&mut answered);
        answered
    });
    let (stream, _) = listener.accept().unwrap();
    let read = block_on(async move {
        let mut stream = TcpStream::from_std({
            stream.set_nonblocking(true).unwrap();
            stream
        })
        .unwrap();
        let got = handshake(&mut stream).await;
        drop(stream);
        got
    });
    (read, client.join().unwrap())
}

/// A request for a connection to `host`: the greeting offering no authentication, then a CONNECT of the address type.
fn connect(command: u8, kind: u8, address: &[u8], port: u16) -> Vec<u8> {
    let mut v = vec![5, 1, 0, 5, command, 0, kind];
    v.extend_from_slice(address);
    v.extend_from_slice(&port.to_be_bytes());
    v
}

/// The proxy serves a browser that speaks SOCKS5 and asks to CONNECT, by a name, an IPv4 or an IPv6 address; any other
/// kind of client, or any other request, is not served.
#[test]
fn the_proxy_serves_only_a_socks5_connect_with_no_authentication() {
    let name = [&[12u8][..], b"shop.example"].concat();
    assert_eq!(browser_says(connect(1, 3, &name, 443)), (Some(("shop.example".into(), 443)), vec![5, 0]), "a name");
    assert_eq!(browser_says(connect(1, 1, &[93, 184, 216, 34], 80)).0, Some(("93.184.216.34".into(), 80)), "an IPv4 address");
    let v6 = std::net::Ipv6Addr::LOCALHOST.octets();
    assert_eq!(browser_says(connect(1, 4, &v6, 8443)).0, Some(("::1".into(), 8443)), "an IPv6 address");
    assert_eq!(browser_says(vec![4, 1, 0]).0, None, "another protocol");
    let (read, answered) = browser_says(vec![5, 2, 1, 2]);
    assert_eq!((read, answered), (None, vec![5, 0xFF]), "a browser that offers only authentication is told there is none acceptable");
    assert_eq!(browser_says(connect(2, 3, &name, 443)).0, None, "BIND is not offered");
    assert_eq!(browser_says(connect(3, 3, &name, 443)).0, None, "UDP is not offered");
    assert_eq!(browser_says(connect(1, 9, &[0; 6], 443)).0, None, "an address kind it does not know");
    assert_eq!(browser_says(vec![5, 1, 0, 5, 1]).0, None, "a request cut short");
}

/// An upstream that answers the greeting with `greeting`, then (if it picked authentication) takes the user and
/// password and says `auth`, then answers the CONNECT with `connect`. Returns its address and what it was sent.
fn upstream(greeting: Vec<u8>, auth: Vec<u8>, connected: Vec<u8>) -> (std::net::SocketAddr, std::thread::JoinHandle<Vec<u8>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let at = listener.local_addr().unwrap();
    let handle = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut got = Vec::new();
        let mut head = [0u8; 2];
        s.read_exact(&mut head).unwrap();
        let mut methods = vec![0u8; head[1] as usize];
        s.read_exact(&mut methods).unwrap();
        got.extend_from_slice(&head);
        got.extend_from_slice(&methods);
        s.write_all(&greeting).unwrap();
        if greeting.get(1) == Some(&2) {
            let mut v = [0u8; 2];
            s.read_exact(&mut v).unwrap();
            let mut user = vec![0u8; v[1] as usize];
            s.read_exact(&mut user).unwrap();
            let mut plen = [0u8; 1];
            s.read_exact(&mut plen).unwrap();
            let mut pass = vec![0u8; plen[0] as usize];
            s.read_exact(&mut pass).unwrap();
            got.extend_from_slice(b"|");
            got.extend_from_slice(&user);
            got.extend_from_slice(b":");
            got.extend_from_slice(&pass);
            s.write_all(&auth).unwrap();
            if auth.get(1) != Some(&0) {
                return got;
            }
        }
        if greeting.get(1).is_some_and(|m| *m == 0 || *m == 2) && connected.len() > 1 {
            let mut request = [0u8; 10];
            if s.read_exact(&mut request).is_ok() {
                got.extend_from_slice(b"|");
                got.extend_from_slice(&request);
                let _ = s.write_all(&connected);
            }
        }
        got
    });
    (at, handle)
}

/// A pinned site goes through a SOCKS5 upstream that answers right: with no authentication, or the user and password the
/// upstream's URL names (sent in SOCKS5's own authentication). One that answers as another protocol, wants a method
/// not offered, refuses the credentials, or refuses the connection, carries nothing.
#[test]
fn a_pinned_site_is_carried_by_an_upstream_that_greets_and_authenticates_as_socks5() {
    let site: SocketAddr = "93.184.216.34:443".parse().unwrap();
    let opened = vec![5, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    let (at, seen) = upstream(vec![5, 0], vec![], opened.clone());
    assert!(block_on(chain(&format!("socks5://127.0.0.1:{}", at.port()), &[site])).is_some());
    assert_eq!(seen.join().unwrap(), [vec![5, 1, 0], b"|".to_vec(), vec![5, 1, 0, 1, 93, 184, 216, 34, 1, 187]].concat(), "the greeting offers no authentication; the CONNECT names the address checked");

    let (at, seen) = upstream(vec![5, 2], vec![1, 0], opened.clone());
    assert!(block_on(chain(&format!("socks5://exit:s3cret@127.0.0.1:{}", at.port()), &[site])).is_some());
    let said = seen.join().unwrap();
    assert!(said.starts_with(&[5, 2, 0, 2]) && said.windows(12).any(|w| w == b"|exit:s3cret"), "{said:?}");

    let (at, _) = upstream(vec![4, 0], vec![], vec![]);
    assert!(block_on(chain(&format!("socks5://127.0.0.1:{}", at.port()), &[site])).is_none(), "another protocol");
    let (at, _) = upstream(vec![5, 0xFF], vec![], vec![]);
    assert!(block_on(chain(&format!("socks5://127.0.0.1:{}", at.port()), &[site])).is_none(), "no method it offered is acceptable");
    let (at, _) = upstream(vec![5, 2], vec![1, 1], opened.clone());
    assert!(block_on(chain(&format!("socks5://exit:wrong@127.0.0.1:{}", at.port()), &[site])).is_none(), "credentials refused");
    let (at, _) = upstream(vec![5, 0], vec![], vec![5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
    assert!(block_on(chain(&format!("socks5://127.0.0.1:{}", at.port()), &[site])).is_none(), "connection refused");
    assert!(block_on(chain("http://127.0.0.1:1", &[site])).is_none(), "only a socks5 upstream can carry a pinned site");
}
