//! Bounties as limit orders (spec ch. 8, `CoinBounties.sol`): UNB posted for a site that has no route yet, released by
//! its poster's confirmation after the poster's own paid call on an entry of the site counted (`coin.bounty-confirm`),
//! or, after its deadline, by the use other wallets made of the site's entries while it was open, at most
//! `route_coin.bounty_use_cap` of what those lines paid (`coin.bounty-by-use`). A release buys the entry's coin at once
//! on its curve within the poster's limit price, fees and tax included (`coin.bounty-limit`, `-no-slicing`); half the
//! coins are staked for the credited contributor and the rest for the poster. A bounty never launches a coin: a
//! confirmation for an entry with no coin is refused, and a release by use gives the share of an entry that had no
//! coin when the bounty was settled to the poster. What doesn't fill, what nobody's use reserved, and the share of an
//! entry with no coin at settle, is the poster's to take back (`refund`).
//!
//! A bounty names its site by the hash Settlement's entries carry (`listing::domain_hash`, `open.coin-bounty-site`).
//! The poster's confirmation needs the poster's own counting line on the entry, so a bounty the owner's key posts is
//! confirmed by a call paid from the node's own deposit: a line paid from a granted wallet is that wallet's.
//!
//! Every write is signed by the owner's root key. A post and a confirmation must not go twice (`inflight`); the rest
//! are made again safely. The node's own steps (asking its agent, confirming on the owner's yes, settling and taking
//! back after the deadline) are `autobounty`'s.

use std::collections::BTreeMap;

use alloy::sol_types::SolEvent;

use super::*;
use super::coins::CoinBounties;
use crate::inflight;

/// The most a confirmation of `budget` UNB pays a coin (`CoinBounties.confirm`'s `maxCost`, scaled by 1e18 as a limit
/// is): the price per coin of the curve's quote for the whole budget, `quoted` coins, with `TRADE_SLIPPAGE_BPS` fewer
/// (`coins::at_least`), rounded up. A price pushed ahead of the confirmation in its block makes it revert
/// (`CostAboveMax`) instead of filling (red L-2). With nothing quoted there is nothing to bound: the contract refuses
/// that confirmation on its own (`NoCoin`, `NothingFills`).
pub fn max_cost(budget: U256, quoted: U256) -> U256 {
    let least = super::coins::at_least(quoted);
    if least.is_zero() {
        return U256::MAX;
    }
    (budget * U256::from(1_000_000_000_000_000_000u128)).div_ceil(least)
}

/// What a confirmation refused for its price says, wherever it reaches the poster: the command's answer and the
/// node's activity.
pub const PRICE_MOVED: &str = "price moved: wait, or post the bounty again with a limit";

/// What the poster is told when the node won't confirm on its own: no cap was kept from the owner's yes, because the
/// entry's coin wasn't trading then (policy 1b).
pub const NEEDS_HAND: &str = "needs a hand confirm (`bounty confirm`), or post the bounty again with a limit";

/// The most a confirmation of bounty `id` for `entry` would pay a coin if sent now (`max_cost` of the curve's quote for
/// the whole bounty), or None while there is nothing to fix it from: no coin yet, a coin still in its snipe window
/// (whose quote carries the tax), or a quote of nothing. The node fixes this once, when the owner allows the
/// confirmation, and never quotes higher on a retry (red L-4).
pub async fn bounty_confirm_cap(chain: &Chain, id: u64, entry: FixedBytes<32>) -> Result<Option<U256>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let amount = CoinBounties::new(bounties_of(&d)?, &p).bountyOf(U256::from(id)).call().await.map_err(|e| e.to_string())?.amount;
    let rc = RouteCoins::new(d.coins.route_coins, &p);
    let coin = rc.coinOf(entry).call().await.map_err(|e| e.to_string())?;
    if coin.is_zero() || !rc.snipeTaxBps(coin).call().await.map_err(|e| e.to_string())?.is_zero() {
        return Ok(None);
    }
    let quoted = rc.quoteBuy(coin, amount).call().await.map_err(|e| e.to_string())?.coinsOut;
    Ok(if quoted.is_zero() { None } else { Some(max_cost(amount, quoted)) })
}

