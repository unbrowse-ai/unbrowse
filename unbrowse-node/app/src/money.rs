//! The Money screen's one reply (`money`): everything in dollars, with USDC doing the work underneath. One balance (the
//! USDC at the node's address, its Settlement deposit, and the owner's account deposit while the owner's account pays
//! for this node's agents), what agents can spend now, the smallest top-up that starts the node, each agent's daily
//! limit and what it spent today, the earnings, and the page that adds funds (`link::fund_page`).
//!
//! Every sum is a decimal string of USDC. The node never offers to withdraw the balance from here: the deposit's
//! withdrawal stays under Advanced. Route coins, per coin, are `coin_holdings`' (`chain::coins::holdings`).

use alloy::primitives::Address;
use serde::Serialize;

use crate::{agents, chain, link, store, St};

#[derive(Serialize, Debug)]
pub struct Money {
    /// The one figure: USDC at the node's address, plus its deposit, plus the owner's account deposit while it pays for
    /// this node's agents, less what agents signed for and the chain hasn't collected yet.
    pub balance: String,
    /// What agents can spend now: the deposits they draw on, and what the node will move in from its address, less
    /// the network fees it keeps there.
    pub available_to_spend: String,
    /// The smallest top-up that starts the node: its registration, the deposit its agents pay from and the network
    /// fees it keeps, less what it holds. "0.00" once it has them, or while payments aren't open.
    pub needed_to_start: String,
    /// Where the owner adds funds (`link::fund_page`); none while payments aren't open.
    pub add_funds_url: Option<String>,
    /// `test` (the devnet: test money), `open`, `not_open` (a live network with no Settlement yet), `offline` or
    /// `starting`.
    pub payments: &'static str,
    /// The balance's parts, for Advanced.
    pub parts: Parts,
    pub agents: Vec<AgentMoney>,
    pub earnings: EarningsMoney,
    /// Each route coin the listing's first buy launched for the owner (`coin_dev_buy_bps`): the UNB it spent, the
    /// coins it bought and the stake it put them in, oldest first. None on a network that isn't open.
    pub first_buys: Vec<crate::chain::coins::FirstBuy>,
}

#[derive(Serialize, Debug, Default)]
pub struct Parts {
    /// USDC at the node's address, of which `kept_for_fees` stays there for network fees.
    pub at_address: String,
    pub kept_for_fees: String,
    /// The node's own Settlement deposit.
    pub deposit: String,
    /// The owner's account deposit, while it pays for one of this node's agents.
    pub account_deposit: Option<String>,
    /// Signed for by agents and not yet collected by the chain.
    pub signed: String,
}

#[derive(Serialize, Debug)]
pub struct AgentMoney {
    pub index: u32,
    pub name: String,
    /// The most it spends a day, and what it spent today.
    pub daily_limit: String,
    pub spent_today: String,
    /// `node`: it pays from this node's balance; `account`: from the owner's account.
    pub pays_from: &'static str,
}

#[derive(Serialize, Debug, Default)]
pub struct EarningsMoney {
    /// Route shares the fetch owes the owner as a contributor, ready to take, in USDC. Claims are paid whole: nothing is
    /// on hold. What staked coins earned is per coin (`coin_holdings`).
    pub available: String,
}

/// What a node needs before its agents can pay, all in USDC: its identity registration (none once registered, or
/// where the chain pays it), the deposit floor its agents pay from, the network fees it keeps at its address, and
/// what it already has towards them.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Start {
    pub registration: f64,
    pub floor: f64,
    pub deposited: f64,
    pub keep: f64,
    pub held: f64,
}

/// The smallest top-up that starts the node, rounded up to the cent: what the deposit lacks of its floor, the fees
/// kept and the registration, less what the address holds. Nothing once it has them.
pub fn needed_to_start(s: Start) -> f64 {
    let need = (s.floor - s.deposited).max(0.0) + s.keep + s.registration - s.held;
    if need <= 1e-9 {
        return 0.0;
    }
    (need * 100.0 - 1e-6).ceil() / 100.0
}

/// A sum of USDC as a decimal string: cents always, and finer only where it has them (USDC has six decimals).
pub fn usdc(x: f64) -> String {
    let x = if x.abs() < 5e-7 { 0.0 } else { x };
    let s = format!("{x:.6}");
    let (whole, frac) = s.split_once('.').unwrap_or((&s, "000000"));
    let frac = frac.trim_end_matches('0');
    format!("{whole}.{frac:0<2}")
}

/// Whether the node can take and make payments: the one answer `chain_status`, `money` and so the window give. The
/// devnet is test mode: its money is minted on this machine. A live network pays for real once it has a Settlement to
/// use; until then payments aren't open there.
pub fn payments(live: bool, up: bool, settlement_missing: bool, error: bool) -> &'static str {
    match (live, up) {
        (false, true) => "test",
        (true, true) => "open",
        (true, false) if settlement_missing => "not_open",
        (_, false) if error => "offline",
        (_, false) => "starting",
    }
}

