//! The resolver the node's own browser uses: a SOCKS5 proxy that resolves every name itself, checks the answer
//! against the node's egress rule, and only then opens the connection.
//!
//! Chrome connects to it and hands it a hostname; this resolves that name through [`crate::egress`], which refuses a
//! public name that answers with an address inside the owner's network, and pins the address it checked. So a page the
//! browser loads can no longer resolve a public name to the owner's loopback, intranet or the cloud metadata address:
//! that was the gap `SECURITY.md` recorded — "pages the node's browser loads resolve in the browser".
//!
//! Why a proxy and not the engine's fetch interception: interception answers each request from Rust, so the site is
//! handed Rust's TLS handshake instead of the browser's, and the handshake is exactly what the door reads. A SOCKS5
//! tunnel carries the browser's own bytes untouched — Chrome's ClientHello and HTTP/2 settings arrive as they are —
//! while the name is resolved here. The tunnel is opaque: nothing is learned from the traffic and nothing rewritten.
//!
//! Two rules, one per kind of client, each on a listener of its own so a connection can't claim the other's:
//!
//! - **The browser** ([`switches`]): a page the node's browser loads never reaches this machine, nor a link-local
//!   address (where a cloud's metadata service answers), whatever led the browser there: an address typed, a redirect, a
//!   script's navigation, a name rebound between two lookups. The check is on the address the socket connects to,
//!   resolved here, so there is no second lookup for the answer to change between. An address inside the owner's
//!   network (a private or unique-local range) is reached only when the owner has turned on Reach private networks. The
//!   node's own control channels are never reached through the browser, so the rule carries no exception for them.
//! - **The node's pinned calls** ([`local_url`]): the node's own rule (`Egress::Own`): a public name must resolve to a
//!   public address, and a place addressed plainly goes where it says, as the call's own transport would decide.
//!
//! A browser is never launched outside the rule: [`switches`] is the one place a launch gets its proxy, it starts the
//! proxy when it isn't up (a few tries), and when it still can't, it says so and the launch is refused. A start that
//! failed is not remembered: the next launch tries again.

use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// How long the proxy waits for a client that connected and says nothing, and for a target to accept.
const HELLO: Duration = Duration::from_secs(10);
const CONNECT: Duration = Duration::from_secs(10);

/// How many times a launch tries to start a proxy that isn't up before it is refused.
const START_TRIES: u32 = 3;

/// Whose connections a listener carries, and so which rule they meet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Carries {
    /// The node's browser: never this machine or a link-local address; inside the network only with the owner's setting.
    Browser,
    /// The node's own pinned calls: the node's own rule.
    Calls,
}

/// Each listener's port for this process, once it is up. Only a start that worked is kept.
static BROWSER: Mutex<Option<u16>> = Mutex::new(None);
/// A site's own browser's listener, by the site: a connection on it is that browser's, so the checkout hold can tell
/// the checkout's own browser from every other (`hold::browser_refused`).
static LABELLED: Mutex<BTreeMap<String, u16>> = Mutex::new(BTreeMap::new());
static CALLS: Mutex<Option<u16>> = Mutex::new(None);

/// Which sites leave through which upstream: a registrable site (or `*`) to a `socks5://user:pass@host:port`. A site
/// with one sends its browser and its browserless calls through the same public address, so the client that earned a
/// credential and the calls that spend it are the same client to the site. Empty: direct, as before.
static PINS: RwLock<BTreeMap<String, String>> = RwLock::new(BTreeMap::new());

/// Sets the pins from the owner's settings: keys lowercased, blank entries dropped. A site's own entry wins over `*`.
pub fn pin_all(pins: BTreeMap<String, String>) {
    let mut held = PINS.write().unwrap_or_else(std::sync::PoisonError::into_inner);
    *held = pins
        .into_iter()
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .filter(|(k, v)| !k.is_empty() && !v.is_empty())
        .collect();
}

/// The upstream `host` leaves through, if one is pinned: its own site's, else `*`.
pub fn pinned(host: &str) -> Option<String> {
    let held = PINS.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    let site = crate::identity::site_of(host);
    held.get(&host.to_ascii_lowercase())
        .or_else(|| held.get(&site.to_ascii_lowercase()))
        .or_else(|| held.get("*"))
        .cloned()
}

/// The calls' proxy address, when it is up: a client whose site is pinned goes through it, so the pin applies to the
/// browserless side exactly as it does to the browser's.
pub fn local_url() -> Option<String> {
    let port = up(&CALLS, || start(Carries::Calls, None)).ok()?;
    Some(format!("socks5h://127.0.0.1:{port}"))
}

/// The switches every browser the node launches runs with, so that every connection it makes meets the browser's
/// rule: `--proxy-server`; the bypass list that keeps Chrome from taking loopback around it (`<-loopback>` *removes*
/// Chrome's implicit loopback bypass); `--disable-quic`, so Chrome can't reach an origin over UDP QUIC (which a TCP
/// proxy can't carry) and skip the check; and WebRTC held to the proxy, so a page can't open UDP to an address the
/// proxy never sees. This is the one place a launch gets them.
///
/// An error when the proxy isn't up after [`START_TRIES`] tries: the launch is refused rather than run outside the rule.
pub fn switches() -> Result<Vec<String>, String> {
    switches_from(up(&BROWSER, || start(Carries::Browser, None))?)
}

/// [`switches`], for `label`'s own browser (a site's): the same rule, on a listener of its own, so the connections it
/// carries are known to be that browser's.
pub fn switches_for(label: &str) -> Result<Vec<String>, String> {
    let mut all = LABELLED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(port) = all.get(label) {
        return switches_from(*port);
    }
    let held = Mutex::new(None);
    let named: std::sync::Arc<str> = std::sync::Arc::from(label);
    let port = up(&held, || start(Carries::Browser, Some(named.clone())))?;
    all.insert(label.to_string(), port);
    switches_from(port)
}

fn switches_from(port: u16) -> Result<Vec<String>, String> {
    Ok(vec![
        format!("--proxy-server=socks5://127.0.0.1:{port}"),
        "--proxy-bypass-list=<-loopback>".to_string(),
        "--disable-quic".to_string(),
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string(),
    ])
}

/// The port `held` names, starting it with `start` when it isn't up: a few tries, a short wait between them. A start
/// that failed leaves nothing behind, so the next ask tries again.
fn up(held: &Mutex<Option<u16>>, start: impl Fn() -> Option<u16>) -> Result<u16, String> {
    let mut held = held.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(port) = *held {
        return Ok(port);
    }
    for attempt in 0..START_TRIES {
        if let Some(port) = start() {
            *held = Some(port);
            return Ok(port);
        }
        if attempt + 1 < START_TRIES {
            std::thread::sleep(Duration::from_millis(200 * u64::from(attempt + 1)));
        }
    }
    Err(format!(
        "the browser's egress proxy didn't start after {START_TRIES} tries, so the browser isn't launched: \
         a browser outside it could reach this machine and the owner's network"
    ))
}

/// Starts a proxy carrying `carries` on a thread of its own: `None` when it couldn't bind or couldn't run. Everything
/// that can fail is done before the port is handed back, so a port handed back is one that answers.
fn start(carries: Carries, label: Option<std::sync::Arc<str>>) -> Option<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    listener.set_nonblocking(true).ok()?;
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
    let listener = {
        let _in = rt.enter();
        TcpListener::from_std(listener).ok()?
    };
    std::thread::Builder::new()
        .name("unbrowse-browser-proxy".into())
        .spawn(move || {
            rt.block_on(async move {
                loop {
                    let Ok((client, _)) = listener.accept().await else { continue };
                    tokio::spawn(serve(client, carries, label.clone()));
                }
            });
        })
        .ok()?;
    Some(port)
}