/// What a confirmation refused for its price (`CostAboveMax`) says: the bound it was held to, which was fixed when the
/// confirmation was allowed only if a cap was kept then; otherwise it was the quote when it was sent (blue B-2).
pub fn price_moved_error(id: u64, entry: &FixedBytes<32>, most: U256, capped: bool) -> String {
    let bound = if capped { "a bound fixed when it was allowed and never raised for a retry" } else { "the quote when it was sent, with the 1% slippage" };
    format!("bounty #{id} wasn't confirmed for entry {entry:#x}: {PRICE_MOVED} (the coin costs more now than the {} UNB a coin this confirmation may pay: {bound})", unb_f(most))
}

/// What a confirmation sends as its `maxCost`: the cap fixed when it was allowed, or the fresh quote's bound if that is
/// lower; never more than the cap, so a retry can't pay a price pushed since (red L-4).
pub fn confirm_cost(cap: Option<U256>, fresh: U256) -> U256 {
    cap.map_or(fresh, |c| c.min(fresh))
}

/// How long a bounty stays open by default when the owner names no deadline, in seconds: 30 days.
pub const BOUNTY_OPEN: u64 = 30 * 86_400;

/// A bounty's limit price as the contract takes it: UNB a coin, scaled by 1e18, fees and tax included; zero buys at
/// market (`coin.bounty-limit`).
pub fn limit_units(limit: Option<f64>) -> Result<U256, String> {
    match limit {
        None => Ok(U256::ZERO),
        Some(l) if l.is_finite() && l > 0.0 => Ok(unb_units(l)),
        Some(l) => Err(format!("a limit price is some UNB a coin above zero, or none to buy at market; {l} isn't")),
    }
}

/// Where a bounty stands at time `now` (seconds): open until its deadline, then waiting to be settled; confirmed once
/// its poster released it; settled once its use is fixed.
pub fn state_of(b: &BountyView, now: u64) -> &'static str {
    match () {
        _ if b.confirmed => "confirmed",
        _ if b.settled => "settled",
        _ if now <= b.deadline => "open",
        _ => "to settle",
    }
}

/// A bounty, as the owner reads it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BountyView {
    pub id: u64,
    pub poster: String,
    pub mine: bool,
    /// The site's hash, as entries carry it, and its name when the node knows a site of that hash.
    pub site: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    /// UNB it still holds for buying.
    pub amount: f64,
    /// The most it pays a coin, UNB, fees and tax included; none buys at market.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_price: Option<f64>,
    /// When it was posted, and the last time it may be confirmed (timestamps).
    pub posted_at: u64,
    pub deadline: u64,
    pub confirmed: bool,
    pub settled: bool,
    /// After settling: UNB set aside for release by use, and the USDC the site's counting lines paid while it was open.
    pub reserved: f64,
    pub use_usdc: f64,
    /// What the poster may take back now.
    pub refundable: f64,
    /// "open", "to settle", "confirmed" or "settled".
    pub state: String,
}

/// What a bounty write did.
#[derive(Clone, Debug, Serialize)]
pub struct BountyDone {
    pub tx: String,
    pub id: u64,
}

fn bounties_of(d: &Deployment) -> Result<Address, String> {
    if d.coins.coin_bounties == Address::ZERO {
        return Err(super::coins::no_coins());
    }
    Ok(d.coins.coin_bounties)
}

