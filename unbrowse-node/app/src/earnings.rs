//! What the wallet earned, by where it came from (route coins, `coin.split`, `coin.holders-share`, `coin.claims`):
//!
//! - **from staking**: USDC its staked, checked coins earned from the fetches on their entries (`coin.fetch-pays`):
//!   what it claimed (`CoinStakes.Claimed`) and what it may claim now (`owedOf`). Claims are paid whole, in USDC: there is no vesting and no bond (`bond.none`).
//! - **as contributor**: route shares `coin.split`'s fallback owed it for lines on its entries that had no coin, or a
//!   part too small to buy (`CoinFetch.ContributorOwed`), what it took (`ContributorPaid`) and what it may take now.
//! - **its routes' use**: the route share its entries' claimed lines sent to their coins, all time. That is the
//!   coins' money, paid to whoever stakes them: this wallet earns from it only what its own stake earns (`coin.split`:
//!   "a wallet earns from a route only what its own stake earns"). The leaderboard ranks by it.
//!
//! A serving node is paid nothing (`fees.server` = 0), and the platform takes no share (`fees.platform` = 0).

use std::collections::{BTreeSet, HashMap};

use alloy::primitives::{Address, FixedBytes, U256};
use alloy::providers::Provider;
use alloy::sol_types::SolEvent;
use serde::Serialize;

use crate::chain::{self, Chain, CoinFetch, CoinStakes, LeanSettlement};
use crate::rpc::ProviderBuilder;

/// One source's earnings, in USDC.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Line {
    /// Earned, all time: claimed and still to claim.
    pub earned: f64,
    /// Taken to the wallet.
    pub claimed: f64,
    /// Waiting on the chain for the wallet to take (`collect_earnings`).
    pub to_claim: f64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Earnings {
    pub staking: Line,
    pub contributor: Line,
    /// The route share the wallet's entries' claimed lines sent to their coins, in USDC: the coins' money, not the
    /// wallet's.
    pub routes_paid: f64,
    /// USDC waiting for the wallet in all.
    pub to_claim: f64,
}

/// The route's share of a claimed line, as `_claim` computes it (`ROUTE_PCT`, `chain::SPLIT.contributor`): what the
/// line sent to its entry's coin.
pub fn route_share(amount: U256) -> U256 {
    amount * U256::from(chain::SPLIT.contributor) / U256::from(100u8)
}

/// Who held an entry's credit at `at` (block, log index), from its `credits` in the order made: the last one at or
/// before it. None for a line older than any credit read.
fn credit_at(credits: &[((u64, u64), Address)], at: (u64, u64)) -> Option<Address> {
    credits.iter().rev().find(|(when, _)| *when <= at).map(|(_, who)| *who)
}

/// One claimed line, as it paid its entry: the line's transaction, the contributor credited with the entry then, and
/// the route share the line sent to the entry's coin (`route_share`).
pub struct Take {
    pub tx: FixedBytes<32>,
    pub contributor: Address,
    pub take: U256,
}

/// Every claimed line of `d` since it was deployed, with the contributor credited then and the route share it sent:
/// the one reading the Wallet screen, the leaderboard and Earnings all show.
pub async fn takes(p: &impl Provider, d: &chain::Deployment) -> Result<Vec<Take>, String> {
    let s = LeanSettlement::new(d.settlement, p);
    let f = alloy::rpc::types::Filter::new().address(d.settlement).event_signature(LeanSettlement::Claimed::SIGNATURE_HASH);
    let credits = chain::credit_history(p, d).await?;
    let mut now: HashMap<FixedBytes<32>, Address> = HashMap::new();
    let mut out = Vec::new();
    for l in chain::logs(p, f, d.block, None).await? {
        let Ok(ev) = LeanSettlement::Claimed::decode_log(&l.inner) else { continue };
        let Some(tx) = l.transaction_hash else { continue };
        #[allow(clippy::map_entry)] // the value is read from the chain between the check and the insert
        if !now.contains_key(&ev.entryId) {
            let en = s.entry(ev.entryId).call().await.map_err(|e| e.to_string())?;
            now.insert(ev.entryId, en.contributor);
        }
        // Credited to whoever held the entry's credit then: a credit that moved since doesn't move what was paid.
        let at = (l.block_number.unwrap_or(0), l.log_index.unwrap_or(0));
        let contributor = credits.get(&ev.entryId).and_then(|c| credit_at(c, at)).unwrap_or(now[&ev.entryId]);
        out.push(Take { tx, contributor, take: route_share(ev.amount) });
    }
    Ok(out)
}

