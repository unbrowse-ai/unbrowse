//! Where the node's own calls may land. A name the public DNS answers for (one under a listed public suffix) is a
//! place on the internet, and a call to it is a call to the internet: if it resolves to a loopback, private or
//! link-local address, the name has been pointed inside the owner's network, by a rebinding attacker or a poisoned
//! answer, and the call is refused. A call addressed plainly to a private place (an IP literal, `localhost`, a name
//! no public suffix lists) says where it goes, and goes there.
//!
//! An owner whose company gives public names private addresses (split-horizon DNS for an intranet) turns this off in
//! Settings ("Reach private networks"), and the app tells this module with [`allow_private`].
//!
//! The check sits in the resolver, so the addresses checked are the addresses the client connects to: there is no
//! second lookup for an answer to change between.
//!
//! All of that is for the node's own routes, which its own walks made. A route this node didn't learn itself (a body
//! another contributor listed) is someone else's code, and every request it makes is held to more, whatever the
//! owner's setting ([`Egress::Foreign`]): it goes over HTTPS, and only to an address on the public internet, every hop
//! of it, checked against the address resolved for the connection. Which rule a call runs under is the caller's to
//! say, call by call: it is a property of the route, never of the process.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};

pub use agent_browser_core::intercept::is_public_ip;

/// The most an answer to someone else's route may be, and how long one request of it may take, connection to last
/// byte. A route made from another contributor's body points the node at a host the body chose: without a bound, one
/// that answers forever, or endlessly, holds the call and the node's memory. A route the node learned itself answers
/// as its site does, unbounded as before.
pub const FOREIGN_ANSWER_MAX: usize = 8 << 20;
pub const FOREIGN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

impl Egress {
    /// The bound on one answer's size under this rule, if any.
    pub fn answer_max(self) -> Option<usize> {
        match self {
            Egress::Foreign => Some(FOREIGN_ANSWER_MAX),
            _ => None,
        }
    }

    /// The bound on one request's time under this rule, if any.
    pub fn timeout(self) -> Option<std::time::Duration> {
        match self {
            Egress::Foreign => Some(FOREIGN_TIMEOUT),
            _ => None,
        }
    }
}

/// Reads an answer's body up to `max` bytes; more is refused, never kept.
pub fn read_capped(mut body: impl std::io::Read, max: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut out = Vec::new();
    (&mut body).take(max as u64 + 1).read_to_end(&mut out).map_err(|e| e.to_string())?;
    if out.len() > max {
        return Err(format!("the answer is larger than {max} bytes: someone else's route gets no more than that"));
    }
    Ok(out)
}

/// The same for an answer that arrives in chunks.
pub async fn read_stream_capped<S, B, E>(mut body: S, max: usize) -> Result<Vec<u8>, String>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    use futures_util::StreamExt;
    let mut out = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if out.len() + chunk.as_ref().len() > max {
            return Err(format!("the answer is larger than {max} bytes: someone else's route gets no more than that"));
        }
        out.extend_from_slice(chunk.as_ref());
    }
    Ok(out)
}

/// Whose rule a call runs under: whose route it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Egress {
    /// A route this node learned itself, from its own walk: a public name never leads inside the owner's network,
    /// unless the owner has turned on Reach private networks; a place addressed plainly goes where it says.
    #[default]
    Own,
    /// A route this node didn't learn itself. Every request, every redirect hop and every setup step goes over HTTPS
    /// to a public internet address, and the owner's setting never applies.
    Foreign,
}

impl Egress {
    /// Whether a request to `url` may be made at all, before anything is sent: its scheme, and where it says it goes.
    /// A name is checked again when it resolves ([`Egress::check`]).
    pub fn request(self, url: &url::Url) -> Result<(), String> {
        if self == Egress::Own {
            return Ok(());
        }
        // A user name or password in the address is sent as the request's credentials (Basic authentication) by the
        // transport, whatever the route's fields say: someone else's route never carries one, in any request or
        // redirect hop. The reason never repeats the address, which holds them.
        if !url.username().is_empty() || url.password().is_some() {
            return Err(format!(
                "an address on {} carries a user name or password: a route this node didn't learn itself never sends credentials in its address",
                url.host_str().unwrap_or_default()
            ));
        }
        if url.scheme() != "https" {
            return Err(format!(
                "{url} isn't HTTPS: a route this node didn't learn itself is someone else's, and it goes over HTTPS only"
            ));
        }
        match url.host() {
            Some(url::Host::Ipv4(ip)) => public_address(&ip.to_string(), IpAddr::V4(ip)),
            Some(url::Host::Ipv6(ip)) => public_address(&format!("[{ip}]"), IpAddr::V6(ip)),
            Some(url::Host::Domain(d)) if public_name(d) => Ok(()),
            Some(url::Host::Domain(d)) => Err(format!(
                "{d} is a name no public suffix lists, one only this network knows: a route this node didn't learn itself goes only to public internet addresses"
            )),
            None => Err(format!("{url} names no host")),
        }
    }