/// Posts `amount` of the owner's UNB for `site` (`coin.bounty-launch`), with a limit price per coin (`None`: market)
/// and a deadline `open_for` seconds from now. One post a site may be out at a time (`inflight`).
pub async fn bounty_post(chain: &Chain, keys: &(dyn KeyStore + Sync), site: &str, amount: f64, limit: Option<f64>, open_for: u64) -> Result<BountyDone, String> {
    use crate::inflight::Settled;
    let d = chain.deployed()?;
    let b = bounties_of(&d)?;
    let name = unbrowse_learn::identity::site_of(site.trim()).to_ascii_lowercase();
    if name.is_empty() {
        return Err("name the site the bounty is for (example.com)".into());
    }
    if !(amount > 0.0) || !amount.is_finite() {
        return Err("a bounty is some UNB above zero".into());
    }
    if open_for == 0 {
        return Err("a bounty stays open for some time: name how long".into());
    }
    let limit = limit_units(limit)?;
    let hash = domain_hash(&name);
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let key = format!("bounty post {hash:#x}");
    match inflight::settle(&p, &key).await? {
        Settled::Clear => {}
        Settled::Waiting(s) => return Err(format!("an earlier bounty post for {name} ({:#x}) isn't mined yet, so nothing more was sent: the node looks at it again each pass", s.tx)),
        Settled::Landed(_, r) => {
            inflight::done(&key)?;
            return Err(format!("an earlier bounty post for {name} landed ({}); ask again for another", tx_hash(&r)));
        }
    }
    let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.map(|b| b.header.timestamp).unwrap_or(0);
    crate::rpc::once_allowed()?;
    let units = unb_units(amount);
    approve(&p, &d, b, d.unb, me, units).await?;
    let bt = CoinBounties::new(b, &p);
    let call = bt.post(hash, units, limit, now + open_for);
    let watch = (b, bt.bountyCount().calldata().clone());
    let sent: Result<_, String> = async { Ok(crate::rpc::once!(call, &key, amount, None, watch, "posting a bounty")) }.await;
    if sent.as_ref().err().is_none_or(|e| !crate::rpc::unsettled(e)) {
        take_back_allowance(&p, b, d.unb, me).await?;
    } else {
        note_pending_reset(b, d.unb, "the bounty post it was for may still land")?;
    }
    let receipt = sent?;
    inflight::done(&key)?;
    if !receipt.status() {
        return Err("posting the bounty was reverted".into());
    }
    let id = receipt
        .inner
        .logs()
        .iter()
        .find_map(|l| CoinBounties::Posted::decode_log(&l.inner).ok().map(|ev| ev.id.to::<u64>()))
        .ok_or("the post landed but named no bounty")?;
    let tx = tx_hash(&receipt);
    log("Posted a bounty", "bounty", Some(amount), &tx, Some(format!("#{id} for {name}: released by your confirmation after your own paid call on an entry there, or by use after its deadline")));
    Ok(BountyDone { tx, id })
}

/// The bounty `id` as the chain holds it now, for the owner `me`.
async fn view(p: &impl Provider, d: &Deployment, id: u64, me: Address, names: &BTreeMap<FixedBytes<32>, String>, now: u64) -> Result<BountyView, String> {
    let bt = CoinBounties::new(bounties_of(d)?, p);
    let e = |e: alloy::contract::Error| e.to_string();
    let x = bt.bountyOf(U256::from(id)).call().await.map_err(e)?;
    let refundable = bt.refundableOf(U256::from(id)).call().await.map_err(e)?;
    let mut v = BountyView {
        id,
        poster: format!("{:#x}", x.poster),
        mine: x.poster == me,
        site: format!("{:#x}", x.site),
        site_name: names.get(&x.site).cloned(),
        amount: unb_f(x.amount),
        limit_price: (!x.limitPrice.is_zero()).then(|| unb_f(x.limitPrice)),
        posted_at: x.postedAt,
        deadline: x.deadline,
        confirmed: x.confirmed,
        settled: x.settled,
        reserved: unb_f(x.reserved),
        use_usdc: d.usdc_f(x.useUsdc),
        refundable: unb_f(refundable),
        state: String::new(),
    };
    v.state = state_of(&v, now).into();
    Ok(v)
}

/// The sites the node knows by their hash: those of its own routes and of the entries it holds listings of.
fn site_names(chain: &Chain) -> BTreeMap<FixedBytes<32>, String> {
    let mut out = BTreeMap::new();
    for r in store::load_routes() {
        let s = unbrowse_learn::identity::site_of(&r.site).to_ascii_lowercase();
        if !s.is_empty() {
            out.insert(domain_hash(&s), s);
        }
    }
    if let Ok(d) = chain.deployed() {
        for (site, _) in crate::listing::held_names(&d).into_values() {
            let s = unbrowse_learn::identity::site_of(&site).to_ascii_lowercase();
            if !s.is_empty() {
                out.insert(domain_hash(&s), s);
            }
        }
    }
    out
}

