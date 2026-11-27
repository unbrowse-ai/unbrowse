//! Fetch-interception proxy: every browser request is DNS-checked, pinned to a
//! public address, and fulfilled from Rust. The browser never makes a direct
//! outbound connection.

use std::io::Write as _;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use url::Url;

use crate::cdp::client::CdpClient;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUESTS: usize = 1000;
const MAX_TRANSFER_BYTES: usize = 256 * 1024 * 1024;
const MAX_BODY_BYTES: u64 = 64 * 1024 * 1024;
const CONCURRENCY: usize = 6;

#[derive(Debug, thiserror::Error)]
pub enum InterceptError {
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
    #[error("target resolves to a non-public address")]
    NonPublicAddress,
    #[error("DNS lookup failed: {0}")]
    Dns(String),
    #[error("request failed: {0}")]
    Request(String),
    #[error("request budget exceeded")]
    BudgetRequests,
    #[error("transfer budget exceeded")]
    BudgetBytes,
    #[error("response too large")]
    TooLarge,
}

#[derive(Debug, Clone)]
pub struct FetchedResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct InterceptedExchange {
    pub request_url: String,
    pub method: String,
    pub request_headers: Vec<(String, String)>,
    pub response: FetchedResponse,
}

/// Budget counters shared across all concurrent request handlers.
#[derive(Clone)]
pub struct InterceptBudget {
    requests: Arc<AtomicUsize>,
    bytes: Arc<AtomicUsize>,
    permits: Arc<Semaphore>,
}

impl InterceptBudget {
    pub fn new() -> Self {
        Self {
            requests: Arc::new(AtomicUsize::new(0)),
            bytes: Arc::new(AtomicUsize::new(0)),
            permits: Arc::new(Semaphore::new(CONCURRENCY)),
        }
    }

    fn check_request(&self) -> Result<(), InterceptError> {
        if self.requests.fetch_add(1, Ordering::Relaxed) >= MAX_REQUESTS {
            return Err(InterceptError::BudgetRequests);
        }
        Ok(())
    }

    fn check_bytes(&self, len: usize) -> Result<(), InterceptError> {
        if self.bytes.fetch_add(len, Ordering::Relaxed) + len > MAX_TRANSFER_BYTES {
            return Err(InterceptError::BudgetBytes);
        }
        Ok(())
    }
}

/// The IPv4 ranges the protocol sets aside (the IANA IPv4 Special-Purpose Address Registry, plus multicast and the
/// limited broadcast address): none of them is a host on the public internet, so none is a public address. A table
/// of the protocol's own ranges, as (network, prefix length).
pub const SPECIAL_IPV4: &[([u8; 4], u8)] = &[
    ([0, 0, 0, 0], 8),        // "this network" (RFC 791)
    ([10, 0, 0, 0], 8),       // private use (RFC 1918)
    ([100, 64, 0, 0], 10),    // shared address space, carrier-grade NAT (RFC 6598)
    ([127, 0, 0, 0], 8),      // loopback (RFC 1122)
    ([169, 254, 0, 0], 16),   // link-local, where metadata services answer (RFC 3927)
    ([172, 16, 0, 0], 12),    // private use (RFC 1918)
    ([192, 0, 0, 0], 24),     // IETF protocol assignments (RFC 6890), the whole block
    ([192, 0, 2, 0], 24),     // documentation, TEST-NET-1 (RFC 5737)
    ([192, 88, 99, 0], 24),   // deprecated 6to4 relay anycast (RFC 7526)
    ([192, 168, 0, 0], 16),   // private use (RFC 1918)
    ([198, 18, 0, 0], 15),    // benchmarking (RFC 2544)
    ([198, 51, 100, 0], 24),  // documentation, TEST-NET-2 (RFC 5737)
    ([203, 0, 113, 0], 24),   // documentation, TEST-NET-3 (RFC 5737)
    ([224, 0, 0, 0], 4),      // multicast (RFC 5771)
    ([240, 0, 0, 0], 4),      // reserved for future use (RFC 1112), limited broadcast within it
];

