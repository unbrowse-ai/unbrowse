//! One-time codes (RFC 6238): the code a site asks for after the password, made on the node from the key the site
//! gave when two-step sign-in was turned on. The key stays in the keystore and the code goes only into the site's
//! own field, so an agent signs in with both steps and holds neither: a code it can read is a code it can be talked
//! into handing over.

use hmac::{Hmac, Mac};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hash {
    Sha1,
    Sha256,
    Sha512,
}

/// A time-based one-time code key: the shared secret and how codes are made from it.
pub struct CodeKey {
    secret: Zeroizing<Vec<u8>>,
    hash: Hash,
    digits: u32,
    period: u64,
}

impl CodeKey {
    /// Reads a key as sites hand it out and exporters write it: an `otpauth://totp/…?secret=…` address, or the bare
    /// base32 secret (spaces, dashes and case as people copy it). Anything else, a counter-based or vendor code
    /// included, is not a key this makes codes from.
    pub fn parse(text: &str) -> Option<CodeKey> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let lower = text.to_ascii_lowercase();
        if lower.starts_with("otpauth://") {
            if !lower.starts_with("otpauth://totp/") {
                return None;
            }
            let query = text.split_once('?')?.1;
            let (mut secret, mut hash, mut digits, mut period) = (None, Hash::Sha1, 6, 30);
            for pair in query.split('&') {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                let v = percent_decode(v);
                match k.to_ascii_lowercase().as_str() {
                    "secret" => secret = base32(&v),
                    "algorithm" => {
                        hash = match v.to_ascii_uppercase().as_str() {
                            "SHA1" => Hash::Sha1,
                            "SHA256" => Hash::Sha256,
                            "SHA512" => Hash::Sha512,
                            _ => return None,
                        }
                    }
                    "digits" => digits = v.parse().ok().filter(|d| (6..=8).contains(d))?,
                    "period" => period = v.parse().ok().filter(|p| *p > 0)?,
                    _ => {}
                }
            }
            return Some(CodeKey { secret: secret?, hash, digits, period });
        }
        Some(CodeKey { secret: base32(text)?, hash: Hash::Sha1, digits: 6, period: 30 })
    }

    /// The code at `unix` seconds.
    pub fn at(&self, unix: u64) -> Zeroizing<String> {
        let counter = (unix / self.period).to_be_bytes();
        macro_rules! mac {
            ($d:ty) => {{
                let mut m = Hmac::<$d>::new_from_slice(&self.secret).expect("HMAC takes a key of any length");
                m.update(&counter);
                Zeroizing::new(m.finalize().into_bytes().to_vec())
            }};
        }
        let mac = match self.hash {
            Hash::Sha1 => mac!(sha1::Sha1),
            Hash::Sha256 => mac!(sha2::Sha256),
            Hash::Sha512 => mac!(sha2::Sha512),
        };
        let offset = (mac[mac.len() - 1] & 0x0f) as usize;
        let bin = u32::from_be_bytes([mac[offset] & 0x7f, mac[offset + 1], mac[offset + 2], mac[offset + 3]]);
        Zeroizing::new(format!("{:0width$}", bin % 10u32.pow(self.digits), width = self.digits as usize))
    }

    /// The code now.
    pub fn now(&self) -> Zeroizing<String> {
        self.at(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
    }
}

/// Base32 as people copy it: case, spaces, dashes and missing padding forgiven.
fn base32(text: &str) -> Option<Zeroizing<Vec<u8>>> {
    let mut clean: String = text.chars().filter(|c| !matches!(c, ' ' | '-' | '=')).map(|c| c.to_ascii_uppercase()).collect();
    if clean.is_empty() {
        return None;
    }
    while !clean.len().is_multiple_of(8) {
        clean.push('=');
    }
    let bytes = data_encoding::BASE32.decode(clean.as_bytes()).ok()?;
    (!bytes.is_empty()).then(|| Zeroizing::new(bytes))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], b.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(v)) => {
                out.push(v);
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B: the reference secrets, eight digits, at each listed time.
    #[test]
    fn codes_match_the_rfc_vectors() {
        let key = |secret: &[u8], hash| CodeKey { secret: Zeroizing::new(secret.to_vec()), hash, digits: 8, period: 30 };
        let sha1 = key(b"12345678901234567890", Hash::Sha1);
        let sha256 = key(b"12345678901234567890123456789012", Hash::Sha256);
        let sha512 = key(b"1234567890123456789012345678901234567890123456789012345678901234", Hash::Sha512);
        for (t, a, b, c) in [
            (59, "94287082", "46119246", "90693936"),
            (1111111109, "07081804", "68084774", "25091201"),
            (1234567890, "89005924", "91819424", "93441116"),
            (20000000000, "65353130", "77737706", "47863826"),
        ] {
            assert_eq!(*sha1.at(t), a);
            assert_eq!(*sha256.at(t), b);
            assert_eq!(*sha512.at(t), c);
        }
    }

    /// A key reads the same whether it came as an address or as the bare secret people copy.
    #[test]
    fn a_key_is_read_as_sites_and_exporters_write_it() {
        // "12345678901234567890" in base32.
        let bare = CodeKey::parse("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq").unwrap();
        let address = CodeKey::parse("otpauth://totp/Example:me%40x.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example").unwrap();
        assert_eq!(*bare.at(59), "287082");
        assert_eq!(*address.at(59), "287082");
        let eight = CodeKey::parse("otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30&algorithm=SHA1").unwrap();
        assert_eq!(*eight.at(59), "94287082");
        assert!(CodeKey::parse("otpauth://hotp/x?secret=GEZDGNBV&counter=1").is_none(), "a counter-based key makes no time codes");
        assert!(CodeKey::parse("steam://ABCDEF").is_none());
        assert!(CodeKey::parse("not base32!").is_none());
        assert!(CodeKey::parse("").is_none());
    }
}