/// Every bounty posted on this deployment, newest first; `mine` keeps the owner's own.
pub async fn bounty_list(chain: &Chain, keys: &(dyn KeyStore + Sync), mine: bool) -> Result<Vec<BountyView>, String> {
    let d = chain.deployed()?;
    let b = bounties_of(&d)?;
    let me = owner_signer(keys)?.address();
    let p = ProviderBuilder::new().connect_http(url());
    let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.map(|b| b.header.timestamp).unwrap_or(0);
    let mut f = alloy::rpc::types::Filter::new().address(b).event_signature(CoinBounties::Posted::SIGNATURE_HASH);
    if mine {
        f = f.topic2(me.into_word());
    }
    let names = site_names(chain);
    let mut out = Vec::new();
    for l in logs(&p, f, d.block, None).await? {
        let Ok(ev) = CoinBounties::Posted::decode_log(&l.inner) else { continue };
        out.push(view(&p, &d, ev.id.to::<u64>(), me, &names, now).await?);
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.id));
    Ok(out)
}

/// One bounty.
pub async fn bounty_show(chain: &Chain, keys: &(dyn KeyStore + Sync), id: u64) -> Result<BountyView, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.map(|b| b.header.timestamp).unwrap_or(0);
    let count = CoinBounties::new(bounties_of(&d)?, &p).bountyCount().call().await.map_err(|e| e.to_string())?;
    if U256::from(id) >= count {
        return Err(format!("there's no bounty #{id}"));
    }
    view(&p, &d, id, owner_signer(keys)?.address(), &site_names(chain), now).await
}

/// The owner's confirmation of its bounty `id` for `entry` (`coin.bounty-confirm`): it buys the entry's coin at once
/// within the bounty's limit and at most the curve's quote with the trade slippage (`max_cost`), half the coins staked
/// for the entry's contributor and half for the owner. Only once the
/// owner's own paid call on the entry counted (claimed as a counting line since the bounty was posted), and only for an
/// entry whose coin is launched (a bounty never launches one, `NoCoin`): the contract refuses it otherwise, and the
/// node asks it first, so a refusal costs nothing. Never twice (`inflight`).
pub async fn bounty_confirm(chain: &Chain, keys: &(dyn KeyStore + Sync), id: u64, entry: FixedBytes<32>, cap: Option<U256>) -> Result<BountyDone, String> {
    use crate::inflight::Settled;
    let d = chain.deployed()?;
    let b = bounties_of(&d)?;
    let p = as_signer(owner_signer(keys)?).await?;
    let me = p.default_signer_address();
    let bt = CoinBounties::new(b, &p);
    let x = bt.bountyOf(U256::from(id)).call().await.map_err(|e| e.to_string())?;
    if x.poster != me {
        return Err(format!("bounty #{id} isn't this wallet's: only its poster confirms it"));
    }
    let key = format!("bounty confirm {id}");
    match inflight::settle(&p, &key).await? {
        Settled::Clear => {}
        Settled::Waiting(s) => return Err(format!("an earlier confirmation of bounty #{id} ({:#x}) isn't mined yet", s.tx)),
        Settled::Landed(_, r) => {
            inflight::done(&key)?;
            return Ok(BountyDone { tx: tx_hash(&r), id });
        }
    }
    let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.map(|b| b.header.timestamp).unwrap_or(0);
    // The most it pays a coin: the curve's quote for the whole bounty now, with the trade slippage (`max_cost`), and
    // never more than the cap fixed when the confirmation was allowed (`confirm_cost`).
    let rc = RouteCoins::new(d.coins.route_coins, &p);
    let coin = rc.coinOf(entry).call().await.map_err(|e| e.to_string())?;
    let quoted = if coin.is_zero() { U256::ZERO } else { rc.quoteBuy(coin, x.amount).call().await.map_err(|e| e.to_string())?.coinsOut };
    let most = confirm_cost(cap, max_cost(x.amount, quoted));
    let call = bt.confirm(U256::from(id), entry, U256::from(now + super::coins::TRADE_DEADLINE), most);
    call.call().await.map_err(|e| {
        use alloy::sol_types::SolError;
        if e.as_revert_data().is_some_and(|d| d.starts_with(&CoinBounties::CostAboveMax::SELECTOR)) {
            price_moved_error(id, &entry, most, cap.is_some())
        } else {
            format!("bounty #{id} can't be confirmed for entry {entry:#x} now (it needs your own paid call on that entry, claimed since the bounty was posted, the entry's coin launched and past its snipe window, and a fill within its limit): {e}")
        }
    })?;
    crate::rpc::once_allowed()?;
    let call = match super::gas::swap_limit(&call).await { Some(g) => call.gas(g), None => call };
    let watch = (b, bt.bountyOf(U256::from(id)).calldata().clone());
    let receipt = crate::rpc::once!(call, &key, unb_f(x.amount), None, watch, "confirming a bounty");
    inflight::done(&key)?;
    if !receipt.status() {
        return Err(format!("confirming the bounty was reverted: if the coin's price moved while it was sent, {PRICE_MOVED}"));
    }
    let tx = tx_hash(&receipt);
    log("Confirmed a bounty", "bounty", Some(unb_f(x.amount)), &tx, Some(format!("#{id} bought entry {entry:#x}'s coin, staked half for its contributor and half for you")));
    Ok(BountyDone { tx, id })
}