/// The IPv6 ranges the protocol sets aside (the IANA IPv6 Special-Purpose Address Registry, multicast, and everything
/// outside global unicast `2000::/3`), as (network, prefix length). The ranges that embed an IPv4 address
/// ([`embedded_ipv4`]) are judged by the address they carry, before this table is read.
pub const SPECIAL_IPV6: &[([u16; 8], u8)] = &[
    ([0, 0, 0, 0, 0, 0, 0, 0], 128),             // unspecified
    ([0, 0, 0, 0, 0, 0, 0, 1], 128),             // loopback
    ([0x64, 0xff9b, 1, 0, 0, 0, 0, 0], 48),      // local-use IPv4/IPv6 translation (RFC 8215)
    ([0x100, 0, 0, 0, 0, 0, 0, 0], 64),          // discard-only (RFC 6666)
    ([0x100, 0, 0, 1, 0, 0, 0, 0], 64),          // dummy prefix (RFC 9780)
    ([0x2001, 0, 0, 0, 0, 0, 0, 0], 23),         // IETF protocol assignments, Teredo among them (RFC 2928)
    ([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32),     // documentation (RFC 3849)
    ([0x2002, 0, 0, 0, 0, 0, 0, 0], 16),         // 6to4 (RFC 3056)
    ([0x3fff, 0, 0, 0, 0, 0, 0, 0], 20),         // documentation (RFC 9637)
    ([0x5f00, 0, 0, 0, 0, 0, 0, 0], 16),         // segment routing SIDs (RFC 9602)
    ([0xfc00, 0, 0, 0, 0, 0, 0, 0], 7),          // unique local (RFC 4193)
    ([0xfe80, 0, 0, 0, 0, 0, 0, 0], 10),         // link-local (RFC 4291)
    ([0xff00, 0, 0, 0, 0, 0, 0, 0], 8),          // multicast (RFC 4291)
];

/// The IPv4 address an IPv6 address carries, where the protocol puts one in it: IPv4-mapped (`::ffff:a.b.c.d`),
/// IPv4-compatible (`::a.b.c.d`, deprecated), the well-known IPv4/IPv6 translation prefix (`64:ff9b::/96`), 6to4
/// (`2002:aabb:ccdd::/48`) and Teredo (`2001:0::/32`, the client's address inverted in the last 32 bits). `::` and
/// `::1` carry none: they are themselves.
pub fn embedded_ipv4(ip: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = ip.segments();
    let o = ip.octets();
    let last = std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15]);
    if let Some(v4) = translated_to(ip) {
        return Some(v4);
    }
    if s[0] == 0x2002 {
        return Some(std::net::Ipv4Addr::new(o[2], o[3], o[4], o[5]));
    }
    if s[0] == 0x2001 && s[1] == 0 {
        return Some(std::net::Ipv4Addr::from(!u32::from(last)));
    }
    None
}

/// The IPv4 address a connection to `ip` reaches: the forms where the IPv6 address stands for the IPv4 one (mapped,
/// compatible, the well-known translation prefix). 6to4 and Teredo carry an address too, but are relays, not it.
fn translated_to(ip: std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = ip.segments();
    let o = ip.octets();
    let last = std::net::Ipv4Addr::new(o[12], o[13], o[14], o[15]);
    let mapped = s[..5] == [0; 5] && s[5] == 0xffff;
    let compatible = s[..6] == [0; 6] && u32::from(last) > 1;
    let translated = s[..6] == [0x64, 0xff9b, 0, 0, 0, 0];
    (mapped || compatible || translated).then_some(last)
}