    /// Whether a step's URL template may be run, as far as it says before any value is filled in: a scheme or a host
    /// built at call time is checked as the concrete request ([`Egress::request`]).
    pub fn template(self, template: &str) -> Result<(), String> {
        if self == Egress::Own {
            return Ok(());
        }
        let Some((scheme, rest)) = template.split_once("://") else {
            return Err(format!("{template} isn't a web address"));
        };
        if scheme.contains(['{', '}']) {
            return Ok(());
        }
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.contains(['{', '}']) {
            if scheme != "https" {
                return Err(format!(
                    "{template} isn't HTTPS: a route this node didn't learn itself is someone else's, and it goes over HTTPS only"
                ));
            }
            return Ok(());
        }
        let url = url::Url::parse(&format!("{scheme}://{authority}/")).map_err(|e| format!("{template}: {e}"))?;
        self.request(&url)
    }

    /// Refuses an answer for `host` that isn't where this rule lets a call go.
    pub fn check(self, host: &str, addrs: &[SocketAddr]) -> Result<(), String> {
        match self {
            Egress::Own => check(host, addrs),
            Egress::Foreign => match addrs.iter().find(|a| !is_public_ip(a.ip())) {
                Some(a) => Err(format!(
                    "{host} resolved to {}, which isn't a public internet address: a route this node didn't learn itself goes only to public addresses, whatever Settings say",
                    a.ip()
                )),
                None => Ok(()),
            },
        }
    }

    /// Whether a redirect may take a call from `from` to `to`.
    pub fn hop(self, from: &str, to: &url::Url) -> Result<(), String> {
        match self {
            Egress::Own if !hop_allowed(from, to.host_str().unwrap_or_default()) => Err(format!(
                "{from} redirected to {}, inside this network: the node doesn't follow a public name in",
                to.host_str().unwrap_or_default()
            )),
            Egress::Own => Ok(()),
            Egress::Foreign => self.request(to).map_err(|e| format!("{from} redirected the call: {e}")),
        }
    }
}

/// A connection the call's rule refused, as the resolver says it: a transport finds it in a failed request's causes
/// and knows nothing was sent.
#[derive(Debug)]
pub struct Refusal(pub String);

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Refusal {}

/// The refusal among an error's causes, if the call's rule refused it.
pub fn refusal_in(e: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut at = Some(e);
    while let Some(c) = at {
        if let Some(r) = c.downcast_ref::<Refusal>() {
            return Some(r.0.clone());
        }
        at = c.source();
    }
    None
}

/// An address a route this node didn't learn itself may be sent to: a public one.
fn public_address(host: &str, ip: IpAddr) -> Result<(), String> {
    match is_public_ip(ip) {
        true => Ok(()),
        false => Err(format!(
            "{host} isn't a public internet address: a route this node didn't learn itself goes only to public addresses, whatever Settings say"
        )),
    }
}

static ALLOW_PRIVATE: AtomicBool = AtomicBool::new(false);

/// Whether a public name may resolve to a private address: the owner's setting, set by the app.
pub fn allow_private(on: bool) {
    ALLOW_PRIVATE.store(on, Ordering::Relaxed);
}

/// Whether the owner has let public names resolve to private addresses (Settings, "Reach private networks"): then the
/// node's own rule, which the browser's local proxy resolves under, is weaker than a route this node didn't learn may be
/// held to.
pub fn private_allowed() -> bool {
    ALLOW_PRIVATE.load(Ordering::Relaxed)
}