/// Fixes, after its deadline, what bounty `id` releases by use (`CoinBounties.settle`): anyone may.
pub async fn bounty_settle(chain: &Chain, keys: &(dyn KeyStore + Sync), id: u64) -> Result<BountyDone, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let bt = CoinBounties::new(bounties_of(&d)?, &p);
    let call = bt.settle(U256::from(id));
    call.call().await.map_err(|e| format!("bounty #{id} can't be settled now (only after its deadline, once): {e}"))?;
    let tx = send!(call, "settling a bounty");
    log("Settled a bounty", "bounty", None, &tx, Some(format!("#{id}: what its site's use released is set aside, the rest is the poster's")));
    Ok(BountyDone { tx, id })
}

/// Releases `entry`'s share of settled bounty `id` by use (`CoinBounties.releaseByUse`): anyone may. It buys only at a
/// steady price (within the drift of the coin's mean and of its settled price, as a fetch's buy), so a call refused for
/// that is one to make again later; and what the bounty's limit doesn't fill stays the entry's for a later call
/// (`bounty_share_left`). The share of an entry with no coin at settle goes to the poster instead: a bounty never
/// launches one.
pub async fn bounty_release_by_use(chain: &Chain, keys: &(dyn KeyStore + Sync), id: u64, entry: FixedBytes<32>) -> Result<BountyDone, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let bt = CoinBounties::new(bounties_of(&d)?, &p);
    let call = bt.releaseByUse(U256::from(id), entry);
    call.call().await.map_err(|e| format!("entry {entry:#x} has nothing of bounty #{id} to release now (a release buys only at a steady price and within the bounty's limit, and is tried again later): {e}"))?;
    let call = match super::gas::swap_limit(&call).await { Some(g) => call.gas(g), None => call };
    let tx = send!(call, "releasing a bounty by use");
    log("Released a bounty by use", "bounty", None, &tx, Some(format!("#{id}: entry {entry:#x}'s share of its site's use is released: it bought the entry's coin, or, with no coin at settle, went to the poster")));
    Ok(BountyDone { tx, id })
}

/// Takes back what is the owner's of its bounty `id` (`CoinBounties.refund`): what a confirmation didn't fill, and after
/// settling what nobody's use reserved. Settles first when due. A second takes nothing.
pub async fn bounty_refund(chain: &Chain, keys: &(dyn KeyStore + Sync), id: u64) -> Result<BountyDone, String> {
    let d = chain.deployed()?;
    let p = as_signer(owner_signer(keys)?).await?;
    let bt = CoinBounties::new(bounties_of(&d)?, &p);
    let call = bt.refund(U256::from(id));
    let back = call.call().await.map_err(|e| format!("nothing of bounty #{id} is yours to take back now: {e}"))?;
    let tx = send!(call, "taking back a bounty");
    log("Took back a bounty", "bounty", Some(unb_f(back)), &tx, Some(format!("#{id}: what no confirmation filled and no use reserved")));
    Ok(BountyDone { tx, id })
}

/// Whether a later release can still fill some of `entry`'s share of bounty `id`: what its releases so far left unfilled
/// at the bounty's limit (`CoinBounties.shareLeftOf`).
pub async fn bounty_share_left(chain: &Chain, id: u64, entry: FixedBytes<32>) -> Result<bool, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let left = CoinBounties::new(bounties_of(&d)?, &p).shareLeftOf(U256::from(id), entry).call().await.map_err(|e| e.to_string())?;
    Ok(!left.is_zero())
}

