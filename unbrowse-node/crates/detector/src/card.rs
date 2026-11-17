//! Card numbers, as a property of the value: a run of 13 to 19 digits standing on its own, its digits in order with at
//! most one separator (a space, a dash or a dot) between two, whose Luhn check digit is right. Every payment card
//! number carries that check (ISO/IEC 7812), so no issuer, brand or range is named here.
//!
//! This is not a pattern of `unbrowse-detector/1`: the pinned set is what a verifier reads, and a new
//! pattern there is a new version. It is what the publishing node refuses before it lists a body (`recipe::leaks`), so
//! a card number a walk captured never leaves this machine in a recipe.

/// What may stand between two digits of a grouped card number.
fn separator(b: u8) -> bool {
    matches!(b, b' ' | b'-' | b'.')
}

/// Whether `digits` pass the Luhn check: from the right, every second digit doubled (less 9 when over 9), the sum a
/// multiple of 10.
pub fn luhn(digits: &[u8]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| {
            let d = u32::from(d - b'0');
            if i % 2 == 1 {
                let x = d * 2;
                if x > 9 { x - 9 } else { x }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

/// Where the first card number in `bytes` starts, if it holds one.
pub fn find(bytes: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() || (i > 0 && bytes[i - 1].is_ascii_digit()) {
            i += 1;
            continue;
        }
        // The whole run from here: digits, and single separators that have a digit after them.
        let start = i;
        let mut digits = Vec::new();
        let mut j = i;
        while j < bytes.len() {
            if bytes[j].is_ascii_digit() {
                digits.push(bytes[j]);
                j += 1;
            } else if separator(bytes[j]) && bytes.get(j + 1).is_some_and(u8::is_ascii_digit) && !digits.is_empty() {
                j += 1;
            } else {
                break;
            }
        }
        if (13..=19).contains(&digits.len()) && luhn(&digits) {
            return Some(start);
        }
        i = j.max(i + 1);
    }
    None
}

/// Where the first card number in `bytes` starts, read as the bytes are and as the ways a body can carry one encoded
/// or in other digits ([`decodings`]): percent-encoded, `\\u` or HTML-escaped, base64, hex, or in full-width or
/// mathematical digits. A number the page's own script encrypted (a payment provider's client-side encryption) is no
/// card number in the bytes, and nothing here can read it.
pub fn find_anywhere(bytes: &[u8]) -> Option<usize> {
    find(bytes).or_else(|| decodings(&String::from_utf8_lossy(bytes)).iter().find_map(|d| find(d.as_bytes()).map(|_| 0)))
}

/// The ASCII digit a character writes, if it is a full-width or mathematical one; other characters as they are.
fn fold(c: char) -> char {
    let cp = c as u32;
    match cp {
        0xFF10..=0xFF19 => char::from_digit(cp - 0xFF10, 10).unwrap_or(c),
        0x1D7CE..=0x1D7FF => char::from_digit((cp - 0x1D7CE) % 10, 10).unwrap_or(c),
        _ => c,
    }
}

/// The other ways `text` may carry what it says: digits folded to ASCII, percent-decoded, `\\u` and HTML numeric
/// escapes decoded, and each run of base64 (16 or more) or hex (26 or more) decoded.
pub fn decodings(text: &str) -> Vec<String> {
    let mut out = vec![text.chars().map(fold).collect::<String>()];
    let b = text.as_bytes();
    let mut pct = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |x: u8| (x as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                pct.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        pct.push(b[i]);
        i += 1;
    }
    out.push(String::from_utf8_lossy(&pct).into_owned());
    let mut esc = String::new();
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        let decoded = if rest.starts_with("\\u") && rest.len() >= 6 {
            u32::from_str_radix(&rest[2..6], 16).ok().and_then(char::from_u32).map(|ch| (ch, 6))
        } else if let Some(e) = rest.strip_prefix("&#").and_then(|r| r.find(';').filter(|&e| e <= 8).map(|e| &r[..e])) {
            let v = match e.strip_prefix(['x', 'X']) {
                Some(h) => u32::from_str_radix(h, 16).ok(),
                None => e.parse().ok(),
            };
            v.and_then(char::from_u32).map(|ch| (ch, e.len() + 3))
        } else {
            None
        };
        match decoded {
            Some((ch, len)) => {
                esc.push(ch);
                rest = &rest[len..];
            }
            None => {
                esc.push(c);
                rest = &rest[c.len_utf8()..];
            }
        }
    }
    out.push(esc);
    let runs = |keep: fn(char) -> bool, shortest: usize| -> Vec<String> {
        let mut found = Vec::new();
        let mut cur = String::new();
        for c in text.chars().chain(std::iter::once('\0')) {
            if keep(c) {
                cur.push(c);
            } else {
                if cur.len() >= shortest {
                    found.push(std::mem::take(&mut cur));
                }
                cur.clear();
            }
        }
        found
    };
    for run in runs(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '-' | '_'), 16) {
        for skip in 0..4 {
            let Some(at) = run.get(skip..) else { continue };
            let keep = at.len() - if at.len() % 4 == 1 { 1 } else { 0 };
            if let Some(bytes) = b64(&at[..keep]) {
                out.push(String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }
    for run in runs(|c| c.is_ascii_hexdigit(), 26) {
        let even = &run[..run.len() & !1];
        let bytes: Option<Vec<u8>> = (0..even.len()).step_by(2).map(|i| u8::from_str_radix(&even[i..i + 2], 16).ok()).collect();
        if let Some(bytes) = bytes {
            out.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    out
}

/// Base64, standard or for addresses, without padding.
fn b64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in text.as_bytes() {
        acc = (acc << 6) | value(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Whether the values of one request, in the order it sends them, hold a card number split across them: a run of
/// two or more consecutive values that are each only digits (2 to 8 of them, as a page splits a number into boxes
/// or halves) and together make a Luhn-valid number of 13 to 19 digits.
pub fn split_across(values: &[String]) -> bool {
    let piece = |v: &str| -> Option<String> {
        let d: String = v.chars().map(fold).collect();
        ((2..=8).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit())).then_some(d)
    };
    for start in 0..values.len() {
        let mut joined = String::new();
        for (n, v) in values[start..].iter().enumerate() {
            let Some(p) = piece(v) else { break };
            joined.push_str(&p);
            if n >= 1 && (13..=19).contains(&joined.len()) && luhn(joined.as_bytes()) {
                return true;
            }
            if joined.len() > 19 {
                break;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Luhn-valid run of 13 to 19 digits is a card number however it is grouped; one digit off, too short, too long
    /// or part of a longer number, it is not.
    #[test]
    fn a_card_number_is_found_however_it_is_grouped() {
        for body in [
            "4242424242424242",
            r#"{"pan":"4242 4242 4242 4242"}"#,
            "card=4242-4242-4242-4242&x=1",
            "3782 822463 10005",
            "6011.1111.1111.1117",
            "4222222222222",
        ] {
            assert!(find(body.as_bytes()).is_some(), "{body}");
        }
        for body in [
            "4242424242424241",
            "424242424242",
            "42424242424242424242",
            "4242 4242 4242 4241",
            r#"{"id":"order-1"}"#,
            "4242--4242-4242-4242",
        ] {
            assert!(find(body.as_bytes()).is_none(), "{body}");
        }
    }

    /// A card number a body carries encoded, or in other digits, is found too; split across the values of one
    /// request, it is found from the values.
    #[test]
    fn a_card_number_is_found_encoded_or_split() {
        let pan = "4242424242424242";
        let hex: String = pan.bytes().map(|b| format!("{b:02x}")).collect();
        let pct: String = pan.bytes().map(|b| format!("%{b:02X}")).collect();
        let wide: String = pan.chars().map(|c| char::from_u32(0xFF10 + c.to_digit(10).unwrap()).unwrap()).collect();
        for body in ["{\"t\":\"NDI0MjQyNDI0MjQyNDI0Mg\"}".to_string(), hex, pct, wide, "&#52;&#50;&#52;&#50;&#52;&#50;&#52;&#50;&#52;&#50;&#52;&#50;&#52;&#50;&#52;&#50;".into()] {
            assert!(find_anywhere(body.as_bytes()).is_some(), "{body}");
        }
        assert!(find_anywhere(b"{\"t\":\"aGVsbG8gd29ybGQgaGVsbG8\"}").is_none());
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(split_across(&v(&["4242", "4242", "4242", "4242"])));
        assert!(split_across(&v(&["visa", "42424242", "42424242", "x"])));
        assert!(!split_across(&v(&["4242", "4242", "4242", "4241"])), "fails the check digit");
        assert!(!split_across(&v(&["4242424242424242"])), "one value is find's to judge");
        assert!(!split_across(&v(&["1", "20", "3"])));
    }
}