/// Whether `host` is a name the public DNS answers for: under a public suffix the list knows, and not the suffix
/// itself. An IP literal is not a name.
pub fn public_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok() || host.starts_with('[') {
        return false;
    }
    match psl::suffix(host.as_bytes()) {
        Some(s) if s.is_known() => s.as_bytes().len() < host.len(),
        _ => false,
    }
}

/// Refuses an answer that points a public name inside the owner's network.
pub fn check(host: &str, addrs: &[SocketAddr]) -> Result<(), String> {
    if ALLOW_PRIVATE.load(Ordering::Relaxed) || !public_name(host) {
        return Ok(());
    }
    match addrs.iter().find(|a| !is_public_ip(a.ip())) {
        Some(a) => Err(format!(
            "{host} is a public name that resolved to {}, inside this network: the node doesn't follow a public name in. \
             If {host} is your own network's, turn on Reach private networks in Settings",
            a.ip()
        )),
        None => Ok(()),
    }
}

/// Whether `host` is a place on the internet: a public name, or an IP literal whose address is public.
pub fn on_the_internet(host: &str) -> bool {
    match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(ip) => is_public_ip(ip),
        Err(_) => public_name(host),
    }
}

/// Whether a redirect may take a call from `from` to `to`. A call that began on the internet (at a public name, or
/// at a public address) is a call to the internet, and a site's redirect can't turn it into one inside the owner's
/// network: a hop to an address that isn't public, or to a name no public suffix lists (`localhost`, `printer.lan`),
/// is refused. A hop to a public name is let through and checked again when that name resolves. A call addressed
/// plainly to a private place may redirect anywhere, and so may every call when the owner has turned on Reach
/// private networks.
pub fn hop_allowed(from: &str, to: &str) -> bool {
    if ALLOW_PRIVATE.load(Ordering::Relaxed) || !on_the_internet(from) {
        return true;
    }
    on_the_internet(to)
}

/// Redirects a call follows: a browser's limit, and none that leads a call that began on the internet inside.
pub(crate) const MAX_REDIRECTS: usize = 10;

/// The redirect rule for the node's other clients. (The Chrome-shaped client follows its redirects hop by hop,
/// `http::next_hop`, under the same rule.)
pub fn reqwest_redirects() -> reqwest::redirect::Policy {
    reqwest_redirects_for(Egress::Own)
}

/// The same, under `egress`.
pub fn reqwest_redirects_for(egress: Egress) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |a| {
        let from = a.previous().first().and_then(|u| u.host_str()).unwrap_or_default().to_string();
        if a.previous().len() >= MAX_REDIRECTS {
            return a.error("too many redirects");
        }
        match egress.hop(&from, a.url()) {
            Ok(()) => a.follow(),
            Err(e) => a.error(e),
        }
    })
}

async fn resolve(host: String, egress: Egress) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(test)]
    if let Some(addrs) = tests::answer(&host) {
        egress.check(&host, &addrs).map_err(Refusal)?;
        return Ok(addrs);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
    egress.check(&host, &addrs).map_err(Refusal)?;
    Ok(addrs)
}

/// The addresses `host` resolves to for a connection to `port`, with [`check`] on the answer: for a transport that
/// connects by itself (a socket) rather than through one of the guarded clients.
pub async fn lookup(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    #[cfg(test)]
    if let Some(addrs) = tests::answer(bare) {
        let addrs: Vec<SocketAddr> = addrs.into_iter().map(|a| SocketAddr::new(a.ip(), port)).collect();
        check(host, &addrs)?;
        return Ok(addrs);
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port)).await.map_err(|e| format!("{host}: {e}"))?.collect();
    check(host, &addrs)?;
    Ok(addrs)
}

/// The system resolver, with the call's rule ([`Egress::check`]) on every answer.
#[derive(Clone, Copy, Default)]
pub struct Resolver(pub Egress);

impl reqwest::dns::Resolve for Resolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let (host, egress) = (name.as_str().to_string(), self.0);
        Box::pin(async move { resolve(host, egress).await.map(|a| Box::new(a.into_iter()) as reqwest::dns::Addrs) })
    }
}