/// Whether settled bounty `id` found `entry`'s coin launched when it was settled (`CoinBounties.coinAtSettle`): only
/// then does a release by use buy for the entry; otherwise its share is the poster's.
pub async fn bounty_coin_at_settle(chain: &Chain, id: u64, entry: FixedBytes<32>) -> Result<bool, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    CoinBounties::new(bounties_of(&d)?, &p).coinAtSettle(U256::from(id), entry).call().await.map_err(|e| e.to_string())
}

/// When `payer`'s latest counting line on `entry` was claimed, while a bounty for its site was open: the chain's
/// timestamp (`CoinBounties.lastCounted`), 0 for none. A bounty posted before it can be confirmed by `payer`.
pub async fn bounty_last_counted(chain: &Chain, entry: FixedBytes<32>, payer: Address) -> Result<u64, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    CoinBounties::new(bounties_of(&d)?, &p).lastCounted(entry, payer).call().await.map_err(|e| e.to_string())
}

/// The entries of the bounty's site this node knows of that a use counted for while it was open, by the USDC
/// `CoinBounties.useOf` reads: those `releaseByUse` releases a share to.
pub async fn bounty_used_entries(chain: &Chain, id: u64) -> Result<Vec<(FixedBytes<32>, f64)>, String> {
    let d = chain.deployed()?;
    let p = ProviderBuilder::new().connect_http(url());
    let bt = CoinBounties::new(bounties_of(&d)?, &p);
    let x = bt.bountyOf(U256::from(id)).call().await.map_err(|e| e.to_string())?;
    let s = LeanSettlement::new(d.settlement, &p);
    let mut out = Vec::new();
    for (entry, _, _) in super::discovery::credited(&p, &d, d.block, None).await? {
        if s.entry(entry).call().await.map_err(|e| e.to_string())?.domainHash != x.site {
            continue;
        }
        let used = bt.useOf(U256::from(id), entry).call().await.map_err(|e| e.to_string())?;
        if !used.is_zero() {
            out.push((entry, d.usdc_f(used)));
        }
    }
    Ok(out)
}

/// Every bounty on this deployment, read at once for the owner `me`: what the node's own steps are decided from
/// (`autobounty`). `None` when the deployment has no coin contracts.
pub async fn bounty_board(chain: &Chain, me: Address) -> Result<Option<Board>, String> {
    let d = chain.deployed()?;
    if !d.coins.named() {
        return Ok(None);
    }
    let p = ProviderBuilder::new().connect_http(url());
    let now = p.get_block_by_number(alloy::eips::BlockNumberOrTag::Latest).await.map_err(|e| e.to_string())?.map(|b| b.header.timestamp).unwrap_or(0);
    let f = alloy::rpc::types::Filter::new().address(d.coins.coin_bounties).event_signature(CoinBounties::Posted::SIGNATURE_HASH);
    let names = site_names(chain);
    let mut board = Board { bounties: Vec::new() };
    for l in logs(&p, f, d.block, None).await? {
        let Ok(ev) = CoinBounties::Posted::decode_log(&l.inner) else { continue };
        board.bounties.push(view(&p, &d, ev.id.to::<u64>(), me, &names, now).await?);
    }
    Ok(Some(board))
}

/// Every bounty, as the owner `bounty_board` was read for sees it, for the node's own steps.
#[derive(Clone, Debug, Default)]
pub struct Board {
    pub bounties: Vec<BountyView>,
}

impl Board {
    /// The owner's own bounties.
    pub fn mine(&self) -> impl Iterator<Item = &BountyView> + '_ {
        self.bounties.iter().filter(|b| b.mine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_limit_is_unb_a_coin_or_market() {
        assert_eq!(limit_units(None), Ok(U256::ZERO), "no limit buys at market");
        assert_eq!(limit_units(Some(0.5)), Ok(unb_units(0.5)));
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(limit_units(Some(bad)).is_err(), "{bad}");
        }
    }

    fn bounty(deadline: u64) -> BountyView {
        BountyView {
            id: 0,
            poster: String::new(),
            mine: true,
            site: String::new(),
            site_name: None,
            amount: 1.0,
            limit_price: None,
            posted_at: 0,
            deadline,
            confirmed: false,
            settled: false,
            reserved: 0.0,
            use_usdc: 0.0,
            refundable: 0.0,
            state: String::new(),
        }
    }