/// Whether `ip` is an address on the public internet: not in a range the protocol sets aside ([`SPECIAL_IPV4`],
/// [`SPECIAL_IPV6`]), and for IPv6 within global unicast, an IPv6 address that carries an IPv4 one judged as the
/// IPv4. The one classification every caller uses: the transport's resolver, the browser's proxy and the sandbox's
/// line to the node.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let a = u32::from(v4);
            !SPECIAL_IPV4.iter().any(|(net, len)| {
                let mask = if *len == 0 { 0 } else { u32::MAX << (32 - u32::from(*len)) };
                a & mask == u32::from_be_bytes(*net) & mask
            })
        }
        IpAddr::V6(v6) => {
            // An IPv6 address that carries a set-aside IPv4 address is set aside too; one that stands for a public
            // IPv4 address is public as that address is.
            if embedded_ipv4(v6).is_some_and(|v4| !is_public_ip(IpAddr::V4(v4))) {
                return false;
            }
            if let Some(v4) = translated_to(v6) {
                return is_public_ip(IpAddr::V4(v4));
            }
            let a = u128::from(v6);
            let global_unicast = (v6.segments()[0] & 0xe000) == 0x2000;
            global_unicast
                && !SPECIAL_IPV6.iter().any(|(net, len)| {
                    let mask = if *len == 0 { 0 } else { u128::MAX << (128 - u32::from(*len)) };
                    a & mask == u128::from(std::net::Ipv6Addr::from(*net)) & mask
                })
        }
    }
}

fn validate_web_url(raw: &str) -> Result<Url, InterceptError> {
    let mut url =
        Url::parse(raw).map_err(|_| InterceptError::InvalidUrl("unparseable".into()))?;
    url.set_fragment(None);
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(InterceptError::InvalidUrl("not http(s)".into()));
    }
    Ok(url)
}

/// Headers the transport owns; callers cannot set or receive them.
fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "upgrade"
            | "te"
            | "trailer"
            | "content-length"
            | "content-encoding"
            | "accept-encoding"
    )
}

