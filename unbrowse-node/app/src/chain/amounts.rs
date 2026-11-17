//! Sums in whole tokens and in a token's smallest units, and the conversions between them.

use super::*;

// ---- amounts ----
//
// The node holds every sum as a number of whole tokens (`f64`), and the chain as a count of a token's smallest units.
// Each token has its own decimals: Settlement's USDC those its deployment records (Arc's own USDC counts in 6 as an
// ERC-20, a devnet's test USDC in 18), UNB 18, and the chain's native gas 18 (Arc's gas is USDC, 18 decimals at the
// native level). A sum is turned into units by the decimal it is written as, never by multiplying a float, so a
// sum the owner typed or the chain said comes back as the same units every time.

/// The decimals UNB counts in; the node takes no UNB with others (`named`).
pub const UNB_DECIMALS: u8 = 18;
/// The decimals the chain's native gas counts in.
pub const GAS_DECIMALS: u8 = 18;

/// Which way a sum finer than a token's smallest unit goes when it is turned into units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Round {
    Down,
    Up,
}

/// `x` whole tokens as units of a token of `decimals`. A sum that isn't a number above zero is none.
pub(super) fn units(x: f64, decimals: u8, round: Round) -> U256 {
    if !x.is_finite() || x <= 0.0 {
        return U256::ZERO;
    }
    // The shortest decimal that reads back as `x` (Rust never writes it with an exponent): the sum as it was written.
    let written = format!("{x}");
    let (int, frac) = written.split_once('.').unwrap_or((&written, ""));
    let d = usize::from(decimals);
    let (kept, past) = frac.split_at(frac.len().min(d));
    let Ok(mut n) = U256::from_str_radix(&format!("{int}{kept:0<d$}"), 10) else { return U256::MAX };
    if round == Round::Up && past.bytes().any(|b| b != b'0') {
        n = n.saturating_add(U256::from(1u8));
    }
    n
}

/// `x` units of a token of `decimals`, as whole tokens: the nearest number to the decimal they make.
pub(super) fn whole(x: U256, decimals: u8) -> f64 {
    let d = usize::from(decimals);
    let digits = format!("{:0>w$}", x.to_string(), w = d + 1);
    let (int, frac) = digits.split_at(digits.len() - d);
    format!("{int}.{frac}").trim_end_matches('.').parse().unwrap_or(f64::MAX)
}

/// A sum of USDC moved or capped (a deposit, a withdrawal, a key's cap), in units of a USDC of `decimals`: rounded
/// down, so what goes on the chain never passes what the owner set.
pub fn usdc_units(x: f64, decimals: u8) -> U256 {
    units(x, decimals, Round::Down)
}

/// A fee in units of a USDC of `decimals`: rounded up, so a payer never pays less than the fee its contributor set,
/// and a line or voucher for a fee read from the chain is that fee's units exactly.
pub fn usdc_fee_units(x: f64, decimals: u8) -> U256 {
    units(x, decimals, Round::Up)
}

/// Units of a USDC of `decimals`, as whole USDC.
pub fn usdc_f(x: U256, decimals: u8) -> f64 {
    whole(x, decimals)
}

/// A sum of UNB (a witness pledge, a coin buy, the faucet's), in units, rounded down.
pub fn unb_units(x: f64) -> U256 {
    units(x, UNB_DECIMALS, Round::Down)
}

/// Units of UNB, as whole UNB.
pub fn unb_f(x: U256) -> f64 {
    whole(x, UNB_DECIMALS)
}

/// A sum of the chain's native gas, in units, rounded down.
pub fn gas_units(x: f64) -> U256 {
    units(x, GAS_DECIMALS, Round::Down)
}

/// Units of the chain's native gas, as whole coins.
pub fn gas_f(x: U256) -> f64 {
    whole(x, GAS_DECIMALS)
}
