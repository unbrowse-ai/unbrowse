//! Documented example and test keys are not leaks (R6.36). Two rules exclude them, and neither needs the keys
//! themselves in this source:
//!
//! - **By hash.** `DOCUMENTED` holds the SHA-256, in hex, of tokens that vendors publish in their documentation as
//!   examples, so the list never holds the tokens themselves. A token whose hash is listed is excluded. It is empty in
//!   version 1 (README).
//! - **By shape.** A token that says it is a placeholder: it carries a marker word vendors use for examples, a run of one
//!   character a random draw would almost never give, or a template brace.

use sha2::{Digest, Sha256};

/// SHA-256 (hex) of documented example tokens, sorted. Pinned with the detector version: a change is a new version.
pub const DOCUMENTED: &[&str] = &[];

/// Marker words that make a token a placeholder, matched case-sensitively as written in vendors' examples.
const MARKERS: &[&[u8]] = &[b"EXAMPLE", b"example", b"Example", b"XXXX", b"xxxx", b"YOUR", b"your", b"REDACTED", b"redacted", b"PLACEHOLDER", b"placeholder", b"dummy", b"DUMMY"];

/// The longest run of one character a random token may have. Base 32 drawn at random gives a run of six or more in a
/// 64-character token about once in two million draws.
pub const MAX_RUN: usize = 6;

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Whether `token` is excluded: a documented example by hash, or a placeholder by shape.
pub fn excluded(token: &[u8]) -> bool {
    if MARKERS.iter().any(|m| contains(token, m)) {
        return true;
    }
    if token.iter().any(|b| matches!(b, b'{' | b'}' | b'*' | b'<' | b'>')) {
        return true;
    }
    if crate::random::longest_run(token) > MAX_RUN {
        return true;
    }
    let h = hex::encode(Sha256::digest(token));
    DOCUMENTED.binary_search(&h.as_str()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_documented_list_is_sorted_hex() {
        assert!(DOCUMENTED.windows(2).all(|w| w[0] < w[1]));
        assert!(DOCUMENTED.iter().all(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())));
    }

    #[test]
    fn placeholders_are_excluded_by_shape() {
        let marked = [b"ab12".as_slice(), b"EXAMPLE", b"cd34"].concat();
        assert!(excluded(&marked));
        assert!(excluded(b"ab12{token}cd34"));
        assert!(excluded(b"ab12zzzzzzzcd34"));
        assert!(!excluded(b"ab12zq9kcd34"));
    }
}
