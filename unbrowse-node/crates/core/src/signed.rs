//! Requests signed with a token, never carrying it.
//!
//! A client holding an agent's or the owner's token never sends the token. It names the token by its key
//! ([`crate::token_key`]) and signs each request with an HMAC-SHA256 keyed by the token over the method, the authority
//! it sends to (host and port), the request target (path and query, as sent), a SHA-256 of the body, the time and a
//! fresh nonce. No client follows a redirect, and a request signed for one authority verifies at no other. The node finds the token by its
//! key, checks the signature, and takes each nonce once within [`WINDOW_SECS`]. A process that took the node's port and
//! relays a client's request to the real node gets that one request answered, and nothing it can use again: no token,
//! and a signature that is bound to that request and spent.
//!
//! The node signs its answer the same way, over the status, a SHA-256 of the body and the request's nonce, so a process
//! in the middle can't hand the client an answer of its own. An event stream's events are signed one by one, each with
//! its place in the stream, so none can be added, dropped from the middle, or moved.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// The header naming the token's key (`token_key`, hex).
pub const KEY: &str = "x-unbrowse-key";
/// The header carrying the request's time, in seconds since the Unix epoch.
pub const TIME: &str = "x-unbrowse-time";
/// The header carrying the request's nonce: at least 16 random bytes, hex.
pub const NONCE: &str = "x-unbrowse-nonce";
/// The header carrying the request's signature (hex).
pub const SIGNATURE: &str = "x-unbrowse-signature";
/// The header carrying the node's signature over its answer (hex).
pub const REPLY: &str = "x-unbrowse-reply";

/// How far a request's time may be from the node's, either way. Clients and the node share one machine's clock.
pub const WINDOW_SECS: u64 = 60;

/// What stands for the body hash in the answer's signature when the answer is an event stream: its events are signed
/// one by one ([`event_mac`]).
pub const STREAM: &str = "event-stream";

fn mac(token: &str, parts: &[&[u8]]) -> [u8; 32] {
    let mut m = Hmac::<Sha256>::new_from_slice(token.as_bytes()).expect("HMAC takes a key of any length");
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            m.update(b"\n");
        }
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// SHA-256 of a body, hex: what the signatures carry in its place.
pub fn body_hash(body: &[u8]) -> String {
    hex::encode(Sha256::digest(body))
}

/// The signature a client holding `token` puts on a request to `authority`: the host and port it believes it is talking
/// to, as `host:port` in lower case with the port always written ([`authority`]). A request signed for one authority
/// verifies at no other, so a redirect, or a listener that relays it on, can't spend it anywhere else.
pub fn request_mac(token: &str, method: &str, authority: &str, target: &str, body: &[u8], time: u64, nonce: &str) -> [u8; 32] {
    let method = method.to_ascii_uppercase();
    let authority = authority.to_ascii_lowercase();
    mac(
        token,
        &[b"unbrowse/request/v2", method.as_bytes(), authority.as_bytes(), target.as_bytes(), body_hash(body).as_bytes(), time.to_string().as_bytes(), nonce.as_bytes()],
    )
}

/// The authority a request is signed for: `host:port`, lower case, the port written even when it is the scheme's
/// default (80 for http, 443 for https).
pub fn authority(host: &str, port: Option<u16>, https: bool) -> String {
    format!("{}:{}", host.to_ascii_lowercase(), port.unwrap_or(if https { 443 } else { 80 }))
}

/// The signature the node puts on its answer to the request that carried `nonce`. `body_hash` is [`body_hash`] of the
/// body, or [`STREAM`] for an event stream.
pub fn reply_mac(token: &str, status: u16, body_hash: &str, nonce: &str) -> [u8; 32] {
    mac(token, &[b"unbrowse/reply/v1", status.to_string().as_bytes(), body_hash.as_bytes(), nonce.as_bytes()])
}

