//! Rank by route coins (spec §5.1, §5.2: `rank.score`, `rank.counted-stake`, `rank.exit-delay`, `rank.collateral`,
//! `rank.twap-cap`, `rank.last-out`, `rank.pick`). Every rule here is the client's: the contracts only keep what it
//! reads (`unbrowse-settlement/src/coins/README.md`), and a node that ranks otherwise only picks differently for its own
//! owner. The chain reads that feed it are `chain::coins` (`stake_book`, `market`); this module is plain arithmetic
//! over them, so two nodes reading one chain rank alike.
//!
//! - **Counted stake** (`counted_stake`): a wallet's staked coins in an entry's coin count only when the wallet has
//!   checked the entry (`coin.check`, the contract's `Checked` record) and its own latest paid call on the entry passed
//!   (the contract's latest-passed flag, `LineNoted`; `open.latest-call-rule`). Coins asked back are no longer staked
//!   and count for nothing from the moment they are asked. Each lot counts by its exit delay (`exit_delay_weight`).
//! - **Collateral** `Q`: the counted coins valued at the lower of the coin's time-weighted price over
//!   `RANK_PRICE_WINDOW` and what selling them would return as the last out, after every unstaked coin outside the
//!   curve was sold first (`collateral`).
//! - **Market cap** `M`: the coin's fixed supply at the same time-weighted price.
//! - **Rank** `S = √(Q·M)` (`score`). An entry with no coin, or no counted stake, has no rank.
//! - **The pick** (`order`): entries in proportion to their rank, keeping `EXPLORATION_SHARE` of a read's picks for an
//!   entry with no rank. The pass rate (`rank::reputation`) is still computed and shown, and orders what rank leaves
//!   level; it no longer chooses.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use alloy::primitives::{Address, B256, U256};

pub use super::reputation::EXPLORATION_SHARE;

/// The version of `rank.score` and its pick, `order` (R5.20): two clients on the same version, reading the same chain,
/// score and pick alike. Raised with any change to how an entry is scored or drawn here. Reported beside the pass
/// rate's own (`rank::reputation::VERSION`) wherever an entry's standing is shown (`api::reputation_json`).
pub const VERSION: u32 = 1;

/// `rank.price_window`: the window of the time-weighted price that values stake and the market cap, in seconds (24
/// hours, `protocol/params.toml [rank] price_window`, proposed; `open.rank-window`).
pub const RANK_PRICE_WINDOW: u64 = 24 * 3600;

/// `route_coin.unstake_delay`: the exit delay a client names by default, in seconds (24 hours). The contract's own
/// default for coins a fetch stakes is its `CoinStakes.DEFAULT_DELAY`, which `chain/conform.rs` holds to the same value.
pub const DEFAULT_EXIT_DELAY: u64 = 24 * 3600;

/// The exit delay a stake is weighed against in `exit_delay_weight`: the network's median exit delay as the Quint
/// model fixes it (`coins.qnt` `BG_DELAY`, one day). THE MODEL'S CHOICE, not the spec's: how a delay scales what a stake
/// counts for is open (`open.exit-delay-scale`).
pub const RANK_MEDIAN_DELAY: u64 = 24 * 3600;

/// How much one staked coin with an exit delay of `delay` seconds counts for in rank (`rank.exit-delay`): from 0 for
/// no delay towards 1 for a delay far longer than the median, a half at the median. THE MODEL'S CHOICE
/// (`coins.qnt` `agedOf`: `delay / (delay + median delay)`), kept behind this one function while `open.exit-delay-scale`
/// is open.
pub fn exit_delay_weight(delay: u64) -> f64 {
    exit_delay_weight_against(delay, RANK_MEDIAN_DELAY)
}

/// `exit_delay_weight` against a given median.
pub fn exit_delay_weight_against(delay: u64, median: u64) -> f64 {
    let (d, m) = (delay as f64, median as f64);
    if d + m <= 0.0 {
        return 0.0;
    }
    d / (d + m)
}