/// Make an HTTP request from Rust with DNS pinning and public-IP validation.
/// Redirects are returned unfollowed so each hop is re-intercepted by Chromium
/// and checked again.
pub async fn fetch_public(
    raw_url: &str,
    method: &str,
    headers: &[(String, String)],
    body: Option<&[u8]>,
) -> Result<FetchedResponse, InterceptError> {
    let url = validate_web_url(raw_url)?;
    let domain = url.host_str().unwrap().to_owned();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| InterceptError::InvalidUrl("no port".into()))?;

    let addresses: Vec<SocketAddr> = tokio::net::lookup_host((domain.as_str(), port))
        .await
        .map_err(|e| InterceptError::Dns(e.to_string()))?
        .collect();

    if addresses.is_empty() || addresses.iter().any(|a| !is_public_ip(a.ip())) {
        return Err(InterceptError::NonPublicAddress);
    }

    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| InterceptError::InvalidUrl("bad method".into()))?;

    // Pin to the exact addresses we validated: no second DNS resolution in the
    // HTTP client, and no ambient proxy can bypass it.
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(REQUEST_TIMEOUT)
        .resolve_to_addrs(&domain, &addresses)
        .build()
        .map_err(|e| InterceptError::Request(e.to_string()))?;

    let mut request = client.request(http_method, url.clone());
    for (name, value) in headers.iter().filter(|(n, _)| !is_hop_by_hop(n)) {
        request = request.header(name, value);
    }
    if let Some(body) = body {
        request = request.body(body.to_vec());
    }

    let mut response = request
        .send()
        .await
        .map_err(|e| InterceptError::Request(e.to_string()))?;

    let status = response.status().as_u16();
    let resp_headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .filter(|(name, _)| !is_hop_by_hop(name.as_str()))
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.to_string(), v.to_string()))
        })
        .collect();

    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| InterceptError::Request(e.to_string()))?
    {
        if (bytes.len() + chunk.len()) as u64 > MAX_BODY_BYTES {
            return Err(InterceptError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(FetchedResponse {
        status,
        headers: resp_headers,
        body: bytes,
    })
}

/// Send `Fetch.enable` to intercept all requests at the request stage.
pub async fn enable_fetch_interception(
    client: &CdpClient,
    session_id: &str,
) -> Result<(), String> {
    client
        .send_command(
            "Fetch.enable",
            Some(json!({
                "patterns": [{"urlPattern": "*", "requestStage": "Request"}]
            })),
            Some(session_id),
        )
        .await?;
    Ok(())
}

fn safe_logged_url(raw: &str) -> String {
    if let Ok(mut u) = Url::parse(raw) {
        u.set_query(None);
        u.set_fragment(None);
        u.set_username("").ok();
        u.set_password(None).ok();
        u.to_string()
    } else {
        "invalid URL".into()
    }
}

/// Extract the request body from a `Fetch.requestPaused` event.
fn request_body(params: &Value) -> Option<Vec<u8>> {
    let request = &params["request"];
    if let Some(entries) = request["postDataEntries"].as_array() {
        let mut body = Vec::new();
        for entry in entries {
            body.extend(
                STANDARD
                    .decode(entry["bytes"].as_str().unwrap_or(""))
                    .ok()?,
            );
        }
        return Some(body);
    }
    if let Some(text) = request["postData"].as_str() {
        return Some(text.as_bytes().to_vec());
    }
    None
}

/// Handle a single `Fetch.requestPaused` event: fetch the resource from Rust
/// and fulfill or fail the request back to the browser.
pub async fn handle_paused_request(
    client: &CdpClient,
    session_id: &str,
    params: &Value,
    budget: &InterceptBudget,
) -> Option<InterceptedExchange> {
    let id = params["requestId"].as_str()?;
    let raw_url = params["request"]["url"].as_str().unwrap_or("");
    let method = params["request"]["method"].as_str().unwrap_or("GET");

    // Non-HTTP resources (data:, blob:, chrome-extension:) are local to the
    // browser and pass through without interception.
    if !raw_url.starts_with("http://") && !raw_url.starts_with("https://") {
        let _ = client
            .send_command(
                "Fetch.continueRequest",
                Some(json!({"requestId": id})),
                Some(session_id),
            )
            .await;
        return None;
    }

    let headers: Vec<(String, String)> = params["request"]["headers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
        .collect();

    let body = request_body(params);

    let result: Result<FetchedResponse, InterceptError> = async {
        budget.check_request()?;
        let _permit = budget
            .permits
            .acquire()
            .await
            .map_err(|_| InterceptError::Request("closing".into()))?;
        let fetched = fetch_public(raw_url, method, &headers, body.as_deref()).await?;
        budget.check_bytes(fetched.body.len())?;
        Ok(fetched)
    }
    .await;

    match result {
        Ok(ref response) => {
            let cdp_headers: Vec<Value> = response
                .headers
                .iter()
                .map(|(name, value)| json!({"name": name, "value": value}))
                .collect();
            let fulfill = json!({
                "requestId": id,
                "responseCode": response.status,
                "responseHeaders": cdp_headers,
                "body": STANDARD.encode(&response.body),
            });
            if let Err(e) = client
                .send_command("Fetch.fulfillRequest", Some(fulfill), Some(session_id))
                .await
            {
                let _ = writeln!(
                    std::io::stderr(),
                    "[intercept] fulfillRequest failed for {}: {e}",
                    safe_logged_url(raw_url)
                );
            }
        }
        Err(ref reason) => {
            let _ = client
                .send_command(
                    "Fetch.failRequest",
                    Some(json!({"requestId": id, "errorReason": "BlockedByClient"})),
                    Some(session_id),
                )
                .await;
            let _ = writeln!(
                std::io::stderr(),
                "[intercept] blocked {}: {reason}",
                safe_logged_url(raw_url)
            );
        }
    }

    result.ok().map(|response| InterceptedExchange {
        request_url: safe_logged_url(raw_url),
        method: method.to_string(),
        request_headers: headers,
        response,
    })
}

/// Aborts the intercept loop when dropped, so every return path from the
/// caller cleans up without explicit abort calls at each exit.
pub struct InterceptGuard(tokio::task::JoinHandle<()>);

impl InterceptGuard {
    pub fn new(handle: tokio::task::JoinHandle<()>) -> Self {
        Self(handle)
    }
}

impl Drop for InterceptGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Spawn the interception event loop: reads `Fetch.requestPaused` events from
/// the method tap and handles each one concurrently. Returns a handle that
/// aborts the loop when dropped or explicitly aborted.
pub fn spawn_intercept_loop(
    client: Arc<CdpClient>,
    session_id: String,
    mut tap: tokio::sync::mpsc::UnboundedReceiver<crate::cdp::types::CdpEvent>,
) -> tokio::task::JoinHandle<()> {
    let budget = InterceptBudget::new();
    tokio::spawn(async move {
        let mut workers = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                event = tap.recv() => match event {
                    Some(event) if event.session_id.as_deref() == Some(session_id.as_str()) => {
                        let c = Arc::clone(&client);
                        let s = session_id.clone();
                        let b = budget.clone();
                        let params = event.params;
                        workers.spawn(async move {
                            handle_paused_request(&c, &s, &params, &b).await;
                        });
                    }
                    Some(_) => (),
                    None => break,
                },
                _ = workers.join_next(), if !workers.is_empty() => (),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn special_use_and_metadata_addresses_are_denied() {
        for address in [
            "0.0.0.0",
            "10.1.2.3",
            "127.0.0.1",
            "100.100.100.200",
            "169.254.169.254",
            "172.31.1.1",
            "192.168.1.1",
            "192.0.0.8",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "64:ff9b::a00:1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::",
            "3fff::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "140.82.112.6",
            "2606:4700:4700::1111",
            "2001:4860:4860::8888",
        ] {
            assert!(is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    /// Every address of every range the protocol sets aside is no public address, its first, its last and one in
    /// between, and so is each of them carried in an IPv6 address that stands for it; the addresses around them are.
    #[test]
    fn every_special_purpose_range_is_not_public_wherever_it_is_written() {
        for (net, len) in SPECIAL_IPV4 {
            let first = u32::from_be_bytes(*net);
            let span = if *len == 0 { u32::MAX } else { (1u32 << (32 - u32::from(*len))) - 1 };
            for a in [first, first + span / 2, first + span] {
                let v4 = std::net::Ipv4Addr::from(a);
                assert!(!is_public_ip(IpAddr::V4(v4)), "{v4} is in {net:?}/{len}");
                for v6 in [v4.to_ipv6_mapped(), std::net::Ipv6Addr::from((0x0064_ff9b_u128 << 96) | u128::from(a))] {
                    assert!(!is_public_ip(IpAddr::V6(v6)), "{v6} carries {v4}");
                }
                if a > 1 {
                    assert!(!is_public_ip(IpAddr::V6(v4.to_ipv6_compatible())), "{} carries {v4}", v4.to_ipv6_compatible());
                }
                let six_to_four = std::net::Ipv6Addr::from((0x2002_u128 << 112) | (u128::from(a) << 80));
                let teredo = std::net::Ipv6Addr::from((0x2001_0000_u128 << 96) | u128::from(!a));
                for v6 in [six_to_four, teredo] {
                    assert_eq!(embedded_ipv4(v6), Some(v4), "{v6} carries {v4}");
                    assert!(!is_public_ip(IpAddr::V6(v6)), "{v6} carries {v4}");
                }
            }
        }
        for (net, len) in SPECIAL_IPV6 {
            let first = u128::from(std::net::Ipv6Addr::from(*net));
            let span = if *len == 0 { u128::MAX } else { (1u128 << (128 - u32::from(*len))) - 1 };
            for a in [first, first + span / 2, first + span] {
                let v6 = std::net::Ipv6Addr::from(a);
                assert!(!is_public_ip(IpAddr::V6(v6)), "{v6} is in {net:x?}/{len}");
            }
        }
        // Outside global unicast is no internet host either.
        for address in ["4000::1", "8000::1", "e000::1", "1000::1"] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        // The neighbours of the ranges are public: the table takes no more than it names.
        for address in ["1.1.1.1", "8.8.8.8", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
            "192.0.1.0", "192.0.3.0", "192.167.255.255", "192.169.0.0", "198.17.255.255", "198.20.0.0", "223.255.255.255",
            "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:200::1", "2003::1", "2606:4700:4700::1111", "2001:4860:4860::8888", "3fff:1000::1"] {
            assert!(is_public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(!is_public_ip("192.0.0.1".parse().unwrap()), "the whole IETF protocol block, not only its first addresses");
    }

    #[test]
    fn hop_by_hop_headers_are_stripped() {
        assert!(is_hop_by_hop("Connection"));
        assert!(is_hop_by_hop("transfer-encoding"));
        assert!(is_hop_by_hop("Content-Length"));
        assert!(!is_hop_by_hop("Content-Type"));
        assert!(!is_hop_by_hop("X-Custom"));
    }

    #[test]
    fn web_urls_require_http_scheme() {
        assert!(validate_web_url("https://example.com/page").is_ok());
        assert!(validate_web_url("http://example.com/page").is_ok());
        assert!(validate_web_url("ftp://example.com/page").is_err());
        assert!(validate_web_url("data:text/html,hi").is_err());
        assert!(validate_web_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn safe_logged_url_strips_query_and_credentials() {
        assert_eq!(
            safe_logged_url("https://user:pass@example.com/api?token=secret#frag"),
            "https://example.com/api"
        );
    }

    #[test]
    fn budget_checks_request_limit() {
        let budget = InterceptBudget::new();
        for _ in 0..MAX_REQUESTS {
            assert!(budget.check_request().is_ok());
        }
        assert!(budget.check_request().is_err());
    }

    #[test]
    fn budget_checks_byte_limit() {
        let budget = InterceptBudget::new();
        assert!(budget.check_bytes(MAX_TRANSFER_BYTES - 1).is_ok());
        assert!(budget.check_bytes(MAX_TRANSFER_BYTES).is_err());
    }

    #[test]
    fn request_body_from_post_data() {
        let params = json!({
            "request": {
                "postData": "hello=world"
            }
        });
        assert_eq!(request_body(&params), Some(b"hello=world".to_vec()));
    }

    #[test]
    fn request_body_from_base64_entries() {
        let params = json!({
            "request": {
                "postDataEntries": [{"bytes": "aGVsbG8="}]
            }
        });
        assert_eq!(request_body(&params), Some(b"hello".to_vec()));
    }

    #[test]
    fn request_body_absent_when_no_post_data() {
        let params = json!({"request": {}});
        assert_eq!(request_body(&params), None);
    }

    // ---- a browser on a local socket, driven by the test ----

    use futures_util::{SinkExt, StreamExt};
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
    use tokio_tungstenite::tungstenite::Message;

    struct FakeBrowser {
        client: Arc<CdpClient>,
        /// Every command the browser was sent, as (method, params, sessionId).
        seen: UnboundedReceiver<(String, Value, Option<String>)>,
        /// Raw text the browser pushes at the client (events).
        push: UnboundedSender<String>,
    }

    /// A browser that answers each command with `reply(method)` (`Ok` result or `Err` message).
    async fn fake_browser(reply: fn(&str) -> Result<Value, String>) -> FakeBrowser {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let (seen_tx, seen) = unbounded_channel();
        let (push, mut push_rx) = unbounded_channel::<String>();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
            loop {
                tokio::select! {
                    msg = ws.next() => {
                        let Some(Ok(Message::Text(text))) = msg else { break };
                        let cmd: Value = serde_json::from_str(&text).unwrap();
                        let method = cmd["method"].as_str().unwrap().to_string();
                        let _ = seen_tx.send((method.clone(), cmd["params"].clone(), cmd["sessionId"].as_str().map(String::from)));
                        let answer = match reply(&method) {
                            Ok(result) => json!({"id": cmd["id"], "result": result}),
                            Err(message) => json!({"id": cmd["id"], "error": {"code": -32000, "message": message}}),
                        };
                        if ws.send(Message::Text(answer.to_string())).await.is_err() { break }
                    }
                    Some(text) = push_rx.recv() => {
                        if ws.send(Message::Text(text)).await.is_err() { break }
                    }
                }
            }
        });
        FakeBrowser { client: Arc::new(CdpClient::connect(&url).await.unwrap()), seen, push }
    }

    fn accept_all(_: &str) -> Result<Value, String> {
        Ok(json!({}))
    }

    async fn next_seen(b: &mut FakeBrowser) -> (String, Value, Option<String>) {
        tokio::time::timeout(Duration::from_secs(10), b.seen.recv()).await.expect("the browser was sent a command").expect("line open")
    }

    #[tokio::test]
    async fn interception_is_asked_for_every_url_at_the_request_stage_on_the_session() {
        let mut b = fake_browser(accept_all).await;
        enable_fetch_interception(&b.client, "S1").await.unwrap();
        let (method, params, session) = next_seen(&mut b).await;
        assert_eq!(method, "Fetch.enable");
        assert_eq!(params["patterns"], json!([{"urlPattern": "*", "requestStage": "Request"}]));
        assert_eq!(session.as_deref(), Some("S1"));
    }

    #[tokio::test]
    async fn a_browser_that_refuses_interception_is_reported_not_swallowed() {
        let b = fake_browser(|_| Err("Fetch domain refused".into())).await;
        let e = enable_fetch_interception(&b.client, "S1").await.unwrap_err();
        assert!(e.contains("Fetch domain refused"), "{e}");
    }

    #[tokio::test]
    async fn a_resource_local_to_the_browser_is_let_through_untouched() {
        let mut b = fake_browser(accept_all).await;
        let params = json!({"requestId": "r1", "request": {"url": "data:text/html,hi", "method": "GET"}});
        let out = handle_paused_request(&b.client, "S1", &params, &InterceptBudget::new()).await;
        assert!(out.is_none());
        let (method, sent, session) = next_seen(&mut b).await;
        assert_eq!(method, "Fetch.continueRequest");
        assert_eq!(sent, json!({"requestId": "r1"}));
        assert_eq!(session.as_deref(), Some("S1"));
    }

    #[tokio::test]
    async fn a_pause_without_a_request_id_is_ignored_and_the_browser_hears_nothing() {
        let mut b = fake_browser(accept_all).await;
        let params = json!({"request": {"url": "https://example.com/", "method": "GET"}});
        assert!(handle_paused_request(&b.client, "S1", &params, &InterceptBudget::new()).await.is_none());
        assert!(tokio::time::timeout(Duration::from_millis(200), b.seen.recv()).await.is_err());
    }

    #[tokio::test]
    async fn a_request_to_a_non_public_address_is_failed_back_to_the_browser() {
        let mut b = fake_browser(accept_all).await;
        let params = json!({"requestId": "r2", "request": {
            "url": "http://127.0.0.1:9/secret?token=1", "method": "POST",
            "headers": {"X-Custom": "1", "Number": 5}, "postData": "a=b"}});
        let out = handle_paused_request(&b.client, "S1", &params, &InterceptBudget::new()).await;
        assert!(out.is_none(), "nothing was fetched");
        let (method, sent, _) = next_seen(&mut b).await;
        assert_eq!(method, "Fetch.failRequest");
        assert_eq!(sent, json!({"requestId": "r2", "errorReason": "BlockedByClient"}));
    }

    #[tokio::test]
    async fn a_request_past_the_budget_is_failed_before_any_lookup() {
        let mut b = fake_browser(accept_all).await;
        let budget = InterceptBudget::new();
        budget.requests.store(MAX_REQUESTS, Ordering::Relaxed);
        let params = json!({"requestId": "r3", "request": {"url": "https://example.com/", "method": "GET"}});
        assert!(handle_paused_request(&b.client, "S1", &params, &budget).await.is_none());
        let (method, sent, _) = next_seen(&mut b).await;
        assert_eq!(method, "Fetch.failRequest");
        assert_eq!(sent["requestId"], "r3");
    }

    #[tokio::test]
    async fn the_loop_handles_its_own_sessions_events_and_ends_when_the_tap_closes() {
        let mut b = fake_browser(accept_all).await;
        let (tap_tx, tap) = unbounded_channel();
        let handle = spawn_intercept_loop(b.client.clone(), "S1".into(), tap);
        let paused = |session: &str, id: &str| crate::cdp::types::CdpEvent {
            method: "Fetch.requestPaused".into(),
            session_id: Some(session.into()),
            params: json!({"requestId": id, "request": {"url": "blob:x", "method": "GET"}}),
        };
        tap_tx.send(paused("OTHER", "not-mine")).unwrap();
        tap_tx.send(paused("S1", "mine")).unwrap();
        let (method, sent, session) = next_seen(&mut b).await;
        assert_eq!((method.as_str(), session.as_deref()), ("Fetch.continueRequest", Some("S1")));
        assert_eq!(sent["requestId"], "mine", "the other session's pause was not handled");
        drop(tap_tx);
        let ended = tokio::time::timeout(Duration::from_secs(10), handle).await;
        assert!(ended.is_ok(), "the loop outlived its tap");
    }

    #[tokio::test]
    async fn dropping_the_guard_stops_the_loop() {
        let (keep, hold) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _keep = keep;
            std::future::pending::<()>().await;
        });
        let guard = InterceptGuard::new(handle);
        drop(guard);
        // The task's future is dropped by the abort, so its sender is dropped and the receiver closes.
        let closed = tokio::time::timeout(Duration::from_secs(10), hold).await.expect("the task was aborted");
        assert!(closed.is_err());
    }

    #[test]
    fn a_logged_url_that_does_not_parse_says_so_and_leaks_nothing() {
        assert_eq!(safe_logged_url("not a url with ?secret=1"), "invalid URL");
    }

    #[test]
    fn a_request_body_with_a_broken_entry_is_no_body() {
        let params = json!({"request": {"postDataEntries": [{"bytes": "aGVsbG8="}, {"bytes": "***"}]}});
        assert_eq!(request_body(&params), None);
        let two = json!({"request": {"postDataEntries": [{"bytes": "aGk="}, {"bytes": "IHRoZXJl"}]}});
        assert_eq!(request_body(&two), Some(b"hi there".to_vec()));
    }

    #[tokio::test]
    async fn fetch_public_refuses_what_is_not_a_public_web_address() {
        assert!(matches!(fetch_public("ftp://example.com/", "GET", &[], None).await, Err(InterceptError::InvalidUrl(_))));
        assert!(matches!(fetch_public("http://127.0.0.1:1/", "GET", &[], None).await, Err(InterceptError::NonPublicAddress)));
        // A bracketed literal is not looked up as an address: refused all the same, as a failed lookup.
        assert!(matches!(fetch_public("http://[::1]:1/", "GET", &[], None).await, Err(InterceptError::Dns(_) | InterceptError::NonPublicAddress)));
        assert!(matches!(fetch_public("http://169.254.169.254/latest", "GET", &[], None).await, Err(InterceptError::NonPublicAddress)));
    }

    #[tokio::test]
    async fn fetch_public_refuses_a_method_that_is_not_one() {
        let e = fetch_public("http://8.8.8.8/", "NOT A METHOD", &[], None).await.unwrap_err();
        assert!(matches!(e, InterceptError::InvalidUrl(ref m) if m == "bad method"), "{e}");
    }

    #[tokio::test]
    async fn fetch_public_reports_a_connection_that_never_opens_as_a_request_failure() {
        let headers = vec![("Host".to_string(), "evil".to_string()), ("X-Custom".to_string(), "1".to_string())];
        let e = fetch_public("http://8.8.8.8:1/", "POST", &headers, Some(b"x")).await.unwrap_err();
        assert!(matches!(e, InterceptError::Request(_)), "{e}");
    }
}