    #[test]
    fn a_bounty_is_open_until_its_deadline_then_waits_to_be_settled() {
        assert_eq!(state_of(&bounty(100), 100), "open");
        assert_eq!(state_of(&bounty(100), 101), "to settle");
        assert_eq!(state_of(&BountyView { settled: true, ..bounty(100) }, 200), "settled");
        assert_eq!(state_of(&BountyView { confirmed: true, ..bounty(100) }, 50), "confirmed");
    }

    /// The node's bindings send what the contract has: each function it calls is in the artifact's selectors.
    #[test]
    fn the_calls_are_the_contracts() {
        use alloy::sol_types::SolCall;
        let artifact: serde_json::Value = serde_json::from_str(include_str!("../../contracts/CoinBounties.json")).unwrap();
        let ids = artifact["methodIdentifiers"].as_object().unwrap();
        for (sig, sel) in [
            (CoinBounties::postCall::SIGNATURE, CoinBounties::postCall::SELECTOR),
            (CoinBounties::confirmCall::SIGNATURE, CoinBounties::confirmCall::SELECTOR),
            (CoinBounties::settleCall::SIGNATURE, CoinBounties::settleCall::SELECTOR),
            (CoinBounties::releaseByUseCall::SIGNATURE, CoinBounties::releaseByUseCall::SELECTOR),
            (CoinBounties::refundCall::SIGNATURE, CoinBounties::refundCall::SELECTOR),
            (CoinBounties::bountyOfCall::SIGNATURE, CoinBounties::bountyOfCall::SELECTOR),
            (CoinBounties::refundableOfCall::SIGNATURE, CoinBounties::refundableOfCall::SELECTOR),
            (CoinBounties::useOfCall::SIGNATURE, CoinBounties::useOfCall::SELECTOR),
        ] {
            assert_eq!(ids.get(sig).and_then(|v| v.as_str()), Some(hex::encode(sel).as_str()), "{sig}");
        }
        assert_eq!(CoinBounties::postCall::SIGNATURE, "post(bytes32,uint256,uint256,uint64)");
        assert_eq!(CoinBounties::confirmCall::SIGNATURE, "confirm(uint256,bytes32,uint256,uint256)");
    }

    /// A confirmation's max cost is its quote's price per coin with the trade slippage's fewer coins, rounded up; with
    /// nothing quoted it bounds nothing.
    #[test]
    fn a_confirmations_max_cost_is_its_quote_with_the_trade_slippage() {
        let e18 = U256::from(1_000_000_000_000_000_000u128);
        // 10,000 UNB quoted 10,000 coins: 9,900 with the slippage, so at most 10,000/9,900 UNB a coin, rounded up.
        let unb = U256::from(10_000u64) * e18;
        let want = (unb * e18).div_ceil(U256::from(9_900u64) * e18);
        assert_eq!(max_cost(unb, U256::from(10_000u64) * e18), want);
        assert!(want > e18 && want < e18 + e18 / U256::from(50u8), "a hundredth or so above the quote's price");
        assert_eq!(max_cost(unb, U256::ZERO), U256::MAX);
    }

    /// A confirmation sends the lower of its kept cap and the fresh bound: a push can only make it fail, never pay more.
    #[test]
    fn a_confirmation_never_pays_more_than_its_cap() {
        let (cap, pushed, fallen) = (U256::from(100u8), U256::from(130u8), U256::from(90u8));
        assert_eq!(confirm_cost(Some(cap), pushed), cap, "a pushed quote doesn't lift the cap");
        assert_eq!(confirm_cost(Some(cap), fallen), fallen, "a price that fell is paid as it is");
        assert_eq!(confirm_cost(None, pushed), pushed, "with no cap kept, the fresh bound");
    }

    /// Blue B-2: a refusal for its price says the bound was fixed when the confirmation was allowed only when it was.
    #[test]
    fn a_price_refusal_names_the_kept_cap_only_when_there_is_one() {
        let e = FixedBytes::repeat_byte(1);
        let most = U256::from(1_000_000_000_000_000_000u128);
        let capped = price_moved_error(3, &e, most, true);
        assert!(capped.contains(PRICE_MOVED) && capped.contains("fixed when it was allowed"), "{capped}");
        let fresh = price_moved_error(3, &e, most, false);
        assert!(fresh.contains(PRICE_MOVED), "{fresh}");
        assert!(!fresh.contains("fixed when it was allowed"), "no cap was kept: {fresh}");
        assert!(fresh.contains("the quote when it was sent"), "{fresh}");
    }
}