/// One of CoinStakes' records as its events say it (`ICoinStakes`): what rank is rebuilt from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StakeEvent {
    /// `Staked(coin, wallet, from, delay, amount)`: coins into the wallet's lot of that exit delay.
    Staked { coin: Address, wallet: Address, delay: u64, amount: U256 },
    /// `UnstakeRequested(coin, wallet, delay, amount, readyAt)`: coins asked back from that lot, no longer staked.
    Unstaked { coin: Address, wallet: Address, delay: u64, amount: U256 },
    /// `Checked(entryId, wallet)`: the wallet checked the entry, once and for good (`coin.check`).
    Checked { entry: B256, wallet: Address },
    /// `LineNoted(entryId, wallet, epoch, passed)`: the wallet's latest paid call on the entry, as the contract kept it.
    /// The contract emits it only when it records it (an earlier epoch never overwrites a later one).
    Noted { entry: B256, wallet: Address, epoch: u64, passed: bool },
}

/// Every wallet's staked lots, checks and latest-passed flags, as CoinStakes' events built them up to block `to`.
#[derive(Clone, Debug, Default)]
pub struct StakeBook {
    /// The last block read into it.
    pub to: u64,
    /// (coin, wallet) → exit delay → coins staked and not asked back.
    pub lots: HashMap<(Address, Address), BTreeMap<u64, U256>>,
    /// coin → every wallet that ever staked in it.
    pub stakers: HashMap<Address, BTreeSet<Address>>,
    pub checked: HashSet<(B256, Address)>,
    /// (entry, wallet) → (epoch, passed) of its latest paid call.
    pub latest: HashMap<(B256, Address), (u64, bool)>,
}

impl StakeBook {
    /// Takes one record, in the chain's order.
    pub fn apply(&mut self, ev: &StakeEvent) {
        match *ev {
            StakeEvent::Staked { coin, wallet, delay, amount } => {
                *self.lots.entry((coin, wallet)).or_default().entry(delay).or_default() += amount;
                self.stakers.entry(coin).or_default().insert(wallet);
            }
            StakeEvent::Unstaked { coin, wallet, delay, amount } => {
                if let Some(lot) = self.lots.get_mut(&(coin, wallet)).and_then(|l| l.get_mut(&delay)) {
                    *lot = lot.saturating_sub(amount);
                }
            }
            StakeEvent::Checked { entry, wallet } => {
                self.checked.insert((entry, wallet));
            }
            StakeEvent::Noted { entry, wallet, epoch, passed } => {
                let kept = self.latest.entry((entry, wallet)).or_insert((epoch, passed));
                if epoch >= kept.0 {
                    *kept = (epoch, passed);
                }
            }
        }
    }

    /// Whether `wallet`'s stake in `entry`'s coin counts (`rank.counted-stake`): it checked the entry and its own latest
    /// paid call on it passed.
    pub fn counts(&self, entry: B256, wallet: Address) -> bool {
        self.checked.contains(&(entry, wallet)) && self.latest.get(&(entry, wallet)).is_some_and(|(_, passed)| *passed)
    }

    /// Coins staked in `coin` by anyone and not asked back, in base units.
    pub fn staked(&self, coin: Address) -> U256 {
        let Some(who) = self.stakers.get(&coin) else { return U256::ZERO };
        who.iter().filter_map(|w| self.lots.get(&(coin, *w))).flat_map(|l| l.values()).fold(U256::ZERO, |a, b| a.saturating_add(*b))
    }

    /// `wallet`'s lots in `coin`: exit delay and coins staked, in base units.
    pub fn lots_of(&self, coin: Address, wallet: Address) -> Vec<(u64, U256)> {
        self.lots.get(&(coin, wallet)).map(|l| l.iter().filter(|(_, a)| !a.is_zero()).map(|(d, a)| (*d, *a)).collect()).unwrap_or_default()
    }
}

/// Whole coins (or UNB) from 18-decimal base units.
pub fn whole(x: U256) -> f64 {
    let u: u128 = x.try_into().unwrap_or(u128::MAX);
    u as f64 / 1e18
}