/// Whether a connection from the node's browser may go to `ip`. The rule is a property of the address, never a list of
/// hosts:
///
/// - **Never this machine**, whatever the owner's setting: loopback, unspecified, "this network" (`0.0.0.0/8`), and any
///   address one of this machine's own interfaces holds (its LAN, VPN or public address reaches every service bound to
///   all interfaces just as loopback does).
/// - **Never link-local** (`169.254.0.0/16`, `fe80::/10`), whatever the setting: an address that is only meaningful on the
///   wire next to the machine is where a host's own services answer. Every IPv4 instance-metadata service the clouds run
///   sits there (`169.254.169.254` and its neighbours), so they fall under the property, not under a name.
/// - **Inside the owner's network only with Reach private networks on**: private, unique-local, shared (CGNAT) and every
///   other range that isn't public.
/// - Anywhere public.
///
/// An IPv6 address that carries an IPv4 one (mapped, compatible, NAT64, 6to4, Teredo) is judged as that IPv4 address, so
/// a wrapping can't move an address from one class to another.
///
/// What address alone can't tell: an instance-metadata service a cloud puts on a unique-local IPv6 address (or on
/// shared space) looks exactly like the owner's own intranet, so it is refused while Reach private networks is off and
/// reachable while it is on.
pub fn browser_may_reach(ip: IpAddr) -> Result<(), String> {
    let ip = carried(ip);
    if is_this_machine(ip) {
        return Err(format!("{ip} is this machine: a page the node's browser loads never reaches this machine's own services"));
    }
    let link_local = match ip {
        IpAddr::V4(a) => a.is_link_local(),
        IpAddr::V6(a) => (a.segments()[0] & 0xffc0) == 0xfe80,
    };
    if link_local {
        return Err(format!(
            "{ip} is link-local, where a machine's metadata and configuration services answer: the node's browser never goes there"
        ));
    }
    if !crate::egress::is_public_ip(ip) && !crate::egress::private_allowed() {
        return Err(format!(
            "{ip} is inside this network: the node's browser goes there only with Reach private networks on in Settings"
        ));
    }
    Ok(())
}

/// The IPv4 address an IPv6 address carries, or the address itself when it carries none: one rule for every caller
/// ([`agent_browser_core::intercept::embedded_ipv4`]), so a wrapping can't move an address from one class to another.
fn carried(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => agent_browser_core::intercept::embedded_ipv4(v6).map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

/// Whether `ip` is this machine: loopback, unspecified, "this network", or an address one of its interfaces holds.
fn is_this_machine(ip: IpAddr) -> bool {
    ip.is_loopback()
        || ip.is_unspecified()
        || matches!(ip, IpAddr::V4(a) if a.octets()[0] == 0)
        || if_addrs::get_if_addrs().map(|all| all.iter().any(|i| i.ip() == ip)).unwrap_or(false)
}

/// One client: greet, take its CONNECT, resolve and check the name, open the target, and tunnel.
async fn serve(mut client: TcpStream, carries: Carries, label: Option<std::sync::Arc<str>>) {
    let Some((host, port)) = tokio::time::timeout(HELLO, handshake(&mut client)).await.ok().flatten() else { return };
    // While a card checkout waits for the owner, a browser connects only as the hold lets it (`hold`). The connection
    // listens for a change in the hold before its first check, so a hold that begins while it resolves or connects is
    // heard; it is checked before the name is resolved, again under the commit lock just before success is replied,
    // and again before the first byte is carried (`carry_while_allowed`).
    let changes = (carries == Carries::Browser).then(crate::hold::watch);
    if carries == Carries::Browser {
        if let Err(why) = crate::hold::browser_authorized(label.as_deref(), &host) {
            eprintln!("browser proxy: {host}: {why}");
            let _ = reply(&mut client, false).await;
            return;
        }
    }
    #[cfg(test)]
    if let Some(addr) = tests::target_for(&host) {
        return serve_to(client, carries, label, host, changes, TcpStream::connect(addr).await.ok()).await;
    }
    let Some(addrs) = resolve(&host, port, carries).await else {
        // Say so, so the client stops waiting. The rule's own words go to the node's log, never to the page.
        let _ = reply(&mut client, false).await;
        return;
    };
    // A pinned site leaves through its upstream: the address is the one resolved and checked here, while the public
    // address the site sees is the upstream's.
    let target = match pinned(&host) {
        Some(upstream) => match chain(&upstream, &addrs).await {
            Some(t) => Some(t),
            None => {
                eprintln!("browser proxy: {host}: the pinned upstream {} did not carry it", named(&upstream));
                let _ = reply(&mut client, false).await;
                return;
            }
        },
        None => {
            let mut direct = None;
            for addr in addrs {
                if let Ok(Ok(t)) = tokio::time::timeout(CONNECT, TcpStream::connect(addr)).await {
                    direct = Some(t);
                    break;
                }
            }
            direct
        }
    };
    serve_to(client, carries, label, host, changes, target).await;
}

/// The end of [`serve`], once the target is connected (or not): the final authorisation, the reply, and the carrying.
async fn serve_to(mut client: TcpStream, carries: Carries, label: Option<std::sync::Arc<str>>, host: String, changes: Option<tokio::sync::watch::Receiver<u64>>, target: Option<TcpStream>) {
    let Some(mut target) = target else {
        let _ = reply(&mut client, false).await;
        return;
    };
    #[cfg(test)]
    tests::pause(&host, "connected").await;
    // The final authorisation, under the commit lock, immediately before success is said: a hold made durable while
    // this connection resolved or connected is seen here, and the client hears a refusal. Its generation is what each
    // carried write is held to (`forward`).
    let mut seen = 0;
    if carries == Carries::Browser {
        match crate::hold::browser_authorized(label.as_deref(), &host) {
            Ok(generation) => seen = generation,
            Err(why) => {
                eprintln!("browser proxy: {host}: {why}");
                let _ = reply(&mut client, false).await;
                return;
            }
        }
    }
    if reply(&mut client, true).await.is_err() {
        return;
    }
    #[cfg(test)]
    tests::pause(&host, "replied").await;
    match changes {
        Some(changes) => carry_while_allowed(client, target, label, host, changes, seen).await,
        None => {
            let _ = tokio::io::copy_bidirectional(&mut client, &mut target).await;
        }
    }
}

/// Carries a browser's connection to `host` until it ends, or until the checkout hold changes so that it is refused
/// (`hold::changed`): then it is closed, both ways. What the page sends goes through [`forward`], whose every write is
/// held to the hold's generation; what the site answers is copied as it comes, and when the site ends its side the
/// browser hears that end, as `copy_bidirectional` passes it on (an answer that ends by closing is otherwise waited on
/// for ever). A keep-alive connection opened before a hold began carries nothing past it, not even a chunk read just as
/// the hold was made durable.
async fn carry_while_allowed<A, B>(client: A, target: B, label: Option<std::sync::Arc<str>>, host: String, mut changes: tokio::sync::watch::Receiver<u64>, seen: u64)
where
    A: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    B: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut client_rd, mut client_wr) = tokio::io::split(client);
    let (mut target_rd, mut target_wr) = tokio::io::split(target);
    let up = forward(&mut client_rd, &mut target_wr, label.as_deref(), &host, seen);
    let down = async {
        let copied = tokio::io::copy(&mut target_rd, &mut client_wr).await;
        let _ = client_wr.shutdown().await;
        copied
    };
    tokio::pin!(up);
    tokio::pin!(down);
    let (mut up_done, mut down_done) = (false, false);
    loop {
        // A change is heard before any byte is carried: `changes` was subscribed before the connection's first check,
        // so one that came while it was set up is waiting here already, and is met first.
        tokio::select! {
            biased;
            heard = changes.changed() => {
                if heard.is_err() || crate::hold::browser_authorized(label.as_deref(), &host).is_err() {
                    eprintln!("browser proxy: {host}: closed, a card checkout is waiting for the owner");
                    return;
                }
            }
            sent = &mut up, if !up_done => {
                if sent.is_err() {
                    return;
                }
                up_done = true;
            }
            _ = &mut down, if !down_done => {
                down_done = true;
            }
        }
        if up_done && down_done {
            return;
        }
    }
}