/// The signature on event number `seq` (from 0) of the stream that answered the request carrying `nonce`.
pub fn event_mac(token: &str, nonce: &str, seq: u64, name: &str, data: &str) -> [u8; 32] {
    mac(token, &[b"unbrowse/event/v1", nonce.as_bytes(), seq.to_string().as_bytes(), name.as_bytes(), data.as_bytes()])
}

/// Whether `given` (hex) is `expected`, compared without stopping at the first difference.
pub fn matches(expected: &[u8; 32], given: &str) -> bool {
    let Ok(given) = hex::decode(given.trim()) else { return false };
    given.len() == 32 && expected.iter().zip(&given).fold(0u8, |d, (a, b)| d | (a ^ b)) == 0
}

/// Whether a nonce is one a client could have drawn fresh: 16 to 64 random bytes, hex.
pub fn nonce_shape_ok(nonce: &str) -> bool {
    (32..=128).contains(&nonce.len()) && nonce.len().is_multiple_of(2) && nonce.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vectors every client checks itself against (the SDKs, the window): one formula, wherever it is written.
    #[test]
    fn the_signatures_are_the_formula_every_client_writes() {
        let t = "unb_000000000000000000000000000000000000000000000000";
        let n = "00112233445566778899aabbccddeeff";
        assert_eq!(body_hash(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(
            hex::encode(request_mac(t, "post", "127.0.0.1:7788", "/v1/do?x=1", br#"{"goal":"g"}"#, 1_700_000_000, n)),
            hex::encode(request_mac(t, "POST", "127.0.0.1:7788", "/v1/do?x=1", br#"{"goal":"g"}"#, 1_700_000_000, n)),
            "the method is upper-cased"
        );
        assert_eq!(hex::encode(request_mac(t, "POST", "127.0.0.1:7788", "/v1/do?x=1", br#"{"goal":"g"}"#, 1_700_000_000, n)), REQUEST_VECTOR);
        assert_eq!(hex::encode(reply_mac(t, 200, &body_hash(b"{}"), n)), REPLY_VECTOR);
        assert_eq!(hex::encode(event_mac(t, n, 0, "walk", "{}")), EVENT_VECTOR);
    }

    /// A signature covers every part of what it signs: change any one and it no longer matches.
    #[test]
    fn a_signature_is_bound_to_every_part_of_its_request() {
        let t = "tok";
        let n = "00112233445566778899aabbccddeeff";
        let good = request_mac(t, "POST", "127.0.0.1:7788", "/v1/do", b"{}", 5, n);
        assert!(matches(&good, &hex::encode(good)));
        for other in [
            request_mac("tok2", "POST", "127.0.0.1:7788", "/v1/do", b"{}", 5, n),
            request_mac(t, "GET", "127.0.0.1:7788", "/v1/do", b"{}", 5, n),
            request_mac(t, "POST", "127.0.0.1:7788", "/v1/do?x", b"{}", 5, n),
            request_mac(t, "POST", "127.0.0.1:7788", "/v1/do", b"{ }", 5, n),
            request_mac(t, "POST", "127.0.0.1:7788", "/v1/do", b"{}", 6, n),
            request_mac(t, "POST", "127.0.0.1:7788", "/v1/do", b"{}", 5, "00112233445566778899aabbccddeef0"),
        ] {
            assert!(!matches(&other, &hex::encode(good)));
        }
        assert!(!matches(&good, "zz"));
        assert!(!nonce_shape_ok("abc"));
        assert!(nonce_shape_ok(n));
    }

    // Worked out apart from this code (Python's hmac and hashlib), and written into each client's tests too.
    const REQUEST_VECTOR: &str = "cdcc36e12c9a4077bb5da315826c623c3c3ca50927b0c6bc4b795ba45c03b767";
    const REPLY_VECTOR: &str = "e10b3b799411ad8e80d1811eabe612c092eabc800287749a5f2afbb03b3cb35d";
    const EVENT_VECTOR: &str = "b6f79d64e0d4bfc35cb04732c0d84ede9d24e945ea2af522a67f11b15128b3fa";
}