/// `entry`'s counted stake in `coin`, in whole coins, each lot weighed by its exit delay (`rank.counted-stake`,
/// `rank.exit-delay`).
pub fn counted_stake(book: &StakeBook, entry: B256, coin: Address) -> f64 {
    let Some(who) = book.stakers.get(&coin) else { return 0.0 };
    who.iter()
        .filter(|w| book.counts(entry, **w))
        .flat_map(|w| book.lots_of(coin, *w))
        .map(|(delay, amount)| whole(amount) * exit_delay_weight(delay))
        .sum()
}

/// What a client reads of one coin's market to rank it, in whole coins and UNB.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Market {
    /// The coin's fixed supply (`RouteCoins.SUPPLY`).
    pub supply: f64,
    /// Its time-weighted price over `RANK_PRICE_WINDOW` (or since launch, for a younger coin), UNB a coin.
    pub twap: f64,
    /// What `counted` coins sell for as the last out, before the trade fee: `quoteSell(u + counted) − quoteSell(u)`,
    /// `u` the unstaked coins outside the curve (`rank.last-out`).
    pub last_out: f64,
}

/// What one entry ranks at, and from what.
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct Rank {
    /// Counted stake, in delay-weighted whole coins.
    pub counted: f64,
    /// `Q`, in UNB.
    pub collateral: f64,
    /// `M`, in UNB.
    pub market_cap: f64,
    /// `S = √(Q·M)`, in UNB; 0 is no rank.
    pub score: f64,
    /// The time-weighted price it was valued at, UNB a coin.
    pub twap: f64,
}

/// `Q` (`rank.collateral`, `rank.twap-cap`): the counted coins at the lower of their time-weighted value and their
/// last-out sale value.
pub fn collateral(counted: f64, m: &Market) -> f64 {
    if counted <= 0.0 || !counted.is_finite() {
        return 0.0;
    }
    (counted * m.twap).min(m.last_out).max(0.0)
}

/// `S = √(Q·M)` (`rank.score`): nothing else enters.
pub fn score(counted: f64, m: &Market) -> Rank {
    let q = collateral(counted, m);
    let cap = (m.supply * m.twap).max(0.0);
    let s = (q * cap).sqrt();
    Rank { counted, collateral: q, market_cap: cap, score: if s.is_finite() { s } else { 0.0 }, twap: m.twap }
}

/// A price record's mean over a stretch: `(c1 − c0) / (t1 − t0)` of `RouteCoins.observe`'s running ∫ price dt, which
/// counts UNB a coin scaled by 1e18 times seconds. `None` for no stretch.
pub fn mean_price(c0: U256, t0: u64, c1: U256, t1: u64) -> Option<f64> {
    if t1 <= t0 || c1 < c0 {
        return None;
    }
    Some(whole(c1 - c0) / (t1 - t0) as f64)
}

