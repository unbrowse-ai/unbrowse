//! Made-up credentials in real formats, for tests and devnet drives only. Each is assembled at run time from short
//! prefix fragments and characters drawn from a seeded generator, so no whole token is ever written in a file. None was
//! ever issued by anyone: they match a format and nothing else.

const UPPER32: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE62: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const URL64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const STD64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGITS: &[u8] = b"0123456789";

/// A seeded generator (splitmix64): the same seed gives the same token everywhere.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// `n` characters of `alphabet`, holding a letter and a digit when the alphabet has both.
    fn draw(&mut self, alphabet: &[u8], n: usize) -> String {
        let mut s: Vec<u8> = (0..n).map(|_| alphabet[(self.next() % alphabet.len() as u64) as usize]).collect();
        let digit = alphabet.iter().copied().find(u8::is_ascii_digit);
        let letter = alphabet.iter().copied().find(u8::is_ascii_alphabetic);
        if let (Some(d), Some(l), true) = (digit, letter, n >= 4) {
            if !s.iter().any(u8::is_ascii_digit) {
                s[n / 2] = d;
            }
            if !s.iter().any(u8::is_ascii_alphabetic) {
                s[n / 3] = l;
            }
        }
        String::from_utf8(s).expect("ascii")
    }
}

fn b64url_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | (b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(URL64[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// A made-up token that pattern `k` of this version matches, from `seed`. `None` for a pattern with no token of its
/// own (13 and 14 match a value by its field: see `value`).
pub fn token(k: u32, seed: u64) -> Option<String> {
    let mut r = Rng(seed);
    let p = |parts: &[&str]| parts.concat();
    Some(match k {
        1 => p(&["AK", "IA"]) + &r.draw(UPPER32, 16),
        2 => p(&["AI", "za"]) + &r.draw(URL64, 35),
        3 => p(&["sk", "_li", "ve_"]) + &r.draw(BASE62, 32),
        4 => p(&["sq0", "csp-"]) + &r.draw(URL64, 43),
        5 => p(&["gh", "p_"]) + &r.draw(BASE62, 36),
        6 => p(&["git", "hub_", "pat_"]) + &r.draw(BASE62, 82),
        7 => p(&["gl", "pat-"]) + &r.draw(BASE62, 24),
        8 => p(&["np", "m_"]) + &r.draw(BASE62, 36),
        9 => p(&["xo", "xb-"]) + &r.draw(DIGITS, 11) + "-" + &r.draw(DIGITS, 12) + "-" + &r.draw(BASE62, 24),
        10 => {
            let label = p(&["PRIV", "ATE ", "KEY"]);
            let body: Vec<String> = (0..4).map(|_| r.draw(STD64, 64)).collect();
            format!("-----BEGIN {label}-----\n{}\n-----END {label}-----\n", body.join("\n"))
        }
        11 => {
            let header = b64url_encode(br#"{"alg":"HS256","typ":"JWT"}"#);
            let claims = b64url_encode(format!(r#"{{"sub":"user-{}","iat":1790000000}}"#, r.draw(DIGITS, 8)).as_bytes());
            format!("{header}.{claims}.{}", r.draw(URL64, 43))
        }
        12 => p(&["Bea", "rer "]) + &r.draw(URL64, 40),
        _ => return None,
    })
}

/// A made-up session value for pattern 13 (a cookie pair) or 14 (a secret-named field's value), from `seed`.
pub fn value(k: u32, seed: u64) -> Option<String> {
    let mut r = Rng(seed ^ 0xd1b5_4a32_d192_ed03);
    match k {
        13 => Some(format!("sid={}", r.draw(BASE62, 32))),
        14 => Some(r.draw(BASE62, 32)),
        _ => None,
    }
}

/// A made-up recipe-shaped body that pattern `k` flags: a field holding the token or value as a constant, where a
/// careless compiler would have left it.
pub fn body(k: u32, seed: u64) -> String {
    let field = |loc: &str, key: &str, v: &str| serde_json::json!({ "from": { "source": "constant", "value": v, "seen_in": null }, "loc": { "in": loc, "key": key } });
    let f = match k {
        13 => field("header", "cookie", &value(13, seed).unwrap_or_default()),
        14 => field("query", "api_key", &value(14, seed).unwrap_or_default()),
        12 => field("header", "x-forwarded-authorization", &token(12, seed).unwrap_or_default()),
        _ => field("query", "q", &token(k, seed).unwrap_or_default()),
    };
    let v = serde_json::json!({ "format": "unbrowse.recipe/1", "site": "api.shop.example", "steps": [{ "fields": [f], "url": "https://api.shop.example/v1/items" }] });
    serde_json::to_string(&v).expect("json")
}
