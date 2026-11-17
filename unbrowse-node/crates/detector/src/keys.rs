//! Private keys and signed session tokens: patterns 10 and 11.

use crate::format::Format;

fn base64_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'+' || b == b'/'
}

/// Decodes unpadded base64url (or standard base64), or `None` if `s` isn't that.
pub fn b64url(s: &[u8]) -> Option<Vec<u8>> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32)
    };
    let s: &[u8] = match s.iter().position(|&b| b == b'=') {
        Some(i) => &s[..i],
        None => s,
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for chunk in s.chunks(4) {
        if chunk.len() == 1 {
            return None;
        }
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= val(c)? << (18 - 6 * i);
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..chunk.len() - 1]);
    }
    Some(out)
}

fn has(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// A signed token naming a principal: its header decodes to JSON naming an algorithm other than `none`, and its claims
/// decode to JSON with a subject (`sub`). A token with no subject (a project's public key a page ships, an anonymous
/// role) names no one and acts as no one.
fn signed_with_subject(t: &[u8]) -> bool {
    let mut parts = t.split(|&b| b == b'.');
    let (Some(h), Some(p)) = (parts.next(), parts.next()) else { return false };
    let (Some(h), Some(p)) = (b64url(h), b64url(p)) else { return false };
    let compact = |v: Vec<u8>| -> Vec<u8> { v.into_iter().filter(|b| !b.is_ascii_whitespace()).collect() };
    let (h, p) = (compact(h), compact(p));
    has(&h, b"\"alg\":") && !has(&h, b"\"alg\":\"none\"") && !has(&h, b"\"alg\":\"NONE\"") && has(&p, b"\"sub\":")
}

pub const FORMATS: &[Format] = &[
    Format {
        id: 10,
        name: "private-key-block",
        family: "private key",
        // An armoured private key of any kind: the BEGIN line naming a private key, then its base-64 body, whose line
        // breaks a JSON string holds escaped. A key cut short still leaks, so no END line is needed.
        regex: r"(?-u)(?P<t>-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?P<r>(?:[A-Za-z0-9+/=]|\\[nr]|[ \t\r\n])+))",
        min_millibits: 4500,
        mixed: true,
        keep: Some(base64_char),
        min_kept: 64,
        check: None,
    },
    Format {
        id: 11,
        name: "signed-session-token",
        family: "session",
        // A JSON web token: base-64-url header and claims, each starting `eyJ` (`{"`), and a signature of 16 or more.
        regex: r"(?-u)(?P<t>eyJ[A-Za-z0-9_\-]{4,}\.eyJ[A-Za-z0-9_\-]{4,}\.(?P<r>[A-Za-z0-9_\-]{16,}))",
        min_millibits: 3500,
        mixed: true,
        keep: None,
        min_kept: 16,
        check: Some(signed_with_subject),
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trips_without_padding() {
        assert_eq!(b64url(b"eyJhIjoxfQ").unwrap(), br#"{"a":1}"#);
        assert_eq!(b64url(b"YQ").unwrap(), b"a");
        assert!(b64url(b"Y").is_none());
        assert!(b64url(b"a.b").is_none());
    }
}
