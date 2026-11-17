//! The randomness threshold (R6.36): a format match counts only when its random part looks drawn at random. The measure
//! is the Shannon entropy of the part's bytes, in millibits per byte, computed with integers alone so that every
//! platform, the zkVM guest included, gets the same number for the same bytes.

/// `log2(x)` in Q16.16 fixed point, for `x >= 1`: the integer part from the highest set bit, the fraction by squaring
/// the normalised mantissa sixteen times.
fn log2_q16(x: u64) -> u64 {
    debug_assert!(x >= 1);
    let ip = 63 - x.leading_zeros() as u64;
    // The mantissa in [1, 2) as Q32: one is 2^32.
    let mut m: u128 = if ip >= 32 { (x >> (ip - 32)) as u128 } else { (x << (32 - ip)) as u128 };
    let mut frac: u64 = 0;
    for i in 0..16 {
        m = (m * m) >> 32;
        if m >= 1u128 << 33 {
            m >>= 1;
            frac |= 1 << (15 - i);
        }
    }
    (ip << 16) | frac
}

/// The Shannon entropy of `s`'s bytes, in millibits per byte (an even spread over 64 symbols is 6,000). Empty is zero.
pub fn entropy_millibits(s: &[u8]) -> u32 {
    let n = s.len() as u64;
    if n == 0 {
        return 0;
    }
    let mut counts = [0u64; 256];
    for &b in s {
        counts[b as usize] += 1;
    }
    // H = log2(n) - (1/n) * sum(c * log2 c)
    let sum: u64 = counts.iter().filter(|&&c| c > 1).map(|&c| c * log2_q16(c)).sum();
    let h_q16 = log2_q16(n).saturating_sub(sum / n);
    ((h_q16 * 1000) >> 16) as u32
}

/// Whether `s` has at least one ASCII letter and one ASCII digit: a key drawn at random from letters and digits almost
/// always has both, and a word, a name or a number has only one kind.
pub fn mixed(s: &[u8]) -> bool {
    s.iter().any(u8::is_ascii_alphabetic) && s.iter().any(u8::is_ascii_digit)
}

/// The longest run of one byte repeated in `s`.
pub fn longest_run(s: &[u8]) -> usize {
    let (mut best, mut run) = (0, 0);
    for (i, b) in s.iter().enumerate() {
        run = if i > 0 && s[i - 1] == *b { run + 1 } else { 1 };
        best = best.max(run);
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log2_is_exact_on_powers_and_close_between() {
        for k in 0..40u64 {
            assert_eq!(log2_q16(1 << k), k << 16);
        }
        // log2(3) = 1.58496...: within one part in 2^15.
        let got = log2_q16(3) as f64 / 65536.0;
        assert!((got - 1.584_962_5).abs() < 1.0 / 32768.0, "{got}");
    }

    #[test]
    fn entropy_reads_spread_not_length() {
        assert_eq!(entropy_millibits(b""), 0);
        assert_eq!(entropy_millibits(b"aaaaaaaaaaaaaaaa"), 0);
        assert_eq!(entropy_millibits(b"abababababababab"), 1000);
        assert_eq!(entropy_millibits(b"0123456789abcdef"), 4000);
        let all: Vec<u8> = (0u8..64).collect();
        assert_eq!(entropy_millibits(&all), 6000);
    }

    #[test]
    fn runs_and_mixing() {
        assert_eq!(longest_run(b"abcccd"), 3);
        assert!(mixed(b"a1") && !mixed(b"abc") && !mixed(b"123"));
    }
}
