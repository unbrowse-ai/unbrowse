//! A format pattern: a byte regex for a known key format, matched anywhere in the bytes, and the randomness its random
//! part must reach for the match to count.

use regex::bytes::Regex;

use crate::{exclude, random};

/// One known key format.
pub struct Format {
    /// The pattern's number `k` in this detector version: what a leak proof names. Never reused.
    pub id: u32,
    pub name: &'static str,
    /// What kind of credential it is: cloud, payment, code host, chat, private key, session.
    pub family: &'static str,
    /// A byte regex, Unicode off. Group `t` is the whole token, group `r` its random part. A token is never part of a
    /// longer run of letters and digits: the bytes either side of `t` must not be ASCII letters or digits.
    pub regex: &'static str,
    /// The random part's entropy must reach this many millibits per byte.
    pub min_millibits: u32,
    /// The random part must hold both letters and digits.
    pub mixed: bool,
    /// What the random part's randomness is measured over: the bytes `keep` keeps (all of them when `None`).
    pub keep: Option<fn(u8) -> bool>,
    /// The fewest bytes `keep` must leave.
    pub min_kept: usize,
    /// A check of the whole token beyond its shape (a token's own structure), when the format has one.
    pub check: Option<fn(&[u8]) -> bool>,
}

fn alnum(b: Option<&u8>) -> bool {
    b.is_some_and(u8::is_ascii_alphanumeric)
}

impl Format {
    pub fn compile(&self) -> Regex {
        Regex::new(self.regex).expect("a pinned pattern compiles")
    }

    /// Whether the token `t` with random part `r` counts as a leak under this format.
    fn counts(&self, t: &[u8], r: &[u8]) -> bool {
        let kept: Vec<u8> = match self.keep {
            Some(keep) => r.iter().copied().filter(|b| keep(*b)).collect(),
            None => r.to_vec(),
        };
        kept.len() >= self.min_kept
            && random::entropy_millibits(&kept) >= self.min_millibits
            && (!self.mixed || random::mixed(&kept))
            && !exclude::excluded(t)
            && self.check.is_none_or(|c| c(t))
    }

    /// The first token in `text` that counts, as its byte range.
    pub fn find(&self, re: &Regex, text: &[u8]) -> Option<(usize, usize)> {
        let mut at = 0;
        while at <= text.len() {
            let c = re.captures_at(text, at)?;
            let t = c.name("t").expect("every pattern names its token");
            let r = c.name("r").map(|m| m.as_bytes()).unwrap_or(t.as_bytes());
            let bounded = !alnum(t.start().checked_sub(1).and_then(|i| text.get(i))) && !alnum(text.get(t.end()));
            if bounded && self.counts(t.as_bytes(), r) {
                return Some((t.start(), t.end()));
            }
            at = t.start() + 1;
        }
        None
    }
}