/// How long one carried write may take: a commit waits for writes under way, so none may hold it long.
const WRITE_WAIT: Duration = Duration::from_secs(10);

/// Copies what the page sends to the site, a chunk at a time, each write held to the hold's generation: a chunk is
/// read, then written only while nothing changed since the connection was last authorised (`hold::Writing`), and a
/// commit waits for a write under way. When the hold changed, the commit is let finish and the connection is
/// authorised again before the chunk goes; refused, the chunk is dropped and the connection ends.
async fn forward<R, W>(from: &mut R, to: &mut W, label: Option<&str>, host: &str, mut seen: u64) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = from.read(&mut buf).await?;
        if n == 0 {
            let _ = to.shutdown().await;
            return Ok(());
        }
        #[cfg(test)]
        tests::pause(host, "read").await;
        loop {
            if let Some(writing) = crate::hold::Writing::may(seen) {
                let wrote = tokio::time::timeout(WRITE_WAIT, to.write_all(&buf[..n])).await;
                drop(writing);
                match wrote {
                    Ok(Ok(())) => break,
                    Ok(Err(e)) => return Err(e),
                    Err(_) => return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "the site didn't take the bytes")),
                }
            }
            // A commit is under way or came since: wait for it, then meet the rule again.
            tokio::time::sleep(Duration::from_millis(2)).await;
            match crate::hold::browser_authorized(label, host) {
                Ok(generation) if generation % 2 == 0 => seen = generation,
                Ok(_) => continue,
                Err(why) => {
                    eprintln!("browser proxy: {host}: a chunk dropped and the connection closed: {why}");
                    return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied, why));
                }
            }
        }
    }
}

/// The name and port a SOCKS5 client asked to reach. `None` for a client that isn't speaking SOCKS5, or asks for BIND
/// or UDP, which this proxy doesn't offer.
async fn handshake(client: &mut TcpStream) -> Option<(String, u16)> {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await.ok()?;
    if head[0] != 5 {
        return None;
    }
    let mut methods = vec![0u8; head[1] as usize];
    client.read_exact(&mut methods).await.ok()?;
    // Only "no authentication": the proxy listens on loopback for this machine's browser, and anyone who can reach it
    // can already read the node's files.
    if !methods.contains(&0) {
        client.write_all(&[5, 0xFF]).await.ok()?;
        return None;
    }
    client.write_all(&[5, 0]).await.ok()?;

    let mut request = [0u8; 4];
    client.read_exact(&mut request).await.ok()?;
    if request[0] != 5 || request[1] != 1 {
        return None; // CONNECT only
    }
    let host = match request[3] {
        1 => {
            let mut a = [0u8; 4];
            client.read_exact(&mut a).await.ok()?;
            IpAddr::from(a).to_string()
        }
        3 => {
            let mut n = [0u8; 1];
            client.read_exact(&mut n).await.ok()?;
            let mut name = vec![0u8; n[0] as usize];
            client.read_exact(&mut name).await.ok()?;
            String::from_utf8(name).ok()?
        }
        4 => {
            let mut a = [0u8; 16];
            client.read_exact(&mut a).await.ok()?;
            IpAddr::from(a).to_string()
        }
        _ => return None,
    };
    let mut port = [0u8; 2];
    client.read_exact(&mut port).await.ok()?;
    Some((host, u16::from_be_bytes(port)))
}


/// An upstream as the node's log names it: by its host. Its URL carries the exit's user and password, which a log
/// never does, and one that isn't a URL is not repeated at all.
fn named(upstream: &str) -> String {
    url::Url::parse(upstream).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_else(|| "(not a URL)".to_string())
}

/// Opens a tunnel to one of `addrs` through `upstream`, a SOCKS5 proxy: the CONNECT names the address this proxy
/// resolved and checked, so the address used is the address checked, while the public address is the upstream's. The
/// upstream's user and password, when its URL names them, go in SOCKS5's own authentication.
async fn chain(upstream: &str, addrs: &[SocketAddr]) -> Option<TcpStream> {
    let url = url::Url::parse(upstream).ok()?;
    if url.scheme() != "socks5" && url.scheme() != "socks5h" {
        eprintln!("browser proxy: {}: only a socks5:// upstream can carry a pinned site", named(upstream));
        return None;
    }
    let host = url.host_str()?;
    let port = url.port().unwrap_or(1080);
    let password = url.password().map(str::to_string);
    let mut server = tokio::time::timeout(CONNECT, TcpStream::connect((host, port))).await.ok()?.ok()?;
    // Greet: no authentication, and its username/password when the URL names one.
    let methods: Vec<u8> = if password.is_some() { vec![0, 2] } else { vec![0] };
    let mut greet = vec![5u8, methods.len() as u8];
    greet.extend_from_slice(&methods);
    server.write_all(&greet).await.ok()?;
    let mut answer = [0u8; 2];
    server.read_exact(&mut answer).await.ok()?;
    if answer[0] != 5 {
        return None;
    }
    if answer[1] == 2 {
        let user = url.username().as_bytes();
        let pass = password.as_deref().unwrap_or_default().as_bytes();
        let mut auth = vec![1u8, user.len() as u8];
        auth.extend_from_slice(user);
        auth.push(pass.len() as u8);
        auth.extend_from_slice(pass);
        server.write_all(&auth).await.ok()?;
        server.read_exact(&mut answer).await.ok()?;
        if answer[1] != 0 {
            return None;
        }
    } else if answer[1] != 0 {
        return None;
    }
    for addr in addrs {
        let mut req = match addr.ip() {
            IpAddr::V4(a) => {
                let mut r = vec![5u8, 1, 0, 1];
                r.extend_from_slice(&a.octets());
                r
            }
            IpAddr::V6(a) => {
                let mut r = vec![5u8, 1, 0, 4];
                r.extend_from_slice(&a.octets());
                r
            }
        };
        req.extend_from_slice(&addr.port().to_be_bytes());
        if server.write_all(&req).await.is_err() {
            return None;
        }
        if read_reply(&mut server).await == Some(0) {
            return Some(server);
        }
    }
    None
}

/// Reads a SOCKS5 reply's status, whatever address form the server answered with: a tunnel is open only on `0x00`.
async fn read_reply(server: &mut TcpStream) -> Option<u8> {
    let mut head = [0u8; 4];
    server.read_exact(&mut head).await.ok()?;
    let rest = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut n = [0u8; 1];
            server.read_exact(&mut n).await.ok()?;
            n[0] as usize + 2
        }
        _ => return None,
    };
    let mut tail = vec![0u8; rest];
    server.read_exact(&mut tail).await.ok()?;
    Some(head[1])
}