impl wreq::dns::Resolve for Resolver {
    fn resolve(&self, name: wreq::dns::Name) -> wreq::dns::Resolving {
        let (host, egress) = (name.as_str().to_string(), self.0);
        Box::pin(async move { resolve(host, egress).await.map(|a| Box::new(a.into_iter()) as wreq::dns::Addrs) })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// An address's user name and password are sent as the request's credentials by the transport, so someone else's
    /// route never carries one: its request, a redirect hop and its step templates are refused, and the reason doesn't
    /// repeat them. The node's own route is as it was.
    #[test]
    fn someone_elses_route_never_sends_credentials_in_its_address() {
        for with in ["https://alice:s3cret@bank.example.com/pay", "https://alice@bank.example.com/pay", "https://:s3cret@bank.example.com/pay"] {
            let url = url::Url::parse(with).unwrap();
            let e = Egress::Foreign.request(&url).unwrap_err();
            assert!(e.contains("user name or password") && !e.contains("s3cret") && !e.contains("alice"), "{e}");
            assert!(Egress::Foreign.hop("bank.example.com", &url).is_err(), "a redirect hop to it");
            assert!(Egress::Foreign.template(with).is_err(), "a step template naming it");
            assert!(Egress::Own.request(&url).is_ok());
        }
        assert!(Egress::Foreign.request(&url::Url::parse("https://bank.example.com/pay").unwrap()).is_ok());
    }

    /// Someone else's route waits a bounded time and takes an answer of bounded size; the node's own route is
    /// unbounded as before. An answer past the bound is refused, whether it arrives whole or in chunks, and one at the
    /// bound is kept whole.
    #[test]
    fn someone_elses_route_gets_a_bounded_answer_in_bounded_time() {
        assert_eq!(Egress::Foreign.answer_max(), Some(FOREIGN_ANSWER_MAX));
        assert_eq!(Egress::Foreign.timeout(), Some(FOREIGN_TIMEOUT));
        assert_eq!((Egress::Own.answer_max(), Egress::Own.timeout()), (None, None));
        let endless = std::io::repeat(b'x');
        assert!(read_capped(endless, 1024).unwrap_err().contains("larger than 1024"), "an endless answer is cut off");
        assert_eq!(read_capped(&[b'y'; 1024][..], 1024).unwrap().len(), 1024);
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let chunks = |n: usize| futures_util::stream::iter((0..n).map(|_| Ok::<_, std::io::Error>(vec![b'z'; 256])));
        assert!(rt.block_on(read_stream_capped(chunks(5), 1024)).unwrap_err().contains("larger than 1024"));
        assert_eq!(rt.block_on(read_stream_capped(chunks(4), 1024)).unwrap().len(), 1024);
    }

    /// Names a test answers for itself, as a resolver pointed somewhere would: no DNS is asked for them.
    static ANSWERS: std::sync::Mutex<Vec<(String, Vec<SocketAddr>)>> = std::sync::Mutex::new(Vec::new());

    pub(crate) fn answer(host: &str) -> Option<Vec<SocketAddr>> {
        ANSWERS.lock().unwrap().iter().find(|(h, _)| h.eq_ignore_ascii_case(host)).map(|(_, a)| a.clone())
    }

    /// Points `host` at `addrs` for the rest of the test process.
    pub(crate) fn point(host: &str, addrs: Vec<SocketAddr>) {
        ANSWERS.lock().unwrap().push((host.to_string(), addrs));
    }

    /// Held by a test that sets the owner's Reach private networks, or that counts on it being off: the setting is the
    /// process's, and tests run at once.
    pub(crate) fn setting() -> std::sync::MutexGuard<'static, ()> {
        static SETTING: std::sync::Mutex<()> = std::sync::Mutex::new(());
        SETTING.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn at(ip: &str) -> Vec<SocketAddr> {
        vec![SocketAddr::new(ip.parse().unwrap(), 443)]
    }

    #[test]
    fn a_public_name_is_one_under_a_listed_suffix() {
        assert!(public_name("shop.example.com"));
        assert!(public_name("a.b.co.uk"));
        assert!(!public_name("co.uk"), "a suffix itself names no one");
        assert!(!public_name("localhost"));
        assert!(!public_name("printer.lan"), "a suffix no list knows is a local name");
        assert!(!public_name("10.0.0.1"));
        assert!(!public_name("::1"));
    }

    /// A public name that answers with an address inside the network is refused; the same address asked for plainly
    /// is not, and the owner's setting lets the name in.
    #[test]
    fn a_public_name_never_leads_inside_the_network() {
        let _setting = setting();
        assert!(check("rebind.example.com", &at("127.0.0.1")).is_err());
        assert!(check("rebind.example.com", &at("192.168.1.1")).is_err());
        assert!(check("rebind.example.com", &at("169.254.169.254")).is_err(), "the cloud metadata address");
        assert!(check("rebind.example.com", &at("::1")).is_err());
        assert!(check("rebind.example.com", &[at("93.184.215.14")[0], at("10.0.0.5")[0]]).is_err(), "one inside is enough");
        assert!(check("shop.example.com", &at("93.184.215.14")).is_ok());
        assert!(check("localhost", &at("127.0.0.1")).is_ok());
        assert!(check("127.0.0.1", &at("127.0.0.1")).is_ok());
        allow_private(true);
        let allowed = check("intranet.example.com", &at("10.0.0.5")).is_ok();
        allow_private(false);
        assert!(allowed);
    }

    /// A redirect can't take a call that began on the internet inside the network, by address or by local name;
    /// a call that began inside goes where it is sent.
    #[test]
    fn a_redirect_never_leads_a_public_call_inside() {
        let _setting = setting();
        for inside in ["169.254.169.254", "127.0.0.1", "10.0.0.5", "[::1]", "::ffff:127.0.0.1", "localhost", "printer.lan"] {
            assert!(!hop_allowed("shop.example.com", inside), "{inside}");
        }
        assert!(hop_allowed("shop.example.com", "93.184.215.14"));
        assert!(hop_allowed("shop.example.com", "login.example.org"), "a public name is checked when it resolves");
        assert!(hop_allowed("localhost", "127.0.0.1"));
        assert!(hop_allowed("10.0.0.5", "printer.lan"));
        allow_private(true);
        let allowed = hop_allowed("intranet.example.com", "10.0.0.5");
        allow_private(false);
        assert!(allowed);
    }

    /// A call addressed to a public address is a call to the internet as much as one to a public name: a redirect
    /// can't take it inside either.
    #[test]
    fn a_redirect_never_leads_a_call_to_a_public_address_inside() {
        let _setting = setting();
        for inside in ["127.0.0.1", "169.254.169.254", "10.0.0.5", "[::1]", "localhost"] {
            assert!(!hop_allowed("93.184.215.14", inside), "{inside}");
            assert!(!hop_allowed("[2606:2800:220:1:248:1893:25c8:1946]", inside), "{inside}");
        }
        assert!(hop_allowed("93.184.215.14", "shop.example.com"));
        assert!(hop_allowed("93.184.215.14", "93.184.215.15"));
        assert!(hop_allowed("192.168.1.1", "127.0.0.1"), "a call that began inside goes where it is sent");
    }

    /// A transport that connects by itself looks its host up through the same check.
    #[test]
    fn a_lookup_lets_a_plainly_addressed_place_through() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(lookup("127.0.0.1", 9)).is_ok(), "an address asked for plainly");
        assert!(rt.block_on(lookup("localhost", 9)).is_ok(), "a local name");
    }

    /// The node's client, sent to a public name that answers with a redirect to the owner's loopback, refuses the
    /// hop. The name is pinned to a local server, so this needs no DNS.
    #[test]
    fn the_node_s_client_refuses_a_redirect_inside() {
        let _setting = setting();
        use std::io::{Read, Write};
        let inside = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let (to, at) = (inside.local_addr().unwrap().port(), site.local_addr().unwrap());
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = site.accept() {
                let _ = s.read(&mut [0u8; 1024]);
                let _ = write!(s, "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:{to}/\r\ncontent-length: 0\r\n\r\n");
            }
        });
        let client = crate::tls::blocking().resolve("shop.example.com", at).build().unwrap();
        let err = client.get(format!("http://shop.example.com:{}/", at.port())).send().unwrap_err();
        assert!(format!("{err:?}").contains("inside this network"), "{err:?}");
    }

    /// Both transports, against a public name whose DNS answers 127.0.0.1. Needs DNS, so it runs on request.
    #[test]
    #[ignore = "needs DNS"]
    fn the_node_s_clients_refuse_a_name_pointed_inside() {
        let err = crate::tls::blocking().build().unwrap().get("http://localtest.me:9/").send().unwrap_err();
        assert!(format!("{err:?}").contains("inside this network"), "{err:?}");
        let mut chrome = crate::http::ChromeFetch::new().unwrap();
        let req = crate::replay::Request { method: "GET".into(), url: "http://localtest.me:9/".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let err = crate::replay::Fetch::fetch(&mut chrome, &req).unwrap_err();
        assert!(format!("{err:?}").contains("inside this network"), "{err:?}");
    }

    const INSIDE: [&str; 17] = [
        "127.0.0.1",
        "10.0.0.5",
        "172.16.0.1",
        "192.168.1.1",
        "100.64.0.1",
        "169.254.169.254",
        "0.0.0.0",
        "224.0.0.1",
        "[::1]",
        "[::]",
        "[fe80::1]",
        "[fc00::1]",
        "[ff02::1]",
        "[::ffff:127.0.0.1]",
        "[::ffff:10.0.0.5]",
        "localhost",
        "printer.lan",
    ];

    /// A route this node didn't learn itself goes over HTTPS only: plain HTTP, and every other scheme, is refused
    /// before anything is sent, and the refusal says the rule. The node's own route keeps going where it says.
    #[test]
    fn someone_elses_route_goes_over_https_only() {
        let url = |u: &str| url::Url::parse(u).unwrap();
        for plain in ["http://shop.example.com/api", "ws://shop.example.com/", "ftp://shop.example.com/"] {
            let e = Egress::Foreign.request(&url(plain)).unwrap_err();
            assert!(e.contains("HTTPS only"), "{plain}: {e}");
            assert!(Egress::Own.request(&url(plain)).is_ok(), "{plain}");
        }
        assert!(Egress::Foreign.request(&url("https://shop.example.com/api?q=1")).is_ok());
        assert!(Egress::Foreign.template("http://shop.example.com/api?q={q}").unwrap_err().contains("HTTPS only"));
        assert!(Egress::Foreign.template("http://{host}/api").unwrap_err().contains("HTTPS only"), "a built host keeps its scheme");
        assert!(Egress::Foreign.template("https://shop.example.com/api?q={q}").is_ok());
        assert!(Egress::Foreign.template("{scheme}://shop.example.com/").is_ok(), "a built scheme is checked as the request");
    }

    /// A route this node didn't learn itself goes only to the public internet: loopback, private, CGNAT, link-local
    /// (the cloud metadata address among them), unspecified, multicast, unique-local and IPv4-mapped addresses, and
    /// names only this network knows, are refused as written, whatever the owner's setting says.
    #[test]
    fn someone_elses_route_never_goes_to_a_private_address() {
        let _setting = setting();
        allow_private(true);
        let refused: Vec<(String, Result<(), String>, Result<(), String>)> = INSIDE
            .iter()
            .map(|h| {
                let u = url::Url::parse(&format!("https://{h}/latest")).unwrap();
                (h.to_string(), Egress::Foreign.request(&u), Egress::Foreign.template(&format!("https://{h}/x?q={{q}}")))
            })
            .collect();
        allow_private(false);
        for (h, request, template) in refused {
            let e = request.unwrap_err();
            assert!(e.contains("public internet addresses") || e.contains("public addresses"), "{h}: {e}");
            assert!(template.is_err(), "{h}");
        }
        assert!(Egress::Foreign.request(&url::Url::parse("https://93.184.215.14/").unwrap()).is_ok());
        assert!(Egress::Foreign.request(&url::Url::parse("https://[2606:2800:220:1:248:1893:25c8:1946]/").unwrap()).is_ok());
        // An address written as a number is the address it names.
        assert!(Egress::Foreign.request(&url::Url::parse("https://2130706433/").unwrap()).is_err());
    }

    /// A public name whose answer points inside is refused for a route this node didn't learn itself, even when the
    /// owner has turned on Reach private networks, which still lets the node's own routes in.
    #[test]
    fn someone_elses_route_never_follows_a_name_inside_whatever_settings_say() {
        let _setting = setting();
        allow_private(true);
        let foreign: Vec<bool> = ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1", "::ffff:192.168.1.1", "fd00::1"]
            .iter()
            .map(|ip| Egress::Foreign.check("rebind.example.com", &at(ip)).is_err())
            .collect();
        let own = Egress::Own.check("intranet.example.com", &at("10.0.0.5"));
        let one_inside = Egress::Foreign.check("rebind.example.com", &[at("93.184.215.14")[0], at("10.0.0.5")[0]]);
        allow_private(false);
        assert!(foreign.iter().all(|r| *r), "{foreign:?}");
        assert!(own.is_ok(), "the owner's setting still serves their own routes");
        assert!(one_inside.is_err(), "one answer inside is enough");
        assert!(Egress::Foreign.check("shop.example.com", &at("93.184.215.14")).is_ok());
    }

    /// No redirect takes a route this node didn't learn itself off HTTPS or off the public internet.
    #[test]
    fn someone_elses_route_never_follows_a_redirect_inside_or_off_https() {
        let to = |u: &str| url::Url::parse(u).unwrap();
        for hop in ["http://shop.example.com/", "https://127.0.0.1/", "https://169.254.169.254/latest", "https://[::ffff:10.0.0.5]/", "https://printer.lan/"] {
            assert!(Egress::Foreign.hop("shop.example.com", &to(hop)).is_err(), "{hop}");
        }
        assert!(Egress::Foreign.hop("shop.example.com", &to("https://login.example.org/")).is_ok());
    }

    /// Over the wire, both transports: a public name the resolver answers with this machine's loopback, asked for by a
    /// route this node didn't learn itself, is refused at connect time, and the listener there hears nothing. The
    /// answer is the test's own resolver's, so this needs no DNS.
    #[test]
    fn the_transports_refuse_someone_elses_route_a_name_pointed_inside() {
        let inside = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = inside.local_addr().unwrap();
        inside.set_nonblocking(true).unwrap();
        point("rebound.example.com", vec![at]);
        let url = format!("https://rebound.example.com:{}/api", at.port());
        let req = crate::replay::Request { method: "GET".into(), url: url.parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let mut chrome = crate::http::ChromeFetch::held_to(Egress::Foreign).unwrap();
        let err = crate::replay::Fetch::fetch(&mut chrome, &req).unwrap_err();
        assert!(matches!(err, crate::replay::ReplayError::Refused(_)) && err.to_string().contains("isn't a public internet address"), "{err}");
        let mut plain = crate::replay::HttpFetch::held_to(Egress::Foreign).unwrap();
        let err = crate::replay::Fetch::fetch(&mut plain, &req).unwrap_err();
        assert!(matches!(err, crate::replay::ReplayError::Refused(_)) && err.to_string().contains("isn't a public internet address"), "{err:?}");
        assert!(inside.accept().is_err(), "nothing reached the address inside");
    }

    /// The node's own route, with Reach private networks on, still reaches a private host by a public name: the
    /// owner's intranet.
    #[test]
    fn the_owners_own_route_still_reaches_their_intranet() {
        use std::io::{Read, Write};
        let _setting = setting();
        let site = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let at = site.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = site.accept() {
                let _ = s.read(&mut [0u8; 1024]);
                let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{{}}");
            }
        });
        point("intranet.example.com", vec![at]);
        let req = crate::replay::Request {
            method: "GET".into(),
            url: format!("http://intranet.example.com:{}/api", at.port()).parse().unwrap(),
            exchange: 0,
            headers: vec![],
            body: None,
        };
        allow_private(true);
        let got = crate::http::ChromeFetch::held_to(Egress::Own).and_then(|mut c| crate::replay::Fetch::fetch(&mut c, &req));
        allow_private(false);
        assert_eq!(got.unwrap().status, 200);
    }

    /// A route this node didn't learn itself, to a public HTTPS host, runs: both transports reach it and get its page.
    /// Needs the internet, so it runs on request.
    #[test]
    #[ignore = "needs the internet"]
    fn someone_elses_route_reaches_a_public_https_host() {
        let req = crate::replay::Request { method: "GET".into(), url: "https://example.com/".parse().unwrap(), exchange: 0, headers: vec![], body: None };
        let mut chrome = crate::http::ChromeFetch::held_to(Egress::Foreign).unwrap();
        assert_eq!(crate::replay::Fetch::fetch(&mut chrome, &req).unwrap().status, 200);
        let mut plain = crate::replay::HttpFetch::held_to(Egress::Foreign).unwrap();
        assert_eq!(crate::replay::Fetch::fetch(&mut plain, &req).unwrap().status, 200);
    }
}