/// The Money screen's reply for this node.
pub async fn of(node: St<'_>) -> Result<Money, String> {
    let keys = node.key()?;
    let me = chain::owner_address(keys)?;
    let settings = store::load_settings();
    let live = node.chain.network();
    let payments = crate::chain_status(node).payments;
    let all = agents::list();
    let live_keys: Vec<&agents::Agent> = all.iter().filter(|a| !a.revoked && a.expires > store::now()).collect();
    if !matches!(payments, "test" | "open") {
        let agents = live_keys.iter().map(|a| AgentMoney { index: a.index, name: a.name.clone(), daily_limit: usdc(a.cap_usdc), spent_today: usdc(0.0), pays_from: "node" }).collect();
        return Ok(Money {
            balance: usdc(0.0),
            available_to_spend: usdc(0.0),
            needed_to_start: usdc(0.0),
            add_funds_url: None,
            payments,
            parts: Parts::default(),
            agents,
            earnings: EarningsMoney::default(),
            first_buys: Vec::new(),
        });
    }
    let parts = chain::money_parts(&node.chain, keys).await?;
    let epoch = chain::current_epoch(&node.chain).await?;
    let signed = chain::signed_unclaimed(epoch);
    // What each deposit can still pay is less what was signed on that deposit: a key the wallet granted draws on the
    // wallet's, and a line of its is nothing to the node's.
    let signed_here = chain::signed_unclaimed_on(epoch, None);
    // The owner's account deposit counts while it pays for one of this node's agents.
    let account: Option<Address> = live_keys.iter().find_map(|a| a.pays_from());
    let account_deposit = match account {
        Some(w) => Some(chain::spendable_usdc(&node.chain, w).await?),
        None => None,
    };
    // A live network registers the node's identity from its own USDC, once: on the devnet the chain pays.
    let registration = match live {
        Some(_) if crate::erc8004::identity_of(&node.chain, me).await.ok().flatten().is_none() => link::IDENTITY_USDC,
        _ => 0.0,
    };
    let start = Start { registration, floor: settings.deposit_floor_usdc, deposited: parts.spendable, keep: parts.keep, held: parts.held };
    let needed = needed_to_start(start);
    let movable = (parts.held - parts.keep - registration).max(0.0);
    let mut agents = Vec::new();
    for a in &live_keys {
        let spent = chain::agent_spend(&node.chain, keys, a.index, epoch).await.map(|(s, _)| s).unwrap_or(0.0);
        agents.push(AgentMoney {
            index: a.index,
            name: a.name.clone(),
            daily_limit: usdc(a.cap_usdc),
            spent_today: usdc(spent),
            pays_from: if a.pays_from().is_some() { "account" } else { "node" },
        });
    }
    let chain_id = node.chain.chain_id()?;
    let site = link::sites().remove(0);
    let add_funds_url = Some(link::fund_page(&site, &format!("{me:#x}"), chain_id, &usdc(needed), &link::nonce()?));
    let balance = parts.held + parts.deposit - signed + account_deposit.unwrap_or(0.0);
    let on_account = account_deposit.map(|d| (d - chain::signed_unclaimed_on(epoch, account)).max(0.0)).unwrap_or(0.0);
    let available = (parts.spendable - signed_here).max(0.0) + movable + on_account;
    Ok(Money {
        balance: usdc(balance.max(0.0)),
        available_to_spend: usdc(available),
        needed_to_start: usdc(needed),
        add_funds_url,
        payments,
        parts: Parts {
            at_address: usdc(parts.held),
            kept_for_fees: usdc(parts.keep.min(parts.held)),
            deposit: usdc(parts.deposit),
            account_deposit: account_deposit.map(usdc),
            signed: usdc(signed),
        },
        agents,
        earnings: EarningsMoney { available: usdc(parts.owed) },
        first_buys: crate::chain::coins::first_buys(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payments_are_said_one_way() {
        assert_eq!(payments(false, true, false, false), "test");
        assert_eq!(payments(false, false, false, false), "starting");
        assert_eq!(payments(false, false, false, true), "offline");
        assert_eq!(payments(true, true, false, false), "open");
        assert_eq!(payments(true, false, true, true), "not_open", "a live network with no Settlement: nothing is broken");
        assert_eq!(payments(true, false, false, true), "offline");
        assert_eq!(payments(true, false, false, false), "starting", "a live chain not yet read isn't one with payments closed");
    }

    /// The smallest top-up that starts a node covers the deposit floor, the fees it keeps and its registration, less
    /// what it already holds, and is nothing once it has them.
    #[test]
    fn the_smallest_top_up_covers_registration_deposit_and_fees() {
        let fresh = Start { registration: 0.05, floor: 0.5, deposited: 0.0, keep: 0.25, held: 0.0 };
        assert_eq!(needed_to_start(fresh), 0.8);
        assert_eq!(needed_to_start(Start { held: 0.3, ..fresh }), 0.5, "what the address holds counts");
        assert_eq!(needed_to_start(Start { registration: 0.0, deposited: 0.5, held: 0.25, ..fresh }), 0.0, "registered, deposited, fees kept");
        assert_eq!(needed_to_start(Start { registration: 0.0, deposited: 0.2, keep: 0.0, held: 0.0, floor: 0.5 }), 0.3, "the devnet: no fees, no registration");
        assert_eq!(needed_to_start(Start { registration: 0.0, floor: 0.5, deposited: 0.0, keep: 0.0, held: 0.123 }), 0.38, "rounded up to the cent");
    }

    #[test]
    fn sums_are_decimal_strings_of_usdc() {
        assert_eq!(usdc(0.0), "0.00");
        assert_eq!(usdc(5.0), "5.00");
        assert_eq!(usdc(0.8), "0.80");
        assert_eq!(usdc(0.0225), "0.0225");
        assert_eq!(usdc(12.345678), "12.345678");
        assert_eq!(usdc(1e-9), "0.00");
    }

    /// The page that adds funds carries the node, the chain, the smallest top-up and a nonce, in the fragment.
    #[test]
    fn the_add_funds_page_carries_node_chain_min_and_nonce() {
        let url = link::fund_page("https://unbrowse.ai", "0xAbC0000000000000000000000000000000000001", 5042002, "0.80", "n1");
        assert_eq!(url, "https://unbrowse.ai/fund/#node=0xabc0000000000000000000000000000000000001&chain=5042002&min=0.80&nonce=n1");
    }
}