/// The order to try `found` in for one goal (`rank.pick`, R3.4): `found` comes in the pass rate's order
/// (`rank::reputation::order`). Ranked entries are drawn in proportion to their rank, one after another (`draws.2`
/// feeds each draw); with `reads`, `draws.0` below `EXPLORATION_SHARE` puts one entry with no rank first instead,
/// chosen by `draws.1`, when a ranked one exists to explore away from. Entries with no rank keep the pass rate's order
/// after the ranked ones; with no ranked entry at all, the pass rate's order stands. A demoted entry goes last.
pub fn order<T>(ranks: &HashMap<B256, f64>, found: Vec<T>, entry: impl Fn(&T) -> B256, reads: bool, draws: (f64, f64, &mut dyn FnMut() -> f64), demoted: impl Fn(B256) -> bool) -> super::reputation::Pick<T> {
    let rank_of = |t: &T| ranks.get(&entry(t)).copied().filter(|s| s.is_finite() && *s > 0.0).unwrap_or(0.0);
    let (mut ranked, mut fresh): (Vec<(f64, T)>, Vec<(f64, T)>) = found.into_iter().map(|t| (rank_of(&t), t)).partition(|(s, _)| *s > 0.0);
    let mut order: Vec<T> = Vec::new();
    let mut explored = None;
    if reads && draws.0 < EXPLORATION_SHARE && !ranked.is_empty() && !fresh.is_empty() {
        let k = ((draws.1.clamp(0.0, 1.0) * fresh.len() as f64) as usize).min(fresh.len() - 1);
        let (_, t) = fresh.remove(k);
        explored = Some(entry(&t));
        order.push(t);
    }
    let next = draws.2;
    while !ranked.is_empty() {
        let total: f64 = ranked.iter().map(|(s, _)| *s).sum();
        let mut at = next().clamp(0.0, 1.0) * total;
        let mut chosen = ranked.len() - 1;
        for (k, (s, _)) in ranked.iter().enumerate() {
            if at < *s {
                chosen = k;
                break;
            }
            at -= s;
        }
        order.push(ranked.remove(chosen).1);
    }
    order.extend(fresh.into_iter().map(|(_, t)| t));
    let (keep, failed): (Vec<T>, Vec<T>) = order.into_iter().partition(|t| !demoted(entry(t)));
    if explored.is_some_and(&demoted) {
        explored = None;
    }
    super::reputation::Pick { order: keep.into_iter().chain(failed).collect(), explored }
}