/// What `me` earned, by source (`Earnings`), from the chain's own events and its views now.
pub async fn of(chain: &Chain, me: Address) -> Result<Earnings, String> {
    let d = chain.deployed()?;
    if !d.coins.named() {
        return Err(chain::coins::no_coins());
    }
    let p = ProviderBuilder::new().connect_http(chain::url());
    let e = |x: alloy::contract::Error| x.to_string();
    let mut out = Earnings::default();
    for t in takes(&p, &d).await?.into_iter().filter(|t| t.contributor == me) {
        out.routes_paid += d.usdc_f(t.take);
    }
    // Staking: what it claimed, and what it may claim now, coin by coin.
    let st = CoinStakes::new(d.coins.coin_stakes, &p);
    let mine = |sig: FixedBytes<32>, at: Address| alloy::rpc::types::Filter::new().address(at).event_signature(sig).topic2(me.into_word());
    let mut coins = BTreeSet::new();
    for l in chain::logs(&p, mine(CoinStakes::Claimed::SIGNATURE_HASH, d.coins.coin_stakes), d.block, None).await? {
        let Ok(ev) = CoinStakes::Claimed::decode_log(&l.inner) else { continue };
        out.staking.claimed += d.usdc_f(ev.usdc);
        coins.insert(ev.coin);
    }
    for l in chain::logs(&p, mine(CoinStakes::Staked::SIGNATURE_HASH, d.coins.coin_stakes), d.block, None).await? {
        if let Ok(ev) = CoinStakes::Staked::decode_log(&l.inner) {
            coins.insert(ev.coin);
        }
    }
    for coin in coins {
        let owed = st.owedOf(coin, me).call().await.map_err(e)?;
        out.staking.to_claim += d.usdc_f(owed);
    }
    out.staking.earned = out.staking.claimed + out.staking.to_claim;
    // As contributor: the fetch's fallback, paid out and owed.
    let f = CoinFetch::new(d.coins.coin_fetch, &p);
    let paid = alloy::rpc::types::Filter::new().address(d.coins.coin_fetch).event_signature(CoinFetch::ContributorPaid::SIGNATURE_HASH).topic1(me.into_word());
    for l in chain::logs(&p, paid, d.block, None).await? {
        if let Ok(ev) = CoinFetch::ContributorPaid::decode_log(&l.inner) {
            out.contributor.claimed += d.usdc_f(ev.usdc);
        }
    }
    out.contributor.to_claim = d.usdc_f(f.owedOf(me).call().await.map_err(e)?);
    out.contributor.earned = out.contributor.claimed + out.contributor.to_claim;
    out.to_claim = out.staking.to_claim + out.contributor.to_claim;
    Ok(out)
}

/// Takes everything waiting for the owner's wallet: each coin's earnings (`coins::claim_earned`) and what the fetch owes
/// it as a contributor (`coins::withdraw_owed`). Answers the transactions.
pub async fn collect_all(chain: &Chain, keys: &(dyn unbrowse_core::KeyStore + Sync)) -> Result<Vec<String>, String> {
    let held = chain::coins::holdings(chain, keys).await?;
    let mut txs = Vec::new();
    for h in held.coins {
        if h.owed_usdc <= 0.0 {
            continue;
        }
        let Ok(entry) = h.entry.parse() else { continue };
        txs.push(chain::coins::claim_earned(chain, keys, entry).await?.tx);
    }
    if let Some(tx) = chain::coins::withdraw_owed(chain, keys).await? {
        txs.push(tx);
    }
    Ok(txs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lines_route_share_is_sixty_five_percent_rounded_down() {
        assert_eq!(route_share(U256::from(10_000u64)), U256::from(6_500u64));
        assert_eq!(route_share(U256::from(1u64)), U256::ZERO, "the burn takes the rounding");
        assert_eq!(route_share(U256::from(99u64)), U256::from(64u64));
    }

    #[test]
    fn a_line_is_credited_to_whoever_held_the_credit_then() {
        let (a, b) = (Address::repeat_byte(1), Address::repeat_byte(2));
        let credits = [((10, 0), a), ((20, 3), b)];
        assert_eq!(credit_at(&credits, (5, 0)), None);
        assert_eq!(credit_at(&credits, (10, 0)), Some(a));
        assert_eq!(credit_at(&credits, (20, 2)), Some(a));
        assert_eq!(credit_at(&credits, (20, 3)), Some(b));
    }
}