/// The addresses `host` may be connected to under the rule `carries` meets, or `None` when the rule refuses it.
///
/// A name is resolved here and checked ([`crate::egress::lookup`]), so the address checked is the address connected
/// to: a public name that answers inside the network is refused before anything is sent. For the node's calls, an
/// address the client wrote itself is a place addressed plainly, and goes where it says. For the browser, every address
/// a connection would use, written or resolved, meets [`browser_may_reach`]; one it refuses refuses the whole answer,
/// since a name that answers both outside and in is a name being pointed in.
async fn resolve(host: &str, port: u16, carries: Carries) -> Option<Vec<SocketAddr>> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addrs = match bare.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => match crate::egress::lookup(bare, port).await {
            Ok(addrs) => addrs,
            Err(why) => {
                eprintln!("browser proxy: {host}: {why}");
                return None;
            }
        },
    };
    if carries == Carries::Browser {
        if let Some(why) = addrs.iter().find_map(|a| browser_may_reach(a.ip()).err()) {
            eprintln!("browser proxy: {host}: {why}");
            return None;
        }
    }
    Some(addrs)
}

/// SOCKS5's answer to a CONNECT: `0x00` connected, else a general failure. BND.ADDR is all zeros, since nothing
/// downstream reads the bound address of a tunnel.
async fn reply(client: &mut TcpStream, ok: bool) -> std::io::Result<()> {
    let body: [u8; 10] = if ok { [5, 0, 0, 1, 0, 0, 0, 0, 0, 0] } else { [5, 1, 0, 1, 0, 0, 0, 0, 0, 0] };
    client.write_all(&body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::egress::tests::{point, setting};
    use std::io::{Read, Write};

    /// Asks the proxy for `host:port` and says whether it connected, by reading the SOCKS5 answer.
    fn connect_through(proxy: u16, host: &str, port: u16) -> bool {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(&[5, 1, 0]).unwrap();
        let mut two = [0u8; 2];
        s.read_exact(&mut two).unwrap();
        assert_eq!(two, [5, 0], "no authentication");
        let mut req = vec![5u8, 1, 0, 3, host.len() as u8];
        req.extend_from_slice(host.as_bytes());
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).unwrap();
        let mut answer = [0u8; 10];
        match s.read_exact(&mut answer) {
            Ok(()) => answer[0] == 5 && answer[1] == 0,
            Err(_) => false,
        }
    }


    /// A SOCKS5 upstream that records what it was asked to connect to and tunnels there: a pinned site's connection
    /// reaches it, and the address it names is the one this proxy resolved and checked.
    fn fake_upstream(seen: std::sync::Arc<std::sync::Mutex<Vec<String>>>) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut head = [0u8; 2];
                if s.read_exact(&mut head).is_err() {
                    continue;
                }
                let mut methods = vec![0u8; head[1] as usize];
                let _ = s.read_exact(&mut methods);
                if s.write_all(&[5, 0]).is_err() {
                    continue;
                }
                let mut req = [0u8; 4];
                if s.read_exact(&mut req).is_err() {
                    continue;
                }
                let mut addr = [0u8; 4];
                let _ = s.read_exact(&mut addr);
                let mut p = [0u8; 2];
                let _ = s.read_exact(&mut p);
                let target = format!("{}.{}.{}.{}:{}", addr[0], addr[1], addr[2], addr[3], u16::from_be_bytes(p));
                seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(target.clone());
                let Ok(sa) = target.parse::<SocketAddr>() else { continue };
                let Ok(mut t) = std::net::TcpStream::connect(sa) else { continue };
                if s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).is_err() {
                    continue;
                }
                let (mut up, mut down) = match (s.try_clone(), t.try_clone()) {
                    (Ok(a), Ok(b)) => (a, b),
                    _ => continue,
                };
                std::thread::spawn(move || { let _ = std::io::copy(&mut down, &mut up); });
                let _ = std::io::copy(&mut s, &mut t);
            }
        });
        port
    }

    /// An upstream's URL carries the exit's user and password. The log names the exit by its host and nothing else,
    /// whatever the URL's scheme, and an upstream that isn't a URL is not repeated at all.
    #[test]
    fn the_log_names_an_upstream_by_its_host_alone() {
        for upstream in ["socks5://owner:hunter2@exit.example:1080", "http://owner:hunter2@exit.example:8080/x?key=hunter2", "socks5h://hunter2@exit.example"] {
            assert_eq!(named(upstream), "exit.example", "{upstream}");
        }
        for upstream in ["owner:hunter2@exit.example:1080", "hunter2", ""] {
            let said = named(upstream);
            assert!(!said.contains("hunter2") && !said.contains("owner"), "{said}");
        }
    }

    /// A pinned site leaves through its upstream, with the address this proxy resolved: the browser and the calls
    /// share one public address, so a credential the browser earned is spent by the call that sends it.
    /// Hosts a test sends to a local target of its own, skipping resolution (a browser's rule refuses this machine).
    static TARGETS: std::sync::Mutex<Vec<(String, std::net::SocketAddr)>> = std::sync::Mutex::new(Vec::new());
    /// Points where a test holds a connection still: (host, stage, said when reached, let go).
    #[allow(clippy::type_complexity)]
    static PAUSES: std::sync::Mutex<Vec<(String, &'static str, std::sync::mpsc::Sender<()>, std::sync::Arc<tokio::sync::Notify>)>> = std::sync::Mutex::new(Vec::new());

    pub(super) fn target_for(host: &str) -> Option<std::net::SocketAddr> {
        TARGETS.lock().unwrap().iter().find(|(h, _)| h == host).map(|(_, a)| *a)
    }

    pub(super) async fn pause(host: &str, stage: &str) {
        let found = PAUSES.lock().unwrap().iter().find(|(h, s, ..)| h == host && *s == stage).map(|(.., said, go)| (said.clone(), go.clone()));
        if let Some((said, go)) = found {
            let _ = said.send(());
            go.notified().await;
        }
    }

    /// A chunk a carried connection read just as a hold was made durable is never written: the page-to-site copy
    /// (`forward`, driven alone here, so no watcher on the hold's changes can close the connection first) is held still
    /// between reading a chunk and writing it, a hold is committed, and it is let go; the site sees none of those bytes
    /// and the copy ends refused. Before the hold, a chunk is carried as read.
    #[test]
    fn a_chunk_read_as_a_hold_commits_is_never_written_upstream() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let host = "streaming-write.invalid".to_string();
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let (mut page, mut page_end) = tokio::io::duplex(64 * 1024);
        let (mut site_end, mut site) = tokio::io::duplex(64 * 1024);
        let seen = crate::hold::browser_authorized(Some("another-site"), &host).unwrap();
        let h = host.clone();
        let copying = rt.spawn(async move { forward(&mut page_end, &mut site_end, Some("another-site"), &h, seen).await });
        rt.block_on(async {
            page.write_all(b"before").await.unwrap();
            let mut got = [0u8; 6];
            site.read_exact(&mut got).await.unwrap();
            assert_eq!(&got, b"before", "carried while nothing is held");
        });
        // The next chunk is held still once read, before it is written.
        let (said, reached) = std::sync::mpsc::channel();
        let go = std::sync::Arc::new(tokio::sync::Notify::new());
        PAUSES.lock().unwrap().push((host.clone(), "read", said, go.clone()));
        rt.block_on(async { page.write_all(b"POST /act HTTP/1.1\r\n\r\n").await.unwrap() });
        reached.recv_timeout(Duration::from_secs(10)).expect("the chunk was read");
        // The hold is made durable while the chunk sits between read and write.
        refuse_while_held(&[host.as_str()]);
        crate::hold::committing(|| ());
        go.notify_one();
        rt.block_on(async {
            let ended = tokio::time::timeout(Duration::from_secs(5), copying).await.expect("the copy ends").unwrap();
            assert!(ended.is_err(), "the copy ended refused");
            let mut more = [0u8; 64];
            let n = tokio::time::timeout(Duration::from_millis(500), site.read(&mut more)).await.ok().and_then(|r| r.ok()).unwrap_or(0);
            assert_eq!(n, 0, "the chunk read as the hold committed never reached the site: {:?}", String::from_utf8_lossy(&more[..n]));
        });
        PAUSES.lock().unwrap().retain(|(h, ..)| *h != host);
        release(&[host.as_str()]);
    }

    /// A browser connection being set up when a hold begins carries nothing to its target: held still once its
    /// upstream connected (before success is said), and again once success was said (before any byte is carried),
    /// while the hold is made durable. Held before the reply, the client hears a refusal; held after it, the connection
    /// is closed before the first byte. Either way the target sees no application byte.
    #[test]
    fn a_connection_set_up_while_a_hold_begins_carries_nothing() {
        for stage in ["connected", "replied"] {
            let host = format!("late-{stage}.invalid");
            let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = target.local_addr().unwrap();
            let got = std::thread::spawn(move || {
                let (mut s, _) = target.accept().unwrap();
                s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                let mut all = Vec::new();
                let _ = s.read_to_end(&mut all);
                all
            });
            TARGETS.lock().unwrap().push((host.clone(), addr));
            let (said, reached) = std::sync::mpsc::channel();
            let go = std::sync::Arc::new(tokio::sync::Notify::new());
            PAUSES.lock().unwrap().push((host.clone(), stage, said, go.clone()));
            let proxy = start(Carries::Browser, Some(std::sync::Arc::from("other-browser"))).expect("the proxy starts");
            let h = host.clone();
            let client = std::thread::spawn(move || {
                let mut s = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
                s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                s.write_all(&[5, 1, 0]).unwrap();
                let mut two = [0u8; 2];
                s.read_exact(&mut two).unwrap();
                let mut req = vec![5u8, 1, 0, 3, h.len() as u8];
                req.extend_from_slice(h.as_bytes());
                req.extend_from_slice(&443u16.to_be_bytes());
                s.write_all(&req).unwrap();
                let mut answer = [0u8; 10];
                s.read_exact(&mut answer).unwrap();
                if answer[1] == 0 {
                    let _ = s.write_all(b"POST /act HTTP/1.1\r\nhost: x\r\n\r\n");
                    let mut rest = Vec::new();
                    let _ = s.read_to_end(&mut rest);
                }
                answer[1]
            });
            reached.recv_timeout(Duration::from_secs(10)).expect("the connection reached its pause");
            // The hold is made durable, and said, while the connection is held still.
            refuse_while_held(&[host.as_str()]);
            crate::hold::committing(|| ());
            go.notify_one();
            let rep = client.join().unwrap();
            if stage == "connected" {
                assert_ne!(rep, 0, "the client hears a refusal");
            }
            assert!(got.join().unwrap().is_empty(), "{stage}: the target saw no application byte");
            release(&[host.as_str()]);
        }
    }

    /// Hosts these tests' checkout rule refuses: each test names its own, so tests beside it are untouched.
    static REFUSED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    /// Every host the rule refused, as the proxy asked it.
    static REFUSALS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

    fn refuse_while_held(hosts: &[&str]) {
        static SET: std::sync::Once = std::sync::Once::new();
        SET.call_once(|| {
            crate::hold::set_browser(|label, host| {
                let refused = label != Some("the-checkout") && REFUSED.lock().unwrap().iter().any(|h| h == host);
                if refused {
                    REFUSALS.lock().unwrap().push(host.to_string());
                }
                refused.then(|| "a card checkout is waiting for the owner".to_string())
            })
        });
        REFUSED.lock().unwrap().extend(hosts.iter().map(|h| h.to_string()));
    }

    fn release(hosts: &[&str]) {
        REFUSED.lock().unwrap().retain(|h| !hosts.contains(&h.as_str()));
        crate::hold::changed();
    }

    /// While a card checkout waits, a browser's new connection to a host the hold doesn't let it reach is refused
    /// before its name is even resolved, whatever the page or tab that asked; the checkout's own browser, on a listener
    /// of its own, is let through. Released, the host is reached again.
    #[test]
    fn a_browser_reaches_only_what_the_hold_lets_it_while_a_checkout_waits() {
        refuse_while_held(&["unheld-processor.invalid"]);
        assert!(crate::hold::browser_refused(Some("another-site"), "unheld-processor.invalid").is_some());
        assert!(crate::hold::browser_refused(Some("the-checkout"), "unheld-processor.invalid").is_none(), "the checkout's own browser");
        let other = start(Carries::Browser, Some(std::sync::Arc::from("another-site"))).expect("the proxy starts");
        assert!(!connect_through(other, "unheld-processor.invalid", 443), "refused through the proxy");
        assert!(super::switches_for("another-site").unwrap()[0].starts_with("--proxy-server=socks5://127.0.0.1:"));
        assert_eq!(super::switches_for("another-site").unwrap(), super::switches_for("another-site").unwrap(), "one listener per browser");
        assert_ne!(super::switches_for("another-site").unwrap(), super::switches_for("the-checkout").unwrap());
        release(&["unheld-processor.invalid"]);
        assert!(crate::hold::browser_refused(Some("another-site"), "unheld-processor.invalid").is_none(), "released");
    }

    /// Live, through real Chrome launched with this proxy as an unheld site's browser: a page defines an `innerText`
    /// getter that POSTs, and the node reads `innerText` the way the browser daemon's `get text` does
    /// (`Runtime.callFunctionOn`). During a hold the request reaches the proxy and is refused there, before its name is
    /// resolved: the page's fetch fails and nothing leaves. (The node refuses the `get text` command itself during a
    /// hold too; this shows that a page running code anyway is held at the proxy.)
    #[test]
    #[ignore = "drives Chrome: cargo test -p unbrowse-learn an_unheld_pages_getter -- --ignored"]
    fn an_unheld_pages_getter_post_is_refused_at_the_proxy_during_a_hold() {
        use agent_browser_core::cdp::client::CdpClient;
        use serde_json::json;
        refuse_while_held(&["getter-post.invalid"]);
        let proxy = start(Carries::Browser, Some(std::sync::Arc::from("unheld-site"))).expect("the proxy starts");
        let path = agent_browser_core::cdp::chrome::find_chrome().expect("Chrome");
        let profile = std::env::temp_dir().join(format!("proxy-hold-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&profile);
        let mut child = std::process::Command::new(path)
            .args(["--headless=new", "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-gpu"])
            .args(switches_from(proxy).unwrap())
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg("about:blank")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut ws = None;
        for _ in 0..150 {
            if let Some((p, path)) = agent_browser_core::cdp::chrome::read_devtools_active_port(&profile) {
                ws = Some(format!("ws://127.0.0.1:{p}{path}"));
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let ws = ws.expect("Chrome opened its DevTools");
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let page = "data:text/html,<body>hello<script>Object.defineProperty(document.body,'innerText',{get(){fetch('https://getter-post.invalid/act',{method:'POST',body:'x',mode:'no-cors'}).then(()=>window.r='sent',e=>window.r='refused');return 'harmless';}});</script></body>";
        let result = rt.block_on(async {
            let cdp = CdpClient::connect(&ws).await?;
            let t = cdp.send_command("Target.createTarget", Some(json!({ "url": page })), None).await?;
            let s = cdp.send_command("Target.attachToTarget", Some(json!({ "targetId": t["targetId"], "flatten": true })), None).await?;
            let session = s["sessionId"].as_str().unwrap().to_string();
            tokio::time::sleep(Duration::from_millis(800)).await;
            let body = cdp.send_command("Runtime.evaluate", Some(json!({ "expression": "document.body" })), Some(&session)).await?;
            let read = cdp
                .send_command(
                    "Runtime.callFunctionOn",
                    Some(json!({ "objectId": body["result"]["objectId"], "functionDeclaration": "function() { return this.innerText || this.textContent || ''; }", "returnByValue": true })),
                    Some(&session),
                )
                .await?;
            assert_eq!(read["result"]["value"], json!("harmless"), "the page's getter ran on the read");
            let mut said = serde_json::Value::Null;
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                said = cdp.send_command("Runtime.evaluate", Some(json!({ "expression": "window.r", "returnByValue": true })), Some(&session)).await?["result"]["value"].clone();
                if !said.is_null() {
                    break;
                }
            }
            cdp.close().await;
            Ok::<_, String>(said)
        });
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&profile);
        assert_eq!(result.unwrap(), json!("refused"), "the getter's POST failed");
        assert!(REFUSALS.lock().unwrap().iter().any(|h| h == "getter-post.invalid"), "and it was the hold that refused it, at the proxy");
        release(&["getter-post.invalid"]);
        assert!(crate::hold::browser_refused(Some("unheld-site"), "getter-post.invalid").is_none(), "released");
    }

    /// A connection a page opened before the hold began (a keep-alive, a socket, a worker's) carries nothing past it:
    /// when the hold changes, every carried connection meets the rule again, and one it refuses is closed both ways.
    #[test]
    fn an_open_browser_connection_is_closed_when_a_hold_begins() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (mut page, page_end) = tokio::io::duplex(1024);
            let (site_end, mut site) = tokio::io::duplex(1024);
            let carried = tokio::spawn(carry_while_allowed(page_end, site_end, Some(std::sync::Arc::from("another-site")), "long-poll.invalid".to_string(), crate::hold::watch(), crate::hold::browser_authorized(Some("another-site"), "long-poll.invalid").unwrap()));
            page.write_all(b"before").await.unwrap();
            let mut got = [0u8; 6];
            site.read_exact(&mut got).await.unwrap();
            assert_eq!(&got, b"before", "carried while nothing is held");
            refuse_while_held(&["long-poll.invalid"]);
            crate::hold::changed();
            tokio::time::timeout(Duration::from_secs(5), carried).await.expect("closed at once").unwrap();
            let _ = page.write_all(b"after").await;
            let mut rest = Vec::new();
            let n = tokio::time::timeout(Duration::from_secs(5), site.read_to_end(&mut rest)).await.expect("the site's end closes").unwrap_or(0);
            assert_eq!(n, 0, "nothing reached the site after the hold began: {rest:?}");
        });
        release(&["long-poll.invalid"]);
    }

    /// A site that ends its answer by closing the connection (HTTP/1.0, or HTTP/1.1 with neither a length nor chunks)
    /// is heard to close by the browser, through the browser's proxy: the browser reads the whole answer and then the end,
    /// as it does with no proxy. Before, the site-to-page copy stopped at the site's end without passing it on, so the
    /// browser waited for the rest of an answer that had ended: the page never loaded and the next `Page.navigate` timed
    /// out (EU TARIC, UNB-208 step 8).
    #[test]
    fn a_site_that_ends_its_answer_by_closing_is_heard_to_close_by_the_browser() {
        let host = "close-delimited.invalid".to_string();
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = target.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut s, _) = target.accept().unwrap();
            s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            let mut req = [0u8; 256];
            let _ = s.read(&mut req);
            s.write_all(b"HTTP/1.0 200 OK\r\ncontent-type: text/html\r\n\r\n<html>the whole page</html>").unwrap();
            // The answer ends here: the site closes, and keeps the socket's other half open, as a server that
            // lingers for the client's close does.
            s.shutdown(std::net::Shutdown::Write).unwrap();
            std::thread::sleep(Duration::from_secs(15));
        });
        TARGETS.lock().unwrap().push((host.clone(), addr));
        let proxy = start(Carries::Browser, Some(std::sync::Arc::from("close-site"))).expect("the proxy starts");
        let mut s = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(&[5, 1, 0]).unwrap();
        let mut two = [0u8; 2];
        s.read_exact(&mut two).unwrap();
        let mut req = vec![5u8, 1, 0, 3, host.len() as u8];
        req.extend_from_slice(host.as_bytes());
        req.extend_from_slice(&80u16.to_be_bytes());
        s.write_all(&req).unwrap();
        let mut answer = [0u8; 10];
        s.read_exact(&mut answer).unwrap();
        assert_eq!(answer[1], 0, "the tunnel opens");
        s.write_all(b"GET / HTTP/1.0\r\nhost: close-delimited.invalid\r\n\r\n").unwrap();
        let mut page = Vec::new();
        let ended = s.read_to_end(&mut page);
        TARGETS.lock().unwrap().retain(|(h, _)| *h != host);
        assert!(ended.is_ok(), "the browser hears the site's close within 5 s, not a wait for more: {ended:?}, read {:?}", String::from_utf8_lossy(&page));
        assert!(String::from_utf8_lossy(&page).ends_with("<html>the whole page</html>"), "and the whole answer before it: {:?}", String::from_utf8_lossy(&page));
    }

    /// A SOCKS5 upstream that asks for a user and password, takes `user:pass` only, and answers each connect in turn
    /// with the status and address form in `replies`. It keeps the methods offered and each address asked.
    fn fake_upstream_with_login(user: &'static str, pass: &'static str, replies: Vec<(u8, u8)>) -> (u16, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let keep = seen.clone();
        std::thread::spawn(move || {
            let Ok((mut s, _)) = listener.accept() else { return };
            let mut head = [0u8; 2];
            s.read_exact(&mut head).unwrap();
            let mut methods = vec![0u8; head[1] as usize];
            s.read_exact(&mut methods).unwrap();
            keep.lock().unwrap().push(format!("methods {methods:?}"));
            s.write_all(&[5, 2]).unwrap();
            let mut n = [0u8; 2];
            s.read_exact(&mut n).unwrap();
            let mut u = vec![0u8; n[1] as usize];
            s.read_exact(&mut u).unwrap();
            let mut pl = [0u8; 1];
            s.read_exact(&mut pl).unwrap();
            let mut pw = vec![0u8; pl[0] as usize];
            s.read_exact(&mut pw).unwrap();
            if u != user.as_bytes() || pw != pass.as_bytes() {
                let _ = s.write_all(&[1, 1]);
                return;
            }
            s.write_all(&[1, 0]).unwrap();
            for (status, form) in replies {
                let mut req = [0u8; 4];
                if s.read_exact(&mut req).is_err() {
                    return;
                }
                let asked = if req[3] == 4 {
                    let mut a = [0u8; 16];
                    s.read_exact(&mut a).unwrap();
                    std::net::IpAddr::from(a).to_string()
                } else {
                    let mut a = [0u8; 4];
                    s.read_exact(&mut a).unwrap();
                    std::net::IpAddr::from(a).to_string()
                };
                let mut p = [0u8; 2];
                s.read_exact(&mut p).unwrap();
                keep.lock().unwrap().push(format!("{asked} {}", u16::from_be_bytes(p)));
                let mut reply = vec![5u8, status, 0, form];
                match form {
                    1 => reply.extend_from_slice(&[10, 0, 0, 1]),
                    4 => reply.extend_from_slice(&[0u8; 16]),
                    3 => {
                        reply.push(12);
                        reply.extend_from_slice(b"exit.example");
                    }
                    _ => {}
                }
                reply.extend_from_slice(&[0, 80]);
                s.write_all(&reply).unwrap();
            }
            let mut rest = [0u8; 1];
            let _ = s.read(&mut rest);
        });
        (port, seen)
    }

    fn chained(upstream: &str, addrs: &[SocketAddr]) -> bool {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(chain(upstream, addrs)).is_some()
    }

    /// A pinned site's upstream that asks for a login gets the user and password its URL names. Each address this
    /// proxy checked is asked in turn, IPv6 in its own form, until the upstream opens one, whatever address form its
    /// answer is written in.
    #[test]
    fn an_upstream_that_asks_for_a_login_gets_the_urls_and_each_checked_address_in_turn() {
        let v6: SocketAddr = "[2001:db8::7]:443".parse().unwrap();
        let v4: SocketAddr = "192.0.2.10:443".parse().unwrap();
        let (port, seen) = fake_upstream_with_login("exit-user", "s3cret", vec![(5, 4), (0, 3)]);
        assert!(chained(&format!("socks5://exit-user:s3cret@127.0.0.1:{port}"), &[v6, v4]), "the second address is open");
        assert_eq!(*seen.lock().unwrap(), ["methods [0, 2]", "2001:db8::7 443", "192.0.2.10 443"]);
    }

    /// A login the upstream refuses, an answer in no address form, or an upstream that speaks no SOCKS5 opens nothing.
    #[test]
    fn a_refused_login_an_unreadable_answer_or_another_scheme_opens_nothing() {
        let v4: SocketAddr = "192.0.2.10:443".parse().unwrap();
        let (port, _) = fake_upstream_with_login("exit-user", "s3cret", vec![(0, 1)]);
        assert!(!chained(&format!("socks5://exit-user:wrong@127.0.0.1:{port}"), &[v4]));
        let (port, seen) = fake_upstream_with_login("exit-user", "s3cret", vec![(0, 9)]);
        assert!(!chained(&format!("socks5h://exit-user:s3cret@127.0.0.1:{port}"), &[v4]), "an answer in no address form");
        assert_eq!(seen.lock().unwrap().len(), 2, "the address was asked");
        let (port, seen) = fake_upstream_with_login("exit-user", "s3cret", vec![]);
        assert!(!chained(&format!("http://exit-user:s3cret@127.0.0.1:{port}"), &[v4]), "only socks5 carries a pinned site");
        assert!(seen.lock().unwrap().is_empty(), "nothing was sent to it");
    }

    #[test]
    fn a_pinned_site_leaves_through_its_upstream() {
        let _setting = setting();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let upstream = fake_upstream(seen.clone());
        // An echo the tunnel is aimed at, on an address all its own so another test's pins never reach it.
        let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = echo.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in echo.incoming() {
                let Ok(mut s) = s else { continue };
                let mut b = [0u8; 4];
                let _ = s.read(&mut b);
                let _ = s.write_all(b"pong");
            }
        });
        pin_all(std::collections::BTreeMap::from([("127.0.0.1".to_string(), format!("socks5://127.0.0.1:{upstream}"))]));
        let proxy = start(Carries::Calls, None).expect("the proxy starts");
        assert!(connect_through(proxy, "127.0.0.1", at.port()), "the tunnel is open");
        assert_eq!(seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_slice(), [format!("{}:{}", at.ip(), at.port())]);
        pin_all(Default::default());
    }


    /// The browserless transport goes through the same local proxy when its site is pinned: a call leaves from the
    /// address the browser did, which is the whole point of the pin.
    #[test]
    fn a_pinned_calls_transport_leaves_through_the_same_upstream() {
        let _setting = setting();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let upstream = fake_upstream(seen.clone());
        // A page answering a fixed body.
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = server.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in server.incoming() {
                let Ok(mut s) = s else { continue };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
            }
        });
        pin_all(std::collections::BTreeMap::from([("127.0.0.1".to_string(), format!("socks5://127.0.0.1:{upstream}"))]));
        let proxy = crate::proxy::local_url().expect("the local proxy");
        let mut fetch = crate::replay::HttpFetch::held_to_proxy(crate::egress::Egress::Own, Some(&proxy)).expect("a transport");
        use crate::replay::Fetch as _;
        let req = crate::replay::Request { method: "GET".into(), url: format!("http://127.0.0.1:{}/x", at.port()).parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let ex = fetch.fetch(&req).expect("the call");
        assert_eq!(ex.status, 200);
        assert_eq!(ex.response_body.as_deref(), Some("ok"));
        assert!(!seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty(), "the call left through the upstream");
        pin_all(Default::default());
    }

    /// A public name the resolver answers with this machine's loopback is refused before anything is sent: that is the
    /// rebinding the gap was about. A place addressed plainly is a place, and goes there.
    #[test]
    fn a_public_name_pointed_inside_never_connects() {
        let _setting = setting();
        let inside = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        inside.set_nonblocking(true).unwrap();
        let at = inside.local_addr().unwrap();
        point("rebind.example.com", vec![at]);
        let proxy = start(Carries::Calls, None).expect("the proxy starts");

        assert!(!connect_through(proxy, "rebind.example.com", at.port()), "a public name answering loopback is refused");
        assert!(inside.accept().is_err(), "nothing reached the address inside");

        // A place addressed plainly goes where it says, so an intranet the owner browses still works.
        let local = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let local_at = local.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = local.accept() {
                let mut b = [0u8; 4];
                let _ = s.read(&mut b);
                let _ = s.write_all(b"pong");
            }
        });
        assert!(connect_through(proxy, "127.0.0.1", local_at.port()), "an address asked for plainly connects");

        // A port nothing listens on is a refusal the client is told about, not a hang.
        assert!(!connect_through(proxy, "127.0.0.1", 1), "a closed port fails the CONNECT");
    }

    /// A launch whose proxy won't start is refused, never run outside the rule: the start is tried a few times, a
    /// failure is not remembered (the next launch tries again), and a start that works is kept.
    #[test]
    fn a_browser_never_launches_without_the_egress_rule() {
        let held = Mutex::new(None);
        let tries = std::sync::atomic::AtomicU32::new(0);
        let failing = || {
            tries.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            None
        };
        let refused = up(&held, failing).and_then(switches_from);
        assert!(refused.is_err(), "no proxy, no switches, no launch: {refused:?}");
        assert_eq!(tries.load(std::sync::atomic::Ordering::Relaxed), START_TRIES, "tried before refusing");
        assert_eq!(*held.lock().unwrap(), None, "a failed start is not kept as an answer");
        assert_eq!(up(&held, || Some(4242)), Ok(4242), "the next launch tries again, and a start that works is kept");
        assert_eq!(up(&held, || None), Ok(4242));
        let flags = switches().expect("the real proxy starts");
        assert!(flags.iter().any(|f| f.starts_with("--proxy-server=socks5://127.0.0.1:")), "{flags:?}");
        assert!(flags.contains(&"--proxy-bypass-list=<-loopback>".to_string()), "{flags:?}");
        assert!(flags.contains(&"--disable-quic".to_string()), "{flags:?}");
        assert!(flags.iter().any(|f| f == "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"), "{flags:?}");
    }

    /// Whatever sent the browser there (an address typed, a redirect from a public page, a script's `location =`, a
    /// name rebound to loopback), the connection reaches the proxy as a CONNECT, and a CONNECT to this machine is
    /// refused on the address it would use, Reach private networks on or off. Nothing reaches the listener.
    #[test]
    fn a_redirect_or_script_never_takes_the_browser_to_this_machine() {
        let _setting = setting();
        let inside = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        inside.set_nonblocking(true).unwrap();
        let at = inside.local_addr().unwrap();
        point("rebound.example.com", vec![at]);
        point("plain-name-inside", vec![at]);
        let proxy = start(Carries::Browser, None).expect("the proxy starts");
        for on in [false, true] {
            crate::egress::allow_private(on);
            for host in ["127.0.0.1", "rebound.example.com", "plain-name-inside", "::ffff:127.0.0.1", "0.0.0.0"] {
                assert!(!connect_through(proxy, host, at.port()), "{host} (private networks {on}) is this machine");
            }
        }
        crate::egress::allow_private(false);
        assert!(inside.accept().is_err(), "nothing reached this machine's listener");
    }

    /// The browser reaches a public address; never a link-local one (where metadata services answer); and the owner's
    /// network only with Reach private networks on. An IPv6 form of an IPv4 address is judged as that address.
    #[test]
    fn the_browser_reaches_the_owners_network_only_with_their_setting() {
        let _setting = setting();
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        for on in [false, true] {
            crate::egress::allow_private(on);
            for never in ["169.254.169.254", "::ffff:169.254.169.254", "fe80::1", "::1", "127.8.0.1", "0.1.2.3"] {
                assert!(browser_may_reach(ip(never)).is_err(), "{never} (private networks {on})");
            }
            // The same addresses wrapped in IPv6 (compatible, NAT64, 6to4, Teredo) are judged as what they carry.
            for wrapped in ["::7f00:1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "2001:0:4136:e378:8000:63bf:80ff:fffe"] {
                assert!(browser_may_reach(ip(wrapped)).is_err(), "{wrapped} (private networks {on})");
            }
            // An address this machine's own interfaces hold is this machine, private or public.
            for own in if_addrs::get_if_addrs().unwrap_or_default() {
                assert!(browser_may_reach(own.ip()).is_err(), "{} is this machine (private networks {on})", own.ip());
            }
            for public in ["93.184.216.34", "2606:2800:220:1::1", "::ffff:93.184.216.34", "64:ff9b::5db8:d822"] {
                assert!(browser_may_reach(ip(public)).is_ok(), "{public}");
            }
            // A unique-local or shared address can't be told from the owner's own network by address alone: a cloud's
            // IPv6 metadata address there (fd00:ec2::254) goes with the setting, like any intranet address.
            for private in ["10.0.0.1", "192.168.1.1", "172.16.0.5", "fd00::1", "::ffff:10.0.0.1", "fd00:ec2::254", "100.100.100.200", "64:ff9b::a00:1"] {
                assert_eq!(browser_may_reach(ip(private)).is_ok(), on, "{private} (private networks {on})");
            }
        }
        crate::egress::allow_private(false);
    }

    /// An echo on an address of its own: whatever four bytes it is sent, it answers `pong`.
    fn pong_site() -> std::net::SocketAddr {
        let echo = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = echo.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in echo.incoming() {
                let Ok(mut s) = s else { continue };
                let mut b = [0u8; 4];
                if s.read_exact(&mut b).is_ok() {
                    let _ = s.write_all(b"pong");
                }
            }
        });
        at
    }

    /// Opens a SOCKS5 CONNECT with the address bytes the caller gives (`kind` 1, 3 or 4), reads the 10-byte answer, and
    /// then says `ping` and returns what comes back: `None` where the proxy refused.
    fn ask_and_ping(proxy: u16, kind: u8, address: &[u8], port: u16) -> Option<Vec<u8>> {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(&[5, 1, 0]).unwrap();
        let mut two = [0u8; 2];
        s.read_exact(&mut two).unwrap();
        let mut req = vec![5u8, 1, 0, kind];
        req.extend_from_slice(address);
        req.extend_from_slice(&port.to_be_bytes());
        s.write_all(&req).unwrap();
        let mut answer = [0u8; 10];
        s.read_exact(&mut answer).ok()?;
        if answer[1] != 0 { return None; }
        s.write_all(b"ping").unwrap();
        let mut back = Vec::new();
        let _ = s.take(4).read_to_end(&mut back);
        Some(back)
    }

    /// A tunnel carries bytes both ways, for a call and for a browser: what the client sends reaches the site and what
    /// the site answers comes back, plainly addressed and through a pinned site's upstream.
    #[test]
    fn a_tunnel_carries_bytes_both_ways() {
        let _setting = setting();
        let at = pong_site();
        let proxy = start(Carries::Calls, None).expect("the proxy starts");
        assert_eq!(ask_and_ping(proxy, 1, &[127, 0, 0, 1], at.port()).as_deref(), Some(&b"pong"[..]), "a call's tunnel");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let upstream = fake_upstream(seen.clone());
        pin_all(std::collections::BTreeMap::from([("127.0.0.1".to_string(), format!("socks5://127.0.0.1:{upstream}"))]));
        let through = ask_and_ping(proxy, 1, &[127, 0, 0, 1], at.port());
        pin_all(Default::default());
        assert_eq!(through.as_deref(), Some(&b"pong"[..]), "a pinned site's tunnel");
        assert!(!seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty(), "it went through the upstream");
    }

    /// A pinned site whose upstream doesn't carry it is refused, and the client is told so: nothing leaves by the
    /// address the owner didn't pin, and the client doesn't wait.
    #[test]
    fn a_pinned_site_whose_upstream_is_down_is_refused() {
        let _setting = setting();
        let at = pong_site();
        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        pin_all(std::collections::BTreeMap::from([("127.0.0.1".to_string(), format!("socks5://127.0.0.1:{closed}"))]));
        let proxy = start(Carries::Calls, None).expect("the proxy starts");
        let carried = connect_through(proxy, "127.0.0.1", at.port());
        pin_all(Default::default());
        assert!(!carried, "the upstream didn't carry it, so nothing was");
    }

    /// A client that offers no way of greeting this proxy accepts (only a login) is told no method fits, and is not
    /// carried anywhere.
    #[test]
    fn a_client_that_offers_only_a_login_is_told_no_method_fits() {
        let proxy = start(Carries::Calls, None).expect("the proxy starts");
        let mut s = std::net::TcpStream::connect(("127.0.0.1", proxy)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(&[5, 1, 2]).unwrap();
        let mut two = [0u8; 2];
        s.read_exact(&mut two).unwrap();
        assert_eq!(two, [5, 0xFF]);
    }

    /// A browser that asks for an address in its IPv6 form is read whole: the proxy names the address as the sixteen
    /// bytes it was given, and carries the connection to the target that name stands for.
    #[test]
    fn an_address_asked_for_in_its_ipv6_form_is_read_whole() {
        let at = pong_site();
        let host = "2001:db8::7";
        TARGETS.lock().unwrap().push((host.to_string(), at));
        let proxy = start(Carries::Browser, None).expect("the proxy starts");
        let address = "2001:db8::7".parse::<std::net::Ipv6Addr>().unwrap().octets();
        let back = ask_and_ping(proxy, 4, &address, 443);
        TARGETS.lock().unwrap().retain(|(h, _)| h != host);
        assert_eq!(back.as_deref(), Some(&b"pong"[..]));
    }

    /// A write the site doesn't take ends the copy with that error, rather than going on reading what the page sends.
    #[test]
    fn a_copy_ends_when_the_site_takes_no_more() {
        use tokio::io::AsyncWriteExt;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (mut page, mut page_end) = tokio::io::duplex(1024);
            let (mut site_end, site) = tokio::io::duplex(1024);
            drop(site);
            page.write_all(b"data").await.unwrap();
            let ended = tokio::time::timeout(Duration::from_secs(5), forward(&mut page_end, &mut site_end, None, "gone.invalid", 0)).await.expect("the copy ended, not waited on the page");
            assert!(ended.is_err(), "{ended:?}");
        });
    }
}

#[cfg(test)]
#[path = "proxy_cov_tests.rs"]
mod proxy_cov_tests;