/// Random numbers in [0, 1) for `order`'s draws.
pub fn draw() -> f64 {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("the OS gives no randomness");
    (u64::from_le_bytes(b) >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coin() -> Address {
        Address::repeat_byte(0xc0)
    }
    fn entry() -> B256 {
        B256::repeat_byte(0xe0)
    }
    fn coins(n: u64) -> U256 {
        U256::from(n) * U256::from(10u64).pow(U256::from(18u64))
    }

    #[test]
    fn the_exit_delay_weight_is_the_models_delay_over_delay_plus_the_median() {
        assert_eq!(exit_delay_weight(0), 0.0);
        assert_eq!(exit_delay_weight(RANK_MEDIAN_DELAY), 0.5, "a stake at the median counts half");
        assert!((exit_delay_weight(3600) - 3600.0 / (3600.0 + 86_400.0)).abs() < 1e-12, "an hour: the model's 60/(60+1440)");
        assert!((exit_delay_weight(7 * 86_400) - 7.0 / 8.0).abs() < 1e-12, "a week: 7/8");
        // Longer never counts for less, and never for more than the coins.
        let mut last = 0.0;
        for d in [1u64, 60, 3600, 86_400, 604_800, u32::MAX as u64] {
            let w = exit_delay_weight(d);
            assert!(w >= last && w < 1.0);
            last = w;
        }
    }

    #[test]
    fn a_stake_counts_only_once_checked_and_while_its_latest_call_passed() {
        let (w, other) = (Address::repeat_byte(1), Address::repeat_byte(2));
        let mut b = StakeBook::default();
        b.apply(&StakeEvent::Staked { coin: coin(), wallet: w, delay: RANK_MEDIAN_DELAY, amount: coins(100) });
        b.apply(&StakeEvent::Staked { coin: coin(), wallet: other, delay: RANK_MEDIAN_DELAY, amount: coins(1000) });
        assert_eq!(counted_stake(&b, entry(), coin()), 0.0, "nobody checked");
        b.apply(&StakeEvent::Checked { entry: entry(), wallet: w });
        assert_eq!(counted_stake(&b, entry(), coin()), 0.0, "checked, but no paid call on record");
        b.apply(&StakeEvent::Noted { entry: entry(), wallet: w, epoch: 5, passed: true });
        assert_eq!(counted_stake(&b, entry(), coin()), 50.0, "100 coins at the median delay count half");
        // Its own latest call fails: its stake stops counting, whatever else holds.
        b.apply(&StakeEvent::Noted { entry: entry(), wallet: w, epoch: 6, passed: false });
        assert_eq!(counted_stake(&b, entry(), coin()), 0.0, "the latest call failed");
        // A late claim of an earlier passed line never overwrites the later failure.
        b.apply(&StakeEvent::Noted { entry: entry(), wallet: w, epoch: 5, passed: true });
        assert_eq!(counted_stake(&b, entry(), coin()), 0.0, "an earlier epoch doesn't overwrite a later one");
        b.apply(&StakeEvent::Noted { entry: entry(), wallet: w, epoch: 7, passed: true });
        assert_eq!(counted_stake(&b, entry(), coin()), 50.0, "a later passed call counts it again");
        // The other wallet's latest call passed but it never checked: its stake never counts.
        b.apply(&StakeEvent::Noted { entry: entry(), wallet: other, epoch: 7, passed: true });
        assert_eq!(counted_stake(&b, entry(), coin()), 50.0);
        // A check of another entry is no check of this one.
        b.apply(&StakeEvent::Checked { entry: B256::repeat_byte(0xee), wallet: other });
        assert_eq!(counted_stake(&b, entry(), coin()), 50.0);
    }

    #[test]
    fn coins_asked_back_stop_counting_at_once_and_each_lot_counts_by_its_delay() {
        let w = Address::repeat_byte(1);
        let mut b = StakeBook::default();
        b.apply(&StakeEvent::Checked { entry: entry(), wallet: w });
        b.apply(&StakeEvent::Noted { entry: entry(), wallet: w, epoch: 1, passed: true });
        b.apply(&StakeEvent::Staked { coin: coin(), wallet: w, delay: 3600, amount: coins(150) });
        b.apply(&StakeEvent::Staked { coin: coin(), wallet: w, delay: 7 * 86_400, amount: coins(80) });
        let want = 150.0 * exit_delay_weight(3600) + 80.0 * exit_delay_weight(7 * 86_400);
        assert!((counted_stake(&b, entry(), coin()) - want).abs() < 1e-9);
        b.apply(&StakeEvent::Unstaked { coin: coin(), wallet: w, delay: 7 * 86_400, amount: coins(80) });
        assert!((counted_stake(&b, entry(), coin()) - 150.0 * exit_delay_weight(3600)).abs() < 1e-9, "the week's lot is asked back");
        assert_eq!(b.staked(coin()), coins(150));
        // Splitting one stake into many wallets counts no more than the stake in one (F3).
        let mut split = StakeBook::default();
        for i in 0..10u8 {
            let x = Address::repeat_byte(10 + i);
            split.apply(&StakeEvent::Checked { entry: entry(), wallet: x });
            split.apply(&StakeEvent::Noted { entry: entry(), wallet: x, epoch: 1, passed: true });
            split.apply(&StakeEvent::Staked { coin: coin(), wallet: x, delay: 3600, amount: coins(15) });
        }
        assert!((counted_stake(&split, entry(), coin()) - 150.0 * exit_delay_weight(3600)).abs() < 1e-9);
    }

    #[test]
    fn rank_is_the_root_of_collateral_times_market_cap_with_the_twap_capped_by_the_last_out() {
        let m = Market { supply: 1e9, twap: 0.002, last_out: 1_000.0 };
        // 100,000 counted coins at 0.002 UNB is 200 UNB, under the last-out value: Q = 200.
        let r = score(100_000.0, &m);
        assert_eq!(r.collateral, 200.0);
        assert_eq!(r.market_cap, 2_000_000.0);
        assert!((r.score - (200.0f64 * 2_000_000.0).sqrt()).abs() < 1e-6);
        // A pump that lifts the twap past what the coins would really sell for is capped at the last out (F14).
        let pumped = Market { twap: 0.1, ..m };
        assert_eq!(score(100_000.0, &pumped).collateral, 1_000.0);
        // No counted stake, or no price, is no rank.
        assert_eq!(score(0.0, &m).score, 0.0);
        assert_eq!(score(100_000.0, &Market { twap: 0.0, ..m }).score, 0.0);
    }

    #[test]
    fn a_mean_price_is_the_records_rise_over_the_stretch() {
        let scaled = |p: f64| U256::from((p * 1e18) as u128);
        // 0.002 UNB a coin held for 100 seconds adds 0.2e18.
        assert_eq!(mean_price(U256::ZERO, 0, scaled(0.2), 100), Some(0.002));
        assert_eq!(mean_price(scaled(1.0), 100, scaled(1.0), 100), None, "no stretch");
        assert_eq!(mean_price(scaled(2.0), 0, scaled(1.0), 10), None, "a record never falls");
    }

    fn picks(ranks: &HashMap<B256, f64>, found: &[B256], reads: bool, d0: f64, d1: f64, seq: &[f64]) -> (Vec<B256>, Option<B256>) {
        let mut it = seq.iter().copied().cycle();
        let mut next = move || it.next().unwrap_or(0.0);
        let p = order(ranks, found.to_vec(), |e| *e, reads, (d0, d1, &mut next), |_| false);
        (p.order, p.explored)
    }

    #[test]
    fn the_pick_follows_rank_in_proportion() {
        let (a, b, c) = (B256::repeat_byte(1), B256::repeat_byte(2), B256::repeat_byte(3));
        let ranks: HashMap<B256, f64> = [(a, 1.0), (b, 3.0)].into();
        // Draws past the exploration share: the first draw at 0.1 of 4 lands on a, at 0.5 on b.
        assert_eq!(picks(&ranks, &[a, b, c], true, 0.9, 0.0, &[0.1]).0, vec![a, b, c]);
        assert_eq!(picks(&ranks, &[a, b, c], true, 0.9, 0.0, &[0.5]).0, vec![b, a, c]);
        // Over many draws each ranked entry comes first in proportion to its rank.
        let mut firsts: HashMap<B256, u32> = HashMap::new();
        for k in 0..1000 {
            let x = (k as f64 + 0.5) / 1000.0;
            *firsts.entry(picks(&ranks, &[a, b], false, 0.9, 0.0, &[x]).0[0]).or_default() += 1;
        }
        assert_eq!(firsts[&a], 250);
        assert_eq!(firsts[&b], 750);
    }

    #[test]
    fn the_exploration_share_goes_to_an_entry_with_no_rank() {
        let (a, b, c) = (B256::repeat_byte(1), B256::repeat_byte(2), B256::repeat_byte(3));
        let ranks: HashMap<B256, f64> = [(a, 2.0)].into();
        // Below the share, a read's pick puts an unranked entry first.
        let (o, explored) = picks(&ranks, &[a, b, c], true, EXPLORATION_SHARE - 0.001, 0.7, &[0.0]);
        assert_eq!(o[0], c, "the second of the two unranked, by the draw");
        assert_eq!(explored, Some(c));
        // At or over it, the ranked entry goes first and nothing is explored.
        let (o, explored) = picks(&ranks, &[a, b, c], true, EXPLORATION_SHARE, 0.7, &[0.0]);
        assert_eq!((o[0], explored), (a, None));
        // A write never explores; with no ranked entry the pass rate's order stands.
        assert_eq!(picks(&ranks, &[a, b, c], false, 0.0, 0.7, &[0.0]).1, None);
        assert_eq!(picks(&HashMap::new(), &[c, b], true, 0.0, 0.0, &[0.0]), (vec![c, b], None));
        // Over a run of reads the share is held: exactly the draws below it explore.
        let explored = (0..1000).filter(|k| picks(&ranks, &[a, b], true, (*k as f64 + 0.5) / 1000.0, 0.0, &[0.0]).1.is_some()).count();
        assert_eq!(explored, (EXPLORATION_SHARE * 1000.0) as usize);
    }

    #[test]
    fn a_demoted_entry_goes_last_whatever_its_rank() {
        let (a, b) = (B256::repeat_byte(1), B256::repeat_byte(2));
        let ranks: HashMap<B256, f64> = [(a, 100.0), (b, 1.0)].into();
        let mut next = || 0.0;
        let p = order(&ranks, vec![a, b], |e| *e, false, (0.9, 0.0, &mut next), |e| e == a);
        assert_eq!(p.order, vec![b, a]);
    }
}
